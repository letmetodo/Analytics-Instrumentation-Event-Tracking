# ABI C / C++17 Data Collection SDK (Server-Side & Unreal Engine / Cocos2d-x Game Clients)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`abi.sdk/cpp` is the official C / C++17 data collection SDK for the **ABI Enterprise User Behavior Analytics (UBA) & BI Platform** (benchmarked against ThinkingData C/C++ Server SDK and Unreal Engine / Cocos2d-x Game Client SDK v3.4).

Designed as a **single-header (`include/abi_sdk.hpp`), zero-external-dependency, STL-ABI-independent** library with a built-in `extern "C"` interface, it integrates seamlessly into Linux / macOS / Windows C++ game servers, backend microservices, Unreal Engine 4/5 projects, and Cocos2d-x 3.x/4.x clients.

---

## 1. Key Features & Four-Consumer Architecture

### Key Features
- **Header-Only & Zero Dependencies**: Just `#include "abi_sdk.hpp"` to compile and run. Self-contained containers avoid cross-compiler `libc++` / `libstdc++` ABI mismatches in Unreal Engine and Android NDK builds.
- **Unified Dual-Mode Support (100% ThinkingData Dual-Identity Model `distinct_id` + `login_id`)**:
  - **C/C++ Server-Side Stateless Mode**: Designed for multi-user shared backend instances; pass `account_id` (`login_id` ≤ 128 UTF-8 bytes), `distinct_id` (visitor/device ID ≤ 64 UTF-8 bytes, at least one non-empty; when only `account_id` is provided, `distinct_id` stays `""`), and client `"#ip"` explicitly on each call.
  - **Unreal Engine / Cocos2d-x Stateful Client Mode**: Supports `enable_client_mode`, `identify(distinct_id)` (updates visitor ID locally with zero network events), `login(account_id)` (sets `login_id` locally **without overwriting `distinct_id` and without emitting any network event**), `logout()` (clears `login_id` locally), `time_event` (stopwatch timer automatically injecting `$duration` in seconds), and automatic device preset properties.
- **Strict Client-Side Validation**: Validates UTF-8 sequences, rejects ASCII control characters (`0x00–0x08`, `0x0E–0x1F`, `0x7F`) prior to trimming, trims leading/trailing Unicode whitespace, and enforces UTF-8 byte limits (`distinct_id` / `event_id` ≤ 64 bytes, `login_id` ≤ 128 bytes).
- **64-Bit Snowflake ID Precision Protection (`> 2^53 - 1` Auto-String Conversion)**: Automatically serializes `int64_t` / `uint64_t` values (including `INT64_MIN` and array elements) exceeding IEEE-754 safe integer bounds (`9007199254740991`) into decimal strings.
- **Super Properties & `$user_*` Profile Isolation**: Merges properties in strict order (`client device presets < static super properties < dynamic super properties < event properties`) while excluding super and device preset properties from all 7 `$user_*` profile operations.

### Four-Consumer Architecture

| Consumer | Class | Use Case & Core Capability |
| :--- | :--- | :--- |
| **`StagingConsumer`** | `abi::StagingConsumer` | **Two-Step Preview & Confirm Submit**: Stages events in memory so developers can inspect the formatted `POST /collect/api/v1/track/batch` JSON via `preview_request_json()` (zero network side effects) before calling `submit_to_gateway()` or `confirm_submit()`. |
| **`LoggerConsumer`** | `abi::LoggerConsumer` | **Local JSONL File Rotation**: Appends newline-delimited JSONL events to disk with `Daily` or `Hourly` rotation for sidecar collection via Filebeat / Vector / LogBus. |
| **`BatchConsumer`** | `abi::BatchConsumer` | **High-Throughput Buffered Batching**: Buffers events in memory and flushes automatically when reaching `batch_size`, supporting custom `HttpTransportFunc` callbacks (`libcurl`, Unreal `FHttpModule`, or Cocos2d-x `HttpClient`). |
| **`DebugConsumer`** | `abi::DebugConsumer` | **Synchronous L4 Validation & `dry_run`**: Sends events with `debug=true` (and optional `dry_run=true` to validate schema without writing to Kafka or StarRocks). |

---

## 2. Integration Guide: C/C++ Server Mode vs. Unreal / Cocos2d-x Client Mode

| Dimension | C/C++ Server-Side Stateless Mode (Battle / Match / Payment Servers) | Unreal Engine / Cocos2d-x Stateful Client Mode |
| :--- | :--- | :--- |
| **User Identity**<br>(`distinct_id` / `login_id`) | **[Required Per Call]** Server instances are shared across all players. Every `sdk.track(account_id, distinct_id, ...)` call must explicitly pass the player's `account_id` (`login_id`) and/or client-forwarded visitor `distinct_id` (at least one non-empty). | **[Managed Automatically by SDK]** Call `sdk.enable_client_mode(cfg)` on startup to initialize visitor `distinct_id`. Call `sdk.login(account_id)` upon player login (sets `login_id` locally without overwriting `distinct_id` or sending any event), then call `sdk.client_track(event_name, props)`. |
| **Client Public IP**<br>(`#ip` / `$ip` for GeoIP Country/Province/City) | **[Required on Server]** When a backend server connects to `:8081` (or writes to disk via `LoggerConsumer`), the gateway only sees the **datacenter/container IP**. You must extract the player's real public IP from the socket or `X-Forwarded-For` header and pass `properties["#ip"]` (or `"$ip"`). Flink ETL resolves GeoIP from `#ip` first and strips the key. | **[Not Passed by Client]** Mobile and PC game clients sit behind NAT and connect directly to the ingest gateway, which **automatically extracts the client public IP** from the HTTP connection. |
| **Event Timestamp**<br>(`#time` / `$time` / `timestamp_ms`) | **[Optional for Real-Time / Required for Async MQ & Backfill]** Pass actual business time via `properties["#time"]` (ms/sec integer or ISO-8601 string `"2026-11-10T12:00:00Z"`). The SDK extracts it to top-level `timestamp` and strips `#time` from `properties`. | **[Automatic]** Defaults to current client millisecond timestamp; pass `#time` only when replaying cached offline events. |
| **Device Preset Properties**<br>(`$os` / `$app_version` / `$device_model` / `$screen_width`) | **[Forward on Demand]** Pass per-event in `properties` if forwarded from client headers (never put single-user device info in global `set_super_properties`). | **[Injected Automatically]** Configured once via `enable_client_mode(ClientDeviceConfig)` and automatically isolated from `$user_*` profile events. |

