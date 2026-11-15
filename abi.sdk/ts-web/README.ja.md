**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

# ABI Web / TypeScript / WeChat ミニプログラム / React Native SDK (`@anylink/abi-web-sdk`)

`@anylink/abi-web-sdk` は、**Web / H5 シングルページアプリケーション（SPA）、WeChat ミニプログラム / uni-app / Taro、および React Native** 向けのクロスプラットフォーム行動分析（UBA）収集 SDK です。**ThinkingData JS SDK v3.4** のセマンティクス仕様に完全準拠し、ABI 収集ゲートウェイ（`POST /collect/api/v1/track/batch`）、Flink リアルタイムストリーミング ETL、および StarRocks OLAP モデルとシームレスに連携します。

---

## 1. コア機能一覧

| 機能領域 | 主要 API / メカニズム | 特徴・仕様 |
|----------|----------------------|------------|
| **デュアル ID 識別モデル** | `identify(distinctId)`<br>`login(accountId)`<br>`logout()`<br>`getDistinctId()` / `getLoginId()` | 初回起動時に UUIDv4 訪問者・デバイス ID（`distinct_id` $\le 64$ UTF-8 バイト）を自動生成・永続化。`identify()` で `distinct_id` をローカル更新し、`login()` 呼び出しで認証済みアカウント ID（`login_id` $\le 128$ UTF-8 バイト）をローカル保存します（**`distinct_id` を上書きせず、追加ネットワークイベントも送信しません**）。後続イベントには `distinct_id` と `login_id` の両方が付与され、`logout()` で `login_id` のみをクリアします。 |
| **静的・動的パブリックプロパティ** | `setSuperProperties(props)`<br>`unsetSuperProperty(key)`<br>`clearSuperProperties()`<br>`getSuperProperties()`<br>`setDynamicSuperProperties(fn)` | 静的パブリックプロパティはストレージへ自動永続化され、動的パブリックプロパティは `track()` 呼び出しのたびにリアルタイム評価されます。優先順位：**イベント個別プロパティ > 動的パブリックプロパティ > 静的パブリックプロパティ > プリセットプロパティ**（`$user_*` ユーザー属性イベントにはプリセットおよびパブリックプロパティは混入しません）。 |
| **高精度イベント計測** | `timeEvent(eventName)` $\rightarrow$ `$duration` | 単調増加クロック（`performance.now()`）で経過時間を計測し、後続の同名 `track(eventName)` 呼び出し時に `$duration`（単位：秒、小数点以下3桁）を自動付与します。 |
| **初回イベント重複排除（現バージョン未開放）** | `trackFirst(eventName, firstCheckId, props)` | （*D7① / G6 制限により現バージョン未開放*）呼び出し時に `Error` をスローし偽装イベントは入隊しません。同日再送のべき等性には `track(..., { eventId })` を使用してください。 |
| **更新可能・上書き可能イベント（現バージョン未開放）** | `trackUpdate(eventName, eventId, props)`<br>`trackOverwrite(eventName, eventId, props)` | （*D7① / G6 制限により現バージョン未開放*）呼び出し時に `Error` をスローし偽装イベントは入隊しません。ステータス遷移は独立したマイルストーンイベントとして送信してください。 |
| **`BigInt` および `> 2^53 - 1` 精度保護** | `normalizeProperties` による自動変換 | ネイティブ `BigInt`（例：`9007199254740993n`）や IEEE-754 安全整数範囲（`> 2^53 - 1` または `< -(2^53 - 1)`）を超える 64 ビット Snowflake ID（配列要素を含む）を自動的に欠損のない10進文字列へシリアライズし、`JSON.stringify` による精度落ちを防止します。 |
| **`#time` / `$time` 発生時刻の自動抽出** | `properties['#time' \| '$time']` | イベントや `$user_*` のプロパティに渡された `Date` インスタンス、秒/ミリ秒タイムスタンプ、または日時文字列（例：`'2026-11-10 12:30:00'`）を自動的にトップレベルの `timestamp`（ミリ秒）へ変換し、`properties` から除外します。 |
| **7種類の `$user_*` ユーザープロファイル操作** | `userSet` (`$user_set`)<br>`userSetOnce` (`$user_set_once`)<br>`userAdd` (`$user_add`)<br>`userUnset` (`$user_unset`)<br>`userAppend` (`$user_append`)<br>`userUniqAppend` (`$user_uniq_append`)<br>`userDelete` (`$user_del`) | StarRocks `abi.dim_users` テーブルに対する上書き設定、初回のみ設定、数値アトミック加算、属性削除、リスト追加、重複排除付きリスト追加、プロファイル削除を網羅します。 |
| **SPA 自動計測 & オフライン再送** | `enableAutoTrack({ pageView, pageLeave, webClick })`<br>`navigator.sendBeacon` + 永続化キュー | `pushState` / `replaceState` / `popstate` / `hashchange` を検知して `$pageview` を送信。`<button>`、`<a>`、`<input>`、`[data-abi-track]` 要素のクリックで `$AppClick` を送信。`visibilitychange` / `pagehide` 時に滞在時間を計測して `$AppEnd` を生成し、`navigator.sendBeacon` を優先して送信します。通信エラーや HTTP `429` / `5xx` 発生時は同一 `event_id` のまま永続化キューに保持し、冪等リトライを行います。 |

