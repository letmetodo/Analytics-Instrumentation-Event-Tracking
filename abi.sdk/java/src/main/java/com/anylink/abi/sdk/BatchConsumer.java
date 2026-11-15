package com.anylink.abi.sdk;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.*;
import java.util.concurrent.*;
import java.util.zip.GZIPOutputStream;

/**
 * Thread-safe asynchronous batching HTTP consumer for ABI Gateway (/collect/api/v1/track/batch).
 * Preserves deterministic event_id across exponential backoff retries on 5xx / 429 / network errors.
 */
public class BatchConsumer implements Consumer {
    private final String endpoint;
    private final long projectId;
    private final String projectToken;
    private final int batchSize;
    private final int maxQueueSize;
    private final int maxRetries;
    private final boolean compressGzip;
    private final boolean dryRun;
    private final ObjectMapper mapper = new ObjectMapper();
    private final LinkedBlockingQueue<Map<String, Object>> queue;
    private final ScheduledExecutorService scheduler;
    private volatile int lastResponseStatus = 0;
    private volatile String lastResponseBody = "";

    public static class Config {
        public String serverUrl;
        public long projectId;
        public String projectToken;
        public int batchSize = 50;
        public long flushIntervalMs = 2000L;
        public int maxQueueSize = 10000;
        public int maxRetries = 3;
        public boolean compressGzip = false;
        public boolean dryRun = false;

        public Config(String serverUrl, long projectId, String projectToken) {
            this.serverUrl = serverUrl;
            this.projectId = projectId;
            this.projectToken = projectToken;
        }
    }

    public static String resolveBatchEndpoint(String rawUrl) {
        String trimmed = rawUrl.trim().replaceAll("/+$", "");
        if (trimmed.endsWith("/collect/api/v1/track/batch")) {
            return trimmed;
        }
        return trimmed + "/collect/api/v1/track/batch";
    }

    public BatchConsumer(Config config) {
        if (config == null || config.serverUrl == null || config.projectId <= 0 || config.projectToken == null || config.projectToken.isBlank()) {
            throw new IllegalArgumentException("serverUrl, projectId (> 0), and projectToken are required");
        }
        this.endpoint = resolveBatchEndpoint(config.serverUrl);
        this.projectId = config.projectId;
        this.projectToken = config.projectToken.trim();
        this.batchSize = Math.max(1, Math.min(config.batchSize, 500));
        this.maxQueueSize = Math.max(this.batchSize, config.maxQueueSize);
        this.maxRetries = Math.max(0, config.maxRetries);
        this.compressGzip = config.compressGzip;
        this.dryRun = config.dryRun;
        this.queue = new LinkedBlockingQueue<>(this.maxQueueSize);
        this.scheduler = Executors.newSingleThreadScheduledExecutor(r -> {
            Thread t = new Thread(r, "abi-sdk-batch-flusher");
            t.setDaemon(true);
            return t;
        });
        long interval = Math.max(100L, config.flushIntervalMs);
        this.scheduler.scheduleWithFixedDelay(() -> {
            try {
                flush();
            } catch (Exception ignored) {
            }
        }, interval, interval, TimeUnit.MILLISECONDS);
    }

    @Override
    public void add(Map<String, Object> eventRecord) throws Exception {
        if (!queue.offer(eventRecord)) {
            throw new IllegalStateException("BatchConsumer queue is full (" + maxQueueSize + ")");
        }
        if (queue.size() >= batchSize && !scheduler.isShutdown()) {
            scheduler.execute(() -> {
                try {
                    flush();
                } catch (Exception ignored) {
                }
            });
        }
    }

    @Override
    public synchronized void flush() throws Exception {
        while (!queue.isEmpty()) {
            List<Map<String, Object>> batch = new ArrayList<>(batchSize);
            queue.drainTo(batch, batchSize);
            if (batch.isEmpty()) {
                return;
            }
            Map<String, Object> payload = new LinkedHashMap<>();
            payload.put("project_id", projectId);
            payload.put("project_token", projectToken);
            if (dryRun) {
                payload.put("dry_run", true);
            }
            payload.put("events", batch);
            byte[] jsonBytes = mapper.writeValueAsBytes(payload);
            postWithRetry(endpoint, jsonBytes);
        }
    }

    private void postWithRetry(String urlStr, byte[] jsonBytes) throws Exception {
        Exception lastErr = null;
        for (int attempt = 0; attempt <= maxRetries; attempt++) {
            if (attempt > 0) {
                Thread.sleep(50L * (1L << (attempt - 1)));
            }
            HttpURLConnection conn = null;
            try {
                conn = (HttpURLConnection) new URL(urlStr).openConnection();
                conn.setRequestMethod("POST");
                conn.setConnectTimeout(5000);
                conn.setReadTimeout(5000);
                conn.setDoOutput(true);
                conn.setRequestProperty("Content-Type", "application/json");
                conn.setRequestProperty("User-Agent", AbiValidator.SDK_VERSION);

                byte[] bodyToWrite = jsonBytes;
                if (compressGzip) {
                    conn.setRequestProperty("Content-Encoding", "gzip");
                    ByteArrayOutputStream bos = new ByteArrayOutputStream();
                    try (GZIPOutputStream gzip = new GZIPOutputStream(bos)) {
                        gzip.write(jsonBytes);
                    }
                    bodyToWrite = bos.toByteArray();
                }

                try (OutputStream os = conn.getOutputStream()) {
                    os.write(bodyToWrite);
                }

                int status = conn.getResponseCode();
                InputStream is = (status >= 200 && status < 400) ? conn.getInputStream() : conn.getErrorStream();
                String respBody = is != null ? new String(is.readAllBytes(), StandardCharsets.UTF_8) : "";
                this.lastResponseStatus = status;
                this.lastResponseBody = respBody;
                if (status >= 200 && status < 300) {
                    return;
                }
                if (status >= 400 && status < 500 && status != 429) {
                    throw new IllegalStateException("Permanent client error HTTP " + status + (respBody.isEmpty() ? "" : ": " + respBody));
                }
                lastErr = new RuntimeException("Retryable HTTP status " + status);
            } catch (IllegalStateException permanent) {
                throw permanent;
            } catch (Exception ex) {
                lastErr = ex;
            } finally {
                if (conn != null) {
                    conn.disconnect();
                }
            }
        }
        if (lastErr != null) {
            throw lastErr;
        }
    }

    public int getLastResponseStatus() {
        return lastResponseStatus;
    }

    public String getLastResponseBody() {
        return lastResponseBody;
    }

    @Override
    public void close() {
        scheduler.shutdown();
        try {
            flush();
        } catch (Exception ignored) {
        }
    }
}
