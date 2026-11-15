using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.IO.Compression;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Text;
using System.Text.RegularExpressions;
#if UNITY_5_3_OR_NEWER
using UnityEngine;
using UnityEngine.Networking;
#endif

namespace Abi.GameEngines.Unity
{
    /// <summary>
    /// ABI Unity 游戏引擎客户端数据采集 SDK（对标数数科技 ThinkingData Unity SDK v3.4 <c>TDAnalytics</c> / <c>ThinkingAnalyticsAPI</c>）。
    /// <para>
    /// 核心能力：
    /// <list type="bullet">
    ///   <item><description>自动生成并持久化设备访客标识 <c>distinct_id</c> 与登录账号标识 <c>login_id</c>（<see cref="Identify"/> / <see cref="Login"/> / <see cref="Logout"/>，纯本地状态切换，零网络副作用）；</description></item>
    ///   <item><description>支持 <c>autoFlush = false</c> + <see cref="BuildPendingBatchJson"/> + <see cref="Flush"/> 两步式「1. 预览单份请求 JSON -&gt; 2. 确认提交」工作流；</description></item>
    ///   <item><description>内置高精度关卡/战斗秒表计时器 <see cref="TimeEvent"/>（自动计算秒级 <c>$duration</c>）；</description></item>
    ///   <item><description>支持全局静态公共属性（<see cref="SetSuperProperties"/>）与动态公共属性回调（<see cref="SetDynamicSuperProperties"/>）；</description></item>
    ///   <item><description>支持同日固定 <c>eventId</c> 幂等重放（<see cref="Track"/>）；<c>TrackFirst</c> / <c>TrackUpdate</c> / <c>TrackOverwrite</c> 当前版本未开放（D7① / G6 门禁），调用时显式抛出 <see cref="NotSupportedException"/> 且绝不静默降级为普通事件；</description></item>
    ///   <item><description>支持全部 7 类 <c>$user_*</c> 玩家画像操作，并自动隔离公共属性与设备预置属性；</description></item>
    ///   <item><description>自动将超出 IEEE-754 安全整数范围（<c>&gt; 2^53 - 1 = 9007199254740991</c>）的 64 位 <c>long</c>（如雪花战斗流水号、道具唯一 UID）转为十进制字符串；</description></item>
    ///   <item><description>自动提取 <c>properties["#time"]</c> 或 <c>properties["$time"]</c> 为顶层毫秒 <c>timestamp</c> 并从 <c>properties</c> 中剥离。</description></item>
    /// </list>
    /// </para>
    /// </summary>
    public sealed class AbiUnityAnalytics
    {
        /// <summary>全局共享单例实例。</summary>
        public static AbiUnityAnalytics Shared { get; } = new AbiUnityAnalytics();

        /// <summary><c>distinct_id</c> 最大 UTF-8 字节长度（64 字节）。</summary>
        public const int MaxDistinctIdBytes = 64;

        /// <summary><c>login_id</c> 最大 UTF-8 字节长度（128 字节）。</summary>
        public const int MaxLoginIdBytes = 128;

        /// <summary><c>event_id</c> 最大 UTF-8 字节长度（64 字节）。</summary>
        public const int MaxEventIdBytes = 64;

        /// <summary>事件名称最大字符长度（128 字符）。</summary>
        public const int MaxEventNameChars = 128;

        /// <summary>自定义属性名最大字符长度（64 字符）。</summary>
        public const int MaxCustomKeyChars = 64;

        /// <summary>IEEE-754 双精度浮点数最大安全整数（<c>2^53 - 1 = 9007199254740991</c>）。</summary>
        public const long MaxSafeInteger = 9007199254740991L;

        /// <summary>区分秒级与毫秒级正整数时间戳的阈值（<c>10^11</c>）。</summary>
        public const long SecondsTimestampUpperBound = 100_000_000_000L;

        /// <summary>Unity 客户端 SDK 标识。</summary>
        public const string LibName = "abi-unity-sdk";

        /// <summary>Unity 客户端 SDK 版本号。</summary>
        public const string LibVersion = "1.0.0";

        private const string PrefsDistinctIdKey = "abi_unity_sdk_distinct_id";
        private const string PrefsLoginIdKey = "abi_unity_sdk_login_id";

        private static readonly Regex IdentifierRegex = new Regex(
            "^[A-Za-z_][A-Za-z0-9_]*$",
            RegexOptions.Compiled | RegexOptions.CultureInvariant);

        private static readonly HashSet<string> SystemEvents = new HashSet<string>(StringComparer.Ordinal)
        {
            "$signup", "$login", "$pageview",
            "$AppStart", "$AppEnd", "$AppClick", "$AppViewScreen",
            "$user_set", "#user_set",
            "$user_set_once", "#user_set_once",
            "$user_add", "#user_add",
            "$user_unset", "#user_unset",
            "$user_append", "#user_append",
            "$user_uniq_append", "#user_uniq_append",
            "$user_del", "#user_del"
        };

        private static readonly HashSet<string> SystemProps = new HashSet<string>(StringComparer.Ordinal)
        {
            "$os", "#os", "os",
            "$os_version", "#os_version", "os_version",
            "$app_version", "#app_version", "app_version",
            "$browser", "#browser", "browser",
            "$browser_version", "#browser_version", "browser_version",
            "$city", "#city", "city",
            "$province", "#province", "province",
            "$country", "#country", "country",
            "$country_code", "#country_code", "country_code",
            "$ip", "#ip", "ip",
            "$network", "#network", "network",
            "$network_type", "#network_type", "network_type",
            "$platform", "#platform", "platform",
            "$device_id", "#device_id", "device_id",
            "$session_id", "#session_id", "session_id",
            "$screen_width", "#screen_width", "screen_width",
            "$screen_height", "#screen_height", "screen_height",
            "$model", "#model", "model",
            "$device_model", "#device_model", "device_model",
            "$manufacturer", "#manufacturer", "manufacturer",
            "$carrier", "#carrier", "carrier",
            "$url", "#url", "url",
            "$url_path", "#url_path", "url_path",
            "$referrer", "#referrer", "referrer",
            "$title", "#title", "title",
            "$duration", "#duration", "duration",
            "$lib", "#lib", "lib",
            "$lib_version", "#lib_version", "lib_version",
            "$zone_offset", "#zone_offset", "zone_offset",
            "$first_check_id", "#first_check_id", "first_check_id"
        };

