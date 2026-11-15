# ABI Unity 游戏引擎客户端 SDK 使用与示例指南 (`Abi.GameEngines.Unity`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`AbiUnityAnalytics` 是 ABI 用户行为分析（UBA）与商业智能（BI）平台专为 **Unity 游戏引擎（移动端 iOS/Android、PC Steam/Windows/macOS、主机及小游戏）** 打造的客户端 C# 数据采集 SDK（语义兼容数数科技 ThinkingData Unity Client SDK v3.4）。

---

## 1. 核心特性

- **数数科技标准双身份自动持久化（`distinct_id` + `login_id`）**：
  - 首次启动自动生成 UUIDv4 作为设备访客标识 `distinct_id`（最大 64 UTF-8 字节）并通过 `PlayerPrefs`（`abi_unity_sdk_distinct_id`）持久化；支持通过 `Identify(distinctId)` 本地修改访客标识（纯本地更新，不发送任何网络事件）。
  - 玩家完成账号/角色登录时调用 `Login(accountId)`（最大 128 UTF-8 字节），SDK 仅在本地持久化 `login_id`（**不会覆盖 `distinct_id`，也不会发送任何网络事件**）；后续上报的事件将同时携带 `distinct_id` 与 `login_id`，由后端 Flink Job1 实时写入 StarRocks `identity_map` 完成“安装激活 → 创角登录 → 付费留存”全生命周期归因。
  - 切换账号或登出时调用 `Logout()`，仅在本地清空 `login_id` 并保持 `distinct_id` 不变（不发送任何网络事件）。
- **两步式预览与确认提交模式（`autoFlush = false`）**：
  - 将 `Initialize(..., autoFlush: false)` 设为手动模式后，所有埋点与画像操作仅在内存队列中组装；
  - **第 1 步（预览单份请求 JSON）**：调用 `BuildPendingBatchJson(indented: true)` 实时查看完整格式化的 `POST /collect/api/v1/track/batch` 请求报文（零网络请求、不刷屏）；
  - **第 2 步（确认提交）**：点击 UI「确认提交」按钮或调用 `Flush(callback)` 一次性发送并获取网关响应。
- **游戏场景专属能力**：
  - **高精度关卡/副本计时（`TimeEvent`）**：在进入副本或 Boss 战时调用 `TimeEvent("BossDefeated")`，通关调用 `Track("BossDefeated")` 时自动注入秒级耗时 `$duration`（精确到毫秒小数位）。
  - **64 位雪花 ID 精度保护（`> 2^53 - 1`）**：战斗流水号、道具唯一 UID、订单流水号等绝对值超过 `9007199254740991` 的 `long` / `ulong` 属性（含列表元素）自动转为十进制字符串传输，杜绝 JSON 双精度截断。
  - **动静态公共属性（Super Properties）**：支持注册区服、包体渠道等静态公共属性（`SetSuperProperties`），以及当前所在地图场景、实时 FPS、网络延迟等动态公共属性回调（`SetDynamicSuperProperties`）。
  - **全套 7 类 `$user_*` 玩家画像操作**：内置 `UserSet`、`UserSetOnce`、`UserAdd`、`UserUnset`、`UserAppend`、`UserUniqAppend`、`UserDelete`，并**自动隔离**静态/动态公共属性与设备环境属性，防止环境字段污染玩家画像宽表（`dim_users`）。

---

## 2. 目录结构与安装方式

| 文件 | 说明 |
| :--- | :--- |
| [`AbiUnityAnalytics.cs`](AbiUnityAnalytics.cs) | Unity 客户端核心 SDK 源码（零第三方插件依赖，兼容 Mono 与 IL2CPP） |
| [`AbiUnityDemoMonoBehaviour.cs`](AbiUnityDemoMonoBehaviour.cs) | 两步式交互演练脚本（含 `AbiUnityDemoMonoBehaviour` 组件与 `AbiUnityDemoRunner` 演练器） |

### 集成到 Unity 工程

1. 将 [`AbiUnityAnalytics.cs`](AbiUnityAnalytics.cs)（以及可选的演练脚本 [`AbiUnityDemoMonoBehaviour.cs`](AbiUnityDemoMonoBehaviour.cs)）复制到 Unity 工程的 `Assets/Scripts/AbiSdk/` 目录下。
2. SDK 使用 `#if UNITY_5_3_OR_NEWER` 条件编译指令，自动调用 `UnityEngine.PlayerPrefs`、`Application`、`SystemInfo`、`Screen` 等原生接口，无需安装任何外部 DLL 或 NuGet 包。

