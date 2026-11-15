# ABI 数据采集 RESTful API 使用指南

本指南介绍如何在不依赖客户端或服务端 SDK 的情况下，直接使用标准 HTTP `POST` 请求向 ABI 采集网关（Ingest Gateway）上报用户行为事件与用户画像数据。

采集接口统一采用 **UTF-8 原生 JSON（无需 URL Encode）** 报文格式。文中所有请求与响应报文均已按标准缩进排版，方便阅读、核对与直接复制联调。

---

## 目录

- [1. 接口概览](#1-接口概览)
- [2. 数据格式规范](#2-数据格式规范)
  - [2.1 顶层请求体结构](#21-顶层请求体结构)
  - [2.2 单条事件对象结构与约束](#22-单条事件对象结构与约束)
  - [2.3 事件名、属性名与值类型规则](#23-事件名属性名与值类型规则)
- [3. 数据上报示例（格式化报文）](#3-数据上报示例格式化报文)
  - [3.1 单条行为事件上报](#31-单条行为事件上报)
  - [3.2 多条事件批量上报（访客浏览 → 登录双 ID 自动关联 → 实名下单）](#32-多条事件批量上报访客浏览--登录双-id-自动关联--实名下单)
  - [3.3 同日幂等重放（固定 `event_id`）与未开放可变事件说明](#33-同日幂等重放固定-event_id与未开放可变事件说明)
  - [3.4 用户画像操作上报（7 类 `$user_*` 操作全集）](#34-用户画像操作上报7-类-user_-操作全集)
  - [3.5 Gzip 压缩批量上报（高吞吐生产推荐）](#35-gzip-压缩批量上报高吞吐生产推荐)
- [4. Debug 联调模式与 Dry-Run 演练模式](#4-debug-联调模式与-dry-run-演练模式)
  - [4.1 Debug 联调模式（`debug: true`）](#41-debug-联调模式debug-true)
  - [4.2 Dry-Run 零污染预检模式（`dry_run: true`）](#42-dry-run-零污染预检模式dry_run-true)
- [5. 多语言原生 HTTP 调用示例（无需安装 SDK）](#5-多语言原生-http-调用示例无需安装-sdk)
  - [5.1 Python 3（标准库）](#51-python-3标准库)
  - [5.2 Node.js 18+ / TypeScript（原生 `fetch`）](#52-nodejs-18--typescript原生-fetch)
- [6. 响应结构、错误码速查与常见问题](#6-响应结构错误码速查与常见问题)

---

## 1. 接口概览

| 配置项 | 说明 |
| :--- | :--- |
| **请求方式** | `POST` |
| **接口路径** | `/collect/api/v1/track/batch` |
| **本地开发环境地址** | `http://127.0.0.1:8081/collect/api/v1/track/batch` |
| **私有化 / 生产环境地址** | `https://<您的采集网关域名>/collect/api/v1/track/batch` |
| **字符编码** | `UTF-8` |
| **Content-Type** | `application/json; charset=utf-8`（直接提交 JSON 文本，**无需 urlencode**） |
| **可选请求头** | `Content-Encoding: gzip`（开启请求体 Gzip 压缩，解压后体积上限 `10 MiB`）<br>`X-Request-Id: <自定义追踪ID>`（原样透传至响应 `request_id`，便于端到端链路排查）<br>`User-Agent: <调用方标识/版本号>`（记录至入湖元数据 `sdk_agent` 字段） |

---

## 2. 数据格式规范

### 2.1 顶层请求体结构

```json
{
  "project_id": 1,
  "project_token": "abi_tok_demo_secret",
  "debug": false,
  "dry_run": false,
  "events": [
    {
      "event_id": "018f6b9c-7c40-7000-8000-000000000001",
      "event_name": "OrderPaid",
      "distinct_id": "vis_ios_99a1",
      "login_id": "u_10086",
      "timestamp": 1794283200000,
      "properties": {
        "$ip": "203.0.113.42",
        "$os": "iOS",
        "$app_version": "2.4.0",
        "order_id": "9007199254740993",
        "pay_amount": 199.0,
        "is_first_order": true,
        "item_categories": [
          "electronics",
          "accessories"
        ]
      }
    }
  ]
}
```

| 字段名 | 类型 | 必填 | 说明 |
| :--- | :--- | :---: | :--- |
| `project_id` | `int64` | 是 | ABI 管理后台「项目管理」中分配的项目数字 ID（必须 `> 0`） |
| `project_token` | `string` | 是 | 项目对应的采集鉴权 Token（不可为空） |
| `debug` | `boolean` | 否 | 默认 `false`。设为 `true` 时开启 L4 严格校验并在响应 `data.errors` 中返回逐条错误原因（详见 [第 4 节](#4-debug-联调模式与-dry-run-演练模式)） |
| `dry_run` | `boolean` | 否 | 默认 `false`。设为 `true` 时仍正常执行项目鉴权、L4 严格校验与项目级 QPS 限流保护（`rate_limit_qps`），但**不写入 Kafka、StarRocks 与死信队列** |
| `events` | `array<object>` | 是 | 事件列表，单条上报同样放入长度为 `1` 的数组中；单批条数不得超过项目配置的 `max_batch_size`（建议单批 `50 ~ 500` 条） |

### 2.2 单条事件对象结构与约束

`events` 数组中的每个元素代表一条行为事件或一次用户画像变更：

| 字段名 | 类型 | 必填 | 长度 / 格式约束与业务说明 |
| :--- | :--- | :---: | :--- |
| `event_id` | `string` | 推荐 | **≤ 64 UTF-8 字节**。幂等事件主键（推荐 UUIDv4 或确定性业务键如 `"order_paid_10001"`）。不传时由网关自动生成 UUID |
| `event_name` | `string` | 是 | **≤ 128 字符**。自定义事件名须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`；系统预置事件与画像事件以 `$` 开头 |
| `distinct_id` | `string` | 条件必填 | **≤ 64 UTF-8 字节**。访客或终端设备标识（如客户端设备 ID、Web 访客 Cookie ID）。**`distinct_id` 与 `login_id` 至少需要提供一个非空白字符串**；当已提供非空 `login_id` 且无客户端设备上下文（如纯后端批处理/Webhook）时允许传空字符串 `""`（**切勿将 `login_id` 拷贝或截断回填至 `distinct_id`**） |
| `login_id` | `string` | 条件必填 | **≤ 128 UTF-8 字节**。用户实名登录后的业务账号标识（未登录访客可不传或传空字符串 `""`）。当任一事件或画像操作同时携带非空 `distinct_id` 与 `login_id` 时，下游 Flink 会自动在 `identity_map` 中完成双 ID 实时归因关联 |
| `timestamp` | `int64` | 条件必填 | 事件发生的 **Unix 毫秒时间戳**（如 `1794283200000`），且与服务器当前时间差不得超出项目允许的时间窗口（`ts_window_days`）；若在 `properties` 中传入了 `"#time"` 或 `"$time"`，网关会自动提取并覆写 `timestamp` |
| `properties` | `object` | 否 | 自定义业务属性与环境预置属性字典（详见 2.3 与 2.4） |

> **身份字段字符规范**：`event_id`、`distinct_id`、`login_id` 必须是合法的 UTF-8 字符串，严禁包含不可见 ASCII 控制字符（`0x00–0x08`、`0x0E–0x1F`、`0x7F`），首尾空白符会被自动裁剪。

### 2.4 接入人员必读：客户端直连 vs. 服务端上报的字段职责差异

直接使用 HTTP 接口或不同端 SDK 接入时，**「谁负责提供 IP、设备信息、身份标识、时间戳」** 在不同网络拓扑下截然不同：

| 核心字段 | 客户端直连网关（浏览器 / 小程序 / App 直接请求 `:8081`） | 服务端上报网关（后端微服务 / 批处理 / MQ 消费者请求 `:8081`） |
| :--- | :--- | :--- |
| **用户真实 IP 与地域 (`#ip` / `$ip`)** | **客户端无需传**。浏览器 JS 和移动端 App 本身拿不到公网出口 IP；采集网关会自动从 TCP 连接 / 反向代理 `X-Forwarded-For` 提取客户端公网 IP（`client_ip`）交由 Flink 解析国家/省份/城市。 | **服务端必传（若需地域分析）**。服务端发起请求时，网关看到的连接 IP 是**后端机房内网/NAT IP**。后端接入人员必须从前端请求头（`X-Forwarded-For` / `X-Real-IP`）拿到用户真实 IP，显式塞入 `properties["#ip"]`（或 `"$ip"`），Flink 会优先按 `#ip`/`$ip` 解析用户真实省市并落库。 |
| **用户身份 (`distinct_id` / `login_id`)** | 客户端 SDK 首次初始化自动生成并持久化设备级访客 `distinct_id`，未登录时无需人工传参；登录时调用 `login(accountId)` 纯本地保存 `login_id`，后续事件自动同时携带双 ID。 | **每次调用必填**。服务端是无状态多租户/多用户共享实例，无法缓存“当前用户”，每次上报必须显式传入该笔业务归属的 `login_id` 与/或前端请求头（如 `X-ABI-Distinct-Id`）透传过来的访客 `distinct_id`（两者至少传其一，切勿将 `login_id` 拷贝回填到 `distinct_id`）。 |
| **事件时间 (`timestamp` / `#time` / `$time`)** | 客户端实时触发时由 SDK 自动取当前毫秒时间戳（`Date.now()`），接入人员无需手填。 | 实时接口可由服务端 SDK 自动取当前时间；但若为**异步 MQ 消费延迟上报、第三方支付回调或历史数据补导**，服务端必须通过 `properties["#time"]`（或顶层 `timestamp`）传入**实际业务发生时间**。 |
| **幂等主键 (`event_id`)** | 客户端 SDK 自动生成 UUIDv4 并在断网离线重发时保持不变。 | 服务端涉及 MQ 重试或核心交易（如 `OrderPaid`）时，**强烈建议传入确定性业务主键**（如 `"ord_paid_" + orderNo`），防止消费重试造成重复统计。 |
| **终端设备属性 (`$os` / `$app_version` / `$model`)** | 客户端 SDK 自动从浏览器 `navigator` 或原生系统 API 采集注入。 | 服务端运行在 Linux 容器中，若需按客户端系统/版本拆分服务端事件，需由前端请求头透传并由服务端放入 `properties`。 |

### 2.3 事件名、属性名与值类型规则

1. **命名规则**：
   - **自定义事件名 / 属性 Key**：必须以英文字母或下划线开头，仅包含字母、数字和下划线（正则 `^[A-Za-z_][A-Za-z0-9_]*$`）；事件名最长 **128 字符**，自定义属性 Key 最长 **64 字符**。
   - **系统预置事件白名单**：`$signup`、`$login`、`$pageview`、`$AppStart`、`$AppEnd`、`$AppClick`、`$AppViewScreen`，以及 7 类用户画像事件 `$user_set`、`$user_set_once`、`$user_add`、`$user_unset`、`$user_append`、`$user_uniq_append`、`$user_del`。
   - **系统预置属性白名单**：`$ip`、`$os`、`$os_version`、`$app_version`、`$platform`、`$device_id`、`$model`、`$device_model`、`$manufacturer`、`$carrier`、`$network`、`$network_type`、`$screen_width`、`$screen_height`、`$browser`、`$browser_version`、`$country`、`$country_code`、`$province`、`$city`、`$url`、`$url_path`、`$referrer`、`$title`、`$duration`、`$session_id`、`$lib`、`$lib_version`、`$zone_offset`。（*注：`$first_check_id` / `#first_check_id` 首次行为校验键在当前版本未开放，后端不执行全局首次去重，详见 3.3 节*）。
2. **支持的属性值类型**：
   - **字符串（`String`）**：如 `"Shanghai"`、ISO-8601 时间 `"2026-11-10T04:00:00Z"`。
   - **数值（`Number`）**：整数或有限浮点数（如 `199.5`、`3`），**严禁传入 `NaN` 或 `Infinity`**。
   - **大整数精度保护（`> 2^53 - 1`）**：当 64 位长整型（如分布式雪花订单号 `9007199254740993`）绝对值超过 IEEE-754 安全整数上限 `9007199254740991` 时，**请务必转为字符串传输**（如 `"9007199254740993"`），防止 JSON 解析丢失低位精度。
   - **布尔值（`Boolean`）**：`true` / `false`。
   - **一维数组（`Array`）**：元素仅限非 `null` 的基础标量（字符串、数值、布尔值），不支持嵌套对象或二维数组。
   - **空值处理**：属性值为 `null` 的键会被自动忽略（`$user_unset` 除外）。
3. **属性内时间字段解析（可选）**：
   - 推荐直接传入顶层毫秒 `timestamp`；若业务日志将事件时间放在 `properties` 的 `"$time"` 字段中（支持 RFC3339 `"2026-11-10T12:00:00+08:00"`、`"2026-11-10 12:00:00.000"` 或毫秒/秒级数字），网关会按项目时区自动将其转换为顶层毫秒 `timestamp` 并从 `properties` 中剥离。

---

## 3. 数据上报示例（格式化报文）

> 以下所有 `curl` 示例均使用多行 `<<'EOF'` 标准格式化 JSON，可直接复制到终端执行（请将网关地址、`project_id` 与 `project_token` 替换为您环境的实际值）。

### 3.1 单条行为事件上报

上报一条用户完成支付的 `OrderPaid` 事件：

```bash
curl -X POST "http://127.0.0.1:8081/collect/api/v1/track/batch" \
  -H "Content-Type: application/json; charset=utf-8" \
  -H "X-Request-Id: req_demo_single_001" \
  --data-binary @- <<'EOF'
{
  "project_id": 1,
  "project_token": "abi_tok_demo_secret",
  "events": [
    {
      "event_id": "evt_order_paid_20261110_0001",
      "event_name": "OrderPaid",
      "distinct_id": "vis_ios_99a1b2c3",
      "login_id": "u_10086",
      "timestamp": 1794283200000,
      "properties": {
        "$lib": "restful-api",
        "$lib_version": "1.0.0",
        "$ip": "203.0.113.88",
        "$os": "iOS",
        "$os_version": "18.1",
        "$app_version": "3.2.0",
        "order_id": "9007199254740993",
        "payment_method": "apple_pay",
        "pay_amount": 299.0,
        "currency": "CNY",
        "used_coupon": true,
        "sku_list": [
          "sku_pro_annual",
          "sku_addon_ai"
        ]
      }
    }
  ]
}
EOF
```

**成功返回示例（HTTP `200 OK`）**：

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "accepted": 1,
    "rejected": 0
  },
  "request_id": "req_demo_single_001"
}
```

---

### 3.2 多条事件批量上报（访客浏览 → 登录双 ID 自动关联 → 实名下单）

在生产环境中，建议将多条事件合并至同一个 `events` 数组批量提交（例如攒够 `50 ~ 200` 条或每隔 `2` 秒发送一次）。对标数数科技 ThinkingData 双 ID 规范，无需发送单独的身份绑定事件——只要登录后的任意事件同时携带访客 `distinct_id` 与账号 `login_id`，下游 Flink 即实时完成全链路归因关联。以下示例演示了完整的「**未登录访客浏览商品 → 账号登录（`$login` 同时携带双 ID 自动完成关联） → 实名提交订单**」三步事件批量上报：

```bash
curl -X POST "http://127.0.0.1:8081/collect/api/v1/track/batch" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary @- <<'EOF'
{
  "project_id": 1,
  "project_token": "abi_tok_demo_secret",
  "events": [
    {
      "event_id": "018f6b9c-7c40-7000-8000-000000000101",
      "event_name": "ProductViewed",
      "distinct_id": "vis_web_7f8e9d",
      "timestamp": 1794283180000,
      "properties": {
        "$platform": "Web",
        "$url": "https://shop.example.com/products/pro-plan",
        "$title": "企业专业版订阅",
        "product_id": "prod_pro_plan",
        "price": 299.0
      }
    },
    {
      "event_id": "018f6b9c-7c40-7000-8000-000000000102",
      "event_name": "$login",
      "distinct_id": "vis_web_7f8e9d",
      "login_id": "u_20099",
      "timestamp": 1794283195000,
      "properties": {
        "$platform": "Web",
        "login_method": "sso_oidc"
      }
    },
    {
      "event_id": "018f6b9c-7c40-7000-8000-000000000103",
      "event_name": "OrderCreated",
      "distinct_id": "vis_web_7f8e9d",
      "login_id": "u_20099",
      "timestamp": 1794283200000,
      "properties": {
        "$platform": "Web",
        "order_id": "ORD-20261110-20099",
        "order_status": "created",
        "order_amount": 299.0
      }
    }
  ]
}
EOF
```

**成功返回示例**：

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "accepted": 3,
    "rejected": 0
  },
  "request_id": "8e3b9f10-4c21-4d8a-9b12-71a0e6d2c110"
}
```

---

### 3.3 同日幂等重放（固定 `event_id`）与未开放可变事件说明

> ⚠️ **功能开放状态说明（D7① / G6 门禁）**：
> 当前版本后端存储与清洗管道（StarRocks `dwd_events` 按天分区主键模型）**未开放** `trackFirst` / `$first_check_id` / `#first_check_id`（首次行为去重）、`trackUpdate`（事件局部属性更新）与 `trackOverwrite`（跨天事件整行覆盖重写）。全语言客户端与服务端 SDK 中的对应接口已统一收敛为**显式拒绝/报错拦截**（Unsupported in current version），绝不静默伪造普通 `track` 事件入队。
> - **切勿使用相同 `event_id` 模拟订单状态局部流转**（如 `created -> settled -> refunded`）：同日传入相同 `event_id` 会整行替换并抹除前序事件未再次携带的属性，跨天传入相同 `event_id` 则会在新日期分区产生重复行。业务状态推进请拆分为独立里程碑事件（如 `OrderCreated`、`OrderPaid`、`OrderRefunded`）。

当客户端断网重试或上游消息队列（MQ / Webhook）在同一事件日期（`event_date`）分区内发生**完全相同报文的消费重放**时，只需保持**相同的 `event_name`、`timestamp` 与确定性 `event_id`**，下游存储即可基于主键自动完成同日幂等去重：

```bash
curl -X POST "http://127.0.0.1:8081/collect/api/v1/track/batch" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary @- <<'EOF'
{
  "project_id": 1,
  "project_token": "abi_tok_demo_secret",
  "events": [
    {
      "event_id": "ord_paid_20261110_20099",
      "event_name": "OrderPaid",
      "distinct_id": "vis_web_7f8e9d",
      "login_id": "u_20099",
      "timestamp": 1794283500000,
      "properties": {
        "order_id": "ORD-20261110-20099",
        "order_status": "paid",
        "paid_amount": 269.1,
        "discount_code": "ANNUAL10"
      }
    }
  ]
}
EOF
```

---

### 3.4 用户画像操作上报（7 类 `$user_*` 操作全集）

用户画像变更与行为事件共用同一个 `/collect/api/v1/track/batch` 接口，通过将 `event_name` 指定为对应的系统保留事件名路由至 StarRocks 用户维表（`dim_users`）。

> **最佳实践**：上报 `$user_*` 事件时，`properties` 中**仅需携带要修改的用户画像属性**，请勿混入 `$url`、`$app_version` 等行为环境属性，以免污染用户画像宽表。

| `event_name` | 画像更新语义 | `properties` 取值要求 |
| :--- | :--- | :--- |
| `$user_set` | 覆盖设置用户最新属性（存在则覆盖，不存在则新增） | 任意合法标量或一维数组 |
| `$user_set_once` | 仅当该属性尚未设置时首次写入（适用于注册渠道、首单时间等归因字段） | 任意合法标量或一维数组 |
| `$user_add` | 对数值型属性执行原子累加/扣减（传入负数即为扣减） | **仅限数值型（`Number`）** |
| `$user_append` | 向列表型（`Array`）属性末尾追加元素（不去重） | 一维数组（如 `["tag_a", "tag_b"]`） |
| `$user_uniq_append` | 向列表型（`Array`）属性追加元素并自动集合去重 | 一维数组（如 `["badge_pro"]`） |
| `$user_unset` | 清空指定的用户画像属性键 | 待清空的属性名作为 Key，Value 统一填 `0` 或 `""` 占位 |
| `$user_del` | 删除当前用户的画像记录 | 传空对象 `{}` 即可 |

**画像操作组合上报格式化示例**：

```bash
curl -X POST "http://127.0.0.1:8081/collect/api/v1/track/batch" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary @- <<'EOF'
{
  "project_id": 1,
  "project_token": "abi_tok_demo_secret",
  "events": [
    {
      "event_id": "usr_op_set_001",
      "event_name": "$user_set",
      "distinct_id": "vis_ios_99a1",
      "login_id": "u_10086",
      "timestamp": 1794283201000,
      "properties": {
        "nickname": "Alex Chen",
        "vip_level": 3,
        "$city": "Shanghai",
        "plan_tier": "Enterprise"
      }
    },
    {
      "event_id": "usr_op_set_once_001",
      "event_name": "$user_set_once",
      "distinct_id": "vis_ios_99a1",
      "login_id": "u_10086",
      "timestamp": 1794283201000,
      "properties": {
        "first_utm_source": "google_sem",
        "registered_at": "2026-11-10T04:00:00Z"
      }
    },
    {
      "event_id": "usr_op_add_001",
      "event_name": "$user_add",
      "distinct_id": "",
      "login_id": "u_10086",
      "timestamp": 1794283202000,
      "properties": {
        "total_orders": 1,
        "lifetime_spent": 299.0
      }
    },
    {
      "event_id": "usr_op_uniq_append_001",
      "event_name": "$user_uniq_append",
      "distinct_id": "vis_ios_99a1",
      "login_id": "u_10086",
      "timestamp": 1794283203000,
      "properties": {
        "owned_badges": [
          "early_adopter",
          "annual_subscriber"
        ]
      }
    },
    {
      "event_id": "usr_op_unset_001",
      "event_name": "$user_unset",
      "distinct_id": "",
      "login_id": "u_10086",
      "timestamp": 1794283204000,
      "properties": {
        "trial_expired_flag": 0,
        "temp_campaign_tag": 0
      }
    }
  ]
}
EOF
```

---

### 3.5 Gzip 压缩批量上报（高吞吐生产推荐）

在公网传输或大批量（如单批 200 条）上报时，开启 Gzip 通常可将 JSON 体积压缩 **75% ~ 85%**。只需将格式化 JSON 经 `gzip` 压缩，并附带请求头 `Content-Encoding: gzip` 即可（解压后总大小上限为 `10 MiB`）：

```bash
cat <<'EOF' | gzip -c | curl -X POST "http://127.0.0.1:8081/collect/api/v1/track/batch" \
  -H "Content-Type: application/json; charset=utf-8" \
  -H "Content-Encoding: gzip" \
  --data-binary @-
{
  "project_id": 1,
  "project_token": "abi_tok_demo_secret",
  "events": [
    {
      "event_id": "evt_gzip_demo_001",
      "event_name": "BatchExportSynced",
      "distinct_id": "",
      "login_id": "u_10086",
      "timestamp": 1794283200000,
      "properties": {
        "batch_source": "erp_nightly_job",
        "synced_records": 500
      }
    }
  ]
}
EOF
```

---

## 4. Debug 联调模式与 Dry-Run 演练模式

> **注意**：`debug` 与 `dry_run` 会对每条事件及所有属性键、属性值类型执行 L4 严格校验，**仅适用于开发联调或 CI 自动化门禁，请勿在高并发生产流量中常驻开启**。

### 4.1 Debug 联调模式（`debug: true`）

- **行为**：校验通过的事件正常写入 Kafka；校验未通过的事件写入死信队列（`track_dlq`），并在 HTTP 响应的 `data.errors` 中逐条返回失败索引（`index`）、`event_id`、`event_name` 与具体错误原因（`reason`）。

### 4.2 Dry-Run 零污染预检模式（`dry_run: true`）

- **行为**：仍经过项目鉴权、项目级 QPS 限流（`rate_limit_qps`）及与 `debug: true` 完全一致的 L4 严格 Schema 校验并返回 `data.errors`，但**无论校验成功或失败，均不会向线上 Kafka、StarRocks 或死信队列写入任何测试脏数据**。适合新埋点上线前的冒烟测试。

**Dry-Run 校验错误演示请求（故意传入非法事件名与非法属性名）**：

```bash
curl -X POST "http://127.0.0.1:8081/collect/api/v1/track/batch" \
  -H "Content-Type: application/json; charset=utf-8" \
  --data-binary @- <<'EOF'
{
  "project_id": 1,
  "project_token": "abi_tok_demo_secret",
  "debug": true,
  "dry_run": true,
  "events": [
    {
      "event_id": "evt_valid_001",
      "event_name": "CheckoutStarted",
      "distinct_id": "u_10086",
      "timestamp": 1794283200000,
      "properties": {
        "cart_items_count": 2,
        "cart_total": 398.0
      }
    },
    {
      "event_id": "evt_invalid_002",
      "event_name": "123-Bad-Event-Name",
      "distinct_id": "u_10086",
      "timestamp": 1794283200000,
      "properties": {
        "bad-key-with-dash": "test"
      }
    }
  ]
}
EOF
```

**Dry-Run 响应结果示例（清晰指出第 1 条成功、第 2 条失败原因）**：

```json
{
  "code": 200,
  "message": "success",
  "data": {
    "accepted": 1,
    "rejected": 1,
    "dry_run": true,
    "errors": [
      {
        "index": 1,
        "event_id": "evt_invalid_002",
        "event_name": "123-Bad-Event-Name",
        "reason": "invalid event_name \"123-Bad-Event-Name\": must match ^[A-Za-z_][A-Za-z0-9_]*$ or be a system event"
      }
    ]
  },
  "request_id": "4f9c2a18-0d3e-47a9-8e15-391b7c88d002"
}
```

---

## 5. 多语言原生 HTTP 调用示例（无需安装 SDK）

对于 Python 数据脚本、Airflow 调度任务、Webhook / Serverless 函数等未引入专用 SDK 的场景，可直接使用语言内置 HTTP 客户端构造 JSON 报文上报。

### 5.1 Python 3（标准库）

```python
import gzip
import json
import time
import uuid
import urllib.request

GATEWAY_URL = "http://127.0.0.1:8081/collect/api/v1/track/batch"
MAX_SAFE_INT = 9007199254740991  # 2^53 - 1


def safe_int(val: int):
    """超过 IEEE-754 安全整数范围的 64 位长整型自动转为字符串，避免精度丢失"""
    return str(val) if abs(val) > MAX_SAFE_INT else val


payload = {
    "project_id": 1,
    "project_token": "abi_tok_demo_secret",
    "debug": False,
    "events": [
        {
            "event_id": str(uuid.uuid4()),
            "event_name": "SubscriptionRenewed",
            "distinct_id": "vis_ios_99a1",
            "login_id": "u_10086",
            "timestamp": int(time.time() * 1000),
            "properties": {
                "$lib": "python-http",
                "$lib_version": "1.0.0",
                "invoice_snowflake_id": safe_int(9007199254740999),
                "plan_name": "Enterprise_Annual",
                "renew_amount": 2999.0,
                "auto_renew": True,
            },
        }
    ],
}

# 打印格式化请求报文便于本地核对
print("Request Payload:\n", json.dumps(payload, indent=2, ensure_ascii=False))

compressed_body = gzip.compress(json.dumps(payload, ensure_ascii=False).encode("utf-8"))
req = urllib.request.Request(
    GATEWAY_URL,
    data=compressed_body,
    headers={
        "Content-Type": "application/json; charset=utf-8",
        "Content-Encoding": "gzip",
        "User-Agent": "abi-python-restful-demo/1.0.0",
    },
    method="POST",
)

with urllib.request.urlopen(req, timeout=10) as resp:
    result = json.loads(resp.read().decode("utf-8"))
    print("Gateway Response:\n", json.dumps(result, indent=2, ensure_ascii=False))
```

### 5.2 Node.js 18+ / TypeScript（原生 `fetch`）

```javascript
import { randomUUID } from "node:crypto";

const GATEWAY_URL = "http://127.0.0.1:8081/collect/api/v1/track/batch";

const payload = {
  project_id: 1,
  project_token: "abi_tok_demo_secret",
  events: [
    {
      event_id: randomUUID(),
      event_name: "WebhookPaymentSucceeded",
      distinct_id: "",
      login_id: "u_10086",
      timestamp: Date.now(),
      properties: {
        $lib: "node-fetch",
        $lib_version: "1.0.0",
        // BigInt 雪花 ID 直接转为十进制字符串
        order_id: 9007199254740993n.toString(),
        amount: 199.0,
        currency: "USD",
      },
    },
  ],
};

const response = await fetch(GATEWAY_URL, {
  method: "POST",
  headers: {
    "Content-Type": "application/json; charset=utf-8",
    "User-Agent": "abi-node-webhook/1.0.0",
  },
  body: JSON.stringify(payload, null, 2),
});

const body = await response.json();
console.log("HTTP Status:", response.status);
console.log("Gateway Response:\n", JSON.stringify(body, null, 2));
```

---

## 6. 响应结构、错误码速查与常见问题

### 6.1 错误响应结构示例

当鉴权失败、JSON 格式非法、触发限流或整批事件全部校验失败时，网关返回非 `200` HTTP 状态码及如下格式化错误信封：

```json
{
  "code": 32020,
  "message": "invalid or expired project token",
  "data": "",
  "request_id": "9c210e44-112b-49c3-a709-6e118a3f9012"
}
```

### 6.2 采集网关业务状态码一览

| HTTP 状态码 | 响应 `code` | 错误原因说明 | 客户端推荐处理策略 |
| :---: | :---: | :--- | :--- |
| `200` | `200` | 上报成功（查看 `data.accepted` / `data.rejected` 确认明细） | 正常完成，无需重试 |
| `400` | `32001` | 请求体超出大小上限（Gzip 解压后最大 `10 MiB`） | **不重试**；拆分缩减单批事件数量 |
| `400` | `32002` | 单批 `events` 条数超出项目 `max_batch_size` 上限 | **不重试**；建议将单批控制在 `50 ~ 500` 条 |
| `400` | `32003` | 请求体不是合法的 UTF-8 JSON 或 Gzip 流损坏 | **不重试**；检查 JSON 语法与 `Content-Encoding` 头 |
| `400` | `32004` | 缺失 `project_id`、`project_token` 或 `events` 为空数组 | **不重试**；补齐必填顶层字段 |
| `400` | `32044` | 非 Debug 模式下整批事件全部未通过基础校验（已入死信队列） | **不重试**；使用 `dry_run: true` 查看具体 `errors` 原因 |
| `401` | `32020` | `project_id` 与 `project_token` 不匹配或 Token 已失效 | **不重试**；前往管理后台核对项目采集凭证 |
| `403` | `32021` | 目标项目已被管理员停用 | **不重试**；确认项目启用状态 |
| `422` | `32040` ~ `32045` | 缺失 `event_name` / 身份标识、长度超限或 `timestamp` 超出时间窗口 | **不重试**；修正字段格式与毫秒时间戳单位 |
| `429` | `32060` | 触发项目 QPS 限流或网关 IP 速率限制 | **指数退避重试**（保留原 `event_id` 不变，避免重复计数） |
| `503` | `32080` / `32081` | 消息队列或网关下游瞬态繁忙 | **指数退避重试**（保留原 `event_id` 不变，建议退避 `100ms -> 200ms -> 400ms`） |

### 6.3 常见问题排查（FAQ）

1. **为什么返回 `timestamp is out of allowed window`？**
   - **原因 1（秒与毫秒混淆）**：顶层 `timestamp` 要求传入 **13 位毫秒级** Unix 时间戳（例如 `1794283200000`），如果误传了 10 位秒级时间戳（`1794283200`），会被识别为 1970 年的时间从而超出项目时间窗口。
   - **原因 2（历史数据回填）**：项目默认只接收合理时间窗口（`ts_window_days`）内的实时/准实时数据；如需补导数月前的历史离线日志，请先在项目管理中调大对应项目的采集时间窗口配置。
2. **RESTful API 上报的数据需要做 `urlencode` 吗？**
   - **不需要**。ABI 采集网关统一接收原生 `application/json; charset=utf-8` 请求体，直接发送可读的 JSON 文本（或 Gzip 压缩后的 JSON 字节流）即可。
3. **客户端真实 IP 与地域解析（国家/省份/城市）如何生效？**
   - 若服务端代替客户端通过 RESTful API 转发埋点，网关看到的连接 IP 是您的业务服务器内网/出口 IP；此时请在事件的 `properties` 中显式传入客户端真实 IP（如 `"$ip": "203.0.113.88"`），下游 Flink 实时 ETL 会优先基于 `$ip` 解析地理位置信息。
