/**
 * @module @anylink/abi-node-sdk
 * @description
 * ABI 企业级用户行为分析（UBA）与 BI 平台的官方 Node.js 服务端数据采集 SDK，
 * 核心语义完整对标数数科技 ThinkingData Node.js Server SDK v3.4。
 *
 * 核心特性：
 * 1. 零第三方运行时依赖：100% 基于 Node.js 标准库（`node:http`、`node:https`、`node:zlib`、`node:fs`、`node:crypto`）实现。
 * 2. 服务端无状态多用户并发安全：不在内存中绑定单用户身份，每次调用显式传入当前请求用户的 `loginId`（实名账号 ID）与/或 `distinctId`（访客/设备 ID）。
 * 3. 前置强契约校验：内置事件名、属性名、UTF-8 字节长度（`distinct_id` / `event_id` <= 64B，`login_id` <= 128B，且 `distinct_id` 与 `login_id` 至少一个非空，绝不将 `login_id` 回填复制到 `distinct_id`）与控制字符拦截。
 * 4. 64 位雪花 ID 精度保护：对原生 `BigInt` 及超出 IEEE-754 安全整数范围（`> 2^53 - 1` 或 `< -(2^53 - 1)`）的整数（含数组元素）自动转为十进制字符串。
 * 5. 预置时间与客户端 IP 透传：支持从 `properties` 自动提取 `#time` / `$time` 作为顶层毫秒级 `timestamp` 并从 `properties` 剥离；原生透传 `#ip` / `$ip` 供采集网关执行 GeoIP 解析。
 * 6. 四大可插拔 Consumer：`StagingConsumer`（两步式预览 JSON 与确认提交）、`BatchConsumer`（定时/定量 Gzip 批量上报与指数退避幂等重试）、`LoggerConsumer`（按天/按小时切分本地 `.jsonl` 文件）、`DebugConsumer`（研发期同步 L4 强校验与 `dryRun`）。
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import path from 'node:path';
import { URL } from 'node:url';
import zlib from 'node:zlib';

/** SDK 标准库标识名称 */
export const SDK_NAME = 'abi-node-sdk';

/** SDK 版本号 */
export const SDK_VERSION = '1.0.0';

/** HTTP 请求默认 User-Agent 标识 */
export const USER_AGENT = `${SDK_NAME}/${SDK_VERSION}`;

/** `distinct_id` 最大允许 UTF-8 字节数 */
export const MAX_DISTINCT_ID_BYTES = 64;

/** `login_id` 最大允许 UTF-8 字节数 */
export const MAX_LOGIN_ID_BYTES = 128;

/** `event_id` 最大允许 UTF-8 字节数 */
export const MAX_EVENT_ID_BYTES = 64;

/** 事件名称最大字符长度 */
export const MAX_EVENT_NAME_LEN = 128;

/** 自定义属性键名最大字符长度 */
export const MAX_PROP_KEY_LEN = 64;

/** IEEE-754 双精度浮点数最大安全整数（`2^53 - 1`） */
export const MAX_SAFE_INT = 9007199254740991;

/** IEEE-754 双精度浮点数最小安全整数（`-(2^53 - 1)`） */
export const MIN_SAFE_INT = -9007199254740991;

/** 秒级与毫秒级 Unix 时间戳分界阈值（`1e11`） */
const SECONDS_TO_MS_THRESHOLD = 100_000_000_000;

/**
 * `LoggerConsumer` 本地 JSONL 日志文件切分轮转模式枚举。
 * @readonly
 * @enum {string}
 */
export const RotateMode = Object.freeze({
  /** 按天切分（文件名形如 `prefix.YYYY-MM-DD.jsonl`） */
  DAILY: 'DAILY',
  /** 按小时切分（文件名形如 `prefix.YYYY-MM-DD-HH.jsonl`） */
  HOURLY: 'HOURLY',
});

/** 合法自定义标识符正则（字母或下划线开头，仅含字母、数字、下划线） */
const IDENTIFIER_REGEX = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** 首尾空白字符修剪正则（对齐 Java/Go 跨语言身份规范化策略，保留内部全角空格等合法字符） */
const IDENTITY_TRIM_REGEX = /^[\s\u0085\u00a0\u2007\u202f]+|[\s\u0085\u00a0\u2007\u202f]+$/g;

/** 允许上报的系统预置事件白名单 */
export const PROTECTED_SYSTEM_EVENTS = new Set([
  '$signup',
  '$login',
  '$pageview',
  '$AppStart',
  '$AppEnd',
  '$AppClick',
  '$AppViewScreen',
  '$user_set',
  '#user_set',
  '$user_set_once',
  '#user_set_once',
  '$user_add',
  '#user_add',
  '$user_unset',
  '#user_unset',
  '$user_append',
  '#user_append',
  '$user_uniq_append',
  '#user_uniq_append',
  '$user_del',
  '#user_del',
]);

