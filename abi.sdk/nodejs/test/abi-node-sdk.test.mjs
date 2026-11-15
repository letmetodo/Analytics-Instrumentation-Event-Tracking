/**
 * @file ABI Node.js 服务端 SDK (`@anylink/abi-node-sdk`) 单元测试套件
 * @description
 * 使用 Node.js 标准库 `node:test` 与 `node:assert/strict` 验证：
 * 1. `abi.sdk/spec/test-vectors/identity_cases.json` 与 `event_and_property_cases.json` 跨语言黄金测试向量 100% 通过；
 * 2. 服务端无状态多用户 `AbiNodeAnalytics`（对象签名与便捷位置签名、静态/动态公共属性与 `$user_*` 隔离、
 *    双 ID `distinct_id` + `login_id` 零回填契约、`trackFirst`、`trackUpdate`、`trackOverwrite`、7 类用户画像方法）；
 * 3. `BigInt` 与 `> 2^53 - 1` 超大整数自动转字符串、`#time` / `$time` 时间提取与剥离、`#ip` / `$ip` 透传；
 * 4. 四大 Consumer（`StagingConsumer`、`BatchConsumer`、`LoggerConsumer`、`DebugConsumer`）及两步式 CLI Demo。
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

import {
  AbiNodeAnalytics,
  BatchConsumer,
  DebugConsumer,
  LoggerConsumer,
  MAX_SAFE_INT,
  RotateMode,
  StagingConsumer,
  normalizeIdentity,
  normalizeIdentityField,
  normalizeProperties,
  validateEventName,
  validatePropertyKey,
} from '../src/index.mjs';
import {
  buildDemoRequestPreview,
  confirmSubmitDemo,
} from '../examples/demo.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SPEC_DIR = path.resolve(__dirname, '../../spec/test-vectors');

test('1. 黄金测试向量：100% 通过 identity_cases.json 身份规范化与 UTF-8 字节边界契约（且 login_id 绝不回填 distinct_id）', () => {
  const raw = fs.readFileSync(path.join(SPEC_DIR, 'identity_cases.json'), 'utf8');
  const spec = JSON.parse(raw);

  assert.equal(spec.max_distinct_id_bytes, 64);
  assert.equal(spec.max_login_id_bytes, 128);

  for (const tc of spec.cases) {
    let gotValid = false;
    let normDistinct = '';
    let normLogin = '';

    try {
      normDistinct = normalizeIdentityField(
        tc.distinct_id,
        spec.max_distinct_id_bytes,
        'distinct_id',
        true,
      );
      normLogin = normalizeIdentityField(
        tc.login_id,
        spec.max_login_id_bytes,
        'login_id',
        true,
      );
      gotValid = Boolean(normDistinct || normLogin);
    } catch {
      gotValid = false;
    }

    assert.equal(
      gotValid,
      tc.valid,
      `identity case "${tc.name}" expected valid=${tc.valid}, got ${gotValid}`,
    );

    if (tc.valid) {
      assert.equal(normDistinct, tc.normalized_distinct_id, `case "${tc.name}" distinct_id mismatch`);
      assert.equal(normLogin, tc.normalized_login_id, `case "${tc.name}" login_id mismatch`);

      const combined = normalizeIdentity(tc.distinct_id, tc.login_id);
      assert.equal(combined.distinctId, tc.normalized_distinct_id);
      assert.equal(combined.loginId, tc.normalized_login_id);
      assert.equal(combined.distinct_id, tc.normalized_distinct_id);
      assert.equal(combined.login_id, tc.normalized_login_id);
    } else {
      assert.throws(
        () => normalizeIdentity(tc.distinct_id, tc.login_id),
        `case "${tc.name}" should throw in normalizeIdentity`,
      );
    }
  }

  // 验证 100 字节 loginId + 空 distinctId 直接上报 distinct_id: ""，绝不回填 login_id 到 distinct_id
  const staging = new StagingConsumer({ projectId: 1, projectToken: 'tok_id' });
  const sdk = new AbiNodeAnalytics(staging);
  const longLoginId = 'u'.repeat(100);
  sdk.track(longLoginId, '', 'BackendCronJob', { ok: true });
  const [evt] = staging.getEvents();
  assert.equal(evt.distinct_id, '');
  assert.equal(evt.login_id, longLoginId);
  assert.deepEqual(Object.keys(evt).sort(), [
    'distinct_id',
    'event_id',
    'event_name',
    'login_id',
    'properties',
    'timestamp',
  ]);
});

test('2. 黄金测试向量：100% 通过 event_and_property_cases.json 事件名、属性键与安全整数契约', () => {
  const raw = fs.readFileSync(path.join(SPEC_DIR, 'event_and_property_cases.json'), 'utf8');
  const spec = JSON.parse(raw);

  assert.equal(spec.max_safe_integer, MAX_SAFE_INT);

  for (const tc of spec.event_name_cases) {
    if (tc.valid) {
      assert.equal(validateEventName(tc.event_name), tc.event_name);
    } else {
      assert.throws(
        () => validateEventName(tc.event_name),
        `event_name "${tc.event_name}" should be rejected`,
      );
    }
  }

  for (const tc of spec.property_key_cases) {
    if (tc.valid) {
      assert.equal(validatePropertyKey(tc.key), tc.key);
    } else {
      assert.throws(
        () => validatePropertyKey(tc.key),
        `property key "${tc.key}" should be rejected`,
      );
    }
  }
});

test('3. BigInt 与超过 2^53 - 1 的 64 位整数（含数组元素）自动转字符串，且保留 #ip / $ip 透传', () => {
  const normalized = normalizeProperties({
    safe_positive: 9007199254740991,
    safe_negative: -9007199254740991,
    unsafe_positive: 9007199254740992,
    unsafe_negative: -9007199254740996,
    native_bigint: 9007199254740993n,
    small_bigint: 42n,
    mixed_array: [100, 9007199254741024, 9007199254742048n, 'sku_1', true],
    '#ip': '203.0.113.88',
    $ip: '198.51.100.12',
    ignored_null: null,
    ignored_undef: undefined,
  });

  assert.equal(normalized.safe_positive, 9007199254740991);
  assert.equal(normalized.safe_negative, -9007199254740991);
  assert.equal(normalized.unsafe_positive, '9007199254740992');
  assert.equal(normalized.unsafe_negative, '-9007199254740996');
  assert.equal(normalized.native_bigint, '9007199254740993');
  assert.equal(normalized.small_bigint, '42');
  assert.deepEqual(normalized.mixed_array, [
    100,
    '9007199254741024',
    '9007199254742048',
    'sku_1',
    true,
  ]);
  assert.equal(normalized['#ip'], '203.0.113.88');
  assert.equal(normalized.$ip, '198.51.100.12');
  assert.equal('ignored_null' in normalized, false);
  assert.equal('ignored_undef' in normalized, false);
});

test('4. #time / $time 自动提取为顶层毫秒级 timestamp 并从 properties 剥离（不修改调用方入参对象）', () => {
  const staging = new StagingConsumer({ projectId: 1, projectToken: 'tok_time' });
  const sdk = new AbiNodeAnalytics(staging);

  const callerProps = {
    '#time': new Date('2026-11-10T09:15:30.123Z'),
    '#ip': '203.0.113.42',
    amount: 88.5,
  };
  sdk.track('u_1001', 'vis_001', 'OrderPaid', callerProps);
  assert.equal('#time' in callerProps, true, '不应修改调用方原始 properties 对象');

  sdk.userSet('u_1001', 'vis_001', {
    $time: 1762746407, // 秒级时间戳 -> 自动 * 1000
    vip_level: 5,
  });

  sdk.userAdd('u_1001', 'vis_001', {
    '#time': 1762746407890, // 毫秒级时间戳
    total_orders: 1,
  });

  sdk.track({
    loginId: 'u_1001',
    distinctId: 'vis_001',
    eventName: 'BackfillEvent',
    timestamp: new Date('2026-11-09T00:00:00.000Z'), // 显式 timestamp 优先于 #time
    properties: {
      '#time': '2026-11-10 14:30:00.125',
      source: 'mq_replay',
    },
  });

  const events = staging.getEvents();
  assert.equal(events.length, 4);
  assert.equal(events[0].timestamp, Date.parse('2026-11-10T09:15:30.123Z'));
  assert.equal(events[0].properties['#ip'], '203.0.113.42');
  assert.equal(events[1].timestamp, 1762746407 * 1000);
  assert.equal(events[2].timestamp, 1762746407890);
  assert.equal(events[3].timestamp, Date.parse('2026-11-09T00:00:00.000Z'));

  for (const evt of events) {
    assert.equal('#time' in evt.properties, false);
    assert.equal('$time' in evt.properties, false);
  }

  // 非法 #time / $time 必须抛出异常
  assert.throws(() => sdk.track('u_1001', 'anon_001', 'OrderPaid', { '#time': 'invalid-date' }));
  assert.throws(() => sdk.track('u_1001', 'anon_001', 'OrderPaid', { '#time': 0 }));
  assert.throws(() => sdk.track('u_1001', 'anon_001', 'OrderPaid', { '$time': '   ' }));
});

test('5. 公共属性管理（静态/动态覆盖优先级）与 $user_* / #user_* 画像事件严格隔离 + 7 类画像操作', () => {
  const staging = new StagingConsumer({ projectId: 2, projectToken: 'tok_profile' });
  const sdk = new AbiNodeAnalytics(staging);

  sdk.setSuperProperties({
    static_only: 's_val',
    override_by_dyn: 'from_static',
    override_by_evt: 'from_static',
    to_be_unset: 'temp',
  });

  const superSnap = sdk.getSuperProperties();
  superSnap.static_only = 'mutated_outside';
  assert.equal(sdk.getSuperProperties().static_only, 's_val');

  sdk.unsetSuperProperty('to_be_unset');
  assert.equal('to_be_unset' in sdk.getSuperProperties(), false);

  let dynCalls = 0;
  sdk.setDynamicSuperProperties(() => {
    dynCalls += 1;
    return {
      dyn_seq: dynCalls,
      override_by_dyn: 'from_dynamic',
      override_by_evt: 'from_dynamic',
      dyn_bigint: 9007199254740999n,
    };
  });

  sdk.track('u_200', 'anon_200', 'AddToCart', {
    override_by_evt: 'from_event',
    sku_id: 'sku_99',
  });

  const callsBeforeProfile = dynCalls;
  sdk.userSet('u_200', 'anon_200', { vip_level: 'gold' });
  sdk.userSetOnce('u_200', 'anon_200', { first_channel: 'sem' });
  sdk.userAdd('u_200', 'anon_200', { points: 100 });
  sdk.userAppend('u_200', 'anon_200', { tags: ['a', 'b'] });
  sdk.userUniqAppend('u_200', 'anon_200', { tags: ['b', 'c'] });
  sdk.userUnset('u_200', 'anon_200', 'legacy_field', 'temp_tag');
  sdk.userDelete('u_200', 'anon_200');

  assert.equal(dynCalls, callsBeforeProfile, '画像事件不得触发动态公共属性回调');

  const events = staging.getEvents();
  assert.equal(events.length, 8);

  const trackProps = events[0].properties;
  assert.equal(trackProps.static_only, 's_val');
  assert.equal(trackProps.override_by_dyn, 'from_dynamic');
  assert.equal(trackProps.override_by_evt, 'from_event');
  assert.equal(trackProps.dyn_bigint, '9007199254740999');

  const expectedUserEvents = [
    '$user_set',
    '$user_set_once',
    '$user_add',
    '$user_append',
    '$user_uniq_append',
    '$user_unset',
    '$user_del',
  ];
  for (let i = 0; i < expectedUserEvents.length; i += 1) {
    const uEvt = events[i + 1];
    assert.equal(uEvt.event_name, expectedUserEvents[i]);
    assert.equal('static_only' in uEvt.properties, false);
    assert.equal('dyn_seq' in uEvt.properties, false);
  }

  assert.deepEqual(events[6].properties, { legacy_field: '', temp_tag: '' });
  assert.deepEqual(events[7].properties, {});

  // 验证 clearSuperProperties 及 userAdd 非数值拦截
  sdk.clearSuperProperties();
  assert.deepEqual(sdk.getSuperProperties(), {});
  assert.throws(() => sdk.userAdd('u_200', 'anon_200', { bad_metric: 'not_a_number' }));
});

test('6. StagingConsumer 两步式预览（previewRequestJson / buildRequestPayload / clear / confirmSubmit）与特殊事件', async () => {
  const receivedBatches = [];
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks);
      const body =
        req.headers['content-encoding'] === 'gzip'
          ? JSON.parse(zlib.gunzipSync(raw).toString('utf8'))
          : JSON.parse(raw.toString('utf8'));
      receivedBatches.push(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          code: 200,
          message: 'success',
          request_id: 'req_stage_ok',
          data: { accepted: body.events.length, rejected: 0, dry_run: Boolean(body.dry_run) },
        }),
      );
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const serverUrl = `http://127.0.0.1:${port}`;

  try {
    const staging = new StagingConsumer({
      projectId: 9,
      projectToken: 'abi_tok_stage',
      dryRun: true,
    });
    const sdk = new AbiNodeAnalytics(staging);

    sdk.track('acct_1', 'vis_1', '$login', { login_method: 'sso' });
    sdk.track('acct_1', 'vis_1', 'OrderPaid', { status: 'PAID' }, { eventId: 'evt_ord_1' });

    assert.throws(
      () => sdk.trackFirst('acct_1', 'vis_1', 'DeviceActivation', 'chk_001', { channel: 'ios' }),
      /trackFirst is unsupported in current version/,
    );
    assert.throws(
      () => sdk.trackUpdate('acct_1', 'vis_1', 'OrderState', 'evt_ord_1', { status: 'PAID' }),
      /trackUpdate is unsupported in current version/,
    );
    assert.throws(
      () => sdk.trackOverwrite('acct_1', 'vis_1', 'OrderState', 'evt_ord_1', { status: 'DONE' }),
      /trackOverwrite is unsupported in current version/,
    );

    await sdk.flush();
    await sdk.close();
    assert.equal(receivedBatches.length, 0, '确认提交前不应发起任何 HTTP 请求');

    const previewJson = staging.previewRequestJson();
    const payload = JSON.parse(previewJson);
    assert.equal(payload.project_id, 9);
    assert.equal(payload.project_token, 'abi_tok_stage');
    assert.equal(payload.dry_run, true);
    assert.equal(payload.events.length, 2);
    assert.equal(payload.events[0].event_name, '$login');
    assert.equal(payload.events[0].distinct_id, 'vis_1');
    assert.equal(payload.events[0].login_id, 'acct_1');
    assert.equal(payload.events[1].event_name, 'OrderPaid');
    assert.equal(payload.events[1].event_id, 'evt_ord_1');

    const batchTarget = new BatchConsumer({
      serverUrl,
      projectId: 9,
      projectToken: 'abi_tok_stage',
      compressGzip: true,
    });
    await staging.confirmSubmit(batchTarget);
    await batchTarget.close();

    assert.equal(receivedBatches.length, 1);
    assert.equal(receivedBatches[0].events.length, 2);
    assert.equal(receivedBatches[0].events[1].event_id, 'evt_ord_1');

    staging.clear();
    assert.equal(staging.getEvents().length, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('7. BatchConsumer：zlib.gzipSync 压缩传输与 429 / 5xx 指数退避幂等重试（保留原 event_id）', async () => {
  let attemptCount = 0;
  let sawGzipHeader = false;
  const receivedEventIdsPerAttempt = [];

  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      attemptCount += 1;
      if (req.headers['content-encoding'] === 'gzip') {
        sawGzipHeader = true;
      }
      const raw = Buffer.concat(chunks);
      const body =
        req.headers['content-encoding'] === 'gzip'
          ? JSON.parse(zlib.gunzipSync(raw).toString('utf8'))
          : JSON.parse(raw.toString('utf8'));
      receivedEventIdsPerAttempt.push(body.events.map((e) => e.event_id));

      if (attemptCount === 1) {
        res.writeHead(429, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 429, message: 'rate limited' }));
        return;
      }
      if (attemptCount === 2) {
        res.writeHead(503, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 503, message: 'kafka busy' }));
        return;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          code: 200,
          message: 'success',
          request_id: 'req_retry_ok',
          data: { accepted: body.events.length, rejected: 0 },
        }),
      );
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const consumer = new BatchConsumer({
      serverUrl: `http://127.0.0.1:${port}`,
      projectId: 1,
      projectToken: 'abi_tok_batch',
      batchSize: 10,
      flushIntervalMs: 60000,
      maxRetries: 3,
      baseRetryDelayMs: 10,
      compressGzip: true,
    });
    const sdk = new AbiNodeAnalytics(consumer);

    const id1 = sdk.track('u_1', 'vis_1', 'OrderPaid', { amount: 100 });
    const id2 = sdk.track({
      loginId: 'u_2',
      distinctId: 'vis_2',
      eventName: 'OrderPaid',
      eventId: 'ord_fixed_id_002',
      properties: { amount: 200 },
    });

    await sdk.close();

    assert.equal(sawGzipHeader, true, '必须携带 Content-Encoding: gzip');
    assert.equal(attemptCount, 3, '应经历 429 -> 503 -> 200 共 3 次尝试');
    assert.deepEqual(receivedEventIdsPerAttempt[0], [id1, id2]);
    assert.deepEqual(receivedEventIdsPerAttempt[1], [id1, id2]);
    assert.deepEqual(receivedEventIdsPerAttempt[2], [id1, id2]);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('8. LoggerConsumer：按天（DAILY）/ 按小时（HOURLY）及文件大小切分本地 .jsonl 文件', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'abi-node-logger-'));
  try {
    let currentNow = new Date('2026-11-10T10:00:00.000Z');
    const logger = new LoggerConsumer({
      directory: tmpDir,
      filePrefix: 'abi.track',
      rotateMode: RotateMode.HOURLY,
      maxFileSizeBytes: 220,
      nowFn: () => currentNow,
    });
    const sdk = new AbiNodeAnalytics(logger);

    sdk.track('u_1', 'anon_1', 'PageView', { '#ip': '203.0.113.1', page: 'home' });
    sdk.track('u_1', 'anon_1', 'PageView', { '#ip': '203.0.113.1', page: 'pricing' });

    // 推进 1 小时触发按小时切分
    currentNow = new Date('2026-11-10T11:00:00.000Z');
    sdk.track('u_2', 'anon_2', 'OrderPaid', { amount: 99.5 });

    await sdk.close();

    const fileHour10Part0 = path.join(tmpDir, 'abi.track.2026-11-10-10.jsonl');
    const fileHour10Part1 = path.join(tmpDir, 'abi.track.2026-11-10-10_1.jsonl');
    const fileHour11Part0 = path.join(tmpDir, 'abi.track.2026-11-10-11.jsonl');

    assert.equal(fs.existsSync(fileHour10Part0), true);
    assert.equal(fs.existsSync(fileHour10Part1), true);
    assert.equal(fs.existsSync(fileHour11Part0), true);

    const parsedLine = JSON.parse(fs.readFileSync(fileHour10Part0, 'utf8').trim());
    assert.equal(parsedLine.event_name, 'PageView');
    assert.equal(parsedLine.properties['#ip'], '203.0.113.1');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('9. DebugConsumer：发送 debug: true 与 dry_run，并在网关返回校验失败时抛出详细原因', async () => {
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      assert.equal(body.debug, true);
      assert.equal(body.dry_run, true);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          code: 200,
          message: 'success',
          request_id: 'req_dbg_1',
          data: {
            accepted: 0,
            rejected: 1,
            dry_run: true,
            errors: [
              {
                index: 0,
                event_name: 'PageView',
                reason: 'timestamp is out of allowed window',
              },
            ],
          },
        }),
      );
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  try {
    const debugConsumer = new DebugConsumer({
      serverUrl: `http://127.0.0.1:${port}`,
      projectId: 1,
      projectToken: 'abi_tok_dbg',
      dryRun: true,
    });
    const sdk = new AbiNodeAnalytics(debugConsumer);

    await assert.rejects(
      async () => {
        await sdk.track('u_1', 'anon_1', 'PageView', { $url: 'https://example.com' });
      },
      /timestamp is out of allowed window/,
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('10. 两步式 Demo 端到端验证：第 1 步预览请求 JSON，第 2 步确认提交返回单份响应 JSON', async () => {
  const { previewJson, payload, staging } = buildDemoRequestPreview({
    projectId: 1,
    projectToken: 'abi_tok_demo_node',
    scenario: 'all',
    dryRun: true,
  });

  assert.equal(typeof previewJson, 'string');
  assert.equal(payload.project_id, 1);
  assert.equal(payload.dry_run, true);
  assert.equal(payload.events.length, 14);

  const { envelope, responseJson } = await confirmSubmitDemo(staging, {
    projectId: 1,
    projectToken: 'abi_tok_demo_node',
    compressGzip: true,
  });

  assert.equal(envelope.code, 200);
  assert.equal(envelope.data.accepted, 14);
  assert.equal(envelope.data.rejected, 0);
  assert.equal(JSON.parse(responseJson).code, 200);
});
