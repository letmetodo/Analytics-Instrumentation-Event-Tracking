export const MAX_DISTINCT_ID_BYTES = 64;
export const MAX_LOGIN_ID_BYTES = 128;
export const MAX_EVENT_ID_BYTES = 64;
export const MAX_EVENT_NAME_LEN = 128;
export const MAX_PROP_KEY_LEN = 64;
export const MAX_SAFE_INT = 9007199254740991;
export const MIN_SAFE_INT = -9007199254740991;

const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

const PROTECTED_SYSTEM_EVENTS = new Set([
  '$signup', '$login',
  '$pageview',
  '$AppStart',
  '$AppEnd',
  '$AppClick',
  '$AppViewScreen',
  '$user_set', '#user_set',
  '$user_set_once', '#user_set_once',
  '$user_add', '#user_add',
  '$user_unset', '#user_unset',
  '$user_append', '#user_append',
  '$user_uniq_append', '#user_uniq_append',
  '$user_del', '#user_del',
]);

const PROTECTED_SYSTEM_PROP_ALIASES = new Set([
  '$ip', '#ip', 'ip',
  '$country', '#country', 'country',
  '$country_code', '#country_code', 'country_code',
  '$province', '#province', 'province',
  '$city', '#city', 'city',
  '$os', '#os', 'os',
  '$os_version', '#os_version', 'os_version',
  '$device_model', '#device_model', 'device_model',
  '$model', '#model', 'model',
  '$manufacturer', '#manufacturer', 'manufacturer',
  '$device_id', '#device_id', 'device_id',
  '$session_id', '#session_id', 'session_id',
  '$browser', '#browser', 'browser',
  '$browser_version', '#browser_version', 'browser_version',
  '$app_version', '#app_version', 'app_version',
  '$lib', '#lib', 'lib',
  '$lib_version', '#lib_version', 'lib_version',
  '$network', '#network', 'network',
  '$network_type', '#network_type', 'network_type',
  '$platform', '#platform', 'platform',
  '$carrier', '#carrier', 'carrier',
  '$screen_height', '#screen_height', 'screen_height',
  '$screen_width', '#screen_width', 'screen_width',
  '$url', '#url', 'url',
  '$url_path', '#url_path', 'url_path',
  '$title', '#title', 'title',
  '$referrer', '#referrer', 'referrer',
  '$duration', '#duration', 'duration',
  '$zone_offset', '#zone_offset', 'zone_offset',
  '$first_check_id', '#first_check_id', 'first_check_id',
]);

const utf8Encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

export function containsDisallowedControlChar(value: string): boolean {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if ((code < 0x20 && (code < 0x09 || code > 0x0d)) || code === 0x7f) {
      return true;
    }
  }
  return false;
}

const IDENTITY_TRIM_REGEX = /^[\s\u0085\u00a0\u2007\u202f]+|[\s\u0085\u00a0\u2007\u202f]+$/g;