/** 允许上报的系统预置属性键名白名单（兼容 `$`、`#` 与无前缀别名） */
export const PROTECTED_SYSTEM_PROP_ALIASES = new Set([
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

/**
 * 计算字符串的 UTF-8 字节长度。
 *
 * @param {string} value - 待计算的字符串
 * @returns {number} UTF-8 编码字节数
 */
export function utf8ByteLength(value) {
  if (typeof value !== 'string') {
    throw new TypeError('utf8ByteLength expects a string');
  }
  return Buffer.byteLength(value, 'utf8');
}

/**
 * 检测字符串中是否包含非法 ASCII 控制字符（`< 0x20` 且不在 `\t..\r` 范围内，或 `0x7f` DEL）。
 *
 * @param {string} value - 待检测的字符串
 * @returns {boolean} 若包含非法控制字符则返回 `true`
 */
export function containsDisallowedControlChar(value) {
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if ((code < 0x20 && (code < 0x09 || code > 0x0d)) || code === 0x7f) {
      return true;
    }
  }
  return false;
}

/**
 * 生成标准 RFC 4122 UUIDv4 字符串。
 *
 * @returns {string} UUIDv4 字符串
 */
export function generateUUIDv4() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = crypto.randomBytes(16);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 校验并规范化单个身份标识字段（在裁剪首尾空白前拦截控制字符，裁剪后校验最大 UTF-8 字节长度）。
 *
 * @param {string} raw - 原始身份标识字符串
 * @param {number} maxBytes - 最大允许的 UTF-8 字节数
 * @param {string} [fieldName='identity'] - 字段名称（用于异常提示）
 * @param {boolean} [allowEmpty=false] - 是否允许为空或全空白字符串
 * @returns {string} 规范化后的身份标识字符串
 */
export function normalizeIdentityField(raw, maxBytes, fieldName = 'identity', allowEmpty = false) {
  if (raw === undefined || raw === null || raw === '') {
    if (allowEmpty) {
      return '';
    }
    throw new Error(`${fieldName} cannot be empty`);
  }
  if (typeof raw !== 'string') {
    throw new Error(`${fieldName} must be a string`);
  }
  if (containsDisallowedControlChar(raw)) {
    throw new Error(`${fieldName} contains disallowed ASCII control character`);
  }
  const normalized = raw.replace(IDENTITY_TRIM_REGEX, '');
  if (!normalized) {
    if (allowEmpty) {
      return '';
    }
    throw new Error(`${fieldName} cannot be empty`);
  }
  const byteLen = utf8ByteLength(normalized);
  if (byteLen > maxBytes) {
    throw new Error(`${fieldName} exceeds ${maxBytes} UTF-8 bytes (got ${byteLen})`);
  }
  return normalized;
}

/**
 * 校验并规范化 ThinkingData 对齐双身份标识（访客/设备 ID `distinct_id` 与实名账号 ID `login_id`）。
 * 支持传入 `(distinctId, loginId)` 位置参数或 `{ distinctId, loginId, accountId }` 对象。
 *
 * 规则：
 * - `distinct_id` <= 64 UTF-8 字节（当 `login_id` 非空时允许为空字符串 `""`）；
 * - `login_id` <= 128 UTF-8 字节（当 `distinct_id` 非空时允许为空字符串 `""`）；
 * - `distinct_id` 与 `login_id` 至少需要有一个非空，否则抛出异常；
 * - 绝不将 `login_id` 复制回填到 `distinct_id`（避免超过 64 字节的 `login_id` 报错或污染访客 ID）。
 *
 * @param {string | { distinctId?: string, distinct_id?: string, loginId?: string, login_id?: string, accountId?: string, account_id?: string }} distinctIdOrInput
 * @param {string} [loginId='']
 * @returns {{ distinctId: string, loginId: string, distinct_id: string, login_id: string }}
 */
export function normalizeIdentity(distinctIdOrInput, loginId = '') {
  let rawDistinct = '';
  let rawLogin = '';

  if (distinctIdOrInput !== null && typeof distinctIdOrInput === 'object') {
    rawDistinct = distinctIdOrInput.distinctId ?? distinctIdOrInput.distinct_id ?? '';
    rawLogin =
      distinctIdOrInput.loginId ??
      distinctIdOrInput.login_id ??
      distinctIdOrInput.accountId ??
      distinctIdOrInput.account_id ??
      '';
  } else {
    rawDistinct = distinctIdOrInput ?? '';
    rawLogin = loginId ?? '';
  }

  const normDistinct = normalizeIdentityField(
    rawDistinct,
    MAX_DISTINCT_ID_BYTES,
    'distinct_id',
    true,
  );
  const normLogin = normalizeIdentityField(
    rawLogin,
    MAX_LOGIN_ID_BYTES,
    'login_id',
    true,
  );

  if (!normDistinct && !normLogin) {
    throw new Error('missing_identity: at least one of loginId or distinctId is required');
  }

  return {
    distinctId: normDistinct,
    loginId: normLogin,
    distinct_id: normDistinct,
    login_id: normLogin,
  };
}

/**
 * 校验并规范化事件名称（允许预置系统事件白名单或符合 `^[A-Za-z_][A-Za-z0-9_]*$` 的自定义事件名）。
 *
 * @param {string} eventName - 待校验的事件名
 * @returns {string} 去除首尾空白后的合法事件名
 */
export function validateEventName(eventName) {
  if (typeof eventName !== 'string') {
    throw new Error('event_name must be a non-empty string');
  }
  const trimmed = eventName.trim();
  if (!trimmed) {
    throw new Error('event_name must not be empty');
  }
  if (trimmed.length > MAX_EVENT_NAME_LEN) {
    throw new Error(`event_name exceeds ${MAX_EVENT_NAME_LEN} characters`);
  }
  if (PROTECTED_SYSTEM_EVENTS.has(trimmed)) {
    return trimmed;
  }
  if (!IDENTIFIER_REGEX.test(trimmed)) {
    throw new Error(`invalid event_name "${trimmed}": must match ^[A-Za-z_][A-Za-z0-9_]*$`);
  }
  return trimmed;
}

/**
 * 校验并规范化属性键名（允许系统预置属性白名单或长度 <= 64 且符合 `^[A-Za-z_][A-Za-z0-9_]*$` 的自定义键名）。
 *
 * @param {string} propKey - 待校验的属性键名
 * @returns {string} 去除首尾空白后的合法属性键名
 */
export function validatePropertyKey(propKey) {
  if (typeof propKey !== 'string') {
    throw new Error('property key must be a non-empty string');
  }
  const trimmed = propKey.trim();
  if (!trimmed) {
    throw new Error('property key must not be empty');
  }
  if (PROTECTED_SYSTEM_PROP_ALIASES.has(trimmed)) {
    return trimmed;
  }
  if (trimmed.length > MAX_PROP_KEY_LEN || !IDENTIFIER_REGEX.test(trimmed)) {
    throw new Error(
      `invalid property key "${trimmed}": must match ^[A-Za-z_][A-Za-z0-9_]*$ (max ${MAX_PROP_KEY_LEN} chars)`,
    );
  }
  return trimmed;
}

/**
 * 将 `Date` 对象格式化为 ABI 网关标准 ISO-8601 UTC 字符串。
 *
 * @param {Date} date - 日期实例
 * @returns {string} ISO-8601 字符串
 */
export function formatDateForABI(date) {
  if (!(date instanceof Date) || Number.isNaN(date.getTime())) {
    throw new Error('invalid Date value');
  }
  return date.toISOString();
}

/**
 * 规范化单个属性值：
 * - `BigInt` 统一无损序列化为十进制字符串；
 * - 超过 IEEE-754 安全整数范围（`> 2^53 - 1` 或 `< -(2^53 - 1)`）的整数转为十进制字符串；
 * - `Date` 转为 ISO-8601 UTC 字符串；
 * - 数组递归校验标量元素（禁止 `null`、`undefined` 或嵌套对象/数组）。
 *
 * @param {string} propKey - 属性键名
 * @param {unknown} value - 原始属性值
 * @returns {unknown} 规范化后的属性值
 */
export function normalizePropertyValue(propKey, value) {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (typeof value === 'string' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') {
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
  if (value instanceof Date || Object.prototype.toString.call(value) === '[object Date]') {
    const ms = value.getTime();
    if (!Number.isFinite(ms)) {
      throw new Error(`property "${propKey}" contains invalid Date`);
    }
    return value.toISOString();
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
      if (item instanceof Date || Object.prototype.toString.call(item) === '[object Date]') {
        const ms = item.getTime();
        if (!Number.isFinite(ms)) {
          throw new Error(`property "${propKey}[${idx}]" contains invalid Date`);
        }
        return item.toISOString();
      }
      throw new Error(
        `property "${propKey}[${idx}]" must be a scalar value (nested objects or arrays are not allowed)`,
      );
    });
  }
  throw new Error(`property "${propKey}" has unsupported non-scalar type`);
}

/**
 * 校验并规范化属性键值映射表（忽略值为 `null` 或 `undefined` 的键，不修改调用方传入的原对象）。
 *
 * @param {Record<string, unknown> | null | undefined} props - 原始属性对象
 * @returns {Record<string, unknown>} 规范化后的属性对象副本
 */
export function normalizeProperties(props) {
  if (!props) {
    return {};
  }
  if (typeof props !== 'object' || Array.isArray(props)) {
    throw new Error('properties must be a plain object');
  }
  const normalized = {};
  for (const [rawKey, val] of Object.entries(props)) {
    const key = validatePropertyKey(rawKey);
    const normVal = normalizePropertyValue(key, val);
    if (normVal !== undefined) {
      normalized[key] = normVal;
    }
  }
  return normalized;
}

/**
 * 解析 `#time` / `$time` 或显式 `timestamp` 为毫秒级 Unix 时间戳。
 * 支持 `Date` 实例、正整数毫秒/秒时间戳（`< 1e11` 自动按秒转为毫秒）以及 ISO-8601 / `YYYY-MM-DD HH:mm:ss(.SSS)` 字符串。
 *
 * @param {string} key - 字段标识（如 `'#time'`、`'$time'` 或 `'timestamp'`）
 * @param {unknown} raw - 原始时间值
 * @returns {number} 毫秒级时间戳
 */
export function parseEventTimestamp(key, raw) {
  if (raw instanceof Date || Object.prototype.toString.call(raw) === '[object Date]') {
    const ms = raw.getTime();
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error(`invalid ${key}: Date value must be a valid positive timestamp`);
    }
    return ms;
  }
  if (typeof raw === 'bigint') {
    const num = Number(raw);
    if (!Number.isFinite(num) || num <= 0) {
      throw new Error(`invalid ${key}: timestamp must be positive`);
    }
    return num < SECONDS_TO_MS_THRESHOLD ? Math.round(num * 1000) : Math.round(num);
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0 || !Number.isInteger(raw)) {
      throw new Error(`invalid ${key}: numeric timestamp must be a positive integer`);
    }
    return raw < SECONDS_TO_MS_THRESHOLD ? raw * 1000 : raw;
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error(`invalid ${key}: time string must not be empty`);
    }
    const isoCandidate = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:?\d{2})?$/.test(
      trimmed,
    )
      ? trimmed.replace(/\s+/, 'T')
      : trimmed;
    const parsed = Date.parse(isoCandidate);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`invalid ${key} string "${raw}": expected ISO-8601 or "YYYY-MM-DD HH:mm:ss"`);
    }
    return parsed;
  }
  throw new Error(
    `invalid ${key}: must be a Date, positive integer unix timestamp, or ISO-8601 / "YYYY-MM-DD HH:mm:ss" string`,
  );
}

/**
 * 从属性对象中提取 `#time` / `$time` 为毫秒时间戳，并返回剥离了这两个时间键的浅拷贝对象（不修改入参）。
 *
 * @param {Record<string, unknown> | undefined | null} props - 原始属性对象
 * @param {Date | number | string | undefined} explicitTimestamp - 显式传入的顶层 timestamp
 * @returns {{ strippedProps: Record<string, unknown>, timestampMs: number }}
 */
function extractEventTimeAndStrip(props, explicitTimestamp) {
  let explicitMs;
  if (explicitTimestamp !== undefined && explicitTimestamp !== null && explicitTimestamp !== '') {
    explicitMs = parseEventTimestamp('timestamp', explicitTimestamp);
  }

  if (!props || typeof props !== 'object' || Array.isArray(props)) {
    return {
      strippedProps: {},
      timestampMs: explicitMs ?? Date.now(),
    };
  }

  const strippedProps = {};
  let hasHashTime = false;
  let hashTimeVal;
  let hasDollarTime = false;
  let dollarTimeVal;

  for (const [k, v] of Object.entries(props)) {
    const trimmed = k.trim();
    if (trimmed === '#time') {
      hasHashTime = true;
      hashTimeVal = v;
    } else if (trimmed === '$time') {
      hasDollarTime = true;
      dollarTimeVal = v;
    } else {
      strippedProps[k] = v;
    }
  }

  let extractedMs;
  if (hasDollarTime && dollarTimeVal !== undefined) {
    extractedMs = parseEventTimestamp('$time', dollarTimeVal);
  }
  if (hasHashTime && hashTimeVal !== undefined) {
    extractedMs = parseEventTimestamp('#time', hashTimeVal);
  }

  return {
    strippedProps,
    timestampMs: explicitMs ?? extractedMs ?? Date.now(),
  };
}