        private static readonly HttpClient SharedHttpClient = new HttpClient
        {
            Timeout = TimeSpan.FromSeconds(8)
        };

        private readonly object _lock = new object();
        private readonly Dictionary<string, object?> _superProperties = new Dictionary<string, object?>(StringComparer.Ordinal);
        private readonly Dictionary<string, long> _eventTimersStopwatchTicks = new Dictionary<string, long>(StringComparer.Ordinal);
        private readonly List<Dictionary<string, object?>> _eventQueue = new List<Dictionary<string, object?>>();

        private string _serverUrl = "http://127.0.0.1:8081";
        private long _projectId = 1;
        private string _projectToken = string.Empty;
        private string _appVersion = "1.0.0";
        private int _batchSize = 20;
        private bool _debug;
        private bool _dryRun;
        private bool _autoFlush = true;
        private bool _compressGzip;
        private bool _isFlushing;

        private string _distinctId = Guid.NewGuid().ToString("D");
        private string _loginId = string.Empty;
        private Func<IDictionary<string, object?>>? _dynamicSuperPropsProvider;

        /// <summary>获取当前设备访客标识 <c>distinct_id</c>（客户端与服务端协同时可通过请求头 <c>X-ABI-Distinct-Id</c> 透传给游戏服）。</summary>
        public string DistinctId
        {
            get
            {
                lock (_lock)
                {
                    return _distinctId;
                }
            }
        }

        /// <summary>获取当前已设置的登录账号/角色标识 <c>login_id</c>（未登录时为空字符串）。</summary>
        public string LoginId
        {
            get
            {
                lock (_lock)
                {
                    return _loginId;
                }
            }
        }

        /// <summary>获取内存队列中尚未上报的事件条数。</summary>
        public int PendingQueueCount
        {
            get
            {
                lock (_lock)
                {
                    return _eventQueue.Count;
                }
            }
        }

        /// <summary>创建独立的 <see cref="AbiUnityAnalytics"/> 客户端实例（常规场景推荐使用 <see cref="Shared"/> 单例）。</summary>
        public AbiUnityAnalytics()
        {
            LoadPersistedIdentity();
        }

        /// <summary>
        /// 初始化配置 Unity 客户端 SDK。
        /// <para>
        /// 当 <paramref name="autoFlush"/> 设为 <c>false</c> 时，所有埋点事件仅保存在内存队列中，方便调用
        /// <see cref="BuildPendingBatchJson"/> 预览完整请求 JSON，再由开发者调用 <see cref="Flush"/> 确认提交。
        /// </para>
        /// </summary>
        /// <param name="serverUrl">采集网关基础地址（如 <c>http://127.0.0.1:8081</c>）。</param>
        /// <param name="projectId">ABI 项目数字 ID（必须 <c>&gt; 0</c>）。</param>
        /// <param name="projectToken">ABI 项目采集鉴权 Token。</param>
        /// <param name="appVersion">游戏客户端版本号（如 <c>"1.4.2"</c>，自动注入 <c>$app_version</c>）。</param>
        /// <param name="batchSize">单批自动触发上报阈值（默认 20，范围 1~500）。</param>
        /// <param name="debug">是否开启网关 L4 严格调试校验（<c>"debug": true</c>）。</param>
        /// <param name="autoFlush">是否开启定量自动刷新（两步式预览模式请传 <c>false</c>）。</param>
        /// <param name="dryRun">是否开启网关零污染预检模式（<c>"dry_run": true</c>）。</param>
        /// <param name="compressGzip">是否启用 Gzip 请求体压缩。</param>
        public void Initialize(
            string serverUrl,
            long projectId,
            string projectToken,
            string appVersion = "1.0.0",
            int batchSize = 20,
            bool debug = false,
            bool autoFlush = true,
            bool dryRun = false,
            bool compressGzip = false)
        {
            if (projectId <= 0)
            {
                throw new ArgumentException("projectId must be > 0", nameof(projectId));
            }
            if (string.IsNullOrWhiteSpace(projectToken))
            {
                throw new ArgumentException("projectToken must not be empty", nameof(projectToken));
            }

            lock (_lock)
            {
                _serverUrl = string.IsNullOrWhiteSpace(serverUrl)
                    ? "http://127.0.0.1:8081"
                    : serverUrl.Trim().TrimEnd('/');
                _projectId = projectId;
                _projectToken = projectToken.Trim();
                _appVersion = string.IsNullOrWhiteSpace(appVersion) ? "1.0.0" : appVersion.Trim();
                _batchSize = Math.Clamp(batchSize, 1, 500);
                _debug = debug;
                _autoFlush = autoFlush;
                _dryRun = dryRun;
                _compressGzip = compressGzip;
            }
        }

        /// <summary>
        /// 自定义设置设备/访客标识 <c>distinct_id</c>（UTF-8 字节长度 ≤ 64 字节），自动持久化至本地 <c>PlayerPrefs</c>，不触发任何网络事件。
        /// </summary>
        public void Identify(string distinctId)
        {
            string norm = NormalizeIdentity(distinctId, MaxDistinctIdBytes, "distinct_id");
            if (string.IsNullOrEmpty(norm))
            {
                throw new ArgumentException("distinct_id must not be empty", nameof(distinctId));
            }

            lock (_lock)
            {
                _distinctId = norm;
                SavePersistedIdentity(_distinctId, _loginId);
            }
        }

        /// <summary>
        /// 设置玩家实名账号或角色标识 <c>login_id</c>（UTF-8 字节长度 ≤ 128 字节），持久化至本地；不会覆盖 <c>distinct_id</c>，也不会触发任何网络事件。
        /// </summary>
        /// <param name="accountId">玩家登录账号 ID。</param>
        public void Login(string accountId)
        {
            string normLogin = NormalizeIdentity(accountId, MaxLoginIdBytes, "login_id");
            if (string.IsNullOrEmpty(normLogin))
            {
                throw new ArgumentException("login_id must not be empty", nameof(accountId));
            }

            lock (_lock)
            {
                _loginId = normLogin;
                SavePersistedIdentity(_distinctId, _loginId);
            }
        }