---

## 2. 実装エンジニア視点：必須指定フィールド・SDK 自動収集フィールド・ゲートウェイ／サーバー補完フィールド（IP など）

フロントエンド／ミニプログラム／React Native の実装エンジニアの視点から、計測フィールドは以下の 3 つのカテゴリに分類されます：

### 1. フィールド責務一覧表

| カテゴリ | フェーズ / フィールド名 | クライアント実装での指定 | 生成元・処理メカニズム |
|----------|-------------------------|--------------------------|------------------------|
| **第1類：実装者が【必ず明示的に渡す】必須項目** | **初期化 (`init`)**：`serverUrl`、`projectId` (`> 0`)、`token` | **必須** | `:8081` 収集ゲートウェイ URL、プロジェクト ID（`> 0`）、非空のプロジェクトトークン（`project_token`）を指定します。 |
| | **イベント計測 (`track`)**：`eventName` | **必須** | イベント名（例：`'OrderPaid'`）。任意のカスタム属性は `properties` で渡します。 |
| | **ログイン (`login`)**：`accountId`（`login_id`） | **ログイン時に必須** | 認証完了時にアカウント ID を渡し、`login_id` をローカル永続化します（`distinct_id` は維持されネットワーク送信は発生せず、後続イベントに両方の ID が付与されます）。 |
| | **イベント更新・上書き (`trackUpdate` / `trackOverwrite`)**：`eventId` | **現バージョン未開放** | D7① / G6 制限により呼び出し時は `Error` をスローします。同日再送のべき等性には `track(..., { eventId })` を使用してください。 |
| **第2類：SDK が【自動生成・永続化】し、手動入力不要な項目** | `distinct_id` | **自動生成（入力不要）** | 初期化時に UUIDv4 訪問者・デバイス ID を自動生成しローカルストレージ（`localStorage` / `SharedPreferences` / `UserDefaults`）へ永続化。`identify()` で変更可能であり、`login()` / `logout()` によって上書きされません。 |
| | `event_id` | **自動生成（入力不要）** | `track` ごとに UUIDv4 を自動採番し、オフライン／弱電波環境でのリトライ時も同一 ID を維持して冪等性を保証します。 |
| | `timestamp` | **自動生成（入力不要）** | クライアントの現在ミリ秒タイムスタンプを自動取得します（`#time` / `$time` で過去イベント時刻を明示した場合を除く）。 |
| | 端末・環境プリセット属性：`$lib`、`$lib_version`、`$os`、`$os_version`、`$device_model`、`$screen_width`、`$screen_height`、`$url`、`$title`、`$referrer`、`$zone_offset` | **自動収集（入力不要）** | SDK が自動的に取得・付与します（`$user_*` プロファイルイベントでは自動的に除外されます）。 |
| **第3類：クライアントでは【取得不可・指定不要】で、ゲートウェイ／サーバーが補完する項目** | **グローバル IP と地域情報 (`#ip` / `$ip` $\rightarrow$ 国・都道府県・市区町村)** | **クライアントでの指定厳禁** | クライアントが `:8081` ゲートウェイへ直接通信する場合、ゲートウェイが HTTP 接続（および `X-Forwarded-For` / `X-Real-IP`）から実際のクライアント IP を抽出し、Flink が国・地域・都市を自動解析します。 |

