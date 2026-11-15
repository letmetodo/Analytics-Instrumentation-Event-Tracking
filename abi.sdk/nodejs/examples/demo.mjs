/**
 * @file ABI Node.js 服务端 SDK 两步式 CLI 与方法级演示程序 (`examples/demo.mjs`)
 * @description
 * 采用「第 1 步：配置参数并预览唯一一份 POST /collect/api/v1/track/batch 请求 JSON（零网络副作用） ->
 * 第 2 步：支持 --yes 或交互确认后提交并打印唯一一份网关响应 JSON」的两步式工作流。
 */

import http from 'node:http';
import readline from 'node:readline';
import { pathToFileURL } from 'node:url';
import zlib from 'node:zlib';

import {
  AbiNodeAnalytics,
  StagingConsumer,
} from '../src/index.mjs';

/** 默认演示静态公共属性 JSON 字符串 */
export const DEFAULT_SUPER_PROPS_JSON = JSON.stringify({
  $app_version: '2.5.0',
  $platform: 'NodeServer',
  service_name: 'order-service',
});

/**
 * 场景 1：触发未登录访客浏览行为事件（`$pageview`、`ProductViewed`，仅携带访客 `distinctId` 与客户端真实 `#ip`）。
 *
 * @param {AbiNodeAnalytics} sdk - ABI Node.js 服务端 SDK 实例
 */
export function triggerAnonymousBrowseDemo(sdk) {
  const distinctId = 'vis_dev_7f8e9a01';
  const clientIp = '203.0.113.42';

  sdk.track('', distinctId, '$pageview', {
    '#ip': clientIp,
    $url: 'https://store.example.com/products/bi-enterprise',
    $url_path: '/products/bi-enterprise',
    $title: 'ABI Enterprise Edition',
    $referrer: 'https://www.google.com',
  });

  sdk.track({
    distinctId,
    eventName: 'ProductViewed',
    properties: {
      '#ip': clientIp,
      product_id: 'sku_abi_ent_2026',
      product_name: 'ABI Enterprise Analytics Suite',
      category: 'SaaS',
      price: 2999.0,
    },
  });
}

/**
 * 场景 2：触发用户注册与实名登录双 ID 自动身份关联（`$signup` + `$login` 同时携带 `loginId` 与 `distinctId`，Flink 自动归并）。
 *
 * @param {AbiNodeAnalytics} sdk - ABI Node.js 服务端 SDK 实例
 */
export function triggerLoginIdentityBindDemo(sdk) {
  const loginId = 'acct_900102';
  const distinctId = 'vis_dev_7f8e9a01';

  sdk.track(loginId, distinctId, '$signup', {
    '#ip': '203.0.113.42',
    signup_channel: 'github_oauth',
  });

  sdk.track(loginId, distinctId, '$login', {
    '#ip': '203.0.113.42',
    login_method: 'sso_oidc',
    mfa_verified: true,
  });
}

/**
 * 场景 3：触发订单里程碑事件（使用对象签名 `track({ eventId })` 保障同日重试幂等），
 * 演示 `BigInt` 与超过 `2^53 - 1` 的 64 位雪花 ID 自动转字符串，以及 `#time` 自动提取为顶层毫秒时间戳并从 `properties` 剥离。
 *
 * @param {AbiNodeAnalytics} sdk - ABI Node.js 服务端 SDK 实例
 */
