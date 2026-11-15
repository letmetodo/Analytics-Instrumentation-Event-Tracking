# ABI Go サーバーサイド SDK (`github.com/anylink/abi-go-sdk`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`abi-go-sdk` は、**ABI エンタープライズユーザー行動分析（UBA）& BI プラットフォーム** の公式 Go サーバーサイドデータ収集 SDK です（API 設計は ThinkingData / Sensors Data に準拠）。Go 標準ライブラリのみで実装されており（**外部依存ゼロ**）、厳格な識別子・プロパティ正規化検証、64 ビット整数の精度保護、および 4 種類のプラガブルな転送コンシューマー（Consumer）を備えています。

---

## 1. 主な特徴と 4 大 Consumer アーキテクチャ

### 主な特徴
- **外部依存ゼロ（Zero Dependencies）**：Go 1.22+ 標準ライブラリのみで構築されており、マイクロサービスへの導入時に依存パッケージの競合が発生しません。
- **スレッドセーフ（並行安全）**：`AbiAnalytics` クライアントおよびすべての内蔵 Consumer は並行安全に設計されており、シングルトンとして数千の Goroutine から同時に呼び出すことができます。
- **クライアントサイド事前検証**：イベント名・プロパティキーの正規表現検証（`^[a-zA-Z$#][a-zA-Z0-9_$#]{0,127}$`、および許可リストに登録されたシステム予約名のみ許可）、UTF-8 エンコーディング検証、バイト長制限（`distinct_id`/`event_id` ≤ 64 バイト、`login_id` ≤ 128 バイト；`distinct_id` と `login_id` の少なくとも一方が非空必須、`login_id` を `distinct_id` にコピーしない）をローカルで自動実行します。
- **64 ビット Snowflake ID 精度保護（`> 2^53 - 1` の自動文字列変換）**：絶対値が IEEE-754 倍精度浮動小数点の安全整数上限（`9007199254740991`）を超える `int64` / `uint64` プロパティ値（配列要素を含む）を自動的に 10 進文字列へシリアライズし、フロントエンドの JSON パースや言語間転送での精度欠損を防止します。
- **静的・動的共通プロパティの階層マージ**：`静的共通プロパティ < 動的共通プロパティ < イベント個別プロパティ` の優先順位に従ってマージを行い、`$user_*` / `#user_*` プロファイル操作時には共通プロパティを自動分離してユーザープロファイルテーブルの汚染を防ぎます。
- **イベント発生時刻とクライアント IP の自動抽出**：プロパティ内の `#time` / `$time`（ミリ秒単位のイベント `timestamp` として抽出し `properties` から除去）および `#ip` / `$ip`（収集ゲートウェイでのサーバーサイド GeoIP 地域解析オーバーライド用）をサポートします。

### 4 大 Consumer アーキテクチャ

| Consumer 種別 | コンストラクタ | 主な用途と機能 |
| :--- | :--- | :--- |
| **`StagingConsumer`** | `abi.NewStagingConsumer` | **2 ステッププレビューと確認送信**：イベントをメモリキューに一時保存し、`PreviewRequestJSON()` で `POST /collect/api/v1/track/batch` に送信予定の整形済み JSON を事前確認（ネットワーク通信ゼロ）した上で、`SubmitToGateway()` または `ConfirmSubmit()` で正式送信します。 |
| **`BatchConsumer`** | `abi.NewBatchConsumer` | **本番環境向け高スループット非同期バッチ送信**：メモリバッファリング、バッチ件数（`BatchSize`、デフォルト 50、最大 500）および時間間隔（`FlushInterval`、デフォルト 3 秒）のデュアルトリガー非同期フラッシュ、Gzip 圧縮、さらに `429` / `5xx` 応答に対する指数バックオフべき等リトライ（元の `event_id` を維持し StarRocks での重複排除を保証）を提供します。 |
| **`LoggerConsumer`** | `abi.NewLoggerConsumer` | **ローカル JSONL ローテーション保存**：イベントを改行区切り JSON（JSONL）としてローカルディスクに書き込み、日次（`RotateDaily`）・時間次（`RotateHourly`）およびファイルサイズ上限（`MaxFileSizeMB`）による自動ローテーションをサポートします（Filebeat / Vector / LogBus 連携に最適）。 |
| **`DebugConsumer`** | `abi.NewDebugConsumer` | **開発時同期 L4 検証と `dry_run`**：`debug=true`（および Kafka / StarRocks への書き込みを行わず検証のみを実行する `DryRun: true`）で 1 件ずつ同期送信し、ゲートウェイの L3/L4 メタデータ・契約エラーを即座に返却します。 |

