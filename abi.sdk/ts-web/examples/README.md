**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

# ABI TypeScript SDK 交互式演练场与多端接入示例

本目录提供 `@anylink/abi-web-sdk`（面向 **Web / H5 / 微信小程序 / uni-app / Taro / React Native** 的跨平台埋点 SDK，兼容 ThinkingData v3.4 语义）的可视化联调演练场与端到端可运行接入示例：

| 文件 | 说明 |
|------|------|
| [`interactive-demo.html`](./interactive-demo.html) | 浏览器零依赖交互式演练场，内置配置栏、实时状态看板、5 大核心能力分组触发器及实时 JSON 报文监控面板 |
| [`usage-examples.ts`](./usage-examples.ts) | Web SPA 电商全链路、微信小程序（`createMiniProgramAdapter`）、React Native（`createReactNativeAdapter`）三大场景的可运行 TypeScript 示例 |

---

## 一、浏览器交互式演练场（`interactive-demo.html`）

### 1. 打开与联调方式

#### 方式 A：构建后通过本地 HTTP 服务打开（推荐，加载真实编译产物）

1. 在 `abi.sdk/ts-web` 目录下编译 SDK 产物 `dist/index.js`：
   ```bash
   cd abi.sdk/ts-web
   pnpm run build
   ```
2. 在 `abi.sdk/ts-web` 目录启动任意静态文件服务（以 Python 内置 HTTP 服务为例）：
   ```bash
   cd abi.sdk/ts-web
   python3 -m http.server 8090
   ```
3. 使用浏览器访问 `http://localhost:8090/examples/interactive-demo.html`。页面顶部标题右侧徽标将显示 **`已加载 ../dist/index.js`**，代表当前正在运行真实 SDK 编译产物。

#### 方式 B：直接双击打开（零构建离线快速体验）

如果尚未执行构建或仅通过 `file://` 协议直接打开 `examples/interactive-demo.html`（浏览器限制 `file://` 下的 ES Module 跨目录导入），页面会自动启用内置的轻量兜底实现（徽标提示 **`内置兜底 SDK（执行 pnpm run build 可加载 dist/index.js）`**），无需任何后端或本地服务即可预览报文结构。

#### 联调真实 ABI 采集网关（`:8081`）

如需将演练场事件发送至本地或测试环境的 ABI SDK 采集网关（`POST /collect/api/v1/track/batch`）：

1. 启动后端采集网关：
   ```bash
   cd abi.srv
   ENV=dev go run ./cmd/gateway/
   ```
2. 在演练场顶部配置栏填写：
   - **采集网关地址 (`Server URL`)**：`http://localhost:8081`
   - **项目 ID (`Project ID`)**：目标项目的数字 ID（如 `1`）
   - **项目上报密钥 (`Project Token`)**：后台「项目管理」中签发的 `project_token`
   - **上报发送模式 (`Send Mode`)**：选择 **真实网关 Dry-Run 仅校验** 或 **真实网关正式上报**
3. 点击 **「初始化 / 重新初始化 SDK」** 按钮使新配置生效。

---

### 2. 顶部 3 种发送模式说明

演练场顶部 **「上报发送模式 (`Send Mode`)」** 下拉框支持以下 3 种联调级别：

| 发送模式 | 请求行为与 `dry_run` 标记 | 适用场景 |
|----------|---------------------------|----------|
| **本地 Mock 报文监控（无需启动后端）** (`mock`) | 不发起真实网络请求，由演练场拦截传输层并在本地返回模拟 `200 OK`，完整批次 JSON 实时输出到右侧监控面板 | 前端离线开发、核对字段命名、双 ID 变化及 `BigInt` 序列化格式 |
| **真实网关 Dry-Run 仅校验（不落库）** (`dry_run`) | 向采集网关 `POST /collect/api/v1/track/batch` 发送真实 HTTP 请求，并在顶层报文附加 `"dry_run": true`；网关执行完整的 Token 鉴权、字段规范与 Schema 校验，但**不写入 Kafka 与 StarRocks** | 提测与上线前联调网关连通性、排查鉴权失败或属性类型不合法问题，避免污染生产/测试库 |
| **真实网关正式上报（写入 Kafka/StarRocks）** (`live`) | 向采集网关正式发送上报批次，数据经 Kafka 流入 Flink Job1 ETL / Job2 ODS，落库至 StarRocks（`dwd_events`、`dim_users`、`identity_map`、`ods_events_raw`） | 端到端全链路数据验收、BI 报表查询核对与用户分群/画像实时验证 |

