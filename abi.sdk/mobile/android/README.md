# ABI Android Kotlin 客户端 SDK 文档 (`abi.sdk/mobile/android`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

[`AbiAnalytics.kt`](AbiAnalytics.kt) 是面向原生 Android 应用的零第三方依赖数据采集分析 SDK，基于 Android 原生框架与 Java 标准库（`HttpURLConnection`、`org.json`、`ConcurrentLinkedQueue`、`SystemClock.elapsedRealtime`）实现，全面对齐 ABI 采集网关 `POST /collect/api/v1/track/batch` 协议契约与 ThinkingData v3.4 规范。

> 返回移动端总览：[简体中文](../README.md) | [English](../README.en.md) | [日本語](../README.ja.md)

---

## 接入人员视角：哪些字段必填、哪些由 SDK 自动采集、哪些由服务端/网关补充（如 IP）

站在 Android 客户端接入研发人员的视角，日常集成时可将所有埋点字段划分为以下三类：

| 字段分类 | 阶段 / 字段名 | 是否需要客户端手填 | 来源与处理机制 |
|----------|---------------|--------------------|----------------|
| **第一类：接入人员【必须主动传入】的必填项** | **初始化 (`init` / `initialize`)**：`serverUrl`、`projectId` (`> 0`)、`projectToken` / `token` | **必填** | 调用 `AbiAnalytics.init` 指定 `:8081` 采集网关地址、归属项目 ID（`> 0`）与非空项目密钥。 |
| | **事件埋点 (`track`)**：`eventName` | **必填** | 业务事件名（如 `"OrderPaid"`），自定义业务属性通过 `properties` 按需传入。 |
| | **账号登录 (`login`)**：`accountId`（即 `login_id`） | **实名登录时必传** | 用户完成实名登录时调用 `login(accountId)` 纯本地更新并持久化 `login_id`（上限 128 UTF-8 字节，绝不覆盖 `distinct_id`，不自动触发网络事件）。 |
| | **更新 / 重写事件 (`trackUpdate` / `trackOverwrite`)**：`eventId` | **当前版本未开放** | 严守 D7① / G6 门禁，当前 StarRocks `dwd_events` 存储模型尚未开放 `trackFirst` / `trackUpdate` / `trackOverwrite`。 |
| **第二类：SDK【自动生成并持久化】，客户端【无需手填】** | `distinct_id` | **无需手填** | 初始化时自动生成 UUIDv4 并持久化至 `SharedPreferences` 的 `distinct_id` 键，仅通过 `identify` 修改，不受 `login` 覆盖。 |
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
   - **`distinct_id`（访客/设备 ID）**：初始化时自动生成 UUIDv4 并持久化至 `SharedPreferences` 的 `distinct_id` 键（上限 64 UTF-8 字节），登录时绝不被 `login_id` 覆盖。
   - **`event_id`**：每次 `track` 自动生成 UUIDv4，且在弱网/离线重试时保持幂等不变。
   - **`timestamp`**：自动取客户端当前毫秒时间戳（除非通过 `#time` / `$time` 显式指定历史事件时间）。
   - **设备与环境预置属性**：`$lib`、`$lib_version`、`$os`、`$os_version`、`$device_model`、`$screen_width`、`$screen_height`、`$url`、`$title`、`$referrer`、`$zone_offset`。
3. **第三类：客户端【拿不到也无需传】，由采集网关/服务端负责获取的字段（重点：`IP` 与前后端打通）**
   - **公网 IP 与地域信息 (`#ip` / `$ip` $\rightarrow$ 国家/省/市)**：浏览器 JS、小程序与移动端 App 处于客户端沙箱及 NAT 路由后，**本身拿不到真实的公网出口 IP，因此客户端接入时绝对不需要传 `$ip` / `#ip`**！当客户端直连 `:8081` 采集网关时，网关会自动从 HTTP 连接（及 Nginx/SLB 的 `X-Forwarded-For` / `X-Real-IP`）提取真实客户端 IP 并由 Flink 自动解析国家、省份、城市。
   - **注意：何时需要传 IP？** 只有当业务采用「客户端先调业务后端 API，再由 Go/Java 服务端 SDK 代报埋点」时，因为网关看到的是后端机房 IP，才需要由业务后端从客户端请求中提取 IP 并通过 `#ip` / `$ip` 传给服务端 SDK。同时建议移动端调用业务后端接口时在 Header 携带访客标识（`sdk.distinctId`），方便服务端关联前后端漏斗。

---

## 1. 集成方式与环境配置

