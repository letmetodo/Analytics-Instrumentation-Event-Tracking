# ABI Python 3 服务端 SDK (`abi.sdk/python`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`abi_sdk.py` 是 **ABI 企业级用户行为分析（UBA）与商业智能（BI）平台** 的官方 Python 3 服务端数据采集 SDK（API 设计对标数数科技 ThinkingData Python Server SDK v3.4）。SDK 采用 **100% Python 3 标准库实现（零第三方依赖）**，内置与采集网关（`:8081`）及 Flink 实时 ETL 完全对齐的标识符校验、64 位大整数精度保护以及四种可插拔传输消费者（Consumer）。

---

## 1. 核心特性与四大 Consumer 架构

### 核心特性
- **零第三方依赖**：纯 Python 3.9+ 标准库实现（`urllib.request`、`gzip`、`threading`、`json`、`datetime`），无需安装 `requests` 等外部包即可直接嵌入 FastAPI、Django、Flask、Celery 或 Airflow 任务。
- **并发线程安全**：`AbiAnalytics` 与四大 Consumer 内部均采用线程锁保护，支持在多线程 Web 服务或 Worker 进程中作为全局单例安全调用。
- **客户端前置强校验**：
  - 身份标识先拦截不可见 ASCII 控制字符（`0x00–0x08`、`0x0E–0x1F`、`0x7F`），再裁剪首尾 Unicode 空白符，并严格校验 UTF-8 字节上限（访客/设备 ID `distinct_id <= 64`、实名账号 ID `login_id <= 128`、`event_id <= 64`）；
  - 对标 ThinkingData 双 ID 契约：`distinct_id` 与 `login_id` 至少一个非空；当 `distinct_id` 为空时直接发送 `distinct_id: ""` 与 `login_id: "<account>"`（绝不将 `login_id` 回填至 `distinct_id`）；两者全空直接报错拦截；
  - 自定义事件名（`<= 128` 字符）与自定义属性名（`<= 64` 字符）严格匹配 `^[A-Za-z_][A-Za-z0-9_]*$`，同时放行系统预置事件（`$signup`、`$login`、`$user_*` 等）与系统预置属性（`#ip`/`$ip`、`#time`/`$time`、`$os` 等）。
- **大整数精度保护（`> 2^53 - 1` 自动转字符串）**：严格区分 Python `bool` 与 `int`（在 Python 中 `bool` 是 `int` 的子类），对绝对值超过 IEEE-754 双精度安全整数上限 `9007199254740991`（$2^{53}-1$）的整数（含列表元素，如雪花算法订单号 `9007199254740999`）自动转为十进制字符串，并拦截 `NaN`、`Infinity` 及含 `None` 或嵌套容器的非法列表。
- **静态与动态公共属性分层合并**：严格遵循 `super_properties < dynamic_super_properties < 显式事件 properties` 优先级，且在 `$user_*` / `#user_*` 用户画像操作中自动隔离公共属性。

### 四大 Consumer 架构

| Consumer 类型 | 初始化方式 | 适用场景与核心能力 |
| :--- | :--- | :--- |
| **`StagingConsumer`** | `StagingConsumer(project_id, project_token, dry_run=False)` | **两步式预览与确认提交**：将埋点事件暂存在内存中，第 1 步通过 `preview_request_json()` 预览唯一一份 `POST /collect/api/v1/track/batch` 请求 JSON（零网络请求）；第 2 步确认无误后通过 `submit_to_gateway()` 或 `confirm_submit(target_consumer)` 正式提交。 |
| **`BatchConsumer`** | `BatchConsumer(server_url, project_id, project_token, ...)` | **生产高吞吐异步批量上报**：后台守护线程支持按条数（`batch_size`，默认 50，最大 500）与时间间隔（`flush_interval`，默认 3.0s）自动刷盘，支持 Gzip 压缩及 HTTP `429` / `5xx` 指数退避重试（严格保留原 `event_id` 确保 StarRocks 去重）。 |
| **`LoggerConsumer`** | `LoggerConsumer(directory, file_prefix="abi.log", ...)` | **本地 JSONL 轮转落盘**：按 UTC 日期（`DAILY`，如 `abi.log.2026-11-10.jsonl`）或 UTC 小时（`HOURLY`）及文件大小上限自动切分本地 `.jsonl` 文件，配合 Filebeat / Vector / LogBus 旁路采集。 |
| **`DebugConsumer`** | `DebugConsumer(server_url, project_id, project_token, dry_run=False)` | **研发期同步 L4 强校验与 `dry_run`**：逐条同步发送事件并附带 `debug: True`（可选 `dry_run: True` 仅校验不写入 Kafka / StarRocks），若网关返回校验错误立即抛出 `AbiGatewayError`。 |

