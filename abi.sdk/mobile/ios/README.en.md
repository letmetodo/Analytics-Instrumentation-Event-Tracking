# ABI iOS / macOS Swift Client SDK Guide (`abi.sdk/mobile/ios`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

[`AbiAnalytics.swift`](AbiAnalytics.swift) is a zero-dependency native iOS and macOS data collection and analytics SDK written in Swift. Built purely on Apple's `Foundation` framework (`NSLock`, `URLSession`, `JSONSerialization`, `ProcessInfo.processInfo.systemUptime`), it fully complies with the ABI ingest gateway `POST /collect/api/v1/track/batch` contract and the ThinkingData v3.4 specification.

> Back to Mobile SDK Overview: [简体中文](../README.md) | [English](../README.en.md) | [日本語](../README.ja.md)

---

## Developer Integration Guide: Required Fields vs. SDK Auto-Collected vs. Gateway/Server Enriched (e.g., IP)

From an iOS / macOS client engineer's perspective, all tracking fields fall into three clear categories:

| Category | Stage / Field Name | Developer Action | Source & Handling Mechanism |
|----------|--------------------|------------------|-----------------------------|
| **Category 1: Required Fields Passed by Developer** | **Initialization (`init` / `initialize`)**: `serverUrl`, `projectId` (`> 0`), `projectToken` / `token` | **Required** | Passed to `AbiAnalytics.shared.initialize` to specify the `:8081` ingest gateway URL, project ID (`> 0`), and non-empty project key. |
| | **Event Tracking (`track`)**: `eventName` | **Required** | Business event name (e.g., `"OrderPaid"`), with optional business attributes in `properties`. |
| | **Account Login (`login`)**: `accountId` (`login_id`) | **Required on Login** | Calls `login(accountId)` to persist `login_id` locally (`<= 128` UTF-8 bytes, never overwrites `distinct_id`, sends no network event). |
| | **Mutable Events (`trackUpdate` / `trackOverwrite`)**: `eventId` | **Unsupported in current version** | Per D7① / G6 gate, `trackFirst` / `trackUpdate` / `trackOverwrite` are not yet enabled in the current StarRocks `dwd_events` model. |
| **Category 2: Auto-Generated & Persisted by SDK (No Manual Input Needed)** | `distinct_id` | **Auto-generated** | Generates a UUIDv4 on init and persists it to `UserDefaults` (`abi_sdk_<projectId>_distinct_id`); updated only via `identify` and never overwritten by `login`. |
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
   - **`distinct_id` (Visitor / Device ID)**: Generated as UUIDv4 upon initialization and persisted to `UserDefaults` (`abi_sdk_<projectId>_distinct_id`, max 64 UTF-8 bytes); never overwritten by `login()`.
   - **`event_id`**: Generated as UUIDv4 on every `track` call and kept unchanged across offline/weak-network retries for idempotent deduplication.
   - **`timestamp`**: Defaults to the client's current millisecond timestamp (unless a historical time is explicitly specified via `#time` / `$time`).
   - **Device & Environment Preset Properties**: `$lib`, `$lib_version`, `$os`, `$os_version`, `$device_model`, `$screen_width`, `$screen_height`, `$url`, `$title`, `$referrer`, `$zone_offset`.
3. **Category 3: Fields Unavailable to Clients & Populated by Gateway/Server (`IP` & Cross-Stack Stitching)**
   - **Public IP & Geo Resolution (`#ip` / `$ip` $\rightarrow$ Country/Province/City)**: Browser JS, MiniPrograms, and mobile apps run inside client sandboxes behind NAT routers and **cannot reliably obtain their own public egress IP—therefore, client integrations must NEVER pass `$ip` / `#ip`**! When clients report directly to the `:8081` ingest gateway, the gateway automatically extracts the real client IP from the HTTP connection (including Nginx/SLB `X-Forwarded-For` / `X-Real-IP` headers) and Flink automatically resolves country, province, and city.
   - **When SHOULD `#ip` / `$ip` be passed?** Only when your architecture routes requests as "Client calls your business backend API $\rightarrow$ Go/Java Server SDK reports tracking events on behalf of the user". Because the ingest gateway sees the backend server's datacenter IP in that topology, your business backend should extract the client IP from the incoming request and pass it via `#ip` / `$ip` to the server SDK. At the same time, we recommend forwarding the visitor ID (`sdk.distinctId`) in a request header when calling your backend API so the server can stitch client-to-server funnels.

