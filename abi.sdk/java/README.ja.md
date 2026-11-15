# ABI Java サーバーサイド SDK 利用ガイド＆サンプル集 (`abi-java-sdk`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`abi-java-sdk` は、ABI ユーザー行動分析（UBA）＆ BI プラットフォーム公式の **Java サーバーサイドデータ収集 SDK**（ThinkingData TA Java SDK v3.4 とセマンティクス互換）です。高並行マイクロサービス、トランザクションバックエンド、およびバッチ処理ジョブ向けに設計されています。

---

## 1. 主な特長

- **マルチチャネル `Consumer` アーキテクチャ**：
  - `StagingConsumer`（ステージングプレビュー / 対話型デバッグ推奨）：ネットワークリクエストを自動送信せず、送信待ちイベントをメモリ内に一時保持します。まず `previewRequestJson(...)` を呼び出してインデント整形済みの `POST /collect/api/v1/track/batch` リクエスト JSON 全文を確認し、目視またはプログラムで検証した後に `confirmSubmit(targetConsumer)` を呼び出して一括送信できます。
  - `BatchConsumer`（本番環境推奨）：メモリ内の有界ブロッキングキューとデーモン定期スレッドによる非同期バッチ HTTP 送信。Gzip 圧縮、ネットワーク揺らぎ・`5xx`・`429` 発生時の指数バックオフリトライをサポートし、リトライ中も `event_id` の冪等性を厳密に維持します。
  - `DebugConsumer`（結合テスト / CI 品質ゲート）：イベントを 1 件ずつ同期送信し、ゲートウェイの L4 厳格メタデータ・スキーマ検証を有効化します。`dryRun=true`（検証のみ行い保存しない）をサポートし、テスト用のダーティデータが本番の Kafka や StarRocks を汚染するのを防ぎます。
  - `LoggerConsumer`（高スループットオフラインディスク出力）：イベントおよびユーザープロファイル更新を UTC 日付単位で自動ローテーションされるローカル `.jsonl` ファイルへ追記します。Filebeat / Vector / LogBus などのサイドカー収集エージェントと組み合わせることで、コアトランザクション経路を外部ネットワーク I/O から完全に分離できます。
- **ThinkingData 準拠のデュアル ID 自動紐付け**：通信ペイロード上の ID フィールドは訪問者／端末 ID（`distinct_id` ≤ 64 UTF-8 バイト）と認証済みアカウント ID（`login_id` ≤ 128 UTF-8 バイト）の 2 つのみです（少なくとも一方が非空白必須であり、`distinct_id` が空の際に `login_id` を `distinct_id` にコピーすることは一切ありません）。専用の ID 紐付けメソッドや特別な紐付けイベントは不要で、任意の `track*` または `user*` イベントに `login_id` と `distinct_id` の両方を渡すだけで Flink ETL が自動的に ID-Mapping を行います。
- **べき等イベント送信（注：D7① / G6 制限により、`trackFirst`/`trackUpdate`/`trackOverwrite` は現バージョン未開放として統一）**：決定論的な `event_id` を指定したべき等送信（`trackWithId`）をサポート。`trackFirst` 重複排除および `trackUpdate`/`trackOverwrite` 更新は現バージョン未開放のため、同一パーティション内で `trackWithId` を使用してください。
- **充実したユーザープロファイル（User Profile）操作**：`userSet`、`userSetOnce`、`userAdd`、`userAppend`、`userUniqAppend`、`userUnset`、`userDelete` の全 7 種類のプロファイル更新プリミティブを備え、行動イベント用の共通プロパティ（Super Properties）を自動的に除外してサーバー環境属性によるプロファイルテーブルの汚染を防止します。
- **厳格な型安全性と精度保護**：
  - **分散 Snowflake ID の精度欠損防止**：IEEE-754 安全整数範囲（`> 2^53 - 1`、すなわち `9007199254740991`）を超える `Long` 型プロパティを自動的に文字列へシリアライズし、フロントエンド JS や下流の JSON パーサーでの末尾桁落ちを防止します。
  - **UTC タイムスタンプ正規化**：`java.time.Instant` および `java.util.Date` を標準 UTC ISO-8601 文字列（例：`2026-11-10T02:15:30Z`）へ自動フォーマットします。

---

## 2. 動作環境・ビルドとインストール

- **JDK バージョン**：Java 11 以上（`maven.compiler.source = 11`）
- **ビルドツール**：Maven 3.8 以上
- **ランタイム依存関係**：`com.fasterxml.jackson.core:jackson-databind` と JDK 標準ライブラリのみに依存し、重量級フレームワークへの依存はありません。

