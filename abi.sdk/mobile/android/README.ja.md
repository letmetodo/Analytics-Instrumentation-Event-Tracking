# ABI Android Kotlin クライアント SDK ドキュメント (`abi.sdk/mobile/android`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

[`AbiAnalytics.kt`](AbiAnalytics.kt) は、ネイティブ Android アプリケーション向けのサードパーティ依存ゼロのデータ収集・分析 SDK です。Android 標準フレームワークと Java 標準ライブラリ（`HttpURLConnection`、`org.json`、`ConcurrentLinkedQueue`、`SystemClock.elapsedRealtime`）のみで実装されており、ABI 収集ゲートウェイ `POST /collect/api/v1/track/batch` のプロトコル契約および ThinkingData v3.4 仕様に完全準拠しています。

> モバイル SDK 総覧へ戻る：[简体中文](../README.md) | [English](../README.en.md) | [日本語](../README.ja.md)

---

## 実装エンジニア視点：必須指定フィールド・SDK 自動収集フィールド・ゲートウェイ／サーバー補完フィールド（IP など）

Android クライアント実装エンジニアの視点から、すべての計測フィールドは以下の 3 つのカテゴリに分類されます：

| カテゴリ | フェーズ / フィールド名 | クライアント実装での指定 | 生成元・処理メカニズム |
|----------|-------------------------|--------------------------|------------------------|
| **第1類：実装者が【必ず明示的に渡す】必須項目** | **初期化 (`init` / `initialize`)**：`serverUrl`、`projectId` (`> 0`)、`projectToken` / `token` | **必須** | `AbiAnalytics.init` で `:8081` 収集ゲートウェイ URL、プロジェクト ID（`> 0`）、非空のプロジェクトキーを指定します。 |
| | **イベント計測 (`track`)**：`eventName` | **必須** | イベント名（例：`"OrderPaid"`）。任意のカスタム属性は `properties` で渡します。 |
| | **ログイン (`login`)**：`accountId`（`login_id`） | **ログイン時に必須** | 実名ログイン完了時に `login(accountId)` でローカルに `login_id`（最大 128 UTF-8 バイト）を設定・永続化します（`distinct_id` は上書きせず、ネットワークイベントも発火しません）。 |
| | **イベント更新・上書き (`trackUpdate` / `trackOverwrite`)**：`eventId` | **現バージョン未開放** | D7① / G6 制限により、現行の StarRocks `dwd_events` モデルでは `trackFirst` / `trackUpdate` / `trackOverwrite` は未開放です。 |
| **第2類：SDK が【自動生成・永続化】し、手動入力不要な項目** | `distinct_id` | **自動生成（入力不要）** | 初期化時に UUIDv4 を自動生成して `SharedPreferences` の `distinct_id` キーへ永続化します。`identify` のみで更新され、`login` では上書きされません。 |
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
   - **`distinct_id`（ゲスト／デバイス ID）**：初期化時に UUIDv4 を自動生成して `SharedPreferences` の `distinct_id` キー（最大 64 UTF-8 バイト）に永続化します。`login()` で上書きされることはありません。
   - **`event_id`**：`track` 呼び出しごとに UUIDv4 を自動生成し、弱電波やオフライン再送時にも同一値を維持して冪等性を保ちます。
   - **`timestamp`**：クライアントの現在ミリ秒タイムスタンプを自動採用します（`#time` / `$time` で過去イベント時刻を明示的に指定した場合を除く）。
   - **端末・環境プリセット属性**：`$lib`、`$lib_version`、`$os`、`$os_version`、`$device_model`、`$screen_width`、`$screen_height`、`$url`、`$title`、`$referrer`、`$zone_offset`。
