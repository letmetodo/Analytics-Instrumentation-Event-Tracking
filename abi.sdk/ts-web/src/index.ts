import {
  BrowserLocalStorageAdapter,
  type AbiStorageAdapter,
} from './storage.js';
import {
  MAX_DISTINCT_ID_BYTES,
  MAX_EVENT_ID_BYTES,
  MAX_LOGIN_ID_BYTES,
  normalizeIdentityField,
  normalizeProperties,
  validateEventName,
  validatePropertyKey,
} from './validator.js';

export * from './storage.js';
export * from './validator.js';
export * from './adapters/miniapp.js';
export * from './adapters/react-native.js';
export * from './adapters/h5-bridge.js';
export * from './adapters/game-engines.js';

/**
 * 网络传输层响应结果。
 */
export interface AbiTransportResponse {
  /** HTTP 状态码（例如 200 表示网关接收成功，429/5xx 触发离线队列保留与后续重试）。 */
  status: number;
  /** 采集网关返回的原始响应文本。 */
  bodyText: string;
}

/**
 * 自定义网络传输适配器函数签名（可用于桥接微信小程序 `wx.request`、测试拦截或自定义重试网关）。
 */
export type AbiTransportFn = (
  url: string,
  headers: Record<string, string>,
  body: string,
) => Promise<AbiTransportResponse>;

/**
 * 浏览器端全埋点（Auto-Track）配置项。
 */
export interface AbiAutoTrackOptions {
  /** 是否自动监听 SPA 路由切换与页面加载并上报 `$pageview`。 */
  pageView?: boolean;
  /** 是否自动统计页面停留时长并在离开/隐藏时上报 `$AppEnd`（含 `$duration` 与 `sendBeacon` 兜底）。 */
  pageLeave?: boolean;
  /** 是否自动采集 `<button>`、`<a>`、`<input>` 及 `[data-abi-track]` 元素点击并上报 `$AppClick`。 */
  webClick?: boolean;
}

/**
 * ABI SDK 初始化核心配置项。
 */
export interface AbiSdkConfig {
  /** 采集网关服务地址（如 `https://ingest.abi.example.com` 或 `http://localhost:8081`）。 */
  serverUrl: string;
  /** 目标项目数字 ID（必须 `> 0`）。 */
  projectId: number;
  /** 项目采集上报密钥（对应网关 `project_token` 字段，兼容使用 `appKey` 别名传入）。 */
  token?: string;
  /** `token` 的兼容别名。 */
  appKey?: string;
  /** 宿主应用版本号（自动注入预置属性 `$app_version`）。 */
  appVersion?: string;
  /** 自定义 SDK 库名称（默认 `'abi-web-sdk'`）。 */
  libName?: string;
  /** 自定义 SDK 版本号（默认 `'1.0.0'`）。 */
  libVersion?: string;
  /** 单次批量上报最大事件条数（默认 `20`，上限 `500`）。 */
  maxBatchSize?: number;
  /** `maxBatchSize` 的兼容别名。 */
  batchSize?: number;
  /** 定时自动刷新上报队列的毫秒间隔（默认 `5000` ms）。 */
  flushIntervalMs?: number;
  /** 本地离线缓冲队列的最大容量上限（默认 `1000` 条，超出时淘汰最早事件）。 */
  maxQueueSize?: number;
  /** 是否开启调试模式（开启后每次入队立即触发 `flush` 并携带 `debug: true`）。 */
  debug?: boolean;
  /** 是否开启 Dry-Run 仅校验模式（网关校验鉴权与 Schema 但不写入 Kafka / StarRocks）。 */
  dryRun?: boolean;
  /** 浏览器端全埋点开关配置。 */
  autoTrack?: AbiAutoTrackOptions;
  /** 自定义持久化存储适配器（如小程序同步存储或 React Native MMKV）。 */
  storage?: AbiStorageAdapter;
  /** 自定义 HTTP 传输适配器。 */
  transport?: AbiTransportFn;
  /** 平台环境预置属性提供函数（由小程序/RN 适配器注入操作系统与机型信息）。 */
  presetProperties?: () => Record<string, unknown>;
}

/**
 * 单条上报事件标准传输结构（对应 `/collect/api/v1/track/batch` 的 `events[]` 元素）。
 */
export interface TrackEventDTO {
  event_id: string;
  event_name: string;
  distinct_id: string;
  login_id?: string;
  timestamp: number;
  properties: Record<string, unknown>;
}

/**
 * 单次事件上报可选覆盖参数。
 */
export interface TrackOptions {
  /** 指定同日网络重试幂等去重的固定 `event_id`（仅限同日完全相同报文重放去重，不可用于局部属性更新）。 */
  eventId?: string;
  /** 自定义事件发生毫秒时间戳（默认取当前 `Date.now()`）。 */
  timestamp?: number;
}