        /// <summary>
        /// 玩家退出登录，仅清空本地 <c>login_id</c>，保持当前 <c>distinct_id</c> 不变，不触发任何网络事件。
        /// </summary>
        public void Logout()
        {
            lock (_lock)
            {
                _loginId = string.Empty;
                SavePersistedIdentity(_distinctId, _loginId);
            }
        }

        /// <summary>
        /// 注册全局静态公共属性（如渠道包名 <c>channel</c>、区服 ID <c>server_zone_id</c>），
        /// 自动合并至后续所有非 <c>$user_*</c> 画像事件中。
        /// </summary>
        public void SetSuperProperties(IDictionary<string, object?> properties)
        {
            if (properties is null) return;
            var sanitized = SanitizeProperties(properties);
            lock (_lock)
            {
                foreach (var kvp in sanitized)
                {
                    _superProperties[kvp.Key] = kvp.Value;
                }
            }
        }

        /// <summary>移除单个已注册的全局静态公共属性。</summary>
        public void UnsetSuperProperty(string key)
        {
            if (string.IsNullOrWhiteSpace(key)) return;
            lock (_lock)
            {
                _superProperties.Remove(key.Trim());
            }
        }

        /// <summary>清空全部已注册的全局静态公共属性。</summary>
        public void ClearSuperProperties()
        {
            lock (_lock)
            {
                _superProperties.Clear();
            }
        }

        /// <summary>获取当前全局静态公共属性的浅拷贝快照。</summary>
        public Dictionary<string, object?> GetSuperProperties()
        {
            lock (_lock)
            {
                return new Dictionary<string, object?>(_superProperties, StringComparer.Ordinal);
            }
        }

        /// <summary>
        /// 注册动态公共属性回调委托（如实时帧率 <c>fps</c>、当前所在地图场景 <c>scene_name</c>、当前网络延迟 <c>ping_ms</c>）。
        /// 每次调用 <see cref="Track"/> 上报非 <c>$user_*</c> 事件时实时求值合并。
        /// </summary>
        public void SetDynamicSuperProperties(Func<IDictionary<string, object?>>? provider)
        {
            lock (_lock)
            {
                _dynamicSuperPropsProvider = provider;
            }
        }

        /// <summary>
        /// 为指定事件启动高精度秒表计时器（基于 <see cref="Stopwatch.GetTimestamp"/>）；
        /// 下一次调用 <see cref="Track"/> 上报同名事件时自动计算秒级耗时并注入 <c>$duration</c> 属性（保留 3 位小数）。
        /// </summary>
        public void TimeEvent(string eventName)
        {
            string normEvent = ValidateEventName(eventName);
            lock (_lock)
            {
                _eventTimersStopwatchTicks[normEvent] = Stopwatch.GetTimestamp();
            }
        }

        /// <summary>
        /// 采集并入队一条游戏行为事件或系统保留事件，返回幂等主键 <c>event_id</c>。
        /// <para>
        /// 支持：
        /// <list type="bullet">
        ///   <item><description>自动注入客户端设备环境预置属性（<c>$lib</c>、<c>$lib_version</c>、<c>$os</c>、<c>$os_version</c>、<c>$app_version</c>、<c>$device_model</c>、<c>$screen_width</c>、<c>$screen_height</c>、<c>$platform</c>）；</description></item>
        ///   <item><description>若 <paramref name="properties"/> 中包含 <c>"#time"</c> 或 <c>"$time"</c>，自动提取为顶层毫秒 <c>timestamp</c> 并从 <c>properties</c> 中剥离；</description></item>
        ///   <item><description>绝对值超过 <c>2^53 - 1</c>（<c>9007199254740991</c>）的 <c>long</c> / <c>ulong</c> 自动转换为十进制字符串。</description></item>
        /// </list>
        /// </para>
        /// </summary>
        public string Track(
            string eventName,
            IDictionary<string, object?>? properties = null,
            string? eventId = null,
            DateTimeOffset? timestamp = null)
        {
            string normEvent = ValidateEventName(eventName);
            bool isUserEvent = normEvent.StartsWith("$user_", StringComparison.Ordinal) ||
                               normEvent.StartsWith("#user_", StringComparison.Ordinal);

            string resolvedEventId = !string.IsNullOrWhiteSpace(eventId)
                ? NormalizeIdentity(eventId!, MaxEventIdBytes, "event_id")
                : Guid.NewGuid().ToString("D");

            long? extractedTimeMs = null;
            Dictionary<string, object?>? filteredProps = null;
            if (properties is not null && properties.Count > 0)
            {
                filteredProps = new Dictionary<string, object?>(properties.Count, StringComparer.Ordinal);
                bool hasHashTime = false;
                foreach (var kvp in properties)
                {
                    string trimmedKey = (kvp.Key ?? string.Empty).Trim();
                    if (string.Equals(trimmedKey, "#time", StringComparison.Ordinal))
                    {
                        extractedTimeMs = ParseTimePropertyMs("#time", kvp.Value);
                        hasHashTime = true;
                    }
                    else if (string.Equals(trimmedKey, "$time", StringComparison.Ordinal))
                    {
                        long dollarMs = ParseTimePropertyMs("$time", kvp.Value);
                        if (!hasHashTime)
                        {
                            extractedTimeMs = dollarMs;
                        }
                    }
                    else
                    {
                        filteredProps[kvp.Key!] = kvp.Value;
                    }
                }
            }

            long resolvedTimestampMs;
            if (timestamp.HasValue)
            {
                resolvedTimestampMs = timestamp.Value.ToUnixTimeMilliseconds();
                if (resolvedTimestampMs <= 0)
                {
                    throw new ArgumentException("timestamp must be positive epoch milliseconds");
                }
            }
            else if (extractedTimeMs.HasValue)
            {
                resolvedTimestampMs = extractedTimeMs.Value;
            }
            else
            {
                resolvedTimestampMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            }

            var sanitizedCustomProps = SanitizeProperties(filteredProps);

            Func<IDictionary<string, object?>>? dynProvider = null;
            if (!isUserEvent)
            {
                lock (_lock)
                {
                    dynProvider = _dynamicSuperPropsProvider;
                }
            }

            Dictionary<string, object?>? sanitizedDynProps = null;
            if (dynProvider is not null)
            {
                var rawDyn = dynProvider();
                if (rawDyn is not null && rawDyn.Count > 0)
                {
                    var cleanDyn = new Dictionary<string, object?>(StringComparer.Ordinal);
                    foreach (var kvp in rawDyn)
                    {
                        string tk = (kvp.Key ?? string.Empty).Trim();
                        if (tk is "#time" or "$time") continue;
                        cleanDyn[kvp.Key!] = kvp.Value;
                    }
                    sanitizedDynProps = SanitizeProperties(cleanDyn);
                }
            }

            bool shouldFlush;
            lock (_lock)
            {
                var merged = isUserEvent
                    ? new Dictionary<string, object?>(StringComparer.Ordinal)
                    : CollectClientPresetProperties(_appVersion);

                if (!isUserEvent)
                {
                    foreach (var kvp in _superProperties)
                    {
                        merged[kvp.Key] = kvp.Value;
                    }
                    if (sanitizedDynProps is not null)
                    {
                        foreach (var kvp in sanitizedDynProps)
                        {
                            merged[kvp.Key] = kvp.Value;
                        }
                    }
                }

                if (_eventTimersStopwatchTicks.TryGetValue(normEvent, out long startTicks))
                {
                    _eventTimersStopwatchTicks.Remove(normEvent);
                    double elapsedSeconds = Math.Max(0.0, (double)(Stopwatch.GetTimestamp() - startTicks) / Stopwatch.Frequency);
                    merged["$duration"] = Math.Round(elapsedSeconds, 3, MidpointRounding.AwayFromZero);
                }

                foreach (var kvp in sanitizedCustomProps)
                {
                    merged[kvp.Key] = kvp.Value;
                }

                var record = new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["event_id"] = resolvedEventId,
                    ["event_name"] = normEvent,
                    ["distinct_id"] = _distinctId
                };
                if (!string.IsNullOrEmpty(_loginId))
                {
                    record["login_id"] = _loginId;
                }
                record["timestamp"] = resolvedTimestampMs;
                record["properties"] = merged;

                _eventQueue.Add(record);
                shouldFlush = _autoFlush && (_eventQueue.Count >= _batchSize || _debug);
            }

