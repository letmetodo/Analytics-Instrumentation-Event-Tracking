// ============================================================================
// ABI C / C++17 SDK 单元测试套件 (tests/abi_cpp_test.cpp)
//
// 覆盖验证项：
// 1. 身份标识校验：ASCII 控制字符拦截（裁剪前拦截）、Unicode 首尾空白裁剪、内部全角空格保留、
//    UTF-8 64/128 字节边界（含多字节中文与 4 字节 Emoji 精确边界）。
// 2. 事件名与属性键校验：正则 ^[A-Za-z_][A-Za-z0-9_]*$ 与系统预置白名单。
// 3. 大整数精度保护（> 2^53 - 1）：int64_t / uint64_t 超出 9007199254740991（含 INT64_MIN 及数组元素）
//    自动转为十进制字符串，安全范围内整数保持数值类型，拦截 NaN / Infinity。
// 4. #time / $time 提取与剥离：支持秒/毫秒时间戳与日期字符串，优先级 #time > $time，并从 properties 剥离。
// 5. 公共属性合并优先级（静态 < 动态 < 单次事件）及与 $user_* / #user_* 画像事件的严格隔离。
// 6. 7 类用户画像操作全集（$user_set / $user_set_once / $user_add / $user_unset / $user_append / $user_uniq_append / $user_del）。
// 7. Unreal Engine / Cocos2d-x 游戏客户端有状态设备模式（identify / login 纯本地更新 login_id 且不覆盖 distinct_id、不发送任何事件 / logout / time_event）。
// 8. StagingConsumer 两步式预览与确认提交、LoggerConsumer JSONL 落盘、BatchConsumer、DebugConsumer 及 C API。
// ============================================================================

#include "abi_sdk.hpp"

