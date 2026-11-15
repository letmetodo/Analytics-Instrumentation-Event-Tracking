# ABI Flutter / Dart 客户端 SDK 文档 (`abi.sdk/mobile/flutter`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

[`lib/abi_sdk.dart`](lib/abi_sdk.dart) 是面向 Flutter 跨平台移动与桌面应用的零第三方依赖数据采集分析 SDK，基于纯 Dart 标准库（`dart:async`、`dart:convert`、`dart:io`、`dart:math`）实现，完整对齐 ABI 采集网关 `POST /collect/api/v1/track/batch` 协议契约与 ThinkingData v3.4 规范。

> 返回移动端总览：[简体中文](../README.md) | [English](../README.en.md) | [日本語](../README.ja.md)

---

## 接入人员视角：哪些字段必填、哪些由 SDK 自动采集、哪些由服务端/网关补充（如 IP）

站在 Flutter 客户端接入研发人员的视角，日常集成时可将所有埋点字段划分为以下三类：

| 字段分类 | 阶段 / 字段名 | 是否需要客户端手填 | 来源与处理机制 |
|----------|---------------|--------------------|----------------|
| **第一类：接入人员【必须主动传入】的必填项** | **初始化 (`init` / `initialize`)**：`serverUrl`、`projectId` (`> 0`)、`projectToken` / `token` | **必填** | 通过 `AbiConfig` 指定 `:8081` 采集网关地址、归属项目 ID（`> 0`）与非空项目密钥。 |
| | **事件埋点 (`track`)**：`eventName` | **必填** | 业务事件名（如 `'OrderPaid'`），自定义业务属性通过 `properties` 按需传入。 |
| | **账号登录 (`login`)**：`accountId`（即 `login_id`） | **实名登录时必传** | 用户完成实名登录时调用 `login(accountId)` 纯本地更新 `login_id`（上限 128 UTF-8 字节，绝不覆盖 `distinct_id`，不自动触发网络事件）。 |
| | **更新 / 重写事件 (`trackUpdate` / `trackOverwrite`)**：`eventId` | **当前版本未开放** | 严守 D7① / G6 门禁，当前 StarRocks `dwd_events` 存储模型尚未开放 `trackFirst` / `trackUpdate` / `trackOverwrite`。 |
| **第二类：SDK【自动生成并持久化】，客户端【无需手填】** | `distinct_id` | **无需手填** | 初始化时自动生成 UUIDv4（配置持久化回调时写入 `distinct_id` 键），仅通过 `identify` 修改，不受 `login` 覆盖。 |
| | `event_id` | **无需手填** | 每次 `track` 自动生成 UUIDv4，且在弱网/离线重试时保持幂等不变。 |
| | `timestamp` | **无需手填** | 自动取客户端当前毫秒时间戳（除非通过 `#time` / `$time` 显式指定历史事件时间）。 |
| | 设备与环境预置属性：`$lib`、`$lib_version`、`$os`、`$os_version`、`$device_model`、`$screen_width`、`$screen_height`、`$url`、`$title`、`$referrer`、`$zone_offset` | **无需手填** | SDK 自动采集并注入（`$user_*` 画像事件自动隔离预置属性与公共属性）。 |
| **第三类：客户端【拿不到也无需传】，由网关/服务端补充** | **公网 IP 与地域信息 (`#ip` / `$ip` $\rightarrow$ 国家/省/市)** | **客户端严禁手填** | 客户端直连 `:8081` 网关时，由网关自动从 HTTP 连接（及 `X-Forwarded-For` / `X-Real-IP`）提取真实客户端 IP，并由 Flink 自动解析国家、省份、城市。 |

1. **第一类：接入人员【必须主动传入】的必填项**
   - **初始化阶段 (`init` / `initialize`)**：`serverUrl`（采集网关地址）、`projectId`（`> 0`）、`token` / `projectToken`（非空项目密钥）。
   - **埋点调用阶段 (`track`)**：`eventName`（必填，如 `'OrderPaid'`）。
   - **账号登录阶段 (`login`)**：用户完成实名登录时传入 `accountId`（即 `login_id`），纯本地更新 `login_id`（不覆盖 `distinct_id`，不触发额外事件），后续事件自动同时携带 `distinct_id` 与 `login_id`。
   - **同日重试幂等标识 (`track` 可选 `eventId`)**：如需同日重试幂等，可在 `track` 中显式传入确定性 `eventId`（严守 D7① / G6 门禁，当前版本未开放 `trackFirst` / `trackUpdate` / `trackOverwrite`）。