            if (shouldFlush)
            {
                Flush();
            }

            return resolvedEventId;
        }

        /// <summary>
        /// 首次事件上报接口（当前版本未开放）。
        /// <para><strong>[当前版本未开放 / Unsupported in current version]</strong> 详见 RESTFUL_API.md §3.3 (D7① / G6 gate)。严禁静默降级为普通 <c>Track</c> 事件；同日网络重试幂等请调用 <see cref="Track"/> 传入固定 <c>eventId</c>。</para>
        /// </summary>
        [Obsolete("当前版本未开放 (RESTFUL_API.md §3.3 D7① / G6 gate)，调用将抛出 NotSupportedException。同日重试幂等请使用 Track(..., eventId: ...)。")]
        public string TrackFirst(
            string eventName,
            string firstCheckId,
            IDictionary<string, object?>? properties = null)
        {
            throw new NotSupportedException(
                "TrackFirst is unsupported in current version (RESTFUL_API.md §3.3 D7① / G6 gate); use Track(..., eventId: ...) for same-day retry idempotency");
        }

        /// <summary>
        /// 可修改事件局部更新接口（当前版本未开放）。
        /// <para><strong>[当前版本未开放 / Unsupported in current version]</strong> 详见 RESTFUL_API.md §3.3 (D7① / G6 gate)。严禁静默发送普通 <c>Track</c> 覆盖整行属性。</para>
        /// </summary>
        [Obsolete("当前版本未开放 (RESTFUL_API.md §3.3 D7① / G6 gate)，调用将抛出 NotSupportedException。")]
        public string TrackUpdate(string eventName, string eventId, IDictionary<string, object?> properties)
        {
            throw new NotSupportedException(
                "TrackUpdate is unsupported in current version (RESTFUL_API.md §3.3 D7① / G6 gate); emit distinct milestone events via Track(...) instead");
        }

        /// <summary>
        /// 可修改事件整行覆盖重写接口（当前版本未开放）。
        /// <para><strong>[当前版本未开放 / Unsupported in current version]</strong> 详见 RESTFUL_API.md §3.3 (D7① / G6 gate)。严禁静默发送普通 <c>Track</c> 产生跨天重复行。</para>
        /// </summary>
        [Obsolete("当前版本未开放 (RESTFUL_API.md §3.3 D7① / G6 gate)，调用将抛出 NotSupportedException。")]
        public string TrackOverwrite(string eventName, string eventId, IDictionary<string, object?> properties)
        {
            throw new NotSupportedException(
                "TrackOverwrite is unsupported in current version (RESTFUL_API.md §3.3 D7① / G6 gate); emit distinct milestone events via Track(...) instead");
        }

        /// <summary>覆盖设置玩家画像属性（上报 <c>$user_set</c>，自动隔离公共属性与设备环境属性）。</summary>
        public string UserSet(IDictionary<string, object?> properties) => Track("$user_set", properties);

        /// <summary>首次设置玩家画像属性（上报 <c>$user_set_once</c>，适用于首登渠道、创角职业等不可变属性）。</summary>
        public string UserSetOnce(IDictionary<string, object?> properties) => Track("$user_set_once", properties);

        /// <summary>原子累加数值型玩家画像属性（上报 <c>$user_add</c>，如累计充值金额、宝石余量变动）。</summary>
        public string UserAdd(IDictionary<string, object?> properties)
        {
            if (properties is null || properties.Count == 0)
            {
                throw new ArgumentException("UserAdd requires non-empty numeric properties", nameof(properties));
            }
            foreach (var kvp in properties)
            {
                string tk = (kvp.Key ?? string.Empty).Trim();
                if (tk is "#time" or "$time") continue;
                if (kvp.Value is not (sbyte or byte or short or ushort or int or uint or long or ulong or float or double or decimal))
                {
                    throw new ArgumentException($"UserAdd property \"{kvp.Key}\" must be numeric");
                }
            }
            return Track("$user_add", properties);
        }

