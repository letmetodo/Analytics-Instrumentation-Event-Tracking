**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

# ABI TypeScript SDK 対話型プレイグラウンド & マルチプラットフォーム導入サンプル

本ディレクトリでは、`@anylink/abi-web-sdk`（**Web / H5 / WeChat ミニプログラム / uni-app / Taro / React Native** 向けクロスプラットフォーム計測 SDK、ThinkingData v3.4 セマンティクス準拠）のビジュアル検証プレイグラウンドと、エンドツーエンドで実行可能な導入サンプルを提供します：

| ファイル | 説明 |
|----------|------|
| [`interactive-demo.html`](./interactive-demo.html) | 外部依存ゼロのブラウザ対話型プレイグラウンド。設定バー、リアルタイム状態ダッシュボード、5大機能トリガーグループ、およびリアルタイム JSON ペイロード監視パネルを内蔵 |
| [`usage-examples.ts`](./usage-examples.ts) | Web SPA EC フルフロー、WeChat ミニプログラム（`createMiniProgramAdapter`）、React Native（`createReactNativeAdapter`）の3つのシナリオを網羅した実行可能な TypeScript サンプル |

---

## 一、ブラウザ対話型プレイグラウンド（`interactive-demo.html`）

### 1. 起動と連携方法

#### 方法 A：ビルド後にローカル HTTP サーバー経由で開く（推奨・実際のコンパイル成果物を読み込み）

1. `abi.sdk/ts-web` ディレクトリで SDK 成果物 `dist/index.js` をビルドします：
   ```bash
   cd abi.sdk/ts-web
   pnpm run build
   ```
2. `abi.sdk/ts-web` ディレクトリで任意の静的ファイルサーバーを起動します（Python 標準 HTTP サーバーの例）：
   ```bash
   cd abi.sdk/ts-web
   python3 -m http.server 8090
   ```
3. ブラウザで `http://localhost:8090/examples/interactive-demo.html` にアクセスします。ページ上部タイトル右側のバッジに **`已加载 ../dist/index.js`** と表示され、実際の SDK ビルド成果物が動作していることを示します。

#### 方法 B：ファイルを直接ダブルクリックして開く（ビルド不要のオフライン即時体験）

まだビルドを実行していない場合や、`file://` プロトコルで直接 `examples/interactive-demo.html` を開いた場合（ブラウザの制約により `file://` 下での ES Module 親ディレクトリ読み込みが制限される場合）、ページ内蔵の軽量フォールバック実装が自動的に有効化され（バッジ表示：**`内置兜底 SDK（执行 pnpm run build 可加载 dist/index.js）`**）、バックエンドやローカルサーバーなしでリクエスト JSON 構造をプレビューできます。

#### 実際の ABI 収集ゲートウェイ（`:8081`）との結合テスト

プレイグラウンドのイベントをローカルまたは検証環境の ABI SDK 収集ゲートウェイ（`POST /collect/api/v1/track/batch`）へ送信する場合：

1. バックエンド収集ゲートウェイを起動します：
   ```bash
   cd abi.srv
   ENV=dev go run ./cmd/gateway/
   ```
2. プレイグラウンド上部の設定バーに入力します：
   - **収集ゲートウェイ URL (`Server URL`)**：`http://localhost:8081`
   - **プロジェクト ID (`Project ID`)**：対象プロジェクトの数値 ID（例：`1`）
   - **プロジェクトトークン (`Project Token`)**：管理画面「プロジェクト管理」で発行された `project_token`
   - **送信モード (`Send Mode`)**：**実ゲートウェイ Dry-Run（検証のみ）** または **実ゲートウェイ本番送信** を選択
3. **「SDK を初期化 / 再初期化」** ボタンをクリックして設定を反映します。

---

### 2. 上部 3 種類の送信モードの説明

プレイグラウンド上部の **「送信モード (`Send Mode`)」** ドロップダウンは、以下の3段階の検証レベルをサポートしています：