/**
 * `properties` 中内置时间属性（`#time` / `$time`）支持的时间输入类型：
 * `Date` 实例、有限正数毫秒/秒时间戳、或可解析的日期字符串。
 */
export type AbiEventTimeInput = Date | number | string;

/**
 * 允许在约束特定值类型（如 `userAdd` 的 `number` 或 `userAppend` 的 `unknown[]`）的同时可选携带 `#time` / `$time`。
 */
export type WithOptionalEventTime<T extends Record<string, unknown>, V> = {
  [K in keyof T]: K extends '#time' | '$time' ? AbiEventTimeInput | undefined : V;
};

const DEFAULT_LIB_NAME = 'abi-web-sdk';
const DEFAULT_LIB_VERSION = '1.0.0';
const SECONDS_TO_MS_THRESHOLD = 1e11;

function parseEventTimestamp(key: '#time' | '$time', raw: unknown): number {
  if (raw instanceof Date || Object.prototype.toString.call(raw) === '[object Date]') {
    const ms = (raw as Date).getTime();
    if (!Number.isFinite(ms) || ms <= 0) {
      throw new Error(`property "${key}" contains invalid Date`);
    }
    return ms;
  }
  if (typeof raw === 'number') {
    if (!Number.isFinite(raw) || raw <= 0) {
      throw new Error(`property "${key}" must be a positive finite timestamp`);
    }
    return raw < SECONDS_TO_MS_THRESHOLD ? Math.round(raw * 1000) : Math.round(raw);
  }
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new Error(`property "${key}" cannot be an empty date string`);
    }
    const isoCandidate = /^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/.test(trimmed)
      ? trimmed.replace(/\s+/, 'T')
      : trimmed;
    const parsed = Date.parse(isoCandidate);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(`property "${key}" contains invalid date string "${raw}"`);
    }
    return parsed;
  }
  throw new Error(
    `property "${key}" must be a Date, positive finite timestamp, or parseable date string`,
  );
}

function generateUUIDv4(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < 16; i++) {
    bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * 将用户传入的采集网关基础域名或完整路径规范化为标准批量上报端点 `/collect/api/v1/track/batch`。
 */
export function resolveBatchEndpoint(rawUrl: string): string {
  const trimmed = rawUrl.trim().replace(/\/+$/, '');
  if (trimmed.endsWith('/collect/api/v1/track/batch')) {
    return trimmed;
  }
  return `${trimmed}/collect/api/v1/track/batch`;
}

const defaultFetchTransport: AbiTransportFn = async (url, headers, body) => {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body,
    keepalive: true,
  });
  const bodyText = await res.text();
  return { status: res.status, bodyText };
};

/**
 * ABI Web / H5 / 微信小程序 / React Native 跨平台行为分析 SDK 核心客户端。
 *
 * 完整对齐 ThinkingData（数数科技）双身份采集语义，内置本地离线队列持久化与幂等重试、
 * 访客标识与账号标识分离维护（`distinct_id` + `login_id`）、IEEE-754 超大 64 位整数
 * 无损字符串序列化（`BigInt` / `> 2^53 - 1`）、高精度单调时钟事件计时（`$duration`）
 * 以及 `$user_*` 用户画像全生命周期变更能力。
 *
 * @example
 * ```ts
 * import { abi } from '@anylink/abi-web-sdk';
 *
 * // 1. 初始化 SDK 实例
 * abi.init({
 *   serverUrl: 'https://ingest.abi.example.com',
 *   projectId: 1,
 *   token: 'abi_proj_token_xxx',
 *   appVersion: '2.4.0',
 *   autoTrack: { pageView: true, pageLeave: true, webClick: true },
 * });
 *
 * // 2. 设置全局静态公共属性并设置登录账号 ID
 * abi.setSuperProperties({ channel: 'web_organic' });
 * abi.login('user_10086');
 *
 * // 3. 上报携带 64 位雪花订单号的行为事件
 * abi.track('OrderPaid', { order_id: 9007199254740993n, amount: 299.5 });
 * ```
 */
export class AbiWebSdk {
  private endpoint = '';
  private projectId = 0;
  private projectToken = '';
  private libName = DEFAULT_LIB_NAME;
  private libVersion = DEFAULT_LIB_VERSION;
  private appVersion?: string;
  private batchSize = 20;
  private flushIntervalMs = 5000;
  private maxQueueSize = 1000;
  private debug = false;
  private dryRun = false;
  private presetPropertiesFn?: () => Record<string, unknown>;

  private storage: AbiStorageAdapter = new BrowserLocalStorageAdapter();
  private transport: AbiTransportFn = defaultFetchTransport;
  private initialized = false;