---

## 2. インストールと動作環境

- **Go バージョン要件**：Go `1.22` 以上
- **外部依存パッケージ**：なし（Go 標準ライブラリのみ）

```bash
go get github.com/anylink/abi-go-sdk
```

ABI モノレポ内で検証・テストを実行する場合は、`abi.sdk/go` ディレクトリ内で直接コマンドを実行できます。

---

## 3. サーバーサイド導入時の必須フィールドとクライアント透過転送ガイド（IP / ID / 時刻 / べき等キー）

### 3.1 なぜサーバーサイド SDK とフロントエンド／モバイル SDK で必須項目が異なるのか？

- **フロントエンド／モバイル SDK（Web / iOS / Android / ミニプログラム）**：**単一ユーザーの端末上**で動作し、収集ゲートウェイへ直接通信します。SDK が端末ローカルで `distinct_id`（訪問者/端末 ID、ThinkingData `getDistinctId()` 準拠）を自動生成・永続化し、`login(accountId)` 呼び出し時はローカルの `login_id` のみを更新（個別バインドイベントは送信しない）するほか、ゲートウェイもクライアントとの TCP 接続からユーザーの実際のグローバル IP を直接取得できます。
- **Go / Java サーバーサイド SDK**：**バックエンドのデータセンターやクラウド VPC 内で動作するステートレスなマルチユーザー共有シングルトン**です。単一ユーザーのセッション状態をメモリに保持することはできず、`:8081` 収集ゲートウェイへの TCP 接続元も**バックエンドサーバー自身のデータセンター／内部 IP** になります（`LoggerConsumer` によるディスク出力では通信接続すら存在しません）。そのため、**ユーザー ID、実際のクライアント IP、実際のビジネス発生時刻、べき等イベント ID** はすべて、導入担当エンジニアが現在のリクエストコンテキストやメッセージペイロードから明示的に渡す必要があります。

### 3.2 サーバーサイド導入フィールドの必須度と取得元一覧表

