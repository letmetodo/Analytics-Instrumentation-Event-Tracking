-- ============================================================================
-- ABI Lua SDK 单元测试套件 (tests/test_abi_sdk.lua)
--
-- 覆盖验证项：
-- 1. 黄金测试向量契约（spec/test-vectors/identity_cases.json & event_and_property_cases.json）：
--    - 身份标识控制字符拦截（0x00, 0x07, 0x1F, 0x7F）、Unicode 首尾空白裁剪、内部全角空格保留、
--      UTF-8 64/128 字节边界（含多字节中文与 4 字节 Emoji 精确边界）。
--    - 事件名与属性键正则校验及系统白名单。
-- 2. 大整数精度保护（> 2^53 - 1）：64 位整数超出 9007199254740991（含 math.mininteger 及数组元素）
--    自动转为十进制字符串，安全范围内整数保持整型，拦截 NaN / Infinity。
-- 3. #time / $time 提取与剥离：支持秒/毫秒时间戳与日期字符串，优先级 #time > $time，并从 properties 剥离。
-- 4. 公共属性合并优先级（静态 < 动态 < 单次事件）及与 $user_* / #user_* 画像事件的严格隔离。
-- 5. 7 类用户画像操作全集（$user_set / $user_set_once / $user_add / $user_unset / $user_append / $user_uniq_append / $user_del）。
-- 6. Cocos2d-Lua 游戏客户端有状态设备模式（enable_client_mode / identify / login 仅本地设置 login_id 且不覆盖 distinct_id、不发送任何事件 / logout / time_event）。
-- 7. StagingConsumer 两步式预览与确认提交、LoggerConsumer JSONL 落盘、BatchConsumer、DebugConsumer。
-- ============================================================================

local script_path = debug.getinfo(1, "S").source:sub(2)
local script_dir  = script_path:match("^(.*)/") or "."
package.path      = script_dir .. "/../?.lua;" .. package.path

local abi = require("abi_sdk")

local passed = 0
local failed = 0

local function assert_true(cond, msg)
    if cond then
        passed = passed + 1
    else
        failed = failed + 1
        io.stderr:write("[FAIL] " .. tostring(msg) .. "\n")
    end
end

local function assert_throws(fn, msg)
    local ok, _ = pcall(fn)
    assert_true(not ok, msg)
end

local function read_file_content(path)
    local f = io.open(path, "rb")
    if not f then
        return nil
    end
    local content = f:read("*a")
    f:close()
    return content
end

local function test_golden_vectors_and_identity()
    local id_json_str = read_file_content(script_dir .. "/../../spec/test-vectors/identity_cases.json")
    assert_true(id_json_str ~= nil, "loaded identity_cases.json")
    local id_vectors = abi.json_decode(id_json_str)

    for _, tc in ipairs(id_vectors.cases) do
        local ok, res = pcall(function()
            local d, u = abi.normalize_identity_pair(tc.distinct_id or "", tc.login_id or "")
            return { d = d, u = u }
        end)
        if tc.valid then
            assert_true(ok, "identity vector should be valid: " .. tc.name)
            if ok then
                assert_true(res.d == tc.normalized_distinct_id, "normalized distinct_id for " .. tc.name)
                assert_true(res.u == tc.normalized_login_id, "normalized login_id for " .. tc.name)
            end
        else
            assert_true(not ok, "identity vector should be rejected: " .. tc.name)
        end
    end

    -- 补充非法 UTF-8 字节序列断言
    assert_throws(function()
        abi.normalize_identity("\xFF\xFEbad", abi.MAX_DISTINCT_ID_BYTES)
    end, "invalid UTF-8 bytes rejected")

    -- 加载事件名与属性键黄金测试向量
    local ep_json_str = read_file_content(script_dir .. "/../../spec/test-vectors/event_and_property_cases.json")
    assert_true(ep_json_str ~= nil, "loaded event_and_property_cases.json")
    local ep_vectors = abi.json_decode(ep_json_str)

    for _, ec in ipairs(ep_vectors.event_name_cases) do
        local ok, _ = pcall(function()
            abi.validate_event_name(ec.event_name)
        end)
        assert_true(ok == ec.valid, "event_name vector: " .. tostring(ec.event_name))
    end

    for _, pc in ipairs(ep_vectors.property_key_cases) do
        local ok, _ = pcall(function()
            abi.validate_property_key(pc.key)
        end)
        assert_true(ok == pc.valid, "property_key vector: " .. tostring(pc.key))
    end
