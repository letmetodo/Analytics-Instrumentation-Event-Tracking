# ABI iOS / macOS Swift クライアント SDK ドキュメント (`abi.sdk/mobile/ios`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

[`AbiAnalytics.swift`](AbiAnalytics.swift) は、iOS および macOS ネイティブクライアント向けのサードパーティ依存ゼロのデータ収集・分析 SDK です。Apple 標準の `Foundation` フレームワーク（`NSLock`、`URLSession`、`JSONSerialization`、`ProcessInfo.processInfo.systemUptime`）のみで実装されており、ABI 収集ゲートウェイ `POST /collect/api/v1/track/batch` のプロトコル契約および ThinkingData v3.4 仕様に完全準拠しています。

> モバイル SDK 総覧へ戻る：[简体中文](../README.md) | [English](../README.en.md) | [日本語](../README.ja.md)

---

## 実装エンジニア視点：必須指定フィールド・SDK 自動収集フィールド・ゲートウェイ／サーバー補完フィールド（IP など）

iOS / macOS クライアント実装エンジニアの視点から、すべての計測フィールドは以下の 3 つのカテゴリに分類されます：

| カテゴリ | フェーズ / フィールド名 | クライアント実装での指定 | 生成元・処理メカニズム |
|----------|-------------------------|--------------------------|------------------------|
| **第1類：実装者が【必ず明示的に渡す】必須項目** | **初期化 (`init` / `initialize`)**：`serverUrl`、`projectId` (`> 0`)、`projectToken` / `token` | **必須** | `AbiAnalytics.shared.initialize` で `:8081` 収集ゲートウェイ URL、プロジェクト ID（`> 0`）、非空のプロジェクトキーを指定します。 |
| | **イベント計測 (`track`)**：`eventName` | **必須** | イベント名（例：`"OrderPaid"`）。任意のカスタム属性は `properties` で渡します。 |
| | **ログイン (`login`)**：`accountId`（`login_id`） | **ログイン時に必須** | 実名ログイン完了時に `login(accountId)` でローカルに `login_id`（最大 128 UTF-8 バイト）を設定・永続化します（`distinct_id` は上書きせず、ネットワークイベントも発火しません）。 |
| | **イベント更新・上書き (`trackUpdate` / `trackOverwrite`)**：`eventId` | **現バージョン未開放** | D7① / G6 制限により、現行の StarRocks `dwd_events` モデルでは `trackFirst` / `trackUpdate` / `trackOverwrite` は未開放です。 |
| **第2類：SDK が【自動生成・永続化】し、手動入力不要な項目** | `distinct_id` | **自動生成（入力不要）** | 初期化時に UUIDv4 を自動生成して `UserDefaults`（`abi_sdk_<projectId>_distinct_id`）へ永続化します。`identify` のみで更新され、`login` では上書きされません。 |
| | `event_id` | **自動生成（入力不要）** | `track` ごとに UUIDv4 を自動生成し、弱電波・オフライン再送時も同一 ID を維持して冪等性を保証します。 |
| | `timestamp` | **自動生成（入力不要）** | クライアントの現在ミリ秒タイムスタンプを自動取得します（`#time` / `$time` で過去イベント時刻を明示した場合を除く）。 |
| | 端末・環境プリセット属性：`$lib`、`$lib_version`、`$os`、`$os_version`、`$device_model`、`$screen_width`、`$screen_height`、`$url`、`$title`、`$referrer`、`$zone_offset` | **自動収集（入力不要）** | SDK が自動的に取得・付与します（`$user_*` プロファイル操作では自動的に分離されます）。 |
| **第3類：クライアントでは【取得不可・指定不要】で、ゲートウェイ／サーバーが補完する項目** | **グローバル IP と地域情報 (`#ip` / `$ip` $\rightarrow$ 国・都道府県・市区町村)** | **クライアントでの指定厳禁** | クライアントが `:8081` ゲートウェイへ直接通信する場合、ゲートウェイが HTTP 接続（および `X-Forwarded-For` / `X-Real-IP`）から実際のクライアント IP を抽出し、Flink が国・地域・都市を自動解析します。 |

