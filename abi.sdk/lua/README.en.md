# ABI Lua Data Collection SDK (OpenResty / Game Server & Cocos2d-Lua Client)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`abi.sdk/lua` is the official Lua data collection SDK for the **ABI Enterprise User Behavior Analytics (UBA) & BI Platform** (benchmarked against ThinkingData Lua SDK v3.4).

Built with **100% pure Lua 5.3+ standard library (`abi_sdk.lua`) and zero external C dependencies**, it includes a deterministic pretty-printing JSON codec and strict UTF-8 validator, supporting both **OpenResty / Skynet stateless server mode** and **Cocos2d-Lua stateful mobile game client mode**.

---

## 1. Key Features & Four-Consumer Architecture

### Key Features
- **Zero External Dependencies**: Runs out-of-the-box in standard Lua 5.3+, OpenResty, Skynet, or Cocos2d-Lua without requiring `lua-cjson` or native C extensions.
- **Unified Dual-Mode Support (100% ThinkingData Dual-Identity Model `distinct_id` + `login_id`)**:
  - **OpenResty / Skynet Stateless Server Mode**: Explicitly pass `account_id` (`login_id` ≤ 128 UTF-8 bytes), `distinct_id` (visitor/device ID ≤ 64 UTF-8 bytes, at least one non-empty; when only `account_id` is passed, `distinct_id` stays `""`), and the client's real public IP `"#ip"` (extracted from `ngx.var.remote_addr` or `X-Forwarded-For`) per call.
  - **Cocos2d-Lua Stateful Client Mode**: Supports `enable_client_mode`, `identify(distinct_id)` (updates visitor ID locally), `login(account_id)` (sets `login_id` locally **without overwriting `distinct_id` and without sending any network event**), `logout()` (clears `login_id` locally), `time_event` (stopwatch timer automatically injecting `$duration` in seconds), and automatic device preset properties.
- **64-Bit Snowflake ID Precision Protection (`> 2^53 - 1` Auto-String Conversion)**: Automatically converts Lua 64-bit integers exceeding IEEE-754 safe integer bounds (`9007199254740991`, including `math.mininteger` and array elements) into decimal strings.
- **Strict Identity Validation & Profile Isolation**: Validates UTF-8 sequences, rejects ASCII control characters (`0x00–0x08`, `0x0E–0x1F`, `0x7F`), trims Unicode whitespace, enforces 64/128-byte UTF-8 limits, and isolates super/device preset properties from all 7 `$user_*` profile operations.

### Four-Consumer Architecture

| Consumer | Constructor | Use Case & Core Capability |
| :--- | :--- | :--- |
| **`StagingConsumer`** | `abi.new_staging_consumer` | **Two-Step Preview & Confirm Submit**: Stages events in memory so you can inspect the formatted `POST /collect/api/v1/track/batch` JSON via `preview_request_json()` (zero network side effects) before calling `submit_to_gateway()` or `confirm_submit()`. |
| **`LoggerConsumer`** | `abi.new_logger_consumer` | **Local JSONL File Rotation**: Appends newline-delimited JSONL events to disk with `DAILY` or `HOURLY` rotation for sidecar collection via Filebeat / Vector. |
| **`BatchConsumer`** | `abi.new_batch_consumer` | **High-Throughput Buffered Batching**: Buffers events in memory and flushes automatically upon reaching `batch_size`, supporting custom `transport` callbacks (`lua-resty-http` or Cocos2d `cc.XMLHttpRequest`). |
| **`DebugConsumer`** | `abi.new_debug_consumer` | **Synchronous L4 Validation & `dry_run`**: Sends events with `debug=true` (and optional `dry_run=true` to validate schema without writing to Kafka or StarRocks). |

---

## 2. Integration Guide: OpenResty Server Mode vs. Cocos2d-Lua Client Mode

