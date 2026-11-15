# ABI Android Kotlin Client SDK Guide (`abi.sdk/mobile/android`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

[`AbiAnalytics.kt`](AbiAnalytics.kt) is a zero-dependency native Android data collection and analytics SDK written in Kotlin. Built purely on the Android framework and standard Java libraries (`HttpURLConnection`, `org.json`, `ConcurrentLinkedQueue`, `SystemClock.elapsedRealtime`), it fully complies with the ABI ingest gateway `POST /collect/api/v1/track/batch` contract and the ThinkingData v3.4 specification.

> Back to Mobile SDK Overview: [简体中文](../README.md) | [English](../README.en.md) | [日本語](../README.ja.md)

---

## Developer Integration Guide: Required Fields vs. SDK Auto-Collected vs. Gateway/Server Enriched (e.g., IP)

From an Android client engineer's perspective, all tracking fields fall into three clear categories:

| Category | Stage / Field Name | Developer Action | Source & Handling Mechanism |
|----------|--------------------|------------------|-----------------------------|
| **Category 1: Required Fields Passed by Developer** | **Initialization (`init` / `initialize`)**: `serverUrl`, `projectId` (`> 0`), `projectToken` / `token` | **Required** | Passed to `AbiAnalytics.init` to specify the `:8081` ingest gateway URL, project ID (`> 0`), and non-empty project key. |
| | **Event Tracking (`track`)**: `eventName` | **Required** | Business event name (e.g., `"OrderPaid"`), with optional business attributes in `properties`. |
| | **Account Login (`login`)**: `accountId` (`login_id`) | **Required on Login** | Calls `login(accountId)` to persist `login_id` locally (`<= 128` UTF-8 bytes, never overwrites `distinct_id`, sends no network event). |
| | **Mutable Events (`trackUpdate` / `trackOverwrite`)**: `eventId` | **Unsupported in current version** | Per D7① / G6 gate, `trackFirst` / `trackUpdate` / `trackOverwrite` are not yet enabled in the current StarRocks `dwd_events` model. |
| **Category 2: Auto-Generated & Persisted by SDK (No Manual Input Needed)** | `distinct_id` | **Auto-generated** | Generates a UUIDv4 on init and persists it under the `distinct_id` key in `SharedPreferences`; updated only via `identify` and never overwritten by `login`. |
| | `event_id` | **Auto-generated** | Generates a UUIDv4 on every `track` call and preserves it across offline/weak-network retries for idempotency. |
| | `timestamp` | **Auto-generated** | Automatically uses the client's current millisecond timestamp (unless explicitly overridden via `#time` / `$time` for historical events). |
| | Preset Device & Environment Properties: `$lib`, `$lib_version`, `$os`, `$os_version`, `$device_model`, `$screen_width`, `$screen_height`, `$url`, `$title`, `$referrer`, `$zone_offset` | **Auto-collected** | Automatically collected and merged by the SDK (`$user_*` profile operations automatically isolate preset and super properties). |
| **Category 3: Enriched by Ingest Gateway / Server (Unavailable on Client)** | **Public IP & Geo Location (`#ip` / `$ip` $\rightarrow$ Country / Province / City)** | **Never pass from client** | When the client connects directly to the `:8081` ingest gateway, the gateway extracts the real client IP from the HTTP connection (`X-Forwarded-For` / `X-Real-IP`) and Flink resolves country, province, and city. |

1. **Category 1: Fields Developers MUST Explicitly Pass**
   - **Initialization (`init` / `initialize`)**: `serverUrl` (ingest gateway URL), `projectId` (`> 0`), and `token` / `projectToken` (non-empty project key).
   - **Event Tracking (`track`)**: `eventName` (required, e.g., `"OrderPaid"`).
   - **Account Login (`login`)**: Pass `accountId` (`login_id`) when the user completes authentication. Updates `login_id` locally (without overwriting `distinct_id` or sending any network event) so subsequent events carry both `distinct_id` and `login_id`.
   - **Same-Day Retry Idempotency (`track` optional `eventId`)**: Optionally pass a deterministic `eventId` on `track` for same-day retry deduplication (`trackFirst` / `trackUpdate` / `trackOverwrite` are unsupported in the current version per D7① / G6 gate).
