import type { AbiStorageAdapter } from '../storage.js';

export interface ReactNativeEnvOptions {
  os: 'ios' | 'android' | string;
  osVersion?: string;
  deviceModel?: string;
  appVersion?: string;
  screenWidth?: number;
  screenHeight?: number;
  syncStorage?: AbiStorageAdapter;
}

/**
 * Creates a Storage + PresetProperties adapter for React Native apps (e.g., backed by MMKV or in-memory sync cache).
 */
export function createReactNativeAdapter(options: ReactNativeEnvOptions): {
  storage?: AbiStorageAdapter;
  presetProperties: () => Record<string, unknown>;
} {
  return {
    storage: options.syncStorage,
    presetProperties: () => {
      const props: Record<string, unknown> = {
        $lib: 'abi-rn-sdk',
        $os: options.os,
      };
      if (options.osVersion) props.$os_version = options.osVersion;
      if (options.deviceModel) props.$device_model = options.deviceModel;
      if (options.appVersion) props.$app_version = options.appVersion;
      if (typeof options.screenWidth === 'number') props.$screen_width = options.screenWidth;
      if (typeof options.screenHeight === 'number') props.$screen_height = options.screenHeight;
      return props;
    },
  };
}
