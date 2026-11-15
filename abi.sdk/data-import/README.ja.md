# ABI データインポート＆サーバーログ転送スイート (`abi.sdk/data-import`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`abi.sdk/data-import` は [ThinkingData v3.4 データインポート・転送ツールスイート](https://docs.thinkingdata.cn/ta-manual/v3.4/installation/installation_menu/installation_menu.html)（`LogBus 2`、`Filebeat + Logstash`、`Vector`、`ta-datax-writer`）に準拠し、以下の 2 つの本番シナリオ向けの標準ツールと設定テンプレートを提供します：

1. **サーバー SDK ローカル `.jsonl` ログのリアルタイム転送**：Go / Java サーバー SDK の `LoggerConsumer` がローカルディスクに出力した `abi.log.YYYY-MM-DD` ファイルを、外部プロセス（`abi_logbus.py`、`Filebeat + Logstash`、または `Vector`）がバイトオフセット（Byte Offset）管理付きで非同期に読み取り、Gzip 圧縮バッチとして ABI 収集ゲートウェイ（`:8081`）へ転送します。
2. **過去オフラインデータの一括移行（DataX）**：既存の RDB（MySQL / PostgreSQL）や DWH に蓄積された過去の注文・会員登録・ユーザープロファイルデータを、[`datax/ta-datax-abi-writer.json`](datax/ta-datax-abi-writer.json) を用いて ABI 収集ゲートウェイおよび StarRocks OLAP へ一括インポートします。

---

## 1. ディレクトリ構成とツール比較

| ファイル / ディレクトリ | ThinkingData 対応機能 | 役割と推奨ユースケース | 外部依存 |
|-------------------------|-----------------------|------------------------|----------|
| [`abi_logbus.py`](abi_logbus.py) | **LogBus 2** | `LoggerConsumer` が出力した `.jsonl` ディレクトリをスキャンしてバッチ転送する軽量ツール。Inode + Byte Offset チェックポイント（`.abi_logbus_state.json`）、Gzip 圧縮、`#time` 抽出、64 ビット大整数保護、および**2 段階のリクエスト JSON プレビュー（`--preview`）と確定送信（`--yes`）**を内蔵 | Python 3 標準ライブラリのみ（外部パッケージ不要） |
| [`filebeat-logstash/filebeat.abi.yml`](filebeat-logstash/filebeat.abi.yml)<br/>[`filebeat-logstash/logstash.abi.conf`](filebeat-logstash/logstash.abi.conf) | **Filebeat + Logstash** | Elastic Stack 環境向けの標準パイプライン：Filebeat が `abi.log.*` を末尾追従し、Logstash が正規化および HTTP Gzip バッチ送信を実行 | Filebeat 8.x + Logstash 8.x |
| [`vector/vector.abi.toml`](vector/vector.abi.toml) | **Vector Shipper** | Kubernetes DaemonSet / サイドカー向けの省メモリ・高スループット転送設定 | Vector 0.38+ |
| [`datax/ta-datax-abi-writer.json`](datax/ta-datax-abi-writer.json) | **ta-datax-writer** | 既存データベースから過去イベント・プロファイルデータを一括移行するジョブ設定 | Alibaba DataX |

---

## 2. オフラインインポート＆ログ転送における必須フィールド規約

サーバーログ転送や過去データ移行では、送信元マシンがエンドユーザーの端末ではなく、送信時刻も実際のイベント発生時刻と異なるため、以下の 5 つのルールを必ず守ってください：