---

## 2. 接入人员视角：服务端必填字段与客户端透传指南（`#ip`、每次必传身份、异步 `#time`、幂等 `event_id`）

服务端 SDK 运行在后端容器或机房内，属于**无状态多用户共享单例**，其网络位置与运行态和浏览器/移动端 SDK 截然不同。接入人员在编写后端埋点代码时请务必遵循以下四项规范：

| 核心字段 | SDK 传参位置 | 必填性级别 | 为什么需要 & 研发接入规范 |
| :--- | :--- | :--- | :--- |
| **1. 客户端真实 IP (`#ip` / `$ip`)** | `properties["#ip"]`<br>或 `properties["$ip"]` | **【需地域分析时必传】** | 后端服务请求采集网关 `:8081` 时，网关 TCP 连接看到的是**后端机房内网/NAT 出口 IP**（使用 `LoggerConsumer` 落盘时更无连接 IP）。**若不显式传 `#ip`，所有服务端事件的国家/省份/城市都会变成服务器机房所在地！**<br>请从反向代理请求头（`X-Forwarded-For` 首跳公网 IP 或 `X-Real-IP`）提取用户真实 IP 传入 `properties["#ip"]`。Flink Job1 会优先按 `#ip` > `$ip` 解析省市并在落库前自动剥离该字段。 |
| **2. 每次必传用户身份 (`account_id` / `distinct_id`)** | `track(account_id, distinct_id, ...)`<br>或 `login_id` / `distinct_id` | **【每次调用必传】** | 服务端 SDK 不缓存单用户会话，每次调用 `track*` / `user_*` 必须显式传入当前用户的实名账号 `account_id`（线上面字段 `login_id <= 128B`）与/或前端透传的访客 ID `distinct_id`（`<= 64B`），至少非空其一。<br>若需打通「前端匿名浏览 → 后端下单支付」全漏斗，请让前端通过请求头（如 `X-ABI-Distinct-Id`）将访客 `distinct_id` 透传给后端；任意 `track*` 或 `user_*` 事件同时携带 `account_id` 与 `distinct_id` 时，Flink 实时流会自动建立身份关联（无需单独调用身份绑定接口）。 |
| **3. 异步实际业务时间 (`#time` / `$time` / `timestamp`)** | `properties["#time"]`<br>或 `timestamp=...` | **【实时可省，异步 MQ / 回调 / 补数必传】** | 同步接口默认取服务器当前毫秒时间；但在 **Celery / Kafka 异步消费、第三方支付回调、离线历史数据补导** 场景下，事件处理时间晚于业务实际发生时间，必须通过 `properties["#time"]`（支持 `datetime`、秒/毫秒时间戳、ISO-8601 字符串）传入实际发生时间。SDK 会自动将其提取为顶层毫秒 `timestamp` 并从 `properties` 中剥离。 |
| **4. 确定性幂等主键 (`event_id`)** | `track(..., event_id="...")`<br>（注：按 D7① / G6 门禁，`track_first` / `track_update` / `track_overwrite` 当前版本未开放） | **【核心交易与 MQ 消费强烈推荐】** | 不传时 SDK 自动生成随机 UUIDv4；但在 **MQ 消费重试、Webhook 重放** 场景下，强烈建议传入确定性业务主键（如 `f"ord_paid_{order_no}"`，`<= 64` 字节），利用 StarRocks 主键模型实现同日幂等去重。 |

---

## 3. 快速开始与代码示例

### 3.1 两步式预览请求 JSON 与确认提交（`StagingConsumer`）