### Maven 座標

```xml
<dependency>
    <groupId>com.anylink.abi</groupId>
    <artifactId>abi-java-sdk</artifactId>
    <version>1.0.0</version>
</dependency>
```

### ローカルビルドと単体テストの実行

> 複数の JDK がインストールされた macOS 環境では、明示的に Java 11 を指定することを推奨します：

```bash
cd abi.sdk/java
JAVA_HOME=$(/usr/libexec/java_home -v 11) mvn test
```

---

## 3. 2 ステップ式デモの実行（1. 設定＆リクエスト JSON プレビュー → 2. 送信確認）

SDK 同梱の [`AbiJavaSdkDemo`](src/main/java/com/anylink/abi/sdk/examples/AbiJavaSdkDemo.java) は、複数バッチのログが混在して画面が流れるのを防ぐため、明快な **2 ステップ対話型ワークフロー** を採用しています：
1. **ステップ 1（パラメータ設定とリクエスト JSON プレビュー）**：指定されたビジネスシナリオと共通プロパティ設定に基づき、ターミナルに **インデント整形済みの `POST /collect/api/v1/track/batch` 送信予定リクエスト JSON プレビューを 1 つだけ出力** します（この段階ではネットワーク通信は一切発生しません）。
2. **ステップ 2（送信確認）**：対話型ターミナルで確認プロンプト（`[y/N]: `）を表示し、`y` が入力された場合（または `--yes` 指定時／非対話環境）にのみ実際にリクエストを送信し、**ゲートウェイからのレスポンス結果を 1 つだけ出力** します。

### 3.1 デフォルトのゼロ依存ローカルプレビュー＆確認モード

`--server-url` を省略すると、ステップ 1 で送信予定の JSON ペイロードを表示し、ステップ 2 で確認した後に軽量な内蔵モックゲートウェイを自動起動して送信・レスポンス確認を完結できます：

```bash
cd abi.sdk/java
JAVA_HOME=$(/usr/libexec/java_home -v 11) mvn compile exec:java \
  -Dexec.mainClass="com.anylink.abi.sdk.examples.AbiJavaSdkDemo"
```

### 3.2 共通プロパティ・シナリオのカスタマイズと実 `:8081` 収集ゲートウェイへの接続

```bash
cd abi.sdk/java
JAVA_HOME=$(/usr/libexec/java_home -v 11) mvn compile exec:java \
  -Dexec.mainClass="com.anylink.abi.sdk.examples.AbiJavaSdkDemo" \
  -Dexec.args="--server-url http://127.0.0.1:8081 --project-id 1 --project-token abi_live_token \
  --scenario=order --super-props='{\"$app_version\":\"3.5.0\",\"env\":\"staging\"}' --dynamic-super"
```

スクリプトや自動検証でターミナルの `[y/N]` 確認をスキップして即時送信する場合は、`--yes`（および保存せず検証のみ行う場合は任意の `--dry-run`）を追加します：

```bash
cd abi.sdk/java
JAVA_HOME=$(/usr/libexec/java_home -v 11) mvn compile exec:java \
  -Dexec.mainClass="com.anylink.abi.sdk.examples.AbiJavaSdkDemo" \
  -Dexec.args="--server-url http://127.0.0.1:8081 --project-id 1 --project-token abi_live_token \
  --scenario=all --dry-run --yes"
```

### 3.3 Java コード内で `StagingConsumer` を使った 2 ステッププレビュー＆送信確認

ローカルでの自己検証や運用データ補填ツールを作成する際、`StagingConsumer` を直接使用して生成されたリクエスト JSON を事前確認してから送信を確定できます：