### 1.1 源码集成（零第三方 Gradle 依赖）
1. 将 [`AbiAnalytics.kt`](AbiAnalytics.kt) 复制到宿主 Android 工程对应的源码包目录 `com/anylink/abi/sdk/android/` 下（无需引入 OkHttp、Gson 等任何第三方库）。
2. 如需使用内置交互式演练页或无界面演练方法，将 [`example/AbiDemoActivity.kt`](example/AbiDemoActivity.kt) 复制到 `com/anylink/abi/sdk/android/example/` 下。

### 1.2 `AndroidManifest.xml` 权限与网络配置
在宿主模块的 `AndroidManifest.xml` 中声明 `INTERNET` 权限；若在 Android 模拟器中联调宿主机本地明文 HTTP 网关（`http://10.0.2.2:8081`），请在开发环境开启 `android:usesCleartextTraffic="true"` 并注册 `AbiDemoActivity`：

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.yourcompany.app">

    <!-- 必须声明网络访问权限 -->
    <uses-permission android:name="android.permission.INTERNET" />

    <application
        android:usesCleartextTraffic="true"
        ...>
        <!-- 可选：注册两步式交互联调演练 Activity -->
        <activity
            android:name="com.anylink.abi.sdk.android.example.AbiDemoActivity"
            android:exported="true"
            android:label="ABI Android SDK Demo" />
    </application>
</manifest>
```

---

## 2. 初始化与核心 API 速查

### 2.1 SDK 初始化 (`AbiAnalytics.init` & `AbiAnalytics.getInstance`)

建议在 `Application.onCreate()` 中初始化全局单例（同时带 `@JvmStatic` 与 `@JvmOverloads` 注解，完全兼容 Java 与 Kotlin 调用）：

```kotlin
import com.anylink.abi.sdk.android.AbiAnalytics

val sdk = AbiAnalytics.init(
    serverUrl = "http://10.0.2.2:8081", // Android 模拟器访问宿主机 :8081 网关地址
    projectId = 1L,
    projectToken = "abi_tok_android_demo",
    appVersion = "2.1.0",
    batchSize = 20,
    debug = false,
    autoFlush = true // 生产环境默认 true（5 秒定时 + batchSize 阈值自动上报）；两步式交互预览时设为 false
)

// 在任意位置获取已初始化的单例
val sharedSdk = AbiAnalytics.getInstance()
```

| `init` 参数 | 类型 | 默认值 | 说明 |
|-------------|------|--------|------|
| `serverUrl` | `String` | 必填 | 采集网关基础地址（自动拼接 `/collect/api/v1/track/batch`） |
| `projectId` | `Long` | 必填 | ABI 归属项目 ID (`project_id`) |
| `projectToken` | `String` | 必填 | 项目接入令牌 (`project_token`) |
| `appVersion` | `String` | `"1.0.0"` | 宿主应用版本号，自动写入事件预置属性 `$app_version` |
| `batchSize` | `Int` | `20` | 触发后台自动批量发送的队列条数阈值 |
| `debug` | `Boolean` | `false` | 调试模式（开启后在请求体附加 `"debug": true` 并即时触发上报） |
| `autoFlush` | `Boolean` | `true` | 是否启动 5 秒周期后台定时线程与阈值自动上报（设为 `false` 时由调用方手动 `flush()`） |

---

### 2.2 双标识身份管理 (`identify` / `login` / `logout`)

SDK 通过 `@Volatile` 保证多线程读写安全，严格对齐数数科技（ThinkingData）规范，上报报文仅包含 `distinct_id`（访客/设备 ID，上限 64 UTF-8 字节）与 `login_id`（登录账号 ID，上限 128 UTF-8 字节）两个身份字段：
- `distinctId`：当前访客/设备标识（初始化自动生成 UUIDv4，若传入 `context` 则自动持久化至 `SharedPreferences` 的 `distinct_id` 键）。
- `loginId`：当前登录账号标识（未登录时为空字符串 `""`）。
- `identify(customDistinctId: String)`：自定义覆盖访客/设备标识（自动过滤首尾空白并校验无控制字符及 ≤ 64 UTF-8 字节，纯本地更新，不发送网络事件）。
- `login(accountId: String)`：设置实名登录账号标识（上限 128 UTF-8 字节，纯本地更新并持久化，**绝不覆盖 `distinctId`**，**绝不发送任何网络事件**，返回 `Unit`）。
- `logout()`：清空 `loginId`，保持 `distinctId` 不变（不发送网络事件）。

```kotlin
sdk.identify("android_visitor_device_001")
sdk.login("user_android_10001") // 纯本地状态更新，不发送额外网络事件
println("distinctId=${sdk.distinctId}, loginId=${sdk.loginId}")
sdk.logout()
```

---

### 2.3 静态与动态公共属性 (`Super Properties`)

公共属性存储在线程安全的 `ConcurrentHashMap` 中，自动合并到后续所有普通行为与系统事件中（**自动隔离 `$user_*` / `#user_*` 用户画像事件**）。优先级为：`单次事件 properties > 动态公共属性 > 静态公共属性 > SDK 预置系统属性（$os/$model/$manufacturer 等）`。

