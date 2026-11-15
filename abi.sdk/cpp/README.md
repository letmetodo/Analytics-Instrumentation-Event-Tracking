# ABI C / C++17 数据采集 SDK（服务端 & Unreal Engine / Cocos2d-x 游戏客户端）

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`abi.sdk/cpp` 是 **ABI 企业级用户行为分析（UBA）与 BI 平台** 的官方 C / C++17 数据采集 SDK（API 设计对标数数科技 ThinkingData C/C++ 服务端 SDK 以及 Unreal Engine / Cocos2d-x 游戏客户端 SDK v3.4）。

SDK 采用 **单头文件（Header-Only，`include/abi_sdk.hpp`）、零第三方依赖、跨编译器 STL-ABI 无关** 架构设计，同时内置 `extern "C"` 纯 C 导出接口，可直接集成至 Linux / macOS / Windows C++ 后端战斗服、微服务以及 Unreal Engine 4/5、Cocos2d-x 3.x/4.x 客户端工程。

---

## 1. 核心特性与四大 Consumer 架构

### 核心特性
- **单头文件零依赖（Header-Only）**：仅需 `#include "abi_sdk.hpp"` 即可编译运行，无需链接第三方 JSON 库，且内部容器不暴露跨编译器 `std::string` / `std::map` ABI 差异，天然适配 Unreal Engine 自定义编译工具链与 Cocos2d-x NDK。
- **双模式一体化支持（100% 对齐数数科技双身份模型 `distinct_id` + `login_id`）**：
  - **C/C++ 服务端无状态模式**：支持高并发共享实例，每次调用显式传入 `account_id`（`login_id` ≤ 128 字节）、`distinct_id`（访客/设备 ID ≤ 64 字节，两者至少一个非空；仅传 `account_id` 时 `distinct_id` 保持空字符串 `""`）及客户端真实 `"#ip"`。
  - **Unreal Engine / Cocos2d-x 客户端有状态设备模式**：支持 `enable_client_mode`、`identify(distinct_id)`（本地更新访客 ID，不发网络请求）、`login(account_id)`（仅本地设置 `login_id`，**绝不覆盖 `distinct_id`、绝不发送任何网络事件**）、`logout()`（仅清空 `login_id`）、`time_event`（秒表耗时自动计算 `$duration`）及设备预置属性自动注入。
- **客户端前置强校验**：本地严格执行 UTF-8 合法性校验、ASCII 控制字符拦截（`0x00–0x08`、`0x0E–0x1F`、`0x7F`）、首尾 Unicode 空白符裁剪与字节边界检查（`distinct_id` / `event_id` ≤ 64 字节，`login_id` ≤ 128 字节）。
- **64 位雪花 ID 精度保护（`> 2^53 - 1` 自动转字符串）**：对绝对值超过 IEEE-754 双精度安全整数上限（`9007199254740991`，含 `INT64_MIN` 及数组元素）的 `int64_t` / `uint64_t` 属性值，自动转为十进制字符串传输，杜绝跨端精度丢失。
- **公共属性与 `$user_*` 画像事件严格隔离**：合并优先级遵循 `客户端设备预置属性 < 静态公共属性 < 动态公共属性 < 单次事件属性`，且在全部 7 类 `$user_*` 用户画像操作中自动隔离公共属性与设备环境属性。

### 四大 Consumer 架构

| Consumer 类型 | 类名 | 适用场景与核心能力 |
| :--- | :--- | :--- |
| **`StagingConsumer`** | `abi::StagingConsumer` | **两步式预览与确认提交**：将埋点事件暂存在内存队列中，先通过 `preview_request_json()` 预览即将发送至 `POST /collect/api/v1/track/batch` 的完整格式化 JSON（零网络副作用），核对无误后再通过 `submit_to_gateway()` 或 `confirm_submit()` 正式提交。 |
| **`LoggerConsumer`** | `abi::LoggerConsumer` | **本地 JSONL 轮转落盘**：将事件按行序列化为 JSONL 写入本地磁盘（支持按天 `Daily`、按小时 `Hourly` 切分），推荐 C++ 游戏服务端配合 Filebeat / Vector / LogBus 旁路采集。 |
| **`BatchConsumer`** | `abi::BatchConsumer` | **生产高吞吐批量缓冲上报**：支持内存缓冲队列、达到 `batch_size` 自动触发批量提交，并支持自定义 `HttpTransportFunc`（对接 `libcurl`、Unreal `FHttpModule` 或 Cocos2d-x `HttpClient`）。 |
| **`DebugConsumer`** | `abi::DebugConsumer` | **研发期同步 L4 强校验与 `dry_run`**：逐条同步发送事件并开启 `debug=true`（可选 `dry_run=true` 仅校验不落库 Kafka / StarRocks）。 |

---

## 2. 接入人员必读：C/C++ 服务端模式 vs. Unreal / Cocos2d-x 客户端模式的职责边界

