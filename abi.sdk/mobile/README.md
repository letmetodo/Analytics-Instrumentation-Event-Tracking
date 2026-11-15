# ABI 移动端客户端 SDK 与交互式 Demo 指南 (`abi.sdk/mobile`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

本目录提供 ABI 用户行为分析（UBA）与 BI 平台的原生及跨平台移动客户端 SDK 实现与交互式演练页，全面对齐采集网关 `POST /collect/api/v1/track/batch` 协议契约（双 ID 身份映射、`> 2^53 - 1` 大整数精度保护、`#time` / `$time` 事件时间提取、秒表计时事件以及 `$user_*` 全套用户画像操作；*注：按 D7① / G6 门禁，`trackFirst` / `trackUpdate` / `trackOverwrite` 统一标注为当前版本未开放*）。

## 各平台专属文档导航

| 平台 | 核心实现与交互式 Demo | 专属文档（多语言） |
|------|-----------------------|-------------------|
| **Flutter (Dart)** | [`flutter/lib/abi_sdk.dart`](flutter/lib/abi_sdk.dart) · [`flutter/example/lib/main.dart`](flutter/example/lib/main.dart) | [简体中文](flutter/README.md) \| [English](flutter/README.en.md) \| [日本語](flutter/README.ja.md) |
| **Android (Kotlin)** | [`android/AbiAnalytics.kt`](android/AbiAnalytics.kt) · [`android/example/AbiDemoActivity.kt`](android/example/AbiDemoActivity.kt) | [简体中文](android/README.md) \| [English](android/README.en.md) \| [日本語](android/README.ja.md) |
| **iOS / macOS (Swift)** | [`ios/AbiAnalytics.swift`](ios/AbiAnalytics.swift) · [`ios/example/AbiDemoViewController.swift`](ios/example/AbiDemoViewController.swift) | [简体中文](ios/README.md) \| [English](ios/README.en.md) \| [日本語](ios/README.ja.md) |

---

## 接入人员视角：哪些字段必填、哪些由 SDK 自动采集、哪些由服务端/网关补充（如 IP）

站在移动端（Flutter / Android / iOS）与跨端接入研发人员的视角，可将所有埋点字段清晰划分为以下三类：

### 字段职责全景对照表

| 字段分类 | 阶段 / 字段名 | 是否需要客户端手填 | 来源与处理机制 |
|----------|---------------|--------------------|----------------|
| **第一类：接入人员【必须主动传入】的必填项** | **初始化 (`init` / `initialize`)**：`serverUrl`、`projectId` (`> 0`)、`projectToken` / `token` | **必填** | 指定 `:8081` 采集网关地址、归属项目 ID（`> 0`）与非空项目密钥。 |
| | **事件埋点 (`track`)**：`eventName` | **必填** | 业务事件名（如 `'OrderPaid'`），自定义业务属性通过 `properties` 按需传入。 |
| | **账号登录 (`login`)**：`accountId`（即 `login_id`） | **实名登录时必传** | 用户完成实名登录时调用 `login(accountId)` 纯本地更新并持久化 `login_id`（上限 128 UTF-8 字节，绝不覆盖 `distinct_id`，不自动触发网络事件）；退出登录调用 `logout()` 清空 `login_id`。 |
| | **更新 / 重写事件 (`trackUpdate` / `trackOverwrite`)**：`eventId` | **当前版本未开放** | 严守 D7① / G6 门禁，当前 StarRocks `dwd_events` 存储模型尚未开放 `trackFirst` / `trackUpdate` / `trackOverwrite`。 |
| **第二类：SDK【自动生成并持久化】，客户端【无需手填】** | `distinct_id` | **无需手填** | 初始化时自动生成 UUIDv4 并持久化至本地存储 `distinct_id` 键（`localStorage` / `SharedPreferences` / `UserDefaults`）；仅在调用 `identify(distinctId)` 时显式覆盖，调用 `login` 绝不覆盖 `distinct_id`。 |
| | `event_id` | **无需手填** | 每次 `track` 自动生成 UUIDv4，且在弱网/离线重试时保持幂等不变。 |
| | `timestamp` | **无需手填** | 自动取客户端当前毫秒时间戳（除非通过 `#time` / `$time` 显式指定历史事件时间）。 |
| | 设备与环境预置属性：`$lib`、`$lib_version`、`$os`、`$os_version`、`$device_model`、`$screen_width`、`$screen_height`、`$url`、`$title`、`$referrer`、`$zone_offset` | **无需手填** | SDK 自动采集并合并（`$user_*` 画像事件自动隔离预置属性与公共属性）。 |
| **第三类：客户端【拿不到也无需传】，由网关/服务端补充** | **公网 IP 与地域信息 (`#ip` / `$ip` $\rightarrow$ 国家/省/市)** | **客户端严禁手填** | 客户端直连 `:8081` 网关时，由网关自动从 HTTP 连接（及 `X-Forwarded-For` / `X-Real-IP`）提取真实客户端 IP，并由 Flink 自动解析国家、省份、城市。 |

