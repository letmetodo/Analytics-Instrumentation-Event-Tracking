package com.anylink.abi.sdk;

import com.anylink.abi.sdk.examples.AbiJavaSdkDemo;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.File;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.ZoneId;
import java.util.*;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

class AbiAnalyticsTest {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    @Test
    void passesSharedIdentityGoldenVectors() throws Exception {
        File f = new File("../spec/test-vectors/identity_cases.json");
        JsonNode root = MAPPER.readTree(f);
        assertEquals(AbiValidator.MAX_DISTINCT_ID_BYTES, root.get("max_distinct_id_bytes").asInt());
        assertEquals(AbiValidator.MAX_LOGIN_ID_BYTES, root.get("max_login_id_bytes").asInt());
        JsonNode cases = root.get("cases");
        assertNotNull(cases);
        assertTrue(cases.size() > 0);

        for (JsonNode tc : cases) {
            String name = tc.get("name").asText();
            String distinctId = tc.path("distinct_id").asText("");
            String loginId = tc.path("login_id").asText("");
            boolean valid = tc.get("valid").asBoolean();

            if (valid) {
                String[] norm = AbiValidator.normalizeIdentityPair(distinctId, loginId);
                if (tc.has("normalized_distinct_id") && !tc.get("normalized_distinct_id").isNull()) {
                    assertEquals(tc.get("normalized_distinct_id").asText(), norm[0], name);
                }
                if (tc.has("normalized_login_id") && !tc.get("normalized_login_id").isNull()) {
                    assertEquals(tc.get("normalized_login_id").asText(), norm[1], name);
                }
            } else {
                assertThrows(IllegalArgumentException.class,
                        () -> AbiValidator.normalizeIdentityPair(distinctId, loginId), name);
            }
        }
    }

    @Test
    void loginIdOnlyDoesNotFallbackIntoDistinctId() throws Exception {
        List<Map<String, Object>> captured = new ArrayList<>();
        try (AbiAnalytics sdk = new AbiAnalytics(createMemoryConsumer(captured))) {
            String longLoginId = "u".repeat(100);
            sdk.track(longLoginId, "", "OrderPaid", Map.of("amount", 99.0));
            assertEquals(1, captured.size());
            assertEquals("", captured.get(0).get("distinct_id"));
            assertEquals(longLoginId, captured.get(0).get("login_id"));
            assertThrows(IllegalArgumentException.class, () -> sdk.track("  ", "\t", "OrderPaid", Map.of()));
        }
    }

    @Test
    void passesSharedEventAndPropertyGoldenVectors() throws Exception {
        File f = new File("../spec/test-vectors/event_and_property_cases.json");
        JsonNode root = MAPPER.readTree(f);

        for (JsonNode tc : root.get("event_name_cases")) {
            String evt = tc.get("event_name").asText();
            boolean valid = tc.get("valid").asBoolean();
            if (valid) {
                assertDoesNotThrow(() -> AbiValidator.validateEventName(evt), evt);
            } else {
                assertThrows(IllegalArgumentException.class, () -> AbiValidator.validateEventName(evt), evt);
            }
        }

        for (JsonNode tc : root.get("property_key_cases")) {
            String key = tc.get("key").asText();
            boolean valid = tc.get("valid").asBoolean();
            if (valid) {
                assertDoesNotThrow(() -> AbiValidator.validatePropertyKey(key), key);
            } else {
                assertThrows(IllegalArgumentException.class, () -> AbiValidator.validatePropertyKey(key), key);
            }
        }
    }

    @Test
    void convertsSnowflakeLongBeyondMaxSafeIntegerToString() {
        Map<String, Object> raw = new LinkedHashMap<>();
        raw.put("safe_id", 9007199254740991L);
        raw.put("snowflake_id", 9007199254740992L);
        Map<String, Object> sanitized = AbiValidator.sanitizeProperties(raw);
        assertEquals(9007199254740991L, sanitized.get("safe_id"));
        assertEquals("9007199254740992", sanitized.get("snowflake_id"));
    }