/**
 * 将采集网关基础地址规范化为批量上报完整端点 `/collect/api/v1/track/batch`。
 *
 * @param {string} rawUrl - 采集网关基础地址或完整 URL
 * @returns {string} 完整批量上报 URL
 */
export function resolveBatchEndpoint(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    throw new Error('serverUrl is required');
  }
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/collect/api/v1/track/batch')) {
    return trimmed;
  }
  return `${trimmed}/collect/api/v1/track/batch`;
}

/**
 * 深拷贝单条 `TrackEvent` 对象，防止外部修改污染队列。
 *
 * @param {Record<string, any>} evt - 事件对象
 * @returns {Record<string, any>} 深拷贝后的事件对象
 */
function cloneTrackEvent(evt) {
  const clonedProps = {};
  if (evt.properties && typeof evt.properties === 'object') {
    for (const [k, v] of Object.entries(evt.properties)) {
      clonedProps[k] = Array.isArray(v) ? [...v] : v;
    }
  }
  const out = {
    event_id: evt.event_id,
    event_name: evt.event_name,
    distinct_id: evt.distinct_id ?? '',
    timestamp: evt.timestamp,
    properties: clonedProps,
  };
  if (evt.login_id) {
    out.login_id = evt.login_id;
  }
  return out;
}

/**
 * 使用 Node.js 原生 `node:http` / `node:https` 发送 HTTP POST 请求。
 *
 * @param {string} endpoint - 完整请求 URL
 * @param {Record<string, string>} headers - HTTP 请求头
 * @param {Buffer | string} bodyBuffer - 请求体 Buffer
 * @param {number} [timeoutMs=10000] - 超时毫秒数
 * @returns {Promise<{ status: number, bodyText: string, headers: Record<string, any> }>}
 */
export function defaultNodeHttpTransport(endpoint, headers, bodyBuffer, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    let parsedUrl;
    try {
      parsedUrl = new URL(endpoint);
    } catch (err) {
      reject(new Error(`Invalid gateway URL "${endpoint}": ${err.message}`));
      return;
    }

    const isHttps = parsedUrl.protocol === 'https:';
    const lib = isHttps ? https : http;
    const payloadBuf = Buffer.isBuffer(bodyBuffer)
      ? bodyBuffer
      : Buffer.from(String(bodyBuffer), 'utf8');

    const req = lib.request(
      parsedUrl,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': String(payloadBuf.byteLength),
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        let totalBytes = 0;
        const maxResponseBytes = 1024 * 1024; // 1 MiB 响应上限保护

        res.on('data', (chunk) => {
          totalBytes += chunk.length;
          if (totalBytes <= maxResponseBytes) {
            chunks.push(chunk);
          }
        });
        res.on('end', () => {
          const bodyText = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            bodyText,
            headers: res.headers ?? {},
          });
        });
      },
    );

    req.on('timeout', () => {
      req.destroy(new Error(`Request to ${endpoint} timed out after ${timeoutMs}ms`));
    });
    req.on('error', (err) => {
      reject(err);
    });

    req.write(payloadBuf);
    req.end();
  });
}

/**
 * 异步延迟指定毫秒数（用于指数退避重试）。
 *
 * @param {number} ms - 延迟毫秒数
 * @returns {Promise<void>}
 */
function sleepMs(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * 向 ABI 采集网关发送批量 payload（内置 `zlib.gzipSync` Gzip 压缩与 `429`/`5xx` 指数退避重试）。
 *
 * @param {object} params
 * @param {string} params.endpoint
 * @param {Record<string, any>} params.payload
 * @param {boolean} [params.compressGzip=false]
 * @param {number} [params.timeoutMs=10000]
 * @param {number} [params.maxRetries=0]
 * @param {number} [params.baseRetryDelayMs=50]
 * @param {Function} [params.transport]
 * @returns {Promise<Record<string, any>>}
 */
async function sendBatchPayloadWithRetry({
  endpoint,
  payload,
  compressGzip = false,
  timeoutMs = 10000,
  maxRetries = 0,
  baseRetryDelayMs = 50,
  transport = defaultNodeHttpTransport,
}) {
  const jsonString = JSON.stringify(payload);
  const rawBuffer = Buffer.from(jsonString, 'utf8');
  const bodyBuffer = compressGzip ? zlib.gzipSync(rawBuffer) : rawBuffer;

  const headers = {
    'Content-Type': 'application/json',
    'User-Agent': USER_AGENT,
  };
  if (compressGzip) {
    headers['Content-Encoding'] = 'gzip';
  }

  const maxAttempts = Math.max(1, (maxRetries ?? 0) + 1);
  let lastError = null;

  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    if (attempt > 0) {
      const backoff = Math.min(baseRetryDelayMs * (2 ** (attempt - 1)), 2000);
      await sleepMs(backoff);
    }

    let response;
    try {
      response = await transport(endpoint, headers, bodyBuffer, timeoutMs);
    } catch (networkErr) {
      lastError = new Error(`send batch request failed: ${networkErr.message}`);
      continue;
    }

    const { status, bodyText } = response;

    if (status === 429 || status >= 500) {
      lastError = new Error(`gateway retryable status ${status}: ${bodyText}`);
      continue;
    }

    let envelope = null;
    if (bodyText && bodyText.trim()) {
      try {
        envelope = JSON.parse(bodyText);
      } catch {
        if (status !== 200) {
          throw new Error(`gateway rejected batch (status=${status}): ${bodyText}`);
        }
        throw new Error(`invalid JSON response from gateway: ${bodyText}`);
      }
    }

    if (status !== 200 || (envelope && envelope.code !== undefined && envelope.code !== 200)) {
      const err = new Error(
        `gateway error (status=${status}, code=${envelope?.code ?? 'unknown'}): ${envelope?.message ?? bodyText}`,
      );
      err.envelope = envelope;
      err.status = status;
      throw err;
    }

    return (
      envelope ?? {
        code: 200,
        message: 'success',
        request_id: '',
        data: {
          accepted: Array.isArray(payload.events) ? payload.events.length : 0,
          rejected: 0,
          dry_run: Boolean(payload.dry_run),
        },
      }
    );
  }

  throw lastError ?? new Error('send batch request failed');
}

/**
 * `StagingConsumer`：支持「第 1 步在内存中录制并预览完整 `POST /collect/api/v1/track/batch` 请求 JSON ->
 * 第 2 步确认无误后通过 `confirmSubmit(targetConsumer)` 或 `submitToGateway(config)` 提交」的两步式 Consumer。
 *
 * 在显式调用 `confirmSubmit` / `submitToGateway` 之前，`flush()` 与 `close()` 均为零网络副作用的空操作。
 */
export class StagingConsumer {
  /**
   * 创建 `StagingConsumer` 实例。
   * 支持传入配置对象 `{ projectId, projectToken, token, debug, dryRun, serverUrl, compressGzip }`
   * 或位置参数 `(projectId, projectToken, dryRun)`。
   *
   * @param {object | number} [optionsOrProjectId=1] - 配置对象或项目 ID
   * @param {string} [projectToken=''] - 项目采集 Token
   * @param {boolean} [dryRun=false] - 是否开启 `dry_run`
   */
  constructor(optionsOrProjectId = 1, projectToken = '', dryRun = false) {
    if (optionsOrProjectId !== null && typeof optionsOrProjectId === 'object') {
      const cfg = optionsOrProjectId;
      this.projectId = Number(cfg.projectId ?? cfg.project_id ?? 1);
      this.projectToken = String(cfg.projectToken ?? cfg.project_token ?? cfg.token ?? '').trim();
      this.debug = Boolean(cfg.debug);
      this.dryRun = Boolean(cfg.dryRun ?? cfg.dry_run);
      this.serverUrl = String(cfg.serverUrl ?? cfg.server_url ?? '').trim();
      this.compressGzip = Boolean(cfg.compressGzip);
      this.timeoutMs = Number(cfg.timeoutMs ?? 10000);
      this.maxRetries = Number(cfg.maxRetries ?? 0);
      this.transport = cfg.transport ?? defaultNodeHttpTransport;
    } else {
      this.projectId = Number(optionsOrProjectId);
      this.projectToken = String(projectToken ?? '').trim();
      this.debug = false;
      this.dryRun = Boolean(dryRun);
      this.serverUrl = '';
      this.compressGzip = false;
      this.timeoutMs = 10000;
      this.maxRetries = 0;
      this.transport = defaultNodeHttpTransport;
    }
    /** @type {Array<Record<string, any>>} */
    this.events = [];
  }

