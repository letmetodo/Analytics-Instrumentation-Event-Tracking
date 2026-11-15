# ABI Lua 数据采集 SDK（OpenResty / 游戏服务端 & Cocos2d-Lua 客户端）

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`abi.sdk/lua` 是 **ABI 企业级用户行为分析（UBA）与 BI 平台** 的官方 Lua 数据采集 SDK（API 设计对标数数科技 ThinkingData Lua SDK v3.4 规范）。

SDK 采用 **100% 纯 Lua 5.3+ 标准库（`abi_sdk.lua`）、零第三方 C 扩展依赖** 实现，内置确定性格式化 JSON 编解码器与 UTF-8 校验器，同时支持 **OpenResty / Skynet 后端服务端无状态模式** 与 **Cocos2d-Lua 手游客户端有状态设备模式**。

---

## 1. 核心特性与四大 Consumer 架构

### 核心特性
- **零外部依赖**：无需编译安装 `lua-cjson` 或第三方 C 动态库，单文件 `abi_sdk.lua` 即可直接在标准 Lua 5.3+、OpenResty 或 Cocos2d-Lua 环境中加载运行。
- **双模式支持（100% 对齐数数科技双身份模型 `distinct_id` + `login_id`）**：
  - **OpenResty / Skynet 服务端无状态模式**：每次调用显式传入 `account_id`（`login_id` ≤ 128 字节）、`distinct_id`（访客/设备 ID ≤ 64 字节，至少一个非空；仅传 `account_id` 时 `distinct_id` 保持空字符串 `""`）以及从 `ngx.var.remote_addr` / `X-Forwarded-For` 提取的玩家真实公网 `"#ip"`。
  - **Cocos2d-Lua 游戏客户端有状态设备模式**：支持 `enable_client_mode`、`identify(distinct_id)`（纯本地更新访客 ID）、`login(account_id)`（仅本地设置 `login_id`，**绝不覆盖 `distinct_id`、绝不发送任何网络事件**）、`logout()`（仅清空 `login_id`）、`time_event`（秒表耗时自动计算 `$duration`）及客户端设备预置属性自动注入。
- **64 位雪花 ID 精度保护（`> 2^53 - 1` 自动转字符串）**：对超出 IEEE-754 双精度安全整数上限（`9007199254740991`，含 `math.mininteger` 及一维数组元素）的 Lua 64 位整数自动转换为十进制字符串，防止跨端 JSON 解析丢失低位精度。
- **严格身份校验与画像隔离**：内置 UTF-8 解码校验、ASCII 控制字符拦截（`0x00–0x08`、`0x0E–0x1F`、`0x7F`）、首尾 Unicode 空白裁剪与 64/128 字节边界检查；公共属性与设备环境属性在全部 7 类 `$user_*` 画像事件中自动隔离。

### 四大 Consumer 架构

| Consumer 类型 | 构造函数 | 适用场景与核心能力 |
| :--- | :--- | :--- |
| **`StagingConsumer`** | `abi.new_staging_consumer` | **两步式预览与确认提交**：将埋点事件暂存在内存队列中，先通过 `preview_request_json()` 预览即将发送至 `POST /collect/api/v1/track/batch` 的完整格式化 JSON（零网络请求），确认无误后再调用 `submit_to_gateway()` 或 `confirm_submit()` 提交。 |
| **`LoggerConsumer`** | `abi.new_logger_consumer` | **本地 JSONL 轮转落盘**：将事件按行序列化为 JSONL 写入本地磁盘（支持按天 `DAILY`、按小时 `HOURLY` 切分），推荐 OpenResty / Skynet 游戏服配合 Filebeat / Vector 旁路采集。 |
| **`BatchConsumer`** | `abi.new_batch_consumer` | **生产高吞吐批量缓冲上报**：内存缓冲队列，达到 `batch_size` 自动触发批量提交，支持自定义 `transport` 回调（如对接 `lua-resty-http` 或 Cocos2d `cc.XMLHttpRequest`）。 |
| **`DebugConsumer`** | `abi.new_debug_consumer` | **研发期同步 L4 强校验与 `dry_run`**：逐条同步发送事件并开启 `debug=true`（可选 `dry_run=true` 仅校验不写入 Kafka / StarRocks）。 |

