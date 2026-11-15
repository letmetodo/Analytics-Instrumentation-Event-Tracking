# ABI Node.js Server SDK (`@anylink/abi-node-sdk`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`@anylink/abi-node-sdk` is the official Node.js server-side data collection SDK for the **ABI Enterprise User Behavior Analytics (UBA) & BI Platform**, designed to align with **ThinkingData Node.js Server SDK v3.4**. Built entirely on the **Node.js standard library** (`node:http`, `node:https`, `node:zlib`, `node:fs`, `node:crypto`) with **zero external runtime dependencies**, it is engineered for stateless, high-concurrency multi-user server environments.

---

## 1. Key Features & Four-Consumer Architecture

### Key Features
- **Zero External Runtime Dependencies**: 100% pure Node.js 18+ built-in modules.
- **Stateless Multi-User Server Architecture**: Unlike the single-user browser SDK (`@anylink/abi-web-sdk`), `AbiNodeAnalytics` does not bind per-user session state in memory. Every call explicitly accepts `loginId` (account ID) and/or `distinctId` (visitor/device ID).
- **ThinkingData-Aligned Dual-ID Automatic Identity Stitching**: Wire payloads carry strictly two identity fields—`distinct_id` (<= 64 UTF-8 bytes) and `login_id` (<= 128 UTF-8 bytes), requiring at least one non-empty and never copying `login_id` into `distinct_id` when `distinct_id` is empty. Whenever any `track*` or `user*` event carries both `login_id` and `distinct_id`, Flink ETL automatically stitches them.
- **Strict Client-Side Contract Validation**: Validates event names and property keys against `^[A-Za-z_][A-Za-z0-9_]*$` and the system whitelist, rejects ASCII control characters, and enforces UTF-8 byte limits (`distinct_id` / `event_id` <= 64 bytes, `login_id` <= 128 bytes).
- **`BigInt` & `> 2^53 - 1` 64-Bit Integer Precision Protection**: Automatically converts native `BigInt` values and integers outside the IEEE-754 safe integer range (`> 9007199254740991` or `< -9007199254740991`, including array elements) into decimal strings.
- **Static & Dynamic Super Properties with Profile Isolation**: Merges properties with `Static Super Properties < Dynamic Super Properties < Event Properties` precedence and automatically isolates super properties from `$user_*` / `#user_*` profile operations.
- **`#time` / `$time` Extraction & `#ip` / `$ip` Passthrough**: Automatically extracts `properties['#time']` or `properties['$time']` into the top-level millisecond `timestamp` and strips the key from `properties`, while forwarding `#ip` / `$ip` for server-side GeoIP resolution.

### Four-Consumer Architecture

| Consumer | Class | Purpose & Core Methods |
| :--- | :--- | :--- |
| **`StagingConsumer`** | `StagingConsumer` | **Two-Step JSON Preview & Confirmed Submission**: Stages events in memory so you can inspect the exact `POST /collect/api/v1/track/batch` payload via `previewRequestJson()` / `buildRequestPayload()`, reset via `clear()`, and submit via `confirmSubmit(targetConsumer)` or `submitToGateway(config)`. |
| **`BatchConsumer`** | `BatchConsumer` | **High-Throughput Production Batch Ingestion**: Flushes by batch count (`batchSize`, default 50, max 500) or interval (`flushIntervalMs`, default 3000ms), supports `zlib.gzipSync` compression (`compressGzip: true`), and performs exponential backoff retries on `429` / `5xx` while preserving original `event_id` values. |
| **`LoggerConsumer`** | `LoggerConsumer` | **Local `.jsonl` File Rotation**: Writes events as newline-delimited JSON (`.jsonl`) files rotated daily (`RotateMode.DAILY`), hourly (`RotateMode.HOURLY`), or by file size for Filebeat / Vector / LogBus collection. |
| **`DebugConsumer`** | `DebugConsumer` | **Synchronous Development L4 Validation**: Sends events immediately with `debug: true` (and optional `dryRun: true`) and throws detailed gateway validation errors when `rejected > 0`. |

