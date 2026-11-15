# ABI Unity ゲームエンジンクライアント SDK 利用ガイド & サンプル (`Abi.GameEngines.Unity`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`AbiUnityAnalytics` は、ABI ユーザー行動分析（UBA）＆ BI プラットフォームの公式 **Unity クライアント C# データ収集 SDK**（ThinkingData Unity Client SDK v3.4 仕様準拠）です。モバイル（iOS/Android）、PC（Steam/Windows/macOS）、コンソール、ミニゲームなど Unity で構築されたあらゆるターゲットに対応しています。

---

## 1. 主な特長

- **ThinkingData 準拠デュアル識別子の自動永続化（`distinct_id` + `login_id`）**：
  - 初回起動時に訪問者／デバイス識別子 `distinct_id`（UUIDv4、最大 64 UTF-8 バイト）を自動生成し、`PlayerPrefs`（`abi_unity_sdk_distinct_id`）に永続化します（`Identify(distinctId)` によるローカル変更も可能、通信は発生しません）。
  - プレイヤーのログイン・キャラクター選択時に `Login(accountId)`（最大 128 UTF-8 バイト）を呼び出すと、`distinct_id` を上書きせずローカルに `login_id` のみを永続化します（通信イベントは送信しません）。以降のイベントには `distinct_id` と `login_id` の両方が付与され、Flink Job1 が StarRocks `identity_map` 上でログイン前後の行動をリアルタイムに紐付けます。
  - ログアウト時に `Logout()` を呼び出すとローカルの `login_id` のみがクリアされ、`distinct_id` はそのまま維持されます（通信は発生しません）。
- **2 ステップ・プレビュー＆確認送信モード（`autoFlush = false`）**：
  - `Initialize(..., autoFlush: false)` を指定すると、イベントは自動送信されずメモリキューに保持されます。
  - **ステップ 1（単一リクエスト JSON のプレビュー）**：`BuildPendingBatchJson(indented: true)` を呼び出し、送信予定の整形済み `POST /collect/api/v1/track/batch` リクエスト JSON をその場で確認できます（履歴ログが無限に増えることはありません）。
  - **ステップ 2（確認送信）**：「確認送信」ボタンのクリックまたは `Flush(callback)` の呼び出しで一括送信し、ゲートウェイのレスポンスを確認します。
- **ゲーム分析向けの専用機能**：
  - **高精度ステージ・ボス戦タイマー（`TimeEvent`）**：`TimeEvent("BossDefeated")` で計測を開始し、クリア時の `Track("BossDefeated")` で経過秒数 `$duration`（ミリ秒単位まで算出）を自動付与します。
  - **64 ビット Snowflake 大整数（`> 2^53 - 1`）の精度保護**：`9007199254740991` を超える `long` / `ulong` 値（バトル ID、アイテム UID、注文番号など）を自動的に 10 進文字列へ変換し、JSON パース時の精度欠損を防止します。
  - **静的・動的共通プロパティ（Super Properties）**：配信チャネルやワールドサーバー ID などの静的共通プロパティ（`SetSuperProperties`）と、現在のマップ名や FPS などの動的共通プロパティ（`SetDynamicSuperProperties`）をサポートします。
  - **7 種類のプレイヤープロファイル操作（`$user_*`）と環境分離**：`UserSet`、`UserSetOnce`、`UserAdd`、`UserUnset`、`UserAppend`、`UserUniqAppend`、`UserDelete` を備え、共通プロパティやデバイス環境属性がプロファイル表（`dim_users`）に混入しないよう自動分離します。

---

## 2. ファイル構成と導入方法

| ファイル | 説明 |
| :--- | :--- |
| [`AbiUnityAnalytics.cs`](AbiUnityAnalytics.cs) | Unity クライアントコア SDK（外部プラグイン依存ゼロ、Mono / IL2CPP 両対応） |
| [`AbiUnityDemoMonoBehaviour.cs`](AbiUnityDemoMonoBehaviour.cs) | 2 ステップ対話型デモスクリプト（`AbiUnityDemoMonoBehaviour` コンポーネント＆`AbiUnityDemoRunner`） |

