**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

# ABI Web / TypeScript / WeChat MiniProgram / React Native SDK (`@anylink/abi-web-sdk`)

`@anylink/abi-web-sdk` is a cross-platform User Behavior Analytics (UBA) tracking SDK for **Web / H5 Single-Page Applications (SPA), WeChat MiniProgram / uni-app / Taro, and React Native**. It is fully benchmarked against **ThinkingData JS SDK v3.4** semantics and integrates seamlessly with the ABI Ingest Gateway (`POST /collect/api/v1/track/batch`), Flink streaming ETL, and StarRocks OLAP tables.

---

## 1. Core Capabilities Overview

| Domain | Core APIs / Mechanism | Highlights |
|--------|-----------------------|------------|
| **Dual-ID Identity Model** | `identify(distinctId)`<br>`login(accountId)`<br>`logout()`<br>`getDistinctId()` / `getLoginId()` | Automatically generates and persists a UUIDv4 visitor/device ID (`distinct_id` $\le 64$ UTF-8 bytes) on init. `identify()` updates `distinct_id` locally; `login()` sets the authenticated account (`login_id` $\le 128$ UTF-8 bytes) locally **without overwriting `distinct_id` and without emitting any network event**, so subsequent events carry both `distinct_id` and `login_id`; `logout()` clears `login_id` while keeping `distinct_id` intact. |
| **Static & Dynamic Super Properties** | `setSuperProperties(props)`<br>`unsetSuperProperty(key)`<br>`clearSuperProperties()`<br>`getSuperProperties()`<br>`setDynamicSuperProperties(fn)` | Static super properties are persisted in storage; dynamic super properties are evaluated at every `track()` call. Merge precedence: **Event Custom Properties > Dynamic Super Properties > Static Super Properties > Platform Preset Properties** (`$user_*` profile events exclude preset and super properties). |
| **High-Precision Event Timing** | `timeEvent(eventName)` $\rightarrow$ `$duration` | Uses a monotonic clock (`performance.now()`) to measure elapsed time and automatically injects `$duration` (in seconds, rounded to 3 decimal places) when `track(eventName)` is called. |
| **First-Time Event Deduplication (Unsupported in Current Version)** | `trackFirst(eventName, firstCheckId, props)` | (*Unsupported in current version per D7① / G6 gate*) Throws an explicit `Error` without enqueueing fake events. For same-day retry idempotency, pass a deterministic `eventId` via `track(..., { eventId })`. |
| **Updatable & Overwritable Events (Unsupported in Current Version)** | `trackUpdate(eventName, eventId, props)`<br>`trackOverwrite(eventName, eventId, props)` | (*Unsupported in current version per D7① / G6 gate*) Throws an explicit `Error` without enqueueing fake events. Emit distinct milestone events via `track()` instead. |
| **`BigInt` & `> 2^53 - 1` Precision Protection** | Automatic serialization in `normalizeProperties` | Automatically serializes native `BigInt` values (e.g., `9007199254740993n`) and 64-bit Snowflake IDs outside the IEEE-754 safe integer range (`> 2^53 - 1` or `< -(2^53 - 1)`, including array elements) into lossless decimal strings, preventing `JSON.stringify` precision loss. |
| **Automatic `#time` / `$time` Extraction** | `properties['#time' \| '$time']` | Accepts a `Date` instance, Unix timestamp (seconds or milliseconds), or date string (e.g., `'2026-11-10 12:30:00'`) in event or `$user_*` properties, automatically converting it into the top-level `timestamp` (ms) and stripping `#time` / `$time` from `properties`. |
| **7 `$user_*` User Profile Operations** | `userSet` (`$user_set`)<br>`userSetOnce` (`$user_set_once`)<br>`userAdd` (`$user_add`)<br>`userUnset` (`$user_unset`)<br>`userAppend` (`$user_append`)<br>`userUniqAppend` (`$user_uniq_append`)<br>`userDelete` (`$user_del`) | Covers the full lifecycle of StarRocks `abi.dim_users` profile mutations: overwrite, initialize-once, atomic numeric increment, property unset, list append, deduplicated list append, and profile deletion. |
| **SPA Auto-Tracking & Offline Retry** | `enableAutoTrack({ pageView, pageLeave, webClick })`<br>`navigator.sendBeacon` + persistent queue | Listens to `pushState`, `replaceState`, `popstate`, and `hashchange` for `$pageview`; captures `<button>`, `<a>`, `<input>`, and `[data-abi-track]` clicks for `$AppClick`; tracks page stay duration on `visibilitychange` / `pagehide` via `$AppEnd` with priority `navigator.sendBeacon` delivery. Retains original `event_id` in persistent storage for idempotent retry on network errors, HTTP `429`, or `5xx`. |