export function triggerOrderLifecycleDemo(sdk) {
  const loginId = 'acct_900102';
  const distinctId = 'vis_dev_7f8e9a01';
  const snowflakeOrderId = 9007199254740999n; // 原生 BigInt (> 2^53 - 1)，自动转为字符串 "9007199254740999"

  sdk.track({
    eventId: 'ord_created_20261110_8801',
    eventName: 'OrderCreated',
    loginId,
    distinctId,
    properties: {
      '#time': '2026-11-10T10:00:00.000Z',
      '#ip': '203.0.113.42',
      order_no: 'ORD-20261110-8801',
      snowflake_id: snowflakeOrderId,
      order_status: 'CREATED',
      payable_amount: 2999.0,
      item_sku_list: ['sku_abi_ent_2026', 'sku_addon_flink'],
      sub_task_ids: [1001, 9007199254741024],
    },
  });

  sdk.track({
    eventId: 'ord_paid_20261110_8801',
    eventName: 'OrderPaid',
    loginId,
    distinctId,
    properties: {
      '#ip': '203.0.113.42',
      order_no: 'ORD-20261110-8801',
      snowflake_id: snowflakeOrderId,
      order_status: 'PAID',
      payable_amount: 2549.15,
      coupon_code: 'FIRST_ORDER_50',
      discount_rate: 0.85,
      payment_channel: 'stripe_enterprise',
    },
  });

  sdk.track({
    eventId: 'ord_fulfilled_20261110_8801',
    eventName: 'OrderFulfilled',
    loginId,
    distinctId,
    properties: {
      '#ip': '203.0.113.42',
      order_no: 'ORD-20261110-8801',
      snowflake_id: snowflakeOrderId,
      order_status: 'FULFILLED',
      payable_amount: 2549.15,
      invoice_issued: true,
      fulfilled_at: new Date('2026-11-10T10:05:00.000Z'),
    },
  });
}

/**
 * 场景 4：触发全部 7 类用户画像属性变更操作（自动隔离静态与动态公共属性）：
 * `userSet`、`userSetOnce`、`userAdd`、`userAppend`、`userUniqAppend`、`userUnset` 与 `userDelete`。
 *
 * @param {AbiNodeAnalytics} sdk - ABI Node.js 服务端 SDK 实例
 */
export function triggerUserProfileDemo(sdk) {
  const loginId = 'acct_900102';
  const distinctId = 'vis_dev_7f8e9a01';

  sdk.userSet(loginId, distinctId, {
    company_name: 'Acme Analytics Corp',
    plan_tier: 'Enterprise',
    seat_count: 50,
    $city: 'Shanghai',
  });

  sdk.userSetOnce(loginId, distinctId, {
    first_utm_source: 'github_release',
    activated_at: new Date('2026-11-10T08:00:00.000Z'),
  });

  sdk.userAdd(loginId, distinctId, {
    cumulative_payment: 2549.15,
    order_count: 1,
  });

  sdk.userAppend(loginId, distinctId, {
    enabled_modules: ['event_analysis', 'funnel_analysis'],
  });

  sdk.userUniqAppend(loginId, distinctId, {
    enabled_modules: ['funnel_analysis', 'retention_analysis', 'sql_ide'],
  });

  sdk.userUnset(loginId, distinctId, 'legacy_trial_tag', 'onboarding_banner_dismissed');

  sdk.userDelete('acct_gdpr_erased_01', 'vis_gdpr_erased_01');
}

/**
 * 第 1 步：根据配置参数初始化 `StagingConsumer` 与 `AbiNodeAnalytics`，执行指定埋点场景，
 * 并返回唯一一份格式化后的 `POST /collect/api/v1/track/batch` 请求 JSON 预览（零网络请求）。
 *
 * @param {object} [config={}]
 * @param {number} [config.projectId=1]
 * @param {string} [config.projectToken='abi_tok_demo_node']
 * @param {string} [config.scenario='all'] - `'browse' | 'identity' | 'order' | 'profile' | 'all'`
 * @param {string} [config.superPropsJson=DEFAULT_SUPER_PROPS_JSON]
 * @param {boolean} [config.enableDynamicSuper=true]
 * @param {boolean} [config.dryRun=false]
 * @returns {{ previewJson: string, payload: Record<string, any>, staging: StagingConsumer, sdk: AbiNodeAnalytics }}
 */