```java
import com.anylink.abi.sdk.AbiAnalytics;
import com.anylink.abi.sdk.BatchConsumer;
import com.anylink.abi.sdk.StagingConsumer;

import java.time.Instant;
import java.util.Map;

public class TwoStepSubmitExample {
    public static void main(String[] args) throws Exception {
        StagingConsumer staging = new StagingConsumer();

        // ステップ 1：共通プロパティを設定しイベントを記録（メモリ内の一時キューへの書き込みのみ、ネットワーク通信ゼロ）
        try (AbiAnalytics sdk = new AbiAnalytics(staging)) {
            sdk.setSuperProperties(Map.of("$platform", "java-server", "service_name", "order-service"));
            sdk.trackWithId(
                    "user_8848",     // 認証済みアカウント ID (login_id)
                    "vis_sess_9001", // フロントエンドから X-ABI-Distinct-Id ヘッダーで透過転送された訪問者／端末 ID (distinct_id)
                    "OrderPaid",
                    "ord_paid_ORD202611108848",
                    Map.of(
                            "#ip", "203.0.113.42",          // クライアントの X-Forwarded-For / X-Real-IP から抽出した実際のグローバル IP
                            "order_id", 9007199254740999L,  // > 2^53-1 の Snowflake Long。自動的に文字列 "9007199254740999" に変換
                            "order_no", "ORD202611108848",
                            "amount", 299.00,
                            "paid_at", Instant.now()
                    )
            );
        }

        // インデント整形済みの完全な POST /collect/api/v1/track/batch リクエスト JSON を確認
        String requestJson = staging.previewRequestJson(1L, "abi_live_token", false);
        System.out.println("送信予定リクエスト JSON:\n" + requestJson);

        // ステップ 2：目視または業務ロジックで確認後、BatchConsumer / DebugConsumer へ一括送信しステージングキューをクリア
        BatchConsumer.Config cfg = new BatchConsumer.Config("http://127.0.0.1:8081", 1L, "abi_live_token");
        try (BatchConsumer batchConsumer = new BatchConsumer(cfg)) {
            int submittedCount = staging.confirmSubmit(batchConsumer);
            System.out.println("確認・送信完了イベント件数: " + submittedCount);
        }
    }
}
```

---

## 4. デモのコマンドライン引数と環境変数一覧

コマンドライン引数は同名の環境変数より優先されます（`--key value` と `--key=value` の両方の記法をサポート）：

| コマンドライン引数 | 対応する環境変数 | デフォルト値 | 説明 |
| :--- | :--- | :--- | :--- |
| `--server-url` | `ABI_SERVER_URL` | 空（送信確認時に内蔵モックゲートウェイを起動） | ABI 収集ゲートウェイのベース URL。例：`http://127.0.0.1:8081`（SDK が自動的に `/collect/api/v1/track/batch` を補完） |
| `--project-id` | `ABI_PROJECT_ID` | `1` | ABI 管理画面で発行されたプロジェクト数値 ID（`> 0` 必須） |
| `--project-token` | `ABI_PROJECT_TOKEN` | `abi_demo_project_token` | ABI プロジェクトに対応するデータ収集認証トークン |
| `--scenario` | `ABI_SCENARIO` | `order` | プレビューシナリオ：`order`（注文ライフサイクル）\| `browse`（匿名閲覧）\| `identity`（ログイン ID 紐付け）\| `profile`（7 種のユーザープロファイル操作）\| `all`（全シナリオ統合） |
| `--super-props` | `ABI_SUPER_PROPS` | 内蔵サンプル静的共通プロパティ | 静的共通プロパティの JSON オブジェクト文字列。例：`'{"$app_version":"3.5.0","env":"prod"}'`（`'{}'` を渡すとクリア） |
| `--dynamic-super` | `ABI_DYNAMIC_SUPER` | `false` | 動的共通プロパティの有効化フラグ（`--dynamic-super` 指定で `request_seq` と `trace_ts` を自動注入） |
| `--dry-run` | `ABI_DRY_RUN` | `false` | リクエストペイロードに `"dry_run": true` を付与するか（ゲートウェイでの検証のみ行いストレージへ保存しない） |
| `--yes` / `-y` | `ABI_AUTO_CONFIRM` | `false` | 対話型ターミナルの `[y/N]` 確認プロンプトをスキップし、プレビュー後に即時送信 |

---

## 5. `AbiJavaSdkDemo` コアメソッド詳細

`AbiJavaSdkDemo` は 2 ステップ実行用のエントリメソッド（`buildScenarioPreview` + `confirmAndSubmit`）に加え、個別ビジネスシナリオの静的メソッドおよび全シナリオ連続実行メソッド `runAllDemos` を提供します：

### 5.0 2 ステップ実行エントリ：`buildScenarioPreview(...)` と `confirmAndSubmit(...)`
- **`buildScenarioPreview(DemoConfig config)`**：設定に従って `StagingConsumer` と `AbiAnalytics` を初期化し、静的／動的共通プロパティを注入して対象シナリオのイベントを生成し、コンソールに整形済みのリクエスト JSON プレビューを 1 つだけ出力した上で `StagingConsumer` を返します。
- **`confirmAndSubmit(StagingConsumer staging, DemoConfig config)`**：対話型ターミナルの `[y/N]` 確認を処理し（キャンセル時は `staging.clear()` を呼び出しネットワーク通信ゼロ）、承認後に `staging.confirmSubmit(...)` で単一バッチを送信してゲートウェイレスポンスを出力します。

