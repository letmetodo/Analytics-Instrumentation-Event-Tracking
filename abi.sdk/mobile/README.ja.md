# ABI モバイルクライアント SDK & インタラクティブ Demo ガイド (`abi.sdk/mobile`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

本ディレクトリは、ABI ユーザー行動分析（UBA）および BI プラットフォーム向けのネイティブ／クロスプラットフォーム・モバイルクライアント SDK 実装とインタラクティブ・デモ画面を提供します。収集ゲートウェイ `POST /collect/api/v1/track/batch` のプロトコル契約（デュアル ID 識別マッピング、`> 2^53 - 1` 大整数精度保護、`#time` / `$time` イベント時刻抽出、ストップウォッチ計測イベント、および `$user_*` ユーザープロファイル操作一式；*注：D7① / G6 制限により、`trackFirst` / `trackUpdate` / `trackOverwrite` は現バージョン未開放として統一*）に完全準拠しています。

## プラットフォーム別ドキュメント案内

| プラットフォーム | コア実装 & インタラクティブ Demo | 専用ドキュメント（多言語） |
|------------------|----------------------------------|----------------------------|
| **Flutter (Dart)** | [`flutter/lib/abi_sdk.dart`](flutter/lib/abi_sdk.dart) · [`flutter/example/lib/main.dart`](flutter/example/lib/main.dart) | [简体中文](flutter/README.md) \| [English](flutter/README.en.md) \| [日本語](flutter/README.ja.md) |
| **Android (Kotlin)** | [`android/AbiAnalytics.kt`](android/AbiAnalytics.kt) · [`android/example/AbiDemoActivity.kt`](android/example/AbiDemoActivity.kt) | [简体中文](android/README.md) \| [English](android/README.en.md) \| [日本語](android/README.ja.md) |
| **iOS / macOS (Swift)** | [`ios/AbiAnalytics.swift`](ios/AbiAnalytics.swift) · [`ios/example/AbiDemoViewController.swift`](ios/example/AbiDemoViewController.swift) | [简体中文](ios/README.md) \| [English](ios/README.en.md) \| [日本語](ios/README.ja.md) |

---

## 実装エンジニア視点：必須指定フィールド・SDK 自動収集フィールド・ゲートウェイ／サーバー補完フィールド（IP など）

モバイル（Flutter / Android / iOS）およびフロントエンドの実装エンジニアの視点から、すべての計測フィールドは以下の 3 つのカテゴリに整理されます：

### フィールド責務一覧表

| カテゴリ | フェーズ / フィールド名 | クライアント実装での指定 | 生成元・処理メカニズム |
|----------|-------------------------|--------------------------|------------------------|
| **第1類：実装者が【必ず明示的に渡す】必須項目** | **初期化 (`init` / `initialize`)**：`serverUrl`、`projectId` (`> 0`)、`projectToken` / `token` | **必須** | `:8081` 収集ゲートウェイ URL、プロジェクト ID（`> 0`）、非空のプロジェクトキーを指定します。 |
| | **イベント計測 (`track`)**：`eventName` | **必須** | イベント名（例：`'OrderPaid'`）。任意のカスタム属性は `properties` で渡します。 |
| | **ログイン (`login`)**：`accountId`（`login_id`） | **ログイン時に必須** | 実名ログイン完了時に `login(accountId)` でローカルに `login_id`（最大 128 UTF-8 バイト）を設定・永続化します（`distinct_id` は上書きせず、ネットワークイベントも発火しません）。`logout()` で `login_id` をクリアします。 |
| | **イベント更新・上書き (`trackUpdate` / `trackOverwrite`)**：`eventId` | **現バージョン未開放** | D7① / G6 制限により、現行の StarRocks `dwd_events` モデルでは `trackFirst` / `trackUpdate` / `trackOverwrite` は未開放です。 |
| **第2類：SDK が【自動生成・永続化】し、手動入力不要な項目** | `distinct_id` | **自動生成（入力不要）** | 初期化時に UUIDv4 を自動生成してローカルストレージの `distinct_id` キー（`localStorage` / `SharedPreferences` / `UserDefaults`）へ永続化します。`identify(distinctId)` のみで更新され、`login` では上書きされません。 |
| | `event_id` | **自動生成（入力不要）** | `track` ごとに UUIDv4 を自動生成し、弱電波・オフライン再送時も同一 ID を維持して冪等性を保証します。 |
| | `timestamp` | **自動生成（入力不要）** | クライアントの現在ミリ秒タイムスタンプを自動取得します（`#time` / `$time` で過去イベント時刻を明示した場合を除く）。 |
| | 端末・環境プリセット属性：`$lib`、`$lib_version`、`$os`、`$os_version`、`$device_model`、`$screen_width`、`$screen_height`、`$url`、`$title`、`$referrer`、`$zone_offset` | **自動収集（入力不要）** | SDK が自動的に取得・付与します（`$user_*` プロファイル操作では自動的に分離されます）。 |
| **第3類：クライアントでは【取得不可・指定不要】で、ゲートウェイ／サーバーが補完する項目** | **グローバル IP と地域情報 (`#ip` / `$ip` $\rightarrow$ 国・都道府県・市区町村)** | **クライアントでの指定厳禁** | クライアントが `:8081` ゲートウェイへ直接通信する場合、ゲートウェイが HTTP 接続（および `X-Forwarded-For` / `X-Real-IP`）から実際のクライアント IP を抽出し、Flink が国・地域・都市を自動解析します。 |

