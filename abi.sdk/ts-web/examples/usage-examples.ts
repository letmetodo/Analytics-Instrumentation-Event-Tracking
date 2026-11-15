import {
  AbiWebSdk,
  MemoryStorageAdapter,
  type AbiTransportFn,
  type TrackEventDTO,
} from '../src/index';
import {
  createMiniProgramAdapter,
  type MiniProgramApiLike,
} from '../src/adapters/miniapp';
import { createReactNativeAdapter } from '../src/adapters/react-native';

export type MiniProgramGlobalLike = MiniProgramApiLike;

/**
 * 采集批次捕获结构（用于本地调试与单元测试断言）。
 */
export interface CapturedBatchPayload {
  url: string;
  headers: Record<string, string>;
  project_id: number;
  project_token: string;
  debug?: boolean;
  dry_run?: boolean;
  events: TrackEventDTO[];
}

/**
 * 示例运行返回结果，包含所有上报批次、扁平化事件列表及最终身份标识快照。
 */
export interface ExampleRunResult {
  batches: CapturedBatchPayload[];
  events: TrackEventDTO[];
  distinctId: string;
  loginId: string;
}

/**
 * Web 单页应用（SPA）电商全链路埋点接入示例，完整演示：
 * 1. SDK 初始化与自定义访客设备标识（`identify` -> `distinct_id`）
 * 2. 静态公共属性与动态公共属性回调（`setSuperProperties`、`setDynamicSuperProperties`）
 * 3. 未登录访客商品浏览行为事件上报（`ProductView`）
 * 4. 账号登录（`login('user_10086')` -> 纯本地设置 `login_id`，保留访客 `distinct_id` 不变，不发送额外网络事件）
 * 5. 基于单调时钟的事件耗时统计（`timeEvent('OrderPaid')` -> 自动计算秒级 `$duration`）
 * 6. 发起结算事件与同日固定 `eventId` 幂等去重上报（`track('CheckoutStarted', ..., { eventId })`）
 * 7. 64 位雪花算法订单 ID 无损上报（`track('OrderPaid', { order_id: 9007199254740993n, ... })`）
 * 8. 独立订单履约里程碑事件上报（`OrderSettled`）
 * 9. 用户画像属性全生命周期变更（`userSet`、`userSetOnce`、`userAdd`、`userAppend`、`userUniqAppend`、`userUnset`、`userDelete`）
 *
 * @param transport 可选的自定义网络传输函数（不传时默认本地拦截并返回 200 OK）
 * @returns 包含所有捕获批次、事件明细与当前用户标识的运行结果
 *
 * @example
 * ```ts
 * const result = await runWebSpaEcommerceExample();
 * console.log('访客标识:', result.distinctId, '账号标识:', result.loginId, '上报事件总数:', result.events.length);
 * ```
 */
