using System.Diagnostics;
using System.Globalization;
using System.IO.Compression;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Text.Json;

namespace Abi.Sdk;

/// <summary>
/// ABI C# (.NET) 服务端 SDK 命令行入口：
/// <list type="bullet">
///   <item><description>传入 <c>--test</c>：执行跨语言黄金测试向量（<c>spec/test-vectors/*.json</c>）与全量 SDK 单元测试自检；</description></item>
///   <item><description>默认或传入 <c>--yes</c>：运行「1. 预览单份请求 JSON -&gt; 2. 确认提交并打印网关响应 JSON」两步式交互演练 Demo。</description></item>
/// </list>
/// </summary>
public static class Program
{
    private const string DefaultSuperPropsJson =
        "{\"$app_version\":\"2.5.0\",\"$platform\":\"CSharpServer\",\"service_name\":\"order-service\"}";

    /// <summary>
    /// 两步式演示（配置预览 -&gt; 确认提交）运行参数。
    /// </summary>
    public sealed class DemoConfig
    {
        public string ServerUrl { get; set; } = Environment.GetEnvironmentVariable("ABI_SERVER_URL") ?? string.Empty;
        public long ProjectId { get; set; } = ParseEnvLong("ABI_PROJECT_ID", 1L);
        public string ProjectToken { get; set; } = Environment.GetEnvironmentVariable("ABI_PROJECT_TOKEN") ?? "abi_tok_demo_csharp";
        public string Scenario { get; set; } = Environment.GetEnvironmentVariable("ABI_SCENARIO") ?? "order";
        public string SuperPropsJson { get; set; } = Environment.GetEnvironmentVariable("ABI_SUPER_PROPS") ?? DefaultSuperPropsJson;
        public bool EnableDynamicSuper { get; set; } = true;
        public bool DryRun { get; set; }
        public bool CompressGzip { get; set; } = true;
        public bool AutoConfirm { get; set; }
    }

    public static int Main(string[] args)
    {
        Console.OutputEncoding = Encoding.UTF8;

        if (args.Any(a => string.Equals(a, "--test", StringComparison.OrdinalIgnoreCase)))
        {
            return SelfTestRunner.RunAllTests();
        }

        DemoConfig cfg;
        try
        {
            cfg = ParseArgs(args);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[错误] 参数解析失败: {ex.Message}");
            return 1;
        }

        // 第 1 步：配置参数并生成唯一一份待提交请求 JSON 预览（零网络请求）
        StagingConsumer staging;
        string previewJson;
        try
        {
            (previewJson, staging) = BuildDemoRequestPreview(cfg);
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[错误] 生成请求 JSON 预览失败: {ex.Message}");
            return 1;
        }

        Console.WriteLine("=== 待提交请求 JSON 预览 (POST /collect/api/v1/track/batch) ===");
        Console.WriteLine(previewJson);

        // 第 2 步：交互终端且未传 --yes 时等待开发者确认；传了 --yes 或非交互重定向时自动确认提交
        if (!cfg.AutoConfirm && !Console.IsInputRedirected)
        {
            Console.Write("\n是否确认提交上述请求参数？输入 y 回车确认提交，其他键取消: ");
            string? input = Console.ReadLine();
            if (!string.Equals(input?.Trim(), "y", StringComparison.OrdinalIgnoreCase))
            {
                staging.Clear();
                Console.WriteLine("已取消提交，未向采集网关发送任何请求。");
                return 0;
            }
        }

        try
        {
            var (_, respJson) = ConfirmSubmitDemo(staging, cfg);
            Console.WriteLine("\n=== 提交响应结果 (Response JSON) ===");
            Console.WriteLine(respJson);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[错误] 提交请求至采集网关失败: {ex.Message}");
            return 1;
        }
    }

    /// <summary>
    /// 第 1 步：根据配置参数初始化 <see cref="StagingConsumer"/> 与 <see cref="AbiAnalytics"/>，
    /// 执行所选埋点场景，并返回格式化后的 <c>POST /collect/api/v1/track/batch</c> 请求 JSON 字符串。
    /// </summary>
    public static (string PreviewJson, StagingConsumer Staging) BuildDemoRequestPreview(DemoConfig cfg)
    {
        if (cfg.ProjectId <= 0)
        {
            throw new ArgumentException($"project-id 必须大于 0（当前值: {cfg.ProjectId}）");
        }
        if (string.IsNullOrWhiteSpace(cfg.ProjectToken))
        {
            throw new ArgumentException("token 不能为空");
        }

        var staging = new StagingConsumer(cfg.ProjectId, cfg.ProjectToken.Trim(), cfg.DryRun);
        using var sdk = new AbiAnalytics(staging);

        if (!string.IsNullOrWhiteSpace(cfg.SuperPropsJson))
        {
            var staticProps = ParseJsonObjectToDictionary(cfg.SuperPropsJson);
            if (staticProps.Count > 0)
            {
                sdk.SetSuperProperties(staticProps);
            }
        }

        if (cfg.EnableDynamicSuper)
        {
            sdk.SetDynamicSuperProperties(() => new Dictionary<string, object?>
            {
                ["server_region"] = "ap-shanghai",
                ["dotnet_version"] = Environment.Version.ToString()
            });
        }

        string mode = string.IsNullOrWhiteSpace(cfg.Scenario) ? "order" : cfg.Scenario.Trim().ToLowerInvariant();
        switch (mode)
        {
            case "browse":
                TriggerAnonymousBrowseDemo(sdk);
                break;
            case "identity":
                TriggerLoginIdentityBindDemo(sdk);
                break;
            case "order":
                TriggerOrderLifecycleDemo(sdk);
                break;
            case "profile":
                TriggerUserProfileDemo(sdk);
                break;
            case "all":
                TriggerAnonymousBrowseDemo(sdk);
                TriggerLoginIdentityBindDemo(sdk);
                TriggerOrderLifecycleDemo(sdk);
                TriggerUserProfileDemo(sdk);
                break;
            default:
                throw new ArgumentException(
                    $"未知的 --scenario 参数值 \"{mode}\"（可选值：browse | identity | order | profile | all）");
        }

        string previewJson = staging.PreviewRequestJson(cfg.ProjectId, cfg.ProjectToken, cfg.DryRun);
        return (previewJson, staging);
    }