| フィールド分類 | SDK 引数 / `properties` キー名 | 必須レベル | 必要な理由と取得・透過転送の方法 |
| :--- | :--- | :--- | :--- |
| **ユーザー識別子**<br>(`login_id` / `distinct_id`) | Go: `accountID`(`login_id`) + `distinctID`(`distinct_id`)<br>または `TrackOptions{AccountID, DistinctID}` | **【毎回呼び出し時に必須】** | ThinkingData 準拠のデュアル ID 契約：プロトコル上は `distinct_id`（訪問者/端末 ID、≤ 64 バイト）と `login_id`（アカウント ID、≤ 128 バイト）の 2 つのみを送信し、**少なくとも 1 つは非空必須**です（`distinct_id` が空の場合は `login_id` をコピーせず `distinct_id: ""` と `login_id` をそのまま送信します）。<br>**「フロントエンドでの訪問者閲覧 → バックエンドでの注文・決済」**ファネルを繋ぐには、フロントエンドから HTTP ヘッダー（例：`X-ABI-Distinct-Id: abi.getDistinctId()`）で `distinct_id` をバックエンドへ渡してください。任意の `Track*` / `User*` イベントが `login_id` と `distinct_id` の両方を持つと、Flink が自動的に ID 紐付けを実行します。 |
| **実際のクライアント IP**<br>(`#ip` / `$ip`) | `properties["#ip"]`<br>（または `properties["$ip"]`） | **【地域分析を行う場合は必須】** | バックエンドから収集ゲートウェイ `:8081` へ送信する際、ゲートウェイの TCP 接続に見えるのは**バックエンドサーバーのデータセンター IP** です（`LoggerConsumer` では接続 IP すらありません）。**`#ip` / `$ip` を渡さないと、すべてのイベントの国・都道府県・都市がデータセンター所在地またはプライベート IP になってしまいます！**<br>クライアントの HTTP リクエストヘッダー（`X-Forwarded-For` の先頭グローバル IP または `X-Real-IP`）からユーザーの実際のグローバル IP を抽出し、`properties["#ip"]`（または `"$ip"`）に設定してください。ゲートウェイと Flink Job1 ETL は `#ip` > `$ip` の優先順で国・地域・都市（`$country` / `$province` / `$city`）を解決し、保存前に `properties` から該当の一時キーを自動的に除去します。 |
| **イベント発生時刻**<br>(`#time` / `$time` / `Timestamp`) | `properties["#time"]` / `properties["$time"]`<br>または `TrackOptions.Timestamp` | **【リアルタイム通信は省略可／非同期 MQ・コールバック・データ補填時は必須】** | 同期 HTTP API で省略した場合はサーバーの現在時刻が使用されますが、**Kafka/RocketMQ の非同期コンシューマー、決済 Webhook コールバック、オフラインバッチによる過去データ補填**では、処理時刻と実際のビジネス発生時刻が乖離するため、`properties["#time"]`（`time.Time`、ミリ秒タイムスタンプ、RFC3339、または `"2006-01-02 15:04:05.000"`）または `TrackOptions.Timestamp` で実際の発生時刻を渡す必要があります（プロジェクトの `ts_window_days` 期間内である必要があり、抽出後は `properties` から自動除去されます）。 |
| **べき等イベント ID**<br>(`event_id`) | `TrackOptions.EventID` | **【MQ 消費・基幹トランザクションでは強く推奨】** | 省略時はランダムな UUIDv4 が自動生成されますが、**MQ の再配信や決済コールバックのリトライ**で毎回新しい UUID が生成されると、注文数や決済金額が二重計上されます。`TrackWithOptions` を使用し、決定論的な業務主キー（例：`"ord_paid_" + orderNo`、64 バイト以内）を `EventID` に指定して同日のべき等重複排除を行うことを強く推奨します（注：D7① / G6 制限により、`TrackFirst` / `TrackUpdate` / `TrackOverwrite` は現バージョン未開放で `ErrUnsupportedMutableTrack` を返します）。 |
| **クライアント端末コンテキスト**<br>(`$os` / `$app_version` / `$device_model`) | `properties["$os"]`<br>`properties["$app_version"]`<br>`properties["$device_model"]` | **【必要に応じてフロントエンドから透過転送】** | バックエンドサーバーはユーザーの端末モデルやアプリバージョンを自動検知できません。サーバーサイドイベント（決済完了など）をクライアント OS やアプリバージョン別に分析したい場合は、フロントエンドのリクエストヘッダー（例：`X-Client-OS`、`X-App-Version`）から受け取り、個別イベントの `properties` に書き込んでください（全ユーザー共通の `SetSuperProperties` には絶対に入れないでください）。 |

---

## 4. クイックスタートと本番導入コード例

### 4.1 2 ステップでのリクエスト JSON プレビューと確認送信（`StagingConsumer`）

開発時の結合検証や自動テストでは、まず送信予定のリクエスト JSON 全文（クライアントから透過転送された `"#ip"` や注文 ID `"order_id"` を含む）をプレビューし、パラメータと共通プロパティを確認してからゲートウェイへの送信または他の Consumer への転送を行うことができます：

