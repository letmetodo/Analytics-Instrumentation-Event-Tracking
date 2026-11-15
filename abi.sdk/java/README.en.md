# ABI Java Server SDK Guide & Examples (`abi-java-sdk`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`abi-java-sdk` is the official **Java Server Data Ingestion SDK** for the ABI User Behavior Analytics (UBA) & BI platform (semantically compatible with ThinkingData TA Java SDK v3.4), engineered for high-concurrency microservices, transactional backends, and batch processing jobs.

---

## 1. Key Features

- **Multi-Channel `Consumer` Architecture**:
  - `StagingConsumer` (Recommended for Staging Preview & Interactive Debugging): Buffers pending events in memory without automatically triggering network requests; supports calling `previewRequestJson(...)` first to inspect the pretty-printed `POST /collect/api/v1/track/batch` request payload, and then calling `confirmSubmit(targetConsumer)` to deliver the batch in one shot after human or programmatic verification.
  - `BatchConsumer` (Recommended for Production): Asynchronous batched HTTP ingestion backed by a bounded in-memory blocking queue and a scheduled daemon thread. Supports Gzip compression and exponential backoff retries on network jitter, `5xx`, and `429` responses while strictly preserving `event_id` idempotency across retries.
  - `DebugConsumer` (Integration Debugging & CI Quality Gates): Synchronously sends events one by one with Gateway L4 strict metadata and schema validation enabled; supports `dryRun=true` to validate without persisting, preventing test data from polluting production Kafka and StarRocks tables.
  - `LoggerConsumer` (High-Throughput Offline Disk Logging): Appends tracking and user profile events into local `.jsonl` files rotated automatically by UTC calendar day. Pairs seamlessly with Filebeat / Vector / LogBus sidecar collectors to completely decouple core transaction paths from external network I/O.
- **ThinkingData-Aligned Dual-ID Automatic Identity Stitching**: Wire events carry strictly two identity fields—visitor/device ID (`distinct_id` ≤ 64 UTF-8 bytes) and authenticated account ID (`login_id` ≤ 128 UTF-8 bytes), requiring at least one non-blank without ever copying `login_id` into `distinct_id` when `distinct_id` is empty. No dedicated identity-binding method or special binding event is needed: whenever any `track*` or `user*` event carries both `login_id` and `distinct_id`, Flink ETL automatically stitches them in `identity_map`.
- **Idempotent Ingestion (Note: `trackFirst`/`trackUpdate`/`trackOverwrite` are marked unsupported in current version per D7① / G6 gate)**: Supports idempotent ingestion with a deterministic `event_id` (`trackWithId`); `trackFirst` deduplication and mutable `trackUpdate`/`trackOverwrite` are converged as unsupported in current version. Use `trackWithId` within the same partition window for idempotency.
- **Complete User Profile Operations**: Built-in support for all 7 profile mutation primitives—`userSet`, `userSetOnce`, `userAdd`, `userAppend`, `userUniqAppend`, `userUnset`, and `userDelete`—while automatically isolating behavioral event Super Properties so server environment metadata never pollutes user profile tables.
- **Strong Type Safety & Precision Protection**:
  - **Snowflake 64-Bit Integer Precision Guard**: `Long` properties exceeding the IEEE-754 safe integer range (`> 2^53 - 1`, i.e., `9007199254740991`) are automatically serialized as strings to prevent mantissa truncation in frontend JavaScript or downstream JSON parsers.
  - **UTC Timestamp Normalization**: `java.time.Instant` and `java.util.Date` values are automatically formatted as standard UTC ISO-8601 strings (e.g., `2026-11-10T02:15:30Z`).

---

## 2. Requirements, Build & Installation

- **JDK Version**: Java 11 or later (`maven.compiler.source = 11`)
- **Build Tool**: Maven 3.8+
- **Runtime Dependencies**: Only depends on `com.fasterxml.jackson.core:jackson-databind` and the standard JDK library—zero heavyweight framework intrusion.

### Maven Coordinates

```xml
<dependency>
    <groupId>com.anylink.abi</groupId>
    <artifactId>abi-java-sdk</artifactId>
    <version>1.0.0</version>
</dependency>
```

### Local Compilation & Unit Tests

> On macOS with multiple JDKs installed, explicitly specifying Java 11 is recommended:

```bash
cd abi.sdk/java
JAVA_HOME=$(/usr/libexec/java_home -v 11) mvn test
```