| 方法签名 | 说明 |
|----------|------|
| `setSuperProperties(props: Map<String, Any>)` | 注册或合并全局静态公共属性 |
| `unsetSuperProperty(key: String)` | 按属性名移除单个静态公共属性 |
| `clearSuperProperties()` | 清空所有已注册的静态公共属性 |
| `getSuperProperties(): Map<String, Any>` | 获取当前静态公共属性的不可变拷贝快照 |
| `setDynamicSuperProperties(provider: (() -> Map<String, Any?>)?)` | 注册（或传 `null` 移除）动态公共属性回调，每次 `track` 时实时求值 |

```kotlin
sdk.setSuperProperties(mapOf("channel" to "GooglePlay", "vip_tier" to "Gold"))
sdk.unsetSuperProperty("vip_tier")
val snapshot = sdk.getSuperProperties()

sdk.setDynamicSuperProperties {
    mapOf("network_state" to "wifi", "dyn_sequence" to 1)
}
```

---

### 2.4 事件计时与同日幂等事件采集 (`timeEvent` / `track`)

- **单调时钟计时事件 (`timeEvent`)**：基于 `SystemClock.elapsedRealtime()` 记录起点（不受用户手动修改系统墙钟影响）；下一次上报同名 `track` 事件时自动计算并注入秒级 `Double` 属性 `$duration`。
- **普通事件 (`track`)**：校验事件名与属性键名合法性后入队，返回幂等 `event_id`；核心交易或里程碑事件可显式传入确定性 `eventId` 实现同日全量载荷重试幂等去重。
- **未开放接口门禁 (`trackFirst` / `trackUpdate` / `trackOverwrite`)**：严守 D7① / G6 门禁，当前 StarRocks `dwd_events` 存储模型未开放 `$first_check_id` 首次去重及 `trackUpdate` / `trackOverwrite` 可变事件（调用 `trackUpdate` / `trackOverwrite` 将直接抛出 `UnsupportedOperationException` 且绝不入队伪造普通 `track` 事件）；订单状态流转请按独立里程碑事件建模。

```kotlin
// 1. 单调时钟事件计时与普通事件采集
sdk.timeEvent("OrderPaid")
val orderEvtId = sdk.track(
    eventName = "OrderPaid",
    properties = mapOf(
        "order_id" to "ord_9001",
        "amount" to 199.95,
        "currency" to "CNY"
    )
)

// 2. 同日固定 eventId 里程碑事件（网络重试保持完整相同载荷幂等）
sdk.track(
    eventName = "OrderSettled",
    properties = mapOf(
        "order_id" to "ord_9001",
        "order_status" to "settled",
        "amount" to 199.95
    ),
    eventId = "ord_settled_9001"
)
```

---

### 2.5 7 类用户画像操作 (`$user_*`)

所有画像方法对应 StarRocks `abi.dim_users` 维表，SDK 会**自动剥离系统设备预置属性与静态/动态公共属性**：

| 方法签名 | 对应系统事件 | 说明 |
|----------|--------------|------|
| `userSet(properties: Map<String, Any?>)` | `$user_set` | 覆盖设置用户画像属性 |
| `userSetOnce(properties: Map<String, Any?>)` | `$user_set_once` | 首次设置用户画像属性（仅当字段尚未赋值时生效） |
| `userAdd(properties: Map<String, Number>)` | `$user_add` | 原子累加数值型用户画像属性（负数代表扣减） |
| `userAppend(properties: Map<String, List<Any>>)` | `$user_append` | 向列表类型画像属性追加元素（不去重） |
| `userUniqAppend(properties: Map<String, List<Any>>)` | `$user_uniq_append` | 向列表类型画像属性去重追加元素 |
| `userUnset(vararg keys: String)` | `$user_unset` | 清空指定的用户画像属性键（支持可变参数） |
| `userDelete()` | `$user_del` | 标记删除当前主体的用户画像记录 |

```kotlin
sdk.userSet(mapOf("vip_level" to "Platinum", "city" to "Shanghai"))
sdk.userSetOnce(mapOf("first_install_channel" to "GooglePlay"))
sdk.userAdd(mapOf("loyalty_points" to 100))
sdk.userAppend(mapOf("interests" to listOf("analytics", "kotlin")))
sdk.userUniqAppend(mapOf("interests" to listOf("kotlin", "starrocks")))
sdk.userUnset("temp_campaign_flag", "expired_badge")
sdk.userDelete()
```