1. **第1類：実装者が【必ず明示的に渡す】必須項目**
   - **初期化フェーズ (`init` / `initialize`)**：`serverUrl`（収集ゲートウェイアドレス）、`projectId`（`> 0`）、`token` / `projectToken`（非空のプロジェクトキー）。
   - **イベント送信フェーズ (`track`)**：`eventName`（必須、例：`"OrderPaid"`）。
   - **アカウントログインフェーズ (`login`)**：ユーザーが実名ログインを完了した際に `accountId`（すなわち `login_id`）を渡します。ローカルで `login_id` を永続化し（`distinct_id` は上書きせず追加イベントも送信しません）、以降のイベントに `distinct_id` と `login_id` が付与されます。
   - **同日リトライ冪等キー (`track` の任意 `eventId`)**：同日再送時の重複排除が必要な場合は `track` に固定 `eventId` を渡します（D7① / G6 制限により、現バージョンでは `trackFirst` / `trackUpdate` / `trackOverwrite` は未開放です）。
2. **第2類：SDK が【自動生成・永続化】し、フロントエンド／クライアント開発者が【手動入力不要】なフィールド**
   - **`distinct_id`（ゲスト／デバイス ID）**：初期化時に UUIDv4 を自動生成して `UserDefaults`（`abi_sdk_<projectId>_distinct_id`、最大 64 UTF-8 バイト）に永続化します。`login()` で上書きされることはありません。
   - **`event_id`**：`track` 呼び出しごとに UUIDv4 を自動生成し、弱電波やオフライン再送時にも同一値を維持して冪等性を保ちます。
   - **`timestamp`**：クライアントの現在ミリ秒タイムスタンプを自動採用します（`#time` / `$time` で過去イベント時刻を明示的に指定した場合を除く）。
   - **端末・環境プリセット属性**：`$lib`、`$lib_version`、`$os`、`$os_version`、`$device_model`、`$screen_width`、`$screen_height`、`$url`、`$title`、`$referrer`、`$zone_offset`。
3. **第3類：クライアントでは【取得できず送信も不要】で、収集ゲートウェイ／サーバー側が取得するフィールド（重要：`IP` とフロント・バックエンド連携）**
   - **グローバル IP と地域情報 (`#ip` / `$ip` $\rightarrow$ 国／都道府県／市区町村)**：ブラウザ JS、ミニプログラム、モバイル App はクライアントサンドボックスおよび NAT ルーター配下で動作するため、**自身のパブリック出口 IP を直接取得することはできません。したがって、クライアント実装時に `$ip` / `#ip` を渡す必要は一切ありません**。クライアントが `:8081` 収集ゲートウェイに直接送信すれば、ゲートウェイが HTTP 接続（および Nginx/SLB の `X-Forwarded-For` / `X-Real-IP`）から実際のクライアント IP を自動抽出し、Flink が国・都道府県・市区町村を自動解決します。
   - **注意：いつ IP を渡す必要があるのか？** 「クライアントがまず自社バックエンド API を呼び出し、Go/Java サーバーサイド SDK が代わってイベントを代理送信する」構成を採用している場合のみ、ゲートウェイからはバックエンドサーバーのデータセンター IP に見えるため、バックエンド側でクライアントリクエストから IP を抽出して `#ip` / `$ip` としてサーバー SDK に渡す必要があります。あわせて、モバイルからバックエンド API を呼び出す際はリクエストヘッダーにゲスト ID（`sdk.distinctId`）を付与し、クライアントとサーバー間のファネルを紐付けることを推奨します。

---

## 1. 組み込み方法と環境設定

### 1.1 ソースコード組み込み（CocoaPods / SPM 外部依存ゼロ）
1. [`AbiAnalytics.swift`](AbiAnalytics.swift) をホスト Xcode プロジェクト Target の `Compile Sources` に直接ドラッグ＆ドロップで追加します（システム標準の `Foundation` のみに依存します）。
2. インタラクティブ SwiftUI デモ画面または 2 ステップ・ヘッドレス実行ランナーを使用する場合は、[`example/AbiDemoViewController.swift`](example/AbiDemoViewController.swift) もあわせて Target に追加します：
   - **SwiftUI プロジェクト**：ビュー階層内で `AbiSdkDemoView()` を直接マウントします（iOS 15.0+ / macOS 12.0+ 対応）。
   - **UIKit プロジェクト**：`UIHostingController(rootView: AbiSdkDemoView())` でラップしてプッシュまたはモーダル表示します。

### 1.2 `Info.plist` ローカルネットワーク ATS 設定
iOS シミュレータ、macOS、または開発用実機からローカルの平文 HTTP 収集ゲートウェイ（`http://localhost:8081`）に接続する場合は、`Info.plist` の `NSAppTransportSecurity` 配下で `NSAllowsLocalNetworking` を有効にしてください：

```xml
<key>NSAppTransportSecurity</key>
<dict>
    <!-- 開発環境での localhost / LAN 平文 HTTP ゲートウェイへのアクセスを許可 -->
    <key>NSAllowsLocalNetworking</key>
    <true/>
</dict>
```

