# ABI Go サーバーサイド SDK デモプログラム (Demo)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

本ディレクトリには、**ABI Go サーバーサイド SDK (`github.com/anylink/abi-go-sdk`)** の 2 ステップ対話型デモプログラム [`main.go`](./main.go)（Go 標準ライブラリのみで実装、外部依存ゼロ）が含まれています。

大量のプロセスログに埋もれることなく SDK が生成する実際のプロトコルペイロードを直感的に確認できるよう、本デモでは **「1. パラメータ設定とリクエスト JSON プレビュー (`POST /collect/api/v1/track/batch`) -> 2. 確認後に送信してレスポンス JSON を出力」** というワークフローを採用しています：

1. **ステップ 1（一時保存とプレビュー）**：`abi.NewStagingConsumer` を使用してメモリ上で共通プロパティ（静的/動的）のマージ、識別子検証、および $2^{53}-1$ を超える 64 ビット Snowflake ID の文字列化保護を実行し、送信予定の整形済みリクエスト JSON プレビューを 1 つ出力します（**ネットワーク通信は一切発生しません**）。
2. **ステップ 2（確認と送信）**：
   - 対話型ターミナル（TTY）かつ `--yes` 未指定の場合、`y` + Enter で送信確認を求めます（その他のキーを入力すると即座にキャンセルされ、リクエストは送信されません）；
   - `--yes` が指定された場合、またはパイプ/CI などの非対話環境（非 TTY）では自動的に送信を実行し、ゲートウェイの **`送信レスポンス結果 (Response JSON)`** を出力します。

---

## 1. クイックスタート

ローカル環境に **Go 1.22+** がインストールされていることを確認してください。

### 方法 1：対話形式でリクエスト JSON をプレビューして確認後に送信（デフォルト：注文シナリオ）

ターミナルで直接実行すると、まず `POST /collect/api/v1/track/batch` のリクエスト JSON 全文が表示され、`y` を入力して確認すると内蔵のローカル Mock ゲートウェイ経由で送信が完了します：

```bash
cd abi.sdk/go
go run ./examples/demo
```

### 方法 2：非対話モードで一括送信（自動テスト / 高速検証）

`--yes` を指定するとターミナルでの確認プロンプトをスキップし、**送信予定リクエスト JSON プレビュー**と**送信レスポンス結果 JSON** を順番に出力します：

```bash
cd abi.sdk/go
go run ./examples/demo --yes
```

### 方法 3：共通プロパティとシナリオをカスタマイズして実際の ABI 収集ゲートウェイ (`:8081`) に接続

ローカルまたはテスト環境で `abi.srv` 収集ゲートウェイ（デフォルトは `:8081`）が起動している場合、プロジェクト認証情報、ビジネスシナリオ、共通プロパティをカスタマイズしてプレビューと送信を行えます：

```bash
cd abi.sdk/go
go run ./examples/demo \
  --server-url="http://127.0.0.1:8081" \
  --project-id=1 \
  --token="abi_tok_demo_go" \
  --scenario="all" \
  --super-props='{"$app_version":"2.6.0","$platform":"GoServer","service_name":"checkout-api"}' \
  --dynamic-super=true \
  --dry-run=true
```

---

## 2. コマンドライン引数一覧

| 引数名 | 型 | デフォルト値 | 説明 |
| :--- | :--- | :--- | :--- |
| `--server-url` | `string` | `""`（空文字列） | ABI 収集ゲートウェイのベース URL（例：`http://127.0.0.1:8081`）。空の場合、**送信確認フェーズ**でのみ内蔵ローカル Mock ゲートウェイ（`127.0.0.1:0`）をオンデマンド起動します。 |
| `--project-id` | `int64` | `1` | ABI 対象プロジェクト ID（リクエストボディの `project_id` に対応）。 |
| `--token` | `string` | `"abi_tok_demo_go"` | ABI プロジェクト収集書き込みトークン（リクエストボディの `project_token` に対応）。 |
| `--scenario` | `string` | `"order"` | 生成するデモシナリオ：`browse` \| `identity` \| `order` \| `profile` \| `all`。 |
| `--super-props` | `string` | `'{"$app_version":"2.5.0","$platform":"GoServer","service_name":"order-service"}'` | 静的共通プロパティの JSON 文字列（`'{}'` を渡すと静的共通プロパティの注入を無効化）。 |
| `--dynamic-super` | `bool` | `true` | 動的共通プロパティコールバックを登録するかどうか（行動イベントに `server_region` とリアルタイムの `goroutine_count` を自動注入）。 |
| `--dry-run` | `bool` | `false` | リクエストボディに `"dry_run": true` を付与するかどうか（ゲートウェイは完全な検証のみを行い Kafka / StarRocks へは書き込みません）。 |
| `--yes` | `bool` | `false` | 非対話で自動確認送信を行うかどうか；`--yes=false` かつ標準入力が対話型ターミナルの場合は `y` 入力を待機します。 |

