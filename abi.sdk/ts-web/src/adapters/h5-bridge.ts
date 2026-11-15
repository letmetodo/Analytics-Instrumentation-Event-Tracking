import {
  BrowserLocalStorageAdapter,
  type AbiStorageAdapter,
} from '../storage.js';
import {
  MAX_DISTINCT_ID_BYTES,
  MAX_LOGIN_ID_BYTES,
  normalizeIdentityField,
} from '../validator.js';
import type { AbiTransportFn, AbiTransportResponse } from '../index.js';

/**
 * 原生 App 注入到 WebView `window` 上的 JS Bridge 接口契约（对标 ThinkingData `h5_app_integrate`）。
 *
 * 支持两种主流原生桥接形态：
 * 1. **Android `@JavascriptInterface` / 自定义桥对象**：实现 `trackFromH5(payloadJson)`，并可选实现
 *    `getDistinctId()`、`getLoginId()`、`getAppPresetProperties()`；
 * 2. **iOS `WKScriptMessageHandler`**：挂载于 `window.webkit.messageHandlers.abiAnalytics`，通过
 *    `postMessage(payloadJson)` 将 H5 事件报文转发给 iOS 原生 SDK。
 */
export interface NativeAppBridgeLike {
  /**
   * 接收来自 H5 SDK 序列化后的批量上报 JSON 报文（结构同 `POST /collect/api/v1/track/batch`），
   * 由原生 App SDK 合并设备环境属性或复用原生加密通道统一上报。
   * 返回 `false` 表示原生桥拒绝处理，H5 SDK 将自动回退至 HTTP 通道。
   */
  trackFromH5?: (payloadJson: string) => void | boolean | Promise<void | boolean>;
  /**
   * iOS `WKScriptMessageHandler` 标准消息投递接口（如 `window.webkit.messageHandlers.abiAnalytics.postMessage`）。
   */
  postMessage?: (message: string) => void;
  /** 获取原生 App 当前持久化的访客/设备标识（`distinct_id`）。 */
  getDistinctId?: () => string | null | undefined;
  /** 获取原生 App 当前已设置的登录账号标识（`login_id`）。 */
  getLoginId?: () => string | null | undefined;
  /** 获取原生 App 提供的设备预置属性（支持返回 JSON 字符串或键值对对象，如 `$os`、`$app_version`、`$device_model`）。 */
  getAppPresetProperties?: () => string | Record<string, unknown> | null | undefined;
}

/**
 * WebView 全局 `window` 上的原生桥声明扩展。
 */
export interface AbiBridgeWindowLike {
  AbiAnalyticsBridge?: NativeAppBridgeLike;
  webkit?: {
    messageHandlers?: {
      abiAnalytics?: NativeAppBridgeLike;
    };
  };
}

/**
 * H5 与原生 App SDK 打通适配器配置项。
 */
export interface H5AppBridgeOptions {
  /**
   * 显式传入的原生 App 桥接对象。
   * 若不传，适配器将按以下优先级在全局 `window` 上自动探测：
   * 1. `window.AbiAnalyticsBridge`（Android `@JavascriptInterface` 或通用注入桥）
   * 2. `window.webkit.messageHandlers.abiAnalytics`（iOS `WKWebView` 原生消息处理器）
   */
  bridge?: NativeAppBridgeLike;
  /**
   * 当 H5 页面运行在外部普通浏览器（未检测到 App 原生桥）或原生桥返回 `false` 时的 HTTP 回退传输实现。
   * 默认使用浏览器标准 `fetch` 向采集网关 `/collect/api/v1/track/batch` 发送请求。
   */
  fallbackTransport?: AbiTransportFn;
  /**
   * 自定义底层存储适配器（默认使用 `BrowserLocalStorageAdapter`）。
   */
  storage?: AbiStorageAdapter;
  /**
   * 是否自动复用原生 App 的 `distinct_id` 与 `login_id`（默认 `true`）。
   * 开启后，H5 端在初始化恢复身份态时会优先读取原生桥提供的 `getDistinctId()` 与 `getLoginId()`，
   * 确保同一用户在 App 原生页面与内嵌 H5 页面中的行为归属到同一主体。
   */
  syncNativeIdentity?: boolean;
  /**
   * 是否在 H5 事件预置属性中注入 `$h5_bridge: true` 标记（默认 `true`）。
   */
  appendH5Marker?: boolean;
}