3. **第3類：クライアントでは【取得できず送信も不要】で、収集ゲートウェイ／サーバー側が取得するフィールド（重要：`IP` とフロント・バックエンド連携）**
   - **グローバル IP と地域情報 (`#ip` / `$ip` $\rightarrow$ 国／都道府県／市区町村)**：ブラウザ JS、ミニプログラム、モバイル App はクライアントサンドボックスおよび NAT ルーター配下で動作するため、**自身のパブリック出口 IP を直接取得することはできません。したがって、クライアント実装時に `$ip` / `#ip` を渡す必要は一切ありません**。クライアントが `:8081` 収集ゲートウェイに直接送信すれば、ゲートウェイが HTTP 接続（および Nginx/SLB の `X-Forwarded-For` / `X-Real-IP`）から実際のクライアント IP を自動抽出し、Flink が国・都道府県・市区町村を自動解決します。
   - **注意：いつ IP を渡す必要があるのか？** 「クライアントがまず自社バックエンド API を呼び出し、Go/Java サーバーサイド SDK が代わってイベントを代理送信する」構成を採用している場合のみ、ゲートウェイからはバックエンドサーバーのデータセンター IP に見えるため、バックエンド側でクライアントリクエストから IP を抽出して `#ip` / `$ip` としてサーバー SDK に渡す必要があります。あわせて、モバイルからバックエンド API を呼び出す際はリクエストヘッダーにゲスト ID（`sdk.distinctId`）を付与し、クライアントとサーバー間のファネルを紐付けることを推奨します。

---

## 1. 組み込み方法と環境設定

### 1.1 ソースコード組み込み（外部 Gradle 依存ゼロ）
1. [`AbiAnalytics.kt`](AbiAnalytics.kt) をホスト Android プロジェクトのソースパッケージディレクトリ `com/anylink/abi/sdk/android/` にコピーします（OkHttp や Gson などの外部ライブラリは一切不要です）。
2. インタラクティブ検証画面またはヘッドレス検証メソッドを利用する場合は、[`example/AbiDemoActivity.kt`](example/AbiDemoActivity.kt) を `com/anylink/abi/sdk/android/example/` にコピーします。

### 1.2 `AndroidManifest.xml` の権限とネットワーク設定
ホストモジュールの `AndroidManifest.xml` で `INTERNET` 権限を宣言します。Android エミュレータからホストマシンのローカル平文 HTTP ゲートウェイ（`http://10.0.2.2:8081`）に接続する場合は、開発環境で `android:usesCleartextTraffic="true"` を有効にし、`AbiDemoActivity` を登録してください：

```xml
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.yourcompany.app">

    <!-- バッチイベント送信に必須 -->
    <uses-permission android:name="android.permission.INTERNET" />

    <application
        android:usesCleartextTraffic="true"
        ...>
        <!-- 任意：2ステップ・インタラクティブ検証用 Activity の登録 -->
        <activity
            android:name="com.anylink.abi.sdk.android.example.AbiDemoActivity"
            android:exported="true"
            android:label="ABI Android SDK Demo" />
    </application>
</manifest>
```

---

## 2. 初期化とコア API クイックリファレンス

### 2.1 SDK の初期化 (`AbiAnalytics.init` & `AbiAnalytics.getInstance`)

`Application.onCreate()` 内でグローバルシングルトンを初期化することを推奨します（`@JvmStatic` および `@JvmOverloads` アノテーション付きのため、Kotlin と Java の両方からシームレスに呼び出し可能です）：

```kotlin
import com.anylink.abi.sdk.android.AbiAnalytics

val sdk = AbiAnalytics.init(
    serverUrl = "http://10.0.2.2:8081", // Android エミュレータからホスト側 :8081 ゲートウェイへ接続するアドレス
    projectId = 1L,
    projectToken = "abi_tok_android_demo",
    appVersion = "2.1.0",
    batchSize = 20,
    debug = false,
    autoFlush = true // 本番環境のデフォルトは true（5秒周期＋batchSize 閾値自動送信）。2ステップ・プレビュー時は false
)

// アプリ内の任意の場所から初期化済みシングルトンを取得
val sharedSdk = AbiAnalytics.getInstance()
```

