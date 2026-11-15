# ABI Python 3 Server SDK (`abi.sdk/python`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`abi_sdk.py` is the official Python 3 server-side data collection SDK for the **ABI Enterprise User Behavior Analytics (UBA) & BI Platform**, benchmarked against the ThinkingData Python Server SDK v3.4 specification. Implemented purely with the **Python 3 standard library (zero third-party dependencies)**, it enforces strict field contracts aligned with the ABI Ingest Gateway (`:8081`) and Flink real-time ETL pipelines.

---

## 1. Key Features & Four-Consumer Architecture

### Key Features
- **Zero External Dependencies**: Built 100% on the Python 3.9+ standard library (`urllib.request`, `gzip`, `threading`, `json`, `datetime`). Ready to drop into FastAPI, Django, Flask, Celery, or Airflow tasks without dependency conflicts.
- **Thread-Safe**: Both `AbiAnalytics` and all built-in consumers are thread-safe and designed to be shared as a global singleton across worker threads.
- **Strict Local Contract Validation**:
  - Rejects ASCII control characters (`0x00–0x08`, `0x0E–0x1F`, `0x7F`) **before** trimming leading/trailing Unicode whitespace, and enforces UTF-8 byte limits (visitor/device ID `distinct_id <= 64`, account ID `login_id <= 128`, `event_id <= 64`);
  - ThinkingData-aligned dual-ID contract: at least one of `distinct_id` or `login_id` must be non-empty; when `distinct_id` is empty, sends `distinct_id: ""` and `login_id: "<account>"` directly (never copies `login_id` into `distinct_id`); raises `AbiValidationError` if both are empty;
  - Validates custom event names (`<= 128` chars) and property keys (`<= 64` chars) against `^[A-Za-z_][A-Za-z0-9_]*$`, while allowing whitelisted system events (`$signup`, `$login`, `$user_*`, etc.) and system property aliases (`#ip`/`$ip`, `#time`/`$time`, `$os`, etc.).
- **64-Bit Big Integer Precision Guard (`> 2^53 - 1`)**: Explicitly checks `isinstance(v, bool)` before `int` (since `bool` subclasses `int` in Python). Automatically converts integers (including list elements) whose absolute value exceeds `9007199254740991` ($2^{53}-1$) into decimal strings to prevent IEEE-754 precision loss. Rejects `NaN`, `Infinity`, and lists containing `None` or nested containers.
- **Super Properties Layering & Isolation**: Merges properties in strict order (`super_properties < dynamic_super_properties < explicit properties`) on behavioral events while automatically isolating `$user_*` / `#user_*` profile operations.

### Four Consumers

| Consumer | Constructor | Primary Use Case |
| :--- | :--- | :--- |
| **`StagingConsumer`** | `StagingConsumer(project_id, project_token, dry_run=False)` | **Two-Step Preview & Confirm Submit**: Buffers events in memory so developers can inspect the single formatted `POST /collect/api/v1/track/batch` JSON via `preview_request_json()` (zero network side effects) before calling `submit_to_gateway()` or `confirm_submit(target_consumer)`. |
| **`BatchConsumer`** | `BatchConsumer(server_url, project_id, project_token, ...)` | **High-Throughput Async Batching**: Daemon background thread flushes by count (`batch_size`, default 50, max 500) or interval (`flush_interval`, default 3.0s), supports Gzip compression and exponential backoff retry on HTTP `429` / `5xx` while preserving original `event_id` values. |
| **`LoggerConsumer`** | `LoggerConsumer(directory, file_prefix="abi.log", ...)` | **Local JSONL File Rotation**: Writes newline-delimited JSON rotated by UTC date (`DAILY`, e.g. `abi.log.2026-11-10.jsonl`) or UTC hour (`HOURLY`) for sidecar collectors such as Filebeat, Vector, or LogBus. |
| **`DebugConsumer`** | `DebugConsumer(server_url, project_id, project_token, dry_run=False)` | **Synchronous L4 Validation & Dry-Run**: Sends each event immediately with `debug: True` (and optional `dry_run: True`) and raises `AbiGatewayError` with detailed rejection reasons on schema violations. |

---

## 2. Integration Guide: Server-Side Required Fields & Client Pass-Through (`#ip`, Per-Call Identity, Async `#time`, Idempotent `event_id`)

Unlike browser or mobile SDKs that run on a single end-user device, a server-side SDK runs as a **stateless multi-tenant singleton** inside your backend infrastructure. Engineers integrating the Python Server SDK must handle the following four fields explicitly:

