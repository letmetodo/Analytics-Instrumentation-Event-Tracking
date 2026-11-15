import {
  MemoryStorageAdapter,
  type AbiStorageAdapter,
} from '../storage.js';
import type { AbiTransportFn } from '../index.js';

/**
 * Cocos Creator 引擎全局对象（`cc`）最小兼容接口。
 */
export interface CocosCreatorLike {
  ENGINE_VERSION?: string;
  sys?: {
    localStorage?: {
      getItem(key: string): string | null | undefined;
      setItem(key: string, value: string): void;
      removeItem(key: string): void;
    };
    os?: string;
    osVersion?: string;
    platform?: string | number;
    language?: string;
    isNative?: boolean;
    isBrowser?: boolean;
    isMobile?: boolean;
  };
  view?: {
    getFrameSize?: () => { width: number; height: number };
    getVisibleSize?: () => { width: number; height: number };
  };
  screen?: {
    windowSize?: { width: number; height: number };
  };
}

/**
 * Egret（白鹭引擎）全局对象（`egret`）最小兼容接口。
 */
export interface EgretLike {
  localStorage?: {
    getItem(key: string): string | null | undefined;
    setItem(key: string, value: string): boolean | void;
    removeItem(key: string): void;
  };
  Capabilities?: {
    os?: string;
    runtimeType?: string;
    language?: string;
    isMobile?: boolean;
    boundingClientWidth?: number;
    boundingClientHeight?: number;
    engineVersion?: string;
  };
  MainContext?: {
    instance?: {
      stage?: {
        stageWidth?: number;
        stageHeight?: number;
      };
    };
  };
  stageWidth?: number;
  stageHeight?: number;
}

/**
 * LayaAir 引擎全局对象（`Laya`）最小兼容接口。
 */
export interface LayaAirLike {
  version?: string;
  LocalStorage?: {
    getItem(key: string): string | null | undefined;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
  };
  Browser?: {
    onIOS?: boolean;
    onAndroid?: boolean;
    onWP?: boolean;
    onMac?: boolean;
    onPC?: boolean;
    onMobile?: boolean;
    onMiniGame?: boolean;
    clientWidth?: number;
    clientHeight?: number;
    width?: number;
    height?: number;
  };
  stage?: {
    width?: number;
    height?: number;
  };
}

/**
 * Weex `storage` 模块回调结果结构。
 */
export interface WeexStorageCallbackResult {
  result?: 'success' | 'failed' | string;
  data?: string;
}

/**
 * Weex `storage` 原生模块接口（`weex.requireModule('storage')`）。
 */
export interface WeexStorageModuleLike {
  getItem(key: string, callback?: (res: WeexStorageCallbackResult) => void): string | void;
  setItem(
    key: string,
    value: string,
    callback?: (res: WeexStorageCallbackResult) => void,
  ): void;
  removeItem(key: string, callback?: (res: WeexStorageCallbackResult) => void): void;
}

/**
 * Weex `stream` 网络请求模块接口（`weex.requireModule('stream')`）。
 */
export interface WeexStreamModuleLike {
  fetch(
    options: {
      method: 'POST' | 'GET';
      url: string;
      headers?: Record<string, string>;
      type?: 'text' | 'json';
      body?: string;
    },
    callback: (res: { status: number; ok?: boolean; data?: unknown }) => void,
  ): void;
}

/**
 * Weex 运行时环境（`weex`）最小兼容接口。
 */
export interface WeexLike {
  config?: {
    env?: {
      platform?: string;
      osName?: string;
      osVersion?: string;
      appVersion?: string;
      deviceModel?: string;
      deviceWidth?: number;
      deviceHeight?: number;
      weexVersion?: string;
    };
  };
  requireModule?: {
    (name: 'storage'): WeexStorageModuleLike | undefined;
    (name: 'stream'): WeexStreamModuleLike | undefined;
    (name: string): unknown;
  };
}