### 5.1 匿名閲覧と静的／動的共通プロパティ：`triggerAnonymousBrowseAndSuperProps(AbiAnalytics sdk)`
- **デモ内容**：
  1. `sdk.setSuperProperties(...)` を呼び出してグローバルな静的共通プロパティ（`$app_version`、`$platform`、`service_name` など）を登録し、後続のすべての行動イベントに自動注入します。
  2. `sdk.setDynamicSuperProperties(Supplier)` を呼び出して動的共通プロパティのコールバック（単調増加するリクエスト連番 `request_seq`、トレースタイムスタンプ `trace_ts` など）を登録し、`track` 呼び出しごとにリアルタイム評価します。
  3. 未ログイン訪問者（`loginId = ""`、`distinctId = "vis_sess_9001"`）をシミュレートして、`$pageview` と `ProductViewed` の 2 件の閲覧イベントを送信します。
- **プロパティ上書き優先順位**：`track` 明示指定のイベントプロパティ > 動的共通プロパティ（`DynamicSuperProperties`） > 静的共通プロパティ（`SuperProperties`）。

### 5.2 登録・ログイン時のデュアル ID 自動紐付け：`triggerLoginIdentityBinding(AbiAnalytics sdk)`
- **デモ内容**：
  1. ThinkingData 準拠のデュアル ID モデルにより専用の紐付け API は不要です。登録・ログイン完了時に `sdk.track("user_8848", "vis_sess_9001", "$signup", ...)` と `"$login"` を呼び出し、認証済み `loginId` と訪問者 `distinctId` の両方を同時に送信します。
  2. Flink Job1 ETL は任意のイベントで非空の `login_id` と `distinct_id` が揃ったことを検知すると、StarRocks の `identity_map` へ自動的にマッピングを記録し、以前の訪問者セッション行動をアカウント `user_8848` に統合します。

### 5.3 注文マイルストーンイベントと Snowflake 長整数の安全変換：`triggerOrderLifecycleTrackUpdateOverwrite(AbiAnalytics sdk)`
- **デモ内容**：
  1. **決定論的 `event_id` によるマイルストーン送信（`trackWithId`）**：固定の業務イベント主キーを使用し、`OrderCreated`、`OrderPaid`、`OrderSettled` の 3 つの独立したマイルストーンイベントを送信します（注：D7① / G6 制限により、`trackFirst` / `trackUpdate` / `trackOverwrite` は現バージョン未開放であり、`UnsupportedOperationException` をスローします）。
  2. **Snowflake 長整数の精度欠損防止**：プロパティ `order_id` に `9007199254740999L`（JS の最大安全整数 `2^53 - 1` を超える値）を渡し、SDK 内部で自動的に文字列 `"9007199254740999"` に変換して転送します。

### 5.4 全 7 種のユーザープロファイル操作：`triggerUserProfileOperations(AbiAnalytics sdk)`
- **デモ内容**：ABI がサポートする全 7 種類のユーザープロファイル（`dim_users`）更新インターフェースを順に実行します（**注意**：すべての `$user_*` イベントでは `superProperties` と `dynamicSuperProperties` が自動的に除外されます）：

| SDK メソッド | 内部システムイベント | ビジネスセマンティクスと主な用途 |
| :--- | :--- | :--- |
| `userSet` | `$user_set` | ユーザーの最新属性を上書き保存（ニックネーム `display_name`、会員ランク `vip_tier`、居住都市 `$city` など） |
| `userSetOnce` | `$user_set_once` | 属性が未設定の場合のみ初回書き込みを行い、以降は上書きしない（初回流入広告チャネル `first_utm_source`、初回登録日時 `first_registered_at` など） |
| `userAdd` | `$user_add` | 数値型属性のアトミックな加減算（ポイント増減 `loyalty_points: 300`、累計決済金額 `lifetime_spend: 269.10` など） |
| `userAppend` | `$user_append` | リスト型属性への要素追加（重複排除なし。閲覧カテゴリ履歴 `viewed_categories` など） |
| `userUniqAppend` | `$user_uniq_append` | リスト型属性への要素追加と重複排除（有効化済み機能フラグ `feature_flags`、獲得バッジなど） |
| `userUnset` | `$user_unset` | 指定した 1 つ以上のユーザー属性をクリア（期限切れトライアルバッジ `legacy_trial_badge` の削除など） |
| `userDelete` | `$user_del` | 該当ユーザーのプロファイルレコードを削除マーク（プライバシー法規対応のデータ消去要求など） |

