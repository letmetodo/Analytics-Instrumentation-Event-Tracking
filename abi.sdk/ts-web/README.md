**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

# ABI Web / TypeScript / 微信小程序 / React Native SDK (`@anylink/abi-web-sdk`)

`@anylink/abi-web-sdk` 是面向 **Web / H5 单页应用（SPA）、微信小程序 / uni-app / Taro、React Native** 的跨平台用户行为分析（UBA）采集 SDK，完整对标 **ThinkingData（数数科技）JS SDK v3.4** 语义规范，并与 ABI 采集网关（`POST /collect/api/v1/track/batch`）、Flink 实时流处理及 StarRocks OLAP 模型深度协同。

---

## 一、核心能力概览

| 能力域 | 核心 API / 机制 | 特性说明 |
|--------|-----------------|----------|
| **双 ID 身份体系** | `identify(distinctId)`<br>`login(accountId)`<br>`logout()`<br>`getDistinctId()` / `getLoginId()` | 初始化时自动生成并持久化 UUIDv4 访客设备标识（`distinct_id` $\le 64$ UTF-8 字节）；调用 `identify()` 本地更新访客标识；调用 `login()` 本地设置已认证账号（`login_id` $\le 128$ UTF-8 字节），**保留 `distinct_id` 不变且不自动发送额外网络事件**；后续事件同时携带 `distinct_id` 与 `login_id`；`logout()` 清除 `login_id` 并保留 `distinct_id`。 |
| **静态与动态公共属性** | `setSuperProperties(props)`<br>`unsetSuperProperty(key)`<br>`clearSuperProperties()`<br>`getSuperProperties()`<br>`setDynamicSuperProperties(fn)` | 静态公共属性自动持久化至存储层；动态公共属性在每次 `track()` 时实时求值合并；属性优先级：**事件自定义属性 > 动态公共属性 > 静态公共属性 > 平台预置属性**（注：`$user_*` 画像事件不混入预置属性与公共属性）。 |
| **高精度事件计时** | `timeEvent(eventName)` $\rightarrow$ `$duration` | 基于单调时钟（`performance.now()`）记录事件耗时，后续调用同名 `track(eventName)` 时自动注入 `$duration`（单位：秒，保留 3 位小数）。 |
| **首次事件去重（当前版本未开放）** | `trackFirst(eventName, firstCheckId, props)` | （*当前版本未开放，受限于 D7① / G6 门禁*）调用将直接抛出 `Error` 且不入队伪造事件；同日网络重试幂等请通过标准 `track(..., { eventId })` 实现。 |
| **可更新 / 可重写事件（当前版本未开放）** | `trackUpdate(eventName, eventId, props)`<br>`trackOverwrite(eventName, eventId, props)` | （*当前版本未开放，受限于 D7① / G6 门禁*）调用将直接抛出 `Error` 且不入队伪造事件；业务状态流转请拆分为独立里程碑事件上报。 |
| **`BigInt` 与超大整数精度保护** | `normalizeProperties` 自动拦截 | 对原生 `BigInt`（如 `9007199254740993n`）及超出 IEEE-754 安全整数范围（`> 2^53 - 1` 或 `< -(2^53 - 1)`）的 64 位雪花 ID（含数组元素）自动无损序列化为十进制字符串，规避前端 `JSON.stringify` 精度丢失。 |
| **`#time` / `$time` 时间自动提取** | `properties['#time' \| '$time']` | 支持在事件或 `$user_*` 属性对象中传入 `Date` 实例、秒级/毫秒级时间戳或日期字符串（如 `'2026-11-10 12:30:00'`），SDK 自动将其解析为顶层 `timestamp`（毫秒）并从 `properties` 中剥离。 |
| **7 类 `$user_*` 用户画像操作** | `userSet` (`$user_set`)<br>`userSetOnce` (`$user_set_once`)<br>`userAdd` (`$user_add`)<br>`userUnset` (`$user_unset`)<br>`userAppend` (`$user_append`)<br>`userUniqAppend` (`$user_uniq_append`)<br>`userDelete` (`$user_del`) | 完整覆盖 StarRocks `abi.dim_users` 用户维度表的覆盖写入、首次初始化、数值原子累加、字段置空、数组追加、数组去重追加与画像删除。 |
| **SPA 全埋点与离线可靠投递** | `enableAutoTrack({ pageView, pageLeave, webClick })`<br>`navigator.sendBeacon` + 离线队列 | 自动监听 `pushState` / `replaceState` / `popstate` / `hashchange` 上报 `$pageview`；捕获 `<button>`、`<a>`、`<input>` 与 `[data-abi-track]` 元素上报 `$AppClick`；在 `visibilitychange` / `pagehide` 时统计页面停留时长上报 `$AppEnd` 并优先使用 `navigator.sendBeacon` 投递。遇断网、`429` 限流或 `5xx` 异常时保留原 `event_id` 持久化队列，支持幂等重试。 |

