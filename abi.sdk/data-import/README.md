# ABI 数据导入与服务端日志传输套件 (`abi.sdk/data-import`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`abi.sdk/data-import` 对标 [ThinkingData（数数科技）v3.4 数据导入与传输工具菜单](https://docs.thinkingdata.cn/ta-manual/v3.4/installation/installation_menu/installation_menu.html)（`LogBus 2`、`Filebeat + Logstash`、`Vector`、`ta-datax-writer`），为以下两类核心生产场景提供标准化工具与开箱即用配置：

1. **服务端 SDK 本地落盘日志实时转发**：业务后端（Go / Java 等）通过 `LoggerConsumer` 将埋点事件以毫秒级无阻塞方式追加写入本地磁盘 `.jsonl`（`abi.log.YYYY-MM-DD`），再由独立进程（`abi_logbus.py`、`Filebeat + Logstash` 或 `Vector`）按断点 Offset 异步批量压缩上报至 ABI 采集网关（`:8081`），彻底实现**业务主链路与网络 I/O 解耦**；
2. **历史离线存量数据批量迁移（DataX）**：将存量业务关系数据库（MySQL / PostgreSQL）或数仓历史表中的订单、注册与用户画像数据，通过 `datax/ta-datax-abi-writer.json` 批量回填至 ABI 采集网关与 StarRocks OLAP 分析引擎。

---

## 1. 目录结构与工具选型对比

| 文件 / 目录 | 对标数数科技组件 | 适用场景与架构职责 | 外部依赖 |
|-------------|------------------|--------------------|----------|
| [`abi_logbus.py`](abi_logbus.py) | **LogBus 2** | 轻量级本地 `LoggerConsumer` `.jsonl` 目录扫描与批量转发器；内置文件 Inode + Byte Offset 断点续传（`.abi_logbus_state.json`）、Gzip 压缩、`#time` 提取、大整数精度保护，以及**两步式请求 JSON 预览（`--preview`）与确认提交（`--yes`）** | 仅依赖 Python 3 标准库（零第三方包） |
| [`filebeat-logstash/filebeat.abi.yml`](filebeat-logstash/filebeat.abi.yml)<br/>[`filebeat-logstash/logstash.abi.conf`](filebeat-logstash/logstash.abi.conf) | **Filebeat + Logstash** | 企业已部署 ELK / Elastic Stack 基础设施时的标准采集管道：Filebeat 负责边车（Sidecar）尾随读取 `abi.log.*`，Logstash 负责 JSON 校验、字段归一化与 HTTP Gzip / Kafka 批量投递 | Filebeat 8.x + Logstash 8.x |
| [`vector/vector.abi.toml`](vector/vector.abi.toml) | **Vector 采集器** | 云原生 Kubernetes DaemonSet 高吞吐、极低内存占用的 Rust 日志边车转发配置 | Vector 0.38+ |
| [`datax/ta-datax-abi-writer.json`](datax/ta-datax-abi-writer.json) | **ta-datax-writer** | 历史存量业务库（如历史订单表、会员表）一次性或按日全量/增量离线回填至 ABI 网关 | Alibaba DataX |

---

## 2. 服务端日志转发与离线导入核心字段契约（必读）

无论是 `LoggerConsumer` 落盘转发还是 `DataX` 历史离线回填，由于**上报进程所在机器并非终端用户的真实客户端设备，且上报时刻往往滞后于实际业务发生时刻**，接入人员必须严格遵循以下 5 项字段规范：

| 核心字段 | 协议位置 | 必填性 | 为什么在离线导入/日志转发中至关重要？ |
|----------|----------|--------|--------------------------------------|
| **客户端真实 IP**<br/>(`#ip` 或 `$ip`) | `properties["#ip"]` | **强烈建议必传** | LogBus / Filebeat / DataX 运行在后端服务器或跳板机上，采集网关看到的 TCP 连接 IP 是**机房内网/NAT 出口 IP**。只有在 `properties` 中显式传入业务发生时的真实客户端公网 IP（如 `"203.0.113.88"`），后端 Flink Job1 才能按 `properties["#ip"] > properties["$ip"] > client_ip` 优先级正确解析用户的国家、省份与城市，并在入库前自动剥离 `#ip`。 |
| **实际业务发生时间**<br/>(`#time` / `$time` / `timestamp`) | 顶层 `timestamp`（毫秒）或 `properties["#time"]` | **历史补数必填** | 离线导入或异步转发时，切勿使用脚本运行时的当前系统时间！必须传入业务实际发生时间的 Unix 毫秒时间戳（如 `1762768805000`）或 ISO-8601 字符串（如 `"2026-11-10T10:00:05Z"`）。`abi_logbus.py` 与网关会自动提取 `properties["#time"]` 覆盖顶层毫秒 `timestamp` 并剥离 `#time`。 |
| **幂等事件主键**<br/>(`event_id`) | 顶层 `event_id`（`<= 64` 字节） | **强烈建议显式传确定性 ID** | 当 LogBus 断点续传重试、Logstash 重发或 DataX 作业失败重跑时，使用确定性业务主键（如 `"ord_paid_" + order_no`）可确保 StarRocks `dwd_events` 在同一分区窗口内自动幂等去重，防止重复计算 GMV 或转化率。 |
| **64 位大整数保护**<br/>(`> 2^53 - 1`) | `properties` 内任意数值或列表元素 | **自动/强制转 `string`** | 超出 IEEE-754 双精度安全整数上限（`9007199254740991`）的雪花算法订单号（如 `9007199254740993`）必须序列化为字符串 `"9007199254740993"`。`abi_logbus.py` 内置 `sanitize_large_ints()` 自动拦截转换；DataX 配置中请将对应列类型声明为 `"string"`。 |
| **双 ID 身份契约**<br/>(`distinct_id` + `login_id`) | 顶层 `distinct_id`（`<= 64` 字节）与 `login_id`（`<= 128` 字节） | **至少一个非空** | 对标数数科技 ThinkingData 双 ID 规范：仅包含访客/设备标识 `distinct_id` 与实名账号标识 `login_id`，两者至少一个非空（绝不把长 `login_id` 拷贝或截断回填到 `distinct_id`）；任一事件或画像记录同时携带两者时，Flink 自动完成全链路 ID-Mapping 关联。 |
| **用户画像隔离**<br/>(`$user_*`) | `event_name` 为 `$user_set` / `$user_add` 等 | **严禁混入环境属性** | 导入用户画像事件（`$user_set`、`$user_set_once`、`$user_add`、`$user_unset`、`$user_append`、`$user_uniq_append`、`$user_del`）时，`properties` 中仅允许包含需要修改的用户画像列，请勿注入 `$os`、`$app_version` 等设备环境字段。 |

