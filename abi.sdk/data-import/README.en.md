# ABI Data Import & Server Log Forwarding Suite (`abi.sdk/data-import`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`abi.sdk/data-import` benchmarks the [ThinkingData v3.4 Data Import & Transmission Tool Suite](https://docs.thinkingdata.cn/ta-manual/v3.4/installation/installation_menu/installation_menu.html) (`LogBus 2`, `Filebeat + Logstash`, `Vector`, `ta-datax-writer`), providing ready-to-use tools and configurations for two core production scenarios:

1. **Real-Time Forwarding of Server SDK Local JSONL Logs**: Backend services (Go / Java) use `LoggerConsumer` to append analytics events to local `.jsonl` files (`abi.log.YYYY-MM-DD`) without blocking business threads. An out-of-process shipper (`abi_logbus.py`, `Filebeat + Logstash`, or `Vector`) tails the directory with byte-offset checkpoints and forwards Gzip-compressed batches to the ABI Ingest Gateway (`:8081`), decoupling business critical paths from network I/O.
2. **Historical Offline Batch Migration (DataX)**: Backfill historical orders, registrations, and user profiles from relational databases (MySQL / PostgreSQL) or data warehouses into the ABI Ingest Gateway and StarRocks OLAP using `datax/ta-datax-abi-writer.json`.

---

## 1. Directory Structure & Tool Selection Matrix

| File / Directory | ThinkingData Counterpart | Role & Best-Fit Scenario | External Dependencies |
|------------------|--------------------------|--------------------------|-----------------------|
| [`abi_logbus.py`](abi_logbus.py) | **LogBus 2** | Lightweight local `LoggerConsumer` `.jsonl` scanner and batch forwarder; built-in inode + byte-offset checkpointing (`.abi_logbus_state.json`), Gzip compression, `#time` extraction, 64-bit integer precision protection, and **two-step request JSON preview (`--preview`) & confirm submit (`--yes`)** | Python 3 Standard Library only (zero third-party packages) |
| [`filebeat-logstash/filebeat.abi.yml`](filebeat-logstash/filebeat.abi.yml)<br/>[`filebeat-logstash/logstash.abi.conf`](filebeat-logstash/logstash.abi.conf) | **Filebeat + Logstash** | Standard pipeline for teams running Elastic Stack: Filebeat tails `abi.log.*` with local spooling, while Logstash normalizes fields and sends Gzip HTTP batches (or writes directly to Kafka `track_raw`) | Filebeat 8.x + Logstash 8.x |
| [`vector/vector.abi.toml`](vector/vector.abi.toml) | **Vector Shipper** | High-throughput, low-memory Rust sidecar/DaemonSet configuration for Kubernetes | Vector 0.38+ |
| [`datax/ta-datax-abi-writer.json`](datax/ta-datax-abi-writer.json) | **ta-datax-writer** | Batch migration template for backfilling historical relational tables into ABI | Alibaba DataX |

---

## 2. Required Field Contract for Offline Import & Log Forwarding

When forwarding server logs or backfilling historical records, the shipper runs on backend servers rather than end-user devices, and transmission time lags behind actual event occurrence time. Always follow these 5 field rules:

