# ABI Java 服务端 SDK 使用与示例指南 (`abi-java-sdk`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`abi-java-sdk` 是 ABI 用户行为分析与 BI 平台的官方 **Java 服务端数据采集 SDK**（语义兼容数数科技 ThinkingData TA Java SDK v3.4），专为高并发微服务、交易后端与批处理作业设计。

---

## 1. 核心特性

- **多通道消费者（`Consumer`）架构**：
  - `StagingConsumer`（暂存预览 / 交互式联调推荐）：在内存中暂存待提交事件而不自动触发网络请求；支持先调用 `previewRequestJson(...)` 查看带缩进格式化的完整 `POST /collect/api/v1/track/batch` 请求体，人工或程序核对无误后再调用 `confirmSubmit(targetConsumer)` 一次性投递发送。
  - `BatchConsumer`（生产推荐）：基于内存有界阻塞队列 + 守护定时线程的异步批量 HTTP 上报，支持 Gzip 压缩、网络抖动 / `5xx` / `429` 指数退避重试，且重试过程严格保持 `event_id` 幂等不变。
  - `DebugConsumer`（联调 / CI 门禁）：同步逐条发送并开启网关 L4 严格元数据与 Schema 校验；支持 `dryRun=true` 仅校验不落库，避免测试脏数据污染线上 Kafka 与 StarRocks。
  - `LoggerConsumer`（高吞吐离线落盘）：将埋点与用户画像事件按 UTC 自然日自动切分写入本地 `.jsonl` 文件，配合 Filebeat / Vector / LogBus 旁路采集，彻底解耦核心交易链路与外部网络 I/O。
- **ThinkingData 对齐双 ID 自动身份关联**：网络传输仅保留访客/设备 ID（`distinct_id` ≤ 64 UTF-8 字节）与实名账号 ID（`login_id` ≤ 128 UTF-8 字节）两个身份字段（两者至少一个非空，且当 `distinct_id` 为空时绝不把 `login_id` 回填复制到 `distinct_id`）。无需任何专用身份绑定接口或特殊绑定事件——只要任意 `track*` 或 `user*` 事件同时携带非空 `login_id` 与 `distinct_id`，Flink ETL 即自动完成全链路 ID-Mapping 身份归并。
- **幂等事件上报（注：按 D7① / G6 门禁，`trackFirst`/`trackUpdate`/`trackOverwrite` 标注为当前版本未开放）**：支持指定确定性 `event_id` 的幂等上报（`trackWithId`）；`trackFirst` 首次去重与跨天 `trackUpdate`/`trackOverwrite` 统一标注为当前版本未开放，请在同分区内通过 `trackWithId` 传入业务唯一键保障幂等。
- **完备的用户画像（User Profile）操作**：内置 `userSet`、`userSetOnce`、`userAdd`、`userAppend`、`userUniqAppend`、`userUnset`、`userDelete` 共 7 种画像变更原语，并自动隔离行为事件的公共属性（Super Properties），防止服务端环境字段污染用户画像表。
- **强类型安全与精度保护**：
  - **分布式雪花 ID 防精度丢失**：超过 IEEE-754 安全整数范围（`> 2^53 - 1`，即 `9007199254740991`）的 `Long` 型属性自动序列化为字符串，防止前端 JS 或下游 JSON 解析截断尾数。
  - **UTC 时间标准化**：`java.time.Instant` 与 `java.util.Date` 自动格式化为标准 UTC ISO-8601 字符串（如 `2026-11-10T02:15:30Z`）。

---

## 2. 环境要求与构建安装

- **JDK 版本**：Java 11 及以上（`maven.compiler.source = 11`）
- **构建工具**：Maven 3.8+
- **运行期依赖**：仅依赖 `com.fasterxml.jackson.core:jackson-databind` 与 JDK 标准库，零重型框架侵入。

### Maven 坐标