---

## 3. Quick Start & Code Examples

### 3.1 C++17 Server-Side Example (`#ip`, BigInt Protection, Two-Step Preview & 7 User Profile Operations)

```cpp
#include "abi_sdk.hpp"
#include <stdio.h>

int main() {
    abi::StagingConsumer staging(1, "abi_tok_cpp_server", false);
    abi::AbiAnalytics sdk(staging);

    sdk.set_super_properties({
        {"service_name", "battle-settlement-srv"},
        {"cluster_region", "ap-shanghai"}
    });

    const abi::String account_id  = "player_9001";
    const abi::String distinct_id = "visitor_ue5_dev_01";
    const abi::String client_ip   = "203.0.113.88"; // Real player IP from socket / X-Forwarded-For

    sdk.track(account_id, distinct_id, "OrderPaid", {
        {"#ip", client_ip},
        {"#time", "2026-11-10T12:00:00Z"},
        {"order_id", int64_t(9007199254740999LL)}, // > 2^53-1 -> serialized as string "9007199254740999"
        {"pay_amount", 299.5},
        {"item_skus", abi::Value::from_string_list({"skin_dragon", "battle_pass"})}
    });

    // All 7 user profile operations (isolated from super properties)
    sdk.user_set(account_id, distinct_id, {{"nickname", "DragonKnight"}, {"vip_level", 5}});
    sdk.user_set_once(account_id, distinct_id, {{"first_channel", "steam"}});
    sdk.user_add(account_id, distinct_id, {{"total_recharged", 299.5}});
    sdk.user_append(account_id, distinct_id, {{"chapters", abi::Value::from_string_list({"ch_1"})}});
    sdk.user_uniq_append(account_id, distinct_id, {{"titles", abi::Value::from_string_list({"founder"})}});
    sdk.user_unset(account_id, distinct_id, {"trial_buff_flag"});

    // Step 1: Preview formatted POST /collect/api/v1/track/batch request JSON
    abi::String preview_json = staging.preview_request_json(true);
    printf("=== Request JSON Preview ===\n%s\n", preview_json.c_str());

    // Step 2: Confirm and submit to gateway
    abi::String resp_json;
    staging.submit_to_gateway("http://127.0.0.1:8081", nullptr, &resp_json);
    printf("=== Gateway Response JSON ===\n%s\n", resp_json.c_str());
    return 0;
}
```

### 3.2 Unreal Engine 4/5 & Cocos2d-x Stateful Client Mode

```cpp
#include "abi_sdk.hpp"

void RunGameClientExample() {
    abi::BatchConsumer::Config batch_cfg;
    batch_cfg.server_url    = "https://collect.yourgame.com";
    batch_cfg.project_id    = 1;
    batch_cfg.project_token = "abi_tok_game_client";
    batch_cfg.batch_size    = 30;
    abi::BatchConsumer consumer(batch_cfg);
    abi::AbiAnalytics sdk(consumer);

    abi::ClientDeviceConfig dev;
    dev.distinct_id   = "ue5_device_uuid_001";
    dev.platform      = "UnrealEngine"; // Or "Cocos2d-x"
    dev.os            = "Windows";
    dev.os_version    = "11.0";
    dev.app_version   = "3.4.0";
    dev.device_model  = "RTX4080";
    dev.screen_width  = 2560;
    dev.screen_height = 1440;
    sdk.enable_client_mode(dev);

    sdk.client_track("PatchDownloadCompleted", {{"patch_size_mb", 512}});
    sdk.login("player_9001"); // Pure local state update: sets login_id without overwriting distinct_id or sending events

    sdk.time_event("BossDungeonCleared");
    sdk.client_track("BossDungeonCleared", {
        {"dungeon_id", "raid_abyss_09"},
        {"damage_dealt", int64_t(9007199254741005LL)}
    });

    sdk.client_user_set({{"guild_name", "Avalon"}});
    sdk.logout();
    sdk.flush();
}
```

---

## 4. Build & Verification Commands

```bash
# 1. Compile and run C++17 unit test suite
/usr/bin/clang++ -std=c++17 -O2 -I/Users/zhongjie/data/anylink/abi/abi.sdk/cpp/include \
  /Users/zhongjie/data/anylink/abi/abi.sdk/cpp/tests/abi_cpp_test.cpp -o /tmp/abi_cpp_test && \
  /tmp/abi_cpp_test && rm -f /tmp/abi_cpp_test

# 2. Compile and run two-step CLI Demo
/usr/bin/clang++ -std=c++17 -O2 -I/Users/zhongjie/data/anylink/abi/abi.sdk/cpp/include \
  /Users/zhongjie/data/anylink/abi/abi.sdk/cpp/examples/demo.cpp -o /tmp/abi_cpp_demo && \
  /tmp/abi_cpp_demo --yes && rm -f /tmp/abi_cpp_demo
```