        /// <summary>清空指定的玩家画像属性键列表（上报 <c>$user_unset</c>，键值填充 <c>0</c> 占位）。</summary>
        public string UserUnset(params string[] keys)
        {
            if (keys is null || keys.Length == 0)
            {
                throw new ArgumentException("UserUnset requires at least one key", nameof(keys));
            }
            var props = new Dictionary<string, object?>(keys.Length, StringComparer.Ordinal);
            foreach (string key in keys)
            {
                props[ValidatePropertyKey(key)] = 0;
            }
            return Track("$user_unset", props);
        }

        /// <summary>向列表类型的玩家画像属性末尾追加元素（上报 <c>$user_append</c>）。</summary>
        public string UserAppend(IDictionary<string, object?> properties)
        {
            ValidateListProfileProps("$user_append", properties);
            return Track("$user_append", properties);
        }

        /// <summary>向列表类型的玩家画像属性去重追加元素（上报 <c>$user_uniq_append</c>，如已解锁成就、拥有皮肤列表）。</summary>
        public string UserUniqAppend(IDictionary<string, object?> properties)
        {
            ValidateListProfileProps("$user_uniq_append", properties);
            return Track("$user_uniq_append", properties);
        }

        /// <summary>标记删除当前玩家的画像记录（上报 <c>$user_del</c>）。</summary>
        public string UserDelete() => Track("$user_del");

        /// <summary>清空内存缓冲队列中尚未提交的所有事件。</summary>
        public void ClearPendingQueue()
        {
            lock (_lock)
            {
                _eventQueue.Clear();
            }
        }

