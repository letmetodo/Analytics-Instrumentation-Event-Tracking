# ABI Node.js 服务端 SDK (`@anylink/abi-node-sdk`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`@anylink/abi-node-sdk` 是 **ABI 企业级用户行为分析（UBA）与 BI 平台** 的官方 Node.js 服务端数据采集 SDK，API 与语义完整对标 **数数科技 ThinkingData Node.js Server SDK v3.4**。SDK 采用 **100% 纯 Node.js 标准库**（`node:http` / `node:https` / `node:zlib` / `node:fs` / `node:crypto`）构建，**零第三方运行时依赖**，专为服务端无状态多用户并发场景设计。

---

## 1. 核心特性与四大 Consumer 架构

### 核心特性
- **零第三方依赖**：仅使用 Node.js 18+ 原生内置模块，无任何外部 npm 依赖，彻底杜绝供应链风险与版本冲突。
- **服务端无状态多用户设计（区别于浏览器单用户 `ts-web`）**：`AbiNodeAnalytics` 不在内存中绑定单个用户状态，每次调用显式传入当前请求用户的实名账号 `loginId` 与/或访客/设备 `distinctId`，天然支持单进程承接成千上万并发用户请求。
- **ThinkingData 对齐双 ID 自动身份关联**：网络报文 `events[]` 仅包含 `distinct_id`（访客/设备 ID，<= 64 UTF-8 字节）与 `login_id`（实名账号 ID，<= 128 UTF-8 字节），两者至少一个非空，且当 `distinctId` 为空时直接发送 `"distinct_id": ""`，绝不把 `loginId` 复制回填到 `distinct_id`。只要任意 `track*` 或 `user*` 事件同时携带非空 `login_id` 与 `distinct_id`，Flink ETL 即自动完成全链路 ID-Mapping。
- **前置强契约校验**：本地执行事件名与属性键正则校验（`^[A-Za-z_][A-Za-z0-9_]*$` 及开放系统预置白名单）、控制字符拦截与 UTF-8 字节长度校验（`distinct_id` / `event_id` <= 64 字节，`login_id` <= 128 字节）。
- **`BigInt` 与 `> 2^53 - 1` 64 位大整数精度保护**：对原生 `BigInt`（如 `9007199254740999n`）及超过 IEEE-754 双精度安全整数范围（`> 9007199254740991` 或 `< -9007199254740991`）的雪花 ID（含数组元素）自动无损转为十进制字符串。
- **静态与动态公共属性分层合并与画像隔离**：严格遵循 `静态公共属性 < 动态公共属性 < 单次事件属性` 覆盖优先级，并在 `$user_*` / `#user_*` 7 类用户画像操作中自动隔离公共属性。
- **`#time` / `$time` 时间提取与 `#ip` / `$ip` 透传**：支持在 `properties` 中传入 `#time` / `$time`（自动解析为顶层毫秒级 `timestamp` 并从 `properties` 中剥离），以及透传 `#ip` / `$ip` 供采集网关与 Flink Job1 执行 GeoIP 国家/省/市地域解析。

### 四大 Consumer 架构

| Consumer 类型 | 类名 | 适用场景与核心方法 |
| :--- | :--- | :--- |
| **`StagingConsumer`** | `StagingConsumer` | **两步式预览请求 JSON 与确认提交**：在内存中暂存事件，先通过 `previewRequestJson()` / `buildRequestPayload()` 预览发往 `POST /collect/api/v1/track/batch` 的唯一一份完整 JSON（零网络副作用），可随时 `clear()` 重建，确认无误后通过 `confirmSubmit(targetConsumer)` 或 `submitToGateway(config)` 正式提交。 |
| **`BatchConsumer`** | `BatchConsumer` | **生产高吞吐异步批量上报**：支持内存队列按条数（`batchSize`，默认 50，最大 500）与时间间隔（`flushIntervalMs`，默认 3000ms）双触发刷盘、基于 `zlib.gzipSync` 的 `Content-Encoding: gzip` 压缩传输，以及针对 `429` / `5xx` 的指数退避幂等重试（保留原 `event_id`）。 |
| **`LoggerConsumer`** | `LoggerConsumer` | **本地 `.jsonl` 轮转落盘**：将事件按行序列化为 `.jsonl`（JSON Lines）写入本地磁盘，支持按天（`RotateMode.DAILY`）、按小时（`RotateMode.HOURLY`）及单文件体积上限自动切分，配合 Filebeat / Vector / LogBus 旁路采集。 |
| **`DebugConsumer`** | `DebugConsumer` | **研发期同步 L4 强校验与 `dryRun`**：逐条同步发送事件并固定携带 `debug: true`（可选 `dryRun: true` 仅校验不落库 Kafka / StarRocks），若触发网关契约错误则立即抛出详细 `reason`。 |

---

## 2. 安装与环境要求

- **Node.js 版本**：Node.js `>= 18.0.0`
- **运行时依赖**：零外部依赖

```bash
# 在项目中使用
pnpm add @anylink/abi-node-sdk
```

