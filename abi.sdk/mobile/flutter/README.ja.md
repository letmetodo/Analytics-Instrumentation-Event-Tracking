# ABI Flutter / Dart クライアント SDK ドキュメント (`abi.sdk/mobile/flutter`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

[`lib/abi_sdk.dart`](lib/abi_sdk.dart) は、Flutter クロスプラットフォーム（モバイルおよびデスクトップ）アプリケーション向けのサードパーティ依存ゼロのデータ収集・分析 SDK です。純粋な Dart 標準ライブラリ（`dart:async`、`dart:convert`、`dart:io`、`dart:math`）のみで実装されており、ABI 収集ゲートウェイ `POST /collect/api/v1/track/batch` のプロトコル契約および ThinkingData v3.4 仕様に完全準拠しています。

> モバイル SDK 総覧へ戻る：[简体中文](../README.md) | [English](../README.en.md) | [日本語](../README.ja.md)

---

## 実装エンジニア視点：必須指定フィールド・SDK 自動収集フィールド・ゲートウェイ／サーバー補完フィールド（IP など）

Flutter クライアント実装エンジニアの視点から、すべての計測フィールドは以下の 3 つのカテゴリに分類されます：

| カテゴリ | フェーズ / フィールド名 | クライアント実装での指定 | 生成元・処理メカニズム |
|----------|-------------------------|--------------------------|------------------------|
| **第1類：実装者が【必ず明示的に渡す】必須項目** | **初期化 (`init` / `initialize`)**：`serverUrl`、`projectId` (`> 0`)、`projectToken` / `token` | **必須** | `AbiConfig` で `:8081` 収集ゲートウェイ URL、プロジェクト ID（`> 0`）、非空のプロジェクトキーを指定します。 |
| | **イベント計測 (`track`)**：`eventName` | **必須** | イベント名（例：`'OrderPaid'`）。任意のカスタム属性は `properties` で渡します。 |
| | **ログイン (`login`)**：`accountId`（`login_id`） | **ログイン時に必須** | 実名ログイン完了時に `login(accountId)` でローカルに `login_id`（最大 128 UTF-8 バイト）を設定します（`distinct_id` は上書きせず、ネットワークイベントも発火しません）。 |
| | **イベント更新・上書き (`trackUpdate` / `trackOverwrite`)**：`eventId` | **現バージョン未開放** | D7① / G6 制限により、現行の StarRocks `dwd_events` モデルでは `trackFirst` / `trackUpdate` / `trackOverwrite` は未開放です。 |
| **第2類：SDK が【自動生成・永続化】し、手動入力不要な項目** | `distinct_id` | **自動生成（入力不要）** | 初期化時に UUIDv4 を自動生成します（永続化コールバック指定時は `distinct_id` キーに保存）。`identify` のみで更新され、`login` では上書きされません。 |
| | `event_id` | **自動生成（入力不要）** | `track` ごとに UUIDv4 を自動生成し、弱電波・オフライン再送時も同一 ID を維持して冪等性を保証します。 |
| | `timestamp` | **自動生成（入力不要）** | クライアントの現在ミリ秒タイムスタンプを自動取得します（`#time` / `$time` で過去イベント時刻を明示した場合を除く）。 |
| | 端末・環境プリセット属性：`$lib`、`$lib_version`、`$os`、`$os_version`、`$device_model`、`$screen_width`、`$screen_height`、`$url`、`$title`、`$referrer`、`$zone_offset` | **自動収集（入力不要）** | SDK が自動的に取得・付与します（`$user_*` プロファイル操作では自動的に分離されます）。 |
| **第3類：クライアントでは【取得不可・指定不要】で、ゲートウェイ／サーバーが補完する項目** | **グローバル IP と地域情報 (`#ip` / `$ip` $\rightarrow$ 国・都道府県・市区町村)** | **クライアントでの指定厳禁** | クライアントが `:8081` ゲートウェイへ直接通信する場合、ゲートウェイが HTTP 接続（および `X-Forwarded-For` / `X-Real-IP`）から実際のクライアント IP を抽出し、Flink が国・地域・都市を自動解析します。 |

