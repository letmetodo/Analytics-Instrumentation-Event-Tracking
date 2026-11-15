# ABI Node.js サーバーサイド SDK (`@anylink/abi-node-sdk`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`@anylink/abi-node-sdk` は、**ABI エンタープライズユーザー行動分析（UBA）＆ BI プラットフォーム**の公式 Node.js サーバーサイドデータ収集 SDK です。API 設計と仕様は **ThinkingData Node.js Server SDK v3.4** に完全準拠しており、**外部ランタイム依存関係ゼロ**（Node.js 標準ライブラリ `node:http` / `node:https` / `node:zlib` / `node:fs` / `node:crypto` のみ使用）で構築され、ステートレスなマルチユーザー高並行サーバー環境に最適化されています。

---

## 1. 主な特徴と 4 つの Consumer アーキテクチャ

### 主な特徴
- **外部依存ゼロ**：Node.js 18+ の標準モジュールのみで実装されており、サードパーティパッケージによる脆弱性やバージョン競合がありません。
- **サーバーサイド・ステートレスマルチユーザー設計**：ブラウザ向け単一ユーザー SDK（`@anylink/abi-web-sdk`）とは異なり、`AbiNodeAnalytics` はメモリ内に特定ユーザーのセッションを持たず、各メソッド呼び出し時に `loginId`（アカウント ID）および／または `distinctId`（訪問者／端末 ID）を明示的に渡します。
- **ThinkingData 準拠のデュアル ID 自動紐付け**：通信ペイロードは `distinct_id`（<= 64 UTF-8 バイト）と `login_id`（<= 128 UTF-8 バイト）の 2 つの ID フィールドのみを持ち、少なくとも一方の指定が必須です（`distinct_id` が空の際に `login_id` を `distinct_id` にコピーすることは一切ありません）。任意のイベントに両方の ID が含まれると Flink ETL が自動的に ID-Mapping を実行します。
- **事前厳格バリデーション**：イベント名・プロパティキーの正規表現検証（`^[A-Za-z_][A-Za-z0-9_]*$` およびシステム予約ホワイトリスト）、制御文字の拒否、UTF-8 バイト長制限（`distinct_id` / `event_id` <= 64 バイト、`login_id` <= 128 バイト）をクライアント側で実行します。
- **`BigInt` および `> 2^53 - 1` の 64 ビット整数精度保護**：ネイティブ `BigInt`（例：`9007199254740999n`）や IEEE-754 安全整数範囲（`> 9007199254740991` または `< -9007199254740991`）を超える Snowflake ID（配列要素を含む）を自動的に 10 進文字列へ変換します。
- **静的・動的共通プロパティとユーザープロファイル分離**：`静的共通プロパティ < 動的共通プロパティ < イベント個別プロパティ` の優先順位でマージし、`$user_*` / `#user_*` の 7 種類のプロファイル更新イベントでは共通プロパティを自動的に除外します。
- **`#time` / `$time` の自動抽出と `#ip` / `$ip` パススルー**：`properties` 内の `#time` / `$time` をミリ秒単位のトップレベル `timestamp` に変換して `properties` から除去し、`#ip` / `$ip` をゲートウェイの GeoIP 地域解析用に透過転送します。

### 4 つの Consumer アーキテクチャ

| Consumer 種別 | クラス名 | 用途と主要メソッド |
| :--- | :--- | :--- |
| **`StagingConsumer`** | `StagingConsumer` | **2 ステップ JSON プレビュー＆確認送信**：イベントをメモリに一時保存し、`previewRequestJson()` / `buildRequestPayload()` で `POST /collect/api/v1/track/batch` の完全なリクエスト JSON をプレビュー（ネットワーク通信なし）。`clear()` でリセット可能で、確認後に `confirmSubmit(targetConsumer)` または `submitToGateway(config)` で送信します。 |
| **`BatchConsumer`** | `BatchConsumer` | **本番環境向け高スループット非同期バッチ送信**：件数（`batchSize`、デフォルト 50、最大 500）または間隔（`flushIntervalMs`、デフォルト 3000ms）で自動フラッシュし、`zlib.gzipSync` による Gzip 圧縮（`compressGzip: true`）および `429` / `5xx` エラー時の指数バックオフ冪等リトライ（元の `event_id` を維持）をサポートします。 |
| **`LoggerConsumer`** | `LoggerConsumer` | **ローカル `.jsonl` ファイルローテーション**：イベントを 1 行 1 JSON（`.jsonl`）形式でローカルディスクに書き込み、日次（`RotateMode.DAILY`）・時間単位（`RotateMode.HOURLY`）・ファイルサイズ上限で自動分割します（Filebeat / Vector / LogBus 連携用）。 |
| **`DebugConsumer`** | `DebugConsumer` | **開発時リアルタイム L4 厳格検証**：各イベントを `debug: true`（および任意の `dryRun: true`）で即時同期送信し、ゲートウェイで検証エラー（`rejected > 0`）が発生した場合は詳細な `reason` を含む例外をスローします。 |

