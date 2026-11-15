# ABI C# (.NET) 服务端 SDK 使用与示例指南 (`Abi.Sdk`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`Abi.Sdk` 是 ABI 用户行为分析（UBA）与商业智能（BI）平台的官方 **C# / .NET 服务端数据采集 SDK**（语义兼容数数科技 ThinkingData C# Server SDK v3.4），专为 ASP.NET Core 微服务、交易结算后端、异步消息队列（Kafka / RabbitMQ）消费者与批处理作业设计。

---

## 1. 核心特性

- **零第三方 NuGet 依赖**：仅基于 .NET 标准库（`System.Text.Json`、`System.Net.Http`、`System.IO.Compression`）构建，离线或内网私有化环境开箱即用。
- **四大消费者（`IConsumer`）通道**：
  - `StagingConsumer`（两步式预览与确认提交 / 本地自检推荐）：在内存中暂存待提交事件而不自动触发网络请求；支持先调用 `PreviewRequestJson(...)` 查看带缩进格式化的唯一一份 `POST /collect/api/v1/track/batch` 请求 JSON，核对无误后再调用 `ConfirmSubmit(targetConsumer)` 或 `SubmitToGateway(config)` 一次性发送。
  - `BatchConsumer`（生产环境推荐）：基于线程安全内存有界队列 + 后台定时线程的异步批量 HTTP 上报，支持 `Content-Encoding: gzip` 压缩以及网络抖动 / HTTP `429` / `5xx` 指数退避重试（重试过程严格保持 `event_id` 幂等不变）。
  - `DebugConsumer`（联调 / CI 自动化门禁）：同步发送单条事件并开启网关 L4 严格 Schema 校验；支持 `dryRun: true` 零污染预检（仅校验不写入 Kafka 与 StarRocks）。
  - `LoggerConsumer`（高吞吐离线落盘）：按 UTC 自然日自动切分写入本地 `<prefix>.YYYY-MM-DD.jsonl` 文件，配合 Filebeat / Vector / LogBus 旁路采集，彻底解耦核心交易链路与外部网络 I/O。
- **全链路双 ID 自动身份贯通（对标数数科技 ThinkingData）**：协议层仅包含访客/设备标识 `distinct_id`（≤ 64 UTF-8 字节）与实名账号标识 `login_id`（≤ 128 UTF-8 字节），两者至少一个非空（绝不把 `login_id` 拷贝回填至 `distinct_id`）；任一 `Track*` 或 `User*` 事件同时携带非空 `accountId`（`login_id`）与 `distinctId`（`distinct_id`）时，下游 Flink 自动将其关联至 StarRocks `identity_map`。
- **可变事件生命周期管理**：支持指定确定性 `event_id` 幂等上报（`TrackWithId` / `TrackWithOptions`）。注：首次事件（`TrackFirst`）、局部属性更新（`TrackUpdate`）与整行覆盖重写（`TrackOverwrite`）在当前版本未开放（详见 RESTFUL_API.md §3.3 D7① / G6 gate），建议直接使用 `TrackWithId` 携带确定性业务主键。
- **7 类用户画像（User Profile）操作与环境隔离**：内置 `UserSet`、`UserSetOnce`、`UserAdd`、`UserUnset`、`UserAppend`、`UserUniqAppend`、`UserDelete` 共 7 种画像原语，并自动隔离静态/动态公共属性（Super Properties），防止服务端环境元数据污染 StarRocks `dim_users` 用户画像宽表。
- **大整数精度保护与 `#time` 自动提取**：
  - **64 位雪花 ID 防精度截断**：绝对值超过 IEEE-754 安全整数上限（`> 2^53 - 1`，即 `9007199254740991`）的 `long` / `ulong` 属性值（包括数组元素）自动序列化为十进制字符串。
  - **`#time` / `$time` 自动提取**：自动将 `properties["#time"]` 或 `properties["$time"]`（支持 `DateTimeOffset`、`DateTime`、秒/毫秒时间戳、ISO-8601 字符串）提取为顶层毫秒 `timestamp`，并从 `properties` 中自动剥离。