1. **第1類：実装者が【必ず明示的に渡す】必須項目**
   - **初期化フェーズ (`init` / `initialize`)**：`serverUrl`（収集ゲートウェイアドレス）、`projectId`（`> 0`）、`token` / `projectToken`（非空のプロジェクトキー）。
   - **イベント送信フェーズ (`track`)**：`eventName`（必須、例：`'OrderPaid'`）。
   - **アカウントログインフェーズ (`login`)**：ユーザーが実名ログインを完了した際に `accountId`（すなわち `login_id`）を渡します。ローカルで `login_id` を更新し（`distinct_id` は上書きせず追加イベントも送信しません）、以降のイベントに `distinct_id` と `login_id` が付与されます。
   - **同日リトライ冪等キー (`track` の任意 `eventId`)**：同日再送時の重複排除が必要な場合は `track` に固定 `eventId` を渡します（D7① / G6 制限により、現バージョンでは `trackFirst` / `trackUpdate` / `trackOverwrite` は未開放です）。
2. **第2類：SDK が【自動生成・永続化】し、フロントエンド／クライアント開発者が【手動入力不要】なフィールド**
   - **`distinct_id`（ゲスト／デバイス ID）**：初期化時に UUIDv4 を自動生成し、任意の `storageRead` / `storageWrite` によって `distinct_id` キー（最大 64 UTF-8 バイト）に永続化できます。`login()` で上書きされることはありません。
   - **`event_id`**：`track` 呼び出しごとに UUIDv4 を自動生成し、弱電波やオフライン再送時にも同一値を維持して冪等性を保ちます。
   - **`timestamp`**：クライアントの現在ミリ秒タイムスタンプを自動採用します（`#time` / `$time` で過去イベント時刻を明示的に指定した場合を除く）。
   - **端末・環境プリセット属性**：`$lib`、`$lib_version`、`$os`、`$os_version`、`$device_model`、`$screen_width`、`$screen_height`、`$url`、`$title`、`$referrer`、`$zone_offset`。
3. **第3類：クライアントでは【取得できず送信も不要】で、収集ゲートウェイ／サーバー側が取得するフィールド（重要：`IP` とフロント・バックエンド連携）**
   - **グローバル IP と地域情報 (`#ip` / `$ip` $\rightarrow$ 国／都道府県／市区町村)**：ブラウザ JS、ミニプログラム、モバイル App はクライアントサンドボックスおよび NAT ルーター配下で動作するため、**自身のパブリック出口 IP を直接取得することはできません。したがって、クライアント実装時に `$ip` / `#ip` を渡す必要は一切ありません**。クライアントが `:8081` 収集ゲートウェイに直接送信すれば、ゲートウェイが HTTP 接続（および Nginx/SLB の `X-Forwarded-For` / `X-Real-IP`）から実際のクライアント IP を自動抽出し、Flink が国・都道府県・市区町村を自動解決します。
   - **注意：いつ IP を渡す必要があるのか？** 「クライアントがまず自社バックエンド API を呼び出し、Go/Java サーバーサイド SDK が代わってイベントを代理送信する」構成を採用している場合のみ、ゲートウェイからはバックエンドサーバーのデータセンター IP に見えるため、バックエンド側でクライアントリクエストから IP を抽出して `#ip` / `$ip` としてサーバー SDK に渡す必要があります。あわせて、モバイルからバックエンド API を呼び出す際はリクエストヘッダーにゲスト ID（`sdk.distinctId`）を付与し、クライアントとサーバー間のファネルを紐付けることを推奨します。

---

## 1. 組み込み方法と環境設定

### 1.1 純粋な Dart によるゼロ依存での導入
1. [`lib/abi_sdk.dart`](lib/abi_sdk.dart) をホスト Flutter プロジェクトの `lib/` ディレクトリに直接コピーします（`pubspec.yaml` に外部の HTTP パッケージやデバイスプラグインを追加する必要はありません）。
2. イベント計測を行うコードでインポートします：
   ```dart
   import 'package:your_app/abi_sdk.dart';
   ```
3. インタラクティブ検証画面を利用する場合は、[`example/lib/main.dart`](example/lib/main.dart) をプロジェクトにコピーし、`const AbiSdkDemoApp()` をマウントします。

### 1.2 実行環境別のネットワーク・ゲートウェイ接続先設定
- **iOS シミュレータ / macOS デスクトップ**：`serverUrl` にホストマシンのローカルゲートウェイ `http://localhost:8081` をそのまま指定できます。
- **Android エミュレータ**：Android エミュレータ内の `localhost` はエミュレータ自身を指すため、ホスト側の `:8081` ゲートウェイへ接続するには `serverUrl` を `http://10.0.2.2:8081` に設定してください。
- **iOS / Android 実機検証**：`serverUrl` を開発マシンの LAN IP（例：`http://192.168.1.x:8081`）に設定し、開発ビルドで平文 HTTP 通信を許可してください（Android `usesCleartextTraffic="true"` / iOS `NSAllowsLocalNetworking = YES`）。