---

## 二、接入人员视角：哪些字段必填、哪些由 SDK 自动采集、哪些由服务端/网关补充（如 IP）

站在前端 / 小程序 / React Native 接入研发人员的视角，日常集成时可将所有埋点字段划分为以下三类：

### 1. 字段职责全景对照表

| 字段分类 | 阶段 / 字段名 | 是否需要前端手填 | 来源与处理机制 |
|----------|---------------|------------------|----------------|
| **第一类：接入人员【必须主动传入】的必填项** | **初始化 (`init`)**：`serverUrl`、`projectId` (`> 0`)、`token` | **必填** | 指定 `:8081` 采集网关地址、归属项目 ID 与非空项目密钥（`project_token`）。 |
| | **事件埋点 (`track`)**：`eventName` | **必填** | 业务事件名（如 `'OrderPaid'`），自定义业务属性通过 `properties` 按需传入。 |
| | **账号登录 (`login`)**：`accountId`（即 `login_id`） | **实名登录时必传** | 用户完成注册/登录时传入业务账号 ID，本地持久化 `login_id`（保留 `distinct_id` 不变，不发送额外网络事件），使后续所有上报事件同时携带访客 `distinct_id` 与账号 `login_id`。 |
| | **更新 / 重写事件 (`trackUpdate` / `trackOverwrite`)**：`eventId` | **当前版本未开放** | 受限于 D7① / G6 门禁，调用将抛出 `Error` 且不入队；同日重试幂等请通过 `track(..., { eventId })` 指定固定 `eventId`。 |
| **第二类：SDK【自动生成并持久化】，前端【无需手填】** | `distinct_id` | **无需手填** | 初始化时自动生成 UUIDv4 访客/设备标识并持久化至本地存储（`localStorage` / 小程序 Storage / RN Storage）；可通过 `identify()` 自定义覆盖，且在 `login()` / `logout()` 时保持不变。 |
| | `event_id` | **无需手填** | 每次 `track` 自动生成 UUIDv4，并在弱网/离线持久化队列重试时保持幂等不变。 |
| | `timestamp` | **无需手填** | 自动取客户端当前毫秒时间戳（除非在 `properties` 中通过 `#time` / `$time` 显式指定历史事件时间）。 |
| | 设备与环境预置属性：`$lib`、`$lib_version`、`$os`、`$os_version`、`$device_model`、`$screen_width`、`$screen_height`、`$url`、`$title`、`$referrer`、`$zone_offset` | **无需手填** | SDK 在初始化及每次上报时自动采集并注入（`$user_*` 画像事件自动隔离预置属性）。 |
| **第三类：客户端【拿不到也无需传】，由网关/服务端补充** | **公网 IP 与地域信息 (`#ip` / `$ip` $\rightarrow$ 国家/省/市)** | **客户端严禁手填** | 客户端直连 `:8081` 网关时，由网关自动从 HTTP 连接（及 `X-Forwarded-For` / `X-Real-IP`）提取真实公网 IP，交由 Flink 自动解析国家、省份、城市。 |

### 2. 三类字段详细说明与前后端打通最佳实践

1. **第一类：接入人员【必须主动传入】的必填项**
   - **初始化阶段 (`init`)**：必须传入 `serverUrl`（采集网关地址）、`projectId`（必须 `> 0`）、`token`（非空项目密钥）。
   - **埋点调用阶段 (`track`)**：必须传入 `eventName`（如 `'OrderPaid'`）。
   - **账号登录阶段 (`login`)**：当用户完成实名登录时必传 `accountId`（即 `login_id`），SDK 会在本地持久化 `login_id` 并保留 `distinct_id` 不变（不发送额外网络事件），后续所有事件同时携带 `distinct_id` 与 `login_id` 供后端实时归因。
   - **同日幂等重放（可选 `TrackOptions.eventId`）**：如需同日重放去重，可在 `track(eventName, props, { eventId })` 中显式指定固定 `eventId`（注：`trackFirst` / `trackUpdate` / `trackOverwrite` 当前版本未开放，调用将报错拦截）。