---

## 3. Running the Two-Step Demo (1. Configure & Preview Request JSON → 2. Confirm Submission)

The built-in [`AbiJavaSdkDemo`](src/main/java/com/anylink/abi/sdk/examples/AbiJavaSdkDemo.java) uses a clean **two-step interactive workflow** (replacing noisy multi-batch console logs):
1. **Step 1 (Configure Parameters & Preview Request JSON)**: Based on the selected business scenario and super property configuration, prints **a single, pretty-printed `POST /collect/api/v1/track/batch` request JSON preview** to the terminal without making any network requests;
2. **Step 2 (Confirm Submission)**: Prompts for confirmation in interactive terminals (`[y/N]: `), and only dispatches the batch after entering `y` (or when `--yes` is passed / running in a non-interactive environment), printing **a single gateway response summary**.

### 3.1 Default Zero-Dependency Local Preview & Confirmation Mode

When `--server-url` is omitted, Step 1 displays the staged JSON payload; once confirmed in Step 2, the demo automatically starts a lightweight local mock gateway to receive the batch and return a response:

```bash
cd abi.sdk/java
JAVA_HOME=$(/usr/libexec/java_home -v 11) mvn compile exec:java \
  -Dexec.mainClass="com.anylink.abi.sdk.examples.AbiJavaSdkDemo"
```

### 3.2 Customizing Super Properties, Scenarios & Connecting to a Real `:8081` Ingest Gateway

```bash
cd abi.sdk/java
JAVA_HOME=$(/usr/libexec/java_home -v 11) mvn compile exec:java \
  -Dexec.mainClass="com.anylink.abi.sdk.examples.AbiJavaSdkDemo" \
  -Dexec.args="--server-url http://127.0.0.1:8081 --project-id 1 --project-token abi_live_token \
  --scenario=order --super-props='{\"$app_version\":\"3.5.0\",\"env\":\"staging\"}' --dynamic-super"
```

To skip the interactive `[y/N]` prompt in scripts or automated verification, append `--yes` (and optionally `--dry-run` for validation without storage persistence):

```bash
cd abi.sdk/java
JAVA_HOME=$(/usr/libexec/java_home -v 11) mvn compile exec:java \
  -Dexec.mainClass="com.anylink.abi.sdk.examples.AbiJavaSdkDemo" \
  -Dexec.args="--server-url http://127.0.0.1:8081 --project-id 1 --project-token abi_live_token \
  --scenario=all --dry-run --yes"
```

### 3.3 Using `StagingConsumer` for Two-Step Preview & Confirmed Submission in Java Code

When performing local self-checks or building operational backfill utilities, developers can use `StagingConsumer` directly to inspect the generated request payload before confirming delivery:

```java
import com.anylink.abi.sdk.AbiAnalytics;
import com.anylink.abi.sdk.BatchConsumer;
import com.anylink.abi.sdk.StagingConsumer;

import java.time.Instant;
import java.util.Map;

public class TwoStepSubmitExample {
    public static void main(String[] args) throws Exception {
        StagingConsumer staging = new StagingConsumer();

        // Step 1: Configure super properties and record events (buffered in memory only, zero network I/O)
        try (AbiAnalytics sdk = new AbiAnalytics(staging)) {
            sdk.setSuperProperties(Map.of("$platform", "java-server", "service_name", "order-service"));
            sdk.trackWithId(
                    "user_8848",     // Authenticated account ID (login_id)
                    "vis_sess_9001", // Frontend visitor/device distinct_id forwarded via X-ABI-Distinct-Id header
                    "OrderPaid",
                    "ord_paid_ORD202611108848",
                    Map.of(
                            "#ip", "203.0.113.42",          // Real client public IP extracted from X-Forwarded-For / X-Real-IP
                            "order_id", 9007199254740999L,  // > 2^53-1 Snowflake Long, auto-serialized as string "9007199254740999"
                            "order_no", "ORD202611108848",
                            "amount", 299.00,
                            "paid_at", Instant.now()
                    )
            );
        }

        // Inspect the pretty-printed POST /collect/api/v1/track/batch request JSON
        String requestJson = staging.previewRequestJson(1L, "abi_live_token", false);
        System.out.println("Pending Request JSON:\n" + requestJson);

        // Step 2: Once verified manually or programmatically, deliver to BatchConsumer / DebugConsumer and clear the staging queue
        BatchConsumer.Config cfg = new BatchConsumer.Config("http://127.0.0.1:8081", 1L, "abi_live_token");
        try (BatchConsumer batchConsumer = new BatchConsumer(cfg)) {
            int submittedCount = staging.confirmSubmit(batchConsumer);
            System.out.println("Confirmed and submitted event count: " + submittedCount);
        }
    }
}
```