| Dimension | OpenResty / Skynet Stateless Server Mode | Cocos2d-Lua Stateful Game Client Mode |
| :--- | :--- | :--- |
| **User Identity**<br>(`distinct_id` / `login_id`) | **[Required Per Call]** Server workers are shared across all users. Every `sdk:track(account_id, distinct_id, ...)` call must pass the current user's `account_id` (`login_id`) or client-forwarded visitor `distinct_id` (at least one non-empty). | **[Managed Automatically by SDK]** Call `sdk:enable_client_mode(cfg)` on startup to initialize visitor `distinct_id`. Call `sdk:login(account_id)` on login (sets `login_id` locally without overwriting `distinct_id` or sending any event), then call `sdk:client_track(event_name, props)`. |
| **Client Public IP**<br>(`#ip` / `$ip` for GeoIP Country/Province/City) | **[Required on Server]** When OpenResty or a backend server connects to `:8081` (or writes to disk via `LoggerConsumer`), the gateway only sees the **backend internal IP**. Extract the client's real IP from `ngx.req.get_headers()["X-Forwarded-For"]` or `ngx.var.remote_addr` and pass `properties["#ip"]` (or `"$ip"`). Flink ETL resolves GeoIP from `#ip` first and strips the key. | **[Not Passed by Client]** Mobile clients connect directly to the ingest gateway, which **automatically extracts the client public IP** from the HTTP connection. |
| **Event Timestamp**<br>(`#time` / `$time` / `timestamp_ms`) | **[Optional for Real-Time / Required for Async & Backfill]** Pass actual business time via `properties["#time"]` (ms/sec integer or ISO-8601 string `"2026-11-10T12:00:00Z"`). The SDK extracts it to top-level `timestamp` and strips `#time` from `properties`. | **[Automatic]** Defaults to current millisecond timestamp; pass `#time` only when replaying cached offline events. |
| **Device Preset Properties**<br>(`$os` / `$app_version` / `$device_model` / `$screen_width`) | **[Forward on Demand]** Pass per-event in `properties` if forwarded from client headers (never put single-user device info in global `set_super_properties`). | **[Injected Automatically]** Configured once via `enable_client_mode` and automatically isolated from `$user_*` profile events. |

---

## 3. Quick Start & Code Examples

### 3.1 OpenResty Server-Side Example (`ngx.var.remote_addr` `#ip`, BigInt Protection & 7 User Profile Operations)

```lua
local abi = require("abi_sdk")

local function get_client_ip()
    if type(ngx) == "table" and ngx.req then
        local headers = ngx.req.get_headers()
        local xff = headers["X-Forwarded-For"] or headers["x-forwarded-for"]
        if type(xff) == "string" and #xff > 0 then
            return xff:match("^%s*([^,%s]+)")
        end
        return ngx.var.remote_addr
    end
    return "203.0.113.66"
end

local staging = abi.new_staging_consumer(1, "abi_tok_openresty", false)
local sdk     = abi.new(staging)

sdk:set_super_properties({
    service_name   = "payment-callback-edge",
    cluster_region = "ap-shanghai",
})

local account_id  = "acct_lua_9001"
local distinct_id = "visitor_cocos_dev_01"
local client_ip   = get_client_ip()

sdk:track(account_id, distinct_id, "OrderPaid", {
    ["#ip"]        = client_ip,
    ["#time"]      = "2026-11-10T12:00:00Z",
    ["order_id"]   = 9007199254740999, -- > 2^53-1 -> serialized as string "9007199254740999"
    ["pay_amount"] = 199.5,
    ["item_skus"]  = abi.array({ "gem_pack_648", "monthly_card" }),
})

sdk:user_set(account_id, distinct_id, { nickname = "LuaMaster", vip_level = 6 })
sdk:user_set_once(account_id, distinct_id, { first_ad_channel = "taptap_cn" })
sdk:user_add(account_id, distinct_id, { total_recharged = 199.5 })
sdk:user_append(account_id, distinct_id, { cleared_dungeons = abi.array({ "d_01" }) })
sdk:user_uniq_append(account_id, distinct_id, { owned_medals = abi.array({ "pioneer" }) })
sdk:user_unset(account_id, distinct_id, { "temp_newbie_buff" })

-- Step 1: Preview formatted POST /collect/api/v1/track/batch JSON
print("=== Request JSON Preview ===")
print(staging:preview_request_json(true))

-- Step 2: Confirm and submit to gateway
local _, resp_json = staging:submit_to_gateway({ server_url = "http://127.0.0.1:8081" })
print("=== Gateway Response JSON ===")
print(resp_json)
```

---

## 4. Verification Commands

```bash
# 1. Run Lua unit test suite (including cross-language golden test vectors)
/usr/local/bin/lua /Users/zhongjie/data/anylink/abi/abi.sdk/lua/tests/test_abi_sdk.lua

# 2. Run two-step CLI Demo
/usr/local/bin/lua /Users/zhongjie/data/anylink/abi/abi.sdk/lua/examples/demo.lua --yes
```