---

## 3. 服务端接入必填字段与客户端透传指南（Express / Fastify / Koa 提取 `#ip`、`X-ABI-Distinct-Id` 透传、异步 `#time`、幂等 `event_id`）

### 3.1 为什么 Node.js 服务端 SDK 与浏览器 Web SDK (`@anylink/abi-web-sdk`) 必填项不同？

- **前端 / 移动端 SDK**：运行在单用户终端设备上，SDK 会自动生成并持久化访客 `distinct_id`（调用客户端 `login(accountId)` 仅更新本地 `login_id` 状态而不额外发请求），且客户端直连采集网关 `:8081` 时网关可直接从 TCP 连接 / SLB 读取用户真实公网 IP。
- **Node.js 服务端 SDK**：是运行在**后端机房或云容器内的无状态多用户共享单例**。当 Node.js 后端请求 `:8081` 采集网关时，网关看到的是**后端服务器内网/机房出口 IP**（使用 `LoggerConsumer` 写本地 `.jsonl` 文件时更无客户端连接）。因此，**用户身份、客户端真实公网 IP（`#ip`）、前后端串联访客 ID（`X-ABI-Distinct-Id`）、异步事件真实发生时间（`#time`）以及业务幂等键（`event_id`）** 必须由后端从当前 HTTP 请求上下文或消息队列（MQ）消息体中显式提取并传入。

### 3.2 服务端接入字段必填性与来源速查表

| 字段分类 | SDK 参数 / `properties` 键 | 必填级别 | 来源与最佳实践说明 |
| :--- | :--- | :--- | :--- |
| **用户身份**<br>(`loginId` / `distinctId`) | `track({ loginId, distinctId })`<br>或 `track(loginId, distinctId, ...)` | **【每次调用必填】** | `loginId`（<= 128B）与 `distinctId`（<= 64B）至少传入一个非空标识（否则抛出 `missing_identity`）。前端请求业务后端 API 时应通过请求头 `X-ABI-Distinct-Id` 透传访客 ID，后端同时传入 `loginId` 与 `distinctId`，Flink 即自动打通前后端转化漏斗。 |
| **客户端真实公网 IP**<br>(`#ip` / `$ip`) | `properties['#ip']`<br>（或 `properties['$ip']`） | **【地域分析必传】** | **若不传 `#ip`，所有服务端埋点的国家/省份/城市都会变成后端服务器机房所在地！** 必须从 `X-Forwarded-For` 首跳公网 IP 或 `X-Real-IP` 提取并传入 `properties['#ip']`。 |
| **实际业务发生时间**<br>(`#time` / `$time` / `timestamp`) | `properties['#time']`<br>或顶层 `timestamp` | **【实时可省，MQ / 回调 / 补数必传】** | 在 Kafka / RabbitMQ / BullMQ 异步消费、支付回调或离线补数场景下，处理时间晚于实际发生时间，必须传入业务真实发生时间（`Date`、毫秒/秒时间戳或 ISO 字符串），SDK 会自动提取为顶层毫秒级 `timestamp` 并从 `properties` 中剥离。 |
| **幂等事件 ID**<br>(`eventId` / `event_id`) | `track({ eventId })`<br>或 `options.eventId` | **【MQ 重试与核心交易强烈推荐】** | 在 MQ 消费重试、Webhook 重放场景下，传入确定性业务主键（如 `` `ord_paid_${orderNo}` ``，<= 64 字节），利用 StarRocks 主键模型天然幂等去重，防止金额/次数重复统计。 |

### 3.3 Express / Fastify / Koa 提取 `#ip`、`X-ABI-Distinct-Id`、异步 `#time` 与幂等 `event_id` 实战代码

```js
import { AbiNodeAnalytics, BatchConsumer } from '@anylink/abi-node-sdk';

// 1. 初始化全局单例 BatchConsumer 与 AbiNodeAnalytics
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
 * 通用工具函数：从 Express / Fastify / Koa 请求头安全提取客户端真实公网 IP 与前端透传的 X-ABI-Distinct-Id
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

// ============================================================================
// 示例 A：Express 路由中提取 #ip、X-ABI-Distinct-Id 与幂等 eventId 上报订单支付
// ============================================================================
export function registerExpressCheckoutRoute(app) {
  app.post('/api/v1/orders/pay', async (req, res) => {
    const { clientIp, distinctId } = extractClientContext(req.headers, req.ip);
    const loginId = req.user?.id || 'acct_900102';
    const { orderNo, snowflakeOrderId, amount, occurredAt } = req.body;

    abi.track({
      loginId,
      distinctId, // 串联前端 Web/App 透传的 X-ABI-Distinct-Id，Flink 自动完成双 ID 身份关联
      eventId: `ord_paid_${orderNo}`, // 确定性业务幂等键，防止网络重试或消息重放重复统计
      eventName: 'OrderPaid',
      properties: {
        '#ip': clientIp, // 透传真实客户端公网 IP，确保国家/省/市地域解析准确
        '#time': occurredAt || new Date(), // 自动提取为顶层毫秒级 timestamp 并从 properties 剥离
        order_no: orderNo,
        order_id: BigInt(snowflakeOrderId), // BigInt 自动转为字符串，防止 > 2^53-1 精度丢失
        amount,
      },
    });

    res.json({ code: 200, message: 'ok' });
  });
}

// ============================================================================
// 示例 B：Fastify 路由中提取 #ip 与 X-ABI-Distinct-Id
// ============================================================================
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

// ============================================================================
// 示例 C：Koa 中间件 / 路由中提取 #ip 与 X-ABI-Distinct-Id
// ============================================================================
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

## 4. 快速开始与核心 API 示例

### 4.1 两步式预览请求 JSON 与确认提交（`StagingConsumer`）

```js
import { AbiNodeAnalytics, BatchConsumer, StagingConsumer } from '@anylink/abi-node-sdk';