/**
 * H5 与原生 App 打通适配器返回结构（可直接展开传入 `abi.init({ ... })`）。
 */
export interface H5AppBridgeAdapterResult {
  storage: AbiStorageAdapter;
  transport: AbiTransportFn;
  presetProperties: () => Record<string, unknown>;
  /** 实时检测当前环境是否已成功挂载可用的原生 App 桥。 */
  isBridgeAvailable: () => boolean;
  /** 读取原生 App 当前暴露的身份标识快照。 */
  getNativeIdentity: () => {
    distinctId?: string;
    loginId?: string;
  };
}

const defaultHttpFallbackTransport: AbiTransportFn = async (
  url,
  headers,
  body,
): Promise<AbiTransportResponse> => {
  const res = await fetch(url, {
    method: 'POST',
    headers,
    body,
    keepalive: true,
  });
  const bodyText = await res.text();
  return { status: res.status, bodyText };
};

function detectNativeBridge(explicitBridge?: NativeAppBridgeLike): NativeAppBridgeLike | null {
  if (explicitBridge) {
    return explicitBridge;
  }
  if (typeof window === 'undefined') {
    return null;
  }
  const win = window as unknown as AbiBridgeWindowLike;
  if (
    win.AbiAnalyticsBridge &&
    (typeof win.AbiAnalyticsBridge.trackFromH5 === 'function' ||
      typeof win.AbiAnalyticsBridge.postMessage === 'function')
  ) {
    return win.AbiAnalyticsBridge;
  }
  const webkitHandler = win.webkit?.messageHandlers?.abiAnalytics;
  if (
    webkitHandler &&
    (typeof webkitHandler.postMessage === 'function' ||
      typeof webkitHandler.trackFromH5 === 'function')
  ) {
    return webkitHandler;
  }
  return null;
}

function safeReadNativeDistinctId(fn?: () => string | null | undefined): string | undefined {
  if (typeof fn !== 'function') {
    return undefined;
  }
  try {
    const val = fn();
    if (typeof val === 'string' && val.trim().length > 0) {
      return normalizeIdentityField(val, MAX_DISTINCT_ID_BYTES, 'distinct_id');
    }
  } catch {
    // 忽略原生桥同步调用异常或越界脏值，回退到本地存储
  }
  return undefined;
}

function safeReadNativeLoginId(fn?: () => string | null | undefined): string | undefined {
  if (typeof fn !== 'function') {
    return undefined;
  }
  try {
    const val = fn();
    if (val === undefined) {
      return undefined;
    }
    if (val === null) {
      return '';
    }
    if (typeof val === 'string') {
      if (val.trim().length === 0) {
        return '';
      }
      return normalizeIdentityField(val, MAX_LOGIN_ID_BYTES, 'login_id');
    }
  } catch {
    // 忽略原生桥同步调用异常或越界脏值，回退到本地存储
  }
  return undefined;
}

/**
 * 创建 H5 与原生 App SDK（iOS / Android）打通适配器（对标 ThinkingData `h5_app_integrate`）。
 *
 * 核心能力：
 * 1. **自动探测双端原生桥**：自动识别 Android `window.AbiAnalyticsBridge` 与 iOS `window.webkit.messageHandlers.abiAnalytics`；
 * 2. **原生身份无缝复用**：当 H5 在 App WebView 内打开且原生桥提供 `getDistinctId()` / `getLoginId()` 时，
 *    自动覆盖 H5 本地身份，无需在 URL Query 中手动拼接访客 ID；
 * 3. **双通道智能路由**：在 App WebView 内优先通过原生桥上报；当同一 H5 活动页被分享至微信或外部浏览器打开时，
 *    自动无缝回退至标准 HTTP 批量上报通道。
 *
 * @example
 * ```ts
 * import { abi } from '@anylink/abi-web-sdk';
 * import { createH5AppBridgeAdapter } from '@anylink/abi-web-sdk/adapters/h5-bridge';
 *
 * const bridgeAdapter = createH5AppBridgeAdapter();
 * abi.init({
 *   serverUrl: 'https://ingest.abi.example.com',
 *   projectId: 1,
 *   token: 'abi_proj_token_xxx',
 *   ...bridgeAdapter,
 * });
 * ```
 */