---

## 3. 两步式交互演练（1. 预览单份请求 JSON → 2. 确认提交）

### 3.1 使用 `AbiUnityDemoMonoBehaviour` 挂载运行

在 Unity 场景中创建一个空物体（如 `AbiSdkDemo`），挂载 [`AbiUnityDemoMonoBehaviour`](AbiUnityDemoMonoBehaviour.cs) 脚本：
- **顶部身份状态仅展示 2 项**：`VisitorDistinctId`（访客标识 `distinct_id`）与 `CurrentLoginId`（登录账号 ID `login_id`）。
- **第 1 步（调整参数实时刷新预览）**：调用 `SwitchVisitorId()`（切换随机访客 ID `identify`）、`TriggerLogin("role_knight_10001")`（设置登录账号 `login`，纯本地状态切换，令暂存事件同时携带 `distinct_id` 与 `login_id`）、`TriggerLogout()`（退出登录 `logout`）、`ApplyStaticSuperProperties("TapTap_CN", "S101_Avalon")`、`StageBossDefeatedWithDuration()`、`StageSnowflakeIapOrder()` 或任意 `StageUser*()` 方法，脚本会原地重算并更新 `RequestJsonPreview` 属性中的**唯一一份待提交请求 JSON**（不会在控制台或 UI 累加历史刷屏日志）。
- **第 2 步（确认提交）**：绑定 UI 按钮点击 `ConfirmSubmit()`，SDK 立即调用 `Flush` 发送该批次，并将网关返回的 JSON 写入 `ResponseJsonPreview`。

### 3.2 代码直接调用两步式预览与确认提交 (`AbiUnityDemoRunner`)

```csharp
using Abi.GameEngines.Unity;
using UnityEngine;

public class GameBootstrap : MonoBehaviour
{
    void Start()
    {
        // 第 1 步：构造完整游戏埋点场景并预览唯一一份 POST /collect/api/v1/track/batch 请求 JSON（零网络请求）
        string previewJson = AbiUnityDemoRunner.PreviewScenarioJson(
            serverUrl: "http://127.0.0.1:8081",
            projectId: 1,
            projectToken: "abi_tok_unity_demo"
        );
        Debug.Log("=== 待提交请求 JSON 预览 ===\n" + previewJson);

        // 第 2 步：确认无误后提交至采集网关
        AbiUnityDemoRunner.ConfirmSubmit((statusCode, responseJson) =>
        {
            Debug.Log($"=== 网关响应 (HTTP {statusCode}) ===\n{responseJson}");
        });
    }
}
```

---

## 4. 客户端接入人员必读：必填项、SDK 自动采集项与网关自动提取 IP 说明

在游戏项目中，**Unity 客户端 SDK** 运行在玩家终端设备上并直连采集网关，其字段传参职责与后端 C# 服务端 SDK 有本质区别：

| 字段 / 属性 | Unity 客户端接入职责 | 详细说明与后端协作机制 |
| :--- | :--- | :--- |
| **`projectId` & `projectToken`** | **【初始化必填】** | 在游戏启动入口调用 `AbiUnityAnalytics.Shared.Initialize(serverUrl, projectId, projectToken, appVersion)` 传入一次即可。 |
| **`eventName`（事件名）** | **【每次 `Track` 必填】** | 自定义事件名需以字母或下划线开头（`^[A-Za-z_][A-Za-z0-9_]*$`，≤ 128 字符）；`UserSet` 等画像方法由 SDK 自动填充 `$user_set` 等系统事件名。 |
| **玩家身份 (`distinct_id` / `login_id`)** | **【SDK 自动管理，仅登录时调 `Login`】** | SDK 启动时自动生成设备级访客标识 `distinct_id` 并持久化至 `PlayerPrefs`，平时调用 `Track` **无需手传身份 ID**；仅需在玩家登录/选角成功时调用一次 `Login(roleOrAccountId)`（纯本地设置 `login_id`，不改写 `distinct_id`，不发网络请求），退登时调用 `Logout()`。 |
| **设备环境预置属性 (`$os` / `$device_model` / `$screen_width` 等)** | **【SDK 自动采集注入】** | SDK 自动从 `UnityEngine.SystemInfo`、`Screen`、`Application` 提取 `$os`、`$os_version`、`$device_model`、`$screen_width`、`$screen_height`、`$app_version`、`$platform`（`"Unity"`）、`$lib`（`"abi-unity-sdk"`），并自动在 `$user_*` 画像事件中剥离。 |
| **玩家公网 IP 与地域 (`#ip` / `$ip`)** | **【客户端无需传，由网关自动提取】** | 玩家手机/PC 处于家庭路由器或移动基站 NAT 之后，客户端本地只能看到局域网 IP（如 `192.168.x.x`）。**Unity 客户端无需传入 `#ip`**——当客户端向 `:8081` 采集网关发起 HTTP 请求时，网关会自动从 TCP 连接或负载均衡 `X-Forwarded-For` 头提取玩家真实公网 IP，交由 Flink Job1 解析国家、省份与城市。 |
| **事件时间 (`timestamp` / `#time`)** | **【默认免填】** | 实时触发时 SDK 自动取当前 UTC 毫秒时间戳；仅补报离线缓存事件时可通过 `properties["#time"]` 或 `timestamp` 参数传入历史时间（提取后自动从 `properties` 移除）。 |
| **幂等主键 (`event_id`)** | **【默认免填】** | SDK 自动生成 UUIDv4，在弱网重连重试时保持原 `event_id` 不变；需要确定性去重时可使用 `Track` 显式传入目标 `eventId`（注：`TrackFirst`、`TrackUpdate`、`TrackOverwrite` 在当前版本未开放，详见 RESTFUL_API.md §3.3 D7① / G6 gate）。 |

