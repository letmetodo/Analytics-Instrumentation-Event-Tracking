-- ============================================================================
-- ABI Lua 数据采集 SDK (abi_sdk.lua)
-- 对标数数科技 ThinkingData Lua SDK v3.4 规范（支持 OpenResty / Skynet 服务端与 Cocos2d-Lua 客户端）
--
-- 核心能力：
-- 1. 纯 Lua 5.3+ 标准库实现（零第三方 C 扩展依赖），内置确定性格式化 JSON 编解码器与 UTF-8 校验器。
-- 2. 双模式支持：
--    - OpenResty / 游戏后端无状态模式：每次调用显式传入 account_id (login_id) / distinct_id 与客户端真实 "#ip"（如 ngx.var.remote_addr）。
--    - Cocos2d-Lua 游戏客户端有状态设备模式：支持 enable_client_mode、identify、login（仅本地设置 login_id，不覆盖 distinct_id、不发送任何网络事件）、
--      logout、time_event（秒表耗时自动计算 $duration）及客户端设备预置属性自动注入。
-- 3. 四大 Consumer：
--    - StagingConsumer：两步式「1. 预览完整请求 JSON -> 2. 确认后提交」。
--    - LoggerConsumer：本地 JSONL 按天/按小时轮转落盘（配合 Filebeat / Vector 采集）。
--    - BatchConsumer：内存缓冲批量上报（支持自定义 HTTP 回调或 OpenResty cosocket）。
--    - DebugConsumer：研发期同步 L4 强校验与 dry_run 零污染预检。
-- 4. 严格数据契约保护：
--    - 身份标识 UTF-8 校验、ASCII 控制字符拦截（0x00-0x08, 0x0E-0x1F, 0x7F）、Unicode 空白裁剪与 64/128 字节边界检查。
--    - 超过 IEEE-754 安全整数范围（> 2^53 - 1，即 9007199254740991）的 Lua 64 位整数自动转为十进制字符串。
--    - #time / $time 自动提取为顶层毫秒 timestamp 并从 properties 中剥离。
--    - 静态/动态公共属性与客户端设备预置属性在 7 类 $user_* 画像事件中严格隔离。
-- ============================================================================

local abi = {}

abi.MAX_EVENT_ID_BYTES     = 64
abi.MAX_DISTINCT_ID_BYTES  = 64
abi.MAX_LOGIN_ID_BYTES     = 128
abi.MAX_EVENT_NAME_CHARS   = 128
abi.MAX_CUSTOM_KEY_CHARS   = 64
abi.MAX_SAFE_INTEGER       = 9007199254740991 -- 2^53 - 1
abi.SDK_LIB_NAME           = "abi-lua-sdk"
abi.SDK_LIB_VERSION        = "1.0.0"

-- ============================================================================
-- 1. 系统预置事件与属性白名单
-- ============================================================================

local SYSTEM_EVENT_WHITELIST = {
    ["$signup"]            = true, ["$login"]             = true, ["$pageview"]      = true,
    ["$AppStart"]          = true, ["$AppEnd"]            = true, ["$AppClick"]      = true, ["$AppViewScreen"] = true,
    ["$user_set"]          = true, ["#user_set"]          = true,
    ["$user_set_once"]     = true, ["#user_set_once"]     = true,
    ["$user_add"]          = true, ["#user_add"]          = true,
    ["$user_unset"]        = true, ["#user_unset"]        = true,
    ["$user_append"]       = true, ["#user_append"]       = true,
    ["$user_uniq_append"]  = true, ["#user_uniq_append"]  = true,
    ["$user_del"]          = true, ["#user_del"]          = true,
}

local SYSTEM_PROPERTY_WHITELIST = {
    ["$os"] = true, ["#os"] = true, ["os"] = true,
    ["$os_version"] = true, ["#os_version"] = true, ["os_version"] = true,
    ["$app_version"] = true, ["#app_version"] = true, ["app_version"] = true,
    ["$browser"] = true, ["#browser"] = true, ["browser"] = true,
    ["$browser_version"] = true, ["#browser_version"] = true, ["browser_version"] = true,
    ["$city"] = true, ["#city"] = true, ["city"] = true,
    ["$province"] = true, ["#province"] = true, ["province"] = true,
    ["$country"] = true, ["#country"] = true, ["country"] = true,
    ["$country_code"] = true, ["#country_code"] = true, ["country_code"] = true,
    ["$ip"] = true, ["#ip"] = true, ["ip"] = true,
    ["$network"] = true, ["#network"] = true, ["network"] = true,
    ["$network_type"] = true, ["#network_type"] = true, ["network_type"] = true,
    ["$platform"] = true, ["#platform"] = true, ["platform"] = true,
    ["$device_id"] = true, ["#device_id"] = true, ["device_id"] = true,
    ["$session_id"] = true, ["#session_id"] = true, ["session_id"] = true,
    ["$screen_width"] = true, ["#screen_width"] = true, ["screen_width"] = true,
    ["$screen_height"] = true, ["#screen_height"] = true, ["screen_height"] = true,
    ["$model"] = true, ["#model"] = true, ["model"] = true,
    ["$device_model"] = true, ["#device_model"] = true, ["device_model"] = true,
    ["$manufacturer"] = true, ["#manufacturer"] = true, ["manufacturer"] = true,
    ["$carrier"] = true, ["#carrier"] = true, ["carrier"] = true,
    ["$url"] = true, ["#url"] = true, ["url"] = true,
    ["$url_path"] = true, ["#url_path"] = true, ["url_path"] = true,
    ["$referrer"] = true, ["#referrer"] = true, ["referrer"] = true,
    ["$title"] = true, ["#title"] = true, ["title"] = true,
    ["$duration"] = true, ["#duration"] = true, ["duration"] = true,
    ["$lib"] = true, ["#lib"] = true, ["lib"] = true,
    ["$lib_version"] = true, ["#lib_version"] = true, ["lib_version"] = true,
    ["$zone_offset"] = true, ["#zone_offset"] = true, ["zone_offset"] = true,
    ["$first_check_id"] = true, ["#first_check_id"] = true, ["first_check_id"] = true,
}

-- ============================================================================
-- 2. 基础工具：时间、UUIDv4、深拷贝与 UTF-8 解码
-- ============================================================================

local uuid_seq = 0
local rng_seeded = false

local function current_unix_millis()
    if type(ngx) == "table" and type(ngx.now) == "function" then
        return math.floor(ngx.now() * 1000)
    end
    local sec = os.time()
    local clk = math.floor((os.clock() * 1000) % 1000)
    return sec * 1000 + clk
end

--- 生成标准 RFC 4122 UUIDv4 字符串
function abi.generate_uuid_v4()
    if not rng_seeded then
        math.randomseed(os.time() ~ math.floor(os.clock() * 1000000))
        rng_seeded = true
    end
    uuid_seq = (uuid_seq + 1) & 0xFFFF
    local bytes = {}
    for i = 1, 16 do
        bytes[i] = math.random(0, 255)
    end
    bytes[1] = (bytes[1] ~ ((uuid_seq >> 8) & 0xFF)) & 0xFF
    bytes[2] = (bytes[2] ~ (uuid_seq & 0xFF)) & 0xFF
    bytes[7] = (bytes[7] & 0x0F) | 0x40
    bytes[9] = (bytes[9] & 0x3F) | 0x80
    return string.format(
        "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
        bytes[1], bytes[2], bytes[3], bytes[4],
        bytes[5], bytes[6],
        bytes[7], bytes[8],
        bytes[9], bytes[10],
        bytes[11], bytes[12], bytes[13], bytes[14], bytes[15], bytes[16]
    )