### 5.5 `DebugConsumer` Dry-Run オンライン検証：`triggerDebugDryRunValidation(serverUrl, projectId, projectToken)`
- **デモ内容**：`new DebugConsumer(serverUrl, projectId, projectToken, true)`（第 4 引数 `dryRun = true`）をインスタンス化し、イベント `CheckoutValidated` を同期送信します。
- **主な用途**：開発者のローカル単体確認や CI 自動回帰テスト。リクエストペイロードに `"debug": true, "dry_run": true` が自動付与され、イベント名・プロパティ名・値の型が ABI ゲートウェイの L4 メタデータ規約に違反している場合、具体的な拒否理由を含む `IllegalArgumentException` が即座にスローされます。検証を通過した場合、ゲートウェイは成功を返しますが、**本番の分析テーブルへの書き込みは行いません**。

### 5.6 `LoggerConsumer` ローカル JSONL ローテーション出力：`triggerLoggerConsumerDemo(Path outputDir)`
- **デモ内容**：`new LoggerConsumer(outputDir.toFile(), "abi_demo")` をインスタンス化し、オフライン精算イベント `NightlySettlementCompleted` とユーザープロファイル更新を UTF-8 JSON Lines 形式でローカルディスクファイル `abi_demo.YYYY-MM-DD.jsonl` に直接追記します。
- **ローテーション仕組み**：UTC 日付（`YYYY-MM-DD`）ごとに新しいファイルへ自動分割されます。1 行につき 1 件の完全なイベント JSON となるため、Filebeat、Vector、LogBus などのサイドカー収集にそのまま対応します。

---

## 6. 4 つの Consumer の選び方と設定リファレンス

| Consumer 実装 | I/O モデル | 推奨環境 | 主な特徴 |
| :--- | :--- | :--- | :--- |
| `StagingConsumer` | メモリ内ステージングキュー（明示的な確認時のみ送信） | **ローカルパラメータ検証 / 運用データ補填ツール** | 自動ネットワーク通信ゼロ。`previewRequestJson` による完全なリクエストプレビュー、`clear` リセット、`confirmSubmit` 確定送信をサポート |
| `BatchConsumer` | メモリキューバッファ + バックグラウンド定期／件数単位バッチ HTTP | **本番環境のマイクロサービス** | ビジネススレッドをブロックしない非同期設計、Gzip 圧縮、通信エラーおよび `5xx`/`429` 時の指数バックオフリトライ |
| `DebugConsumer` | `track` ごとに同期ブロッキング単発 HTTP | **ローカル結合テスト / CI テスト** | ゲートウェイのスキーマ拒否詳細を即座に検出、`dryRun=true` による非汚染プリフライト検証をサポート |
| `LoggerConsumer` | ローカルディスクへのバッファ付き順次追記（`BufferedWriter`） | **超高スループット取引 / 外部通信なしバッチ処理** | ネットワーク遅延ゼロ、UTC 日付単位で `<prefix>.YYYY-MM-DD.jsonl` を自動ローテーション |

### `BatchConsumer.Config` パラメータ一覧

| フィールド名 | 型 | デフォルト値 | 説明 |
| :--- | :--- | :--- | :--- |
| `serverUrl` | `String` | 必須 | 収集ゲートウェイ URL（例：`https://collect.example.com`） |
| `projectId` | `long` | 必須（`> 0`） | プロジェクト ID |
| `projectToken` | `String` | 必須 | プロジェクト収集認証トークン |
| `batchSize` | `int` | `50` | 1 バッチあたりの送信トリガー上限件数（有効範囲：`1 ~ 500`） |
| `flushIntervalMs` | `long` | `2000L` | バックグラウンド定期フラッシュ間隔（ミリ秒、最小 `100ms`） |
| `maxQueueSize` | `int` | `10000` | メモリ内送信待ちキューの最大容量（満杯時はメモリ保護のため `add` が `IllegalStateException` をスロー） |
| `maxRetries` | `int` | `3` | 通信エラー / `429` / `5xx` 発生時の最大指数バックオフリトライ回数（`4xx` 恒久的クライアントエラーはリトライ対象外） |
| `compressGzip` | `boolean` | `false` | リクエストボディの `Content-Encoding: gzip` 圧縮を有効化するか（本番のパブリックネットワークやマルチ AZ 間通信では有効化を強く推奨） |
| `dryRun` | `boolean` | `false` | バッチ送信リクエストボディに `"dry_run": true` を含めるか（検証のみ行いストレージに保存しない） |

