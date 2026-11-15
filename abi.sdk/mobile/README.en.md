# ABI Mobile Client SDKs & Interactive Demo Guide (`abi.sdk/mobile`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

This directory provides native and cross-platform mobile client SDKs and interactive demo screens for the ABI User Behavior Analytics (UBA) & BI platform, fully aligned with the ingest gateway contract `POST /collect/api/v1/track/batch` (dual-ID identity mapping, `> 2^53 - 1` 64-bit integer precision protection, `#time` / `$time` event time extraction, stopwatch timed events, and the full suite of `$user_*` user profile operations; *Note: per D7① / G6 gate, `trackFirst` / `trackUpdate` / `trackOverwrite` are marked unsupported in current version*).

## Platform-Specific Documentation Navigation

| Platform | Core Implementation & Interactive Demo | Platform Guides (Multilingual) |
|----------|----------------------------------------|--------------------------------|
| **Flutter (Dart)** | [`flutter/lib/abi_sdk.dart`](flutter/lib/abi_sdk.dart) · [`flutter/example/lib/main.dart`](flutter/example/lib/main.dart) | [简体中文](flutter/README.md) \| [English](flutter/README.en.md) \| [日本語](flutter/README.ja.md) |
| **Android (Kotlin)** | [`android/AbiAnalytics.kt`](android/AbiAnalytics.kt) · [`android/example/AbiDemoActivity.kt`](android/example/AbiDemoActivity.kt) | [简体中文](android/README.md) \| [English](android/README.en.md) \| [日本語](android/README.ja.md) |
| **iOS / macOS (Swift)** | [`ios/AbiAnalytics.swift`](ios/AbiAnalytics.swift) · [`ios/example/AbiDemoViewController.swift`](ios/example/AbiDemoViewController.swift) | [简体中文](ios/README.md) \| [English](ios/README.en.md) \| [日本語](ios/README.ja.md) |

---

## Developer Integration Guide: Required Fields vs. SDK Auto-Collected vs. Gateway/Server Enriched (e.g., IP)

From a mobile (Flutter / Android / iOS) and frontend developer's perspective, all tracking fields are divided into three clear categories:

### Field Responsibility Comparison Table

| Category | Stage / Field Name | Developer Action | Source & Handling Mechanism |
|----------|--------------------|------------------|-----------------------------|
| **Category 1: Required Fields Passed by Developer** | **Initialization (`init` / `initialize`)**: `serverUrl`, `projectId` (`> 0`), `projectToken` / `token` | **Required** | Specifies the `:8081` ingest gateway URL, project ID (`> 0`), and non-empty project key. |
| | **Event Tracking (`track`)**: `eventName` | **Required** | Business event name (e.g., `'OrderPaid'`), with optional business attributes in `properties`. |
| | **Account Login (`login`)**: `accountId` (`login_id`) | **Required on Login** | Updates and persists `login_id` locally (`<= 128` UTF-8 bytes) without overwriting `distinct_id` and without emitting any network event; call `logout()` to clear `login_id`. |
| | **Mutable Events (`trackUpdate` / `trackOverwrite`)**: `eventId` | **Unsupported in current version** | Per D7① / G6 gate, `trackFirst` / `trackUpdate` / `trackOverwrite` are not yet enabled in the current StarRocks `dwd_events` model. |
| **Category 2: Auto-Generated & Persisted by SDK (No Manual Input Needed)** | `distinct_id` | **Auto-generated** | Generates a UUIDv4 on init and persists it under the `distinct_id` key in local storage (`localStorage` / `SharedPreferences` / `UserDefaults`); overridden only via `identify(distinctId)` and never overwritten by `login()`. |
| | `event_id` | **Auto-generated** | Generates a UUIDv4 on every `track` call and preserves it across offline/weak-network retries for idempotency. |
| | `timestamp` | **Auto-generated** | Automatically uses the client's current millisecond timestamp (unless explicitly overridden via `#time` / `$time` for historical events). |
| | Preset Device & Environment Properties: `$lib`, `$lib_version`, `$os`, `$os_version`, `$device_model`, `$screen_width`, `$screen_height`, `$url`, `$title`, `$referrer`, `$zone_offset` | **Auto-collected** | Automatically collected and merged by the SDK (`$user_*` profile operations automatically isolate preset and super properties). |
| **Category 3: Enriched by Ingest Gateway / Server (Unavailable on Client)** | **Public IP & Geo Location (`#ip` / `$ip` $\rightarrow$ Country / Province / City)** | **Never pass from client** | When the client connects directly to the `:8081` ingest gateway, the gateway extracts the real client IP from the HTTP connection (`X-Forwarded-For` / `X-Real-IP`) and Flink resolves country, province, and city. |

