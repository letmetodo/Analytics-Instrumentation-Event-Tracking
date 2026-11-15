# ABI C# (.NET) サーバーサイド SDK 利用ガイド & サンプル (`Abi.Sdk`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`Abi.Sdk` は、ABI ユーザー行動分析（UBA）＆ BI プラットフォームの公式 **C# / .NET サーバーサイドデータ収集 SDK**（ThinkingData C# Server SDK v3.4 仕様準拠）です。ASP.NET Core マイクロサービス、決済バックエンド、非同期メッセージキュー（Kafka / RabbitMQ）コンシューマー、およびバッチ処理ジョブ向けに設計されています。

---

## 1. 主な特長

- **サードパーティ NuGet 依存ゼロ**：.NET 標準ライブラリ（`System.Text.Json`、`System.Net.Http`、`System.IO.Compression`）のみで構築されており、オフライン環境やプライベート環境でもそのまま動作します。
- **4 種類のコンシューマー（`IConsumer`）アーキテクチャ**：
  - `StagingConsumer`（2 ステップ・プレビュー＆確認送信）：ネットワーク通信を行わずにメモリ上にイベントを一時保持します。`PreviewRequestJson(...)` で整形済みの `POST /collect/api/v1/track/batch` リクエスト JSON（1 件）を事前確認し、`ConfirmSubmit(targetConsumer)` または `SubmitToGateway(config)` で一括送信できます。
  - `BatchConsumer`（本番環境推奨）：スレッドセーフなメモリキュー＋バックグラウンド定期フラッシュ、`Content-Encoding: gzip` 圧縮、およびネットワーク一時障害 / HTTP `429` / `5xx` 発生時の指数バックオフ再試行（`event_id` を維持したべき等リトライ）をサポートします。
  - `DebugConsumer`（ローカル検証 / CI ゲート）：ゲートウェイの L4 厳格スキーマ検証を同期実行します。`dryRun: true` を指定すると Kafka や StarRocks にデータを書き込まずに検証のみを行えます。
  - `LoggerConsumer`（高スループット・ローカルファイル出力）：UTC 日付ごとに `<prefix>.YYYY-MM-DD.jsonl` へ追記出力し、Filebeat / Vector / LogBus によるサイドカー収集と連携します。
- **ThinkingData 準拠のデュアル ID 自動紐付け**：通信ペイロードは訪問者/デバイス ID `distinct_id`（64 UTF-8 バイト以内）と認証済みアカウント ID `login_id`（128 UTF-8 バイト以内）の 2 つのみを持ち、少なくとも一方が非空であれば送信可能です（`login_id` を `distinct_id` にコピーしません）。任意の `Track*` / `User*` イベントに `accountId`（`login_id`）と `distinctId`（`distinct_id`）の両方を渡すと、下流の Flink が自動的に StarRocks `identity_map` へ紐付けます。
- **可変イベントライフサイクル管理**：確定的 `event_id` 指定送信（`TrackWithId` / `TrackWithOptions`）をサポートします。注：初回イベント（`TrackFirst`）、部分更新（`TrackUpdate`）、全体上書き（`TrackOverwrite`）は現行バージョンでは未サポートです（RESTFUL_API.md §3.3 D7① / G6 gate 参照）。`TrackWithId` で確定的なビジネスメインキーを直接指定することを推奨します。
- **7 種類のユーザープロファイル操作（`$user_*`）と共通プロパティ分離**：`UserSet`、`UserSetOnce`、`UserAdd`、`UserUnset`、`UserAppend`、`UserUniqAppend`、`UserDelete` を提供し、静的・動的共通プロパティ（Super Properties）がユーザープロファイル表（`dim_users`）に混入しないよう自動分離します。
- **大整数（`> 2^53 - 1`）精度保護と `#time` 自動抽出**：
  - IEEE-754 安全整数上限（`9007199254740991`）を超える 64 ビット `long` / `ulong` 値（Snowflake 注文 ID など）を自動的に 10 進文字列へ変換します。
  - `properties["#time"]` または `properties["$time"]` をトップレベルのミリ秒 `timestamp` として抽出し、`properties` から自動的に除外します。

---

## 2. 動作環境とセルフテスト検証

- **.NET SDK**：.NET 7.0 以上（`TargetFramework: net7.0`）
- **外部依存パッケージ**：なし

### 2.1 ゴールデンテストベクター＆単体テストの実行 (`--test`)

[`../spec/test-vectors/identity_cases.json`](../spec/test-vectors/identity_cases.json) および [`../spec/test-vectors/event_and_property_cases.json`](../spec/test-vectors/event_and_property_cases.json) の全テストベクターと SDK 機能を検証します：

```bash
/usr/local/share/dotnet/dotnet run --project abi.sdk/csharp -- --test
```

---

## 3. 2 ステップ対話型デモ（1. リクエスト JSON プレビュー → 2. 確認送信）