```xml
<dependency>
    <groupId>com.anylink.abi</groupId>
    <artifactId>abi-java-sdk</artifactId>
    <version>1.0.0</version>
</dependency>
```

### 本地编译与运行单元测试

> macOS 多 JDK 环境下建议显式指定 Java 11：

```bash
cd abi.sdk/java
JAVA_HOME=$(/usr/libexec/java_home -v 11) mvn test
```

---

## 3. 两步式运行 Demo（1. 配置并预览请求 JSON → 2. 确认提交）

SDK 内置的 [`AbiJavaSdkDemo`](src/main/java/com/anylink/abi/sdk/examples/AbiJavaSdkDemo.java) 采用清爽的**两步式交互工作流**（告别多批混杂刷屏日志）：
1. **第一步（配置参数并预览请求 JSON）**：根据指定的业务场景与公共属性配置，仅在终端输出**唯一一份完整带缩进的 `POST /collect/api/v1/track/batch` 待提交请求 JSON 预览**，此时不发起任何网络请求；
2. **第二步（确认提交）**：在交互式终端下提示 `是否确认提交上述请求参数？[y/N]: `，输入 `y` 确认（或传入 `--yes` / 处于非交互环境）后才真正发送，并输出**唯一一份网关响应结果**。

### 3.1 默认零依赖本地预览与确认模式

不传入 `--server-url` 时，第一步直接展示待提交 JSON 报文；第二步确认后自动启动轻量级本地模拟网关完成投递并返回响应：

```bash
cd abi.sdk/java
JAVA_HOME=$(/usr/libexec/java_home -v 11) mvn compile exec:java \
  -Dexec.mainClass="com.anylink.abi.sdk.examples.AbiJavaSdkDemo"
```

### 3.2 自定义公共属性、场景并连接真实 `:8081` 采集网关

```bash
cd abi.sdk/java
JAVA_HOME=$(/usr/libexec/java_home -v 11) mvn compile exec:java \
  -Dexec.mainClass="com.anylink.abi.sdk.examples.AbiJavaSdkDemo" \
  -Dexec.args="--server-url http://127.0.0.1:8081 --project-id 1 --project-token abi_live_token \
  --scenario=order --super-props='{\"$app_version\":\"3.5.0\",\"env\":\"staging\"}' --dynamic-super"
```

若在脚本或自动化验证中希望跳过终端 `[y/N]` 确认直接提交，追加 `--yes`（以及可选 `--dry-run` 仅校验不落库）：

```bash
cd abi.sdk/java
JAVA_HOME=$(/usr/libexec/java_home -v 11) mvn compile exec:java \
  -Dexec.mainClass="com.anylink.abi.sdk.examples.AbiJavaSdkDemo" \
  -Dexec.args="--server-url http://127.0.0.1:8081 --project-id 1 --project-token abi_live_token \
  --scenario=all --dry-run --yes"
```

### 3.3 在 Java 代码中使用 `StagingConsumer` 两步式预览与确认提交

开发者在本地自检或编写运维补数工具时，可直接使用 `StagingConsumer` 先核对最终生成的请求报文，再确认提交：