  /**
   * 将单条已校验的事件暂存至内存队列（不产生任何网络请求）。
   *
   * @param {Record<string, any>} event - 标准事件传输对象
   */
  add(event) {
    this.events.push(cloneTrackEvent(event));
  }

  /**
   * 设置生成预览请求体时的 `debug` 标志。
   *
   * @param {boolean} debug - 是否开启 debug
   */
  setDebug(debug) {
    this.debug = Boolean(debug);
  }

  /**
   * 设置生成预览请求体时的 `dry_run` 标志。
   *
   * @param {boolean} dryRun - 是否开启 dry_run
   */
  setDryRun(dryRun) {
    this.dryRun = Boolean(dryRun);
  }

  /**
   * 清空当前暂存的所有事件（可在修改公共属性或配置后重新录制预览）。
   */
  clear() {
    this.events = [];
  }

  /**
   * `clear()` 的兼容别名。
   */
  reset() {
    this.clear();
  }

  /**
   * 获取当前暂存事件列表的深拷贝快照。
   *
   * @returns {Array<Record<string, any>>}
   */
  getEvents() {
    return this.events.map((evt) => cloneTrackEvent(evt));
  }

  /**
   * 构造即将发送至 `POST /collect/api/v1/track/batch` 的完整请求负载对象。
   *
   * @returns {{ project_id: number, project_token: string, debug?: boolean, dry_run?: boolean, events: Array<Record<string, any>> }}
   */
  buildRequestPayload() {
    const payload = {
      project_id: this.projectId,
      project_token: this.projectToken,
    };
    if (this.debug) {
      payload.debug = true;
    }
    if (this.dryRun) {
      payload.dry_run = true;
    }
    payload.events = this.getEvents();
    return payload;
  }

  /**
   * 生成格式化缩进后的 `POST /collect/api/v1/track/batch` 完整请求 JSON 预览字符串（零网络请求）。
   *
   * @returns {string} 2 空格缩进的完整请求 JSON 字符串
   */
  previewRequestJson() {
    return JSON.stringify(this.buildRequestPayload(), null, 2);
  }

  /**
   * `previewRequestJson()` 的大写兼容别名。
   *
   * @returns {string}
   */
  previewRequestJSON() {
    return this.previewRequestJson();
  }

  /**
   * 第 2 步确认提交：将当前暂存的所有事件投递至目标 `Consumer`（如 `BatchConsumer` / `DebugConsumer` / `LoggerConsumer`）并执行 `flush()`，
   * 或者在传入网关配置对象时直接调用 `submitToGateway`。
   *
   * @param {object} targetConsumer - 目标 Consumer 实例（需具备 `add` 与 `flush` 方法）或网关配置对象
   * @returns {Promise<any>}
   */
  async confirmSubmit(targetConsumer) {
    if (!targetConsumer) {
      throw new Error('targetConsumer is required for confirmSubmit');
    }
    if (targetConsumer === this) {
      throw new Error('targetConsumer must not be the same StagingConsumer');
    }
    if (typeof targetConsumer.add === 'function') {
      const snapshot = this.getEvents();
      let lastAddResult;
      for (const evt of snapshot) {
        lastAddResult = await targetConsumer.add(evt);
      }
      if (typeof targetConsumer.flush === 'function') {
        const flushResult = await targetConsumer.flush();
        return flushResult ?? lastAddResult;
      }
      return lastAddResult;
    }
    if (typeof targetConsumer === 'object' && (targetConsumer.serverUrl || this.serverUrl)) {
      return this.submitToGateway(targetConsumer);
    }
    throw new Error('targetConsumer must implement add(event)');
  }

  /**
   * 直接将当前暂存的 `buildRequestPayload()` 发送至 ABI 采集网关 `POST /collect/api/v1/track/batch`，
   * 并返回网关响应信封对象。
   *
   * @param {object} [config={}] - 网关连接与压缩重试配置
   * @param {string} [config.serverUrl] - 采集网关地址
   * @param {number} [config.projectId] - 项目 ID（可选覆盖）
   * @param {string} [config.projectToken] - 项目 Token（可选覆盖）
   * @param {boolean} [config.compressGzip] - 是否使用 Gzip 压缩请求体
   * @param {number} [config.timeoutMs] - 请求超时毫秒数
   * @param {number} [config.maxRetries] - 429/5xx 最大重试次数
   * @param {Function} [config.transport] - 自定义 HTTP 传输函数
   * @returns {Promise<Record<string, any>>} 采集网关返回的 JSON 信封对象
   */
  async submitToGateway(config = {}) {
    const resolvedServerUrl = String(config.serverUrl ?? this.serverUrl ?? '').trim();
    if (!resolvedServerUrl) {
      throw new Error('serverUrl is required for submitToGateway');
    }
    const payload = this.buildRequestPayload();
    if ((!payload.project_id || payload.project_id <= 0) && config.projectId > 0) {
      payload.project_id = Number(config.projectId);
    }
    if (!payload.project_token && (config.projectToken || config.token)) {
      payload.project_token = String(config.projectToken ?? config.token).trim();
    }
    if (!payload.project_id || payload.project_id <= 0 || !payload.project_token) {
      throw new Error('projectId (> 0) and projectToken are required');
    }
    if (!Array.isArray(payload.events) || payload.events.length === 0) {
      throw new Error('no staged events to submit');
    }

    const endpoint = resolveBatchEndpoint(resolvedServerUrl);
    return sendBatchPayloadWithRetry({
      endpoint,
      payload,
      compressGzip: config.compressGzip ?? this.compressGzip,
      timeoutMs: config.timeoutMs ?? this.timeoutMs,
      maxRetries: config.maxRetries ?? this.maxRetries,
      baseRetryDelayMs: config.baseRetryDelayMs ?? 50,
      transport: config.transport ?? this.transport,
    });
  }

  /**
   * `StagingConsumer` 的 `flush()` 为空操作，确保在用户调用 `confirmSubmit` 前不触发网络发送。
   *
   * @returns {Promise<void>}
   */
  async flush() {
    // 保持静默，不触发网络请求
  }

  /**
   * `StagingConsumer` 的 `close()` 为空操作，保留已暂存事件供后续预览或确认提交。
   *
   * @returns {Promise<void>}
   */
  async close() {
    // 保持静默，不清空已录制事件
  }
}

/**
 * `BatchConsumer`：面向生产高吞吐场景的异步批量上报 Consumer。
 *
 * 支持按批量条数（`batchSize`，默认 50，最大 500）与时间间隔（`flushIntervalMs`，默认 3000ms）双触发刷盘、
 * 基于 `zlib.gzipSync` 的 `Content-Encoding: gzip` 压缩传输，以及针对 `429` / `5xx` 的指数退避幂等重试（保留原 `event_id`）。
 */
export class BatchConsumer {
  /**
   * 创建并启动 `BatchConsumer`。
   *
   * @param {object} config - 批量上报配置项
   * @param {string} config.serverUrl - ABI 采集网关地址（如 `'http://127.0.0.1:8081'`）
   * @param {number} config.projectId - ABI 项目 ID（必须 `> 0`）
   * @param {string} [config.projectToken] - 项目写入 Token（兼容 `token` 别名）
   * @param {string} [config.token] - `projectToken` 的兼容别名
   * @param {number} [config.batchSize=50] - 单次批量上报条数上限（默认 50，最大 500）
   * @param {number} [config.flushIntervalMs=3000] - 定时自动刷盘间隔毫秒数（默认 3000ms）
   * @param {number} [config.maxCacheSize=10000] - 内存缓冲队列最大事件条数（默认 10000）
   * @param {number} [config.timeoutMs=10000] - HTTP 请求超时毫秒数
   * @param {number} [config.maxRetries=3] - 遇到网络错误或 429/5xx 时的最大重试次数
   * @param {number} [config.baseRetryDelayMs=50] - 指数退避基础等待毫秒数
   * @param {boolean} [config.compressGzip=true] - 是否开启 `zlib.gzipSync` Gzip 请求体压缩
   * @param {boolean} [config.dryRun=false] - 是否开启网关 `dry_run` 仅校验模式
   * @param {boolean} [config.debug=false] - 是否在批量请求中附带 `debug: true`
   * @param {Function} [config.onError] - 批量发送最终失败时的回调 `(err, droppedEvents) => void`
   * @param {Function} [config.transport] - 自定义底层 HTTP 传输函数
   */
  constructor(config = {}) {
    const serverUrl = String(config.serverUrl ?? config.server_url ?? '').trim();
    const projectId = Number(config.projectId ?? config.project_id ?? 0);
    const projectToken = String(
      config.projectToken ?? config.project_token ?? config.token ?? '',
    ).trim();

    if (!serverUrl) {
      throw new Error('BatchConsumer requires serverUrl');
    }
    if (!Number.isFinite(projectId) || projectId <= 0 || !projectToken) {
      throw new Error('BatchConsumer requires projectId (> 0) and projectToken');
    }

    const rawBatchSize = Number(config.batchSize ?? config.maxBatchSize ?? 50);
    this.endpoint = resolveBatchEndpoint(serverUrl);
    this.projectId = projectId;
    this.projectToken = projectToken;
    this.batchSize = rawBatchSize > 0 ? Math.min(rawBatchSize, 500) : 50;
    this.flushIntervalMs =
      Number(config.flushIntervalMs ?? 3000) > 0 ? Number(config.flushIntervalMs ?? 3000) : 3000;
    this.maxCacheSize =
      Number(config.maxCacheSize ?? config.maxQueueSize ?? 10000) > 0
        ? Number(config.maxCacheSize ?? config.maxQueueSize ?? 10000)
        : 10000;
    this.timeoutMs = Number(config.timeoutMs ?? 10000) > 0 ? Number(config.timeoutMs ?? 10000) : 10000;
    this.maxRetries = Number(config.maxRetries ?? 3) >= 0 ? Number(config.maxRetries ?? 3) : 3;
    this.baseRetryDelayMs =
      Number(config.baseRetryDelayMs ?? 50) > 0 ? Number(config.baseRetryDelayMs ?? 50) : 50;
    this.compressGzip = config.compressGzip !== undefined ? Boolean(config.compressGzip) : true;
    this.dryRun = Boolean(config.dryRun ?? config.dry_run);
    this.debug = Boolean(config.debug);
    this.onError = typeof config.onError === 'function' ? config.onError : null;
    this.transport = config.transport ?? defaultNodeHttpTransport;

    /** @type {Array<Record<string, any>>} */
    this.buffer = [];
    this.closed = false;
    this._flushChain = Promise.resolve(null);

    this.timer = setInterval(() => {
      void this.flush().catch(() => {
        // 定时后台刷盘错误已由 onError 处理，防止触发未捕获 Promise 异常
      });
    }, this.flushIntervalMs);
    if (this.timer && typeof this.timer.unref === 'function') {
      this.timer.unref();
    }
  }