### 1.3 コマンドラインでの静的型チェック検証
Xcode を起動することなく、macOS のターミナルから `swiftc` を直接実行して SDK と SwiftUI デモビューがコンパイルエラーゼロで通過することを検証できます：
```bash
swiftc -typecheck abi.sdk/mobile/ios/AbiAnalytics.swift abi.sdk/mobile/ios/example/AbiDemoViewController.swift
```

---

## 2. 初期化とコア API クイックリファレンス

### 2.1 SDK の初期化 (`AbiAnalytics.shared.initialize`)

`AppDelegate.application(_:didFinishLaunchingWithOptions:)` または SwiftUI の `App.init()` 内でグローバル共有シングルトンを初期化します：

```swift
import Foundation

let sdk = AbiAnalytics.shared
sdk.initialize(
    serverUrl: "http://localhost:8081",
    projectId: 1,
    projectToken: "abi_tok_ios_demo",
    appVersion: "2.1.0",
    batchSize: 20,
    debug: false,
    autoFlush: true // 本番環境のデフォルトは true（5秒周期 Timer＋batchSize 閾値自動送信）。2ステップ・プレビュー時は false
)
```

| `initialize` パラメータ | 型 | デフォルト値 | 説明 |
|-------------------------|------|--------------|------|
| `serverUrl` | `String` | 必須 | 収集ゲートウェイのベース URL（`/collect/api/v1/track/batch` を自動付与） |
| `projectId` | `Int64` | 必須 | ABI プロジェクト ID (`project_id`) |
| `projectToken` | `String` | 必須 | プロジェクトアクセストークン (`project_token`) |
| `appVersion` | `String` | `"1.0.0"` | アプリバージョン（プリセット属性 `$app_version` に自動注入） |
| `batchSize` | `Int` | `20` | 自動バッチ送信をトリガーするキュー件数の閾値（`1...500` の範囲に正規化） |
| `debug` | `Bool` | `false` | デバッグモード（ペイロードに `"debug": true` を付与し即時送信をトリガー） |
| `autoFlush` | `Bool` | `true` | メインランループで 5 秒周期タイマーと閾値自動送信を有効化（`false` の場合は手動で `flush()`） |

---

### 2.2 デュアル ID 識別管理 (`identify` / `login` / `logout`)

SDK は `NSLock` を用いてすべての ID 状態とキュー操作をスレッドセーフに保護し、ThinkingData 仕様に完全準拠して送信イベントには `distinct_id`（ゲスト／デバイス ID、最大 64 UTF-8 バイト）と `login_id`（ログインアカウント ID、最大 128 UTF-8 バイト）の 2 つのみを格納します：
- `distinctId`：ゲスト／デバイス識別子（初期化時に UUIDv4 を自動生成し、`UserDefaults` の `abi_sdk_<projectId>_distinct_id` に永続化）。
- `loginId` / `currentLoginId`：ログインアカウント識別子（未ログイン時は空文字列 `""`）。
- `identify(_ distinctId: String) throws`：カスタムゲスト／デバイス ID をローカルで更新します（空文字列、制御文字を含む場合、または 64 UTF-8 バイトを超える場合は `NSError` をスロー。ネットワークイベントは送信しません）。
- `login(_ accountId: String) throws`：ログインアカウント ID（最大 128 UTF-8 バイト）をローカルに設定・永続化します（**`distinctId` を上書きせず、ネットワークイベントも一切送信しません**。戻り値は `Void`）。
- `logout()`：`loginId` をローカルでクリアし、`distinctId` はそのまま保持します（ネットワークイベントは送信しません）。

```swift
try sdk.identify("ios_visitor_device_001")
try sdk.login("user_ios_10001") // ローカル状態の更新のみ（ネットワークイベント送信なし）
print("distinctId=\(sdk.distinctId), loginId=\(sdk.currentLoginId)")
sdk.logout()
```

---

### 2.3 静的および動的共通プロパティ (`Super Properties`)

共通プロパティは以降のすべての通常行動イベントおよびシステムイベントに自動マージされます（**`$user_*` / `#user_*` ユーザープロファイルイベントからは自動的に除外されます**）。優先順位は `単一イベントの properties > 動的共通プロパティ > 静的共通プロパティ > SDK プリセット属性（$lib/$os/$app_version）` です。

