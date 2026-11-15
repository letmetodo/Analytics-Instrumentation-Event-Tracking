# ABI iOS / macOS Swift 客户端 SDK 文档 (`abi.sdk/mobile/ios`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

[`AbiAnalytics.swift`](AbiAnalytics.swift) 是面向 iOS 与 macOS 原生客户端的零第三方依赖数据采集分析 SDK，基于 Apple 原生 `Foundation` 框架（`NSLock`、`URLSession`、`JSONSerialization`、`ProcessInfo.processInfo.systemUptime`）实现，全面对齐 ABI 采集网关 `POST /collect/api/v1/track/batch` 协议契约与 ThinkingData v3.4 规范。

> 返回移动端总览：[简体中文](../README.md) | [English](../README.en.md) | [日本語](../README.ja.md)

---

## 接入人员视角：哪些字段必填、哪些由 SDK 自动采集、哪些由服务端/网关补充（如 IP）

站在 iOS / macOS 客户端接入研发人员的视角，日常集成时可将所有埋点字段划分为以下三类：

| 字段分类 | 阶段 / 字段名 | 是否需要客户端手填 | 来源与处理机制 |
|----------|---------------|--------------------|----------------|
| **第一类：接入人员【必须主动传入】的必填项** | **初始化 (`init` / `initialize`)**：`serverUrl`、`projectId` (`> 0`)、`projectToken` / `token` | **必填** | 调用 `AbiAnalytics.shared.initialize` 指定 `:8081` 采集网关地址、归属项目 ID（`> 0`）与非空项目密钥。 |
| | **事件埋点 (`track`)**：`eventName` | **必填** | 业务事件名（如 `"OrderPaid"`），自定义业务属性通过 `properties` 按需传入。 |
| | **账号登录 (`login`)**：`accountId`（即 `login_id`） | **实名登录时必传** | 用户完成实名登录时调用 `login(accountId)` 纯本地更新并持久化 `login_id`（上限 128 UTF-8 字节，绝不覆盖 `distinct_id`，不自动触发网络事件）。 |
| | **更新 / 重写事件 (`trackUpdate` / `trackOverwrite`)**：`eventId` | **当前版本未开放** | 严守 D7① / G6 门禁，当前 StarRocks `dwd_events` 存储模型尚未开放 `trackFirst` / `trackUpdate` / `trackOverwrite`。 |
| **第二类：SDK【自动生成并持久化】，客户端【无需手填】** | `distinct_id` | **无需手填** | 初始化时自动生成 UUIDv4 并持久化至 `UserDefaults`（`abi_sdk_<projectId>_distinct_id`），仅通过 `identify` 修改，不受 `login` 覆盖。 |
| | `event_id` | **无需手填** | 每次 `track` 自动生成 UUIDv4，且在弱网/离线重试时保持幂等不变。 |
| | `timestamp` | **无需手填** | 自动取客户端当前毫秒时间戳（除非通过 `#time` / `$time` 显式指定历史事件时间）。 |
| | 设备与环境预置属性：`$lib`、`$lib_version`、`$os`、`$os_version`、`$device_model`、`$screen_width`、`$screen_height`、`$url`、`$title`、`$referrer`、`$zone_offset` | **无需手填** | SDK 自动采集并注入（`$user_*` 画像事件自动隔离预置属性与公共属性）。 |
| **第三类：客户端【拿不到也无需传】，由网关/服务端补充** | **公网 IP 与地域信息 (`#ip` / `$ip` $\rightarrow$ 国家/省/市)** | **客户端严禁手填** | 客户端直连 `:8081` 网关时，由网关自动从 HTTP 连接（及 `X-Forwarded-For` / `X-Real-IP`）提取真实客户端 IP，并由 Flink 自动解析国家、省份、城市。 |