2. **Category 2: Fields Auto-Generated & Persisted by the SDK (No Manual Input Required)**
   - **`distinct_id` (Visitor / Device ID)**: Generated as UUIDv4 upon initialization and persisted under the `distinct_id` key in `SharedPreferences` (max 64 UTF-8 bytes); never overwritten by `login()`.
   - **`event_id`**: Generated as UUIDv4 on every `track` call and kept unchanged across offline/weak-network retries for idempotent deduplication.
   - **`timestamp`**: Defaults to the client's current millisecond timestamp (unless a historical time is explicitly specified via `#time` / `$time`).
   - **Device & Environment Preset Properties**: `$lib`, `$lib_version`, `$os`, `$os_version`, `$device_model`, `$screen_width`, `$screen_height`, `$url`, `$title`, `$referrer`, `$zone_offset`.
3. **Category 3: Fields Unavailable to Clients & Populated by Gateway/Server (`IP` & Cross-Stack Stitching)**
   - **Public IP & Geo Resolution (`#ip` / `$ip` $\rightarrow$ Country/Province/City)**: Browser JS, MiniPrograms, and mobile apps run inside client sandboxes behind NAT routers and **cannot reliably obtain their own public egress IP—therefore, client integrations must NEVER pass `$ip` / `#ip`**! When clients report directly to the `:8081` ingest gateway, the gateway automatically extracts the real client IP from the HTTP connection (including Nginx/SLB `X-Forwarded-For` / `X-Real-IP` headers) and Flink automatically resolves country, province, and city.
   - **When SHOULD `#ip` / `$ip` be passed?** Only when your architecture routes requests as "Client calls your business backend API $\rightarrow$ Go/Java Server SDK reports tracking events on behalf of the user". Because the ingest gateway sees the backend server's datacenter IP in that topology, your business backend should extract the client IP from the incoming request and pass it via `#ip` / `$ip` to the server SDK. At the same time, we recommend forwarding the visitor ID (`sdk.distinctId`) in a request header when calling your backend API so the server can stitch client-to-server funnels.

---

## 1. Integration & Environment Setup

### 1.1 Source Integration (Zero Third-Party Gradle Dependencies)
1. Copy [`AbiAnalytics.kt`](AbiAnalytics.kt) into your Android module's source tree under `com/anylink/abi/sdk/android/` (no third-party dependencies such as OkHttp or Gson are required).
2. To use the interactive verification screen or headless verification helpers, copy [`example/AbiDemoActivity.kt`](example/AbiDemoActivity.kt) into `com/anylink/abi/sdk/android/example/`.

### 1.2 `AndroidManifest.xml` Permissions & Network Configuration
Declare the `INTERNET` permission in your module's `AndroidManifest.xml`. When testing against a local cleartext HTTP gateway (`http://10.0.2.2:8081` from the Android Emulator), enable `android:usesCleartextTraffic="true"` in development and register `AbiDemoActivity`:

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.yourcompany.app">

    <!-- Required for sending batch tracking requests -->
    <uses-permission android:name="android.permission.INTERNET" />

    <application
        android:usesCleartextTraffic="true"
        ...>
        <!-- Optional: Register the two-step interactive demo Activity -->
        <activity
            android:name="com.anylink.abi.sdk.android.example.AbiDemoActivity"
            android:exported="true"
            android:label="ABI Android SDK Demo" />
    </application>
</manifest>
```

---

## 2. Initialization & Core API Quick Reference

### 2.1 SDK Initialization (`AbiAnalytics.init` & `AbiAnalytics.getInstance`)

Initialize the global singleton in `Application.onCreate()` (annotated with `@JvmStatic` and `@JvmOverloads` for seamless Kotlin and Java interoperability):

```kotlin
import com.anylink.abi.sdk.android.AbiAnalytics