| 送信モード | リクエスト動作と `dry_run` フラグ | 適用シナリオ |
|------------|-----------------------------------|--------------|
| **ローカル Mock 電文監視（バックエンド不要）** (`mock`) | 実際のネットワーク通信は行わず、プレイグラウンドがトランスポート層をインターセプトしてローカルで `200 OK` を返し、完全なバッチ JSON を右側パネルにリアルタイム表示します | フロントエンドのオフライン開発、フィールド名・デュアル ID 遷移・`BigInt` シリアライズ形式の確認 |
| **実ゲートウェイ Dry-Run 検証のみ（DB 非保存）** (`dry_run`) | 収集ゲートウェイ `POST /collect/api/v1/track/batch` へ実際の HTTP リクエストを送信し、トップレベルに `"dry_run": true` を付与します。ゲートウェイはトークン認証・フィールド規約・スキーマ検証を完全に実行しますが、**Kafka および StarRocks へは書き込みません** | リリース前のゲートウェイ疎通確認、テスト/本番 DB を汚さずに認証エラーや属性型エラーを特定 |
| **実ゲートウェイ本番送信（Kafka/StarRocks 書込）** (`live`) | 収集ゲートウェイへ本番バッチを送信し、Kafka 経由で Flink Job1 ETL / Job2 ODS で処理され、StarRocks（`dwd_events`、`dim_users`、`identity_map`、`ods_events_raw`）へ格納されます | エンドツーエンドのデータパイプライン検収、BI レポート集計照合、ユーザーセグメント/プロファイルのリアルタイム検証 |

---

### 3. リアルタイム状態ダッシュボードと「設定プレビュー -> 確認送信」ワークフロー

プレイグラウンドは **「左側でパラメータを設定し、右側で単一の送信待ちリクエスト JSON をリアルタイムプレビューし、手動で確認送信する」** クリーンな設計を採用しており、パブリックプロパティや ID の切り替えによって右側に大量のログカードが無限追記されることはありません：

1. **リアルタイム状態ダッシュボード**：
   - **訪問者 ID (`distinct_id`)**：初回初期化時に自動生成される UUIDv4 訪問者・デバイス ID。`identify()` でカスタム上書き可能であり、`login()` / `logout()` でも維持されます。
   - **ログインアカウント ID (`login_id`)**：`login()` 呼び出し後に設定された業務アカウント ID。未ログインまたは `logout()` 実行後は `(未登录)` と表示されます。
2. **右側「送信待ちリクエスト JSON プレビュー」と「確認送信」パネル**：
   - **リクエストボディ (`Request Body JSON`)**：常に1つの完全な `POST /collect/api/v1/track/batch` 送信待ち JSON のみを表示し、**テキストエリア内での直接手動編集およびワンクリック整形をサポートします**（JSON 構文と `events` 配列のリアルタイム検証付き）。ID の変更、パブリックプロパティの編集・切り替え、または別のイベントを選択すると、この JSON パネルがその場でリアルタイム更新されます（「複数イベント一括バッチモード」にチェックを入れると、同一の `events` 配列に複数イベントを追加できます）。
   - **確認送信**：上記リクエスト JSON を確認後、右上の緑色の **「確認送信」** ボタンをクリックした時点で初めて実際の送信が行われ、下部の **「直近の送信結果」** エリアが更新されます。

---

### 4. 機能グループとパラメータ構築ボタンの説明

プレイグラウンド左側は収集ライフサイクルに沿って **パラメータ設定・構築グループ** に分かれています：

#### グループ 1：ID とセッションパラメータ（`identify` / `login` / `logout`）

1. **ランダム訪問者 ID の切り替え (`identify`)**：現在の訪問者・デバイス ID（`distinct_id`）をローカル更新し、右側の送信待ちリクエスト内の `distinct_id` を即座に更新します。
2. **ログインアカウントの設定 (`login`)**：`sdk.login(...)` を純粋なローカル状態変更として呼び出し（`distinct_id` を上書きせず追加イベントも生成しません）、右側の送信待ちイベント JSON に `distinct_id` と `login_id` の両方を即座に反映します。
3. **ログアウト (`logout`)**：`sdk.logout()` を呼び出して `login_id` をクリアし（`distinct_id` は維持）、右側のプレビュー JSON を更新します。