在游戏与实时交互业务中，C++ 既常用于**后端战斗服/网关服**，也常用于 **Unreal Engine / Cocos2d-x 游戏客户端**。两者所处的网络位置不同，字段传参职责完全不同：

| 核心维度 | C/C++ 服务端无状态模式（战斗服 / 匹配服 / 支付服） | Unreal Engine / Cocos2d-x 游戏客户端模式 |
| :--- | :--- | :--- |
| **用户身份管理**<br>(`distinct_id` / `login_id`) | **【每次调用必传】** 服务端进程为所有玩家共享，无单玩家会话状态；每次调用 `sdk.track(account_id, distinct_id, ...)` 必须显式传入当前玩家的 `account_id`（`login_id`）或客户端透传的访客设备 `distinct_id`（至少一个非空）。 | **【SDK 自动管理】** 客户端启动时调用 `sdk.enable_client_mode(cfg)` 自动生成/挂载设备访客 `distinct_id`；玩家登录时调用一次 `sdk.login(account_id)`（纯本地持久化 `login_id`，保留 `distinct_id` 不变），后续调用 `sdk.client_track(event_name, props)` 时自动同时携带 `distinct_id` 与 `login_id`。 |
| **玩家真实公网 IP**<br>(`#ip` / `$ip`，决定国家/省/市地域分析) | **【服务端必传】** 战斗服直连 `:8081` 网关时，网关看到的 TCP 连接 IP 是**机房内网/服务器出口 IP**（使用 `LoggerConsumer` 落盘时更无连接 IP）。服务端必须将玩家客户端连接 IP（或网关透传的 `X-Forwarded-For`）显式写入 `properties["#ip"]`（或 `"$ip"`），Flink ETL 会优先按 `#ip` 解析玩家真实省市并剥离该字段。 | **【客户端无需传】** 玩家手机或 PC 客户端处于 NAT 后方，本身无法可靠获知公网出口 IP；客户端直连采集网关时，**采集网关会自动从 HTTP 连接提取玩家公网 IP** 交由 Flink 解析地域。 |
| **事件发生时间**<br>(`#time` / `$time` / `timestamp_ms`) | **【实时免填 / 异步队列与离线补数必传】** 若为 MQ 异步消费、战报结算回填，必须在 `properties["#time"]`（支持毫秒/秒级整数或 `"2026-11-10T12:00:00Z"` 字符串）中传入实际发生时间，SDK 会自动提取覆写顶层 `timestamp` 并从 `properties` 剥离。 | **【默认免填】** 客户端实时触发时 SDK 自动取当前毫秒时间戳；仅离线缓存补报时传入 `#time`。 |
| **设备环境预置属性**<br>(`$os` / `$app_version` / `$device_model` / `$screen_width`) | **【按需从客户端报文透传】** 服务端运行在 Linux 容器中，若需按客户端机型拆分服务端事件，需由客户端协议透传后放入单次事件 `properties`（切勿放入全局 `set_super_properties`）。 | **【SDK 自动采集注入】** 通过 `enable_client_mode(ClientDeviceConfig)` 配置一次后，自动注入所有客户端行为事件，并在 `$user_*` 画像事件中自动隔离。 |

---

## 3. 快速开始与代码示例

### 3.1 C++17 服务端接入示例（含 `#ip` 透传、大整数保护、两步式预览与 7 类画像操作）

```cpp
#include "abi_sdk.hpp"
#include <stdio.h>

int main() {
    // 1. 初始化 StagingConsumer（支持先预览完整请求 JSON，确认后再提交）
    abi::StagingConsumer staging(1, "abi_tok_cpp_server", false);
    abi::AbiAnalytics sdk(staging);

    // 2. 设置服务端全局静态公共属性（仅放服务端自身集群/服务名，切勿放单个玩家的 IP）
    sdk.set_super_properties({
        {"service_name", "battle-settlement-srv"},
        {"cluster_region", "ap-shanghai"}
    });

    const abi::String account_id  = "player_9001";
    const abi::String distinct_id = "visitor_ue5_dev_01";
    const abi::String client_ip   = "203.0.113.88"; // 从玩家客户端 Socket 或反向代理头提取的真实公网 IP

    // 3. 上报服务端核心支付事件（同时携带 login_id 与访客 distinct_id 自动归因，含 #ip、#time 提取剥离、> 2^53-1 雪花订单号自动转字符串）
    sdk.track(account_id, distinct_id, "OrderPaid", {
        {"#ip", client_ip},
        {"#time", "2026-11-10T12:00:00Z"},
        {"order_id", int64_t(9007199254740999LL)}, // > 2^53-1，自动序列化为字符串 "9007199254740999"
        {"pay_amount", 299.5},
        {"item_skus", abi::Value::from_string_list({"skin_dragon", "battle_pass"})}
    });

    // 4. 7 类用户画像操作（SDK 自动隔离静态/动态公共属性）
    sdk.user_set(account_id, distinct_id, {{"nickname", "DragonKnight"}, {"vip_level", 5}});
    sdk.user_set_once(account_id, distinct_id, {{"first_channel", "steam"}});
    sdk.user_add(account_id, distinct_id, {{"total_recharged", 299.5}});
    sdk.user_append(account_id, distinct_id, {{"chapters", abi::Value::from_string_list({"ch_1"})}});
    sdk.user_uniq_append(account_id, distinct_id, {{"titles", abi::Value::from_string_list({"founder"})}});
    sdk.user_unset(account_id, distinct_id, {"trial_buff_flag"});

    // 第 1 步：预览格式化 POST /collect/api/v1/track/batch 请求 JSON
    abi::String preview_json = staging.preview_request_json(true);
    printf("=== 待提交请求 JSON 预览 ===\n%s\n", preview_json.c_str());

    // 第 2 步：确认无误后提交并获取响应 JSON
    abi::String resp_json;
    staging.submit_to_gateway("http://127.0.0.1:8081", nullptr, &resp_json);
    printf("=== 提交响应结果 ===\n%s\n", resp_json.c_str());
    return 0;
}
```

