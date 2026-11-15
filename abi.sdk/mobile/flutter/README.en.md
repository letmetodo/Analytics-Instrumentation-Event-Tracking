# ABI Flutter / Dart Client SDK Guide (`abi.sdk/mobile/flutter`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

[`lib/abi_sdk.dart`](lib/abi_sdk.dart) is a zero-dependency data collection and analytics SDK for Flutter cross-platform mobile and desktop applications. Built exclusively on the pure Dart standard library (`dart:async`, `dart:convert`, `dart:io`, `dart:math`), it fully complies with the ABI ingest gateway `POST /collect/api/v1/track/batch` contract and the ThinkingData v3.4 specification.

> Back to Mobile SDK Overview: [简体中文](../README.md) | [English](../README.en.md) | [日本語](../README.ja.md)

---

## Developer Integration Guide: Required Fields vs. SDK Auto-Collected vs. Gateway/Server Enriched (e.g., IP)

From a Flutter client engineer's perspective, all tracking fields fall into three clear categories:

| Category | Stage / Field Name | Developer Action | Source & Handling Mechanism |
|----------|--------------------|------------------|-----------------------------|
| **Category 1: Required Fields Passed by Developer** | **Initialization (`init` / `initialize`)**: `serverUrl`, `projectId` (`> 0`), `projectToken` / `token` | **Required** | Passed via `AbiConfig` to specify the `:8081` ingest gateway URL, project ID (`> 0`), and non-empty project key. |
| | **Event Tracking (`track`)**: `eventName` | **Required** | Business event name (e.g., `'OrderPaid'`), with optional business attributes in `properties`. |
| | **Account Login (`login`)**: `accountId` (`login_id`) | **Required on Login** | Calls `login(accountId)` to update `login_id` locally (`<= 128` UTF-8 bytes, never overwrites `distinct_id`, sends no network event). |
| | **Mutable Events (`trackUpdate` / `trackOverwrite`)**: `eventId` | **Unsupported in current version** | Per D7① / G6 gate, `trackFirst` / `trackUpdate` / `trackOverwrite` are not yet enabled in the current StarRocks `dwd_events` model. |
| **Category 2: Auto-Generated & Persisted by SDK (No Manual Input Needed)** | `distinct_id` | **Auto-generated** | Generates a UUIDv4 on init (persisted under `distinct_id` when storage callbacks are configured); updated only via `identify` and never overwritten by `login`. |
| | `event_id` | **Auto-generated** | Generates a UUIDv4 on every `track` call and preserves it across offline/weak-network retries for idempotency. |
| | `timestamp` | **Auto-generated** | Automatically uses the client's current millisecond timestamp (unless explicitly overridden via `#time` / `$time` for historical events). |
| | Preset Device & Environment Properties: `$lib`, `$lib_version`, `$os`, `$os_version`, `$device_model`, `$screen_width`, `$screen_height`, `$url`, `$title`, `$referrer`, `$zone_offset` | **Auto-collected** | Automatically collected and merged by the SDK (`$user_*` profile operations automatically isolate preset and super properties). |
| **Category 3: Enriched by Ingest Gateway / Server (Unavailable on Client)** | **Public IP & Geo Location (`#ip` / `$ip` $\rightarrow$ Country / Province / City)** | **Never pass from client** | When the client connects directly to the `:8081` ingest gateway, the gateway extracts the real client IP from the HTTP connection (`X-Forwarded-For` / `X-Real-IP`) and Flink resolves country, province, and city. |

1. **Category 1: Fields Developers MUST Explicitly Pass**
   - **Initialization (`init` / `initialize`)**: `serverUrl` (ingest gateway URL), `projectId` (`> 0`), and `token` / `projectToken` (non-empty project key).
   - **Event Tracking (`track`)**: `eventName` (required, e.g., `'OrderPaid'`).
   - **Account Login (`login`)**: Pass `accountId` (`login_id`) when the user completes authentication. Updates `login_id` locally (without overwriting `distinct_id` or sending any network event) so subsequent events carry both `distinct_id` and `login_id`.
   - **Same-Day Retry Idempotency (`track` optional `eventId`)**: Optionally pass a deterministic `eventId` on `track` for same-day retry deduplication (`trackFirst` / `trackUpdate` / `trackOverwrite` are unsupported in the current version per D7① / G6 gate).
2. **Category 2: Fields Auto-Generated & Persisted by the SDK (No Manual Input Required)**
   - **`distinct_id` (Visitor / Device ID)**: Generated as UUIDv4 upon initialization and persisted under the `distinct_id` key via optional `storageRead` / `storageWrite` callbacks (max 64 UTF-8 bytes); never overwritten by `login()`.
   - **`event_id`**: Generated as UUIDv4 on every `track` call and kept unchanged across offline/weak-network retries for idempotent deduplication.
   - **`timestamp`**: Defaults to the client's current millisecond timestamp (unless a historical time is explicitly specified via `#time` / `$time`).
   - **Device & Environment Preset Properties**: `$lib`, `$lib_version`, `$os`, `$os_version`, `$device_model`, `$screen_width`, `$screen_height`, `$url`, `$title`, `$referrer`, `$zone_offset`.