---

## 2. Developer Integration Guide: Required Fields vs. SDK Auto-Collected vs. Gateway/Server Enriched (e.g., IP)

From the perspective of a frontend, MiniProgram, or React Native engineer, all tracking fields fall into three clear categories:

### 1. Field Responsibility Comparison Table

| Category | Stage / Field Name | Developer Action | Source & Handling Mechanism |
|----------|--------------------|------------------|-----------------------------|
| **Category 1: Required Fields Passed by Developer** | **Initialization (`init`)**: `serverUrl`, `projectId` (`> 0`), `token` | **Required** | Specifies the `:8081` ingest gateway URL, project ID (`> 0`), and non-empty project secret (`project_token`). |
| | **Event Tracking (`track`)**: `eventName` | **Required** | Business event name (e.g., `'OrderPaid'`), with optional custom business attributes in `properties`. |
| | **Account Login (`login`)**: `accountId` (`login_id`) | **Required on Login** | Passed when a user completes authentication; persists `login_id` locally while keeping `distinct_id` intact (sends no network event) so subsequent events carry both `distinct_id` and `login_id`. |
| | **Mutable Events (`trackUpdate` / `trackOverwrite`)**: `eventId` | **Unsupported in current version** | Per D7① / G6 gate, calling these methods throws an `Error` without enqueueing; pass a fixed `eventId` via `track(..., { eventId })` for same-day retry idempotency. |
| **Category 2: Auto-Generated & Persisted by SDK (No Manual Input Needed)** | `distinct_id` | **Auto-generated** | Generates a UUIDv4 visitor/device ID on init and persists it to local storage (`localStorage` / `SharedPreferences` / `UserDefaults`); customizable via `identify()` and preserved across `login()` / `logout()`. |
| | `event_id` | **Auto-generated** | Generates a unique UUIDv4 per `track` call and preserves the exact same `event_id` across offline/weak-network retries for idempotency. |
| | `timestamp` | **Auto-generated** | Automatically captures current client epoch milliseconds (unless explicitly overridden via `#time` / `$time` for historical events). |
| | Preset Device & Context Properties: `$lib`, `$lib_version`, `$os`, `$os_version`, `$device_model`, `$screen_width`, `$screen_height`, `$url`, `$title`, `$referrer`, `$zone_offset` | **Auto-collected** | Automatically collected and injected by the SDK (`$user_*` profile events automatically exclude preset properties). |
| **Category 3: Enriched by Ingest Gateway / Server (Unavailable on Client)** | **Public IP & Geo Location (`#ip` / `$ip` $\rightarrow$ Country / Province / City)** | **Never pass from client** | When the client connects directly to the `:8081` ingest gateway, the gateway extracts the real client IP from the HTTP connection (`X-Forwarded-For` / `X-Real-IP`) and Flink resolves country, province, and city. |

### 2. Detailed Breakdown & Frontend-Backend Funnel Stitching

1. **Category 1: Fields Developers MUST Explicitly Pass**
   - **Initialization (`init` / `initialize`)**: `serverUrl` (ingest gateway URL), `projectId` (`> 0`), and `token` / `projectToken` (non-empty project key).
   - **Event Tracking (`track`)**: `eventName` (required, e.g., `'OrderPaid'`).
   - **Account Login (`login`)**: Pass `accountId` (`login_id`) when the user logs in to persist `login_id` locally while preserving `distinct_id` (no extra network event emitted); subsequent events carry both `distinct_id` and `login_id`.
   - **Same-Day Retry Idempotency (optional `TrackOptions.eventId`)**: Pass `track(eventName, props, { eventId })` when deterministic same-day deduplication is needed (*Note: `trackFirst` / `trackUpdate` / `trackOverwrite` are unsupported in current version and throw `Error`*).
2. **Category 2: Fields Auto-Generated & Persisted by the SDK (No Manual Input Required)**
   - **`distinct_id` (Visitor / Device ID)**: Generated as UUIDv4 upon initialization and persisted to local storage (`localStorage` / `SharedPreferences` / `UserDefaults`). Can be customized via `identify()` and is never overwritten by `login()` or `logout()`.
   - **`event_id`**: Generated as UUIDv4 on every `track` call and kept unchanged across offline/weak-network retries for idempotent deduplication.
   - **`timestamp`**: Defaults to the client's current millisecond timestamp (unless a historical time is explicitly specified via `#time` / `$time`).
   - **Device & Environment Preset Properties**: `$lib`, `$lib_version`, `$os`, `$os_version`, `$device_model`, `$screen_width`, `$screen_height`, `$url`, `$title`, `$referrer`, `$zone_offset`.