1. **第一类：接入人员【必须主动传入】的必填项**
   - **初始化阶段 (`init` / `initialize`)**：`serverUrl`（采集网关地址）、`projectId`（`> 0`）、`token` / `projectToken`（非空项目密钥）。
   - **埋点调用阶段 (`track`)**：`eventName`（必填，如 `"OrderPaid"`）。
   - **账号登录阶段 (`login`)**：用户完成实名登录时传入 `accountId`（即 `login_id`），纯本地持久化 `login_id`（不覆盖 `distinct_id`，不触发额外事件），后续事件自动同时携带 `distinct_id` 与 `login_id`。
   - **同日重试幂等标识 (`track` 可选 `eventId`)**：如需同日重试幂等，可在 `track` 中显式传入确定性 `eventId`（严守 D7① / G6 门禁，当前版本未开放 `trackFirst` / `trackUpdate` / `trackOverwrite`）。
2. **第二类：SDK【自动生成并持久化】，前端/客户端开发【无需手填】的字段**
   - **`distinct_id`（访客/设备 ID）**：初始化时自动生成 UUIDv4 并持久化至 `UserDefaults`（`abi_sdk_<projectId>_distinct_id`，上限 64 UTF-8 字节），登录时绝不被 `login_id` 覆盖。
   - **`event_id`**：每次 `track` 自动生成 UUIDv4，且在弱网/离线重试时保持幂等不变。
   - **`timestamp`**：自动取客户端当前毫秒时间戳（除非通过 `#time` / `$time` 显式指定历史事件时间）。
   - **设备与环境预置属性**：`$lib`、`$lib_version`、`$os`、`$os_version`、`$device_model`、`$screen_width`、`$screen_height`、`$url`、`$title`、`$referrer`、`$zone_offset`。
3. **第三类：客户端【拿不到也无需传】，由采集网关/服务端负责获取的字段（重点：`IP` 与前后端打通）**
   - **公网 IP 与地域信息 (`#ip` / `$ip` $\rightarrow$ 国家/省/市)**：浏览器 JS、小程序与移动端 App 处于客户端沙箱及 NAT 路由后，**本身拿不到真实的公网出口 IP，因此客户端接入时绝对不需要传 `$ip` / `#ip`**！当客户端直连 `:8081` 采集网关时，网关会自动从 HTTP 连接（及 Nginx/SLB 的 `X-Forwarded-For` / `X-Real-IP`）提取真实客户端 IP 并由 Flink 自动解析国家、省份、城市。
   - **注意：何时需要传 IP？** 只有当业务采用「客户端先调业务后端 API，再由 Go/Java 服务端 SDK 代报埋点」时，因为网关看到的是后端机房 IP，才需要由业务后端从客户端请求中提取 IP 并通过 `#ip` / `$ip` 传给服务端 SDK。同时建议移动端调用业务后端接口时在 Header 携带访客标识（`sdk.distinctId`），方便服务端关联前后端漏斗。

---

## 1. 集成方式与环境配置

### 1.1 源码集成（零 CocoaPods / SPM 第三方依赖）
1. 将 [`AbiAnalytics.swift`](AbiAnalytics.swift) 直接拖入宿主 Xcode 工程 Target 的 `Compile Sources` 中（仅依赖系统 `Foundation`）。
2. 如需挂载交互式 SwiftUI 演练页或使用两步式无界面演练运行器，将 [`example/AbiDemoViewController.swift`](example/AbiDemoViewController.swift) 一并加入 Target：
   - **SwiftUI 工程**：直接在视图层级中挂载 `AbiSdkDemoView()`（要求 iOS 15.0+ / macOS 12.0+）；
   - **UIKit 工程**：通过 `UIHostingController(rootView: AbiSdkDemoView())` 压栈或模态展示。

### 1.2 `Info.plist` 本地网络 ATS 配置
当在 iOS 模拟器、macOS 或真机开发环境下连接本地明文 HTTP 采集网关（`http://localhost:8081`）时，请在 `Info.plist` 中配置 `NSAppTransportSecurity` 允许本地明文网络请求：

```xml
<key>NSAppTransportSecurity</key>
<dict>
    <!-- 允许开发环境访问 localhost / 局域网明文 HTTP 网关 -->
    <key>NSAllowsLocalNetworking</key>
    <true/>
</dict>
```

