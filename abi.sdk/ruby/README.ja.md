# ABI Ruby サーバーサイド SDK (`abi_sdk`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`abi_sdk` は **ABI エンタープライズ行動分析（UBA）& BI プラットフォーム** の公式 Ruby サーバーサイドデータ収集 SDK です（ThinkingData Ruby Server SDK v3.4 に準拠）。**Ruby 標準ライブラリのみ（外部 Gem 依存ゼロ、Ruby 2.6+ / 3.x 対応）** で構築されており、ID 正規化、`2^53 - 1`（`9007199254740991`）を超える 64 ビット整数の文字列自動変換、`#time` / `$time` の自動抽出、および 4 種類の Consumer（`StagingConsumer`、`BatchConsumer`、`LoggerConsumer`、`DebugConsumer`）を備えています。

---

## 1. 主な特徴と 4 種類の Consumer

- **外部 Gem 依存ゼロ（Ruby 2.6+ / 3.x 対応）**：標準ライブラリ（`json`、`net/http`、`zlib`、`securerandom`、`time`）のみで動作します。
- **`snake_case` と `camelCase` の両方に対応**：Ruby 標準の `snake_case`（`set_super_properties`、`track`、`user_set`）と、言語共通の `camelCase`（`setSuperProperties`、`track`、`userSet`）の両方のメソッド名を利用できます。（*注：D7① / G6 制限により、`track_first`/`track_update`/`track_overwrite` は現バージョン未開放として統一*）。
- **ThinkingData 準拠のデュアル ID 正規化とスキーマ検証**：トリム前の ASCII 制御文字（`0x00–0x08`、`0x0E–0x1F`、`0x7F`）拒否、前後の Unicode 空白除去（内部の全角スペース `U+3000` は保持）、および UTF-8 バイト長制限（`distinct_id` / `event_id` ≤ 64 バイト、`login_id` ≤ 128 バイト；少なくとも一方が非空必須、`login_id` を `distinct_id` にコピーしない）を実施します。任意のイベントやプロファイル操作で `account_id`（`login_id`）と `distinct_id` の両方を渡すと、Flink が自動的に `identity_map` へ紐付けます。
- **64 ビット Snowflake ID の精度保護（`> 2^53 - 1`）**：絶対値が `9007199254740991` を超える整数（1 次元配列内の要素を含む）を自動的に 10 進文字列へ変換します。
- **共通プロパティ（Super Properties）とユーザープロファイル分離**：`静的共通プロパティ < 動的共通プロパティ < イベントプロパティ` の優先順位でマージし、`$user_*` / `#user_*` のプロファイル操作からは自動的に分離します。

---

## 2. Rails / Rack / Sidekiq サーバーサイド実装ガイド（`request.remote_ip` による `#ip` 指定・ID 必須指定・非同期 `#time`・べき等 `event_id`）

1. **Rails `request.remote_ip` からクライアント実 IP を取得して `#ip` に設定**：サーバー間通信ではゲートウェイ側の接続元 IP がバックエンドサーバーの内部 IP になります。地域分析（国・都道府県・都市）を正確に行うため、`request.remote_ip`（または Rack の `HTTP_X_FORWARDED_FOR`）を `properties['#ip']` に渡してください。
2. **呼び出しごとにユーザー ID を明示的に指定**：ステートレスなサーバー環境では、呼び出しごとに `account_id`（`login_id`、128 UTF-8 バイト以内）やフロントエンドから転送された訪問者 `distinct_id`（64 UTF-8 バイト以内、例：`X-ABI-Distinct-Id` ヘッダー）の少なくとも一方を渡す必要があります。
3. **Sidekiq 非同期ジョブでの `#time` と `event_id` 指定**：遅延実行やジョブリトライ時の重複集計を防ぐため、実際のイベント発生時刻を `properties['#time']`（トップレベルのミリ秒 `timestamp` に変換され、`properties` から自動削除されます）に、決定論的な業務キー（例：`"ord_paid_#{order.order_no}"`）を `event_id` に指定してください。

```ruby
require_relative 'lib/abi_sdk'

staging = AbiSdk::StagingConsumer.new(project_id: 1, project_token: 'abi_tok_demo_ruby')
sdk = AbiSdk::AbiAnalytics.new(staging)

sdk.track_with_options(
  event_id: 'ord_paid_ORD-20261110-8801',
  event_name: 'OrderPaid',
  account_id: 'acct_900102',
  distinct_id: 'vis_dev_7f8e9a01',
  properties: {
    '#ip' => '203.0.113.42', # Rails request.remote_ip から取得
    '#time' => '2026-11-10T10:00:00Z',
    'order_id' => 9_007_199_254_740_999, # > 2^53-1 は自動的に文字列 "9007199254740999" に変換
    'amount' => 2549.15
  }
)

# ステップ 1：送信前のリクエスト JSON をプレビュー
puts staging.preview_request_json
```

---

## 3. テストと 2 ステップ CLI Demo の実行コマンド

```bash
# ゴールデンテストベクター契約テストおよび単体テストの実行
/usr/bin/ruby /Users/zhongjie/data/anylink/abi/abi.sdk/ruby/test/abi_sdk_test.rb

# 2 ステップ CLI Demo の実行（リクエスト JSON プレビュー -> 確認送信 -> レスポンス JSON 表示）
/usr/bin/ruby /Users/zhongjie/data/anylink/abi/abi.sdk/ruby/examples/demo.rb --yes
```