  private distinctId = '';
  private loginId = '';
  private superProperties: Record<string, unknown> = {};
  private dynamicSuperPropsFn?: () => Record<string, unknown>;
  private timers = new Map<string, number>();
  private queue: TrackEventDTO[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;
  private autoTrackCleanupFns: Array<() => void> = [];

  private storageKey(suffix: string): string {
    return `abi_sdk_${this.projectId}_${suffix}`;
  }

  /**
   * 初始化（或重新初始化）SDK 实例：配置网关地址、项目凭证、定时刷新策略、
   * 浏览器端全埋点监听器以及自定义存储/网络传输适配器，并自动从持久化存储恢复身份态与离线队列。
   *
   * @example
   * ```ts
   * abi.init({
   *   serverUrl: 'http://localhost:8081',
   *   projectId: 1,
   *   token: 'abi_token_demo_123',
   *   appVersion: '1.2.0',
   *   maxBatchSize: 20,
   *   flushIntervalMs: 5000,
   *   autoTrack: { pageView: true, pageLeave: true, webClick: false },
   * });
   * ```
   */
  init(config: AbiSdkConfig): this {
    const resolvedToken = (config.token ?? config.appKey ?? '').trim();
    if (!config.serverUrl || !config.projectId || config.projectId <= 0 || !resolvedToken) {
      throw new Error('AbiWebSdk.init requires serverUrl, projectId (> 0), and token');
    }
    this.destroyCleanup();
    this.endpoint = resolveBatchEndpoint(config.serverUrl);
    this.projectId = config.projectId;
    this.projectToken = resolvedToken;
    this.appVersion = config.appVersion;
    this.libName = config.libName || DEFAULT_LIB_NAME;
    this.libVersion = config.libVersion || DEFAULT_LIB_VERSION;
    const rawBatch = config.maxBatchSize ?? config.batchSize ?? 20;
    this.batchSize = rawBatch > 0 ? Math.min(rawBatch, 500) : 20;
    this.flushIntervalMs = config.flushIntervalMs && config.flushIntervalMs > 0 ? config.flushIntervalMs : 5000;
    this.maxQueueSize = config.maxQueueSize && config.maxQueueSize > 0 ? config.maxQueueSize : 1000;
    this.debug = Boolean(config.debug);
    this.dryRun = Boolean(config.dryRun);
    this.presetPropertiesFn = config.presetProperties;
    this.storage = config.storage ?? new BrowserLocalStorageAdapter();
    this.transport = config.transport ?? defaultFetchTransport;

    this.restoreState();
    this.initialized = true;

    this.flushTimer = setInterval(() => {
      void this.flush();
    }, this.flushIntervalMs);

    if (config.autoTrack) {
      this.enableAutoTrack(config.autoTrack);
    }

    return this;
  }

  private restoreState(): void {
    const savedDistinct = this.storage.getItem(this.storageKey('distinct_id'));
    let restoredDistinct = '';
    if (savedDistinct) {
      try {
        restoredDistinct = normalizeIdentityField(
          savedDistinct,
          MAX_DISTINCT_ID_BYTES,
          'distinct_id',
        );
      } catch {
        restoredDistinct = '';
      }
    }
    if (restoredDistinct) {
      this.distinctId = restoredDistinct;
      if (restoredDistinct !== savedDistinct) {
        this.storage.setItem(this.storageKey('distinct_id'), restoredDistinct);
      }
    } else {
      this.distinctId = generateUUIDv4();
      this.storage.setItem(this.storageKey('distinct_id'), this.distinctId);
    }

    const savedLogin = this.storage.getItem(this.storageKey('login_id')) ?? '';
    if (savedLogin) {
      try {
        const restoredLogin = normalizeIdentityField(
          savedLogin,
          MAX_LOGIN_ID_BYTES,
          'login_id',
        );
        this.loginId = restoredLogin;
        if (restoredLogin !== savedLogin) {
          this.storage.setItem(this.storageKey('login_id'), restoredLogin);
        }
      } catch {
        this.loginId = '';
        this.storage.removeItem(this.storageKey('login_id'));
      }
    } else {
      this.loginId = '';
    }

    const savedSuper = this.storage.getItem(this.storageKey('super_props'));
    if (savedSuper) {
      try {
        this.superProperties = JSON.parse(savedSuper) as Record<string, unknown>;
      } catch {
        this.superProperties = {};
      }
    } else {
      this.superProperties = {};
    }

    const savedQueue = this.storage.getItem(this.storageKey('offline_queue'));
    if (savedQueue) {
      try {
        const parsed = JSON.parse(savedQueue);
        if (Array.isArray(parsed)) {
          this.queue = parsed as TrackEventDTO[];
        }
      } catch {
        this.queue = [];
      }
    } else {
      this.queue = [];
    }
  }

  private persistQueue(): void {
    try {
      this.storage.setItem(this.storageKey('offline_queue'), JSON.stringify(this.queue));
    } catch {
      // 忽略本地存储空间配额超限异常，保留内存队列可用
    }
  }

  private ensureInit(): void {
    if (!this.initialized) {
      throw new Error('AbiWebSdk is not initialized; call abi.init(config) first');
    }
  }

  /**
   * 获取当前访客/设备标识（`distinct_id`）。
   */
  getDistinctId(): string {
    this.ensureInit();
    return this.distinctId;
  }

  /**
   * 获取当前已设置的登录账号标识（`login_id`）；未登录时返回空字符串 `""`。
   */
  getLoginId(): string {
    this.ensureInit();
    return this.loginId;
  }

  /**
   * 自定义设置当前访客/设备标识（`distinct_id`，最大长度 64 UTF-8 字节），持久化至本地存储，不触发任何网络上报事件。
   *
   * @example
   * ```ts
   * abi.identify('visitor_device_fp_98765');
   * ```
   */
  identify(distinctId: string): void {
    this.ensureInit();
    const norm = normalizeIdentityField(distinctId, MAX_DISTINCT_ID_BYTES, 'distinct_id');
    this.distinctId = norm;
    this.storage.setItem(this.storageKey('distinct_id'), norm);
  }

  /**
   * 设置当前已认证账号标识 `accountId`（`login_id`，最大长度 128 UTF-8 字节）并持久化至本地存储。
   * 对齐 ThinkingData 语义：纯本地状态更新，不覆盖 `distinct_id`，且不自动发送任何网络事件；
   * 后续所有上报事件将同时携带当前 `distinct_id` 与 `login_id`。
   *
   * @example
   * ```ts
   * abi.login('user_10086');
   * ```
   */
  login(accountId: string): void {
    this.ensureInit();
    const normLogin = normalizeIdentityField(accountId, MAX_LOGIN_ID_BYTES, 'login_id');
    this.loginId = normLogin;
    this.storage.setItem(this.storageKey('login_id'), normLogin);
  }

  /**
   * 退出当前登录态：清除已持久化的 `login_id`，保留当前访客标识 `distinct_id` 不变，不触发任何网络事件。
   *
   * @example
   * ```ts
   * abi.logout();
   * ```
   */
  logout(): void {
    this.ensureInit();
    this.loginId = '';
    this.storage.removeItem(this.storageKey('login_id'));
  }

  /**
   * 合并设置全局静态公共属性：自动持久化至存储层，并在后续所有非 `$user_*` 行为事件上报时自动附带。
   *
   * @example
   * ```ts
   * abi.setSuperProperties({
   *   channel: 'google_ads',
   *   ab_group: 'checkout_v2',
   * });
   * ```
   */
  setSuperProperties(props: Record<string, unknown>): void {
    this.ensureInit();
    const norm = normalizeProperties(props);
    this.superProperties = { ...this.superProperties, ...norm };
    this.storage.setItem(this.storageKey('super_props'), JSON.stringify(this.superProperties));
  }

  /**
   * 按属性名移除单个已注册的静态公共属性。
   */
  unsetSuperProperty(key: string): void {
    this.ensureInit();
    delete this.superProperties[key];
    if (typeof key === 'string') {
      delete this.superProperties[key.trim()];
    }
    this.storage.setItem(this.storageKey('super_props'), JSON.stringify(this.superProperties));
  }

  /**
   * 清空所有已注册的静态公共属性及其本地持久化缓存。
   */
  clearSuperProperties(): void {
    this.ensureInit();
    this.superProperties = {};
    this.storage.removeItem(this.storageKey('super_props'));
  }

  /**
   * 获取当前静态公共属性的浅拷贝快照。
   */
  getSuperProperties(): Record<string, unknown> {
    this.ensureInit();
    return { ...this.superProperties };
  }

  /**
   * 注册动态公共属性回调函数：每次调用 `track()` 上报行为事件时实时求值并合并到事件属性中。
   *
   * @example
   * ```ts
   * abi.setDynamicSuperProperties(() => ({
   *   network_online: typeof navigator !== 'undefined' ? navigator.onLine : true,
   *   cart_item_count: window.__CART_COUNT__ ?? 0,
   * }));
   * ```
   */
  setDynamicSuperProperties(fn: () => Record<string, unknown>): void {
    this.ensureInit();
    this.dynamicSuperPropsFn = fn;
  }

  /**
   * 为指定事件 `eventName` 启动高精度单调时钟计时器。
   * 当后续调用 `track(eventName)` 完成上报时，SDK 会自动计算经过的秒数（保留 3 位小数）并注入 `$duration` 属性。
   *
   * @example
   * ```ts
   * abi.timeEvent('OrderPaid');
   * // ... 用户完成收银台支付流程 ...
   * abi.track('OrderPaid', { amount: 299.5 }); // 自动携带 $duration（单位：秒）
   * ```
   */
  timeEvent(eventName: string): void {
    this.ensureInit();
    const normEvent = validateEventName(eventName);
    this.timers.set(normEvent, this.nowMonotonicMs());
  }

  private nowMonotonicMs(): number {
    if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
      return performance.now();
    }
    return Date.now();
  }