| Field | Wire Location | Requirement | Why It Matters in Offline Import / Log Forwarding |
|-------|---------------|-------------|---------------------------------------------------|
| **Client Public IP**<br/>(`#ip` or `$ip`) | `properties["#ip"]` | **Strongly Recommended** | The ingest gateway sees the backend server's internal/NAT IP on the TCP socket. Passing the user's real public IP (e.g., `"203.0.113.88"`) in `properties["#ip"]` enables Flink Job1 ETL (`properties["#ip"] > properties["$ip"] > client_ip`) to resolve accurate GeoIP (`country`, `province`, `city`) before stripping `#ip`. |
| **Event Occurrence Time**<br/>(`#time` / `$time` / `timestamp`) | Top-level `timestamp` (ms) or `properties["#time"]` | **Required for Backfills** | Never use the migration script's wall-clock execution time for historical data. Pass the actual business event timestamp in Unix milliseconds (e.g., `1762768805000`) or ISO-8601 string (`"2026-11-10T10:00:05Z"`). `abi_logbus.py` and the gateway extract `properties["#time"]` into top-level `timestamp` and strip `#time`. |
| **Idempotent Event ID**<br/>(`event_id`) | Top-level `event_id` (`<= 64` bytes) | **Deterministic ID Recommended** | Using a deterministic primary key (such as `"ord_paid_" + order_no`) ensures idempotent deduplication in StarRocks `dwd_events` across LogBus retries or DataX job reruns. |
| **64-Bit Integer Safety**<br/>(`> 2^53 - 1`) | Any value/list item in `properties` | **Stringified Automatically** | Snowflake IDs exceeding IEEE-754 `MAX_SAFE_INTEGER` (`9007199254740991`, e.g., `9007199254740993`) are automatically converted to strings (`"9007199254740993"`) by `abi_logbus.py` to prevent precision loss. |
| **Dual-ID Identity**<br/>(`distinct_id` + `login_id`) | Top-level `distinct_id` (`<= 64` bytes) & `login_id` (`<= 128` bytes) | **At Least One Non-Empty** | Aligned with ThinkingData's dual-ID model: wire payloads carry only visitor/device `distinct_id` and authenticated account `login_id` (never copying `login_id` into `distinct_id`). Any event or profile update carrying both non-empty IDs triggers automatic ID-Mapping in Flink. |
| **User Profile Isolation**<br/>(`$user_*`) | `event_name` = `$user_set`, `$user_add`, etc. | **No Device Preset Props** | Keep `$user_*` `properties` clean with only user profile attributes; do not inject `$os` or `$app_version` into profile events. |

---

## 3. `abi_logbus.py` Quick Start & Verification

### 3.1 One-Click Self-Contained Demo (Two-Step Preview & Confirm)

```bash
# Step 1: Preview the formatted POST /collect/api/v1/track/batch JSON payload without network calls
/opt/homebrew/bin/python3 abi.sdk/data-import/abi_logbus.py --demo --preview

# Step 2: Preview the request JSON and automatically confirm Gzip submission + offset checkpointing
/opt/homebrew/bin/python3 abi.sdk/data-import/abi_logbus.py --demo --yes
```

### 3.2 Forwarding Production `LoggerConsumer` Directories

```bash
# 1. Preview the first pending batch from /var/log/abi without advancing offset
/opt/homebrew/bin/python3 abi.sdk/data-import/abi_logbus.py \
  --log-dir /var/log/abi \
  --server-url http://localhost:8081 \
  --project-id 1 \
  --project-token abi_tok_prod_xxx \
  --preview

# 2. Run a one-shot batch forward and save offset checkpoints to /var/log/abi/.abi_logbus_state.json
/opt/homebrew/bin/python3 abi.sdk/data-import/abi_logbus.py \
  --log-dir /var/log/abi \
  --server-url http://localhost:8081 \
  --project-id 1 \
  --project-token abi_tok_prod_xxx \
  --batch-size 200 \
  --yes

# 3. Run in continuous daemon mode (tails new JSONL lines every 2 seconds)
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

## 4. Filebeat + Logstash, Vector & DataX Usage

- **Filebeat + Logstash**:
  ```bash
  export ABI_PROJECT_TOKEN="abi_tok_prod_xxx"
  filebeat -c abi.sdk/data-import/filebeat-logstash/filebeat.abi.yml
  logstash -f abi.sdk/data-import/filebeat-logstash/logstash.abi.conf
  ```
- **Vector**:
  ```bash
  export ABI_PROJECT_TOKEN="abi_tok_prod_xxx"
  vector --config abi.sdk/data-import/vector/vector.abi.toml
  ```
- **DataX (`ta-datax-abi-writer.json`)**:
  ```bash
  python3 /opt/datax/bin/datax.py \
    -p "-DSOURCE_MYSQL_USER=readonly -DSOURCE_MYSQL_PASS=secret -DABI_PROJECT_TOKEN=abi_tok_prod_xxx" \
    abi.sdk/data-import/datax/ta-datax-abi-writer.json
  ```