---

## 2. 初期化とコア API クイックリファレンス

### 2.1 SDK の初期化 (`AbiConfig` & `AbiAnalytics.instance.init`)

```dart
final sdk = AbiAnalytics.instance;

sdk.init(const AbiConfig(
  serverUrl: 'http://localhost:8081', // Android エミュレータでは http://10.0.2.2:8081 を使用
  projectId: 1,
  projectToken: 'abi_tok_demo_project_1',
  appVersion: '2.1.0',
  batchSize: 20,
  flushInterval: Duration(seconds: 5),
  debug: false,
  dryRun: false,     // true の場合、ゲートウェイはスキーマ検証のみを行い Kafka/StarRocks への保存をスキップ
  autoFlush: true,   // 本番環境のデフォルトは true。2ステップ・プレビュー時は false に設定
));
```

| `AbiConfig` パラメータ | 型 | デフォルト値 | 説明 |
|------------------------|------|--------------|------|
| `serverUrl` | `String` | 必須 | 収集ゲートウェイのベース URL（`/collect/api/v1/track/batch` を自動付与） |
| `projectId` | `int` | 必須 | ABI プロジェクト ID (`project_id`) |
| `projectToken` | `String` | 必須 | プロジェクトアクセストークン (`project_token`) |
| `appVersion` | `String` | `'1.0.0'` | アプリバージョン（プリセット属性 `$app_version` に自動注入） |
| `batchSize` | `int` | `20` | 自動バッチ送信をトリガーするキュー件数の閾値 |
| `flushInterval` | `Duration` | `Duration(seconds: 5)` | バックグラウンド定期フラッシュの間隔 |
| `debug` | `bool` | `false` | デバッグ即時送信モード（`track` 呼び出しごとに即時送信） |
| `dryRun` | `bool` | `false` | ゲートウェイ `dry_run` 検証モード（フォーマット検証のみで保存しない） |
| `autoFlush` | `bool` | `true` | バックグラウンド定期送信および閾値自動送信の有効化（`false` の場合は手動で `flush()` を呼ぶ） |

---

### 2.2 デュアル ID 識別管理 (`identify` / `login` / `logout`)

SDK は ThinkingData 仕様に完全準拠しており、送信イベントには `distinct_id`（ゲスト／デバイス ID、最大 64 UTF-8 バイト）と `login_id`（ログインアカウント ID、最大 128 UTF-8 バイト）の 2 つのみを格納します：
- `distinctId`：ゲスト／デバイス識別子（初期化時に UUIDv4 を自動生成し、`AbiConfig.storageRead` / `storageWrite` 指定時は `distinct_id` キーに永続化）。
- `loginId`：ログインアカウント識別子（未ログイン時は空文字列 `''`）。
- `identify(String distinctId)`：カスタムゲスト／デバイス ID をローカルで更新します（非空・制御文字なし・最大 64 UTF-8 バイトを自動検証。ネットワークイベントは送信しません）。
- `login(String accountId)`：ログインアカウント ID（最大 128 UTF-8 バイト）をローカルに設定します（**`distinctId` を上書きせず、ネットワークイベントも一切送信しません**。戻り値は `void`）。
- `logout()`：`loginId` をローカルでクリアし、`distinctId` はそのまま保持します（ネットワークイベントは送信しません）。

```dart
sdk.identify('flutter_visitor_device_001');
sdk.login('acct_flutter_10001'); // ローカル状態の更新のみ（ネットワークイベント送信なし）
print('distinctId: ${sdk.distinctId}, loginId: ${sdk.loginId}');
sdk.logout();
```

---

### 2.3 静的および動的共通プロパティ (`Super Properties`)

共通プロパティは以降のすべての行動イベントおよびシステムイベントに自動マージされます（**`$user_*` / `#user_*` ユーザープロファイルイベントからは自動的に除外されます**）。優先順位は `単一イベントの properties > 動的共通プロパティ > 静的共通プロパティ > SDK プリセット属性` です。

