# ABI Lua データ収集 SDK（OpenResty / ゲームサーバー & Cocos2d-Lua クライアント対応）

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`abi.sdk/lua` は、**ABI エンタープライズユーザー行動分析（UBA）& BI プラットフォーム**の公式 Lua データ収集 SDK です（ThinkingData Lua SDK v3.4 仕様に準拠）。

**100% 純粋な Lua 5.3+ 標準ライブラリ（`abi_sdk.lua`）・外部 C 拡張依存ゼロ**で実装されており、整形出力対応の JSON エンコーダ／デコーダと厳格な UTF-8 バリデータを内蔵し、**OpenResty / Skynet サーバーサイド・ステートレスモード**と **Cocos2d-Lua モバイルゲームクライアント・ステートフル端末モード**の両方をサポートします。

---

## 1. 主な特長と 4 種類の Consumer アーキテクチャ

### 主な特長
- **外部依存ゼロ**：`lua-cjson` などの C 拡張モジュールをビルドすることなく、`abi_sdk.lua` 1 ファイルのみで標準 Lua 5.3+、OpenResty、Skynet、Cocos2d-Lua 環境で動作します。
- **サーバー／クライアント両モード対応（ThinkingData 準拠デュアル識別子 `distinct_id` + `login_id`）**：
  - **OpenResty / Skynet サーバーサイド・ステートレスモード**：呼び出しごとに `account_id`（`login_id` ≤ 128 バイト）、`distinct_id`（訪問者／端末 ID ≤ 64 バイト、少なくとも一方は非空、`account_id` のみ指定時は `distinct_id` は空文字 `""` を維持）、および `ngx.var.remote_addr` / `X-Forwarded-For` から抽出したクライアント実 IP `"#ip"` を明示的に渡します。
  - **Cocos2d-Lua クライアント・ステートフル端末モード**：`enable_client_mode`、`identify(distinct_id)`（ローカルで `distinct_id` を更新）、`login(account_id)`（`distinct_id` を上書きせずローカルに `login_id` のみ設定、通信イベント送信なし）、`logout()`（ローカルの `login_id` のみクリア）、`time_event`（経過秒数 `$duration` を自動計測）、および端末プリセット属性の自動付与をサポートします。
- **64 ビット Snowflake ID 精度保護（`> 2^53 - 1` の自動文字列化）**：IEEE-754 倍精度安全整数上限（`9007199254740991`、`math.mininteger` や配列要素を含む）を超える Lua 64 ビット整数を自動的に 10 進文字列へ変換します。
- **厳格な識別子検証とプロファイル分離**：UTF-8 検証、ASCII 制御文字（`0x00–0x08`、`0x0E–0x1F`、`0x7F`）のブロック、前後の Unicode 空白トリム、64/128 バイト上限チェックを実行し、7 種類の `$user_*` 操作から共通属性や端末属性を自動的に隔離します。

### 4 種類の Consumer

| Consumer | コンストラクタ | 用途と主な機能 |
| :--- | :--- | :--- |
| **`StagingConsumer`** | `abi.new_staging_consumer` | **2 段階プレビュー＆確定送信**：イベントをメモリ上に一時保持し、`preview_request_json()` で `POST /collect/api/v1/track/batch` の整形済み JSON を事前確認（通信なし）した上で、`submit_to_gateway()` または `confirm_submit()` で本送信します。 |
| **`LoggerConsumer`** | `abi.new_logger_consumer` | **ローカル JSONL ファイルローテーション**：1 行 1 イベントの JSONL 形式でディスクへ書き出します（日次 `DAILY` / 時間次 `HOURLY` 対応）。Filebeat / Vector 連携に最適です。 |
| **`BatchConsumer`** | `abi.new_batch_consumer` | **高スループットバッチ送信**：メモリバッファに蓄積し、`batch_size` 到達時に一括送信します（`lua-resty-http` 等のカスタム `transport` コールバック対応）。 |
| **`DebugConsumer`** | `abi.new_debug_consumer` | **開発時 L4 厳格検証 & `dry_run`**：`debug=true`（および Kafka / StarRocks へ書き込まない `dry_run=true`）で同期検証します。 |

---

## 2. 実装ガイド：OpenResty サーバーモード vs. Cocos2d-Lua クライアントモードの責務比較