export function buildDemoRequestPreview(config = {}) {
  const projectId = Number(config.projectId ?? 1);
  const projectToken = String(config.projectToken ?? 'abi_tok_demo_node').trim();
  const scenario = String(config.scenario ?? 'all').trim().toLowerCase() || 'all';
  const superPropsJson =
    config.superPropsJson !== undefined ? String(config.superPropsJson).trim() : DEFAULT_SUPER_PROPS_JSON;
  const enableDynamicSuper =
    config.enableDynamicSuper !== undefined ? Boolean(config.enableDynamicSuper) : true;
  const dryRun = Boolean(config.dryRun);

  if (!Number.isFinite(projectId) || projectId <= 0) {
    throw new Error(`project-id must be > 0 (got ${projectId})`);
  }
  if (!projectToken) {
    throw new Error('token must not be empty');
  }

  const staging = new StagingConsumer({
    projectId,
    projectToken,
    dryRun,
  });
  const sdk = new AbiNodeAnalytics(staging);

  if (superPropsJson) {
    const parsedSuper = JSON.parse(superPropsJson);
    if (!parsedSuper || typeof parsedSuper !== 'object' || Array.isArray(parsedSuper)) {
      throw new Error('--super-props must be a JSON object');
    }
    if (Object.keys(parsedSuper).length > 0) {
      sdk.setSuperProperties(parsedSuper);
    }
  }

  if (enableDynamicSuper) {
    sdk.setDynamicSuperProperties(() => ({
      server_region: 'ap-shanghai',
      node_version: process.version,
    }));
  }

  switch (scenario) {
    case 'browse':
      triggerAnonymousBrowseDemo(sdk);
      break;
    case 'identity':
      triggerLoginIdentityBindDemo(sdk);
      break;
    case 'order':
      triggerOrderLifecycleDemo(sdk);
      break;
    case 'profile':
      triggerUserProfileDemo(sdk);
      break;
    case 'all':
      triggerAnonymousBrowseDemo(sdk);
      triggerLoginIdentityBindDemo(sdk);
      triggerOrderLifecycleDemo(sdk);
      triggerUserProfileDemo(sdk);
      break;
    default:
      throw new Error(
        `Unknown --scenario "${scenario}" (expected browse | identity | order | profile | all)`,
      );
  }

  const previewJson = staging.previewRequestJson();
  const payload = staging.buildRequestPayload();
  return { previewJson, payload, staging, sdk };
}

/**
 * 启动本地随机端口的内置静默 Mock 采集网关（支持 `Content-Encoding: gzip` 解压与标准信封回执）。
 *
 * @returns {Promise<{ baseUrl: string, close: () => Promise<void> }>}
 */
export function startEmbeddedMockGateway() {
  return new Promise((resolve, reject) => {
    let seq = 0;
    const server = http.createServer((req, res) => {
      if (req.method !== 'POST' || !req.url?.startsWith('/collect/api/v1/track/batch')) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 404, message: 'not found' }));
        return;
      }

      const chunks = [];
      req.on('data', (chunk) => chunks.push(chunk));
      req.on('end', () => {
        try {
          const rawBuf = Buffer.concat(chunks);
          const decodedBuf =
            req.headers['content-encoding'] === 'gzip'
              ? zlib.gunzipSync(rawBuf)
              : rawBuf;
          const body = JSON.parse(decodedBuf.toString('utf8'));
          seq += 1;
          const envelope = {
            code: 200,
            message: 'success',
            request_id: `req_mock_node_${seq}`,
            data: {
              accepted: Array.isArray(body.events) ? body.events.length : 0,
              rejected: 0,
              dry_run: Boolean(body.dry_run),
            },
          };
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(envelope));
        } catch (err) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ code: 400, message: err.message }));
        }
      });
    });

    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      resolve({
        baseUrl: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise((resClose) => {
            server.close(() => resClose());
          }),
      });
    });
  });
}

/**
 * 第 2 步：在确认请求 JSON 无误后提交 `StagingConsumer` 中暂存的批量请求，
 * 并返回网关响应信封对象与格式化后的单份响应 JSON 字符串。
 *
 * @param {StagingConsumer} staging - 已暂存事件的 StagingConsumer
 * @param {object} [config={}]
 * @param {string} [config.serverUrl=''] - 网关地址（为空时自动启动内置本地 Mock 网关）
 * @param {number} [config.projectId=1]
 * @param {string} [config.projectToken='abi_tok_demo_node']
 * @param {boolean} [config.compressGzip=true]
 * @returns {Promise<{ envelope: Record<string, any>, responseJson: string }>}
 */
