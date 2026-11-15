package com.anylink.abi.sdk;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Synchronous DebugConsumer that sends each event immediately with debug=true (and optional dry_run=true)
 * to /collect/api/v1/track/batch so Gateway L4 strict schema errors are surfaced synchronously.
 */
public class DebugConsumer implements Consumer {
    private final String endpoint;
    private final long projectId;
    private final String projectToken;
    private final boolean dryRun;
    private final ObjectMapper mapper = new ObjectMapper();

    public DebugConsumer(String serverUrl, long projectId, String projectToken, boolean dryRun) {
        if (serverUrl == null || projectId <= 0 || projectToken == null || projectToken.isBlank()) {
            throw new IllegalArgumentException("serverUrl, projectId (> 0), and projectToken are required");
        }
        this.endpoint = BatchConsumer.resolveBatchEndpoint(serverUrl);
        this.projectId = projectId;
        this.projectToken = projectToken.trim();
        this.dryRun = dryRun;
    }

    @Override
    public void add(Map<String, Object> eventRecord) throws Exception {
        Map<String, Object> payload = new LinkedHashMap<>();
        payload.put("project_id", projectId);
        payload.put("project_token", projectToken);
        payload.put("debug", true);
        payload.put("dry_run", dryRun);
        payload.put("events", Collections.singletonList(eventRecord));

        byte[] jsonBytes = mapper.writeValueAsBytes(payload);
        HttpURLConnection conn = (HttpURLConnection) new URL(endpoint).openConnection();
        try {
            conn.setRequestMethod("POST");
            conn.setConnectTimeout(5000);
            conn.setReadTimeout(5000);
            conn.setDoOutput(true);
            conn.setRequestProperty("Content-Type", "application/json");
            conn.setRequestProperty("User-Agent", AbiValidator.SDK_VERSION);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(jsonBytes);
            }
            int status = conn.getResponseCode();
            InputStream is = (status >= 200 && status < 400) ? conn.getInputStream() : conn.getErrorStream();
            String respBody = is != null ? new String(is.readAllBytes(), StandardCharsets.UTF_8) : "";
            if (status < 200 || status >= 300) {
                throw new IllegalArgumentException("DebugConsumer HTTP " + status + ": " + respBody);
            }
            if (!respBody.isEmpty()) {
                JsonNode root = mapper.readTree(respBody);
                JsonNode data = root.path("data");
                if (data.path("rejected").asInt(0) > 0) {
                    throw new IllegalArgumentException("DebugConsumer validation rejected event: " + data.path("errors").toString());
                }
            }
        } finally {
            conn.disconnect();
        }
    }

    @Override
    public void flush() {
    }

    @Override
    public void close() {
    }
}