  private collectPresetProperties(): Record<string, unknown> {
    const preset: Record<string, unknown> = {
      $lib: this.libName,
      $lib_version: this.libVersion,
      $zone_offset: -(new Date().getTimezoneOffset() / 60),
    };
    if (this.appVersion) {
      preset.$app_version = this.appVersion;
    }
    if (typeof window !== 'undefined') {
      if (window.screen) {
        if (typeof window.screen.width === 'number') preset.$screen_width = window.screen.width;
        if (typeof window.screen.height === 'number') preset.$screen_height = window.screen.height;
      }
      if (window.location) {
        preset.$url = window.location.href;
        preset.$url_path = window.location.pathname;
      }
      if (typeof document !== 'undefined') {
        if (document.title) preset.$title = document.title;
        if (document.referrer) preset.$referrer = document.referrer;
      }
    }
    if (this.presetPropertiesFn) {
      Object.assign(preset, this.presetPropertiesFn());
    }
    return preset;
  }

  /**
   * 记录并入队一条用户行为事件（或系统内置事件），支持传入自定义事件属性与可选 `eventId` / `timestamp`。
   * 对于常规行为事件，会自动合并设备预置属性、静态/动态公共属性以及由 `timeEvent` 记录的耗时（`$duration`），
   * 最终返回该事件的唯一标识 `event_id`。
   *
   * @example
   * ```ts
   * const eventId = abi.track('OrderPaid', {
   *   order_id: 9007199254740993n, // 64 位雪花 ID -> 自动无损序列化为字符串
   *   amount: 299.5,
   *   currency: 'CNY',
   *   items: ['sku_keyboard', 2, true],
   * });
   * ```
   */
  track(
    eventName: string,
    properties?: Record<string, unknown>,
    options?: TrackOptions,
  ): string {
    this.ensureInit();
    const normEvent = validateEventName(eventName);
    const isUserEvent = normEvent.startsWith('$user_') || normEvent.startsWith('#user_');

    let extractedTimestamp: number | undefined;
    let customPropsToNormalize: Record<string, unknown> | undefined;
    if (properties) {
      const shallowCopy: Record<string, unknown> = { ...properties };
      if (Object.prototype.hasOwnProperty.call(shallowCopy, '#time')) {
        const rawHashTime = shallowCopy['#time'];
        if (rawHashTime !== undefined) {
          extractedTimestamp = parseEventTimestamp('#time', rawHashTime);
        }
        delete shallowCopy['#time'];
      }
      if (Object.prototype.hasOwnProperty.call(shallowCopy, '$time')) {
        const rawDollarTime = shallowCopy['$time'];
        if (rawDollarTime !== undefined) {
          const parsedDollarTime = parseEventTimestamp('$time', rawDollarTime);
          if (extractedTimestamp === undefined) {
            extractedTimestamp = parsedDollarTime;
          }
        }
        delete shallowCopy['$time'];
      }
      customPropsToNormalize = shallowCopy;
    }

    const normCustom = customPropsToNormalize
      ? normalizeProperties(customPropsToNormalize)
      : undefined;

    const merged: Record<string, unknown> = isUserEvent
      ? {}
      : {
          ...this.collectPresetProperties(),
          ...this.superProperties,
        };

    if (!isUserEvent && this.dynamicSuperPropsFn) {
      const dyn = normalizeProperties(this.dynamicSuperPropsFn());
      Object.assign(merged, dyn);
    }

    if (!isUserEvent && this.timers.has(normEvent)) {
      const startedAt = this.timers.get(normEvent)!;
      this.timers.delete(normEvent);
      const elapsedSeconds = Math.max(0, Number(((this.nowMonotonicMs() - startedAt) / 1000).toFixed(3)));
      merged.$duration = elapsedSeconds;
    }

    if (normCustom) {
      Object.assign(merged, normCustom);
    }

    const eventId = options?.eventId
      ? normalizeIdentityField(options.eventId, MAX_EVENT_ID_BYTES, 'event_id')
      : generateUUIDv4();

    const resolvedTimestamp =
      options?.timestamp !== undefined && options.timestamp > 0
        ? options.timestamp
        : (extractedTimestamp ?? Date.now());

    const dto: TrackEventDTO = {
      event_id: eventId,
      event_name: normEvent,
      distinct_id: this.distinctId,
      ...(this.loginId ? { login_id: this.loginId } : {}),
      timestamp: resolvedTimestamp,
      properties: merged,
    };

    this.enqueue(dto);
    return eventId;
  }