### 2. 3つのカテゴリの詳細とフロントエンド・バックエンド連携のベストプラクティス

1. **第1類：実装者が【必ず明示的に渡す】必須項目**
   - **初期化フェーズ (`init` / `initialize`)**：`serverUrl`（収集ゲートウェイアドレス）、`projectId`（`> 0`）、`token` / `projectToken`（非空のプロジェクトキー）。
   - **イベント送信フェーズ (`track`)**：`eventName`（必須、例：`'OrderPaid'`）。
   - **アカウントログインフェーズ (`login`)**：ユーザーが実名ログインを完了した際に `accountId`（すなわち `login_id`）を渡します。SDK はローカルに `login_id` を永続化し、`distinct_id` を維持したまま（追加通信なしで）後続すべてのイベントに両 ID を付与します。
   - **同日べき等リトライ（任意 `TrackOptions.eventId`）**：確定的な同日重複排除が必要な場合は `track(eventName, props, { eventId })` を指定します（注：`trackFirst` / `trackUpdate` / `trackOverwrite` は現バージョン未開放であり `Error` をスローします）。
2. **第2類：SDK が【自動生成・永続化】し、フロントエンド／クライアント開発者が【手動入力不要】なフィールド**
   - **`distinct_id`（訪問者／デバイス ID）**：初期化時に UUIDv4 を自動生成してローカルストレージ（`localStorage` / `SharedPreferences` / `UserDefaults`）に永続化します。`identify()` で変更可能であり、`login()` や `logout()` で上書きされることはありません。
   - **`event_id`**：`track` 呼び出しごとに UUIDv4 を自動生成し、弱電波やオフライン再送時にも同一値を維持して冪等性を保ちます。
   - **`timestamp`**：クライアントの現在ミリ秒タイムスタンプを自動採用します（`#time` / `$time` で過去イベント時刻を明示的に指定した場合を除く）。
   - **端末・環境プリセット属性**：`$lib`、`$lib_version`、`$os`、`$os_version`、`$device_model`、`$screen_width`、`$screen_height`、`$url`、`$title`、`$referrer`、`$zone_offset`。
3. **第3類：クライアントでは【取得できず送信も不要】で、収集ゲートウェイ／サーバー側が取得するフィールド（重要：`IP` とフロント・バックエンド連携）**
   - **グローバル IP と地域情報 (`#ip` / `$ip` $\rightarrow$ 国／都道府県／市区町村)**：ブラウザ JS、ミニプログラム、モバイル App はクライアントサンドボックスおよび NAT ルーター配下で動作するため、**自身のパブリック出口 IP を直接取得することはできません。したがって、クライアント実装時に `$ip` / `#ip` を渡す必要は一切ありません**。クライアントが `:8081` 収集ゲートウェイに直接送信すれば、ゲートウェイが HTTP 接続（および Nginx/SLB の `X-Forwarded-For` / `X-Real-IP`）から実際のクライアント IP を自動抽出し、Flink が国・都道府県・市区町村を自動解決します。
   - **注意：いつ IP を渡す必要があるのか？** 「クライアントがまず自社バックエンド API を呼び出し、Go/Java サーバーサイド SDK が代わってイベントを代理送信する」構成を採用している場合のみ、ゲートウェイからはバックエンドサーバーのデータセンター IP に見えるため、バックエンド側でクライアントリクエストから IP を抽出して `#ip` / `$ip` としてサーバー SDK に渡す必要があります。あわせて、フロントエンドからバックエンド API を呼び出す際はリクエストヘッダーに `abi.getDistinctId()`（モバイルでは `getDistinctId()`）を付与し、フロントエンドとバックエンドのファネルを紐付けることを推奨します：
     ```ts
     // バックエンド API 呼び出し時に distinct_id をヘッダーで渡し、サーバー SDK 側と同一訪問者として紐付ける
     await fetch('/api/v1/orders/checkout', {
       method: 'POST',
       headers: {
         'Content-Type': 'application/json',
         'X-ABI-Distinct-Id': abi.getDistinctId(),
       },
       body: JSON.stringify({ skuId: 'sku_1001', count: 1 }),
     });
     ```