        /// <summary>
        /// 构造当前待提交给 <c>POST /collect/api/v1/track/batch</c> 的完整请求体字典
        /// （不清空队列，也不发起网络请求）。
        /// </summary>
        public Dictionary<string, object?> BuildPendingBatchPayload()
        {
            lock (_lock)
            {
                var eventsCopy = new List<Dictionary<string, object?>>(_eventQueue.Count);
                foreach (var item in _eventQueue)
                {
                    eventsCopy.Add(CloneRecord(item));
                }

                var payload = new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["project_id"] = _projectId,
                    ["project_token"] = _projectToken,
                    ["debug"] = _debug,
                    ["dry_run"] = _dryRun,
                    ["events"] = eventsCopy
                };
                return payload;
            }
        }

        /// <summary>
        /// 第 1 步预览：生成当前待提交给 <c>POST /collect/api/v1/track/batch</c> 的完整请求 JSON 字符串（支持格式化缩进，零网络副作用）。
        /// </summary>
        /// <param name="indented">是否输出带 2 空格缩进的可读 JSON（默认 <c>true</c>）。</param>
        public string BuildPendingBatchJson(bool indented = true)
        {
            var payload = BuildPendingBatchPayload();
            return SimpleJsonFormatter.Serialize(payload, indented);
        }

        /// <summary>
        /// 第 2 步确认提交：将内存队列中的待发事件分批发送至采集网关 <c>/collect/api/v1/track/batch</c>。
        /// 遇到断网、HTTP 429 限流或 5xx 服务端异常时会自动保留原始队列及 <c>event_id</c> 供下次幂等重试。
        /// </summary>
        /// <param name="completion">可选回调 <c>(httpStatusCode, responseBody)</c>。</param>
        public void Flush(Action<int, string>? completion = null)
        {
            List<Dictionary<string, object?>> batch;
            HashSet<string> sentIds;
            string endpointUrl;
            Dictionary<string, object?> payload;
            bool compressGzip;

            lock (_lock)
            {
                if (_eventQueue.Count == 0)
                {
                    completion?.Invoke(200, "{\"code\":200,\"message\":\"当前无待提交事件\"}");
                    return;
                }
                if (_isFlushing)
                {
                    return;
                }
                _isFlushing = true;

                int count = Math.Min(_batchSize, _eventQueue.Count);
                batch = new List<Dictionary<string, object?>>(count);
                sentIds = new HashSet<string>(StringComparer.Ordinal);
                for (int i = 0; i < count; i++)
                {
                    var clone = CloneRecord(_eventQueue[i]);
                    batch.Add(clone);
                    if (clone.TryGetValue("event_id", out object? idObj) && idObj is string idStr)
                    {
                        sentIds.Add(idStr);
                    }
                }

                endpointUrl = _serverUrl.EndsWith("/collect/api/v1/track/batch", StringComparison.OrdinalIgnoreCase)
                    ? _serverUrl
                    : $"{_serverUrl}/collect/api/v1/track/batch";
                payload = new Dictionary<string, object?>(StringComparer.Ordinal)
                {
                    ["project_id"] = _projectId,
                    ["project_token"] = _projectToken,
                    ["debug"] = _debug,
                    ["dry_run"] = _dryRun,
                    ["events"] = batch
                };
                compressGzip = _compressGzip;
            }

            string jsonBody = SimpleJsonFormatter.Serialize(payload, indented: false);
            PostBatchAsync(endpointUrl, jsonBody, compressGzip, (statusCode, responseText) =>
            {
                bool hasMore;
                lock (_lock)
                {
                    bool shouldRemove = (statusCode >= 200 && statusCode <= 299) ||
                                        (statusCode >= 400 && statusCode <= 499 && statusCode != 429);
                    if (shouldRemove)
                    {
                        _eventQueue.RemoveAll(item =>
                            item.TryGetValue("event_id", out object? id) &&
                            id is string s &&
                            sentIds.Contains(s));
                    }
                    _isFlushing = false;
                    hasMore = shouldRemove && _eventQueue.Count > 0;
                }

                if (hasMore)
                {
                    Flush(completion);
                }
                else
                {
                    completion?.Invoke(statusCode, responseText);
                }
            });
        }

        /// <summary>校验并归一化身份标识字段。</summary>
        public static string NormalizeIdentity(string? raw, int maxBytes, string fieldName)
        {
            if (string.IsNullOrEmpty(raw))
            {
                return string.Empty;
            }

            for (int i = 0; i < raw.Length; i++)
            {
                char c = raw[i];
                if (char.IsHighSurrogate(c))
                {
                    if (i + 1 >= raw.Length || !char.IsLowSurrogate(raw[i + 1]))
                    {
                        throw new ArgumentException($"{fieldName} contains unpaired high surrogate");
                    }
                    i++;
                    continue;
                }
                if (char.IsLowSurrogate(c))
                {
                    throw new ArgumentException($"{fieldName} contains unpaired low surrogate");
                }
                if ((c < 0x20 && (c < 0x09 || c > 0x0D)) || c == 0x7F)
                {
                    throw new ArgumentException($"{fieldName} contains control character U+{(int)c:X4}");
                }
            }

            int start = 0;
            int end = raw.Length - 1;
            while (start <= end && IsUnicodeWhitespace(raw[start])) start++;
            while (end >= start && IsUnicodeWhitespace(raw[end])) end--;

            string trimmed = start > end ? string.Empty : raw.Substring(start, end - start + 1);
            int utf8Len = Encoding.UTF8.GetByteCount(trimmed);
            if (utf8Len > maxBytes)
            {
                throw new ArgumentException($"{fieldName} exceeds max {maxBytes} UTF-8 bytes (got {utf8Len})");
            }
            return trimmed;
        }

        /// <summary>校验事件名称。</summary>
        public static string ValidateEventName(string? raw)
        {
            string trimmed = (raw ?? string.Empty).Trim();
            if (string.IsNullOrEmpty(trimmed) || trimmed.Length > MaxEventNameChars)
            {
                throw new ArgumentException("invalid event_name");
            }
            if (SystemEvents.Contains(trimmed))
            {
                return trimmed;
            }
            if (!IdentifierRegex.IsMatch(trimmed))
            {
                throw new ArgumentException($"invalid event_name \"{trimmed}\"");
            }
            return trimmed;
        }

        /// <summary>校验属性键名。</summary>
        public static string ValidatePropertyKey(string? raw)
        {
            string trimmed = (raw ?? string.Empty).Trim();
            if (string.IsNullOrEmpty(trimmed))
            {
                throw new ArgumentException("empty property key");
            }
            if (SystemProps.Contains(trimmed))
            {
                return trimmed;
            }
            if (trimmed.Length > MaxCustomKeyChars || !IdentifierRegex.IsMatch(trimmed))
            {
                throw new ArgumentException($"invalid property key \"{trimmed}\"");
            }
            return trimmed;
        }

        /// <summary>校验并归一化属性集合（含 <c>&gt; 2^53 - 1</c> 大整数转字符串）。</summary>
        public static Dictionary<string, object?> SanitizeProperties(IDictionary<string, object?>? props)
        {
            var dict = new Dictionary<string, object?>(StringComparer.Ordinal);
            if (props is null || props.Count == 0) return dict;

            foreach (var kvp in props)
            {
                string key = ValidatePropertyKey(kvp.Key);
                if (kvp.Value is null) continue;
                dict[key] = SanitizeValue(key, kvp.Value);
            }
            return dict;
        }

        private static object SanitizeValue(string key, object val)
        {
            switch (val)
            {
                case bool b:
                    return b;
                case string s:
                    return s;
                case sbyte or byte or short or ushort or int or uint:
                    return Convert.ToInt64(val, CultureInfo.InvariantCulture);
                case long i64:
                    if (i64 == long.MinValue || i64 > MaxSafeInteger || i64 < -MaxSafeInteger)
                    {
                        return i64.ToString(CultureInfo.InvariantCulture);
                    }
                    return i64;
                case ulong u64:
                    if (u64 > (ulong)MaxSafeInteger)
                    {
                        return u64.ToString(CultureInfo.InvariantCulture);
                    }
                    return (long)u64;
                case float f32:
                    if (float.IsNaN(f32) || float.IsInfinity(f32))
                    {
                        throw new ArgumentException($"property \"{key}\" has non-finite float");
                    }
                    return (double)f32;
                case double f64:
                    if (double.IsNaN(f64) || double.IsInfinity(f64))
                    {
                        throw new ArgumentException($"property \"{key}\" has non-finite double");
                    }
                    return f64;
                case decimal dec:
                    return (double)dec;
                case DateTime dt:
                    DateTime utcDt = dt.Kind == DateTimeKind.Unspecified
                        ? DateTime.SpecifyKind(dt, DateTimeKind.Utc)
                        : dt.ToUniversalTime();
                    return utcDt.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
                case DateTimeOffset dto:
                    return dto.UtcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
                default:
                    if (val is IDictionary)
                    {
                        throw new ArgumentException($"property \"{key}\" does not allow nested dictionaries");
                    }
                    if (val is IEnumerable enumerable)
                    {
                        var list = new List<object>();
                        foreach (object? item in enumerable)
                        {
                            if (item is null || (item is IEnumerable && item is not string))
                            {
                                throw new ArgumentException($"property \"{key}\" list contains invalid element");
                            }
                            list.Add(SanitizeValue(key, item));
                        }
                        return list;
                    }
                    throw new ArgumentException($"property \"{key}\" has unsupported type {val.GetType().FullName}");
            }
        }

        private static long ParseTimePropertyMs(string key, object? raw)
        {
            if (raw is null) throw new ArgumentException($"{key} must not be null");
            switch (raw)
            {
                case DateTimeOffset dto:
                    long dtoMs = dto.ToUnixTimeMilliseconds();
                    if (dtoMs <= 0) throw new ArgumentException($"invalid {key}");
                    return dtoMs;
                case DateTime dt:
                    DateTime utc = dt.Kind == DateTimeKind.Unspecified
                        ? DateTime.SpecifyKind(dt, DateTimeKind.Local).ToUniversalTime()
                        : dt.ToUniversalTime();
                    long dtMs = new DateTimeOffset(utc).ToUnixTimeMilliseconds();
                    if (dtMs <= 0) throw new ArgumentException($"invalid {key}");
                    return dtMs;
                case sbyte or byte or short or ushort or int or uint or long:
                    long n = Convert.ToInt64(raw, CultureInfo.InvariantCulture);
                    if (n <= 0) throw new ArgumentException($"invalid {key}");
                    return n < SecondsTimestampUpperBound ? n * 1000L : n;
                case float or double or decimal:
                    double d = Convert.ToDouble(raw, CultureInfo.InvariantCulture);
                    if (!double.IsFinite(d) || d <= 0) throw new ArgumentException($"invalid {key}");
                    return d < SecondsTimestampUpperBound
                        ? (long)Math.Round(d * 1000.0, MidpointRounding.AwayFromZero)
                        : (long)Math.Round(d, MidpointRounding.AwayFromZero);
                case string s:
                    string trimmed = s.Trim();
                    if (long.TryParse(trimmed, NumberStyles.None, CultureInfo.InvariantCulture, out long epoch) && epoch > 0)
                    {
                        return epoch < SecondsTimestampUpperBound ? epoch * 1000L : epoch;
                    }
                    if (DateTimeOffset.TryParse(trimmed, CultureInfo.InvariantCulture, DateTimeStyles.AssumeLocal, out DateTimeOffset parsed))
                    {
                        long ms = parsed.ToUnixTimeMilliseconds();
                        if (ms > 0) return ms;
                    }
                    throw new ArgumentException($"invalid {key} string: {raw}");
                default:
                    throw new ArgumentException($"unsupported {key} type: {raw.GetType().FullName}");
            }
        }

        private static Dictionary<string, object?> CollectClientPresetProperties(string appVersion)
        {
#if UNITY_5_3_OR_NEWER
            return new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["$lib"] = LibName,
                ["$lib_version"] = LibVersion,
                ["$os"] = Application.platform.ToString(),
                ["$os_version"] = SystemInfo.operatingSystem ?? "Unknown",
                ["$app_version"] = string.IsNullOrEmpty(appVersion) ? Application.version : appVersion,
                ["$device_model"] = SystemInfo.deviceModel ?? "Unknown",
                ["$screen_width"] = (long)Screen.width,
                ["$screen_height"] = (long)Screen.height,
                ["$platform"] = "Unity"
            };