  /**
   * 首次事件上报接口（当前版本未开放）。
   *
   * @deprecated [当前版本未开放 / Unsupported in current version]
   * 严守 D7① / G6 门禁，当前 StarRocks dwd_events 存储模型尚未开放 trackFirst 首次行为去重；
   * 调用此方法将直接抛出异常且绝不入队伪造普通 track 事件。同日网络重试幂等请通过 `track(..., { eventId })` 实现。
   */
  trackFirst(
    _eventName: string,
    _firstCheckId: string,
    _properties?: Record<string, unknown>,
  ): string {
    throw new Error(
      'trackFirst is unsupported in current version (RESTFUL_API.md §3.3 D7① / G6 gate); use track(eventName, properties, { eventId }) for same-day retry idempotency',
    );
  }

  /**
   * 可变事件局部属性更新接口（当前版本未开放）。
   *
   * @deprecated [当前版本未开放 / Unsupported in current version]
   * 严守 D7① / G6 门禁，当前 StarRocks dwd_events 存储模型尚未开放 trackUpdate 局部属性更新；
   * 调用此方法将直接抛出异常且绝不静默发送普通 track 事件（否则会在同日覆盖抹除原事件未携带属性）。
   */
  trackUpdate(
    _eventName: string,
    _eventId: string,
    _properties?: Record<string, unknown>,
  ): string {
    throw new Error(
      'trackUpdate is unsupported in current version (RESTFUL_API.md §3.3 D7① / G6 gate); emit distinct milestone events via track(...) instead',
    );
  }