---

## 7. サーバーサイド導入時の必須フィールドとクライアント透過転送ガイド（IP / ID / 時刻 / べき等キー）

### 7.1 なぜサーバーサイド SDK とフロントエンド／モバイル SDK で必須項目が異なるのか？

- **フロントエンド／モバイル SDK（Web / iOS / Android / ミニプログラム）**：**単一ユーザーの端末上**で動作し、収集ゲートウェイへ直接通信します。SDK が端末ローカルで `distinct_id`（訪問者／端末 ID。クライアント `login(accountId)` はローカル状態更新のみで追加リクエストを送信しません）を自動生成・永続化し、端末情報（`$os` / `$device_model` / `$app_version`）を自動収集するほか、ゲートウェイもクライアントとの TCP 接続からユーザーの実際のグローバル IP を直接取得できます。
- **Go / Java サーバーサイド SDK**：**バックエンドのデータセンターやクラウド VPC 内で動作するステートレスなマルチユーザー共有シングルトン**です。単一ユーザーのセッション状態をメモリに保持することはできず、`:8081` 収集ゲートウェイへの TCP 接続元も**バックエンドサーバー自身のデータセンター／内部 IP** になります（`LoggerConsumer` によるディスク出力では通信接続すら存在しません）。そのため、**ユーザー ID、実際のクライアント IP、実際のビジネス発生時刻、べき等イベント ID** はすべて、導入担当エンジニアが現在のリクエストコンテキストやメッセージペイロードから明示的に渡す必要があります。

### 7.2 サーバーサイド導入フィールドの必須度と取得元一覧表

| フィールド分類 | SDK 引数 / `properties` キー名 | 必須レベル | 必要な理由と取得・透過転送の方法 |
| :--- | :--- | :--- | :--- |
| **ユーザー識別子**<br>(`loginId` / `distinctId`) | Java: `(loginId, distinctId, ...)` 引数 | **【毎回呼び出し時に必須】** | サーバーはステートレスなため、`track*` / `user*` の呼び出しごとに現在リクエストしているユーザーの `loginId`（アカウント ID ≤ 128 バイト）またはフロントエンドから透過転送された `distinctId`（訪問者／端末 ID ≤ 64 バイト）を明示的に渡す必要があります（**`loginId` と `distinctId` の少なくとも 1 つは非空白必須**。`distinctId` が空の場合は `"distinct_id": ""` をそのまま送信し、`loginId` を `distinct_id` にコピーすることはありません）。<br>**「フロントエンドでの訪問者閲覧 → バックエンドでの注文・決済」**のコンバージョンファネルを繋ぐには、フロントエンドから HTTP ヘッダー（例：`X-ABI-Distinct-Id`）で `distinct_id` をバックエンドへ渡し、バックエンドで `loginId` と `distinctId` の両方を指定してください。 |
| **実際のクライアント IP**<br>(`#ip` / `$ip`) | `properties.get("#ip")`<br>（または `properties.get("$ip")`） | **【地域分析を行う場合は必須】** | バックエンドから収集ゲートウェイ `:8081` へ送信する際、ゲートウェイの TCP 接続に見えるのは**バックエンドサーバーのデータセンター IP** です（`LoggerConsumer` では接続 IP すらありません）。**`#ip` / `$ip` を渡さないと、すべてのイベントの国・都道府県・都市がデータセンター所在地またはプライベート IP になってしまいます！**<br>クライアントの HTTP リクエストヘッダー（`X-Forwarded-For` の先頭グローバル IP または `X-Real-IP`）からユーザーの実際のグローバル IP を抽出し、`properties` の `"#ip"`（または `"$ip"`）に設定してください。ゲートウェイと Flink Job1 ETL は `#ip` > `$ip` の優先順で国・地域・都市（`$country` / `$province` / `$city`）を解決し、保存前に `properties` から該当の一時キーを自動的に除去します。 |
| **イベント発生時刻**<br>(`#time` / `$time` / `Date`·`Instant` オーバーロード) | `properties` の `"#time"` / `"$time"`<br>または `track*(..., Date / Instant)` オーバーロード | **【リアルタイム通信は省略可／非同期 MQ・コールバック・データ補填時は必須】** | 同期 HTTP API で省略した場合はサーバーの現在時刻が使用されますが、**Kafka/RocketMQ の非同期コンシューマー、決済 Webhook コールバック、オフラインバッチによる過去データ補填**では、処理時刻と実際のビジネス発生時刻が乖離するため、`properties.put("#time", ...)`（`Date`、`Instant`、秒/ミリ秒タイムスタンプ、ISO-8601、または `"yyyy-MM-dd HH:mm:ss.SSS"`）または `Date` / `Instant` 引数のオーバーロードメソッドで実際の発生時刻を渡す必要があります（プロジェクトの `ts_window_days` 期間内である必要があり、抽出後は `properties` から自動除去されます）。 |
| **べき等イベント ID**<br>(`event_id`) | `trackWithId(..., eventId, ...)` | **【MQ 消費・基幹トランザクションでは強く推奨】** | `track(...)` で省略時はランダムな UUIDv4 が自動生成されますが、**MQ の再配信や決済コールバックのリトライ**で毎回新しい UUID が生成されると、注文数や決済金額が二重計上されます。`trackWithId` を使用し、決定論的な業務主キー（例：`"ord_paid_" + orderNo`、64 バイト以内）を `eventId` に指定して同日のべき等重複排除を行うことを強く推奨します（注：`trackFirst` / `trackUpdate` / `trackOverwrite` は現バージョン未開放です）。 |
| **クライアント端末コンテキスト**<br>(`$os` / `$app_version` / `$device_model`) | `properties` の `"$os"`、`"$app_version"`、`"$device_model"` | **【必要に応じてフロントエンドから透過転送】** | バックエンドサーバーはユーザーの端末モデルやアプリバージョンを自動検知できません。サーバーサイドイベントをクライアント OS やアプリバージョン別に分析したい場合は、フロントエンドのリクエストヘッダー（例：`X-Client-OS`、`X-App-Version`）から受け取り、個別イベントの `properties` に書き込んでください（全ユーザー共通の `setSuperProperties` には絶対に入れないでください）。 |