### 三类字段核心说明与前后端打通建议

1. **第一类：接入人员【必须主动传入】的必填项**
   - **初始化阶段 (`init` / `initialize`)**：`serverUrl`（采集网关地址）、`projectId`（`> 0`）、`token` / `projectToken`（非空项目密钥）。
   - **埋点调用阶段 (`track`)**：`eventName`（必填，如 `'OrderPaid'`）。
   - **账号登录阶段 (`login`)**：用户完成实名登录时传入 `accountId`（即 `login_id`），纯本地持久化 `login_id`（不覆盖 `distinct_id`、不发送额外事件），后续事件自动同时携带 `distinct_id` 与 `login_id` 供后端进行实名与访客身份关联。
   - **同日重试幂等标识 (`track` 可选 `eventId`)**：如需同日重试幂等，可在 `track` 中显式传入确定性 `eventId`（严守 D7① / G6 门禁，当前版本未开放 `trackFirst` / `trackUpdate` / `trackOverwrite`）。
2. **第二类：SDK【自动生成并持久化】，前端/客户端开发【无需手填】的字段**
   - **`distinct_id`（访客/设备 ID）**：初始化时自动生成 UUIDv4 并持久化至本地存储 `distinct_id` 键（`localStorage` / `SharedPreferences` / `UserDefaults`），上限 64 UTF-8 字节；登录账号 `login` 仅设置 `login_id`，绝不覆盖 `distinct_id`。
   - **`event_id`**：每次 `track` 自动生成 UUIDv4，且在弱网/离线重试时保持幂等不变。
   - **`timestamp`**：自动取客户端当前毫秒时间戳（除非通过 `#time` / `$time` 显式指定历史事件时间）。
   - **设备与环境预置属性**：`$lib`、`$lib_version`、`$os`、`$os_version`、`$device_model`、`$screen_width`、`$screen_height`、`$url`、`$title`、`$referrer`、`$zone_offset`。
3. **第三类：客户端【拿不到也无需传】，由采集网关/服务端负责获取的字段（重点：`IP` 与前后端打通）**
   - **公网 IP 与地域信息 (`#ip` / `$ip` $\rightarrow$ 国家/省/市)**：浏览器 JS、小程序与移动端 App 处于客户端沙箱及 NAT 路由后，**本身拿不到真实的公网出口 IP，因此客户端接入时绝对不需要传 `$ip` / `#ip`**！当客户端直连 `:8081` 采集网关时，网关会自动从 HTTP 连接（及 Nginx/SLB 的 `X-Forwarded-For` / `X-Real-IP`）提取真实客户端 IP 并由 Flink 自动解析国家、省份、城市。
   - **注意：何时需要传 IP？** 只有当业务采用「客户端先调业务后端 API，再由 Go/Java 服务端 SDK 代报埋点」时，因为网关看到的是后端机房 IP，才需要由业务后端从客户端请求中提取 IP 并通过 `#ip` / `$ip` 传给服务端 SDK。同时建议移动端/前端调用业务后端接口时在 Header 携带访客标识 `distinct_id`（Flutter `sdk.distinctId` / Android `sdk.distinctId` / iOS `sdk.distinctId` / Web `abi.getDistinctId()`），方便服务端关联前后端漏斗。

---

所有移动端 UI Demo 与无界面方法级 Demo 均与 Web [`../ts-web/examples/interactive-demo.html`](../ts-web/examples/interactive-demo.html) 保持完全一致的**两步式联调交互契约**（彻底取消无限追加的历史事件日志刷屏）：

1. **第 1 步：配置参数并原地实时预览唯一一份具体请求 JSON**
   - 初始化时通过 `autoFlush = false` 禁用后台定时器与 `batchSize` 自动触发发送；
   - 切换身份（`identify` / `login` / `logout`）或修改静态/动态公共属性时，自动清空待发队列并重算当前待提交事件的请求体 JSON，原地刷新唯一预览框，绝不刷屏追加日志；
   - 支持单条事件覆盖预览与 **「多条拼批模式」**（勾选后将多次点击的事件追加至同一请求体的 `events` 数组）。