```go
package main

import (
	"fmt"
	"log"

	abi "github.com/anylink/abi-go-sdk"
)

func main() {
	// ステップ 1：StagingConsumer（projectID=1, dryRun=false）を作成し、メモリ上でイベントを記録
	staging := abi.NewStagingConsumer(1, "abi_tok_demo_go", false)
	sdk := abi.New(staging)

	_ = sdk.SetSuperProperties(map[string]any{
		"$platform":    "GoServer",
		"service_name": "order-service",
	})

	_ = sdk.Track("acct_900102", "vis_dev_7f8e9a01", "OrderPaid", map[string]any{
		"#ip":          "203.0.113.42",          // クライアントの X-Forwarded-For / X-Real-IP から抽出した実際のグローバル IP
		"order_id":     int64(9007199254740999), // > 2^53-1 の Snowflake ID。自動的に文字列 "9007199254740999" に変換
		"order_no":     "ORD-20261110-8801",
		"amount":       2549.15,
		"$os":          "iOS",                   // 必要に応じてフロントエンドヘッダーから透過転送した OS 情報
		"$app_version": "2.5.0",
	})

	// POST /collect/api/v1/track/batch リクエスト JSON 全文をプレビュー（ネットワークリクエストなし）
	reqJSON, err := staging.PreviewRequestJSON()
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("=== 送信予定リクエスト JSON プレビュー ===")
	fmt.Println(reqJSON)

	// ステップ 2（方法 A）：確認後に ABI 収集ゲートウェイへ直接送信し、レスポンスエンベロープを取得
	env, err := staging.SubmitToGateway(abi.BatchConfig{
		ServerURL:    "http://127.0.0.1:8081",
		CompressGzip: true,
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("送信成功: accepted=%d, rejected=%d, request_id=%s\n",
		env.Data.Accepted, env.Data.Rejected, env.RequestID)

	// ステップ 2（方法 B）：または ConfirmSubmit で任意の初期化済み Consumer（BatchConsumer / LoggerConsumer など）へ転送
	// _ = staging.ConfirmSubmit(batchConsumer)
}
```

### 4.2 本番環境向け高スループット `BatchConsumer`、HTTP ヘッダー透過転送と全 API 使用例

以下の例では、`BatchConsumer` の初期化、HTTP リクエストヘッダーからの訪問者 `distinct_id` とクライアント IP の抽出、`TrackWithOptions` による決定論的 `EventID` の指定、行動イベント送信（`#time`/`$time` 時刻抽出、`#ip`/`$ip` GeoIP オーバーライド、`> 2^53 - 1` の大整数自動文字列変換を含む）、および全 7 種類のユーザープロファイル操作を網羅しています：

