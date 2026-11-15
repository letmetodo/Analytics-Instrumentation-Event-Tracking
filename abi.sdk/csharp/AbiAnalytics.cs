using System.Collections;
using System.Globalization;
using System.IO.Compression;
using System.Net;
using System.Net.Http.Headers;
using System.Text;
using System.Text.Encodings.Web;
using System.Text.Json;
using System.Text.Json.Serialization;
using System.Text.RegularExpressions;

namespace Abi.Sdk;

/// <summary>
/// ABI C# (.NET) 服务端数据采集校验与类型归一化工具类（对标数数科技 ThinkingData C# Server SDK v3.4 规范）。
/// <para>
/// 负责执行身份标识 UTF-8 字节边界与控制字符检查、事件名与属性键名正则校验、
/// 大整数（<c>&gt; 2^53 - 1</c>）防精度丢失字符串转换、时间类型标准化，以及 <c>#time</c> / <c>$time</c> 时间戳提取。
/// </para>
/// </summary>
public static class AbiValidator
{
    /// <summary>事件幂等主键 <c>event_id</c> 的最大 UTF-8 字节长度（64 字节）。</summary>
    public const int MaxEventIdBytes = 64;

    /// <summary>访客/设备标识 <c>distinct_id</c> 的最大 UTF-8 字节长度（64 字节）。</summary>
    public const int MaxDistinctIdBytes = 64;

    /// <summary>实名登录账号标识 <c>login_id</c> 的最大 UTF-8 字节长度（128 字节）。</summary>
    public const int MaxLoginIdBytes = 128;

    /// <summary>事件名称 <c>event_name</c> 的最大字符长度（128 字符）。</summary>
    public const int MaxEventNameChars = 128;

    /// <summary>自定义属性名（Property Key）的最大字符长度（64 字符）。</summary>
    public const int MaxCustomKeyChars = 64;

    /// <summary>IEEE-754 双精度浮点数最大安全整数（<c>2^53 - 1 = 9007199254740991</c>）。</summary>
    public const long MaxSafeInteger = 9007199254740991L;

    /// <summary>区分秒级与毫秒级正整数时间戳的阈值（<c>10^11</c>）。</summary>
    public const long SecondsTimestampUpperBound = 100_000_000_000L;

    /// <summary>SDK 标识与版本号。</summary>
    public const string SdkVersion = "abi-csharp-sdk/1.0.0";

    private static readonly Regex IdentifierRegex = new(
        "^[A-Za-z_][A-Za-z0-9_]*$",
        RegexOptions.Compiled | RegexOptions.CultureInvariant);

    private static readonly HashSet<string> SystemEventWhitelist = new(StringComparer.Ordinal)
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

    private static readonly HashSet<string> SystemPropertyWhitelist = new(StringComparer.Ordinal)
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

    private static readonly string[] SupportedDateTimeFormats =
    {
        "yyyy-MM-dd HH:mm:ss.fffffffK",
        "yyyy-MM-dd HH:mm:ss.ffffffK",
        "yyyy-MM-dd HH:mm:ss.fffffK",
        "yyyy-MM-dd HH:mm:ss.ffffK",
        "yyyy-MM-dd HH:mm:ss.fffK",
        "yyyy-MM-dd HH:mm:ss.ffK",
        "yyyy-MM-dd HH:mm:ss.fK",
        "yyyy-MM-dd HH:mm:ssK",
        "yyyy-MM-dd HH:mm:ss.fffffff",
        "yyyy-MM-dd HH:mm:ss.ffffff",
        "yyyy-MM-dd HH:mm:ss.fffff",
        "yyyy-MM-dd HH:mm:ss.ffff",
        "yyyy-MM-dd HH:mm:ss.fff",
        "yyyy-MM-dd HH:mm:ss.ff",
        "yyyy-MM-dd HH:mm:ss.f",
        "yyyy-MM-dd HH:mm:ss",
        "yyyy-MM-dd'T'HH:mm:ss.fffffffK",
        "yyyy-MM-dd'T'HH:mm:ss.fffK",
        "yyyy-MM-dd'T'HH:mm:ssK",
        "yyyy-MM-dd'T'HH:mm:ss.fff",
        "yyyy-MM-dd'T'HH:mm:ss"
    };