    /// <summary>
    /// 第 2 步：在确认请求 JSON 无误后，将 <see cref="StagingConsumer"/> 中暂存的报文提交至 ABI 采集网关
    /// （若 <c>cfg.ServerUrl</c> 为空则自动启动本地临时 Mock 网关接收），并返回响应结构与格式化后的 Response JSON。
    /// </summary>
    public static (GatewayEnvelope? Envelope, string ResponseJson) ConfirmSubmitDemo(
        StagingConsumer staging,
        DemoConfig cfg)
    {
        if (staging is null) throw new ArgumentNullException(nameof(staging));

        string targetUrl = (cfg.ServerUrl ?? string.Empty).Trim();
        IDisposable? mockServer = null;
        if (string.IsNullOrEmpty(targetUrl))
        {
            (targetUrl, mockServer) = StartEmbeddedMockGateway();
        }

        try
        {
            var batchCfg = new BatchConsumer.Config(targetUrl, cfg.ProjectId, cfg.ProjectToken)
            {
                CompressGzip = cfg.CompressGzip,
                DryRun = cfg.DryRun
            };
            return staging.SubmitToGateway(batchCfg);
        }
        finally
        {
            mockServer?.Dispose();
        }
    }

    /// <summary>构造用户登录前的访客浏览行为事件（<c>$pageview</c>、<c>ProductViewed</c>）。</summary>
    public static void TriggerAnonymousBrowseDemo(AbiAnalytics sdk)
    {
        const string visitorId = "vis_dev_7f8e9a01";

        sdk.Track(null, visitorId, "$pageview", new Dictionary<string, object?>
        {
            ["#ip"] = "203.0.113.42",
            ["$url"] = "https://store.example.com/products/bi-enterprise",
            ["$url_path"] = "/products/bi-enterprise",
            ["$title"] = "ABI Enterprise Edition",
            ["$referrer"] = "https://www.google.com"
        });

        sdk.Track(null, visitorId, "ProductViewed", new Dictionary<string, object?>
        {
            ["#ip"] = "203.0.113.42",
            ["product_id"] = "sku_abi_ent_2026",
            ["product_name"] = "ABI Enterprise Analytics Suite",
            ["category"] = "SaaS",
            ["price"] = 2999.00
        });
    }

    /// <summary>构造用户注册/登录时同时携带 <c>login_id</c> 与 <c>distinct_id</c> 的事件（Flink 自动完成 ID-Mapping 关联）。</summary>
    public static void TriggerLoginIdentityBindDemo(AbiAnalytics sdk)
    {
        const string accountId = "acct_900102";
        const string visitorId = "vis_dev_7f8e9a01";

        sdk.Track(accountId, visitorId, "$signup", new Dictionary<string, object?>
        {
            ["#ip"] = "203.0.113.42",
            ["register_channel"] = "sso_oidc"
        });

        sdk.Track(accountId, visitorId, "$login", new Dictionary<string, object?>
        {
            ["#ip"] = "203.0.113.42",
            ["login_method"] = "sso_oidc",
            ["mfa_verified"] = true
        });
    }

    /// <summary>
    /// 构造订单里程碑事件（使用 <c>TrackWithOptions</c> / <c>TrackWithId</c> 指定确定性 <c>event_id</c> 保障同日重试幂等），
    /// 演示超过 <c>2^53 - 1</c> 的 64 位雪花 ID 自动转为字符串安全序列化。
    /// </summary>
    public static void TriggerOrderLifecycleDemo(AbiAnalytics sdk)
    {
        const string accountId = "acct_900102";
        const string visitorId = "vis_dev_7f8e9a01";
        const long snowflakeOrderId = 9007199254740999L; // > 2^53-1 (9007199254740991)

        sdk.TrackWithOptions(new TrackOptions
        {
            EventId = "ord_created_20261110_8801",
            EventName = "OrderCreated",
            AccountId = accountId,
            DistinctId = visitorId,
            Timestamp = DateTimeOffset.UtcNow,
            Properties = new Dictionary<string, object?>
            {
                ["#ip"] = "203.0.113.42",
                ["order_no"] = "ORD-20261110-8801",
                ["snowflake_id"] = snowflakeOrderId,
                ["order_status"] = "CREATED",
                ["payable_amount"] = 2999.00,
                ["item_sku_list"] = new[] { "sku_abi_ent_2026", "sku_addon_flink" },
                ["sub_task_ids"] = new long[] { 1001L, 9007199254741024L }
            }
        });

        sdk.TrackWithId(accountId, visitorId, "OrderPaid", "ord_paid_20261110_8801", new Dictionary<string, object?>
        {
            ["#ip"] = "203.0.113.42",
            ["order_no"] = "ORD-20261110-8801",
            ["snowflake_id"] = snowflakeOrderId,
            ["order_status"] = "PAID",
            ["payable_amount"] = 2549.15,
            ["coupon_code"] = "FIRST_ORDER_50",
            ["discount_rate"] = 0.85,
            ["payment_channel"] = "stripe_enterprise"
        });

        sdk.TrackWithId(accountId, visitorId, "OrderFulfilled", "ord_fulfilled_20261110_8801", new Dictionary<string, object?>
        {
            ["#ip"] = "203.0.113.42",
            ["order_no"] = "ORD-20261110-8801",
            ["snowflake_id"] = snowflakeOrderId,
            ["order_status"] = "FULFILLED",
            ["payable_amount"] = 2549.15,
            ["invoice_issued"] = true,
            ["fulfilled_at"] = DateTimeOffset.UtcNow
        });
    }