---

## 4. Demo CLI Options & Environment Variables

CLI flags take precedence over corresponding environment variables (both `--key value` and `--key=value` syntaxes are supported):

| CLI Option | Environment Variable | Default Value | Description |
| :--- | :--- | :--- | :--- |
| `--server-url` | `ABI_SERVER_URL` | Empty (starts built-in mock gateway on confirm) | Base URL of the ABI Ingest Gateway, e.g., `http://127.0.0.1:8081` (the SDK automatically appends `/collect/api/v1/track/batch`) |
| `--project-id` | `ABI_PROJECT_ID` | `1` | Numeric project ID assigned in ABI Admin (must be `> 0`) |
| `--project-token` | `ABI_PROJECT_TOKEN` | `abi_demo_project_token` | Ingestion authentication token for the ABI project |
| `--scenario` | `ABI_SCENARIO` | `order` | Preview scenario: `order` (order lifecycle) \| `browse` (anonymous browsing) \| `identity` (login identity binding) \| `profile` (7 user profile operations) \| `all` (all combined) |
| `--super-props` | `ABI_SUPER_PROPS` | Built-in sample static super properties | JSON object string for static super properties, e.g., `'{"$app_version":"3.5.0","env":"prod"}'` (pass `'{}'` to clear) |
| `--dynamic-super` | `ABI_DYNAMIC_SUPER` | `false` | Dynamic super properties toggle (pass `--dynamic-super` to inject `request_seq` and `trace_ts`) |
| `--dry-run` | `ABI_DRY_RUN` | `false` | Whether to mark `"dry_run": true` in the request payload (gateway validates without writing to storage) |
| `--yes` / `-y` | `ABI_AUTO_CONFIRM` | `false` | Skip interactive terminal `[y/N]` confirmation prompt and submit immediately after preview |

---

## 5. `AbiJavaSdkDemo` Core Methods Reference

`AbiJavaSdkDemo` provides both the two-step workflow entry points (`buildScenarioPreview` + `confirmAndSubmit`) and standalone static methods for each business scenario as well as the full end-to-end runner `runAllDemos`:

### 5.0 Two-Step Core Entry Points: `buildScenarioPreview(...)` & `confirmAndSubmit(...)`
- **`buildScenarioPreview(DemoConfig config)`**: Initializes `StagingConsumer` and `AbiAnalytics` from the configuration, injects static/dynamic super properties, records the scenario events, prints a single clean request JSON preview to the console, and returns the `StagingConsumer`.
- **`confirmAndSubmit(StagingConsumer staging, DemoConfig config)`**: Handles the interactive `[y/N]` confirmation (calling `staging.clear()` with zero network requests if cancelled) and, once confirmed, dispatches a single batch via `staging.confirmSubmit(...)` and prints the gateway response.

### 5.1 Anonymous Browsing & Static/Dynamic Super Properties: `triggerAnonymousBrowseAndSuperProps(AbiAnalytics sdk)`
- **What It Demonstrates**:
  1. Calls `sdk.setSuperProperties(...)` to register global static super properties (such as `$app_version`, `$platform`, `service_name`), automatically injected into all subsequent behavioral events.
  2. Calls `sdk.setDynamicSuperProperties(Supplier)` to register a dynamic super property callback (such as incrementing `request_seq` and `trace_ts`), evaluated on every `track` invocation.
  3. Simulates an unauthenticated visitor (passing `loginId = ""` and `distinctId = "vis_sess_9001"`) reporting two browsing events: `$pageview` and `ProductViewed`.
- **Property Override Precedence**: Explicit `track` event properties > Dynamic super properties (`DynamicSuperProperties`) > Static super properties (`SuperProperties`).

### 5.2 Dual-ID Automatic Identity Stitching on Signup / Login: `triggerLoginIdentityBinding(AbiAnalytics sdk)`
- **What It Demonstrates**:
  1. Aligned with ThinkingData's dual-ID model, no separate identity-binding call is required—at signup/login, directly call `sdk.track("user_8848", "vis_sess_9001", "$signup", ...)` and `"$login"` with both `loginId` and the visitor `distinctId`.
  2. Whenever Flink Job1 ETL observes any event carrying both non-empty `login_id` and `distinct_id`, it automatically records the mapping in StarRocks `identity_map` to stitch prior visitor activity to account `user_8848`.