end

local function test_bigint_precision_protection()
    local clean = abi.sanitize_properties({
        safe_max   = abi.MAX_SAFE_INTEGER,
        safe_min   = -abi.MAX_SAFE_INTEGER,
        unsafe_pos = 9007199254740993,
        unsafe_neg = -9007199254740992,
        min_int64  = math.mininteger,
        mixed_list = abi.array({ 100, 9007199254740995 }),
    })

    assert_true(type(clean.safe_max) == "number" and clean.safe_max == 9007199254740991, "safe_max stays number")
    assert_true(type(clean.safe_min) == "number" and clean.safe_min == -9007199254740991, "safe_min stays number")
    assert_true(type(clean.unsafe_pos) == "string" and clean.unsafe_pos == "9007199254740993", ">2^53-1 converted to string")
    assert_true(type(clean.unsafe_neg) == "string" and clean.unsafe_neg == "-9007199254740992", "<-2^53+1 converted to string")
    assert_true(type(clean.min_int64) == "string" and clean.min_int64 == "-9223372036854775808", "math.mininteger converted to string")
    assert_true(type(clean.mixed_list[1]) == "number" and clean.mixed_list[1] == 100, "list[1] stays number")
    assert_true(type(clean.mixed_list[2]) == "string" and clean.mixed_list[2] == "9007199254740995", "list[2] >2^53-1 converted to string")

    -- NaN 与 Infinity 必须拦截
    assert_throws(function()
        abi.sanitize_properties({ bad_nan = 0 / 0 })
    end, "NaN rejected")
    assert_throws(function()
        abi.sanitize_properties({ bad_inf = math.huge })
    end, "Infinity rejected")
end

