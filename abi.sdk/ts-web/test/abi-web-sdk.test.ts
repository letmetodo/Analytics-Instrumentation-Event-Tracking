import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AbiWebSdk,
  MemoryStorageAdapter,
  normalizeIdentity,
  normalizeProperties,
  validateEventName,
  validatePropertyKey,
  type AbiTransportFn,
} from '../src/index';
import { createMiniProgramAdapter } from '../src/adapters/miniapp';
import { createReactNativeAdapter } from '../src/adapters/react-native';
import { createH5AppBridgeAdapter } from '../src/adapters/h5-bridge';
import {
  createCocosCreatorAdapter,
  createEgretAdapter,
  createLayaAirAdapter,
  createWeexAdapter,
} from '../src/adapters/game-engines';
import {
  runReactNativeExample,
  runWebSpaEcommerceExample,
  runWeChatMiniProgramExample,
} from '../examples/usage-examples';

interface IdentityVector {
  name: string;
  distinct_id: string;
  login_id: string;
  valid: boolean;
  normalized_distinct_id?: string;
  normalized_login_id?: string;
}

interface EventPropVectorsFile {
  max_safe_integer: number;
  event_name_cases: Array<{ event_name: string; valid: boolean }>;
  property_key_cases: Array<{ key: string; valid: boolean }>;
}