3. **Category 3: Fields Unavailable to Clients & Populated by Gateway/Server (`IP` & Cross-Stack Stitching)**
   - **Public IP & Geo Resolution (`#ip` / `$ip` $\rightarrow$ Country/Province/City)**: Browser JS, MiniPrograms, and mobile apps run inside client sandboxes behind NAT routers and **cannot reliably obtain their own public egress IP—therefore, client integrations must NEVER pass `$ip` / `#ip`**! When clients report directly to the `:8081` ingest gateway, the gateway automatically extracts the real client IP from the HTTP connection (including Nginx/SLB `X-Forwarded-For` / `X-Real-IP` headers) and Flink automatically resolves country, province, and city.
   - **When SHOULD `#ip` / `$ip` be passed?** Only when your architecture routes requests as "Client calls your business backend API $\rightarrow$ Go/Java Server SDK reports tracking events on behalf of the user". Because the ingest gateway sees the backend server's datacenter IP in that topology, your business backend should extract the client IP from the incoming request and pass it via `#ip` / `$ip` to the server SDK. At the same time, we recommend forwarding the visitor ID (`sdk.distinctId`) in a request header when calling your backend API so the server can stitch client-to-server funnels.

---

## 1. Integration & Environment Setup

### 1.1 Pure Dart Zero-Dependency Integration
1. Copy [`lib/abi_sdk.dart`](lib/abi_sdk.dart) directly into your host Flutter project's `lib/` directory (no third-party HTTP or device plugins are required in `pubspec.yaml`).
2. Import the SDK in your application code:
   ```dart
   import 'package:your_app/abi_sdk.dart';
   ```
3. To mount the interactive verification UI, copy [`example/lib/main.dart`](example/lib/main.dart) into your host project and mount `const AbiSdkDemoApp()`.

### 1.2 Network & Gateway Endpoint Configuration by Environment
- **iOS Simulator / macOS Desktop**: Set `serverUrl` directly to `http://localhost:8081` to reach the local ingest gateway on your host machine.
- **Android Emulator**: Inside the Android Emulator, `localhost` points to the emulator loopback interface; set `serverUrl` to `http://10.0.2.2:8081` to reach the host's `:8081` gateway.
- **Physical iOS / Android Devices**: Point `serverUrl` to your development machine's LAN IP (e.g., `http://192.168.1.x:8081`) and allow cleartext HTTP traffic in development builds (`usesCleartextTraffic="true"` on Android / `NSAllowsLocalNetworking = YES` on iOS).

---

## 2. Initialization & Core API Quick Reference

### 2.1 SDK Initialization (`AbiConfig` & `AbiAnalytics.instance.init`)

```dart
final sdk = AbiAnalytics.instance;

sdk.init(const AbiConfig(
  serverUrl: 'http://localhost:8081', // Use http://10.0.2.2:8081 on Android Emulator
  projectId: 1,
  projectToken: 'abi_tok_demo_project_1',
  appVersion: '2.1.0',
  batchSize: 20,
  flushInterval: Duration(seconds: 5),
  debug: false,
  dryRun: false,     // When true, gateway validates the payload without persisting to Kafka/StarRocks
  autoFlush: true,   // Defaults to true in production; set to false for two-step interactive preview
));
```

| `AbiConfig` Field | Type | Default | Description |
|-------------------|------|---------|-------------|
| `serverUrl` | `String` | Required | Ingest gateway base URL (automatically appends `/collect/api/v1/track/batch`) |
| `projectId` | `int` | Required | ABI project ID (`project_id`) |
| `projectToken` | `String` | Required | Project access token (`project_token`) |
| `appVersion` | `String` | `'1.0.0'` | Host app version, injected into preset property `$app_version` |
| `batchSize` | `int` | `20` | Batch size threshold that triggers an automatic flush |
| `flushInterval` | `Duration` | `Duration(seconds: 5)` | Background periodic flush interval |
| `debug` | `bool` | `false` | Immediate debug reporting mode (flushes on every `track` call) |
| `dryRun` | `bool` | `false` | Gateway `dry_run` validation mode (validates schema without writing to storage) |
| `autoFlush` | `bool` | `true` | Enables periodic and threshold auto-flush (`false` requires manual `flush()`) |

---

### 2.2 Dual-ID Identity Management (`identify` / `login` / `logout`)