export function createH5AppBridgeAdapter(
  options: H5AppBridgeOptions = {},
): H5AppBridgeAdapterResult {
  const baseStorage = options.storage ?? new BrowserLocalStorageAdapter();
  const fallbackTransport = options.fallbackTransport ?? defaultHttpFallbackTransport;
  const syncNativeIdentity = options.syncNativeIdentity !== false;
  const appendH5Marker = options.appendH5Marker !== false;

  const resolveBridge = (): NativeAppBridgeLike | null => detectNativeBridge(options.bridge);

  const getNativeIdentity = () => {
    const bridge = resolveBridge();
    if (!bridge) {
      return {};
    }
    const distinctId = safeReadNativeDistinctId(bridge.getDistinctId?.bind(bridge));
    const loginId = safeReadNativeLoginId(bridge.getLoginId?.bind(bridge));
    const snapshot: { distinctId?: string; loginId?: string } = {};
    if (distinctId !== undefined) {
      snapshot.distinctId = distinctId;
    }
    if (loginId !== undefined) {
      snapshot.loginId = loginId;
    }
    return snapshot;
  };

  const storage: AbiStorageAdapter = {
    getItem(key: string): string | null {
      if (syncNativeIdentity) {
        const nativeId = getNativeIdentity();
        if (key.endsWith('_distinct_id') && nativeId.distinctId) {
          return nativeId.distinctId;
        }
        if (key.endsWith('_login_id') && nativeId.loginId !== undefined) {
          if (nativeId.loginId === '') {
            baseStorage.removeItem(key);
            return null;
          }
          return nativeId.loginId;
        }
      }
      return baseStorage.getItem(key);
    },
    setItem(key: string, value: string): void {
      baseStorage.setItem(key, value);
    },
    removeItem(key: string): void {
      baseStorage.removeItem(key);
    },
  };

  const transport: AbiTransportFn = async (url, headers, body) => {
    const bridge = resolveBridge();
    if (bridge) {
      try {
        if (typeof bridge.trackFromH5 === 'function') {
          const result = await bridge.trackFromH5(body);
          if (result !== false) {
            return {
              status: 200,
              bodyText: '{"code":200,"message":"accepted_by_native_bridge"}',
            };
          }
        } else if (typeof bridge.postMessage === 'function') {
          bridge.postMessage(body);
          return {
            status: 200,
            bodyText: '{"code":200,"message":"accepted_by_webkit_bridge"}',
          };
        }
      } catch {
        // 原生桥调用抛出异常时平滑回退至 HTTP 传输通道
      }
    }
    return fallbackTransport(url, headers, body);
  };

  const presetProperties = (): Record<string, unknown> => {
    const bridge = resolveBridge();
    const props: Record<string, unknown> = {
      $lib: 'abi-h5-bridge-sdk',
    };
    if (appendH5Marker) {
      props.$h5_bridge = Boolean(bridge);
    }
    if (bridge && typeof bridge.getAppPresetProperties === 'function') {
      try {
        const rawPreset = bridge.getAppPresetProperties();
        if (typeof rawPreset === 'string' && rawPreset.trim().length > 0) {
          const parsed = JSON.parse(rawPreset) as Record<string, unknown>;
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            Object.assign(props, parsed);
          }
        } else if (rawPreset && typeof rawPreset === 'object' && !Array.isArray(rawPreset)) {
          Object.assign(props, rawPreset);
        }
      } catch {
        // 忽略原生预置属性解析失败
      }
    }
    return props;
  };

  return {
    storage,
    transport,
    presetProperties,
    isBridgeAvailable: () => resolveBridge() !== null,
    getNativeIdentity,
  };
}