local function test_time_extraction_and_stripping()
    local staging = abi.new_staging_consumer(1, "abi_tok_lua_test", false)
    local sdk     = abi.new(staging)

    -- 1. #time 与 $time 同时存在时 #time 优先，且从 properties 中剥离
    sdk:track("u_1", "d_1", "TestTimeMs", {
        ["$time"]  = 1700000000000,
        ["#time"]  = 1794283200123,
        ["amount"] = 66,
    })

    -- 2. 秒级整数自动乘以 1000 转为毫秒
    sdk:track("u_1", "d_1", "TestTimeSec", {
        ["$time"] = 1794283200,
    })

    -- 3. ISO-8601 字符串自动解析为毫秒
    sdk:track("u_1", "d_1", "TestTimeISO", {
        ["#time"] = "2026-11-10T12:00:00.250Z",
    })

    local evts = staging:events()
    assert_true(#evts == 3, "3 time test events recorded")
    assert_true(evts[1].timestamp == 1794283200123, "#time overrides $time")
    assert_true(evts[1].properties["#time"] == nil and evts[1].properties["$time"] == nil, "#time and $time stripped")
    assert_true(evts[2].timestamp == 1794283200000, "seconds converted to ms")
    assert_true(evts[3].timestamp == 1794312000250, "ISO-8601 UTC parsed to ms")
end

local function test_super_properties_and_user_profile_isolation()
    local staging = abi.new_staging_consumer(1, "abi_tok_lua_test", false)
    local sdk     = abi.new(staging)

    sdk:set_super_properties({
        env          = "staging",
        priority_key = "from_static",
        to_unset     = "temp",
    })
    sdk:unset_super_property("to_unset")
    sdk:set_dynamic_super_properties(function()
        return {
            priority_key = "from_dynamic",
            dyn_metric   = 42,
        }
    end)

    local long_login_128 = string.rep("u", 128)
    sdk:track(long_login_128, "", "Purchase", {
        priority_key = "from_event",
        price        = 99.5,
    })
    assert_throws(function()
        sdk:track("   ", "\t", "Purchase", {})
    end, "server track rejects both empty identities")

    -- 全部 7 类用户画像操作
    sdk:user_set("u_100", "vis_100", { vip_level = 2 })
    sdk:user_set_once("u_100", "vis_100", { first_utm = "organic" })
    sdk:user_add("u_100", "vis_100", { points = 50 })
    sdk:user_unset("u_100", "vis_100", { "expired_tag" })
    sdk:user_append("u_100", "vis_100", { tags = abi.array({ "a", "b" }) })
    sdk:user_uniq_append("u_100", "vis_100", { badges = abi.array({ "pro" }) })
    sdk:user_delete("u_100", "vis_100")

    -- user_add 传入非数值属性必须拦截
    assert_throws(function()
        sdk:user_add("u_100", "vis_100", { bad_str = "not_a_number" })
    end, "user_add rejects non-numeric property")

    -- D7① / G6 门禁：未开放接口必须显式报错且绝不入队伪造 track 事件
    assert_throws(function()
        sdk:track_first("u_100", "vis_100", "FirstActivate", "chk_1", {})
    end, "track_first rejected")
    assert_throws(function()
        sdk:track_update("u_100", "vis_100", "OrderState", "evt_1", {})
    end, "track_update rejected")
    assert_throws(function()
        sdk:track_overwrite("u_100", "vis_100", "OrderState", "evt_1", {})
    end, "track_overwrite rejected")

    local evts = staging:events()
    assert_true(#evts == 8, "1 track + 7 user profile events")
    assert_true(evts[1].distinct_id == "" and evts[1].login_id == long_login_128, "account_id-only keeps distinct_id empty")
    assert_true(evts[1].properties.env == "staging", "static super prop present on track")
    assert_true(evts[1].properties.dyn_metric == 42, "dynamic super prop present on track")
    assert_true(evts[1].properties.priority_key == "from_event", "event prop overrides dynamic & static")
    assert_true(evts[1].properties.to_unset == nil, "unset super prop removed")

    local expected_ops = {
        "$user_set", "$user_set_once", "$user_add", "$user_unset", "$user_append", "$user_uniq_append", "$user_del",
    }
    for i, op_name in ipairs(expected_ops) do
        local uevt = evts[i + 1]
        assert_true(uevt.event_name == op_name, "user op name matches " .. op_name)
        assert_true(uevt.properties.env == nil, "super prop isolated from " .. op_name)
        assert_true(uevt.properties.dyn_metric == nil, "dynamic prop isolated from " .. op_name)
    end
    assert_true(evts[5].properties.expired_tag == 0, "$user_unset sets 0 placeholder")
end

local function test_cocos2d_client_mode_and_consumers()
    local staging = abi.new_staging_consumer(1, "abi_tok_cocos", true)
    local sdk     = abi.new(staging)
    local tmp_id  = "/tmp/abi_lua_test_identity.json"
    os.remove(tmp_id)

    sdk:enable_client_mode({
        distinct_id  = "cocos_lua_dev_01",
        storage_file = tmp_id,
        platform     = "Cocos2d-Lua",
        os           = "iOS",
        app_version  = "2.1.0",
    })

    sdk:client_track("StageEntered", { stage_id = 1 })
    assert_true(sdk:get_distinct_id() == "cocos_lua_dev_01", "visitor distinct_id before login")

    sdk:identify("cocos_lua_dev_02")
    assert_true(sdk:get_distinct_id() == "cocos_lua_dev_02", "distinct_id updated by identify")
    assert_true(#staging:events() == 1, "identify sends NO network event")

    assert_true(sdk:login("player_999") == nil, "login returns nil")
    assert_true(sdk:get_distinct_id() == "cocos_lua_dev_02", "login NEVER overwrites distinct_id")
    assert_true(sdk:get_login_id() == "player_999", "login sets login_id")
    assert_true(#staging:events() == 1, "login sends NO network event")

    sdk:time_event("StageCleared")
    sdk:client_track("StageCleared", { stars = 3 })

    sdk:client_user_set({ guild_name = "Avalon" })

    assert_throws(function()
        sdk:client_track_first("FirstStage", "chk_1", {})
    end, "client_track_first rejected")
    assert_throws(function()
        sdk:client_track_update("StageCleared", "evt_1", {})
    end, "client_track_update rejected")
    assert_throws(function()
        sdk:client_track_overwrite("StageCleared", "evt_1", {})
    end, "client_track_overwrite rejected")

    sdk:logout()
    assert_true(sdk:get_distinct_id() == "cocos_lua_dev_02", "distinct_id preserved after logout")
    assert_true(sdk:get_login_id() == "", "login_id cleared after logout")
    os.remove(tmp_id)

    local evts = staging:events()
    assert_true(#evts == 3, "3 client events recorded (zero identify events)")
    assert_true(evts[1].distinct_id == "cocos_lua_dev_01" and evts[1].login_id == "", "event 1 visitor only")
    assert_true(evts[2].distinct_id == "cocos_lua_dev_02" and evts[2].login_id == "player_999" and evts[2].properties["$duration"] ~= nil, "event 2 carries both distinct_id and login_id plus $duration")
    assert_true(evts[2].properties["$platform"] == "Cocos2d-Lua", "event 2 has client preset $platform")
    assert_true(evts[3].event_name == "$user_set" and evts[3].distinct_id == "cocos_lua_dev_02" and evts[3].login_id == "player_999" and evts[3].properties["$platform"] == nil, "$user_set isolates client presets")

    local preview = staging:preview_request_json(true)
    assert_true(preview:find('"project_token": "abi_tok_cocos"', 1, true) ~= nil, "preview contains project_token")
    assert_true(preview:find('"dry_run": true', 1, true) ~= nil, "preview contains dry_run")

    local batch_consumer = abi.new_batch_consumer({
        project_id    = 1,
        project_token = "abi_tok_cocos",
        batch_size    = 10,
    })
    staging:confirm_submit(batch_consumer)
    assert_true(#staging:events() == 0, "staging cleared after confirm_submit")
    assert_true(#batch_consumer:flushed_batches() == 1, "batch_consumer flushed 1 batch")
    assert_true(#batch_consumer:flushed_batches()[1].events == 3, "flushed batch has 3 events")

    local tmp_log = "/tmp/abi_lua_test_logger.jsonl"
    os.remove(tmp_log)
    local logger = abi.new_logger_consumer(tmp_log)
    logger:add(batch_consumer:flushed_batches()[1].events[1])
    assert_true(#logger:logged_lines() == 1, "logger recorded 1 JSONL line")
    os.remove(tmp_log)

    local debug_consumer = abi.new_debug_consumer({
        project_id    = 1,
        project_token = "abi_tok_cocos",
        dry_run       = true,
    })
    debug_consumer:add(batch_consumer:flushed_batches()[1].events[1])
    assert_true(#debug_consumer:sent_payloads() == 1 and debug_consumer:last_envelope().data.dry_run == true, "debug consumer sent with dry_run")
end

test_golden_vectors_and_identity()
test_bigint_precision_protection()
test_time_extraction_and_stripping()
test_super_properties_and_user_profile_isolation()
test_cocos2d_client_mode_and_consumers()

print(string.format("[ABI Lua SDK Tests] Passed: %d, Failed: %d", passed, failed))
if failed > 0 then
    os.exit(1)
end