val sdk = AbiAnalytics.init(
    serverUrl = "http://10.0.2.2:8081", // Android Emulator alias for host machine :8081 gateway
    projectId = 1L,
    projectToken = "abi_tok_android_demo",
    appVersion = "2.1.0",
    batchSize = 20,
    debug = false,
    autoFlush = true // Defaults to true in production (5s timer + batchSize threshold); set to false for two-step preview
)

// Retrieve the initialized singleton anywhere in your app
val sharedSdk = AbiAnalytics.getInstance()
```

| `init` Parameter | Type | Default | Description |
|------------------|------|---------|-------------|
| `serverUrl` | `String` | Required | Ingest gateway base URL (automatically appends `/collect/api/v1/track/batch`) |
| `projectId` | `Long` | Required | ABI project ID (`project_id`) |
| `projectToken` | `String` | Required | Project access token (`project_token`) |
| `appVersion` | `String` | `"1.0.0"` | Host app version, injected into preset property `$app_version` |
| `batchSize` | `Int` | `20` | Queue size threshold that triggers an automatic background flush |
| `debug` | `Boolean` | `false` | Debug mode (attaches `"debug": true` to the payload and triggers an immediate flush) |
| `autoFlush` | `Boolean` | `true` | Starts the 5-second background flush scheduler and threshold auto-flush (`false` requires manual `flush()`) |

---

### 2.2 Dual-ID Identity Management (`identify` / `login` / `logout`)

The SDK guarantees thread safety via `@Volatile` properties and strictly follows the ThinkingData identity contract—wire events carry only `distinct_id` (visitor/device ID, max 64 UTF-8 bytes) and `login_id` (authenticated account ID, max 128 UTF-8 bytes):
- `distinctId`: Visitor/device identifier (auto-generated UUIDv4 on init, persisted under the `distinct_id` key in `SharedPreferences` when `context` is provided).
- `loginId`: Authenticated account identifier (`""` when logged out).
- `identify(customDistinctId: String)`: Overrides the visitor/device ID locally (validates non-empty, no control characters, and ≤ 64 UTF-8 bytes; sends no network event).
- `login(accountId: String)`: Sets and persists `login_id` locally (max 128 UTF-8 bytes; **never overwrites `distinctId`**, **never emits any network event**, returns `Unit`).
- `logout()`: Clears `loginId` locally while keeping `distinctId` intact (sends no network event).

```kotlin
sdk.identify("android_visitor_device_001")
sdk.login("user_android_10001") // Pure local state update, sends no network event
println("distinctId=${sdk.distinctId}, loginId=${sdk.loginId}")
sdk.logout()
```

---

### 2.3 Static & Dynamic Super Properties (`Super Properties`)

Super properties are stored in a thread-safe `ConcurrentHashMap` and merged into all subsequent behavioral and system events (**automatically excluded from `$user_*` / `#user_*` user profile operations**). Property precedence is: `Event properties > Dynamic super properties > Static super properties > SDK preset properties ($os/$model/$manufacturer, etc.)`.

| Method Signature | Description |
|------------------|-------------|
| `setSuperProperties(props: Map<String, Any>)` | Registers or merges global static super properties |
| `unsetSuperProperty(key: String)` | Removes a single static super property by key |
| `clearSuperProperties()` | Clears all registered static super properties |
| `getSuperProperties(): Map<String, Any>` | Returns an immutable copy snapshot of current static super properties |
| `setDynamicSuperProperties(provider: (() -> Map<String, Any?>)?)` | Registers (or passes `null` to clear) a callback evaluated dynamically on each `track` call |