3. **Category 3: Fields Unavailable to Clients & Populated by Gateway/Server (`IP` & Cross-Stack Stitching)**
   - **Public IP & Geo Resolution (`#ip` / `$ip` $\rightarrow$ Country/Province/City)**: Browser JS, MiniPrograms, and mobile apps run inside client sandboxes behind NAT routers and **cannot reliably obtain their own public egress IP—therefore, client integrations must NEVER pass `$ip` / `#ip`**! When clients report directly to the `:8081` ingest gateway, the gateway automatically extracts the real client IP from the HTTP connection (including Nginx/SLB `X-Forwarded-For` / `X-Real-IP` headers) and Flink automatically resolves country, province, and city.
   - **When SHOULD `#ip` / `$ip` be passed?** Only when your architecture routes requests as "Client calls your business backend API $\rightarrow$ Go/Java Server SDK reports tracking events on behalf of the user". Because the ingest gateway sees the backend server's datacenter IP in that topology, your business backend should extract the client IP from the incoming request and pass it via `#ip` / `$ip` to the server SDK. At the same time, we recommend forwarding `abi.getDistinctId()` (or mobile `getDistinctId()`) in a request header when calling your backend API so the server can stitch frontend-to-backend conversion funnels:
     ```ts
     // Forward distinct_id to your business backend so Server SDK events share the same visitor identity
     await fetch('/api/v1/orders/checkout', {
       method: 'POST',
       headers: {
         'Content-Type': 'application/json',
         'X-ABI-Distinct-Id': abi.getDistinctId(),
       },
       body: JSON.stringify({ skuId: 'sku_1001', count: 1 }),
     });
     ```

---

## 3. Two-Step "Configure & Preview Request JSON -> Confirm & Flush" & Interactive Playground

For integration testing, QA verification, and interactive debugging, the SDK provides `buildPendingBatchPayload()` and `clearQueue()` to support a two-step **"assemble parameters & preview the exact batch JSON payload before calling `flush()` to submit"** workflow:

```ts
import { AbiWebSdk } from '@anylink/abi-web-sdk';

const sdk = new AbiWebSdk().init({
  serverUrl: 'http://localhost:8081',
  projectId: 1,
  token: 'abi_proj_token_demo',
  flushIntervalMs: 600_000, // Defer automatic timer flush for manual confirmation
  dryRun: true,             // Optional: validate auth & schema on gateway without writing to Kafka/StarRocks
});

// Step 1: Configure identity, super properties, and enqueue events (call sdk.clearQueue() anytime to rebuild)
sdk.identify('visitor_preview_001');
sdk.setSuperProperties({ channel: 'organic_search' });
sdk.track('OrderPaid', {
  order_id: 9007199254740993n,
  amount: 299.5,
  '#time': '2026-11-10T08:00:00.000Z',
});

// Preview the exact JSON payload to be sent to POST /collect/api/v1/track/batch without mutating the queue
const previewPayload = sdk.buildPendingBatchPayload();
console.log('Pending Batch Request JSON Preview:', JSON.stringify(previewPayload, null, 2));

// Step 2: Confirm and flush the batch to the ingest gateway
const ok = await sdk.flush();
console.log('Flush succeeded:', ok);
```

### Browser Interactive Playground

A zero-dependency interactive playground is included at [`examples/interactive-demo.html`](examples/interactive-demo.html) (see [`examples/README.en.md`](examples/README.en.md) for full details):

1. Build the SDK and start a local static server:
   ```bash
   cd abi.sdk/ts-web
   pnpm run build
   python3 -m http.server 8090
   ```
2. Open `http://localhost:8090/examples/interactive-demo.html` in your browser (or open the HTML file directly via `file://` using its built-in fallback implementation).
3. Configure identities, static/dynamic super properties, and 24 event triggers on the left, inspect the live request JSON preview on the right, switch between `mock`, `dry_run`, and `live` modes, and click **"Confirm & Submit"** (`flush`).

---

## 4. Multi-Platform Quick Start Examples

See [`examples/usage-examples.ts`](examples/usage-examples.ts) for runnable end-to-end code.

### 1. Web SPA Integration

