// ============================================================================
// ABI C / C++17 SDK 两步式交互演示程序 (examples/demo.cpp)
//
// 演示流程：
// 第 1 步：配置 SDK 参数并在内存 StagingConsumer 中录制 C++ 服务端埋点、Unreal/Cocos2d-x
//          客户端埋点与用户画像操作，输出唯一一份格式化 POST /collect/api/v1/track/batch 请求 JSON 预览。
// 第 2 步：通过 --yes 或终端输入 y 确认提交，输出唯一一份格式化网关响应 JSON。
// ============================================================================

#include "abi_sdk.hpp"

#if defined(_WIN32)
#include <io.h>
#define ISATTY _isatty
#define FILENO _fileno
#else
#include <unistd.h>
#define ISATTY isatty
#define FILENO fileno
#endif

namespace {

struct DemoConfig {
    int64_t project_id        = 1;
    abi::String project_token = "abi_tok_demo_cpp";
    abi::String scenario      = "all"; // server | client | profile | all
    bool dry_run              = false;
    bool auto_confirm         = false;
};

abi::PropertyMap dynamic_super_props_callback() {
    return {
        {"server_tick_rate", 60}
    };
}

void run_server_scenario(abi::AbiAnalytics& sdk) {
    const abi::String account_id  = "acct_cpp_9001";
    const abi::String distinct_id = "visitor_ue5_device_01";
    const abi::String client_ip   = "203.0.113.88";

    // 1. 服务端会话激活事件（携带确定性 event_id 保障同日重试幂等，同时携带 login_id 与访客 distinct_id 自动归因）
    abi::TrackOptions sess_opts;
    sess_opts.event_id    = "evt_sess_activated_9001";
    sess_opts.account_id  = account_id;
    sess_opts.distinct_id = distinct_id;
    sess_opts.event_name  = "ServerSessionActivated";
    sess_opts.properties  = {
        {"#ip", client_ip},
        {"server_node", "game-battle-sh-01"}
    };
    sdk.track_with_options(sess_opts);

    // 2. 服务端支付成功事件（含 #ip、#time 提取剥离、> 2^53-1 雪花订单号自动转字符串）
    int64_t snowflake_order_id = 9007199254740999LL;
    sdk.track(account_id, distinct_id, "OrderPaid", {
        {"#ip", client_ip},
        {"#time", "2026-11-10T12:00:00Z"},
        {"order_id", snowflake_order_id},
        {"order_no", "ORD-CPP-20261110-01"},
        {"pay_amount", 299.5},
        {"is_first_pay", true},
        {"item_skus", abi::Value::from_string_list({"skin_dragon_slayer", "battle_pass_s1"})}
    });

    // 3. 订单结算里程碑事件（使用 track_with_options 指定确定性 event_id 防消息队列重试重复入库）
    abi::TrackOptions settled_opts;
    settled_opts.event_id    = "ord_settled_cpp_001";
    settled_opts.account_id  = account_id;
    settled_opts.distinct_id = distinct_id;
    settled_opts.event_name  = "OrderSettled";
    settled_opts.properties  = {
        {"#ip", client_ip},
        {"order_id", snowflake_order_id},
        {"order_status", "COMPLETED"},
        {"settled_amount", 299.5},
        {"invoice_issued", true}
    };
    sdk.track_with_options(settled_opts);
}

void run_client_engine_scenario(abi::AbiAnalytics& sdk) {
    // 模拟 Unreal Engine 5 / Cocos2d-x 游戏客户端有状态设备模式（无需手动传 #ip，网关自动取连接公网 IP）
    abi::ClientDeviceConfig dev_cfg;
    dev_cfg.distinct_id   = "visitor_ue5_device_01";
    dev_cfg.platform      = "UnrealEngine";
    dev_cfg.os            = "Windows";
    dev_cfg.os_version    = "11.0";
    dev_cfg.app_version   = "3.4.0";
    dev_cfg.device_model  = "RTX4080-Workstation";
    dev_cfg.screen_width  = 2560;
    dev_cfg.screen_height = 1440;

    sdk.enable_client_mode(dev_cfg);
    sdk.login("acct_cpp_9001"); // 纯本地设置 login_id，不覆盖 distinct_id、不产生任何网络事件

    sdk.time_event("BossDungeonCleared");
    sdk.client_track("BossDungeonCleared", {
        {"dungeon_id", "raid_abyss_09"},
        {"boss_level", 90},
        {"damage_dealt", int64_t(9007199254741005LL)} // > 2^53-1 伤害数值自动转字符串
    });
}

void run_profile_scenario(abi::AbiAnalytics& sdk) {
    const abi::String account_id  = "acct_cpp_9001";
    const abi::String distinct_id = "visitor_ue5_device_01";

    // 7 类用户画像操作（SDK 自动隔离静态/动态公共属性与客户端设备环境属性）
    sdk.user_set(account_id, distinct_id, {
        {"nickname", "DragonKnight"},
        {"vip_level", 5},
        {"$city", "Shanghai"}
    });
    sdk.user_set_once(account_id, distinct_id, {
        {"first_channel", "steam_global"},
        {"registered_at", "2026-11-10T08:00:00Z"}
    });
    sdk.user_add(account_id, distinct_id, {
        {"total_recharged", 299.5},
        {"vip_points", 300}
    });
    sdk.user_append(account_id, distinct_id, {
        {"unlocked_chapters", abi::Value::from_string_list({"chapter_1", "chapter_2"})}
    });
    sdk.user_uniq_append(account_id, distinct_id, {
        {"owned_titles", abi::Value::from_string_list({"founder", "abyss_conqueror"})}
    });
    sdk.user_unset(account_id, distinct_id, {"trial_buff_flag"});
    sdk.user_delete("acct_cpp_deleted_01", "visitor_cpp_deleted_01");
}

} // namespace