---

## 2. 环境要求与自检验证

- **.NET SDK 版本**：.NET 7.0 及以上（`TargetFramework: net7.0`）
- **外部依赖**：无（零第三方 NuGet 包）

### 2.1 运行黄金测试向量与单元测试自检 (`--test`)

`Program.cs` 内置了完整的测试运行器，自动加载并校验 [`../spec/test-vectors/identity_cases.json`](../spec/test-vectors/identity_cases.json) 与 [`../spec/test-vectors/event_and_property_cases.json`](../spec/test-vectors/event_and_property_cases.json) 全部跨语言黄金测试向量：

```bash
/usr/local/share/dotnet/dotnet run --project abi.sdk/csharp -- --test
```

---

## 3. 两步式运行 Demo（1. 预览单份请求 JSON → 2. 确认提交）

SDK 内置 CLI 演示程序采用清爽的**两步式交互工作流**（告别刷屏式冗余日志）：
1. **第 1 步（配置参数并预览请求 JSON）**：根据指定的业务场景与公共属性配置，在终端输出**唯一一份格式化后的 `POST /collect/api/v1/track/batch` 待提交请求 JSON 预览**，此阶段不产生任何网络请求；
2. **第 2 步（确认提交）**：在交互式终端提示确认，输入 `y`（或传入 `--yes`）后发送报文，并输出**唯一一份网关响应 JSON**。

### 3.1 本地零依赖快速演练（自动启动内置 Mock 网关）

```bash
# 交互式预览请求 JSON 后按 y 确认提交
/usr/local/share/dotnet/dotnet run --project abi.sdk/csharp

# 非交互模式：预览单份请求 JSON 后自动确认提交
/usr/local/share/dotnet/dotnet run --project abi.sdk/csharp -- --yes
```

### 3.2 连接真实 `:8081` 采集网关并指定场景

```bash
/usr/local/share/dotnet/dotnet run --project abi.sdk/csharp -- \
  --server-url http://127.0.0.1:8081 \
  --project-id 1 \
  --token abi_tok_demo_secret \
  --scenario all \
  --dry-run \
  --yes
```

支持的命令行参数：

| 参数 | 环境变量 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `--server-url` | `ABI_SERVER_URL` | 空（确认时启动内置 Mock 网关） | ABI 采集网关地址（如 `http://127.0.0.1:8081`） |
| `--project-id` | `ABI_PROJECT_ID` | `1` | ABI 项目数字 ID（必须 `> 0`） |
| `--token` / `--project-token` | `ABI_PROJECT_TOKEN` | `abi_tok_demo_csharp` | 项目采集鉴权 Token |
| `--scenario` | `ABI_SCENARIO` | `order` | 演示场景：`browse` \| `identity` \| `order` \| `profile` \| `all` |
| `--super-props` | `ABI_SUPER_PROPS` | 内置静态公共属性 JSON | 自定义静态公共属性 JSON 对象字符串 |
| `--dynamic-super` | — | `true` | 是否注册动态公共属性（`server_region`、`dotnet_version`） |
| `--dry-run` | — | `false` | 是否开启网关 `dry_run: true`（仅校验不落库） |
| `--yes` / `-y` | — | `false` | 跳过终端确认提示，预览后直接提交 |
| `--test` | — | `false` | 运行黄金测试向量与全量单元测试自检 |

---

## 4. 服务端接入人员必读：#ip 提取、每次必传身份、异步 #time 与幂等 event_id

在生产架构中，**C# 服务端 SDK** 与 **客户端 SDK（Unity / Web / iOS / Android）** 的网络位置和生命周期截然不同。接入人员请重点核对以下 4 项职责边界：