---

## 2. サーバーサイド必須フィールドとクライアント透過ガイド（Express / Fastify / Koa での `#ip` 抽出、`X-ABI-Distinct-Id` 連携、非同期 `#time`、冪等 `event_id`）

### 2.1 なぜサーバーサイド SDK ではクライアント情報の明示的な受け渡しが必要なのか？

Node.js バックエンドから収集ゲートウェイ（`:8081`）へ直接通信する場合、ゲートウェイ側が検知する接続元 IP は**バックエンドサーバー自身のデータセンター IP** となります（`LoggerConsumer` によるファイル出力時はネットワーク接続すらありません）。そのため、**ユーザー識別子、クライアントの実グローバル IP（`#ip`）、フロントエンドの訪問者 ID（`X-ABI-Distinct-Id`）、実際のイベント発生時刻（`#time`）、およびビジネス冪等キー（`event_id`）** を HTTP リクエストヘッダーやメッセージキュー（MQ）のペイロードから抽出して SDK に渡す必要があります。

### 2.2 Express / Fastify / Koa 実装サンプルコード

```js
import { AbiNodeAnalytics, BatchConsumer } from '@anylink/abi-node-sdk';

const batchConsumer = new BatchConsumer({
  serverUrl: process.env.ABI_GATEWAY_URL || 'http://127.0.0.1:8081',
  projectId: 1,
  projectToken: process.env.ABI_PROJECT_TOKEN || 'abi_tok_prod_node',
  compressGzip: true,
});
export const abi = new AbiNodeAnalytics(batchConsumer);
abi.setSuperProperties({
  $platform: 'NodeServer',
  service_name: 'order-api',
});

/**
 * Express / Fastify / Koa のリクエストヘッダーからクライアントの実 IP (#ip) と X-ABI-Distinct-Id を抽出するヘルパー関数
 */
export function extractClientContext(headers = {}, fallbackIp = '') {
  const xff = headers['x-forwarded-for'];
  const rawXff = Array.isArray(xff) ? xff[0] : xff;
  const clientIp =
    (typeof rawXff === 'string' && rawXff.split(',')[0].trim()) ||
    (typeof headers['x-real-ip'] === 'string' && headers['x-real-ip'].trim()) ||
    fallbackIp ||
    '';

  const rawDistinct = headers['x-abi-distinct-id'];
  const distinctId =
    (Array.isArray(rawDistinct) ? rawDistinct[0] : rawDistinct)?.trim() || '';

  return { clientIp, distinctId };
}

// Express ルートでの実装例
export function registerExpressCheckoutRoute(app) {
  app.post('/api/v1/orders/pay', async (req, res) => {
    const { clientIp, distinctId } = extractClientContext(req.headers, req.ip);
    const { orderNo, snowflakeOrderId, amount, occurredAt } = req.body;

    abi.track({
      loginId: req.user?.id || 'acct_900102',
      distinctId, // フロントエンドから渡された X-ABI-Distinct-Id を Flink で自動紐付け
      eventId: `ord_paid_${orderNo}`, // StarRocks 主キー重複排除のための決定的 event_id
      eventName: 'OrderPaid',
      properties: {
        '#ip': clientIp, // クライアントの実パブリック IP（GeoIP で国・都道府県・市区町村を解析）
        '#time': occurredAt || new Date(), // トップレベルの timestamp (ms) に抽出され properties から除去される
        order_no: orderNo,
        order_id: BigInt(snowflakeOrderId), // > 2^53 - 1 の整数も文字列として安全にシリアライズ
        amount,
      },
    });

    res.json({ code: 200, message: 'ok' });
  });
}

// Fastify ルートでの実装例
export function registerFastifyCheckoutRoute(fastify) {
  fastify.post('/api/v1/orders/pay', async (request, reply) => {
    const { clientIp, distinctId } = extractClientContext(request.headers, request.ip);
    abi.track({
      loginId: request.user?.id || 'acct_900102',
      distinctId,
      eventId: `ord_paid_${request.body.orderNo}`,
      eventName: 'OrderPaid',
      properties: {
        '#ip': clientIp,
        '#time': request.body.occurredAt || Date.now(),
        order_no: request.body.orderNo,
        amount: request.body.amount,
      },
    });
    return reply.send({ code: 200, message: 'ok' });
  });
}

// Koa ミドルウェア / ルートでの実装例
export async function koaCheckoutHandler(ctx) {
  const { clientIp, distinctId } = extractClientContext(ctx.request.headers, ctx.request.ip);
  abi.track({
    loginId: ctx.state.user?.id || 'acct_900102',
    distinctId,
    eventId: `ord_paid_${ctx.request.body.orderNo}`,
    eventName: 'OrderPaid',
    properties: {
      '#ip': clientIp,
      '#time': ctx.request.body.occurredAt || new Date(),
      order_no: ctx.request.body.orderNo,
      amount: ctx.request.body.amount,
    },
  });
  ctx.body = { code: 200, message: 'ok' };
}
```