### 5.3 Order Milestone Events & Safe Snowflake Long Serialization: `triggerOrderLifecycleTrackUpdateOverwrite(AbiAnalytics sdk)`
- **What It Demonstrates**:
  1. **Idempotent Milestone Events via `trackWithId`**: Reports `OrderCreated`, `OrderPaid`, and `OrderSettled` as distinct milestone events with deterministic business primary keys (*Note: per D7① / G6 gate, `trackFirst` / `trackUpdate` / `trackOverwrite` are unsupported in current version and throw `UnsupportedOperationException` without enqueueing*).
  2. **Snowflake 64-Bit Integer Precision Protection**: Passes `9007199254740999L` (greater than JS max safe integer `2^53 - 1`) for `order_id`; the SDK automatically serializes it as the string `"9007199254740999"` over the wire.

### 5.4 All 7 User Profile Operations: `triggerUserProfileOperations(AbiAnalytics sdk)`
- **What It Demonstrates**: Exercises all 7 user profile (`dim_users`) mutation APIs supported by ABI (**Note**: all `$user_*` events automatically strip `superProperties` and `dynamicSuperProperties`):

| SDK Method | Underlying System Event | Business Semantics & Typical Use Cases |
| :--- | :--- | :--- |
| `userSet` | `$user_set` | Overwrites latest user profile attributes (e.g., nickname `display_name`, membership tier `vip_tier`, home city `$city`) |
| `userSetOnce` | `$user_set_once` | Sets attributes only if not already present without overwriting existing values (e.g., first-touch ad channel `first_utm_source`, registration time `first_registered_at`) |
| `userAdd` | `$user_add` | Atomically increments or decrements numeric attributes (e.g., loyalty points delta `loyalty_points: 300`, cumulative spend `lifetime_spend: 269.10`) |
| `userAppend` | `$user_append` | Appends elements to a list attribute without deduplication (e.g., browsed category history `viewed_categories`) |
| `userUniqAppend` | `$user_uniq_append` | Appends elements to a list attribute with set deduplication (e.g., enabled `feature_flags`, earned badges) |
| `userUnset` | `$user_unset` | Clears one or more specified user attributes (e.g., removing an expired trial flag `legacy_trial_badge`) |
| `userDelete` | `$user_del` | Marks the user profile record for deletion/erasure (supporting privacy and compliance erasure requests) |

### 5.5 `DebugConsumer` Dry-Run Online Validation: `triggerDebugDryRunValidation(serverUrl, projectId, projectToken)`
- **What It Demonstrates**: Instantiates `new DebugConsumer(serverUrl, projectId, projectToken, true)` (4th argument `dryRun = true`) and synchronously sends the `CheckoutValidated` event.
- **Intended Use Case**: Developer local verification and CI automated regression gates. The payload automatically includes `"debug": true, "dry_run": true`. If an event name, property key, or property value type violates ABI Gateway L4 metadata rules, the call immediately throws a synchronous `IllegalArgumentException` with the detailed rejection reason; when validation passes, the gateway returns success **without writing to production analytical tables**.

### 5.6 `LoggerConsumer` Local JSONL Rotation: `triggerLoggerConsumerDemo(Path outputDir)`
- **What It Demonstrates**: Instantiates `new LoggerConsumer(outputDir.toFile(), "abi_demo")` to append the offline settlement event `NightlySettlementCompleted` and user profile updates directly to local disk files named `abi_demo.YYYY-MM-DD.jsonl` in UTF-8 JSON Lines format.
- **Rotation Mechanism**: Automatically rolls over to a new file by UTC date (`YYYY-MM-DD`); each line contains one complete event JSON object, natively compatible with Filebeat, Vector, or LogBus sidecar shippers.

---

## 6. Consumer Selection & Configuration Reference