1. **ステップ 1（パラメータ設定とリクエスト JSON プレビュー）**：送信予定の `POST /collect/api/v1/track/batch` リクエスト JSON を 1 つだけ整形表示します（この段階では通信は発生しません）。
2. **ステップ 2（確認送信）**：ターミナルで `y` を入力（または `--yes` を指定）すると送信を実行し、ゲートウェイのレスポンス JSON を表示します。

```bash
# 対話モード：リクエスト JSON を確認してから y で送信
/usr/local/share/dotnet/dotnet run --project abi.sdk/csharp

# 自動確認モード：リクエスト JSON プレビュー表示後に自動送信
/usr/local/share/dotnet/dotnet run --project abi.sdk/csharp -- --yes
```

---

## 4. サーバーサイド実装時の重要ガイド（`#ip` 抽出・毎回の ID 指定・非同期 `#time`・べき等 `event_id`）

クライアント SDK（Unity / Web / モバイル）とは異なり、C# サーバーサイド SDK は**バックエンドデータセンター内で全ユーザーのリクエストを処理するステートレスなシングルトン**です。実装担当者は以下の 4 点に必ず留意してください：

| 項目 | サーバーサイドで明示的な指定が必須な理由 | C# サーバーサイド SDK での推奨実装 |
| :--- | :--- | :--- |
| **1. クライアントの実パブリック IP (`#ip` / `$ip`)**<br/>*(国・都道府県・都市の地域分析)* | バックエンドから `:8081` ゲートウェイへ送信する場合、ゲートウェイが検知する接続元 IP は**バックエンドサーバー自身の内部/NAT IP** になります。`#ip` を渡さないと全イベントの地域がデータセンター所在地になってしまいます。 | ASP.NET Core の `HttpContext`（`X-Forwarded-For` の先頭 IP または `X-Real-IP`）からユーザーのパブリック IP を取得し、`properties["#ip"]` に格納してください。Flink ETL が優先的に GeoIP 解決を行い、`#ip` を自動的に除去します。 |
| **2. ユーザー識別子 (`accountId` / `distinctId`)**<br/>*(毎回の呼び出しで必須)* | サーバーインスタンスは全リクエストで共有されるため、「現在のログインユーザー」をローカル保持できません。 | `Track*` / `User*` の呼び出しごとに、`accountId`（`login_id`、128 UTF-8 バイト以内）またはフロントエンドからヘッダー `X-ABI-Distinct-Id` で転送された訪問者 ID `distinctId`（`distinct_id`、64 UTF-8 バイト以内）の少なくとも一方を必ず渡してください。 |
| **3. イベント発生時刻 (`#time` / `Timestamp`)**<br/>*(非同期 MQ / Webhook / 過去データ補填時は必須)* | Kafka/RabbitMQ の遅延コンシュームや決済 Webhook、バッチ補填では、送信時刻と実際のビジネス発生時刻が異なります。 | `properties["#time"]` または `TrackOptions.Timestamp` に実際のイベント発生時刻（`DateTimeOffset` 等）を指定してください。 |
| **4. 確定的べき等キー (`event_id`)**<br/>*(基幹トランザクション・MQ 再試行時に推奨)* | メッセージキューの再配信時に毎回ランダムな UUID を生成すると、売上や注文回数が重複計上されます。 | `TrackWithId` または `TrackWithOptions` で `"ord_paid_" + orderNo` のような確定的なビジネスメインキー（64 UTF-8 バイト以内）を指定してください（注：`TrackFirst` / `TrackUpdate` / `TrackOverwrite` は現バージョン未開放であり `NotSupportedException` をスローします）。 |

---

## 5. ASP.NET Core 本番環境での統合サンプル

```csharp
using Abi.Sdk;

// 1. Program.cs にてグローバル Singleton として登録（シャットダウン時に自動的に Flush & Close されます）
builder.Services.AddSingleton<AbiAnalytics>(_ =>
{
    var config = new BatchConsumer.Config("http://127.0.0.1:8081", 1, "abi_prod_token")
    {
        BatchSize = 100,
        FlushIntervalMs = 2000,
        CompressGzip = true
    };
    var sdk = new AbiAnalytics(new BatchConsumer(config));
    sdk.SetSuperProperties(new Dictionary<string, object?>
    {
        ["$platform"] = "CSharpServer",
        ["service_name"] = "order-service"
    });
    return sdk;
});

// 2. コントローラーまたは MQ コンシューマーでのイベント送信
string clientIp = HttpContext.Request.Headers["X-Forwarded-For"].FirstOrDefault()?.Split(',')[0].Trim()
                  ?? HttpContext.Connection.RemoteIpAddress?.ToString()
                  ?? string.Empty;

_abi.TrackWithOptions(new TrackOptions
{
    EventId = $"ord_paid_{orderNo}",
    EventName = "OrderPaid",
    AccountId = userId,
    DistinctId = clientDistinctId,
    Timestamp = orderPaidAtUtc,
    Properties = new Dictionary<string, object?>
    {
        ["#ip"] = clientIp,
        ["order_id"] = 9007199254740999L, // > 2^53-1 は自動的に文字列 "9007199254740999" としてシリアライズ
        ["pay_amount"] = 299.00
    }
});
```