---

## 3. `abi_logbus.py`（LogBus 本地转发器）使用指南

### 3.1 一键运行内置自包含演练（两步式预览 + 确认提交）

`abi_logbus.py` 内置 `--demo` 自包含演练模式：自动在临时目录生成模拟 `LoggerConsumer` 产出的 `abi.log.2026-11-10`（含同时携带 `distinct_id` 与 `login_id` 自动触发 ID 关联的 `$login` 登录事件、带 `#ip`/`#time`/64 位雪花 ID 的 `OrderPaid` 订单事件、以及 `$user_set` 画像更新），展示**第一步格式化请求 JSON 预览**，并在确认后执行 **Gzip 压缩上报与 `.abi_logbus_state.json` 断点 Offset 落盘校验**：

```bash
# 第一步：仅预览即将发送给 POST /collect/api/v1/track/batch 的完整请求 JSON（不发送网络请求）
/opt/homebrew/bin/python3 abi.sdk/data-import/abi_logbus.py --demo --preview

# 第二步：预览请求 JSON 后自动确认提交（或省略 --yes 在交互式终端按 y 确认）
/opt/homebrew/bin/python3 abi.sdk/data-import/abi_logbus.py --demo --yes
```

### 3.2 对接生产环境 `LoggerConsumer` 日志目录

假设 Go / Java 服务端 SDK 已配置 `LoggerConsumer` 将日志输出至 `/var/log/abi/`：

```bash
# 1. 先执行单批次预览，核对字段映射与项目凭证无误（零网络副作用，不修改 Offset）
/opt/homebrew/bin/python3 abi.sdk/data-import/abi_logbus.py \
  --log-dir /var/log/abi \
  --server-url http://localhost:8081 \
  --project-id 1 \
  --project-token abi_tok_prod_xxx \
  --preview

# 2. 确认无误后执行单次全量扫描转发（自动记录断点至 /var/log/abi/.abi_logbus_state.json）
/opt/homebrew/bin/python3 abi.sdk/data-import/abi_logbus.py \
  --log-dir /var/log/abi \
  --server-url http://localhost:8081 \
  --project-id 1 \
  --project-token abi_tok_prod_xxx \
  --batch-size 200 \
  --yes

# 3. 启动常驻守护进程模式（每 2 秒轮询增量写入的 JSONL 行并自动 Gzip 批量上报）
/opt/homebrew/bin/python3 abi.sdk/data-import/abi_logbus.py \
  --log-dir /var/log/abi \
  --server-url http://localhost:8081 \
  --project-id 1 \
  --project-token abi_tok_prod_xxx \
  --batch-size 200 \
  --daemon \
  --interval 2.0
```

---

## 4. Filebeat + Logstash 与 Vector 管道部署

### 4.1 Filebeat + Logstash

1. 将 [`filebeat-logstash/filebeat.abi.yml`](filebeat-logstash/filebeat.abi.yml) 中的 `paths` 指向服务端 SDK `LoggerConsumer` 的落盘目录（默认 `/var/log/abi/abi.log.*`），并通过环境变量注入项目密钥：
   ```bash
   export ABI_PROJECT_TOKEN="abi_tok_prod_xxx"
   filebeat -c abi.sdk/data-import/filebeat-logstash/filebeat.abi.yml
   ```
2. 启动 Logstash 加载 [`filebeat-logstash/logstash.abi.conf`](filebeat-logstash/logstash.abi.conf) 管道（自动完成 `#time` 提取、`event_id` 兜底与 HTTP Gzip 批量发送）：
   ```bash
   logstash -f abi.sdk/data-import/filebeat-logstash/logstash.abi.conf
   ```

### 4.2 Vector 轻量级采集器

```bash
export ABI_PROJECT_TOKEN="abi_tok_prod_xxx"
vector --config abi.sdk/data-import/vector/vector.abi.toml
```

---

## 5. DataX 历史离线数据导入 (`ta-datax-abi-writer.json`)

针对需要将历史数据库存量订单或用户表导入 ABI 的场景，请参考 [`datax/ta-datax-abi-writer.json`](datax/ta-datax-abi-writer.json)：

1. **先开启 `dryRun: true` 预检**：在正式导入数百万条历史记录前，建议先在 SQL `where` 条件中加上 `LIMIT 10` 并将 `writer.parameter.dryRun` 设为 `true`，验证网关返回 `200 OK` 且无字段命名或时间窗报错；
2. **执行 DataX 作业**：
   ```bash
   python3 /opt/datax/bin/datax.py \
     -p "-DSOURCE_MYSQL_USER=readonly -DSOURCE_MYSQL_PASS=secret -DABI_PROJECT_TOKEN=abi_tok_prod_xxx" \
     abi.sdk/data-import/datax/ta-datax-abi-writer.json
   ```