---

## 3. 2ステップ「パラメータ設定・リクエスト JSON プレビュー -> 確認送信」と対話型プレイグラウンド

結合テストや計測検証向けに、`buildPendingBatchPayload()` および `clearQueue()` を提供しており、**「送信前にバッチリクエスト JSON 全体をリアルタイムでプレビューし、内容を確認してから `flush()` で送信する」** 2ステップのワークフローに対応しています。

```ts
import { AbiWebSdk } from '@anylink/abi-web-sdk';

const sdk = new AbiWebSdk().init({
  serverUrl: 'http://localhost:8081',
  projectId: 1,
  token: 'abi_proj_token_demo',
  flushIntervalMs: 600_000, // 手動確認のため自動フラッシュ間隔を延長
  dryRun: true,             // 任意：ゲートウェイの Dry-Run モード（認証・スキーマ検証のみ行い DB 保存しない）
});

// ステップ 1：ID・パブリックプロパティ・イベントを組み立てる（sdk.clearQueue() でいつでも再構築可能）
sdk.identify('visitor_preview_001');
sdk.setSuperProperties({ channel: 'organic_search' });
sdk.track('OrderPaid', {
  order_id: 9007199254740993n,
  amount: 299.5,
  '#time': '2026-11-10T08:00:00.000Z',
});

// POST /collect/api/v1/track/batch へ送信される完全な JSON ペイロードをプレビュー（キューは消費しない）
const previewPayload = sdk.buildPendingBatchPayload();
console.log('送信待ちリクエスト JSON プレビュー:', JSON.stringify(previewPayload, null, 2));

// ステップ 2：内容を確認後、ゲートウェイへ送信
const ok = await sdk.flush();
console.log('送信結果:', ok);
```

### ブラウザ対話型プレイグラウンド

外部依存ゼロのブラウザ検証ツール [`examples/interactive-demo.html`](examples/interactive-demo.html) を同梱しています（詳細は [`examples/README.ja.md`](examples/README.ja.md) を参照）：

1. SDK をビルドしてローカル HTTP サーバーを起動します：
   ```bash
   cd abi.sdk/ts-web
   pnpm run build
   python3 -m http.server 8090
   ```
2. ブラウザで `http://localhost:8090/examples/interactive-demo.html` を開きます（`file://` で直接開いた場合も内蔵フォールバック SDK で動作します）。
3. 左側パネルで ID・静的/動的パブリックプロパティ・24種類のイベントトリガーを操作し、右側パネルで送信待ち JSON ペイロードを確認した上で、`mock` / `dry_run` / `live` モードを切り替えて **「確認送信」** を実行できます。

---

## 4. マルチプラットフォーム導入クイックスタート

実行可能な完全なサンプルコードは [`examples/usage-examples.ts`](examples/usage-examples.ts) を参照してください。

### 1. Web SPA アプリケーションへの導入

```ts
import { AbiWebSdk } from '@anylink/abi-web-sdk';

export const abi = new AbiWebSdk().init({
  serverUrl: 'https://ingest.abi.example.com',
  projectId: 101,
  token: 'abi_proj_token_web_ecommerce',
  appVersion: '3.4.0',
  autoTrack: {
    pageView: true,  // History / Hash ルート遷移時に $pageview を自動送信
    pageLeave: true, // ページ非表示・離脱時に滞在時間を計測して $AppEnd を自動送信 (sendBeacon)
    webClick: true,  // button / a / input / [data-abi-track] のクリックで $AppClick を自動送信
  },
});

// 1. 訪問者 ID とパブリックプロパティの設定
abi.identify('visitor_web_001');
abi.setSuperProperties({ channel: 'seo_landing', ab_group: 'checkout_v2' });
abi.setDynamicSuperProperties(() => ({ cart_items: 2 }));

// 2. ログインによるアカウント ID 設定 (login_id をローカル保存、distinct_id は維持、追加通信なし)
abi.login('user_10086');

// 3. イベント時間計測・固定 eventId 同日べき等送信・64ビット Snowflake ID・マイルストーンイベント
abi.timeEvent('OrderPaid');
abi.track('CheckoutStarted', { coupon: 'WELCOME_ABI' }, { eventId: 'evt_checkout_001' });

abi.track('OrderPaid', {
  order_id: 9007199254740993n, // > 2^53 - 1 は自動的に文字列 "9007199254740993" としてシリアライズ
  amount: 299.5,
  items: ['sku_1', 2, true],
}, { eventId: 'evt_order_paid_001' });

abi.track('OrderSettled', { order_id: 9007199254740993n, amount: 279.5, status: 'settled' });

// 4. ユーザープロファイル操作 ($user_*)
abi.userSet({ vip_level: 'gold', city: 'Shanghai' });
abi.userSetOnce({ first_order_date: '2026-11-10' });
abi.userAdd({ loyalty_points: 300, total_orders: 1 });
abi.userUniqAppend({ badges: ['early_adopter', 'vip_2026'] });
await abi.flush();
```