### 3.2 Unreal Engine 4/5 与 Cocos2d-x 游戏客户端有状态模式示例

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

    // 1. 初始化游戏客户端设备环境（Unreal Engine 可从 FPlatformMisc / GEngine 获取，Cocos2d-x 可从 Application / Director 获取）
    abi::ClientDeviceConfig dev;
    dev.distinct_id   = "ue5_device_uuid_001"; // 若留空则由 SDK 自动生成 UUIDv4
    dev.platform      = "UnrealEngine";        // Cocos2d-x 填 "Cocos2d-x"
    dev.os            = "Windows";
    dev.os_version    = "11.0";
    dev.app_version   = "3.4.0";
    dev.device_model  = "RTX4080";
    dev.screen_width  = 2560;
    dev.screen_height = 1440;
    sdk.enable_client_mode(dev);

    // 2. 登录前访客行为上报（distinct_id 自动取 ue5_device_uuid_001，客户端无需传 #ip）
    sdk.client_track("PatchDownloadCompleted", {{"patch_size_mb", 512}});

    // 3. 玩家登录成功：纯本地设置 login_id，保留 distinct_id 不变，不发送任何网络事件
    sdk.login("player_9001");

    // 4. 开启副本耗时计时并在通关时自动上报 $duration（秒），同时携带 distinct_id 与 login_id
    sdk.time_event("BossDungeonCleared");
    sdk.client_track("BossDungeonCleared", {
        {"dungeon_id", "raid_abyss_09"},
        {"damage_dealt", int64_t(9007199254741005LL)}
    });

    // 5. 客户端更新玩家画像（自动隔离 $os / $platform 等设备环境属性）
    sdk.client_user_set({{"guild_name", "Avalon"}});

    // 6. 玩家切换账号或登出：清空 login_id，保持设备 distinct_id 不变
    sdk.logout();
    sdk.flush();
}
```

### 3.3 纯 C 语言导出接口（`extern "C"`）调用示例

```c
#include "abi_sdk.hpp"
#include <stdio.h>

void c_api_demo(void) {
    abi_client_t* client = abi_client_create_staging(1, "abi_tok_c_demo", 1);
    abi_props_t* props   = abi_props_create();

    abi_props_set_string(props, "#ip", "203.0.113.88");
    abi_props_set_int64(props, "snowflake_id", 9007199254740993LL);
    abi_props_set_double(props, "pay_amount", 99.0);

    abi_track(client, "u_10086", "visitor_c_01", "OrderPaid", props);
    printf("Preview JSON:\n%s\n", abi_staging_preview_json(client));

    abi_props_destroy(props);
    abi_client_destroy(client);
}
```

---

## 4. 编译运行单元测试与两步式 CLI Demo

```bash
# 1. 编译并运行 C++17 单元测试套件
/usr/bin/clang++ -std=c++17 -O2 -I/Users/zhongjie/data/anylink/abi/abi.sdk/cpp/include \
  /Users/zhongjie/data/anylink/abi/abi.sdk/cpp/tests/abi_cpp_test.cpp -o /tmp/abi_cpp_test && \
  /tmp/abi_cpp_test && rm -f /tmp/abi_cpp_test

# 2. 编译并运行两步式 CLI Demo（预览单份请求 JSON + --yes 确认提交输出单份响应 JSON）
/usr/bin/clang++ -std=c++17 -O2 -I/Users/zhongjie/data/anylink/abi/abi.sdk/cpp/include \
  /Users/zhongjie/data/anylink/abi/abi.sdk/cpp/examples/demo.cpp -o /tmp/abi_cpp_demo && \
  /tmp/abi_cpp_demo --yes && rm -f /tmp/abi_cpp_demo
```