```go
package main

import (
	"log"
	"net/http"
	"runtime"
	"strings"
	"time"

	abi "github.com/anylink/abi-go-sdk"
)

// extractClientIP はリバースプロキシヘッダーからクライアントの実際のグローバル IP を抽出します（データセンター IP の誤記録を防止）
func extractClientIP(r *http.Request) string {
	if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	return strings.TrimSpace(r.Header.Get("X-Real-IP"))
}

func main() {
	// 1. 本番環境向け高スループット非同期 BatchConsumer の初期化（Gzip 圧縮 + 指数バックオフリトライ）
	consumer, err := abi.NewBatchConsumer(abi.BatchConfig{
		ServerURL:     "http://127.0.0.1:8081",
		ProjectID:     1,
		ProjectToken:  "abi_tok_prod_xxx",
		BatchSize:     100,
		FlushInterval: 2 * time.Second,
		MaxCacheSize:  10000,
		Timeout:       10 * time.Second,
		MaxRetries:    3,
		CompressGzip:  true,
		OnError: func(err error, dropped []abi.TrackEvent) {
			log.Printf("[ABI SDK] バッチ送信失敗 (dropped=%d): %v", len(dropped), err)
		},
	})
	if err != nil {
		log.Fatal(err)
	}

	sdk := abi.New(consumer)
	defer sdk.Close() // プロセス終了前にバッファ内の残イベントをフラッシュして安全にクローズ

	// 2. 静的共通プロパティ管理（サーバー自身の環境情報のみを設定し、個別ユーザーの IP や端末情報は入れないこと）
	_ = sdk.SetSuperProperties(map[string]any{
		"$platform":    "GoServer",
		"service_name": "checkout-service",
		"temp_flag":    "will_be_removed",
	})
	sdk.UnsetSuperProperty("temp_flag")
	currentSuper := sdk.GetSuperProperties()
	_ = currentSuper
	// すべての静的共通プロパティをクリアする場合：sdk.ClearSuperProperties()

	// 3. 動的共通プロパティ（行動イベント生成時に毎回評価；優先順位：静的共通 < 動的共通 < イベント個別プロパティ）
	sdk.SetDynamicSuperProperties(func() map[string]any {
		return map[string]any{
			"server_region":   "ap-shanghai",
			"goroutine_count": runtime.NumGoroutine(),
		}
	})

	// リクエストコンテキストおよびフロントエンド透過ヘッダー（X-ABI-Distinct-Id、X-Forwarded-For など）から ID と IP を取得
	accountID := "acct_900102"
	distinctID := "vis_dev_7f8e9a01" // フロントエンドヘッダー r.Header.Get("X-ABI-Distinct-Id") から取得
	clientIP := "203.0.113.42"       // extractClientIP(r) から取得

	// 4. 自動デュアル ID 紐付け：個別バインド API は不要。任意の Track* / User* イベントに accountID (login_id) と distinctID の両方を渡すと Flink が自動で紐付けます
	_ = sdk.Track(accountID, distinctID, "$login", map[string]any{
		"#ip":          clientIP,
		"login_method": "sso_oidc",
	})

	// 5. 行動イベント送信
	// 5.1 標準行動イベント Track（#ip クライアント実 IP、#time カスタム発生時刻、order_id > 2^53-1 大整数の自動文字列変換を含む）
	_ = sdk.Track(accountID, distinctID, "OrderPaid", map[string]any{
		"#time":        "2026-11-10 14:30:00.125", // time.Time / ミリ秒タイムスタンプ / "$time" も指定可能；イベント timestamp として抽出され properties からは除去
		"#ip":          clientIP,                  // クライアントの実際のグローバル IP（"#ip" または "$ip"）を必ず指定し、地域がサーバー IP になるのを防ぐ
		"order_id":     int64(9007199254740999),   // 2^53-1 (9007199254740991) を超えるため自動的に文字列 "9007199254740999" に変換
		"order_no":     "ORD-20261110-8801",
		"amount":       2549.15,
		"item_skus":    []string{"sku_abi_ent", "sku_addon_flink"},
		"$os":          "iOS",                     // 必要に応じてフロントエンドヘッダーから透過転送したクライアント情報
		"$app_version": "2.5.0",
	})

	// 5.1b MQ コンシューマーや決済コールバックでは TrackWithOptions で決定論的 EventID と実際の発生時刻 Timestamp を指定
	_ = sdk.TrackWithOptions(abi.TrackOptions{
		EventID:    "ord_paid_ORD-20261110-8801", // MQ 再試行時の重複計上を防ぐ決定論的ビジネス主キー
		EventName:  "OrderPaid",
		AccountID:  accountID,
		DistinctID: distinctID,                   // フロントエンドの訪問者 distinct_id を同時に渡し、前後端のファネルを統合（不明時は ""）
		Timestamp:  time.Now().UTC(),             // 非同期処理時は実際のビジネス発生時刻を指定
		Properties: map[string]any{
			"#ip":      clientIP,
			"order_id": int64(9007199254740999),
			"order_no": "ORD-20261110-8801",
			"amount":   2549.15,
		},
	})

	// 5.2 ステータス遷移は独立したマイルストーンイベントとして送信（注：D7① / G6 制限により、TrackFirst/TrackUpdate/TrackOverwrite は現バージョン未開放であり ErrUnsupportedMutableTrack を返します）
	_ = sdk.TrackWithOptions(abi.TrackOptions{
		EventID:    "ord_fulfilled_ORD-20261110-8801",
		EventName:  "OrderFulfilled",
		AccountID:  accountID,
		DistinctID: distinctID,
		Properties: map[string]any{
			"#ip":            clientIP,
			"order_id":       int64(9007199254740999),
			"order_status":   "FULFILLED",
			"paid_amount":    2549.15,
			"invoice_issued": true,
		},
	})

	// 6. 全 7 種類のユーザープロファイル操作（静的/動的共通プロパティは自動的に分離されます）
	// 6.1 UserSet ($user_set)：ユーザープロファイルプロパティを上書き設定
	_ = sdk.UserSet(accountID, distinctID, map[string]any{
		"company_name": "Acme Analytics Corp",
		"plan_tier":    "Enterprise",
		"seat_count":   50,
	})

	// 6.2 UserSetOnce ($user_set_once)：プロパティが未設定の場合のみ初期値を書き込み（初回流入元チャネルなど）
	_ = sdk.UserSetOnce(accountID, distinctID, map[string]any{
		"first_utm_source": "github_release",
		"registered_at":    time.Now().UTC(),
	})

	// 6.3 UserAdd ($user_add)：数値型プロファイルプロパティのアトミック加算（非数値型はクライアント側でエラーとして拒否）
	_ = sdk.UserAdd(accountID, distinctID, map[string]any{
		"cumulative_payment": 2549.15,
		"order_count":        1,
	})

	// 6.4 UserAppend ($user_append)：リスト型プロファイルプロパティへの要素追加（重複排除なし）
	_ = sdk.UserAppend(accountID, distinctID, map[string]any{
		"browsed_categories": []string{"uba", "funnel"},
	})

	// 6.5 UserUniqAppend ($user_uniq_append)：リスト型プロファイルプロパティへの重複排除付き要素追加
	_ = sdk.UserUniqAppend(accountID, distinctID, map[string]any{
		"certified_badges": []string{"early_adopter", "enterprise_admin"},
	})

	// 6.6 UserUnset ($user_unset)：指定したユーザープロファイルプロパティキーをリセット
	_ = sdk.UserUnset(accountID, distinctID, "trial_flag", "legacy_coupon")

	// 6.7 UserDelete ($user_del)：当該ユーザーのプロファイルレコードを削除
	// _ = sdk.UserDelete(accountID, distinctID)
}
```