2. **第 2 步：点击「确认提交」按钮发送并查看单份响应**
   - 仅当点击显式的 **「确认提交」** 主按钮时才调用 `flush()` 发送 `POST /collect/api/v1/track/batch`，并在下方响应面板展示最近一次提交状态与返回结果。

> **跨端小程序与 React Native 说明**：微信小程序适配器（[`../ts-web/src/adapters/miniapp.ts`](../ts-web/src/adapters/miniapp.ts)）与 React Native 适配器（[`../ts-web/src/adapters/react-native.ts`](../ts-web/src/adapters/react-native.ts)）复用 TypeScript 核心校验与持久化队列引擎，演练示例见 [`../ts-web/examples/usage-examples.ts`](../ts-web/examples/usage-examples.ts)。

---

## 1. 目录结构一览

```text
abi.sdk/mobile/
├── README.md                                 # 移动端 SDK 与两步式交互 Demo 中文总览（本文档）
├── README.en.md                              # 移动端 SDK 与两步式交互 Demo 英文总览
├── README.ja.md                              # 移动端 SDK 与两步式交互 Demo 日文总览
├── flutter/
│   ├── README.md / README.en.md / README.ja.md
│   ├── lib/abi_sdk.dart                      # Flutter / Dart 核心 SDK（AbiConfig、AbiAnalytics）
│   └── example/lib/main.dart                 # Material 3 参数配置 + 请求 JSON 预览 + 确认提交演练页
├── android/
│   ├── README.md / README.en.md / README.ja.md
│   ├── AbiAnalytics.kt                       # Android Kotlin 零第三方依赖核心 SDK
│   └── example/AbiDemoActivity.kt            # 原生 ScrollView 两步式交互演练页与无界面预览/提交方法
└── ios/
    ├── README.md / README.en.md / README.ja.md
    ├── AbiAnalytics.swift                    # iOS / macOS Swift 线程安全核心 SDK
    └── example/AbiDemoViewController.swift   # SwiftUI 两步式交互演练视图与 AbiSdkDemoRunner
```

---

## 2. 核心预览与手动提交控制接口

三端 SDK 均默认保持生产环境 `autoFlush = true`（周期定时 + 阈值自动批量发送）；在交互式联调演练或断点审查场景下，将 `autoFlush` 设为 `false` 即可配合队列预览接口精确检查完整请求体：

| 平台 | 禁用自动发送配置 | 清空待发队列 | 构建完整 `POST /collect/api/v1/track/batch` 请求体 | 手动确认提交 |
|------|------------------|--------------|---------------------------------------------------|--------------|
| **Flutter** | `AbiConfig(..., autoFlush: false)` | `sdk.clearPendingQueue()` | `sdk.buildPendingBatchPayload()` (`Map<String, dynamic>`) | `await sdk.flush()` |
| **Android Kotlin** | `AbiAnalytics.init(..., autoFlush = false)` | `sdk.clearPendingQueue()` | `sdk.buildPendingBatchPayload()` (`JSONObject`) | `sdk.flush()` |
| **iOS Swift** | `sdk.initialize(..., autoFlush: false)` | `sdk.clearPendingQueue()` | `sdk.buildPendingBatchPayload()` / `sdk.buildPendingBatchJsonString()` | `sdk.flush(completion:)` |

---

## 3. 三端交互式 UI Demo 详解

三个客户端 UI Demo 统一采用 **「上方四组参数配置区 + 下方双面板（面板 A 待提交请求 JSON 预览 / 面板 B 最近一次提交结果）」** 布局：

### 3.1 Flutter 交互式 Demo（[`flutter/example/lib/main.dart`](flutter/example/lib/main.dart)）

- **上方参数配置区**：
  - **状态摘要卡片**：实时展示 `distinct_id`（访客标识）、`login_id`（登录账号 ID）、`superProperties` 与动态公共属性启用状态。
  - **`1. 身份与会话参数`**：`切换随机访客 ID (identify)`、`设置登录账号 (login)`、`退出登录 (logout)`（纯本地状态切换，原地同步下方预览 JSON）。
  - **`2. 公共属性配置`**：可编辑静态公共属性 JSON `TextField` + `应用静态公共属性` + `启用动态公共属性：开/关` + `清空公共属性`（修改后仅原地重算待提交请求 JSON，不追加任何历史日志）。
  - **「多条拼批模式」开关**（`SwitchListTile`）：关闭时每次点击事件按钮只预览当前单条事件；开启时连续点击会追加到 `events` 数组。
  - **`3. 行为事件参数构建`**：`商品浏览事件 (ProductView)`、`① 开始事件计时 (timeEvent)`、`② 上报支付事件 ($duration)`、`64 位雪花大整数 (> 2^53-1)`、`固定 eventId 幂等事件 (OrderSettled)`。
  - **`4. 用户画像操作参数构建 ($user_*)`**：`userSet`、`userSetOnce`、`userAdd (+100)`、`userAppend`、`userUniqAppend`、`userUnset`、`userDelete`（自动隔离公共属性）。