```java
import com.anylink.abi.sdk.AbiAnalytics;
import com.anylink.abi.sdk.BatchConsumer;
import com.anylink.abi.sdk.StagingConsumer;

import java.time.Instant;
import java.util.Map;

public class TwoStepSubmitExample {
    public static void main(String[] args) throws Exception {
        StagingConsumer staging = new StagingConsumer();

        // 第一步：配置公共属性并记录埋点事件（仅写入内存暂存队列，零网络请求）
        try (AbiAnalytics sdk = new AbiAnalytics(staging)) {
            sdk.setSuperProperties(Map.of("$platform", "java-server", "service_name", "order-service"));
            sdk.trackWithId(
                    "user_8848",     // 实名账号 ID (login_id)
                    "vis_sess_9001", // 前端通过请求头 X-ABI-Distinct-Id 透传的访客/设备 ID (distinct_id)
                    "OrderPaid",
                    "ord_paid_ORD202611108848",
                    Map.of(
                            "#ip", "203.0.113.42",          // 从客户端 X-Forwarded-For / X-Real-IP 提取的真实公网 IP
                            "order_id", 9007199254740999L,  // > 2^53-1 雪花长整型，自动转为字符串 "9007199254740999"
                            "order_no", "ORD202611108848",
                            "amount", 299.00,
                            "paid_at", Instant.now()
                    )
            );
        }

        // 查看带缩进格式化的完整 POST /collect/api/v1/track/batch 请求 JSON
        String requestJson = staging.previewRequestJson(1L, "abi_live_token", false);
        System.out.println("待提交请求 JSON:\n" + requestJson);

        // 第二步：人工或业务条件确认无误后，一次性投递至 BatchConsumer / DebugConsumer 并清空暂存队列
        BatchConsumer.Config cfg = new BatchConsumer.Config("http://127.0.0.1:8081", 1L, "abi_live_token");
        try (BatchConsumer batchConsumer = new BatchConsumer(cfg)) {
            int submittedCount = staging.confirmSubmit(batchConsumer);
            System.out.println("已确认提交事件条数: " + submittedCount);
        }
    }
}
```

---

## 4. Demo 命令行参数与环境变量说明

命令行参数优先级高于同名环境变量（支持 `--key value` 与 `--key=value` 两种写法）：

| 命令行参数 | 对应环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `--server-url` | `ABI_SERVER_URL` | 空（确认提交时启动内置模拟网关） | ABI 采集网关基础地址，例如 `http://127.0.0.1:8081`（SDK 自动补全 `/collect/api/v1/track/batch`） |
| `--project-id` | `ABI_PROJECT_ID` | `1` | ABI 后台分配的项目数字 ID（必须 `> 0`） |
| `--project-token` | `ABI_PROJECT_TOKEN` | `abi_demo_project_token` | ABI 项目对应的采集鉴权 Token |
| `--scenario` | `ABI_SCENARIO` | `order` | 预览场景：`order`（订单生命周期）\| `browse`（匿名浏览）\| `identity`（登录身份绑定）\| `profile`（7 种用户画像）\| `all`（合并全部） |
| `--super-props` | `ABI_SUPER_PROPS` | 内置示例静态公共属性 | 静态公共属性 JSON 对象字符串，如 `'{"$app_version":"3.5.0","env":"prod"}'`（传 `'{}'` 可清空） |
| `--dynamic-super` | `ABI_DYNAMIC_SUPER` | `false` | 动态公共属性开关（传入 `--dynamic-super` 开启注入 `request_seq` 与 `trace_ts`） |
| `--dry-run` | `ABI_DRY_RUN` | `false` | 是否在请求载荷中标记 `"dry_run": true`（仅执行网关校验不写入存储） |
| `--yes` / `-y` | `ABI_AUTO_CONFIRM` | `false` | 跳过交互式终端 `[y/N]` 确认提示，预览后直接提交 |

---

## 5. `AbiJavaSdkDemo` 核心方法详解

`AbiJavaSdkDemo` 既提供两步式入口方法（`buildScenarioPreview` + `confirmAndSubmit`），也保留了全部独立的业务场景静态方法与全量串联方法 `runAllDemos`：

### 5.0 两步式核心入口：`buildScenarioPreview(...)` 与 `confirmAndSubmit(...)`
- **`buildScenarioPreview(DemoConfig config)`**：按配置初始化 `StagingConsumer` 与 `AbiAnalytics`，注入静态/动态公共属性并生成对应场景事件，在控制台输出唯一一份干净完整的请求 JSON 预览后返回 `StagingConsumer`。
- **`confirmAndSubmit(StagingConsumer staging, DemoConfig config)`**：处理交互式终端 `[y/N]` 确认（取消时调用 `staging.clear()` 且零网络请求），确认通过后通过 `staging.confirmSubmit(...)` 发送单批请求并输出唯一一份网关响应结果。