### 4.3 ローカル JSONL ローテーション保存（`LoggerConsumer`）と同期デバッグ検証（`DebugConsumer`）

```go
// LoggerConsumer：イベントを日次または時間次でローカル JSONL ファイルに出力（Filebeat / Vector 収集用）
// 注意：ディスク出力モードではクライアントの TCP 接続情報が存在しないため、地域分析が必要な場合は properties に "#ip" を必ず指定してください
loggerConsumer, err := abi.NewLoggerConsumer(abi.LoggerConfig{
	Directory:     "/var/log/abi-events",
	FilePrefix:    "abi.log",
	RotateMode:    abi.RotateDaily, // abi.RotateDaily ("DAILY") または abi.RotateHourly ("HOURLY") をサポート
	MaxFileSizeMB: 256,             // 単一ファイルが 256MB を超えると自動的に _1, _2 サフィックスで分割
})

// DebugConsumer：開発時に 1 件ずつ同期送信し、ゲートウェイの L4 メタデータ強検証を実行
debugConsumer, err := abi.NewDebugConsumer(abi.DebugConfig{
	ServerURL:    "http://127.0.0.1:8081",
	ProjectID:    1,
	ProjectToken: "abi_tok_demo_go",
	DryRun:       true, // true の場合はゲートウェイで完全検証のみを行い、Kafka / StarRocks へは書き込まない
})
```

---

## 5. 対話型 CLI デモと単体テスト検証

### 対話型 CLI デモの実行（[`examples/demo`](./examples/demo/README.ja.md)）

```bash
cd abi.sdk/go

# 対話形式でリクエスト JSON をプレビューし、ターミナルで y を入力して送信
go run ./examples/demo

# 非対話モードで全 4 シナリオのプレビューと送信を一括実行
go run ./examples/demo --scenario="all" --yes
```

コマンドライン引数の詳細は [`examples/demo/README.ja.md`](./examples/demo/README.ja.md) を参照してください。

### テストと並行競合（Race Detector）の実行

テストスイートには、ゴールデンテストベクター（Golden Test Vectors）契約テスト、大整数精度保護テスト、並行競合テスト、および 4 大 Consumer の統合テストが含まれています：

```bash
cd abi.sdk/go
go test -race -v ./...
```
