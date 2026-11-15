# ABI C / C++17 データ収集 SDK（サーバーサイド & Unreal Engine / Cocos2d-x ゲームクライアント対応）

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`abi.sdk/cpp` は、**ABI エンタープライズユーザー行動分析（UBA）& BI プラットフォーム**の公式 C / C++17 データ収集 SDK です（ThinkingData C/C++ サーバー SDK および Unreal Engine / Cocos2d-x SDK v3.4 仕様に準拠）。

**シングルヘッダー（Header-Only、`include/abi_sdk.hpp`）・外部依存ゼロ・STL-ABI 非依存**で設計されており、`extern "C"` C 言語インターフェースも内蔵しているため、Linux / macOS / Windows の C++ ゲームサーバーやマイクロサービス、Unreal Engine 4/5、Cocos2d-x 3.x/4.x クライアントへそのまま組み込むことができます。

---

## 1. 主な特長と 4 種類の Consumer アーキテクチャ

### 主な特長
- **シングルヘッダー・外部依存ゼロ**：`#include "abi_sdk.hpp"` のみでコンパイル可能。独自の軽量コンテナにより Unreal Engine や Android NDK 環境での `libc++` / `libstdc++` ABI 競合を完全に回避します。
- **サーバー／クライアント両モード対応（ThinkingData 準拠デュアル識別子 `distinct_id` + `login_id`）**：
  - **C/C++ サーバーサイド・ステートレスモード**：マルチユーザー共有インスタンス向け。呼び出しごとに `account_id`（`login_id` ≤ 128 バイト）、`distinct_id`（訪問者／端末 ID ≤ 64 バイト、少なくとも一方は非空、`account_id` のみ指定時は `distinct_id` は空文字 `""` を維持）、およびクライアントの実 IP `"#ip"` を明示的に指定します。
  - **Unreal Engine / Cocos2d-x クライアント・ステートフル端末モード**：`enable_client_mode`、`identify(distinct_id)`（ローカルで `distinct_id` を更新、通信なし）、`login(account_id)`（`distinct_id` を上書きせずローカルの `login_id` のみ設定、通信イベント送信なし）、`logout()`（ローカルの `login_id` のみクリア）、`time_event`（経過秒数 `$duration` を自動計測）、および端末プリセット属性の自動付与をサポートします。
- **厳格な事前バリデーション**：UTF-8 検証、ASCII 制御文字（`0x00–0x08`、`0x0E–0x1F`、`0x7F`）のブロック、前後の Unicode 空白文字トリム、UTF-8 バイト長上限（`distinct_id` / `event_id` ≤ 64 バイト、`login_id` ≤ 128 バイト）をローカルで強制します。
- **64 ビット Snowflake ID 精度保護（`> 2^53 - 1` の自動文字列化）**：IEEE-754 倍精度安全整数上限（`9007199254740991`、`INT64_MIN` や配列要素を含む）を超える `int64_t` / `uint64_t` 値を自動的に 10 進文字列へ変換します。
- **共通属性と `$user_*` プロファイル操作の厳格な分離**：`端末プリセット属性 < 静的共通属性 < 動的共通属性 < 個別イベント属性` の優先順位でマージし、7 種類の `$user_*` ユーザープロファイル操作には共通属性や端末属性を一切混入させません。

### 4 種類の Consumer

| Consumer | クラス名 | 用途と主な機能 |
| :--- | :--- | :--- |
| **`StagingConsumer`** | `abi::StagingConsumer` | **2 段階プレビュー＆確定送信**：イベントをメモリ上に一時保持し、`preview_request_json()` で `POST /collect/api/v1/track/batch` の整形済み JSON を事前確認（ネットワーク通信なし）した上で、`submit_to_gateway()` または `confirm_submit()` で本送信します。 |
| **`LoggerConsumer`** | `abi::LoggerConsumer` | **ローカル JSONL ファイルローテーション**：1 行 1 イベントの JSONL 形式でディスクへ書き出します（日次 `Daily` / 時間次 `Hourly` ローテーション対応）。Filebeat / Vector 連携に最適です。 |
| **`BatchConsumer`** | `abi::BatchConsumer` | **高スループットバッチ送信**：メモリバッファに蓄積し、`batch_size` 到達時に一括送信します（カスタム HTTP コールバック `HttpTransportFunc` 対応）。 |
| **`DebugConsumer`** | `abi::DebugConsumer` | **開発時 L4 厳格検証 & `dry_run`**：`debug=true`（および Kafka / StarRocks へ書き込まない `dry_run=true`）で 1 件ずつ同期検証します。 |

---

## 2. 実装ガイド：C/C++ サーバーモード vs. Unreal / Cocos2d-x クライアントモードの責務比較