  /**
   * 可变事件整行覆盖重写接口（当前版本未开放）。
   *
   * @deprecated [当前版本未开放 / Unsupported in current version]
   * 严守 D7① / G6 门禁，当前 StarRocks dwd_events 存储模型尚未开放 trackOverwrite 跨天覆盖重写；
   * 调用此方法将直接抛出异常且绝不静默发送普通 track 事件（否则跨天会产生重复事件行）。
   */
  trackOverwrite(
    _eventName: string,
    _eventId: string,
    _properties?: Record<string, unknown>,
  ): string {
    throw new Error(
      'trackOverwrite is unsupported in current version (RESTFUL_API.md §3.3 D7① / G6 gate); emit distinct milestone events via track(...) instead',
    );
  }

  /**
   * 覆盖设置用户画像属性（`$user_set`），更新 StarRocks `abi.dim_users` 中对应字段的最新值。
   *
   * @example
   * ```ts
   * abi.userSet({ vip_level: 'diamond', city: 'Shanghai' });
   * ```
   */
  userSet(properties: Record<string, unknown>): string {
    return this.track('$user_set', properties);
  }

  /**
   * 仅当目标用户画像属性尚未设置时执行首次初始化写入（`$user_set_once`，适用于首次获客渠道、注册时间等不可变属性）。
   *
   * @example
   * ```ts
   * abi.userSetOnce({ first_deposit_channel: 'apple_pay' });
   * ```
   */
  userSetOnce(properties: Record<string, unknown>): string {
    return this.track('$user_set_once', properties);
  }

  /**
   * 对数值型用户画像属性执行原子累加或扣减（`$user_add`，属性值必须为有限数字）。
   *
   * @example
   * ```ts
   * abi.userAdd({ total_points: 50, order_count: 1 });
   * ```
   */
  userAdd<T extends Record<string, unknown> = Record<string, number>>(
    properties: WithOptionalEventTime<T, number>,
  ): string {
    for (const [k, v] of Object.entries(properties)) {
      if (k === '#time' || k === '$time') {
        continue;
      }
      validatePropertyKey(k);
      if (typeof v !== 'number' || !Number.isFinite(v)) {
        throw new Error(`userAdd property "${k}" must be a finite number`);
      }
    }
    return this.track('$user_add', properties);
  }

  /**
   * 清空并移除指定名称的用户画像属性（`$user_unset`）。
   *
   * @example
   * ```ts
   * abi.userUnset('city', 'temp_campaign_tag');
   * ```
   */
  userUnset(...keys: string[]): string {
    const props: Record<string, unknown> = {};
    for (const key of keys) {
      const normKey = validatePropertyKey(key);
      props[normKey] = '';
    }
    return this.track('$user_unset', props);
  }