  /**
   * 将单条已校验的事件追加至内存缓冲队列；当队列长度达到 `batchSize` 时自动触发异步批量发送。
   *
   * @param {Record<string, any>} event - 标准事件传输对象
   */
  add(event) {
    if (this.closed) {
      throw new Error('BatchConsumer is already closed');
    }
    if (this.buffer.length >= this.maxCacheSize) {
      throw new Error(`BatchConsumer buffer full (max=${this.maxCacheSize})`);
    }
    this.buffer.push(cloneTrackEvent(event));
    if (this.buffer.length >= this.batchSize) {
      void this.flush().catch(() => {
        // 定量后台刷盘错误通过 onError 回调或显式 flush/close 捕获
      });
    }
  }

  /**
   * 立即将当前缓冲队列中的所有待发送事件按批次发送至采集网关。
   *
   * @returns {Promise<Record<string, any> | null>} 最后一批请求的网关响应信封
   */
  flush() {
    const runFlush = async () => {
      let lastEnvelope = null;
      while (this.buffer.length > 0) {
        const batch = this.buffer.splice(0, this.batchSize);
        const payload = {
          project_id: this.projectId,
          project_token: this.projectToken,
        };
        if (this.debug) {
          payload.debug = true;
        }
        if (this.dryRun) {
          payload.dry_run = true;
        }
        payload.events = batch;

        try {
          lastEnvelope = await sendBatchPayloadWithRetry({
            endpoint: this.endpoint,
            payload,
            compressGzip: this.compressGzip,
            timeoutMs: this.timeoutMs,
            maxRetries: this.maxRetries,
            baseRetryDelayMs: this.baseRetryDelayMs,
            transport: this.transport,
          });
        } catch (err) {
          if (this.onError) {
            this.onError(err, batch);
          }
          throw err;
        }
      }
      return lastEnvelope;
    };

    const nextPromise = this._flushChain.then(runFlush, runFlush);
    this._flushChain = nextPromise.catch(() => null);
    return nextPromise;
  }

  /**
   * 停止后台定时器并排空发送所有剩余缓冲事件。
   *
   * @returns {Promise<Record<string, any> | null>}
   */
  async close() {
    if (this.closed) {
      return this._flushChain;
    }
    this.closed = true;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    return this.flush();
  }
}

/**
 * `LoggerConsumer`：将事件序列化为单行 JSON（Newline-delimited JSON / `.jsonl`）写入本地磁盘，
 * 支持按天（`DAILY`）、按小时（`HOURLY`）及按单文件大小上限自动切分轮转，供 Filebeat / Vector / LogBus 采集。
 */
export class LoggerConsumer {
  /**
   * 创建本地 JSONL 落盘 Consumer。
   *
   * @param {object} config - 本地日志配置项
   * @param {string} config.directory - 日志输出目录路径（不存在时自动递归创建）
   * @param {string} [config.filePrefix='abi.log'] - 日志文件名前缀
   * @param {'DAILY' | 'HOURLY'} [config.rotateMode='DAILY'] - 轮转粒度：`'DAILY'`（按天）或 `'HOURLY'`（按小时）
   * @param {number} [config.maxFileSizeMB=0] - 单个日志文件最大 MB 上限（超出后自动追加 `_1`, `_2` 分片后缀，`0` 表示不限制）
   * @param {number} [config.maxFileSizeBytes=0] - 单个日志文件最大字节数上限（优先级高于 `maxFileSizeMB`，便于精确控制分片）
   * @param {boolean} [config.useUTC=true] - 计算日期/小时切分周期时是否使用 UTC 时间
   * @param {() => Date} [config.nowFn] - 自定义当前时间获取函数（便于单元测试注入固定时间）
   */
  constructor(config = {}) {
    const directory = String(config.directory ?? '').trim();
    if (!directory) {
      throw new Error('LoggerConsumer requires directory');
    }
    const rawPrefix = String(config.filePrefix ?? 'abi.log').trim() || 'abi.log';
    const cleanPrefix = rawPrefix.endsWith('.jsonl')
      ? rawPrefix.slice(0, -'.jsonl'.length)
      : rawPrefix;
    const rotateMode = String(config.rotateMode ?? RotateMode.DAILY).toUpperCase();
    if (rotateMode !== RotateMode.DAILY && rotateMode !== RotateMode.HOURLY) {
      throw new Error(`Invalid rotateMode "${rotateMode}": expected DAILY or HOURLY`);
    }

    fs.mkdirSync(directory, { recursive: true });

    this.directory = directory;
    this.filePrefix = cleanPrefix;
    this.rotateMode = rotateMode;
    this.maxFileSizeBytes =
      Number(config.maxFileSizeBytes ?? 0) > 0
        ? Number(config.maxFileSizeBytes)
        : Number(config.maxFileSizeMB ?? 0) > 0
          ? Math.floor(Number(config.maxFileSizeMB) * 1024 * 1024)
          : 0;
    this.useUTC = config.useUTC !== undefined ? Boolean(config.useUTC) : true;
    this.nowFn = typeof config.nowFn === 'function' ? config.nowFn : () => new Date();

    this.currentPeriod = '';
    this.currentIndex = 0;
    this.currentBytes = 0;
    this.currentFilePath = '';
    /** @type {number | null} */
    this.fd = null;
    this.closed = false;
  }

  /**
   * 根据当前时间格式化切分周期字符串（`YYYY-MM-DD` 或 `YYYY-MM-DD-HH`）。
   *
   * @param {Date} date
   * @returns {string}
   */
  _formatPeriod(date) {
    const year = this.useUTC ? date.getUTCFullYear() : date.getFullYear();
    const month = String((this.useUTC ? date.getUTCMonth() : date.getMonth()) + 1).padStart(2, '0');
    const day = String(this.useUTC ? date.getUTCDate() : date.getDate()).padStart(2, '0');
    if (this.rotateMode === RotateMode.HOURLY) {
      const hour = String(this.useUTC ? date.getUTCHours() : date.getHours()).padStart(2, '0');
      return `${year}-${month}-${day}-${hour}`;
    }
    return `${year}-${month}-${day}`;
  }

  /**
   * 确保当前写入的目标 `.jsonl` 文件描述符已打开且满足周期与文件体积切分条件。
   *
   * @param {number} incomingBytes - 即将写入的单行字节数
   */
  _ensureFile(incomingBytes) {
    const now = this.nowFn();
    const period = this._formatPeriod(now);
    const sizeExceeded =
      this.maxFileSizeBytes > 0 &&
      this.currentBytes > 0 &&
      this.currentBytes + incomingBytes > this.maxFileSizeBytes;

    const needRotate = this.fd === null || this.currentPeriod !== period || sizeExceeded;
    if (!needRotate) {
      return;
    }

    if (this.fd !== null) {
      try {
        fs.closeSync(this.fd);
      } catch {
        // 忽略关闭旧文件描述符异常
      }
      this.fd = null;
    }

    if (this.currentPeriod !== period) {
      this.currentPeriod = period;
      this.currentIndex = 0;
    } else if (sizeExceeded) {
      this.currentIndex += 1;
    }

    const suffix =
      this.currentIndex > 0 ? `${this.currentPeriod}_${this.currentIndex}` : this.currentPeriod;
    const fileName = `${this.filePrefix}.${suffix}.jsonl`;
    const fullPath = path.join(this.directory, fileName);

    const fd = fs.openSync(fullPath, 'a', 0o644);
    let size = 0;
    try {
      size = fs.fstatSync(fd).size;
    } catch {
      size = 0;
    }

    this.fd = fd;
    this.currentBytes = size;
    this.currentFilePath = fullPath;
  }