The SDK strictly follows the ThinkingData identity contract—wire events carry only `distinct_id` (visitor/device ID, max 64 UTF-8 bytes) and `login_id` (authenticated account ID, max 128 UTF-8 bytes):
- `distinctId`: Visitor/device identifier (auto-generated UUIDv4 on init, persisted under `distinct_id` via optional `AbiConfig.storageRead` / `storageWrite`).
- `loginId`: Authenticated account identifier (`''` when logged out).
- `identify(String distinctId)`: Overrides the visitor/device identifier locally (validates non-empty, no control characters, and ≤ 64 UTF-8 bytes; sends no network event).
- `login(String accountId)`: Sets `login_id` locally (max 128 UTF-8 bytes; **never overwrites `distinctId`**, **never emits any network event**, returns `void`).
- `logout()`: Clears `loginId` locally while keeping `distinctId` intact (sends no network event).

```dart
sdk.identify('flutter_visitor_device_001');
sdk.login('acct_flutter_10001'); // Pure local state update, sends no network event
print('distinctId: ${sdk.distinctId}, loginId: ${sdk.loginId}');
sdk.logout();
```

---

### 2.3 Static & Dynamic Super Properties (`Super Properties`)

Super properties are automatically merged into all subsequent behavioral and system events (**automatically excluded from `$user_*` / `#user_*` user profile operations**). Property precedence is: `Event properties > Dynamic super properties > Static super properties > SDK preset properties`.

| Method Signature | Description |
|------------------|-------------|
| `setSuperProperties(Map<String, dynamic> props)` | Registers or merges global static super properties |
| `unsetSuperProperty(String key)` | Removes a single registered static super property by key |
| `clearSuperProperties()` | Clears all registered static super properties |
| `getSuperProperties()` | Returns a shallow copy `Map<String, dynamic>` of current static super properties |
| `setDynamicSuperProperties(Map<String, dynamic> Function()? fn)` | Registers (or passes `null` to clear) a callback evaluated dynamically on each `track` call |

```dart
sdk.setSuperProperties({'channel': 'AppStore', 'ab_group': 'checkout_v2'});
sdk.unsetSuperProperty('ab_group');
final currentStaticProps = sdk.getSuperProperties();

sdk.setDynamicSuperProperties(() => {
  'network_state': 'wifi',
  'dyn_sequence': 1,
});
```

---

### 2.4 Event Timing & Same-Day Idempotent Tracking (`timeEvent` / `track`)

- **Timed Events (`timeEvent`)**: Call `sdk.timeEvent('OrderPaid')` to start a high-precision `Stopwatch`; the next `sdk.track('OrderPaid', ...)` call automatically stops the timer and injects `$duration` in seconds (3 decimal places).
- **Standard Events (`track`)**: Enqueues a custom business or system event and returns the normalized idempotent `event_id` (defaults to UUID v4). Pass a deterministic `eventId` for same-day identical-payload retry deduplication.
- **Unsupported Mutable Event Gate (`trackFirst` / `trackUpdate` / `trackOverwrite`)**: Per D7① / G6 gate, `$first_check_id` deduplication and `trackUpdate` / `trackOverwrite` are unsupported in the current StarRocks `dwd_events` storage model (`trackUpdate` / `trackOverwrite` throw `UnsupportedError` without enqueueing any fake `track` event). Model order lifecycle transitions as distinct milestone events instead.

```dart
// 1. Stopwatch timing and standard event tracking
sdk.timeEvent('OrderPaid');
final orderEvtId = sdk.track(
  'OrderPaid',
  properties: {
    'order_id': 'ord_20261110_01',
    'amount': 299.0,
  },
);

// 2. Deterministic eventId milestone event (idempotent on same-day identical-payload retries)
sdk.track(
  'OrderSettled',
  properties: {
    'order_id': 'ord_20261110_01',
    'order_status': 'settled',
    'amount': 299.0,
  },
  eventId: 'ord_settled_20261110_01',
);
```

---

### 2.5 7 User Profile Operations (`$user_*`)

User profile operations target the StarRocks `abi.dim_users` dimension table. The SDK **automatically isolates preset system properties and static/dynamic super properties** from all `$user_*` events:

| Method Signature | System Event | Description |
|------------------|--------------|-------------|
| `userSet(Map<String, dynamic> properties)` | `$user_set` | Sets or overwrites user profile properties |
| `userSetOnce(Map<String, dynamic> properties)` | `$user_set_once` | Sets user profile properties only if they are currently null/unset |
| `userAdd(Map<String, num> properties)` | `$user_add` | Atomically increments numeric profile properties (negative values decrement) |
| `userAppend(Map<String, List<dynamic>> properties)` | `$user_append` | Appends elements to list profile properties (without deduplication) |
| `userUniqAppend(Map<String, List<dynamic>> properties)` | `$user_uniq_append` | Appends unique elements to list profile properties (with deduplication) |
| `userUnset(List<String> keys)` | `$user_unset` | Clears specified user profile property keys (mapped internally to `{key: 0}`) |
| `userDelete()` | `$user_del` | Marks the current user profile record for deletion |