export async function confirmSubmitDemo(staging, config = {}) {
  if (!staging || typeof staging.submitToGateway !== 'function') {
    throw new Error('valid StagingConsumer instance is required');
  }

  let targetUrl = String(config.serverUrl ?? '').trim();
  let mockGateway = null;

  if (!targetUrl) {
    mockGateway = await startEmbeddedMockGateway();
    targetUrl = mockGateway.baseUrl;
  }

  try {
    const envelope = await staging.submitToGateway({
      serverUrl: targetUrl,
      projectId: config.projectId,
      projectToken: config.projectToken,
      compressGzip: config.compressGzip !== undefined ? Boolean(config.compressGzip) : true,
    });
    const responseJson = JSON.stringify(envelope, null, 2);
    return { envelope, responseJson };
  } finally {
    if (mockGateway) {
      await mockGateway.close();
    }
  }
}

/**
 * 解析命令行参数。
 *
 * @param {string[]} argv
 * @returns {Record<string, any>}
 */
export function parseCliArgs(argv) {
  const out = {
    serverUrl: '',
    projectId: 1,
    projectToken: 'abi_tok_demo_node',
    scenario: 'all',
    superPropsJson: DEFAULT_SUPER_PROPS_JSON,
    enableDynamicSuper: true,
    dryRun: false,
    yes: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    const [key, inlineVal] = arg.includes('=') ? arg.split(/=(.*)/s) : [arg, undefined];
    const nextVal = () => {
      if (inlineVal !== undefined) return inlineVal;
      i += 1;
      return argv[i] ?? '';
    };

    switch (key) {
      case '--server-url':
        out.serverUrl = nextVal();
        break;
      case '--project-id':
        out.projectId = Number(nextVal());
        break;
      case '--token':
        out.projectToken = nextVal();
        break;
      case '--scenario':
        out.scenario = nextVal();
        break;
      case '--super-props':
        out.superPropsJson = nextVal();
        break;
      case '--dynamic-super':
        out.enableDynamicSuper = inlineVal !== undefined ? inlineVal !== 'false' : true;
        break;
      case '--no-dynamic-super':
        out.enableDynamicSuper = false;
        break;
      case '--dry-run':
        out.dryRun = inlineVal !== undefined ? inlineVal !== 'false' : true;
        break;
      case '--yes':
      case '-y':
        out.yes = true;
        break;
      default:
        break;
    }
  }
  return out;
}

/**
 * 在交互式终端询问用户是否确认提交。
 *
 * @param {string} question
 * @returns {Promise<boolean>}
 */
function askTerminalConfirmation(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim().toLowerCase() === 'y');
    });
  });
}

async function runCli() {
  const cfg = parseCliArgs(process.argv.slice(2));

  // 第 1 步：生成并打印唯一一份 POST /collect/api/v1/track/batch 待提交请求 JSON 预览
  const { previewJson, staging } = buildDemoRequestPreview(cfg);
  process.stdout.write('=== 待提交请求 JSON 预览 (POST /collect/api/v1/track/batch) ===\n');
  process.stdout.write(`${previewJson}\n`);

  // 第 2 步：若未传 --yes 且处于交互式 TTY，则询问确认；否则直接自动确认提交
  if (!cfg.yes && Boolean(process.stdin.isTTY)) {
    const confirmed = await askTerminalConfirmation(
      '\n是否确认提交上述请求参数？输入 y 回车确认提交，其他键取消: ',
    );
    if (!confirmed) {
      process.stdout.write('已取消提交，未向采集网关发送任何请求。\n');
      return;
    }
  }

  const { responseJson } = await confirmSubmitDemo(staging, cfg);
  process.stdout.write('\n=== 提交响应结果 (Response JSON) ===\n');
  process.stdout.write(`${responseJson}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((err) => {
    process.stderr.write(`[错误] ${err.message}\n`);
    process.exit(1);
  });
}
