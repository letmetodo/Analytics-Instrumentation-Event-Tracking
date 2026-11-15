# ABI C# (.NET) Server SDK Guide & Examples (`Abi.Sdk`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`Abi.Sdk` is the official **C# / .NET Server-Side Data Collection SDK** for the ABI User Behavior Analytics (UBA) & BI Platform (semantically aligned with ThinkingData C# Server SDK v3.4). It is engineered for high-concurrency ASP.NET Core microservices, payment/settlement backends, async MQ (Kafka / RabbitMQ) consumers, and batch ETL jobs.

---

## 1. Key Features

- **Zero Third-Party NuGet Dependencies**: Built strictly on the .NET standard library (`System.Text.Json`, `System.Net.Http`, `System.IO.Compression`), working out of the box in air-gapped or private enterprise environments.
- **Four Pluggable `IConsumer` Transports**:
  - `StagingConsumer` (Two-Step Preview & Confirm Submit): Stages events in memory without initiating automatic network requests. Call `PreviewRequestJson(...)` to inspect the single formatted `POST /collect/api/v1/track/batch` request JSON, then call `ConfirmSubmit(targetConsumer)` or `SubmitToGateway(config)` to send.
  - `BatchConsumer` (Recommended for Production): Thread-safe bounded memory queue with background periodic flushing, `Content-Encoding: gzip` compression, and exponential backoff retries on network errors, HTTP `429`, or `5xx` while keeping `event_id` unchanged for end-to-end idempotency.
  - `DebugConsumer` (Local Debugging & CI Gate): Synchronously validates each event against the gateway's L4 strict schema validator; supports `dryRun: true` to validate without writing to Kafka or StarRocks.
  - `LoggerConsumer` (High-Throughput Local Disk Logging): Appends events to UTC daily rotating `<prefix>.YYYY-MM-DD.jsonl` files for sidecar shippers (Filebeat / Vector / LogBus), completely decoupling core transaction threads from network I/O.
- **ThinkingData-Aligned Dual-ID Mapping**: Wire payloads use strictly two identity fields — `distinct_id` (visitor/device ID, ≤ 64 UTF-8 bytes) and `login_id` (authenticated account ID, ≤ 128 UTF-8 bytes), requiring at least one non-empty without copying `login_id` into `distinct_id`. Whenever any `Track*` or `User*` event carries both `accountId` (`login_id`) and `distinctId` (`distinct_id`), Flink automatically binds them in StarRocks `identity_map`.
- **Mutable Event Lifecycle**: Supports deterministic `event_id` tracking (`TrackWithId` / `TrackWithOptions`). Note: `TrackFirst`, `TrackUpdate`, and `TrackOverwrite` are unsupported in the current version (see RESTFUL_API.md §3.3 D7① / G6 gate); please use `TrackWithId` with a deterministic business key directly.
- **7 User Profile Operations (`$user_*`) with Super-Property Isolation**: Provides `UserSet`, `UserSetOnce`, `UserAdd`, `UserUnset`, `UserAppend`, `UserUniqAppend`, and `UserDelete`, automatically excluding static and dynamic super properties so server metadata never pollutes the `dim_users` table.
- **Large Integer (`> 2^53 - 1`) Precision Protection & `#time` Extraction**:
  - Automatically serializes 64-bit `long` / `ulong` values exceeding IEEE-754 safe integer limits (`9007199254740991`, such as Snowflake order IDs) as decimal strings.
  - Automatically extracts `#time` or `$time` from `properties` as the top-level millisecond `timestamp` and strips `#time`/`$time` from `properties`.

---

## 2. Requirements & Self-Test Verification

- **.NET SDK**: .NET 7.0 or later (`TargetFramework: net7.0`)
- **External Dependencies**: None

### 2.1 Run Golden Test Vectors & Unit Self-Tests (`--test`)

`Program.cs` includes a built-in test runner that loads and verifies all shared cross-language golden test vectors in [`../spec/test-vectors/identity_cases.json`](../spec/test-vectors/identity_cases.json) and [`../spec/test-vectors/event_and_property_cases.json`](../spec/test-vectors/event_and_property_cases.json):

```bash
/usr/local/share/dotnet/dotnet run --project abi.sdk/csharp -- --test
```

---

## 3. Two-Step Interactive Demo (1. Preview Single Request JSON → 2. Confirm Submit)