| 項目 | C/C++ サーバーサイド・ステートレスモード（バトルサーバー／決済サーバー） | Unreal Engine / Cocos2d-x ゲームクライアントモード |
| :--- | :--- | :--- |
| **ユーザー識別子**<br>(`distinct_id` / `login_id`) | **【毎回指定必須】** サーバーは全プレイヤーで共有されるため、`sdk.track(account_id, distinct_id, ...)` の呼び出しごとに `account_id`（`login_id`）またはクライアントから転送された訪問者 `distinct_id`（少なくとも一方）を渡す必要があります。 | **【SDK が自動管理】** 起動時に `sdk.enable_client_mode(cfg)` で訪問者 `distinct_id` を初期化し、ログイン時に `sdk.login(account_id)` を呼ぶだけでローカルに `login_id` が設定され（`distinct_id` は維持、通信なし）、以降の `sdk.client_track(...)` に両方自動付与されます。 |
| **クライアント実 IP**<br>(`#ip` / `$ip`、国・都道府県・都市の地域解析用) | **【サーバーでは指定必須】** サーバーから `:8081` ゲートウェイへ送信する場合（または `LoggerConsumer` でファイル出力する場合）、接続元 IP は**データセンター内部 IP** になります。ソケットや `X-Forwarded-For` から取得したプレイヤーの実パブリック IP を `properties["#ip"]` に渡してください。Flink ETL が `#ip` を最優先で GeoIP 解析し、保存時にフィールドを除去します。 | **【クライアントは指定不要】** スマートフォンや PC クライアントが収集ゲートウェイへ直接通信する場合、**ゲートウェイが HTTP 接続から自動的にクライアントのパブリック IP を抽出**します。 |
| **イベント発生時刻**<br>(`#time` / `$time` / `timestamp_ms`) | **【リアルタイムは省略可／非同期 MQ・過去データ補填は必須】** `properties["#time"]`（ミリ秒/秒整数または `"2026-11-10T12:00:00Z"`）を渡すと、SDK がトップレベルの `timestamp` に抽出し `properties` から除去します。 | **【自動取得】** リアルタイム送信時は現在のミリ秒タイムスタンプを自動取得します。 |
| **端末プリセット属性**<br>(`$os` / `$app_version` / `$device_model` / `$screen_width`) | **【必要に応じて転送】** クライアントヘッダーから受け取った値をイベント単位の `properties` に設定します（全体の `set_super_properties` には入れないでください）。 | **【SDK が自動付与】** `enable_client_mode` で設定した端末属性が行動イベントへ自動注入され、`$user_*` イベントからは自動除外されます。 |

---

## 3. クイックスタート＆コード例

### 3.1 C++17 サーバーサイド実装例（`#ip` 指定、大整数保護、2 段階プレビュー、7 種のプロファイル操作）

```cpp
#include "abi_sdk.hpp"
#include <stdio.h>

int main() {
    abi::StagingConsumer staging(1, "abi_tok_cpp_server", false);
    abi::AbiAnalytics sdk(staging);

    sdk.set_super_properties({
        {"service_name", "battle-settlement-srv"},
        {"cluster_region", "ap-tokyo"}
    });

    const abi::String account_id  = "player_9001";
    const abi::String distinct_id = "visitor_ue5_dev_01";
    const abi::String client_ip   = "203.0.113.88"; // クライアント接続または X-Forwarded-For から取得した実 IP

    sdk.track(account_id, distinct_id, "OrderPaid", {
        {"#ip", client_ip},
        {"#time", "2026-11-10T12:00:00Z"},
        {"order_id", int64_t(9007199254740999LL)}, // > 2^53-1 のため文字列 "9007199254740999" に自動変換
        {"pay_amount", 299.5},
        {"item_skus", abi::Value::from_string_list({"skin_dragon", "battle_pass"})}
    });

    // 7 種類のユーザープロファイル操作（共通属性は自動的に除外されます）
    sdk.user_set(account_id, distinct_id, {{"nickname", "DragonKnight"}, {"vip_level", 5}});
    sdk.user_set_once(account_id, distinct_id, {{"first_channel", "steam"}});
    sdk.user_add(account_id, distinct_id, {{"total_recharged", 299.5}});
    sdk.user_append(account_id, distinct_id, {{"chapters", abi::Value::from_string_list({"ch_1"})}});
    sdk.user_uniq_append(account_id, distinct_id, {{"titles", abi::Value::from_string_list({"founder"})}});
    sdk.user_unset(account_id, distinct_id, {"trial_buff_flag"});

    // ステップ 1：送信前の整形済みリクエスト JSON をプレビュー
    abi::String preview_json = staging.preview_request_json(true);
    printf("=== リクエスト JSON プレビュー ===\n%s\n", preview_json.c_str());

    // ステップ 2：確定してゲートウェイへ送信
    abi::String resp_json;
    staging.submit_to_gateway("http://127.0.0.1:8081", nullptr, &resp_json);
    printf("=== レスポンス JSON ===\n%s\n", resp_json.c_str());
    return 0;
}
```

---

## 4. テストと CLI デモのビルド・検証コマンド

```bash
# 1. C++17 ユニットテストスイートのコンパイルと実行
/usr/bin/clang++ -std=c++17 -O2 -I/Users/zhongjie/data/anylink/abi/abi.sdk/cpp/include \
  /Users/zhongjie/data/anylink/abi/abi.sdk/cpp/tests/abi_cpp_test.cpp -o /tmp/abi_cpp_test && \
  /tmp/abi_cpp_test && rm -f /tmp/abi_cpp_test

# 2. 2 段階 CLI デモのコンパイルと実行
/usr/bin/clang++ -std=c++17 -O2 -I/Users/zhongjie/data/anylink/abi/abi.sdk/cpp/include \
  /Users/zhongjie/data/anylink/abi/abi.sdk/cpp/examples/demo.cpp -o /tmp/abi_cpp_demo && \
  /tmp/abi_cpp_demo --yes && rm -f /tmp/abi_cpp_demo
```