| Consumer Implementation | I/O Model | Recommended Environment | Key Characteristics |
| :--- | :--- | :--- | :--- |
| `StagingConsumer` | In-memory staging queue (delivers only on explicit confirmation) | **Local Parameter Inspection / Ops Backfill Tools** | Zero automatic network requests; supports `previewRequestJson` full payload preview, `clear` reset, and `confirmSubmit` delivery |
| `BatchConsumer` | In-memory queue buffer + background scheduled/size-triggered batch HTTP | **Production Microservices** | Non-blocking business threads, Gzip compression, exponential backoff retries on network errors and `5xx`/`429` |
| `DebugConsumer` | Synchronous blocking single-event HTTP per `track` call | **Local Integration / CI Testing** | Surfaces gateway schema rejection details immediately; supports `dryRun=true` zero-pollution preflight checks |
| `LoggerConsumer` | Buffered sequential local disk append (`BufferedWriter`) | **Ultra-High-Throughput Trading / Air-Gapped Batch Jobs** | Zero network latency; automatically rotates `<prefix>.YYYY-MM-DD.jsonl` files by UTC calendar day |

### `BatchConsumer.Config` Options Reference

| Field | Type | Default | Description |
| :--- | :--- | :--- | :--- |
| `serverUrl` | `String` | Required | Ingest gateway base URL (e.g., `https://collect.example.com`) |
| `projectId` | `long` | Required (`> 0`) | Project ID |
| `projectToken` | `String` | Required | Project ingestion authentication token |
| `batchSize` | `int` | `50` | Maximum events per batch flush (valid range: `1 ~ 500`) |
| `flushIntervalMs` | `long` | `2000L` | Background periodic flush interval in milliseconds (minimum `100ms`) |
| `maxQueueSize` | `int` | `10000` | Maximum capacity of the in-memory pending queue (`add` throws `IllegalStateException` when full to protect heap memory) |
| `maxRetries` | `int` | `3` | Maximum exponential backoff retries on network errors, `429`, or `5xx` (`4xx` permanent client errors are never retried) |
| `compressGzip` | `boolean` | `false` | Whether to enable `Content-Encoding: gzip` request body compression (strongly recommended over public networks or cross-AZ links in production) |
| `dryRun` | `boolean` | `false` | Whether to include `"dry_run": true` in batch request payloads (validates without writing to storage) |

---

## 7. Required Server-Side Fields & Client Passthrough Guide (IP / Identity / Time / Idempotency Key)

### 7.1 Why Do Server-Side SDK Required Fields Differ from Frontend / Mobile SDKs?

- **Frontend / Mobile SDKs (Web / iOS / Android / Mini-Program)**: Run on a **single-user client device** and connect directly to the Ingest Gateway. The client SDK automatically generates and persists `distinct_id` on the device (and calling client `login(accountId)` is pure local state without sending a separate request), collects device context (`$os` / `$device_model` / `$app_version`), and allows the Ingest Gateway to extract the user's real public IP directly from the client TCP connection.
- **Go / Java Server-Side SDKs**: Run as a **stateless, multi-user shared singleton inside backend data centers or cloud VPCs**. A server SDK cannot cache single-user session state in memory, and its TCP connection to the `:8081` Ingest Gateway only exposes the **backend server's internal/IDC egress IP** (and `LoggerConsumer` disk logging has no network connection IP at all). Therefore, **user identity, real client IP, actual event occurrence time, and deterministic idempotency keys** must be explicitly passed by integration engineers from the current request context or message payload.

### 7.2 Server-Side Field Requirement & Source Reference Table