### 3つのカテゴリの詳細とフロント・バックエンド連携のベストプラクティス

1. **第1類：実装者が【必ず明示的に渡す】必須項目**
   - **初期化フェーズ (`init` / `initialize`)**：`serverUrl`（収集ゲートウェイアドレス）、`projectId`（`> 0`）、`token` / `projectToken`（非空のプロジェクトキー）。
   - **イベント送信フェーズ (`track`)**：`eventName`（必須、例：`'OrderPaid'`）。
   - **アカウントログインフェーズ (`login`)**：ユーザーが実名ログインを完了した際に `accountId`（すなわち `login_id`）を渡します。ローカル状態を更新するのみで（`distinct_id` を上書きせず追加イベントも送信しません）、以降のイベントに `distinct_id` と `login_id` の両方が付与されます。
   - **同日リトライ冪等キー (`track` の任意 `eventId`)**：同日再送時の重複排除が必要な場合は `track` に固定 `eventId` を渡します（D7① / G6 制限により、現バージョンでは `trackFirst` / `trackUpdate` / `trackOverwrite` は未開放です）。
2. **第2類：SDK が【自動生成・永続化】し、フロントエンド／クライアント開発者が【手動入力不要】なフィールド**
   - **`distinct_id`（ゲスト／デバイス ID）**：初期化時に UUIDv4 を自動生成してローカルストレージの `distinct_id` キー（`localStorage` / `SharedPreferences` / `UserDefaults`、最大 64 UTF-8 バイト）に永続化します。`login()` を呼んでも `distinct_id` は保持されます。
   - **`event_id`**：`track` 呼び出しごとに UUIDv4 を自動生成し、弱電波やオフライン再送時にも同一値を維持して冪等性を保ちます。
   - **`timestamp`**：クライアントの現在ミリ秒タイムスタンプを自動採用します（`#time` / `$time` で過去イベント時刻を明示的に指定した場合を除く）。
   - **端末・環境プリセット属性**：`$lib`、`$lib_version`、`$os`、`$os_version`、`$device_model`、`$screen_width`、`$screen_height`、`$url`、`$title`、`$referrer`、`$zone_offset`。
3. **第3類：クライアントでは【取得できず送信も不要】で、収集ゲートウェイ／サーバー側が取得するフィールド（重要：`IP` とフロント・バックエンド連携）**
   - **グローバル IP と地域情報 (`#ip` / `$ip` $\rightarrow$ 国／都道府県／市区町村)**：ブラウザ JS、ミニプログラム、モバイル App はクライアントサンドボックスおよび NAT ルーター配下で動作するため、**自身のパブリック出口 IP を直接取得することはできません。したがって、クライアント実装時に `$ip` / `#ip` を渡す必要は一切ありません**。クライアントが `:8081` 収集ゲートウェイに直接送信すれば、ゲートウェイが HTTP 接続（および Nginx/SLB の `X-Forwarded-For` / `X-Real-IP`）から実際のクライアント IP を自動抽出し、Flink が国・都道府県・市区町村を自動解決します。
   - **注意：いつ IP を渡す必要があるのか？** 「クライアントがまず自社バックエンド API を呼び出し、Go/Java サーバーサイド SDK が代わってイベントを代理送信する」構成を採用している場合のみ、ゲートウェイからはバックエンドサーバーのデータセンター IP に見えるため、バックエンド側でクライアントリクエストから IP を抽出して `#ip` / `$ip` としてサーバー SDK に渡す必要があります。あわせて、モバイル／フロントエンドからバックエンド API を呼び出す際はリクエストヘッダーにゲスト識別子 `distinct_id`（Flutter `sdk.distinctId` / Android `sdk.distinctId` / iOS `sdk.distinctId` / Web `abi.getDistinctId()`）を付与し、クライアントとサーバー間のファネルを紐付けることを推奨します。

