package com.anylink.abi.sdk;

import java.nio.charset.StandardCharsets;
import java.text.SimpleDateFormat;
import java.time.Instant;
import java.time.ZoneOffset;
import java.time.format.DateTimeFormatter;
import java.util.*;
import java.util.regex.Pattern;

public final class AbiValidator {
    public static final int MAX_EVENT_ID_BYTES = 64;
    public static final int MAX_DISTINCT_ID_BYTES = 64;
    public static final int MAX_LOGIN_ID_BYTES = 128;
    public static final int MAX_EVENT_NAME_CHARS = 128;
    public static final int MAX_CUSTOM_KEY_CHARS = 64;
    public static final long MAX_SAFE_INTEGER = 9007199254740991L; // 2^53 - 1
    public static final String SDK_VERSION = "abi-java-sdk/1.0.0";

    private static final Pattern IDENTIFIER_PATTERN = Pattern.compile("^[A-Za-z_][A-Za-z0-9_]*$");
    private static final DateTimeFormatter UTC_FORMATTER = DateTimeFormatter.ISO_INSTANT;

    private static final Set<String> SYSTEM_EVENT_WHITELIST = Set.of(
            "$signup", "$login", "$pageview",
            "$AppStart", "$AppEnd", "$AppClick", "$AppViewScreen",
            "$user_set", "#user_set",
            "$user_set_once", "#user_set_once",
            "$user_add", "#user_add",
            "$user_unset", "#user_unset",
            "$user_append", "#user_append",
            "$user_uniq_append", "#user_uniq_append",
            "$user_del", "#user_del"
    );

    private static final Set<String> SYSTEM_PROPERTY_WHITELIST = Set.of(
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
    );

    private AbiValidator() {
    }

    public static String normalizeIdentity(String value, int maxUtf8Bytes, String fieldName) {
        if (value == null) {
            return "";
        }
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if ((c < 0x20 && (c < 0x09 || c > 0x0D)) || c == 0x7F) {
                throw new IllegalArgumentException(fieldName + " contains control character");
            }
        }
        String trimmed = trimUnicodeWhitespace(value);
        byte[] utf8 = trimmed.getBytes(StandardCharsets.UTF_8);
        if (utf8.length > maxUtf8Bytes) {
            throw new IllegalArgumentException(
                    fieldName + " exceeds max length of " + maxUtf8Bytes + " UTF-8 bytes (got " + utf8.length + ")");
        }
        return trimmed;
    }

    /**
     * Validates and normalizes the ThinkingData dual-ID pair (distinct_id <= 64 UTF-8 bytes,
     * login_id <= 128 UTF-8 bytes), requiring at least one non-empty without copying login_id into distinct_id.
     */
    public static String[] normalizeIdentityPair(String distinctId, String loginId) {
        String normDistinct = normalizeIdentity(distinctId, MAX_DISTINCT_ID_BYTES, "distinct_id");
        String normLogin = normalizeIdentity(loginId, MAX_LOGIN_ID_BYTES, "login_id");
        if (normDistinct.isEmpty() && normLogin.isEmpty()) {
            throw new IllegalArgumentException("at least one of distinct_id or login_id is required");
        }
        return new String[]{normDistinct, normLogin};
    }

    private static String trimUnicodeWhitespace(String s) {
        int start = 0;
        int end = s.length();
        while (start < end && isIdentityWhitespace(s.charAt(start))) {
            start++;
        }
        while (end > start && isIdentityWhitespace(s.charAt(end - 1))) {
            end--;
        }
        return s.substring(start, end);
    }

    private static boolean isIdentityWhitespace(char c) {
        return Character.isWhitespace(c) || Character.isSpaceChar(c) || c == '\u0085' || c == '\u00A0';
    }

    public static String validateEventName(String eventName) {
        if (eventName == null) {
            throw new IllegalArgumentException("event_name must not be null");
        }
        String trimmed = eventName.trim();
        if (trimmed.isEmpty()) {
            throw new IllegalArgumentException("event_name must not be empty");
        }
        if (trimmed.length() > MAX_EVENT_NAME_CHARS) {
            throw new IllegalArgumentException("event_name exceeds " + MAX_EVENT_NAME_CHARS + " chars");
        }
        if (SYSTEM_EVENT_WHITELIST.contains(trimmed)) {
            return trimmed;
        }
        if (!IDENTIFIER_PATTERN.matcher(trimmed).matches()) {
            throw new IllegalArgumentException("invalid event_name: " + trimmed);
        }
        return trimmed;
    }

    public static String validatePropertyKey(String key) {
        if (key == null) {
            throw new IllegalArgumentException("property key must not be null");
        }
        String trimmed = key.trim();
        if (trimmed.isEmpty()) {
            throw new IllegalArgumentException("property key must not be empty");
        }
        if (SYSTEM_PROPERTY_WHITELIST.contains(trimmed)) {
            return trimmed;
        }
        if (trimmed.length() > MAX_CUSTOM_KEY_CHARS || !IDENTIFIER_PATTERN.matcher(trimmed).matches()) {
            throw new IllegalArgumentException("invalid property key: " + trimmed);
        }
        return trimmed;
    }

    public static Map<String, Object> sanitizeProperties(Map<String, Object> properties) {
        if (properties == null || properties.isEmpty()) {
            return new LinkedHashMap<>();
        }
        Map<String, Object> out = new LinkedHashMap<>(properties.size());
        for (Map.Entry<String, Object> entry : properties.entrySet()) {
            String key = validatePropertyKey(entry.getKey());
            Object val = entry.getValue();
            if (val == null) {
                continue;
            }
            out.put(key, sanitizeValue(key, val));
        }
        return out;
    }

    private static Object sanitizeValue(String key, Object val) {
        if (val instanceof String || val instanceof Boolean) {
            return val;
        }
        if (val instanceof Integer || val instanceof Short || val instanceof Byte) {
            return ((Number) val).longValue();
        }
        if (val instanceof Long) {
            long lv = (Long) val;
            if (lv == Long.MIN_VALUE || lv > MAX_SAFE_INTEGER || lv < -MAX_SAFE_INTEGER) {
                return Long.toString(lv);
            }
            return lv;
        }
        if (val instanceof Double || val instanceof Float) {
            double dv = ((Number) val).doubleValue();
            if (Double.isNaN(dv) || Double.isInfinite(dv)) {
                throw new IllegalArgumentException("property " + key + " has non-finite float value");
            }
            return dv;
        }
        if (val instanceof Date) {
            return UTC_FORMATTER.format(Instant.ofEpochMilli(((Date) val).getTime()));
        }
        if (val instanceof Instant) {
            return UTC_FORMATTER.format((Instant) val);
        }
        if (val instanceof Collection<?>) {
            List<Object> list = new ArrayList<>();
            for (Object elem : (Collection<?>) val) {
                if (elem == null) {
                    throw new IllegalArgumentException("property " + key + " list contains null element");
                }
                if (elem instanceof Collection<?> || elem instanceof Map<?, ?>) {
                    throw new IllegalArgumentException("property " + key + " list contains nested collection/map");
                }
                list.add(sanitizeValue(key, elem));
            }
            return list;
        }
        throw new IllegalArgumentException("property " + key + " has unsupported type " + val.getClass().getName());
    }
}