export function normalizeIdentityField(
  raw: string,
  maxBytes: number,
  fieldName: string,
): string {
  if (typeof raw !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  if (containsDisallowedControlChar(raw)) {
    throw new Error(`${fieldName} contains ASCII control character`);
  }
  const normalized = raw.replace(IDENTITY_TRIM_REGEX, '');
  if (!normalized) {
    throw new Error(`${fieldName} cannot be empty`);
  }
  const byteLen = utf8ByteLength(normalized);
  if (byteLen > maxBytes) {
    throw new Error(`${fieldName} exceeds ${maxBytes} UTF-8 bytes (got ${byteLen})`);
  }
  return normalized;
}

export interface NormalizedIdentity {
  distinctId: string;
  loginId: string;
}

export function normalizeIdentity(
  distinctId: string,
  loginId = '',
): NormalizedIdentity {
  if (typeof distinctId !== 'string') {
    throw new Error('distinct_id must be a string');
  }
  if (typeof loginId !== 'string') {
    throw new Error('login_id must be a string');
  }
  if (containsDisallowedControlChar(distinctId)) {
    throw new Error('distinct_id contains ASCII control character');
  }
  if (containsDisallowedControlChar(loginId)) {
    throw new Error('login_id contains ASCII control character');
  }
  const trimmedDistinct = distinctId.replace(IDENTITY_TRIM_REGEX, '');
  const trimmedLogin = loginId.replace(IDENTITY_TRIM_REGEX, '');
  if (!trimmedDistinct && !trimmedLogin) {
    throw new Error('at least one of distinct_id or login_id is required');
  }
  const normDistinct = trimmedDistinct
    ? normalizeIdentityField(trimmedDistinct, MAX_DISTINCT_ID_BYTES, 'distinct_id')
    : '';
  const normLogin = trimmedLogin
    ? normalizeIdentityField(trimmedLogin, MAX_LOGIN_ID_BYTES, 'login_id')
    : '';
  return {
    distinctId: normDistinct,
    loginId: normLogin,
  };
}

export function validateEventName(eventName: string): string {
  if (typeof eventName !== 'string') {
    throw new Error('event name is required');
  }
  const trimmed = eventName.trim();
  if (!trimmed) {
    throw new Error('event name is required');
  }
  if (trimmed.length > MAX_EVENT_NAME_LEN) {
    throw new Error(`event name exceeds ${MAX_EVENT_NAME_LEN} chars`);
  }
  if (PROTECTED_SYSTEM_EVENTS.has(trimmed)) {
    return trimmed;
  }
  if (!IDENTIFIER_REGEX.test(trimmed)) {
    throw new Error(`invalid event name "${trimmed}"`);
  }
  return trimmed;
}

export function validatePropertyKey(propKey: string): string {
  if (typeof propKey !== 'string') {
    throw new Error('property key cannot be empty');
  }
  const trimmed = propKey.trim();
  if (!trimmed) {
    throw new Error('property key cannot be empty');
  }
  if (PROTECTED_SYSTEM_PROP_ALIASES.has(trimmed)) {
    return trimmed;
  }
  if (trimmed.length > MAX_PROP_KEY_LEN || !IDENTIFIER_REGEX.test(trimmed)) {
    throw new Error(`invalid property key "${trimmed}"`);
  }
  return trimmed;
}

export function normalizePropertyValue(propKey: string, value: unknown): unknown {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
    if (value >= BigInt(MIN_SAFE_INT) && value <= BigInt(MAX_SAFE_INT)) {
      return Number(value);
    }
    return value.toString();
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new Error(`property "${propKey}" contains non-finite number`);
    }
    if (Number.isInteger(value) && (value > MAX_SAFE_INT || value < MIN_SAFE_INT)) {
      return String(value);
    }
    return value;
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) {
      throw new Error(`property "${propKey}" contains invalid Date`);
    }
    return formatDateForABI(value);
  }
  if (Array.isArray(value)) {
    return value.map((item, idx) => {
      if (item === null || item === undefined) {
        throw new Error(`property "${propKey}[${idx}]" list element cannot be null or undefined`);
      }
      if (typeof item === 'string' || typeof item === 'boolean') {
        return item;
      }
      if (typeof item === 'bigint') {
        if (item >= BigInt(MIN_SAFE_INT) && item <= BigInt(MAX_SAFE_INT)) {
          return Number(item);
        }
        return item.toString();
      }
      if (typeof item === 'number') {
        if (!Number.isFinite(item)) {
          throw new Error(`property "${propKey}[${idx}]" contains non-finite number`);
        }
        if (Number.isInteger(item) && (item > MAX_SAFE_INT || item < MIN_SAFE_INT)) {
          return String(item);
        }
        return item;
      }
      if (item instanceof Date) {
        if (Number.isNaN(item.getTime())) {
          throw new Error(`property "${propKey}[${idx}]" contains invalid Date`);
        }
        return formatDateForABI(item);
      }
      throw new Error(`property "${propKey}[${idx}]" must be a scalar value (nested objects/arrays are not allowed)`);
    });
  }
  throw new Error(`property "${propKey}" has unsupported non-scalar type`);
}

export function normalizeProperties(
  props?: Record<string, unknown> | null,
): Record<string, unknown> {
  if (!props) {
    return {};
  }
  const normalized: Record<string, unknown> = {};
  for (const [rawKey, val] of Object.entries(props)) {
    const key = validatePropertyKey(rawKey);
    const normVal = normalizePropertyValue(key, val);
    if (normVal !== undefined) {
      normalized[key] = normVal;
    }
  }
  return normalized;
}

export function formatDateForABI(date: Date): string {
  return date.toISOString();
}