2. **第二类：SDK【自动生成并持久化】，前端/客户端开发【无需手填】的字段**
   - **`distinct_id`（访客/设备标识）**：初始化时自动生成 UUIDv4 并持久化至本地存储（`localStorage` / `SharedPreferences` / `UserDefaults`），可通过 `identify()` 自定义覆盖，且不会因 `login()` / `logout()` 被改写。
   - **`event_id`**：每次 `track` 自动生成 UUIDv4，且在弱网/离线重试时保持幂等不变。
   - **`timestamp`**：自动取客户端当前毫秒时间戳（除非通过 `#time` / `$time` 显式指定历史事件时间）。
   - **设备与环境预置属性**：`$lib`、`$lib_version`、`$os`、`$os_version`、`$device_model`、`$screen_width`、`$screen_height`、`$url`、`$title`、`$referrer`、`$zone_offset`。
3. **第三类：客户端【拿不到也无需传】，由采集网关/服务端负责获取的字段（重点：`IP` 与前后端打通）**
   - **公网 IP 与地域信息 (`#ip` / `$ip` $\rightarrow$ 国家/省/市)**：浏览器 JS、小程序与移动端 App 处于客户端沙箱及 NAT 路由后，**本身拿不到真实的公网出口 IP，因此客户端接入时绝对不需要传 `$ip` / `#ip`**！当客户端直连 `:8081` 采集网关时，网关会自动从 HTTP 连接（及 Nginx/SLB 的 `X-Forwarded-For` / `X-Real-IP`）提取真实客户端 IP 并由 Flink 自动解析国家、省份、城市。
   - **注意：何时需要传 IP？** 只有当业务采用「客户端先调业务后端 API，再由 Go/Java 服务端 SDK 代报埋点」时，因为网关看到的是后端机房 IP，才需要由业务后端从客户端请求中提取 IP 并通过 `#ip` / `$ip` 传给服务端 SDK。同时建议前端调用业务后端接口时在 Header 携带 `abi.getDistinctId()`（或移动端 `getDistinctId()`），方便服务端关联前后端漏斗：
     ```ts
     // 前端调用业务后端 API 时，建议在请求头透传访客标识 distinct_id，便于服务端 SDK 关联同一访客漏斗
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

## 三、两步式「配置参数预览 JSON -> 确认提交」与交互式演练场

在联调、埋点验收或可视化调试台场景中，SDK 提供 `buildPendingBatchPayload()` 与 `clearQueue()` 接口，支持 **「先组装事件并实时预览完整请求 JSON，核对无误后再调用 `flush()` 确认提交」** 的两步式工作流：

```ts
import { AbiWebSdk } from '@anylink/abi-web-sdk';

const sdk = new AbiWebSdk().init({
  serverUrl: 'http://localhost:8081',
  projectId: 1,
  token: 'abi_proj_token_demo',
  flushIntervalMs: 600_000, // 延长自动刷新间隔，交由人工确认提交
  dryRun: true,             // 可选：开启网关 Dry-Run 仅校验 Schema 与鉴权，不落库
});

// 第一步：配置身份、公共属性并入队待测事件（可随时调用 sdk.clearQueue() 重建预览）
sdk.identify('visitor_preview_001');
sdk.setSuperProperties({ channel: 'organic_search' });
sdk.track('OrderPaid', {
  order_id: 9007199254740993n,
  amount: 299.5,
  '#time': '2026-11-10T08:00:00.000Z',
});

// 实时获取即将发送至 POST /collect/api/v1/track/batch 的完整 JSON 报文（不消耗队列）
const previewPayload = sdk.buildPendingBatchPayload();
console.log('待提交请求 JSON 预览:', JSON.stringify(previewPayload, null, 2));