### 客户端与游戏服（C# / Go / Java 服务端 SDK）充值归因协同最佳实践

当「玩家在 Unity 客户端内浏览礼包 → 游戏服务端接收苹果/Google/微信支付回调并由服务端 SDK 上报 `OrderPaid`」时，为了让服务端充值事件与客户端前置行为归因到同一设备会话并保留玩家真实地域：
1. Unity 客户端在请求游戏服创建订单接口时，从 `AbiUnityAnalytics.Shared.DistinctId` 读取当前设备访客标识 `distinct_id`，放入 HTTP 请求头（如 `X-ABI-Distinct-Id`）或创单协议包中传给游戏服；
2. 游戏服务端在支付回调中使用服务端 SDK 上报 `OrderPaid` 时，同时传入玩家的账号 ID（`login_id`）、客户端透传的访客 ID（`distinct_id`）以及客户端连接时的真实公网 `"#ip"`。

---

## 5. 常规游戏业务埋点代码示例

```csharp
using System.Collections.Generic;
using Abi.GameEngines.Unity;

public static class GameAnalyticsExample
{
    public static void RunGameplayFlow()
    {
        var sdk = AbiUnityAnalytics.Shared;

        // 1. 游戏启动初始化（生产环境 autoFlush 设为 true）
        sdk.Initialize(
            serverUrl: "https://collect.game-example.com",
            projectId: 101,
            projectToken: "abi_tok_prod_unity",
            appVersion: "2.4.0",
            batchSize: 20,
            autoFlush: true
        );

        // 2. 注册包体与区服静态公共属性 + 实时场景动态公共属性
        sdk.SetSuperProperties(new Dictionary<string, object?>
        {
            ["channel"] = "AppStore_Global",
            ["server_zone"] = "S101_Avalon"
        });
        sdk.SetDynamicSuperProperties(() => new Dictionary<string, object?>
        {
            ["current_map"] = "WorldBoss_Arena",
            ["fps"] = 60
        });

        // 3. 玩家登录角色（纯本地持久化 login_id，保留设备 distinct_id 不变，后续事件自动同时携带两者）
        sdk.Login("role_10086");

        // 4. 开启副本计时 -> 通关上报（自动计算并附加秒级 $duration）
        sdk.TimeEvent("DungeonCleared");
        sdk.Track("DungeonCleared", new Dictionary<string, object?>
        {
            ["dungeon_id"] = "dng_abyss_04",
            ["battle_snowflake_id"] = 9007199254740999L, // > 2^53-1 自动转为字符串 "9007199254740999"
            ["stars"] = 3
        });

        // 5. 更新玩家画像（自动隔离静态/动态公共属性与设备环境属性）
        sdk.UserSet(new Dictionary<string, object?>
        {
            ["role_level"] = 45,
            ["vip_tier"] = "Gold"
        });
        sdk.UserAdd(new Dictionary<string, object?>
        {
            ["gold_coins"] = 5000
        });

        // 6. 切后台或关键节点主动刷新上报
        sdk.Flush();
    }
}
```