---

すべてのモバイル UI デモおよびヘッドレス（UI なし）メソッドレベル・デモは、Web 版 [`../ts-web/examples/interactive-demo.html`](../ts-web/examples/interactive-demo.html) と完全に一致する**2ステップ連携インタラクション契約**を採用しています（履歴イベントログが無限に追記されて画面が埋まる問題を完全に排除）：

1. **ステップ 1：パラメータを設定し、送信予定の単一リクエスト JSON をその場でリアルタイムプレビュー**
   - 初期化時に `autoFlush = false` を設定し、バックグラウンドタイマーと `batchSize` 自動送信を無効化します。
   - ID の切り替え（`identify` / `login` / `logout`）や静的・動的共通プロパティの変更時には、送信待ちキューを自動的にクリアして現在の送信予定イベントの JSON ペイロードを再計算し、単一のプレビュー枠をその場で更新します（履歴ログの追記は一切行いません）。
   - 単一イベントの上書きプレビューと **「複数イベント一括（バッチ）モード」**（オンにすると複数回タップしたイベントを同一リクエストの `events` 配列に追加）の両方をサポートします。
2. **ステップ 2：「確認して送信（确认提交）」ボタンをタップして送信し、単一のレスポンスを確認**
   - 明示的に **「确认提交（確認して送信）」** メインボタンをタップした時のみ `flush()` を呼び出して `POST /collect/api/v1/track/batch` を送信し、下部のレスポンスパネルに直近 1 回の HTTP ステータスとゲートウェイ応答を表示します。

> **ミニプログラム & React Native について**：WeChat ミニプログラム用アダプタ（[`../ts-web/src/adapters/miniapp.ts`](../ts-web/src/adapters/miniapp.ts)）および React Native 用アダプタ（[`../ts-web/src/adapters/react-native.ts`](../ts-web/src/adapters/react-native.ts)）は TypeScript コアのバリデーションおよび永続化キューエンジンを共有しています。使用例は [`../ts-web/examples/usage-examples.ts`](../ts-web/examples/usage-examples.ts) を参照してください。

---

## 1. ディレクトリ構成

```text
abi.sdk/mobile/
├── README.md                                 # モバイル SDK & 2ステップ Demo ガイド（簡体字中国語）
├── README.en.md                              # モバイル SDK & 2ステップ Demo ガイド（英語）
├── README.ja.md                              # モバイル SDK & 2ステップ Demo ガイド（日本語・本書）
├── flutter/
│   ├── README.md / README.en.md / README.ja.md
│   ├── lib/abi_sdk.dart                      # Flutter / Dart コア SDK（AbiConfig、AbiAnalytics）
│   └── example/lib/main.dart                 # Material 3 パラメータ設定 + JSON プレビュー + 送信確認デモ画面
├── android/
│   ├── README.md / README.en.md / README.ja.md
│   ├── AbiAnalytics.kt                       # Android Kotlin サードパーティ依存ゼロのコア SDK
│   └── example/AbiDemoActivity.kt            # ネイティブ ScrollView 2ステップデモ画面 & ヘッドレス検証メソッド
└── ios/
    ├── README.md / README.en.md / README.ja.md
    ├── AbiAnalytics.swift                    # iOS / macOS Swift スレッドセーフ・コア SDK
    └── example/AbiDemoViewController.swift   # SwiftUI 2ステップデモビュー & AbiSdkDemoRunner
```

---

## 2. コアプレビューおよび手動送信制御 API

3 つのプラットフォームの SDK はすべて、本番環境ではデフォルトで `autoFlush = true`（周期タイマー＋閾値による自動バッチ送信）となります。インタラクティブな結合テストやペイロード検証時には、`autoFlush` を `false` に設定することで、キュープレビュー API と組み合わせて完全なリクエストボディを事前に検査できます。