### 5.1 匿名浏览与动静态公共属性：`triggerAnonymousBrowseAndSuperProps(AbiAnalytics sdk)`
- **演示内容**：
  1. 调用 `sdk.setSuperProperties(...)` 注册全局静态公共属性（如 `$app_version`、`$platform`、`service_name`），自动注入后续所有行为事件。
  2. 调用 `sdk.setDynamicSuperProperties(Supplier)` 注册动态公共属性回调（如递增请求序号 `request_seq`、链路时间戳 `trace_ts`），每次调用 `track` 时实时求值。
  3. 模拟未登录访客（`loginId` 传 `""`，仅携带 `distinctId = "vis_sess_9001"`）连续上报 `$pageview` 与 `ProductViewed` 两条浏览事件。
- **属性覆盖优先级**：`track` 显式事件属性 > 动态公共属性（`DynamicSuperProperties`） > 静态公共属性（`SuperProperties`）。

### 5.2 注册 / 登录双 ID 自动身份关联：`triggerLoginIdentityBinding(AbiAnalytics sdk)`
- **演示内容**：
  1. 对齐 ThinkingData 双 ID 规范：无需额外身份绑定接口，在用户完成注册/登录瞬间直接调用 `sdk.track("user_8848", "vis_sess_9001", "$signup", ...)` 与 `"$login"`，同时携带实名账号 `loginId` 与前端透传的访客 `distinctId`。
  2. Flink Job1 ETL 检测到任意事件同时包含非空 `login_id` 与 `distinct_id` 时，自动写入 StarRocks `identity_map` 将此前访客会话行为归并到实名账号 `user_8848`。

### 5.3 订单全阶段里程碑事件与雪花长整型安全转换：`triggerOrderLifecycleTrackUpdateOverwrite(AbiAnalytics sdk)`
- **演示内容**：
  1. **确定性 `event_id` 幂等上报（`trackWithId`）**：分别使用确定性业务事件主键上报订单创建（`OrderCreated`）、支付成功（`OrderPaid`）与结算履约（`OrderSettled`）三个独立里程碑事件（注：按 D7① / G6 门禁，`trackFirst` / `trackUpdate` / `trackOverwrite` 当前版本未开放，调用会抛出 `UnsupportedOperationException` 且不入队）。
  2. **雪花长整型防精度丢失**：属性 `order_id` 传入 `9007199254740999L`（大于 JS 最大安全整数 `2^53 - 1`），SDK 内部自动转为字符串 `"9007199254740999"` 传输。

### 5.4 7 种用户画像操作全集：`triggerUserProfileOperations(AbiAnalytics sdk)`
- **演示内容**：依次演示 ABI 支持的全部 7 类用户画像（`dim_users`）变更接口（**注意**：所有 `$user_*` 事件均会自动剥离 `superProperties` 与 `dynamicSuperProperties`）：

| SDK 方法 | 底层系统事件 | 业务语义与典型用途 |
| :--- | :--- | :--- |
| `userSet` | `$user_set` | 覆盖写入用户最新属性（如昵称 `display_name`、会员等级 `vip_tier`、常驻城市 `$city`） |
| `userSetOnce` | `$user_set_once` | 仅当属性不存在时首次写入，后续不覆盖（如首访广告渠道 `first_utm_source`、注册时间 `first_registered_at`） |
| `userAdd` | `$user_add` | 数值型属性原子增减（如积分变动 `loyalty_points: 300`、累计消费金额 `lifetime_spend: 269.10`） |
| `userAppend` | `$user_append` | 向列表型属性追加元素，不去重（如浏览品类流水 `viewed_categories`） |
| `userUniqAppend` | `$user_uniq_append` | 向列表型属性追加元素并集合去重（如已开通特性开关 `feature_flags`、已获勋章） |
| `userUnset` | `$user_unset` | 清空一个或多个指定用户属性（如清理过期试用标记 `legacy_trial_badge`） |
| `userDelete` | `$user_del` | 标记注销/删除该用户的画像记录（满足隐私合规清理诉求） |