### Key Takeaways & Frontend-Backend Funnel Stitching

1. **Category 1: Fields Developers MUST Explicitly Pass**
   - **Initialization (`init` / `initialize`)**: `serverUrl` (ingest gateway URL), `projectId` (`> 0`), and `token` / `projectToken` (non-empty project key).
   - **Event Tracking (`track`)**: `eventName` (required, e.g., `'OrderPaid'`).
   - **Account Login (`login`)**: Pass `accountId` (`login_id`) when the user completes authentication. This is a pure local state update (never overwrites `distinct_id`, sends no network event) so subsequent events carry both `distinct_id` and `login_id` for server-side identity stitching.
   - **Same-Day Retry Idempotency (`track` optional `eventId`)**: Optionally pass a deterministic `eventId` on `track` for same-day retry deduplication (`trackFirst` / `trackUpdate` / `trackOverwrite` are unsupported in the current version per D7① / G6 gate).
2. **Category 2: Fields Auto-Generated & Persisted by the SDK (No Manual Input Required)**
   - **`distinct_id` (Visitor / Device ID)**: Generated as UUIDv4 upon initialization and persisted under the `distinct_id` key in local storage (`localStorage` / `SharedPreferences` / `UserDefaults`, max 64 UTF-8 bytes). Calling `login()` sets `login_id` without modifying `distinct_id`.
   - **`event_id`**: Generated as UUIDv4 on every `track` call and kept unchanged across offline/weak-network retries for idempotent deduplication.
   - **`timestamp`**: Defaults to the client's current millisecond timestamp (unless a historical time is explicitly specified via `#time` / `$time`).
   - **Device & Environment Preset Properties**: `$lib`, `$lib_version`, `$os`, `$os_version`, `$device_model`, `$screen_width`, `$screen_height`, `$url`, `$title`, `$referrer`, `$zone_offset`.
3. **Category 3: Fields Unavailable to Clients & Populated by Gateway/Server (`IP` & Cross-Stack Stitching)**
   - **Public IP & Geo Resolution (`#ip` / `$ip` $\rightarrow$ Country/Province/City)**: Browser JS, MiniPrograms, and mobile apps run inside client sandboxes behind NAT routers and **cannot reliably obtain their own public egress IP—therefore, client integrations must NEVER pass `$ip` / `#ip`**! When clients report directly to the `:8081` ingest gateway, the gateway automatically extracts the real client IP from the HTTP connection (including Nginx/SLB `X-Forwarded-For` / `X-Real-IP` headers) and Flink automatically resolves country, province, and city.
   - **When SHOULD `#ip` / `$ip` be passed?** Only when your architecture routes requests as "Client calls your business backend API $\rightarrow$ Go/Java Server SDK reports tracking events on behalf of the user". Because the ingest gateway sees the backend server's datacenter IP in that topology, your business backend should extract the client IP from the incoming request and pass it via `#ip` / `$ip` to the server SDK. At the same time, we recommend forwarding the visitor ID `distinct_id` (Flutter `sdk.distinctId` / Android `sdk.distinctId` / iOS `sdk.distinctId` / Web `abi.getDistinctId()`) in a request header when calling your backend API so the server can stitch client-to-server funnels.

---

All mobile UI demos and headless method-level demos follow the exact same **two-step interactive verification contract** as Web [`../ts-web/examples/interactive-demo.html`](../ts-web/examples/interactive-demo.html) (completely eliminating endlessly appended historical event logs):

1. **Step 1: Configure Parameters & Preview a Single Request JSON in Real Time**
   - Initialize with `autoFlush = false` to disable background timers and automatic `batchSize` triggers;
   - When switching identity (`identify` / `login` / `logout`) or updating static/dynamic super properties, the pending queue is automatically cleared and recomputed in place so the single request JSON preview box always reflects the exact payload to be submitted;
   - Supports both single-event replacement preview and **"Multi-Event Batch Mode"** (when enabled, clicking multiple event buttons appends them to the `events` array of the same batch payload).
2. **Step 2: Click "Confirm Submit" to Send & Inspect the Single Response**
   - `flush()` is called to send `POST /collect/api/v1/track/batch` only when the user explicitly clicks the primary **"Confirm Submit"** (`确认提交`) button, updating the response panel below with the latest HTTP status and gateway response.