---

### 2.6 `> 2^53 - 1` 大整数精度保护与 `#time` / `$time` 时间提取

1. **`> 2^53 - 1` 大整数精度保护**：
   - IEEE-754 双精度浮点数安全整数上限为 `9007199254740991L`（$2^{53}-1$，`AbiAnalytics.MAX_SAFE_INTEGER`）。
   - 当属性（或列表元素）中的 `Long` 值超出 `[-9007199254740991L, 9007199254740991L]`（含 `Long.MIN_VALUE`，如 64 位雪花 ID `9007199254740993L`）时，SDK 会自动将其转为十进制字符串 `"9007199254740993"` 写入 JSON，避免前端或跨端解析丢失精度。
2. **`#time` / `$time` 事件发生时间提取**：
   - 除显式传入 `timestampMs: Long?` 外，若 `properties` 中包含 `"#time"` 或 `"$time"`（`"#time"` 优先于 `"$time"`），SDK 会在属性键名校验前将其提取为事件顶层毫秒 `timestamp`，并**从 `properties` 中剥离**。
   - 支持的时间类型：`java.util.Date`、10 位秒级或 13 位毫秒级 `Long`/`Int`/`Short`/`Double`/`Float`、纯数字时间戳字符串（10~16 位）以及标准 ISO-8601 日期时间字符串（支持毫秒与时区偏移）。

```kotlin
sdk.track(
    eventName = "OrderPaid",
    properties = mapOf(
        "#time" to "2026-11-10T08:30:00.000+08:00", // 自动提取为顶层毫秒 timestamp 并从 properties 移除
        "snowflake_seq" to 9007199254740993L        // > 2^53 - 1，自动转为字符串 "9007199254740993"
    )
)
```

---

## 3. 两步式交互演练页与无界面调用示例

### 3.1 两步式 UI 演练页 ([`example/AbiDemoActivity.kt`](example/AbiDemoActivity.kt))

`AbiDemoActivity` 采用纯 Kotlin 原生 `ScrollView` + `LinearLayout` 编写（零 XML 布局文件依赖），严格执行**两步式预览与确认提交契约**：
1. **第 1 步：配置参数并实时预览单份请求 JSON (`autoFlush = false` + `buildPendingBatchPayload`)**
   - `onCreate` 中以 `autoFlush = false` 初始化 SDK，彻底禁用后台定时器与阈值自动触发。
   - 切换身份（`identify` / `login` / `logout`）、编辑静态公共属性 JSON、切换动态公共属性开关、勾选 **「多条拼批模式」** 或点击任意事件/画像按钮时，均通过 `sdk.clearPendingQueue()` 重算当前动作并通过 `sdk.buildPendingBatchPayload().toString(2)` 原地刷新 **面板 A：待提交请求 JSON 预览**，绝不追加历史日志刷屏。
2. **第 2 步：点击「确认提交」发送 (`flush`)**
   - 仅当点击绿色的 **「确认提交」** 按钮时，才在工作线程调用 `sdk.flush()` 发送请求，完成后切回主线程更新 **面板 B：最近一次提交结果 (Response)**（展示 `lastFlushStatusCode` 与 `lastFlushResponseBody`）。

### 3.2 两步式无界面方法级调用 (`previewScenarioPayload` + `confirmSubmit`)

在 JUnit 单元测试、仪器化测试或后台调试脚本中，可直接调用 `AbiDemoActivity` 伴生对象提供的两步式静态方法：

```kotlin
import com.anylink.abi.sdk.android.AbiAnalytics
import com.anylink.abi.sdk.android.example.AbiDemoActivity

fun runHeadlessTwoStepDemo() {
    val sdk = AbiAnalytics.init(
        serverUrl = "http://10.0.2.2:8081",
        projectId = 1L,
        projectToken = "abi_tok_android_demo",
        autoFlush = false
    )

    // 第 1 步：配置双 ID、静态/动态公共属性、计时事件、>2^53-1 大整数、固定 eventId 里程碑事件与 7 类 $user_* 画像，
    // 返回格式化后的 POST /collect/api/v1/track/batch 请求体 JSON 字符串（不自动触发发送）
    val pendingRequestJson: String = AbiDemoActivity.previewScenarioPayload(sdk)
    println("=== 第 1 步：待提交请求 JSON 预览 ===\n$pendingRequestJson")

    // 第 2 步：在工作线程确认提交并获取单次响应摘要 JSON（包含 http_status、submitted_count、response_body）
    val responseSummaryJson: String = AbiDemoActivity.confirmSubmit(sdk)
    println("=== 第 2 步：最近一次提交结果 ===\n$responseSummaryJson")
}
```