// 第二步：人工或自动化断言确认参数无误后，正式发起网络上报
const ok = await sdk.flush();
console.log('上报结果:', ok);
```

### 浏览器交互式演练场

仓库内置零依赖可视化演练场 [`examples/interactive-demo.html`](examples/interactive-demo.html)（详细说明见 [`examples/README.md`](examples/README.md)）：

1. 编译产物并启动静态服务：
   ```bash
   cd abi.sdk/ts-web
   pnpm run build
   python3 -m http.server 8090
   ```
2. 浏览器访问 `http://localhost:8090/examples/interactive-demo.html`（也支持直接双击打开离线兜底模式）。
3. 左侧调整身份、静态/动态公共属性及 24 个核心事件触发器，右侧实时预览唯一待提交请求 JSON，切换 `mock` / `dry_run` / `live` 三种模式并点击 **「确认提交」** 验证。

---

## 四、三端快速接入示例

完整可运行代码参见 [`examples/usage-examples.ts`](examples/usage-examples.ts)。

### 1. Web SPA 单页应用接入

```ts
import { AbiWebSdk } from '@anylink/abi-web-sdk';

export const abi = new AbiWebSdk().init({
  serverUrl: 'https://ingest.abi.example.com',
  projectId: 101,
  token: 'abi_proj_token_web_ecommerce',
  appVersion: '3.4.0',
  autoTrack: {
    pageView: true,  // 自动监听 History / Hash 路由切换上报 $pageview
    pageLeave: true, // 页面隐藏/卸载时自动统计停留时长上报 $AppEnd (sendBeacon)
    webClick: true,  // 自动采集 button / a / input / [data-abi-track] 点击上报 $AppClick
  },
});

// 1. 访客标识与公共属性
abi.identify('visitor_web_001');
abi.setSuperProperties({ channel: 'seo_landing', ab_group: 'checkout_v2' });
abi.setDynamicSuperProperties(() => ({ cart_items: 2 }));

// 2. 设置登录账号 ID (login_id，保留 distinct_id 不变，不发送额外网络事件)
abi.login('user_10086');

// 3. 事件计时、固定 eventId 同日幂等、64 位雪花 ID 与独立履约里程碑事件
abi.timeEvent('OrderPaid');
abi.track('CheckoutStarted', { coupon: 'WELCOME_ABI' }, { eventId: 'evt_checkout_001' });

abi.track('OrderPaid', {
  order_id: 9007199254740993n, // > 2^53 - 1 自动无损序列化为字符串 "9007199254740993"
  amount: 299.5,
  items: ['sku_1', 2, true],
}, { eventId: 'evt_order_paid_001' });

abi.track('OrderSettled', { order_id: 9007199254740993n, amount: 279.5, status: 'settled' });

// 4. 用户画像操作 ($user_*)
abi.userSet({ vip_level: 'gold', city: 'Shanghai' });
abi.userSetOnce({ first_order_date: '2026-11-10' });
abi.userAdd({ loyalty_points: 300, total_orders: 1 });
abi.userUniqAppend({ badges: ['early_adopter', 'vip_2026'] });
await abi.flush();
```

### 2. 微信小程序 / uni-app / Taro 接入（`createMiniProgramAdapter`）

通过 `@anylink/abi-web-sdk/adapters/miniapp` 一键桥接小程序同步存储（`wx.getStorageSync` / `setStorageSync`）、网络请求（`wx.request`）与系统信息预置属性（`$lib: 'abi-mp-sdk'`、`$os`、`$os_version`、`$device_model`、屏幕宽高）：

```ts
import { AbiWebSdk } from '@anylink/abi-web-sdk';
import { createMiniProgramAdapter } from '@anylink/abi-web-sdk/adapters/miniapp';

const mpAdapter = createMiniProgramAdapter(wx); // uni-app 传入 uni，Taro 传入 Taro

export const abiMp = new AbiWebSdk().init({
  serverUrl: 'https://ingest.abi.example.com', // 需加入微信小程序后台 request 合法域名白名单
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

### 3. React Native 移动应用接入（`createReactNativeAdapter`）

通过 `@anylink/abi-web-sdk/adapters/react-native` 注入移动端系统预置属性（`$lib: 'abi-rn-sdk'`、`$os`、`$os_version`、`$device_model`、`$screen_width`、`$screen_height`）及自定义同步持久化存储（如 `react-native-mmkv`）：

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

## 五、构建与测试命令

在 `abi.sdk/ts-web` 目录下执行以下命令运行单元测试（含跨语言契约黄金向量校验、离线幂等重试与三端示例集成测试）并编译 ESM 与 `.d.ts` 类型声明产物：

```bash
cd abi.sdk/ts-web
pnpm test && pnpm run build
```