  /**
   * 将单条事件以 JSONL 格式追加写入当前活跃的本地 `.jsonl` 文件。
   *
   * @param {Record<string, any>} event - 标准事件传输对象
   */
  add(event) {
    if (this.closed) {
      throw new Error('LoggerConsumer is already closed');
    }
    const lineBuffer = Buffer.from(`${JSON.stringify(event)}\n`, 'utf8');
    this._ensureFile(lineBuffer.byteLength);
    const written = fs.writeSync(this.fd, lineBuffer);
    this.currentBytes += written;
  }

  /**
   * 获取当前活跃 `.jsonl` 日志文件的完整路径。
   *
   * @returns {string}
   */
  getFilePath() {
    return this.currentFilePath;
  }

  /**
   * 将操作系统文件缓冲区强制刷盘（`fsync`）。
   *
   * @returns {Promise<void>}
   */
  async flush() {
    if (this.fd !== null) {
      fs.fsyncSync(this.fd);
    }
  }

  /**
   * 刷盘并安全关闭当前打开的日志文件描述符。
   *
   * @returns {Promise<void>}
   */
  async close() {
    if (this.closed) {
      return;
    }
    this.closed = true;
    if (this.fd !== null) {
      try {
        fs.fsyncSync(this.fd);
      } finally {
        fs.closeSync(this.fd);
        this.fd = null;
      }
    }
  }
}

/**
 * `DebugConsumer`：面向研发联调期的实时同步校验 Consumer。
 *
 * 每次上报自动携带 `debug: true`（可选 `dryRun: true` 仅校验不落库 Kafka / StarRocks），
 * 若采集网关返回 L3/L4 元数据或契约校验错误（`rejected > 0`），立即抛出包含详细 `reason` 的异常。
 */
export class DebugConsumer {
  /**
   * 创建 `DebugConsumer`。
   *
   * @param {object} config - 调试消费者配置项
   * @param {string} config.serverUrl - ABI 采集网关地址
   * @param {number} config.projectId - 项目 ID（必须 `> 0`）
   * @param {string} [config.projectToken] - 项目写入 Token（兼容 `token` 别名）
   * @param {string} [config.token] - `projectToken` 的兼容别名
   * @param {boolean} [config.dryRun=false] - 是否开启 `dry_run: true`（仅执行网关校验，不写入存储）
   * @param {number} [config.timeoutMs=10000] - 请求超时毫秒数
   * @param {Function} [config.transport] - 自定义底层 HTTP 传输函数
   */
  constructor(config = {}) {
    const serverUrl = String(config.serverUrl ?? config.server_url ?? '').trim();
    const projectId = Number(config.projectId ?? config.project_id ?? 0);
    const projectToken = String(
      config.projectToken ?? config.project_token ?? config.token ?? '',
    ).trim();

    if (!serverUrl) {
      throw new Error('DebugConsumer requires serverUrl');
    }
    if (!Number.isFinite(projectId) || projectId <= 0 || !projectToken) {
      throw new Error('DebugConsumer requires projectId (> 0) and projectToken');
    }

    this.endpoint = resolveBatchEndpoint(serverUrl);
    this.projectId = projectId;
    this.projectToken = projectToken;
    this.dryRun = Boolean(config.dryRun ?? config.dry_run);
    this.timeoutMs = Number(config.timeoutMs ?? 10000) > 0 ? Number(config.timeoutMs ?? 10000) : 10000;
    this.transport = config.transport ?? defaultNodeHttpTransport;
  }

  /**
   * 同步向网关发送单条开启 `debug: true` 的事件并校验返回结果。
   *
   * @param {Record<string, any>} event - 标准事件传输对象
   * @returns {Promise<Record<string, any>>} 采集网关返回的响应信封
   */
  async add(event) {
    const payload = {
      project_id: this.projectId,
      project_token: this.projectToken,
      debug: true,
      dry_run: this.dryRun,
      events: [cloneTrackEvent(event)],
    };

    const envelope = await sendBatchPayloadWithRetry({
      endpoint: this.endpoint,
      payload,
      compressGzip: false,
      timeoutMs: this.timeoutMs,
      maxRetries: 0,
      transport: this.transport,
    });

    const rejected = Number(envelope?.data?.rejected ?? 0);
    const errors = Array.isArray(envelope?.data?.errors) ? envelope.data.errors : [];
    if (rejected > 0 || errors.length > 0) {
      const reason = errors[0]?.reason ?? 'unknown validation error';
      const err = new Error(
        `debug validation failed for event "${event.event_name}": ${reason}`,
      );
      err.envelope = envelope;
      throw err;
    }

    return envelope;
  }

  /**
   * `DebugConsumer` 逐条即时发送，`flush()` 为空操作。
   *
   * @returns {Promise<void>}
   */
  async flush() {
    // 实时同步发送无需缓冲刷盘
  }

  /**
   * 关闭 `DebugConsumer`。
   *
   * @returns {Promise<void>}
   */
  async close() {
    // 无后台资源需释放
  }
}

/**
 * `AbiNodeAnalytics`：ABI Node.js 服务端无状态多用户行为分析核心客户端（对标数数科技 ThinkingData Node.js Server SDK v3.4）。
 *
 * 与运行在单用户浏览器上的 `@anylink/abi-web-sdk` 不同，`AbiNodeAnalytics` 专为后端多租户/多用户共享实例设计：
 * - 内部不维护任何单个用户的会话状态或本地存储；
 * - 每次调用 `track*` / `user*` 均须显式传入当前请求用户的身份（`loginId` 实名账号 ID 与/或 `distinctId` 访客/设备 ID，至少一个非空）；
 * - 只要任意事件同时携带非空 `login_id` 与 `distinct_id`，Flink ETL 即自动完成全链路身份关联；
 * - 支持对象参数风格 `sdk.track({ loginId, distinctId, eventName, properties })` 与位置参数便捷签名 `sdk.track(loginId, distinctId, eventName, properties, options)`。
 */
export class AbiNodeAnalytics {
  /**
   * 使用指定的 `Consumer` 创建 `AbiNodeAnalytics` 实例。
   *
   * @param {StagingConsumer | BatchConsumer | LoggerConsumer | DebugConsumer | { add: Function, flush?: Function, close?: Function }} consumer - 底层事件消费者
   */
  constructor(consumer) {
    if (!consumer || typeof consumer.add !== 'function') {
      throw new Error('AbiNodeAnalytics requires a valid consumer implementing add(event)');
    }
    this.consumer = consumer;
    /** @type {Record<string, unknown>} */
    this.superProperties = {};
    /** @type {(() => Record<string, unknown>) | null} */
    this.dynamicSuperPropsFn = null;
  }

  /**
   * 合并注册全局静态公共属性（仅注入非 `$user_*` / `#user_*` 的行为事件，覆盖优先级：`静态公共属性 < 动态公共属性 < 单次事件属性`）。
   *
   * @param {Record<string, unknown>} props - 静态公共属性键值对（仅放置服务名、机房区域等全局环境信息，切勿放入单用户 IP 或设备信息）
   */
  setSuperProperties(props) {
    const clean = normalizeProperties(props);
    this.superProperties = {
      ...this.superProperties,
      ...clean,
    };
  }

  /**
   * 按属性名移除单个已注册的全局静态公共属性。
   *
   * @param {string} key - 要移除的公共属性键名
   */
  unsetSuperProperty(key) {
    if (typeof key !== 'string') {
      return;
    }
    delete this.superProperties[key];
    delete this.superProperties[key.trim()];
  }

  /**
   * 清空全部已注册的全局静态公共属性。
   */
  clearSuperProperties() {
    this.superProperties = {};
  }

  /**
   * 获取当前全局静态公共属性的浅拷贝快照（外部修改返回对象不会影响 SDK 内部状态）。
   *
   * @returns {Record<string, unknown>}
   */
  getSuperProperties() {
    return { ...this.superProperties };
  }

  /**
   * 注册动态公共属性回调函数；每次上报非 `$user_*` / `#user_*` 行为事件时动态调用并清洗返回值。
   * 传入 `null` 或 `undefined` 可移除已注册的回调。
   *
   * @param {(() => Record<string, unknown>) | null | undefined} fn - 动态公共属性生成函数
   */
  setDynamicSuperProperties(fn) {
    if (fn !== null && fn !== undefined && typeof fn !== 'function') {
      throw new Error('setDynamicSuperProperties expects a function or null');
    }
    this.dynamicSuperPropsFn = fn ?? null;
  }

