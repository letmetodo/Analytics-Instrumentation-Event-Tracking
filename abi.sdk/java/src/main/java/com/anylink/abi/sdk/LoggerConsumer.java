package com.anylink.abi.sdk;

import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.BufferedWriter;
import java.io.File;
import java.io.FileOutputStream;
import java.io.OutputStreamWriter;
import java.nio.charset.StandardCharsets;
import java.time.LocalDate;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.Map;

/**
 * Local JSONL file consumer compatible with LogBus / Filebeat / Vector ingestion.
 */
public class LoggerConsumer implements Consumer {
    private final File directory;
    private final String filePrefix;
    private final ObjectMapper mapper = new ObjectMapper();
    private String currentDateStr = "";
    private BufferedWriter writer;

    public LoggerConsumer(File directory, String filePrefix) {
        if (!directory.exists() && !directory.mkdirs()) {
            throw new IllegalArgumentException("Failed to create log directory: " + directory);
        }
        this.directory = directory;
        this.filePrefix = (filePrefix == null || filePrefix.isBlank()) ? "abi_track" : filePrefix.trim();
    }

    @Override
    public synchronized void add(Map<String, Object> eventRecord) throws Exception {
        String today = LocalDate.now(ZoneOffset.UTC).format(DateTimeFormatter.ISO_LOCAL_DATE);
        if (!today.equals(currentDateStr) || writer == null) {
            if (writer != null) {
                writer.close();
            }
            currentDateStr = today;
            File target = new File(directory, filePrefix + "." + today + ".jsonl");
            writer = new BufferedWriter(new OutputStreamWriter(new FileOutputStream(target, true), StandardCharsets.UTF_8));
        }
        writer.write(mapper.writeValueAsString(eventRecord));
        writer.newLine();
    }

    @Override
    public synchronized void flush() throws Exception {
        if (writer != null) {
            writer.flush();
        }
    }

    @Override
    public synchronized void close() {
        if (writer != null) {
            try {
                writer.flush();
                writer.close();
            } catch (Exception ignored) {
            }
            writer = null;
        }
    }
}