---

## 8. Spring Boot / サーバーサイド本番運用ベストプラクティス

### 8.1 グローバルシングルトン Bean とグレースフルシャットダウン（リクエストごとの `new` は厳禁）

`AbiAnalytics` と `BatchConsumer` は内部でスレッドセーフに設計されており、バックグラウンドスケジューラスレッドプールを保持しています。Spring Boot では **グローバルシングルトン Bean** として登録し、`destroyMethod = "close"` を指定してアプリケーション終了（`SIGTERM`）時にメモリキュー内の残存イベントが自動的にフラッシュ送信されるようにしてください：

```java
package com.example.shop.config;

import com.anylink.abi.sdk.AbiAnalytics;
import com.anylink.abi.sdk.BatchConsumer;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import java.util.Map;

@Configuration
public class AbiAnalyticsConfig {

    @Bean(destroyMethod = "close")
    public AbiAnalytics abiAnalytics(
            @Value("${abi.collect.server-url}") String serverUrl,
            @Value("${abi.collect.project-id}") long projectId,
            @Value("${abi.collect.project-token}") String projectToken,
            @Value("${spring.application.name:order-service}") String serviceName,
            @Value("${spring.profiles.active:prod}") String env
    ) {
        BatchConsumer.Config config = new BatchConsumer.Config(serverUrl, projectId, projectToken);
        config.batchSize = 100;
        config.flushIntervalMs = 2000L;
        config.maxQueueSize = 20000;
        config.maxRetries = 3;
        config.compressGzip = true;

        AbiAnalytics sdk = new AbiAnalytics(new BatchConsumer(config));
        // サービスレベルの静的共通プロパティを登録（行動イベントにのみ注入。個別ユーザーの IP や端末情報はここに入れないこと）
        sdk.setSuperProperties(Map.of(
                "$platform", "java-server",
                "service_name", serviceName,
                "deploy_env", env
        ));
        return sdk;
    }
}
```

### 8.2 ビジネス Service への組み込み、クライアント IP / 訪問者 `distinct_id` 透過転送と障害分離の実装例

コアトランザクション経路では、以下の実装を推奨します：
1. **HTTP リクエストヘッダーからクライアントの実際のグローバル IP（`X-Forwarded-For` / `X-Real-IP`）とフロントエンドの訪問者 `distinct_id`（`X-ABI-Distinct-Id`）を抽出**し、`properties` の `"#ip"` に設定するとともに `loginId` と `distinctId` の両方を渡す。
2. **決定論的な業務冪等キーを `eventId` として使用する**（例：`"ord_paid_" + orderNo`）。これによりメッセージキューの再試行による二重計上を防止できます。
3. **イベント送信呼び出しを `try-catch` で囲み例外を吸収する**。極端なキュー飽和やパラメータ検証エラーが発生しても、メインのビジネストランザクションを決して中断させないようにします。