function wrapSyncKeyValueStorage(
  rawStore?: {
    getItem(key: string): string | null | undefined;
    setItem(key: string, value: string): unknown;
    removeItem(key: string): void;
  },
): AbiStorageAdapter {
  const fallback = new MemoryStorageAdapter();
  return {
    getItem(key: string): string | null {
      if (rawStore && typeof rawStore.getItem === 'function') {
        try {
          const val = rawStore.getItem(key);
          if (typeof val === 'string' && val.length > 0) {
            return val;
          }
          return null;
        } catch {
          // 回退至内存存储
        }
      }
      return fallback.getItem(key);
    },
    setItem(key: string, value: string): void {
      fallback.setItem(key, value);
      if (rawStore && typeof rawStore.setItem === 'function') {
        try {
          rawStore.setItem(key, value);
        } catch {
          // 忽略引擎本地存储配额异常
        }
      }
    },
    removeItem(key: string): void {
      fallback.removeItem(key);
      if (rawStore && typeof rawStore.removeItem === 'function') {
        try {
          rawStore.removeItem(key);
        } catch {
          // 忽略移除异常
        }
      }
    },
  };
}

/**
 * 创建 Cocos Creator（2.x / 3.x）引擎适配器（对标 ThinkingData Cocos Creator 集成指南）。
 *
 * 自动桥接 `cc.sys.localStorage` 本地存储，并提取 `cc.sys.os`、`cc.view.getFrameSize()` / `cc.screen.windowSize`
 * 注入 `$lib: 'abi-cocos-creator-sdk'`、`$os`、`$os_version`、`$screen_width`、`$screen_height`。
 *
 * @example
 * ```ts
 * import { abi } from '@anylink/abi-web-sdk';
 * import { createCocosCreatorAdapter } from '@anylink/abi-web-sdk/adapters/game-engines';
 *
 * abi.init({
 *   serverUrl: 'https://ingest.abi.example.com',
 *   projectId: 1,
 *   token: 'abi_proj_token_xxx',
 *   ...createCocosCreatorAdapter(globalThis.cc),
 * });
 * ```
 */
export function createCocosCreatorAdapter(ccLike?: CocosCreatorLike): {
  storage: AbiStorageAdapter;
  presetProperties: () => Record<string, unknown>;
} {
  const storage = wrapSyncKeyValueStorage(ccLike?.sys?.localStorage);

  const presetProperties = (): Record<string, unknown> => {
    const props: Record<string, unknown> = {
      $lib: 'abi-cocos-creator-sdk',
      $engine: 'CocosCreator',
    };
    if (ccLike?.ENGINE_VERSION) {
      props.$engine_version = ccLike.ENGINE_VERSION;
    }
    const sys = ccLike?.sys;
    if (sys) {
      if (sys.os) props.$os = sys.os;
      if (sys.osVersion) props.$os_version = sys.osVersion;
      if (sys.language) props.$system_language = sys.language;
    }
    const winSize =
      ccLike?.screen?.windowSize ??
      ccLike?.view?.getFrameSize?.() ??
      ccLike?.view?.getVisibleSize?.();
    if (winSize) {
      if (typeof winSize.width === 'number') props.$screen_width = winSize.width;
      if (typeof winSize.height === 'number') props.$screen_height = winSize.height;
    }
    return props;
  };

  return { storage, presetProperties };
}

/**
 * 创建 Egret（白鹭引擎）适配器（对标 ThinkingData Egret 集成指南）。
 *
 * 自动桥接 `egret.localStorage` 本地存储，并从 `egret.Capabilities` 与舞台尺寸提取
 * `$lib: 'abi-egret-sdk'`、`$os`、`$screen_width`、`$screen_height`。
 *
 * @example
 * ```ts
 * import { abi } from '@anylink/abi-web-sdk';
 * import { createEgretAdapter } from '@anylink/abi-web-sdk/adapters/game-engines';
 *
 * abi.init({
 *   serverUrl: 'https://ingest.abi.example.com',
 *   projectId: 1,
 *   token: 'abi_proj_token_xxx',
 *   ...createEgretAdapter(globalThis.egret),
 * });
 * ```
 */