```dart
sdk.userSet({'vip_level': 'Diamond', 'city': 'Shanghai'});
sdk.userSetOnce({'first_install_channel': 'AppStore'});
sdk.userAdd({'loyalty_points': 100});
sdk.userAppend({'tags': ['mobile_shopper', 'promo_2026']});
sdk.userUniqAppend({'tags': ['promo_2026', 'vip_member']});
sdk.userUnset(['temporary_flag']);
sdk.userDelete();
```

---

### 2.6 `> 2^53 - 1` Large Integer Precision Protection & `#time` / `$time` Time Extraction

1. **`> 2^53 - 1` Large Integer Precision Protection**:
   - The IEEE-754 double-precision safe integer limit is `9007199254740991` ($2^{53}-1$, `AbiAnalytics.maxSafeInteger`).
   - Whenever an `int` property (or list element) exceeds `±9007199254740991` (such as a 64-bit Snowflake ID `9007199254740993`), the SDK automatically serializes it as a decimal string `"9007199254740993"` to prevent precision loss across JSON parsers.
2. **`#time` / `$time` Event Timestamp Extraction**:
   - In addition to the explicit `timestamp: DateTime` parameter on `track`, if `properties` contains `'#time'` or `'$time'` (`'#time'` takes precedence over `'$time'`), the SDK automatically parses it into the top-level millisecond `timestamp` field and **strips `'#time'` / `'$time'` from `properties`**.
   - Supported time formats: `DateTime`, 10-digit second or 13-digit millisecond `int`/`double` epochs, numeric epoch strings (10–16 digits), and ISO-8601 strings (e.g., `'2026-11-10T08:00:00Z'`).

```dart
sdk.track(
  'OrderPaid',
  properties: {
    '#time': '2026-11-10T08:30:00.000Z', // Extracted to top-level millisecond timestamp and removed from properties
    'snowflake_seq': 9007199254740993,   // > 2^53 - 1, automatically serialized as "9007199254740993"
  },
);
```

---

## 3. Two-Step Interactive Demo UI & Headless Call Examples

### 3.1 Two-Step Interactive UI Demo ([`example/lib/main.dart`](example/lib/main.dart))

`AbiSdkDemoScreen` implements the **two-step preview-then-submit workflow**:
1. **Step 1: Configure Parameters & Preview a Single Request JSON in Real Time (`autoFlush: false` + `buildPendingBatchPayload`)**
   - Initializes the SDK with `autoFlush: false` so background timers and batch thresholds never send network requests behind the scenes.
   - Switching identity (`identify` / `login` / `logout`), editing static/dynamic super properties, or clicking any behavioral / `$user_*` event button calls `_sdk.clearPendingQueue()`, replays the staged action(s), and refreshes **Panel A: Pending Request JSON Preview** in place via `_sdk.buildPendingBatchPayload()`.
   - Toggling **"Multi-Event Batch Mode"** on allows consecutive button clicks to append multiple events into the same `events` array.
2. **Step 2: Click "Confirm Submit" (`确认提交`) to Send (`flush`)**
   - Only when the user clicks **"Confirm Submit"** does the screen call `await _sdk.flush()`, updating **Panel B: Latest Submission Response** with the HTTP status code (`_sdk.lastStatusCode`) and gateway response body (`_sdk.lastResponseBody`).

### 3.2 Two-Step Headless Method-Level Call (`previewScenarioPayload` + `confirmSubmit`)

For unit tests or headless CLI verification, call the built-in two-step methods on `AbiAnalytics`:

```dart
import 'package:your_app/abi_sdk.dart';

Future<void> runHeadlessTwoStepDemo() async {
  final sdk = AbiAnalytics.instance;

  // Step 1: Build identity, super properties, timed event, BigInt, deterministic eventId milestone, and all 7 $user_* operations
  // with autoFlush: false, returning the formatted POST /collect/api/v1/track/batch request JSON string
  final pendingJson = sdk.previewScenarioPayload(
    serverUrl: 'http://localhost:8081',
    projectId: 1,
    projectToken: 'abi_tok_demo_flutter',
    dryRun: true,
  );
  print('=== Step 1: Pending Request JSON Preview ===\n$pendingJson');

  // Step 2: Confirm submission and inspect the single response
  final ok = await sdk.confirmSubmit();
  print('=== Step 2: Confirm Submit Result ===');
  print('ok=$ok, status=${sdk.lastStatusCode}, response=${sdk.lastResponseBody}');
}
```