#### グループ 2：パブリックプロパティ設定（`Super Properties`）

4. **静的パブリックプロパティ入力欄 + 適用ボタン**：任意の JSON オブジェクトを直接編集して `sdk.setSuperProperties(...)` を呼び出すと、右側の送信待ち行動イベントの `properties` に即座にマージされます。
5. **動的パブリックプロパティの有効化（ON / OFF）**：`setDynamicSuperProperties` の状態をワンクリックで切り替えます。有効化すると、右側の行動イベントパラメータに `dyn_sequence` と `viewport_width` が自動マージされます。
6. **全パブリックプロパティのクリア**：静的パブリックプロパティを消去し動的パブリックプロパティをオフにし、右側リクエスト JSON から該当フィールドを除去します。

#### グループ 3：行動イベント送信（`track` / `timeEvent` / 固定 `eventId` 同日べき等送信 / `BigInt`）

7. **商品閲覧イベントの送信 (`ProductView`)**
   - `sdk.track('ProductView', { sku_id, product_name, price, in_stock })` を呼び出し、プリセットプロパティ（`$lib`、`$url`、`$screen_width` など）とパブリックプロパティを自動マージした標準的な EC 商品詳細閲覧イベントを生成します。
8. **イベント計測の開始 (`timeEvent 'OrderPaid'`)**
   - 高精度単調増加クロック（`performance.now()`）に基づく `sdk.timeEvent('OrderPaid')` タイマーを開始します（この時点ではネットワーク送信を行いません）。
9. **計測イベントの完了 (`$duration`)**
   - `sdk.track('OrderPaid', { amount: 299.5, currency: 'CNY', payment_method: 'apple_pay' })` を呼び出します。事前に「イベント計測の開始」をクリックしていた場合、経過秒数（小数点以下3桁）を自動計算して `$duration` プロパティを注入します。
10. **固定 `eventId` 同日べき等送信 (`CheckoutStart`)**
    - `sdk.track('CheckoutStart', { coupon_code: 'WELCOME_ABI' }, { eventId })` を呼び出し、確定的な `event_id` による同日リトライ重複排除を実演します（注：`trackFirst` / `trackUpdate` / `trackOverwrite` は D7① / G6 制限により現バージョン未開放であり、`Error` をスローします）。
11. **64ビット Snowflake ID の送信 (`BigInt > 2^53-1`)**
    - `sdk.track('OrderPaid', { order_id: 9007199254740993n, snowflake_trace_id: 1844674407370955161n, items: [...] })` を呼び出します。IEEE-754 安全整数範囲（`> 2^53 - 1`）を超える `BigInt`（配列内要素を含む）は自動的に欠損のない10進文字列へシリアライズされます。

#### グループ 4：ユーザープロファイル属性操作（`$user_*` -> StarRocks `abi.dim_users`）

14. **プロファイルの上書き設定 (`userSet`: `vip_level/city`)**
    - `sdk.userSet({ vip_level: 'diamond', city: 'Shanghai' })` を呼び出し、`$user_set` イベントで最新プロファイル属性を上書きします（注：`$user_*` イベントにはブラウザプリセット属性やパブリックプロパティは混入しません）。
15. **プロファイルの初回のみ設定 (`userSetOnce`: `first_channel`)**
    - `sdk.userSetOnce({ first_channel: 'organic_search' })` を呼び出し、対象フィールドが未設定の場合のみ書き込む `$user_set_once` イベントを生成します。
16. **数値プロファイルの加算 (`userAdd`: `loyalty_points +50`)**
    - `sdk.userAdd({ loyalty_points: 50 })` を呼び出し、数値型プロファイル属性に対してアトミック加算（負数の場合は減算）を行う `$user_add` イベントを生成します。