---

## 1. Integration & Environment Setup

### 1.1 Source Integration (Zero CocoaPods / SPM Third-Party Dependencies)
1. Drag [`AbiAnalytics.swift`](AbiAnalytics.swift) directly into your Xcode project Target's `Compile Sources` (depends only on `Foundation`).
2. To mount the interactive SwiftUI verification view or use the two-step headless runner, also add [`example/AbiDemoViewController.swift`](example/AbiDemoViewController.swift) to your Target:
   - **SwiftUI App**: Mount `AbiSdkDemoView()` directly in your view hierarchy (requires iOS 15.0+ / macOS 12.0+);
   - **UIKit App**: Present or push `UIHostingController(rootView: AbiSdkDemoView())`.

### 1.2 `Info.plist` Local Networking ATS Configuration
When connecting to a local cleartext HTTP ingest gateway (`http://localhost:8081`) from Simulator, macOS, or a physical device during development, enable `NSAllowsLocalNetworking` under `NSAppTransportSecurity` in your `Info.plist`:

```xml
<key>NSAppTransportSecurity</key>
<dict>
    <!-- Allow cleartext HTTP requests to localhost / LAN gateways during development -->
    <key>NSAllowsLocalNetworking</key>
    <true/>
</dict>
```

### 1.3 Command-Line Static Typecheck Verification
You can verify that both the SDK and the SwiftUI demo compile cleanly with zero errors directly from macOS Terminal without opening Xcode:
```bash
swiftc -typecheck abi.sdk/mobile/ios/AbiAnalytics.swift abi.sdk/mobile/ios/example/AbiDemoViewController.swift
```

---

## 2. Initialization & Core API Quick Reference

### 2.1 SDK Initialization (`AbiAnalytics.shared.initialize`)

Initialize the shared singleton in `AppDelegate.application(_:didFinishLaunchingWithOptions:)` or your SwiftUI `App.init()`:

```swift
import Foundation

let sdk = AbiAnalytics.shared
sdk.initialize(
    serverUrl: "http://localhost:8081",
    projectId: 1,
    projectToken: "abi_tok_ios_demo",
    appVersion: "2.1.0",
    batchSize: 20,
    debug: false,
    autoFlush: true // Defaults to true in production (5s Timer + batchSize threshold); set to false for two-step preview
)
```

| `initialize` Parameter | Type | Default | Description |
|------------------------|------|---------|-------------|
| `serverUrl` | `String` | Required | Ingest gateway base URL (automatically appends `/collect/api/v1/track/batch`) |
| `projectId` | `Int64` | Required | ABI project ID (`project_id`) |
| `projectToken` | `String` | Required | Project access token (`project_token`) |
| `appVersion` | `String` | `"1.0.0"` | Host app version, injected into preset property `$app_version` |
| `batchSize` | `Int` | `20` | Queue count threshold that triggers an automatic flush (clamped to `1...500`) |
| `debug` | `Bool` | `false` | Debug mode (attaches `"debug": true` to the payload and triggers an immediate flush) |
| `autoFlush` | `Bool` | `true` | Schedules a 5-second repeating timer on the main run loop and enables threshold auto-flush (`false` requires manual `flush()`) |

---

### 2.2 Dual-ID Identity Management (`identify` / `login` / `logout`)

The SDK protects all identity states and queue mutations with `NSLock` and strictly follows the ThinkingData identity contract—wire events carry only `distinct_id` (visitor/device ID, max 64 UTF-8 bytes) and `login_id` (authenticated account ID, max 128 UTF-8 bytes):
- `distinctId`: Visitor/device identifier (auto-generated UUIDv4 on init and persisted under `abi_sdk_<projectId>_distinct_id` in `UserDefaults`).
- `loginId` / `currentLoginId`: Authenticated account identifier (`""` when logged out).
- `identify(_ distinctId: String) throws`: Sets a custom visitor/device ID locally (throws `NSError` if empty, contains control characters, or exceeds 64 UTF-8 bytes; sends no network event).
- `login(_ accountId: String) throws`: Sets and persists `login_id` locally (max 128 UTF-8 bytes; **never overwrites `distinctId`**, **never emits any network event**, returns `Void`).
- `logout()`: Clears `loginId` locally while keeping `distinctId` intact (sends no network event).