---

## 2. Server Integration Required Fields & Client Passthrough Guide (`#ip` Extraction in Express / Fastify / Koa, `X-ABI-Distinct-Id` Passthrough, Async `#time`, Idempotent `event_id`)

### 2.1 Why Server SDK Required Fields Differ from Browser/Mobile SDKs

When a Node.js backend service sends events to the ABI Ingest Gateway (`:8081`), the gateway's TCP connection sees the **backend server's data-center IP** rather than the end user's device IP (and `LoggerConsumer` writes to local disk with no network connection at all). Furthermore, a backend process serves thousands of concurrent users simultaneously. Therefore, **user identity, client public IP (`#ip`), visitor `distinct_id` (`X-ABI-Distinct-Id`), actual business occurrence time (`#time`), and idempotent `event_id`** must be explicitly passed from the request context or message queue payload.

### 2.2 Express / Fastify / Koa Integration Example

```js
import { AbiNodeAnalytics, BatchConsumer } from '@anylink/abi-node-sdk';

const batchConsumer = new BatchConsumer({
  serverUrl: process.env.ABI_GATEWAY_URL || 'http://127.0.0.1:8081',
  projectId: 1,
  projectToken: process.env.ABI_PROJECT_TOKEN || 'abi_tok_prod_node',
  compressGzip: true,
});
export const abi = new AbiNodeAnalytics(batchConsumer);
abi.setSuperProperties({
  $platform: 'NodeServer',
  service_name: 'order-api',
});

/**
 * Extract real client public IP (#ip) and X-ABI-Distinct-Id from Express / Fastify / Koa headers
 */
export function extractClientContext(headers = {}, fallbackIp = '') {
  const xff = headers['x-forwarded-for'];
  const rawXff = Array.isArray(xff) ? xff[0] : xff;
  const clientIp =
    (typeof rawXff === 'string' && rawXff.split(',')[0].trim()) ||
    (typeof headers['x-real-ip'] === 'string' && headers['x-real-ip'].trim()) ||
    fallbackIp ||
    '';

  const rawDistinct = headers['x-abi-distinct-id'];
  const distinctId =
    (Array.isArray(rawDistinct) ? rawDistinct[0] : rawDistinct)?.trim() || '';

  return { clientIp, distinctId };
}

// Express Route Example
export function registerExpressCheckoutRoute(app) {
  app.post('/api/v1/orders/pay', async (req, res) => {
    const { clientIp, distinctId } = extractClientContext(req.headers, req.ip);
    const { orderNo, snowflakeOrderId, amount, occurredAt } = req.body;

    abi.track({
      loginId: req.user?.id || 'acct_900102',
      distinctId, // Connects frontend visitor funnel via X-ABI-Distinct-Id (stitched automatically in Flink)
      eventId: `ord_paid_${orderNo}`, // Deterministic idempotent event_id for StarRocks deduplication
      eventName: 'OrderPaid',
      properties: {
        '#ip': clientIp, // Real client public IP for accurate GeoIP country/province/city
        '#time': occurredAt || new Date(), // Extracted to top-level ms timestamp and stripped from properties
        order_no: orderNo,
        order_id: BigInt(snowflakeOrderId), // > 2^53 - 1 serialized as string
        amount,
      },
    });

    res.json({ code: 200, message: 'ok' });
  });
}

// Fastify Route Example
export function registerFastifyCheckoutRoute(fastify) {
  fastify.post('/api/v1/orders/pay', async (request, reply) => {
    const { clientIp, distinctId } = extractClientContext(request.headers, request.ip);
    abi.track({
      loginId: request.user?.id || 'acct_900102',
      distinctId,
      eventId: `ord_paid_${request.body.orderNo}`,
      eventName: 'OrderPaid',
      properties: {
        '#ip': clientIp,
        '#time': request.body.occurredAt || Date.now(),
        order_no: request.body.orderNo,
        amount: request.body.amount,
      },
    });
    return reply.send({ code: 200, message: 'ok' });
  });
}

// Koa Route Example
export async function koaCheckoutHandler(ctx) {
  const { clientIp, distinctId } = extractClientContext(ctx.request.headers, ctx.request.ip);
  abi.track({
    loginId: ctx.state.user?.id || 'acct_900102',
    distinctId,
    eventId: `ord_paid_${ctx.request.body.orderNo}`,
    eventName: 'OrderPaid',
    properties: {
      '#ip': clientIp,
      '#time': ctx.request.body.occurredAt || new Date(),
      order_no: ctx.request.body.orderNo,
      amount: ctx.request.body.amount,
    },
  });
  ctx.body = { code: 200, message: 'ok' };
}
```