    /// <summary>
    /// 构造全部 7 种用户画像属性变更操作（自动隔离静态/动态公共属性）：
    /// <c>UserSet</c>、<c>UserSetOnce</c>、<c>UserAdd</c>、<c>UserAppend</c>、<c>UserUniqAppend</c>、<c>UserUnset</c> 与 <c>UserDelete</c>。
    /// </summary>
    public static void TriggerUserProfileDemo(AbiAnalytics sdk)
    {
        const string accountId = "acct_900102";
        const string visitorId = "vis_dev_7f8e9a01";

        sdk.UserSet(accountId, visitorId, new Dictionary<string, object?>
        {
            ["company_name"] = "Acme Analytics Corp",
            ["plan_tier"] = "Enterprise",
            ["seat_count"] = 50,
            ["$city"] = "Shanghai"
        });

        sdk.UserSetOnce(accountId, visitorId, new Dictionary<string, object?>
        {
            ["first_utm_source"] = "github_release",
            ["activated_at"] = DateTimeOffset.UtcNow
        });

        sdk.UserAdd(accountId, visitorId, new Dictionary<string, object?>
        {
            ["cumulative_payment"] = 2549.15,
            ["order_count"] = 1
        });

        sdk.UserAppend(accountId, visitorId, new Dictionary<string, object?>
        {
            ["enabled_modules"] = new[] { "event_analysis", "funnel_analysis" }
        });

        sdk.UserUniqAppend(accountId, visitorId, new Dictionary<string, object?>
        {
            ["enabled_modules"] = new[] { "funnel_analysis", "retention_analysis", "sql_ide" }
        });

        sdk.UserUnset(accountId, visitorId, "legacy_trial_tag", "onboarding_banner_dismissed");
        sdk.UserDelete("acct_gdpr_erased_01", "vis_gdpr_erased_01");
    }

    private static DemoConfig ParseArgs(string[] args)
    {
        var cfg = new DemoConfig();
        for (int i = 0; i < args.Length; i++)
        {
            string arg = args[i];
            string? val = null;
            int eqIdx = arg.IndexOf('=');
            if (eqIdx > 0)
            {
                val = arg[(eqIdx + 1)..];
                arg = arg[..eqIdx];
            }

            switch (arg)
            {
                case "--server-url":
                    cfg.ServerUrl = val ?? NextArgValue(args, ref i, arg);
                    break;
                case "--project-id":
                    cfg.ProjectId = long.Parse(val ?? NextArgValue(args, ref i, arg), CultureInfo.InvariantCulture);
                    break;
                case "--token":
                case "--project-token":
                    cfg.ProjectToken = val ?? NextArgValue(args, ref i, arg);
                    break;
                case "--scenario":
                    cfg.Scenario = val ?? NextArgValue(args, ref i, arg);
                    break;
                case "--super-props":
                    cfg.SuperPropsJson = val ?? NextArgValue(args, ref i, arg);
                    break;
                case "--dynamic-super":
                    cfg.EnableDynamicSuper = val is null || bool.Parse(val);
                    break;
                case "--no-dynamic-super":
                    cfg.EnableDynamicSuper = false;
                    break;
                case "--dry-run":
                    cfg.DryRun = val is null || bool.Parse(val);
                    break;
                case "--yes":
                case "-y":
                    cfg.AutoConfirm = val is null || bool.Parse(val);
                    break;
            }
        }
        return cfg;
    }

    private static string NextArgValue(string[] args, ref int index, string flagName)
    {
        if (index + 1 >= args.Length)
        {
            throw new ArgumentException($"参数 {flagName} 缺少对应的值");
        }
        index++;
        return args[index];
    }

    private static long ParseEnvLong(string name, long defaultVal)
    {
        string? raw = Environment.GetEnvironmentVariable(name);
        return long.TryParse(raw, NumberStyles.Integer, CultureInfo.InvariantCulture, out long v) ? v : defaultVal;
    }

    private static Dictionary<string, object?> ParseJsonObjectToDictionary(string json)
    {
        using JsonDocument doc = JsonDocument.Parse(json);
        if (doc.RootElement.ValueKind != JsonValueKind.Object)
        {
            throw new ArgumentException("JSON 顶层必须是对象 (object)");
        }
        var dict = new Dictionary<string, object?>(StringComparer.Ordinal);
        foreach (JsonProperty prop in doc.RootElement.EnumerateObject())
        {
            dict[prop.Name] = prop.Value.Clone();
        }
        return dict;
    }

    internal static (string BaseUrl, IDisposable ServerHandle) StartEmbeddedMockGateway()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        int port = ((IPEndPoint)listener.LocalEndpoint).Port;
        var cts = new CancellationTokenSource();