export async function runWebSpaEcommerceExample(
  transport?: AbiTransportFn,
): Promise<ExampleRunResult> {
  const batches: CapturedBatchPayload[] = [];
  let cartItemCount = 2;

  const wrappedTransport: AbiTransportFn = async (url, headers, body) => {
    const parsed = JSON.parse(body) as Omit<CapturedBatchPayload, 'url' | 'headers'>;
    batches.push({
      url,
      headers,
      ...parsed,
    });
    if (transport) {
      return transport(url, headers, body);
    }
    return {
      status: 200,
      bodyText: JSON.stringify({ code: 200, message: 'ok', data: { accepted: parsed.events.length } }),
    };
  };

  const sdk = new AbiWebSdk().init({
    serverUrl: 'https://ingest.abi.example.com',
    projectId: 101,
    token: 'abi_proj_token_web_ecommerce_demo',
    appVersion: '3.4.0',
    maxBatchSize: 50,
    flushIntervalMs: 60_000,
    storage: new MemoryStorageAdapter(),
    transport: wrappedTransport,
  });

  // 1. 用户登录前设置自定义访客标识 (distinct_id)
  sdk.identify('visitor_web_001');

  // 2. 注册静态公共属性（投放渠道/AB 实验分组）与动态公共属性（实时购物车商品数）
  sdk.setSuperProperties({
    channel: 'seo_landing',
    ab_group: 'checkout_one_step_v2',
  });
  sdk.setDynamicSuperProperties(() => ({
    cart_items: cartItemCount,
  }));

  // 3. 上报未登录访客商品详情浏览事件（仅携带 distinct_id）
  sdk.track('ProductView', {
    sku_id: 'sku_1',
    product_name: 'ABI Mechanical Keyboard Pro',
    price: 149.75,
  });

  // 4. 用户登录账号 -> 本地设置 login_id，保留 distinct_id 不变，后续事件同时携带 distinct_id 与 login_id
  sdk.login('user_10086');

  // 5. 启动支付耗时计时器，并以确定性 eventId 记录发起结算事件（同日网络重试幂等）
  sdk.timeEvent('OrderPaid');
  sdk.track(
    'CheckoutStarted',
    {
      entry_scene: 'cart_drawer',
    },
    {
      eventId: 'evt_checkout_visitor_web_001',
    },
  );

  // 6. 完成订单支付：传入超过 IEEE-754 MAX_SAFE_INTEGER 的 64 位雪花 BigInt 订单号（自动转为字符串防精度丢失）
  cartItemCount = 0;
  sdk.track(
    'OrderPaid',
    {
      order_id: 9007199254740993n,
      amount: 299.5,
      items: ['sku_1', 2, true],
      payment_Time: new Date('2026-11-10T02:00:00.000Z'),
    },
    {
      eventId: 'evt_order_paid_2026_001',
    },
  );

  // 7. 履约结算状态推进使用独立里程碑事件上报（避免同 event_id 覆盖原事件属性）
  sdk.track(
    'OrderSettled',
    {
      order_id: 9007199254740993n,
      amount: 279.5,
      discount_applied: 20,
      status: 'settled',
    },
    {
      eventId: 'evt_order_settled_2026_001',
    },
  );

  // 8. 用户画像属性全套变更操作（$user_set / $user_set_once / $user_add / $user_append / $user_uniq_append / $user_unset / $user_del）
  sdk.userSet({
    vip_level: 'gold',
    city: 'Shanghai',
  });
  sdk.userSetOnce({
    first_order_date: '2026-11-10',
  });
  sdk.userAdd({
    loyalty_points: 300,
    total_orders: 1,
  });
  sdk.userAppend({
    purchased_skus: ['sku_1'],
  });
  sdk.userUniqAppend({
    badges: ['first_buyer', 'keyboard_enthusiast'],
  });
  sdk.userUnset('city');
  sdk.userDelete();

  // 9. 立即刷新队列并采集最终状态快照
  await sdk.flush();

  const distinctId = sdk.getDistinctId();
  const loginId = sdk.getLoginId();
  sdk.destroy();

  return {
    batches,
    events: batches.flatMap((b) => b.events),
    distinctId,
    loginId,
  };
}

/**
 * 微信小程序（兼容原生 `wx`、`uni-app`、`Taro`）接入示例：
 * 使用 `createMiniProgramAdapter` 自动桥接小程序同步存储（`getStorageSync`/`setStorageSync`）、
 * 网络请求（`wx.request`）以及设备系统预置属性（`$lib: 'abi-mp-sdk'`、`$os`、`$device_model` 等）。
 *
 * @param wxMock 可选的小程序全局对象实例（真实小程序环境直接传入 `wx`）
 * @returns 包含所有捕获批次、事件明细与当前用户标识的运行结果
 *
 * @example
 * ```ts
 * // 在微信小程序 app.ts 中初始化：
 * // const mpAdapter = createMiniProgramAdapter(wx);
 * const res = await runWeChatMiniProgramExample();
 * console.log('小程序绑定 OpenID:', res.loginId);
 * ```
 */
