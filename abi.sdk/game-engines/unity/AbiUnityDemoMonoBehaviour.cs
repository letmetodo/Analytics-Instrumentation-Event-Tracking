using System;
using System.Collections.Generic;
using System.Globalization;
#if UNITY_5_3_OR_NEWER
using UnityEngine;
#endif

namespace Abi.GameEngines.Unity
{
    /// <summary>
    /// 面向 Unity 客户端的 <see cref="AbiUnityAnalytics"/> 两步式无界面演练运行器：
    /// <list type="number">
    ///   <item><description><see cref="PreviewScenarioJson"/>：以 <c>autoFlush: false</c> 构造游戏埋点场景，生成并返回唯一一份格式化的 <c>POST /collect/api/v1/track/batch</c> 请求 JSON；</description></item>
    ///   <item><description><see cref="ConfirmSubmit"/>：确认提交当前暂存批次并回调单次网关响应。</description></item>
    /// </list>
    /// </summary>
    public static class AbiUnityDemoRunner
    {
        /// <summary>
        /// 第 1 步：以 <c>autoFlush: false</c> 初始化并构造全套游戏客户端埋点场景
        /// （访客标识 <c>distinct_id</c> 与登录账号 ID <c>login_id</c> 本地设置、静态/动态公共属性、<see cref="AbiUnityAnalytics.TimeEvent"/> 副本耗时计时、
        /// <c>&gt; 2^53 - 1</c> 64 位雪花战斗/订单流水号、独立里程碑事件及 7 类 <c>$user_*</c> 玩家画像操作），
        /// 返回格式化后的待提交请求 JSON 字符串（零网络副作用）。
        /// </summary>
        public static string PreviewScenarioJson(
            string serverUrl = "http://127.0.0.1:8081",
            long projectId = 1,
            string projectToken = "abi_tok_unity_demo")
        {
            var sdk = AbiUnityAnalytics.Shared;
            sdk.Initialize(
                serverUrl: serverUrl,
                projectId: projectId,
                projectToken: projectToken,
                appVersion: "2.4.0",
                batchSize: 50,
                debug: false,
                autoFlush: false
            );
            sdk.ClearPendingQueue();
            sdk.ClearSuperProperties();
            sdk.Logout();

            sdk.Identify("visitor_unity_dev_001");
            sdk.Login("role_knight_8888");
            sdk.SetSuperProperties(new Dictionary<string, object?>
            {
                ["channel"] = "TapTap_CN",
                ["server_zone"] = "S101_Avalon"
            });
            sdk.SetDynamicSuperProperties(() => new Dictionary<string, object?>
            {
                ["current_scene"] = "Dungeon_DragonLair",
                ["fps"] = 60
            });

            sdk.TimeEvent("BossDefeated");
            sdk.Track(
                "BossDefeated",
                properties: new Dictionary<string, object?>
                {
                    ["boss_id"] = "boss_ancient_dragon",
                    ["difficulty"] = "Hell",
                    ["battle_snowflake_id"] = 9007199254740993L // > 2^53-1 自动转为字符串 "9007199254740993"
                },
                eventId: "evt_unity_boss_1001"
            );

            sdk.Track(
                "BossLootClaimed",
                properties: new Dictionary<string, object?>
                {
                    ["boss_id"] = "boss_ancient_dragon",
                    ["loot_status"] = "claimed",
                    ["gold_dropped"] = 1500
                },
                eventId: "evt_unity_boss_loot_1001"
            );

            sdk.UserSet(new Dictionary<string, object?>
            {
                ["role_level"] = 65,
                ["vip_tier"] = "Diamond",
                ["guild_name"] = "Starlight"
            });
            sdk.UserSetOnce(new Dictionary<string, object?>
            {
                ["first_install_channel"] = "TapTap_CN"
            });
            sdk.UserAdd(new Dictionary<string, object?>
            {
                ["total_gems"] = 300,
                ["lifetime_iap_cny"] = 68.0
            });
            sdk.UserAppend(new Dictionary<string, object?>
            {
                ["unlocked_mounts"] = new[] { "griffin", "frost_wolf" }
            });
            sdk.UserUniqAppend(new Dictionary<string, object?>
            {
                ["unlocked_mounts"] = new[] { "frost_wolf", "phoenix" }
            });
            sdk.UserUnset("temp_season_buff");
            sdk.UserDelete();

            return sdk.BuildPendingBatchJson(indented: true);
        }

