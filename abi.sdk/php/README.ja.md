# ABI PHP サーバーサイド SDK (`anylink/abi-php-sdk`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`abi-php-sdk` は **ABI エンタープライズ行動分析（UBA）& BI プラットフォーム** の公式 PHP サーバーサイドデータ収集 SDK です（ThinkingData PHP Server SDK v3.4 に準拠）。**PHP 8.1+** 標準ライブラリのみで構築されており（外部依存ゼロ）、ID 正規化、`2^53 - 1`（`9007199254740991`）を超える 64 ビット整数の文字列自動変換、`#time` / `$time` の自動抽出、および 4 種類の Consumer（`StagingConsumer`、`BatchConsumer`、`LoggerConsumer`、`DebugConsumer`）を備えています。

---

## 1. 主な特徴と 4 種類の Consumer

- **外部依存ゼロ（PHP 8.1+ ネイティブ実装）**：標準拡張（`json`、`mbstring`、`zlib`、標準 HTTP ストリーム）のみで動作します。
- **厳格な ID 正規化とスキーマ検証**：トリム前の ASCII 制御文字（`0x00–0x08`、`0x0E–0x1F`、`0x7F`）拒否、前後の Unicode 空白除去（内部の全角スペース `U+3000` は保持）、UTF-8 バイト長制限（訪問者／端末 ID `distinct_id` および `event_id` ≤ 64 バイト、アカウント ID `login_id` ≤ 128 バイト）を実行し、少なくとも一方の非空を必須としつつ `login_id` を `distinct_id` にコピーしません。
- **64 ビット Snowflake ID の精度保護（`> 2^53 - 1`）**：絶対値が `9007199254740991` を超える整数（1 次元配列内の要素を含む）を自動的に 10 進文字列へ変換し、JSON パース時の精度欠落を防ぎます。
- **共通プロパティ（Super Properties）とユーザープロファイル分離**：`静的共通プロパティ < 動的共通プロパティ < イベントプロパティ` の優先順位でマージし、`$user_*` / `#user_*` のプロファイル操作からは自動的に分離します。
- **4 つの Consumer**：
  - `StagingConsumer`：第 1 ステップで `previewRequestJson()` により `POST /collect/api/v1/track/batch` のリクエスト JSON をプレビューし、第 2 ステップで `submitToGateway()` または `confirmSubmit()` で送信します。
  - `BatchConsumer`：メモリバッファリング、Gzip 圧縮、HTTP `429` / `5xx` に対する指数バックオフ再試行（`event_id` を維持）を行います。
  - `LoggerConsumer`：ローカルディスクへ日次（`DAILY`）・時間別（`HOURLY`）・ファイルサイズ上限（`maxFileSizeMB`）で JSONL ログをローテーション出力します（PHP-FPM 環境に最適）。
  - `DebugConsumer`：`debug: true`（および任意の `dry_run: true`）で 1 件ずつ同期検証を行います。

---

## 2. Laravel / Symfony / PHP-FPM サーバーサイド実装ガイド（`#ip`・ID 必須指定・非同期 `#time`・べき等 `event_id`）

1. **`$_SERVER['HTTP_X_FORWARDED_FOR']` からクライアント実 IP を取得して `#ip` に設定**：サーバー間通信ではゲートウェイ側の接続元 IP がバックエンドサーバーの内部 IP になります。地域分析（国・都道府県・都市）を正確に行うため、リバースプロキシの `HTTP_X_FORWARDED_FOR` の先頭 IP を `properties['#ip']` に渡してください。
2. **呼び出しごとにユーザー ID を明示的に指定**：ステートレスなサーバー環境では、`track*` / `user*` の呼び出しごとに `accountId`（通信フィールド `login_id`）やフロントエンドから転送された訪問者 ID `distinctId`（例：`HTTP_X_ABI_DISTINCT_ID`）を渡す必要があります。両方を同時に渡すと Flink がリアルタイムで ID 紐付けを自動実行します。
3. **非同期ジョブ（Laravel Queue 等）での `#time` と `event_id` 指定**：遅延実行やリトライ時の重複集計を防ぐため、実際のイベント発生時刻を `properties['#time']`（トップレベルのミリ秒 `timestamp` に変換され、`properties` から自動削除されます）に、決定論的な業務キー（例：`"ord_paid_{$orderNo}"`）を `event_id` に指定してください。

```php
<?php

require_once __DIR__ . '/src/AbiAnalytics.php';

use Anylink\AbiSdk\AbiAnalytics;
use Anylink\AbiSdk\StagingConsumer;

function resolveClientIp(array $server): string
{
    if (!empty($server['HTTP_X_FORWARDED_FOR'])) {
        return trim(explode(',', (string) $server['HTTP_X_FORWARDED_FOR'])[0]);
    }
    return trim((string) ($server['HTTP_X_REAL_IP'] ?? $server['REMOTE_ADDR'] ?? ''));
}

$staging = new StagingConsumer(projectId: 1, projectToken: 'abi_tok_demo_php');
$sdk = new AbiAnalytics($staging);

$sdk->trackWithOptions([
    'event_id' => 'ord_paid_ORD-20261110-8801',
    'event_name' => 'OrderPaid',
    'account_id' => 'acct_900102',
    'distinct_id' => $_SERVER['HTTP_X_ABI_DISTINCT_ID'] ?? 'vis_dev_7f8e9a01',
    'properties' => [
        '#ip' => resolveClientIp($_SERVER) ?: '203.0.113.42',
        '#time' => '2026-11-10T10:00:00Z',
        'order_id' => 9007199254740999, // > 2^53-1 は自動的に文字列 "9007199254740999" に変換
        'amount' => 2549.15,
    ],
]);

// ステップ 1：送信前のリクエスト JSON をプレビュー
echo $staging->previewRequestJson() . "\n";
```

---

## 3. テストと 2 ステップ CLI Demo の実行コマンド

```bash
# ゴールデンテストベクター契約テストおよび単体テストの実行
/usr/local/bin/php /Users/zhongjie/data/anylink/abi/abi.sdk/php/tests/abi_sdk_test.php

# 2 ステップ CLI Demo の実行（リクエスト JSON プレビュー -> 確認送信 -> レスポンス JSON 表示）
/usr/local/bin/php /Users/zhongjie/data/anylink/abi/abi.sdk/php/examples/demo.php --yes
```
