# ABI Python 3 サーバーサイド SDK (`abi.sdk/python`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`abi_sdk.py` は **ABI エンタープライズユーザー行動分析（UBA）＆ BI プラットフォーム** の公式 Python 3 サーバーサイドデータ収集 SDK です（ThinkingData Python Server SDK v3.4 仕様に準拠）。**Python 3 標準ライブラリのみで実装（サードパーティ依存ゼロ）** されており、ABI 収集ゲートウェイ（`:8081`）および Flink リアルタイム ETL と完全に一致する識別子検証、64 ビット大整数精度保護、および 4 種類のプラガブル Consumer を備えています。

---

## 1. 主な特徴と 4 種類の Consumer アーキテクチャ

### 主な特徴
- **外部依存ゼロ**：Python 3.9+ 標準ライブラリ（`urllib.request`、`gzip`、`threading`、`json`、`datetime`）のみで構築されており、FastAPI、Django、Flask、Celery、Airflow へそのまま組み込み可能です。
- **スレッドセーフ**：`AbiAnalytics` とすべての Consumer は内部ロックによりスレッドセーフに設計されており、マルチスレッド環境でシングルトンとして安全に共有できます。
- **厳格なローカルスキーマ検証**：
  - 文字列トリミングの前に ASCII 制御文字（`0x00–0x08`、`0x0E–0x1F`、`0x7F`）を遮断し、前後の Unicode 空白文字を除去した上で UTF-8 バイト上限（訪問者／端末 ID `distinct_id <= 64`、アカウント ID `login_id <= 128`、`event_id <= 64`）を検証します。
  - ThinkingData 準拠のデュアル ID 契約：`distinct_id` と `login_id` の少なくとも一方が非空である必要があり、`distinct_id` が空の場合は `login_id` をコピーせず `distinct_id: ""` と `login_id: "<account>"` をそのまま送信します（両方空の場合はエラーを送出）。
  - カスタムイベント名（`<= 128` 文字）と属性キー（`<= 64` 文字）は `^[A-Za-z_][A-Za-z0-9_]*$` を検証し、システム予約イベント（`$signup`、`$login`、`$user_*` 等）とシステム属性エイリアス（`#ip`/`$ip`、`#time`/`$time`、`$os` 等）を許可します。
- **64 ビット大整数精度保護（`> 2^53 - 1` 自動文字列化）**：Python では `bool` が `int` のサブクラスであるため、先に `isinstance(v, bool)` を判定します。絶対値が IEEE-754 安全整数上限 `9007199254740991`（$2^{53}-1$）を超える整数（リスト要素内の Snowflake ID 等を含む）を自動的に 10 進文字列へ変換し、`NaN`、`Infinity`、`None` を含む配列やネスト構造を遮断します。
- **共通属性の優先順位とプロファイル分離**：行動イベントでは `super_properties < dynamic_super_properties < イベント明示 properties` の優先順位でマージし、`$user_*` / `#user_*` プロファイル更新イベントには共通属性を混入させません。

### 4 種類の Consumer

| Consumer クラス | 初期化 | 用途と主な機能 |
| :--- | :--- | :--- |
| **`StagingConsumer`** | `StagingConsumer(project_id, project_token, dry_run=False)` | **2 段階プレビュー＆確認送信**：メモリ上にイベントを一時保持し、ステップ 1 で `preview_request_json()` により `POST /collect/api/v1/track/batch` の単一リクエスト JSON をプレビュー（通信なし）、ステップ 2 で `submit_to_gateway()` または `confirm_submit(target_consumer)` で正式送信します。 |
| **`BatchConsumer`** | `BatchConsumer(server_url, project_id, project_token, ...)` | **本番用高スループット非同期バッチ送信**：バックグラウンドスレッドが件数（`batch_size`、既定 50、最大 500）または周期（`flush_interval`、既定 3.0 秒）で自動フラッシュし、Gzip 圧縮および HTTP `429` / `5xx` 発生時の指数バックオフ再試行（元の `event_id` を維持し StarRocks で冪等重複排除）を行います。 |
| **`LoggerConsumer`** | `LoggerConsumer(directory, file_prefix="abi.log", ...)` | **ローカル JSONL ファイルローテーション**：UTC 日付（`DAILY`、例：`abi.log.2026-11-10.jsonl`）または UTC 時間（`HOURLY`）およびファイルサイズ上限で `.jsonl` ファイルを分割出力し、Filebeat / Vector / LogBus と連携します。 |
| **`DebugConsumer`** | `DebugConsumer(server_url, project_id, project_token, dry_run=False)` | **開発時同期 L4 検証＆ `dry_run`**：`debug: True`（および任意の `dry_run: True`）を付与して 1 件ずつ同期送信し、検証エラー時は直ちに `AbiGatewayError` を送出します。 |

---

## 2. 実装担当者向け：サーバーサイド必須フィールドとクライアント透過ガイド（`#ip`・都度必須の ID・非同期 `#time`・冪等 `event_id`）

