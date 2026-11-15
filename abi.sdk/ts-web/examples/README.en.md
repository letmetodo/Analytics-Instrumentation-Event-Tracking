**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

# ABI TypeScript SDK Interactive Playground & Multi-Platform Examples

This directory provides a visual integration playground and runnable end-to-end examples for `@anylink/abi-web-sdk` (a cross-platform tracking SDK for **Web / H5 / WeChat MiniProgram / uni-app / Taro / React Native**, compatible with ThinkingData v3.4 semantics):

| File | Description |
|------|-------------|
| [`interactive-demo.html`](./interactive-demo.html) | Zero-dependency browser interactive playground with a configuration bar, live state dashboard, 5 core capability trigger groups, and a real-time JSON request inspector |
| [`usage-examples.ts`](./usage-examples.ts) | Runnable TypeScript examples covering Web SPA e-commerce, WeChat MiniProgram (`createMiniProgramAdapter`), and React Native (`createReactNativeAdapter`) |

---

## 1. Browser Interactive Playground (`interactive-demo.html`)

### 1.1 Opening & Integration Modes

#### Option A: Open via a Local HTTP Server After Building (Recommended — Loads Real Compiled Output)

1. Compile the SDK output `dist/index.js` in `abi.sdk/ts-web`:
   ```bash
   cd abi.sdk/ts-web
   pnpm run build
   ```