export function createEgretAdapter(egretLike?: EgretLike): {
  storage: AbiStorageAdapter;
  presetProperties: () => Record<string, unknown>;
} {
  const storage = wrapSyncKeyValueStorage(egretLike?.localStorage);

  const presetProperties = (): Record<string, unknown> => {
    const props: Record<string, unknown> = {
      $lib: 'abi-egret-sdk',
      $engine: 'Egret',
    };
    const cap = egretLike?.Capabilities;
    if (cap) {
      if (cap.os) props.$os = cap.os;
      if (cap.engineVersion) props.$engine_version = cap.engineVersion;
      if (cap.language) props.$system_language = cap.language;
      if (cap.runtimeType) props.$runtime_type = cap.runtimeType;
    }
    const stage = egretLike?.MainContext?.instance?.stage;
    const width = cap?.boundingClientWidth ?? stage?.stageWidth ?? egretLike?.stageWidth;
    const height = cap?.boundingClientHeight ?? stage?.stageHeight ?? egretLike?.stageHeight;
    if (typeof width === 'number') props.$screen_width = width;
    if (typeof height === 'number') props.$screen_height = height;
    return props;
  };

  return { storage, presetProperties };
}

/**
 * 创建 LayaAir（2.x / 3.x）引擎适配器（对标 ThinkingData LayaAir 集成指南）。
 *
 * 自动桥接 `Laya.LocalStorage` 本地存储，并从 `Laya.Browser` / `Laya.stage` 提取
 * `$lib: 'abi-layaair-sdk'`、`$os`、`$screen_width`、`$screen_height`。
 *
 * @example
 * ```ts
 * import { abi } from '@anylink/abi-web-sdk';
 * import { createLayaAirAdapter } from '@anylink/abi-web-sdk/adapters/game-engines';
 *
 * abi.init({
 *   serverUrl: 'https://ingest.abi.example.com',
 *   projectId: 1,
 *   token: 'abi_proj_token_xxx',
 *   ...createLayaAirAdapter(globalThis.Laya),
 * });
 * ```
 */
export function createLayaAirAdapter(layaLike?: LayaAirLike): {
  storage: AbiStorageAdapter;
  presetProperties: () => Record<string, unknown>;
} {
  const storage = wrapSyncKeyValueStorage(layaLike?.LocalStorage);

  const presetProperties = (): Record<string, unknown> => {
    const props: Record<string, unknown> = {
      $lib: 'abi-layaair-sdk',
      $engine: 'LayaAir',
    };
    if (layaLike?.version) {
      props.$engine_version = layaLike.version;
    }
    const br = layaLike?.Browser;
    if (br) {
      if (br.onIOS) props.$os = 'iOS';
      else if (br.onAndroid) props.$os = 'Android';
      else if (br.onMac) props.$os = 'Mac';
      else if (br.onWP) props.$os = 'WindowsPhone';
      else if (br.onPC) props.$os = 'Windows';
    }
    const width = br?.clientWidth ?? layaLike?.stage?.width ?? br?.width;
    const height = br?.clientHeight ?? layaLike?.stage?.height ?? br?.height;
    if (typeof width === 'number') props.$screen_width = width;
    if (typeof height === 'number') props.$screen_height = height;
    return props;
  };

  return { storage, presetProperties };
}