| フィールド | プロトコル位置 | 必須性 | 重要性・バックエンド処理ルール |
|------------|----------------|--------|--------------------------------|
| **クライアント公開 IP**<br/>(`#ip` / `$ip`) | `properties["#ip"]` | **強く推奨** | ゲートウェイが観測する TCP 接続元 IP はバックエンドサーバーの内部 IP です。イベント発生時の実際のクライアント公開 IP（例：`"203.0.113.88"`）を `properties["#ip"]` に渡すことで、Flink Job1 が `properties["#ip"] > properties["$ip"] > client_ip` の優先順位で国・都道府県・都市を正確に解析し、保存前に `#ip` を自動除去します。 |
| **イベント発生時刻**<br/>(`#time` / `$time` / `timestamp`) | トップレベル `timestamp`（ミリ秒）または `properties["#time"]` | **過去データ移行では必須** | 移行スクリプトの実行時刻ではなく、実際の業務イベント発生時刻（ミリ秒 Unix タイムスタンプ `1762768805000` または ISO-8601 文字列 `"2026-11-10T10:00:05Z"`）を指定してください。`abi_logbus.py` とゲートウェイが自動的にトップレベル `timestamp` に昇格させ、`#time` を除去します。 |
| **べき等イベント ID**<br/>(`event_id`) | トップレベル `event_id`（`<= 64` バイト） | **決定的 ID を推奨** | `"ord_paid_" + order_no` のような決定的な主キーを指定することで、LogBus のリトライや DataX ジョブの再実行時に StarRocks `dwd_events` 側で自動的に重複排除されます。 |
| **64 ビット整数の精度保護**<br/>(`> 2^53 - 1`) | `properties` 内の任意の整数・配列要素 | **自動的に文字列化** | IEEE-754 安全整数上限（`9007199254740991`）を超える Snowflake ID（例：`9007199254740993`）は、`abi_logbus.py` によって自動的に文字列 `"9007199254740993"` へ変換され精度欠損を防ぎます。 |
| **デュアル ID 規約**<br/>(`distinct_id` + `login_id`) | トップレベル `distinct_id`（`<= 64` バイト）＆ `login_id`（`<= 128` バイト） | **少なくとも一方が非空必須** | ThinkingData 準拠のデュアル ID モデル：訪問者/デバイス ID `distinct_id` と認証済みアカウント ID `login_id` の 2 つのみを使用し、`login_id` を `distinct_id` にコピーしません。任意のイベントやプロファイル更新に両方の ID を含めると、Flink が自動的に ID-Mapping を完了します。 |
| **ユーザープロファイル分離**<br/>(`$user_*`) | `event_name` = `$user_set`, `$user_add` など | **端末属性の混入禁止** | `$user_*` イベントの `properties` にはプロファイル属性のみを含め、`$os` や `$app_version` などの環境属性を混入させないでください。 |

---

## 3. `abi_logbus.py` クイックスタートと検証コマンド

### 3.1 ワンクリック自己完結デモ（2 段階プレビュー＆送信確認）

```bash
# ステップ 1：ネットワーク送信を行わずに POST /collect/api/v1/track/batch の JSON ペイロードをプレビュー
/opt/homebrew/bin/python3 abi.sdk/data-import/abi_logbus.py --demo --preview

# ステップ 2：リクエスト JSON をプレビューした後、Gzip 送信と Offset チェックポイント保存を自動実行
/opt/homebrew/bin/python3 abi.sdk/data-import/abi_logbus.py --demo --yes
```

### 3.2 本番環境の `LoggerConsumer` ログディレクトリ転送

```bash
# 1. 初回バッチのプレビュー（オフセットは進みません）
/opt/homebrew/bin/python3 abi.sdk/data-import/abi_logbus.py \
  --log-dir /var/log/abi \
  --server-url http://localhost:8081 \
  --project-id 1 \
  --project-token abi_tok_prod_xxx \
  --preview

# 2. 常駐デーモンモードで起動（2 秒間隔で新規 JSONL 行を追跡し Gzip バッチ送信）
/opt/homebrew/bin/python3 abi.sdk/data-import/abi_logbus.py \
  --log-dir /var/log/abi \
  --server-url http://localhost:8081 \
  --project-id 1 \
  --project-token abi_tok_prod_xxx \
  --batch-size 200 \
  --daemon \
  --interval 2.0
```
