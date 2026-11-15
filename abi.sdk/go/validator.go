package abi

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"math"
	"reflect"
	"regexp"
	"strconv"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"
)

const (
	MaxEventIDBytes    = 64
	MaxDistinctIDBytes = 64
	MaxLoginIDBytes    = 128
	MaxEventNameChars  = 128
	MaxCustomKeyChars  = 64
	MaxSafeInteger     = 9007199254740991 // 2^53 - 1
	SDKVersion         = "abi-go-sdk/1.0.0"
)

var identifierRegex = regexp.MustCompile(`^[A-Za-z_][A-Za-z0-9_]*$`)

var systemEventWhitelist = map[string]struct{}{
	"$signup": {}, "$login": {}, "$pageview": {},
	"$AppStart": {}, "$AppEnd": {}, "$AppClick": {}, "$AppViewScreen": {},
	"$user_set": {}, "#user_set": {},
	"$user_set_once": {}, "#user_set_once": {},
	"$user_add": {}, "#user_add": {},
	"$user_unset": {}, "#user_unset": {},
	"$user_append": {}, "#user_append": {},
	"$user_uniq_append": {}, "#user_uniq_append": {},
	"$user_del": {}, "#user_del": {},
}

var systemPropertyWhitelist = map[string]struct{}{
	"$os": {}, "#os": {}, "os": {},
	"$os_version": {}, "#os_version": {}, "os_version": {},
	"$app_version": {}, "#app_version": {}, "app_version": {},
	"$browser": {}, "#browser": {}, "browser": {},
	"$browser_version": {}, "#browser_version": {}, "browser_version": {},
	"$city": {}, "#city": {}, "city": {},
	"$province": {}, "#province": {}, "province": {},
	"$country": {}, "#country": {}, "country": {},
	"$country_code": {}, "#country_code": {}, "country_code": {},
	"$ip": {}, "#ip": {}, "ip": {},
	"$network": {}, "#network": {}, "network": {},
	"$network_type": {}, "#network_type": {}, "network_type": {},
	"$platform": {}, "#platform": {}, "platform": {},
	"$device_id": {}, "#device_id": {}, "device_id": {},
	"$session_id": {}, "#session_id": {}, "session_id": {},
	"$screen_width": {}, "#screen_width": {}, "screen_width": {},
	"$screen_height": {}, "#screen_height": {}, "screen_height": {},
	"$model": {}, "#model": {}, "model": {},
	"$device_model": {}, "#device_model": {}, "device_model": {},
	"$manufacturer": {}, "#manufacturer": {}, "manufacturer": {},
	"$carrier": {}, "#carrier": {}, "carrier": {},
	"$url": {}, "#url": {}, "url": {},
	"$url_path": {}, "#url_path": {}, "url_path": {},
	"$referrer": {}, "#referrer": {}, "referrer": {},
	"$title": {}, "#title": {}, "title": {},
	"$duration": {}, "#duration": {}, "duration": {},
	"$lib": {}, "#lib": {}, "lib": {},
	"$lib_version": {}, "#lib_version": {}, "lib_version": {},
	"$zone_offset": {}, "#zone_offset": {}, "zone_offset": {},
	"$first_check_id": {}, "#first_check_id": {}, "first_check_id": {},
}

// isJavaStyleWhitespace matches Java's Character.isWhitespace || Character.isSpaceChar || U+0085 || U+00A0
// used by IdentityInputPolicy.java and Go's strings.TrimSpace.
func isIdentityWhitespace(r rune) bool {
	if unicode.IsSpace(r) {
		return true
	}
	return r == '\u0085' || r == '\u00a0' || r == '\u2007' || r == '\u202f'
}

// NormalizeIdentity validates UTF-8, rejects control characters before trimming, trims Unicode whitespace,
// and enforces the maximum UTF-8 byte length.
func NormalizeIdentity(val string, maxUTF8Bytes int) (string, error) {
	if !utf8.ValidString(val) {
		return "", fmt.Errorf("identity is not valid UTF-8")
	}
	for _, r := range val {
		if (r < 0x20 && (r < 0x09 || r > 0x0d)) || r == 0x7f {
			return "", fmt.Errorf("identity contains control character U+%04X", r)
		}
	}
	trimmed := strings.TrimFunc(val, isIdentityWhitespace)
	if len(trimmed) > maxUTF8Bytes {
		return "", fmt.Errorf("identity exceeds max length of %d UTF-8 bytes (got %d)", maxUTF8Bytes, len(trimmed))
	}
	return trimmed, nil
}

// NormalizeIdentityPair validates and normalizes the ThinkingData dual-identity pair
// (distinct_id <= 64 UTF-8 bytes, login_id <= 128 UTF-8 bytes) and requires at least one non-empty.
// It never copies login_id into distinct_id when distinct_id is empty.
func NormalizeIdentityPair(distinctID, loginID string) (string, string, error) {
	normDistinct, err := NormalizeIdentity(distinctID, MaxDistinctIDBytes)
	if err != nil {
		return "", "", fmt.Errorf("invalid distinct_id: %w", err)
	}
	normLogin, err := NormalizeIdentity(loginID, MaxLoginIDBytes)
	if err != nil {
		return "", "", fmt.Errorf("invalid login_id: %w", err)
	}
	if normDistinct == "" && normLogin == "" {
		return "", "", fmt.Errorf("distinct_id or login_id is required")
	}
	return normDistinct, normLogin, nil
}