---

## 3. Quick Start & Complete API Examples

```js
import { AbiNodeAnalytics, BatchConsumer, StagingConsumer } from '@anylink/abi-node-sdk';

// Step 1: Preview the exact batch request JSON with StagingConsumer (zero network calls)
const staging = new StagingConsumer({
  projectId: 1,
  projectToken: 'abi_tok_demo_node',
  dryRun: false,
});
const sdk = new AbiNodeAnalytics(staging);

sdk.setSuperProperties({ $platform: 'NodeServer', service_name: 'order-service' });
sdk.setDynamicSuperProperties(() => ({ server_region: 'ap-shanghai' }));

sdk.track('acct_900102', 'vis_dev_7f8e9a01', '$login', { login_method: 'sso_oidc' });
// Note: per D7① / G6 gate, trackFirst, trackUpdate, and trackOverwrite are unsupported in current version and throw Error without enqueueing.
sdk.track({
  loginId: 'acct_900102',
  distinctId: 'vis_dev_7f8e9a01',
  eventId: 'ord_evt_001',
  eventName: 'OrderPaid',
  properties: {
    '#ip': '203.0.113.42',
    '#time': '2026-11-10T10:00:00.000Z',
    order_id: 9007199254740999n,
    order_status: 'PAID',
  },
});

// 7 User Profile Operations (isolated from super properties)
sdk.userSet('acct_900102', 'vis_dev_7f8e9a01', { plan_tier: 'Enterprise' });
sdk.userSetOnce('acct_900102', 'vis_dev_7f8e9a01', { first_utm_source: 'github' });
sdk.userAdd('acct_900102', 'vis_dev_7f8e9a01', { order_count: 1, total_spent: 2549.15 });
sdk.userAppend('acct_900102', 'vis_dev_7f8e9a01', { modules: ['event', 'funnel'] });
sdk.userUniqAppend('acct_900102', 'vis_dev_7f8e9a01', { modules: ['funnel', 'retention'] });
sdk.userUnset('acct_900102', 'vis_dev_7f8e9a01', 'legacy_tag');
sdk.userDelete('acct_gdpr_erased_01', 'vis_gdpr_erased_01');

console.log(staging.previewRequestJson());

// Step 2: Confirm submission to target consumer or gateway
const batchConsumer = new BatchConsumer({
  serverUrl: 'http://127.0.0.1:8081',
  projectId: 1,
  projectToken: 'abi_tok_demo_node',
  compressGzip: true,
});
await staging.confirmSubmit(batchConsumer);
await batchConsumer.close();
```

---

## 4. Verification & CLI Demo Commands

```bash
# Run unit & golden vector contract tests
node --test /Users/zhongjie/data/anylink/abi/abi.sdk/nodejs/test/abi-node-sdk.test.mjs

# Run two-step CLI Demo (Step 1 previews request JSON, Step 2 submits and prints response JSON)
node /Users/zhongjie/data/anylink/abi/abi.sdk/nodejs/examples/demo.mjs --yes
```