  /**
   * 向列表/数组类型的用户画像属性追加元素（`$user_append`，不去重）。
   *
   * @example
   * ```ts
   * abi.userAppend({ favorite_categories: ['electronics', 'gaming'] });
   * ```
   */
  userAppend<T extends Record<string, unknown> = Record<string, unknown[]>>(
    properties: WithOptionalEventTime<T, unknown[]>,
  ): string {
    return this.track('$user_append', properties);
  }

  /**
   * 向列表/数组类型的用户画像属性追加元素并自动去重（`$user_uniq_append`）。
   *
   * @example
   * ```ts
   * abi.userUniqAppend({ badges: ['early_adopter', 'vip_2026'] });
   * ```
   */
  userUniqAppend<T extends Record<string, unknown> = Record<string, unknown[]>>(
    properties: WithOptionalEventTime<T, unknown[]>,
  ): string {
    return this.track('$user_uniq_append', properties);
  }

  /**
   * 标记删除当前用户的画像记录（`$user_del`）。
   *
   * @example
   * ```ts
   * abi.userDelete();
   * ```
   */
  userDelete(): string {
    return this.track('$user_del', {});
  }

  private enqueue(dto: TrackEventDTO): void {
    if (this.queue.length >= this.maxQueueSize) {
      this.queue.shift();
    }
    this.queue.push(dto);
    this.persistQueue();

    if (this.queue.length >= this.batchSize || this.debug) {
      void this.flush();
    }
  }

  /**
   * 获取当前离线缓冲队列中尚未上报成功的事件数量。
   */
  getQueueLength(): number {
    return this.queue.length;
  }

  /**
   * 构造当前待发队列下一批请求将发送至 `POST /collect/api/v1/track/batch` 的完整 JSON 请求体预览（不修改队列）。
   * 当队列为空时返回 `null`。适用于在用户点击「确认提交」(`flush()`) 前展示真实请求参数。
   */
  buildPendingBatchPayload(): Record<string, unknown> | null {
    this.ensureInit();
    if (this.queue.length === 0) {
      return null;
    }
    const batch = this.queue.slice(0, this.batchSize).map((item) => ({
      ...item,
      properties: { ...item.properties },
    }));
    const payload: Record<string, unknown> = {
      project_id: this.projectId,
      project_token: this.projectToken,
      events: batch,
    };
    if (this.debug) {
      payload.debug = true;
    }
    if (this.dryRun) {
      payload.dry_run = true;
    }
    return payload;
  }

  /**
   * 清空当前尚未发送的离线缓冲队列（例如在参数配置预览阶段重新构建待提交事件）。
   */
  clearQueue(): void {
    this.ensureInit();
    this.queue = [];
    this.persistQueue();
  }

  /**
   * 立即按批次将离线队列中的待发事件刷新上报至采集网关。
   * 遇到网络错误、`429` 限流或 `5xx` 服务端异常时保留原事件（含相同 `event_id`）等待下次幂等重试；
   * 全部发送成功或队列为空时返回 `true`。
   *
   * @example
   * ```ts
   * const ok = await abi.flush();
   * ```
   */
  async flush(): Promise<boolean> {
    this.ensureInit();
    if (this.flushing || this.queue.length === 0) {
      return true;
    }
    this.flushing = true;
    try {
      while (this.queue.length > 0) {
        const batch = this.queue.slice(0, this.batchSize);
        const payload: Record<string, unknown> = {
          project_id: this.projectId,
          project_token: this.projectToken,
          events: batch,
        };
        if (this.debug) {
          payload.debug = true;
        }
        if (this.dryRun) {
          payload.dry_run = true;
        }

        let res: AbiTransportResponse;
        try {
          res = await this.transport(
            this.endpoint,
            {
              'Content-Type': 'application/json',
            },
            JSON.stringify(payload),
          );
        } catch {
          return false;
        }

        if (res.status >= 200 && res.status < 300) {
          this.queue.splice(0, batch.length);
          this.persistQueue();
          continue;
        }

        if (res.status === 429 || res.status >= 500) {
          return false;
        }

        this.queue.splice(0, batch.length);
        this.persistQueue();
        return false;
      }
      return true;
    } finally {
      this.flushing = false;
    }
  }