| 項目 | OpenResty / Skynet サーバーサイド・ステートレスモード | Cocos2d-Lua ゲームクライアント・ステートフルモード |
| :--- | :--- | :--- |
| **ユーザー識別子**<br>(`distinct_id` / `login_id`) | **【毎回指定必須】** サーバーワーカーは全リクエストで共有されるため、`sdk:track(account_id, distinct_id, ...)` の呼び出しごとに `account_id`（`login_id`）またはクライアントから転送された訪問者 `distinct_id`（少なくとも一方）を渡す必要があります。 | **【SDK が自動管理】** 起動時に `sdk:enable_client_mode(cfg)` で訪問者 `distinct_id` を初期化し、ログイン時に `sdk:login(account_id)` を呼ぶだけでローカルに `login_id` が設定され（`distinct_id` は維持、通信なし）、以降の `sdk:client_track(...)` に両方自動付与されます。 |
| **クライアント実 IP**<br>(`#ip` / `$ip`、国・都道府県・都市の地域解析用) | **【サーバーでは指定必須】** OpenResty やゲームサーバーから `:8081` へ接続する場合（または `LoggerConsumer` でファイル出力する場合）、ゲートウェイから見える IP は**サーバー内部 IP** になります。`ngx.req.get_headers()["X-Forwarded-For"]` または `ngx.var.remote_addr` からプレイヤーの実 IP を取得し、`properties["#ip"]` に渡してください。Flink ETL が `#ip` を最優先で GeoIP 解析し、保存時に除去します。 | **【クライアントは指定不要】** スマートフォンクライアントが収集ゲートウェイへ直接通信する場合、**ゲートウェイが HTTP 接続から自動的にクライアントのパブリック IP を抽出**します。 |
| **イベント発生時刻**<br>(`#time` / `$time` / `timestamp_ms`) | **【リアルタイムは省略可／非同期・過去データ補填は必須】** `properties["#time"]`（ミリ秒/秒整数または `"2026-11-10T12:00:00Z"`）を渡すと、SDK がトップレベルの `timestamp` に抽出し `properties` から除去します。 | **【自動取得】** リアルタイム送信時は現在のミリ秒タイムスタンプを自動取得します。 |
| **端末プリセット属性**<br>(`$os` / `$app_version` / `$device_model` / `$screen_width`) | **【必要に応じて転送】** クライアントヘッダーから受け取った値をイベント単位の `properties` に設定します（全体の `set_super_properties` には入れないでください）。 | **【SDK が自動付与】** `enable_client_mode` で設定した端末属性が行動イベントへ自動注入され、`$user_*` イベントからは自動除外されます。 |

---

## 3. クイックスタート＆コード例

### 3.1 OpenResty サーバーサイド実装例（`ngx.var.remote_addr` による `#ip` 指定、大整数保護、2 段階プレビュー）

```lua
local abi = require("abi_sdk")

local function get_client_ip()
    if type(ngx) == "table" and ngx.req then
        local headers = ngx.req.get_headers()
        local xff = headers["X-Forwarded-For"] or headers["x-forwarded-for"]
        if type(xff) == "string" and #xff > 0 then
            return xff:match("^%s*([^,%s]+)")
        end
        return ngx.var.remote_addr
    end
    return "203.0.113.66"
end

local staging = abi.new_staging_consumer(1, "abi_tok_openresty", false)
local sdk     = abi.new(staging)

sdk:set_super_properties({
    service_name   = "payment-callback-edge",
    cluster_region = "ap-tokyo",
})

local account_id  = "acct_lua_9001"
local distinct_id = "visitor_cocos_dev_01"
local client_ip   = get_client_ip()

sdk:track(account_id, distinct_id, "OrderPaid", {
    ["#ip"]        = client_ip,
    ["#time"]      = "2026-11-10T12:00:00Z",
    ["order_id"]   = 9007199254740999, -- > 2^53-1 のため文字列 "9007199254740999" に自動変換
    ["pay_amount"] = 199.5,
    ["item_skus"]  = abi.array({ "gem_pack_648", "monthly_card" }),
})

sdk:user_set(account_id, distinct_id, { nickname = "LuaMaster", vip_level = 6 })
sdk:user_set_once(account_id, distinct_id, { first_ad_channel = "taptap_cn" })
sdk:user_add(account_id, distinct_id, { total_recharged = 199.5 })
sdk:user_append(account_id, distinct_id, { cleared_dungeons = abi.array({ "d_01" }) })
sdk:user_uniq_append(account_id, distinct_id, { owned_medals = abi.array({ "pioneer" }) })
sdk:user_unset(account_id, distinct_id, { "temp_newbie_buff" })

-- ステップ 1：整形済みリクエスト JSON をプレビュー
print("=== リクエスト JSON プレビュー ===")
print(staging:preview_request_json(true))

-- ステップ 2：確定してゲートウェイへ送信
local _, resp_json = staging:submit_to_gateway({ server_url = "http://127.0.0.1:8081" })
print("=== レスポンス JSON ===")
print(resp_json)
```

---

## 4. テストと CLI デモの実行コマンド

```bash
# 1. Lua ユニットテストスイートの実行
/usr/local/bin/lua /Users/zhongjie/data/anylink/abi/abi.sdk/lua/tests/test_abi_sdk.lua

# 2. 2 段階 CLI デモの実行
/usr/local/bin/lua /Users/zhongjie/data/anylink/abi/abi.sdk/lua/examples/demo.lua --yes
```