| メソッドシグネチャ | 説明 |
|--------------------|------|
| `setSuperProperties(_ props: [String: Any])` | グローバルな静的共通プロパティを登録・マージ |
| `unsetSuperProperty(_ key: String)` | 指定したキーの静的共通プロパティを削除 |
| `clearSuperProperties()` | 登録済みのすべての静的共通プロパティをクリア |
| `getSuperProperties() -> [String: Any]` | 現在の静的共通プロパティのスレッドセーフなコピースナップショットを取得 |
| `setDynamicSuperProperties(_ provider: (() -> [String: Any])?)` | `track` 呼び出し時に毎回評価される動的共通プロパティクロージャを登録（`nil` で解除） |

```swift
sdk.setSuperProperties(["channel": "AppStore", "vip_tier": "Gold"])
sdk.unsetSuperProperty("vip_tier")
let snapshot = sdk.getSuperProperties()

sdk.setDynamicSuperProperties {
    ["network_state": "wifi", "dyn_sequence": 1]
}
```

---

### 2.4 イベント時間計測と同日べき等イベント収集 (`timeEvent` / `track`)

- **システム稼働時間による高精度時間計測 (`timeEvent`)**：`ProcessInfo.processInfo.systemUptime` に基づいて開始時刻を記録し（端末のシステム時刻変更の影響を受けません）、次回同名の `track` イベント送信時に経過秒数（小数点以下 3 桁）を `$duration` プロパティとして自動付与します。
- **通常イベント (`track`)**：イベント名とプロパティ辞書を検証してスレッドセーフにエンキューし、べき等 `event_id` を返します（検証失敗時は空文字列 `""` を返します）。同日同一ペイロード再送時の重複排除には固定 `eventId` を明示指定できます。
- **未開放 API の制限 (`trackFirst` / `trackUpdate` / `trackOverwrite`)**：D7① / G6 制限により、現行の StarRocks `dwd_events` モデルでは `$first_check_id` 初回重複排除および `trackUpdate` / `trackOverwrite` は未開放です（呼び出すと明示的なエラーログを出力して `""` を返し、擬似 `track` イベントは一切エンキューされません）。ステータス遷移は個別のマイルストーンイベントとして記録してください。

```swift
// 1. 高精度イベント計測と通常イベントの収集
sdk.timeEvent("OrderPaid")
let orderEvtId = sdk.track(
    "OrderPaid",
    properties: [
        "order_id": "ord_9001",
        "amount": 199.95,
        "currency": "CNY"
    ]
)

// 2. 同日固定 eventId マイルストーンイベント（同一ペイロード再送時にべき等重複排除）
_ = sdk.track(
    "OrderSettled",
    properties: [
        "order_id": "ord_9001",
        "order_status": "settled",
        "amount": 199.95
    ],
    eventId: "ord_settled_9001"
)
```

---

### 2.5 7 種類のユーザープロファイル操作 (`$user_*`)

すべてのプロファイル操作メソッドは StarRocks の `abi.dim_users` ディメンションテーブルに対応しており、SDK は**プリセットシステム属性および静的・動的共通プロパティを自動的に除外**します：

| メソッドシグネチャ | 対応システムイベント | 説明 |
|--------------------|----------------------|------|
| `userSet(_ properties: [String: Any])` | `$user_set` | ユーザープロファイル属性を上書き設定 |
| `userSetOnce(_ properties: [String: Any])` | `$user_set_once` | 初回のみプロファイル属性を設定（未設定の場合のみ有効） |
| `userAdd(_ properties: [String: NSNumber])` | `$user_add` | 数値型プロファイル属性のアトミック加算（負数で減算） |
| `userAppend(_ properties: [String: [Any]])` | `$user_append` | リスト型プロファイル属性への要素追加（重複排除なし） |
| `userUniqAppend(_ properties: [String: [Any]])` | `$user_uniq_append` | リスト型プロファイル属性への重複排除付き要素追加 |
| `userUnset(_ keys: [String])` | `$user_unset` | 指定したプロファイル属性キー配列をクリア（内部で `[key: 0]` に変換） |
| `userDelete()` | `$user_del` | 現在のユーザープロファイルレコードを削除マーク |

```swift
sdk.userSet(["vip_level": "Diamond", "city": "Shanghai"])
sdk.userSetOnce(["first_channel": "AppStore"])
sdk.userAdd(["loyalty_points": NSNumber(value: 100)])
sdk.userAppend(["tags": ["ios", "vip"]])
sdk.userUniqAppend(["tags": ["vip", "annual"]])
sdk.userUnset(["temp_badge"])
sdk.userDelete()
```

---

### 2.6 `> 2^53 - 1` 大整数精度保護と `#time` / `$time` 時刻抽出