| Field / Concept | SDK Parameter / Property Key | Requirement Level | Why It Matters & How to Populate |
| :--- | :--- | :--- | :--- |
| **1. Real Client IP (`#ip` / `$ip`)** | `properties["#ip"]`<br>or `properties["$ip"]` | **Required for GeoIP Analysis** | When your backend calls the Ingest Gateway (`:8081`), the TCP connection IP is your **datacenter / NAT IP** (and `LoggerConsumer` has no socket IP at all). **If `#ip` is omitted, all server events will resolve to your server room's location!**<br>Extract the client's public IP from `X-Forwarded-For` or `X-Real-IP` and pass it in `properties["#ip"]`. Flink ETL prioritizes `#ip` > `$ip` for GeoIP lookup and strips the key before storage. |
| **2. Per-Call User Identity (`account_id` / `distinct_id`)** | `track(account_id, distinct_id, ...)`<br>or `login_id` / `distinct_id` | **Required on Every Call** | Server SDK instances hold no per-user session state. Every `track*` / `user_*` call must pass the user's `account_id` (wire field `login_id <= 128B`) and/or the client-forwarded visitor `distinct_id` (`<= 64B`), with at least one non-empty.<br>To stitch anonymous front-end browsing with back-end checkout funnels, forward `distinct_id` from the client via an HTTP header (e.g. `X-ABI-Distinct-Id`). Whenever any `track*` or `user_*` event carries both `account_id` and `distinct_id`, Flink binds the identities automatically in real time. |
| **3. Actual Event Time (`#time` / `$time` / `timestamp`)** | `properties["#time"]`<br>or `timestamp=...` | **Required for Async MQ / Webhooks / Backfills** | Real-time API handlers can rely on the default current timestamp. However, for **async Kafka/Celery consumers, payment webhooks, or historical backfills**, you must pass the actual business occurrence time via `properties["#time"]` (accepts `datetime`, positive sec/ms numbers, or ISO-8601 strings). The SDK converts it to top-level millisecond `timestamp` and strips `#time` from `properties`. |
| **4. Deterministic Idempotent Key (`event_id`)** | `track(..., event_id="...")`<br>(*Note: per D7① / G6 gate, `track_first` / `track_update` / `track_overwrite` are unsupported in current version*) | **Strongly Recommended for Transactions & MQ** | By default, the SDK generates a random UUIDv4. For **MQ retries or payment callbacks**, pass a deterministic key (e.g. `f"ord_paid_{order_no}"`, `<= 64` UTF-8 bytes) for same-day idempotent deduplication. |

---

## 3. Quick Start & Code Examples

### 3.1 Two-Step Request JSON Preview & Confirmed Submission (`StagingConsumer`)

```python
from abi_sdk import AbiAnalytics, StagingConsumer

# Step 1: Stage events in memory and preview the single request JSON payload (zero network I/O)
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
        "#ip": "203.0.113.42",              # Client public IP from X-Forwarded-For
        "#time": "2026-11-10T10:00:00Z",    # Extracted to top-level ms timestamp and stripped
        "order_id": 9007199254740999,       # > 2^53-1 snowflake ID -> serialized as "9007199254740999"
        "pay_amount": 2549.15,
        "is_first_order": True,
    },
)

print("=== Staged Request JSON Preview ===")
print(staging.preview_request_json())

# Step 2: Submit to the ABI Ingest Gateway (or forward via staging.confirm_submit(batch_consumer))
resp = staging.submit_to_gateway("http://127.0.0.1:8081", compress_gzip=True)
print("Gateway Response:", resp)
```

### 3.2 Production `BatchConsumer` & Full API Surface

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

sdk.set_super_properties({"$platform": "PythonServer", "service_name": "checkout-svc"})
sdk.set_dynamic_super_properties(lambda: {"server_region": "ap-shanghai"})

account_id = "acct_900102"
vis_id = "vis_py_7f8e9a01"
client_ip = "203.0.113.42"

# Automatic identity binding: any event carrying both account_id and distinct_id is bound in Flink
sdk.track(account_id, vis_id, "$login", {"#ip": client_ip, "login_method": "sso_oidc"})

# Behavioral events with deterministic event_id (Note: per D7① / G6 gate, track_first/track_update/track_overwrite are unsupported in current version and raise AbiUnsupportedError)
sdk.track(account_id, vis_id, "OrderPaid", {
    "#ip": client_ip,
    "#time": datetime.now(timezone.utc),
    "order_id": 9007199254740999,
    "amount": 299.0,
}, event_id="ord_paid_8801")

# 7 User profile operations (isolated from super properties)
sdk.user_set(account_id, vis_id, {"plan_tier": "Enterprise", "seat_count": 50})
sdk.user_set_once(account_id, vis_id, {"first_utm_source": "google_sem"})
sdk.user_add(account_id, vis_id, {"total_orders": 1, "lifetime_spent": 299.0})
sdk.user_append(account_id, vis_id, {"browsed_modules": ["event", "funnel"]})
sdk.user_uniq_append(account_id, vis_id, {"owned_badges": ["early_adopter"]})
sdk.user_unset(account_id, vis_id, "legacy_trial_tag")
# sdk.user_delete(account_id, vis_id)

sdk.close()
```

---

## 4. Running the Two-Step CLI Demo & Unit Tests

```bash
# Run the standard unittest suite (including cross-language golden test vectors)
python3 -m unittest discover -s abi.sdk/python/tests -v

# Run the two-step CLI Demo (previews the single batch request JSON, then submits and prints the response JSON)
python3 abi.sdk/python/examples/demo.py --yes
```
