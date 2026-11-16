# ABI 多語言數據採集 SDK 套件 (`abi.sdk`)

**語言 / Language / 言語**: [简体中文](README.md) | **[繁體中文](README.zh-TW.md)** | [English](README.en.md) | [日本語](README.ja.md) | [한국어](README.ko.md) | [Español](README.es.md) | [Português](README.pt.md) | [Deutsch](README.de.md) | [Français](README.fr.md) | [Русский](README.ru.md) | [Tiếng Việt](README.vi.md) | [ไทย](README.th.md) | [Bahasa Indonesia](README.id.md)

`abi.sdk` 為 ABI 用戶行為分析（UBA）與商業智慧（BI）平台提供生產級客戶端與伺服端數據採集 SDK。套件整體設計對標 [ThinkingData（數數科技）SDK v3.4 規範](https://docs.thinkingdata.cn/ta-manual/v3.4/installation/installation_menu/installation_menu.html)，在欄位契約、身分映射與數據校驗層面與後端採集閘道 [`abi.srv`](../abi.srv/)（`:8081`）及串流批次一體處理引擎 [`abi.flink`](../abi.flink/)（Job1 即時 ETL 與 Job2 原始 ODS 入湖）嚴格對齊。

---

## 1. 目錄結構、多語言文件索引與平台能力矩陣

| 目錄 | 目標平台 / 語言包 | 多語言 README（中 / 英 / 日） | 核心能力覆蓋 | 驗證命令 |
|------|-------------------|-------------------------------|--------------|----------|
| [`RESTFUL_API.md`](RESTFUL_API.md) | 跨語言原生 HTTP RESTful API | [中文](RESTFUL_API.md) | 零 SDK 依賴直連採集閘道指南：包含介面協定規範、全部採用格式化 JSON 的 `curl` 範例（單筆/批次/雙 ID 自動歸因關聯/同日重試冪等去重/7 類 `$user_*` 畫像/Gzip 壓縮/`debug` 與 `dry_run` 預檢）及 Python / Node.js 原生呼叫範例 | 參見文件內 `curl` `dry_run: true` 線上聯調命令 |
| [`spec/test-vectors/`](spec/test-vectors/) | 跨語言黃金測試向量契約 | — | 跨語言共享的 JSON 標準測試向量，涵蓋身分識別碼歸一化（64/128 位元組 UTF-8 邊界、Unicode 空白字元裁剪、控制字元攔截）、事件與屬性命名校驗、大整數（`> 2^53 - 1`）精度保護及 `$user_*` 畫像操作規範 | 由各端 SDK 單元測試套件統一載入斷言 |
| [`ts-web/`](ts-web/) | Web / H5 / TypeScript（`@anylink/abi-web-sdk`）、App-H5 打通橋接、小程式/RN 及 H5 遊戲引擎（Cocos Creator / Egret / LayaAir / Weex）適配器 | [中文](ts-web/README.md) · [EN](ts-web/README.en.md) · [JA](ts-web/README.ja.md)<br/>範例：[中文](ts-web/examples/README.md) · [EN](ts-web/examples/README.en.md) · [JA](ts-web/examples/README.ja.md) | 支援 `init`、`identify`、`login`、`logout`、`track`、`timeEvent`、`setSuperProperties`、`setDynamicSuperProperties`、全套 `$user_*` 畫像更新、SPA 路由 `$pageview` 與 `$AppEnd` 自動採集、App-H5 WebView 橋接打通（`createH5AppBridgeAdapter`）、H5 遊戲引擎適配（`createCocosCreatorAdapter` / `createEgretAdapter` / `createLayaAirAdapter` / `createWeexAdapter`）及頁面關閉 `sendBeacon` 兜底回報（*註：按 D7① / G6 閘門，`trackFirst`/`trackUpdate`/`trackOverwrite` 統一標註為當前版本未開放*） | `cd abi.sdk/ts-web && pnpm test` |
| [`go/`](go/) | Go 伺服端 SDK（`abi.sdk/go`） | [中文](go/README.md) · [EN](go/README.en.md) · [JA](go/README.ja.md)<br/>Demo：[中文](go/examples/demo/README.md) · [EN](go/examples/demo/README.en.md) · [JA](go/examples/demo/README.ja.md) | 並發安全的 `AbiAnalytics` 客戶端，內建四種回報管道：`StagingConsumer`（兩階段式請求 JSON 預覽與確認提交）、`BatchConsumer`（非同步緩衝批次 HTTP + Gzip 壓縮 + 指數退避重試）、`LoggerConsumer`（按天/按小時/按檔案大小滾動的本地 JSONL 寫入）、`DebugConsumer`（同步 L4 強校驗與 `dry_run` 演練驗證） | `cd abi.sdk/go && go test -race ./...` |
| [`java/`](java/) | Java 11+ 伺服端 SDK（`com.anylink.abi:abi-java-sdk`） | [中文](java/README.md) · [EN](java/README.en.md) · [JA](java/README.ja.md) | 執行緒安全的 `AbiAnalytics`（實作 `AutoCloseable` 優雅關閉），提供 `StagingConsumer`、`BatchConsumer`、`LoggerConsumer`、`DebugConsumer`，自動對超出 IEEE-754 雙精度安全範圍（`> 2^53 - 1`）的長整數屬性執行字串無損序列化 | `cd abi.sdk/java && JAVA_HOME=$(/usr/libexec/java_home -v 11) mvn test` |
| [`python/`](python/) | Python 3 伺服端 SDK（`abi.sdk/python`） | [中文](python/README.md) · [EN](python/README.en.md) · [JA](python/README.ja.md) | 零第三方依賴純 Python 3 標準庫實作，提供 `StagingConsumer`、`BatchConsumer`（背景守護執行緒 + Gzip + 指數退避重試）、`LoggerConsumer`、`DebugConsumer`，自動識別 `bool` 與 `> 2^53 - 1` 任意精度大整數轉字串，支援 `#time` / `$time` 提取與 `#ip` / `$ip` 透傳 | `python3 -m unittest discover -s abi.sdk/python/tests -v` |
| [`nodejs/`](nodejs/) | Node.js 伺服端 SDK（`@anylink/abi-node-sdk`） | [中文](nodejs/README.md) · [EN](nodejs/README.en.md) · [JA](nodejs/README.ja.md) | 零外部依賴 ESM + TypeScript 型別宣告（`index.d.ts`），支援 Express / Fastify / Koa / NestJS 多用戶無狀態並發回報，內建 `StagingConsumer`、`BatchConsumer`（`zlib.gzipSync`）、`LoggerConsumer`、`DebugConsumer`，支援 `BigInt` 與不安全整數自動轉字串 | `node --test abi.sdk/nodejs/test/abi-node-sdk.test.mjs` |
| [`csharp/`](csharp/) | C# / .NET 伺服端 SDK（`Anylink.Abi.Sdk`） | [中文](csharp/README.md) · [EN](csharp/README.en.md) · [JA](csharp/README.ja.md) | 基於 .NET 標準庫（`System.Text.Json` / `HttpClient` / `GZipStream`）的執行緒安全伺服端 SDK，提供 `StagingConsumer`、`BatchConsumer`、`LoggerConsumer`、`DebugConsumer` 及全套 `Track*` / `User*` 介面 | `dotnet run --project abi.sdk/csharp -- --test` |
| [`php/`](php/) | PHP 8.1+ 伺服端 SDK（`Anylink\Abi\Sdk`） | [中文](php/README.md) · [EN](php/README.en.md) · [JA](php/README.ja.md) | 零第三方依賴 PHP 伺服端 SDK（適配 Laravel / Symfony / PHP-FPM / Swoole），內建 `StagingConsumer`、`BatchConsumer`（`gzencode` + 重試）、`LoggerConsumer`、`DebugConsumer` 與完整黃金向量校驗 | `php abi.sdk/php/tests/abi_sdk_test.php` |
| [`ruby/`](ruby/) | Ruby 伺服端 SDK（`AbiSdk`） | [中文](ruby/README.md) · [EN](ruby/README.en.md) · [JA](ruby/README.ja.md) | 零外部 Gem 依賴 Ruby 標準庫實作（適配 Rails / Sidekiq / Rack，同時支援 `snake_case` 與 `camelCase` 方法名），提供 `StagingConsumer`、`BatchConsumer`、`LoggerConsumer`、`DebugConsumer` | `ruby abi.sdk/ruby/test/abi_sdk_test.rb` |
| [`cpp/`](cpp/) | C / C++17 跨端 SDK（伺服端 & Unreal Engine / Cocos2d-x 客戶端） | [中文](cpp/README.md) · [EN](cpp/README.en.md) · [JA](cpp/README.ja.md) | 零依賴單標頭檔 C++17 SDK（[`include/abi_sdk.hpp`](cpp/include/abi_sdk.hpp)）及 `extern "C"` 純 C 介面，避免跨 DLL STL ABI 衝突；同時支援 C++ 遊戲服/後端無狀態模式與 Unreal Engine / Cocos2d-x 客戶端設備 Session 模式（含 `time_event` 碼錶耗時計算） | `clang++ -std=c++17 -O2 -Iabi.sdk/cpp/include abi.sdk/cpp/tests/abi_cpp_test.cpp -o /tmp/abi_cpp_test && /tmp/abi_cpp_test` |
| [`lua/`](lua/) | Lua 5.3+ 跨端 SDK（OpenResty / Skynet 伺服端 & Cocos2d-Lua 客戶端） | [中文](lua/README.md) · [EN](lua/README.en.md) · [JA](lua/README.ja.md) | 純 Lua 標準庫零依賴單檔案 [`abi_sdk.lua`](lua/abi_sdk.lua)，內建確定性 JSON 編解碼器與 UTF-8 校驗器，同時支援遊戲服/閘道無狀態模式與客戶端有狀態模式 | `lua abi.sdk/lua/tests/test_abi_sdk.lua` |
| [`mobile/`](mobile/) | 行動客戶端 SDK（Flutter Dart、Android Kotlin、iOS Swift） | 總覽：[中文](mobile/README.md) · [EN](mobile/README.en.md) · [JA](mobile/README.ja.md)<br/>Flutter：[中文](mobile/flutter/README.md) · [EN](mobile/flutter/README.en.md) · [JA](mobile/flutter/README.ja.md)<br/>Android：[中文](mobile/android/README.md) · [EN](mobile/android/README.en.md) · [JA](mobile/android/README.ja.md)<br/>iOS：[中文](mobile/ios/README.md) · [EN](mobile/ios/README.en.md) · [JA](mobile/ios/README.ja.md) | 原生執行緒安全佇列與定時批次刷新、雙 ID 身分綁定（`identify` / `login` / `logout`）、高精度碼錶事件計時（`timeEvent` -> `$duration`）、同日固定 `event_id` 冪等回報（按 D7① / G6 閘門，`trackFirst`/`trackUpdate`/`trackOverwrite` 未開放）、全套 `$user_*` 畫像變更及兩階段式預覽與確認提交互動 Demo | `swiftc -typecheck abi.sdk/mobile/ios/AbiAnalytics.swift abi.sdk/mobile/ios/example/AbiDemoViewController.swift` |
| [`game-engines/unity/`](game-engines/unity/) | Unity 遊戲引擎客戶端 SDK（C# `AbiUnityAnalytics`） | [中文](game-engines/unity/README.md) · [EN](game-engines/unity/README.en.md) · [JA](game-engines/unity/README.ja.md) | 專為 Unity 遊戲客戶端設計的設備 Session 管理、高精度計時器、離線佇列與兩階段式預覽確認組件（`AbiUnityDemoMonoBehaviour`） | `dotnet run --project abi.sdk/csharp -- --test` |
| [`data-import/`](data-import/) | 數據傳輸與離線匯入工具套件（LogBus 2 / Filebeat / Logstash / Vector / DataX） | [中文](data-import/README.md) · [EN](data-import/README.en.md) · [JA](data-import/README.ja.md) | 對標數數 LogBus 2 即時日誌採集守護程式（[`abi_logbus.py`](data-import/abi_logbus.py)，監聽各語言 `LoggerConsumer` 寫入的 `.jsonl` 斷點續傳 + Gzip 批次回報），並提供 Filebeat、Logstash、Vector、Alibaba DataX 開箱即用配置範本 | `python3 abi.sdk/data-import/abi_logbus.py --demo --yes` |

---

## 2. 採集閘道批次回報協議契約 (`POST /collect/api/v1/track/batch`)

所有客戶端與伺服端 HTTP Consumer 均統一向採集閘道發送標準 JSON 批次封包：

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

### 2.1 身分雙 ID 與冪等標識約束（對標數數科技 ThinkingData）

- **`distinct_id`（訪客 / 設備 ID）**：協議層唯一的訪客或終端設備識別碼，嚴禁包含 ASCII 控制字元（`0x00–0x08`、`0x0E–0x1F`、`0x7F`），首尾 Unicode 空白字元自動裁剪，UTF-8 位元組長度上限為 **64 位元組**。客戶端 SDK 初始化時自動生成並持久化本地訪客 ID，也可透過 `identify(visitorId)` 自訂；伺服端在純帳號場景（已提供非空 `login_id` 且無客戶端設備上下文）下允許傳空字串 `""`（**嚴禁將 `login_id` 複製或截斷回填至 `distinct_id`**）。
- **`login_id`（實名登入帳號 ID）**：用戶完成認證或帳號登入後的業務帳號識別碼，UTF-8 位元組長度上限為 **128 位元組**（未登入訪客可省略或傳 `""`）。每筆事件的 `distinct_id` 與 `login_id` **至少有一個非空**。
- **客戶端 `login()` 純本地狀態與全鏈路自動 ID-Mapping**：客戶端呼叫 `login(accountId)` **僅在本地持久化寫入 `login_id`**（保留原 `distinct_id` 不變，且不會自動發送單獨的身分綁定事件）；呼叫 `logout()` 僅清空本地 `login_id` 並繼續沿用當前 `distinct_id`。無論客戶端還是伺服端，**只要任意一筆行為事件（`Track*`）或用戶畫像事件（`$user_*`）同時攜帶非空 `distinct_id` 與 `login_id`**，下游 Flink Job1 即即時將其寫入 `abi.identity_map` 完成跨生命週期歸因貫通。
- **`event_id`（事件冪等主鍵）**：UTF-8 位元組長度上限為 **64 位元組**。當遇到客戶端斷網、HTTP `429` 限流或 `5xx` 伺服端瞬態異常觸發重試時，佇列會保留原始 `event_id` 不變以實作冪等寫入。（*註：當前版本按 D7① / G6 閘門約束，`trackFirst` 首次去重與 `trackUpdate`/`trackOverwrite` 跨天更新統一標註為未開放，如需冪等請在同一事件日期分區內透過標準 `track` 攜帶固定 `event_id`*）。

### 2.2 大整數（$> 2^{53}-1$）精度保護

JavaScript 與通用 JSON 解析器遵循 IEEE-754 雙精度浮點數規範，最大安全整數為 $2^{53}-1$（即 `9007199254740991`）。

- 當整數屬性值的絕對值超過 `9007199254740991`（例如分散式雪花演算法生成的 64 位元訂單流水號 `9007199254740993` 或邊界值 `Int64.min` / `Long.MIN_VALUE`）時，各語言 SDK 會在序列化前自動將其轉換為十進位字串（`"9007199254740993"`），徹底杜絕跨端傳輸過程中的低位精度截斷。
- 同時，所有 SDK 在入隊前均會攔截 `NaN`、`Infinity` / `-Infinity` 非有限浮點數，以及包含 `null` 或巢狀物件/巢狀陣列的非法清單元素。

### 2.3 `$user_*` 用戶畫像事件規範

SDK 提供 7 類標準用戶畫像變更介面，底層統一編碼為系統保留事件並路由至 StarRocks 用戶維表（`dim_users`）：

| SDK 方法 | 協議 `event_name` | 畫像更新語意 |
|----------|-------------------|--------------|
| `userSet(props)` | `$user_set` | 覆蓋寫入用戶畫像屬性（存在則覆蓋，不存在則新增） |
| `userSetOnce(props)` | `$user_set_once` | 僅在目標畫像屬性尚未設定時首次寫入（適用於首次安裝管道、註冊來源等不可變歸因屬性） |
| `userAdd(props)` | `$user_add` | 對數值型畫像屬性執行原子累加/扣減（如積分變動、累計消費金額） |
| `userUnset(keys)` | `$user_unset` | 清空指定的用戶畫像屬性鍵（封包中屬性值統一填充 `0` 作為刪除佔位符） |
| `userAppend(props)` | `$user_append` | 向清單（Array）類型的畫像屬性末尾追加元素（保留重複項） |
| `userUniqAppend(props)` | `$user_uniq_append` | 向清單（Array）類型的畫像屬性追加元素並自動去重（適用於用戶興趣標籤、勳章集合） |
| `userDelete()` | `$user_del` | 標記刪除當前主體的用戶畫像記錄 |

> **隔離約束**：SDK 在組裝 `$user_*`（及相容前綴 `#user_*`）事件的 `properties` 時，**不會注入**靜態/動態公共屬性（Super Properties）以及 `$os`、`$app_version`、`$lib` 等客戶端環境預置屬性，確保環境元數據不會污染用戶畫像寬表。

### 2.4 接入人員視角：各端 SDK 欄位必填性與職責邊界對照（重點）

在實際工程落地中，**客戶端 SDK（Web / 小程式 / App）** 與 **伺服端 SDK（Go / Java）** 所處的網路位置和執行態完全不同。接入人員需特別注意以下欄位在不同 SDK 場景下的傳參職責：

| 欄位 / 屬性 | 客戶端 SDK（`ts-web` / `mobile` Flutter·Android·iOS） | 伺服端 SDK（`go` / `java` / `python` / `nodejs` / `csharp` / `php` / `ruby`） | 原生 HTTP 直連（`RESTFUL_API.md`） | 後端閘道 (`:8081`) 與 Flink ETL 處理規則 |
| :--- | :--- | :--- | :--- | :--- |
| **`project_id` & `project_token`** | **初始化必填**（`init` 時傳入一次） | **初始化 Consumer 必填** | **每次請求頂層必填** | 閘道校驗專案啟用狀態與 Token 簽名，非法直接返回 `401/403` |
| **`event_name`（事件名）** | **每次 `track` 必填**（`userSet*` 等畫像方法由 SDK 自動填 `$user_*`） | **每次 `Track` 必填**（`UserSet*` 等畫像方法由 SDK 自動填 `$user_*`） | **每筆事件必填** | 校驗 `<= 128` 字元及命名規範 `^[A-Za-z_][A-Za-z0-9_]*$`（或系統 `$`/`#` 白名單） |
| **用戶身分（`distinct_id` / `login_id`）** | **自動管理（無需每次傳）**：SDK 初始化時自動生成並持久化訪客 `distinct_id`；用戶登入時呼叫 `login(accountId)` 純本地保存 `login_id`（後續事件自動同時攜帶雙 ID） | **每次呼叫必填**：伺服端實例被所有用戶共享，無本地 Session 態；每次呼叫必須顯式傳入當前用戶的 `login_id`（`accountId`）與/或前端透傳的訪客 `distinct_id`（至少非空其一，絕不將 `login_id` 回填到 `distinct_id`） | **每筆事件必填**（`distinct_id` 與 `login_id` 至少非空其一） | 閘道攔截空身分（`missing_identity`）；任意事件同時攜帶非空 `distinct_id` + `login_id` 時，Flink 自動即時寫入 `abi.identity_map` 完成歸因映射 |
| **用戶公網 IP（`#ip` / `$ip`）**<br/>*(影響國家/省份/城市地域分析)* | **客戶端不傳（也拿不到）**：瀏覽器 JS 與行動端 App 處於 NAT 後方，無法直接取得自身公網出口 IP；直接由採集閘道從 HTTP 連線提取 | **伺服端強烈建議必傳**：伺服端回報時閘道看到的連線 IP 是**後端機房/容器 IP**（或 `LoggerConsumer` 寫入無連線 IP）。伺服端需從客戶端請求標頭（`X-Forwarded-For` / `X-Real-IP`）取得真實用戶 IP 並傳入 `properties["#ip"]` 或 `"$ip"` | 客戶端直連無需傳；伺服端轉發/回報時**需在 `properties` 中傳入 `"#ip"` 或 `"$ip"`** | Flink 嚴格按 **`properties["#ip"]` > `properties["$ip"]` > 閘道連線 `client_ip`** 優先級提取合法數值 IP 解析 GeoIP（國家/省/市），並自動從 `properties` 中剝離 `#ip`/`$ip` |
| **事件發生時間（`timestamp` / `#time` / `$time`）** | **預設免填**：客戶端即時觸發時 SDK 自動取 `Date.now()`；僅補報歷史離線事件時傳 `#time` / `$time` 或 `options.timestamp` | **即時免填 / 非同步與補數必填**：即時埋點預設取伺服器當前時間；若為 **MQ 非同步消費、支付回呼或歷史數據回補**，必須透過 `properties["#time"]`（或 `TrackOptions.Timestamp` / `Date` / `Instant`）傳入實際業務發生時間 | **每筆事件必填**（傳頂層毫秒 `timestamp` 或 `properties["#time"]` / `"$time"`） | 閘道與 SDK 均支援將 `#time` / `$time` 自動提取覆蓋為頂層毫秒 `timestamp` 並從 `properties` 剝離；超出專案時間視窗 `ts_window_days` 將被攔截或標記 |
| **事件冪等主鍵（`event_id`）** | **預設免填**：SDK 自動生成 UUIDv4，斷網重連重發時自動保持原 `event_id`；按 D7① / G6 閘門，`trackFirst`/`trackUpdate`/`trackOverwrite` 統一收斂標註為當前版本未開放 | **普通事件免填 / 核心交易推薦顯式傳**：MQ 消費或訂單狀態演進場景，強烈建議透過 `TrackWithOptions` / `trackWithId` 傳入確定性業務主鍵（如 `"ord_paid_" + orderNo`）實作端到端冪等 | 推薦顯式傳 UUID 或業務主鍵（不傳時閘道自動生成 UUID，但客戶端重試無法冪等） | StarRocks `dwd_events` 依據主鍵與 `event_id` 在同一分區視窗內保障冪等去重 |
| **設備環境預置屬性（`$os` / `$app_version` / `$screen_width` 等）** | **SDK 自動採集注入**（僅注入行為事件，自動隔離 `$user_*` 畫像事件） | **伺服端無法自動獲知客戶端設備**：可透過 `SetSuperProperties` 設定服務名/版本號，或從客戶端請求標頭透傳 `$os`、`$app_version`、`$device_model` | 按需在 `properties` 中顯式傳入 | Flink 自動將 `$os`、`$app_version`、`$device_model` 等提升至 `dwd_events` 物理加速欄位 |

> **前後端協同打通最佳實踐**：當同一業務既有前端瀏覽（Web/App SDK）又有後端落單（Go/Java 等伺服端 SDK）時，推薦前端在呼叫業務後端下單 API 時，透過請求標頭（如 `X-ABI-Distinct-Id: abi.getDistinctId()`）把前端訪客 ID 傳給後端；後端在呼叫伺服端 SDK `Track` 時同時傳入 `loginId`（`accountId`）、訪客 `distinctId` 以及客戶端真實 `"#ip"`，即可在任意業務事件上自動觸發 Flink ID-Mapping 關聯，完美實作「前端曝光瀏覽 → 後端支付回呼」的全漏斗歸因與真實地域還原。

---

## 3. 各端互動式 Demo 與程式碼範例速查表

`abi.sdk` 為每一門語言和客戶端框架均配備了完整的文件註解（`GoDoc`、`Javadoc`、`TSDoc`、`DartDoc`、`KDoc`、`SwiftDoc`），並且所有面向用戶的視覺化 Demo 與命令列/方法級 Demo 統一採用 **「1. 配置參數並即時預覽唯一一份請求封包 JSON → 2. 顯式點擊『確認提交』（或呼叫確認提交方法）發送並查看單份回應」** 的兩階段互動模式，避免參數調整時在監控區無限累加冗餘日誌：

| 平台 / SDK | 互動式介面 / 可執行 Demo 入口檔案 | 帶註解的核心 SDK 原始碼 | 觸發方式與驗證命令 |
|------------|-----------------------------------|----------------------|--------------------|
| **Go 伺服端 SDK** | [`go/examples/demo/main.go`](go/examples/demo/main.go) & [`go/example_test.go`](go/example_test.go) | [`go/abi.go`](go/abi.go)（含 `StagingConsumer`） | `cd abi.sdk/go && go run ./examples/demo`（互動式預覽請求 JSON 後輸入 `y` 確認提交，或加 `--yes` 自動確認） |
| **Java 11+ 伺服端 SDK** | [`java/src/main/java/com/anylink/abi/sdk/examples/AbiJavaSdkDemo.java`](java/src/main/java/com/anylink/abi/sdk/examples/AbiJavaSdkDemo.java) | [`java/src/main/java/com/anylink/abi/sdk/AbiAnalytics.java`](java/src/main/java/com/anylink/abi/sdk/AbiAnalytics.java) & [`StagingConsumer.java`](java/src/main/java/com/anylink/abi/sdk/StagingConsumer.java) | `cd abi.sdk/java && JAVA_HOME=$(/usr/libexec/java_home -v 11) mvn test-compile exec:java -Dexec.mainClass="com.anylink.abi.sdk.examples.AbiJavaSdkDemo"` |
| **Python 3 伺服端 SDK** | [`python/examples/demo.py`](python/examples/demo.py) | [`python/abi_sdk.py`](python/abi_sdk.py)（含 `StagingConsumer`） | `python3 abi.sdk/python/examples/demo.py --yes`（預覽請求 JSON 後確認提交） |
| **Node.js 伺服端 SDK** | [`nodejs/examples/demo.mjs`](nodejs/examples/demo.mjs) | [`nodejs/src/index.mjs`](nodejs/src/index.mjs)（含 `StagingConsumer`） | `node abi.sdk/nodejs/examples/demo.mjs --yes` |
| **C# (.NET) 伺服端 SDK** | [`csharp/Program.cs`](csharp/Program.cs) | [`csharp/AbiAnalytics.cs`](csharp/AbiAnalytics.cs)（含 `StagingConsumer`） | `dotnet run --project abi.sdk/csharp -- --yes` |
| **PHP 8.1+ 伺服端 SDK** | [`php/examples/demo.php`](php/examples/demo.php) | [`php/src/AbiAnalytics.php`](php/src/AbiAnalytics.php)（含 `StagingConsumer`） | `php abi.sdk/php/examples/demo.php --yes` |
| **Ruby 伺服端 SDK** | [`ruby/examples/demo.rb`](ruby/examples/demo.rb) | [`ruby/lib/abi_sdk.rb`](ruby/lib/abi_sdk.rb)（含 `StagingConsumer`） | `ruby abi.sdk/ruby/examples/demo.rb --yes` |
| **C / C++17 跨端 SDK** | [`cpp/examples/demo.cpp`](cpp/examples/demo.cpp) | [`cpp/include/abi_sdk.hpp`](cpp/include/abi_sdk.hpp)（含 `StagingConsumer` 與 `extern "C"`） | `clang++ -std=c++17 -O2 -Iabi.sdk/cpp/include abi.sdk/cpp/examples/demo.cpp -o /tmp/abi_cpp_demo && /tmp/abi_cpp_demo --yes` |
| **Lua 5.3+ 跨端 SDK** | [`lua/examples/demo.lua`](lua/examples/demo.lua) | [`lua/abi_sdk.lua`](lua/abi_sdk.lua)（含 `StagingConsumer`） | `lua abi.sdk/lua/examples/demo.lua --yes` |
| **Web / H5 視覺化演練場** | [`ts-web/examples/interactive-demo.html`](ts-web/examples/interactive-demo.html) & [`ts-web/examples/usage-examples.ts`](ts-web/examples/usage-examples.ts)（`previewAndConfirmWebSdkExample`） | [`ts-web/src/index.ts`](ts-web/src/index.ts)（`buildPendingBatchPayload`） | 瀏覽器開啟 `ts-web/examples/interactive-demo.html` 配置參數預覽 JSON 並點擊「確認提交」，或執行 `cd abi.sdk/ts-web && pnpm test` |
| **App 內嵌 H5 WebView 打通 & H5 遊戲引擎** | [`ts-web/test/abi-web-sdk.test.ts`](ts-web/test/abi-web-sdk.test.ts) | [`ts-web/src/adapters/h5-bridge.ts`](ts-web/src/adapters/h5-bridge.ts) & [`ts-web/src/adapters/game-engines.ts`](ts-web/src/adapters/game-engines.ts) | `cd abi.sdk/ts-web && pnpm test`（覆蓋 Android/iOS WebView Bridge 及 Cocos Creator / Egret / LayaAir / Weex） |
| **ABI 管理端內建接入指南抽屜** | [`../abi.cli/src/pages/Meta/MetaProjects.tsx`](../abi.cli/src/pages/Meta/MetaProjects.tsx) & [`../abi.cli/src/lib/sdk-guide-token.ts`](../abi.cli/src/lib/sdk-guide-token.ts) | 同上 | 在後台「元數據 → 專案管理 → 接入指南」中選擇場景/公共屬性預覽單份 JSON 並點擊「確認提交」 |
| **微信小程式 & React Native** | [`ts-web/examples/usage-examples.ts`](ts-web/examples/usage-examples.ts)（`runWeChatMiniProgramExample`、`runReactNativeExample`） | [`ts-web/src/adapters/miniapp.ts`](ts-web/src/adapters/miniapp.ts) & [`ts-web/src/adapters/react-native.ts`](ts-web/src/adapters/react-native.ts) | 呼叫適配器演練函式，或執行 `cd abi.sdk/ts-web && pnpm test` |
| **Unity 遊戲引擎客戶端 SDK** | [`game-engines/unity/AbiUnityDemoMonoBehaviour.cs`](game-engines/unity/AbiUnityDemoMonoBehaviour.cs)（`AbiUnityDemoMonoBehaviour` / `AbiUnityDemoRunner`） | [`game-engines/unity/AbiUnityAnalytics.cs`](game-engines/unity/AbiUnityAnalytics.cs)（`BuildPendingBatchJson`） | 在 Unity 掛載 `AbiUnityDemoMonoBehaviour` 或執行 `dotnet run --project abi.sdk/csharp -- --test` |
| **Flutter 客戶端 SDK** | [`mobile/flutter/example/lib/main.dart`](mobile/flutter/example/lib/main.dart)（`AbiSdkDemoApp` / `AbiSdkDemoScreen`） | [`mobile/flutter/lib/abi_sdk.dart`](mobile/flutter/lib/abi_sdk.dart)（`buildPendingBatchPayload` / `previewScenarioPayload` + `confirmSubmit`） | 在 Flutter 宿主工程掛載 `AbiSdkDemoApp` 配置參數預覽 JSON 後點擊「確認提交」，或呼叫 `previewScenarioPayload` + `confirmSubmit`（詳見 [`mobile/README.md`](mobile/README.md)） |
| **Android Kotlin 客戶端 SDK** | [`mobile/android/example/AbiDemoActivity.kt`](mobile/android/example/AbiDemoActivity.kt)（`AbiDemoActivity` / `previewScenarioPayload` + `confirmSubmit`） | [`mobile/android/AbiAnalytics.kt`](mobile/android/AbiAnalytics.kt)（`buildPendingBatchPayload`） | 在 Android 宿主工程啟動 `AbiDemoActivity` 預覽單份請求 JSON 後點擊「確認提交」，或呼叫 `previewScenarioPayload` + `confirmSubmit`（詳见 [`mobile/README.md`](mobile/README.md)） |
| **iOS Swift 客戶端 SDK** | [`mobile/ios/example/AbiDemoViewController.swift`](mobile/ios/example/AbiDemoViewController.swift)（`AbiSdkDemoView` / `AbiSdkDemoRunner`） | [`mobile/ios/AbiAnalytics.swift`](mobile/ios/AbiAnalytics.swift)（`buildPendingBatchJsonString`） | 在 SwiftUI 工程掛載 `AbiSdkDemoView()` 預覽請求 JSON 後點擊「確認提交」（或呼叫 `AbiSdkDemoRunner.previewScenarioJson` + `confirmSubmit`）；型別檢查：`swiftc -typecheck abi.sdk/mobile/ios/AbiAnalytics.swift abi.sdk/mobile/ios/example/AbiDemoViewController.swift` |
| **LogBus 2 / 數據匯入工具套件** | [`data-import/abi_logbus.py`](data-import/abi_logbus.py)（`--demo` 兩階段式預覽與確認提交） | [`data-import/abi_logbus.py`](data-import/abi_logbus.py) 及 Filebeat / Logstash / Vector / DataX 配置範本 | `python3 abi.sdk/data-import/abi_logbus.py --demo --yes` |