        _ = Task.Run(async () =>
        {
            int seq = 0;
            while (!cts.IsCancellationRequested)
            {
                TcpClient client;
                try
                {
                    client = await listener.AcceptTcpClientAsync(cts.Token);
                }
                catch
                {
                    break;
                }

                _ = Task.Run(() =>
                {
                    using (client)
                    using (NetworkStream stream = client.GetStream())
                    {
                        var (headers, bodyBytes) = ReadHttpRequest(stream);
                        if (headers.TryGetValue("content-encoding", out string? enc) &&
                            string.Equals(enc.Trim(), "gzip", StringComparison.OrdinalIgnoreCase))
                        {
                            using var inMs = new MemoryStream(bodyBytes);
                            using var gz = new GZipStream(inMs, CompressionMode.Decompress);
                            using var outMs = new MemoryStream();
                            gz.CopyTo(outMs);
                            bodyBytes = outMs.ToArray();
                        }

                        int accepted = 0;
                        bool dryRun = false;
                        try
                        {
                            using JsonDocument doc = JsonDocument.Parse(bodyBytes);
                            if (doc.RootElement.TryGetProperty("events", out JsonElement evs) &&
                                evs.ValueKind == JsonValueKind.Array)
                            {
                                accepted = evs.GetArrayLength();
                            }
                            if (doc.RootElement.TryGetProperty("dry_run", out JsonElement dr) &&
                                dr.ValueKind == JsonValueKind.True)
                            {
                                dryRun = true;
                            }
                        }
                        catch
                        {
                            // Ignore malformed mock body
                        }

                        int curSeq = Interlocked.Increment(ref seq);
                        var respEnvelope = new GatewayEnvelope
                        {
                            Code = 200,
                            Message = "success",
                            RequestId = $"req_mock_{curSeq}",
                            Data = new GatewayBatchResult
                            {
                                Accepted = accepted,
                                Rejected = 0,
                                DryRun = dryRun
                            }
                        };
                        byte[] respJsonBytes = JsonSerializer.SerializeToUtf8Bytes(
                            respEnvelope,
                            AbiJsonSerializer.CompactOptions);
                        string headerText =
                            "HTTP/1.1 200 OK\r\n" +
                            "Content-Type: application/json; charset=utf-8\r\n" +
                            $"Content-Length: {respJsonBytes.Length}\r\n" +
                            "Connection: close\r\n\r\n";
                        byte[] headerBytes = Encoding.ASCII.GetBytes(headerText);
                        stream.Write(headerBytes, 0, headerBytes.Length);
                        stream.Write(respJsonBytes, 0, respJsonBytes.Length);
                        stream.Flush();
                    }
                });
            }
        });

        string baseUrl = $"http://127.0.0.1:{port}";
        return (baseUrl, new ActionDisposable(() =>
        {
            cts.Cancel();
            listener.Stop();
            cts.Dispose();
        }));
    }

    private static (Dictionary<string, string> Headers, byte[] Body) ReadHttpRequest(Stream stream)
    {
        var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        using var headerBuffer = new MemoryStream();
        int matched = 0;
        byte[] pattern = { (byte)'\r', (byte)'\n', (byte)'\r', (byte)'\n' };
        while (true)
        {
            int b = stream.ReadByte();
            if (b < 0) break;
            headerBuffer.WriteByte((byte)b);
            if (b == pattern[matched])
            {
                matched++;
                if (matched == 4) break;
            }
            else
            {
                matched = b == pattern[0] ? 1 : 0;
            }
        }

        string headerStr = Encoding.ASCII.GetString(headerBuffer.ToArray());
        string[] lines = headerStr.Split("\r\n", StringSplitOptions.RemoveEmptyEntries);
        for (int i = 1; i < lines.Length; i++)
        {
            int colon = lines[i].IndexOf(':');
            if (colon > 0)
            {
                headers[lines[i][..colon].Trim()] = lines[i][(colon + 1)..].Trim();
            }
        }

        int contentLength = 0;
        if (headers.TryGetValue("Content-Length", out string? lenStr))
        {
            int.TryParse(lenStr, NumberStyles.Integer, CultureInfo.InvariantCulture, out contentLength);
        }

        byte[] body = new byte[contentLength];
        int offset = 0;
        while (offset < contentLength)
        {
            int read = stream.Read(body, offset, contentLength - offset);
            if (read <= 0) break;
            offset += read;
        }
        return (headers, body);
    }

    private sealed class ActionDisposable : IDisposable
    {
        private readonly Action _onDispose;
        public ActionDisposable(Action onDispose) => _onDispose = onDispose;
        public void Dispose() => _onDispose();
    }
}

/// <summary>
/// 黄金测试向量（<c>spec/test-vectors/*.json</c>）与 SDK 全功能自检测试运行器。
/// </summary>
internal static class SelfTestRunner
{
    public static int RunAllTests()
    {
        var sw = Stopwatch.StartNew();
        Console.WriteLine("=== ABI C# (.NET) SDK 黄金测试向量与单元测试自检 ===");

        try
        {
            string specDir = LocateSpecTestVectorsDirectory();
            TestIdentityGoldenVectors(Path.Combine(specDir, "identity_cases.json"));
            TestEventAndPropertyGoldenVectors(Path.Combine(specDir, "event_and_property_cases.json"));
            TestLargeIntegerPrecisionAndNanRejection();
            TestTimeExtractionAndPriority();
            TestUserProfileOperationsAndSuperPropIsolation();
            TestTrackFirstUpdateOverwriteAndDualIdentity();
            TestStagingAndBatchConsumersEndToEnd();
            TestLoggerConsumerRotation();
            TestUnityClientSdkAndTwoStepDemo();

            sw.Stop();
            Console.WriteLine($"[PASS] 全部测试套件通过！耗时 {sw.ElapsedMilliseconds} ms");
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine($"[FAIL] 测试失败: {ex}");
            return 1;
        }
    }