### 1.3 命令行静态类型检查验证
无需打开 Xcode，即可在 macOS 终端直接运行 `swiftc` 验证 SDK 与 SwiftUI 演练视图零编译错误通过：
```bash
swiftc -typecheck abi.sdk/mobile/ios/AbiAnalytics.swift abi.sdk/mobile/ios/example/AbiDemoViewController.swift
```

---

## 2. 初始化与核心 API 速查

### 2.1 SDK 初始化 (`AbiAnalytics.shared.initialize`)

建议在 `AppDelegate.application(_:didFinishLaunchingWithOptions:)` 或 SwiftUI `App.init()` 中初始化全局共享单例：

```swift
import Foundation

let sdk = AbiAnalytics.shared
sdk.initialize(
    serverUrl: "http://localhost:8081",
    projectId: 1,
    projectToken: "abi_tok_ios_demo",
    appVersion: "2.1.0",
    batchSize: 20,
    debug: false,
    autoFlush: true // 生产环境默认 true（5 秒 Timer + batchSize 阈值自动上报）；两步式交互预览时设为 false
)
```

| `initialize` 参数 | 类型 | 默认值 | 说明 |
|-------------------|------|--------|------|
| `serverUrl` | `String` | 必填 | 采集网关基础地址（自动拼接 `/collect/api/v1/track/batch`） |
| `projectId` | `Int64` | 必填 | ABI 归属项目 ID (`project_id`) |
| `projectToken` | `String` | 必填 | 项目接入令牌 (`project_token`) |
| `appVersion` | `String` | `"1.0.0"` | 宿主应用版本号，自动注入事件预置属性 `$app_version` |
| `batchSize` | `Int` | `20` | 触发自动批量发送的队列条数阈值（范围 `1...500`） |
| `debug` | `Bool` | `false` | 调试模式（开启后在请求体附加 `"debug": true` 并即时触发发送） |
| `autoFlush` | `Bool` | `true` | 是否在主运行循环启动 5 秒周期定时器与阈值自动上报（设为 `false` 时由调用方手动 `flush()`） |

---

### 2.2 双标识身份管理 (`identify` / `login` / `logout`)

SDK 内部使用 `NSLock` 保护所有身份状态与队列操作，严格对齐数数科技（ThinkingData）规范，上报报文仅包含 `distinct_id`（访客/设备 ID，上限 64 UTF-8 字节）与 `login_id`（登录账号 ID，上限 128 UTF-8 字节）两个身份字段：
- `distinctId`：当前访客/设备标识（初始化自动生成 UUIDv4 并持久化至 `UserDefaults` `abi_sdk_<projectId>_distinct_id`）。
- `loginId` / `currentLoginId`：当前登录账号标识（未登录时为空字符串 `""`）。
- `identify(_ distinctId: String) throws`：自定义更新访客/设备标识（若为空、含控制字符或超过 64 UTF-8 字节则抛出 `NSError`，纯本地持久化，不发送网络事件）。
- `login(_ accountId: String) throws`：设置实名账号标识（上限 128 UTF-8 字节，纯本地持久化，**绝不覆盖 `distinctId`**，**绝不发送任何网络事件**，返回 `Void`）。
- `logout()`：清空 `loginId`，保持 `distinctId` 不变（不发送网络事件）。

```swift
try sdk.identify("ios_visitor_device_001")
try sdk.login("user_ios_10001") // 纯本地状态更新，不触发额外网络事件
print("distinctId=\(sdk.distinctId), loginId=\(sdk.currentLoginId)")
sdk.logout()
```

---

### 2.3 静态与动态公共属性 (`Super Properties`)

公共属性会自动合并到后续所有普通行为与系统事件中（**自动隔离 `$user_*` / `#user_*` 用户画像事件**）。优先级为：`单次事件 properties > 动态公共属性 > 静态公共属性 > SDK 预置系统属性（$lib/$os/$app_version）`。

| 方法签名 | 说明 |
|----------|------|
| `setSuperProperties(_ props: [String: Any])` | 注册或合并全局静态公共属性 |
| `unsetSuperProperty(_ key: String)` | 按属性名移除单个静态公共属性 |
| `clearSuperProperties()` | 清空所有已注册的静态公共属性 |
| `getSuperProperties() -> [String: Any]` | 获取当前静态公共属性的线程安全拷贝快照 |
| `setDynamicSuperProperties(_ provider: (() -> [String: Any])?)` | 注册（或传 `nil` 移除）动态公共属性闭包，每次 `track` 时实时求值 |