### 5.5 `DebugConsumer` Dry-Run 在线校验：`triggerDebugDryRunValidation(serverUrl, projectId, projectToken)`
- **演示内容**：实例化 `new DebugConsumer(serverUrl, projectId, projectToken, true)`（第 4 个参数 `dryRun = true`），同步发送事件 `CheckoutValidated`。
- **适用场景**：研发本地自测与 CI 自动化回归。请求报文自动附带 `"debug": true, "dry_run": true`，若事件名、属性名或属性类型违反 ABI 网关 L4 元数据规范，调用会立即同步抛出 `IllegalArgumentException` 并附带具体拒绝原因；校验通过后网关直接返回成功，**不会写入线上分析表**。

### 5.6 `LoggerConsumer` 本地 JSONL 轮转落盘：`triggerLoggerConsumerDemo(Path outputDir)`
- **演示内容**：实例化 `new LoggerConsumer(outputDir.toFile(), "abi_demo")`，将离线结算事件 `NightlySettlementCompleted` 与用户属性更新直接以 UTF-8 JSON Lines 格式追加写入本地磁盘文件 `abi_demo.YYYY-MM-DD.jsonl`。
- **轮转机制**：按 UTC 日期（`YYYY-MM-DD`）自动切分新文件；单行一条完整事件 JSON，天然适配 Filebeat、Vector 或 LogBus Sidecar 采集投递。

---

## 6. 四大 Consumer 选型与配置参考

| 消费者实现 | I/O 模型 | 推荐环境 | 关键特性 |
| :--- | :--- | :--- | :--- |
| `StagingConsumer` | 纯内存暂存队列（显式确认才投递） | **本地参数自检 / 运维补数工具** | 零自动网络请求，支持 `previewRequestJson` 预览完整报文、`clear` 重置、`confirmSubmit` 确认提交 |
| `BatchConsumer` | 内存队列缓冲 + 后台定时/定量批量 HTTP | **生产环境微服务** | 非阻塞业务线程、支持 Gzip 压缩、网络异常与 `5xx`/`429` 指数退避重试 |
| `DebugConsumer` | 每次 `track` 同步阻塞单条 HTTP | **本地联调 / CI 测试** | 实时暴露网关 Schema 拒绝明细，支持 `dryRun=true` 零污染预检 |
| `LoggerConsumer` | 本地磁盘缓冲顺序追加写（`BufferedWriter`） | **超高吞吐交易 / 无外网批处理** | 零网络耗时，按 UTC 自然日自动轮转 `<prefix>.YYYY-MM-DD.jsonl` |

### `BatchConsumer.Config` 参数一览

| 字段名 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `serverUrl` | `String` | 必填 | 采集网关地址（如 `https://collect.example.com`） |
| `projectId` | `long` | 必填（`> 0`） | 项目 ID |
| `projectToken` | `String` | 必填 | 项目采集鉴权 Token |
| `batchSize` | `int` | `50` | 单批触发上报条数上限（有效范围 `1 ~ 500`） |
| `flushIntervalMs` | `long` | `2000L` | 后台定时刷新间隔（毫秒，最小 `100ms`） |
| `maxQueueSize` | `int` | `10000` | 内存待发送队列最大容量（满载时 `add` 抛出 `IllegalStateException` 保护内存） |
| `maxRetries` | `int` | `3` | 网络错误 / `429` / `5xx` 时的最大指数退避重试次数（`4xx` 永久客户端错误不重试） |
| `compressGzip` | `boolean` | `false` | 是否启用请求体 `Content-Encoding: gzip` 压缩（生产公网/跨可用区强烈建议开启） |
| `dryRun` | `boolean` | `false` | 是否在批量上报请求体中携带 `"dry_run": true`（仅校验不写入存储） |