    private static string LocateSpecTestVectorsDirectory()
    {
        string? dir = AppContext.BaseDirectory;
        for (int i = 0; i < 8 && dir is not null; i++)
        {
            string candidate = Path.Combine(dir, "spec", "test-vectors");
            if (Directory.Exists(candidate))
            {
                return candidate;
            }
            string siblingCandidate = Path.Combine(dir, "abi.sdk", "spec", "test-vectors");
            if (Directory.Exists(siblingCandidate))
            {
                return siblingCandidate;
            }
            dir = Directory.GetParent(dir)?.FullName;
        }

        string cwdCandidate = Path.GetFullPath(Path.Combine(Directory.GetCurrentDirectory(), "..", "spec", "test-vectors"));
        if (Directory.Exists(cwdCandidate))
        {
            return cwdCandidate;
        }
        throw new DirectoryNotFoundException("未找到 spec/test-vectors 黄金测试向量目录");
    }

    private static void TestIdentityGoldenVectors(string filePath)
    {
        using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(filePath, Encoding.UTF8));
        JsonElement root = doc.RootElement;
        AssertEqual(64, root.GetProperty("max_distinct_id_bytes").GetInt32(), "max_distinct_id_bytes");
        AssertEqual(128, root.GetProperty("max_login_id_bytes").GetInt32(), "max_login_id_bytes");