```swift
try sdk.identify("ios_visitor_device_001")
try sdk.login("user_ios_10001") // Pure local state update, sends no network event
print("distinctId=\(sdk.distinctId), loginId=\(sdk.currentLoginId)")
sdk.logout()
```

---

### 2.3 Static & Dynamic Super Properties (`Super Properties`)

Super properties are automatically merged into all subsequent behavioral and system events (**automatically excluded from `$user_*` / `#user_*` user profile operations**). Property precedence is: `Event properties > Dynamic super properties > Static super properties > SDK preset properties ($lib/$os/$app_version)`.

| Method Signature | Description |
|------------------|-------------|
| `setSuperProperties(_ props: [String: Any])` | Registers or merges global static super properties |
| `unsetSuperProperty(_ key: String)` | Removes a single static super property by key |
| `clearSuperProperties()` | Clears all registered static super properties |
| `getSuperProperties() -> [String: Any]` | Returns a thread-safe snapshot copy of current static super properties |
| `setDynamicSuperProperties(_ provider: (() -> [String: Any])?)` | Registers (or passes `nil` to clear) a closure evaluated dynamically on each `track` call |

```swift
sdk.setSuperProperties(["channel": "AppStore", "vip_tier": "Gold"])
sdk.unsetSuperProperty("vip_tier")
let snapshot = sdk.getSuperProperties()

sdk.setDynamicSuperProperties {
    ["network_state": "wifi", "dyn_sequence": 1]
}
```

---

### 2.4 Event Timing & Same-Day Idempotent Tracking (`timeEvent` / `track`)

- **System Uptime Event Timing (`timeEvent`)**: Records the start time using `ProcessInfo.processInfo.systemUptime` (unaffected by wall-clock changes); the next `track` call for the same `eventName` automatically calculates and injects `$duration` in seconds (rounded to 3 decimal places).
- **Standard Events (`track`)**: Validates the event name and properties, enqueues the event in a thread-safe manner, and returns the idempotent `event_id` (returns `""` if validation fails). Pass a deterministic `eventId` for same-day identical-payload retry deduplication.
- **Unsupported Mutable Event Gate (`trackFirst` / `trackUpdate` / `trackOverwrite`)**: Per D7① / G6 gate, `$first_check_id` deduplication and `trackUpdate` / `trackOverwrite` are unsupported in the current StarRocks `dwd_events` storage model (`trackUpdate` / `trackOverwrite` log an explicit error and return `""` without enqueueing any fake `track` event). Model order lifecycle transitions as distinct milestone events instead.

```swift
// 1. High-precision event timing and standard event tracking
sdk.timeEvent("OrderPaid")
let orderEvtId = sdk.track(
    "OrderPaid",
    properties: [
        "order_id": "ord_9001",
        "amount": 199.95,
        "currency": "CNY"
    ]
)

// 2. Deterministic eventId milestone event (idempotent on same-day identical-payload retries)
_ = sdk.track(
    "OrderSettled",
    properties: [
        "order_id": "ord_9001",
        "order_status": "settled",
        "amount": 199.95
    ],
    eventId: "ord_settled_9001"
)
```

---

### 2.5 7 User Profile Operations (`$user_*`)

All user profile methods correspond to the StarRocks `abi.dim_users` dimension table. The SDK **automatically isolates preset system properties and static/dynamic super properties** from `$user_*` events:

| Method Signature | System Event | Description |
|------------------|--------------|-------------|
| `userSet(_ properties: [String: Any])` | `$user_set` | Sets or overwrites user profile properties |
| `userSetOnce(_ properties: [String: Any])` | `$user_set_once` | Sets user profile properties only if they are currently unset |
| `userAdd(_ properties: [String: NSNumber])` | `$user_add` | Atomically increments numeric profile properties (negative values decrement) |
| `userAppend(_ properties: [String: [Any]])` | `$user_append` | Appends elements to list profile properties (without deduplication) |
| `userUniqAppend(_ properties: [String: [Any]])` | `$user_uniq_append` | Appends unique elements to list profile properties (with deduplication) |
| `userUnset(_ keys: [String])` | `$user_unset` | Clears specified user profile property keys (mapped internally to `[key: 0]`) |
| `userDelete()` | `$user_del` | Marks the current user profile record for deletion |