#else
            return new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["$lib"] = LibName,
                ["$lib_version"] = LibVersion,
                ["$os"] = Environment.OSVersion.Platform.ToString(),
                ["$os_version"] = Environment.OSVersion.VersionString,
                ["$app_version"] = appVersion,
                ["$device_model"] = "UnityDesktopSimulator",
                ["$screen_width"] = 1920L,
                ["$screen_height"] = 1080L,
                ["$platform"] = "Unity"
            };
#endif
        }

        internal (bool DistinctRegenerated, bool LoginCleared) RestoreIdentityFromPersisted(
            string? savedDistinctId,
            string? savedLoginId)
        {
            bool distinctRegenerated = false;
            bool loginCleared = false;

            if (!string.IsNullOrEmpty(savedDistinctId))
            {
                try
                {
                    string normDistinct = NormalizeIdentity(savedDistinctId, MaxDistinctIdBytes, "distinct_id");
                    if (!string.IsNullOrEmpty(normDistinct))
                    {
                        _distinctId = normDistinct;
                    }
                    else
                    {
                        _distinctId = Guid.NewGuid().ToString("D");
                        distinctRegenerated = true;
                    }
                }
                catch
                {
                    _distinctId = Guid.NewGuid().ToString("D");
                    distinctRegenerated = true;
                }
            }
            else
            {
                distinctRegenerated = true;
            }

            if (!string.IsNullOrEmpty(savedLoginId))
            {
                try
                {
                    _loginId = NormalizeIdentity(savedLoginId, MaxLoginIdBytes, "login_id");
                }
                catch
                {
                    _loginId = string.Empty;
                    loginCleared = true;
                }
            }
            else
            {
                _loginId = string.Empty;
            }

            return (distinctRegenerated, loginCleared);
        }

        private void LoadPersistedIdentity()
        {
#if UNITY_5_3_OR_NEWER
            try
            {
                string savedDistinctId = PlayerPrefs.GetString(PrefsDistinctIdKey, string.Empty);
                string savedLoginId = PlayerPrefs.GetString(PrefsLoginIdKey, string.Empty);
                var (distinctRegenerated, loginCleared) = RestoreIdentityFromPersisted(savedDistinctId, savedLoginId);
                if (distinctRegenerated || loginCleared)
                {
                    PlayerPrefs.SetString(PrefsDistinctIdKey, _distinctId);
                    if (string.IsNullOrEmpty(_loginId))
                    {
                        PlayerPrefs.DeleteKey(PrefsLoginIdKey);
                    }
                    else
                    {
                        PlayerPrefs.SetString(PrefsLoginIdKey, _loginId);
                    }
                    PlayerPrefs.Save();
                }
            }
            catch
            {
                // Ignore PlayerPrefs access outside Unity main thread
            }
#endif
        }

        private static void SavePersistedIdentity(string distinctId, string loginId)
        {
#if UNITY_5_3_OR_NEWER
            try
            {
                PlayerPrefs.SetString(PrefsDistinctIdKey, distinctId ?? string.Empty);
                if (string.IsNullOrEmpty(loginId))
                {
                    PlayerPrefs.DeleteKey(PrefsLoginIdKey);
                }
                else
                {
                    PlayerPrefs.SetString(PrefsLoginIdKey, loginId);
                }
                PlayerPrefs.Save();
            }
            catch
            {
                // Ignore PlayerPrefs access outside Unity main thread
            }
#endif
        }

        private static void ValidateListProfileProps(string opName, IDictionary<string, object?> properties)
        {
            if (properties is null || properties.Count == 0)
            {
                throw new ArgumentException($"{opName} requires non-empty properties");
            }
            foreach (var kvp in properties)
            {
                string tk = (kvp.Key ?? string.Empty).Trim();
                if (tk is "#time" or "$time") continue;
                if (kvp.Value is null || kvp.Value is string || kvp.Value is not IEnumerable)
                {
                    throw new ArgumentException($"{opName} property \"{kvp.Key}\" must be a 1D list/array");
                }
            }
        }

        private static Dictionary<string, object?> CloneRecord(Dictionary<string, object?> source)
        {
            var copy = new Dictionary<string, object?>(source, StringComparer.Ordinal);
            if (source.TryGetValue("properties", out object? rawProps) && rawProps is IDictionary<string, object?> propsDict)
            {
                copy["properties"] = new Dictionary<string, object?>(propsDict, StringComparer.Ordinal);
            }
            return copy;
        }

        private static bool IsUnicodeWhitespace(char c)
        {
            return char.IsWhiteSpace(c) || c == '\u0085' || c == '\u00A0' || c == '\u2007' || c == '\u202F';
        }

        private static void PostBatchAsync(
            string url,
            string jsonBody,
            bool compressGzip,
            Action<int, string> callback)
        {
            byte[] rawBytes = Encoding.UTF8.GetBytes(jsonBody);
            byte[] payloadBytes = compressGzip ? CompressGzip(rawBytes) : rawBytes;

            _ = System.Threading.Tasks.Task.Run(async () =>
            {
                try
                {
                    using var req = new HttpRequestMessage(HttpMethod.Post, url);
                    var content = new ByteArrayContent(payloadBytes);
                    content.Headers.ContentType = new MediaTypeHeaderValue("application/json") { CharSet = "utf-8" };
                    if (compressGzip)
                    {
                        content.Headers.ContentEncoding.Add("gzip");
                    }
                    req.Headers.TryAddWithoutValidation("User-Agent", $"{LibName}/{LibVersion}");
                    req.Content = content;

                    using HttpResponseMessage resp = await SharedHttpClient.SendAsync(req).ConfigureAwait(false);
                    string text = await resp.Content.ReadAsStringAsync().ConfigureAwait(false);
                    callback((int)resp.StatusCode, text);
                }
                catch (Exception ex)
                {
                    callback(0, ex.Message);
                }
            });
        }

        private static byte[] CompressGzip(byte[] raw)
        {
            using var ms = new MemoryStream();
            using (var gz = new GZipStream(ms, CompressionLevel.Fastest, leaveOpen: true))
            {
                gz.Write(raw, 0, raw.Length);
            }
            return ms.ToArray();
        }
    }

    /// <summary>
    /// 零外部依赖的轻量级 JSON 序列化器（兼容 Unity Mono / IL2CPP 与标准 .NET，无需引入第三方 JSON 插件）。
    /// </summary>
    internal static class SimpleJsonFormatter
    {
        public static string Serialize(object? value, bool indented)
        {
            var sb = new StringBuilder(512);
            WriteValue(sb, value, indented, indentLevel: 0);
            return sb.ToString();
        }

        private static void WriteValue(StringBuilder sb, object? value, bool indented, int indentLevel)
        {
            switch (value)
            {
                case null:
                    sb.Append("null");
                    break;
                case bool b:
                    sb.Append(b ? "true" : "false");
                    break;
                case string s:
                    WriteEscapedString(sb, s);
                    break;
                case sbyte or byte or short or ushort or int or uint or long or ulong:
                    sb.Append(Convert.ToString(value, CultureInfo.InvariantCulture));
                    break;
                case float f:
                    sb.Append(f.ToString("G9", CultureInfo.InvariantCulture));
                    break;
                case double d:
                    sb.Append(d.ToString("G17", CultureInfo.InvariantCulture));
                    break;
                case decimal dec:
                    sb.Append(dec.ToString(CultureInfo.InvariantCulture));
                    break;
                case IDictionary dict:
                    WriteObject(sb, dict, indented, indentLevel);
                    break;
                case IEnumerable list:
                    WriteArray(sb, list, indented, indentLevel);
                    break;
                default:
                    WriteEscapedString(sb, value.ToString() ?? string.Empty);
                    break;
            }
        }

        private static void WriteObject(StringBuilder sb, IDictionary dict, bool indented, int indentLevel)
        {
            sb.Append('{');
            bool first = true;
            foreach (DictionaryEntry entry in dict)
            {
                if (entry.Value is null) continue;
                if (!first) sb.Append(',');
                if (indented)
                {
                    sb.Append('\n');
                    AppendIndent(sb, indentLevel + 1);
                }
                WriteEscapedString(sb, entry.Key?.ToString() ?? string.Empty);
                sb.Append(indented ? ": " : ":");
                WriteValue(sb, entry.Value, indented, indentLevel + 1);
                first = false;
            }
            if (!first && indented)
            {
                sb.Append('\n');
                AppendIndent(sb, indentLevel);
            }
            sb.Append('}');
        }

        private static void WriteArray(StringBuilder sb, IEnumerable list, bool indented, int indentLevel)
        {
            sb.Append('[');
            bool first = true;
            foreach (object? elem in list)
            {
                if (!first) sb.Append(',');
                if (indented)
                {
                    sb.Append('\n');
                    AppendIndent(sb, indentLevel + 1);
                }
                WriteValue(sb, elem, indented, indentLevel + 1);
                first = false;
            }
            if (!first && indented)
            {
                sb.Append('\n');
                AppendIndent(sb, indentLevel);
            }
            sb.Append(']');
        }

        private static void AppendIndent(StringBuilder sb, int level)
        {
            sb.Append(' ', level * 2);
        }

        private static void WriteEscapedString(StringBuilder sb, string s)
        {
            sb.Append('"');
            foreach (char c in s)
            {
                switch (c)
                {
                    case '"':
                        sb.Append("\\\"");
                        break;
                    case '\\':
                        sb.Append("\\\\");
                        break;
                    case '\b':
                        sb.Append("\\b");
                        break;
                    case '\f':
                        sb.Append("\\f");
                        break;
                    case '\n':
                        sb.Append("\\n");
                        break;
                    case '\r':
                        sb.Append("\\r");
                        break;
                    case '\t':
                        sb.Append("\\t");
                        break;
                    default:
                        if (c < 0x20)
                        {
                            sb.AppendFormat(CultureInfo.InvariantCulture, "\\u{0:x4}", (int)c);
                        }
                        else
                        {
                            sb.Append(c);
                        }
                        break;
                }
            }
            sb.Append('"');
        }
    }
}