  /**
   * 内部核心事件组装与校验方法。
   *
   * @param {object} opts
   * @param {string} opts.eventName
   * @param {string} [opts.loginId]
   * @param {string} [opts.distinctId]
   * @param {string} [opts.eventId]
   * @param {Date | number | string} [opts.timestamp]
   * @param {Record<string, unknown>} [opts.properties]
   * @param {boolean} [includeSuperProps=true]
   * @returns {Record<string, any>}
   */
  _buildEvent(opts, includeSuperProps = true) {
    const eventName = validateEventName(opts.eventName);
    const identity = normalizeIdentity({
      distinctId: opts.distinctId,
      loginId: opts.loginId ?? opts.accountId,
    });

    const eventId = opts.eventId
      ? normalizeIdentityField(opts.eventId, MAX_EVENT_ID_BYTES, 'event_id', false)
      : generateUUIDv4();

    const { strippedProps, timestampMs } = extractEventTimeAndStrip(
      opts.properties,
      opts.timestamp,
    );
    const cleanProps = normalizeProperties(strippedProps);

    const isUserEvent =
      eventName.startsWith('$user_') || eventName.startsWith('#user_');

    const finalProps = {};
    if (includeSuperProps && !isUserEvent) {
      Object.assign(finalProps, this.superProperties);
      if (this.dynamicSuperPropsFn) {
        const dynRaw = this.dynamicSuperPropsFn();
        const cleanDyn = normalizeProperties(dynRaw);
        Object.assign(finalProps, cleanDyn);
      }
    }
    Object.assign(finalProps, cleanProps);

    const event = {
      event_id: eventId,
      event_name: eventName,
      distinct_id: identity.distinctId,
      timestamp: timestampMs,
      properties: finalProps,
    };
    if (identity.loginId) {
      event.login_id = identity.loginId;
    }
    return event;
  }

  /**
   * 将构造完成的事件交由 Consumer 处理：
   * - 若 Consumer.add 返回 Promise（如 `DebugConsumer`），则在 Promise 完成后返回 `event.event_id`；
   * - 若 Consumer.add 同步完成（如 `StagingConsumer` / `BatchConsumer` / `LoggerConsumer`），则直接返回 `event.event_id`（同时兼容 `await` 调用）。
   *
   * @param {Record<string, any>} event
   * @returns {string | Promise<string>}
   */
  _dispatchEvent(event) {
    const res = this.consumer.add(event);
    if (res && typeof res.then === 'function') {
      return res.then(() => event.event_id);
    }
    return event.event_id;
  }

  /**
   * 记录一条用户行为事件。
   *
   * 支持两种调用签名：
   * 1. 对象签名：`sdk.track({ loginId, distinctId, eventName, properties, eventId, timestamp })`
   * 2. 便捷位置签名：`sdk.track(loginId, distinctId, eventName, properties, options)`
   *
   * @param {string | { loginId?: string, accountId?: string, distinctId?: string, eventName: string, properties?: Record<string, unknown>, eventId?: string, timestamp?: Date | number | string }} loginIdOrOptions
   * @param {string} [distinctId]
   * @param {string} [eventName]
   * @param {Record<string, unknown>} [properties]
   * @param {{ distinctId?: string, loginId?: string, accountId?: string, eventId?: string, timestamp?: Date | number | string }} [options]
   * @returns {string | Promise<string>} 事件唯一标识 `event_id`
   */
  track(loginIdOrOptions, distinctId, eventName, properties, options) {
    if (loginIdOrOptions !== null && typeof loginIdOrOptions === 'object') {
      const evt = this._buildEvent(
        {
          eventName: loginIdOrOptions.eventName ?? loginIdOrOptions.event_name,
          loginId:
            loginIdOrOptions.loginId ??
            loginIdOrOptions.login_id ??
            loginIdOrOptions.accountId ??
            loginIdOrOptions.account_id,
          distinctId: loginIdOrOptions.distinctId ?? loginIdOrOptions.distinct_id,
          eventId: loginIdOrOptions.eventId ?? loginIdOrOptions.event_id,
          timestamp: loginIdOrOptions.timestamp,
          properties: loginIdOrOptions.properties,
        },
        true,
      );
      return this._dispatchEvent(evt);
    }

    const evt = this._buildEvent(
      {
        eventName,
        loginId: options?.loginId ?? options?.accountId ?? loginIdOrOptions,
        distinctId: options?.distinctId ?? distinctId,
        eventId: options?.eventId,
        timestamp: options?.timestamp,
        properties,
      },
      true,
    );
    return this._dispatchEvent(evt);
  }

  /**
   * 使用完整自定义选项对象记录事件（同 `sdk.track(options)`）。
   *
   * @param {{ loginId?: string, accountId?: string, distinctId?: string, eventName: string, properties?: Record<string, unknown>, eventId?: string, timestamp?: Date | number | string }} options
   * @returns {string | Promise<string>}
   */
  trackWithOptions(options) {
    if (!options || typeof options !== 'object') {
      throw new Error('trackWithOptions requires an options object');
    }
    return this.track(options);
  }

  /**
   * 保留方法签名，但在当前版本显式抛出异常且绝不入队伪造的普通 `track` 事件（D7① / G6 门禁）。
   *
   * @deprecated [当前版本未开放 / Unsupported in current version]
   * 严守 D7① / G6 门禁，当前 StarRocks dwd_events 存储模型尚未开放 trackFirst 首次去重支持；如需同日重试幂等请通过 `track({ eventId })` 上报。
   */
  trackFirst(loginIdOrOptions, distinctId, eventName, firstCheckId, properties, options) {
    void loginIdOrOptions;
    void distinctId;
    void eventName;
    void firstCheckId;
    void properties;
    void options;
    throw new Error(
      'trackFirst is unsupported in current version (D7① / G6 gate); use track({ eventId }) for same-day idempotency',
    );
  }

  /**
   * 保留方法签名，但在当前版本显式抛出异常且绝不入队伪造的普通 `track` 事件（D7① / G6 门禁）。
   *
   * @deprecated [当前版本未开放 / Unsupported in current version]
   * 严守 D7① / G6 门禁，当前 StarRocks dwd_events 存储模型尚未开放 trackUpdate 局部属性更新，禁止伪装成普通 track 覆盖抹掉其他属性。
   */
  trackUpdate(loginIdOrOptions, distinctId, eventName, eventId, properties, options) {
    void loginIdOrOptions;
    void distinctId;
    void eventName;
    void eventId;
    void properties;
    void options;
    throw new Error(
      'trackUpdate is unsupported in current version (D7① / G6 gate); use track({ eventId }) for same-day idempotency',
    );
  }

  /**
   * 保留方法签名，但在当前版本显式抛出异常且绝不入队伪造的普通 `track` 事件（D7① / G6 门禁）。
   *
   * @deprecated [当前版本未开放 / Unsupported in current version]
   * 严守 D7① / G6 门禁，当前 StarRocks dwd_events 存储模型尚未开放 trackOverwrite 跨分区覆盖重写支持。
   */
  trackOverwrite(loginIdOrOptions, distinctId, eventName, eventId, properties, options) {
    void loginIdOrOptions;
    void distinctId;
    void eventName;
    void eventId;
    void properties;
    void options;
    throw new Error(
      'trackOverwrite is unsupported in current version (D7① / G6 gate); use track({ eventId }) for same-day idempotency',
    );
  }

  /**
   * 内部通用画像事件发送方法（强制隔离静态与动态公共属性）。
   *
   * @param {string} opEventName - `$user_*` 系统事件名
   * @param {string | object} loginIdOrOptions
   * @param {string} [distinctId]
   * @param {Record<string, unknown>} [properties]
   * @param {object} [options]
   * @returns {string | Promise<string>}
   */
  _sendUserEvent(opEventName, loginIdOrOptions, distinctId, properties, options) {
    if (loginIdOrOptions !== null && typeof loginIdOrOptions === 'object') {
      const evt = this._buildEvent(
        {
          eventName: opEventName,
          loginId:
            loginIdOrOptions.loginId ??
            loginIdOrOptions.login_id ??
            loginIdOrOptions.accountId ??
            loginIdOrOptions.account_id,
          distinctId: loginIdOrOptions.distinctId ?? loginIdOrOptions.distinct_id,
          eventId: loginIdOrOptions.eventId ?? loginIdOrOptions.event_id,
          timestamp: loginIdOrOptions.timestamp,
          properties: loginIdOrOptions.properties,
        },
        false,
      );
      return this._dispatchEvent(evt);
    }

    const evt = this._buildEvent(
      {
        eventName: opEventName,
        loginId: options?.loginId ?? options?.accountId ?? loginIdOrOptions,
        distinctId: options?.distinctId ?? distinctId,
        eventId: options?.eventId,
        timestamp: options?.timestamp,
        properties,
      },
      false,
    );
    return this._dispatchEvent(evt);
  }