- **下方固定双面板**：
  - **面板 A：`待提交请求 JSON 预览 (POST /collect/api/v1/track/batch)`**：格式化展示完整 `{ project_id, project_token, dry_run, events }` 报文，配备 `重置待发参数` 与醒目的 **「确认提交」** 主按钮。
  - **面板 B：`最近一次提交结果 (Response)`**：仅在点击「确认提交」执行 `await _sdk.flush()` 后刷新单次 HTTP 状态与网关返回结果。

---

### 3.2 Android Kotlin 交互式 Demo（[`android/example/AbiDemoActivity.kt`](android/example/AbiDemoActivity.kt)）

- **纯代码零 XML 依赖**：采用原生 `ScrollView` + `LinearLayout` 构建，拷入任意 Android 工程即可直接运行（默认网关 `http://10.0.2.2:8081`）。
- **参数构建与原地预览**：
  - 提供身份配置按钮组、静态公共属性 JSON `EditText`（含 `应用静态公共属性` / `启用动态公共属性：开/关` / `清空公共属性`）、`CheckBox("多条拼批模式")`、6 个行为事件构建按钮与 7 个 `$user_*` 画像构建按钮。
  - 任意参数变更均调用 `sdk.buildPendingBatchPayload().toString(2)` 原地刷新唯一的 **面板 A：待提交请求 JSON 预览** `TextView`。
- **确认提交与单份响应**：
  - 点击 **「确认提交」** 按钮后在工作线程执行 `sdk.flush()`，完成后切回主线程更新唯一的 **面板 B：最近一次提交结果** `TextView`；点击 `重置待发参数` 可一键恢复默认单条待发预览。

---

### 3.3 iOS Swift 交互式 Demo（[`ios/example/AbiDemoViewController.swift`](ios/example/AbiDemoViewController.swift)）

- **跨平台 SwiftUI 视图（`AbiSdkDemoView`，支持 iOS 15.0+ / macOS 12.0+）**：
  - 包含顶部实时身份与公共属性看板、`1. 身份与会话参数`、带 JSON 编辑框的 `2. 公共属性配置`、`多条拼批模式` `Toggle`、`3. 行为事件参数构建` 与 `4. 用户画像操作参数构建 ($user_*)`。
  - 每次修改公共属性、切换身份或点击事件，均调用 `sdk.buildPendingBatchJsonString()` 原地更新唯一的 **面板 A：待提交请求 JSON 预览** 等宽代码框。
  - 点击醒目的绿色 **「确认提交」** 按钮后执行 `sdk.flush { statusCode, rawBody in ... }`，仅在请求返回后更新底部的 **面板 B：最近一次提交结果** 框。

---

## 4. 两步式无界面方法级 Demo（构建预览 JSON -> 确认提交）

在单元测试、CI 流水线或命令行脚本联调场景下，三端均提供统一的两步式方法级入口：**先生成并检查具体待发请求 JSON，再显式调用确认提交**。

### 4.1 Flutter (`previewScenarioPayload` + `confirmSubmit`)
```dart
import 'package:your_app/abi_sdk.dart';

Future<void> verifyAbiFlutterSdk() async {
  final sdk = AbiAnalytics.instance;

  // 第 1 步：构建全场景埋点参数并预览完整 POST /collect/api/v1/track/batch 请求体 JSON
  final requestJson = sdk.previewScenarioPayload(
    serverUrl: 'http://localhost:8081',
    projectId: 1,
    projectToken: 'abi_tok_demo_flutter',
    dryRun: true,
  );
  print('待提交请求 JSON:\n$requestJson');

  // 第 2 步：确认提交并查看单次结果
  final ok = await sdk.confirmSubmit();
  print('确认提交结果: ok=$ok, status=${sdk.lastStatusCode}, body=${sdk.lastResponseBody}');
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

// 第 1 步：构建双 ID、公共属性、计时事件、>2^53-1 大整数、固定 eventId 里程碑事件与 $user_* 请求体并预览
val requestJson: String = AbiDemoActivity.previewScenarioPayload(sdk)
println("待提交请求 JSON:\n$requestJson")

// 第 2 步：在工作线程确认提交并获取单次响应摘要 JSON
val responseSummaryJson: String = AbiDemoActivity.confirmSubmit(sdk)
println("最近一次提交结果:\n$responseSummaryJson")
```