| メソッドシグネチャ | 説明 |
|--------------------|------|
| `setSuperProperties(Map<String, dynamic> props)` | グローバルな静的共通プロパティを登録・マージ |
| `unsetSuperProperty(String key)` | 指定したキーの静的共通プロパティを削除 |
| `clearSuperProperties()` | 登録済みのすべての静的共通プロパティをクリア |
| `getSuperProperties()` | 現在の静的共通プロパティのシャローコピー `Map<String, dynamic>` を取得 |
| `setDynamicSuperProperties(Map<String, dynamic> Function()? fn)` | `track` 呼び出し時に毎回評価される動的共通プロパティコールバックを登録（`null` で解除） |

```dart
sdk.setSuperProperties({'channel': 'AppStore', 'ab_group': 'checkout_v2'});
sdk.unsetSuperProperty('ab_group');
final currentStaticProps = sdk.getSuperProperties();

sdk.setDynamicSuperProperties(() => {
  'network_state': 'wifi',
  'dyn_sequence': 1,
});
```

---

### 2.4 イベント時間計測と同日べき等イベント収集 (`timeEvent` / `track`)

- **ストップウォッチ時間計測 (`timeEvent`)**：`sdk.timeEvent('OrderPaid')` で高精度 `Stopwatch` を開始し、次回同名の `sdk.track('OrderPaid', ...)` 呼び出し時に経過秒数（小数点以下 3 桁）を `$duration` プロパティとして自動付与します。
- **通常イベント (`track`)**：カスタムイベントまたはシステムイベントをエンキューし、正規化されたべき等 `event_id`（デフォルトは UUID v4）を返します。同日同一ペイロード再送時の重複排除には固定 `eventId` を明示指定できます。
- **未開放 API の制限 (`trackFirst` / `trackUpdate` / `trackOverwrite`)**：D7① / G6 制限により、現行の StarRocks `dwd_events` モデルでは `$first_check_id` 初回重複排除および `trackUpdate` / `trackOverwrite` は未開放です（呼び出すと `UnsupportedError` をスローし、擬似 `track` イベントは一切エンキューされません）。ステータス遷移は個別のマイルストーンイベントとして記録してください。

```dart
// 1. ストップウォッチ計測と通常イベントの記録
sdk.timeEvent('OrderPaid');
final orderEvtId = sdk.track(
  'OrderPaid',
  properties: {
    'order_id': 'ord_20261110_01',
    'amount': 299.0,
  },
);

// 2. 同日固定 eventId マイルストーンイベント（同一ペイロード再送時にべき等重複排除）
sdk.track(
  'OrderSettled',
  properties: {
    'order_id': 'ord_20261110_01',
    'order_status': 'settled',
    'amount': 299.0,
  },
  eventId: 'ord_settled_20261110_01',
);
```

---

### 2.5 7 種類のユーザープロファイル操作 (`$user_*`)

すべてのユーザープロファイル操作は StarRocks の `abi.dim_users` ディメンションテーブルに対応しており、SDK は**プリセットシステム属性および静的・動的共通プロパティを自動的に分離**します：

| メソッドシグネチャ | 対応システムイベント | 説明 |
|--------------------|----------------------|------|
| `userSet(Map<String, dynamic> properties)` | `$user_set` | ユーザープロファイル属性を上書き設定 |
| `userSetOnce(Map<String, dynamic> properties)` | `$user_set_once` | 初回のみプロファイル属性を設定（未設定または null の場合のみ有効） |
| `userAdd(Map<String, num> properties)` | `$user_add` | 数値型プロファイル属性のアトミック加算（負数で減算） |
| `userAppend(Map<String, List<dynamic>> properties)` | `$user_append` | リスト型プロファイル属性への要素追加（重複排除なし） |
| `userUniqAppend(Map<String, List<dynamic>> properties)` | `$user_uniq_append` | リスト型プロファイル属性への重複排除付き要素追加 |
| `userUnset(List<String> keys)` | `$user_unset` | 指定したプロファイル属性キーをクリア（内部で `{key: 0}` に変換） |
| `userDelete()` | `$user_del` | 現在のユーザープロファイルレコードを削除マーク |

```dart
sdk.userSet({'vip_level': 'Diamond', 'city': 'Shanghai'});
sdk.userSetOnce({'first_install_channel': 'AppStore'});
sdk.userAdd({'loyalty_points': 100});
sdk.userAppend({'tags': ['mobile_shopper', 'promo_2026']});
sdk.userUniqAppend({'tags': ['promo_2026', 'vip_member']});
sdk.userUnset(['temporary_flag']);
sdk.userDelete();
```

---

### 2.6 `> 2^53 - 1` 大整数精度保護と `#time` / `$time` 時刻抽出