int main(int argc, char* argv[]) {
    DemoConfig cfg;
    for (int i = 1; i < argc; ++i) {
        abi::String arg(argv[i]);
        if (arg == "--yes" || arg == "-y") {
            cfg.auto_confirm = true;
        } else if (arg == "--dry-run") {
            cfg.dry_run = true;
        } else if (arg.starts_with("--scenario=")) {
            cfg.scenario = arg.substr(11);
        } else if (arg.starts_with("--token=")) {
            cfg.project_token = arg.substr(8);
        } else if (arg.starts_with("--project-id=")) {
            cfg.project_id = ::atoll(arg.substr(13).c_str());
        }
    }

    try {
        // 第 1 步：初始化 StagingConsumer，录制埋点并预览单份格式化请求 JSON（零网络副作用）
        abi::StagingConsumer staging(cfg.project_id, cfg.project_token, cfg.dry_run);
        abi::AbiAnalytics sdk(staging);

        sdk.set_super_properties({
            {"service_name", "abi-cpp-game-server"},
            {"cluster_region", "ap-shanghai"}
        });
        sdk.set_dynamic_super_properties(&dynamic_super_props_callback);

        if (cfg.scenario == "server") {
            run_server_scenario(sdk);
        } else if (cfg.scenario == "client") {
            run_client_engine_scenario(sdk);
        } else if (cfg.scenario == "profile") {
            run_profile_scenario(sdk);
        } else {
            run_server_scenario(sdk);
            run_client_engine_scenario(sdk);
            run_profile_scenario(sdk);
        }

        abi::String preview_json = staging.preview_request_json(true);
        ::printf("=== 待提交请求 JSON 预览 (POST /collect/api/v1/track/batch) ===\n%s\n", preview_json.c_str());

        // 第 2 步：交互式确认或 --yes 自动确认提交
        if (!cfg.auto_confirm && ISATTY(FILENO(stdin))) {
            ::printf("\n是否确认提交上述请求参数？输入 y 回车确认提交，其他键取消: ");
            ::fflush(stdout);
            char buf[64] = {0};
            if (!::fgets(buf, sizeof(buf), stdin) || (buf[0] != 'y' && buf[0] != 'Y')) {
                ::printf("已取消提交，未向采集网关发送任何请求。\n");
                return 0;
            }
        }

        abi::String resp_json;
        staging.submit_to_gateway("http://127.0.0.1:8081", nullptr, &resp_json);

        ::printf("\n=== 提交响应结果 (Response JSON) ===\n%s\n", resp_json.c_str());
        return 0;
    } catch (const abi::Error& ex) {
        ::fprintf(stderr, "[错误] ABI C++ SDK Demo 执行失败: %s\n", ex.what());
        return 1;
    }
}