The built-in CLI demo follows a clean **two-step workflow**:
1. **Step 1 (Configure & Preview Request JSON)**: Prints a **single pretty-printed `POST /collect/api/v1/track/batch` request JSON preview** with zero network side effects.
2. **Step 2 (Confirm & Submit)**: Prompts for confirmation in interactive terminals (or auto-confirms when `--yes` is passed), sends the batch, and prints the **single formatted gateway response JSON**.

```bash
# Interactive mode: preview request JSON, then press 'y' to confirm submission
/usr/local/share/dotnet/dotnet run --project abi.sdk/csharp

# Non-interactive mode: preview single request JSON and auto-confirm submission
/usr/local/share/dotnet/dotnet run --project abi.sdk/csharp -- --yes

# Connect to a live :8081 gateway with dry-run enabled
/usr/local/share/dotnet/dotnet run --project abi.sdk/csharp -- \
  --server-url http://127.0.0.1:8081 \
  --project-id 1 \
  --token abi_tok_demo_secret \
  --scenario all \
  --dry-run \
  --yes
```

---

## 4. Server Integration Guide: `#ip`, Per-Call Identity, Async `#time`, and Idempotent `event_id`

Unlike client SDKs (Unity / Web / Mobile) that run on a single player's device, the C# Server SDK runs as a **stateless shared singleton** inside your backend data center. Engineers integrating the Server SDK must pay attention to four critical fields:

| Field / Concept | Why Server-Side Must Explicitly Provide It | C# Server SDK Best Practice |
| :--- | :--- | :--- |
| **1. Client Public IP (`#ip` / `$ip`)**<br/>*(GeoIP Country / Province / City)* | When your backend calls the `:8081` gateway, the TCP connection IP seen by the gateway is your **backend server / Kubernetes pod IP**. Without `#ip`, all server events will resolve to your data center's location. | Extract the end-user's real IP from `HttpContext` (`X-Forwarded-For` first public IP or `X-Real-IP`) and pass it in `properties["#ip"]`. Flink ETL prioritizes `#ip > $ip > connection IP` for GeoIP lookup and strips `#ip` automatically. |
| **2. User Identity (`accountId` / `distinctId`)**<br/>*(Required on Every Call)* | A backend service handles requests for thousands of concurrent users and holds no per-device local session state. | Explicitly pass the user's `accountId` (`login_id`, ≤ 128 UTF-8 bytes) and/or the client-forwarded `distinctId` (`distinct_id`, ≤ 64 UTF-8 bytes from header `X-ABI-Distinct-Id`) on every `Track*` and `User*` call (at least one must be non-empty). |
| **3. Business Event Time (`#time` / `Timestamp`)**<br/>*(Required for Async MQ & Backfills)* | Real-time API handlers can default to `DateTimeOffset.UtcNow`, but **Kafka/RabbitMQ consumers, payment webhooks, and historical backfills** process events after they occurred. | Pass the actual business occurrence time via `properties["#time"]` or `TrackOptions.Timestamp`. The SDK converts it to top-level epoch milliseconds and removes `#time` from `properties`. |
| **4. Deterministic `event_id`**<br/>*(Recommended for Core Transactions)* | MQ consumers and webhooks use at-least-once delivery. Random UUIDs on retries would duplicate revenue and order counts. | Use `TrackWithId` or `TrackWithOptions` with a deterministic business key such as `"ord_paid_" + orderNo` (≤ 64 UTF-8 bytes) for same-day retry idempotency (*Note: `TrackFirst` / `TrackUpdate` / `TrackOverwrite` are unsupported in current version and throw `NotSupportedException`*). |

---

## 5. ASP.NET Core Production Integration Example

### 5.1 Singleton Registration & Graceful Shutdown

```csharp
using Abi.Sdk;

var builder = WebApplication.CreateBuilder(args);

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
        CompressGzip = true
    };

    var sdk = new AbiAnalytics(new BatchConsumer(batchConfig));
    sdk.SetSuperProperties(new Dictionary<string, object?>
    {
        ["$platform"] = "CSharpServer",
        ["service_name"] = "order-service",
        ["deploy_env"] = builder.Environment.EnvironmentName
    });
    return sdk;
});
```

### 5.2 Extracting `#ip`, Forwarding `X-ABI-Distinct-Id`, and Tracking Orders

```csharp
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
        ["order_id"] = 9007199254740999L, // > 2^53-1 automatically converted to "9007199254740999"
        ["order_no"] = orderNo,
        ["pay_amount"] = 299.00
    }
});
```