namespace {

int g_passed = 0;
int g_failed = 0;

void check_true(bool cond, const abi::String& msg, int line) {
    if (cond) {
        ++g_passed;
    } else {
        ++g_failed;
        ::fprintf(stderr, "[FAIL] Line %d: %s\n", line, msg.c_str());
    }
}

template <typename Fn>
void check_throws(Fn&& fn, const abi::String& msg, int line) {
    bool threw = false;
    try {
        fn();
    } catch (const abi::Error&) {
        threw = true;
    }
    check_true(threw, msg, line);
}

#define ASSERT_TRUE(cond, msg) check_true((cond), (msg), __LINE__)
#define ASSERT_THROWS(expr, msg) check_throws([&]() { (expr); }, (msg), __LINE__)

abi::PropertyMap test_dyn_super_callback() {
    return {
        {"priority_key", "from_dynamic"},
        {"dyn_metric", 42}
    };
}

void test_identity_validation() {
    // 1. 合法 ASCII 与首尾空白裁剪
    ASSERT_TRUE(abi::normalize_identity("  d-valid-1 \t\n", abi::MAX_DISTINCT_ID_BYTES) == "d-valid-1", "ASCII trim");

    // 2. 精确 64 字节与 128 字节边界
    abi::String d64(64, 'd');
    abi::String u128(128, 'u');
    ASSERT_TRUE(abi::normalize_identity(d64, abi::MAX_DISTINCT_ID_BYTES) == d64, "exact 64 bytes distinct_id");
    ASSERT_TRUE(abi::normalize_identity(u128, abi::MAX_LOGIN_ID_BYTES) == u128, "exact 128 bytes login_id");

    // 服务端双身份契约（identity_cases.json）：distinct_id 单独非空、login_id(128B) 单独非空（distinct_id 保持 "" 绝不拷贝）、两者均空拒绝
    abi::String norm_d, norm_u;
    abi::normalize_identity_pair("dev-visitor-only-01", "", norm_d, norm_u);
    ASSERT_TRUE(norm_d == "dev-visitor-only-01" && norm_u.empty(), "distinct_id_only_valid");

    abi::normalize_identity_pair("", u128, norm_d, norm_u);
    ASSERT_TRUE(norm_d.empty() && norm_u == u128, "login_id_only_128_bytes_valid keeps distinct_id empty");

    ASSERT_THROWS(abi::normalize_identity_pair("   ", "\t\n", norm_d, norm_u), "both_identities_empty_rejected");

    // 带空白包裹的 64/128 字节边界裁剪后应通过
    ASSERT_TRUE(abi::normalize_identity(" " + d64 + " ", abi::MAX_DISTINCT_ID_BYTES) == d64, "padded 64 bytes");
    ASSERT_TRUE(abi::normalize_identity(" " + u128 + " ", abi::MAX_LOGIN_ID_BYTES) == u128, "padded 128 bytes");

    // 3. 超出 64 / 128 字节边界应拒绝
    ASSERT_THROWS(abi::normalize_identity(abi::String(65, 'd'), abi::MAX_DISTINCT_ID_BYTES), "65 bytes rejected");
    ASSERT_THROWS(abi::normalize_identity(abi::String(129, 'u'), abi::MAX_LOGIN_ID_BYTES), "129 bytes login rejected");

    // 4. 多字节 UTF-8 中文与 4 字节 Emoji 边界
    // 22 个中文字符 = 66 UTF-8 字节 > 64，拒绝
    abi::String cjk22;
    for (int i = 0; i < 22; ++i) cjk22 += "中";
    ASSERT_THROWS(abi::normalize_identity(cjk22, abi::MAX_DISTINCT_ID_BYTES), "22 CJK chars (66B) rejected");

    // 43 个中文字符 = 129 UTF-8 字节 > 128，拒绝
    abi::String cjk43;
    for (int i = 0; i < 43; ++i) cjk43 += "中";
    ASSERT_THROWS(abi::normalize_identity(cjk43, abi::MAX_LOGIN_ID_BYTES), "43 CJK chars (129B) rejected");

    // 16 个 😀 Emoji = 64 UTF-8 字节，精确通过；17 个 = 68 字节，拒绝
    abi::String emoji16;
    for (int i = 0; i < 16; ++i) emoji16 += "😀";
    ASSERT_TRUE(abi::normalize_identity(emoji16, abi::MAX_DISTINCT_ID_BYTES) == emoji16, "16 emojis (64B) valid");
    ASSERT_THROWS(abi::normalize_identity(emoji16 + "😀", abi::MAX_DISTINCT_ID_BYTES), "17 emojis (68B) rejected");

    // 5. 内部全角空格 (U+3000) 保留，首尾全角空格裁剪
    abi::String internal_ideo = "Device\xE3\x80\x80One";
    ASSERT_TRUE(abi::normalize_identity(internal_ideo, abi::MAX_DISTINCT_ID_BYTES) == internal_ideo, "internal U+3000 preserved");
    ASSERT_TRUE(abi::normalize_identity("\xE3\x80\x80" + internal_ideo + "\xE3\x80\x80", abi::MAX_DISTINCT_ID_BYTES) == internal_ideo, "outer U+3000 trimmed");

    // 6. 控制字符拦截（含 NUL 0x00, BEL 0x07, US 0x1F, DEL 0x7F）
    abi::String with_nul("bad\0id", 6);
    ASSERT_THROWS(abi::normalize_identity(with_nul, abi::MAX_DISTINCT_ID_BYTES), "NUL byte rejected");
    ASSERT_THROWS(abi::normalize_identity("\x07" "Device\x07", abi::MAX_DISTINCT_ID_BYTES), "BEL 0x07 rejected");
    ASSERT_THROWS(abi::normalize_identity("Dev\x1Fice", abi::MAX_DISTINCT_ID_BYTES), "0x1F rejected");
    ASSERT_THROWS(abi::normalize_identity("Account\x7F", abi::MAX_LOGIN_ID_BYTES), "DEL 0x7F rejected");

    // 7. 非法 UTF-8 字节序列拒绝
    abi::String bad_utf8("\xFF\xFEinvalid", 9);
    ASSERT_THROWS(abi::normalize_identity(bad_utf8, abi::MAX_DISTINCT_ID_BYTES), "invalid UTF-8 rejected");
}

void test_event_and_property_names() {
    ASSERT_TRUE(abi::validate_event_name("OrderPaid_2026") == "OrderPaid_2026", "valid custom event");
    ASSERT_TRUE(abi::validate_event_name("$signup") == "$signup", "system event $signup");
    ASSERT_TRUE(abi::validate_event_name("$login") == "$login", "system event $login");
    ASSERT_TRUE(abi::validate_event_name("$user_set") == "$user_set", "system event $user_set");
    ASSERT_THROWS(abi::validate_event_name("$identify"), "$identify removed and rejected");
    ASSERT_THROWS(abi::validate_event_name("#identify"), "#identify removed and rejected");
    ASSERT_THROWS(abi::validate_event_name(""), "empty event name rejected");
    ASSERT_THROWS(abi::validate_event_name("123_bad"), "leading digit event name rejected");
    ASSERT_THROWS(abi::validate_event_name("bad-hyphen"), "hyphen event name rejected");
    ASSERT_THROWS(abi::validate_event_name("$unknown_sys"), "unregistered $ event rejected");

    ASSERT_TRUE(abi::validate_property_key("pay_amount") == "pay_amount", "valid custom key");
    ASSERT_TRUE(abi::validate_property_key("#ip") == "#ip", "system key #ip");
    ASSERT_TRUE(abi::validate_property_key("$os") == "$os", "system key $os");
    ASSERT_THROWS(abi::validate_property_key("$anonymous_id"), "$anonymous_id rejected");
    ASSERT_THROWS(abi::validate_property_key("#anonymous_id"), "#anonymous_id rejected");
    ASSERT_THROWS(abi::validate_property_key("bad-key"), "hyphen key rejected");
    ASSERT_THROWS(abi::validate_property_key("9key"), "leading digit key rejected");
    ASSERT_THROWS(abi::validate_property_key("$unregistered_prop"), "unregistered $ key rejected");
}

void test_bigint_precision_protection() {
    abi::PropertyMap raw = {
        {"safe_max", abi::MAX_SAFE_INTEGER},
        {"safe_min", -abi::MAX_SAFE_INTEGER},
        {"unsafe_pos", int64_t(9007199254740993LL)},
        {"unsafe_neg", int64_t(-9007199254740992LL)},
        {"int64_min", INT64_MIN},
        {"uint64_big", uint64_t(9007199254740999ULL)},
        {"mixed_list", abi::Value::from_int64_list({100, 9007199254740995LL})}
    };
    abi::PropertyMap clean = abi::sanitize_properties(raw);

    ASSERT_TRUE(clean["safe_max"].is_int64() && clean["safe_max"].as_int64() == 9007199254740991LL, "safe_max stays int64");
    ASSERT_TRUE(clean["safe_min"].is_int64() && clean["safe_min"].as_int64() == -9007199254740991LL, "safe_min stays int64");
    ASSERT_TRUE(clean["unsafe_pos"].is_string() && clean["unsafe_pos"].as_string() == "9007199254740993", ">2^53-1 converted to string");
    ASSERT_TRUE(clean["unsafe_neg"].is_string() && clean["unsafe_neg"].as_string() == "-9007199254740992", "<-2^53+1 converted to string");
    ASSERT_TRUE(clean["int64_min"].is_string() && clean["int64_min"].as_string() == "-9223372036854775808", "INT64_MIN converted to string");
    ASSERT_TRUE(clean["uint64_big"].is_string() && clean["uint64_big"].as_string() == "9007199254740999", "uint64 >2^53-1 converted to string");

    const auto& arr = clean["mixed_list"].as_array();
    ASSERT_TRUE(arr.size() == 2, "list size 2");
    ASSERT_TRUE(arr[0].is_int64() && arr[0].as_int64() == 100, "list[0] stays int64");
    ASSERT_TRUE(arr[1].is_string() && arr[1].as_string() == "9007199254740995", "list[1] >2^53-1 converted to string");

    // NaN 与 Infinity 必须被拒绝
    ASSERT_THROWS(abi::sanitize_properties({{"bad_nan", static_cast<double>(NAN)}}), "NaN rejected");
    ASSERT_THROWS(abi::sanitize_properties({{"bad_inf", static_cast<double>(INFINITY)}}), "Inf rejected");
}

void test_time_extraction_and_stripping() {
    abi::StagingConsumer staging(1, "abi_tok_test", false);
    abi::AbiAnalytics sdk(staging);

    // 1. 毫秒整型 #time 与 $time 同时存在时，#time 优先，且两者均从 properties 剥离
    sdk.track("u_1", "d_1", "TestTimeMs", {
        {"$time", int64_t(1700000000000LL)},
        {"#time", int64_t(1794283200123LL)},
        {"amount", 88}
    });

    // 2. 秒级整型 $time 自动乘以 1000 转为毫秒
    sdk.track("u_1", "d_1", "TestTimeSec", {
        {"$time", int64_t(1794283200LL)}
    });

    // 3. ISO-8601 字符串 #time 解析为毫秒
    sdk.track("u_1", "d_1", "TestTimeISO", {
        {"#time", "2026-11-10T12:00:00.250Z"}
    });

    auto evts = staging.events();
    ASSERT_TRUE(evts.size() == 3, "3 time test events recorded");
    ASSERT_TRUE(evts[0].timestamp == 1794283200123LL, "#time overrides $time");
    ASSERT_TRUE(!evts[0].properties.contains("#time"), "#time stripped");
    ASSERT_TRUE(!evts[0].properties.contains("$time"), "$time stripped");
    ASSERT_TRUE(evts[1].timestamp == 1794283200000LL, "seconds converted to ms");
    ASSERT_TRUE(evts[2].timestamp == 1794312000250LL, "ISO-8601 UTC parsed to ms");
}

void test_super_properties_and_user_profile_isolation() {
    abi::StagingConsumer staging(1, "abi_tok_test", false);
    abi::AbiAnalytics sdk(staging);

    sdk.set_super_properties({
        {"env", "staging"},
        {"priority_key", "from_static"},
        {"to_unset", "temp"}
    });
    sdk.unset_super_property("to_unset");
    sdk.set_dynamic_super_properties(&test_dyn_super_callback);

    // 行为事件：校验优先级 静态 < 动态 < 事件属性，且测试服务端仅传 account_id (128B) 时 distinct_id 保持空字符串 ""
    abi::String long_login_128(128, 'u');
    sdk.track(long_login_128, "", "Purchase", {
        {"priority_key", "from_event"},
        {"price", 99.5}
    });
    ASSERT_THROWS(sdk.track("   ", "\t", "Purchase", {}), "server track rejects both empty identities");

    // 全部 7 类用户画像事件：严禁混入静态/动态公共属性
    sdk.user_set("u_100", "vis_100", {{"vip_level", 2}});
    sdk.user_set_once("u_100", "vis_100", {{"first_utm", "organic"}});
    sdk.user_add("u_100", "vis_100", {{"points", 50}});
    sdk.user_unset("u_100", "vis_100", {"expired_tag"});
    sdk.user_append("u_100", "vis_100", {{"tags", abi::Value::from_string_list({"a", "b"})}});
    sdk.user_uniq_append("u_100", "vis_100", {{"badges", abi::Value::from_string_list({"pro"})}});
    sdk.user_delete("u_100", "vis_100");

    // user_add 传入非数值属性必须抛异常
    ASSERT_THROWS(sdk.user_add("u_100", "vis_100", {{"bad_str", "not_a_number"}}), "user_add rejects string");

    // D7① / G6 门禁：未开放接口必须显式抛异常且绝不入队伪造 track 事件
    ASSERT_THROWS(sdk.track_first("u_100", "vis_100", "FirstActivate", "chk_1", {}), "track_first rejected");
    ASSERT_THROWS(sdk.track_update("u_100", "vis_100", "OrderState", "evt_1", {}), "track_update rejected");
    ASSERT_THROWS(sdk.track_overwrite("u_100", "vis_100", "OrderState", "evt_1", {}), "track_overwrite rejected");

    auto evts = staging.events();
    ASSERT_TRUE(evts.size() == 8, "1 track + 7 user profile events");

    const auto& track_evt = evts[0];
    ASSERT_TRUE(track_evt.distinct_id.empty() && track_evt.login_id == long_login_128, "account_id-only keeps distinct_id empty");
    ASSERT_TRUE(track_evt.properties.at("env").as_string() == "staging", "static super prop present on track");
    ASSERT_TRUE(track_evt.properties.at("dyn_metric").as_int64() == 42, "dynamic super prop present on track");
    ASSERT_TRUE(track_evt.properties.at("priority_key").as_string() == "from_event", "event prop overrides dynamic & static");
    ASSERT_TRUE(!track_evt.properties.contains("to_unset"), "unset super prop removed");

    // 检查全部 7 条 $user_* 事件均不包含 env / dyn_metric / priority_key
    const char* const expected_ops[] = {
        "$user_set", "$user_set_once", "$user_add", "$user_unset", "$user_append", "$user_uniq_append", "$user_del"
    };
    for (size_t i = 0; i < 7; ++i) {
        const auto& uevt = evts[i + 1];
        ASSERT_TRUE(uevt.event_name == expected_ops[i], abi::String("user op name matches ") + expected_ops[i]);
        ASSERT_TRUE(!uevt.properties.contains("env"), abi::String("super prop isolated from ") + expected_ops[i]);
        ASSERT_TRUE(!uevt.properties.contains("dyn_metric"), abi::String("dynamic prop isolated from ") + expected_ops[i]);
    }
    ASSERT_TRUE(evts[4].properties.at("expired_tag").as_int64() == 0, "$user_unset sets 0 placeholder");
}

void test_client_engine_mode_and_consumers() {
    abi::StagingConsumer staging(1, "abi_tok_game", true);
    abi::AbiAnalytics sdk(staging);

    const char* tmp_id_file = "/tmp/abi_cpp_test_identity.cfg";
    ::remove(tmp_id_file);

    abi::ClientDeviceConfig cfg;
    cfg.distinct_id  = "cocos_dev_001";
    cfg.storage_file = tmp_id_file;
    cfg.platform     = "Cocos2d-x";
    cfg.os           = "iOS";
    cfg.app_version  = "2.1.0";
    sdk.enable_client_mode(cfg);

    // 未登录时上报：distinct_id 为 cocos_dev_001，login_id 为空
    sdk.client_track("StageEntered", {{"stage_id", 1}});
    ASSERT_TRUE(sdk.get_distinct_id() == "cocos_dev_001", "visitor distinct_id before login");

    // 调用 identify 更新设备 distinct_id：纯本地更新，不产生任何网络事件
    sdk.identify("cocos_dev_002");
    ASSERT_TRUE(sdk.get_distinct_id() == "cocos_dev_002", "distinct_id updated by identify");
    ASSERT_TRUE(staging.events().size() == 1, "identify sends NO network event");

    // 调用 login：仅设置 login_id，绝不覆盖 distinct_id，且不派发任何事件
    sdk.login("player_888");
    ASSERT_TRUE(sdk.get_distinct_id() == "cocos_dev_002", "login NEVER overwrites distinct_id");
    ASSERT_TRUE(sdk.get_login_id() == "player_888", "login sets login_id");
    ASSERT_TRUE(staging.events().size() == 1, "login sends NO network event");

    sdk.time_event("StageCleared");
    sdk.client_track("StageCleared", {{"stars", 3}});

    // 客户端画像更新：不得携带 $os / $app_version 等设备预置属性
    sdk.client_user_set({{"guild_name", "Avalon"}});

    // 客户端 D7① / G6 未开放接口必须显式抛异常且不入队
    ASSERT_THROWS(sdk.client_track_first("FirstStage", "chk_1", {}), "client_track_first rejected");
    ASSERT_THROWS(sdk.client_track_update("StageCleared", "evt_1", {}), "client_track_update rejected");
    ASSERT_THROWS(sdk.client_track_overwrite("StageCleared", "evt_1", {}), "client_track_overwrite rejected");

    // 调用 logout：仅清空 login_id，保留 distinct_id 为 cocos_dev_002，不发送任何事件
    sdk.logout();
    ASSERT_TRUE(sdk.get_distinct_id() == "cocos_dev_002", "distinct_id preserved after logout");
    ASSERT_TRUE(sdk.get_login_id().empty(), "login_id cleared after logout");
    ::remove(tmp_id_file);

    auto evts = staging.events();
    ASSERT_TRUE(evts.size() == 3, "3 client events recorded (zero identify events)");
    ASSERT_TRUE(evts[0].distinct_id == "cocos_dev_001" && evts[0].login_id.empty(), "event 0 visitor only");
    ASSERT_TRUE(evts[1].distinct_id == "cocos_dev_002" && evts[1].login_id == "player_888" && evts[1].properties.contains("$duration"), "event 1 carries both distinct_id and login_id plus $duration");
    ASSERT_TRUE(evts[1].properties.at("$platform").as_string() == "Cocos2d-x", "event 1 has client preset $platform");
    ASSERT_TRUE(evts[2].event_name == "$user_set" && evts[2].distinct_id == "cocos_dev_002" && evts[2].login_id == "player_888" && !evts[2].properties.contains("$platform"), "$user_set isolates client presets");

    // 测试 StagingConsumer 预览 JSON 与确认提交至 BatchConsumer / LoggerConsumer / DebugConsumer
    abi::String preview = staging.preview_request_json(true);
    ASSERT_TRUE(preview.find("\"project_token\": \"abi_tok_game\"") != abi::String::npos, "preview contains project_token");
    ASSERT_TRUE(preview.find("\"dry_run\": true") != abi::String::npos, "preview contains dry_run");

    abi::BatchConsumer::Config batch_cfg;
    batch_cfg.project_id    = 1;
    batch_cfg.project_token = "abi_tok_game";
    batch_cfg.batch_size    = 10;
    abi::BatchConsumer batch_consumer(batch_cfg);

    staging.confirm_submit(batch_consumer);
    ASSERT_TRUE(staging.events().empty(), "staging cleared after confirm_submit");
    ASSERT_TRUE(batch_consumer.flushed_batches().size() == 1, "batch_consumer flushed 1 batch");
    ASSERT_TRUE(batch_consumer.flushed_batches()[0].events.size() == 3, "flushed batch has 3 events");

    // 测试 LoggerConsumer 与 DebugConsumer
    const char* tmp_log = "/tmp/abi_cpp_test_logger.jsonl";
    ::remove(tmp_log);
    abi::LoggerConsumer logger((abi::String(tmp_log)));
    logger.add(batch_consumer.flushed_batches()[0].events[0]);
    ASSERT_TRUE(logger.logged_lines().size() == 1, "logger recorded 1 JSONL line");
    ::remove(tmp_log);

    abi::DebugConsumer::Config dbg_cfg;
    dbg_cfg.project_id    = 1;
    dbg_cfg.project_token = "abi_tok_game";
    dbg_cfg.dry_run       = true;
    abi::DebugConsumer debug_consumer(dbg_cfg);
    debug_consumer.add(batch_consumer.flushed_batches()[0].events[0]);
    ASSERT_TRUE(debug_consumer.sent_payloads().size() == 1 && debug_consumer.last_envelope().dry_run, "debug consumer sent with dry_run");

    // 测试 C API 导出接口
    abi_client_t* c_client = abi_client_create_staging(1, "abi_tok_c_api", 1);
    abi_props_t* c_props   = abi_props_create();
    abi_props_set_string(c_props, "#ip", "198.51.100.12");
    abi_props_set_int64(c_props, "snowflake_id", 9007199254740997LL);
    ASSERT_TRUE(abi_track(c_client, "c_user_1", "c_vis_1", "C_OrderPaid", c_props) == 0, "C API track succeeds");
    abi::String c_json = abi_staging_preview_json(c_client);
    ASSERT_TRUE(c_json.find("\"9007199254740997\"") != abi::String::npos, "C API >2^53-1 converted to string in JSON");
    abi_props_destroy(c_props);
    abi_client_destroy(c_client);
}

} // namespace

int main() {
    test_identity_validation();
    test_event_and_property_names();
    test_bigint_precision_protection();
    test_time_extraction_and_stripping();
    test_super_properties_and_user_profile_isolation();
    test_client_engine_mode_and_consumers();

    ::printf("[ABI C++17 SDK Tests] Passed: %d, Failed: %d\n", g_passed, g_failed);
    return (g_failed == 0) ? 0 : 1;
}