> **Mini-Program & React Native Note**: The WeChat Mini-Program adapter ([`../ts-web/src/adapters/miniapp.ts`](../ts-web/src/adapters/miniapp.ts)) and React Native adapter ([`../ts-web/src/adapters/react-native.ts`](../ts-web/src/adapters/react-native.ts)) reuse the TypeScript core validation and persistent queue engine. See [`../ts-web/examples/usage-examples.ts`](../ts-web/examples/usage-examples.ts) for usage examples.

---

## 1. Directory Structure

```text
abi.sdk/mobile/
├── README.md                                 # Mobile SDK & two-step interactive demo guide (Simplified Chinese)
├── README.en.md                              # Mobile SDK & two-step interactive demo guide (English, this file)
├── README.ja.md                              # Mobile SDK & two-step interactive demo guide (Japanese)
├── flutter/
│   ├── README.md / README.en.md / README.ja.md
│   ├── lib/abi_sdk.dart                      # Flutter / Dart core SDK (AbiConfig, AbiAnalytics)
│   └── example/lib/main.dart                 # Material 3 parameter config + request JSON preview + confirm submit demo
├── android/
│   ├── README.md / README.en.md / README.ja.md
│   ├── AbiAnalytics.kt                       # Android Kotlin zero-dependency core SDK
│   └── example/AbiDemoActivity.kt            # Native ScrollView two-step interactive demo & headless preview/submit API
└── ios/
    ├── README.md / README.en.md / README.ja.md
    ├── AbiAnalytics.swift                    # iOS / macOS Swift thread-safe core SDK
    └── example/AbiDemoViewController.swift   # SwiftUI two-step interactive demo view & AbiSdkDemoRunner
```

---

## 2. Core Preview & Manual Submit Control APIs

All three mobile SDKs default to `autoFlush = true` in production (periodic timer + batch threshold auto-flush). During interactive debugging or payload inspection, set `autoFlush` to `false` and use the queue preview APIs to inspect the exact batch payload before sending:

| Platform | Disable Auto-Flush | Clear Pending Queue | Build Full `POST /collect/api/v1/track/batch` Payload | Manual Confirm Submit |
|----------|--------------------|---------------------|-------------------------------------------------------|-----------------------|
| **Flutter** | `AbiConfig(..., autoFlush: false)` | `sdk.clearPendingQueue()` | `sdk.buildPendingBatchPayload()` (`Map<String, dynamic>`) | `await sdk.flush()` |
| **Android Kotlin** | `AbiAnalytics.init(..., autoFlush = false)` | `sdk.clearPendingQueue()` | `sdk.buildPendingBatchPayload()` (`JSONObject`) | `sdk.flush()` |
| **iOS Swift** | `sdk.initialize(..., autoFlush: false)` | `sdk.clearPendingQueue()` | `sdk.buildPendingBatchPayload()` / `sdk.buildPendingBatchJsonString()` | `sdk.flush(completion:)` |

---

## 3. Interactive UI Demos Across All Three Platforms

All three client UI demos share a unified layout: **four parameter configuration sections on top + dual panels on the bottom (Panel A: Pending Request JSON Preview / Panel B: Latest Submission Response)**:

### 3.1 Flutter Interactive Demo ([`flutter/example/lib/main.dart`](flutter/example/lib/main.dart))

- **Top Parameter Configuration Area**:
  - **Context Status Card**: Displays `distinct_id` (visitor ID), `login_id` (account ID), `superProperties`, and dynamic super property status in real time.
  - **`1. Identity & Session Parameters`**: `Switch Random Visitor ID (identify)`, `Set Login Account (login)`, `Logout (logout)` (pure local state transitions that immediately refresh the staged preview JSON).
  - **`2. Super Properties Configuration`**: Editable static super properties JSON `TextField` + `Apply Static Super Properties` + `Toggle Dynamic Super Properties: On/Off` + `Clear Super Properties` (changes recalculate the pending request JSON in place without appending historical logs).
  - **"Multi-Event Batch Mode" Toggle** (`SwitchListTile`): When off, each event button click previews only that single event; when on, consecutive clicks append events to the `events` array.
  - **`3. Behavior Event Builder`**: `ProductView`, `① Start Event Timer (timeEvent)`, `② Track OrderPaid ($duration)`, `64-bit Snowflake BigInt (> 2^53-1)`, `Deterministic eventId Milestone (OrderSettled)`.
  - **`4. User Profile Operations ($user_*)`**: `userSet`, `userSetOnce`, `userAdd (+100)`, `userAppend`, `userUniqAppend`, `userUnset`, `userDelete` (automatically isolated from super properties).