---

### 3. 实时状态看板与「配置预览 -> 确认提交」交互说明

演练场采用 **「左侧配置参数、右侧实时预览唯一请求 JSON、手动确认提交」** 的清爽联调模式，不会因切换公共属性或身份配置而在右侧无限刷屏追加日志卡片：

1. **实时状态看板**：
   - **访客标识 (`distinct_id`)**：首次初始化自动生成的 UUIDv4 访客/设备标识，可通过 `identify()` 自定义覆盖，且在 `login()` / `logout()` 时保持不变。
   - **登录账号 ID (`login_id`)**：调用 `login()` 后设置的已认证账号 ID；未登录或执行 `logout()` 后显示 `(未登录)`。
2. **右侧「待提交请求 JSON 预览」与「确认提交」面板**：
   - **请求体参数 (`Request Body JSON`)**：始终只保留一份完整的 `POST /collect/api/v1/track/batch` 待发送请求体 JSON，**支持直接在文本框内手动编辑修改参数与一键格式化**（实时校验 JSON 语法与 `events` 数组结构）。当修改身份、编辑/开关公共属性或选择不同事件时，该 JSON 面板会原地实时刷新参数预览（勾选「多条拼批模式」可将多个事件拼入同一 `events` 数组）。
   - **确认提交**：核对上方请求 JSON 无误后，点击右上角绿色 **「确认提交」** 按钮才会真正发起上报，并在下方 **「最近一次提交结果」** 区域更新单次响应结果。

---

### 4. 五大功能分组与参数构建按钮说明

演练场左侧按采集生命周期划分为 **参数配置与构建分组**：

#### 分组 1：身份与会话参数（`identify` / `login` / `logout`）

1. **切换随机访客 ID (`identify`)**：本地覆盖当前访客设备标识（`distinct_id`）并即时刷新右侧待提交请求中的 `distinct_id`。
2. **设置登录账号 (`login`)**：调用 `sdk.login(...)` 本地设置 `login_id`（纯状态变更，不覆盖 `distinct_id`，不生成额外网络事件），即时刷新右侧当前待提交事件的预览 JSON，使其同时展示 `distinct_id` 与 `login_id`。
3. **退出登录 (`logout`)**：调用 `sdk.logout()` 清除 `login_id`（保留 `distinct_id` 不变）并即时刷新右侧预览 JSON。

#### 分组 2：公共属性配置（`Super Properties`）

4. **静态公共属性参数输入框 + 应用静态公共属性**：支持直接编辑任意 JSON 对象并调用 `sdk.setSuperProperties(...)`，右侧待提交行为事件的 `properties` 会原地同步合入这些字段。
5. **启用动态公共属性（开 / 关）**：一键切换 `setDynamicSuperProperties` 状态，开启后右侧行为事件参数自动合入 `dyn_sequence` 与 `viewport_width`，不会重复刷屏输出日志。
6. **清空全部公共属性**：一键清空静态公共属性并关闭动态公共属性，右侧请求 JSON 同步移除对应字段。

#### 分组 3：行为事件上报（`track` / `timeEvent` / 固定 `eventId` 同日幂等 / `BigInt`）

7. **上报商品浏览事件 (`ProductView`)**
   - 调用 `sdk.track('ProductView', { sku_id, product_name, price, in_stock })` 上报标准电商商品详情浏览事件，自动合并预置属性（`$lib`、`$url`、`$screen_width` 等）与公共属性。
8. **开始事件计时 (`timeEvent 'OrderPaid'`)**
   - 调用 `sdk.timeEvent('OrderPaid')` 基于高精度单调时钟（`performance.now()`）启动计时器，本身不发送网络请求。
9. **完成计时事件 (`$duration`)**
   - 调用 `sdk.track('OrderPaid', { amount: 299.5, currency: 'CNY', payment_method: 'apple_pay' })`；若此前已点击「开始事件计时」，SDK 会自动计算耗时（秒，保留 3 位小数）并注入 `$duration` 属性。
10. **固定 `eventId` 同日幂等上报 (`CheckoutStart`)**
    - 调用 `sdk.track('CheckoutStart', { coupon_code: 'WELCOME_ABI' }, { eventId })` 显式传入确定性 `event_id` 演示同日网络重试幂等去重（注：`trackFirst` / `trackUpdate` / `trackOverwrite` 按 D7① / G6 门禁在当前版本未开放，调用将显式抛出异常且不入队）。