2. **第二类：SDK【自动生成并持久化】，前端/客户端开发【无需手填】的字段**
   - **`distinct_id`（访客/设备 ID）**：初始化时自动生成 UUIDv4 并支持通过 `storageRead` / `storageWrite` 持久化至本地 `distinct_id` 键（上限 64 UTF-8 字节），登录时绝不被 `login_id` 覆盖。
   - **`event_id`**：每次 `track` 自动生成 UUIDv4，且在弱网/离线重试时保持幂等不变。
   - **`timestamp`**：自动取客户端当前毫秒时间戳（除非通过 `#time` / `$time` 显式指定历史事件时间）。
   - **设备与环境预置属性**：`$lib`、`$lib_version`、`$os`、`$os_version`、`$device_model`、`$screen_width`、`$screen_height`、`$url`、`$title`、`$referrer`、`$zone_offset`。
3. **第三类：客户端【拿不到也无需传】，由采集网关/服务端负责获取的字段（重点：`IP` 与前后端打通）**
   - **公网 IP 与地域信息 (`#ip` / `$ip` $\rightarrow$ 国家/省/市)**：浏览器 JS、小程序与移动端 App 处于客户端沙箱及 NAT 路由后，**本身拿不到真实的公网出口 IP，因此客户端接入时绝对不需要传 `$ip` / `#ip`**！当客户端直连 `:8081` 采集网关时，网关会自动从 HTTP 连接（及 Nginx/SLB 的 `X-Forwarded-For` / `X-Real-IP`）提取真实客户端 IP 并由 Flink 自动解析国家、省份、城市。
   - **注意：何时需要传 IP？** 只有当业务采用「客户端先调业务后端 API，再由 Go/Java 服务端 SDK 代报埋点」时，因为网关看到的是后端机房 IP，才需要由业务后端从客户端请求中提取 IP 并通过 `#ip` / `$ip` 传给服务端 SDK。同时建议移动端调用业务后端接口时在 Header 携带访客标识（`sdk.distinctId`），方便服务端关联前后端漏斗。

---

## 1. 集成方式与环境配置

### 1.1 纯 Dart 零第三方依赖引入
1. 将 [`lib/abi_sdk.dart`](lib/abi_sdk.dart) 直接复制到宿主 Flutter 工程的 `lib/` 目录下（无需在 `pubspec.yaml` 中添加任何第三方 HTTP 或设备插件依赖）。
2. 在需要埋点的业务代码中引入：
   ```dart
   import 'package:your_app/abi_sdk.dart';
   ```
3. 如需挂载交互式联调演练页，将 [`example/lib/main.dart`](example/lib/main.dart) 复制到宿主工程并挂载 `const AbiSdkDemoApp()`。

### 1.2 各运行环境网络与网关地址说明
- **iOS 模拟器 / macOS 桌面端**：可直接将 `serverUrl` 配置为宿主机本地网关 `http://localhost:8081`。
- **Android 模拟器**：Android 模拟器中 `localhost` 指向模拟器自身，需将 `serverUrl` 设为 `http://10.0.2.2:8081` 访问宿主机 `:8081` 网关。
- **iOS / Android 真机联调**：请将 `serverUrl` 设为开发机局域网 IP（如 `http://192.168.1.x:8081`），并在开发环境开启明文 HTTP 访问许可（Android `usesCleartextTraffic="true"` / iOS `NSAllowsLocalNetworking = YES`）。

---

## 2. 初始化与核心 API 速查

### 2.1 SDK 初始化 (`AbiConfig` & `AbiAnalytics.instance.init`)

```dart
final sdk = AbiAnalytics.instance;

sdk.init(const AbiConfig(
  serverUrl: 'http://localhost:8081', // Android 模拟器请使用 http://10.0.2.2:8081
  projectId: 1,
  projectToken: 'abi_tok_demo_project_1',
  appVersion: '2.1.0',
  batchSize: 20,
  flushInterval: Duration(seconds: 5),
  debug: false,
  dryRun: false,     // 设为 true 时网关仅校验报文格式而不落库
  autoFlush: true,   // 生产环境默认 true；两步式交互预览时设为 false
));
```

| `AbiConfig` 参数 | 类型 | 默认值 | 说明 |
|------------------|------|--------|------|
| `serverUrl` | `String` | 必填 | 采集网关基础地址（自动拼接 `/collect/api/v1/track/batch`） |
| `projectId` | `int` | 必填 | ABI 归属项目 ID (`project_id`) |
| `projectToken` | `String` | 必填 | 项目接入令牌 (`project_token`) |
| `appVersion` | `String` | `'1.0.0'` | 宿主应用版本号，自动注入事件预置属性 `$app_version` |
| `batchSize` | `int` | `20` | 单次批量上报触发阈值（条数） |
| `flushInterval` | `Duration` | `Duration(seconds: 5)` | 后台定时刷新队列的时间间隔 |
| `debug` | `bool` | `false` | 调试即时上报模式（每次 `track` 立即触发发送） |
| `dryRun` | `bool` | `false` | 网关 `dry_run` 演练校验模式（仅校验不写入 Kafka/StarRocks） |
| `autoFlush` | `bool` | `true` | 是否启用后台定时与阈值自动上报（设为 `false` 时由调用方手动 `flush()`） |