- **Bottom Dual Panels**:
  - **Panel A: `Pending Request JSON Preview (POST /collect/api/v1/track/batch)`**: Pretty-prints the full `{ project_id, project_token, dry_run, events }` payload with a `Reset Draft` button and a prominent **"Confirm Submit"** button.
  - **Panel B: `Latest Submission Response`**: Updates the HTTP status code and gateway response body only after clicking "Confirm Submit" (`await _sdk.flush()`).

---

### 3.2 Android Kotlin Interactive Demo ([`android/example/AbiDemoActivity.kt`](android/example/AbiDemoActivity.kt))

- **Pure Kotlin Code with Zero XML Dependencies**: Built with native `ScrollView` + `LinearLayout`, ready to drop into any Android project (default gateway `http://10.0.2.2:8081`).
- **Parameter Building & In-Place Preview**:
  - Includes identity controls, static super properties JSON `EditText` (`Apply Static Super Properties` / `Toggle Dynamic Super Properties` / `Clear Super Properties`), `CheckBox("Multi-Event Batch Mode")`, 6 behavior event buttons, and 7 `$user_*` profile buttons.
  - Every parameter change calls `sdk.buildPendingBatchPayload().toString(2)` to refresh **Panel A: Pending Request JSON Preview** in place.
- **Confirm Submit & Single Response**:
  - Clicking **"Confirm Submit"** runs `sdk.flush()` on a background thread and updates **Panel B: Latest Submission Response** on the UI thread; clicking `Reset Draft` restores the default single-event preview.

---

### 3.3 iOS Swift Interactive Demo ([`ios/example/AbiDemoViewController.swift`](ios/example/AbiDemoViewController.swift))

- **Cross-Platform SwiftUI View (`AbiSdkDemoView`, iOS 15.0+ / macOS 12.0+)**:
  - Features the live identity & super properties header card, `1. Identity & Session Parameters`, `2. Super Properties Configuration` with JSON editor, `Multi-Event Batch Mode` `Toggle`, `3. Behavior Event Builder`, and `4. User Profile Operations ($user_*)`.
  - Modifying super properties, switching identity, or tapping any event button calls `sdk.buildPendingBatchJsonString()` to update **Panel A: Pending Request JSON Preview** in place.
  - Tapping the green **"Confirm Submit"** button executes `sdk.flush { statusCode, rawBody in ... }` and updates **Panel B: Latest Submission Response** upon completion.

---

## 4. Two-Step Headless Method-Level Demos (Preview JSON -> Confirm Submit)

For unit tests, CI pipelines, or CLI verification scripts, all three SDKs provide a two-step programmatic entry point: **first build and inspect the exact request JSON, then explicitly confirm submission**.

### 4.1 Flutter (`previewScenarioPayload` + `confirmSubmit`)
```dart
import 'package:your_app/abi_sdk.dart';

Future<void> verifyAbiFlutterSdk() async {
  final sdk = AbiAnalytics.instance;

  // Step 1: Build full tracking scenario parameters and preview the POST /collect/api/v1/track/batch request JSON
  final requestJson = sdk.previewScenarioPayload(
    serverUrl: 'http://localhost:8081',
    projectId: 1,
    projectToken: 'abi_tok_demo_flutter',
    dryRun: true,
  );
  print('Pending Request JSON:\n$requestJson');

  // Step 2: Confirm submission and inspect the single response
  final ok = await sdk.confirmSubmit();
  print('Confirm submit result: ok=$ok, status=${sdk.lastStatusCode}, body=${sdk.lastResponseBody}');
}
```

### 4.2 Android Kotlin (`AbiDemoActivity.previewScenarioPayload` + `confirmSubmit`)
```kotlin
import com.anylink.abi.sdk.android.AbiAnalytics
import com.anylink.abi.sdk.android.example.AbiDemoActivity

val sdk = AbiAnalytics.init(
    serverUrl = "http://10.0.2.2:8081",
    projectId = 1L,
    projectToken = "abi_tok_android_demo",
    autoFlush = false
)

// Step 1: Build dual-ID, super properties, timed event, >2^53-1 BigInt, deterministic eventId milestone & $user_* payload and preview
val requestJson: String = AbiDemoActivity.previewScenarioPayload(sdk)
println("Pending Request JSON:\n$requestJson")

// Step 2: Confirm submit on a worker thread and get the single response summary JSON
val responseSummaryJson: String = AbiDemoActivity.confirmSubmit(sdk)
println("Latest Submission Result:\n$responseSummaryJson")
```