サーバーサイド SDK はバックエンド環境で動作する **ステートレスなマルチユーザー共有インスタンス** であるため、フロントエンド／モバイル SDK とはフィールドの指定責務が異なります。実装時は以下の 4 点を必ず守ってください：

| 重要フィールド | SDK 引数 / `properties` キー | 必須レベル | 理由と実装ガイドライン |
| :--- | :--- | :--- | :--- |
| **1. クライアント実 IP (`#ip` / `$ip`)** | `properties["#ip"]`<br>または `properties["$ip"]` | **【地域分析を行う場合は必須】** | バックエンドから収集ゲートウェイ（`:8081`）へ送信すると、TCP 接続元 IP は**データセンター／NAT の IP** になります（`LoggerConsumer` では接続 IP 自体が存在しません）。**`#ip` を渡さないと、全ユーザーの国・都道府県・都市がサーバー設置場所になってしまいます。**<br>`X-Forwarded-For` や `X-Real-IP` ヘッダーからクライアントのグローバル IP を取得し、`properties["#ip"]` に設定してください。Flink ETL が `#ip` > `$ip` の優先順で GeoIP を解決し、保存前にプロパティから自動除去します。 |
| **2. 呼び出しごとのユーザー ID (`account_id` / `distinct_id`)** | `track(account_id, distinct_id, ...)`<br>または `login_id` / `distinct_id` | **【毎回呼び出し時に必須】** | サーバー SDK はユーザーセッションを保持しないため、毎回アカウント ID `account_id`（通信フィールド `login_id <= 128B`）またはフロントエンドから透過された訪問者 ID `distinct_id`（`<= 64B`）の少なくとも一方を渡す必要があります。<br>「未ログイン閲覧 → バックエンド決済」のファネルを繋ぐには、フロントエンドから HTTP ヘッダー（例：`X-ABI-Distinct-Id`）で `distinct_id` を受け取り、`track*` や `user_*` に両方渡すだけで Flink がリアルタイムに ID 紐付けを自動実行します。 |
| **3. 実際のイベント発生時刻 (`#time` / `$time` / `timestamp`)** | `properties["#time"]`<br>または `timestamp=...` | **【非同期 MQ・Webhook・過去データ投入時は必須】** | 同期 API では省略時に現在時刻が使われますが、**Kafka / Celery 非同期コンシューマー、決済 Webhook、バッチ補填**では処理時刻と発生時刻がずれるため、`properties["#time"]`（`datetime`、正の秒/ミリ秒数値、ISO-8601 文字列に対応）で実際の発生時刻を渡してください。SDK がトップレベルのミリ秒 `timestamp` に変換し、`properties` から自動除去します。 |
| **4. 決定的冪等キー (`event_id`)** | `track(..., event_id="...")`<br>（注：D7① / G6 制限により `track_first` / `track_update` / `track_overwrite` は現バージョン未開放） | **【基幹トランザクション・MQ 再試行時は強く推奨】** | 省略時はランダムな UUIDv4 が生成されますが、**MQ 再配信や決済コールバック再送**での二重計上を防ぐため、`f"ord_paid_{order_no}"`（64 UTF-8 バイト以内）のような確定的な業務主キーを `event_id` に指定することを強く推奨します。 |

---

## 3. クイックスタートとコード例

### 3.1 2 段階リクエスト JSON プレビューと確認送信（`StagingConsumer`）

```python
from abi_sdk import AbiAnalytics, StagingConsumer

# ステップ 1：メモリ上でイベントを記録し、単一のリクエスト JSON をプレビュー（ネットワーク通信なし）
staging = StagingConsumer(project_id=1, project_token="abi_tok_demo_py", dry_run=False)
sdk = AbiAnalytics(staging)

sdk.set_super_properties({
    "$platform": "PythonServer",
    "service_name": "order-service",
})

sdk.track(
    account_id="acct_900102",
    distinct_id="anon_py_7f8e9a01",
    event_name="OrderPaid",
    event_id="ord_paid_20261110_8801",
    properties={
        "#ip": "203.0.113.42",              # クライアントの実グローバル IP
        "#time": "2026-11-10T10:00:00Z",    # トップレベル timestamp (ミリ秒) へ変換され properties から除去
        "order_id": 9007199254740999,       # 2^53-1 超の Snowflake ID -> 自動的に文字列 "9007199254740999" に変換
        "pay_amount": 2549.15,
        "is_first_order": True,
    },
)

print("=== 送信予定リクエスト JSON プレビュー ===")
print(staging.preview_request_json())

# ステップ 2：内容確認後に収集ゲートウェイへ送信
resp = staging.submit_to_gateway("http://127.0.0.1:8081", compress_gzip=True)
print("Gateway Response:", resp)
```

---

## 4. 2 段階 CLI デモとユニットテストの実行

```bash
# 標準 unittest スイートの実行（言語横断ゴールデンテストベクター検証を含む）
python3 -m unittest discover -s abi.sdk/python/tests -v

# 2 段階 CLI デモの実行（単一リクエスト JSON プレビューと単一レスポンス JSON の出力）
python3 abi.sdk/python/examples/demo.py --yes
```