---

## 3. クイックスタート＆全 API サンプル

```js
import { AbiNodeAnalytics, BatchConsumer, StagingConsumer } from '@anylink/abi-node-sdk';

// ステップ 1：StagingConsumer でリクエスト JSON をプレビュー（ネットワーク通信なし）
const staging = new StagingConsumer({
  projectId: 1,
  projectToken: 'abi_tok_demo_node',
  dryRun: false,
});
const sdk = new AbiNodeAnalytics(staging);

sdk.setSuperProperties({ $platform: 'NodeServer', service_name: 'order-service' });
sdk.setDynamicSuperProperties(() => ({ server_region: 'ap-northeast-1' }));

sdk.track('acct_900102', 'vis_dev_7f8e9a01', '$login', { login_method: 'sso_oidc' });
// 注：D7① / G6 ゲートウェイ制限により、trackFirst、trackUpdate、trackOverwrite は現バージョン未開放であり Error をスローします。
sdk.track({
  loginId: 'acct_900102',
  distinctId: 'vis_dev_7f8e9a01',
  eventId: 'ord_evt_001',
  eventName: 'OrderPaid',
  properties: {
    '#ip': '203.0.113.42',
    '#time': '2026-11-10T10:00:00.000Z',
    order_id: 9007199254740999n,
    order_status: 'PAID',
  },
});

// 7 種類のユーザープロファイル更新メソッド（共通プロパティは自動的に除外）
sdk.userSet('acct_900102', 'vis_dev_7f8e9a01', { plan_tier: 'Enterprise' });
sdk.userSetOnce('acct_900102', 'vis_dev_7f8e9a01', { first_utm_source: 'github' });
sdk.userAdd('acct_900102', 'vis_dev_7f8e9a01', { order_count: 1, total_spent: 2549.15 });
sdk.userAppend('acct_900102', 'vis_dev_7f8e9a01', { modules: ['event', 'funnel'] });
sdk.userUniqAppend('acct_900102', 'vis_dev_7f8e9a01', { modules: ['funnel', 'retention'] });
sdk.userUnset('acct_900102', 'vis_dev_7f8e9a01', 'legacy_tag');
sdk.userDelete('acct_gdpr_erased_01', 'vis_gdpr_erased_01');

console.log(staging.previewRequestJson());

// ステップ 2：確認後にターゲット Consumer またはゲートウェイへ送信
const batchConsumer = new BatchConsumer({
  serverUrl: 'http://127.0.0.1:8081',
  projectId: 1,
  projectToken: 'abi_tok_demo_node',
  compressGzip: true,
});
await staging.confirmSubmit(batchConsumer);
await batchConsumer.close();
```

---

## 4. テストと CLI デモの実行

```bash
# ユニットテストおよびゴールデンテストベクター検証の実行
node --test /Users/zhongjie/data/anylink/abi/abi.sdk/nodejs/test/abi-node-sdk.test.mjs

# 2 ステップ CLI デモの実行（ステップ 1 でリクエスト JSON をプレビューし、ステップ 2 で送信してレスポンス JSON を出力）
node /Users/zhongjie/data/anylink/abi/abi.sdk/nodejs/examples/demo.mjs --yes
```