| `init` パラメータ | 型 | デフォルト値 | 説明 |
|-------------------|------|--------------|------|
| `serverUrl` | `String` | 必須 | 収集ゲートウェイのベース URL（`/collect/api/v1/track/batch` を自動付与） |
| `projectId` | `Long` | 必須 | ABI プロジェクト ID (`project_id`) |
| `projectToken` | `String` | 必須 | プロジェクトアクセストークン (`project_token`) |
| `appVersion` | `String` | `"1.0.0"` | アプリバージョン（プリセット属性 `$app_version` に自動設定） |
| `batchSize` | `Int` | `20` | バックグラウンド自動バッチ送信をトリガーするキュー件数の閾値 |
| `debug` | `Boolean` | `false` | デバッグモード（リクエストに `"debug": true` を付与し即時送信をトリガー） |
| `autoFlush` | `Boolean` | `true` | 5秒周期のバックグラウンドタイマーと閾値自動送信を有効化（`false` の場合は手動で `flush()`） |

---

### 2.2 デュアル ID 識別管理 (`identify` / `login` / `logout`)

SDK は `@Volatile` によりマルチスレッドの読み書き安全性を保証し、ThinkingData 仕様に完全準拠して送信イベントには `distinct_id`（ゲスト／デバイス ID、最大 64 UTF-8 バイト）と `login_id`（ログインアカウント ID、最大 128 UTF-8 バイト）の 2 つのみを格納します：
- `distinctId`：ゲスト／デバイス識別子（初期化時に UUIDv4 を自動生成し、`context` 指定時は `SharedPreferences` の `distinct_id` キーに永続化）。
- `loginId`：ログインアカウント識別子（未ログイン時は空文字列 `""`）。
- `identify(customDistinctId: String)`：カスタムゲスト／デバイス ID をローカルで更新します（前後の空白除去、制御文字チェック、最大 64 UTF-8 バイト検証を自動実行。ネットワークイベントは送信しません）。
- `login(accountId: String)`：ログインアカウント ID（最大 128 UTF-8 バイト）をローカルに設定・永続化します（**`distinctId` を上書きせず、ネットワークイベントも一切送信しません**。戻り値は `Unit`）。
- `logout()`：`loginId` をローカルでクリアし、`distinctId` はそのまま保持します（ネットワークイベントは送信しません）。

```kotlin
sdk.identify("android_visitor_device_001")
sdk.login("user_android_10001") // ローカル状態の更新のみ（ネットワークイベント送信なし）
println("distinctId=${sdk.distinctId}, loginId=${sdk.loginId}")
sdk.logout()
```

---

### 2.3 静的および動的共通プロパティ (`Super Properties`)

共通プロパティはスレッドセーフな `ConcurrentHashMap` に保持され、以降のすべての通常行動イベントおよびシステムイベントに自動マージされます（**`$user_*` / `#user_*` ユーザープロファイルイベントからは自動的に分離されます**）。優先順位は `単一イベントの properties > 動的共通プロパティ > 静的共通プロパティ > SDK プリセット属性（$os/$model/$manufacturer など）` です。

| メソッドシグネチャ | 説明 |
|--------------------|------|
| `setSuperProperties(props: Map<String, Any>)` | グローバルな静的共通プロパティを登録・マージ |
| `unsetSuperProperty(key: String)` | 指定したキーの静的共通プロパティを削除 |
| `clearSuperProperties()` | 登録済みのすべての静的共通プロパティをクリア |
| `getSuperProperties(): Map<String, Any>` | 現在の静的共通プロパティの不変コピースナップショットを取得 |
| `setDynamicSuperProperties(provider: (() -> Map<String, Any?>)?)` | `track` 呼び出し時に毎回評価される動的共通プロパティコールバックを登録（`null` で解除） |

```kotlin
sdk.setSuperProperties(mapOf("channel" to "GooglePlay", "vip_tier" to "Gold"))
sdk.unsetSuperProperty("vip_tier")
val snapshot = sdk.getSuperProperties()

sdk.setDynamicSuperProperties {
    mapOf("network_state" to "wifi", "dyn_sequence" to 1)
}
```

---

### 2.4 イベント時間計測と同日べき等イベント収集 (`timeEvent` / `track`)