end

local function trim_ascii(s)
    if type(s) ~= "string" then
        return ""
    end
    return (s:gsub("^[ \t\r\n]+", ""):gsub("[ \t\r\n]+$", ""))
end

local function deep_copy(val)
    if type(val) ~= "table" then
        return val
    end
    local copy = {}
    for k, v in pairs(val) do
        copy[k] = deep_copy(v)
    end
    local mt = getmetatable(val)
    if mt then
        setmetatable(copy, mt)
    end
    return copy
end

local ARRAY_MT = { __abi_is_array = true }

--- 标记一个空表或一维表为 JSON 数组
function abi.array(tbl)
    local t = tbl or {}
    return setmetatable(t, ARRAY_MT)
end

local function is_unicode_whitespace(cp)
    if cp == 0x09 or cp == 0x0A or cp == 0x0B or cp == 0x0C or cp == 0x0D or cp == 0x20 then
        return true
    end
    if cp == 0x0085 or cp == 0x00A0 or cp == 0x1680 then
        return true
    end
    if cp >= 0x2000 and cp <= 0x200A then
        return true
    end
    if cp == 0x2028 or cp == 0x2029 or cp == 0x202F or cp == 0x205F or cp == 0x3000 then
        return true
    end
    return false
end

local function is_forbidden_control_char(cp)
    if cp < 0x20 and (cp < 0x09 or cp > 0x0D) then
        return true
    end
    return cp == 0x7F
end