---

### 2.2 双标识身份管理 (`identify` / `login` / `logout`)

SDK 严格对齐数数科技（ThinkingData）规范，上报报文仅包含 `distinct_id`（访客/设备 ID，上限 64 UTF-8 字节）与 `login_id`（实名账号 ID，上限 128 UTF-8 字节）两个身份字段：
- `distinctId`：当前访客/设备标识（初始化自动生成 UUIDv4，可通过 `AbiConfig.storageRead` / `storageWrite` 持久化至本地 `distinct_id` 键）。
- `loginId`：当前登录账号标识（未登录时为空字符串 `''`）。
- `identify(String distinctId)`：自定义覆盖访客/设备标识（自动校验非空、无控制字符且 ≤ 64 UTF-8 字节，纯本地更新，不发送网络事件）。
- `login(String accountId)`：设置实名账号标识（上限 128 UTF-8 字节，纯本地更新，**绝不覆盖 `distinctId`**，**绝不发送任何网络事件**，返回 `void`）。
- `logout()`：清空 `loginId`，保持 `distinctId` 不变（不发送网络事件）。

```dart
sdk.identify('flutter_visitor_device_001');
sdk.login('acct_flutter_10001'); // 纯本地状态更新，不发送额外网络事件
print('访客标识: ${sdk.distinctId}, 登录标识: ${sdk.loginId}');
sdk.logout();
```

---

### 2.3 静态与动态公共属性 (`Super Properties`)

公共属性会自动合并到后续所有普通行为与系统事件中（**自动隔离 `$user_*` / `#user_*` 用户画像事件**），属性覆盖优先级为：`单次事件 properties > 动态公共属性 > 静态公共属性 > SDK 预置系统属性`。

| 方法签名 | 说明 |
|----------|------|
| `setSuperProperties(Map<String, dynamic> props)` | 注册或合并全局静态公共属性 |
| `unsetSuperProperty(String key)` | 按属性名移除单个静态公共属性 |
| `clearSuperProperties()` | 清空所有已注册的静态公共属性 |
| `getSuperProperties()` | 获取当前静态公共属性的浅拷贝 `Map<String, dynamic>` 快照 |
| `setDynamicSuperProperties(Map<String, dynamic> Function()? fn)` | 注册（或传 `null` 移除）动态公共属性回调，每次 `track` 时实时求值 |

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

### 2.4 事件计时与同日幂等事件采集 (`timeEvent` / `track`)

- **秒表计时事件 (`timeEvent`)**：调用 `sdk.timeEvent('OrderPaid')` 启动高精度 `Stopwatch`；下一次调用 `sdk.track('OrderPaid', ...)` 时自动停止计时并注入秒级（保留 3 位小数）`$duration` 属性。
- **普通事件 (`track`)**：采集自定义业务事件或系统保留事件，返回归一化后的幂等 `event_id`（默认生成 UUID v4）；核心交易或里程碑事件可显式传入确定性 `eventId` 实现同日全量载荷重试幂等去重。
- **未开放接口门禁 (`trackFirst` / `trackUpdate` / `trackOverwrite`)**：严守 D7① / G6 门禁，当前 StarRocks `dwd_events` 存储模型未开放 `$first_check_id` 首次去重及 `trackUpdate` / `trackOverwrite` 可变事件（调用 `trackUpdate` / `trackOverwrite` 将直接抛出 `UnsupportedError` 且绝不入队伪造普通 `track` 事件）；订单状态流转请按独立里程碑事件建模。

```dart
// 1. 秒表计时与普通事件上报
sdk.timeEvent('OrderPaid');
final orderEvtId = sdk.track(
  'OrderPaid',
  properties: {
    'order_id': 'ord_20261110_01',
    'amount': 299.0,
  },
);

// 2. 同日固定 eventId 里程碑事件（网络重试保持完整相同载荷幂等）
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

### 2.5 7 类用户画像操作 (`$user_*`)

所有用户画像操作对应 StarRocks `abi.dim_users` 用户维表，SDK 会**自动隔离预置系统属性与静态/动态公共属性**，防止设备环境字段污染用户画像：

| 方法签名 | 对应系统事件 | 说明 |
|----------|--------------|------|
| `userSet(Map<String, dynamic> properties)` | `$user_set` | 覆盖设置用户画像属性（已存在同名属性则覆盖） |
| `userSetOnce(Map<String, dynamic> properties)` | `$user_set_once` | 首次设置用户画像属性（仅当目标字段为空或未设置时生效） |
| `userAdd(Map<String, num> properties)` | `$user_add` | 数值型画像属性原子累加（传入负数代表扣减） |
| `userAppend(Map<String, List<dynamic>> properties)` | `$user_append` | 向列表型画像属性追加元素（不去重） |
| `userUniqAppend(Map<String, List<dynamic>> properties)` | `$user_uniq_append` | 向列表型画像属性去重追加元素 |
| `userUnset(List<String> keys)` | `$user_unset` | 清空指定的用户画像属性键列表（内部映射为 `{key: 0}`） |
| `userDelete()` | `$user_del` | 标记删除当前用户的画像记录 |

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

### 2.6 `> 2^53 - 1` 大整数精度保护与 `#time` / `$time` 时间提取

