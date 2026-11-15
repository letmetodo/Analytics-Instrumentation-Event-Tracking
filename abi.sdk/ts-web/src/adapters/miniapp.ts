import type { AbiStorageAdapter } from '../storage.js';
import type { AbiTransportFn } from '../index.js';

export interface MiniProgramApiLike {
  getStorageSync(key: string): unknown;
  setStorageSync(key: string, data: string): void;
  removeStorageSync(key: string): void;
  getSystemInfoSync?: () => {
    system?: string;
    platform?: string;
    model?: string;
    windowWidth?: number;
    windowHeight?: number;
    screenWidth?: number;
    screenHeight?: number;
    version?: string;
  };
  request(options: {
    url: string;
    method: 'POST';
    header: Record<string, string>;
    data: string;
    success: (res: { statusCode: number; data: unknown }) => void;
    fail: (err: unknown) => void;
  }): void;
}

/**
 * Creates a Storage + Transport + PresetProperties adapter for WeChat MiniProgram (`wx`),
 * uni-app (`uni`), or Taro (`Taro`).
 */
export function createMiniProgramAdapter(mp: MiniProgramApiLike): {
  storage: AbiStorageAdapter;
  transport: AbiTransportFn;
  presetProperties: () => Record<string, unknown>;
} {
  const storage: AbiStorageAdapter = {
    getItem(key: string): string | null {
      try {
        const val = mp.getStorageSync(key);
        return typeof val === 'string' && val.length > 0 ? val : null;
      } catch {
        return null;
      }
    },
    setItem(key: string, value: string): void {
      try {
        mp.setStorageSync(key, value);
      } catch {
        // Ignore storage quota errors
      }
    },
    removeItem(key: string): void {
      try {
        mp.removeStorageSync(key);
      } catch {
        // Ignore
      }
    },
  };

  const transport: AbiTransportFn = (url, headers, body) =>
    new Promise((resolve, reject) => {
      mp.request({
        url,
        method: 'POST',
        header: headers,
        data: body,
        success(res) {
          const bodyText =
            typeof res.data === 'string' ? res.data : JSON.stringify(res.data ?? {});
          resolve({ status: res.statusCode, bodyText });
        },
        fail(err) {
          reject(err);
        },
      });
    });

  const presetProperties = (): Record<string, unknown> => {
    const props: Record<string, unknown> = {
      $lib: 'abi-mp-sdk',
    };
    if (typeof mp.getSystemInfoSync === 'function') {
      try {
        const sys = mp.getSystemInfoSync();
        if (sys.platform) props.$os = sys.platform;
        if (sys.system) props.$os_version = sys.system;
        if (sys.model) props.$device_model = sys.model;
        if (typeof sys.screenWidth === 'number') props.$screen_width = sys.screenWidth;
        if (typeof sys.screenHeight === 'number') props.$screen_height = sys.screenHeight;
      } catch {
        // Ignore system info failure
      }
    }
    return props;
  };

  return { storage, transport, presetProperties };
}