---

## 7. 服务端接入必填字段与客户端透传指南（IP / 身份 / 时间 / 幂等键）

### 7.1 为什么服务端 SDK 与前端 / 移动端 SDK 必填项不同？

- **前端 / 移动端 SDK（Web / iOS / Android / 小程序）**：运行在**单用户终端设备**上且由客户端直连采集网关。SDK 会自动在设备本地生成并持久化 `distinct_id`（访客/设备标识，调用客户端 `login(accountId)` 仅在本地内存/存储记录 `login_id` 而不额外发请求），自动采集设备型号与系统版本（`$os` / `$device_model` / `$app_version`），同时采集网关可直接从客户端 TCP 连接中提取用户真实公网 IP。
- **Go / Java 服务端 SDK**：是运行在**后端机房或云 VPC 内的无状态多用户共享单例**。服务端 SDK 既不能在内存中缓存单用户会话状态，直连 `:8081` 采集网关时暴露的也是**后端服务器内网/机房出口 IP**（使用 `LoggerConsumer` 落盘时更无客户端连接上下文）。因此，**用户身份、真实客户端 IP、实际业务发生时间、业务幂等键**均需由接入研发人员从当前请求上下文或消息体中显式传入。

### 7.2 服务端接入字段必填性与来源对照表

| 字段分类 | SDK 参数 / `properties` 键名 | 必填性级别 | 为什么需要 & 研发接入来源说明 |
| :--- | :--- | :--- | :--- |
| **用户身份标识**<br>(`loginId` / `distinctId`) | Java: `(loginId, distinctId, ...)` 参数 | **【每次调用必填】** | 服务端无状态，每次调用 `track*` / `user*` 必须显式传入当前请求用户的 `loginId`（实名账号 ID，≤ 128 字节）或前端透传的 `distinctId`（访客/设备 ID，≤ 64 字节）。**`loginId` 与 `distinctId` 至少一个非空**（否则报 `missing_identity`）；当 `distinctId` 为空时直接发送 `"distinct_id": ""`，绝不会将 `loginId` 回填复制到 `distinct_id`。<br>若要打通**「前端访客浏览 → 后端下单支付」**全链路漏斗，前端需通过 HTTP 请求头（如 `X-ABI-Distinct-Id`）将 `distinct_id` 透传给后端，后端在埋点时同时传入 `loginId` 与 `distinctId`，Flink 即自动完成身份关联。 |
| **用户真实客户端 IP**<br>(`#ip` / `$ip`) | `properties.get("#ip")`<br>（或 `properties.get("$ip")`） | **【需地域分析时必传】** | 服务端请求采集网关 `:8081` 时，网关 TCP 连接看到的是**后端服务器机房 IP**（`LoggerConsumer` 落盘更无连接 IP）。**若不传 `#ip` / `$ip`，所有服务端事件的国家/省/市地域都会变成机房所在地或局域网 IP！**<br>服务端必须从客户端 HTTP 请求头（`X-Forwarded-For` 首跳公网 IP 或 `X-Real-IP`）提取用户真实公网 IP，放入 `properties` 的 `"#ip"`（或 `"$ip"`）字段。采集网关与 Flink Job1 ETL 会优先按 `#ip` > `$ip` 解析国家/省/市（`$country` / `$province` / `$city`），并自动从入库 `properties` 中剥离该临时键。 |
| **事件发生时间**<br>(`#time` / `$time` / `Date`·`Instant` 重载) | `properties` 中的 `"#time"` / `"$time"`<br>或 `track*(..., Date / Instant)` 重载 | **【实时可省，异步 MQ / 回调 / 补数必传】** | 同步实时接口不传时默认取服务器当前时间；但在 **Kafka/RocketMQ 异步消费、支付回调、离线跑批补数** 场景下，必须通过 `properties.put("#time", ...)`（支持 `Date`、`Instant`、秒/毫秒时间戳、ISO-8601 或 `"yyyy-MM-dd HH:mm:ss.SSS"`）或 `Date` / `Instant` 重载方法传入实际业务发生时间（须在项目 `ts_window_days` 窗口内，提取后自动从 `properties` 剥离）。 |
| **幂等事件 ID**<br>(`event_id`) | `trackWithId(..., eventId, ...)` | **【MQ 消费与核心交易强烈推荐必传】** | 不传时 `track(...)` 会自动生成随机 UUIDv4；但后端 **MQ 消费重试、支付回调重放、离线补数重跑** 若不固定 `event_id` 会产生重复计数。强烈推荐使用 `trackWithId` 传入确定性业务主键（如 `"ord_paid_" + orderNo`，≤ 64 字节），利用 StarRocks 主键模型实现同日幂等去重（注：`trackFirst` / `trackUpdate` / `trackOverwrite` 当前版本未开放）。 |
| **客户端设备上下文**<br>(`$os` / `$app_version` / `$device_model`) | `properties` 中的 `"$os"`、`"$app_version"`、`"$device_model"` | **【按需从前端透传】** | 服务端无法自动采集用户手机型号或 App 版本。如需在服务端事件中按客户端版本/OS 细分，需从前端请求头（如 `X-Client-OS`、`X-App-Version`）透传并写入单次事件 `properties`（切勿放入全局 `setSuperProperties`）。 |