```python
from abi_sdk import AbiAnalytics, StagingConsumer

# 第 1 步：初始化 StagingConsumer，在内存中录制埋点并预览唯一一份请求 JSON（零网络请求）
staging = StagingConsumer(project_id=1, project_token="abi_tok_demo_py", dry_run=False)
sdk = AbiAnalytics(staging)

sdk.set_super_properties({
    "$platform": "PythonServer",
    "service_name": "order-service",
})

sdk.track(
    account_id="acct_900102",
    distinct_id="anon_py_7f8e9a01",
    event_name="OrderPaid",
    event_id="ord_paid_20261110_8801",
    properties={
        "#ip": "203.0.113.42",              # 客户端真实公网 IP
        "#time": "2026-11-10T10:00:00Z",    # 自动提取为顶层毫秒 timestamp 并从 properties 剥离
        "order_id": 9007199254740999,       # > 2^53-1 雪花大整数，自动转为字符串 "9007199254740999"
        "pay_amount": 2549.15,
        "is_first_order": True,
    },
)

print("=== 待提交请求 JSON 预览 ===")
print(staging.preview_request_json())

# 第 2 步：确认无误后直接提交至采集网关（或通过 staging.confirm_submit(batch_consumer) 投递）
resp = staging.submit_to_gateway("http://127.0.0.1:8081", compress_gzip=True)
print("Gateway Response:", resp)
```

### 3.2 生产高吞吐 `BatchConsumer` 与全量 API 调用示例

```python
from datetime import datetime, timezone
from abi_sdk import AbiAnalytics, BatchConsumer

consumer = BatchConsumer(
    server_url="http://127.0.0.1:8081",
    project_id=1,
    project_token="abi_tok_prod_secret",
    batch_size=100,
    flush_interval=2.0,
    compress_gzip=True,
    max_retries=3,
)
sdk = AbiAnalytics(consumer)

# 1. 静态与动态公共属性（仅注入行为事件，自动隔离 $user_* 画像事件）
sdk.set_super_properties({"$platform": "PythonServer", "service_name": "checkout-svc"})
sdk.set_dynamic_super_properties(lambda: {"server_region": "ap-shanghai"})

account_id = "acct_900102"
vis_id = "vis_py_7f8e9a01"    # 从前端请求头 X-ABI-Distinct-Id 透传获取
client_ip = "203.0.113.42"    # 从 X-Forwarded-For / X-Real-IP 提取

# 2. 登录与行为事件：同时携带 account_id 与 distinct_id 时 Flink 自动完成身份关联
sdk.track(account_id, vis_id, "$login", {"#ip": client_ip, "login_method": "sso_oidc"})

# 3. 行为事件：标准事件与确定性 event_id 同日幂等重放（注：按 D7① / G6 门禁，track_first/track_update/track_overwrite 当前版本未开放，调用将抛出 AbiUnsupportedError）
sdk.track(account_id, vis_id, "OrderPaid", {
    "#ip": client_ip,
    "#time": datetime.now(timezone.utc),
    "order_id": 9007199254740999,
    "amount": 299.0,
}, event_id="ord_paid_8801")

# 4. 7 类用户画像方法
sdk.user_set(account_id, vis_id, {"plan_tier": "Enterprise", "seat_count": 50})
sdk.user_set_once(account_id, vis_id, {"first_utm_source": "google_sem"})
sdk.user_add(account_id, vis_id, {"total_orders": 1, "lifetime_spent": 299.0})
sdk.user_append(account_id, vis_id, {"browsed_modules": ["event", "funnel"]})
sdk.user_uniq_append(account_id, vis_id, {"owned_badges": ["early_adopter"]})
sdk.user_unset(account_id, vis_id, "legacy_trial_tag")
# sdk.user_delete(account_id, vis_id)

# 进程退出前排空缓冲队列并安全关闭
sdk.close()
```

### 3.3 本地 JSONL 轮转落盘（`LoggerConsumer`）与同步联调（`DebugConsumer`）

```python
from abi_sdk import AbiAnalytics, DebugConsumer, LoggerConsumer

# LoggerConsumer：按 UTC 日期切分本地 .jsonl 文件（如 /var/log/abi/abi.log.2026-11-10.jsonl）
logger_consumer = LoggerConsumer(directory="/var/log/abi", file_prefix="abi.log")

# DebugConsumer：开启网关 L4 严格校验与 dry_run 零污染预检
debug_consumer = DebugConsumer(
    server_url="http://127.0.0.1:8081",
    project_id=1,
    project_token="abi_tok_demo_py",
    dry_run=True,
)
```

---

## 4. 运行两步式 CLI Demo 与单元测试套件

```bash
# 运行标准 unittest 契约与单元测试套件（含跨语言黄金测试向量验证）
python3 -m unittest discover -s abi.sdk/python/tests -v

# 运行两步式交互 Demo（第 1 步预览唯一请求 JSON，第 2 步自动确认提交并打印唯一响应 JSON）
python3 abi.sdk/python/examples/demo.py --yes
```