// 第 1 步：创建 StagingConsumer，在内存中录制事件并预览完整请求 JSON（零网络请求）
const staging = new StagingConsumer({
  projectId: 1,
  projectToken: 'abi_tok_demo_node',
  dryRun: false,
});
const sdk = new AbiNodeAnalytics(staging);

sdk.setSuperProperties({
  $platform: 'NodeServer',
  service_name: 'order-service',
});

sdk.track({
  loginId: 'acct_900102',
  distinctId: 'vis_dev_7f8e9a01',
  eventId: 'ord_paid_ORD-20261110-8801',
  eventName: 'OrderPaid',
  properties: {
    '#ip': '203.0.113.42',
    '#time': '2026-11-10T10:00:00.000Z',
    order_id: 9007199254740999n, // BigInt 自动序列化为字符串 "9007199254740999"
    amount: 2549.15,
  },
});

console.log('=== 待提交请求 JSON 预览 ===');
console.log(staging.previewRequestJson());

// 第 2 步：确认无误后通过 confirmSubmit 投递给目标 Consumer（或直接调用 staging.submitToGateway）
const batchConsumer = new BatchConsumer({
  serverUrl: 'http://127.0.0.1:8081',
  projectId: 1,
  projectToken: 'abi_tok_demo_node',
  compressGzip: true,
});
const envelope = await staging.confirmSubmit(batchConsumer);
await batchConsumer.close();
console.log('=== 提交响应结果 ===', envelope);
```

### 4.2 全功能 API 速览（特殊事件与 7 类用户画像操作）

```js
// 1. 公共属性管理
sdk.setSuperProperties({ $platform: 'NodeServer', env: 'prod', temp_flag: '1' });
sdk.unsetSuperProperty('temp_flag');
const currentSuper = sdk.getSuperProperties();
sdk.setDynamicSuperProperties(() => ({
  memory_rss_mb: Math.round(process.memoryUsage().rss / 1024 / 1024),
}));

// 2. 登录事件（同时传入 loginId 与 distinctId 即自动完成 Flink ID-Mapping 身份关联）
sdk.track('acct_900102', 'vis_dev_7f8e9a01', '$login', { login_method: 'sso_oidc' });

// 3. 确定性 eventId 幂等事件（注：按 D7① / G6 门禁，trackFirst/trackUpdate/trackOverwrite 当前版本未开放，调用将抛出 Error 且不入队）
sdk.track({
  loginId: 'acct_900102',
  distinctId: 'vis_dev_7f8e9a01',
  eventId: 'ord_paid_001',
  eventName: 'OrderPaid',
  properties: { order_status: 'PAID', amount: 2549.15 },
});

// 4. 全部 7 类用户画像操作（自动与公共属性隔离）
sdk.userSet('acct_900102', 'vis_dev_7f8e9a01', { plan_tier: 'Enterprise', seat_count: 50 });
sdk.userSetOnce('acct_900102', 'vis_dev_7f8e9a01', { first_utm_source: 'github' });
sdk.userAdd('acct_900102', 'vis_dev_7f8e9a01', { cumulative_payment: 2549.15, order_count: 1 });
sdk.userAppend('acct_900102', 'vis_dev_7f8e9a01', { modules: ['event', 'funnel'] });
sdk.userUniqAppend('acct_900102', 'vis_dev_7f8e9a01', { modules: ['funnel', 'retention'] });
sdk.userUnset('acct_900102', 'vis_dev_7f8e9a01', 'trial_tag', 'legacy_flag');
sdk.userDelete('acct_gdpr_erased_01', 'vis_gdpr_erased_01');
```

---

## 5. 验证与 CLI 演示命令

```bash
# 运行全部单元测试（含黄金测试向量、四大 Consumer 与并发重试验证）
node --test /Users/zhongjie/data/anylink/abi/abi.sdk/nodejs/test/abi-node-sdk.test.mjs

# 运行两步式 CLI Demo（第 1 步预览请求 JSON，第 2 步自动确认提交并输出响应 JSON）
node /Users/zhongjie/data/anylink/abi/abi.sdk/nodejs/examples/demo.mjs --yes
```