17. **リスト要素の追加 (`userAppend`: `interest_tags`)**
    - `sdk.userAppend({ interest_tags: ['analytics', 'starrocks'] })` を呼び出し、配列型ユーザー属性に要素を追加する `$user_append` イベントを生成します。
18. **リスト要素の重複排除追加 (`userUniqAppend`: `badges`)**
    - `sdk.userUniqAppend({ badges: ['early_adopter', 'verified_dev'] })` を呼び出し、配列型ユーザー属性に重複排除付きで要素を追加する `$user_uniq_append` イベントを生成します。
19. **指定属性の削除 (`userUnset`: `city`)**
    - `sdk.userUnset('city')` を呼び出し、指定したユーザープロファイル属性をクリアする `$user_unset` イベントを生成します。
20. **ユーザープロファイルの削除 (`userDelete` / `$user_del`)**
    - `sdk.userDelete()` を呼び出し、`abi.dim_users` 内の現在のユーザープロファイルレコードを削除マークする `$user_del` イベントを生成します。

#### グループ 5：自動計測と送信キュー制御（`$pageview` / `$AppClick` / `$AppEnd` / `flush()`）

21. **SPA ページ閲覧のシミュレート (`$pageview`)**
    - SPA のルート遷移をシミュレートし、`$pageview` イベント（`$url`、`$url_path`、`$title` 付き）を生成します。本番環境では `init({ autoTrack: { pageView: true } })` により `pushState` / `replaceState` / `popstate` / `hashchange` を自動監視できます。
22. **ボタンクリックの収集 (`$AppClick`)**
    - `data-abi-track="demo-cta"` 属性を持つボタンのクリックをシミュレートし、`$AppClick` イベント（`element_type`、`element_id`、`element_content`）を生成します。本番環境では `autoTrack: { webClick: true }` で自動収集できます。
23. **ページ離脱・滞在時間のシミュレート (`$AppEnd`)**
    - ページ非表示/終了時の `$AppEnd` 滞在時間イベント（`$duration: 12.48` 秒）をシミュレートします。本番環境で `autoTrack: { pageLeave: true }` を有効にすると、`visibilitychange` / `pagehide` 時に自動発火し、`navigator.sendBeacon` を優先して確実に配信します。
24. **送信キューの即時フラッシュ (`flush`)**
    - `await sdk.flush()` を手動実行し、メモリおよび永続化キュー内の未送信イベントを即座にゲートウェイへバッチ送信します。

---

## 二、マルチプラットフォームコードサンプル（`usage-examples.ts`）導入ガイド

[`usage-examples.ts`](./usage-examples.ts) には、外部依存ゼロで直接インポートして実行可能な3つの非同期サンプル関数が含まれており、Web、WeChat ミニプログラム、React Native の標準的な導入パターンを網羅しています。

### 1. Web SPA EC フルフロー導入（`runWebSpaEcommerceExample`）

EC サイトにおける匿名訪問から注文決済、プロファイル蓄積までの標準的な9ステップを一貫して実行します：