Unity プロジェクトの `Assets/Scripts/AbiSdk/` フォルダに [`AbiUnityAnalytics.cs`](AbiUnityAnalytics.cs)（および必要に応じて [`AbiUnityDemoMonoBehaviour.cs`](AbiUnityDemoMonoBehaviour.cs)）を配置するだけで利用できます。

---

## 3. 2 ステップ対話型デモ（1. 単一リクエスト JSON プレビュー → 2. 確認送信）

```csharp
using Abi.GameEngines.Unity;
using UnityEngine;

public class GameBootstrap : MonoBehaviour
{
    void Start()
    {
        // ステップ 1：パラメータを構築し、送信予定の POST /collect/api/v1/track/batch リクエスト JSON をプレビュー表示（通信なし）
        string previewJson = AbiUnityDemoRunner.PreviewScenarioJson(
            serverUrl: "http://127.0.0.1:8081",
            projectId: 1,
            projectToken: "abi_tok_unity_demo"
        );
        Debug.Log("=== 送信予定リクエスト JSON プレビュー ===\n" + previewJson);

        // ステップ 2：確認後にゲートウェイへ送信してレスポンスを表示
        AbiUnityDemoRunner.ConfirmSubmit((statusCode, responseJson) =>
        {
            Debug.Log($"=== ゲートウェイ応答 (HTTP {statusCode}) ===\n{responseJson}");
        });
    }
}
```

---

## 4. クライアント実装ガイド：必須項目・SDK 自動収集項目・ゲートウェイによる自動 IP 抽出

Unity クライアント SDK はプレイヤーの端末上で動作し収集ゲートウェイと直接通信するため、サーバーサイド SDK とはパラメータの役割分担が異なります：

| フィールド / 項目 | Unity クライアント側の実装責務 | 仕組みとバックエンド連携 |
| :--- | :--- | :--- |
| **`projectId` & `projectToken`** | **【初期化時に必須】** | ゲーム起動時に `AbiUnityAnalytics.Shared.Initialize(...)` で 1 回指定します。 |
| **`eventName`（イベント名）** | **【`Track` 呼び出し時に必須】** | カスタムイベント名は `^[A-Za-z_][A-Za-z0-9_]*$`（128 文字以内）。`UserSet` などのプロファイル操作では SDK が自動的に `$user_set` などのシステムイベント名を設定します。 |
| **プレイヤー識別子 (`distinct_id` / `login_id`)** | **【SDK が自動管理（ログイン時のみ `Login` を呼ぶ）】** | 起動時に `distinct_id` を自動生成して `PlayerPrefs` に保存するため、通常の `Track` で ID を毎回渡す必要はありません。ログイン時に `Login(accountId)`（ローカル状態更新のみ）、ログアウト時に `Logout()` を呼ぶだけです。 |
| **端末プリセット属性 (`$os`, `$device_model`, `$screen_width` 等)** | **【SDK が自動収集・注入】** | `UnityEngine.SystemInfo`、`Screen`、`Application` から自動取得して行動イベントに付与します（`$user_*` プロファイルイベントからは自動的に除外されます）。 |
| **プレイヤーのパブリック IP (`#ip` / `$ip`)** | **【クライアントからの指定は不要（ゲートウェイが自動抽出）】** | 端末はルーターや基地局の NAT 配下にあるため、自身でパブリック IP を取得できません。**Unity クライアントで `#ip` を渡す必要はありません**。`:8081` 収集ゲートウェイが HTTP 接続および `X-Forwarded-For` ヘッダーからプレイヤーのパブリック IP を自動抽出し、Flink Job1 が国・都道府県・都市を解決します。 |
| **イベント発生時刻 (`timestamp` / `#time`)** | **【デフォルトで指定不要】** | リアルタイム送信時は SDK が現在時刻（ミリ秒）を自動設定します。オフラインイベント補填時のみ `properties["#time"]` または `timestamp` を指定します。 |
| **べき等キー (`event_id`)** | **【デフォルトで指定不要】** | SDK が UUIDv4 を自動生成し、通信リトライ時も同じ `event_id` を維持します。確定的重複排除が必要な場合は `Track` に直接 `eventId` を指定してください（注：`TrackFirst` / `TrackUpdate` / `TrackOverwrite` は現行バージョンでは未サポートです。RESTFUL_API.md §3.3 D7① / G6 gate 参照）。 |