```ts
import { AbiWebSdk } from '@anylink/abi-web-sdk';

export const abi = new AbiWebSdk().init({
  serverUrl: 'https://ingest.abi.example.com',
  projectId: 101,
  token: 'abi_proj_token_web_ecommerce',
  appVersion: '3.4.0',
  autoTrack: {
    pageView: true,  // Track $pageview on History / Hash route changes
    pageLeave: true, // Track $AppEnd stay duration on visibilitychange / pagehide (sendBeacon)
    webClick: true,  // Track $AppClick on button / a / input / [data-abi-track] elements
  },
});

// 1. Visitor identity & super properties
abi.identify('visitor_web_001');
abi.setSuperProperties({ channel: 'seo_landing', ab_group: 'checkout_v2' });
abi.setDynamicSuperProperties(() => ({ cart_items: 2 }));

// 2. Set account ID on login (persists login_id locally, keeps distinct_id intact, emits no extra event)
abi.login('user_10086');

// 3. Event timing, same-day idempotent eventId, 64-bit Snowflake ID & milestone events
abi.timeEvent('OrderPaid');
abi.track('CheckoutStarted', { coupon: 'WELCOME_ABI' }, { eventId: 'evt_checkout_001' });

abi.track('OrderPaid', {
  order_id: 9007199254740993n, // > 2^53 - 1 serialized losslessly as "9007199254740993"
  amount: 299.5,
  items: ['sku_1', 2, true],
}, { eventId: 'evt_order_paid_001' });

abi.track('OrderSettled', { order_id: 9007199254740993n, amount: 279.5, status: 'settled' });

// 4. User profile operations ($user_*)
abi.userSet({ vip_level: 'gold', city: 'Shanghai' });
abi.userSetOnce({ first_order_date: '2026-11-10' });
abi.userAdd({ loyalty_points: 300, total_orders: 1 });
abi.userUniqAppend({ badges: ['early_adopter', 'vip_2026'] });
await abi.flush();
```

### 2. WeChat MiniProgram / uni-app / Taro (`createMiniProgramAdapter`)

Use `@anylink/abi-web-sdk/adapters/miniapp` to bridge synchronous storage (`wx.getStorageSync` / `setStorageSync`), network transport (`wx.request`), and device preset properties (`$lib: 'abi-mp-sdk'`, `$os`, `$os_version`, `$device_model`, screen dimensions):

```ts
import { AbiWebSdk } from '@anylink/abi-web-sdk';
import { createMiniProgramAdapter } from '@anylink/abi-web-sdk/adapters/miniapp';

const mpAdapter = createMiniProgramAdapter(wx); // Pass `uni` for uni-app or `Taro` for Taro

export const abiMp = new AbiWebSdk().init({
  serverUrl: 'https://ingest.abi.example.com', // Add domain to WeChat MiniProgram request allowlist
  projectId: 102,
  token: 'abi_proj_token_wx_miniapp',
  appVersion: '2.1.0',
  ...mpAdapter,
});

abiMp.track('$AppStart', { path: 'pages/home/index', scene: 1001 });
abiMp.login('wx_openid_u_8801');
abiMp.track('ShareMiniProgram', {
  share_target: 'moments',
  campaign_id: 9007199254740999n,
});
```

### 3. React Native Mobile App (`createReactNativeAdapter`)

Use `@anylink/abi-web-sdk/adapters/react-native` to inject mobile device preset properties (`$lib: 'abi-rn-sdk'`, `$os`, `$os_version`, `$device_model`, `$screen_width`, `$screen_height`) and a synchronous storage adapter (such as `react-native-mmkv`):

```ts
import { AbiWebSdk, type AbiStorageAdapter } from '@anylink/abi-web-sdk';
import { createReactNativeAdapter } from '@anylink/abi-web-sdk/adapters/react-native';

const mmkvStorage: AbiStorageAdapter = {
  getItem: (key) => mmkv.getString(key) ?? null,
  setItem: (key, value) => mmkv.set(key, value),
  removeItem: (key) => mmkv.delete(key),
};

const rnAdapter = createReactNativeAdapter({
  os: 'android',
  osVersion: '14',
  deviceModel: 'Pixel 8 Pro',
  appVersion: '4.0.2',
  screenWidth: 412,
  screenHeight: 915,
  syncStorage: mmkvStorage,
});

export const abiRn = new AbiWebSdk().init({
  serverUrl: 'https://ingest.abi.example.com',
  projectId: 103,
  token: 'abi_proj_token_rn_mobile',
  ...rnAdapter,
});

abiRn.identify('rn_device_uuid_7788');
abiRn.login('rn_user_5566');
abiRn.timeEvent('VideoPlayback');
abiRn.track('VideoPlayback', { video_id: 'vid_onboarding_4k', resolution: '2160p' });
```

---

## 5. Build & Test Commands

Run the unit test suite (including golden vector contract checks, offline idempotent retry assertions, and multi-platform integration tests) and compile the ESM + `.d.ts` output from `abi.sdk/ts-web`:

```bash
cd abi.sdk/ts-web
pnpm test && pnpm run build
```