export async function runWeChatMiniProgramExample(
  wxMock?: MiniProgramGlobalLike,
): Promise<ExampleRunResult> {
  const storageMap = new Map<string, string>();
  const batches: CapturedBatchPayload[] = [];

  // 默认内置的小程序宿主环境模拟实现（在 Node/Vitest 下可直接无依赖运行）
  const defaultWx: MiniProgramGlobalLike = {
    getStorageSync(key: string) {
      return storageMap.get(key) ?? '';
    },
    setStorageSync(key: string, data: string) {
      storageMap.set(key, data);
    },
    removeStorageSync(key: string) {
      storageMap.delete(key);
    },
    getSystemInfoSync() {
      return {
        platform: 'ios',
        system: 'iOS 17.5',
        model: 'iPhone 15 Pro Max',
        screenWidth: 430,
        screenHeight: 932,
        version: '8.0.50',
      };
    },
    request({ url, header, data, success }) {
      const parsed = JSON.parse(data) as Omit<CapturedBatchPayload, 'url' | 'headers'>;
      batches.push({
        url,
        headers: header,
        ...parsed,
      });
      success({
        statusCode: 200,
        data: { code: 200, message: 'ok', data: { accepted: parsed.events.length } },
      });
    },
  };

  const targetWx: MiniProgramGlobalLike = wxMock
    ? {
        ...wxMock,
        request(options) {
          const parsed = JSON.parse(options.data) as Omit<CapturedBatchPayload, 'url' | 'headers'>;
          batches.push({
            url: options.url,
            headers: options.header,
            ...parsed,
          });
          wxMock.request(options);
        },
      }
    : defaultWx;

  // 1. 创建微信小程序平台适配器并注入 SDK 初始化配置
  const mpAdapter = createMiniProgramAdapter(targetWx);
  const sdk = new AbiWebSdk().init({
    serverUrl: 'https://ingest.abi.example.com',
    projectId: 102,
    token: 'abi_proj_token_wx_miniapp',
    appVersion: '2.1.0',
    maxBatchSize: 20,
    flushIntervalMs: 60_000,
    ...mpAdapter,
  });

  // 2. 设置小程序场景值（如 1089 最近使用）与版本环境公共属性
  sdk.setSuperProperties({
    mp_scene: 1089,
    miniapp_env: 'release',
  });

  // 3. 上报小程序启动、OpenID 登录设置、转发分享（含 64 位活动 ID）及微信绑定画像
  sdk.track('$AppStart', { path: 'pages/home/index' });
  sdk.login('wx_openid_u_8801');
  sdk.track('ShareMiniProgram', {
    share_target: 'moments',
    campaign_id: 9007199254740999n,
  });
  sdk.userSet({ wechat_bound: true });

  await sdk.flush();

  const distinctId = sdk.getDistinctId();
  const loginId = sdk.getLoginId();
  sdk.destroy();

  return {
    batches,
    events: batches.flatMap((b) => b.events),
    distinctId,
    loginId,
  };
}

/**
 * React Native 移动应用接入示例：
 * 使用 `createReactNativeAdapter` 注入移动端操作系统、机型、屏幕尺寸预置属性（`$lib: 'abi-rn-sdk'`）
 * 与同步存储适配器（生产环境可传入基于 `react-native-mmkv` 实现的 `AbiStorageAdapter`）。
 *
 * @param transport 可选的自定义网络传输函数
 * @returns 包含所有捕获批次、事件明细与当前用户标识的运行结果
 *
 * @example
 * ```ts
 * const res = await runReactNativeExample();
 * console.log('RN 设备型号:', res.events[0].properties.$device_model);
 * ```
 */