11. **上报 64 位雪花 ID (`BigInt > 2^53-1`)**
    - 调用 `sdk.track('OrderPaid', { order_id: 9007199254740993n, snowflake_trace_id: 1844674407370955161n, items: [...] })`；超出 IEEE-754 安全整数范围（`> 2^53 - 1`）的 `BigInt`（含数组内元素）会自动无损序列化为十进制字符串，彻底避免前端 JSON 精度丢失。

#### 分组 4：用户画像属性操作（`$user_*` -> StarRocks `abi.dim_users`）

14. **覆盖设置画像 (`userSet`: `vip_level/city`)**
    - 调用 `sdk.userSet({ vip_level: 'diamond', city: 'Shanghai' })`，触发 `$user_set` 事件覆盖写入用户最新画像属性（注：`$user_*` 事件不混入浏览器预置属性与公共属性）。
15. **首次初始化画像 (`userSetOnce`: `first_channel`)**
    - 调用 `sdk.userSetOnce({ first_channel: 'organic_search' })`，触发 `$user_set_once` 事件，仅当该画像字段为空/未初始化时写入（如首访获客渠道）。
16. **数值累加画像 (`userAdd`: `loyalty_points +50`)**
    - 调用 `sdk.userAdd({ loyalty_points: 50 })`，触发 `$user_add` 事件对数值型画像字段执行原子累加（传入负数可扣减）。
17. **列表追加元素 (`userAppend`: `interest_tags`)**
    - 调用 `sdk.userAppend({ interest_tags: ['analytics', 'starrocks'] })`，触发 `$user_append` 事件向数组/集合型用户属性追加元素。
18. **列表去重追加 (`userUniqAppend`: `badges`)**
    - 调用 `sdk.userUniqAppend({ badges: ['early_adopter', 'verified_dev'] })`，触发 `$user_uniq_append` 事件向数组型用户属性追加元素并自动去重。
19. **移除指定属性 (`userUnset`: `city`)**
    - 调用 `sdk.userUnset('city')`，触发 `$user_unset` 事件将用户画像中的指定属性置空移除。
20. **删除用户画像 (`userDelete` / `$user_del`)**
    - 调用 `sdk.userDelete()`，触发 `$user_del` 事件标记删除当前用户在 `abi.dim_users` 中的画像记录。

#### 分组 5：全埋点与传输队列控制（`$pageview` / `$AppClick` / `$AppEnd` / `flush()`）

21. **模拟 SPA 页面浏览 (`$pageview`)**
    - 模拟单页应用路由切换并上报 `$pageview` 事件（附带 `$url`、`$url_path`、`$title`）；真实生产环境可通过 `init({ autoTrack: { pageView: true } })` 自动监听 `pushState` / `replaceState` / `popstate` / `hashchange`。
22. **采集按钮点击 (`$AppClick`)**
    - 模拟点击带有 `data-abi-track="demo-cta"` 标记的交互按钮并上报 `$AppClick` 事件（采集 `element_type`、`element_id`、`element_content`）；生产环境可通过 `autoTrack: { webClick: true }` 自动采集。
23. **模拟页面离开停留时长 (`$AppEnd`)**
    - 模拟页面隐藏/关闭时上报 `$AppEnd` 页面停留时长事件（携带 `$duration: 12.48` 秒）；生产环境开启 `autoTrack: { pageLeave: true }` 后会在 `visibilitychange` / `pagehide` 时自动触发并优先通过 `navigator.sendBeacon` 可靠投递。
24. **立即刷新上报队列 (`flush`)**
    - 手动调用 `await sdk.flush()` 立即将当前内存与持久化队列中的待发事件打包发送至网关。

---

## 二、多端代码示例（`usage-examples.ts`）接入指南

[`usage-examples.ts`](./usage-examples.ts) 提供了 3 个零外部依赖、可直接导入执行的异步示例函数，覆盖 Web、微信小程序与 React Native 三端标准接入模式。

### 1. Web SPA 电商全链路接入（`runWebSpaEcommerceExample`）

完整串联电商用户从匿名进站到下单结算与画像沉淀的 9 个标准步骤：