    /// <summary>
    /// 校验并归一化单个身份标识字段（<c>distinct_id</c>、<c>login_id</c> 或 <c>event_id</c>）。
    /// <para>
    /// 规则：首先拦截非法的孤立 UTF-16 代理项与 ASCII 控制字符（<c>0x00-0x08</c>、<c>0x0E-0x1F</c>、<c>0x7F</c>），
    /// 随后裁剪首尾 Unicode 空白符（保留内部空白符如全角空格 <c>U+3000</c>），最后校验 UTF-8 字节长度上限。
    /// </para>
    /// </summary>
    /// <param name="raw">原始输入字符串（允许为 <c>null</c> 或空字符串）。</param>
    /// <param name="maxUtf8Bytes">允许的最大 UTF-8 字节数。</param>
    /// <param name="fieldName">字段名称（用于异常提示）。</param>
    /// <returns>裁剪首尾空白符后的归一化字符串。</returns>
    /// <exception cref="ArgumentException">包含控制字符、非法编码或超出 UTF-8 字节上限时抛出。</exception>
    public static string NormalizeIdentity(string? raw, int maxUtf8Bytes, string fieldName = "identity")
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
                    throw new ArgumentException($"{fieldName} contains unpaired high surrogate at index {i}");
                }
                i++;
                continue;
            }
            if (char.IsLowSurrogate(c))
            {
                throw new ArgumentException($"{fieldName} contains unpaired low surrogate at index {i}");
            }

            if ((c < 0x20 && (c < 0x09 || c > 0x0D)) || c == 0x7F)
            {
                throw new ArgumentException($"{fieldName} contains control character U+{(int)c:X4}");
            }
        }

        int start = 0;
        int end = raw.Length - 1;
        while (start <= end && IsIdentityWhitespace(raw[start]))
        {
            start++;
        }
        while (end >= start && IsIdentityWhitespace(raw[end]))
        {
            end--;
        }

        string trimmed = start > end ? string.Empty : raw.Substring(start, end - start + 1);
        int byteCount = Encoding.UTF8.GetByteCount(trimmed);
        if (byteCount > maxUtf8Bytes)
        {
            throw new ArgumentException(
                $"{fieldName} exceeds max length of {maxUtf8Bytes} UTF-8 bytes (got {byteCount} bytes)");
        }

        return trimmed;
    }

    /// <summary>
    /// 校验并归一化双 ID 身份标识（访客/设备标识 <c>distinct_id</c> 与实名登录账号标识 <c>login_id</c>）。
    /// <para>
    /// 对标数数科技 ThinkingData 规范：<c>distinct_id</c>（≤ 64 UTF-8 字节）与 <c>login_id</c>（≤ 128 UTF-8 字节）至少一个非空；
    /// 当 <c>distinct_id</c> 为空且 <c>login_id</c> 非空时，保持 <c>distinct_id</c> 为空字符串 <c>""</c>，绝不把 <c>login_id</c> 回填至 <c>distinct_id</c>。
    /// </para>
    /// </summary>
    /// <param name="distinctId">访客/设备标识（≤ 64 UTF-8 字节，当 <paramref name="loginId"/> 非空时允许为空）。</param>
    /// <param name="loginId">实名登录账号 ID（≤ 128 UTF-8 字节，当 <paramref name="distinctId"/> 非空时允许为空）。</param>
    /// <returns>归一化后的 <c>(DistinctId, LoginId)</c> 元组。</returns>
    public static (string DistinctId, string LoginId) NormalizeIdentityPair(
        string? distinctId,
        string? loginId)
    {
        string normDistinct = NormalizeIdentity(distinctId, MaxDistinctIdBytes, "distinct_id");
        string normLogin = NormalizeIdentity(loginId, MaxLoginIdBytes, "login_id");

        if (string.IsNullOrEmpty(normDistinct) && string.IsNullOrEmpty(normLogin))
        {
            throw new ArgumentException("at least one of distinct_id or login_id is required");
        }

        return (normDistinct, normLogin);
    }

    /// <summary>
    /// 校验事件名称是否符合 ABI 采集规范（系统白名单事件或匹配 <c>^[A-Za-z_][A-Za-z0-9_]*$</c> 且不超过 128 字符）。
    /// </summary>
    public static string ValidateEventName(string? eventName)
    {
        string trimmed = (eventName ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(trimmed))
        {
            throw new ArgumentException("event_name must not be empty");
        }
        if (trimmed.Length > MaxEventNameChars)
        {
            throw new ArgumentException($"event_name exceeds {MaxEventNameChars} characters");
        }
        if (SystemEventWhitelist.Contains(trimmed))
        {
            return trimmed;
        }
        if (!IdentifierRegex.IsMatch(trimmed))
        {
            throw new ArgumentException(
                $"invalid event_name \"{trimmed}\": must match ^[A-Za-z_][A-Za-z0-9_]*$ or be a system event");
        }
        return trimmed;
    }

    /// <summary>
    /// 校验属性键名（Property Key）是否符合 ABI 采集规范（系统预置属性白名单或匹配 <c>^[A-Za-z_][A-Za-z0-9_]*$</c> 且不超过 64 字符）。
    /// </summary>
    public static string ValidatePropertyKey(string? key)
    {
        string trimmed = (key ?? string.Empty).Trim();
        if (string.IsNullOrEmpty(trimmed))
        {
            throw new ArgumentException("property key must not be empty");
        }
        if (SystemPropertyWhitelist.Contains(trimmed))
        {
            return trimmed;
        }
        if (trimmed.Length > MaxCustomKeyChars || !IdentifierRegex.IsMatch(trimmed))
        {
            throw new ArgumentException(
                $"invalid property key \"{trimmed}\": must match ^[A-Za-z_][A-Za-z0-9_]*$ (max {MaxCustomKeyChars} chars)");
        }
        return trimmed;
    }

    /// <summary>
    /// 判断事件名称是否为 <c>$user_*</c> 或 <c>#user_*</c> 用户画像系统事件。
    /// </summary>
    public static bool IsUserProfileEvent(string eventName)
    {
        return eventName.StartsWith("$user_", StringComparison.Ordinal) ||
               eventName.StartsWith("#user_", StringComparison.Ordinal);
    }

    /// <summary>
    /// 校验并归一化事件属性字典：
    /// <list type="bullet">
    ///   <item><description>自动忽略值为 <c>null</c> 的属性键；</description></item>
    ///   <item><description>绝对值超过 <c>2^53 - 1</c>（<c>9007199254740991</c>）的 64 位整数自动转为十进制字符串，保护雪花 ID 精度；</description></item>
    ///   <item><description><see cref="DateTime"/> 与 <see cref="DateTimeOffset"/> 自动转为 UTC ISO-8601 字符串；</description></item>
    ///   <item><description>拦截 <c>NaN</c>、<c>Infinity</c> 及包含 <c>null</c> 或嵌套集合的非法数组元素。</description></item>
    /// </list>
    /// </summary>
    public static Dictionary<string, object?> SanitizeProperties(IDictionary<string, object?>? properties)
    {
        var result = new Dictionary<string, object?>(StringComparer.Ordinal);
        if (properties == null || properties.Count == 0)
        {
            return result;
        }

        foreach (var kvp in properties)
        {
            string validKey = ValidatePropertyKey(kvp.Key);
            if (kvp.Value is null)
            {
                continue;
            }
            result[validKey] = SanitizePropertyValue(validKey, kvp.Value);
        }

        return result;
    }

    /// <summary>
    /// 校验并转换单个属性值。
    /// </summary>
    public static object SanitizePropertyValue(string key, object value)
    {
        switch (value)
        {
            case bool b:
                return b;
            case string s:
                return s;
            case sbyte sb:
                return (long)sb;
            case byte by:
                return (long)by;
            case short sh:
                return (long)sh;
            case ushort ush:
                return (long)ush;
            case int i32:
                return (long)i32;
            case uint u32:
                return (long)u32;
            case long i64:
                return NormalizeSignedInt64(i64);
            case ulong u64:
                return NormalizeUnsignedInt64(u64);
            case float f32:
                if (float.IsNaN(f32) || float.IsInfinity(f32))
                {
                    throw new ArgumentException($"property \"{key}\" has non-finite float value");
                }
                return (double)f32;
            case double f64:
                if (double.IsNaN(f64) || double.IsInfinity(f64))
                {
                    throw new ArgumentException($"property \"{key}\" has non-finite double value");
                }
                return f64;
            case decimal dec:
                return (double)dec;
            case DateTime dt:
                DateTime utcDt = dt.Kind == DateTimeKind.Unspecified
                    ? DateTime.SpecifyKind(dt, DateTimeKind.Utc)
                    : dt.ToUniversalTime();
                return FormatUtcDateTime(utcDt);
            case DateTimeOffset dto:
                return FormatUtcDateTime(dto.UtcDateTime);
            case JsonElement je:
                return SanitizeJsonElement(key, je);
            default:
                if (value is IDictionary)
                {
                    throw new ArgumentException($"property \"{key}\" does not support nested dictionary/object values");
                }
                if (value is IEnumerable enumerable)
                {
                    var list = new List<object>();
                    int idx = 0;
                    foreach (object? elem in enumerable)
                    {
                        if (elem is null)
                        {
                            throw new ArgumentException($"property \"{key}\" list contains null element at index {idx}");
                        }
                        if (elem is IEnumerable && elem is not string)
                        {
                            throw new ArgumentException($"property \"{key}\" list cannot contain nested collections at index {idx}");
                        }
                        list.Add(SanitizeListElement(key, elem));
                        idx++;
                    }
                    return list;
                }
                throw new ArgumentException($"property \"{key}\" has unsupported value type {value.GetType().FullName}");
        }
    }

    private static object SanitizeListElement(string key, object elem)
    {
        switch (elem)
        {
            case bool b:
                return b;
            case string s:
                return s;
            case sbyte or byte or short or ushort or int or uint:
                return Convert.ToInt64(elem, CultureInfo.InvariantCulture);
            case long i64:
                return NormalizeSignedInt64(i64);
            case ulong u64:
                return NormalizeUnsignedInt64(u64);
            case float f32:
                if (float.IsNaN(f32) || float.IsInfinity(f32))
                {
                    throw new ArgumentException($"property \"{key}\" list contains non-finite float");
                }
                return (double)f32;
            case double f64:
                if (double.IsNaN(f64) || double.IsInfinity(f64))
                {
                    throw new ArgumentException($"property \"{key}\" list contains non-finite double");
                }
                return f64;
            case decimal dec:
                return (double)dec;
            case DateTime dt:
                DateTime utcDt = dt.Kind == DateTimeKind.Unspecified
                    ? DateTime.SpecifyKind(dt, DateTimeKind.Utc)
                    : dt.ToUniversalTime();
                return FormatUtcDateTime(utcDt);
            case DateTimeOffset dto:
                return FormatUtcDateTime(dto.UtcDateTime);
            default:
                throw new ArgumentException(
                    $"property \"{key}\" list contains unsupported element type {elem.GetType().FullName}");
        }
    }

    private static object SanitizeJsonElement(string key, JsonElement element)
    {
        switch (element.ValueKind)
        {
            case JsonValueKind.String:
                return element.GetString() ?? string.Empty;
            case JsonValueKind.True:
                return true;
            case JsonValueKind.False:
                return false;
            case JsonValueKind.Number:
                if (element.TryGetInt64(out long i64))
                {
                    return NormalizeSignedInt64(i64);
                }
                if (element.TryGetUInt64(out ulong u64))
                {
                    return NormalizeUnsignedInt64(u64);
                }
                double d = element.GetDouble();
                if (double.IsNaN(d) || double.IsInfinity(d))
                {
                    throw new ArgumentException($"property \"{key}\" has non-finite number");
                }
                return d;
            case JsonValueKind.Array:
                var list = new List<object>();
                foreach (JsonElement item in element.EnumerateArray())
                {
                    if (item.ValueKind is JsonValueKind.Null or JsonValueKind.Undefined or JsonValueKind.Object or JsonValueKind.Array)
                    {
                        throw new ArgumentException($"property \"{key}\" array contains invalid JSON element ({item.ValueKind})");
                    }
                    list.Add(SanitizeJsonElement(key, item));
                }
                return list;
            default:
                throw new ArgumentException($"property \"{key}\" has unsupported JsonValueKind {element.ValueKind}");
        }
    }

    /// <summary>
    /// 对有符号 64 位长整型执行 IEEE-754 安全整数边界检查：超出 <c>[-9007199254740991, 9007199254740991]</c> 时转为十进制字符串。
    /// </summary>
    public static object NormalizeSignedInt64(long value)
    {
        if (value == long.MinValue || value > MaxSafeInteger || value < -MaxSafeInteger)
        {
            return value.ToString(CultureInfo.InvariantCulture);
        }
        return value;
    }

    /// <summary>
    /// 对无符号 64 位整数执行 IEEE-754 安全整数边界检查：超出 <c>9007199254740991</c> 时转为十进制字符串。
    /// </summary>
    public static object NormalizeUnsignedInt64(ulong value)
    {
        if (value > (ulong)MaxSafeInteger)
        {
            return value.ToString(CultureInfo.InvariantCulture);
        }
        return (long)value;
    }

    /// <summary>
    /// 解析属性字典中的 <c>#time</c> 或 <c>$time</c> 字段为 Unix 毫秒时间戳。
    /// 支持 <see cref="DateTimeOffset"/>、<see cref="DateTime"/>、秒/毫秒级整数或浮点数、以及 ISO-8601 / 标准时间字符串。
    /// </summary>
    public static long ParseTimeValue(string key, object? raw)
    {
        if (raw is null)
        {
            throw new ArgumentException($"{key} must not be null");
        }

        switch (raw)
        {
            case DateTimeOffset dto:
                long dtoMs = dto.ToUnixTimeMilliseconds();
                if (dtoMs <= 0)
                {
                    throw new ArgumentException($"invalid {key} DateTimeOffset timestamp: {dtoMs}");
                }
                return dtoMs;
            case DateTime dt:
                DateTime utc = dt.Kind == DateTimeKind.Unspecified
                    ? DateTime.SpecifyKind(dt, DateTimeKind.Local).ToUniversalTime()
                    : dt.ToUniversalTime();
                long dtMs = new DateTimeOffset(utc).ToUnixTimeMilliseconds();
                if (dtMs <= 0)
                {
                    throw new ArgumentException($"invalid {key} DateTime timestamp: {dtMs}");
                }
                return dtMs;
            case int or long or sbyte or byte or short or ushort or uint:
                long num = Convert.ToInt64(raw, CultureInfo.InvariantCulture);
                if (num <= 0)
                {
                    throw new ArgumentException($"invalid {key} numeric timestamp: {num}");
                }
                return num < SecondsTimestampUpperBound ? num * 1000L : num;
            case float or double or decimal:
                double d = Convert.ToDouble(raw, CultureInfo.InvariantCulture);
                if (!double.IsFinite(d) || d <= 0)
                {
                    throw new ArgumentException($"invalid {key} floating-point timestamp: {d}");
                }
                return d < SecondsTimestampUpperBound
                    ? (long)Math.Round(d * 1000.0, MidpointRounding.AwayFromZero)
                    : (long)Math.Round(d, MidpointRounding.AwayFromZero);
            case string str:
                string trimmed = str.Trim();
                if (string.IsNullOrEmpty(trimmed))
                {
                    throw new ArgumentException($"{key} string must not be empty");
                }
                if (long.TryParse(trimmed, NumberStyles.None, CultureInfo.InvariantCulture, out long epochNum) && epochNum > 0)
                {
                    return epochNum < SecondsTimestampUpperBound ? epochNum * 1000L : epochNum;
                }
                if (DateTimeOffset.TryParseExact(
                        trimmed,
                        SupportedDateTimeFormats,
                        CultureInfo.InvariantCulture,
                        DateTimeStyles.AssumeLocal,
                        out DateTimeOffset exactDto))
                {
                    long ms = exactDto.ToUnixTimeMilliseconds();
                    if (ms > 0) return ms;
                }
                if (DateTimeOffset.TryParse(
                        trimmed,
                        CultureInfo.InvariantCulture,
                        DateTimeStyles.AssumeLocal,
                        out DateTimeOffset parsedDto))
                {
                    long ms = parsedDto.ToUnixTimeMilliseconds();
                    if (ms > 0) return ms;
                }
                throw new ArgumentException($"invalid {key} string value: {raw}");
            default:
                throw new ArgumentException($"unsupported {key} type: {raw.GetType().FullName}");
        }
    }

    private static string FormatUtcDateTime(DateTime utcDateTime)
    {
        return utcDateTime.Millisecond == 0
            ? utcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss'Z'", CultureInfo.InvariantCulture)
            : utcDateTime.ToString("yyyy-MM-dd'T'HH:mm:ss.fff'Z'", CultureInfo.InvariantCulture);
    }

    private static bool IsIdentityWhitespace(char c)
    {
        return char.IsWhiteSpace(c) || c == '\u0085' || c == '\u00A0' || c == '\u2007' || c == '\u202F';
    }
}

