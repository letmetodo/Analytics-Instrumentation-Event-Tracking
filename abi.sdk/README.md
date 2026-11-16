# ABI 多语言数据采集 SDK 套件 (`abi.sdk`)

**语言 / Language / 言語**: **[简体中文](README.md)** | [繁體中文](README.zh-TW.md) | [English](README.en.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Português](README.pt.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Русский](README.ru.md) | [Tiếng Việt](README.vi.md) | [ไทย](README.th.md) | [Bahasa Indonesia](README.id.md)

`abi.sdk` 为 ABI 用户行为分析（UBA）与商业智能（BI）平台提供生产级客户端与服务端数据采集 SDK。套件整体设计对标 [ThinkingData（数数科技）SDK v3.4 规范](https://docs.thinkingdata.cn/ta-manual/v3.4/installation/installation_menu/installation_menu.html)，在字段契约、身份映射与数据校验层面与后端采集网关 [`abi.srv`](../abi.srv/)（`:8081`）及流批一体处理引擎 [`abi.flink`](../abi.flink/)（Job1 实时 ETL 与 Job2 原始 ODS 入湖）严格对齐。

---

## 1. 目录结构、多语言文档索引与平台能力矩阵

| 目录 | 目标平台 / 语言包 | 多语言 README（中 / 英 / 日） | 核心能力覆盖 | 验证命令 |
|------|-------------------|-------------------------------|--------------|----------|
| [`RESTFUL_API.md`](RESTFUL_API.md) | 跨语言原生 HTTP RESTful API | [中文](RESTFUL_API.md) | 零 SDK 依赖直连采集网关指南：包含接口协议规范、全部采用格式化 JSON 的 `curl` 示例（单条/批量/双 ID 自动归因关联/同日重试幂等去重/7 类 `$user_*` 画像/Gzip 压缩/`debug` 与 `dry_run` 预检）及 Python / Node.js 原生调用示例 | 参见文档内 `curl` `dry_run: true` 在线联调命令 |
| [`spec/test-vectors/`](spec/test-vectors/) | 跨语言黄金测试向量契约 | — | 跨语言共享的 JSON 标准测试向量，覆盖身份标识归一化（64/128 字节 UTF-8 边界、Unicode 空白符裁剪、控制字符拦截）、事件与属性命名校验、大整数（`> 2^53 - 1`）精度保护及 `$user_*` 画像操作规范 | 由各端 SDK 单元测试套件统一加载断言 |
| [`ts-web/`](ts-web/) | Web / H5 / TypeScript（`@anylink/abi-web-sdk`）、App-H5 打通桥接、小程序/RN 及 H5 游戏引擎（Cocos Creator / Egret / LayaAir / Weex）适配器 | [中文](ts-web/README.md) · [EN](ts-web/README.en.md) · [JA](ts-web/README.ja.md)<br/>示例：[中文](ts-web/examples/README.md) · [EN](ts-web/examples/README.en.md) · [JA](ts-web/examples/README.ja.md) | 支持 `init`、`identify`、`login`、`logout`、`track`、`timeEvent`、`setSuperProperties`、`setDynamicSuperProperties`、全套 `$user_*` 画像更新、SPA 路由 `$pageview` 与 `$AppEnd` 自动采集、App-H5 WebView 桥接打通（`createH5AppBridgeAdapter`）、H5 游戏引擎适配（`createCocosCreatorAdapter` / `createEgretAdapter` / `createLayaAirAdapter` / `createWeexAdapter`）及页面关闭 `sendBeacon` 兜底上报（*注：按 D7① / G6 门禁，`trackFirst`/`trackUpdate`/`trackOverwrite` 统一标注为当前版本未开放*） | `cd abi.sdk/ts-web && pnpm test` |
| [`go/`](go/) | Go 服务端 SDK（`abi.sdk/go`） | [中文](go/README.md) · [EN](go/README.en.md) · [JA](go/README.ja.md)<br/>Demo：[中文](go/examples/demo/README.md) · [EN](go/examples/demo/README.en.md) · [JA](go/examples/demo/README.ja.md) | 并发安全的 `AbiAnalytics` 客户端，内置四种上报通道：`StagingConsumer`（两步式请求 JSON 预览与确认提交）、`BatchConsumer`（异步缓冲批量 HTTP + Gzip 压缩 + 指数退避重试）、`LoggerConsumer`（按天/按小时/按文件大小滚动的本地 JSONL 落盘）、`DebugConsumer`（同步 L4 强校验与 `dry_run` 演练验证） | `cd abi.sdk/go && go test -race ./...` |
| [`java/`](java/) | Java 11+ 服务端 SDK（`com.anylink.abi:abi-java-sdk`） | [中文](java/README.md) · [EN](java/README.en.md) · [JA](java/README.ja.md) | 线程安全的 `AbiAnalytics`（实现 `AutoCloseable` 优雅关闭），提供 `StagingConsumer`、`BatchConsumer`、`LoggerConsumer`、`DebugConsumer`，自动对超出 IEEE-754 双精度安全范围（`> 2^53 - 1`）的长整型属性执行字符串无损序列化 | `cd abi.sdk/java && JAVA_HOME=$(/usr/libexec/java_home -v 11) mvn test` |
| [`python/`](python/) | Python 3 服务端 SDK（`abi.sdk/python`） | [中文](python/README.md) · [EN](python/README.en.md) · [JA](python/README.ja.md) | 零第三方依赖纯 Python 3 标准库实现，提供 `StagingConsumer`、`BatchConsumer`（后台守护线程 + Gzip + 指数退避重试）、`LoggerConsumer`、`DebugConsumer`，自动识别 `bool` 与 `> 2^53 - 1` 任意精度大整数转字符串，支持 `#time` / `$time` 提取与 `#ip` / `$ip` 透传 | `python3 -m unittest discover -s abi.sdk/python/tests -v` |
| [`nodejs/`](nodejs/) | Node.js 服务端 SDK（`@anylink/abi-node-sdk`） | [中文](nodejs/README.md) · [EN](nodejs/README.en.md) · [JA](nodejs/README.ja.md) | 零外部依赖 ESM + TypeScript 类型声明（`index.d.ts`），支持 Express / Fastify / Koa / NestJS 多用户无状态并发上报，内置 `StagingConsumer`、`BatchConsumer`（`zlib.gzipSync`）、`LoggerConsumer`、`DebugConsumer`，支持 `BigInt` 与不安全整数自动转字符串 | `node --test abi.sdk/nodejs/test/abi-node-sdk.test.mjs` |
| [`csharp/`](csharp/) | C# / .NET 服务端 SDK（`Anylink.Abi.Sdk`） | [中文](csharp/README.md) · [EN](csharp/README.en.md) · [JA](csharp/README.ja.md) | 基于 .NET 标准库（`System.Text.Json` / `HttpClient` / `GZipStream`）的线程安全服务端 SDK，提供 `StagingConsumer`、`BatchConsumer`、`LoggerConsumer`、`DebugConsumer` 及全套 `Track*` / `User*` 接口 | `dotnet run --project abi.sdk/csharp -- --test` |
| [`php/`](php/) | PHP 8.1+ 服务端 SDK（`Anylink\Abi\Sdk`） | [中文](php/README.md) · [EN](php/README.en.md) · [JA](php/README.ja.md) | 零第三方依赖 PHP 服务端 SDK（适配 Laravel / Symfony / PHP-FPM / Swoole），内置 `StagingConsumer`、`BatchConsumer`（`gzencode` + 重试）、`LoggerConsumer`、`DebugConsumer` 与完整黄金向量校验 | `php abi.sdk/php/tests/abi_sdk_test.php` |
| [`ruby/`](ruby/) | Ruby 服务端 SDK（`AbiSdk`） | [中文](ruby/README.md) · [EN](ruby/README.en.md) · [JA](ruby/README.ja.md) | 零外部 Gem 依赖 Ruby 标准库实现（适配 Rails / Sidekiq / Rack，同时支持 `snake_case` 与 `camelCase` 方法名），提供 `StagingConsumer`、`BatchConsumer`、`LoggerConsumer`、`DebugConsumer` | `ruby abi.sdk/ruby/test/abi_sdk_test.rb` |
| [`cpp/`](cpp/) | C / C++17 跨端 SDK（服务端 & Unreal Engine / Cocos2d-x 客户端） | [中文](cpp/README.md) · [EN](cpp/README.en.md) · [JA](cpp/README.ja.md) | 零依赖单头文件 C++17 SDK（[`include/abi_sdk.hpp`](cpp/include/abi_sdk.hpp)）及 `extern "C"` 纯 C 接口，避免跨 DLL STL ABI 冲突；同时支持 C++ 游戏服/后端无状态模式与 Unreal Engine / Cocos2d-x 客户端设备会话模式（含 `time_event` 秒表耗时计算） | `clang++ -std=c++17 -O2 -Iabi.sdk/cpp/include abi.sdk/cpp/tests/abi_cpp_test.cpp -o /tmp/abi_cpp_test && /tmp/abi_cpp_test` |
| [`lua/`](lua/) | Lua 5.3+ 跨端 SDK（OpenResty / Skynet 服务端 & Cocos2d-Lua 客户端） | [中文](lua/README.md) · [EN](lua/README.en.md) · [JA](lua/README.ja.md) | 纯 Lua 标准库零依赖单文件 [`abi_sdk.lua`](lua/abi_sdk.lua)，内置确定性 JSON 编解码器与 UTF-8 校验器，同时支持游戏服/网关无状态模式与客户端有状态模式 | `lua abi.sdk/lua/tests/test_abi_sdk.lua` |
| [`mobile/`](mobile/) | 移动客户端 SDK（Flutter Dart、Android Kotlin、iOS Swift） | 总览：[中文](mobile/README.md) · [EN](mobile/README.en.md) · [JA](mobile/README.ja.md)<br/>Flutter：[中文](mobile/flutter/README.md) · [EN](mobile/flutter/README.en.md) · [JA](mobile/flutter/README.ja.md)<br/>Android：[中文](mobile/android/README.md) · [EN](mobile/android/README.en.md) · [JA](mobile/android/README.ja.md)<br/>iOS：[中文](mobile/ios/README.md) · [EN](mobile/ios/README.en.md) · [JA](mobile/ios/README.ja.md) | 原生线程安全队列与定时批量刷新、双 ID 身份绑定（`identify` / `login` / `logout`）、高精度秒表事件计时（`timeEvent` -> `$duration`）、同日固定 `event_id` 幂等上报（按 D7① / G6 门禁，`trackFirst`/`trackUpdate`/`trackOverwrite` 未开放）、全套 `$user_*` 画像变更及两步式预览与确认提交交互 Demo | `swiftc -typecheck abi.sdk/mobile/ios/AbiAnalytics.swift abi.sdk/mobile/ios/example/AbiDemoViewController.swift` |
| [`game-engines/unity/`](game-engines/unity/) | Unity 游戏引擎客户端 SDK（C# `AbiUnityAnalytics`） | [中文](game-engines/unity/README.md) · [EN](game-engines/unity/README.en.md) · [JA](game-engines/unity/README.ja.md) | 专为 Unity 游戏客户端设计的设备会话管理、高精度计时器、离线队列与两步式预览确认组件（`AbiUnityDemoMonoBehaviour`） | `dotnet run --project abi.sdk/csharp -- --test` |
| [`data-import/`](data-import/) | 数据传输与离线导入工具套件（LogBus 2 / Filebeat / Logstash / Vector / DataX） | [中文](data-import/README.md) · [EN](data-import/README.en.md) · [JA](data-import/README.ja.md) | 对标数数 LogBus 2 实时日志采集守护进程（[`abi_logbus.py`](data-import/abi_logbus.py)，监听各语言 `LoggerConsumer` 落盘 `.jsonl` 断点续传 + Gzip 批量上报），并提供 Filebeat、Logstash、Vector、Alibaba DataX 开箱即用配置模板 | `python3 abi.sdk/data-import/abi_logbus.py --demo --yes` |

---

## 2. 采集网关批量上报协议契约 (`POST /collect/api/v1/track/batch`)

所有客户端与服务端 HTTP Consumer 均统一向采集网关发送标准 JSON 批量报文：

```json
{
  "project_id": 1,
  "project_token": "abi_tok_...",
  "debug": false,
  "dry_run": false,
  "events": [
    {
      "event_id": "018f6b9c-7c40-7000-8000-000000000001",
      "event_name": "OrderPaid",
      "distinct_id": "vis_device_001",
      "login_id": "user_10001",
      "timestamp": 1731174000000,
      "properties": {
        "$lib": "abi-ios-sdk",
        "$lib_version": "1.0.0",
        "$os": "iOS",
        "$app_version": "2.1.0",
        "$duration": 12.345,
        "amount": 199.0,
        "order_id": "9007199254740993"
      }
    }
  ]
}
```

### 2.1 身份双 ID 与幂等标识约束（对标数数科技 ThinkingData）

- **`distinct_id`（访客 / 设备 ID）**：协议层唯一的访客或终端设备标识，严禁包含 ASCII 控制字符（`0x00–0x08`、`0x0E–0x1F`、`0x7F`），首尾 Unicode 空白符自动裁剪，UTF-8 字节长度上限为 **64 字节**。客户端 SDK 初始化时自动生成并持久化本地访客 ID，也可通过 `identify(visitorId)` 自定义；服务端在纯账号场景（已提供非空 `login_id` 且无客户端设备上下文）下允许传空字符串 `""`（**严禁将 `login_id` 拷贝或截断回填至 `distinct_id`**）。
- **`login_id`（实名登录账号 ID）**：用户完成认证或账号登录后的业务账号标识，UTF-8 字节长度上限为 **128 字节**（未登录访客可省略或传 `""`）。每条事件的 `distinct_id` 与 `login_id` **至少有一个非空**。
- **客户端 `login()` 纯本地状态与全链路自动 ID-Mapping**：客户端调用 `login(accountId)` **仅在本地持久化写入 `login_id`**（保留原 `distinct_id` 不变，且不会自动发送单独的身份绑定事件）；调用 `logout()` 仅清空本地 `login_id` 并继续沿用当前 `distinct_id`。无论客户端还是服务端，**只要任意一条行为事件（`Track*`）或用户画像事件（`$user_*`）同时携带非空 `distinct_id` 与 `login_id`**，下游 Flink Job1 即实时将其写入 `abi.identity_map` 完成跨生命周期归因贯通。
- **`event_id`（事件幂等主键）**：UTF-8 字节长度上限为 **64 字节**。当遇到客户端断网、HTTP `429` 限流或 `5xx` 服务端瞬态异常触发重试时，队列会保留原始 `event_id` 不变以实现幂等写入。（*注：当前版本按 D7① / G6 门禁约束，`trackFirst` 首次去重与 `trackUpdate`/`trackOverwrite` 跨天更新统一标注为未开放，如需幂等请在同一事件日期分区内通过标准 `track` 携带固定 `event_id`*）。

### 2.2 大整数（$> 2^{53}-1$）精度保护

JavaScript 与通用 JSON 解析器遵循 IEEE-754 双精度浮点数规范，最大安全整数为 $2^{53}-1$（即 `9007199254740991`）。

- 当整型属性值的绝对值超过 `9007199254740991`（例如分布式雪花算法生成的 64 位订单流水号 `9007199254740993` 或边界值 `Int64.min` / `Long.MIN_VALUE`）时，各语言 SDK 会在序列化前自动将其转换为十进制字符串（`"9007199254740993"`），彻底杜绝跨端传输过程中的低位精度截断。
- 同时，所有 SDK 在入队前均会拦截 `NaN`、`Infinity` / `-Infinity` 非有限浮点数，以及包含 `null` 或嵌套对象/嵌套数组的非法列表元素。

### 2.3 `$user_*` 用户画像事件规范

SDK 提供 7 类标准用户画像变更接口，底层统一编码为系统保留事件并路由至 StarRocks 用户维表（`dim_users`）：

| SDK 方法 | 协议 `event_name` | 画像更新语义 |
|----------|-------------------|--------------|
| `userSet(props)` | `$user_set` | 覆盖写入用户画像属性（存在则覆盖，不存在则新增） |
| `userSetOnce(props)` | `$user_set_once` | 仅在目标画像属性尚未设置时首次写入（适用于首次安装渠道、注册来源等不可变归因属性） |
| `userAdd(props)` | `$user_add` | 对数值型画像属性执行原子累加/扣减（如积分变动、累计消费金额） |
| `userUnset(keys)` | `$user_unset` | 清空指定的用户画像属性键（报文中属性值统一填充 `0` 作为删除占位符） |
| `userAppend(props)` | `$user_append` | 向列表（Array）类型的画像属性末尾追加元素（保留重复项） |
| `userUniqAppend(props)` | `$user_uniq_append` | 向列表（Array）类型的画像属性追加元素并自动去重（适用于用户兴趣标签、勋章集合） |
| `userDelete()` | `$user_del` | 标记删除当前主体的用户画像记录 |

> **隔离约束**：SDK 在组装 `$user_*`（及兼容前缀 `#user_*`）事件的 `properties` 时，**不会注入**静态/动态公共属性（Super Properties）以及 `$os`、`$app_version`、`$lib` 等客户端环境预置属性，确保环境元数据不会污染用户画像宽表。

### 2.4 接入人员视角：各端 SDK 字段必填性与职责边界对照（重点）

在实际工程落地中，**客户端 SDK（Web / 小程序 / App）** 与 **服务端 SDK（Go / Java）** 所处的网络位置和运行态完全不同。接入人员需特别注意以下字段在不同 SDK 场景下的传参职责：

| 字段 / 属性 | 客户端 SDK（`ts-web` / `mobile` Flutter·Android·iOS） | 服务端 SDK（`go` / `java` / `python` / `nodejs` / `csharp` / `php` / `ruby`） | 原生 HTTP 直连（`RESTFUL_API.md`） | 后端网关 (`:8081`) 与 Flink ETL 处理规则 |
| :--- | :--- | :--- | :--- | :--- |
| **`project_id` & `project_token`** | **初始化必填**（`init` 时传入一次） | **初始化 Consumer 必填** | **每次请求顶层必填** | 网关校验项目启用状态与 Token 签名，非法直接返回 `401/403` |
| **`event_name`（事件名）** | **每次 `track` 必填**（`userSet*` 等画像方法由 SDK 自动填 `$user_*`） | **每次 `Track` 必填**（`UserSet*` 等画像方法由 SDK 自动填 `$user_*`） | **每条事件必填** | 校验 `<= 128` 字符及命名规范 `^[A-Za-z_][A-Za-z0-9_]*$`（或系统 `$`/`#` 白名单） |
| **用户身份（`distinct_id` / `login_id`）** | **自动管理（无需每次传）**：SDK 初始化时自动生成并持久化访客 `distinct_id`；用户登录时调用 `login(accountId)` 纯本地保存 `login_id`（后续事件自动同时携带双 ID） | **每次调用必填**：服务端实例被所有用户共享，无本地会话态；每次调用必须显式传入当前用户的 `login_id`（`accountId`）与/或前端透传的访客 `distinct_id`（至少非空其一，绝不将 `login_id` 回填到 `distinct_id`） | **每条事件必填**（`distinct_id` 与 `login_id` 至少非空其一） | 网关拦截空身份（`missing_identity`）；任意事件同时携带非空 `distinct_id` + `login_id` 时，Flink 自动实时写入 `abi.identity_map` 完成归因映射 |
| **用户公网 IP（`#ip` / `$ip`）**<br/>*(影响国家/省份/城市地域分析)* | **客户端不传（也拿不到）**：浏览器 JS 与移动端 App 处于 NAT 后方，无法直接获取自身公网出口 IP；直接由采集网关从 HTTP 连接提取 | **服务端强烈建议必传**：服务端上报时网关看到的连接 IP 是**后端机房/容器 IP**（或 `LoggerConsumer` 落盘无连接 IP）。服务端需从客户端请求头（`X-Forwarded-For` / `X-Real-IP`）获取真实用户 IP 并传入 `properties["#ip"]` 或 `"$ip"` | 客户端直连无需传；服务端转发/上报时**需在 `properties` 中传入 `"#ip"` 或 `"$ip"`** | Flink 严格按 **`properties["#ip"]` > `properties["$ip"]` > 网关连接 `client_ip`** 优先级提取合法数值 IP 解析 GeoIP（国家/省/市），并自动从 `properties` 中剥离 `#ip`/`$ip` |
| **事件发生时间（`timestamp` / `#time` / `$time`）** | **默认免填**：客户端实时触发时 SDK 自动取 `Date.now()`；仅补报历史离线事件时传 `#time` / `$time` 或 `options.timestamp` | **实时免填 / 异步与补数必填**：实时埋点默认取服务器当前时间；若为 **MQ 异步消费、支付回调或历史数据回填**，必须通过 `properties["#time"]`（或 `TrackOptions.Timestamp` / `Date` / `Instant`）传入实际业务发生时间 | **每条事件必填**（传顶层毫秒 `timestamp` 或 `properties["#time"]` / `"$time"`） | 网关与 SDK 均支持将 `#time` / `$time` 自动提取覆盖为顶层毫秒 `timestamp` 并从 `properties` 剥离；超出项目时间窗 `ts_window_days` 将被拦截或标记 |
| **事件幂等主键（`event_id`）** | **默认免填**：SDK 自动生成 UUIDv4，断网重连重发时自动保持原 `event_id`；按 D7① / G6 门禁，`trackFirst`/`trackUpdate`/`trackOverwrite` 统一收敛标注为当前版本未开放 | **普通事件免填 / 核心交易推荐显式传**：MQ 消费或订单状态演进场景，强烈建议通过 `TrackWithOptions` / `trackWithId` 传入确定性业务主键（如 `"ord_paid_" + orderNo`）实现端到端幂等 | 推荐显式传 UUID 或业务主键（不传时网关自动生成 UUID，但客户端重试无法幂等） | StarRocks `dwd_events` 依据主键与 `event_id` 在同一分区窗口内保障幂等去重 |
| **设备环境预置属性（`$os` / `$app_version` / `$screen_width` 等）** | **SDK 自动采集注入**（仅注入行为事件，自动隔离 `$user_*` 画像事件） | **服务端无法自动获知客户端设备**：可通过 `SetSuperProperties` 设置服务名/版本号，或从客户端请求头透传 `$os`、`$app_version`、`$device_model` | 按需在 `properties` 中显式传入 | Flink 自动将 `$os`、`$app_version`、`$device_model` 等提升至 `dwd_events` 物理加速列 |

> **前后端协同打通最佳实践**：当同一业务既有前端浏览（Web/App SDK）又有后端落单（Go/Java 等服务端 SDK）时，推荐前端在调用业务后端下单 API 时，通过请求头（如 `X-ABI-Distinct-Id: abi.getDistinctId()`）把前端访客 ID 传给后端；后端在调用服务端 SDK `Track` 时同时传入 `loginId`（`accountId`）、访客 `distinctId` 以及客户端真实 `"#ip"`，即可在任意业务事件上自动触发 Flink ID-Mapping 关联，完美实现「前端曝光浏览 → 后端支付回调」的全漏斗归因与真实地域还原。

---

## 3. 各端交互式 Demo 与代码示例速查表

`abi.sdk` 为每一门语言和客户端框架均配备了完整的中文文档注释（`GoDoc`、`Javadoc`、`TSDoc`、`DartDoc`、`KDoc`、`SwiftDoc`），并且所有面向用户的可视化 Demo 与命令行/方法级 Demo 统一采用 **「1. 配置参数并实时预览唯一一份请求报文 JSON → 2. 显式点击『确认提交』（或调用确认提交方法）发送并查看单份响应」** 的两阶段交互模式，避免参数调整时在监控区无限累加冗余日志：

| 平台 / SDK | 交互式界面 / 可运行 Demo 入口文件 | 带注释的核心 SDK 源码 | 触发方式与验证命令 |
|------------|-----------------------------------|----------------------|--------------------|
| **Go 服务端 SDK** | [`go/examples/demo/main.go`](go/examples/demo/main.go) & [`go/example_test.go`](go/example_test.go) | [`go/abi.go`](go/abi.go)（含 `StagingConsumer`） | `cd abi.sdk/go && go run ./examples/demo`（交互式预览请求 JSON 后输入 `y` 确认提交，或加 `--yes` 自动确认） |
| **Java 11+ 服务端 SDK** | [`java/src/main/java/com/anylink/abi/sdk/examples/AbiJavaSdkDemo.java`](java/src/main/java/com/anylink/abi/sdk/examples/AbiJavaSdkDemo.java) | [`java/src/main/java/com/anylink/abi/sdk/AbiAnalytics.java`](java/src/main/java/com/anylink/abi/sdk/AbiAnalytics.java) & [`StagingConsumer.java`](java/src/main/java/com/anylink/abi/sdk/StagingConsumer.java) | `cd abi.sdk/java && JAVA_HOME=$(/usr/libexec/java_home -v 11) mvn test-compile exec:java -Dexec.mainClass="com.anylink.abi.sdk.examples.AbiJavaSdkDemo"` |
| **Python 3 服务端 SDK** | [`python/examples/demo.py`](python/examples/demo.py) | [`python/abi_sdk.py`](python/abi_sdk.py)（含 `StagingConsumer`） | `python3 abi.sdk/python/examples/demo.py --yes`（预览请求 JSON 后确认提交） |
| **Node.js 服务端 SDK** | [`nodejs/examples/demo.mjs`](nodejs/examples/demo.mjs) | [`nodejs/src/index.mjs`](nodejs/src/index.mjs)（含 `StagingConsumer`） | `node abi.sdk/nodejs/examples/demo.mjs --yes` |
| **C# (.NET) 服务端 SDK** | [`csharp/Program.cs`](csharp/Program.cs) | [`csharp/AbiAnalytics.cs`](csharp/AbiAnalytics.cs)（含 `StagingConsumer`） | `dotnet run --project abi.sdk/csharp -- --yes` |
| **PHP 8.1+ 服务端 SDK** | [`php/examples/demo.php`](php/examples/demo.php) | [`php/src/AbiAnalytics.php`](php/src/AbiAnalytics.php)（含 `StagingConsumer`） | `php abi.sdk/php/examples/demo.php --yes` |
| **Ruby 服务端 SDK** | [`ruby/examples/demo.rb`](ruby/examples/demo.rb) | [`ruby/lib/abi_sdk.rb`](ruby/lib/abi_sdk.rb)（含 `StagingConsumer`） | `ruby abi.sdk/ruby/examples/demo.rb --yes` |
| **C / C++17 跨端 SDK** | [`cpp/examples/demo.cpp`](cpp/examples/demo.cpp) | [`cpp/include/abi_sdk.hpp`](cpp/include/abi_sdk.hpp)（含 `StagingConsumer` 与 `extern "C"`） | `clang++ -std=c++17 -O2 -Iabi.sdk/cpp/include abi.sdk/cpp/examples/demo.cpp -o /tmp/abi_cpp_demo && /tmp/abi_cpp_demo --yes` |
| **Lua 5.3+ 跨端 SDK** | [`lua/examples/demo.lua`](lua/examples/demo.lua) | [`lua/abi_sdk.lua`](lua/abi_sdk.lua)（含 `StagingConsumer`） | `lua abi.sdk/lua/examples/demo.lua --yes` |
| **Web / H5 可视化演练场** | [`ts-web/examples/interactive-demo.html`](ts-web/examples/interactive-demo.html) & [`ts-web/examples/usage-examples.ts`](ts-web/examples/usage-examples.ts)（`previewAndConfirmWebSdkExample`） | [`ts-web/src/index.ts`](ts-web/src/index.ts)（`buildPendingBatchPayload`） | 浏览器打开 `ts-web/examples/interactive-demo.html` 配置参数预览 JSON 并点击「确认提交」，或运行 `cd abi.sdk/ts-web && pnpm test` |
| **App 内嵌 H5 WebView 打通 & H5 游戏引擎** | [`ts-web/test/abi-web-sdk.test.ts`](ts-web/test/abi-web-sdk.test.ts) | [`ts-web/src/adapters/h5-bridge.ts`](ts-web/src/adapters/h5-bridge.ts) & [`ts-web/src/adapters/game-engines.ts`](ts-web/src/adapters/game-engines.ts) | `cd abi.sdk/ts-web && pnpm test`（覆盖 Android/iOS WebView Bridge 及 Cocos Creator / Egret / LayaAir / Weex） |
| **ABI 管理端内置接入指南抽屉** | [`../abi.cli/src/pages/Meta/MetaProjects.tsx`](../abi.cli/src/pages/Meta/MetaProjects.tsx) & [`../abi.cli/src/lib/sdk-guide-token.ts`](../abi.cli/src/lib/sdk-guide-token.ts) | 同上 | 在后台「元数据 → 项目管理 → 接入指南」中选择场景/公共属性预览单份 JSON 并点击「确认提交」 |
| **微信小程序 & React Native** | [`ts-web/examples/usage-examples.ts`](ts-web/examples/usage-examples.ts)（`runWeChatMiniProgramExample`、`runReactNativeExample`） | [`ts-web/src/adapters/miniapp.ts`](ts-web/src/adapters/miniapp.ts) & [`ts-web/src/adapters/react-native.ts`](ts-web/src/adapters/react-native.ts) | 调用适配器演练函数，或运行 `cd abi.sdk/ts-web && pnpm test` |
| **Unity 游戏引擎客户端 SDK** | [`game-engines/unity/AbiUnityDemoMonoBehaviour.cs`](game-engines/unity/AbiUnityDemoMonoBehaviour.cs)（`AbiUnityDemoMonoBehaviour` / `AbiUnityDemoRunner`） | [`game-engines/unity/AbiUnityAnalytics.cs`](game-engines/unity/AbiUnityAnalytics.cs)（`BuildPendingBatchJson`） | 在 Unity 挂载 `AbiUnityDemoMonoBehaviour` 或运行 `dotnet run --project abi.sdk/csharp -- --test` |
| **Flutter 客户端 SDK** | [`mobile/flutter/example/lib/main.dart`](mobile/flutter/example/lib/main.dart)（`AbiSdkDemoApp` / `AbiSdkDemoScreen`） | [`mobile/flutter/lib/abi_sdk.dart`](mobile/flutter/lib/abi_sdk.dart)（`buildPendingBatchPayload` / `previewScenarioPayload` + `confirmSubmit`） | 在 Flutter 宿主工程挂载 `AbiSdkDemoApp` 配置参数预览 JSON 后点击「确认提交」，或调用 `previewScenarioPayload` + `confirmSubmit`（详见 [`mobile/README.md`](mobile/README.md)） |
| **Android Kotlin 客户端 SDK** | [`mobile/android/example/AbiDemoActivity.kt`](mobile/android/example/AbiDemoActivity.kt)（`AbiDemoActivity` / `previewScenarioPayload` + `confirmSubmit`） | [`mobile/android/AbiAnalytics.kt`](mobile/android/AbiAnalytics.kt)（`buildPendingBatchPayload`） | 在 Android 宿主工程启动 `AbiDemoActivity` 预览单份请求 JSON 后点击「确认提交」，或调用 `previewScenarioPayload` + `confirmSubmit`（详见 [`mobile/README.md`](mobile/README.md)） |
| **iOS Swift 客户端 SDK** | [`mobile/ios/example/AbiDemoViewController.swift`](mobile/ios/example/AbiDemoViewController.swift)（`AbiSdkDemoView` / `AbiSdkDemoRunner`） | [`mobile/ios/AbiAnalytics.swift`](mobile/ios/AbiAnalytics.swift)（`buildPendingBatchJsonString`） | 在 SwiftUI 工程挂载 `AbiSdkDemoView()` 预览请求 JSON 后点击「确认提交」（或调用 `AbiSdkDemoRunner.previewScenarioJson` + `confirmSubmit`）；类型检查：`swiftc -typecheck abi.sdk/mobile/ios/AbiAnalytics.swift abi.sdk/mobile/ios/example/AbiDemoViewController.swift` |
| **LogBus 2 / 数据导入工具套件** | [`data-import/abi_logbus.py`](data-import/abi_logbus.py)（`--demo` 两步式预览与确认提交） | [`data-import/abi_logbus.py`](data-import/abi_logbus.py) 及 Filebeat / Logstash / Vector / DataX 配置模板 | `python3 abi.sdk/data-import/abi_logbus.py --demo --yes` |