--- 严格解码 UTF-8 字符串并返回码点数组 {{cp=..., start_byte=..., end_byte=...}, ...}
local function decode_utf8(s)
    if type(s) ~= "string" then
        return nil, "identity must be a string"
    end
    local spans = {}
    local i = 1
    local n = #s
    while i <= n do
        local b0 = string.byte(s, i)
        if b0 < 0x80 then
            spans[#spans + 1] = { cp = b0, start_byte = i, end_byte = i }
            i = i + 1
        elseif (b0 & 0xE0) == 0xC0 then
            if i + 1 > n then return nil, "invalid UTF-8 truncated 2-byte sequence" end
            local b1 = string.byte(s, i + 1)
            if (b1 & 0xC0) ~= 0x80 then return nil, "invalid UTF-8 continuation byte" end
            local cp = ((b0 & 0x1F) << 6) | (b1 & 0x3F)
            if cp < 0x80 then return nil, "invalid UTF-8 overlong 2-byte encoding" end
            spans[#spans + 1] = { cp = cp, start_byte = i, end_byte = i + 1 }
            i = i + 2
        elseif (b0 & 0xF0) == 0xE0 then
            if i + 2 > n then return nil, "invalid UTF-8 truncated 3-byte sequence" end
            local b1 = string.byte(s, i + 1)
            local b2 = string.byte(s, i + 2)
            if (b1 & 0xC0) ~= 0x80 or (b2 & 0xC0) ~= 0x80 then return nil, "invalid UTF-8 continuation byte" end
            local cp = ((b0 & 0x0F) << 12) | ((b1 & 0x3F) << 6) | (b2 & 0x3F)
            if cp < 0x800 then return nil, "invalid UTF-8 overlong 3-byte encoding" end
            if cp >= 0xD800 and cp <= 0xDFFF then return nil, "invalid UTF-8 surrogate codepoint" end
            spans[#spans + 1] = { cp = cp, start_byte = i, end_byte = i + 2 }
            i = i + 3
        elseif (b0 & 0xF8) == 0xF0 then
            if i + 3 > n then return nil, "invalid UTF-8 truncated 4-byte sequence" end
            local b1 = string.byte(s, i + 1)
            local b2 = string.byte(s, i + 2)
            local b3 = string.byte(s, i + 3)
            if (b1 & 0xC0) ~= 0x80 or (b2 & 0xC0) ~= 0x80 or (b3 & 0xC0) ~= 0x80 then
                return nil, "invalid UTF-8 continuation byte"
            end
            local cp = ((b0 & 0x07) << 18) | ((b1 & 0x3F) << 12) | ((b2 & 0x3F) << 6) | (b3 & 0x3F)
            if cp < 0x10000 or cp > 0x10FFFF then return nil, "invalid UTF-8 4-byte codepoint" end
            spans[#spans + 1] = { cp = cp, start_byte = i, end_byte = i + 3 }
            i = i + 4
        else
            return nil, "invalid UTF-8 leading byte"
        end
    end
    return spans, nil
end

-- ============================================================================
-- 3. 身份校验、事件名/属性键校验、大整数转字符串与 #time/$time 提取
-- ============================================================================

--- 规范化并校验身份标识（UTF-8 校验 -> 拦截控制字符 -> 裁剪首尾 Unicode 空白符 -> 校验 UTF-8 字节长度上限）
function abi.normalize_identity(val, max_utf8_bytes)
    if val == nil then
        return ""
    end
    if type(val) ~= "string" then
        error("identity must be a string", 2)
    end
    local spans, dec_err = decode_utf8(val)
    if not spans then
        error("identity is not valid UTF-8: " .. tostring(dec_err), 2)
    end
    for _, sp in ipairs(spans) do
        if is_forbidden_control_char(sp.cp) then
            error(string.format("identity contains control character U+%04X", sp.cp), 2)
        end
    end
    local first = 1
    while first <= #spans and is_unicode_whitespace(spans[first].cp) do
        first = first + 1
    end
    local last = #spans
    while last >= first and is_unicode_whitespace(spans[last].cp) do
        last = last - 1
    end
    local trimmed = ""
    if first <= last then
        trimmed = string.sub(val, spans[first].start_byte, spans[last].end_byte)
    end
    if #trimmed > max_utf8_bytes then
        error(string.format("identity exceeds max length of %d UTF-8 bytes (got %d)", max_utf8_bytes, #trimmed), 2)
    end
    return trimmed
end

--- 联合校验并规范化双身份字段（distinct_id <= 64 UTF-8 字节，login_id <= 128 UTF-8 字节，且至少一个非空）
function abi.normalize_identity_pair(distinct_id, login_id)
    local norm_distinct = abi.normalize_identity(distinct_id or "", abi.MAX_DISTINCT_ID_BYTES)
    local norm_login    = abi.normalize_identity(login_id or "", abi.MAX_LOGIN_ID_BYTES)
    if #norm_distinct == 0 and #norm_login == 0 then
        error("at least one of login_id (account_id) or distinct_id must be non-empty", 2)
    end
    return norm_distinct, norm_login
end

local function is_valid_identifier(s)
    if type(s) ~= "string" or #s == 0 then
        return false
    end
    return s:match("^[A-Za-z_][A-Za-z0-9_]*$") ~= nil
end

--- 校验事件名称（自定义事件名匹配 ^[A-Za-z_][A-Za-z0-9_]*$ 或属于系统预置事件白名单，上限 128 字符）
function abi.validate_event_name(name)
    if type(name) ~= "string" then
        error("event_name must be a string", 2)
    end
    local trimmed = trim_ascii(name)
    if #trimmed == 0 then
        error("event_name must not be empty", 2)
    end
    if #trimmed > abi.MAX_EVENT_NAME_CHARS then
        error("event_name exceeds 128 characters", 2)
    end
    if SYSTEM_EVENT_WHITELIST[trimmed] then
        return trimmed
    end
    if not is_valid_identifier(trimmed) then
        error(string.format('invalid event_name "%s": must match ^[A-Za-z_][A-Za-z0-9_]*$', trimmed), 2)
    end
    return trimmed
end

--- 校验属性键名（匹配 ^[A-Za-z_][A-Za-z0-9_]*$ 且 <= 64 字符，或属于系统预置属性白名单）
function abi.validate_property_key(key)
    if type(key) ~= "string" then
        error("property key must be a string", 2)
    end
    local trimmed = trim_ascii(key)
    if #trimmed == 0 then
        error("property key must not be empty", 2)
    end
    if SYSTEM_PROPERTY_WHITELIST[trimmed] then
        return trimmed
    end
    if #trimmed > abi.MAX_CUSTOM_KEY_CHARS or not is_valid_identifier(trimmed) then
        error(string.format('invalid property key "%s": must match ^[A-Za-z_][A-Za-z0-9_]*$ (max 64 chars)', trimmed), 2)
    end
    return trimmed
end

local function normalize_number_value(key, v)
    if math.type(v) == "integer" then
        if v == math.mininteger or v > abi.MAX_SAFE_INTEGER or v < -abi.MAX_SAFE_INTEGER then
            return tostring(v)
        end
        return v
    end
    -- float
    if v ~= v or v == math.huge or v == -math.huge then
        error(string.format('property "%s" has non-finite float value', key), 2)
    end
    return v
end

local function is_array_table(t)
    local mt = getmetatable(t)
    if mt and mt.__abi_is_array then
        return true
    end
    local count = 0
    for k, _ in pairs(t) do
        if math.type(k) ~= "integer" or k < 1 then
            return false
        end
        count = count + 1
    end
    if count == 0 then
        return false
    end
    for i = 1, count do
        if rawget(t, i) == nil then
            error("array table cannot contain nil holes", 3)
        end
    end
    return true
end

local function sanitize_list_element(key, elem)
    local tp = type(elem)
    if tp == "boolean" or tp == "string" then
        return elem
    elseif tp == "number" then
        return normalize_number_value(key, elem)
    else
        error(string.format('property "%s" list contains unsupported element type %s', key, tp), 3)
    end
end

local function sanitize_property_value(key, val)
    local tp = type(val)
    if tp == "boolean" or tp == "string" then
        return val
    elseif tp == "number" then
        return normalize_number_value(key, val)
    elseif tp == "table" then
        local mt = getmetatable(val)
        local is_explicit_arr = mt and mt.__abi_is_array
        if not is_explicit_arr and next(val) == nil then
            error(string.format('property "%s" cannot be an empty map object', key), 3)
        end
        if not is_array_table(val) then
            error(string.format('property "%s" nested object map is not supported', key), 3)
        end
        local out = abi.array({})
        for i = 1, #val do
            local elem = rawget(val, i)
            if elem == nil then
                error(string.format('property "%s" list contains nil element at index %d', key, i), 3)
            end
            out[i] = sanitize_list_element(key, elem)
        end
        return out
    else
        error(string.format('property "%s" has unsupported value type %s', key, tp), 3)
    end
end

--- 清洗并校验属性字典（将超过 2^53-1 的 64 位整数自动转为十进制字符串，拦截 NaN/Inf 与非法键名）
function abi.sanitize_properties(props)
    if props == nil then
        return {}
    end
    if type(props) ~= "table" then
        error("properties must be a table", 2)
    end
    local out = {}
    for raw_k, raw_v in pairs(props) do
        local k = abi.validate_property_key(raw_k)
        if raw_v ~= nil then
            out[k] = sanitize_property_value(k, raw_v)
        end
    end
    return out
end

--- 将公历 UTC 年月日时分秒转换为 Unix 秒数（无视宿主本地时区偏移）
local function timegm_utc(year, month, day, hour, min, sec)
    local y = year
    local m = month
    if m <= 2 then
        y = y - 1
        m = m + 12
    end
    local era = math.floor(y / 400)
    local yoe = y - era * 400
    local doy = math.floor((153 * (m - 3) + 2) / 5) + day - 1
    local doe = yoe * 365 + math.floor(yoe / 4) - math.floor(yoe / 100) + doy
    local days = era * 146097 + doe - 719468
    return days * 86400 + hour * 3600 + min * 60 + sec
end

local function parse_datetime_string_ms(raw)
    local s = trim_ascii(raw)
    local y, m, d, sep, hh, mm, ss, rest = s:match("^(%d%d%d%d)%-(%d%d)%-(%d%d)([T t])(%d%d):(%d%d):(%d%d)(.*)$")
    if not y then
        return nil
    end
    local year_n  = tonumber(y)
    local month_n = tonumber(m)
    local day_n   = tonumber(d)
    local hour_n  = tonumber(hh)
    local min_n   = tonumber(mm)
    local sec_n   = tonumber(ss)
    if month_n < 1 or month_n > 12 or day_n < 1 or day_n > 31 or hour_n > 23 or min_n > 59 or sec_n > 60 then
        return nil
    end

    local millis = 0
    if rest:sub(1, 1) == "." then
        local frac, after_frac = rest:match("^%.(%d+)(.*)$")
        if not frac then
            return nil
        end
        local sub3 = frac:sub(1, 3)
        while #sub3 < 3 do
            sub3 = sub3 .. "0"
        end
        millis = tonumber(sub3)
        rest = after_frac
    end

    local epoch_sec
    if rest == "" then
        epoch_sec = os.time({
            year  = year_n,
            month = month_n,
            day   = day_n,
            hour  = hour_n,
            min   = min_n,
            sec   = sec_n,
            isdst = false,
        })
    elseif rest == "Z" or rest == "z" then
        epoch_sec = timegm_utc(year_n, month_n, day_n, hour_n, min_n, sec_n)
    else
        local sign, tzh, tzm = rest:match("^([%+%-])(%d%d):?(%d%d)$")
        if not sign then
            return nil
        end
        local offset = tonumber(tzh) * 3600 + tonumber(tzm) * 60
        if sign == "-" then
            offset = -offset
        end
        epoch_sec = timegm_utc(year_n, month_n, day_n, hour_n, min_n, sec_n) - offset
    end
    return epoch_sec * 1000 + millis
end

local function parse_event_time_value(key, raw)
    if type(raw) == "number" and math.type(raw) == "integer" then
        if raw <= 0 then
            error(string.format("invalid %s property: unix timestamp must be positive", key), 3)
        end
        if raw >= 100000000000 then
            return raw
        end
        return raw * 1000
    elseif type(raw) == "string" then
        local ms = parse_datetime_string_ms(raw)
        if not ms then
            error(string.format('invalid %s property string: "%s"', key, raw), 3)
        end
        return ms
    else
        error(string.format("invalid %s property: unsupported value type %s", key, type(raw)), 3)
    end
end

local function extract_event_time_and_strip(props, explicit_ts_ms)
    if type(props) ~= "table" then
        return {}, explicit_ts_ms
    end
    local stripped = {}
    local has_hash_time = false
    local hash_time_val = nil
    local has_dollar_time = false
    local dollar_time_val = nil

    for k, v in pairs(props) do
        local trimmed = (type(k) == "string") and trim_ascii(k) or k
        if trimmed == "#time" then
            has_hash_time = true
            hash_time_val = v
        elseif trimmed == "$time" then
            has_dollar_time = true
            dollar_time_val = v
        else
            stripped[k] = v
        end
    end

    if explicit_ts_ms and explicit_ts_ms > 0 then
        return stripped, explicit_ts_ms
    end

    local resolved_ts = nil
    if has_dollar_time then
        resolved_ts = parse_event_time_value("$time", dollar_time_val)
    end
    if has_hash_time then
        resolved_ts = parse_event_time_value("#time", hash_time_val)
    end
    return stripped, resolved_ts
end

-- ============================================================================
-- 4. 纯 Lua 标准 JSON 编解码器（支持确定性缩进美化与 UTF-16 代理对解码）
-- ============================================================================

local function escape_json_str(s)
    local replacements = {
        ['"']  = '\\"',
        ['\\'] = '\\\\',
        ['\b'] = '\\b',
        ['\f'] = '\\f',
        ['\n'] = '\\n',
        ['\r'] = '\\r',
        ['\t'] = '\\t',
    }
    local escaped = s:gsub('[%z\1-\31"\\]', function(c)
        return replacements[c] or string.format("\\u%04x", string.byte(c))
    end)
    return '"' .. escaped .. '"'
end

local function serialize_value_json(val, indent_level, pretty)
    local tp = type(val)
    if val == nil then
        return "null"
    elseif tp == "boolean" then
        return val and "true" or "false"
    elseif tp == "number" then
        if math.type(val) == "integer" then
            return tostring(val)
        end
        return string.format("%.15g", val)
    elseif tp == "string" then
        return escape_json_str(val)
    elseif tp == "table" then
        local mt = getmetatable(val)
        local is_arr = (mt and mt.__abi_is_array) or (#val > 0)
        if is_arr then
            if #val == 0 then
                return "[]"
            end
            local child_ind = pretty and string.rep("  ", indent_level + 1) or ""
            local end_ind   = pretty and string.rep("  ", indent_level) or ""
            local parts = {}
            for i = 1, #val do
                parts[i] = (pretty and ("\n" .. child_ind) or "") .. serialize_value_json(val[i], indent_level + 1, pretty)
            end
            return "[" .. table.concat(parts, ",") .. (pretty and ("\n" .. end_ind) or "") .. "]"
        else
            local keys = {}
            for k, _ in pairs(val) do
                keys[#keys + 1] = k
            end
            table.sort(keys)
            if #keys == 0 then
                return "{}"
            end
            local child_ind = pretty and string.rep("  ", indent_level + 1) or ""
            local end_ind   = pretty and string.rep("  ", indent_level) or ""
            local sp        = pretty and " " or ""
            local parts = {}
            for i, k in ipairs(keys) do
                parts[i] = (pretty and ("\n" .. child_ind) or "") ..
                           escape_json_str(tostring(k)) .. ":" .. sp ..
                           serialize_value_json(val[k], indent_level + 1, pretty)
            end
            return "{" .. table.concat(parts, ",") .. (pretty and ("\n" .. end_ind) or "") .. "}"
        end
    end
    return "null"
end

local function serialize_event_json(evt, indent_level, pretty)
    local ind0 = pretty and string.rep("  ", indent_level) or ""
    local ind1 = pretty and string.rep("  ", indent_level + 1) or ""
    local nl   = pretty and "\n" or ""
    local sp   = pretty and " " or ""

    local fields = {}
    if evt.event_id and #evt.event_id > 0 then
        fields[#fields + 1] = ind1 .. '"event_id":' .. sp .. escape_json_str(evt.event_id)
    end
    fields[#fields + 1] = ind1 .. '"event_name":' .. sp .. escape_json_str(evt.event_name)
    fields[#fields + 1] = ind1 .. '"distinct_id":' .. sp .. escape_json_str(evt.distinct_id)
    if evt.login_id and #evt.login_id > 0 then
        fields[#fields + 1] = ind1 .. '"login_id":' .. sp .. escape_json_str(evt.login_id)
    end
    fields[#fields + 1] = ind1 .. '"timestamp":' .. sp .. tostring(evt.timestamp)
    fields[#fields + 1] = ind1 .. '"properties":' .. sp .. serialize_value_json(evt.properties or {}, indent_level + 1, pretty)

    return "{" .. nl .. table.concat(fields, "," .. nl) .. nl .. ind0 .. "}"
end

local function serialize_batch_payload_json(payload, pretty)
    local ind1 = pretty and "  " or ""
    local nl   = pretty and "\n" or ""
    local sp   = pretty and " " or ""

    local lines = {}
    lines[#lines + 1] = ind1 .. '"project_id":' .. sp .. tostring(payload.project_id)
    lines[#lines + 1] = ind1 .. '"project_token":' .. sp .. escape_json_str(payload.project_token)
    if payload.debug then
        lines[#lines + 1] = ind1 .. '"debug":' .. sp .. "true"
    end
    if payload.dry_run then
        lines[#lines + 1] = ind1 .. '"dry_run":' .. sp .. "true"
    end

    local evts = payload.events or {}
    if #evts == 0 then
        lines[#lines + 1] = ind1 .. '"events":' .. sp .. "[]"
    else
        local evt_strs = {}
        for i, evt in ipairs(evts) do
            evt_strs[i] = (pretty and "    " or "") .. serialize_event_json(evt, 2, pretty)
        end
        lines[#lines + 1] = ind1 .. '"events":' .. sp .. "[" .. nl .. table.concat(evt_strs, "," .. nl) .. nl .. ind1 .. "]"
    end

    return "{" .. nl .. table.concat(lines, "," .. nl) .. nl .. "}"
end

local function serialize_envelope_json(env, pretty)
    local is_pretty = (pretty ~= false)
    local ind1 = is_pretty and "  " or ""
    local ind2 = is_pretty and "    " or ""
    local nl   = is_pretty and "\n" or ""
    local sp   = is_pretty and " " or ""

    local data = env.data or {}
    local out = "{" .. nl ..
        ind1 .. '"code":' .. sp .. tostring(env.code or 200) .. "," .. nl ..
        ind1 .. '"message":' .. sp .. escape_json_str(env.message or "success") .. "," .. nl ..
        ind1 .. '"request_id":' .. sp .. escape_json_str(env.request_id or "") .. "," .. nl ..
        ind1 .. '"data":' .. sp .. "{" .. nl ..
        ind2 .. '"accepted":' .. sp .. tostring(data.accepted or 0) .. "," .. nl ..
        ind2 .. '"rejected":' .. sp .. tostring(data.rejected or 0) .. "," .. nl ..
        ind2 .. '"dry_run":' .. sp .. ((data.dry_run and "true") or "false") .. nl ..
        ind1 .. "}" .. nl ..
        "}"
    return out
end

--- 纯 Lua JSON 解析器（支持测试向量与网关响应解析）
function abi.json_decode(str)
    local pos = 1
    local n = #str

    local function skip_ws()
        while pos <= n do
            local b = string.byte(str, pos)
            if b == 0x20 or b == 0x09 or b == 0x0A or b == 0x0D then
                pos = pos + 1
            else
                break
            end
        end
    end

    local parse_value

    local function parse_string()
        pos = pos + 1 -- skip '"'
        local out = {}
        while pos <= n do
            local c = str:sub(pos, pos)
            if c == '"' then
                pos = pos + 1
                return table.concat(out)
            elseif c == "\\" then
                pos = pos + 1
                local esc = str:sub(pos, pos)
                if esc == '"' or esc == "\\" or esc == "/" then
                    out[#out + 1] = esc
                    pos = pos + 1
                elseif esc == "b" then out[#out + 1] = "\b"; pos = pos + 1
                elseif esc == "f" then out[#out + 1] = "\f"; pos = pos + 1
                elseif esc == "n" then out[#out + 1] = "\n"; pos = pos + 1
                elseif esc == "r" then out[#out + 1] = "\r"; pos = pos + 1
                elseif esc == "t" then out[#out + 1] = "\t"; pos = pos + 1
                elseif esc == "u" then
                    local hex = str:sub(pos + 1, pos + 4)
                    local cp = tonumber(hex, 16)
                    pos = pos + 5
                    if cp >= 0xD800 and cp <= 0xDBFF and str:sub(pos, pos + 1) == "\\u" then
                        local low = tonumber(str:sub(pos + 2, pos + 5), 16)
                        if low and low >= 0xDC00 and low <= 0xDFFF then
                            cp = 0x10000 + ((cp - 0xD800) << 10) + (low - 0xDC00)
                            pos = pos + 6
                        end
                    end
                    out[#out + 1] = utf8.char(cp)
                else
                    error("invalid JSON escape at position " .. pos)
                end
            else
                out[#out + 1] = c
                pos = pos + 1
            end
        end
        error("unterminated JSON string")
    end

    local function parse_number()
        local start_p = pos
        local num_str = str:match("^[%-]?%d+%.?%d*[eE]?[%+%-]?%d*", pos)
        pos = start_p + #num_str
        return tonumber(num_str)
    end

    local function parse_array()
        pos = pos + 1 -- skip '['
        local arr = abi.array({})
        skip_ws()
        if str:sub(pos, pos) == "]" then
            pos = pos + 1
            return arr
        end
        while pos <= n do
            skip_ws()
            arr[#arr + 1] = parse_value()
            skip_ws()
            local ch = str:sub(pos, pos)
            if ch == "]" then
                pos = pos + 1
                return arr
            elseif ch == "," then
                pos = pos + 1
            else
                error("expected ',' or ']' in JSON array at pos " .. pos)
            end
        end
        error("unterminated JSON array")
    end

    local function parse_object()
        pos = pos + 1 -- skip '{'
        local obj = {}
        skip_ws()
        if str:sub(pos, pos) == "}" then
            pos = pos + 1
            return obj
        end
        while pos <= n do
            skip_ws()
            if str:sub(pos, pos) ~= '"' then
                error("expected string key in JSON object at pos " .. pos)
            end
            local key = parse_string()
            skip_ws()
            if str:sub(pos, pos) ~= ":" then
                error("expected ':' in JSON object at pos " .. pos)
            end
            pos = pos + 1
            skip_ws()
            obj[key] = parse_value()
            skip_ws()
            local ch = str:sub(pos, pos)
            if ch == "}" then
                pos = pos + 1
                return obj
            elseif ch == "," then
                pos = pos + 1
            else
                error("expected ',' or '}' in JSON object at pos " .. pos)
            end
        end
        error("unterminated JSON object")
    end

    parse_value = function()
        skip_ws()
        local ch = str:sub(pos, pos)
        if ch == '"' then
            return parse_string()
        elseif ch == "{" then
            return parse_object()
        elseif ch == "[" then
            return parse_array()
        elseif ch == "t" and str:sub(pos, pos + 3) == "true" then
            pos = pos + 4
            return true
        elseif ch == "f" and str:sub(pos, pos + 4) == "false" then
            pos = pos + 5
            return false
        elseif ch == "n" and str:sub(pos, pos + 3) == "null" then
            pos = pos + 4
            return nil
        else
            return parse_number()
        end
    end

    return parse_value()
end

-- ============================================================================
-- 5. 四大 Consumer 实现 (StagingConsumer / LoggerConsumer / BatchConsumer / DebugConsumer)
-- ============================================================================

local mock_seq = 0
local function default_mock_gateway_transport(payload)
    mock_seq = mock_seq + 1
    return {
        code       = 200,
        message    = "success",
        request_id = "req_lua_sdk_" .. tostring(mock_seq),
        data       = {
            accepted = #(payload.events or {}),
            rejected = 0,
            dry_run  = payload.dry_run and true or false,
        },
    }
end

--- 5.1 StagingConsumer：两步式「1. 预览完整请求 JSON -> 2. 确认后提交」内存暂存消费者
local StagingConsumer = {}
StagingConsumer.__index = StagingConsumer

function StagingConsumer.new(project_id, project_token, dry_run)
    if type(project_id) ~= "number" or project_id <= 0 then
        error("project_id must be positive", 2)
    end
    local token = trim_ascii(project_token or "")
    if #token == 0 then
        error("project_token must not be empty", 2)
    end
    return setmetatable({
        project_id    = project_id,
        project_token = token,
        debug         = false,
        dry_run       = dry_run and true or false,
        _events       = {},
    }, StagingConsumer)
end

function StagingConsumer:add(event)
    self._events[#self._events + 1] = deep_copy(event)
end

function StagingConsumer:flush()
    -- StagingConsumer 在调用 confirm_submit / submit_to_gateway 前绝不静默发送
end

function StagingConsumer:close()
end

function StagingConsumer:set_debug(debug_flag)
    self.debug = debug_flag and true or false
end

function StagingConsumer:set_dry_run(dry_run_flag)
    self.dry_run = dry_run_flag and true or false
end

function StagingConsumer:reset()
    self._events = {}
end

function StagingConsumer:events()
    return deep_copy(self._events)
end

function StagingConsumer:build_request_payload()
    return {
        project_id    = self.project_id,
        project_token = self.project_token,
        debug         = self.debug,
        dry_run       = self.dry_run,
        events        = deep_copy(self._events),
    }
end

function StagingConsumer:preview_request_json(pretty)
    local is_pretty = (pretty ~= false)
    return serialize_batch_payload_json(self:build_request_payload(), is_pretty)
end

function StagingConsumer:confirm_submit(target_consumer)
    if not target_consumer or target_consumer == self then
        error("valid target_consumer is required for confirm_submit", 2)
    end
    local snapshot = self:events()
    for _, evt in ipairs(snapshot) do
        target_consumer:add(evt)
    end
    target_consumer:flush()
    self:reset()
end

function StagingConsumer:submit_to_gateway(opts)
    opts = opts or {}
    local payload = self:build_request_payload()
    if #payload.events == 0 then
        error("staging consumer has no pending events to submit", 2)
    end
    local req_json = serialize_batch_payload_json(payload, false)
    local env
    if type(opts.transport) == "function" then
        local url = trim_ascii(opts.server_url or "http://127.0.0.1:8081"):gsub("/+$", "") .. "/collect/api/v1/track/batch"
        env = opts.transport(url, req_json, payload.debug, payload.dry_run)
    else
        env = default_mock_gateway_transport(payload)
    end
    local resp_json = serialize_envelope_json(env, true)
    self:reset()
    return env, resp_json
end

abi.StagingConsumer = StagingConsumer
abi.new_staging_consumer = StagingConsumer.new

--- 5.2 LoggerConsumer：本地 JSONL（Newline-delimited JSON）轮转落盘消费者
local LoggerConsumer = {}
LoggerConsumer.__index = LoggerConsumer

function LoggerConsumer.new(cfg)
    if type(cfg) == "string" then
        cfg = { file_path = cfg }
    end
    cfg = cfg or {}
    return setmetatable({
        file_path       = cfg.file_path or "",
        directory       = cfg.directory or "/tmp",
        file_prefix     = cfg.file_prefix or "abi.log",
        rotate_mode     = cfg.rotate_mode or "DAILY",
        max_file_size_mb = cfg.max_file_size_mb or 256,
        _lines          = {},
    }, LoggerConsumer)
end

function LoggerConsumer:_resolve_path()
    if #self.file_path > 0 then
        return self.file_path
    end
    if #self.directory == 0 then
        return ""
    end
    local fmt = (self.rotate_mode == "HOURLY") and "%Y-%m-%d-%H" or "%Y-%m-%d"
    return self.directory .. "/" .. self.file_prefix .. "." .. os.date(fmt)
end

function LoggerConsumer:add(event)
    local line = serialize_event_json(event, 0, false)
    self._lines[#self._lines + 1] = line
    local path = self:_resolve_path()
    if #path > 0 then
        local fp, err = io.open(path, "ab")
        if not fp then
            error("failed to open log file " .. path .. ": " .. tostring(err), 2)
        end
        fp:write(line .. "\n")
        fp:flush()
        fp:close()
    end
end

function LoggerConsumer:flush() end
function LoggerConsumer:close() end
function LoggerConsumer:logged_lines() return deep_copy(self._lines) end

abi.LoggerConsumer = LoggerConsumer
abi.new_logger_consumer = LoggerConsumer.new

--- 5.3 BatchConsumer：生产高吞吐内存缓冲批量消费者
local BatchConsumer = {}
BatchConsumer.__index = BatchConsumer

function BatchConsumer.new(cfg)
    cfg = cfg or {}
    local project_id = cfg.project_id or 1
    local token = trim_ascii(cfg.project_token or "abi_tok_default")
    if project_id <= 0 then
        error("BatchConsumer project_id must be positive", 2)
    end
    if #token == 0 then
        error("BatchConsumer project_token must not be empty", 2)
    end
    return setmetatable({
        server_url       = cfg.server_url or "http://127.0.0.1:8081",
        project_id       = project_id,
        project_token    = token,
        batch_size       = (cfg.batch_size and cfg.batch_size > 0) and cfg.batch_size or 50,
        max_cache_size   = (cfg.max_cache_size and cfg.max_cache_size > 0) and cfg.max_cache_size or 10000,
        transport        = cfg.transport,
        _buffer          = {},
        _flushed_batches = {},
        _last_envelope   = nil,
    }, BatchConsumer)
end

function BatchConsumer:add(event)
    if #self._buffer >= self.max_cache_size then
        table.remove(self._buffer, 1)
    end
    self._buffer[#self._buffer + 1] = deep_copy(event)
    if #self._buffer >= self.batch_size then
        self:flush()
    end
end

function BatchConsumer:flush()
    if #self._buffer == 0 then
        return
    end
    local batch = self._buffer
    self._buffer = {}
    local payload = {
        project_id    = self.project_id,
        project_token = self.project_token,
        debug         = false,
        dry_run       = false,
        events        = batch,
    }
    local req_json = serialize_batch_payload_json(payload, false)
    local env
    if type(self.transport) == "function" then
        local url = trim_ascii(self.server_url):gsub("/+$", "") .. "/collect/api/v1/track/batch"
        env = self.transport(url, req_json, false, false)
    else
        env = default_mock_gateway_transport(payload)
    end
    self._flushed_batches[#self._flushed_batches + 1] = payload
    self._last_envelope = env
end

function BatchConsumer:close()
    self:flush()
end

function BatchConsumer:pending_count() return #self._buffer end
function BatchConsumer:flushed_batches() return deep_copy(self._flushed_batches) end
function BatchConsumer:last_envelope() return deep_copy(self._last_envelope) end

abi.BatchConsumer = BatchConsumer
abi.new_batch_consumer = BatchConsumer.new

--- 5.4 DebugConsumer：研发期同步 L4 强校验与 dry_run 演练消费者
local DebugConsumer = {}
DebugConsumer.__index = DebugConsumer

function DebugConsumer.new(cfg)
    cfg = cfg or {}
    local project_id = cfg.project_id or 1
    local token = trim_ascii(cfg.project_token or "abi_tok_default")
    if project_id <= 0 then
        error("DebugConsumer project_id must be positive", 2)
    end
    if #token == 0 then
        error("DebugConsumer project_token must not be empty", 2)
    end
    return setmetatable({
        server_url     = cfg.server_url or "http://127.0.0.1:8081",
        project_id     = project_id,
        project_token  = token,
        dry_run        = (cfg.dry_run ~= false),
        transport      = cfg.transport,
        _sent_payloads = {},
        _last_envelope = nil,
    }, DebugConsumer)
end

function DebugConsumer:add(event)
    local payload = {
        project_id    = self.project_id,
        project_token = self.project_token,
        debug         = true,
        dry_run       = self.dry_run,
        events        = { deep_copy(event) },
    }
    local req_json = serialize_batch_payload_json(payload, false)
    local env
    if type(self.transport) == "function" then
        local url = trim_ascii(self.server_url):gsub("/+$", "") .. "/collect/api/v1/track/batch"
        env = self.transport(url, req_json, true, self.dry_run)
    else
        env = default_mock_gateway_transport(payload)
    end
    self._sent_payloads[#self._sent_payloads + 1] = payload
    self._last_envelope = env
end

function DebugConsumer:flush() end
function DebugConsumer:close() end
function DebugConsumer:sent_payloads() return deep_copy(self._sent_payloads) end
function DebugConsumer:last_envelope() return deep_copy(self._last_envelope) end

abi.DebugConsumer = DebugConsumer
abi.new_debug_consumer = DebugConsumer.new

-- ============================================================================
-- 6. AbiAnalytics 核心客户端（同时支持 OpenResty 服务端无状态模式 & Cocos2d-Lua 客户端模式）
-- ============================================================================

local AbiAnalytics = {}
AbiAnalytics.__index = AbiAnalytics

function AbiAnalytics.new(consumer)
    if not consumer or type(consumer.add) ~= "function" then
        error("AbiAnalytics requires a valid consumer instance", 2)
    end
    return setmetatable({
        consumer             = consumer,
        _super_props         = {},
        _dynamic_super_fn    = nil,
        _client_mode_enabled = false,
        _client_storage_file = "",
        _client_distinct_id  = "",
        _client_login_id     = "",
        _client_preset_props = {},
        _event_timers        = {},
    }, AbiAnalytics)
end

abi.AbiAnalytics = AbiAnalytics
abi.new = AbiAnalytics.new

-- ----------------------------------------------------------------------------
-- 6.1 静态与动态公共属性管理（优先级：客户端设备预置 < 静态公共属性 < 动态公共属性 < 事件属性）
-- ----------------------------------------------------------------------------

function AbiAnalytics:set_super_properties(props)
    local clean = abi.sanitize_properties(props)
    for k, v in pairs(clean) do
        self._super_props[k] = v
    end
end

function AbiAnalytics:unset_super_property(key)
    if type(key) ~= "string" then return end
    local trimmed = trim_ascii(key)
    self._super_props[key] = nil
    self._super_props[trimmed] = nil
end

function AbiAnalytics:get_super_properties()
    return deep_copy(self._super_props)
end

function AbiAnalytics:clear_super_properties()
    self._super_props = {}
end

function AbiAnalytics:set_dynamic_super_properties(fn)
    if fn ~= nil and type(fn) ~= "function" then
        error("dynamic super properties callback must be a function or nil", 2)
    end
    self._dynamic_super_fn = fn
end

-- ----------------------------------------------------------------------------
-- 6.2 OpenResty / 游戏服务端无状态模式 API
-- ----------------------------------------------------------------------------

function AbiAnalytics:track(account_id, distinct_id, event_name, properties)
    self:track_with_options({
        account_id  = account_id,
        distinct_id = distinct_id,
        event_name  = event_name,
        properties  = properties,
    })
end

-- [当前版本未开放 / Unsupported in current version] (RESTFUL_API.md §3.3 D7① / G6 gate)
-- 严禁伪装成普通 track 入队；如需同日重试幂等请直接使用 track_with_options 携带确定性 event_id
function AbiAnalytics:track_first(_account_id, _distinct_id, _event_name, _first_check_id, _properties)
    error("track_first is unsupported in current version (D7① / G6 gate); use track_with_options with deterministic event_id for same-day idempotency", 2)
end

-- [当前版本未开放 / Unsupported in current version] (RESTFUL_API.md §3.3 D7① / G6 gate)
function AbiAnalytics:track_update(_account_id, _distinct_id, _event_name, _event_id, _properties)
    error("track_update is unsupported in current version (D7① / G6 gate); use track_with_options with deterministic event_id for same-day idempotency", 2)
end

-- [当前版本未开放 / Unsupported in current version] (RESTFUL_API.md §3.3 D7① / G6 gate)
function AbiAnalytics:track_overwrite(_account_id, _distinct_id, _event_name, _event_id, _properties)
    error("track_overwrite is unsupported in current version (D7① / G6 gate); use track_with_options with deterministic event_id for same-day idempotency", 2)
end

function AbiAnalytics:track_with_options(opts)
    if type(opts) ~= "table" then
        error("track_with_options requires an options table", 2)
    end
    local evt = self:_build_event(opts, true, false)
    self.consumer:add(evt)
end

-- ----------------------------------------------------------------------------
-- 6.3 7 类用户画像操作（自动隔离静态/动态公共属性与设备环境预置属性）
-- ----------------------------------------------------------------------------

local function validate_user_add_numeric(properties)
    if type(properties) ~= "table" then
        error("user_add properties must be a table", 3)
    end
    for k, v in pairs(properties) do
        local trimmed = (type(k) == "string") and trim_ascii(k) or ""
        if trimmed ~= "#time" and trimmed ~= "$time" then
            if type(v) ~= "number" then
                error(string.format('user_add property "%s" must be numeric, got %s', tostring(k), type(v)), 3)
            end
        end
    end
end

function AbiAnalytics:user_set(account_id, distinct_id, properties)
    self:_send_user_event(account_id, distinct_id, "$user_set", properties)
end

function AbiAnalytics:user_set_once(account_id, distinct_id, properties)
    self:_send_user_event(account_id, distinct_id, "$user_set_once", properties)
end

function AbiAnalytics:user_add(account_id, distinct_id, properties)
    validate_user_add_numeric(properties)
    self:_send_user_event(account_id, distinct_id, "$user_add", properties)
end

function AbiAnalytics:user_unset(account_id, distinct_id, keys)
    local props = {}
    if type(keys) == "string" then
        props[keys] = 0
    elseif type(keys) == "table" then
        for _, k in ipairs(keys) do
            props[k] = 0
        end
    else
        error("user_unset requires a key string or array of keys", 2)
    end
    self:_send_user_event(account_id, distinct_id, "$user_unset", props)
end

function AbiAnalytics:user_append(account_id, distinct_id, properties)
    self:_send_user_event(account_id, distinct_id, "$user_append", properties)
end

function AbiAnalytics:user_uniq_append(account_id, distinct_id, properties)
    self:_send_user_event(account_id, distinct_id, "$user_uniq_append", properties)
end

function AbiAnalytics:user_delete(account_id, distinct_id)
    self:_send_user_event(account_id, distinct_id, "$user_del", {})
end

-- ----------------------------------------------------------------------------
-- 6.4 Cocos2d-Lua 游戏客户端有状态设备模式 API
-- ----------------------------------------------------------------------------

local function load_client_identity_file(path)
    if type(path) ~= "string" or #path == 0 then
        return "", ""
    end
    local fp = io.open(path, "rb")
    if not fp then
        return "", ""
    end
    local raw = fp:read("*a")
    fp:close()
    if type(raw) ~= "string" or #raw == 0 then
        return "", ""
    end
    local ok, obj = pcall(abi.json_decode, raw)
    if not ok or type(obj) ~= "table" then
        return "", ""
    end
    local ok_d, d = pcall(abi.normalize_identity, obj.distinct_id or "", abi.MAX_DISTINCT_ID_BYTES)
    local ok_u, u = pcall(abi.normalize_identity, obj.login_id or "", abi.MAX_LOGIN_ID_BYTES)
    return (ok_d and d or ""), (ok_u and u or "")
end

function AbiAnalytics:_save_client_identity()
    if #self._client_storage_file == 0 then
        return
    end
    local fp = io.open(self._client_storage_file, "wb")
    if not fp then
        return
    end
    local json = serialize_value_json({
        distinct_id = self._client_distinct_id,
        login_id    = self._client_login_id,
    }, 0, true)
    fp:write(json .. "\n")
    fp:flush()
    fp:close()
end

function AbiAnalytics:enable_client_mode(cfg)
    cfg = cfg or {}
    local storage_file = trim_ascii(cfg.storage_file or "")
    local persisted_did, persisted_login = load_client_identity_file(storage_file)

    local did = abi.normalize_identity(cfg.distinct_id or "", abi.MAX_DISTINCT_ID_BYTES)
    if #did == 0 then
        did = (#persisted_did > 0) and persisted_did or abi.generate_uuid_v4()
    end
    did = abi.normalize_identity(did, abi.MAX_DISTINCT_ID_BYTES)

    local preset = {
        ["$lib"]           = abi.SDK_LIB_NAME,
        ["$lib_version"]   = abi.SDK_LIB_VERSION,
        ["$platform"]      = cfg.platform or "Cocos2d-Lua",
        ["$os"]            = cfg.os or "Android",
        ["$os_version"]    = cfg.os_version or "14",
        ["$app_version"]   = cfg.app_version or "1.0.0",
        ["$device_model"]  = cfg.device_model or "Mobile-Client",
        ["$screen_width"]  = cfg.screen_width or 1920,
        ["$screen_height"] = cfg.screen_height or 1080,
    }
    self._client_mode_enabled = true
    self._client_storage_file = storage_file
    self._client_distinct_id  = did
    if #self._client_login_id == 0 and #persisted_login > 0 then
        self._client_login_id = persisted_login
    end
    self._client_preset_props = abi.sanitize_properties(preset)
    self:_save_client_identity()
end

function AbiAnalytics:identify(distinct_id)
    local norm_did = abi.normalize_identity(distinct_id, abi.MAX_DISTINCT_ID_BYTES)
    if #norm_did == 0 then
        error("identify distinct_id must not be empty", 2)
    end
    self._client_mode_enabled = true
    self._client_distinct_id  = norm_did
    self:_save_client_identity()
end

function AbiAnalytics:login(account_id)
    local norm_login = abi.normalize_identity(account_id, abi.MAX_LOGIN_ID_BYTES)
    if #norm_login == 0 then
        error("login account_id must not be empty", 2)
    end
    if #self._client_distinct_id == 0 then
        self._client_distinct_id = abi.generate_uuid_v4()
    end
    self._client_mode_enabled = true
    self._client_login_id     = norm_login
    self:_save_client_identity()
end

function AbiAnalytics:logout()
    self._client_login_id = ""
    self:_save_client_identity()
end

function AbiAnalytics:get_distinct_id()
    return self._client_distinct_id
end

function AbiAnalytics:get_login_id()
    return self._client_login_id
end

function AbiAnalytics:time_event(event_name)
    local valid_name = abi.validate_event_name(event_name)
    self._event_timers[valid_name] = current_unix_millis()
end

function AbiAnalytics:_ensure_client_distinct_id()
    if #self._client_distinct_id == 0 then
        self._client_distinct_id = abi.generate_uuid_v4()
        self:_save_client_identity()
    end
    return self._client_distinct_id
end

function AbiAnalytics:_prepare_client_track_options(event_name, event_id, properties)
    local valid_name = abi.validate_event_name(event_name)
    local did = self:_ensure_client_distinct_id()
    local merged = deep_copy(properties or {})
    local start_ms = self._event_timers[valid_name]
    if start_ms then
        self._event_timers[valid_name] = nil
        if merged["$duration"] == nil then
            local elapsed_ms = math.max(0, current_unix_millis() - start_ms)
            merged["$duration"] = math.floor((elapsed_ms / 1000.0) * 1000 + 0.5) / 1000.0
        end
    end
    return {
        event_id    = event_id or "",
        event_name  = valid_name,
        account_id  = self._client_login_id,
        distinct_id = did,
        properties  = merged,
    }
end

function AbiAnalytics:client_track(event_name, properties)
    local opts = self:_prepare_client_track_options(event_name, "", properties)
    self.consumer:add(self:_build_event(opts, true, true))
end

-- [当前版本未开放 / Unsupported in current version] (RESTFUL_API.md §3.3 D7① / G6 gate)
function AbiAnalytics:client_track_first(_event_name, _first_check_id, _properties)
    error("client_track_first is unsupported in current version (D7① / G6 gate); use client_track with deterministic event_id for same-day idempotency", 2)
end

-- [当前版本未开放 / Unsupported in current version] (RESTFUL_API.md §3.3 D7① / G6 gate)
function AbiAnalytics:client_track_update(_event_name, _event_id, _properties)
    error("client_track_update is unsupported in current version (D7① / G6 gate); use client_track with deterministic event_id for same-day idempotency", 2)
end

-- [当前版本未开放 / Unsupported in current version] (RESTFUL_API.md §3.3 D7① / G6 gate)
function AbiAnalytics:client_track_overwrite(_event_name, _event_id, _properties)
    error("client_track_overwrite is unsupported in current version (D7① / G6 gate); use client_track with deterministic event_id for same-day idempotency", 2)
end

function AbiAnalytics:client_user_set(properties)
    self:_send_user_event(self._client_login_id, self:_ensure_client_distinct_id(), "$user_set", properties)
end

function AbiAnalytics:client_user_set_once(properties)
    self:_send_user_event(self._client_login_id, self:_ensure_client_distinct_id(), "$user_set_once", properties)
end

function AbiAnalytics:client_user_add(properties)
    validate_user_add_numeric(properties)
    self:_send_user_event(self._client_login_id, self:_ensure_client_distinct_id(), "$user_add", properties)
end

function AbiAnalytics:client_user_unset(keys)
    local props = {}
    if type(keys) == "string" then
        props[keys] = 0
    elseif type(keys) == "table" then
        for _, k in ipairs(keys) do
            props[k] = 0
        end
    end
    self:_send_user_event(self._client_login_id, self:_ensure_client_distinct_id(), "$user_unset", props)
end

function AbiAnalytics:client_user_append(properties)
    self:_send_user_event(self._client_login_id, self:_ensure_client_distinct_id(), "$user_append", properties)
end

function AbiAnalytics:client_user_uniq_append(properties)
    self:_send_user_event(self._client_login_id, self:_ensure_client_distinct_id(), "$user_uniq_append", properties)
end

function AbiAnalytics:client_user_delete()
    self:_send_user_event(self._client_login_id, self:_ensure_client_distinct_id(), "$user_del", {})
end

function AbiAnalytics:flush()
    self.consumer:flush()
end

function AbiAnalytics:close()
    self.consumer:close()
end

-- ----------------------------------------------------------------------------
-- 6.5 内部事件组装与隔离逻辑
-- ----------------------------------------------------------------------------

function AbiAnalytics:_send_user_event(account_id, distinct_id, op_name, properties)
    local evt = self:_build_event({
        event_name  = op_name,
        account_id  = account_id,
        distinct_id = distinct_id,
        properties  = properties or {},
    }, false, false)
    self.consumer:add(evt)
end

function AbiAnalytics:_build_event(opts, include_super_props, include_client_presets)
    local event_name                = abi.validate_event_name(opts.event_name)
    local norm_distinct, norm_login = abi.normalize_identity_pair(opts.distinct_id or "", opts.account_id or "")

    local event_id = opts.event_id or ""
    if #event_id > 0 then
        event_id = abi.normalize_identity(event_id, abi.MAX_EVENT_ID_BYTES)
    end
    if #event_id == 0 then
        event_id = abi.generate_uuid_v4()
    end

    local props_without_time, resolved_ts_ms = extract_event_time_and_strip(opts.properties or {}, opts.timestamp_ms)
    local clean_props = abi.sanitize_properties(props_without_time)

    local final_props = {}
    local is_user_event = (event_name:sub(1, 6) == "$user_") or (event_name:sub(1, 6) == "#user_")

    if not is_user_event then
        if include_client_presets and self._client_mode_enabled then
            for k, v in pairs(self._client_preset_props) do
                final_props[k] = deep_copy(v)
            end
        end
        if include_super_props then
            for k, v in pairs(self._super_props) do
                final_props[k] = deep_copy(v)
            end
            if type(self._dynamic_super_fn) == "function" then
                local clean_dyn = abi.sanitize_properties(self._dynamic_super_fn() or {})
                for k, v in pairs(clean_dyn) do
                    final_props[k] = v
                end
            end
        end
    end

    for k, v in pairs(clean_props) do
        final_props[k] = v
    end

    if not resolved_ts_ms or resolved_ts_ms <= 0 then
        resolved_ts_ms = current_unix_millis()
    end

    return {
        event_id    = event_id,
        event_name  = event_name,
        distinct_id = norm_distinct,
        login_id    = norm_login,
        timestamp   = resolved_ts_ms,
        properties  = final_props,
    }
end

return abi