```swift
sdk.setSuperProperties(["channel": "AppStore", "vip_tier": "Gold"])
sdk.unsetSuperProperty("vip_tier")
let snapshot = sdk.getSuperProperties()

sdk.setDynamicSuperProperties {
    ["network_state": "wifi", "dyn_sequence": 1]
}
```

---

### 2.4 事件计时与同日幂等事件采集 (`timeEvent` / `track`)

- **高精度系统运行时间计时 (`timeEvent`)**：基于 `ProcessInfo.processInfo.systemUptime` 记录起点（不受系统墙钟调整影响）；下一次上报同名 `track` 事件时自动计算并注入秒级（保留 3 位小数）`$duration` 属性。
- **普通事件 (`track`)**：校验事件名与属性字典后线程安全入队，返回幂等 `event_id`（若校验失败则返回空字符串 `""`）；核心交易或里程碑事件可显式传入确定性 `eventId` 实现同日全量载荷重试幂等去重。
- **未开放接口门禁 (`trackFirst` / `trackUpdate` / `trackOverwrite`)**：严守 D7① / G6 门禁，当前 StarRocks `dwd_events` 存储模型未开放 `$first_check_id` 首次去重及 `trackUpdate` / `trackOverwrite` 可变事件（调用 `trackUpdate` / `trackOverwrite` 将打印显式错误日志并返回空字符串 `""`，绝不入队伪造普通 `track` 事件）；订单状态流转请按独立里程碑事件建模。

```swift
// 1. 高精度事件计时与普通事件采集
sdk.timeEvent("OrderPaid")
let orderEvtId = sdk.track(
    "OrderPaid",
    properties: [
        "order_id": "ord_9001",
        "amount": 199.95,
        "currency": "CNY"
    ]
)

// 2. 同日固定 eventId 里程碑事件（网络重试保持完整相同载荷幂等）
_ = sdk.track(
    "OrderSettled",
    properties: [
        "order_id": "ord_9001",
        "order_status": "settled",
        "amount": 199.95
    ],
    eventId: "ord_settled_9001"
)
```

---

### 2.5 7 类用户画像操作 (`$user_*`)

所有画像方法对应 StarRocks `abi.dim_users` 用户维表，SDK 会**自动隔离系统预置属性与静态/动态公共属性**：

| 方法签名 | 对应系统事件 | 说明 |
|----------|--------------|------|
| `userSet(_ properties: [String: Any])` | `$user_set` | 覆盖设置用户画像属性（存在同名字段则覆盖） |
| `userSetOnce(_ properties: [String: Any])` | `$user_set_once` | 首次设置用户画像属性（仅当目标属性未赋值时生效） |
| `userAdd(_ properties: [String: NSNumber])` | `$user_add` | 原子累加数值型用户画像属性（负数代表扣减） |
| `userAppend(_ properties: [String: [Any]])` | `$user_append` | 向列表类型画像属性追加元素（不去重） |
| `userUniqAppend(_ properties: [String: [Any]])` | `$user_uniq_append` | 向列表类型画像属性去重追加元素 |
| `userUnset(_ keys: [String])` | `$user_unset` | 清空指定的用户画像属性键数组（内部映射为 `[key: 0]`） |
| `userDelete()` | `$user_del` | 标记删除当前主体的用户画像记录 |

```swift
sdk.userSet(["vip_level": "Diamond", "city": "Shanghai"])
sdk.userSetOnce(["first_channel": "AppStore"])
sdk.userAdd(["loyalty_points": NSNumber(value: 100)])
sdk.userAppend(["tags": ["ios", "vip"]])
sdk.userUniqAppend(["tags": ["vip", "annual"]])
sdk.userUnset(["temp_badge"])
sdk.userDelete()
```

---

### 2.6 `> 2^53 - 1` 大整数精度保护与 `#time` / `$time` 时间提取