| プラットフォーム | 自動送信の無効化設定 | 送信待ちキューのクリア | 完全な `POST /collect/api/v1/track/batch` ペイロード構築 | 手動での送信確定 |
|------------------|----------------------|------------------------|----------------------------------------------------------|------------------|
| **Flutter** | `AbiConfig(..., autoFlush: false)` | `sdk.clearPendingQueue()` | `sdk.buildPendingBatchPayload()` (`Map<String, dynamic>`) | `await sdk.flush()` |
| **Android Kotlin** | `AbiAnalytics.init(..., autoFlush = false)` | `sdk.clearPendingQueue()` | `sdk.buildPendingBatchPayload()` (`JSONObject`) | `sdk.flush()` |
| **iOS Swift** | `sdk.initialize(..., autoFlush: false)` | `sdk.clearPendingQueue()` | `sdk.buildPendingBatchPayload()` / `sdk.buildPendingBatchJsonString()` | `sdk.flush(completion:)` |

---

## 3. 3 プラットフォームのインタラクティブ UI Demo 詳細

3 つのクライアント UI Demo はすべて **「上部の 4 つのパラメータ設定セクション ＋ 下部の 2 パネル（パネル A：送信予定リクエスト JSON プレビュー ／ パネル B：直近の送信結果 Response）」** という統一レイアウトを採用しています。

### 3.1 Flutter インタラクティブ Demo（[`flutter/example/lib/main.dart`](flutter/example/lib/main.dart)）

- **上部パラメータ設定エリア**：
  - **ステータス概要カード**：`distinct_id`（ゲスト ID）、`login_id`（ログインアカウント ID）、`superProperties`、および動的共通プロパティの有効状態をリアルタイム表示します。
  - **`1. ID・セッションパラメータ`**：`ランダムなゲスト ID 切替 (identify)`、`ログインアカウント設定 (login)`、`ログアウト (logout)`（ローカル状態のみを更新し、プレビュー JSON を即座に再計算）。
  - **`2. 共通プロパティ設定`**：編集可能な静的共通プロパティ JSON `TextField` ＋ `静的共通プロパティを適用` ＋ `動的共通プロパティ：ON/OFF` ＋ `共通プロパティをクリア`（変更後は送信予定リクエスト JSON のみをその場で再計算し、履歴ログは追加しません）。
  - **「複数イベント一括モード」スイッチ**（`SwitchListTile`）：OFF の場合はボタンをタップするたびに現在の単一イベントのみをプレビューし、ON の場合は連続タップで `events` 配列に追記します。
  - **`3. 行動イベントパラメータ構築`**：`商品閲覧イベント (ProductView)`、`① イベント計測開始 (timeEvent)`、`② 決済イベント送信 ($duration)`、`64 bit Snowflake 大整数 (> 2^53-1)`、`固定 eventId 冪等イベント (OrderSettled)`。
  - **`4. ユーザープロファイル操作構築 ($user_*)`**：`userSet`、`userSetOnce`、`userAdd (+100)`、`userAppend`、`userUniqAppend`、`userUnset`、`userDelete`（共通プロパティを自動分離）。
- **下部固定デュアルパネル**：
  - **パネル A：`送信予定リクエスト JSON プレビュー (POST /collect/api/v1/track/batch)`**：完全な `{ project_id, project_token, dry_run, events }` ペイロードを整形表示し、`パラメータをリセット` と目立つ **「确认提交（確認して送信）」** メインボタンを備えています。
  - **パネル B：`直近の送信結果 (Response)`**：「确认提交」をタップして `await _sdk.flush()` が実行された後にのみ、単一の HTTP ステータスとゲートウェイ応答を更新します。

---

### 3.2 Android Kotlin インタラクティブ Demo（[`android/example/AbiDemoActivity.kt`](android/example/AbiDemoActivity.kt)）

- **XML 依存ゼロの純粋な Kotlin コード**：ネイティブの `ScrollView` + `LinearLayout` で構築されており、任意の Android プロジェクトにコピーするだけでそのまま実行可能です（デフォルトゲートウェイ `http://10.0.2.2:8081`）。
- **パラメータ構築とインプレース・プレビュー**：
  - ID 設定ボタングループ、静的共通プロパティ JSON `EditText`（`静的共通プロパティを適用` / `動的共通プロパティ：ON/OFF` / `共通プロパティをクリア`）、`CheckBox("複数イベント一括モード")`、6 つの行動イベント構築ボタン、7 つの `$user_*` プロファイル構築ボタンを提供。
  - パラメータ変更時には常に `sdk.buildPendingBatchPayload().toString(2)` を呼び出し、単一の **パネル A：送信予定リクエスト JSON プレビュー** `TextView` をその場で更新します。