- **単調増加クロックによる時間計測 (`timeEvent`)**：`SystemClock.elapsedRealtime()` に基づいて開始時刻を記録し（端末のシステム時刻変更の影響を受けません）、次回同名の `track` イベント送信時に経過秒数（`Double`）を `$duration` として自動注入します。
- **通常イベント (`track`)**：イベント名とプロパティキーを検証してキューに追加し、べき等 `event_id` を返します。同日同一ペイロード再送時の重複排除には固定 `eventId` を明示指定できます。
- **未開放 API の制限 (`trackFirst` / `trackUpdate` / `trackOverwrite`)**：D7① / G6 制限により、現行の StarRocks `dwd_events` モデルでは `$first_check_id` 初回重複排除および `trackUpdate` / `trackOverwrite` は未開放です（呼び出すと `UnsupportedOperationException` をスローし、擬似 `track` イベントは一切エンキューされません）。ステータス遷移は個別のマイルストーンイベントとして記録してください。

```kotlin
// 1. 単調増加クロック計測と通常イベントの記録
sdk.timeEvent("OrderPaid")
val orderEvtId = sdk.track(
    eventName = "OrderPaid",
    properties = mapOf(
        "order_id" to "ord_9001",
        "amount" to 199.95,
        "currency" to "CNY"
    )
)

// 2. 同日固定 eventId マイルストーンイベント（同一ペイロード再送時にべき等重複排除）
sdk.track(
    eventName = "OrderSettled",
    properties = mapOf(
        "order_id" to "ord_9001",
        "order_status" to "settled",
        "amount" to 199.95
    ),
    eventId = "ord_settled_9001"
)
```

---

### 2.5 7 種類のユーザープロファイル操作 (`$user_*`)

すべてのプロファイル操作メソッドは StarRocks の `abi.dim_users` テーブルに対応しており、SDK は**プリセット端末属性および静的・動的共通プロパティを自動的に除外**します：

| メソッドシグネチャ | 対応システムイベント | 説明 |
|--------------------|----------------------|------|
| `userSet(properties: Map<String, Any?>)` | `$user_set` | ユーザープロファイル属性を上書き設定 |
| `userSetOnce(properties: Map<String, Any?>)` | `$user_set_once` | 初回のみプロファイル属性を設定（未設定の場合のみ有効） |
| `userAdd(properties: Map<String, Number>)` | `$user_add` | 数値型プロファイル属性のアトミック加算（負数で減算） |
| `userAppend(properties: Map<String, List<Any>>)` | `$user_append` | リスト型プロファイル属性への要素追加（重複排除なし） |
| `userUniqAppend(properties: Map<String, List<Any>>)` | `$user_uniq_append` | リスト型プロファイル属性への重複排除付き要素追加 |
| `userUnset(vararg keys: String)` | `$user_unset` | 指定したプロファイル属性キーをクリア（可変長引数対応） |
| `userDelete()` | `$user_del` | 現在のユーザープロファイルレコードを削除マーク |

```kotlin
sdk.userSet(mapOf("vip_level" to "Platinum", "city" to "Shanghai"))
sdk.userSetOnce(mapOf("first_install_channel" to "GooglePlay"))
sdk.userAdd(mapOf("loyalty_points" to 100))
sdk.userAppend(mapOf("interests" to listOf("analytics", "kotlin")))
sdk.userUniqAppend(mapOf("interests" to listOf("kotlin", "starrocks")))
sdk.userUnset("temp_campaign_flag", "expired_badge")
sdk.userDelete()
```

---

### 2.6 `> 2^53 - 1` 大整数精度保護と `#time` / `$time` 時刻抽出

1. **`> 2^53 - 1` 大整数精度保護**：
   - IEEE-754 倍精度浮動小数点数の安全整数上限は `9007199254740991L`（$2^{53}-1$、`AbiAnalytics.MAX_SAFE_INTEGER`）です。
   - プロパティ値（またはリスト要素）の `Long` が `[-9007199254740991L, 9007199254740991L]` の範囲外（`Long.MIN_VALUE` や 64 bit Snowflake ID `9007199254740993L` など）の場合、JSON パース時の精度欠落を防ぐため自動的に文字列 `"9007199254740993"` に変換されます。