```kotlin
sdk.setSuperProperties(mapOf("channel" to "GooglePlay", "vip_tier" to "Gold"))
sdk.unsetSuperProperty("vip_tier")
val snapshot = sdk.getSuperProperties()

sdk.setDynamicSuperProperties {
    mapOf("network_state" to "wifi", "dyn_sequence" to 1)
}
```

---

### 2.4 Event Timing & Same-Day Idempotent Tracking (`timeEvent` / `track`)

- **Monotonic Clock Event Timing (`timeEvent`)**: Records the start time via `SystemClock.elapsedRealtime()` (immune to wall-clock adjustments); the next `track` call for the same `eventName` automatically calculates and injects `$duration` in seconds (`Double`).
- **Standard Events (`track`)**: Validates the event name and property keys, enqueues the event, and returns the idempotent `event_id`. Pass a deterministic `eventId` for same-day identical-payload retry deduplication.
- **Unsupported Mutable Event Gate (`trackFirst` / `trackUpdate` / `trackOverwrite`)**: Per D7① / G6 gate, `$first_check_id` deduplication and `trackUpdate` / `trackOverwrite` are unsupported in the current StarRocks `dwd_events` storage model (`trackUpdate` / `trackOverwrite` throw `UnsupportedOperationException` without enqueueing any fake `track` event). Model order lifecycle transitions as distinct milestone events instead.

```kotlin
// 1. Monotonic stopwatch timing and standard event tracking
sdk.timeEvent("OrderPaid")
val orderEvtId = sdk.track(
    eventName = "OrderPaid",
    properties = mapOf(
        "order_id" to "ord_9001",
        "amount" to 199.95,
        "currency" to "CNY"
    )
)

// 2. Deterministic eventId milestone event (idempotent on same-day identical-payload retries)
sdk.track(
    eventName = "OrderSettled",
    properties = mapOf(
        "order_id" to "ord_9001",
        "order_status" to "settled",
        "amount" to 199.95
    ),
    eventId = "ord_settled_9001"
)
```

---

### 2.5 7 User Profile Operations (`$user_*`)

All user profile methods correspond to the StarRocks `abi.dim_users` table. The SDK **automatically strips preset device properties and static/dynamic super properties** from `$user_*` events:

| Method Signature | System Event | Description |
|------------------|--------------|-------------|
| `userSet(properties: Map<String, Any?>)` | `$user_set` | Sets or overwrites user profile properties |
| `userSetOnce(properties: Map<String, Any?>)` | `$user_set_once` | Sets user profile properties only if they are not yet set |
| `userAdd(properties: Map<String, Number>)` | `$user_add` | Atomically increments numeric profile properties (negative values decrement) |
| `userAppend(properties: Map<String, List<Any>>)` | `$user_append` | Appends elements to list profile properties (without deduplication) |
| `userUniqAppend(properties: Map<String, List<Any>>)` | `$user_uniq_append` | Appends unique elements to list profile properties (with deduplication) |
| `userUnset(vararg keys: String)` | `$user_unset` | Clears specified user profile property keys (supports varargs) |
| `userDelete()` | `$user_del` | Marks the current user profile record for deletion |

```kotlin
sdk.userSet(mapOf("vip_level" to "Platinum", "city" to "Shanghai"))
sdk.userSetOnce(mapOf("first_install_channel" to "GooglePlay"))
sdk.userAdd(mapOf("loyalty_points" to 100))
sdk.userAppend(mapOf("interests" to listOf("analytics", "kotlin")))
sdk.userUniqAppend(mapOf("interests" to listOf("kotlin", "starrocks")))
sdk.userUnset("temp_campaign_flag", "expired_badge")
sdk.userDelete()
```

---

### 2.6 `> 2^53 - 1` Large Integer Precision Protection & `#time` / `$time` Time Extraction

1. **`> 2^53 - 1` Large Integer Precision Protection**:
   - The IEEE-754 double-precision safe integer limit is `9007199254740991L` ($2^{53}-1$, `AbiAnalytics.MAX_SAFE_INTEGER`).
   - Any `Long` property value (or list element) outside `[-9007199254740991L, 9007199254740991L]` (including `Long.MIN_VALUE` and 64-bit Snowflake IDs like `9007199254740993L`) is automatically converted to a decimal string `"9007199254740993"` in JSON to prevent precision loss.