```swift
sdk.userSet(["vip_level": "Diamond", "city": "Shanghai"])
sdk.userSetOnce(["first_channel": "AppStore"])
sdk.userAdd(["loyalty_points": NSNumber(value: 100)])
sdk.userAppend(["tags": ["ios", "vip"]])
sdk.userUniqAppend(["tags": ["vip", "annual"]])
sdk.userUnset(["temp_badge"])
sdk.userDelete()
```

---

### 2.6 `> 2^53 - 1` Large Integer Precision Protection & `#time` / `$time` Time Extraction

1. **`> 2^53 - 1` Large Integer Precision Protection**:
   - The IEEE-754 double-precision safe integer limit is `9007199254740991` ($2^{53}-1$, `AbiAnalytics.maxSafeInteger`).
   - Any `Int64` or `Int` property value (or array element) outside `[-9007199254740991, 9007199254740991]` (including `Int64.min` and 64-bit Snowflake IDs like `Int64(9007199254740993)`) is automatically converted to a decimal string `"9007199254740993"` to prevent precision loss across JSON parsers.
2. **`#time` / `$time` Event Timestamp Extraction**:
   - In addition to passing `timestamp: Date?` directly to `track`, if `properties` contains `"#time"` or `"$time"` (`"#time"` takes precedence over `"$time"`), the SDK parses it into the top-level millisecond `timestamp` field and **strips `"#time"` / `"$time"` from `properties`** before property key validation (while strictly rejecting `Bool` / `CFBoolean` values from being misinterpreted as numeric timestamps).
   - Supported time types: `Date`, 10-digit second or 13-digit millisecond `Int64`/`Int`/`Double`/`Float`/`NSNumber` epochs, numeric epoch strings (10–16 digits), and ISO-8601 / standard datetime strings.

```swift
sdk.track(
    "OrderPaid",
    properties: [
        "#time": "2026-11-10T08:30:00.000Z",          // Extracted to top-level millisecond timestamp and removed from properties
        "snowflake_seq": Int64(9007199254740993)      // > 2^53 - 1, automatically serialized as "9007199254740993"
    ]
)
```

---

## 3. Two-Step Interactive Demo UI & Headless Call Examples

### 3.1 Two-Step SwiftUI Demo View ([`example/AbiDemoViewController.swift`](example/AbiDemoViewController.swift))

`AbiSdkDemoView` (supports iOS 15.0+ / macOS 12.0+) implements the **two-step preview-then-submit workflow**:
1. **Step 1: Configure Parameters & Preview a Single Request JSON in Real Time (`autoFlush: false` + `buildPendingBatchPayload` / `buildPendingBatchJsonString`)**
   - Initializes the SDK with `autoFlush: false` to disable repeating timers and threshold triggers.
   - Switching identity (`identify` / `login` / `logout`), editing the static super properties JSON, toggling dynamic super properties, enabling **"Multi-Event Batch Mode"**, or tapping any event / `$user_*` button calls `sdk.clearPendingQueue()`, replays the staged action(s), and refreshes **Panel A: Pending Request JSON Preview** in place via `sdk.buildPendingBatchJsonString()`.
2. **Step 2: Click "Confirm Submit" (`确认提交`) to Send (`flush(completion:)`)**
   - Only when the user taps the green **"Confirm Submit"** button does the view invoke `sdk.flush { statusCode, rawBody in ... }`, updating **Panel B: Latest Submission Response** once the HTTP callback returns.

### 3.2 Two-Step Headless Method-Level Call (`AbiSdkDemoRunner.previewScenarioJson` + `confirmSubmit`)

For XCTest unit tests or CLI verification scripts, call the two-step static methods on `AbiSdkDemoRunner`:

```swift
// Step 1: Build dual-ID, static/dynamic super properties, timeEvent timing, >2^53-1 BigInt,
// deterministic eventId milestone, and all 7 $user_* operations with autoFlush: false, returning the formatted JSON string
let pendingRequestJson = AbiSdkDemoRunner.previewScenarioJson(
    serverUrl: "http://localhost:8081",
    projectId: 1,
    projectToken: "abi_tok_ios_demo"
)
print("=== Step 1: Pending Request JSON Preview ===\n\(pendingRequestJson)")

// Step 2: Confirm submission of the pending batch and receive the single HTTP status and response body
AbiSdkDemoRunner.confirmSubmit { statusCode, responseBody in
    print("=== Step 2: Submission Completed ===")
    print("HTTP \(statusCode), body: \(responseBody)")
}
```