---

## 8. Spring Boot / 服务端生产最佳实践

### 8.1 全局单例 Bean 与优雅停机（严禁按请求每次 `new`）

`AbiAnalytics` 与 `BatchConsumer` 内部均为线程安全设计，且维护了后台调度线程池。在 Spring Boot 中应将其注册为**全局单例 Bean**，并通过 `destroyMethod = "close"` 确保应用停机（SIGTERM）时自动排空并上报内存队列中的剩余事件：

```java
package com.example.shop.config;

import com.anylink.abi.sdk.AbiAnalytics;
import com.anylink.abi.sdk.BatchConsumer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.Map;

@Configuration
public class AbiAnalyticsConfig {

    @Bean(destroyMethod = "close")
    public AbiAnalytics abiAnalytics(
            @Value("${abi.collect.server-url}") String serverUrl,
            @Value("${abi.collect.project-id}") long projectId,
            @Value("${abi.collect.project-token}") String projectToken,
            @Value("${spring.application.name:order-service}") String serviceName,
            @Value("${spring.profiles.active:prod}") String env
    ) {
        BatchConsumer.Config config = new BatchConsumer.Config(serverUrl, projectId, projectToken);
        config.batchSize = 100;
        config.flushIntervalMs = 2000L;
        config.maxQueueSize = 20000;
        config.maxRetries = 3;
        config.compressGzip = true;

        AbiAnalytics sdk = new AbiAnalytics(new BatchConsumer(config));
        // 注册服务级静态公共属性（仅注入行为事件，不会污染 $user_* 画像事件；切勿放入单用户 IP 或设备信息）
        sdk.setSuperProperties(Map.of(
                "$platform", "java-server",
                "service_name", serviceName,
                "deploy_env", env
        ));
        return sdk;
    }
}
```

### 8.2 业务 Service 接入、客户端 IP / 访客 `distinct_id` 透传与故障隔离示例

在核心交易链路中，建议：
1. **从 HTTP 请求头提取客户端真实公网 IP（`X-Forwarded-For` / `X-Real-IP`）与前端访客 ID（`X-ABI-Distinct-Id`）**，通过 `properties` 传入 `"#ip"` 并同时传入 `loginId` 与 `distinctId`；
2. **使用确定性业务幂等键作为 `eventId`**（如 `"ord_paid_" + orderNo`），避免消息队列消费重试导致重复统计；
3. **对埋点调用做异常捕获兜底**，确保极端队列满载或参数校验异常绝不阻断主业务事务。