// ValidateEventName validates custom or system event names against ABI schema rules.
func ValidateEventName(name string) (string, error) {
	trimmed := strings.TrimSpace(name)
	if trimmed == "" {
		return "", fmt.Errorf("event_name must not be empty")
	}
	if len(trimmed) > MaxEventNameChars {
		return "", fmt.Errorf("event_name exceeds %d characters", MaxEventNameChars)
	}
	if _, ok := systemEventWhitelist[trimmed]; ok {
		return trimmed, nil
	}
	if !identifierRegex.MatchString(trimmed) {
		return "", fmt.Errorf("invalid event_name %q: must match ^[A-Za-z_][A-Za-z0-9_]*$", trimmed)
	}
	return trimmed, nil
}

// ValidatePropertyKey validates a property key against ABI schema rules.
func ValidatePropertyKey(key string) (string, error) {
	trimmed := strings.TrimSpace(key)
	if trimmed == "" {
		return "", fmt.Errorf("property key must not be empty")
	}
	if _, ok := systemPropertyWhitelist[trimmed]; ok {
		return trimmed, nil
	}
	if len(trimmed) > MaxCustomKeyChars || !identifierRegex.MatchString(trimmed) {
		return "", fmt.Errorf("invalid property key %q: must match ^[A-Za-z_][A-Za-z0-9_]*$ (max %d chars)", trimmed, MaxCustomKeyChars)
	}
	return trimmed, nil
}

// SanitizeProperties validates property keys and normalizes values (converting >2^53-1 integers to strings,
// formatting time.Time, and rejecting NaN/Inf/complex nested maps).
func SanitizeProperties(props map[string]any) (map[string]any, error) {
	if len(props) == 0 {
		return map[string]any{}, nil
	}
	out := make(map[string]any, len(props))
	for rawKey, rawVal := range props {
		key, err := ValidatePropertyKey(rawKey)
		if err != nil {
			return nil, err
		}
		if rawVal == nil {
			continue
		}
		normVal, err := sanitizePropertyValue(key, rawVal)
		if err != nil {
			return nil, err
		}
		out[key] = normVal
	}
	return out, nil
}

func sanitizePropertyValue(key string, val any) (any, error) {
	switch v := val.(type) {
	case bool, string:
		return v, nil
	case int:
		return normalizeSignedInt(int64(v)), nil
	case int8:
		return int64(v), nil
	case int16:
		return int64(v), nil
	case int32:
		return int64(v), nil
	case int64:
		return normalizeSignedInt(v), nil
	case uint:
		return normalizeUnsignedInt(uint64(v)), nil
	case uint8:
		return int64(v), nil
	case uint16:
		return int64(v), nil
	case uint32:
		return int64(v), nil
	case uint64:
		return normalizeUnsignedInt(v), nil
	case float32:
		f := float64(v)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return nil, fmt.Errorf("property %q has non-finite float value", key)
		}
		return f, nil
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return nil, fmt.Errorf("property %q has non-finite float value", key)
		}
		return v, nil
	case time.Time:
		return v.UTC().Format(time.RFC3339), nil
	default:
		rv := reflect.ValueOf(val)
		if rv.Kind() == reflect.Slice || rv.Kind() == reflect.Array {
			n := rv.Len()
			list := make([]any, 0, n)
			for i := 0; i < n; i++ {
				elem := rv.Index(i).Interface()
				if elem == nil {
					return nil, fmt.Errorf("property %q list contains nil element at index %d", key, i)
				}
				ev, err := sanitizeListElement(key, elem)
				if err != nil {
					return nil, err
				}
				list = append(list, ev)
			}
			return list, nil
		}
		return nil, fmt.Errorf("property %q has unsupported value type %T", key, val)
	}
}

func sanitizeListElement(key string, elem any) (any, error) {
	switch v := elem.(type) {
	case bool, string:
		return v, nil
	case int:
		return normalizeSignedInt(int64(v)), nil
	case int8, int16, int32:
		return v, nil
	case int64:
		return normalizeSignedInt(v), nil
	case uint:
		return normalizeUnsignedInt(uint64(v)), nil
	case uint8, uint16, uint32:
		return v, nil
	case uint64:
		return normalizeUnsignedInt(v), nil
	case float32:
		f := float64(v)
		if math.IsNaN(f) || math.IsInf(f, 0) {
			return nil, fmt.Errorf("property %q list contains non-finite float", key)
		}
		return f, nil
	case float64:
		if math.IsNaN(v) || math.IsInf(v, 0) {
			return nil, fmt.Errorf("property %q list contains non-finite float", key)
		}
		return v, nil
	default:
		return nil, fmt.Errorf("property %q list contains unsupported element type %T", key, elem)
	}
}

func normalizeSignedInt(v int64) any {
	if v == math.MinInt64 || v > MaxSafeInteger || v < -MaxSafeInteger {
		return strconv.FormatInt(v, 10)
	}
	return v
}

func normalizeUnsignedInt(v uint64) any {
	if v > uint64(MaxSafeInteger) {
		return strconv.FormatUint(v, 10)
	}
	return int64(v)
}

// GenerateUUIDv4 generates a standard RFC 4122 UUIDv4 string.
func GenerateUUIDv4() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		return fmt.Sprintf("evt-%d", time.Now().UnixNano())
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	var buf [36]byte
	hex.Encode(buf[0:8], b[0:4])
	buf[8] = '-'
	hex.Encode(buf[9:13], b[4:6])
	buf[13] = '-'
	hex.Encode(buf[14:18], b[6:8])
	buf[18] = '-'
	hex.Encode(buf[19:23], b[8:10])
	buf[23] = '-'
	hex.Encode(buf[24:36], b[10:16])
	return string(buf[:])
}