- **送信確認と単一レスポンス**：
  - **「确认提交（確認して送信）」** ボタンをタップするとワーカースレッドで `sdk.flush()` を実行し、完了後にメインスレッドで単一の **パネル B：直近の送信結果** `TextView` を更新します。

---

### 3.3 iOS Swift インタラクティブ Demo（[`ios/example/AbiDemoViewController.swift`](ios/example/AbiDemoViewController.swift)）

- **クロスプラットフォーム SwiftUI ビュー（`AbiSdkDemoView`、iOS 15.0+ / macOS 12.0+ 対応）**：
  - 上部のリアルタイム ID・共通プロパティステータスボード、`1. ID・セッションパラメータ`、JSON エディタ付きの `2. 共通プロパティ設定`、`複数イベント一括モード` `Toggle`、`3. 行動イベントパラメータ構築`、`4. ユーザープロファイル操作構築 ($user_*)` を搭載。
  - 共通プロパティの変更、ID の切り替え、イベントボタンのタップのたびに `sdk.buildPendingBatchJsonString()` を呼び出し、単一の **パネル A：送信予定リクエスト JSON プレビュー** 等幅コードボックスをその場で更新します。
  - 緑色の **「确认提交（確認して送信）」** ボタンをタップすると `sdk.flush { statusCode, rawBody in ... }` を実行し、レスポンス返却後に下部の **パネル B：直近の送信結果** を更新します。

---

## 4. 2ステップ・ヘッドレス（UI なし）メソッドレベル Demo（JSON プレビュー構築 -> 送信確定）

ユニットテスト、CI パイプライン、または CLI スクリプトでの検証向けに、3 プラットフォームすべてで統一された 2 ステップのメソッド入口を提供しています：**まず具体的な送信予定リクエスト JSON を生成・検査し、次に明示的に送信確定を呼び出します**。

### 4.1 Flutter (`previewScenarioPayload` + `confirmSubmit`)
```dart
import 'package:your_app/abi_sdk.dart';

Future<void> verifyAbiFlutterSdk() async {
  final sdk = AbiAnalytics.instance;

  // ステップ 1：全シナリオのパラメータを構築し、完全な POST /collect/api/v1/track/batch リクエスト JSON をプレビュー
  final requestJson = sdk.previewScenarioPayload(
    serverUrl: 'http://localhost:8081',
    projectId: 1,
    projectToken: 'abi_tok_demo_flutter',
    dryRun: true,
  );
  print('送信予定リクエスト JSON:\n$requestJson');

  // ステップ 2：送信を確定し、単一のレスポンス結果を確認
  final ok = await sdk.confirmSubmit();
  print('送信結果: ok=$ok, status=${sdk.lastStatusCode}, body=${sdk.lastResponseBody}');
}
```

### 4.2 Android Kotlin (`AbiDemoActivity.previewScenarioPayload` + `confirmSubmit`)
```kotlin
import com.anylink.abi.sdk.android.AbiAnalytics
import com.anylink.abi.sdk.android.example.AbiDemoActivity

val sdk = AbiAnalytics.init(
    serverUrl = "http://10.0.2.2:8081",
    projectId = 1L,
    projectToken = "abi_tok_android_demo",
    autoFlush = false
)

// ステップ 1：デュアル ID、共通プロパティ、計測イベント、>2^53-1 大整数、固定 eventId マイルストーンイベント、$user_* のリクエストボディを構築してプレビュー
val requestJson: String = AbiDemoActivity.previewScenarioPayload(sdk)
println("送信予定リクエスト JSON:\n$requestJson")

// ステップ 2：ワーカースレッドで送信を確定し、単一のレスポンス要約 JSON を取得
val responseSummaryJson: String = AbiDemoActivity.confirmSubmit(sdk)
println("直近の送信結果:\n$responseSummaryJson")
```

### 4.3 iOS Swift (`AbiSdkDemoRunner.previewScenarioJson` + `confirmSubmit`)
```swift
// ステップ 1：autoFlush = false で整形済みの送信予定リクエスト JSON 文字列を構築・取得
let requestJson = AbiSdkDemoRunner.previewScenarioJson(
    serverUrl: "http://localhost:8081",
    projectId: 1,
    projectToken: "abi_tok_ios_demo"
)
print("送信予定リクエスト JSON:\n\(requestJson)")

// ステップ 2：送信を確定し、単一の HTTP レスポンスコールバックを受信
AbiSdkDemoRunner.confirmSubmit { statusCode, responseBody in
    print("送信完了: HTTP \(statusCode), レスポンス: \(responseBody)")
}
```