2. Start any static file server in `abi.sdk/ts-web` (for example, Python's built-in HTTP server):
   ```bash
   cd abi.sdk/ts-web
   python3 -m http.server 8090
   ```
3. Visit `http://localhost:8090/examples/interactive-demo.html` in your browser. The badge next to the header title will display **`已加载 ../dist/index.js`** (`Loaded ../dist/index.js`), indicating that the page is running the actual compiled SDK bundle.

#### Option B: Open Directly by Double-Clicking (Zero-Build Offline Quick Preview)

If you have not built the SDK yet or open `examples/interactive-demo.html` directly via the `file://` protocol (where browsers block cross-directory ES Module imports), the page automatically activates its built-in lightweight fallback implementation (the badge shows **`内置兜底 SDK（执行 pnpm run build 可加载 dist/index.js）`**), allowing you to inspect request payloads without any backend or local server.

#### Connecting to a Live ABI Ingest Gateway (`:8081`)

To send playground events to a local or staging ABI Ingest Gateway (`POST /collect/api/v1/track/batch`):

1. Start the backend ingest gateway:
   ```bash
   cd abi.srv
   ENV=dev go run ./cmd/gateway/
   ```
2. Fill in the top configuration bar in the playground:
   - **Server URL**: `http://localhost:8081`
   - **Project ID**: Numeric ID of the target project (e.g., `1`)
   - **Project Token**: The `project_token` issued in the Admin "Project Management" page
   - **Send Mode**: Select **Real Gateway Dry-Run (Validate Only)** or **Real Gateway Live Ingest**
3. Click the **"Initialize / Re-initialize SDK"** button to apply the configuration.

---

### 1.2 The 3 Send Modes

The **"Send Mode"** dropdown in the top bar supports 3 integration levels:

| Send Mode | Request Behavior & `dry_run` Flag | Use Case |
|-----------|-----------------------------------|----------|
| **Local Mock Inspector (No Backend Needed)** (`mock`) | Does not send real network requests; intercepts the transport layer locally, returns a simulated `200 OK`, and renders the full batch JSON in the right-hand inspector panel | Offline frontend development, verifying field names, dual-ID transitions, and `BigInt` serialization format |
| **Real Gateway Dry-Run (Validate Only, No DB Write)** (`dry_run`) | Sends a real HTTP request to `POST /collect/api/v1/track/batch` with `"dry_run": true` at the top level; the gateway performs full token authentication, field validation, and schema checks **without writing to Kafka or StarRocks** | Pre-release gateway connectivity checks, debugging auth errors or invalid property types without polluting staging/production tables |
| **Real Gateway Live Ingest (Write to Kafka/StarRocks)** (`live`) | Sends live event batches to the ingest gateway, flowing through Kafka into Flink Job1 ETL / Job2 ODS and persisting into StarRocks (`dwd_events`, `dim_users`, `identity_map`, `ods_events_raw`) | End-to-end pipeline verification, BI report validation, and real-time user cohort/profile checks |

---

### 1.3 Live State Dashboard & "Configure & Preview -> Confirm & Submit" Workflow

The playground uses a clean **"configure parameters on the left, preview the single pending request JSON on the right, and manually confirm submission"** workflow without spamming endless log cards when toggling super properties or identities:

1. **Live State Dashboard**:
   - **Visitor ID (`distinct_id`)**: Auto-generated UUIDv4 visitor/device ID on initialization; can be overridden via `identify()` and remains unchanged across `login()` / `logout()`.
   - **Login Account ID (`login_id`)**: Authenticated business account ID set via `login()`; displays `(未登录)` (`Not logged in`) before login or after `logout()`.
2. **Right-Hand "Pending Request JSON Preview" & "Confirm & Submit" Panel**:
   - **Request Body JSON**: Always displays the single complete `POST /collect/api/v1/track/batch` payload waiting to be sent, **and supports direct in-place manual editing and one-click JSON formatting** (with live syntax and `events` array validation). Modifying identity, editing/toggling super properties, or selecting different events updates this JSON preview in place (checking "Multi-event batch mode" appends multiple events into the same `events` array).
   - **Confirm & Submit**: After verifying the request JSON above, click the green **"Confirm & Submit"** button in the top-right corner to actually dispatch the request and update the **"Latest Submission Result"** section below.

---

### 1.4 Capability Groups & Parameter Builder Buttons

The left column of the playground is organized into **parameter configuration and event builder groups** following the tracking lifecycle:

#### Group 1: Identity & Session Parameters (`identify` / `login` / `logout`)

1. **Switch Random Visitor ID (`identify`)**: Updates the visitor/device `distinct_id` locally and immediately refreshes `distinct_id` in the pending request preview.
2. **Set Login Account (`login`)**: Calls `sdk.login(...)` as a pure local state change (never overwrites `distinct_id` and emits no network event), immediately refreshing the preview JSON so the currently staged behavioral/user event displays both `distinct_id` and `login_id`.
3. **Logout (`logout`)**: Calls `sdk.logout()` to clear `login_id` while keeping `distinct_id` intact, and refreshes the preview JSON.

#### Group 2: Super Properties Configuration (`Super Properties`)

4. **Static Super Properties JSON Input + Apply Static Super Properties**: Edit any JSON object and call `sdk.setSuperProperties(...)`; the `properties` of the pending behavioral event on the right immediately merge these fields in place.
5. **Toggle Dynamic Super Properties (On / Off)**: Toggles `setDynamicSuperProperties`; when enabled, behavioral events automatically merge `dyn_sequence` and `viewport_width` without spamming extra log entries.
6. **Clear All Super Properties**: Clears static super properties and disables dynamic super properties, removing those fields from the preview JSON.

#### Group 3: Behavioral Event Tracking (`track` / `timeEvent` / Fixed `eventId` Idempotency / `BigInt`)

7. **Track Product View (`ProductView`)**
   - Calls `sdk.track('ProductView', { sku_id, product_name, price, in_stock })` to report a standard e-commerce product view event, automatically merging preset properties (`$lib`, `$url`, `$screen_width`, etc.) and super properties.
8. **Start Event Timer (`timeEvent 'OrderPaid'`)**
   - Calls `sdk.timeEvent('OrderPaid')` using a high-precision monotonic clock (`performance.now()`) without sending a network request.
9. **Complete Timed Event (`$duration`)**
   - Calls `sdk.track('OrderPaid', { amount: 299.5, currency: 'CNY', payment_method: 'apple_pay' })`; if "Start Event Timer" was clicked earlier, the SDK automatically calculates elapsed seconds (rounded to 3 decimal places) and injects `$duration`.
10. **Fixed `eventId` Same-Day Idempotency (`CheckoutStart`)**
    - Calls `sdk.track('CheckoutStart', { coupon_code: 'WELCOME_ABI' }, { eventId })` with a deterministic `event_id` for same-day retry deduplication (*Note: `trackFirst` / `trackUpdate` / `trackOverwrite` are unsupported in current version per D7① / G6 gate and throw `Error` without enqueueing*).
11. **Track 64-Bit Snowflake ID (`BigInt > 2^53-1`)**
    - Calls `sdk.track('OrderPaid', { order_id: 9007199254740993n, snowflake_trace_id: 1844674407370955161n, items: [...] })`; `BigInt` values (including array items) exceeding the IEEE-754 safe integer limit (`> 2^53 - 1`) are losslessly serialized as decimal strings.

#### Group 4: User Profile Operations (`$user_*` -> StarRocks `abi.dim_users`)

14. **Overwrite Profile (`userSet`: `vip_level/city`)**
    - Calls `sdk.userSet({ vip_level: 'diamond', city: 'Shanghai' })`, emitting `$user_set` to overwrite the latest user profile attributes (note: `$user_*` events do not include browser preset properties or super properties).
15. **Initialize Profile Once (`userSetOnce`: `first_channel`)**
    - Calls `sdk.userSetOnce({ first_channel: 'organic_search' })`, emitting `$user_set_once` to write the field only if it is currently null/uninitialized.
16. **Increment Numeric Profile (`userAdd`: `loyalty_points +50`)**
    - Calls `sdk.userAdd({ loyalty_points: 50 })`, emitting `$user_add` for atomic numeric addition (negative numbers decrement).
17. **Append List Elements (`userAppend`: `interest_tags`)**
    - Calls `sdk.userAppend({ interest_tags: ['analytics', 'starrocks'] })`, emitting `$user_append` to append items to an array/set profile property.
18. **Append Unique List Elements (`userUniqAppend`: `badges`)**
    - Calls `sdk.userUniqAppend({ badges: ['early_adopter', 'verified_dev'] })`, emitting `$user_uniq_append` to append and deduplicate array elements.
19. **Unset Profile Property (`userUnset`: `city`)**
    - Calls `sdk.userUnset('city')`, emitting `$user_unset` to clear and remove the specified property from the user profile.
20. **Delete User Profile (`userDelete` / `$user_del`)**
    - Calls `sdk.userDelete()`, emitting `$user_del` to mark the current user's profile record for deletion in `abi.dim_users`.

#### Group 5: Auto-Tracking & Queue Control (`$pageview` / `$AppClick` / `$AppEnd` / `flush()`)

21. **Simulate SPA Page View (`$pageview`)**
    - Simulates a single-page route transition and tracks `$pageview` (with `$url`, `$url_path`, `$title`); in production, `init({ autoTrack: { pageView: true } })` automatically listens to `pushState`, `replaceState`, `popstate`, and `hashchange`.
22. **Capture Button Click (`$AppClick`)**
    - Simulates clicking an interactive button marked with `data-abi-track="demo-cta"` and tracks `$AppClick` (`element_type`, `element_id`, `element_content`); in production, enable `autoTrack: { webClick: true }`.
23. **Simulate Page Leave Duration (`$AppEnd`)**
    - Simulates page hide/unload by tracking `$AppEnd` with stay duration (`$duration: 12.48` seconds); in production, `autoTrack: { pageLeave: true }` triggers automatically on `visibilitychange` / `pagehide` and prioritizes `navigator.sendBeacon`.
24. **Flush Queue Immediately (`flush`)**
    - Manually calls `await sdk.flush()` to immediately send pending events in the memory and persistent queue to the gateway.

---

## 2. Multi-Platform Code Examples (`usage-examples.ts`)

[`usage-examples.ts`](./usage-examples.ts) provides 3 zero-dependency async example functions that can be imported and executed directly, covering standard integration patterns for Web, WeChat MiniProgram, and React Native.

### 2.1 Web SPA E-Commerce End-to-End Integration (`runWebSpaEcommerceExample`)

Walks through 9 standard e-commerce steps from anonymous landing to order checkout and profile enrichment:

```ts
import { AbiWebSdk } from '@anylink/abi-web-sdk';

const sdk = new AbiWebSdk().init({
  serverUrl: 'https://ingest.abi.example.com',
  projectId: 101,
  token: 'abi_proj_token_web_ecommerce_demo',
  appVersion: '3.4.0',
  autoTrack: { pageView: true, pageLeave: true, webClick: true },
});

// 1. Visitor identity & static/dynamic super properties
sdk.identify('visitor_web_001');
sdk.setSuperProperties({ channel: 'seo_landing', ab_group: 'checkout_one_step_v2' });
sdk.setDynamicSuperProperties(() => ({ cart_items: 2 }));

// 2. Unauthenticated product view -> set login account ID (keeps distinct_id intact)
sdk.track('ProductView', { sku_id: 'sku_1', price: 149.75 });
sdk.login('user_10086');

// 3. Payment timing, fixed eventId same-day idempotency & 64-bit Snowflake order ID
sdk.timeEvent('OrderPaid');
sdk.track('CheckoutStarted', { entry_scene: 'cart_drawer' }, { eventId: 'evt_checkout_visitor_web_001' });
sdk.track('OrderPaid', {
  order_id: 9007199254740993n, // Automatically serialized as string "9007199254740993"
  amount: 299.5,
  items: ['sku_1', 2, true],
}, { eventId: 'evt_order_paid_2026_001' });

// 4. Distinct settlement milestone event & user profile enrichment
sdk.track('OrderSettled', { order_id: 9007199254740993n, amount: 279.5, status: 'settled' });
sdk.userSet({ vip_level: 'gold', city: 'Shanghai' });
sdk.userAdd({ loyalty_points: 300, total_orders: 1 });
await sdk.flush();
```

### 2.2 WeChat MiniProgram / uni-app / Taro (`createMiniProgramAdapter`)

MiniProgram environments do not provide `window.localStorage` or browser `fetch`. Use `createMiniProgramAdapter` from `@anylink/abi-web-sdk/adapters/miniapp` to bridge the native `wx` (or `uni` / `Taro`) object:

```ts
import { AbiWebSdk } from '@anylink/abi-web-sdk';
import { createMiniProgramAdapter } from '@anylink/abi-web-sdk/adapters/miniapp';

// Bridges wx.getStorageSync / setStorageSync, wx.request, and wx.getSystemInfoSync preset properties ($lib: 'abi-mp-sdk')
const mpAdapter = createMiniProgramAdapter(wx);

export const abiMp = new AbiWebSdk().init({
  serverUrl: 'https://ingest.abi.example.com', // Add this domain to the WeChat MiniProgram "request legal domain" allowlist
  projectId: 102,
  token: 'abi_proj_token_wx_miniapp',
  appVersion: '2.1.0',
  ...mpAdapter,
});

abiMp.track('$AppStart', { path: 'pages/home/index' });
abiMp.login('wx_openid_u_8801');
abiMp.track('ShareMiniProgram', { share_target: 'moments', campaign_id: 9007199254740999n });
```

### 2.3 React Native Mobile App (`createReactNativeAdapter`)

React Native provides global `fetch` out of the box. Use `createReactNativeAdapter` from `@anylink/abi-web-sdk/adapters/react-native` to inject mobile device information (`$lib: 'abi-rn-sdk'`, `$os`, `$os_version`, `$device_model`, screen dimensions) and synchronous persistent storage (such as an `AbiStorageAdapter` backed by `react-native-mmkv`):

```ts
import { AbiWebSdk, type AbiStorageAdapter } from '@anylink/abi-web-sdk';
import { createReactNativeAdapter } from '@anylink/abi-web-sdk/adapters/react-native';

// Example: Wrap MMKV as a synchronous storage adapter to persist visitor distinct_id, login_id, and offline queue
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

## 3. Running Tests & Build Verification

`test/abi-web-sdk.test.ts` includes golden test vector assertions (identity normalization, event/property naming rules, `BigInt` serialization, HTTP 503 offline idempotent retry) as well as end-to-end assertions for all 3 platform examples in `usage-examples.ts`. Run the following commands in `abi.sdk/ts-web`:

```bash
cd abi.sdk/ts-web

# Run Vitest unit tests and multi-platform integration assertions
pnpm test

# Compile TypeScript to generate dist/ ESM & type declarations (also loaded by interactive-demo.html)
pnpm run build
```