1. **`> 2^53 - 1` 大整数精度保护**：
   - IEEE-754 双精度浮点数安全整数上限为 `9007199254740991`（$2^{53}-1$，`AbiAnalytics.maxSafeInteger`）。
   - 当属性值（或数组元素）中的 `Int64` 或 `Int` 超出 `[-9007199254740991, 9007199254740991]`（含 `Int64.min`，如 64 位雪花 ID `Int64(9007199254740993)`）时，SDK 会自动将其转换为十进制字符串 `"9007199254740993"`，避免跨端 JSON 解析丢失精度。
2. **`#time` / `$time` 事件发生时间提取**：
   - 除显式传入 `timestamp: Date?` 参数外，若 `properties` 中包含 `"#time"` 或 `"$time"`（`"#time"` 优先级高于 `"$time"`），SDK 会在属性键名校验前将其解析为事件顶层毫秒时间戳 `timestamp`，并**从 `properties` 字典中自动剥离**（同时严格拒绝将 `Bool` 误判为 `NSNumber` 时间戳）。
   - 支持的时间类型：`Date`、10 位秒级或 13 位毫秒级 `Int64`/`Int`/`Double`/`Float`/`NSNumber`、纯数字字符串（10~16 位）以及 ISO-8601 / 常用日期时间字符串。

```swift
sdk.track(
    "OrderPaid",
    properties: [
        "#time": "2026-11-10T08:30:00.000Z",          // 自动提取为顶层毫秒 timestamp 并从 properties 移除
        "snowflake_seq": Int64(9007199254740993)      // > 2^53 - 1，自动转为字符串 "9007199254740993"
    ]
)
```

---

## 3. 两步式交互演练页与无界面调用示例

### 3.1 两步式 SwiftUI 演练页 ([`example/AbiDemoViewController.swift`](example/AbiDemoViewController.swift))

`AbiSdkDemoView`（支持 iOS 15.0+ / macOS 12.0+）严格遵循**两步式预览与确认提交契约**：
1. **第 1 步：配置参数并实时预览单份请求 JSON (`autoFlush: false` + `buildPendingBatchPayload` / `buildPendingBatchJsonString`)**
   - 视图初始化时传入 `autoFlush: false` 禁用定时器与阈值自动触发。
   - 切换身份（`identify` / `login` / `logout`）、编辑静态公共属性 JSON、切换动态公共属性、开启 **「多条拼批模式」** 或点击任意行为/画像按钮时，均通过 `sdk.clearPendingQueue()` 重放当前暂存动作，并调用 `sdk.buildPendingBatchJsonString()` 原地刷新 **面板 A：待提交请求 JSON 预览**，绝不追加历史刷屏日志。
2. **第 2 步：点击「确认提交」发送 (`flush(completion:)`)**
   - 仅当点击醒目的绿色 **「确认提交」** 按钮时才调用 `sdk.flush { statusCode, rawBody in ... }`，并在请求返回后更新底部的 **面板 B：最近一次提交结果 (Response)**。

### 3.2 两步式无界面方法级调用 (`AbiSdkDemoRunner.previewScenarioJson` + `confirmSubmit`)

在 XCTest 单元测试或命令行脚本联调场景下，可直接调用 `AbiSdkDemoRunner` 提供的两步式静态入口：

```swift
// 第 1 步：以 autoFlush: false 构建双 ID、静态/动态公共属性、timeEvent 计时、>2^53-1 大整数、
// 固定 eventId 里程碑事件与 7 类 $user_* 画像操作，返回格式化后的待提交请求体 JSON 字符串（不自动发送）
let pendingRequestJson = AbiSdkDemoRunner.previewScenarioJson(
    serverUrl: "http://localhost:8081",
    projectId: 1,
    projectToken: "abi_tok_ios_demo"
)
print("=== 第 1 步：待提交请求 JSON 预览 ===\n\(pendingRequestJson)")

// 第 2 步：确认提交当前待发批次，并通过回调获取单次 HTTP 状态码与响应体
AbiSdkDemoRunner.confirmSubmit { statusCode, responseBody in
    print("=== 第 2 步：确认提交完成 ===")
    print("HTTP \(statusCode), 响应体: \(responseBody)")
}
```