---

## 5. ホストプロジェクトへの組み込み手順とローカル検証

### 5.1 事前準備：ローカル収集ゲートウェイの起動（任意）
エンドツーエンドの実際の HTTP 200 レスポンスを検証する場合は、リポジトリルートで `abi.srv` 収集ゲートウェイ（`:8081`）を起動します：
```bash
cd abi.srv && ENV=dev go run ./cmd/gateway/
```
> ローカルで `:8081` ゲートウェイを起動していない場合でも、各 SDK は接続エラーを安全にキャッチしてイベントをメモリキュー内に保持し（べき等リトライ用に元の `event_id` を維持）、「直近の送信結果」パネルに未接続状態を分かりやすく表示します。

### 5.2 Flutter ホストプロジェクトへの組み込み手順
1. [`flutter/lib/abi_sdk.dart`](flutter/lib/abi_sdk.dart) をホスト Flutter プロジェクトの `lib/` ディレクトリにコピーします（純粋な Dart 標準ライブラリ実装であり、外部プラグイン依存はゼロです）。
2. インタラクティブ Demo 画面をマウントする場合は、[`flutter/example/lib/main.dart`](flutter/example/lib/main.dart) の `const AbiSdkDemoApp()` をエントリー画面としてマウントし、`import` パスをホスト内の `abi_sdk.dart` に合わせます。
3. ネットワーク設定のヒント：iOS シミュレータや macOS デスクトップからは `http://localhost:8081` に直接アクセスできます。Android エミュレータの場合は `serverUrl` を `http://10.0.2.2:8081` に変更してください。API の詳細は [`flutter/README.ja.md`](flutter/README.ja.md) を参照してください。

### 5.3 Android Kotlin ホストプロジェクトへの組み込み手順
1. [`android/AbiAnalytics.kt`](android/AbiAnalytics.kt)（および任意のデモ画面 [`android/example/AbiDemoActivity.kt`](android/example/AbiDemoActivity.kt)）をホスト App モジュールのソースパッケージパス（`com.anylink.abi.sdk.android`）にコピーします。
2. `AndroidManifest.xml` でインターネット権限を宣言します。ローカルの平文 HTTP ゲートウェイ（`http://10.0.2.2:8081`）と通信する場合は、開発環境で平文通信を許可し、`AbiDemoActivity` を登録してください：
   ```xml
   <uses-permission android:name="android.permission.INTERNET" />

   <application
       android:usesCleartextTraffic="true"
       ...>
       <activity
           android:name="com.anylink.abi.sdk.android.example.AbiDemoActivity"
           android:exported="true" />
   </application>
   ```
3. 本番環境では `Application.onCreate()` 内で `AbiAnalytics.init(...)`（デフォルト `autoFlush = true`）を呼び出します。インタラクティブ検証画面は `Intent(context, AbiDemoActivity::class.java)` で開けます。API の詳細は [`android/README.ja.md`](android/README.ja.md) を参照してください。

### 5.4 iOS Swift ホストプロジェクトへの組み込み手順と静的コンパイル検証
1. [`ios/AbiAnalytics.swift`](ios/AbiAnalytics.swift)（および任意のデモビュー [`ios/example/AbiDemoViewController.swift`](ios/example/AbiDemoViewController.swift)）を Xcode ターゲットの `Compile Sources` に追加します。
2. シミュレータまたは実機からローカル HTTP ゲートウェイ（`http://localhost:8081`）に接続する場合は、開発用 `Info.plist` の `NSAppTransportSecurity` 配下で `NSAllowsLocalNetworking = YES` を有効にします。
3. SwiftUI エントリーポイントで `AbiSdkDemoView()` を直接マウントします（UIKit プロジェクトでは `UIHostingController(rootView: AbiSdkDemoView())` で表示可能）。API の詳細は [`ios/README.ja.md`](ios/README.ja.md) を参照してください。
4. **コマンドラインでの静的型チェック検証**：Xcode を開かずに macOS ターミナルから `swiftc` を直接実行し、SDK と SwiftUI Demo がエラーゼロで通過することを検証できます：
   ```bash
   swiftc -typecheck abi.sdk/mobile/ios/AbiAnalytics.swift abi.sdk/mobile/ios/example/AbiDemoViewController.swift
   ```
