# ABI 多言語データ収集 SDK スイート (`abi.sdk`)

**语言 / Language / 言語**: [简体中文](README.md) | [繁體中文](README.zh-TW.md) | [English](README.en.md) | **[日本語](README.ja.md)** | [한국어](README.ko.md) | [Español](README.es.md) | [Português](README.pt.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Русский](README.ru.md) | [Tiếng Việt](README.vi.md) | [ไทย](README.th.md) | [Bahasa Indonesia](README.id.md)

`abi.sdk` は、ABI ユーザー行動分析（UBA）およびビジネスインテリジェンス（BI）プラットフォーム向けの商用グレード・クライアント／サーバーデータ収集 SDK スイートです。[ThinkingData SDK v3.4 仕様](https://docs.thinkingdata.cn/ta-manual/v3.4/installation/installation_menu/installation_menu.html) に準拠し、フィールド契約、デュアル ID マッピング、データ検証においてバックエンド収集ゲートウェイ [`abi.srv`](../abi.srv/)（`:8081`）およびストリーミングエンジン [`abi.flink`](../abi.flink/)（Job1 リアルタイム ETL / Job2 生データ ODS 格納）と完全に整合しています。

---

## 1. ディレクトリ構成・多言語ドキュメント索引・対応マトリクス

| ディレクトリ | 対象プラットフォーム / パッケージ | 多言語 README（中 / 英 / 日） | 主な機能 | 検証コマンド |
|--------------|-----------------------------------|-------------------------------|----------|--------------|
| [`RESTFUL_API.md`](RESTFUL_API.md) | 言語非依存 HTTP RESTful API | [中文](RESTFUL_API.md) | SDK 不要のダイレクト HTTP 連携ガイド：プロトコル仕様、整形済み JSON `curl` サンプル（単件/バッチ/デュアル ID 自動紐付け/同日再送べき等重複排除/7種の `$user_*` 属性操作/Gzip/`debug` & `dry_run`）、Python / Node.js 実装例 | ドキュメント内の `curl` `dry_run: true` コマンドを参照 |
| [`spec/test-vectors/`](spec/test-vectors/) | 言語共通ゴールデンテストベクター | — | 言語横断の共通 JSON テストベクター（ID 正規化、64/128 バイト UTF-8 境界、空白除去、制御文字拒否、イベント・属性キー検証、`> 2^53 - 1` 大整数精度保護、`$user_*` 仕様） | 各 SDK の単体テストスイートで自動検証 |
| [`ts-web/`](ts-web/) | Web / H5 / TypeScript（`@anylink/abi-web-sdk`）＋ App-H5 WebView ブリッジ、ミニプログラム、RN、H5 ゲームエンジンアダプター | [中文](ts-web/README.md) · [EN](ts-web/README.en.md) · [JA](ts-web/README.ja.md)<br/>サンプル：[中文](ts-web/examples/README.md) · [EN](ts-web/examples/README.en.md) · [JA](ts-web/examples/README.ja.md) | `init`、`identify`、`login`、`logout`、`track`、`timeEvent`、`setSuperProperties`、`setDynamicSuperProperties`、全7種 `$user_*` 操作、SPA `$pageview` & `$AppEnd` 自動収集、App-H5 WebView 連携（`createH5AppBridgeAdapter`）、H5 ゲームエンジン（`createCocosCreatorAdapter` / `createEgretAdapter` / `createLayaAirAdapter` / `createWeexAdapter`）、`sendBeacon` 退避送信（*注：D7① / G6 ゲートウェイ制限により、trackFirst/trackUpdate/trackOverwrite は現バージョン未開放として統一*） | `cd abi.sdk/ts-web && pnpm test` |
| [`go/`](go/) | Go サーバー SDK（`abi.sdk/go`） | [中文](go/README.md) · [EN](go/README.en.md) · [JA](go/README.ja.md)<br/>Demo：[中文](go/examples/demo/README.md) · [EN](go/examples/demo/README.en.md) · [JA](go/examples/demo/README.ja.md) | スレッドセーフな `AbiAnalytics` クライアントと4種の Consumer：`StagingConsumer`（2ステップ JSON プレビュー＆確定送信）、`BatchConsumer`（非同期バッチ HTTP + Gzip + 指数バックオフ再試行）、`LoggerConsumer`（日次/時間/サイズローテーション JSONL 出力）、`DebugConsumer`（同期 L4 検証 & `dry_run`） | `cd abi.sdk/go && go test -race ./...` |
| [`java/`](java/) | Java 11+ サーバー SDK（`com.anylink.abi:abi-java-sdk`） | [中文](java/README.md) · [EN](java/README.en.md) · [JA](java/README.ja.md) | スレッドセーフな `AbiAnalytics`（`AutoCloseable` 対応）、`StagingConsumer`、`BatchConsumer`、`LoggerConsumer`、`DebugConsumer` を提供。IEEE-754 安全整数範囲（`> 2^53 - 1`）を超える 64 ビット整数を自動的に文字列へ無損失シリアライズ | `cd abi.sdk/java && JAVA_HOME=$(/usr/libexec/java_home -v 11) mvn test` |
| [`python/`](python/) | Python 3 サーバー SDK（`abi.sdk/python`） | [中文](python/README.md) · [EN](python/README.en.md) · [JA](python/README.ja.md) | 外部依存ゼロの Python 3 標準ライブラリ実装。`StagingConsumer`、`BatchConsumer`（バックグラウンドスレッド + Gzip + 再試行）、`LoggerConsumer`、`DebugConsumer`、および `> 2^53 - 1` 大整数の自動文字列化、`#time`/`$time` 抽出、`#ip`/`$ip` 透過転送を提供 | `python3 -m unittest discover -s abi.sdk/python/tests -v` |
| [`nodejs/`](nodejs/) | Node.js サーバー SDK（`@anylink/abi-node-sdk`） | [中文](nodejs/README.md) · [EN](nodejs/README.en.md) · [JA](nodejs/README.ja.md) | 外部依存ゼロの ESM + TypeScript 型定義（`index.d.ts`）。Express / Fastify / Koa / NestJS 向けに `StagingConsumer`、`BatchConsumer`（`zlib.gzipSync`）、`LoggerConsumer`、`DebugConsumer`、`BigInt` 自動文字列変換を提供 | `node --test abi.sdk/nodejs/test/abi-node-sdk.test.mjs` |
| [`csharp/`](csharp/) | C# / .NET サーバー SDK（`Anylink.Abi.Sdk`） | [中文](csharp/README.md) · [EN](csharp/README.en.md) · [JA](csharp/README.ja.md) | 外部 NuGet 依存ゼロの .NET 標準ライブラリ実装（`System.Text.Json` / `HttpClient` / `GZipStream`）。`StagingConsumer`、`BatchConsumer`、`LoggerConsumer`、`DebugConsumer` を提供 | `dotnet run --project abi.sdk/csharp -- --test` |
| [`php/`](php/) | PHP 8.1+ サーバー SDK（`Anylink\Abi\Sdk`） | [中文](php/README.md) · [EN](php/README.en.md) · [JA](php/README.ja.md) | 外部依存ゼロの PHP サーバー SDK（Laravel / Symfony / PHP-FPM 対応）。`StagingConsumer`、`BatchConsumer`（`gzencode` + 再試行）、`LoggerConsumer`、`DebugConsumer` を提供 | `php abi.sdk/php/tests/abi_sdk_test.php` |
| [`ruby/`](ruby/) | Ruby サーバー SDK（`AbiSdk`） | [中文](ruby/README.md) · [EN](ruby/README.en.md) · [JA](ruby/README.ja.md) | 外部 Gem 依存ゼロの Ruby 標準ライブラリ実装（Rails / Sidekiq / Rack 対応、`snake_case` / `camelCase` 両対応）。`StagingConsumer`、`BatchConsumer`、`LoggerConsumer`、`DebugConsumer` を提供 | `ruby abi.sdk/ruby/test/abi_sdk_test.rb` |
| [`cpp/`](cpp/) | C / C++17 SDK（サーバー & Unreal Engine / Cocos2d-x クライアント） | [中文](cpp/README.md) · [EN](cpp/README.en.md) · [JA](cpp/README.ja.md) | 外部依存ゼロのシングルヘッダー C++17 SDK（[`include/abi_sdk.hpp`](cpp/include/abi_sdk.hpp)）＆ `extern "C"` C ABI。サーバー用ステートレスモードとゲームエンジン用クライアントモード（`enable_client_mode`、`time_event` 計測）の両方をサポート | `clang++ -std=c++17 -O2 -Iabi.sdk/cpp/include abi.sdk/cpp/tests/abi_cpp_test.cpp -o /tmp/abi_cpp_test && /tmp/abi_cpp_test` |
| [`lua/`](lua/) | Lua 5.3+ SDK（OpenResty / Skynet サーバー & Cocos2d-Lua クライアント） | [中文](lua/README.md) · [EN](lua/README.en.md) · [JA](lua/README.ja.md) | 純粋な Lua 5.3+ 標準ライブラリによる単一ファイル SDK（[`abi_sdk.lua`](lua/abi_sdk.lua)）。JSON エンコーダと UTF-8 検証器を内蔵し、サーバー・クライアント両モードに対応 | `lua abi.sdk/lua/tests/test_abi_sdk.lua` |
| [`mobile/`](mobile/) | モバイルクライアント SDK（Flutter Dart、Android Kotlin、iOS Swift） | 概要：[中文](mobile/README.md) · [EN](mobile/README.en.md) · [JA](mobile/README.ja.md)<br/>Flutter：[中文](mobile/flutter/README.md) · [EN](mobile/flutter/README.en.md) · [JA](mobile/flutter/README.ja.md)<br/>Android：[中文](mobile/android/README.md) · [EN](mobile/android/README.en.md) · [JA](mobile/android/README.ja.md)<br/>iOS：[中文](mobile/ios/README.md) · [EN](mobile/ios/README.en.md) · [JA](mobile/ios/README.ja.md) | ネイティブスレッドセーフキュー＆定期バッチ送信、デュアル ID 紐付け（`identify` / `login` / `logout`）、高精度ストップウォッチ計測（`timeEvent` -> `$duration`）、同日固定 `event_id` べき等送信（D7① / G6 制限により `trackFirst`/`trackUpdate`/`trackOverwrite` は未開放）、全7種 `$user_*` 操作、2ステップ「JSON プレビュー → 確定送信」UI デモ | `swiftc -typecheck abi.sdk/mobile/ios/AbiAnalytics.swift abi.sdk/mobile/ios/example/AbiDemoViewController.swift` |
| [`game-engines/unity/`](game-engines/unity/) | Unity ゲームエンジンクライアント SDK（C# `AbiUnityAnalytics`） | [中文](game-engines/unity/README.md) · [EN](game-engines/unity/README.en.md) · [JA](game-engines/unity/README.ja.md) | Unity C# クライアント向け永続デバイス ID 管理、高精度ストップウォッチ計測、オフラインキュー、および 2 ステップ確認デモ（`AbiUnityDemoMonoBehaviour`） | `dotnet run --project abi.sdk/csharp -- --test` |
| [`data-import/`](data-import/) | データインポート＆ログ転送ツール群（LogBus 2 / Filebeat / Logstash / Vector / DataX） | [中文](data-import/README.md) · [EN](data-import/README.en.md) · [JA](data-import/README.ja.md) | ThinkingData LogBus 2 互換のリアルタイムログ収集デーモン（[`abi_logbus.py`](data-import/abi_logbus.py)、`LoggerConsumer` の `.jsonl` を監視しブレークポイント再開＋Gzip バッチ送信）および Filebeat / Logstash / Vector / DataX 設定テンプレート | `python3 abi.sdk/data-import/abi_logbus.py --demo --yes` |

---

## 2. 収集ゲートウェイ・バッチ送信プロトコル契約 (`POST /collect/api/v1/track/batch`)

すべてのクライアントおよびサーバー HTTP Consumer は、収集ゲートウェイへ以下の標準 JSON バッチペイロードを送信します：

```json
{
  "project_id": 1,
  "project_token": "abi_tok_...",
  "debug": false,
  "dry_run": false,
  "events": [
    {
      "event_id": "018f6b9c-7c40-7000-8000-000000000001",
      "event_name": "OrderPaid",
      "distinct_id": "vis_device_001",
      "login_id": "user_10001",
      "timestamp": 1731174000000,
      "properties": {
        "$lib": "abi-ios-sdk",
        "$lib_version": "1.0.0",
        "$os": "iOS",
        "$app_version": "2.1.0",
        "$duration": 12.345,
        "amount": 199.0,
        "order_id": "9007199254740993"
      }
    }
  ]
}
```

### 2.1 ThinkingData 準拠のデュアル ID 識別子とべき等キーの制約

- **`distinct_id`（ビジター / デバイス ID）**：通信ペイロード上の唯一の訪問者または端末識別子です。ASCII 制御文字（`0x00–0x08`、`0x0E–0x1F`、`0x7F`）は不可、前後の Unicode 空白は自動除去され、UTF-8 最大バイト長は **64 バイト**です。クライアント SDK は初期化時にローカルで自動生成・永続化し、`identify(visitorId)` で上書き可能です。サーバーサイドで非空の `login_id` のみを持つバックエンド専用イベントでは空文字列 `""` が許可されます（**`login_id` を `distinct_id` にコピー・切り詰め補完することは厳禁**）。
- **`login_id`（認証済みアカウント ID）**：認証完了後のビジネスアカウント識別子で、UTF-8 最大バイト長は **128 バイト**です（未ログイン時は省略または `""`）。すべてのイベントで `distinct_id` と `login_id` の **少なくとも一方が非空**である必要があります。
- **クライアント `login()` の純粋ローカル状態管理と自動 ID-Mapping**：クライアント SDK の `login(accountId)` は**ローカル状態の `login_id` のみを永続化**し、`distinct_id` を上書きせず、個別の紐付け用システムイベントも送信しません。`logout()` は `login_id` のみをクリアし、現在の `distinct_id` を維持します。クライアント・サーバーを問わず、**任意の行動イベント（`Track*`）やプロファイル更新（`$user_*`）が非空の `distinct_id` と `login_id` の両方を持つ場合**、下流の Flink Job1 がリアルタイムに `abi.identity_map` を自動更新します。
- **`event_id`（イベントべき等主キー）**：UTF-8 最大バイト長は **64 バイト**。オフライン時や HTTP `429` / `5xx` 再試行時も同一 `event_id` が保持され、べき等な書き込みを保証します。（*注：D7① / G6 制限により、trackFirst/trackUpdate/trackOverwrite は現バージョン未開放として統一。べき等送信が必要な場合は同一パーティション内で標準 track に固定の event_id を指定してください*）。

### 2.2 大整数（$> 2^{53}-1$）精度保護

JavaScript および一般的な JSON パーサーは IEEE-754 倍精度浮動小数点規格に従うため、安全整数上限は $2^{53}-1$（`9007199254740991`）です。

- 整数属性の絶対値が `9007199254740991` を超える場合（例：64 ビット Snowflake 注文 ID `9007199254740993` や `Int64.min` / `Long.MIN_VALUE`）、各言語 SDK はシリアライズ前に自動的に 10 進文字列（`"9007199254740993"`）へ変換し、下位桁の丸め誤差を完全に防止します。
- また、`NaN`、`Infinity` / `-Infinity`、および `null` やネストされたオブジェクト／配列を含むリスト要素はキュー投入前に拒否されます。

### 2.3 `$user_*` ユーザープロファイル操作仕様

全 SDK で StarRocks ユーザーディメンションテーブル（`abi.dim_users`）を更新する 7 種の標準プロファイル操作メソッドを提供します：

| SDK メソッド | プロトコル `event_name` | プロファイル更新セマンティクス |
|--------------|-------------------------|--------------------------------|
| `userSet(props)` | `$user_set` | ユーザー属性を上書き設定（存在すれば更新、なければ新規追加） |
| `userSetOnce(props)` | `$user_set_once` | 対象属性が未設定（NULL）の場合のみ初回書き込み（初回流入チャネルや登録元など） |
| `userAdd(props)` | `$user_add` | 数値型ユーザー属性の原子的加算・減算（ポイント増減、累計購入金額など） |
| `userUnset(keys)` | `$user_unset` | 指定したユーザー属性キーをクリア（`dim_users` 内の該当カラムを `NULL` 化） |
| `userAppend(props)` | `$user_append` | 配列（Array）型ユーザー属性の末尾に要素を追加（重複維持） |
| `userUniqAppend(props)` | `$user_uniq_append` | 配列（Array）型ユーザー属性に要素を追加し自動重複排除（興味タグ、バッジ集合など） |
| `userDelete()` | `$user_del` | `abi.dim_users` から該当ユーザーのプロファイル行を削除（`dwd_events` の過去行動履歴は保持） |

> **分離ルール**：`$user_*`（および互換プレフィックス `#user_*`）イベント構築時、SDK は静的・動的共通属性（Super Properties）や `$os`、`$app_version`、`$lib` などの端末プリセット属性を**一切注入しません**。

### 2.4 導入担当者向け：クライアント SDK とサーバー SDK の必須フィールド・役割分担の比較（重要）

実運用環境において、**クライアント SDK（Web / ミニプログラム / モバイルアプリ）** と **サーバー SDK（Go / Java）** はネットワークトポロジーと状態管理が根本的に異なります。導入担当者は以下のフィールドごとの責務の違いに注意してください：

| フィールド / 属性 | クライアント SDK（`ts-web` / `mobile` Flutter·Android·iOS） | サーバー SDK（`go` / `java` / `python` / `nodejs` / `csharp` / `php` / `ruby`） | 直接 HTTP 送信（`RESTFUL_API.md`） | ゲートウェイ (`:8081`) ＆ Flink ETL の処理仕様 |
| :--- | :--- | :--- | :--- | :--- |
| **`project_id` & `project_token`** | **初期化時に必須**（`init` で1回指定） | **Consumer 初期化時に必須** | **全リクエストのトップレベルで必須** | プロジェクト状態とトークンを検証し、不正な場合は `401/403` を返却 |
| **`event_name`（イベント名）** | **`track` 呼び出しごとに必須**（`userSet*` 等は SDK が `$user_*` を自動設定） | **`Track` 呼び出しごとに必須**（`UserSet*` 等は SDK が `$user_*` を自動設定） | **全イベントで必須** | `<= 128` 文字および `^[A-Za-z_][A-Za-z0-9_]*$`（またはシステム `$`/`#` ホワイトリスト）を検証 |
| **ユーザー識別子（`distinct_id` / `login_id`）** | **SDK が自動管理（都度指定不要）**：初期化時にビジター `distinct_id` を自動生成・永続化。ログイン時は `login(accountId)` でローカルに `login_id` を保存（以降のイベントは自動で両 ID を付与） | **全メソッド呼び出しで必須**：サーバー SDK は全ユーザーで共有されるステートレスなシングルトンのため、呼び出しごとに `login_id`（`accountId`）またはクライアント転送のビジター `distinct_id`（最低1つ非空、`login_id` の `distinct_id` へのコピー禁止）を明示的に渡す必要あり | **全イベントで必須**（`distinct_id` と `login_id` のいずれか1つ以上が必須） | 識別子欠落時は `missing_identity` で拒否。非空の `distinct_id` + `login_id` を両方持つ任意のイベントから Flink が `abi.identity_map` をリアルタイム更新 |
| **ユーザーのグローバル IP（`#ip` / `$ip`）**<br/>*(国・都道府県・市区町村の地域分析に使用)* | **指定不要（クライアントでは取得不可）**：ブラウザ JS やモバイルアプリは NAT 配下にあり自身のグローバル IP を取得できません。ゲートウェイが HTTP 接続から自動抽出します | **サーバー送信時は指定必須（地域分析を行う場合）**：Go/Java サーバーから送信すると、ゲートウェイが検知する接続元 IP は**バックエンドのデータセンター/VPC 内 IP** になります。フロントエンドのヘッダー（`X-Forwarded-For` / `X-Real-IP`）から取得したユーザーの実際の IP を `properties["#ip"]` または `"$ip"` に設定してください | クライアント直連時は不要。**サーバー経由の送信時は `properties` に `"#ip"` または `"$ip"` を指定** | Flink は **`properties["#ip"]` > `properties["$ip"]` > ゲートウェイ接続元 `client_ip`** の優先順位で数値 IP を採用して GeoIP（国/地域/都市）を解決し、`properties` から `#ip`/`$ip` を自動除去 |
| **イベント発生時刻（`timestamp` / `#time` / `$time`）** | **リアルタイム送信時は省略可**：SDK が自動で現在時刻（`Date.now()`）を設定。オフライン履歴データの補填時のみ `#time` / `$time` を指定 | **リアルタイム時は省略可 / 非同期 MQ・過去データ補填時は必須**：遅延 MQ コンシューマーや決済 Webhook、バッチ補填では実際の業務発生時刻を `properties["#time"]`（または `TrackOptions.Timestamp` / `Date` / `Instant`）で明示指定 | **全イベントで必須**（トップレベル `timestamp` または `properties["#time"]` / `"$time"`） | `#time` / `$time` はトップレベルのミリ秒 `timestamp` に自動変換され `properties` から除去。`ts_window_days` 許容窓を検証 |
| **べき等主キー（`event_id`）** | **通常は省略可**：SDK が UUIDv4 を自動生成し、再送時も同一 `event_id` を維持。D7① / G6 制限により、`trackFirst`/`trackUpdate`/`trackOverwrite` は現バージョン未開放として統一 | **通常は省略可 / 基幹トランザクションでは明示指定を推奨**：MQ 再試行時の重複カウント防止のため、`TrackWithOptions` / `trackWithId` で業務一意キー（例：`"ord_paid_" + orderNo`）の指定を推奨 | 明示指定を推奨（省略時はゲートウェイが UUID を生成するが再送時の重複排除不可） | StarRocks `dwd_events` が同一パーティション内で `event_id` によりべき等重複排除を実行 |
| **端末プリセット属性（`$os` / `$app_version` / `$screen_width` 等）** | **SDK が自動収集・注入**（行動イベントのみ。`$user_*` からは自動分離） | **サーバー単体では取得不可**：`SetSuperProperties` でサービス名等を設定するか、クライアントから受け取った `$os`・`$app_version`・`$device_model` を `properties` に設定 | 必要に応じて `properties` に明示指定 | Flink が `$os`、`$app_version`、`$device_model` 等を `dwd_events` の物理カラムへ昇格 |

> **フロントエンド＋バックエンド連携のベストプラクティス**：Web/アプリ（クライアント SDK）で商品閲覧を収集し、決済完了をバックエンド（サーバー SDK）で送信する場合、フロントエンドから注文 API を呼ぶ際にリクエストヘッダー（例：`X-ABI-Distinct-Id: abi.getDistinctId()`）でビジター ID をバックエンドへ渡し、バックエンドの `Track` 呼び出し時に `loginId`（`accountId`）・ビジター `distinctId`・実際のユーザー IP（`"#ip"`）を同時に渡すことで、任意のイベントで Flink ID-Mapping が自動実行され、ファネル分析の紐付けと正確な地域分析が実現します。

---

## 3. 各プラットフォーム対話型デモ＆コードサンプル早見表

`abi.sdk` のすべての UI デモおよび CLI／メソッドデモは、**「1. パラメータを設定し単一のリクエスト JSON (`POST /collect/api/v1/track/batch`) をリアルタイムプレビュー → 2. 『確定して送信（确认提交）』操作で送信し単一のレスポンスを確認」** という 2 ステップ方式に統一されており、設定変更のたびにログが無限増殖することはありません：

| プラットフォーム / SDK | 対話型 UI / 実行可能デモ入口 | コア SDK ソース | 起動・検証コマンド |
|------------------------|------------------------------|-----------------|--------------------|
| **Go サーバー SDK** | [`go/examples/demo/main.go`](go/examples/demo/main.go) & [`go/example_test.go`](go/example_test.go) | [`go/abi.go`](go/abi.go)（`StagingConsumer`） | `cd abi.sdk/go && go run ./examples/demo`（JSON プレビュー後に `y` で送信、または `--yes`） |
| **Java 11+ サーバー SDK** | [`java/src/main/java/com/anylink/abi/sdk/examples/AbiJavaSdkDemo.java`](java/src/main/java/com/anylink/abi/sdk/examples/AbiJavaSdkDemo.java) | [`AbiAnalytics.java`](java/src/main/java/com/anylink/abi/sdk/AbiAnalytics.java) & [`StagingConsumer.java`](java/src/main/java/com/anylink/abi/sdk/StagingConsumer.java) | `cd abi.sdk/java && JAVA_HOME=$(/usr/libexec/java_home -v 11) mvn test-compile exec:java -Dexec.mainClass="com.anylink.abi.sdk.examples.AbiJavaSdkDemo"` |
| **Python 3 サーバー SDK** | [`python/examples/demo.py`](python/examples/demo.py) | [`python/abi_sdk.py`](python/abi_sdk.py)（`StagingConsumer`） | `python3 abi.sdk/python/examples/demo.py --yes` |
| **Node.js サーバー SDK** | [`nodejs/examples/demo.mjs`](nodejs/examples/demo.mjs) | [`nodejs/src/index.mjs`](nodejs/src/index.mjs)（`StagingConsumer`） | `node abi.sdk/nodejs/examples/demo.mjs --yes` |
| **C# (.NET) サーバー SDK** | [`csharp/Program.cs`](csharp/Program.cs) | [`csharp/AbiAnalytics.cs`](csharp/AbiAnalytics.cs)（`StagingConsumer`） | `dotnet run --project abi.sdk/csharp -- --yes` |
| **PHP 8.1+ サーバー SDK** | [`php/examples/demo.php`](php/examples/demo.php) | [`php/src/AbiAnalytics.php`](php/src/AbiAnalytics.php)（`StagingConsumer`） | `php abi.sdk/php/examples/demo.php --yes` |
| **Ruby サーバー SDK** | [`ruby/examples/demo.rb`](ruby/examples/demo.rb) | [`ruby/lib/abi_sdk.rb`](ruby/lib/abi_sdk.rb)（`StagingConsumer`） | `ruby abi.sdk/ruby/examples/demo.rb --yes` |
| **C / C++17 クロスプラットフォーム SDK** | [`cpp/examples/demo.cpp`](cpp/examples/demo.cpp) | [`cpp/include/abi_sdk.hpp`](cpp/include/abi_sdk.hpp)（`StagingConsumer` & `extern "C"`） | `clang++ -std=c++17 -O2 -Iabi.sdk/cpp/include abi.sdk/cpp/examples/demo.cpp -o /tmp/abi_cpp_demo && /tmp/abi_cpp_demo --yes` |
| **Lua 5.3+ クロスプラットフォーム SDK** | [`lua/examples/demo.lua`](lua/examples/demo.lua) | [`lua/abi_sdk.lua`](lua/abi_sdk.lua)（`StagingConsumer`） | `lua abi.sdk/lua/examples/demo.lua --yes` |
| **Web / H5 対話型プレイグラウンド** | [`ts-web/examples/interactive-demo.html`](ts-web/examples/interactive-demo.html) & [`ts-web/examples/usage-examples.ts`](ts-web/examples/usage-examples.ts)（`previewAndConfirmWebSdkExample`） | [`ts-web/src/index.ts`](ts-web/src/index.ts)（`buildPendingBatchPayload`） | ブラウザで `ts-web/examples/interactive-demo.html` を開くか、`cd abi.sdk/ts-web && pnpm test` を実行 |
| **App 内 WebView (H5) ブリッジ & H5 ゲームエンジン** | [`ts-web/test/abi-web-sdk.test.ts`](ts-web/test/abi-web-sdk.test.ts) | [`h5-bridge.ts`](ts-web/src/adapters/h5-bridge.ts) & [`game-engines.ts`](ts-web/src/adapters/game-engines.ts) | `cd abi.sdk/ts-web && pnpm test`（Android/iOS WebView Bridge + Cocos Creator / Egret / LayaAir / Weex） |
| **ABI 管理画面 SDK ガイドドロワー** | [`../abi.cli/src/pages/Meta/MetaProjects.tsx`](../abi.cli/src/pages/Meta/MetaProjects.tsx) & [`../abi.cli/src/lib/sdk-guide-token.ts`](../abi.cli/src/lib/sdk-guide-token.ts) | 同上 | 管理画面「メタデータ → プロジェクト管理 → SDK ガイド」にて JSON をプレビューし「確定して送信」をクリック |
| **WeChat ミニプログラム & React Native** | [`ts-web/examples/usage-examples.ts`](ts-web/examples/usage-examples.ts)（`runWeChatMiniProgramExample`、`runReactNativeExample`） | [`miniapp.ts`](ts-web/src/adapters/miniapp.ts) & [`react-native.ts`](ts-web/src/adapters/react-native.ts) | `cd abi.sdk/ts-web && pnpm test` |
| **Unity ゲームエンジン SDK** | [`game-engines/unity/AbiUnityDemoMonoBehaviour.cs`](game-engines/unity/AbiUnityDemoMonoBehaviour.cs)（`AbiUnityDemoMonoBehaviour` / `AbiUnityDemoRunner`） | [`game-engines/unity/AbiUnityAnalytics.cs`](game-engines/unity/AbiUnityAnalytics.cs)（`BuildPendingBatchJson`） | Unity で `AbiUnityDemoMonoBehaviour` をアタッチするか `dotnet run --project abi.sdk/csharp -- --test` を実行 |
| **Flutter クライアント SDK** | [`mobile/flutter/example/lib/main.dart`](mobile/flutter/example/lib/main.dart)（`AbiSdkDemoApp`） | [`mobile/flutter/lib/abi_sdk.dart`](mobile/flutter/lib/abi_sdk.dart)（`buildPendingBatchPayload` / `previewScenarioPayload` + `confirmSubmit`） | Flutter アプリに `AbiSdkDemoApp` をマウントするか `previewScenarioPayload` + `confirmSubmit` を呼び出し（詳細：[`mobile/flutter/README.ja.md`](mobile/flutter/README.ja.md)） |
| **Android Kotlin クライアント SDK** | [`mobile/android/example/AbiDemoActivity.kt`](mobile/android/example/AbiDemoActivity.kt)（`AbiDemoActivity` / `previewScenarioPayload` + `confirmSubmit`） | [`mobile/android/AbiAnalytics.kt`](mobile/android/AbiAnalytics.kt)（`buildPendingBatchPayload`） | Android で `AbiDemoActivity` を起動するか `previewScenarioPayload` + `confirmSubmit` を呼び出し（詳細：[`mobile/android/README.ja.md`](mobile/android/README.ja.md)） |
| **iOS Swift クライアント SDK** | [`mobile/ios/example/AbiDemoViewController.swift`](mobile/ios/example/AbiDemoViewController.swift)（`AbiSdkDemoView` / `AbiSdkDemoRunner`） | [`mobile/ios/AbiAnalytics.swift`](mobile/ios/AbiAnalytics.swift)（`buildPendingBatchJsonString`） | SwiftUI で `AbiSdkDemoView()` をマウント；型チェック：`swiftc -typecheck abi.sdk/mobile/ios/AbiAnalytics.swift abi.sdk/mobile/ios/example/AbiDemoViewController.swift` |
| **LogBus 2 / データインポートツール群** | [`data-import/abi_logbus.py`](data-import/abi_logbus.py)（`--demo` 2ステッププレビュー＆確定） | [`data-import/abi_logbus.py`](data-import/abi_logbus.py) ＋ Filebeat / Logstash / Vector / DataX テンプレート | `python3 abi.sdk/data-import/abi_logbus.py --demo --yes` |