```java
package com.example.shop.service;

import com.anylink.abi.sdk.AbiAnalytics;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.util.HashMap;
import java.util.Map;

@Service
public class OrderAnalyticsService {
    private static final Logger log = LoggerFactory.getLogger(OrderAnalyticsService.class);

    private final AbiAnalytics abiAnalytics;

    public OrderAnalyticsService(AbiAnalytics abiAnalytics) {
        this.abiAnalytics = abiAnalytics;
    }

    /**
     * @param loginId           ログイン済みユーザー ID (login_id)
     * @param visitorDistinctId フロントエンドから X-ABI-Distinct-Id ヘッダーで透過転送された訪問者／端末 ID (distinct_id)
     * @param clientIp          X-Forwarded-For / X-Real-IP から抽出したクライアントの実際のグローバル IP
     * @param orderNo           業務注文番号（べき等 event_id の生成に使用）
     * @param snowflakeOrderId  64 ビット Snowflake 注文 ID（> 2^53-1 は自動的に文字列へ安全変換）
     * @param payAmount         決済金額
     * @param orderPaidTime     実際の決済完了時刻（MQ 非同期消費やコールバック時は必須）
     */
    public void recordOrderPaid(
            String loginId,
            String visitorDistinctId,
            String clientIp,
            String orderNo,
            long snowflakeOrderId,
            double payAmount,
            Instant orderPaidTime
    ) {
        try {
            // MQ 再配信時の冪等性を保証するため決定論的 eventId を使用。2^53-1 を超える Snowflake Long は自動的に文字列へ安全変換される
            String deterministicEventId = "ord_paid_" + orderNo;
            Map<String, Object> props = new HashMap<>();
            props.put("order_id", snowflakeOrderId);
            props.put("order_no", orderNo);
            props.put("pay_amount", payAmount);
            props.put("#time", orderPaidTime != null ? orderPaidTime : Instant.now()); // トップレベル timestamp として抽出され properties からは自動除去
            if (clientIp != null && !clientIp.isBlank()) {
                props.put("#ip", clientIp); // 地域がバックエンドデータセンター IP になるのを防ぐため実際のクライアント IP を指定
            }

            abiAnalytics.trackWithId(
                    loginId,
                    visitorDistinctId,
                    "OrderPaid",
                    deterministicEventId,
                    props
            );

            // ユーザーの累計決済金額をアトミックに加算
            abiAnalytics.userAdd(
                    loginId,
                    visitorDistinctId,
                    Map.of("total_paid_amount", payAmount)
            );
        } catch (Exception ex) {
            // 計測エラーは警告ログのみ記録し、メインの注文トランザクション処理には影響させない
            log.warn("ABI 注文決済イベントの送信に失敗しました, orderNo={}, orderId={}", orderNo, snowflakeOrderId, ex);
        }
    }
}
```

### 8.3 識別子およびプロパティ検証ルール早見表

| 検証項目 | 制約ルール |
| :--- | :--- |
| ID 識別子の必須条件 | 通信ペイロード上の ID フィールドは `distinct_id`（訪問者／端末 ID）と `login_id`（アカウント ID）の 2 つのみであり、**少なくとも 1 つに非空白文字列を指定する必要があります**。`distinctId` が空の場合は `"distinct_id": ""` がそのまま送信され、`loginId` を `distinct_id` にコピーすることは一切ありません |
| バイト長上限 | `distinct_id` ≤ 64 UTF-8 バイト、`login_id` ≤ 128 UTF-8 バイト、`event_id` ≤ 64 UTF-8 バイト |
| イベント名とプロパティキー | カスタム名称は正規表現 `^[A-Za-z_][A-Za-z0-9_]*$` に一致する必要があります（イベント名は 128 文字以内、カスタムプロパティキーは 64 文字以内）。システム定義済みイベント（`$pageview`、`$signup`、`$login`、`$user_set` など）およびシステムプロパティ（`#ip`、`$ip`、`#time`、`$time`、`$os`、`$app_version`、`$device_model`、`$city`、`$url` など）はホワイトリストとして許可されます |
| サポートされるプロパティ値の型 | `String`、`Boolean`、`Byte`/`Short`/`Integer`/`Long`、有限の `Float`/`Double`（`NaN`/`Infinity` は拒否）、`Date`、`Instant`、および要素が非 null でネストされたコレクション／Map を含まない 1 次元 `Collection`。値が `null` のプロパティキーは自動的に無視されます |