export async function runReactNativeExample(
  transport?: AbiTransportFn,
): Promise<ExampleRunResult> {
  const batches: CapturedBatchPayload[] = [];

  const wrappedTransport: AbiTransportFn = async (url, headers, body) => {
    const parsed = JSON.parse(body) as Omit<CapturedBatchPayload, 'url' | 'headers'>;
    batches.push({
      url,
      headers,
      ...parsed,
    });
    if (transport) {
      return transport(url, headers, body);
    }
    return {
      status: 200,
      bodyText: JSON.stringify({ code: 200, message: 'ok', data: { accepted: parsed.events.length } }),
    };
  };

  // 1. 构建 React Native 环境预置属性与同步存储适配器
  const rnAdapter = createReactNativeAdapter({
    os: 'android',
    osVersion: '14',
    deviceModel: 'Pixel 8 Pro',
    appVersion: '4.0.2',
    screenWidth: 412,
    screenHeight: 915,
    syncStorage: new MemoryStorageAdapter(),
  });

  // 2. 初始化 SDK 实例
  const sdk = new AbiWebSdk().init({
    serverUrl: 'https://ingest.abi.example.com',
    projectId: 103,
    token: 'abi_proj_token_rn_mobile',
    maxBatchSize: 20,
    flushIntervalMs: 60_000,
    transport: wrappedTransport,
    ...rnAdapter,
  });

  // 3. 设置设备访客标识、登录账号、统计视频播放时长并更新用户画像
  sdk.identify('rn_device_uuid_7788');
  sdk.login('rn_user_5566');
  sdk.timeEvent('VideoPlayback');
  sdk.track('VideoPlayback', {
    video_id: 'vid_onboarding_4k',
    resolution: '2160p',
  });
  sdk.userSetOnce({ first_install_os: 'android_14' });
  sdk.userAdd({ watch_count: 1 });

  await sdk.flush();

  const distinctId = sdk.getDistinctId();
  const loginId = sdk.getLoginId();
  sdk.destroy();

  return {
    batches,
    events: batches.flatMap((b) => b.events),
    distinctId,
    loginId,
  };
}

/**
 * 「1. 配置参数并预览单份请求 JSON -> 2. 用户确认后提交」两阶段调用示例（适用于自定义联调面板或无界面方法演练）：
 * - 第一阶段：配置身份、静态/动态公共属性并入队待发事件，通过 `sdk.buildPendingBatchPayload()` 获取将发送至
 *   `POST /collect/api/v1/track/batch` 的唯一一份请求报文 JSON，期间不会产生冗余日志或自动循环请求；
 * - 第二阶段：当用户确认提交（`confirmSubmit = true`）时调用 `await sdk.flush()` 真正发送报文并返回网关结果。
 */
export async function previewAndConfirmWebSdkExample(options?: {
  confirmSubmit?: boolean;
  dryRun?: boolean;
  transport?: AbiTransportFn;
}): Promise<{
  requestPreviewJson: string;
  submitted: boolean;
  batches: CapturedBatchPayload[];
}> {
  const batches: CapturedBatchPayload[] = [];
  const wrappedTransport: AbiTransportFn = async (url, headers, body) => {
    const parsed = JSON.parse(body) as Omit<CapturedBatchPayload, 'url' | 'headers'>;
    batches.push({ url, headers, ...parsed });
    if (options?.transport) {
      return options.transport(url, headers, body);
    }
    return {
      status: 200,
      bodyText: JSON.stringify({ code: 200, message: 'ok', data: { accepted: parsed.events.length } }),
    };
  };

  const sdk = new AbiWebSdk().init({
    serverUrl: 'https://ingest.abi.example.com',
    projectId: 101,
    token: 'abi_proj_token_preview_confirm',
    dryRun: options?.dryRun ?? true,
    maxBatchSize: 50,
    flushIntervalMs: 3_600_000,
    storage: new MemoryStorageAdapter(),
    transport: wrappedTransport,
  });

  // 1. 配置参数与待发事件，仅生成一份确定的请求报文 JSON 预览
  sdk.identify('visitor_preview_001');
  sdk.setSuperProperties({ channel: 'web_official', ab_group: 'checkout_v2' });
  sdk.clearQueue();
  sdk.track('OrderPaid', {
    order_id: 9007199254740993n,
    amount: 199.0,
    currency: 'CNY',
  });

  const pendingPayload = sdk.buildPendingBatchPayload();
  const requestPreviewJson = JSON.stringify(pendingPayload, null, 2);

  // 2. 仅当用户显式确认提交时才触发网络发送
  let submitted = false;
  if (options?.confirmSubmit) {
    submitted = await sdk.flush();
  }

  sdk.destroy();
  return {
    requestPreviewJson,
    submitted,
    batches,
  };
}