```java
package com.example.shop.service;

import com.anylink.abi.sdk.AbiAnalytics;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

@Service
public class OrderAnalyticsService {
    private static final Logger log = LoggerFactory.getLogger(OrderAnalyticsService.class);

    private final AbiAnalytics abiAnalytics;

    public OrderAnalyticsService(AbiAnalytics abiAnalytics) {
        this.abiAnalytics = abiAnalytics;
    }

    /**
     * @param loginId           当前登录实名用户 ID (login_id)
     * @param visitorDistinctId 前端通过请求头 X-ABI-Distinct-Id 透传的访客/设备 ID (distinct_id)
     * @param clientIp          从 X-Forwarded-For / X-Real-IP 提取的客户端真实公网 IP
     * @param orderNo           业务订单号（用于构造幂等 event_id）
     * @param snowflakeOrderId  64 位雪花订单 ID（> 2^53-1 会自动安全序列化为字符串）
     * @param payAmount         实付金额
     * @param orderPaidTime     实际支付完成业务时间（MQ 异步消费或回调时必传真实发生时间）
     */
    public void recordOrderPaid(
            String loginId,
            String visitorDistinctId,
            String clientIp,
            String orderNo,
            long snowflakeOrderId,
            double payAmount,
            Instant orderPaidTime
    ) {
        try {
            // 使用确定性 eventId 保障 MQ 重放幂等；雪花长整型 > 2^53-1 会自动安全序列化为字符串
            String deterministicEventId = "ord_paid_" + orderNo;
            Map<String, Object> props = new HashMap<>();
            props.put("order_id", snowflakeOrderId);
            props.put("order_no", orderNo);
            props.put("pay_amount", payAmount);
            props.put("#time", orderPaidTime != null ? orderPaidTime : Instant.now()); // 提取为事件 timestamp 并自动从 properties 剥离
            if (clientIp != null && !clientIp.isBlank()) {
                props.put("#ip", clientIp); // 必传客户端真实公网 IP，避免地域变成后端机房 IP
            }

            abiAnalytics.trackWithId(
                    loginId,
                    visitorDistinctId,
                    "OrderPaid",
                    deterministicEventId,
                    props
            );

            // 原子累加用户累计消费金额
            abiAnalytics.userAdd(
                    loginId,
                    visitorDistinctId,
                    Map.of("total_paid_amount", payAmount)
            );
        } catch (Exception ex) {
            // 埋点异常仅告警记录，不影响核心订单主流程提交
            log.warn("ABI 订单支付埋点上报失败, orderNo={}, orderId={}", orderNo, snowflakeOrderId, ex);
        }
    }
}
```

### 8.3 标识符与属性校验规范速查

| 校验项 | 约束规则 |
| :--- | :--- |
| 身份标识必填性 | 仅 `distinct_id`（访客/设备 ID）与 `login_id`（实名账号 ID）两个身份字段，**两者至少一个非空白值**；当 `distinctId` 为空且 `loginId` 非空时直接发送 `"distinct_id": ""`，绝不把 `loginId` 复制回填到 `distinct_id` |
| 字节长度上限 | `distinct_id` ≤ 64 UTF-8 字节、`login_id` ≤ 128 UTF-8 字节、`event_id` ≤ 64 UTF-8 字节 |
| 事件名与属性 Key | 自定义名称须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`（事件名 ≤ 128 字符，自定义属性 Key ≤ 64 字符）；系统预置白名单事件（如 `$pageview`、`$signup`、`$login`、`$user_set`）与系统属性（如 `#ip`、`$ip`、`#time`、`$time`、`$os`、`$app_version`、`$device_model`、`$city`、`$url`）直接放行 |
| 支持的属性值类型 | `String`、`Boolean`、`Byte`/`Short`/`Integer`/`Long`、有限 `Float`/`Double`（拒绝 `NaN`/`Infinity`）、`Date`、`Instant`、以及元素非空且不嵌套集合/Map 的一维 `Collection`；值为 `null` 的属性键会被自动忽略 |