        /// <summary>
        /// 第 2 步：确认提交当前待发请求队列，并在完成后回调 <c>(httpStatusCode, responseBody)</c>。
        /// </summary>
        public static void ConfirmSubmit(Action<int, string>? completion = null)
        {
            AbiUnityAnalytics.Shared.Flush(completion);
        }
    }

    /// <summary>
    /// Unity 游戏场景两步式交互演练脚本（挂载至任意 GameObject 即可运行）：
    /// <para>
    /// 1. <b>配置参数并实时刷新单份待提交请求 JSON</b>：切换玩家身份、修改静态/动态公共属性或选择关卡/充值/画像动作时，
    ///    原地重算并刷新 <see cref="RequestJsonPreview"/> 中的唯一一份 <c>POST /collect/api/v1/track/batch</c> 请求 JSON（不追加刷屏历史日志）；
    /// 2. <b>点击「确认提交」按钮发送</b>：调用 <see cref="ConfirmSubmit"/> 将当前预览报文发送至采集网关，并在 <see cref="ResponseJsonPreview"/> 中展示单次响应结果。
    /// </para>
    /// </summary>
    public sealed class AbiUnityDemoMonoBehaviour
#if UNITY_5_3_OR_NEWER
        : MonoBehaviour
#endif
    {
        private sealed class StagedDraftAction
        {
            public string Label { get; }
            public Action<AbiUnityAnalytics> Apply { get; }

            public StagedDraftAction(string label, Action<AbiUnityAnalytics> apply)
            {
                Label = label;
                Apply = apply;
            }
        }

        /// <summary>采集网关基础地址。</summary>
        public string ServerUrl = "http://127.0.0.1:8081";

        /// <summary>ABI 项目数字 ID。</summary>
        public long ProjectId = 1;

        /// <summary>ABI 项目采集 Token。</summary>
        public string ProjectToken = "abi_tok_unity_demo";

        /// <summary>游戏客户端版本号。</summary>
        public string AppVersion = "2.4.0";

        /// <summary>是否开启多条事件拼批模式（<c>false</c> 时点击事件仅预览当前单条；<c>true</c> 时追加到同一批 <c>events</c> 数组）。</summary>
        public bool AppendBatchMode;

        /// <summary>是否启用动态公共属性（注入当前场景名 <c>current_scene</c>、实时帧率 <c>fps</c> 与动态序号 <c>dyn_sequence</c>）。</summary>
        public bool DynamicSuperEnabled;

        /// <summary>当前生效的静态公共属性渠道名。</summary>
        public string StaticChannel = "TapTap_CN";

        /// <summary>当前生效的静态公共属性区服标识。</summary>
        public string StaticServerZone = "S101_Avalon";

        private readonly AbiUnityAnalytics _sdk = AbiUnityAnalytics.Shared;
        private readonly List<StagedDraftAction> _stagedActions = new List<StagedDraftAction>();
        private int _dynamicSeq = 1;
        private bool _bossTimerRunning;
        private string _lastOrderEventId = "evt_unity_iap_001";

        /// <summary>状态栏 1：当前访客标识（<c>distinct_id</c>）。</summary>
        public string VisitorDistinctId => _sdk.DistinctId;

        /// <summary>状态栏 2：当前登录账号 ID（<c>login_id</c>，未登录时为空字符串）。</summary>
        public string CurrentLoginId => _sdk.LoginId;

        /// <summary>面板 A：当前实时预览的唯一一份待提交 <c>POST /collect/api/v1/track/batch</c> 请求 JSON。</summary>
        public string RequestJsonPreview { get; private set; } = "{}";

        /// <summary>面板 B：最近一次点击「确认提交」后的网关响应结果。</summary>
        public string ResponseJsonPreview { get; private set; } =
            "点击「确认提交」按钮发送上方待提交请求 JSON，此处仅展示最近一次网关响应结果。";

        /// <summary>最近一次提交的状态摘要说明。</summary>
        public string ResponseStatusHint { get; private set; } = "尚未提交";

        /// <summary>是否正在提交请求中。</summary>
        public bool IsSubmitting { get; private set; }

        /// <summary>初始化 SDK（固定 <c>autoFlush: false</c> 以严格由「确认提交」按钮触发发送）并生成默认预览 JSON。</summary>
        public void Start()
        {
            _sdk.Initialize(
                serverUrl: ServerUrl,
                projectId: ProjectId,
                projectToken: ProjectToken,
                appVersion: AppVersion,
                batchSize: 50,
                debug: false,
                autoFlush: false
            );
            _sdk.Logout();
            _sdk.ClearPendingQueue();
            _sdk.ClearSuperProperties();
            _sdk.SetSuperProperties(new Dictionary<string, object?>
            {
                ["channel"] = StaticChannel,
                ["server_zone"] = StaticServerZone
            });

            _stagedActions.Clear();
            _stagedActions.Add(MakeStageCompletedAction());
            RebuildDraftPreview();
        }

        /// <summary>1.1 切换随机访客 ID（<c>identify</c>），纯本地状态修改并原地刷新待提交请求 JSON。</summary>
        public void SwitchVisitorId(string? customDistinctId = null)
        {
            string visitorId = string.IsNullOrWhiteSpace(customDistinctId)
                ? $"visitor_unity_{DateTimeOffset.UtcNow.ToUnixTimeSeconds() % 10000:D4}"
                : customDistinctId!;
            _sdk.Identify(visitorId);
            EnsureDefaultDraftIfEmpty();
            RebuildDraftPreview();
        }

        /// <summary>1.2 设置登录账号（<c>login</c>），纯本地写入 <c>login_id</c>（不覆盖 <c>distinct_id</c>、不产生任何暂存事件），并原地刷新待提交请求 JSON。</summary>
        public void TriggerLogin(string accountId = "role_knight_10001")
        {
            _sdk.Login(accountId);
            EnsureDefaultDraftIfEmpty();
            RebuildDraftPreview();
        }

        /// <summary>1.3 退出登录（<c>logout</c>），仅清空 <c>login_id</c>（保留当前 <c>distinct_id</c>），并原地刷新待提交请求 JSON。</summary>
        public void TriggerLogout()
        {
            _sdk.Logout();
            EnsureDefaultDraftIfEmpty();
            RebuildDraftPreview();
        }

        /// <summary>2.1 应用静态公共属性（<c>channel</c>、<c>server_zone</c>），并原地重算待提交请求 JSON。</summary>
        public void ApplyStaticSuperProperties(string channel, string serverZone)
        {
            StaticChannel = string.IsNullOrWhiteSpace(channel) ? "TapTap_CN" : channel.Trim();
            StaticServerZone = string.IsNullOrWhiteSpace(serverZone) ? "S101_Avalon" : serverZone.Trim();
            _sdk.ClearSuperProperties();
            _sdk.SetSuperProperties(new Dictionary<string, object?>
            {
                ["channel"] = StaticChannel,
                ["server_zone"] = StaticServerZone
            });
            EnsureDefaultDraftIfEmpty();
            RebuildDraftPreview();
        }

        /// <summary>2.2 切换动态公共属性开关，并原地重算待提交请求 JSON。</summary>
        public void ToggleDynamicSuperProperties()
        {
            DynamicSuperEnabled = !DynamicSuperEnabled;
            if (DynamicSuperEnabled)
            {
                _dynamicSeq++;
            }
            EnsureDefaultDraftIfEmpty();
            RebuildDraftPreview();
        }

        /// <summary>2.3 清空所有静态与动态公共属性，并原地重算待提交请求 JSON。</summary>
        public void ClearAllSuperProperties()
        {
            DynamicSuperEnabled = false;
            _sdk.ClearSuperProperties();
            _sdk.SetDynamicSuperProperties(null);
            EnsureDefaultDraftIfEmpty();
            RebuildDraftPreview();
        }

        /// <summary>3.1 暂存关卡完成事件（<c>StageCompleted</c>），原地刷新待提交请求 JSON。</summary>
        public void StageQuestCompleted()
        {
            StageAction(MakeStageCompletedAction());
        }

        /// <summary>3.2 启动 Boss 战秒表计时（<c>TimeEvent("BossDefeated")</c>）。</summary>
        public void StartBossTimer()
        {
            _sdk.TimeEvent("BossDefeated");
            _bossTimerRunning = true;
        }

        /// <summary>3.3 结束计时并暂存 Boss 击败事件（自动计算 <c>$duration</c> 秒数），原地刷新待提交请求 JSON。</summary>
        public void StageBossDefeatedWithDuration()
        {
            bool hadTimer = _bossTimerRunning;
            _bossTimerRunning = false;
            string? cachedId = null;
            double? capturedDuration = null;

            StageAction(new StagedDraftAction("BossDefeated($duration)", client =>
            {
                if (!capturedDuration.HasValue && !hadTimer)
                {
                    client.TimeEvent("BossDefeated");
                }
                var props = new Dictionary<string, object?>
                {
                    ["boss_id"] = "boss_ancient_dragon",
                    ["difficulty"] = "Nightmare",
                    ["party_size"] = 4
                };
                if (capturedDuration.HasValue)
                {
                    props["$duration"] = capturedDuration.Value;
                }
                cachedId = client.Track("BossDefeated", props, eventId: cachedId);
                if (!capturedDuration.HasValue)
                {
                    var payload = client.BuildPendingBatchPayload();
                    if (payload.TryGetValue("events", out object? evObj) &&
                        evObj is List<Dictionary<string, object?>> evList &&
                        evList.Count > 0)
                    {
                        var lastEv = evList[evList.Count - 1];
                        if (lastEv.TryGetValue("properties", out object? pObj) &&
                            pObj is Dictionary<string, object?> pDict &&
                            pDict.TryGetValue("$duration", out object? durObj) &&
                            durObj is double durVal)
                        {
                            capturedDuration = durVal;
                        }
                    }
                }
            }));
        }

        /// <summary>
        /// 3.4 暂存含 64 位雪花订单流水号（<c>&gt; 2^53 - 1</c> 自动转字符串）的内购支付事件（<c>InAppPurchasePaid</c>）。
        /// </summary>
        public void StageSnowflakeIapOrder()
        {
            string? cachedId = null;
            StageAction(new StagedDraftAction("InAppPurchasePaid(BigInt)", client =>
            {
                cachedId = client.Track(
                    "InAppPurchasePaid",
                    new Dictionary<string, object?>
                    {
                        ["order_id"] = "iap_bundle_648",
                        ["snowflake_order_seq"] = 9007199254740993L, // > 2^53-1 自动转为字符串 "9007199254740993"
                        ["amount"] = 648.0,
                        ["currency"] = "CNY"
                    },
                    eventId: cachedId);
                _lastOrderEventId = cachedId;
            }));
        }

        /// <summary>3.5 暂存带固定 <c>event_id</c> 的内购发货履约里程碑事件（<c>InAppPurchaseDelivered</c>）。</summary>
        public void StageOrderDeliveredMilestone()
        {
            StageAction(new StagedDraftAction("InAppPurchaseDelivered(eventId)", client =>
            {
                client.Track("InAppPurchaseDelivered", new Dictionary<string, object?>
                {
                    ["order_id"] = "iap_bundle_648",
                    ["order_status"] = "delivered",
                    ["amount"] = 648.0
                }, eventId: "evt_unity_iap_delivered_001");
            }));
        }

        /// <summary>4.1 暂存玩家画像覆盖设置（<c>UserSet</c> -&gt; <c>$user_set</c>，自动隔离公共属性）。</summary>
        public void StageUserSet()
        {
            StageAction(new StagedDraftAction("UserSet", client =>
            {
                client.UserSet(new Dictionary<string, object?>
                {
                    ["role_level"] = 80,
                    ["vip_tier"] = "Challenger",
                    ["guild_name"] = "Avalon Knights"
                });
            }));
        }

        /// <summary>4.2 暂存玩家画像首次设置（<c>UserSetOnce</c> -&gt; <c>$user_set_once</c>）。</summary>
        public void StageUserSetOnce()
        {
            StageAction(new StagedDraftAction("UserSetOnce", client =>
            {
                client.UserSetOnce(new Dictionary<string, object?>
                {
                    ["first_channel"] = "TapTap_CN"
                });
            }));
        }

        /// <summary>4.3 暂存玩家画像数值原子累加（<c>UserAdd</c> -&gt; <c>$user_add</c>）。</summary>
        public void StageUserAdd()
        {
            StageAction(new StagedDraftAction("UserAdd", client =>
            {
                client.UserAdd(new Dictionary<string, object?>
                {
                    ["gems_balance"] = 6480,
                    ["total_iap_cny"] = 648.0
                });
            }));
        }

        /// <summary>4.4 暂存玩家画像列表追加（<c>UserAppend</c> -&gt; <c>$user_append</c>）。</summary>
        public void StageUserAppend()
        {
            StageAction(new StagedDraftAction("UserAppend", client =>
            {
                client.UserAppend(new Dictionary<string, object?>
                {
                    ["owned_skins"] = new[] { "dragon_slayer", "star_guardian" }
                });
            }));
        }

        /// <summary>4.5 暂存玩家画像列表去重追加（<c>UserUniqAppend</c> -&gt; <c>$user_uniq_append</c>）。</summary>
        public void StageUserUniqAppend()
        {
            StageAction(new StagedDraftAction("UserUniqAppend", client =>
            {
                client.UserUniqAppend(new Dictionary<string, object?>
                {
                    ["owned_skins"] = new[] { "star_guardian", "cyber_knight" }
                });
            }));
        }

        /// <summary>4.6 暂存玩家画像属性清空（<c>UserUnset</c> -&gt; <c>$user_unset</c>）。</summary>
        public void StageUserUnset()
        {
            StageAction(new StagedDraftAction("UserUnset", client =>
            {
                client.UserUnset("novice_protection_buff");
            }));
        }

        /// <summary>4.7 暂存玩家画像删除（<c>UserDelete</c> -&gt; <c>$user_del</c>）。</summary>
        public void StageUserDelete()
        {
            StageAction(new StagedDraftAction("UserDelete", client =>
            {
                client.UserDelete();
            }));
        }

        /// <summary>重置当前暂存参数为初始默认关卡事件，并刷新待提交请求 JSON 预览。</summary>
        public void ResetDraft()
        {
            _bossTimerRunning = false;
            _stagedActions.Clear();
            _stagedActions.Add(MakeStageCompletedAction());
            RebuildDraftPreview();
        }

        /// <summary>
        /// 第 2 步：点击「确认提交」按钮后调用，将当前待提交队列中的报文发送至采集网关，
        /// 并在 <see cref="ResponseJsonPreview"/> 中更新单次响应结果。
        /// </summary>
        public void ConfirmSubmit(Action<int, string>? onCompleted = null)
        {
            int countToSubmit = _sdk.PendingQueueCount;
            if (IsSubmitting || countToSubmit == 0)
            {
                return;
            }

            IsSubmitting = true;
            ResponseStatusHint = "正在提交...";

            _sdk.Flush((statusCode, rawBody) =>
            {
                int remaining = _sdk.PendingQueueCount;
                bool succeeded = statusCode >= 200 && statusCode <= 299 && remaining == 0;
                IsSubmitting = false;

                if (succeeded)
                {
                    if (DynamicSuperEnabled)
                    {
                        _dynamicSeq++;
                    }
                    _stagedActions.Clear();
                    RebuildDraftPreview();
                    ResponseStatusHint = $"HTTP {statusCode} OK · 已确认提交 {countToSubmit} 条事件";
                    ResponseJsonPreview = string.IsNullOrWhiteSpace(rawBody)
                        ? $"{{\n  \"code\": 200,\n  \"message\": \"success\",\n  \"submitted_events\": {countToSubmit}\n}}"
                        : rawBody;
                }
                else
                {
                    string statusLabel = statusCode == 0 ? "网关未连接" : $"HTTP {statusCode}";
                    ResponseStatusHint = $"{statusLabel} · 队列保留 {remaining} 条待幂等重试";
                    ResponseJsonPreview =
                        $"提交未完成（{statusLabel}）：\n{rawBody}\n说明：SDK 已在队列中保留原始 event_id 供下次重试。";
                }

                onCompleted?.Invoke(statusCode, ResponseJsonPreview);
            });
        }

        private StagedDraftAction MakeStageCompletedAction()
        {
            string? cachedId = null;
            return new StagedDraftAction("StageCompleted", client =>
            {
                cachedId = client.Track(
                    "StageCompleted",
                    new Dictionary<string, object?>
                    {
                        ["stage_id"] = "chapter_03_stage_08",
                        ["stage_name"] = "阿瓦隆圣殿保卫战",
                        ["star_rating"] = 3,
                        ["is_first_clear"] = true
                    },
                    eventId: cachedId);
            });
        }

        private void EnsureDefaultDraftIfEmpty()
        {
            if (_stagedActions.Count == 0)
            {
                _stagedActions.Add(MakeStageCompletedAction());
            }
        }

        private void StageAction(StagedDraftAction action)
        {
            if (AppendBatchMode)
            {
                _stagedActions.Add(action);
            }
            else
            {
                _stagedActions.Clear();
                _stagedActions.Add(action);
            }
            RebuildDraftPreview();
        }

        private void RebuildDraftPreview()
        {
            _sdk.ClearPendingQueue();
            if (DynamicSuperEnabled)
            {
                int seqSnapshot = _dynamicSeq;
                _sdk.SetDynamicSuperProperties(() => new Dictionary<string, object?>
                {
                    ["current_scene"] = "Dungeon_DragonLair",
                    ["fps"] = 60,
                    ["dyn_sequence"] = seqSnapshot
                });
            }
            else
            {
                _sdk.SetDynamicSuperProperties(null);
            }

            foreach (var action in _stagedActions)
            {
                action.Apply(_sdk);
            }

            RequestJsonPreview = _sdk.BuildPendingBatchJson(indented: true);
        }
    }
}