  /**
   * 覆盖设置用户画像属性（`$user_set`），更新 StarRocks `abi.dim_users` 维度表最新值（自动隔离公共属性）。
   *
   * @param {string | { loginId?: string, accountId?: string, distinctId?: string, properties: Record<string, unknown>, eventId?: string, timestamp?: Date | number | string }} loginIdOrOptions
   * @param {string} [distinctId]
   * @param {Record<string, unknown>} [properties]
   * @param {{ distinctId?: string, eventId?: string, timestamp?: Date | number | string }} [options]
   * @returns {string | Promise<string>}
   */
  userSet(loginIdOrOptions, distinctId, properties, options) {
    return this._sendUserEvent('$user_set', loginIdOrOptions, distinctId, properties, options);
  }

  /**
   * 仅当用户画像属性尚未被设置时执行首次初始化写入（`$user_set_once`），适用于首次归因渠道、注册时间等不可变属性。
   *
   * @param {string | { loginId?: string, accountId?: string, distinctId?: string, properties: Record<string, unknown>, eventId?: string, timestamp?: Date | number | string }} loginIdOrOptions
   * @param {string} [distinctId]
   * @param {Record<string, unknown>} [properties]
   * @param {{ distinctId?: string, eventId?: string, timestamp?: Date | number | string }} [options]
   * @returns {string | Promise<string>}
   */
  userSetOnce(loginIdOrOptions, distinctId, properties, options) {
    return this._sendUserEvent(
      '$user_set_once',
      loginIdOrOptions,
      distinctId,
      properties,
      options,
    );
  }

  /**
   * 对数值型用户画像属性执行原子增量累加或扣减（`$user_add`）；若传入非有限数字属性将立即抛出校验异常。
   *
   * @param {string | { loginId?: string, accountId?: string, distinctId?: string, properties: Record<string, unknown>, eventId?: string, timestamp?: Date | number | string }} loginIdOrOptions
   * @param {string} [distinctId]
   * @param {Record<string, unknown>} [properties]
   * @param {{ distinctId?: string, eventId?: string, timestamp?: Date | number | string }} [options]
   * @returns {string | Promise<string>}
   */
  userAdd(loginIdOrOptions, distinctId, properties, options) {
    const targetProps =
      loginIdOrOptions !== null && typeof loginIdOrOptions === 'object'
        ? loginIdOrOptions.properties
        : properties;

    if (!targetProps || typeof targetProps !== 'object' || Array.isArray(targetProps)) {
      throw new Error('userAdd requires a non-empty numeric properties object');
    }

    for (const [k, v] of Object.entries(targetProps)) {
      const trimmed = k.trim();
      if (trimmed === '#time' || trimmed === '$time') {
        continue;
      }
      validatePropertyKey(trimmed);
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`userAdd property "${k}" must be a finite number`);
      }
    }

    return this._sendUserEvent('$user_add', loginIdOrOptions, distinctId, properties, options);
  }

  /**
   * 向列表型用户画像属性追加新元素（`$user_append`，不去重）。
   *
   * @param {string | { loginId?: string, accountId?: string, distinctId?: string, properties: Record<string, unknown>, eventId?: string, timestamp?: Date | number | string }} loginIdOrOptions
   * @param {string} [distinctId]
   * @param {Record<string, unknown>} [properties]
   * @param {{ distinctId?: string, eventId?: string, timestamp?: Date | number | string }} [options]
   * @returns {string | Promise<string>}
   */
  userAppend(loginIdOrOptions, distinctId, properties, options) {
    const targetProps =
      loginIdOrOptions !== null && typeof loginIdOrOptions === 'object'
        ? loginIdOrOptions.properties
        : properties;

    if (!targetProps || typeof targetProps !== 'object' || Array.isArray(targetProps)) {
      throw new Error('userAppend requires a properties object');
    }
    for (const [k, v] of Object.entries(targetProps)) {
      const trimmed = k.trim();
      if (trimmed === '#time' || trimmed === '$time') {
        continue;
      }
      if (!Array.isArray(v)) {
        throw new Error(`userAppend property "${k}" must be an array`);
      }
    }

    return this._sendUserEvent('$user_append', loginIdOrOptions, distinctId, properties, options);
  }

  /**
   * 向列表型用户画像属性去重追加元素（`$user_uniq_append`）。
   *
   * @param {string | { loginId?: string, accountId?: string, distinctId?: string, properties: Record<string, unknown>, eventId?: string, timestamp?: Date | number | string }} loginIdOrOptions
   * @param {string} [distinctId]
   * @param {Record<string, unknown>} [properties]
   * @param {{ distinctId?: string, eventId?: string, timestamp?: Date | number | string }} [options]
   * @returns {string | Promise<string>}
   */
  userUniqAppend(loginIdOrOptions, distinctId, properties, options) {
    const targetProps =
      loginIdOrOptions !== null && typeof loginIdOrOptions === 'object'
        ? loginIdOrOptions.properties
        : properties;

    if (!targetProps || typeof targetProps !== 'object' || Array.isArray(targetProps)) {
      throw new Error('userUniqAppend requires a properties object');
    }
    for (const [k, v] of Object.entries(targetProps)) {
      const trimmed = k.trim();
      if (trimmed === '#time' || trimmed === '$time') {
        continue;
      }
      if (!Array.isArray(v)) {
        throw new Error(`userUniqAppend property "${k}" must be an array`);
      }
    }

    return this._sendUserEvent(
      '$user_uniq_append',
      loginIdOrOptions,
      distinctId,
      properties,
      options,
    );
  }

  /**
   * 清空并移除指定名称的用户画像属性键（`$user_unset`）。
   *
   * 支持对象签名 `sdk.userUnset({ loginId, distinctId, keys: ['k1', 'k2'] })`
   * 与位置签名 `sdk.userUnset(loginId, distinctId, 'k1', 'k2')` 或 `sdk.userUnset(loginId, distinctId, ['k1', 'k2'])`。
   *
   * @param {string | { loginId?: string, accountId?: string, distinctId?: string, keys?: string[], properties?: Record<string, unknown>, eventId?: string, timestamp?: Date | number | string }} loginIdOrOptions
   * @param {string} [distinctId]
   * @param {...(string | string[])} keys
   * @returns {string | Promise<string>}
   */
  userUnset(loginIdOrOptions, distinctId, ...keys) {
    if (loginIdOrOptions !== null && typeof loginIdOrOptions === 'object') {
      const props = {};
      if (Array.isArray(loginIdOrOptions.keys)) {
        for (const k of loginIdOrOptions.keys) {
          props[validatePropertyKey(k)] = '';
        }
      } else if (loginIdOrOptions.properties && typeof loginIdOrOptions.properties === 'object') {
        for (const k of Object.keys(loginIdOrOptions.properties)) {
          props[validatePropertyKey(k)] = '';
        }
      }
      if (Object.keys(props).length === 0) {
        throw new Error('userUnset requires at least one property key');
      }
      return this._sendUserEvent('$user_unset', {
        ...loginIdOrOptions,
        properties: props,
      });
    }

    const flatKeys = keys.flat();
    if (flatKeys.length === 0) {
      throw new Error('userUnset requires at least one property key');
    }
    const props = {};
    for (const k of flatKeys) {
      props[validatePropertyKey(k)] = '';
    }
    return this._sendUserEvent('$user_unset', loginIdOrOptions, distinctId, props);
  }

  /**
   * 删除指定用户的画像记录（发送 `$user_del` 系统事件）。
   *
   * 支持对象签名 `sdk.userDelete({ loginId, distinctId, eventId, timestamp })`
   * 与位置签名 `sdk.userDelete(loginId, distinctId, options)`。
   *
   * @param {string | { loginId?: string, accountId?: string, distinctId?: string, eventId?: string, timestamp?: Date | number | string }} loginIdOrOptions
   * @param {string} [distinctId]
   * @param {{ distinctId?: string, eventId?: string, timestamp?: Date | number | string }} [options]
   * @returns {string | Promise<string>}
   */
  userDelete(loginIdOrOptions, distinctId, options) {
    return this._sendUserEvent('$user_del', loginIdOrOptions, distinctId, {}, options);
  }

  /**
   * 立即将底层 Consumer 缓冲的所有事件刷盘或批量提交至网关。
   *
   * @returns {Promise<any>}
   */
  async flush() {
    if (typeof this.consumer.flush === 'function') {
      return this.consumer.flush();
    }
    return undefined;
  }

  /**
   * 刷盘排空所有缓冲事件并安全关闭底层 Consumer（推荐在进程退出信号 `SIGTERM` / `SIGINT` 中调用）。
   *
   * @returns {Promise<any>}
   */
  async close() {
    if (typeof this.consumer.close === 'function') {
      return this.consumer.close();
    }
    return undefined;
  }
}

export default AbiNodeAnalytics;