| Field Category | SDK Parameter / `properties` Key | Requirement Level | Why It Matters & Where to Extract It |
| :--- | :--- | :--- | :--- |
| **User Identity**<br>(`loginId` / `distinctId`) | Java: `(loginId, distinctId, ...)` arguments | **[Required on Every Call]** | The server is stateless; every `track*` / `user*` call must explicitly pass the current request user's `loginId` (account ID ≤ 128 bytes) or client-forwarded `distinctId` (visitor/device ID ≤ 64 bytes). **At least one of `loginId` or `distinctId` must be non-blank** (otherwise `missing_identity` is thrown), and when `distinctId` is empty the SDK sends `"distinct_id": ""` directly without copying `loginId` into `distinct_id`.<br>To stitch the **"Frontend Visitor Browse → Backend Order Payment"** conversion funnel, forward `distinct_id` from the frontend via an HTTP header (e.g., `X-ABI-Distinct-Id`) and pass both `loginId` and `distinctId`. |
| **Real Client IP**<br>(`#ip` / `$ip`) | `properties.get("#ip")`<br>(or `properties.get("$ip")`) | **[Required for Geo Analysis]** | When a backend server connects to the `:8081` Ingest Gateway, the gateway TCP socket only sees the **backend server's data center IP** (`LoggerConsumer` has no socket IP at all). **If `#ip` / `$ip` is omitted, every server event's country/province/city will resolve to your data center location or private LAN IP!**<br>Extract the user's real public IP from HTTP headers (`X-Forwarded-For` first hop or `X-Real-IP`) and put it in `properties` under `"#ip"` (or `"$ip"`). The Gateway and Flink Job1 ETL prioritize `#ip` > `$ip` to resolve `$country` / `$province` / `$city` and automatically strip the temporary IP key before persisting `properties`. |
| **Event Occurrence Time**<br>(`#time` / `$time` / `Date`·`Instant` overload) | `"#time"` / `"$time"` in `properties`<br>or `track*(..., Date / Instant)` overloads | **[Optional for Real-Time; Required for Async MQ / Callbacks / Backfill]** | Synchronous real-time APIs default to the server's current wall clock when omitted. However, for **async Kafka/RocketMQ consumers, payment webhooks, or offline batch backfills**, you must pass the actual business occurrence time via `properties.put("#time", ...)` (accepts `Date`, `Instant`, unix sec/ms, ISO-8601, or `"yyyy-MM-dd HH:mm:ss.SSS"`) or the `Date` / `Instant` method overloads (must fall within the project's `ts_window_days` window; automatically stripped from `properties` after extraction). |
| **Idempotent Event ID**<br>(`event_id`) | `trackWithId(..., eventId, ...)` | **[Strongly Recommended for MQ & Core Transactions]** | When omitted, `track(...)` generates a random UUIDv4. However, if **MQ retries, webhook replays, or backfill reruns** generate a new UUID each time, duplicate events and inflated revenue metrics will occur. Use `trackWithId` with a deterministic business primary key (e.g., `"ord_paid_" + orderNo`, ≤ 64 bytes) for same-day idempotent deduplication (*Note: `trackFirst` / `trackUpdate` / `trackOverwrite` are unsupported in current version*). |
| **Client Device Context**<br>(`$os` / `$app_version` / `$device_model`) | `"$os"`, `"$app_version"`, `"$device_model"` in `properties` | **[Passthrough from Frontend on Demand]** | Backend servers cannot auto-detect a user's phone model or client app version. If you need to break down server-side events by client OS or app version, forward them from frontend HTTP headers (e.g., `X-Client-OS`, `X-App-Version`) into per-event `properties` (never put per-user device info into global `setSuperProperties`). |

---

## 8. Spring Boot & Server Production Best Practices

### 8.1 Global Singleton Bean & Graceful Shutdown (Never `new` per Request)

Both `AbiAnalytics` and `BatchConsumer` are thread-safe and maintain background scheduler thread pools. In Spring Boot, register `AbiAnalytics` as a **global singleton Bean** with `destroyMethod = "close"` so that remaining queued events are automatically drained and flushed on application shutdown (`SIGTERM`):

```java
package com.example.shop.config;

import com.anylink.abi.sdk.AbiAnalytics;
import com.anylink.abi.sdk.BatchConsumer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.Map;

@Configuration
public class AbiAnalyticsConfig {

    @Bean(destroyMethod = "close")
    public AbiAnalytics abiAnalytics(
            @Value("${abi.collect.server-url}") String serverUrl,
            @Value("${abi.collect.project-id}") long projectId,
            @Value("${abi.collect.project-token}") String projectToken,
            @Value("${spring.application.name:order-service}") String serviceName,
            @Value("${spring.profiles.active:prod}") String env
    ) {
        BatchConsumer.Config config = new BatchConsumer.Config(serverUrl, projectId, projectToken);
        config.batchSize = 100;
        config.flushIntervalMs = 2000L;
        config.maxQueueSize = 20000;
        config.maxRetries = 3;
        config.compressGzip = true;

        AbiAnalytics sdk = new AbiAnalytics(new BatchConsumer(config));
        // Register service-level static super properties (injected into behavioral events only; never put single-user IP or device info here)
        sdk.setSuperProperties(Map.of(
                "$platform", "java-server",
                "service_name", serviceName,
                "deploy_env", env
        ));
        return sdk;
    }
}
```

### 8.2 Business Service Integration, Client IP / Visitor `distinct_id` Passthrough & Fault Isolation Example