/// <summary>
/// ABI 服务端事件消费者统一接口（对标 ThinkingData <c>ITAConsumer</c>）。
/// </summary>
public interface IConsumer : IDisposable
{
    /// <summary>向消费者写入一条已通过校验与归一化的事件字典。</summary>
    void Add(Dictionary<string, object?> eventRecord);

    /// <summary>立即将缓冲区中的事件批量发送或落盘。</summary>
    void Flush();

    /// <summary>刷新剩余缓冲事件并关闭底层连接或文件句柄。</summary>
    void Close();
}

/// <summary>
/// 采集网关批量上报顶层请求体结构（<c>POST /collect/api/v1/track/batch</c>）。
/// </summary>
public sealed class TrackBatchPayload
{
    [JsonPropertyName("project_id")]
    public long ProjectId { get; set; }

    [JsonPropertyName("project_token")]
    public string ProjectToken { get; set; } = string.Empty;

    [JsonPropertyName("debug")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool Debug { get; set; }

    [JsonPropertyName("dry_run")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool DryRun { get; set; }

    [JsonPropertyName("events")]
    public List<Dictionary<string, object?>> Events { get; set; } = new();
}

/// <summary>
/// 采集网关单条事件校验错误明细。
/// </summary>
public sealed class GatewayEventError
{
    [JsonPropertyName("index")]
    public int Index { get; set; }

    [JsonPropertyName("event_id")]
    public string? EventId { get; set; }

    [JsonPropertyName("event_name")]
    public string? EventName { get; set; }

    [JsonPropertyName("reason")]
    public string? Reason { get; set; }
}

/// <summary>
/// 采集网关批量响应 <c>data</c> 载荷。
/// </summary>
public sealed class GatewayBatchResult
{
    [JsonPropertyName("accepted")]
    public int Accepted { get; set; }

    [JsonPropertyName("rejected")]
    public int Rejected { get; set; }

    [JsonPropertyName("dry_run")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingDefault)]
    public bool DryRun { get; set; }

    [JsonPropertyName("errors")]
    [JsonIgnore(Condition = JsonIgnoreCondition.WhenWritingNull)]
    public List<GatewayEventError>? Errors { get; set; }
}

/// <summary>
/// 采集网关标准 JSON 响应信封（<c>{ code, message, data, request_id }</c>）。
/// </summary>
public sealed class GatewayEnvelope
{
    [JsonPropertyName("code")]
    public int Code { get; set; }

    [JsonPropertyName("message")]
    public string Message { get; set; } = string.Empty;

    [JsonPropertyName("data")]
    public GatewayBatchResult? Data { get; set; }

    [JsonPropertyName("request_id")]
    public string? RequestId { get; set; }
}

/// <summary>
/// 高级事件上报参数选项（支持显式指定确定性 <c>EventId</c>、双 ID 身份标识与精确发生时间 <c>Timestamp</c>）。
/// </summary>
public sealed class TrackOptions
{
    /// <summary>可选：事件幂等主键（为空时自动生成 UUIDv4）。</summary>
    public string? EventId { get; set; }

    /// <summary>必填：事件名称（如 <c>OrderPaid</c>）。</summary>
    public string EventName { get; set; } = string.Empty;

    /// <summary>实名登录账号 ID（对应协议字段 <c>login_id</c>，≤ 128 UTF-8 字节）。</summary>
    public string? AccountId { get; set; }

    /// <summary>访客/设备标识（对应协议字段 <c>distinct_id</c>，≤ 64 UTF-8 字节）。</summary>
    public string? DistinctId { get; set; }

    /// <summary>可选：显式指定事件发生时间（为空时取 <c>properties["#time"]</c> 或当前 UTC 时间）。</summary>
    public DateTimeOffset? Timestamp { get; set; }

    /// <summary>可选：事件自定义属性与预置系统属性（如 <c>"#ip"</c>）。</summary>
    public IDictionary<string, object?>? Properties { get; set; }
}

internal static class AbiJsonSerializer
{
    public static readonly JsonSerializerOptions CompactOptions = new()
    {
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };

    public static readonly JsonSerializerOptions IndentedOptions = new()
    {
        WriteIndented = true,
        Encoder = JavaScriptEncoder.UnsafeRelaxedJsonEscaping,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull
    };
}

/// <summary>
/// 内存暂存预览消费者（<see cref="StagingConsumer"/>）：在内存中暂存待提交事件而不自动发起网络请求。
/// <para>
/// 支持标准两步式接入与调试工作流：
/// 1. 调用 <see cref="PreviewRequestJson(long, string, bool)"/> 生成并核对唯一一份格式化的 <c>POST /collect/api/v1/track/batch</c> 请求 JSON；
/// 2. 确认无误后调用 <see cref="ConfirmSubmit(IConsumer)"/> 或 <see cref="SubmitToGateway(BatchConsumer.Config)"/> 一次性提交并清空暂存队列。
/// </para>
/// </summary>
public sealed class StagingConsumer : IConsumer
{
    private readonly object _syncRoot = new();
    private readonly int _maxQueueSize;
    private readonly List<Dictionary<string, object?>> _stagedEvents = new();
    private readonly long _defaultProjectId;
    private readonly string _defaultProjectToken;
    private readonly bool _defaultDryRun;

    /// <summary>
    /// 创建内存暂存预览消费者。
    /// </summary>
    /// <param name="projectId">默认项目 ID（可选，用于无参调用 <see cref="PreviewRequestJson()"/>）。</param>
    /// <param name="projectToken">默认项目采集 Token。</param>
    /// <param name="dryRun">默认是否开启 <c>dry_run</c> 仅校验不落库模式。</param>
    /// <param name="maxQueueSize">最大内存暂存条数（默认 10000 条）。</param>
    public StagingConsumer(
        long projectId = 1,
        string projectToken = "abi_tok_demo_csharp",
        bool dryRun = false,
        int maxQueueSize = 10000)
    {
        if (maxQueueSize <= 0)
        {
            throw new ArgumentOutOfRangeException(nameof(maxQueueSize), "maxQueueSize must be > 0");
        }
        _defaultProjectId = projectId;
        _defaultProjectToken = projectToken ?? string.Empty;
        _defaultDryRun = dryRun;
        _maxQueueSize = maxQueueSize;
    }

    /// <summary>获取当前暂存队列中的待提交事件数量。</summary>
    public int Size
    {
        get
        {
            lock (_syncRoot)
            {
                return _stagedEvents.Count;
            }
        }
    }

    /// <inheritdoc />
    public void Add(Dictionary<string, object?> eventRecord)
    {
        if (eventRecord is null)
        {
            throw new ArgumentNullException(nameof(eventRecord));
        }

        lock (_syncRoot)
        {
            if (_stagedEvents.Count >= _maxQueueSize)
            {
                throw new InvalidOperationException($"StagingConsumer queue is full ({_maxQueueSize})");
            }
            _stagedEvents.Add(CloneEventRecord(eventRecord));
        }
    }

    /// <summary>暂存消费者的 <c>Flush</c> 为空操作，不会主动触发任何外部网络请求。</summary>
    public void Flush()
    {
    }

    /// <summary>关闭包装器时保留已暂存事件，以便后续继续预览或确认提交。</summary>
    public void Close()
    {
    }

    /// <inheritdoc />
    public void Dispose()
    {
        Close();
    }

    /// <summary>清空当前暂存队列中的所有待提交事件。</summary>
    public void Clear()
    {
        lock (_syncRoot)
        {
            _stagedEvents.Clear();
        }
    }

    /// <summary>获取当前暂存队列中所有事件的深拷贝只读快照。</summary>
    public IReadOnlyList<Dictionary<string, object?>> GetStagedEvents()
    {
        lock (_syncRoot)
        {
            var copy = new List<Dictionary<string, object?>>(_stagedEvents.Count);
            foreach (var item in _stagedEvents)
            {
                copy.Add(CloneEventRecord(item));
            }
            return copy;
        }
    }

    /// <summary>
    /// 使用构造时传入的默认项目凭证组装 <c>POST /collect/api/v1/track/batch</c> 请求载荷字典（不清空队列）。
    /// </summary>
    public Dictionary<string, object?> BuildRequestPayload()
    {
        return BuildRequestPayload(_defaultProjectId, _defaultProjectToken, _defaultDryRun);
    }

    /// <summary>
    /// 组装 <c>POST /collect/api/v1/track/batch</c> 的完整请求载荷字典（不清空暂存队列，零网络副作用）。
    /// </summary>
    public Dictionary<string, object?> BuildRequestPayload(long projectId, string projectToken, bool dryRun = false)
    {
        if (projectId <= 0 || string.IsNullOrWhiteSpace(projectToken))
        {
            throw new ArgumentException("projectId (> 0) and projectToken are required");
        }

        lock (_syncRoot)
        {
            var eventsCopy = new List<Dictionary<string, object?>>(_stagedEvents.Count);
            foreach (var record in _stagedEvents)
            {
                eventsCopy.Add(CloneEventRecord(record));
            }

            var payload = new Dictionary<string, object?>(StringComparer.Ordinal)
            {
                ["project_id"] = projectId,
                ["project_token"] = projectToken.Trim(),
                ["dry_run"] = dryRun,
                ["events"] = eventsCopy
            };
            return payload;
        }
    }

    /// <summary>
    /// 使用默认项目参数生成带缩进格式化的 <c>POST /collect/api/v1/track/batch</c> 待提交请求 JSON 预览字符串。
    /// </summary>
    public string PreviewRequestJson()
    {
        return PreviewRequestJson(_defaultProjectId, _defaultProjectToken, _defaultDryRun);
    }

    /// <summary>
    /// 生成带缩进格式化的 <c>POST /collect/api/v1/track/batch</c> 完整待提交请求 JSON 预览字符串（不清空暂存队列）。
    /// </summary>
    public string PreviewRequestJson(long projectId, string projectToken, bool dryRun = false)
    {
        var payload = BuildRequestPayload(projectId, projectToken, dryRun);
        return JsonSerializer.Serialize(payload, AbiJsonSerializer.IndentedOptions);
    }

    /// <summary>
    /// 第 2 步确认提交：将当前暂存队列中的全部事件一次性投递至目标消费者（如 <see cref="BatchConsumer"/> 或 <see cref="DebugConsumer"/>），
    /// 立即调用 <c>targetConsumer.Flush()</c> 发送，成功后清空暂存队列并返回提交的事件条数。
    /// </summary>
    public int ConfirmSubmit(IConsumer targetConsumer)
    {
        if (targetConsumer is null)
        {
            throw new ArgumentNullException(nameof(targetConsumer));
        }
        if (ReferenceEquals(targetConsumer, this))
        {
            throw new ArgumentException("targetConsumer must not be this StagingConsumer instance");
        }

        List<Dictionary<string, object?>> snapshot;
        lock (_syncRoot)
        {
            snapshot = new List<Dictionary<string, object?>>(_stagedEvents.Count);
            foreach (var item in _stagedEvents)
            {
                snapshot.Add(CloneEventRecord(item));
            }
        }

        foreach (var ev in snapshot)
        {
            targetConsumer.Add(ev);
        }
        targetConsumer.Flush();

        lock (_syncRoot)
        {
            _stagedEvents.Clear();
        }
        return snapshot.Count;
    }

    /// <summary>
    /// 第 2 步确认提交直达网关：将暂存队列中的事件作为单批报文提交至采集网关，返回解析后的响应结构与格式化响应 JSON，并清空暂存队列。
    /// </summary>
    public (GatewayEnvelope? Envelope, string ResponseJson) SubmitToGateway(BatchConsumer.Config config)
    {
        if (config is null)
        {
            throw new ArgumentNullException(nameof(config));
        }

        List<Dictionary<string, object?>> snapshot;
        lock (_syncRoot)
        {
            snapshot = new List<Dictionary<string, object?>>(_stagedEvents.Count);
            foreach (var item in _stagedEvents)
            {
                snapshot.Add(CloneEventRecord(item));
            }
        }

        using var batchConsumer = new BatchConsumer(config, startBackgroundTimer: false);
        var (envelope, rawJson) = batchConsumer.SendBatchDirect(snapshot);

        lock (_syncRoot)
        {
            _stagedEvents.Clear();
        }
        return (envelope, rawJson);
    }