| 关键要素 | 为什么服务端必须显式处理？ | C# 服务端 SDK 推荐做法 |
| :--- | :--- | :--- |
| **1. 客户端真实公网 IP (`#ip` / `$ip`)**<br/>*(决定国家/省份/城市地域维度)* | 服务端向 `:8081` 网关发起请求时，网关 TCP 连接看到的是**后端机房/K8s 容器内网或 NAT 出口 IP**（`LoggerConsumer` 落盘更无连接 IP）。若不传 `#ip`，所有服务端事件的地域都会变成机房所在地！ | 从 ASP.NET Core `HttpContext`（`X-Forwarded-For` 首跳公网 IP 或 `RemoteIpAddress`）提取真实用户 IP，显式传入 `properties["#ip"]`。Flink Job1 会按 `properties["#ip"] > properties["$ip"] > 网关连接 IP` 优先级解析省市并自动剥离 `#ip`。 |
| **2. 用户身份 (`accountId` / `distinctId`)**<br/>*(每次调用必填)* | 服务端 `AbiAnalytics` 是**被所有并发请求共享的无状态单例**，不存在单设备本地持久化的“当前登录用户”。 | 每次调用 `Track*` / `User*` 必须显式传入当前用户的 `accountId`（`login_id`，≤ 128 UTF-8 字节）与/或前端请求头 `X-ABI-Distinct-Id` 透传的访客 ID `distinctId`（`distinct_id`，≤ 64 UTF-8 字节），两者至少非空其一（纯后端任务仅传 `accountId` 时 `distinctId` 传 `""` 即可）。 |
| **3. 实际业务发生时间 (`#time` / `Timestamp`)**<br/>*(异步 MQ / 回调 / 补数必传)* | 实时 HTTP 接口可默认取服务器当前时间；但在 **Kafka/RabbitMQ 异步延迟消费、支付网关异步回调、历史数据回填** 场景下，消费时刻晚于实际业务发生时刻。 | 在 `properties["#time"]`（或 `TrackOptions.Timestamp`）中传入实际业务发生时的 `DateTimeOffset` / 毫秒时间戳（SDK 会自动提取为顶层 `timestamp` 并从 `properties` 移除）。 |
| **4. 确定性幂等主键 (`event_id`)**<br/>*(核心交易与 MQ 重试必传)* | 消息队列存在 At-Least-Once 重试投递，若每次重试都生成随机 UUID，会导致下游交易笔数与金额重复统计。 | 核心订单/支付事件使用 `TrackWithId` 或 `TrackWithOptions` 显式传入确定性业务主键（如 `"ord_paid_" + orderNo`，≤ 64 UTF-8 字节）保障同日幂等（注：`TrackFirst` / `TrackUpdate` / `TrackOverwrite` 当前版本未开放，调用将抛出 `NotSupportedException`）。 |

---

## 5. ASP.NET Core 生产环境集成最佳实践

### 5.1 注册全局单例与优雅停机 (`Program.cs`)

`AbiAnalytics` 与 `BatchConsumer` 均为线程安全设计，切勿在每次 HTTP 请求中 `new` 实例。推荐在 ASP.NET Core DI 容器中注册为 `Singleton`，容器销毁时会自动调用 `Dispose()` 排空并上报内存队列中的剩余事件：

```csharp
using Abi.Sdk;

var builder = WebApplication.CreateBuilder(args);

// 1. 注册 ABI 采集客户端为全局 Singleton（应用退出时 DI 自动调用 Dispose -> Flush）
builder.Services.AddSingleton<AbiAnalytics>(_ =>
{
    var batchConfig = new BatchConsumer.Config(
        serverUrl: builder.Configuration["Abi:ServerUrl"] ?? "http://127.0.0.1:8081",
        projectId: builder.Configuration.GetValue<long>("Abi:ProjectId", 1),
        projectToken: builder.Configuration["Abi:ProjectToken"] ?? "abi_prod_token"
    )
    {
        BatchSize = 100,
        FlushIntervalMs = 2000,
        MaxQueueSize = 20000,
        MaxRetries = 3,
        CompressGzip = true
    };

    var sdk = new AbiAnalytics(new BatchConsumer(batchConfig));
    // 注册服务级静态公共属性（仅注入行为事件，不会污染 $user_* 画像事件；切勿放入单用户 IP）
    sdk.SetSuperProperties(new Dictionary<string, object?>
    {
        ["$platform"] = "CSharpServer",
        ["service_name"] = "order-service",
        ["deploy_env"] = builder.Environment.EnvironmentName
    });
    return sdk;
});

var app = builder.Build();
app.Run();
```