1. **`> 2^53 - 1` 大整数精度保护**：
   - IEEE-754 双精度浮点数安全整数上限为 `9007199254740991`（即 $2^{53}-1$，`AbiAnalytics.maxSafeInteger`）。
   - 当属性值（或列表元素）中的 `int` 绝对值超过 `9007199254740991`（例如 64 位分布式雪花 ID `9007199254740993`）时，SDK 会自动将其序列化为十进制字符串 `"9007199254740993"`，防止跨端 JSON 解析发生尾数截断。
2. **`#time` / `$time` 事件发生时间提取**：
   - 除了通过 `track(..., timestamp: DateTime)` 显式传参外，若 `properties` 中包含 `'#time'` 或 `'$time'`（`'#time'` 优先级高于 `'$time'`），SDK 会自动将其解析为顶层毫秒时间戳 `timestamp`，并**从上报的 `properties` 字典中自动剥离**。
   - 支持的时间值类型：`DateTime`、10 位秒级或 13 位毫秒级 `int`/`double` 时间戳、数字字符串（10~16 位）以及标准 ISO-8601 字符串（如 `'2026-11-10T08:00:00Z'`）。

```dart
sdk.track(
  'OrderPaid',
  properties: {
    '#time': '2026-11-10T08:30:00.000Z', // 自动提取为顶层毫秒 timestamp 并从 properties 中移除
    'snowflake_seq': 9007199254740993,   // > 2^53 - 1，自动转为字符串 "9007199254740993"
  },
);
```

---

## 3. 两步式交互演练页与无界面调用示例

### 3.1 两步式 UI 演练页 ([`example/lib/main.dart`](example/lib/main.dart))

`AbiSdkDemoScreen` 严格遵循与 Web 端一致的**两步式预览与确认提交契约**：
1. **第 1 步：配置参数并实时预览单份请求 JSON (`autoFlush: false` + `buildPendingBatchPayload`)**
   - 页面初始化时传入 `autoFlush: false`，禁用后台定时器与阈值自动发送。
   - 每次切换身份（`identify` / `login` / `logout`）、修改静态/动态公共属性或点击行为事件与 `$user_*` 画像按钮时，内部调用 `_sdk.clearPendingQueue()` 重放当前暂存动作，并通过 `_sdk.buildPendingBatchPayload()` 原地刷新 **面板 A：待提交请求 JSON 预览**，绝不追加历史刷屏日志。
   - 开启 **「多条拼批模式」** 开关后，连续点击多个事件按钮会将它们追加到同一个 `events` 数组中供一次性预览与提交。
2. **第 2 步：点击「确认提交」发送 (`flush`)**
   - 仅当点击 **「确认提交」** 按钮时才调用 `await _sdk.flush()`，并在 **面板 B：最近一次提交结果 (Response)** 展示单次 HTTP 状态码（`_sdk.lastStatusCode`）与响应报文（`_sdk.lastResponseBody`）。

### 3.2 两步式无界面方法级调用 (`previewScenarioPayload` + `confirmSubmit`)

在自动化测试或无需挂载 UI 的脚本联调中，可直接调用 `AbiAnalytics` 内置的两步式方法：

```dart
import 'package:your_app/abi_sdk.dart';

Future<void> runHeadlessTwoStepDemo() async {
  final sdk = AbiAnalytics.instance;

  // 第 1 步：以 autoFlush: false 构建身份、公共属性、计时事件、大整数、固定 eventId 里程碑事件与 7 类 $user_* 画像，
  // 返回完整 POST /collect/api/v1/track/batch 请求体 JSON 字符串（不自动发送）
  final pendingJson = sdk.previewScenarioPayload(
    serverUrl: 'http://localhost:8081',
    projectId: 1,
    projectToken: 'abi_tok_demo_flutter',
    dryRun: true,
  );
  print('=== 第 1 步：待提交请求 JSON 预览 ===\n$pendingJson');

  // 第 2 步：确认提交并输出单次响应结果
  final ok = await sdk.confirmSubmit();
  print('=== 第 2 步：确认提交结果 ===');
  print('ok=$ok, status=${sdk.lastStatusCode}, response=${sdk.lastResponseBody}');
}
```