    internal static Dictionary<string, object?> CloneEventRecord(Dictionary<string, object?> source)
    {
        var copy = new Dictionary<string, object?>(source, StringComparer.Ordinal);
        if (source.TryGetValue("properties", out object? rawProps) && rawProps is IDictionary<string, object?> propsDict)
        {
            copy["properties"] = new Dictionary<string, object?>(propsDict, StringComparer.Ordinal);
        }
        return copy;
    }
}

/// <summary>
/// 异步批量 HTTP 上报消费者（生产环境微服务推荐）：
/// 基于线程安全内存有界队列 + 后台定时刷新线程，支持 Gzip 请求体压缩与网络异常 / HTTP <c>429</c> / <c>5xx</c> 指数退避幂等重试。
/// </summary>
public sealed class BatchConsumer : IConsumer
{
    /// <summary>
    /// <see cref="BatchConsumer"/> 配置项。
    /// </summary>
    public sealed class Config
    {
        /// <summary>采集网关基础地址（如 <c>http://127.0.0.1:8081</c>）。</summary>
        public string ServerUrl { get; set; }

        /// <summary>ABI 项目数字 ID（必须 <c>&gt; 0</c>）。</summary>
        public long ProjectId { get; set; }

        /// <summary>ABI 项目采集鉴权 Token。</summary>
        public string ProjectToken { get; set; }

        /// <summary>单批触发上报的事件条数上限（默认 50，范围 1~500）。</summary>
        public int BatchSize { get; set; } = 50;

        /// <summary>后台定时刷新间隔毫秒数（默认 2000ms）。</summary>
        public int FlushIntervalMs { get; set; } = 2000;

        /// <summary>内存待发送队列最大容量（默认 10000 条）。</summary>
        public int MaxQueueSize { get; set; } = 10000;

        /// <summary>遇到网络抖动、HTTP 429 或 5xx 时的最大指数退避重试次数（默认 3 次）。</summary>
        public int MaxRetries { get; set; } = 3;

        /// <summary>是否开启请求体 Gzip 压缩（默认 <c>true</c>）。</summary>
        public bool CompressGzip { get; set; } = true;

        /// <summary>是否在请求体中开启 <c>dry_run</c> 仅校验不落库模式（默认 <c>false</c>）。</summary>
        public bool DryRun { get; set; }

        /// <summary>单次 HTTP 请求超时时间毫秒数（默认 10000ms）。</summary>
        public int TimeoutMs { get; set; } = 10000;

        /// <summary>构造批量上报配置。</summary>
        public Config(string serverUrl, long projectId, string projectToken)
        {
            ServerUrl = serverUrl ?? string.Empty;
            ProjectId = projectId;
            ProjectToken = projectToken ?? string.Empty;
        }
    }

    private readonly Config _config;
    private readonly string _endpointUrl;
    private readonly HttpClient _httpClient;
    private readonly bool _ownsHttpClient;
    private readonly object _queueLock = new();
    private readonly object _flushLock = new();
    private readonly List<Dictionary<string, object?>> _queue = new();
    private readonly Timer? _timer;
    private bool _closed;

    /// <summary>创建异步批量上报消费者。</summary>
    public BatchConsumer(Config config, HttpClient? httpClient = null, bool startBackgroundTimer = true)
    {
        if (config is null) throw new ArgumentNullException(nameof(config));
        if (string.IsNullOrWhiteSpace(config.ServerUrl))
            throw new ArgumentException("ServerUrl must not be empty", nameof(config));
        if (config.ProjectId <= 0)
            throw new ArgumentException("ProjectId must be > 0", nameof(config));
        if (string.IsNullOrWhiteSpace(config.ProjectToken))
            throw new ArgumentException("ProjectToken must not be empty", nameof(config));

        _config = config;
        _config.BatchSize = Math.Clamp(config.BatchSize, 1, 500);
        _config.FlushIntervalMs = Math.Max(100, config.FlushIntervalMs);
        _config.MaxQueueSize = Math.Max(1, config.MaxQueueSize);
        _config.MaxRetries = Math.Max(0, config.MaxRetries);

        string trimmedUrl = config.ServerUrl.Trim().TrimEnd('/');
        _endpointUrl = trimmedUrl.EndsWith("/collect/api/v1/track/batch", StringComparison.OrdinalIgnoreCase)
            ? trimmedUrl
            : $"{trimmedUrl}/collect/api/v1/track/batch";

        if (httpClient is not null)
        {
            _httpClient = httpClient;
            _ownsHttpClient = false;
        }
        else
        {
            _httpClient = new HttpClient
            {
                Timeout = TimeSpan.FromMilliseconds(Math.Max(1000, config.TimeoutMs))
            };
            _ownsHttpClient = true;
        }

        if (startBackgroundTimer)
        {
            _timer = new Timer(_ =>
            {
                try
                {
                    Flush();
                }
                catch
                {
                    // 后台定时刷新静默容错，避免未捕获异常终止宿主进程
                }
            }, null, _config.FlushIntervalMs, _config.FlushIntervalMs);
        }
    }

    /// <inheritdoc />
    public void Add(Dictionary<string, object?> eventRecord)
    {
        if (eventRecord is null) throw new ArgumentNullException(nameof(eventRecord));

        bool shouldFlush;
        lock (_queueLock)
        {
            if (_closed)
            {
                throw new ObjectDisposedException(nameof(BatchConsumer), "BatchConsumer is already closed");
            }
            if (_queue.Count >= _config.MaxQueueSize)
            {
                throw new InvalidOperationException($"BatchConsumer queue is full ({_config.MaxQueueSize})");
            }
            _queue.Add(StagingConsumer.CloneEventRecord(eventRecord));
            shouldFlush = _queue.Count >= _config.BatchSize;
        }

        if (shouldFlush)
        {
            Flush();
        }
    }

    /// <inheritdoc />
    public void Flush()
    {
        lock (_flushLock)
        {
            while (true)
            {
                List<Dictionary<string, object?>> batch;
                lock (_queueLock)
                {
                    if (_queue.Count == 0)
                    {
                        return;
                    }
                    int count = Math.Min(_config.BatchSize, _queue.Count);
                    batch = _queue.GetRange(0, count);
                    _queue.RemoveRange(0, count);
                }

                SendBatchDirect(batch);
            }
        }
    }

    internal (GatewayEnvelope? Envelope, string FormattedResponseJson) SendBatchDirect(
        List<Dictionary<string, object?>> batch)
    {
        var payload = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["project_id"] = _config.ProjectId,
            ["project_token"] = _config.ProjectToken.Trim(),
            ["dry_run"] = _config.DryRun,
            ["events"] = batch
        };

        byte[] jsonBytes = JsonSerializer.SerializeToUtf8Bytes(payload, AbiJsonSerializer.CompactOptions);
        byte[] bodyBytes = _config.CompressGzip ? CompressGzipBytes(jsonBytes) : jsonBytes;

        Exception? lastError = null;
        for (int attempt = 0; attempt <= _config.MaxRetries; attempt++)
        {
            if (attempt > 0)
            {
                int backoffMs = 100 * (1 << (attempt - 1));
                Thread.Sleep(backoffMs);
            }

            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, _endpointUrl);
                var content = new ByteArrayContent(bodyBytes);
                content.Headers.ContentType = new MediaTypeHeaderValue("application/json") { CharSet = "utf-8" };
                if (_config.CompressGzip)
                {
                    content.Headers.ContentEncoding.Add("gzip");
                }
                request.Headers.TryAddWithoutValidation("User-Agent", AbiValidator.SdkVersion);
                request.Content = content;

                using HttpResponseMessage response = _httpClient.Send(request);
                string respBody = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
                int statusCode = (int)response.StatusCode;

                if (statusCode >= 200 && statusCode < 300)
                {
                    GatewayEnvelope? env = null;
                    string formatted = respBody;
                    try
                    {
                        env = JsonSerializer.Deserialize<GatewayEnvelope>(respBody, AbiJsonSerializer.CompactOptions);
                        if (env is not null)
                        {
                            formatted = JsonSerializer.Serialize(env, AbiJsonSerializer.IndentedOptions);
                        }
                    }
                    catch
                    {
                        // 保留原始响应字符串
                    }
                    return (env, formatted);
                }

                bool retryable = statusCode == 429 || statusCode >= 500;
                lastError = new HttpRequestException(
                    $"ABI gateway returned HTTP {statusCode}: {respBody}",
                    null,
                    response.StatusCode);