### 4.3 iOS Swift (`AbiSdkDemoRunner.previewScenarioJson` + `confirmSubmit`)
```swift
// 第 1 步：以 autoFlush = false 构建并返回格式化后的待提交请求 JSON 字符串
let requestJson = AbiSdkDemoRunner.previewScenarioJson(
    serverUrl: "http://localhost:8081",
    projectId: 1,
    projectToken: "abi_tok_ios_demo"
)
print("待提交请求 JSON:\n\(requestJson)")

// 第 2 步：确认提交并接收单次 HTTP 响应回调
AbiSdkDemoRunner.confirmSubmit { statusCode, responseBody in
    print("提交完成: HTTP \(statusCode), 响应体: \(responseBody)")
}
```

---

## 5. 宿主工程接入步骤与本地验证

### 5.1 前置准备：启动本地采集网关（可选）
若需验证真实端到端 HTTP 200 响应，可在仓库根目录启动 `abi.srv` 采集网关（`:8081`）：
```bash
cd abi.srv && ENV=dev go run ./cmd/gateway/
```
> 即使本地未启动 `:8081` 网关，各端 SDK 也会安全捕获连接异常并将事件保留在内存缓冲队列中（保留原始 `event_id` 等待下次幂等重试），并在「最近一次提交结果」面板清晰提示未连接状态。

### 5.2 Flutter 宿主工程接入步骤
1. 将 [`flutter/lib/abi_sdk.dart`](flutter/lib/abi_sdk.dart) 复制到宿主 Flutter 工程的 `lib/` 目录（纯 Dart 标准库实现，无额外第三方插件依赖）。
2. 如需挂载交互式演练页，将 [`flutter/example/lib/main.dart`](flutter/example/lib/main.dart) 作为入口页面挂载 `const AbiSdkDemoApp()`，并确认 `import` 路径指向宿主工程内的 `abi_sdk.dart`。
3. 网络配置提示：iOS 模拟器或 macOS 桌面端可直接访问 `http://localhost:8081`；Android 模拟器请将 `serverUrl` 改为 `http://10.0.2.2:8081`。详细 API 说明见 [`flutter/README.md`](flutter/README.md)。

### 5.3 Android Kotlin 宿主工程接入步骤
1. 将 [`android/AbiAnalytics.kt`](android/AbiAnalytics.kt)（及可选演练页 [`android/example/AbiDemoActivity.kt`](android/example/AbiDemoActivity.kt)）复制到宿主 App 模块对应的源码包路径下（包名为 `com.anylink.abi.sdk.android`）。
2. 在宿主工程 `AndroidManifest.xml` 中声明网络权限；若联调本地明文 HTTP 网关（`http://10.0.2.2:8081`），请在开发环境开启明文流量支持并注册 `AbiDemoActivity`：
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
3. 生产环境在 `Application.onCreate()` 中调用 `AbiAnalytics.init(...)`（默认 `autoFlush = true`）；交互式联调面板通过 `Intent(context, AbiDemoActivity::class.java)` 打开。详细 API 说明见 [`android/README.md`](android/README.md)。

### 5.4 iOS Swift 宿主工程接入步骤与静态编译验证
1. 将 [`ios/AbiAnalytics.swift`](ios/AbiAnalytics.swift)（及可选演练视图 [`ios/example/AbiDemoViewController.swift`](ios/example/AbiDemoViewController.swift)）拖入 Xcode 宿主工程 Target 的 `Compile Sources` 中。
2. 若在模拟器或真机连接本地 HTTP 网关（`http://localhost:8081`），请在开发环境 `Info.plist` 的 `NSAppTransportSecurity` 下开启 `NSAllowsLocalNetworking = YES`。
3. 在 SwiftUI 入口中直接挂载 `AbiSdkDemoView()`（UIKit 工程可通过 `UIHostingController(rootView: AbiSdkDemoView())` 压栈展示）。详细 API 说明见 [`ios/README.md`](ios/README.md)。
4. **命令行静态类型检查验证**：无需打开 Xcode，可在 macOS 终端直接运行 `swiftc` 验证 SDK 与 SwiftUI Demo 零错误通过：
   ```bash
   swiftc -typecheck abi.sdk/mobile/ios/AbiAnalytics.swift abi.sdk/mobile/ios/example/AbiDemoViewController.swift
   ```