2. **`#time` / `$time` Event Timestamp Extraction**:
   - Besides passing `timestampMs: Long?` directly to `track`, if `properties` contains `"#time"` or `"$time"` (`"#time"` takes precedence over `"$time"`), the SDK parses it into the top-level millisecond `timestamp` field and **strips `"#time"` / `"$time"` from `properties`** prior to property key validation.
   - Supported time types: `java.util.Date`, 10-digit second or 13-digit millisecond `Long`/`Int`/`Short`/`Double`/`Float` epochs, numeric epoch strings (10–16 digits), and ISO-8601 datetime strings (with optional fractional seconds and timezone offsets).

```kotlin
sdk.track(
    eventName = "OrderPaid",
    properties = mapOf(
        "#time" to "2026-11-10T08:30:00.000+08:00", // Extracted to top-level millisecond timestamp and removed from properties
        "snowflake_seq" to 9007199254740993L        // > 2^53 - 1, automatically serialized as "9007199254740993"
    )
)
```

---

## 3. Two-Step Interactive Demo UI & Headless Call Examples

### 3.1 Two-Step Interactive UI Demo ([`example/AbiDemoActivity.kt`](example/AbiDemoActivity.kt))

`AbiDemoActivity` is built entirely in programmatic Kotlin using native `ScrollView` + `LinearLayout` (zero XML layout dependencies) and follows the **two-step preview-then-submit contract**:
1. **Step 1: Configure Parameters & Preview a Single Request JSON in Real Time (`autoFlush = false` + `buildPendingBatchPayload`)**
   - Initializes the SDK in `onCreate` with `autoFlush = false` to disable periodic background timers and threshold triggers.
   - Switching identity (`identify` / `login` / `logout`), editing the static super properties JSON, toggling dynamic super properties, checking **"Multi-Event Batch Mode"**, or tapping any event / `$user_*` button calls `sdk.clearPendingQueue()`, replays the staged action(s), and updates **Panel A: Pending Request JSON Preview** in place via `sdk.buildPendingBatchPayload().toString(2)`.
2. **Step 2: Click "Confirm Submit" (`确认提交`) to Send (`flush`)**
   - Only when the user clicks the green **"Confirm Submit"** button does the Activity invoke `sdk.flush()` on a background thread and update **Panel B: Latest Submission Response** (`lastFlushStatusCode` and `lastFlushResponseBody`) on the UI thread.

### 3.2 Two-Step Headless Method-Level Call (`previewScenarioPayload` + `confirmSubmit`)

In JUnit tests, instrumented tests, or headless debugging scripts, call the static two-step methods on `AbiDemoActivity`:

```kotlin
import com.anylink.abi.sdk.android.AbiAnalytics
import com.anylink.abi.sdk.android.example.AbiDemoActivity

fun runHeadlessTwoStepDemo() {
    val sdk = AbiAnalytics.init(
        serverUrl = "http://10.0.2.2:8081",
        projectId = 1L,
        projectToken = "abi_tok_android_demo",
        autoFlush = false
    )

    // Step 1: Configure dual-ID, static/dynamic super properties, timed event, >2^53-1 BigInt,
    // deterministic eventId milestone, and all 7 $user_* operations, returning the formatted request JSON string
    val pendingRequestJson: String = AbiDemoActivity.previewScenarioPayload(sdk)
    println("=== Step 1: Pending Request JSON Preview ===\n$pendingRequestJson")

    // Step 2: Confirm submit on a worker thread and get the single response summary JSON
    val responseSummaryJson: String = AbiDemoActivity.confirmSubmit(sdk)
    println("=== Step 2: Latest Submission Result ===\n$responseSummaryJson")
}
```