                if (!retryable)
                {
                    throw lastError;
                }
            }
            catch (Exception ex) when (ex is not HttpRequestException || IsRetryableHttpException(ex))
            {
                lastError = ex;
            }
        }

        throw lastError ?? new InvalidOperationException("Failed to send batch to ABI gateway");
    }

    private static bool IsRetryableHttpException(Exception ex)
    {
        if (ex is HttpRequestException httpEx && httpEx.StatusCode.HasValue)
        {
            int code = (int)httpEx.StatusCode.Value;
            return code == 429 || code >= 500;
        }
        return true;
    }

    private static byte[] CompressGzipBytes(byte[] raw)
    {
        using var ms = new MemoryStream();
        using (var gzip = new GZipStream(ms, CompressionLevel.Fastest, leaveOpen: true))
        {
            gzip.Write(raw, 0, raw.Length);
        }
        return ms.ToArray();
    }

    /// <inheritdoc />
    public void Close()
    {
        lock (_queueLock)
        {
            if (_closed) return;
            _closed = true;
        }

        _timer?.Dispose();
        try
        {
            Flush();
        }
        finally
        {
            if (_ownsHttpClient)
            {
                _httpClient.Dispose();
            }
        }
    }

    /// <inheritdoc />
    public void Dispose()
    {
        Close();
    }
}

/// <summary>
/// 同步在线校验与 Dry-Run 预检消费者（研发本地联调 / CI 自动化门禁推荐）：
/// 每次调用 <c>Add</c> 时立即同步向采集网关发送 <c>"debug": true</c> 请求，若网关 L4 校验拒绝则直接抛出异常并附带逐条错误原因。
/// </summary>
public sealed class DebugConsumer : IConsumer
{
    private readonly string _endpointUrl;
    private readonly long _projectId;
    private readonly string _projectToken;
    private readonly bool _dryRun;
    private readonly HttpClient _httpClient;
    private readonly bool _ownsHttpClient;
    private bool _closed;

    /// <summary>
    /// 创建同步联调消费者。
    /// </summary>
    /// <param name="serverUrl">采集网关地址（如 <c>http://127.0.0.1:8081</c>）。</param>
    /// <param name="projectId">ABI 项目 ID。</param>
    /// <param name="projectToken">ABI 项目采集鉴权 Token。</param>
    /// <param name="dryRun">是否开启零污染预检（<c>true</c> 时网关仅校验不写入 Kafka/StarRocks）。</param>
    /// <param name="httpClient">可选的自定义 <see cref="HttpClient"/>。</param>
    public DebugConsumer(
        string serverUrl,
        long projectId,
        string projectToken,
        bool dryRun = true,
        HttpClient? httpClient = null)
    {
        if (string.IsNullOrWhiteSpace(serverUrl))
            throw new ArgumentException("serverUrl must not be empty", nameof(serverUrl));
        if (projectId <= 0)
            throw new ArgumentException("projectId must be > 0", nameof(projectId));
        if (string.IsNullOrWhiteSpace(projectToken))
            throw new ArgumentException("projectToken must not be empty", nameof(projectToken));

        string trimmed = serverUrl.Trim().TrimEnd('/');
        _endpointUrl = trimmed.EndsWith("/collect/api/v1/track/batch", StringComparison.OrdinalIgnoreCase)
            ? trimmed
            : $"{trimmed}/collect/api/v1/track/batch";
        _projectId = projectId;
        _projectToken = projectToken.Trim();
        _dryRun = dryRun;

        if (httpClient is not null)
        {
            _httpClient = httpClient;
            _ownsHttpClient = false;
        }
        else
        {
            _httpClient = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
            _ownsHttpClient = true;
        }
    }

    /// <inheritdoc />
    public void Add(Dictionary<string, object?> eventRecord)
    {
        if (_closed) throw new ObjectDisposedException(nameof(DebugConsumer));
        if (eventRecord is null) throw new ArgumentNullException(nameof(eventRecord));

        var payload = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["project_id"] = _projectId,
            ["project_token"] = _projectToken,
            ["debug"] = true,
            ["dry_run"] = _dryRun,
            ["events"] = new List<Dictionary<string, object?>> { StagingConsumer.CloneEventRecord(eventRecord) }
        };

        byte[] jsonBytes = JsonSerializer.SerializeToUtf8Bytes(payload, AbiJsonSerializer.CompactOptions);
        using var request = new HttpRequestMessage(HttpMethod.Post, _endpointUrl)
        {
            Content = new ByteArrayContent(jsonBytes)
        };
        request.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json") { CharSet = "utf-8" };
        request.Headers.TryAddWithoutValidation("User-Agent", AbiValidator.SdkVersion);

        using HttpResponseMessage response = _httpClient.Send(request);
        string body = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
        if (!response.IsSuccessStatusCode)
        {
            throw new InvalidOperationException($"DebugConsumer HTTP {(int)response.StatusCode} error: {body}");
        }

        GatewayEnvelope? env = JsonSerializer.Deserialize<GatewayEnvelope>(body, AbiJsonSerializer.CompactOptions);
        if (env?.Data is not null && env.Data.Rejected > 0)
        {
            string reason = env.Data.Errors is { Count: > 0 }
                ? string.Join("; ", env.Data.Errors.Select(e => e.Reason))
                : body;
            throw new ArgumentException($"ABI gateway rejected debug event: {reason}");
        }
    }

    /// <inheritdoc />
    public void Flush()
    {
    }

    /// <inheritdoc />
    public void Close()
    {
        if (_closed) return;
        _closed = true;
        if (_ownsHttpClient)
        {
            _httpClient.Dispose();
        }
    }

    /// <inheritdoc />
    public void Dispose()
    {
        Close();
    }
}

/// <summary>
/// 本地 JSONL 滚动落盘消费者（高吞吐核心交易解耦推荐）：
/// 按 UTC 自然日将事件追加写入 <c>&lt;filePrefix&gt;.YYYY-MM-DD.jsonl</c>，配合 Filebeat / Vector / LogBus 旁路采集。
/// </summary>
public sealed class LoggerConsumer : IConsumer
{
    private readonly object _lock = new();
    private readonly string _directoryPath;
    private readonly string _filePrefix;
    private string _currentDateStr = string.Empty;
    private StreamWriter? _writer;
    private bool _closed;

    /// <summary>
    /// 创建本地 JSONL 落盘消费者。
    /// </summary>
    /// <param name="directoryPath">日志文件输出目录。</param>
    /// <param name="filePrefix">日志文件名前缀（默认 <c>abi_events</c>）。</param>
    public LoggerConsumer(string directoryPath, string filePrefix = "abi_events")
    {
        if (string.IsNullOrWhiteSpace(directoryPath))
            throw new ArgumentException("directoryPath must not be empty", nameof(directoryPath));
        if (string.IsNullOrWhiteSpace(filePrefix))
            throw new ArgumentException("filePrefix must not be empty", nameof(filePrefix));

        _directoryPath = directoryPath;
        _filePrefix = filePrefix.Trim();
        Directory.CreateDirectory(_directoryPath);
    }

    /// <summary>获取当前正在写入的 JSONL 文件完整路径。</summary>
    public string CurrentFilePath
    {
        get
        {
            lock (_lock)
            {
                string dateStr = string.IsNullOrEmpty(_currentDateStr)
                    ? DateTime.UtcNow.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture)
                    : _currentDateStr;
                return Path.Combine(_directoryPath, $"{_filePrefix}.{dateStr}.jsonl");
            }
        }
    }

    /// <inheritdoc />
    public void Add(Dictionary<string, object?> eventRecord)
    {
        if (eventRecord is null) throw new ArgumentNullException(nameof(eventRecord));
        string line = JsonSerializer.Serialize(eventRecord, AbiJsonSerializer.CompactOptions);

        lock (_lock)
        {
            if (_closed) throw new ObjectDisposedException(nameof(LoggerConsumer));
            EnsureWriterForToday();
            _writer!.WriteLine(line);
        }
    }

    /// <inheritdoc />
    public void Flush()
    {
        lock (_lock)
        {
            _writer?.Flush();
        }
    }

    /// <inheritdoc />
    public void Close()
    {
        lock (_lock)
        {
            if (_closed) return;
            _closed = true;
            _writer?.Flush();
            _writer?.Dispose();
            _writer = null;
        }
    }

    /// <inheritdoc />
    public void Dispose()
    {
        Close();
    }

    private void EnsureWriterForToday()
    {
        string today = DateTime.UtcNow.ToString("yyyy-MM-dd", CultureInfo.InvariantCulture);
        if (_writer is null || !string.Equals(_currentDateStr, today, StringComparison.Ordinal))
        {
            _writer?.Flush();
            _writer?.Dispose();
            _currentDateStr = today;
            string path = Path.Combine(_directoryPath, $"{_filePrefix}.{today}.jsonl");
            var fs = new FileStream(path, FileMode.Append, FileAccess.Write, FileShare.ReadWrite);
            _writer = new StreamWriter(fs, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
        }
    }
}