---

## 2. 接入人员必读：OpenResty 服务端模式 vs. Cocos2d-Lua 客户端模式的职责边界

| 核心维度 | OpenResty / Skynet 服务端无状态模式 | Cocos2d-Lua 手游客户端有状态模式 |
| :--- | :--- | :--- |
| **用户身份管理**<br>(`distinct_id` / `login_id`) | **【每次调用必传】** 服务端 Worker 被所有请求共享，每次调用 `sdk:track(account_id, distinct_id, ...)` 必须显式传入当前请求用户的 `account_id`（`login_id`）或客户端请求头 `X-ABI-Distinct-Id` 透传的访客 ID（至少一个非空）。 | **【SDK 自动管理】** 游戏启动时调用 `sdk:enable_client_mode(cfg)` 自动生成/挂载设备访客 `distinct_id`；玩家登录时调用一次 `sdk:login(account_id)`（纯本地设置 `login_id`，保留 `distinct_id` 不变，不发网络请求），之后调用 `sdk:client_track(event_name, props)` 自动同时携带两者。 |
| **玩家真实公网 IP**<br>(`#ip` / `$ip`，决定国家/省/市地域分析) | **【服务端必传】** OpenResty / 游戏服连接 `:8081` 网关时，网关看到的连接 IP 是**后端服务器内网 IP**（`LoggerConsumer` 落盘更无连接 IP）。服务端必须从 `ngx.req.get_headers()["X-Forwarded-For"]` 或 `ngx.var.remote_addr` 获取客户端真实公网 IP 并传入 `properties["#ip"]`（或 `"$ip"`），Flink ETL 会优先按 `#ip` 解析真实省市并自动剥离该字段。 | **【客户端无需传】** 手机客户端位于 NAT 之后，直连采集网关时**由网关自动从 HTTP 连接提取客户端公网 IP** 交由 Flink 解析地域。 |
| **事件发生时间**<br>(`#time` / `$time` / `timestamp_ms`) | **【实时免填 / 异步与补数必传】** 异步队列消费或历史日志回填时，通过 `properties["#time"]`（支持毫秒/秒级整数或 `"2026-11-10T12:00:00Z"` 字符串）传入实际业务时间，SDK 自动提取为顶层毫秒 `timestamp` 并从 `properties` 剥离。 | **【默认免填】** 客户端实时触发时 SDK 自动取当前毫秒时间戳；仅离线缓存重放时传 `#time`。 |
| **设备环境预置属性**<br>(`$os` / `$app_version` / `$device_model` / `$screen_width`) | **【按需从客户端请求头透传】** 服务端运行在 Linux 容器中，如需按机型分析服务端事件，请从客户端请求头提取后放入单次事件 `properties`（切勿放入全局 `set_super_properties`）。 | **【SDK 自动采集注入】** 通过 `enable_client_mode` 配置一次后自动注入客户端行为事件，并在 `$user_*` 画像事件中自动隔离。 |

---

## 3. 快速开始与代码示例

### 3.1 OpenResty 服务端接入示例（`ngx.var.remote_addr` 传 `#ip`、大整数保护、两步式预览与 7 类画像操作）