2. **`#time` / `$time` イベント発生時刻の自動抽出**：
   - `track` の `timestampMs: Long?` 引数による指定に加え、`properties` に `"#time"` または `"$time"`（`"#time"` が優先）が含まれている場合、SDK はプロパティキー検証の前にそれをトップレベルのミリ秒 `timestamp` に抽出し、**`properties` から自動的に除去**します。
   - サポートされる型：`java.util.Date`、10 桁（秒）または 13 桁（ミリ秒）の `Long`/`Int`/`Short`/`Double`/`Float`、数値エポック文字列（10〜16 桁）、および ISO-8601 日時文字列（ミリ秒・タイムゾーンオフセット対応）。

```kotlin
sdk.track(
    eventName = "OrderPaid",
    properties = mapOf(
        "#time" to "2026-11-10T08:30:00.000+08:00", // トップレベルのミリ秒 timestamp に抽出され、properties からは除外
        "snowflake_seq" to 9007199254740993L        // > 2^53 - 1 のため自動的に文字列 "9007199254740993" に変換
    )
)
```

---

## 3. 2ステップ・インタラクティブ Demo 画面とヘッドレス呼び出し例

### 3.1 2ステップ UI デモ画面 ([`example/AbiDemoActivity.kt`](example/AbiDemoActivity.kt))

`AbiDemoActivity` は XML レイアウトファイルに一切依存せず、純粋な Kotlin のネイティブ `ScrollView` + `LinearLayout` で構築されており、**2ステップ「プレビュー → 確認して送信」契約**を厳格に実行します：
1. **ステップ 1：パラメータを設定し、単一リクエスト JSON をリアルタイムプレビュー (`autoFlush = false` + `buildPendingBatchPayload`)**
   - `onCreate` で `autoFlush = false` として SDK を初期化し、バックグラウンドタイマーと自動送信を無効化します。
   - ID 切り替え（`identify` / `login` / `logout`）、静的共通プロパティ JSON の編集、動的共通プロパティの切り替え、**「複数イベント一括モード」** チェックボックス、または各イベント／`$user_*` ボタンのタップ時には、`sdk.clearPendingQueue()` でアクションを再適用し、`sdk.buildPendingBatchPayload().toString(2)` によって **パネル A：送信予定リクエスト JSON プレビュー** をその場で更新します。
2. **ステップ 2：「確認して送信（确认提交）」をタップして送信 (`flush`)**
   - 緑色の **「确认提交」** ボタンをタップした時のみワーカースレッドで `sdk.flush()` を実行し、完了後に UI スレッドで **パネル B：直近の送信結果 (Response)**（`lastFlushStatusCode` と `lastFlushResponseBody`）を更新します。

### 3.2 2ステップ・ヘッドレス（UI なし）メソッド呼び出し (`previewScenarioPayload` + `confirmSubmit`)

JUnit ユニットテスト、インストルメンテーションテスト、またはデバッグスクリプトからは、`AbiDemoActivity` のコンパニオンオブジェクトが提供する 2 ステップ静的メソッドを直接呼び出せます：

```kotlin
import com.anylink.abi.sdk.android.AbiAnalytics
import com.anylink.abi.sdk.android.example.AbiDemoActivity

fun runHeadlessTwoStepDemo() {
    val sdk = AbiAnalytics.init(
        serverUrl = "http://10.0.2.2:8081",
        projectId = 1L,
        projectToken = "abi_tok_android_demo",
        autoFlush = false
    )

    // ステップ 1：デュアル ID、静的・動的共通プロパティ、計測イベント、>2^53-1 大整数、
    // 固定 eventId マイルストーンイベント、7 種類の $user_* 操作を構築し、整形済みリクエスト JSON 文字列を取得
    val pendingRequestJson: String = AbiDemoActivity.previewScenarioPayload(sdk)
    println("=== ステップ 1：送信予定リクエスト JSON プレビュー ===\n$pendingRequestJson")

    // ステップ 2：ワーカースレッドで送信を確定し、単一のレスポンス要約 JSON を取得
    val responseSummaryJson: String = AbiDemoActivity.confirmSubmit(sdk)
    println("=== ステップ 2：直近の送信結果 ===\n$responseSummaryJson")
}
```