```ts
import { AbiWebSdk } from '@anylink/abi-web-sdk';

const sdk = new AbiWebSdk().init({
  serverUrl: 'https://ingest.abi.example.com',
  projectId: 101,
  token: 'abi_proj_token_web_ecommerce_demo',
  appVersion: '3.4.0',
  autoTrack: { pageView: true, pageLeave: true, webClick: true },
});

// 1. 访客标识与静态/动态公共属性
sdk.identify('visitor_web_001');
sdk.setSuperProperties({ channel: 'seo_landing', ab_group: 'checkout_one_step_v2' });
sdk.setDynamicSuperProperties(() => ({ cart_items: 2 }));

// 2. 未登录浏览商品 -> 登录设置账号 ID (login_id，保留 distinct_id 不变)
sdk.track('ProductView', { sku_id: 'sku_1', price: 149.75 });
sdk.login('user_10086');

// 3. 支付流程计时、固定 eventId 同日幂等与 64 位雪花订单号上报
sdk.timeEvent('OrderPaid');
sdk.track('CheckoutStarted', { entry_scene: 'cart_drawer' }, { eventId: 'evt_checkout_visitor_web_001' });
sdk.track('OrderPaid', {
  order_id: 9007199254740993n, // 自动安全序列化为字符串 "9007199254740993"
  amount: 299.5,
  items: ['sku_1', 2, true],
}, { eventId: 'evt_order_paid_2026_001' });

// 4. 独立履约里程碑事件与用户画像沉淀
sdk.track('OrderSettled', { order_id: 9007199254740993n, amount: 279.5, status: 'settled' });
sdk.userSet({ vip_level: 'gold', city: 'Shanghai' });
sdk.userAdd({ loyalty_points: 300, total_orders: 1 });
await sdk.flush();
```

### 2. 微信小程序 / uni-app / Taro 接入（`createMiniProgramAdapter`）

小程序环境无浏览器 `window.localStorage` 与 `fetch`，可通过 `@anylink/abi-web-sdk/adapters/miniapp` 提供的 `createMiniProgramAdapter` 一键桥接微信原生 `wx`（或 `uni` / `Taro`）对象：

```ts
import { AbiWebSdk } from '@anylink/abi-web-sdk';
import { createMiniProgramAdapter } from '@anylink/abi-web-sdk/adapters/miniapp';

// 自动适配 wx.getStorageSync / setStorageSync、wx.request 与 wx.getSystemInfoSync 预置属性 ($lib: 'abi-mp-sdk')
const mpAdapter = createMiniProgramAdapter(wx);

export const abiMp = new AbiWebSdk().init({
  serverUrl: 'https://ingest.abi.example.com', // 请将该域名加入微信公众平台「request 合法域名」白名单
  projectId: 102,
  token: 'abi_proj_token_wx_miniapp',
  appVersion: '2.1.0',
  ...mpAdapter,
});

abiMp.track('$AppStart', { path: 'pages/home/index' });
abiMp.login('wx_openid_u_8801');
abiMp.track('ShareMiniProgram', { share_target: 'moments', campaign_id: 9007199254740999n });
```

### 3. React Native 移动应用接入（`createReactNativeAdapter`）

React Native 环境自带全局 `fetch`，可通过 `@anylink/abi-web-sdk/adapters/react-native` 提供的 `createReactNativeAdapter` 注入移动端设备信息（`$lib: 'abi-rn-sdk'`、`$os`、`$os_version`、`$device_model`、屏幕宽高）及同步持久化存储（如基于 `react-native-mmkv` 实现的 `AbiStorageAdapter`）：

```ts
import { AbiWebSdk, type AbiStorageAdapter } from '@anylink/abi-web-sdk';
import { createReactNativeAdapter } from '@anylink/abi-web-sdk/adapters/react-native';

// 示例：使用 MMKV 封装同步存储适配器以持久化访客 distinct_id、登录态 login_id 与离线事件队列
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

## 三、运行测试与构建验证

`test/abi-web-sdk.test.ts` 已内置黄金测试向量校验（身份归一化、事件名/属性名规范、`BigInt` 序列化、503 离线幂等重试）以及对 `usage-examples.ts` 中三大场景示例的端到端断言。在 `abi.sdk/ts-web` 目录执行以下命令即可完成完整验证：

```bash
cd abi.sdk/ts-web

# 运行 Vitest 单元测试与多端示例集成断言
pnpm test

# 编译 TypeScript 生成 dist/ ESM 与类型声明产物（同时供 interactive-demo.html 加载）
pnpm run build
```