```lua
local abi = require("abi_sdk")

-- 提取客户端真实公网 IP（OpenResty 环境优先取 X-Forwarded-For 首跳 IP，回退 ngx.var.remote_addr）
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

-- 1. 初始化 StagingConsumer（支持先预览请求 JSON，确认后再提交）
local staging = abi.new_staging_consumer(1, "abi_tok_openresty", false)
local sdk     = abi.new(staging)

sdk:set_super_properties({
    service_name   = "payment-callback-edge",
    cluster_region = "ap-shanghai",
})

local account_id  = "acct_lua_9001"
local distinct_id = "visitor_cocos_dev_01"
local client_ip   = get_client_ip()

-- 2. 支付成功事件（同时携带 login_id 与访客 distinct_id 自动归因，含 #ip、#time 提取剥离、> 2^53-1 雪花订单号自动转字符串）
sdk:track(account_id, distinct_id, "OrderPaid", {
    ["#ip"]        = client_ip,
    ["#time"]      = "2026-11-10T12:00:00Z",
    ["order_id"]   = 9007199254740999, -- > 2^53-1，自动转为字符串 "9007199254740999"
    ["pay_amount"] = 199.5,
    ["item_skus"]  = abi.array({ "gem_pack_648", "monthly_card" }),
})

-- 3. 全部 7 类用户画像操作（自动隔离静态/动态公共属性）
sdk:user_set(account_id, distinct_id, { nickname = "LuaMaster", vip_level = 6 })
sdk:user_set_once(account_id, distinct_id, { first_ad_channel = "taptap_cn" })
sdk:user_add(account_id, distinct_id, { total_recharged = 199.5 })
sdk:user_append(account_id, distinct_id, { cleared_dungeons = abi.array({ "d_01" }) })
sdk:user_uniq_append(account_id, distinct_id, { owned_medals = abi.array({ "pioneer" }) })
sdk:user_unset(account_id, distinct_id, { "temp_newbie_buff" })

-- 第 1 步：预览格式化 POST /collect/api/v1/track/batch 请求 JSON
print("=== 待提交请求 JSON 预览 ===")
print(staging:preview_request_json(true))

-- 第 2 步：确认提交并打印网关响应 JSON
local _, resp_json = staging:submit_to_gateway({ server_url = "http://127.0.0.1:8081" })
print("=== 提交响应结果 ===")
print(resp_json)
```

### 3.2 Cocos2d-Lua 游戏客户端有状态设备模式示例

```lua
local abi = require("abi_sdk")

local batch_consumer = abi.new_batch_consumer({
    server_url    = "https://collect.yourgame.com",
    project_id    = 1,
    project_token = "abi_tok_cocos_client",
    batch_size    = 30,
})
local sdk = abi.new(batch_consumer)

-- 1. 初始化客户端有状态设备模式（无需手动传 #ip，采集网关自动从连接提取公网 IP）
sdk:enable_client_mode({
    distinct_id   = "cocos_dev_uuid_001",
    platform      = "Cocos2d-Lua",
    os            = "Android",
    os_version    = "14.0",
    app_version   = "2.3.0",
    device_model  = "Xiaomi-14-Pro",
    screen_width  = 2400,
    screen_height = 1080,
})

-- 2. 登录前访客上报热更新事件
sdk:client_track("HotUpdateFinished", { patch_mb = 85.5 })

-- 3. 玩家登录：纯本地设置 login_id，保留设备 distinct_id 不变，不发送任何网络事件
sdk:login("acct_lua_9001")

-- 4. 开启关卡秒表计时，通关时自动计算并注入 $duration（秒）
sdk:time_event("StageRaidCompleted")
sdk:client_track("StageRaidCompleted", {
    stage_id     = "stage_abyss_12",
    star_rating  = 3,
    combat_score = 9007199254741008,
})

-- 5. 客户端更新玩家画像（自动隔离 $os / $platform 等设备环境预置属性）
sdk:client_user_set({ guild_name = "Avalon" })

-- 6. 退出登录并刷盘
sdk:logout()
sdk:flush()
```

---

## 4. 运行单元测试与两步式 CLI Demo

```bash
# 1. 运行 Lua 单元测试套件（含跨语言黄金测试向量验证）
/usr/local/bin/lua /Users/zhongjie/data/anylink/abi/abi.sdk/lua/tests/test_abi_sdk.lua

# 2. 运行两步式 CLI Demo（预览单份请求 JSON + --yes 确认提交输出单份响应 JSON）
/usr/local/bin/lua /Users/zhongjie/data/anylink/abi/abi.sdk/lua/examples/demo.lua --yes
```