### 2. WeChat ミニプログラム / uni-app / Taro への導入（`createMiniProgramAdapter`）

`@anylink/abi-web-sdk/adapters/miniapp` の `createMiniProgramAdapter` を使用して、同期ストレージ（`wx.getStorageSync` / `setStorageSync`）、通信（`wx.request`）、および端末プリセットプロパティ（`$lib: 'abi-mp-sdk'`、`$os`、`$os_version`、`$device_model`、画面サイズ）を接続します：

```ts
import { AbiWebSdk } from '@anylink/abi-web-sdk';
import { createMiniProgramAdapter } from '@anylink/abi-web-sdk/adapters/miniapp';

const mpAdapter = createMiniProgramAdapter(wx); // uni-app は uni、Taro は Taro を渡す

export const abiMp = new AbiWebSdk().init({
  serverUrl: 'https://ingest.abi.example.com', // WeChat 管理画面の request 許可ドメインに登録してください
  projectId: 102,
  token: 'abi_proj_token_wx_miniapp',
  appVersion: '2.1.0',
  ...mpAdapter,
});

abiMp.track('$AppStart', { path: 'pages/home/index', scene: 1001 });
abiMp.login('wx_openid_u_8801');
abiMp.track('ShareMiniProgram', {
  share_target: 'moments',
  campaign_id: 9007199254740999n,
});
```

### 3. React Native モバイルアプリへの導入（`createReactNativeAdapter`）

`@anylink/abi-web-sdk/adapters/react-native` の `createReactNativeAdapter` を使用して、モバイル端末プリセットプロパティ（`$lib: 'abi-rn-sdk'`、`$os`、`$os_version`、`$device_model`、`$screen_width`、`$screen_height`）および同期ストレージアダプター（`react-native-mmkv` など）を注入します：

```ts
import { AbiWebSdk, type AbiStorageAdapter } from '@anylink/abi-web-sdk';
import { createReactNativeAdapter } from '@anylink/abi-web-sdk/adapters/react-native';

const mmkvStorage: AbiStorageAdapter = {
  getItem: (key) => mmkv.getString(key) ?? null,
  setItem: (key, value) => mmkv.set(key, value),
  removeItem: (key) => mmkv.delete(key),
};

const rnAdapter = createReactNativeAdapter({
  os: 'android',
  osVersion: '14',
  deviceModel: 'Pixel 8 Pro',
  appVersion: '4.0.2',
  screenWidth: 412,
  screenHeight: 915,
  syncStorage: mmkvStorage,
});

export const abiRn = new AbiWebSdk().init({
  serverUrl: 'https://ingest.abi.example.com',
  projectId: 103,
  token: 'abi_proj_token_rn_mobile',
  ...rnAdapter,
});

abiRn.identify('rn_device_uuid_7788');
abiRn.login('rn_user_5566');
abiRn.timeEvent('VideoPlayback');
abiRn.track('VideoPlayback', { video_id: 'vid_onboarding_4k', resolution: '2160p' });
```

---

## 5. ビルドとテストコマンド

`abi.sdk/ts-web` ディレクトリで以下のコマンドを実行し、単体テスト（ゴールデンテストベクター検証、オフライン冪等リトライ、3プラットフォーム統合テスト）と ESM / 型定義（`.d.ts`）のビルドを実行します：

```bash
cd abi.sdk/ts-web
pnpm test && pnpm run build
```