1. **`> 2^53 - 1` 大整数精度保護**：
   - IEEE-754 倍精度浮動小数点数の安全整数上限は `9007199254740991`（$2^{53}-1$、`AbiAnalytics.maxSafeInteger`）です。
   - プロパティ値（または配列要素）の `Int64` または `Int` が `[-9007199254740991, 9007199254740991]` の範囲外（`Int64.min` や 64 bit Snowflake ID `Int64(9007199254740993)` など）の場合、JSON パース時の精度欠落を防ぐため自動的に文字列 `"9007199254740993"` に変換されます。
2. **`#time` / `$time` イベント発生時刻の自動抽出**：
   - `track` の `timestamp: Date?` 引数による指定に加え、`properties` に `"#time"` または `"$time"`（`"#time"` が優先）が含まれている場合、SDK はプロパティキー検証の前にそれをトップレベルのミリ秒 `timestamp` に抽出し、**`properties` 辞書から自動的に除去**します（`Bool` / `CFBoolean` が数値タイムスタンプとして誤認識されることも厳格に防止します）。
   - サポートされる型：`Date`、10 桁（秒）または 13 桁（ミリ秒）の `Int64`/`Int`/`Double`/`Float`/`NSNumber`、数値エポック文字列（10〜16 桁）、および ISO-8601／標準日時文字列。

```swift
sdk.track(
    "OrderPaid",
    properties: [
        "#time": "2026-11-10T08:30:00.000Z",          // トップレベルのミリ秒 timestamp に抽出され、properties からは除外
        "snowflake_seq": Int64(9007199254740993)      // > 2^53 - 1 のため自動的に文字列 "9007199254740993" に変換
    ]
)
```

---

## 3. 2ステップ・インタラクティブ Demo 画面とヘッドレス呼び出し例

### 3.1 2ステップ SwiftUI デモ画面 ([`example/AbiDemoViewController.swift`](example/AbiDemoViewController.swift))

`AbiSdkDemoView`（iOS 15.0+ / macOS 12.0+ 対応）は、**2ステップ「プレビュー → 確認して送信」契約**を厳格に実装しています：
1. **ステップ 1：パラメータを設定し、単一リクエスト JSON をリアルタイムプレビュー (`autoFlush: false` + `buildPendingBatchPayload` / `buildPendingBatchJsonString`)**
   - 初期化時に `autoFlush: false` を指定し、定期タイマーと自動送信を無効化します。
   - ID 切り替え（`identify` / `login` / `logout`）、静的共通プロパティ JSON の編集、動的共通プロパティの切り替え、**「複数イベント一括モード」** のオン／オフ、または各イベント／`$user_*` ボタンのタップ時には、`sdk.clearPendingQueue()` でアクションを再適用し、`sdk.buildPendingBatchJsonString()` によって **パネル A：送信予定リクエスト JSON プレビュー** をその場で更新します。
2. **ステップ 2：「確認して送信（确认提交）」をタップして送信 (`flush(completion:)`)**
   - 緑色の **「确认提交」** ボタンをタップした時のみ `sdk.flush { statusCode, rawBody in ... }` を実行し、レスポンス返却後に下部の **パネル B：直近の送信結果 (Response)** を更新します。

### 3.2 2ステップ・ヘッドレス（UI なし）メソッド呼び出し (`AbiSdkDemoRunner.previewScenarioJson` + `confirmSubmit`)

XCTest ユニットテストや CLI 検証スクリプトからは、`AbiSdkDemoRunner` が提供する 2 ステップ静的メソッドを直接呼び出せます：

```swift
// ステップ 1：autoFlush: false でデュアル ID、静的・動的共通プロパティ、timeEvent 計測、>2^53-1 大整数、
// 固定 eventId マイルストーンイベント、7 種類の $user_* 操作を構築し、整形済みの送信予定リクエスト JSON 文字列を取得
let pendingRequestJson = AbiSdkDemoRunner.previewScenarioJson(
    serverUrl: "http://localhost:8081",
    projectId: 1,
    projectToken: "abi_tok_ios_demo"
)
print("=== ステップ 1：送信予定リクエスト JSON プレビュー ===\n\(pendingRequestJson)")

// ステップ 2：送信を確定し、コールバックで単一の HTTP ステータスコードとレスポンスボディを受信
AbiSdkDemoRunner.confirmSubmit { statusCode, responseBody in
    print("=== ステップ 2：送信完了 ===")
    print("HTTP \(statusCode), レスポンス: \(responseBody)")
}
```