/**
 * 创建 Weex 跨平台容器适配器（对标 ThinkingData Weex 集成指南）。
 *
 * 自动桥接 `weex.requireModule('storage')`（内置同步内存镜像以兼容 Weex 回调式存储 API）
 * 与可选的 `weex.requireModule('stream')` 网络模块，并从 `weex.config.env` 提取
 * `$lib: 'abi-weex-sdk'`、`$os`、`$os_version`、`$device_model`、`$screen_width`、`$screen_height`。
 *
 * @example
 * ```ts
 * import { abi } from '@anylink/abi-web-sdk';
 * import { createWeexAdapter } from '@anylink/abi-web-sdk/adapters/game-engines';
 *
 * abi.init({
 *   serverUrl: 'https://ingest.abi.example.com',
 *   projectId: 1,
 *   token: 'abi_proj_token_xxx',
 *   ...createWeexAdapter(globalThis.weex),
 * });
 * ```
 */
export function createWeexAdapter(weexLike?: WeexLike): {
  storage: AbiStorageAdapter;
  transport?: AbiTransportFn;
  presetProperties: () => Record<string, unknown>;
} {
  const cache = new Map<string, string>();
  const storageMod =
    typeof weexLike?.requireModule === 'function'
      ? (weexLike.requireModule('storage') as WeexStorageModuleLike | undefined)
      : undefined;
  const streamMod =
    typeof weexLike?.requireModule === 'function'
      ? (weexLike.requireModule('stream') as WeexStreamModuleLike | undefined)
      : undefined;

  const storage: AbiStorageAdapter = {
    getItem(key: string): string | null {
      if (storageMod && typeof storageMod.getItem === 'function') {
        try {
          let syncValue: string | undefined;
          const directReturn = storageMod.getItem(key, (res) => {
            if (
              res &&
              (res.result === 'success' || res.result === undefined) &&
              typeof res.data === 'string' &&
              res.data.length > 0
            ) {
              syncValue = res.data;
              cache.set(key, res.data);
            }
          });
          if (typeof directReturn === 'string' && directReturn.length > 0) {
            cache.set(key, directReturn);
            return directReturn;
          }
          if (syncValue !== undefined) {
            return syncValue;
          }
        } catch {
          // 回退至内存镜像
        }
      }
      return cache.get(key) ?? null;
    },
    setItem(key: string, value: string): void {
      cache.set(key, value);
      if (storageMod && typeof storageMod.setItem === 'function') {
        try {
          storageMod.setItem(key, value, () => {});
        } catch {
          // 忽略原生模块异常
        }
      }
    },
    removeItem(key: string): void {
      cache.delete(key);
      if (storageMod && typeof storageMod.removeItem === 'function') {
        try {
          storageMod.removeItem(key, () => {});
        } catch {
          // 忽略原生模块异常
        }
      }
    },
  };

  const transport: AbiTransportFn | undefined =
    streamMod && typeof streamMod.fetch === 'function'
      ? (url, headers, body) =>
          new Promise((resolve) => {
            streamMod.fetch(
              {
                method: 'POST',
                url,
                headers,
                type: 'text',
                body,
              },
              (res) => {
                const status = typeof res?.status === 'number' ? res.status : 0;
                const bodyText =
                  typeof res?.data === 'string' ? res.data : JSON.stringify(res?.data ?? {});
                resolve({ status, bodyText });
              },
            );
          })
      : undefined;

  const presetProperties = (): Record<string, unknown> => {
    const env = weexLike?.config?.env;
    const props: Record<string, unknown> = {
      $lib: 'abi-weex-sdk',
      $os: env?.osName || env?.platform || 'weex',
    };
    if (env?.osVersion) props.$os_version = env.osVersion;
    if (env?.appVersion) props.$app_version = env.appVersion;
    if (env?.deviceModel) props.$device_model = env.deviceModel;
    if (env?.weexVersion) props.$engine_version = env.weexVersion;
    if (typeof env?.deviceWidth === 'number') props.$screen_width = env.deviceWidth;
    if (typeof env?.deviceHeight === 'number') props.$screen_height = env.deviceHeight;
    return props;
  };

  return {
    storage,
    ...(transport ? { transport } : {}),
    presetProperties,
  };
}