In critical transactional flows, we recommend:
1. **Extracting the real client public IP (`X-Forwarded-For` / `X-Real-IP`) and frontend visitor `distinct_id` (`X-ABI-Distinct-Id`) from HTTP headers**, passing `"#ip"` in `properties` along with both `loginId` and `distinctId`;
2. **Using a deterministic business idempotency key as `eventId`** (e.g., `"ord_paid_" + orderNo`) to prevent duplicate counting when message queue consumers retry;
3. **Wrapping tracking calls in a defensive `try-catch` block** so extreme queue saturation or parameter validation exceptions never interrupt core business transactions.

```java
package com.example.shop.service;

import com.anylink.abi.sdk.AbiAnalytics;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

@Service
public class OrderAnalyticsService {
    private static final Logger log = LoggerFactory.getLogger(OrderAnalyticsService.class);

    private final AbiAnalytics abiAnalytics;

    public OrderAnalyticsService(AbiAnalytics abiAnalytics) {
        this.abiAnalytics = abiAnalytics;
    }

    /**
     * @param loginId           Authenticated user ID (login_id)
     * @param visitorDistinctId Frontend visitor/device ID forwarded via X-ABI-Distinct-Id header (distinct_id)
     * @param clientIp          Real client public IP extracted from X-Forwarded-For / X-Real-IP
     * @param orderNo           Business order number (used to build a deterministic event_id)
     * @param snowflakeOrderId  64-bit Snowflake order ID (> 2^53-1 is automatically serialized as a string)
     * @param payAmount         Actual paid amount
     * @param orderPaidTime     Actual payment occurrence time (required for async MQ consumers or webhooks)
     */
    public void recordOrderPaid(
            String loginId,
            String visitorDistinctId,
            String clientIp,
            String orderNo,
            long snowflakeOrderId,
            double payAmount,
            Instant orderPaidTime
    ) {
        try {
            // Use a deterministic eventId for MQ replay idempotency; Snowflake Longs > 2^53-1 are automatically serialized as strings
            String deterministicEventId = "ord_paid_" + orderNo;
            Map<String, Object> props = new HashMap<>();
            props.put("order_id", snowflakeOrderId);
            props.put("order_no", orderNo);
            props.put("pay_amount", payAmount);
            props.put("#time", orderPaidTime != null ? orderPaidTime : Instant.now()); // Extracted as top-level timestamp and stripped from properties
            if (clientIp != null && !clientIp.isBlank()) {
                props.put("#ip", clientIp); // Pass real client public IP so GeoIP resolves user location instead of server IDC
            }

            abiAnalytics.trackWithId(
                    loginId,
                    visitorDistinctId,
                    "OrderPaid",
                    deterministicEventId,
                    props
            );

            // Atomically increment the user's cumulative paid amount
            abiAnalytics.userAdd(
                    loginId,
                    visitorDistinctId,
                    Map.of("total_paid_amount", payAmount)
            );
        } catch (Exception ex) {
            // Log warning on tracking failure without disrupting the primary order transaction
            log.warn("Failed to report ABI order payment event, orderNo={}, orderId={}", orderNo, snowflakeOrderId, ex);
        }
    }
}
```

### 8.3 Identifier & Property Validation Rules Quick Reference

| Validation Item | Constraint Rule |
| :--- | :--- |
| Identity Presence | Wire payloads carry only `distinct_id` (visitor/device ID) and `login_id` (account ID); **at least one of `distinctId` or `loginId` must be non-blank**. When `distinctId` is blank, `"distinct_id": ""` is sent directly—`loginId` is NEVER copied into `distinct_id` |
| Byte Length Limits | `distinct_id` ≤ 64 UTF-8 bytes, `login_id` ≤ 128 UTF-8 bytes, `event_id` ≤ 64 UTF-8 bytes |
| Event Names & Property Keys | Custom names must match `^[A-Za-z_][A-Za-z0-9_]*$` (event names ≤ 128 chars, custom property keys ≤ 64 chars); built-in system events (e.g., `$pageview`, `$signup`, `$login`, `$user_set`) and system properties (e.g., `#ip`, `$ip`, `#time`, `$time`, `$os`, `$app_version`, `$device_model`, `$city`, `$url`) are whitelisted |
| Supported Property Value Types | `String`, `Boolean`, `Byte`/`Short`/`Integer`/`Long`, finite `Float`/`Double` (`NaN`/`Infinity` rejected), `Date`, `Instant`, and 1D `Collection`s with non-null elements and no nested collections/maps; property entries with `null` values are automatically ignored |