/// <summary>
/// ABI C# (.NET) 服务端数据采集核心客户端（对标数数科技 ThinkingData C# Server SDK v3.4 <c>ThinkingDataAnalytics</c>）。
/// <para>
/// 提供并发安全的行为事件上报（<see cref="Track"/>）、
/// 首次事件（<see cref="TrackFirst"/>）、可更新事件（<see cref="TrackUpdate"/>）、
/// 可重写事件（<see cref="TrackOverwrite"/>）、
/// 动静态公共属性管理以及全部 7 类 <c>$user_*</c> 用户画像操作。
/// 任一事件或画像操作同时携带非空 <c>accountId</c>（<c>login_id</c>）与 <c>distinctId</c>（<c>distinct_id</c>）时，
/// 下游 Flink 实时完成全链路 ID-Mapping 自动关联。
/// </para>
/// </summary>
public sealed class AbiAnalytics : IDisposable
{
    private readonly IConsumer _consumer;
    private readonly object _superPropsLock = new();
    private readonly Dictionary<string, object?> _superProperties = new(StringComparer.Ordinal);
    private Func<IDictionary<string, object?>>? _dynamicSuperProperties;

    /// <summary>
    /// 使用指定的底层消费者创建 <see cref="AbiAnalytics"/> 实例（推荐在 ASP.NET Core 中注册为全局 Singleton）。
    /// </summary>
    /// <param name="consumer">底层事件消费者（<see cref="StagingConsumer"/>、<see cref="BatchConsumer"/>、<see cref="DebugConsumer"/> 或 <see cref="LoggerConsumer"/>）。</param>
    public AbiAnalytics(IConsumer consumer)
    {
        _consumer = consumer ?? throw new ArgumentNullException(nameof(consumer));
    }

    /// <summary>
    /// 注册全局静态公共属性（Super Properties），自动合并至后续所有非用户画像（非 <c>$user_*</c>）的行为事件中。
    /// </summary>
    public void SetSuperProperties(IDictionary<string, object?> properties)
    {
        var sanitized = AbiValidator.SanitizeProperties(properties);
        lock (_superPropsLock)
        {
            foreach (var kvp in sanitized)
            {
                _superProperties[kvp.Key] = kvp.Value;
            }
        }
    }

    /// <summary>
    /// 移除指定名称的全局静态公共属性。
    /// </summary>
    public void UnsetSuperProperty(string key)
    {
        if (string.IsNullOrWhiteSpace(key))
        {
            throw new ArgumentException("property key must not be null or empty", nameof(key));
        }
        lock (_superPropsLock)
        {
            _superProperties.Remove(key.Trim());
        }
    }

    /// <summary>
    /// 获取当前已注册的静态公共属性字典副本。
    /// </summary>
    public Dictionary<string, object?> GetSuperProperties()
    {
        lock (_superPropsLock)
        {
            return new Dictionary<string, object?>(_superProperties, StringComparer.Ordinal);
        }
    }

    /// <summary>
    /// 清空所有已注册的全局静态公共属性。
    /// </summary>
    public void ClearSuperProperties()
    {
        lock (_superPropsLock)
        {
            _superProperties.Clear();
        }
    }

    /// <summary>
    /// 注册动态公共属性回调委托，在每次上报行为事件时实时计算并合并。
    /// 属性优先级：显式事件属性 &gt; 动态公共属性 &gt; 静态公共属性；<c>$user_*</c> 画像事件自动隔离不注入公共属性。
    /// </summary>
    public void SetDynamicSuperProperties(Func<IDictionary<string, object?>>? provider)
    {
        _dynamicSuperProperties = provider;
    }

    /// <summary>
    /// 上报一条用户行为事件（双 ID 签名，对标 ThinkingData C# SDK <c>Track(accountId, distinctId, eventName, properties)</c>）。
    /// </summary>
    /// <param name="accountId">实名登录账号 ID（对应 <c>login_id</c>，≤ 128 UTF-8 字节；未登录访客传 <c>null</c> 或 <c>""</c>）。</param>
    /// <param name="distinctId">访客/设备 ID（对应 <c>distinct_id</c>，≤ 64 UTF-8 字节，如前端透传的 <c>X-ABI-Distinct-Id</c>；纯后端任务且已传 <paramref name="accountId"/> 时可传 <c>""</c>）。</param>
    /// <param name="eventName">事件名称（如 <c>OrderPaid</c>、<c>$pageview</c>）。</param>
    /// <param name="properties">事件属性字典（建议服务端在此传入客户端真实公网 <c>"#ip"</c> 及异步业务时间 <c>"#time"</c>）。</param>
    /// <param name="eventTime">可选：显式指定事件发生时间。</param>
    /// <returns>生成的幂等事件主键 <c>event_id</c>。</returns>
    public string Track(
        string? accountId,
        string? distinctId,
        string eventName,
        IDictionary<string, object?>? properties = null,
        DateTimeOffset? eventTime = null)
    {
        return TrackWithId(
            accountId: accountId,
            distinctId: distinctId,
            eventName: eventName,
            eventId: null,
            properties: properties,
            eventTime: eventTime);
    }

    /// <summary>
    /// 使用 <see cref="TrackOptions"/> 结构化选项上报事件。
    /// </summary>
    public string TrackWithOptions(TrackOptions options)
    {
        if (options is null) throw new ArgumentNullException(nameof(options));
        return TrackWithId(
            accountId: options.AccountId,
            distinctId: options.DistinctId,
            eventName: options.EventName,
            eventId: options.EventId,
            properties: options.Properties,
            eventTime: options.Timestamp);
    }