### 5.2 提取客户端真实 `#ip`、透传 `distinct_id` 与幂等埋点示例

```csharp
using Abi.Sdk;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Shop.Server.Controllers;

[ApiController]
[Route("api/orders")]
public class OrderController : ControllerBase
{
    private readonly AbiAnalytics _abi;
    private readonly ILogger<OrderController> _logger;

    public OrderController(AbiAnalytics abi, ILogger<OrderController> logger)
    {
        _abi = abi;
        _logger = logger;
    }

    [HttpPost("pay-callback")]
    public IActionResult OnOrderPaid(
        [FromBody] OrderPaidCallbackDto dto,
        [FromHeader(Name = "X-ABI-Distinct-Id")] string? clientDistinctId)
    {
        try
        {
            string clientIp = ExtractClientPublicIp(HttpContext);
            string deterministicEventId = $"ord_paid_{dto.OrderNo}";

            // 1. 上报订单支付成功事件（携带客户端真实 #ip、实际支付时间 #time、雪花长整型订单号）
            _abi.TrackWithOptions(new TrackOptions
            {
                EventId = deterministicEventId,
                EventName = "OrderPaid",
                AccountId = dto.UserId,              // 实名账号 ID (login_id)
                DistinctId = clientDistinctId,       // 客户端透传的访客/设备 ID (distinct_id)
                Timestamp = dto.PaidAtUtc,           // 实际业务发生时间
                Properties = new Dictionary<string, object?>
                {
                    ["#ip"] = clientIp,              // 必传客户端真实公网 IP，供 Flink 解析省市
                    ["order_id"] = dto.SnowflakeOrderId, // > 2^53-1 自动转字符串，防精度丢失
                    ["order_no"] = dto.OrderNo,
                    ["pay_amount"] = dto.PayAmount,
                    ["payment_channel"] = dto.Channel
                }
            });

            // 2. 原子累加用户累计消费金额（$user_add 自动隔离服务级公共属性）
            _abi.UserAdd(dto.UserId, clientDistinctId, new Dictionary<string, object?>
            {
                ["total_paid_amount"] = dto.PayAmount,
                ["total_order_count"] = 1
            });
        }
        catch (Exception ex)
        {
            // 埋点异常仅记录告警，绝不阻断核心支付回调主事务
            _logger.LogWarning(ex, "ABI 订单支付埋点上报异常, orderNo={OrderNo}", dto.OrderNo);
        }

        return Ok(new { status = "ok" });
    }

    /// <summary>
    /// 从反向代理头（X-Forwarded-For / X-Real-IP）或 TCP 连接中提取客户端真实公网 IP。
    /// </summary>
    private static string ExtractClientPublicIp(HttpContext ctx)
    {
        if (ctx.Request.Headers.TryGetValue("X-Forwarded-For", out var xff) && ! string.IsNullOrWhiteSpace(xff))
        {
            string firstIp = xff.ToString().Split(',')[0].Trim();
            if (!string.IsNullOrEmpty(firstIp)) return firstIp;
        }
        if (ctx.Request.Headers.TryGetValue("X-Real-IP", out var realIp) && !string.IsNullOrWhiteSpace(realIp))
        {
            return realIp.ToString().Trim();
        }
        return ctx.Connection.RemoteIpAddress?.ToString() ?? string.Empty;
    }
}

public record OrderPaidCallbackDto(
    string UserId,
    string OrderNo,
    long SnowflakeOrderId,
    double PayAmount,
    string Channel,
    DateTimeOffset PaidAtUtc);
```
