-- ============================================================================
-- ABI Lua SDK 两步式交互演示程序 (examples/demo.lua)
--
-- 演示流程：
-- 第 1 步：配置 SDK 参数并在内存 StagingConsumer 中录制 OpenResty 服务端埋点、Cocos2d-Lua
--          客户端埋点与 7 类用户画像操作，输出唯一一份格式化 POST /collect/api/v1/track/batch 请求 JSON 预览。
-- 第 2 步：通过 --yes 或终端输入 y 确认提交，输出唯一一份格式化网关响应 JSON。
-- ============================================================================

local script_path = debug.getinfo(1, "S").source:sub(2)
local script_dir  = script_path:match("^(.*)/") or "."
package.path      = script_dir .. "/../?.lua;" .. package.path

local abi = require("abi_sdk")

local function run_openresty_server_scenario(sdk)
    local account_id  = "acct_lua_9001"
    local distinct_id = "visitor_cocos_dev_01"
    -- 模拟 OpenResty 中通过 ngx.var.remote_addr 或 X-Forwarded-For 获取玩家真实公网 IP
    local client_ip   = "203.0.113.66"

    -- 1. 服务端网关登录事件（使用 track_with_options 指定确定性 event_id 保障同日重试幂等，同时携带双 ID 自动归因）
    sdk:track_with_options({
        event_id    = "evt_gw_login_9001",
        account_id  = account_id,
        distinct_id = distinct_id,
        event_name  = "GatewayLogin",
        properties  = {
            ["#ip"]         = client_ip,
            ["worker_node"] = "openresty-edge-sh-01",
        },
    })

    -- 2. 服务端支付回调事件（含 #ip、#time 提取剥离、> 2^53-1 64 位雪花订单号自动转字符串）
    local snowflake_order_id = 9007199254740999
    sdk:track(account_id, distinct_id, "OrderPaid", {
        ["#ip"]          = client_ip,
        ["#time"]        = "2026-11-10T12:00:00Z",
        ["order_id"]     = snowflake_order_id,
        ["order_no"]     = "ORD-LUA-20261110-01",
        ["pay_amount"]   = 199.5,
        ["is_first_pay"] = true,
        ["item_skus"]    = abi.array({ "gem_pack_648", "monthly_card" }),
    })

    -- 3. 订单发货完成里程碑事件（使用确定性 event_id 防止回调重放重复入库）
    sdk:track_with_options({
        event_id    = "ord_fulfilled_lua_001",
        account_id  = account_id,
        distinct_id = distinct_id,
        event_name  = "OrderFulfilled",
        properties  = {
            ["#ip"]            = client_ip,
            ["order_id"]       = snowflake_order_id,
            ["order_status"]   = "FULFILLED",
            ["settled_amount"] = 199.5,
            ["delivered"]      = true,
        },
    })
end

local function run_cocos2d_client_scenario(sdk)
    -- 模拟 Cocos2d-Lua 游戏客户端有状态设备模式（客户端直连网关无需传 #ip，网关自动提取连接公网 IP）
    sdk:enable_client_mode({
        distinct_id   = "visitor_cocos_dev_01",
        platform      = "Cocos2d-Lua",
        os            = "Android",
        os_version    = "14.0",
        app_version   = "2.3.0",
        device_model  = "Xiaomi-14-Pro",
        screen_width  = 2400,
        screen_height = 1080,
    })

    -- 玩家登录：仅在本地设置 login_id，保留设备 distinct_id 不变，不发送任何网络事件
    sdk:login("acct_lua_9001")

    sdk:time_event("StageRaidCompleted")
    sdk:client_track("StageRaidCompleted", {
        ["stage_id"]     = "stage_abyss_12",
        ["star_rating"]  = 3,
        ["combat_score"] = 9007199254741008, -- > 2^53-1 自动转为字符串
    })
end

local function run_profile_scenario(sdk)
    local account_id  = "acct_lua_9001"
    local distinct_id = "visitor_cocos_dev_01"

    -- 7 类用户画像操作（自动隔离静态/动态公共属性与客户端设备环境预置属性）
    sdk:user_set(account_id, distinct_id, {
        ["nickname"]  = "LuaMaster",
        ["vip_level"] = 6,
        ["$city"]     = "Shanghai",
    })
    sdk:user_set_once(account_id, distinct_id, {
        ["first_ad_channel"] = "taptap_cn",
        ["registered_at"]    = "2026-11-10T08:00:00Z",
    })
    sdk:user_add(account_id, distinct_id, {
        ["total_recharged"] = 199.5,
        ["gem_balance"]     = 6480,
    })
    sdk:user_append(account_id, distinct_id, {
        ["cleared_dungeons"] = abi.array({ "dungeon_01", "dungeon_02" }),
    })
    sdk:user_uniq_append(account_id, distinct_id, {
        ["owned_medals"] = abi.array({ "s1_champion", "pioneer" }),
    })
    sdk:user_unset(account_id, distinct_id, { "temp_newbie_buff" })
    sdk:user_delete("acct_lua_deleted_01", "visitor_lua_deleted_01")
end

local function main(args)
    local auto_confirm  = false
    local dry_run       = false
    local scenario      = "all"
    local project_id    = 1
    local project_token = "abi_tok_demo_lua"

    for _, a in ipairs(args) do
        if a == "--yes" or a == "-y" then
            auto_confirm = true
        elseif a == "--dry-run" then
            dry_run = true
        elseif a:sub(1, 11) == "--scenario=" then
            scenario = a:sub(12)
        elseif a:sub(1, 8) == "--token=" then
            project_token = a:sub(9)
        elseif a:sub(1, 13) == "--project-id=" then
            project_id = tonumber(a:sub(14)) or 1
        end
    end

    -- 第 1 步：初始化 StagingConsumer，录制埋点并预览单份格式化请求 JSON（零网络请求）
    local staging = abi.new_staging_consumer(project_id, project_token, dry_run)
    local sdk     = abi.new(staging)

    sdk:set_super_properties({
        ["service_name"]   = "abi-openresty-collector",
        ["cluster_region"] = "ap-shanghai",
    })
    sdk:set_dynamic_super_properties(function()
        return {
            ["lua_vm_version"] = _VERSION,
        }
    end)

    if scenario == "server" then
        run_openresty_server_scenario(sdk)
    elseif scenario == "client" then
        run_cocos2d_client_scenario(sdk)
    elseif scenario == "profile" then
        run_profile_scenario(sdk)
    else
        run_openresty_server_scenario(sdk)
        run_cocos2d_client_scenario(sdk)
        run_profile_scenario(sdk)
    end

    local preview_json = staging:preview_request_json(true)
    print("=== 待提交请求 JSON 预览 (POST /collect/api/v1/track/batch) ===")
    print(preview_json)

    -- 第 2 步：--yes 自动确认或终端交互确认提交
    if not auto_confirm then
        io.write("\n是否确认提交上述请求参数？输入 y 回车确认提交，其他键取消: ")
        io.flush()
        local line = io.read("*l")
        if not line or (line:lower() ~= "y") then
            print("已取消提交，未向采集网关发送任何请求。")
            return
        end
    end

    local _, resp_json = staging:submit_to_gateway({
        server_url = "http://127.0.0.1:8081",
    })

    print("\n=== 提交响应结果 (Response JSON) ===")
    print(resp_json)
end

main(arg or {})