    /// <summary>
    /// 使用显式指定的确定性 <paramref name="eventId"/> 上报行为事件（适用于 MQ 消费幂等去重或配合 <see cref="TrackUpdate"/> 使用）。
    /// </summary>
    public string TrackWithId(
        string? accountId,
        string? distinctId,
        string eventName,
        string? eventId,
        IDictionary<string, object?>? properties = null,
        DateTimeOffset? eventTime = null)
    {
        var (normDistinct, normLogin) =
            AbiValidator.NormalizeIdentityPair(distinctId, accountId);
        string normEvent = AbiValidator.ValidateEventName(eventName);
        bool isUserEvent = AbiValidator.IsUserProfileEvent(normEvent);

        string resolvedEventId = !string.IsNullOrWhiteSpace(eventId)
            ? AbiValidator.NormalizeIdentity(eventId, AbiValidator.MaxEventIdBytes, "event_id")
            : Guid.NewGuid().ToString("D");

        long? extractedTimeMs = null;
        Dictionary<string, object?>? propsWithoutTime = null;
        if (properties is not null && properties.Count > 0)
        {
            propsWithoutTime = new Dictionary<string, object?>(properties.Count, StringComparer.Ordinal);
            bool hasHashTime = false;
            foreach (var kvp in properties)
            {
                string trimmedKey = (kvp.Key ?? string.Empty).Trim();
                if (string.Equals(trimmedKey, "#time", StringComparison.Ordinal))
                {
                    extractedTimeMs = AbiValidator.ParseTimeValue("#time", kvp.Value);
                    hasHashTime = true;
                }
                else if (string.Equals(trimmedKey, "$time", StringComparison.Ordinal))
                {
                    long dollarMs = AbiValidator.ParseTimeValue("$time", kvp.Value);
                    if (!hasHashTime)
                    {
                        extractedTimeMs = dollarMs;
                    }
                }
                else
                {
                    propsWithoutTime[kvp.Key!] = kvp.Value;
                }
            }
        }

        long resolvedTimestampMs;
        if (eventTime.HasValue)
        {
            resolvedTimestampMs = eventTime.Value.ToUnixTimeMilliseconds();
            if (resolvedTimestampMs <= 0)
            {
                throw new ArgumentException($"eventTime must be positive epoch millis: {resolvedTimestampMs}");
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

        var mergedProps = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            // 用户画像事件严格隔离公共属性与 SDK 环境属性
        };

        if (!isUserEvent)
        {
            lock (_superPropsLock)
            {
                foreach (var kvp in _superProperties)
                {
                    mergedProps[kvp.Key] = kvp.Value;
                }
            }

            var dynProvider = _dynamicSuperProperties;
            if (dynProvider is not null)
            {
                var dynRaw = dynProvider();
                if (dynRaw is not null && dynRaw.Count > 0)
                {
                    foreach (var kvp in AbiValidator.SanitizeProperties(dynRaw))
                    {
                        mergedProps[kvp.Key] = kvp.Value;
                    }
                }
            }
        }

        if (propsWithoutTime is not null && propsWithoutTime.Count > 0)
        {
            foreach (var kvp in AbiValidator.SanitizeProperties(propsWithoutTime))
            {
                mergedProps[kvp.Key] = kvp.Value;
            }
        }

        var record = new Dictionary<string, object?>(StringComparer.Ordinal)
        {
            ["event_id"] = resolvedEventId,
            ["event_name"] = normEvent,
            ["distinct_id"] = normDistinct
        };
        if (!string.IsNullOrEmpty(normLogin))
        {
            record["login_id"] = normLogin;
        }
        record["timestamp"] = resolvedTimestampMs;
        record["properties"] = mergedProps;

        _consumer.Add(record);
        return resolvedEventId;
    }

    /// <summary>
    /// 保留方法签名，但在当前版本显式抛出 <see cref="NotSupportedException"/> 且绝不入队伪造的普通 <c>track</c> 事件（D7① / G6 门禁）。
    /// <para><strong>[当前版本未开放 / Unsupported in current version]</strong> 详见 RESTFUL_API.md §3.3 (D7① / G6 gate)。建议直接使用 <see cref="TrackWithId"/> 携带确定性 eventId 保障同日重试幂等。</para>
    /// </summary>
    [Obsolete("当前版本未开放 (D7① / G6 gate)。ABI 推荐直接使用确定性 eventId 上报标准 track 事件。")]
    public string TrackFirst(
        string? accountId,
        string? distinctId,
        string eventName,
        string firstCheckId,
        IDictionary<string, object?>? properties = null)
    {
        throw new NotSupportedException(
            "TrackFirst is unsupported in current version (RESTFUL_API.md §3.3 D7① / G6 gate); use TrackWithId or TrackWithOptions for same-day idempotency.");
    }

    /// <summary>
    /// 保留方法签名，但在当前版本显式抛出 <see cref="NotSupportedException"/> 且绝不入队伪造的普通 <c>track</c> 事件（D7① / G6 门禁）。
    /// <para><strong>[当前版本未开放 / Unsupported in current version]</strong> 详见 RESTFUL_API.md §3.3 (D7① / G6 gate)。</para>
    /// </summary>
    [Obsolete("当前版本未开放 (D7① / G6 gate)。ABI 数据湖暂未开放历史事件属性就地更新能力。")]
    public string TrackUpdate(
        string? accountId,
        string? distinctId,
        string eventName,
        string eventId,
        IDictionary<string, object?>? properties = null)
    {
        throw new NotSupportedException(
            "TrackUpdate is unsupported in current version (RESTFUL_API.md §3.3 D7① / G6 gate); use TrackWithId or TrackWithOptions for same-day idempotency.");
    }

    /// <summary>
    /// 保留方法签名，但在当前版本显式抛出 <see cref="NotSupportedException"/> 且绝不入队伪造的普通 <c>track</c> 事件（D7① / G6 门禁）。
    /// <para><strong>[当前版本未开放 / Unsupported in current version]</strong> 详见 RESTFUL_API.md §3.3 (D7① / G6 gate)。</para>
    /// </summary>
    [Obsolete("当前版本未开放 (D7① / G6 gate)。ABI 数据湖暂未开放历史事件全量覆盖重写能力。")]
    public string TrackOverwrite(
        string? accountId,
        string? distinctId,
        string eventName,
        string eventId,
        IDictionary<string, object?>? properties = null)
    {
        throw new NotSupportedException(
            "TrackOverwrite is unsupported in current version (RESTFUL_API.md §3.3 D7① / G6 gate); use TrackWithId or TrackWithOptions for same-day idempotency.");
    }

    /// <summary>
    /// 覆盖设置用户画像属性（上报 <c>$user_set</c>，存在则覆盖，不存在则新增；自动隔离公共属性）。
    /// </summary>
    public string UserSet(string? accountId, string? distinctId, IDictionary<string, object?> properties)
    {
        return TrackWithId(accountId, distinctId, "$user_set", null, properties);
    }

    /// <summary>
    /// 仅在目标用户画像属性尚未设置时首次写入（上报 <c>$user_set_once</c>，适用于注册渠道、首单时间等归因字段）。
    /// </summary>
    public string UserSetOnce(string? accountId, string? distinctId, IDictionary<string, object?> properties)
    {
        return TrackWithId(accountId, distinctId, "$user_set_once", null, properties);
    }

    /// <summary>
    /// 对数值型用户画像属性执行原子累加/扣减（上报 <c>$user_add</c>，传入负数代表扣减）。
    /// </summary>
    public string UserAdd(string? accountId, string? distinctId, IDictionary<string, object?> properties)
    {
        if (properties is null || properties.Count == 0)
        {
            throw new ArgumentException("UserAdd requires at least one numeric property", nameof(properties));
        }
        foreach (var kvp in properties)
        {
            string trimmed = (kvp.Key ?? string.Empty).Trim();
            if (trimmed is "#time" or "$time") continue;
            if (kvp.Value is not (sbyte or byte or short or ushort or int or uint or long or ulong or float or double or decimal))
            {
                throw new ArgumentException($"UserAdd property \"{kvp.Key}\" must be a numeric type");
            }
        }
        return TrackWithId(accountId, distinctId, "$user_add", null, properties);
    }

    /// <summary>
    /// 清空一个或多个指定的用户画像属性键（上报 <c>$user_unset</c>，底层将目标键值置为 <c>0</c> 占位）。
    /// </summary>
    public string UserUnset(string? accountId, string? distinctId, params string[] keys)
    {
        if (keys is null || keys.Length == 0)
        {
            throw new ArgumentException("UserUnset requires at least one property key", nameof(keys));
        }
        var props = new Dictionary<string, object?>(keys.Length, StringComparer.Ordinal);
        foreach (string key in keys)
        {
            string validKey = AbiValidator.ValidatePropertyKey(key);
            props[validKey] = 0;
        }
        return TrackWithId(accountId, distinctId, "$user_unset", null, props);
    }

    /// <summary>
    /// 向列表（Array）类型的用户画像属性末尾追加元素，不去重（上报 <c>$user_append</c>）。
    /// </summary>
    public string UserAppend(string? accountId, string? distinctId, IDictionary<string, object?> properties)
    {
        ValidateListProfileProperties("$user_append", properties);
        return TrackWithId(accountId, distinctId, "$user_append", null, properties);
    }

    /// <summary>
    /// 向列表（Array）类型的用户画像属性追加元素并自动集合去重（上报 <c>$user_uniq_append</c>）。
    /// </summary>
    public string UserUniqAppend(string? accountId, string? distinctId, IDictionary<string, object?> properties)
    {
        ValidateListProfileProperties("$user_uniq_append", properties);
        return TrackWithId(accountId, distinctId, "$user_uniq_append", null, properties);
    }

    /// <summary>
    /// 标记删除当前主体的用户画像记录（上报 <c>$user_del</c>）。
    /// </summary>
    public string UserDelete(string? accountId, string? distinctId)
    {
        return TrackWithId(accountId, distinctId, "$user_del", null, null);
    }

    /// <summary>立即刷新底层消费者缓冲区中的全部待发送事件。</summary>
    public void Flush()
    {
        _consumer.Flush();
    }

    /// <summary>刷新剩余缓冲事件并安全关闭底层消费者。</summary>
    public void Close()
    {
        _consumer.Close();
    }

    /// <inheritdoc />
    public void Dispose()
    {
        Close();
    }

    private static void ValidateListProfileProperties(string opName, IDictionary<string, object?> properties)
    {
        if (properties is null || properties.Count == 0)
        {
            throw new ArgumentException($"{opName} requires non-empty properties", nameof(properties));
        }
        foreach (var kvp in properties)
        {
            string trimmed = (kvp.Key ?? string.Empty).Trim();
            if (trimmed is "#time" or "$time") continue;
            if (kvp.Value is null || kvp.Value is string || kvp.Value is not IEnumerable)
            {
                throw new ArgumentException($"{opName} property \"{kvp.Key}\" must be a 1D collection/array");
            }
        }
    }
}
