# ABI Multi-Language Data Collection SDK Suite (`abi.sdk`)

**语言 / Language / 言語**: [简体中文](README.md) | [繁體中文](README.zh-TW.md) | **[English](README.en.md)** | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Português](README.pt.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Русский](README.ru.md) | [Tiếng Việt](README.vi.md) | [ไทย](README.th.md) | [Bahasa Indonesia](README.id.md)

`abi.sdk` provides production-grade client and server data collection SDKs for the ABI User Behavior Analytics (UBA) & Business Intelligence (BI) platform. Benchmarked against the [ThinkingData SDK v3.4 specification](https://docs.thinkingdata.cn/ta-manual/v3.4/installation/installation_menu/installation_menu.html), this suite strictly aligns wire contracts, dual-identity mapping, and schema validation with the ABI Ingestion Gateway [`abi.srv`](../abi.srv/) (`:8081`) and streaming engines [`abi.flink`](../abi.flink/) (Job1 real-time ETL & Job2 raw ODS ingestion).

---

## 1. Directory Layout, Multilingual Docs Index & Platform Matrix

| Directory | Target Platform / Package | Multilingual README (ZH / EN / JA) | Core Capabilities | Verification Command |
|-----------|---------------------------|------------------------------------|-------------------|----------------------|
| [`RESTFUL_API.md`](RESTFUL_API.md) | Language-Agnostic HTTP RESTful API | [中文](RESTFUL_API.md) | Zero-dependency direct HTTP integration guide: batch/single payload specification, formatted JSON `curl` examples (dual-ID automatic attribution, same-day retry idempotency, 7 `$user_*` profile operations, Gzip, `debug` & `dry_run`), plus Python / Node.js native snippets | See `curl` `dry_run: true` commands in doc |
| [`spec/test-vectors/`](spec/test-vectors/) | Cross-Language Golden Test Vectors | — | Shared JSON conformance vectors covering identity normalization (64/128-byte UTF-8 limits, Unicode whitespace trimming, ASCII control-char rejection), event/property key validation, `> 2^53 - 1` 64-bit integer precision protection, and `$user_*` profile rules | Executed by each SDK's unit test suite |
| [`ts-web/`](ts-web/) | Web / H5 / TypeScript (`@anylink/abi-web-sdk`) + App-H5 Bridge, MiniProgram, RN & H5 Game Engine Adapters | [中文](ts-web/README.md) · [EN](ts-web/README.en.md) · [JA](ts-web/README.ja.md)<br/>Examples: [中文](ts-web/examples/README.md) · [EN](ts-web/examples/README.en.md) · [JA](ts-web/examples/README.ja.md) | Supports `init`, `identify`, `login`, `logout`, `track`, `timeEvent`, `setSuperProperties`, `setDynamicSuperProperties`, all 7 `$user_*` profile operations, SPA `$pageview` & `$AppEnd` auto-tracking, App-H5 WebView bridge (`createH5AppBridgeAdapter`), H5 game engines (`createCocosCreatorAdapter`, `createEgretAdapter`, `createLayaAirAdapter`, `createWeexAdapter`), and `sendBeacon` unload delivery (*Note: trackFirst/trackUpdate/trackOverwrite are marked unsupported in current version per D7① / G6 gate*) | `cd abi.sdk/ts-web && pnpm test` |
| [`go/`](go/) | Go Server SDK (`abi.sdk/go`) | [中文](go/README.md) · [EN](go/README.en.md) · [JA](go/README.ja.md)<br/>Demo: [中文](go/examples/demo/README.md) · [EN](go/examples/demo/README.en.md) · [JA](go/examples/demo/README.ja.md) | Concurrency-safe `AbiAnalytics` client with 4 consumers: `StagingConsumer` (two-step request JSON preview & confirm submit), `BatchConsumer` (async buffered HTTP + Gzip + exponential backoff retry), `LoggerConsumer` (daily/hourly/size-rotated local JSONL files for Filebeat/LogBus), and `DebugConsumer` (synchronous L4 validation & `dry_run`) | `cd abi.sdk/go && go test -race ./...` |
| [`java/`](java/) | Java 11+ Server SDK (`com.anylink.abi:abi-java-sdk`) | [中文](java/README.md) · [EN](java/README.en.md) · [JA](java/README.ja.md) | Thread-safe `AbiAnalytics` (`AutoCloseable`), providing `StagingConsumer`, `BatchConsumer`, `LoggerConsumer`, and `DebugConsumer`, with lossless string serialization for 64-bit integers exceeding IEEE-754 safe range (`> 2^53 - 1`) | `cd abi.sdk/java && JAVA_HOME=$(/usr/libexec/java_home -v 11) mvn test` |
| [`python/`](python/) | Python 3 Server SDK (`abi.sdk/python`) | [中文](python/README.md) · [EN](python/README.en.md) · [JA](python/README.ja.md) | Zero-dependency Python 3 standard-library implementation with `StagingConsumer`, `BatchConsumer` (background daemon thread + Gzip + backoff retry), `LoggerConsumer`, and `DebugConsumer`, automatic `> 2^53 - 1` arbitrary-precision integer-to-string conversion, `#time`/`$time` extraction, and `#ip`/`$ip` forwarding | `python3 -m unittest discover -s abi.sdk/python/tests -v` |
| [`nodejs/`](nodejs/) | Node.js Server SDK (`@anylink/abi-node-sdk`) | [中文](nodejs/README.md) · [EN](nodejs/README.en.md) · [JA](nodejs/README.ja.md) | Zero-dependency ESM + TypeScript declarations (`index.d.ts`) for Express / Fastify / Koa / NestJS backends, providing `StagingConsumer`, `BatchConsumer` (`zlib.gzipSync`), `LoggerConsumer`, `DebugConsumer`, and `BigInt` / unsafe integer string serialization | `node --test abi.sdk/nodejs/test/abi-node-sdk.test.mjs` |
| [`csharp/`](csharp/) | C# / .NET Server SDK (`Anylink.Abi.Sdk`) | [中文](csharp/README.md) · [EN](csharp/README.en.md) · [JA](csharp/README.ja.md) | Zero-NuGet-dependency .NET standard-library Server SDK (`System.Text.Json`, `HttpClient`, `GZipStream`) with `StagingConsumer`, `BatchConsumer`, `LoggerConsumer`, `DebugConsumer`, and full `Track*` / `User*` methods | `dotnet run --project abi.sdk/csharp -- --test` |
| [`php/`](php/) | PHP 8.1+ Server SDK (`Anylink\Abi\Sdk`) | [中文](php/README.md) · [EN](php/README.en.md) · [JA](php/README.ja.md) | Zero-dependency PHP Server SDK for Laravel / Symfony / PHP-FPM / Swoole with `StagingConsumer`, `BatchConsumer` (`gzencode` + retry), `LoggerConsumer`, and `DebugConsumer` | `php abi.sdk/php/tests/abi_sdk_test.php` |
| [`ruby/`](ruby/) | Ruby Server SDK (`AbiSdk`) | [中文](ruby/README.md) · [EN](ruby/README.en.md) · [JA](ruby/README.ja.md) | Zero-Gem-dependency Ruby standard-library Server SDK for Rails / Sidekiq / Rack (supporting both `snake_case` and `camelCase` methods) with `StagingConsumer`, `BatchConsumer`, `LoggerConsumer`, and `DebugConsumer` | `ruby abi.sdk/ruby/test/abi_sdk_test.rb` |
| [`cpp/`](cpp/) | C / C++17 SDK (Server & Unreal Engine / Cocos2d-x Client) | [中文](cpp/README.md) · [EN](cpp/README.en.md) · [JA](cpp/README.ja.md) | Single-header C++17 SDK ([`include/abi_sdk.hpp`](cpp/include/abi_sdk.hpp)) with `extern "C"` C ABI exports; supports both stateless server mode and stateful game client mode (`enable_client_mode`, `identify`, `login`, `logout`, `time_event`) | `clang++ -std=c++17 -O2 -Iabi.sdk/cpp/include abi.sdk/cpp/tests/abi_cpp_test.cpp -o /tmp/abi_cpp_test && /tmp/abi_cpp_test` |
| [`lua/`](lua/) | Lua 5.3+ SDK (OpenResty / Skynet Server & Cocos2d-Lua Client) | [中文](lua/README.md) · [EN](lua/README.en.md) · [JA](lua/README.ja.md) | Pure Lua 5.3+ zero-dependency single-file SDK ([`abi_sdk.lua`](lua/abi_sdk.lua)) with built-in deterministic JSON codec & UTF-8 validator, supporting both stateless server and stateful client modes | `lua abi.sdk/lua/tests/test_abi_sdk.lua` |
| [`mobile/`](mobile/) | Mobile Client SDKs (Flutter Dart, Android Kotlin, iOS Swift) | Overview: [中文](mobile/README.md) · [EN](mobile/README.en.md) · [JA](mobile/README.ja.md)<br/>Flutter: [中文](mobile/flutter/README.md) · [EN](mobile/flutter/README.en.md) · [JA](mobile/flutter/README.ja.md)<br/>Android: [中文](mobile/android/README.md) · [EN](mobile/android/README.en.md) · [JA](mobile/android/README.ja.md)<br/>iOS: [中文](mobile/ios/README.md) · [EN](mobile/ios/README.en.md) · [JA](mobile/ios/README.ja.md) | Native thread-safe offline queue & periodic batch flushing, dual-ID binding (`identify` / `login` / `logout`), monotonic stopwatch timing (`timeEvent` -> `$duration`), same-day deterministic `event_id` idempotency (`trackFirst`/`trackUpdate`/`trackOverwrite` unsupported per D7① / G6 gate), full `$user_*` profile mutations, and two-step preview-then-confirm interactive UI demos | `swiftc -typecheck abi.sdk/mobile/ios/AbiAnalytics.swift abi.sdk/mobile/ios/example/AbiDemoViewController.swift` |
| [`game-engines/unity/`](game-engines/unity/) | Unity Game Engine Client SDK (C# `AbiUnityAnalytics`) | [中文](game-engines/unity/README.md) · [EN](game-engines/unity/README.en.md) · [JA](game-engines/unity/README.ja.md) | Unity C# client SDK with persistent device session identity, monotonic stopwatch timing, offline queue, and two-step preview-then-confirm `AbiUnityDemoMonoBehaviour` | `dotnet run --project abi.sdk/csharp -- --test` |
| [`data-import/`](data-import/) | Data Import & Streaming Agents (LogBus 2 / Filebeat / Logstash / Vector / DataX) | [中文](data-import/README.md) · [EN](data-import/README.en.md) · [JA](data-import/README.ja.md) | ABI LogBus 2 daemon ([`abi_logbus.py`](data-import/abi_logbus.py), tailing `.jsonl` files produced by `LoggerConsumer` with offset checkpointing & Gzip batch upload), plus ready-to-use Filebeat, Logstash, Vector, and Alibaba DataX templates | `python3 abi.sdk/data-import/abi_logbus.py --demo --yes` |

---

## 2. Ingestion Gateway Batch Wire Contract (`POST /collect/api/v1/track/batch`)

All client and server HTTP consumers send a standard JSON batch payload to the ingestion gateway:

```json
{
  "project_id": 1,
  "project_token": "abi_tok_...",
  "debug": false,
  "dry_run": false,
  "events": [
    {
      "event_id": "018f6b9c-7c40-7000-8000-000000000001",
      "event_name": "OrderPaid",
      "distinct_id": "vis_device_001",
      "login_id": "user_10001",
      "timestamp": 1731174000000,
      "properties": {
        "$lib": "abi-ios-sdk",
        "$lib_version": "1.0.0",
        "$os": "iOS",
        "$app_version": "2.1.0",
        "$duration": 12.345,
        "amount": 199.0,
        "order_id": "9007199254740993"
      }
    }
  ]
}
```

### 2.1 ThinkingData-Aligned Dual-ID Identity & Idempotency Constraints

- **`distinct_id` (Visitor / Device ID)**: The sole visitor or client device identifier on wire. ASCII control characters (`0x00–0x08`, `0x0E–0x1F`, `0x7F`) are rejected, leading/trailing Unicode whitespace is trimmed, and max UTF-8 byte length is **64 bytes**. Client SDKs auto-generate and persist `distinct_id` locally (overridable via `identify(visitorId)`); server SDKs may send empty `""` when reporting pure account events that already carry a non-empty `login_id` (**never copy or truncate `login_id` into `distinct_id`**).
- **`login_id` (Authenticated Account ID)**: The authenticated business account identifier; max UTF-8 byte length is **128 bytes** (omitted or `""` for unauthenticated visitors). At least one of `distinct_id` or `login_id` **must be non-empty** on every event.
- **Pure Local Client `login()` & Automatic Flink ID-Mapping**: Calling `login(accountId)` on client SDKs **strictly updates `login_id` in local state** without overwriting `distinct_id` and without emitting a separate identity-bind system event; calling `logout()` clears `login_id` while retaining the current `distinct_id`. Across both client and server SDKs, **whenever any behavioral event (`Track*`) or profile operation (`$user_*`) carries both non-empty `distinct_id` and `login_id`**, Flink Job1 automatically stitches them in `abi.identity_map` in real time.
- **`event_id` (Idempotent Primary Key)**: Max UTF-8 byte length is **64 bytes**. Preserved across offline retries on network failure, HTTP `429`, or `5xx` responses to guarantee idempotent ingestion. (*Note: Per D7① / G6 gate, trackFirst deduplication and trackUpdate/trackOverwrite mutable events are marked unsupported in current version; for idempotency pass a fixed deterministic event_id in track within the same partition window*).

### 2.2 Large Integer ($> 2^{53}-1$) Precision Protection

JavaScript and standard JSON parsers use IEEE-754 double-precision floats with a maximum safe integer of $2^{53}-1$ (`9007199254740991`).

- Whenever an integer property's absolute value exceeds `9007199254740991` (e.g., 64-bit Snowflake order IDs like `9007199254740993` or `Int64.min` / `Long.MIN_VALUE`), every ABI SDK automatically serializes it as a decimal string (`"9007199254740993"`) to prevent low-bit truncation.
- All SDKs also reject `NaN`, `Infinity` / `-Infinity`, `null` list elements, and nested objects/arrays inside list properties prior to enqueueing.

### 2.3 `$user_*` User Profile Operations

All SDKs provide 7 standard user profile mutation methods routed to the StarRocks `abi.dim_users` primary-key table:

| SDK Method | Wire `event_name` | Profile Mutation Semantics |
|------------|-------------------|----------------------------|
| `userSet(props)` | `$user_set` | Overwrite latest user profile properties (insert if absent, update if present) |
| `userSetOnce(props)` | `$user_set_once` | Initialize user profile properties only if currently null (e.g., first acquisition channel, registration source) |
| `userAdd(props)` | `$user_add` | Atomically increment/decrement numeric user profile properties (e.g., loyalty points, cumulative spend) |
| `userUnset(keys)` | `$user_unset` | Clear specified user profile property columns (`NULL` in `dim_users`) |
| `userAppend(props)` | `$user_append` | Append elements to array/list user profile properties |
| `userUniqAppend(props)` | `$user_uniq_append` | Append elements to array/list user profile properties with automatic deduplication |
| `userDelete()` | `$user_del` | Delete the current user's profile row from `abi.dim_users` (`StarRocksSinkOP.DELETE`) while preserving historical behavioral events in `dwd_events` |

> **Isolation Rule**: When building `$user_*` (or `#user_*`) events, SDKs **never inject** static/dynamic Super Properties or preset environment properties (`$os`, `$app_version`, `$lib`), preventing environment metadata from polluting `abi.dim_users`.

### 2.4 Integration Engineer Guide: Field Requirements & Client vs. Server Responsibilities (Important)

In production architectures, **Client-side SDKs (Web / MiniProgram / Mobile App)** and **Server-side SDKs (Go / Java)** operate in fundamentally different network topologies. Integration engineers must pay attention to how field responsibilities differ across SDK scenarios:

| Field / Property | Client SDKs (`ts-web` / `mobile` Flutter·Android·iOS) | Server SDKs (`go` / `java` / `python` / `nodejs` / `csharp` / `php` / `ruby`) | Direct HTTP (`RESTFUL_API.md`) | Gateway (`:8081`) & Flink ETL Behavior |
| :--- | :--- | :--- | :--- | :--- |
| **`project_id` & `project_token`** | **Required once at `init()`** | **Required when initializing Consumer** | **Required at top level of every request** | Gateway validates project status & token; returns `401/403` if invalid |
| **`event_name`** | **Required on every `track()`** (auto-set to `$user_*` by `userSet*()`) | **Required on every `Track()`** (auto-set to `$user_*` by `UserSet*()`) | **Required on every event** | Validated against `<= 128` chars and `^[A-Za-z_][A-Za-z0-9_]*$` (or system `$`/`#` whitelist) |
| **User Identity (`distinct_id` / `login_id`)** | **Auto-managed (not passed per `track`)**: SDK auto-generates & persists visitor `distinct_id` on `init()`; developer calls `login(accountId)` to persist `login_id` locally (subsequent events carry both IDs automatically) | **Required on EVERY call**: Server SDK is a stateless singleton shared across all users; developer **must explicitly pass** `login_id` (`accountId`) and/or client-forwarded visitor `distinct_id` (at least one non-empty; never copy `login_id` into `distinct_id`) | **Required on every event** (at least one of `distinct_id` / `login_id` must be non-empty) | Gateway rejects empty identity (`missing_identity`); whenever an event carries both non-empty `distinct_id` + `login_id`, Flink automatically stitches them in `abi.identity_map` |
| **End-User Public IP (`#ip` / `$ip`)**<br/>*(Used for Country / Province / City GeoIP)* | **Do NOT pass (Client cannot obtain it)**: Browsers and mobile apps sit behind NAT and cannot reliably read their public IP; Gateway automatically extracts client IP from the HTTP connection | **MUST be passed by Server**: When Go/Java backends call the gateway, the TCP connection IP seen by the gateway is the **backend IDC/VPC IP** (or none for `LoggerConsumer`). Server engineers must extract the user's real IP from client request headers (`X-Forwarded-For` / `X-Real-IP`) and pass it in `properties["#ip"]` or `"$ip"` | Omit for direct client calls; **pass `"#ip"` or `"$ip"` in `properties` for server-to-server calls** | Flink resolves GeoIP using strict priority **`properties["#ip"]` > `properties["$ip"]` > Gateway socket `client_ip`**, validates numeric IP literals, and strips `#ip`/`$ip` from `properties` |
| **Event Timestamp (`timestamp` / `#time` / `$time`)** | **Auto-filled (`Date.now()`)**: Omit for real-time events; only pass `#time` / `$time` or `options.timestamp` when backfilling historical offline events | **Auto-filled for real-time / Required for async & backfill**: For delayed MQ consumers, payment webhooks, or historical backfill, explicitly pass actual business time via `properties["#time"]` (or `TrackOptions.Timestamp` / `Date` / `Instant`) | **Required on every event** (either top-level ms `timestamp` or `properties["#time"]` / `"$time"`) | SDKs and Gateway extract `#time` / `$time` into top-level ms `timestamp` and strip them from `properties`; checked against `ts_window_days` |
| **Idempotency Key (`event_id`)** | **Auto-generated (UUIDv4)**: Preserved automatically across offline retries; per D7① / G6 gate, `trackFirst`/`trackUpdate`/`trackOverwrite` are converged as unsupported in the current version | **Auto-generated by default / Recommended for transactions**: Pass a deterministic business key (e.g., `"ord_paid_" + orderNo`) via `TrackWithOptions` / `trackWithId` to prevent duplicate counting on MQ retries | Recommended (Gateway generates UUID if omitted, but retries without fixed `event_id` won't deduplicate) | StarRocks `dwd_events` uses `event_id` for idempotent deduplication |
| **Device Context (`$os` / `$app_version` / `$screen_width`, etc.)** | **Auto-collected & injected by SDK** (into behavioral events only; excluded from `$user_*`) | **Not available on server**: Set service metadata via `SetSuperProperties`, or forward client headers (`$os`, `$app_version`, `$device_model`) in `properties` | Pass explicitly in `properties` as needed | Flink promotes `$os`, `$app_version`, `$device_model`, etc. to physical columns in `dwd_events` |

> **Frontend + Backend Funnel Stitching Best Practice**: When combining client-side browsing (Web/App SDK) with server-side order fulfillment (Go/Java/Python/Node/C#/PHP/Ruby SDK), pass the client's visitor ID (`abi.getDistinctId()`) to your backend API (e.g. via request header `X-ABI-Distinct-Id`), and have the backend pass both `loginId` (`accountId`), visitor `distinctId`, and the user's real `"#ip"` when calling the Server SDK. Flink automatically binds both IDs on any event, ensuring seamless cross-end funnel attribution and accurate geolocation.

---

## 3. Two-Step Interactive Demos & Code Examples Quick Reference

All visual UI demos and CLI/method demos across `abi.sdk` follow a unified **Two-Step Workflow**:
1. **Step 1 (Configure Parameters & Live Single Request JSON Preview)**: Changing identity, Super Properties, or event parameters updates a **single concrete `POST /collect/api/v1/track/batch` Request Body JSON preview** in place (never spamming endless log cards).
2. **Step 2 (Explicit Confirm & Submit)**: Clicking **Confirm & Submit** (`确认提交`) or confirming in CLI sends that exact payload and displays the single latest gateway response.

| Platform / SDK | Interactive UI / Runnable Demo Entrypoint | Core SDK Source | Verification & Launch Command |
|----------------|-------------------------------------------|-----------------|-------------------------------|
| **Go Server SDK** | [`go/examples/demo/main.go`](go/examples/demo/main.go) & [`go/example_test.go`](go/example_test.go) | [`go/abi.go`](go/abi.go) (`StagingConsumer`) | `cd abi.sdk/go && go run ./examples/demo` (type `y` after previewing JSON, or pass `--yes`) |
| **Java 11+ Server SDK** | [`java/src/main/java/com/anylink/abi/sdk/examples/AbiJavaSdkDemo.java`](java/src/main/java/com/anylink/abi/sdk/examples/AbiJavaSdkDemo.java) | [`AbiAnalytics.java`](java/src/main/java/com/anylink/abi/sdk/AbiAnalytics.java) & [`StagingConsumer.java`](java/src/main/java/com/anylink/abi/sdk/StagingConsumer.java) | `cd abi.sdk/java && JAVA_HOME=$(/usr/libexec/java_home -v 11) mvn test-compile exec:java -Dexec.mainClass="com.anylink.abi.sdk.examples.AbiJavaSdkDemo"` |
| **Python 3 Server SDK** | [`python/examples/demo.py`](python/examples/demo.py) | [`python/abi_sdk.py`](python/abi_sdk.py) (`StagingConsumer`) | `python3 abi.sdk/python/examples/demo.py --yes` |
| **Node.js Server SDK** | [`nodejs/examples/demo.mjs`](nodejs/examples/demo.mjs) | [`nodejs/src/index.mjs`](nodejs/src/index.mjs) (`StagingConsumer`) | `node abi.sdk/nodejs/examples/demo.mjs --yes` |
| **C# (.NET) Server SDK** | [`csharp/Program.cs`](csharp/Program.cs) | [`csharp/AbiAnalytics.cs`](csharp/AbiAnalytics.cs) (`StagingConsumer`) | `dotnet run --project abi.sdk/csharp -- --yes` |
| **PHP 8.1+ Server SDK** | [`php/examples/demo.php`](php/examples/demo.php) | [`php/src/AbiAnalytics.php`](php/src/AbiAnalytics.php) (`StagingConsumer`) | `php abi.sdk/php/examples/demo.php --yes` |
| **Ruby Server SDK** | [`ruby/examples/demo.rb`](ruby/examples/demo.rb) | [`ruby/lib/abi_sdk.rb`](ruby/lib/abi_sdk.rb) (`StagingConsumer`) | `ruby abi.sdk/ruby/examples/demo.rb --yes` |
| **C / C++17 Cross-Platform SDK** | [`cpp/examples/demo.cpp`](cpp/examples/demo.cpp) | [`cpp/include/abi_sdk.hpp`](cpp/include/abi_sdk.hpp) (`StagingConsumer` & `extern "C"`) | `clang++ -std=c++17 -O2 -Iabi.sdk/cpp/include abi.sdk/cpp/examples/demo.cpp -o /tmp/abi_cpp_demo && /tmp/abi_cpp_demo --yes` |
| **Lua 5.3+ Cross-Platform SDK** | [`lua/examples/demo.lua`](lua/examples/demo.lua) | [`lua/abi_sdk.lua`](lua/abi_sdk.lua) (`StagingConsumer`) | `lua abi.sdk/lua/examples/demo.lua --yes` |
| **Web / H5 Interactive Playground** | [`ts-web/examples/interactive-demo.html`](ts-web/examples/interactive-demo.html) & [`ts-web/examples/usage-examples.ts`](ts-web/examples/usage-examples.ts) (`previewAndConfirmWebSdkExample`) | [`ts-web/src/index.ts`](ts-web/src/index.ts) (`buildPendingBatchPayload`) | Open `ts-web/examples/interactive-demo.html` in a browser or run `cd abi.sdk/ts-web && pnpm test` |
| **App-H5 WebView Bridge & H5 Game Engines** | [`ts-web/test/abi-web-sdk.test.ts`](ts-web/test/abi-web-sdk.test.ts) | [`h5-bridge.ts`](ts-web/src/adapters/h5-bridge.ts) & [`game-engines.ts`](ts-web/src/adapters/game-engines.ts) | `cd abi.sdk/ts-web && pnpm test` (Android/iOS WebView Bridge + Cocos Creator / Egret / LayaAir / Weex) |
| **ABI Admin Console SDK Drawer** | [`../abi.cli/src/pages/Meta/MetaProjects.tsx`](../abi.cli/src/pages/Meta/MetaProjects.tsx) & [`../abi.cli/src/lib/sdk-guide-token.ts`](../abi.cli/src/lib/sdk-guide-token.ts) | Same as above | In Admin Console `Metadata -> Projects -> SDK Guide`, configure parameters to preview JSON and click `Confirm & Submit` |
| **WeChat MiniProgram & React Native** | [`ts-web/examples/usage-examples.ts`](ts-web/examples/usage-examples.ts) (`runWeChatMiniProgramExample`, `runReactNativeExample`) | [`miniapp.ts`](ts-web/src/adapters/miniapp.ts) & [`react-native.ts`](ts-web/src/adapters/react-native.ts) | `cd abi.sdk/ts-web && pnpm test` |
| **Unity Game Engine Client SDK** | [`game-engines/unity/AbiUnityDemoMonoBehaviour.cs`](game-engines/unity/AbiUnityDemoMonoBehaviour.cs) (`AbiUnityDemoMonoBehaviour` / `AbiUnityDemoRunner`) | [`game-engines/unity/AbiUnityAnalytics.cs`](game-engines/unity/AbiUnityAnalytics.cs) (`BuildPendingBatchJson`) | Mount `AbiUnityDemoMonoBehaviour` in Unity or run `dotnet run --project abi.sdk/csharp -- --test` |
| **Flutter Client SDK** | [`mobile/flutter/example/lib/main.dart`](mobile/flutter/example/lib/main.dart) (`AbiSdkDemoApp`) | [`mobile/flutter/lib/abi_sdk.dart`](mobile/flutter/lib/abi_sdk.dart) (`buildPendingBatchPayload` / `previewScenarioPayload` + `confirmSubmit`) | Mount `AbiSdkDemoApp` in Flutter or call `previewScenarioPayload` + `confirmSubmit` (see [`mobile/flutter/README.en.md`](mobile/flutter/README.en.md)) |
| **Android Kotlin Client SDK** | [`mobile/android/example/AbiDemoActivity.kt`](mobile/android/example/AbiDemoActivity.kt) (`AbiDemoActivity` / `previewScenarioPayload` + `confirmSubmit`) | [`mobile/android/AbiAnalytics.kt`](mobile/android/AbiAnalytics.kt) (`buildPendingBatchPayload`) | Launch `AbiDemoActivity` on Android or call `previewScenarioPayload` + `confirmSubmit` (see [`mobile/android/README.en.md`](mobile/android/README.en.md)) |
| **iOS Swift Client SDK** | [`mobile/ios/example/AbiDemoViewController.swift`](mobile/ios/example/AbiDemoViewController.swift) (`AbiSdkDemoView` / `AbiSdkDemoRunner`) | [`mobile/ios/AbiAnalytics.swift`](mobile/ios/AbiAnalytics.swift) (`buildPendingBatchJsonString`) | Mount `AbiSdkDemoView()` in SwiftUI or run `swiftc -typecheck abi.sdk/mobile/ios/AbiAnalytics.swift abi.sdk/mobile/ios/example/AbiDemoViewController.swift` |
| **LogBus 2 / Data Import Toolkit** | [`data-import/abi_logbus.py`](data-import/abi_logbus.py) (`--demo` two-step preview & confirm) | [`data-import/abi_logbus.py`](data-import/abi_logbus.py) + Filebeat / Logstash / Vector / DataX configs | `python3 abi.sdk/data-import/abi_logbus.py --demo --yes` |