  /**
   * 启用浏览器端自动全埋点采集：
   * - SPA 页面浏览（`$pageview`，监听 `pushState` / `replaceState` / `popstate` / `hashchange`）
   * - 页面离开与停留时长（`$AppEnd`，自动附带 `$duration` 并在卸载时优先走 `navigator.sendBeacon`）
   * - 网页交互元素点击（`$AppClick`，自动采集 `<button>`、`<a>`、`<input>` 及带有 `[data-abi-track]` 的元素）
   *
   * @example
   * ```ts
   * abi.enableAutoTrack({
   *   pageView: true,
   *   pageLeave: true,
   *   webClick: true,
   * });
   * ```
   */
  enableAutoTrack(options: AbiAutoTrackOptions): void {
    this.ensureInit();
    if (typeof window === 'undefined') {
      return;
    }

    if (options.pageView || options.pageLeave) {
      let hasActivePageTimer = false;

      const emitPageLeaveIfActive = (useBeacon: boolean) => {
        if (!options.pageLeave || !hasActivePageTimer) {
          return;
        }
        hasActivePageTimer = false;
        this.track('$AppEnd');
        if (
          useBeacon &&
          typeof navigator !== 'undefined' &&
          typeof navigator.sendBeacon === 'function' &&
          this.transport === defaultFetchTransport &&
          this.queue.length > 0
        ) {
          const batch = this.queue.slice(0, this.batchSize);
          const payload: Record<string, unknown> = {
            project_id: this.projectId,
            project_token: this.projectToken,
            events: batch,
          };
          if (this.debug) payload.debug = true;
          if (this.dryRun) payload.dry_run = true;
          const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
          if (navigator.sendBeacon(this.endpoint, blob)) {
            this.queue.splice(0, batch.length);
            this.persistQueue();
            return;
          }
        }
        void this.flush();
      };

      const trackPageTransition = () => {
        emitPageLeaveIfActive(false);
        if (options.pageView) {
          this.track('$pageview');
        }
        if (options.pageLeave) {
          this.timeEvent('$AppEnd');
          hasActivePageTimer = true;
        }
      };

      const onPopState = () => trackPageTransition();
      window.addEventListener('popstate', onPopState);
      window.addEventListener('hashchange', onPopState);

      const onPageHide = () => emitPageLeaveIfActive(true);
      const onVisibilityChange = () => {
        if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
          emitPageLeaveIfActive(true);
        } else if (
          typeof document !== 'undefined' &&
          document.visibilityState === 'visible' &&
          options.pageLeave &&
          !hasActivePageTimer
        ) {
          this.timeEvent('$AppEnd');
          hasActivePageTimer = true;
        }
      };
      if (options.pageLeave) {
        window.addEventListener('pagehide', onPageHide);
        if (typeof document !== 'undefined') {
          document.addEventListener('visibilitychange', onVisibilityChange);
        }
      }

      const origPushState = window.history?.pushState;
      const origReplaceState = window.history?.replaceState;
      if (window.history && origPushState) {
        window.history.pushState = function (...args) {
          const result = origPushState.apply(this, args);
          trackPageTransition();
          return result;
        };
      }
      if (window.history && origReplaceState) {
        window.history.replaceState = function (...args) {
          const result = origReplaceState.apply(this, args);
          trackPageTransition();
          return result;
        };
      }

      this.autoTrackCleanupFns.push(() => {
        window.removeEventListener('popstate', onPopState);
        window.removeEventListener('hashchange', onPopState);
        window.removeEventListener('pagehide', onPageHide);
        if (typeof document !== 'undefined') {
          document.removeEventListener('visibilitychange', onVisibilityChange);
        }
        if (window.history && origPushState) {
          window.history.pushState = origPushState;
        }
        if (window.history && origReplaceState) {
          window.history.replaceState = origReplaceState;
        }
      });

      trackPageTransition();
    }

    if (options.webClick && typeof document !== 'undefined') {
      const onClick = (ev: MouseEvent) => {
        const target = ev.target as HTMLElement | null;
        if (!target) return;
        const tag = target.tagName?.toLowerCase() ?? '';
        if (!['button', 'a', 'input'].includes(tag) && !target.hasAttribute('data-abi-track')) {
          return;
        }
        this.track('$AppClick', {
          element_type: tag,
          element_id: target.id || '',
          element_content: (target.textContent || '').trim().slice(0, 128),
        });
      };
      document.addEventListener('click', onClick, true);
      this.autoTrackCleanupFns.push(() => {
        document.removeEventListener('click', onClick, true);
      });
    }
  }

  private destroyCleanup(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    for (const fn of this.autoTrackCleanupFns) {
      fn();
    }
    this.autoTrackCleanupFns = [];
    this.dynamicSuperPropsFn = undefined;
    this.timers.clear();
  }

  /**
   * 销毁当前 SDK 实例：清理定时刷新器与全部浏览器全埋点事件监听器，重置初始化状态。
   */
  destroy(): void {
    this.destroyCleanup();
    this.initialized = false;
  }
}

/** 默认导出的全局 ABI SDK 单例实例。 */
export const abi = new AbiWebSdk();
export default abi;