    @Test
    void batchConsumerRetriesWithDeterministicEventIdAndSupportsUserOps() throws Exception {
        AtomicInteger attempts = new AtomicInteger(0);
        List<JsonNode> receivedPayloads = new CopyOnWriteArrayList<>();

        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/collect/api/v1/track/batch", exchange -> {
            byte[] body = exchange.getRequestBody().readAllBytes();
            receivedPayloads.add(MAPPER.readTree(body));
            int n = attempts.incrementAndGet();
            if (n == 1) {
                byte[] resp = "{\"code\":50000}".getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(503, resp.length);
                try (OutputStream os = exchange.getResponseBody()) {
                    os.write(resp);
                }
                return;
            }
            byte[] resp = "{\"code\":200,\"data\":{\"accepted\":3}}".getBytes(StandardCharsets.UTF_8);
            exchange.sendResponseHeaders(200, resp.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(resp);
            }
        });
        server.start();

        try {
            int port = server.getAddress().getPort();
            BatchConsumer.Config cfg = new BatchConsumer.Config("http://127.0.0.1:" + port, 12L, "abi_tok_java_test");
            cfg.batchSize = 10;
            cfg.flushIntervalMs = 60000L;

            try (AbiAnalytics sdk = new AbiAnalytics(new BatchConsumer(cfg))) {
                sdk.setSuperProperties(Map.of("env", "prod"));
                String evtId = sdk.track("u_1001", "vis_1001", "OrderCreated", Map.of("amount", 88.5));
                sdk.userSet("u_1001", "vis_1001", Map.of("tier", "gold"));
                sdk.userAdd("u_1001", "vis_1001", Map.of("points", 10));
                sdk.flush();

                assertEquals(2, attempts.get());
                assertEquals(2, receivedPayloads.size());
                assertEquals(12L, receivedPayloads.get(1).path("project_id").asLong());
                assertEquals("abi_tok_java_test", receivedPayloads.get(1).path("project_token").asText());
                String firstAttemptId = receivedPayloads.get(0).path("events").get(0).path("event_id").asText();
                String secondAttemptId = receivedPayloads.get(1).path("events").get(0).path("event_id").asText();
                assertEquals(evtId, firstAttemptId);
                assertEquals(evtId, secondAttemptId);
                assertEquals("prod", receivedPayloads.get(1).path("events").get(0).path("properties").path("env").asText());
                assertEquals("$user_set", receivedPayloads.get(1).path("events").get(1).path("event_name").asText());
                assertFalse(receivedPayloads.get(1).path("events").get(1).path("properties").has("env"),
                        "$user_set must not include superProperties");
                assertEquals("$user_add", receivedPayloads.get(1).path("events").get(2).path("event_name").asText());
            }
        } finally {
            server.stop(0);
        }
    }

    @Test
    void loggerConsumerWritesJsonLines(@TempDir Path tempDir) throws Exception {
        try (AbiAnalytics sdk = new AbiAnalytics(new LoggerConsumer(tempDir.toFile(), "abi_test"))) {
            sdk.track("u_log_1", "", "ServerBoot", Map.of("host", "node-1"));
            sdk.flush();
        }
        File[] files = tempDir.toFile().listFiles((dir, name) -> name.endsWith(".jsonl"));
        assertNotNull(files);
        assertEquals(1, files.length);
        List<String> lines = Files.readAllLines(files[0].toPath(), StandardCharsets.UTF_8);
        assertEquals(1, lines.size());
        JsonNode eventNode = MAPPER.readTree(lines.get(0));
        assertEquals("ServerBoot", eventNode.path("event_name").asText());
        assertEquals("", eventNode.path("distinct_id").asText());
        assertEquals("u_log_1", eventNode.path("login_id").asText());
        assertEquals("node-1", eventNode.path("properties").path("host").asText());
    }

    @Test
    void extractsHashTimeAndDollarTimeInTrackAndUserSetAndStripsFromProperties() throws Exception {
        List<Map<String, Object>> captured = new ArrayList<>();
        Consumer memoryConsumer = createMemoryConsumer(captured);

        try (AbiAnalytics sdk = new AbiAnalytics(memoryConsumer)) {
            Date customDate = new Date(1762740000456L);
            Instant customInstant = Instant.parse("2026-11-10T03:15:30.789Z");

            // 1. track + #time (Date)
            sdk.track("u_1", "d_1", "ItemPurchased", Map.of(
                    "sku", "SKU_01",
                    "#time", customDate
            ));
            Map<String, Object> evt1 = captured.get(0);
            assertEquals(1762740000456L, evt1.get("timestamp"));
            @SuppressWarnings("unchecked")
            Map<String, Object> props1 = (Map<String, Object>) evt1.get("properties");
            assertEquals("SKU_01", props1.get("sku"));
            assertFalse(props1.containsKey("#time"));

            // 2. track + #time (Instant) + caller Map immutability check
            Map<String, Object> callerMap = new LinkedHashMap<>();
            callerMap.put("sku", "SKU_02");
            callerMap.put("#time", customInstant);
            sdk.track("u_1", "d_1", "ItemPurchased", callerMap);
            Map<String, Object> evt2 = captured.get(1);
            assertEquals(customInstant.toEpochMilli(), evt2.get("timestamp"));
            @SuppressWarnings("unchecked")
            Map<String, Object> props2 = (Map<String, Object>) evt2.get("properties");
            assertFalse(props2.containsKey("#time"));
            assertTrue(callerMap.containsKey("#time"), "caller properties map must not be mutated");

            // 3. userSet + #time (Date & Instant, ThinkingData style)
            Date profileDate = new Date(1762743600000L);
            sdk.userSet("u_1", "d_1", Map.of(
                    "user_name", "ABC",
                    "#time", profileDate
            ));
            Map<String, Object> evt3 = captured.get(2);
            assertEquals("$user_set", evt3.get("event_name"));
            assertEquals(profileDate.getTime(), evt3.get("timestamp"));
            @SuppressWarnings("unchecked")
            Map<String, Object> props3 = (Map<String, Object>) evt3.get("properties");
            assertEquals("ABC", props3.get("user_name"));
            assertFalse(props3.containsKey("#time"));

            sdk.userSet("u_1", "d_1", Map.of(
                    "user_name", "DEF",
                    "#time", customInstant
            ));
            Map<String, Object> evt4 = captured.get(3);
            assertEquals(customInstant.toEpochMilli(), evt4.get("timestamp"));
            @SuppressWarnings("unchecked")
            Map<String, Object> props4 = (Map<String, Object>) evt4.get("properties");
            assertEquals("DEF", props4.get("user_name"));
            assertFalse(props4.containsKey("#time"));

            // 4. $time + seconds Integer, millis Long, ISO-8601 & "yyyy-MM-dd HH:mm:ss"
            sdk.track("u_1", "", "PingEvent", Map.of("$time", 1762740000));
            assertEquals(1762740000000L, captured.get(4).get("timestamp"));
            @SuppressWarnings("unchecked")
            Map<String, Object> props5 = (Map<String, Object>) captured.get(4).get("properties");
            assertFalse(props5.containsKey("$time"));

            sdk.track("u_1", "", "PingEvent", Map.of("#time", 1762740000999L));
            assertEquals(1762740000999L, captured.get(5).get("timestamp"));

            sdk.track("u_1", "", "PingEvent", Map.of("#time", "2026-11-10T11:00:00+08:00"));
            assertEquals(Instant.parse("2026-11-10T03:00:00Z").toEpochMilli(), captured.get(6).get("timestamp"));

            String localStr = "2026-11-10 11:30:45";
            long expectedLocalMs = LocalDateTime.of(2026, 11, 10, 11, 30, 45)
                    .atZone(ZoneId.systemDefault())
                    .toInstant()
                    .toEpochMilli();
            sdk.track("u_1", "", "PingEvent", Map.of("#time", localStr));
            assertEquals(expectedLocalMs, captured.get(7).get("timestamp"));

            // 5. Invalid #time values must throw IllegalArgumentException
            assertThrows(IllegalArgumentException.class,
                    () -> sdk.track("u_1", "", "PingEvent", Map.of("#time", "not-a-valid-date")));
            assertThrows(IllegalArgumentException.class,
                    () -> sdk.track("u_1", "", "PingEvent", Map.of("#time", -100L)));
            assertThrows(IllegalArgumentException.class,
                    () -> sdk.track("u_1", "", "PingEvent", Map.of("#time", true)));
            Map<String, Object> nullTimeProps = new HashMap<>();
            nullTimeProps.put("#time", null);
            assertThrows(IllegalArgumentException.class,
                    () -> sdk.track("u_1", "", "PingEvent", nullTimeProps));
        }
    }

    @Test
    void explicitDateAndInstantOverloadsTakePrecedenceOverPropertyTime() throws Exception {
        List<Map<String, Object>> captured = new ArrayList<>();
        try (AbiAnalytics sdk = new AbiAnalytics(createMemoryConsumer(captured))) {
            Date explicitDate = new Date(1762750000111L);
            Instant explicitInstant = Instant.parse("2026-11-10T06:00:00.222Z");
            Date propDate = new Date(1762700000000L);

            sdk.track("u_2", "d_2", "OrderCreated", Map.of(
                    "amount", 50,
                    "#time", propDate
            ), explicitDate);
            assertEquals(explicitDate.getTime(), captured.get(0).get("timestamp"));
            @SuppressWarnings("unchecked")
            Map<String, Object> props0 = (Map<String, Object>) captured.get(0).get("properties");
            assertFalse(props0.containsKey("#time"));

            sdk.track("u_2", "d_2", "OrderPaid", Map.of(
                    "amount", 50,
                    "$time", propDate
            ), explicitInstant);
            assertEquals(explicitInstant.toEpochMilli(), captured.get(1).get("timestamp"));
            @SuppressWarnings("unchecked")
            Map<String, Object> props1 = (Map<String, Object>) captured.get(1).get("properties");
            assertFalse(props1.containsKey("$time"));

            String returnedId = sdk.trackWithId(
                    "u_2", "d_2", "OrderSettled", "evt_settled_01",
                    Map.of("amount", 50), explicitInstant
            );
            assertEquals("evt_settled_01", returnedId);
            assertEquals("evt_settled_01", captured.get(2).get("event_id"));
            assertEquals(explicitInstant.toEpochMilli(), captured.get(2).get("timestamp"));
        }
    }

    @Test
    void superPropertiesManagementDefensiveCopyAndPriorityOrder() throws Exception {
        List<Map<String, Object>> captured = new ArrayList<>();
        try (AbiAnalytics sdk = new AbiAnalytics(createMemoryConsumer(captured))) {
            sdk.setSuperProperties(Map.of(
                    "k_static_only", "from_static",
                    "k_dyn_override", "from_static",
                    "k_evt_override", "from_static",
                    "k_to_unset", "temp_val"
            ));

            // Defensive copy check on getSuperProperties()
            Map<String, Object> snapshot = sdk.getSuperProperties();
            assertEquals(4, snapshot.size());
            assertEquals("temp_val", snapshot.get("k_to_unset"));
            snapshot.put("injected_outside", "bad");
            snapshot.remove("k_static_only");
            assertFalse(sdk.getSuperProperties().containsKey("injected_outside"));
            assertTrue(sdk.getSuperProperties().containsKey("k_static_only"));

            // unsetSuperProperty removes target key
            sdk.unsetSuperProperty("k_to_unset");
            assertFalse(sdk.getSuperProperties().containsKey("k_to_unset"));
            assertThrows(IllegalArgumentException.class, () -> sdk.unsetSuperProperty(" "));

            // Priority: superProperties < dynamicSuperProperties < eventProperties
            sdk.setDynamicSuperProperties(() -> Map.of(
                    "k_dyn_override", "from_dynamic",
                    "k_evt_override", "from_dynamic"
            ));

            sdk.track("u_3", "d_3", "FeatureUsed", Map.of(
                    "k_evt_override", "from_event"
            ));

            @SuppressWarnings("unchecked")
            Map<String, Object> eventProps = (Map<String, Object>) captured.get(0).get("properties");
            assertEquals("from_static", eventProps.get("k_static_only"));
            assertEquals("from_dynamic", eventProps.get("k_dyn_override"));
            assertEquals("from_event", eventProps.get("k_evt_override"));
            assertFalse(eventProps.containsKey("k_to_unset"));

            // Neither static nor dynamic super properties may leak into $user_* or #user_* events
            sdk.userSet("u_3", "d_3", Map.of("vip", true));
            @SuppressWarnings("unchecked")
            Map<String, Object> userSetProps = (Map<String, Object>) captured.get(1).get("properties");
            assertEquals(Map.of("vip", true), userSetProps);

            sdk.track("u_3", "d_3", "#user_set", Map.of("level", 3));
            @SuppressWarnings("unchecked")
            Map<String, Object> hashUserProps = (Map<String, Object>) captured.get(2).get("properties");
            assertEquals(Map.of("level", 3L), hashUserProps);
        }
    }

    private static Consumer createMemoryConsumer(List<Map<String, Object>> sink) {
        return new Consumer() {
            @Override
            public void add(Map<String, Object> eventRecord) {
                sink.add(eventRecord);
            }

            @Override
            public void flush() {
            }

            @Override
            public void close() {
            }
        };
    }

    @Test
    void stagingConsumerPreviewsFormattedBatchJsonAndSubmitsOnlyOnConfirmation() throws Exception {
        AtomicInteger httpRequests = new AtomicInteger(0);
        List<JsonNode> receivedBatches = new CopyOnWriteArrayList<>();

        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/collect/api/v1/track/batch", exchange -> {
            httpRequests.incrementAndGet();
            byte[] body = exchange.getRequestBody().readAllBytes();
            JsonNode payload = MAPPER.readTree(body);
            receivedBatches.add(payload);
            int count = payload.path("events").size();
            byte[] resp = String.format("{\"code\":200,\"data\":{\"accepted\":%d,\"rejected\":0}}", count)
                    .getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, resp.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(resp);
            }
        });
        server.start();

        try {
            String serverUrl = "http://127.0.0.1:" + server.getAddress().getPort();
            StagingConsumer staging = new StagingConsumer();

            // Step 1: Configure SDK & stage events — flush/close must NOT send any HTTP request
            try (AbiAnalytics sdk = new AbiAnalytics(staging)) {
                sdk.setSuperProperties(Map.of("$app_version", "3.4.0", "service_name", "checkout-api"));
                sdk.trackWithId(
                        "u_stage_01",
                        "vis_stage_01",
                        "OrderCreated",
                        "evt_stage_order_01",
                        Map.of(
                                "order_id", 9007199254740999L,
                                "amount", 199.00,
                                "created_at", Instant.parse("2026-11-10T04:00:00Z")
                        ),
                        Instant.parse("2026-11-10T04:00:00Z")
                );
                sdk.userSet("u_stage_01", "vis_stage_01", Map.of("vip_tier", "platinum"));
                sdk.flush();
            }

            assertEquals(0, httpRequests.get(), "StagingConsumer must not send network requests before confirmSubmit");
            assertEquals(2, staging.size());

            // Inspect formatted request JSON preview
            String previewJson = staging.previewRequestJson(88L, "abi_stage_token", true);
            assertTrue(previewJson.contains("\n"), "previewRequestJson should be pretty-printed with indentation");
            JsonNode previewRoot = MAPPER.readTree(previewJson);
            assertEquals(88L, previewRoot.path("project_id").asLong());
            assertEquals("abi_stage_token", previewRoot.path("project_token").asText());
            assertTrue(previewRoot.path("dry_run").asBoolean());
            assertEquals(2, previewRoot.path("events").size());
            assertEquals("OrderCreated", previewRoot.path("events").get(0).path("event_name").asText());
            assertEquals("9007199254740999",
                    previewRoot.path("events").get(0).path("properties").path("order_id").asText());
            assertEquals("checkout-api",
                    previewRoot.path("events").get(0).path("properties").path("service_name").asText());
            assertEquals("$user_set", previewRoot.path("events").get(1).path("event_name").asText());
            assertFalse(previewRoot.path("events").get(1).path("properties").has("service_name"));
            assertEquals(2, staging.size(), "previewRequestJson must not clear staged events");

            // Step 2: Confirm submit via BatchConsumer -> delivers, flushes, and clears staged queue
            BatchConsumer.Config cfg = new BatchConsumer.Config(serverUrl, 88L, "abi_stage_token");
            cfg.flushIntervalMs = 60000L;
            try (BatchConsumer batchConsumer = new BatchConsumer(cfg)) {
                int submitted = staging.confirmSubmit(batchConsumer);
                assertEquals(2, submitted);
                assertEquals(200, batchConsumer.getLastResponseStatus());
                assertTrue(batchConsumer.getLastResponseBody().contains("\"accepted\":2"));
            }

            assertEquals(0, staging.size(), "confirmSubmit must clear staged events after successful flush");
            assertEquals(1, httpRequests.get(), "All staged events should be sent in a single batch");
            assertEquals(2, receivedBatches.get(0).path("events").size());

            // Second confirmSubmit on empty staging consumer is a safe no-op
            try (BatchConsumer batchConsumer = new BatchConsumer(cfg)) {
                assertEquals(0, staging.confirmSubmit(batchConsumer));
            }
            assertEquals(1, httpRequests.get());

            // Verify clear() discards pending staged events without sending
            try (AbiAnalytics sdk = new AbiAnalytics(staging)) {
                sdk.track("u_stage_02", "", "TempEvent", Map.of("k", "v"));
            }
            assertEquals(1, staging.size());
            staging.clear();
            assertEquals(0, staging.size());
            assertEquals(0, MAPPER.readTree(staging.previewRequestJson(88L, "abi_stage_token", false))
                    .path("events").size());
        } finally {
            server.stop(0);
        }
    }

    @Test
    void demoTwoStepPreviewAndConfirmFlowSupportsCancelAndSubmit() throws Exception {
        AtomicInteger serverHits = new AtomicInteger(0);
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/collect/api/v1/track/batch", exchange -> {
            serverHits.incrementAndGet();
            byte[] body = exchange.getRequestBody().readAllBytes();
            JsonNode root = MAPPER.readTree(body);
            byte[] resp = String.format(
                    "{\"code\":200,\"message\":\"ok\",\"data\":{\"accepted\":%d,\"rejected\":0}}",
                    root.path("events").size()
            ).getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, resp.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(resp);
            }
        });
        server.start();

        try {
            String serverUrl = "http://127.0.0.1:" + server.getAddress().getPort();

            // 1. Parse CLI flags & build preview -> 0 HTTP requests before confirmation
            AbiJavaSdkDemo.DemoConfig cancelCfg = AbiJavaSdkDemo.DemoConfig.fromArgs(new String[]{
                    "--server-url=" + serverUrl,
                    "--project-id=7",
                    "--project-token=tok_demo_7",
                    "--scenario=browse",
                    "--super-props={\"$app_version\":\"3.9.0\",\"custom_env\":\"qa\"}",
                    "--dynamic-super",
                    "--dry-run"
            });
            StagingConsumer previewToCancel = AbiJavaSdkDemo.buildScenarioPreview(cancelCfg);
            assertEquals(2, previewToCancel.size());
            assertEquals(0, serverHits.get());

            JsonNode browsePreview = MAPPER.readTree(
                    previewToCancel.previewRequestJson(cancelCfg.projectId, cancelCfg.projectToken, cancelCfg.dryRun)
            );
            assertTrue(browsePreview.path("dry_run").asBoolean());
            assertEquals("qa", browsePreview.path("events").get(0).path("properties").path("custom_env").asText());
            assertEquals(101L, browsePreview.path("events").get(0).path("properties").path("request_seq").asLong());

            // Simulate user declining [y/N] -> cancels without sending HTTP request
            int cancelledCount = AbiJavaSdkDemo.confirmAndSubmit(previewToCancel, cancelCfg, () -> false);
            assertEquals(0, cancelledCount);
            assertEquals(0, previewToCancel.size());
            assertEquals(0, serverHits.get());

            // 2. Simulate user confirming -> sends 1 single batch HTTP request
            AbiJavaSdkDemo.DemoConfig submitCfg = AbiJavaSdkDemo.DemoConfig.fromArgs(new String[]{
                    "--server-url", serverUrl,
                    "--project-id", "7",
                    "--project-token", "tok_demo_7",
                    "--scenario", "order",
                    "--yes"
            });
            StagingConsumer previewToSubmit = AbiJavaSdkDemo.buildScenarioPreview(submitCfg);
            assertEquals(3, previewToSubmit.size());
            int submittedCount = AbiJavaSdkDemo.confirmAndSubmit(previewToSubmit, submitCfg, () -> true);
            assertEquals(3, submittedCount);
            assertEquals(0, previewToSubmit.size());
            assertEquals(1, serverHits.get());

            // 3. Backward compatibility check on runAllDemos
            assertEquals(17, AbiJavaSdkDemo.runAllDemos(serverUrl, 7L, "tok_demo_7"));
        } finally {
            server.stop(0);
        }
    }

    @Test
    void unsupportedMutableTrackMethodsThrowAndDoNotEnqueue() {
        StagingConsumer staging = new StagingConsumer();
        try (AbiAnalytics sdk = new AbiAnalytics(staging)) {
            assertThrows(UnsupportedOperationException.class, () ->
                    sdk.trackFirst("u_1", "v_1", "DeviceActivation", "chk_1", Map.of("channel", "ios"))
            );
            assertThrows(UnsupportedOperationException.class, () ->
                    sdk.trackUpdate("u_1", "v_1", "OrderState", "evt_1", Map.of("status", "paid"))
            );
            assertThrows(UnsupportedOperationException.class, () ->
                    sdk.trackOverwrite("u_1", "v_1", "OrderState", "evt_1", Map.of("status", "settled"))
            );
            assertEquals(0, staging.size());
        }
    }

    @Test
    void abiJavaSdkDemoRunsAllScenariosEndToEnd() throws Exception {
        assertDoesNotThrow(() -> AbiJavaSdkDemo.main(new String[]{}));
        assertDoesNotThrow(() -> AbiJavaSdkDemo.main(new String[]{"--scenario=all", "--dynamic-super", "--yes"}));
    }
}