        int count = 0;
        foreach (JsonElement item in root.GetProperty("cases").EnumerateArray())
        {
            count++;
            string name = item.GetProperty("name").GetString()!;
            string distinctId = item.GetProperty("distinct_id").GetString()!;
            string loginId = item.GetProperty("login_id").GetString()!;
            bool expectedValid = item.GetProperty("valid").GetBoolean();

            if (expectedValid)
            {
                var (normDistinct, normLogin) =
                    AbiValidator.NormalizeIdentityPair(distinctId, loginId);
                AssertEqual(item.GetProperty("normalized_distinct_id").GetString()!, normDistinct, $"{name}.distinct_id");
                AssertEqual(item.GetProperty("normalized_login_id").GetString()!, normLogin, $"{name}.login_id");
            }
            else
            {
                bool threw = false;
                try
                {
                    AbiValidator.NormalizeIdentityPair(distinctId, loginId);
                }
                catch (ArgumentException)
                {
                    threw = true;
                }
                AssertTrue(threw, $"期望身份测试向量 {name} 抛出 ArgumentException，但实际通过");
            }
        }
        Console.WriteLine($"  ✓ identity_cases.json ({count} 条向量) 全部校验通过");
    }

    private static void TestEventAndPropertyGoldenVectors(string filePath)
    {
        using JsonDocument doc = JsonDocument.Parse(File.ReadAllText(filePath, Encoding.UTF8));
        JsonElement root = doc.RootElement;
        AssertEqual(AbiValidator.MaxSafeInteger, root.GetProperty("max_safe_integer").GetInt64(), "max_safe_integer");

        int eventCount = 0;
        foreach (JsonElement item in root.GetProperty("event_name_cases").EnumerateArray())
        {
            eventCount++;
            string eventName = item.GetProperty("event_name").GetString()!;
            bool expectedValid = item.GetProperty("valid").GetBoolean();
            if (expectedValid)
            {
                string validated = AbiValidator.ValidateEventName(eventName);
                AssertEqual(eventName, validated, $"event_name:{eventName}");
            }
            else
            {
                bool threw = false;
                try
                {
                    AbiValidator.ValidateEventName(eventName);
                }
                catch (ArgumentException)
                {
                    threw = true;
                }
                AssertTrue(threw, $"期望非法 event_name \"{eventName}\" 被拒绝");
            }
        }

        int propKeyCount = 0;
        foreach (JsonElement item in root.GetProperty("property_key_cases").EnumerateArray())
        {
            propKeyCount++;
            string key = item.GetProperty("key").GetString()!;
            bool expectedValid = item.GetProperty("valid").GetBoolean();
            if (expectedValid)
            {
                string validated = AbiValidator.ValidatePropertyKey(key);
                AssertEqual(key, validated, $"property_key:{key}");
            }
            else
            {
                bool threw = false;
                try
                {
                    AbiValidator.ValidatePropertyKey(key);
                }
                catch (ArgumentException)
                {
                    threw = true;
                }
                AssertTrue(threw, $"期望非法 property_key \"{key}\" 被拒绝");
            }
        }

        Console.WriteLine($"  ✓ event_and_property_cases.json ({eventCount} 条事件名 + {propKeyCount} 条属性名) 全部校验通过");
    }

    private static void TestLargeIntegerPrecisionAndNanRejection()
    {
        var props = AbiValidator.SanitizeProperties(new Dictionary<string, object?>
        {
            ["safe_max"] = 9007199254740991L,
            ["safe_min"] = -9007199254740991L,
            ["snowflake_over"] = 9007199254740993L,
            ["snowflake_under"] = -9007199254740993L,
            ["long_min"] = long.MinValue,
            ["ulong_over"] = 9007199254740999UL,
            ["mixed_list"] = new long[] { 42L, 9007199254740995L },
            ["ignored_null"] = null
        });

        AssertEqual(9007199254740991L, (long)props["safe_max"]!, "safe_max 保持 long");
        AssertEqual(-9007199254740991L, (long)props["safe_min"]!, "safe_min 保持 long");
        AssertEqual("9007199254740993", (string)props["snowflake_over"]!, "snowflake_over 转 string");
        AssertEqual("-9007199254740993", (string)props["snowflake_under"]!, "snowflake_under 转 string");
        AssertEqual(long.MinValue.ToString(CultureInfo.InvariantCulture), (string)props["long_min"]!, "long.MinValue 转 string");
        AssertEqual("9007199254740999", (string)props["ulong_over"]!, "ulong_over 转 string");
        AssertTrue(!props.ContainsKey("ignored_null"), "null 属性值应被忽略");

        var list = (List<object>)props["mixed_list"]!;
        AssertEqual(42L, (long)list[0], "数组内安全整数保持 long");
        AssertEqual("9007199254740995", (string)list[1], "数组内超界雪花整数转 string");

        AssertThrows<ArgumentException>(() => AbiValidator.SanitizeProperties(new Dictionary<string, object?>
        {
            ["bad_nan"] = double.NaN
        }), "拒绝 double.NaN");

        AssertThrows<ArgumentException>(() => AbiValidator.SanitizeProperties(new Dictionary<string, object?>
        {
            ["bad_inf"] = double.PositiveInfinity
        }), "拒绝 double.PositiveInfinity");

        Console.WriteLine("  ✓ 大整数 (> 2^53 - 1) 自动转字符串与 NaN/Infinity 拦截测试通过");
    }

    private static void TestTimeExtractionAndPriority()
    {
        var staging = new StagingConsumer();
        using var sdk = new AbiAnalytics(staging);

        // 1. #time 优先于 $time，且两者均从最终 properties 中剥离
        sdk.Track("u_1", "vis_1", "OrderPaid", new Dictionary<string, object?>
        {
            ["#time"] = "2026-11-10T08:00:00Z",
            ["$time"] = "2026-11-09T08:00:00Z",
            ["#ip"] = "203.0.113.88",
            ["amount"] = 100.0
        });

        // 2. 秒级时间戳 (< 10^11) 自动转为毫秒
        sdk.Track("u_1", "vis_1", "OrderPaid", new Dictionary<string, object?>
        {
            ["$time"] = 1794283200L,
            ["amount"] = 200.0
        });

        // 3. 显式 eventTime 优先于 #time
        var explicitTime = DateTimeOffset.FromUnixTimeMilliseconds(1794290000123L);
        sdk.Track("u_1", "vis_1", "OrderPaid", new Dictionary<string, object?>
        {
            ["#time"] = 1794283200000L,
            ["amount"] = 300.0
        }, explicitTime);

        var events = staging.GetStagedEvents();
        AssertEqual(3, events.Count, "应暂存 3 条事件");

        long expectedIsoMs = DateTimeOffset.Parse("2026-11-10T08:00:00Z", CultureInfo.InvariantCulture).ToUnixTimeMilliseconds();
        AssertEqual(expectedIsoMs, (long)events[0]["timestamp"]!, "#time ISO 字符串毫秒解析");
        var props0 = (Dictionary<string, object?>)events[0]["properties"]!;
        AssertTrue(!props0.ContainsKey("#time") && !props0.ContainsKey("$time"), "#time 与 $time 必须从 properties 剥离");
        AssertEqual("203.0.113.88", (string)props0["#ip"]!, "#ip 保留在 properties 中供网关/Flink 解析");

        AssertEqual(1794283200000L, (long)events[1]["timestamp"]!, "秒级时间戳自动乘 1000");
        AssertEqual(1794290000123L, (long)events[2]["timestamp"]!, "显式 eventTime 优先级最高");

        Console.WriteLine("  ✓ #time / $time 时间戳提取、剥离与优先级测试通过");
    }

    private static void TestUserProfileOperationsAndSuperPropIsolation()
    {
        var staging = new StagingConsumer();
        using var sdk = new AbiAnalytics(staging);

        sdk.SetSuperProperties(new Dictionary<string, object?>
        {
            ["service_name"] = "billing-api",
            ["$app_version"] = "3.0.0"
        });
        sdk.SetDynamicSuperProperties(() => new Dictionary<string, object?>
        {
            ["dyn_flag"] = "active"
        });

        sdk.Track("u_100", "anon_100", "NormalEvent", new Dictionary<string, object?> { ["k"] = "v" });
        sdk.UserSet("u_100", "anon_100", new Dictionary<string, object?> { ["vip"] = "gold" });
        sdk.UserSetOnce("u_100", "anon_100", new Dictionary<string, object?> { ["first_src"] = "sem" });
        sdk.UserAdd("u_100", "anon_100", new Dictionary<string, object?> { ["points"] = 50 });
        sdk.UserUnset("u_100", "anon_100", "temp_tag", "expired_flag");
        sdk.UserAppend("u_100", "anon_100", new Dictionary<string, object?> { ["roles"] = new[] { "buyer" } });
        sdk.UserUniqAppend("u_100", "anon_100", new Dictionary<string, object?> { ["roles"] = new[] { "buyer", "vip" } });
        sdk.UserDelete("u_100", "anon_100");

        var events = staging.GetStagedEvents();
        AssertEqual(8, events.Count, "1 条行为事件 + 7 条画像事件");

        var normalProps = (Dictionary<string, object?>)events[0]["properties"]!;
        AssertEqual("billing-api", (string)normalProps["service_name"]!, "行为事件包含静态公共属性");
        AssertEqual("active", (string)normalProps["dyn_flag"]!, "行为事件包含动态公共属性");

        string[] expectedProfileEvents =
        {
            "$user_set", "$user_set_once", "$user_add",
            "$user_unset", "$user_append", "$user_uniq_append", "$user_del"
        };
        for (int i = 0; i < expectedProfileEvents.Length; i++)
        {
            var ev = events[i + 1];
            AssertEqual(expectedProfileEvents[i], (string)ev["event_name"]!, $"画像事件名 #{i}");
            var profileProps = (Dictionary<string, object?>)ev["properties"]!;
            AssertTrue(!profileProps.ContainsKey("service_name"), $"{expectedProfileEvents[i]} 严禁混入静态公共属性");
            AssertTrue(!profileProps.ContainsKey("dyn_flag"), $"{expectedProfileEvents[i]} 严禁混入动态公共属性");
        }

        var unsetProps = (Dictionary<string, object?>)events[4]["properties"]!;
        AssertEqual(0L, Convert.ToInt64(unsetProps["temp_tag"], CultureInfo.InvariantCulture), "$user_unset 键置 0");

        Console.WriteLine("  ✓ 7 类 $user_* 用户画像操作及公共属性严格隔离测试通过");
    }

    private static void TestTrackFirstUpdateOverwriteAndDualIdentity()
    {
        var staging = new StagingConsumer();
        using var sdk = new AbiAnalytics(staging);

        string id1 = sdk.Track("acct_88", "vis_88", "$login", new Dictionary<string, object?>
        {
            ["method"] = "sso"
        });
        AssertTrue(!string.IsNullOrEmpty(id1), "双 ID $login 返回 event_id");

        string paidId = sdk.TrackWithId("acct_88", "vis_88", "OrderPaid", "ord_evt_001", new Dictionary<string, object?>
        {
            ["status"] = "paid"
        });
        AssertEqual("ord_evt_001", paidId, "TrackWithId 保持指定 event_id");

        // D7① / G6 门禁：未开放接口必须显式抛出 NotSupportedException 且绝不入队伪造 track 事件
#pragma warning disable CS0618
        AssertThrows<NotSupportedException>(
            () => sdk.TrackFirst("acct_88", "vis_88", "FirstActivate", "chk_device_88", new Dictionary<string, object?> { ["channel"] = "steam" }),
            "TrackFirst 抛出 NotSupportedException");
        AssertThrows<NotSupportedException>(
            () => sdk.TrackUpdate("acct_88", "vis_88", "OrderState", "ord_evt_001", new Dictionary<string, object?> { ["status"] = "paid" }),
            "TrackUpdate 抛出 NotSupportedException");
        AssertThrows<NotSupportedException>(
            () => sdk.TrackOverwrite("acct_88", "vis_88", "OrderState", "ord_evt_001", new Dictionary<string, object?> { ["status"] = "settled" }),
            "TrackOverwrite 抛出 NotSupportedException");
#pragma warning restore CS0618

        // 100 字节长 login_id 且 distinct_id 为空时，绝不回填 distinct_id
        string longLoginId = new string('u', 100);
        sdk.Track(longLoginId, "", "BackendWebhook", new Dictionary<string, object?>
        {
            ["source"] = "cron"
        });

        var events = staging.GetStagedEvents();
        AssertEqual(3, events.Count, "仅入队合法的 3 条 track 事件");
        AssertEqual("$login", (string)events[0]["event_name"]!, "双 ID 事件名");
        AssertEqual("vis_88", (string)events[0]["distinct_id"]!, "distinct_id 为访客 ID");
        AssertEqual("acct_88", (string)events[0]["login_id"]!, "login_id 为账号 ID");
        AssertEqual("ord_evt_001", (string)events[1]["event_id"]!, "TrackWithId 指定 event_id 保留");

        AssertEqual(string.Empty, (string)events[2]["distinct_id"]!, "仅传长 login_id 时 distinct_id 保持空字符串");
        AssertEqual(longLoginId, (string)events[2]["login_id"]!, "100 字节长 login_id 原样保留");

        Console.WriteLine("  ✓ 双 ID 自动关联 / 长 login_id 空 distinct_id / D7① 未开放接口拦截测试通过");
    }

    private static void TestStagingAndBatchConsumersEndToEnd()
    {
        var cfg = new Program.DemoConfig
        {
            ProjectId = 1,
            ProjectToken = "abi_tok_test",
            Scenario = "all",
            DryRun = true,
            AutoConfirm = true
        };

        var (previewJson, staging) = Program.BuildDemoRequestPreview(cfg);
        AssertTrue(previewJson.Contains("\"project_id\": 1", StringComparison.Ordinal), "预览 JSON 含 project_id");
        AssertTrue(previewJson.Contains("\"9007199254740999\"", StringComparison.Ordinal), "预览 JSON 雪花 ID 已转字符串");
        AssertTrue(staging.Size > 0, "确认提交前暂存队列非空");

        var (envelope, respJson) = Program.ConfirmSubmitDemo(staging, cfg);
        AssertTrue(envelope is not null && envelope.Code == 200, "Mock 网关返回 code=200");
        AssertEqual(0, staging.Size, "确认提交后暂存队列已清空");
        AssertTrue(respJson.Contains("\"accepted\":", StringComparison.Ordinal), "响应 JSON 包含 accepted 计数");

        Console.WriteLine("  ✓ StagingConsumer 两步式预览与 BatchConsumer Gzip 提交端到端测试通过");
    }

    private static void TestLoggerConsumerRotation()
    {
        string tempDir = Path.Combine(Path.GetTempPath(), $"abi_csharp_sdk_test_{Guid.NewGuid():N}");
        try
        {
            string filePath;
            using (var logger = new LoggerConsumer(tempDir, "abi_test"))
            using (var sdk = new AbiAnalytics(logger))
            {
                sdk.Track("u_log_1", "anon_log_1", "OfflineJobCompleted", new Dictionary<string, object?>
                {
                    ["records"] = 1024,
                    ["snowflake_job_id"] = 9007199254740997L
                });
                sdk.Flush();
                filePath = logger.CurrentFilePath;
            }

            AssertTrue(File.Exists(filePath), "LoggerConsumer 应生成带日期的 .jsonl 文件");
            string[] lines = File.ReadAllLines(filePath, Encoding.UTF8);
            AssertEqual(1, lines.Length, "JSONL 文件包含 1 行记录");
            AssertTrue(lines[0].Contains("\"9007199254740997\"", StringComparison.Ordinal), "JSONL 大整数转字符串");
        }
        finally
        {
            if (Directory.Exists(tempDir))
            {
                Directory.Delete(tempDir, recursive: true);
            }
        }

        Console.WriteLine("  ✓ LoggerConsumer 本地 JSONL 落盘测试通过");
    }

    private static void TestUnityClientSdkAndTwoStepDemo()
    {
        var (mockUrl, mockServer) = Program.StartEmbeddedMockGateway();
        try
        {
            string previewJson = Abi.GameEngines.Unity.AbiUnityDemoRunner.PreviewScenarioJson(
                serverUrl: mockUrl,
                projectId: 1,
                projectToken: "abi_tok_unity_test"
            );
            AssertTrue(previewJson.Contains("\"project_id\": 1", StringComparison.Ordinal), "Unity 预览 JSON 含 project_id");
            AssertTrue(previewJson.Contains("\"9007199254740993\"", StringComparison.Ordinal), "Unity 预览雪花 ID 已转字符串");
            AssertTrue(previewJson.Contains("\"$duration\":", StringComparison.Ordinal), "Unity TimeEvent 注入 $duration");
            AssertTrue(previewJson.Contains("\"$user_set\"", StringComparison.Ordinal), "Unity 包含 $user_set 画像事件");

            var demoMb = new Abi.GameEngines.Unity.AbiUnityDemoMonoBehaviour
            {
                ServerUrl = mockUrl,
                ProjectId = 1,
                ProjectToken = "abi_tok_unity_test"
            };
            demoMb.Start();
            demoMb.TriggerLogin("role_paladin_01");
            demoMb.ToggleDynamicSuperProperties();
            demoMb.StageSnowflakeIapOrder();
            AssertTrue(demoMb.RequestJsonPreview.Contains("\"9007199254740993\"", StringComparison.Ordinal), "Unity MonoBehaviour 实时预览 JSON");

            using var doneSignal = new ManualResetEventSlim(false);
            int cbStatus = 0;
            demoMb.ConfirmSubmit((code, _) =>
            {
                cbStatus = code;
                doneSignal.Set();
            });
            AssertTrue(doneSignal.Wait(TimeSpan.FromSeconds(5)), "Unity ConfirmSubmit 异步回调完成");
            AssertEqual(200, cbStatus, "Unity ConfirmSubmit 返回 HTTP 200");

            var unitySdk = new Abi.GameEngines.Unity.AbiUnityAnalytics();
            unitySdk.Initialize(mockUrl, 1, "abi_tok_unity_test", autoFlush: false);
            var validRestore = unitySdk.RestoreIdentityFromPersisted("vis_unity_01", new string('u', 100));
            AssertTrue(!validRestore.DistinctRegenerated && !validRestore.LoginCleared, "Unity 合法持久化双 ID 直接恢复");
            AssertEqual("vis_unity_01", unitySdk.DistinctId, "Unity 恢复 distinct_id");
            AssertEqual(new string('u', 100), unitySdk.LoginId, "Unity 恢复 100B login_id");
            unitySdk.Logout();
            AssertEqual("vis_unity_01", unitySdk.DistinctId, "Unity Logout 不覆盖 distinct_id");
            AssertEqual(string.Empty, unitySdk.LoginId, "Unity Logout 清空 login_id");
            AssertEqual(0, unitySdk.PendingQueueCount, "Unity Logout 不发送网络事件");
            AssertThrows<ArgumentException>(() => unitySdk.Track("$identify"), "Unity 拦截已移除的 $identify");
            AssertThrows<ArgumentException>(() => unitySdk.Track("#identify"), "Unity 拦截已移除的 #identify");
#pragma warning disable CS0618
            AssertThrows<NotSupportedException>(() => unitySdk.TrackFirst("FirstQuest", "chk_001"), "Unity 拦截未开放的 TrackFirst");
            AssertThrows<NotSupportedException>(() => unitySdk.TrackUpdate("BossDefeated", "evt_unity_boss_1001", new Dictionary<string, object?> { ["loot_status"] = "claimed" }), "Unity 拦截未开放的 TrackUpdate");
            AssertThrows<NotSupportedException>(() => unitySdk.TrackOverwrite("BossDefeated", "evt_unity_boss_1001", new Dictionary<string, object?> { ["loot_status"] = "settled" }), "Unity 拦截未开放的 TrackOverwrite");
#pragma warning restore CS0618
            AssertEqual(0, unitySdk.PendingQueueCount, "Unity 未开放可变事件接口不入队伪造 track 事件");

            var dirtyRestore = unitySdk.RestoreIdentityFromPersisted(new string('d', 80), new string('l', 150));
            AssertTrue(dirtyRestore.DistinctRegenerated && dirtyRestore.LoginCleared, "Unity 越界持久化 ID 自动重建与清理");
            AssertTrue(unitySdk.DistinctId.Length <= 64 && unitySdk.DistinctId != new string('d', 80), "Unity 重建合法 UUIDv4 distinct_id");
            AssertEqual(string.Empty, unitySdk.LoginId, "Unity 清理越界 login_id");
        }
        finally
        {
            mockServer.Dispose();
        }

        Console.WriteLine("  ✓ Unity 客户端 SDK (AbiUnityAnalytics + AbiUnityDemoMonoBehaviour) 校验通过");
    }

    private static void AssertEqual<T>(T expected, T actual, string message)
    {
        if (!EqualityComparer<T>.Default.Equals(expected, actual))
        {
            throw new InvalidOperationException($"断言失败 [{message}]: 期望={expected}, 实际={actual}");
        }
    }

    private static void AssertTrue(bool condition, string message)
    {
        if (!condition)
        {
            throw new InvalidOperationException($"断言失败: {message}");
        }
    }

    private static void AssertThrows<TException>(Action action, string message) where TException : Exception
    {
        try
        {
            action();
        }
        catch (TException)
        {
            return;
        }
        throw new InvalidOperationException($"断言失败 [{message}]: 未抛出期望的异常 {typeof(TException).Name}");
    }
}