1. **`> 2^53 - 1` 大整数精度保護**：
   - IEEE-754 倍精度浮動小数点数の安全整数上限は `9007199254740991`（$2^{53}-1$、`AbiAnalytics.maxSafeInteger`）です。
   - プロパティ値（またはリスト要素）の `int` の絶対値が `9007199254740991` を超える場合（例：64 bit Snowflake ID `9007199254740993`）、JSON パース時の精度欠落を防ぐため自動的に文字列 `"9007199254740993"` にシリアライズされます。
2. **`#time` / `$time` イベント発生時刻の自動抽出**：
   - `track(..., timestamp: DateTime)` パラメータによる明示指定に加え、`properties` 内に `'#time'` または `'$time'`（`'#time'` が優先）が含まれている場合、SDK は自動的にそれをトップレベルのミリ秒 `timestamp` に変換し、**送信される `properties` から自動的に除去**します。
   - サポートされる型：`DateTime`、10 桁（秒）または 13 桁（ミリ秒）の `int`/`double`、数値文字列（10〜16 桁）、および ISO-8601 文字列（例：`'2026-11-10T08:00:00Z'`）。

```dart
sdk.track(
  'OrderPaid',
  properties: {
    '#time': '2026-11-10T08:30:00.000Z', // トップレベルのミリ秒 timestamp に抽出され、properties からは除外
    'snowflake_seq': 9007199254740993,   // > 2^53 - 1 のため自動的に文字列 "9007199254740993" に変換
  },
);
```

---

## 3. 2ステップ・インタラクティブ Demo 画面とヘッドレス呼び出し例

### 3.1 2ステップ UI デモ画面 ([`example/lib/main.dart`](example/lib/main.dart))

`AbiSdkDemoScreen` は Web 版と統一された **2ステップ「プレビュー → 確認して送信」ワークフロー**を実装しています：
1. **ステップ 1：パラメータを設定し、単一リクエスト JSON をリアルタイムプレビュー (`autoFlush: false` + `buildPendingBatchPayload`)**
   - 初期化時に `autoFlush: false` を指定し、バックグラウンドタイマーとバッチ閾値による自動送信を無効化します。
   - ID 切り替え（`identify` / `login` / `logout`）、静的・動的共通プロパティの編集、行動イベントや `$user_*` ボタンのタップ時には、`_sdk.clearPendingQueue()` でキューを再構築し、`_sdk.buildPendingBatchPayload()` によって **パネル A：送信予定リクエスト JSON プレビュー** をその場で更新します（履歴ログの無限追記は行いません）。
   - **「複数イベント一括モード」** をオンにすると、複数回タップしたイベントを同一の `events` 配列に追加してプレビューできます。
2. **ステップ 2：「確認して送信（确认提交）」をタップして送信 (`flush`)**
   - **「确认提交」** ボタンをタップした時のみ `await _sdk.flush()` を呼び出し、**パネル B：直近の送信結果 (Response)** に HTTP ステータス（`_sdk.lastStatusCode`）とレスポンスボディ（`_sdk.lastResponseBody`）を表示します。

### 3.2 2ステップ・ヘッドレス（UI なし）メソッド呼び出し (`previewScenarioPayload` + `confirmSubmit`)

自動テストや UI なしのスクリプト検証では、`AbiAnalytics` 組み込みの 2 ステップメソッドを直接呼び出せます：

```dart
import 'package:your_app/abi_sdk.dart';

Future<void> runHeadlessTwoStepDemo() async {
  final sdk = AbiAnalytics.instance;

  // ステップ 1：autoFlush: false で ID、共通プロパティ、計測イベント、大整数、固定 eventId マイルストーンイベント、
  // 7 種類の $user_* 操作を構築し、POST /collect/api/v1/track/batch の整形済み JSON 文字列を取得
  final pendingJson = sdk.previewScenarioPayload(
    serverUrl: 'http://localhost:8081',
    projectId: 1,
    projectToken: 'abi_tok_demo_flutter',
    dryRun: true,
  );
  print('=== ステップ 1：送信予定リクエスト JSON プレビュー ===\n$pendingJson');

  // ステップ 2：送信を確定し、単一のレスポンス結果を確認
  final ok = await sdk.confirmSubmit();
  print('=== ステップ 2：送信確定結果 ===');
  print('ok=$ok, status=${sdk.lastStatusCode}, response=${sdk.lastResponseBody}');
}
```