describe('ABI Web & Cross-Platform TypeScript SDK', () => {
  it('passes all shared golden identity vectors', () => {
    const raw = readFileSync(
      resolve(__dirname, '../../spec/test-vectors/identity_cases.json'),
      'utf-8',
    );
    const parsed = JSON.parse(raw) as { cases: IdentityVector[] };
    const vectors = parsed.cases;
    expect(vectors.length).toBeGreaterThan(0);

    for (const tc of vectors) {
      if (tc.valid) {
        const res = normalizeIdentity(tc.distinct_id, tc.login_id);
        if (tc.normalized_distinct_id !== undefined) {
          expect(res.distinctId, tc.name).toBe(tc.normalized_distinct_id);
        }
        if (tc.normalized_login_id !== undefined) {
          expect(res.loginId, tc.name).toBe(tc.normalized_login_id);
        }
      } else {
        expect(
          () => normalizeIdentity(tc.distinct_id, tc.login_id),
          tc.name,
        ).toThrow();
      }
    }
  });

  it('passes all shared golden event and property vectors', () => {
    const raw = readFileSync(
      resolve(__dirname, '../../spec/test-vectors/event_and_property_cases.json'),
      'utf-8',
    );
    const parsed = JSON.parse(raw) as EventPropVectorsFile;
    expect(parsed.event_name_cases.length).toBeGreaterThan(0);
    expect(parsed.property_key_cases.length).toBeGreaterThan(0);

    for (const tc of parsed.event_name_cases) {
      if (tc.valid) {
        expect(() => validateEventName(tc.event_name), tc.event_name).not.toThrow();
      } else {
        expect(() => validateEventName(tc.event_name), tc.event_name).toThrow();
      }
    }

    for (const tc of parsed.property_key_cases) {
      if (tc.valid) {
        expect(() => validatePropertyKey(tc.key), tc.key).not.toThrow();
      } else {
        expect(() => validatePropertyKey(tc.key), tc.key).toThrow();
      }
    }
  });

  it('converts 64-bit integers beyond IEEE-754 MAX_SAFE_INTEGER to string and preserves scalar types in lists', () => {
    const norm = normalizeProperties({
      safe_int: 9007199254740991,
      snowflake_bigint: 9007199254740993n,
      tags: ['vip', 42, true, 9007199254740995n],
    });
    expect(norm.safe_int).toBe(9007199254740991);
    expect(norm.snowflake_bigint).toBe('9007199254740993');
    expect(norm.tags).toEqual(['vip', 42, true, '9007199254740995']);
    expect(() => normalizeProperties({ bad_list: ['a', null] })).toThrow();
  });

  it('keeps distinctId intact on login/logout without emitting $identify and validates UTF-8 byte limits', () => {
    const storage = new MemoryStorageAdapter();
    const sdk = new AbiWebSdk().init({
      serverUrl: 'https://ingest.abi.example.com',
      projectId: 7,
      token: 'abi_tok_web_test_123',
      storage,
      transport: async () => ({ status: 200, bodyText: '{"code":200}' }),
    });
    expect(storage.getItem('abi_sdk_7_distinct_id')).toBeTruthy();
    sdk.identify('visitor_device_short');
    expect(storage.getItem('abi_sdk_7_distinct_id')).toBe('visitor_device_short');

    const longCjkLogin = '用'.repeat(25); // 25 chars = 75 UTF-8 bytes (<= 128 login_id limit)
    const loginRet = sdk.login(longCjkLogin);
    expect(loginRet).toBeUndefined();
    expect(sdk.getQueueLength()).toBe(0);
    expect(sdk.getLoginId()).toBe(longCjkLogin);
    expect(sdk.getDistinctId()).toBe('visitor_device_short');

    sdk.logout();
    expect(sdk.getLoginId()).toBe('');
    expect(sdk.getDistinctId()).toBe('visitor_device_short');
    expect(sdk.getQueueLength()).toBe(0);

    expect(() => sdk.track('$identify')).toThrow();
    expect(() => sdk.track('#identify')).toThrow();
    sdk.destroy();

    // Corrupted / overlong persisted IDs in storage are sanitized on init instead of poisoning track()
    const dirtyStorage = new MemoryStorageAdapter();
    dirtyStorage.setItem('abi_sdk_7_distinct_id', 'd'.repeat(80));
    dirtyStorage.setItem('abi_sdk_7_login_id', 'l'.repeat(150));
    const recoveredSdk = new AbiWebSdk().init({
      serverUrl: 'https://ingest.abi.example.com',
      projectId: 7,
      token: 'abi_tok_web_test_123',
      storage: dirtyStorage,
      transport: async () => ({ status: 200, bodyText: '{"code":200}' }),
    });
    expect(recoveredSdk.getDistinctId().length).toBeLessThanOrEqual(64);
    expect(recoveredSdk.getDistinctId()).not.toBe('d'.repeat(80));
    expect(recoveredSdk.getLoginId()).toBe('');
    expect(dirtyStorage.getItem('abi_sdk_7_login_id')).toBeNull();
    expect(() => recoveredSdk.track('PageView')).not.toThrow();
    recoveredSdk.destroy();
  });

  it('supports ThinkingData dual identity (distinct_id + login_id), super properties, timeEvent, userSet*, and idempotent offline retry', async () => {
    const calls: Array<{ url: string; headers: Record<string, string>; body: any }> = [];
    let shouldFailTrackOnce = true;

    const mockTransport: AbiTransportFn = async (url, headers, body) => {
      const parsed = JSON.parse(body);
      calls.push({ url, headers, body: parsed });
      if (shouldFailTrackOnce) {
        shouldFailTrackOnce = false;
        return { status: 503, bodyText: '{"code":50000}' };
      }
      return { status: 200, bodyText: '{"code":200,"data":{"accepted":3}}' };
    };

    const sdk = new AbiWebSdk();
    sdk.init({
      serverUrl: 'https://ingest.abi.example.com',
      projectId: 7,
      token: 'abi_tok_web_test_123',
      maxBatchSize: 50,
      flushIntervalMs: 60000,
      storage: new MemoryStorageAdapter(),
      transport: mockTransport,
    });

    sdk.identify('visitor_device_001');
    expect(sdk.getDistinctId()).toBe('visitor_device_001');

    sdk.login('acct_9988');
    expect(sdk.getDistinctId()).toBe('visitor_device_001');
    expect(sdk.getLoginId()).toBe('acct_9988');
    expect(sdk.getQueueLength()).toBe(0);

    sdk.setSuperProperties({ channel: 'web_organic' });
    sdk.timeEvent('OrderPaid');
    const eventId = sdk.track('OrderPaid', { amount: 299.5 });
    sdk.userSet({ vip_level: 'diamond' });
    sdk.userAdd({ total_points: 50 });

    expect(sdk.getQueueLength()).toBe(3);

    // First flush fails with 503 -> queue stays intact with identical event_id
    const firstFlushOk = await sdk.flush();
    expect(firstFlushOk).toBe(false);
    expect(sdk.getQueueLength()).toBe(3);

    // Second flush succeeds -> sends identical event_id to /collect/api/v1/track/batch
    const secondFlushOk = await sdk.flush();
    expect(secondFlushOk).toBe(true);
    expect(sdk.getQueueLength()).toBe(0);

    expect(calls).toHaveLength(2);
    expect(calls[0].url).toBe('https://ingest.abi.example.com/collect/api/v1/track/batch');
    expect(calls[1].body.project_id).toBe(7);
    expect(calls[1].body.project_token).toBe('abi_tok_web_test_123');
    expect(calls[0].body.events[0].event_id).toBe(eventId);
    expect(calls[1].body.events[0].event_id).toBe(eventId);
    expect(calls[1].body.events[0].event_name).toBe('OrderPaid');
    expect(calls[1].body.events[0].distinct_id).toBe('visitor_device_001');
    expect(calls[1].body.events[0].login_id).toBe('acct_9988');
    expect(Object.keys(calls[1].body.events[0])).toEqual([
      'event_id',
      'event_name',
      'distinct_id',
      'login_id',
      'timestamp',
      'properties',
    ]);
    expect(calls[1].body.events[0].properties.channel).toBe('web_organic');
    expect(typeof calls[1].body.events[0].properties.$duration).toBe('number');
    expect(calls[1].body.events[1].event_name).toBe('$user_set');
    expect(calls[1].body.events[1].distinct_id).toBe('visitor_device_001');
    expect(calls[1].body.events[1].login_id).toBe('acct_9988');
    expect(calls[1].body.events[2].event_name).toBe('$user_add');

    sdk.destroy();
  });

  it('works with WeChat MiniProgram and React Native adapters', async () => {
    const mpStore = new Map<string, string>();
    const mpRequests: any[] = [];
    const mpAdapter = createMiniProgramAdapter({
      getStorageSync: (k) => mpStore.get(k) ?? '',
      setStorageSync: (k, v) => mpStore.set(k, v),
      removeStorageSync: (k) => mpStore.delete(k),
      getSystemInfoSync: () => ({
        platform: 'ios',
        system: 'iOS 17.4',
        model: 'iPhone 15 Pro',
        screenWidth: 393,
        screenHeight: 852,
      }),
      request: ({ url, header, data, success }) => {
        mpRequests.push({ url, header, data: JSON.parse(data) });
        success({ statusCode: 200, data: { code: 200 } });
      },
    });

    const sdk = new AbiWebSdk().init({
      serverUrl: 'https://ingest.abi.example.com',
      projectId: 7,
      token: 'abi_tok_mp_001',
      ...mpAdapter,
    });

    sdk.track('MiniAppLaunch');
    await sdk.flush();
    expect(mpRequests).toHaveLength(1);
    expect(mpRequests[0].url).toBe('https://ingest.abi.example.com/collect/api/v1/track/batch');
    expect(mpRequests[0].data.events[0].properties.$lib).toBe('abi-mp-sdk');
    expect(mpRequests[0].data.events[0].properties.$device_model).toBe('iPhone 15 Pro');
    sdk.destroy();

    const rnAdapter = createReactNativeAdapter({
      os: 'android',
      osVersion: '14',
      deviceModel: 'Pixel 8',
      appVersion: '3.2.0',
    });
    expect(rnAdapter.presetProperties()).toMatchObject({
      $lib: 'abi-rn-sdk',
      $os: 'android',
      $device_model: 'Pixel 8',
    });
  });

  it('executes runnable usage examples for Web SPA E-Commerce, WeChat MiniProgram, and React Native', async () => {
    const webRes = await runWebSpaEcommerceExample();
    expect(webRes.distinctId).toBe('visitor_web_001');
    expect(webRes.loginId).toBe('user_10086');
    expect(webRes.events.map((e) => e.event_name)).toEqual([
      'ProductView',
      'CheckoutStarted',
      'OrderPaid',
      'OrderSettled',
      '$user_set',
      '$user_set_once',
      '$user_add',
      '$user_append',
      '$user_uniq_append',
      '$user_unset',
      '$user_del',
    ]);
    expect(webRes.events[0].distinct_id).toBe('visitor_web_001');
    expect(webRes.events[0].login_id).toBeUndefined();

    const checkoutEvt = webRes.events[1];
    expect(checkoutEvt.distinct_id).toBe('visitor_web_001');
    expect(checkoutEvt.login_id).toBe('user_10086');
    expect(checkoutEvt.event_id).toBe('evt_checkout_visitor_web_001');

    const orderPaidEvt = webRes.events[2];
    expect(orderPaidEvt.event_id).toBe('evt_order_paid_2026_001');
    expect(orderPaidEvt.properties.order_id).toBe('9007199254740993');
    expect(orderPaidEvt.properties.amount).toBe(299.5);
    expect(orderPaidEvt.properties.items).toEqual(['sku_1', 2, true]);
    expect(typeof orderPaidEvt.properties.$duration).toBe('number');
    expect(webRes.events[3].event_id).toBe('evt_order_settled_2026_001');

    const mpRes = await runWeChatMiniProgramExample();
    expect(mpRes.loginId).toBe('wx_openid_u_8801');
    expect(mpRes.events.map((e) => e.event_name)).toEqual([
      '$AppStart',
      'ShareMiniProgram',
      '$user_set',
    ]);
    expect(mpRes.events[0].login_id).toBeUndefined();
    expect(mpRes.events[1].distinct_id).toBe(mpRes.distinctId);
    expect(mpRes.events[1].login_id).toBe('wx_openid_u_8801');
    expect(mpRes.events[1].properties.$lib).toBe('abi-mp-sdk');
    expect(mpRes.events[1].properties.campaign_id).toBe('9007199254740999');

    const rnRes = await runReactNativeExample();
    expect(rnRes.distinctId).toBe('rn_device_uuid_7788');
    expect(rnRes.loginId).toBe('rn_user_5566');
    expect(rnRes.events.map((e) => e.event_name)).toEqual([
      'VideoPlayback',
      '$user_set_once',
      '$user_add',
    ]);
    expect(rnRes.events[0].distinct_id).toBe('rn_device_uuid_7788');
    expect(rnRes.events[0].login_id).toBe('rn_user_5566');
    expect(rnRes.events[0].properties.$lib).toBe('abi-rn-sdk');
    expect(rnRes.events[0].properties.$os).toBe('android');
    expect(rnRes.events[0].properties.$device_model).toBe('Pixel 8 Pro');
  });

  it('extracts #time / $time from properties into top-level timestamp and strips them in track and user* methods', async () => {
    const batches: any[] = [];
    const sdk = new AbiWebSdk().init({
      serverUrl: 'https://ingest.abi.example.com',
      projectId: 7,
      token: 'abi_tok_time_test',
      maxBatchSize: 50,
      flushIntervalMs: 60000,
      storage: new MemoryStorageAdapter(),
      transport: async (_url, _headers, body) => {
        batches.push(JSON.parse(body));
        return { status: 200, bodyText: '{"code":200}' };
      },
    });

    const targetDate = new Date('2026-11-10T02:00:00Z');
    const expectedMs = 1794276000000;
    const trackProps = { '#time': targetDate, amount: 100 };
    const userSetProps = { '#time': targetDate, amount: 100 };

    sdk.track('OrderPaid', trackProps);
    sdk.userSet(userSetProps);
    sdk.userSetOnce({ $time: '2026-11-10T02:00:00Z', first_channel: 'organic' });
    sdk.userAdd({ '#time': 1794276000, total_points: 25 });
    sdk.track('ExplicitTimestampWins', { '#time': targetDate, amount: 50 }, { timestamp: 1800000000000 });

    // Caller's input object should not be mutated
    expect(trackProps['#time']).toBe(targetDate);
    expect(userSetProps['#time']).toBe(targetDate);

    // Invalid #time / $time must throw Error
    expect(() => sdk.track('BadTimeDate', { '#time': new Date('invalid-date') })).toThrow();
    expect(() => sdk.track('BadTimeString', { '#time': 'not-a-valid-date' })).toThrow();
    expect(() => sdk.track('BadTimeNumber', { $time: -100 })).toThrow();
    expect(() => sdk.track('BadTimeType', { '#time': { nested: true } })).toThrow();
    expect(() => sdk.userSet({ '#time': null })).toThrow();

    await sdk.flush();
    expect(batches).toHaveLength(1);
    const events = batches[0].events;
    expect(events).toHaveLength(5);

    // 1. track with { '#time': new Date('2026-11-10T02:00:00Z'), amount: 100 }
    expect(events[0].event_name).toBe('OrderPaid');
    expect(events[0].timestamp).toBe(expectedMs);
    expect(events[0].properties.amount).toBe(100);
    expect(events[0].properties).not.toHaveProperty('#time');
    expect(events[0].properties).not.toHaveProperty('$time');

    // 2. userSet with { '#time': new Date('2026-11-10T02:00:00Z'), amount: 100 }
    expect(events[1].event_name).toBe('$user_set');
    expect(events[1].timestamp).toBe(expectedMs);
    expect(events[1].properties).toEqual({ amount: 100 });
    expect(events[1].properties).not.toHaveProperty('#time');

    // 3. userSetOnce with ISO string $time
    expect(events[2].event_name).toBe('$user_set_once');
    expect(events[2].timestamp).toBe(expectedMs);
    expect(events[2].properties).toEqual({ first_channel: 'organic' });
    expect(events[2].properties).not.toHaveProperty('$time');

    // 4. userAdd with Unix seconds #time
    expect(events[3].event_name).toBe('$user_add');
    expect(events[3].timestamp).toBe(expectedMs);
    expect(events[3].properties).toEqual({ total_points: 25 });
    expect(events[3].properties).not.toHaveProperty('#time');

    // 5. Explicit options.timestamp overrides #time while still stripping #time
    expect(events[4].event_name).toBe('ExplicitTimestampWins');
    expect(events[4].timestamp).toBe(1800000000000);
    expect(events[4].properties.amount).toBe(50);
    expect(events[4].properties).not.toHaveProperty('#time');

    sdk.destroy();
  });

  it('enforces super property lifecycle methods and override priority (preset < super < dynamicSuper < properties) without polluting user events', async () => {
    const batches: any[] = [];
    const sdk = new AbiWebSdk().init({
      serverUrl: 'https://ingest.abi.example.com',
      projectId: 7,
      token: 'abi_tok_super_priority',
      maxBatchSize: 50,
      flushIntervalMs: 60000,
      storage: new MemoryStorageAdapter(),
      presetProperties: () => ({
        tier_preset: 'from_preset',
        tier_super: 'from_preset',
        tier_dynamic: 'from_preset',
        tier_event: 'from_preset',
      }),
      transport: async (_url, _headers, body) => {
        batches.push(JSON.parse(body));
        return { status: 200, bodyText: '{"code":200}' };
      },
    });

    // Verify setSuperProperties / getSuperProperties / unsetSuperProperty / clearSuperProperties
    sdk.setSuperProperties({ temp_flag: 'v1', keep_flag: 'v2' });
    expect(sdk.getSuperProperties()).toEqual({ temp_flag: 'v1', keep_flag: 'v2' });

    sdk.unsetSuperProperty('temp_flag');
    expect(sdk.getSuperProperties()).toEqual({ keep_flag: 'v2' });

    sdk.clearSuperProperties();
    expect(sdk.getSuperProperties()).toEqual({});

    // Set layered super properties & dynamic super properties
    sdk.setSuperProperties({
      tier_super: 'from_super',
      tier_dynamic: 'from_super',
      tier_event: 'from_super',
    });
    sdk.setDynamicSuperProperties(() => ({
      tier_dynamic: 'from_dynamic',
      tier_event: 'from_dynamic',
    }));

    sdk.track('PriorityEvent', {
      tier_event: 'from_event',
    });
    sdk.userSet({ vip_tier: 'gold' });
    sdk.track('#user_set', { vip_tier: 'platinum' });

    await sdk.flush();
    expect(batches).toHaveLength(1);
    const [behaviorEvt, dollarUserEvt, hashUserEvt] = batches[0].events;

    expect(behaviorEvt.event_name).toBe('PriorityEvent');
    expect(behaviorEvt.properties.tier_preset).toBe('from_preset');
    expect(behaviorEvt.properties.tier_super).toBe('from_super');
    expect(behaviorEvt.properties.tier_dynamic).toBe('from_dynamic');
    expect(behaviorEvt.properties.tier_event).toBe('from_event');

    // Neither $user_* nor #user_* should contain preset, static super, or dynamic super properties
    expect(dollarUserEvt.event_name).toBe('$user_set');
    expect(dollarUserEvt.properties).toEqual({ vip_tier: 'gold' });
    expect(hashUserEvt.event_name).toBe('#user_set');
    expect(hashUserEvt.properties).toEqual({ vip_tier: 'platinum' });

    sdk.destroy();
  });

  it('supports two-step parameter preview (buildPendingBatchPayload) and explicit confirm submit', async () => {
    const { previewAndConfirmWebSdkExample } = await import('../examples/usage-examples.js');

    const previewOnly = await previewAndConfirmWebSdkExample({ confirmSubmit: false, dryRun: true });
    expect(previewOnly.submitted).toBe(false);
    expect(previewOnly.batches).toHaveLength(0);
    const parsedPreview = JSON.parse(previewOnly.requestPreviewJson);
    expect(parsedPreview.project_id).toBe(101);
    expect(parsedPreview.dry_run).toBe(true);
    expect(parsedPreview.events).toHaveLength(1);
    expect(parsedPreview.events[0].event_name).toBe('OrderPaid');
    expect(parsedPreview.events[0].properties.channel).toBe('web_official');
    expect(parsedPreview.events[0].properties.order_id).toBe('9007199254740993');

    const confirmed = await previewAndConfirmWebSdkExample({ confirmSubmit: true, dryRun: true });
    expect(confirmed.submitted).toBe(true);
    expect(confirmed.batches).toHaveLength(1);
    expect(confirmed.batches[0].events[0].event_name).toBe('OrderPaid');
  });

  it('bridges H5 events and identity with Native App SDK (Android JavascriptInterface, iOS WKScriptMessageHandler, and HTTP fallback)', async () => {
    const nativePayloads: any[] = [];
    const fallbackPayloads: any[] = [];
    let allowNativeTrack = true;

    const androidBridge = createH5AppBridgeAdapter({
      storage: new MemoryStorageAdapter(),
      bridge: {
        getDistinctId: () => 'native_visitor_device_888',
        getLoginId: () => 'native_user_999',
        getAppPresetProperties: () =>
          JSON.stringify({
            $os: 'Android',
            $os_version: '15',
            $device_model: 'Pixel 9 Pro',
            $app_version: '4.1.0',
          }),
        trackFromH5: (payloadJson: string) => {
          if (!allowNativeTrack) {
            return false;
          }
          nativePayloads.push(JSON.parse(payloadJson));
          return true;
        },
      },
      fallbackTransport: async (_url, _headers, body) => {
        fallbackPayloads.push(JSON.parse(body));
        return { status: 200, bodyText: '{"code":200,"channel":"http_fallback"}' };
      },
    });

    expect(androidBridge.isBridgeAvailable()).toBe(true);
    expect(androidBridge.getNativeIdentity()).toEqual({
      distinctId: 'native_visitor_device_888',
      loginId: 'native_user_999',
    });

    const sdk = new AbiWebSdk().init({
      serverUrl: 'https://ingest.abi.example.com',
      projectId: 12,
      token: 'abi_tok_h5_bridge',
      ...androidBridge,
    });

    // Automatically reuses Native App's distinct_id and login_id
    expect(sdk.getDistinctId()).toBe('native_visitor_device_888');
    expect(sdk.getLoginId()).toBe('native_user_999');

    sdk.track('H5CampaignBannerClick', { banner_slot: 'hero_top' });
    await sdk.flush();

    expect(nativePayloads).toHaveLength(1);
    expect(fallbackPayloads).toHaveLength(0);
    expect(nativePayloads[0].events[0].event_name).toBe('H5CampaignBannerClick');
    expect(nativePayloads[0].events[0].distinct_id).toBe('native_visitor_device_888');
    expect(nativePayloads[0].events[0].login_id).toBe('native_user_999');
    expect(nativePayloads[0].events[0].properties).toMatchObject({
      $lib: 'abi-h5-bridge-sdk',
      $h5_bridge: true,
      $os: 'Android',
      $device_model: 'Pixel 9 Pro',
      banner_slot: 'hero_top',
    });

    // When native bridge rejects/is unavailable, falls back to HTTP transport
    allowNativeTrack = false;
    sdk.track('H5ExternalShareView');
    await sdk.flush();
    expect(fallbackPayloads).toHaveLength(1);
    expect(fallbackPayloads[0].events[0].event_name).toBe('H5ExternalShareView');
    sdk.destroy();

    // iOS WKScriptMessageHandler postMessage mode
    const webkitMessages: any[] = [];
    const iosBridge = createH5AppBridgeAdapter({
      storage: new MemoryStorageAdapter(),
      bridge: {
        postMessage: (msg: string) => {
          webkitMessages.push(JSON.parse(msg));
        },
      },
    });
    const iosSdk = new AbiWebSdk().init({
      serverUrl: 'https://ingest.abi.example.com',
      projectId: 12,
      token: 'abi_tok_ios_wk',
      ...iosBridge,
    });
    iosSdk.track('IOSWebViewAction');
    await iosSdk.flush();
    expect(webkitMessages).toHaveLength(1);
    expect(webkitMessages[0].events[0].event_name).toBe('IOSWebViewAction');
    iosSdk.destroy();

    // When Native App logs out (getLoginId returns "" or null), stale H5 login_id in baseStorage is cleared
    const sharedH5Storage = new MemoryStorageAdapter();
    sharedH5Storage.setItem('abi_sdk_12_distinct_id', 'h5_local_visitor');
    sharedH5Storage.setItem('abi_sdk_12_login_id', 'stale_h5_user_001');
    let nativeLoginState: string | null = '';
    const logoutSyncBridge = createH5AppBridgeAdapter({
      storage: sharedH5Storage,
      bridge: {
        getDistinctId: () => 'native_visitor_device_888',
        getLoginId: () => nativeLoginState,
        trackFromH5: () => true,
      },
    });
    const loggedOutSdk = new AbiWebSdk().init({
      serverUrl: 'https://ingest.abi.example.com',
      projectId: 12,
      token: 'abi_tok_h5_bridge',
      ...logoutSyncBridge,
    });
    expect(loggedOutSdk.getDistinctId()).toBe('native_visitor_device_888');
    expect(loggedOutSdk.getLoginId()).toBe('');
    expect(sharedH5Storage.getItem('abi_sdk_12_login_id')).toBeNull();
    loggedOutSdk.destroy();

    sharedH5Storage.setItem('abi_sdk_12_login_id', 'stale_h5_user_002');
    nativeLoginState = null;
    const nullLoggedOutSdk = new AbiWebSdk().init({
      serverUrl: 'https://ingest.abi.example.com',
      projectId: 12,
      token: 'abi_tok_h5_bridge',
      ...logoutSyncBridge,
    });
    expect(nullLoggedOutSdk.getLoginId()).toBe('');
    expect(sharedH5Storage.getItem('abi_sdk_12_login_id')).toBeNull();
    nullLoggedOutSdk.destroy();
  });

  it('works with Cocos Creator, Egret, LayaAir, and Weex game/cross-platform engine adapters', async () => {
    // 1. Cocos Creator
    const cocosStore = new Map<string, string>();
    const cocosBatches: any[] = [];
    const cocosAdapter = createCocosCreatorAdapter({
      ENGINE_VERSION: '3.8.2',
      sys: {
        localStorage: {
          getItem: (k) => cocosStore.get(k) ?? null,
          setItem: (k, v) => cocosStore.set(k, v),
          removeItem: (k) => cocosStore.delete(k),
        },
        os: 'iOS',
        osVersion: '17.5',
        language: 'zh',
      },
      view: {
        getFrameSize: () => ({ width: 1334, height: 750 }),
      },
    });

    const cocosSdk = new AbiWebSdk().init({
      serverUrl: 'https://ingest.abi.example.com',
      projectId: 21,
      token: 'abi_tok_cocos',
      ...cocosAdapter,
      transport: async (_u, _h, body) => {
        cocosBatches.push(JSON.parse(body));
        return { status: 200, bodyText: '{"code":200}' };
      },
    });
    cocosSdk.identify('cocos_player_001');
    cocosSdk.track('StageCleared', { stage_id: 12, stars: 3 });
    await cocosSdk.flush();
    expect(cocosStore.get('abi_sdk_21_distinct_id')).toBe('cocos_player_001');
    expect(cocosBatches[0].events[0].properties).toMatchObject({
      $lib: 'abi-cocos-creator-sdk',
      $engine: 'CocosCreator',
      $engine_version: '3.8.2',
      $os: 'iOS',
      $os_version: '17.5',
      $screen_width: 1334,
      $screen_height: 750,
      stage_id: 12,
    });
    cocosSdk.destroy();

    // 2. Egret
    const egretStore = new Map<string, string>();
    const egretAdapter = createEgretAdapter({
      localStorage: {
        getItem: (k) => egretStore.get(k) ?? null,
        setItem: (k, v) => {
          egretStore.set(k, v);
          return true;
        },
        removeItem: (k) => egretStore.delete(k),
      },
      Capabilities: {
        os: 'Android',
        engineVersion: '5.4.1',
        runtimeType: 'web',
        boundingClientWidth: 720,
        boundingClientHeight: 1280,
      },
    });
    expect(egretAdapter.presetProperties()).toMatchObject({
      $lib: 'abi-egret-sdk',
      $engine: 'Egret',
      $engine_version: '5.4.1',
      $os: 'Android',
      $screen_width: 720,
      $screen_height: 1280,
    });
    egretAdapter.storage.setItem('egret_key', 'egret_val');
    expect(egretAdapter.storage.getItem('egret_key')).toBe('egret_val');

    // 3. LayaAir
    const layaStore = new Map<string, string>();
    const layaAdapter = createLayaAirAdapter({
      version: '3.1.0',
      LocalStorage: {
        getItem: (k) => layaStore.get(k) ?? null,
        setItem: (k, v) => layaStore.set(k, v),
        removeItem: (k) => layaStore.delete(k),
      },
      Browser: {
        onIOS: true,
        clientWidth: 1920,
        clientHeight: 1080,
      },
    });
    expect(layaAdapter.presetProperties()).toMatchObject({
      $lib: 'abi-layaair-sdk',
      $engine: 'LayaAir',
      $engine_version: '3.1.0',
      $os: 'iOS',
      $screen_width: 1920,
      $screen_height: 1080,
    });
    layaAdapter.storage.setItem('laya_key', 'laya_val');
    expect(layaAdapter.storage.getItem('laya_key')).toBe('laya_val');

    // 4. Weex
    const weexStore = new Map<string, string>();
    const weexRequests: any[] = [];
    const weexAdapter = createWeexAdapter({
      config: {
        env: {
          osName: 'iOS',
          osVersion: '17.2',
          appVersion: '5.0.0',
          deviceModel: 'iPhone16,2',
          deviceWidth: 1179,
          deviceHeight: 2556,
          weexVersion: '0.28.0',
        },
      },
      requireModule: ((name: string) => {
        if (name === 'storage') {
          return {
            getItem: (k: string, cb?: (res: { result: string; data?: string }) => void) => {
              const val = weexStore.get(k);
              cb?.({ result: val !== undefined ? 'success' : 'failed', data: val });
            },
            setItem: (k: string, v: string, cb?: (res: { result: string }) => void) => {
              weexStore.set(k, v);
              cb?.({ result: 'success' });
            },
            removeItem: (k: string, cb?: (res: { result: string }) => void) => {
              weexStore.delete(k);
              cb?.({ result: 'success' });
            },
          };
        }
        if (name === 'stream') {
          return {
            fetch: (opts: { url: string; body?: string }, cb: (res: { status: number; data: string }) => void) => {
              weexRequests.push({ url: opts.url, body: JSON.parse(opts.body || '{}') });
              cb({ status: 200, data: '{"code":200}' });
            },
          };
        }
        return undefined;
      }) as any,
    });

    const weexSdk = new AbiWebSdk().init({
      serverUrl: 'https://ingest.abi.example.com',
      projectId: 22,
      token: 'abi_tok_weex',
      ...weexAdapter,
    });
    weexSdk.identify('weex_visitor_007');
    weexSdk.track('WeexPageRender');
    await weexSdk.flush();
    expect(weexStore.get('abi_sdk_22_distinct_id')).toBe('weex_visitor_007');
    expect(weexRequests).toHaveLength(1);
    expect(weexRequests[0].body.events[0].properties).toMatchObject({
      $lib: 'abi-weex-sdk',
      $os: 'iOS',
      $os_version: '17.2',
      $device_model: 'iPhone16,2',
      $screen_width: 1179,
      $screen_height: 2556,
    });
    weexSdk.destroy();
  });

  it('keeps Request Body JSON in interactive-demo.html editable with live validation and direct submit', () => {
    const demoHtml = readFileSync(
      resolve(__dirname, '../examples/interactive-demo.html'),
      'utf-8',
    );
    const textareaMatch = demoHtml.match(/<textarea\b[^>]*\bid=["']request-json-preview["'][^>]*>/);
    expect(textareaMatch).not.toBeNull();
    expect(textareaMatch![0]).not.toMatch(/\breadonly\b|\bdisabled\b/i);
    expect(demoHtml).not.toMatch(/<pre\b[^>]*\bid=["']request-json-preview["']/);
    expect(demoHtml).not.toContain("getElementById('request-json-preview').textContent");
    expect(demoHtml).toContain("requestPreviewEl.addEventListener('input'");
    expect(demoHtml).toContain("getElementById('btn-format-request-json')");
  });

  it('rejects unsupported trackFirst, trackUpdate, and trackOverwrite without enqueueing fake track events', async () => {
    const sent: string[] = [];
    const sdk = new AbiWebSdk().init({
      serverUrl: 'https://ingest.abi.example.com',
      projectId: 101,
      token: 'abi_tok_d7',
      storage: new MemoryStorageAdapter(),
      transport: async (_url, _headers, body) => {
        sent.push(body);
        return { status: 200, bodyText: '{"code":200}' };
      },
    });

    expect(() => sdk.trackFirst('FirstCheckout', 'device_first_001', { coupon_used: true })).toThrow(
      /unsupported in current version/i,
    );
    expect(() => sdk.trackUpdate('OrderPaid', 'ord_evt_001', { status: 'settled' })).toThrow(
      /unsupported in current version/i,
    );
    expect(() => sdk.trackOverwrite('OrderPaid', 'ord_evt_001', { status: 'refunded', amount: 0 })).toThrow(
      /unsupported in current version/i,
    );

    expect(sdk.buildPendingBatchPayload()).toBeNull();
    await sdk.flush();
    expect(sent).toHaveLength(0);
    sdk.destroy();
  });
});