### 4.3 iOS Swift (`AbiSdkDemoRunner.previewScenarioJson` + `confirmSubmit`)
```swift
// Step 1: Build and return the formatted pending request JSON string with autoFlush = false
let requestJson = AbiSdkDemoRunner.previewScenarioJson(
    serverUrl: "http://localhost:8081",
    projectId: 1,
    projectToken: "abi_tok_ios_demo"
)
print("Pending Request JSON:\n\(requestJson)")

// Step 2: Confirm submit and receive the single HTTP response callback
AbiSdkDemoRunner.confirmSubmit { statusCode, responseBody in
    print("Submission completed: HTTP \(statusCode), body: \(responseBody)")
}
```

---

## 5. Host Project Integration & Local Verification

### 5.1 Prerequisite: Start the Local Ingest Gateway (Optional)
To verify end-to-end HTTP 200 responses locally, start the `abi.srv` ingest gateway (`:8081`) from the repository root:
```bash
cd abi.srv && ENV=dev go run ./cmd/gateway/
```
> Even if the local `:8081` gateway is not running, each SDK safely catches connection errors, retains the events in the in-memory queue (preserving the original `event_id` for idempotent retry), and clearly displays the disconnected status in the "Latest Submission Response" panel.

### 5.2 Flutter Host Integration
1. Copy [`flutter/lib/abi_sdk.dart`](flutter/lib/abi_sdk.dart) into your Flutter project's `lib/` directory (pure Dart standard library implementation, zero third-party plugin dependencies).
2. To mount the interactive demo screen, mount `const AbiSdkDemoApp()` from [`flutter/example/lib/main.dart`](flutter/example/lib/main.dart) and adjust the `import` path to `abi_sdk.dart`.
3. Network note: iOS Simulator and macOS desktop can connect directly to `http://localhost:8081`; for Android Emulator, set `serverUrl` to `http://10.0.2.2:8081`. See [`flutter/README.en.md`](flutter/README.en.md) for the complete Flutter SDK reference.

### 5.3 Android Kotlin Host Integration
1. Copy [`android/AbiAnalytics.kt`](android/AbiAnalytics.kt) (and optionally [`android/example/AbiDemoActivity.kt`](android/example/AbiDemoActivity.kt)) into your app module's source tree (`package com.anylink.abi.sdk.android`).
2. Declare the internet permission in `AndroidManifest.xml`; when testing against a local cleartext HTTP gateway (`http://10.0.2.2:8081`), enable cleartext traffic in development and register `AbiDemoActivity`:
   ```xml
   <uses-permission android:name="android.permission.INTERNET" />

   <application
       android:usesCleartextTraffic="true"
       ...>
       <activity
           android:name="com.anylink.abi.sdk.android.example.AbiDemoActivity"
           android:exported="true" />
   </application>
   ```
3. Initialize `AbiAnalytics.init(...)` in `Application.onCreate()` for production (`autoFlush = true` by default), or launch `AbiDemoActivity` via `Intent(context, AbiDemoActivity::class.java)`. See [`android/README.en.md`](android/README.en.md) for the complete Android SDK reference.

### 5.4 iOS Swift Host Integration & Static Typecheck Verification
1. Drag [`ios/AbiAnalytics.swift`](ios/AbiAnalytics.swift) (and optionally [`ios/example/AbiDemoViewController.swift`](ios/example/AbiDemoViewController.swift)) into your Xcode Target's `Compile Sources`.
2. When connecting to a local HTTP gateway (`http://localhost:8081`) from Simulator or device, enable `NSAllowsLocalNetworking = YES` under `NSAppTransportSecurity` in your development `Info.plist`.
3. Mount `AbiSdkDemoView()` directly in SwiftUI (or wrap it in `UIHostingController(rootView: AbiSdkDemoView())` for UIKit apps). See [`ios/README.en.md`](ios/README.en.md) for the complete iOS SDK reference.
4. **CLI Static Typecheck Verification**: Verify both the SDK and SwiftUI demo without opening Xcode by running `swiftc` in macOS Terminal:
   ```bash
   swiftc -typecheck abi.sdk/mobile/ios/AbiAnalytics.swift abi.sdk/mobile/ios/example/AbiDemoViewController.swift
   ```