```ts
import { AbiWebSdk } from '@anylink/abi-web-sdk';

const sdk = new AbiWebSdk().init({
  serverUrl: 'https://ingest.abi.example.com',
  projectId: 101,
  token: 'abi_proj_token_web_ecommerce_demo',
  appVersion: '3.4.0',
  autoTrack: { pageView: true, pageLeave: true, webClick: true },
});

// 1. 訪問者 ID と静的・動的パブリックプロパティの設定
sdk.identify('visitor_web_001');
sdk.setSuperProperties({ channel: 'seo_landing', ab_group: 'checkout_one_step_v2' });
sdk.setDynamicSuperProperties(() => ({ cart_items: 2 }));

// 2. 未ログインでの商品閲覧 -> ログインによるアカウント ID 設定 (distinct_id は維持)
sdk.track('ProductView', { sku_id: 'sku_1', price: 149.75 });
sdk.login('user_10086');

// 3. 決済時間計測、固定 eventId 同日べき等送信、および 64ビット Snowflake 注文 ID の送信
sdk.timeEvent('OrderPaid');
sdk.track('CheckoutStarted', { entry_scene: 'cart_drawer' }, { eventId: 'evt_checkout_visitor_web_001' });
sdk.track('OrderPaid', {
  order_id: 9007199254740993n, // 自動的に文字列 "9007199254740993" へ安全にシリアライズ
  amount: 299.5,
  items: ['sku_1', 2, true],
}, { eventId: 'evt_order_paid_2026_001' });

// 4. 独立した精算マイルストーンイベントとユーザープロファイル蓄積
sdk.track('OrderSettled', { order_id: 9007199254740993n, amount: 279.5, status: 'settled' });
sdk.userSet({ vip_level: 'gold', city: 'Shanghai' });
sdk.userAdd({ loyalty_points: 300, total_orders: 1 });
await sdk.flush();
```

### 2. WeChat ミニプログラム / uni-app / Taro への導入（`createMiniProgramAdapter`）

ミニプログラム環境にはブラウザの `window.localStorage` や `fetch` が存在しないため、`@anylink/abi-web-sdk/adapters/miniapp` が提供する `createMiniProgramAdapter` を使用してネイティブの `wx`（または `uni` / `Taro`）オブジェクトをブリッジします：

```ts
import { AbiWebSdk } from '@anylink/abi-web-sdk';
import { createMiniProgramAdapter } from '@anylink/abi-web-sdk/adapters/miniapp';

// wx.getStorageSync / setStorageSync、wx.request、および wx.getSystemInfoSync プリセット属性 ($lib: 'abi-mp-sdk') を自動接続
const mpAdapter = createMiniProgramAdapter(wx);

export const abiMp = new AbiWebSdk().init({
  serverUrl: 'https://ingest.abi.example.com', // WeChat ミニプログラム管理画面の「request 合法ドメイン」に登録してください
  projectId: 102,
  token: 'abi_proj_token_wx_miniapp',
  appVersion: '2.1.0',
  ...mpAdapter,
});

abiMp.track('$AppStart', { path: 'pages/home/index' });
abiMp.login('wx_openid_u_8801');
abiMp.track('ShareMiniProgram', { share_target: 'moments', campaign_id: 9007199254740999n });
```

### 3. React Native モバイルアプリへの導入（`createReactNativeAdapter`）

React Native 環境には標準でグローバル `fetch` が備わっています。`@anylink/abi-web-sdk/adapters/react-native` の `createReactNativeAdapter` を使用してモバイル端末情報（`$lib: 'abi-rn-sdk'`、`$os`、`$os_version`、`$device_model`、画面サイズ）と同期永続化ストレージ（`react-native-mmkv` で実装した `AbiStorageAdapter` など）を注入します：

```ts
import { AbiWebSdk, type AbiStorageAdapter } from '@anylink/abi-web-sdk';
import { createReactNativeAdapter } from '@anylink/abi-web-sdk/adapters/react-native';

// 例：MMKV を用いて訪問者 distinct_id・login_id・オフラインイベントキューを永続化する同期ストレージアダプター
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

## 三、テスト実行とビルド検証

`test/abi-web-sdk.test.ts` には、ゴールデンテストベクター検証（ID 正規化、イベント名/プロパティ名規約、`BigInt` シリアライズ、HTTP 503 オフライン冪等リトライ）および `usage-examples.ts` の3大シナリオに対するエンドツーエンドのアサーションが含まれています。`abi.sdk/ts-web` ディレクトリで以下のコマンドを実行して検証できます：

```bash
cd abi.sdk/ts-web

# Vitest 単体テストとマルチプラットフォーム統合アサーションの実行
pnpm test

# TypeScript をコンパイルして dist/ ESM と型定義を生成（interactive-demo.html からも読み込まれます）
pnpm run build
```