### `--scenario` シナリオ詳細

- `order`（**デフォルト**）：注文ライフサイクル全体のイベント（`TrackWithOptions` 確定冪等キーのデモ；*注：D7① / G6 制限により、`TrackFirst` / `TrackUpdate` / `TrackOverwrite` は現バージョン未開放として統一*）および $2^{53}-1$ を超える 64 ビット Snowflake ID の自動文字列シリアライズ。
- `browse`：未ログイン訪問者の閲覧トラッキング（訪問者 `distinct_id` のみ：`$pageview` と `ProductViewed`）。
- `identity`：ユーザー登録・ログイン時の自動デュアル ID 紐付け（`$signup` + `$login` に `login_id` と訪問者 `distinct_id` の両方を付与し、Flink が自動で紐付け）。
- `profile`：ユーザープロファイルテーブルに対する全 7 種類の `$user_*` 操作（行動イベント用の静的/動的共通プロパティを自動分離し、プロファイルテーブルの汚染を防止）。
- `all`：上記 4 つのシナリオすべてを順番に組み合わせた一括リクエストペイロードを生成。

---

## 3. 2 ステップ呼び出しコード例（JSON をプレビューし、確認後に送信）

アプリケーションコードや検証ツールからは、[`main.go`](./main.go) で公開されている `BuildDemoRequestPreview` と `ConfirmSubmitDemo` を参照するか、SDK の `abi.NewStagingConsumer` を直接使用できます：

```go
package main

import (
	"fmt"
	"log"

	abi "github.com/anylink/abi-go-sdk"
)

func previewThenSubmitExample() {
	// ステップ 1：メモリ一時保存 Consumer（dryRun=false）を初期化し、共通プロパティを設定してイベントを記録
	staging := abi.NewStagingConsumer(1, "abi_tok_demo_go", false)
	sdk := abi.New(staging)

	_ = sdk.SetSuperProperties(map[string]any{
		"$app_version": "2.5.0",
		"$platform":    "GoServer",
		"service_name": "order-service",
	})
	_ = sdk.Track("acct_900102", "vis_dev_7f8e9a01", "OrderPaid", map[string]any{
		"order_no":     "ORD-20261110-8801",
		"snowflake_id": int64(9007199254740999), // > 2^53-1 のため、プレビュー JSON では自動的に "9007199254740999" としてシリアライズ
		"amount":       2549.15,
	})

	// POST /collect/api/v1/track/batch に送信予定の整形済み JSON を確認（この時点ではネットワーク通信は未発生）
	reqJSON, err := staging.PreviewRequestJSON()
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("送信予定リクエスト JSON プレビュー:\n", reqJSON)

	// ステップ 2：内容を確認後に送信し、ゲートウェイからレスポンスを取得（staging.ConfirmSubmit(batchConsumer) で任意の Consumer に転送も可能）
	respEnv, err := staging.SubmitToGateway(abi.BatchConfig{
		ServerURL:    "http://127.0.0.1:8081",
		CompressGzip: true,
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("ゲートウェイ受信確認: accepted=%d, rejected=%d, request_id=%s\n",
		respEnv.Data.Accepted, respEnv.Data.Rejected, respEnv.RequestID)
}
```

> **ヒント**：プレビュー後に共通プロパティを変更してペイロードを再生成したい場合は、`staging.Reset()` を呼び出して一時保存キューをクリアし、`sdk.SetSuperProperties(...)` を更新してから再度イベントを記録し `staging.PreviewRequestJSON()` を呼び出してください。

---

## 4. 本番環境向け高スループット非同期統合リファレンス

本番の高並行マイクロサービス環境では、事前のペイロードプレビューと結合検証が完了した後、プロセス起動時にグローバルで単一の非同期バッチ `*abi.BatchConsumer`（Gzip 圧縮、件数/時間間隔のデュアルトリガー、429/5xx べき等リトライ対応）を初期化し、プロセス終了前に `analytics.Close()` を呼び出してバッファ内の全イベントを確実にフラッシュすることを推奨します：

```go
consumer, err := abi.NewBatchConsumer(abi.BatchConfig{
	ServerURL:     "http://127.0.0.1:8081",
	ProjectID:     1,
	ProjectToken:  "abi_tok_demo_go",
	BatchSize:     100,
	FlushInterval: 2 * time.Second,
	CompressGzip:  true,
})
if err != nil {
	log.Fatal(err)
}
analytics := abi.New(consumer)
defer analytics.Close()
```
