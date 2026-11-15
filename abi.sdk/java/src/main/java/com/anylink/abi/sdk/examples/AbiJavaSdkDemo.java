package com.anylink.abi.sdk.examples;

import com.anylink.abi.sdk.AbiAnalytics;
import com.anylink.abi.sdk.BatchConsumer;
import com.anylink.abi.sdk.DebugConsumer;
import com.anylink.abi.sdk.LoggerConsumer;
import com.anylink.abi.sdk.StagingConsumer;
import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;
import com.sun.net.httpserver.HttpServer;

import java.io.Console;
import java.io.File;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.BooleanSupplier;

/**
 * ABI Java 服务端 SDK 可直接运行的两步式演示程序（配置预览 JSON -> 确认提交）与可复用场景示例库。
 *
 * <h3>命令行运行方式（两步式交互流程）</h3>
 * <pre>{@code
 * # 1. 默认零依赖模式：先输出待提交请求 JSON 预览，终端确认 [y/N] 后提交至内置模拟网关
 * mvn compile exec:java -Dexec.mainClass="com.anylink.abi.sdk.examples.AbiJavaSdkDemo"
 *
 * # 2. 自定义场景、静态/动态公共属性并连接真实网关（--yes 跳过交互确认直接提交）
 * mvn compile exec:java -Dexec.mainClass="com.anylink.abi.sdk.examples.AbiJavaSdkDemo" \
 *   -Dexec.args="--server-url http://127.0.0.1:8081 --project-id 1 --project-token abi_live_token \
 *   --scenario=order --super-props='{\"$app_version\":\"3.5.0\",\"env\":\"staging\"}' --dynamic-super --yes"
 * }</pre>
 */
public final class AbiJavaSdkDemo {
    private static final ObjectMapper MAPPER = new ObjectMapper();

    private AbiJavaSdkDemo() {
    }

    /**
     * 两步式演示与命令行参数配置项。
     */
    public static class DemoConfig {
        /** ABI 采集网关地址；为空时在确认提交阶段自动启动内置本地模拟网关 */
        public String serverUrl = "";
        /** ABI 项目数字 ID（必须 {@code > 0}） */
        public long projectId = 1L;
        /** ABI 项目采集鉴权 Token */
        public String projectToken = "abi_demo_project_token";
        /** 演示场景：{@code order | browse | identity | profile | all} */
        public String scenario = "order";
        /** 全局静态公共属性（将自动合并至非 {@code $user_*} 行为事件） */
        public Map<String, Object> superProperties = defaultSuperProperties();
        /** 是否开启每次埋点动态求值的动态公共属性（{@code request_seq}、{@code trace_ts}） */
        public boolean enableDynamicSuperProperties = false;
        /** 是否开启 {@code dry_run=true}（网关仅执行严格校验不落库） */
        public boolean dryRun = false;
        /** 是否跳过交互式终端确认直接提交（对应 {@code --yes} / {@code -y}） */
        public boolean autoConfirm = false;

        /**
         * 生成默认静态公共属性示例配置。
         *
         * @return 默认静态公共属性键值对
         */
        public static Map<String, Object> defaultSuperProperties() {
            Map<String, Object> defaults = new LinkedHashMap<>();
            defaults.put("$app_version", "3.4.0");
            defaults.put("$platform", "java-server");
            defaults.put("service_name", "storefront-api");
            return defaults;
        }

        /**
         * 从环境变量与命令行参数解析构造 {@link DemoConfig}（命令行参数优先级高于环境变量）。
         *
         * @param args 命令行参数数组
         * @return 解析后的配置实例
         */
        public static DemoConfig fromArgs(String[] args) {
            DemoConfig cfg = new DemoConfig();
            cfg.serverUrl = envOrDefault("ABI_SERVER_URL", "");
            cfg.projectId = Long.parseLong(envOrDefault("ABI_PROJECT_ID", "1"));
            cfg.projectToken = envOrDefault("ABI_PROJECT_TOKEN", "abi_demo_project_token");
            cfg.scenario = envOrDefault("ABI_SCENARIO", "order");
            cfg.enableDynamicSuperProperties = Boolean.parseBoolean(envOrDefault("ABI_DYNAMIC_SUPER", "false"));
            cfg.dryRun = Boolean.parseBoolean(envOrDefault("ABI_DRY_RUN", "false"));
            cfg.autoConfirm = Boolean.parseBoolean(envOrDefault("ABI_AUTO_CONFIRM", "false"));

            String envSuperProps = envOrDefault("ABI_SUPER_PROPS", "");
            if (!envSuperProps.isEmpty()) {
                cfg.superProperties = parseSuperPropsJson(envSuperProps);
            }

            if (args == null) {
                return cfg;
            }

            for (int i = 0; i < args.length; i++) {
                String arg = args[i];
                if (arg == null || arg.isBlank()) {
                    continue;
                }
                if ("--server-url".equals(arg) && i + 1 < args.length) {
                    cfg.serverUrl = args[++i];
                } else if (arg.startsWith("--server-url=")) {
                    cfg.serverUrl = arg.substring("--server-url=".length());
                } else if ("--project-id".equals(arg) && i + 1 < args.length) {
                    cfg.projectId = Long.parseLong(args[++i]);
                } else if (arg.startsWith("--project-id=")) {
                    cfg.projectId = Long.parseLong(arg.substring("--project-id=".length()));
                } else if ("--project-token".equals(arg) && i + 1 < args.length) {
                    cfg.projectToken = args[++i];
                } else if (arg.startsWith("--project-token=")) {
                    cfg.projectToken = arg.substring("--project-token=".length());
                } else if ("--scenario".equals(arg) && i + 1 < args.length) {
                    cfg.scenario = args[++i];
                } else if (arg.startsWith("--scenario=")) {
                    cfg.scenario = arg.substring("--scenario=".length());
                } else if ("--super-props".equals(arg) && i + 1 < args.length) {
                    cfg.superProperties = parseSuperPropsJson(args[++i]);
                } else if (arg.startsWith("--super-props=")) {
                    cfg.superProperties = parseSuperPropsJson(arg.substring("--super-props=".length()));
                } else if ("--dynamic-super".equals(arg)) {
                    if (i + 1 < args.length && isBooleanLiteral(args[i + 1])) {
                        cfg.enableDynamicSuperProperties = Boolean.parseBoolean(args[++i]);
                    } else {
                        cfg.enableDynamicSuperProperties = true;
                    }
                } else if (arg.startsWith("--dynamic-super=")) {
                    cfg.enableDynamicSuperProperties = Boolean.parseBoolean(arg.substring("--dynamic-super=".length()));
                } else if ("--dry-run".equals(arg)) {
                    if (i + 1 < args.length && isBooleanLiteral(args[i + 1])) {
                        cfg.dryRun = Boolean.parseBoolean(args[++i]);
                    } else {
                        cfg.dryRun = true;
                    }
                } else if (arg.startsWith("--dry-run=")) {
                    cfg.dryRun = Boolean.parseBoolean(arg.substring("--dry-run=".length()));
                } else if ("--yes".equals(arg) || "-y".equals(arg)) {
                    if (i + 1 < args.length && isBooleanLiteral(args[i + 1])) {
                        cfg.autoConfirm = Boolean.parseBoolean(args[++i]);
                    } else {
                        cfg.autoConfirm = true;
                    }
                } else if (arg.startsWith("--yes=")) {
                    cfg.autoConfirm = Boolean.parseBoolean(arg.substring("--yes=".length()));
                } else {
                    throw new IllegalArgumentException("未知命令行参数: " + arg);
                }
            }
            return cfg;
        }
    }

    /**
     * 第一步：根据指定场景、动静态公共属性与项目参数构建暂存事件，仅在标准输出打印唯一一份干净完整的
     * <b>待提交请求 JSON 预览 ({@code POST /collect/api/v1/track/batch})</b>，并返回待确认的 {@link StagingConsumer}
     *（本方法不会发起任何网络请求）。
     *
     * @param scenario                     场景标识：{@code order | browse | identity | profile | all}
     * @param superProperties              静态公共属性键值对（传 {@code null} 或空 Map 表示不注入静态公共属性）
     * @param enableDynamicSuperProperties 是否启用动态公共属性回调
     * @param projectId                    ABI 项目 ID（必须 {@code > 0}）
     * @param projectToken                 ABI 项目采集鉴权 Token
     * @param dryRun                       是否在请求体中标记 {@code dry_run}
     * @return 已暂存待提交事件的 {@link StagingConsumer}
     * @throws Exception 参数校验不通过时抛出
     */
    public static StagingConsumer buildScenarioPreview(
            String scenario,
            Map<String, Object> superProperties,
            boolean enableDynamicSuperProperties,
            long projectId,
            String projectToken,
            boolean dryRun
    ) throws Exception {
        DemoConfig cfg = new DemoConfig();
        cfg.scenario = scenario;
        cfg.superProperties = superProperties;
        cfg.enableDynamicSuperProperties = enableDynamicSuperProperties;
        cfg.projectId = projectId;
        cfg.projectToken = projectToken;
        cfg.dryRun = dryRun;
        return buildScenarioPreview(cfg);
    }

    /**
     * 第一步：根据 {@link DemoConfig} 配置构建暂存事件，仅打印唯一一份干净完整的
     * <b>待提交请求 JSON 预览 ({@code POST /collect/api/v1/track/batch})</b>，并返回 {@link StagingConsumer}。
     *
     * @param config 演示配置项
     * @return 已暂存待提交事件的 {@link StagingConsumer}
     * @throws Exception 参数或属性校验失败时抛出
     */
    public static StagingConsumer buildScenarioPreview(DemoConfig config) throws Exception {
        if (config == null) {
            throw new IllegalArgumentException("config must not be null");
        }
        String normalizedScenario = normalizeScenario(config.scenario);
        StagingConsumer staging = new StagingConsumer();

        try (AbiAnalytics sdk = new AbiAnalytics(staging)) {
            if (config.superProperties != null && !config.superProperties.isEmpty()) {
                sdk.setSuperProperties(config.superProperties);
            }
            if (config.enableDynamicSuperProperties) {
                AtomicInteger requestSeq = new AtomicInteger(100);
                sdk.setDynamicSuperProperties(() -> {
                    Map<String, Object> dyn = new LinkedHashMap<>();
                    dyn.put("request_seq", requestSeq.incrementAndGet());
                    dyn.put("trace_ts", Instant.parse("2026-11-10T02:00:00Z"));
                    return dyn;
                });
            }

            switch (normalizedScenario) {
                case "order":
                    triggerOrderLifecycleTrackUpdateOverwrite(sdk);
                    break;
                case "browse":
                    recordAnonymousBrowseEvents(sdk);
                    break;
                case "identity":
                    triggerLoginIdentityBinding(sdk);
                    break;
                case "profile":
                    triggerUserProfileOperations(sdk);
                    break;
                case "all":
                    recordAnonymousBrowseEvents(sdk);
                    triggerLoginIdentityBinding(sdk);
                    triggerOrderLifecycleTrackUpdateOverwrite(sdk);
                    triggerUserProfileOperations(sdk);
                    break;
                default:
                    throw new IllegalArgumentException(
                            "不支持的 --scenario 值: " + config.scenario + "（可选值: order|browse|identity|profile|all）"
                    );
            }
        }

        String previewJson = staging.previewRequestJson(config.projectId, config.projectToken, config.dryRun);
        System.out.println("=== 待提交请求 JSON 预览 (POST /collect/api/v1/track/batch) ===");
        System.out.println(previewJson);
        return staging;
    }

    /**
     * 第二步：确认并提交已暂存的请求参数。
     * <ul>
     *   <li>若处于交互式终端（{@code System.console() != null}）且未设置 {@code --yes}，提示
     *       {@code 是否确认提交上述请求参数？[y/N]: } 等待用户确认后再发送；</li>
     *   <li>若传入 {@code --yes} 或处于非交互环境（如 JUnit 自动化测试），直接执行确认提交并输出唯一一份网关响应结果。</li>
     * </ul>
     *
     * @param stagingConsumer 第一步生成的暂存消费者
     * @param config          演示配置项
     * @return 实际确认提交成功的事件条数（用户取消时清空暂存队列并返回 {@code 0}）
     * @throws Exception 网络提交或网关校验失败时抛出
     */
    public static int confirmAndSubmit(StagingConsumer stagingConsumer, DemoConfig config) throws Exception {
        BooleanSupplier consoleConfirmation = null;
        Console console = System.console();
        if (config != null && !config.autoConfirm && console != null) {
            consoleConfirmation = () -> {
                String input = console.readLine("是否确认提交上述请求参数？[y/N]: ");
                if (input == null) {
                    return false;
                }
                String trimmed = input.trim();
                return "y".equalsIgnoreCase(trimmed) || "yes".equalsIgnoreCase(trimmed);
            };
        }
        return confirmAndSubmit(stagingConsumer, config, consoleConfirmation);
    }

    /**
     * 第二步（可注入确认回调重载）：当 {@code confirmationPrompt} 非空时先调用该回调确认是否提交；
     * 确认通过后将 {@code stagingConsumer} 中的事件一次性提交至目标网关（未指定远程地址时自动启动本地内嵌模拟网关），
     * 并输出唯一一份网关响应结果。
     *
     * @param stagingConsumer    第一步生成的暂存消费者
     * @param config             演示配置项
     * @param confirmationPrompt 可选的确认决策函数（传 {@code null} 表示直接确认提交）
     * @return 实际确认提交成功的事件条数（取消提交时清空暂存队列并返回 {@code 0}）
     * @throws Exception 网络提交或网关响应异常时抛出
     */
    public static int confirmAndSubmit(
            StagingConsumer stagingConsumer,
            DemoConfig config,
            BooleanSupplier confirmationPrompt
    ) throws Exception {
        if (stagingConsumer == null) {
            throw new IllegalArgumentException("stagingConsumer must not be null");
        }
        if (config == null) {
            throw new IllegalArgumentException("config must not be null");
        }

        if (confirmationPrompt != null && !confirmationPrompt.getAsBoolean()) {
            stagingConsumer.clear();
            System.out.println("已取消提交，暂存事件队列已清空，未发起任何网络请求。");
            return 0;
        }

        HttpServer embeddedServer = null;
        String targetServerUrl = config.serverUrl;
        if (targetServerUrl == null || targetServerUrl.isBlank()) {
            embeddedServer = startSilentMockGateway();
            targetServerUrl = "http://127.0.0.1:" + embeddedServer.getAddress().getPort();
        }

        try {
            BatchConsumer.Config batchCfg = new BatchConsumer.Config(
                    targetServerUrl,
                    config.projectId,
                    config.projectToken
            );
            batchCfg.batchSize = Math.min(500, Math.max(50, stagingConsumer.size()));
            batchCfg.flushIntervalMs = 60000L;
            batchCfg.dryRun = config.dryRun;

            int submitted;
            int statusCode;
            String responseBody;
            try (BatchConsumer batchConsumer = new BatchConsumer(batchCfg)) {
                submitted = stagingConsumer.confirmSubmit(batchConsumer);
                statusCode = batchConsumer.getLastResponseStatus();
                responseBody = batchConsumer.getLastResponseBody();
            }

            System.out.printf(
                    "=== 网关响应结果 (HTTP %d, 已提交事件数=%d, endpoint=%s) ===%n%s%n",
                    statusCode,
                    submitted,
                    BatchConsumer.resolveBatchEndpoint(targetServerUrl),
                    responseBody
            );
            return submitted;
        } finally {
            if (embeddedServer != null) {
                embeddedServer.stop(0);
            }
        }
    }

    /**
     * 场景 1：匿名访客浏览行为上报，以及静态/动态公共属性（Super Properties）注入。
     *
     * @param sdk 已初始化的 {@link AbiAnalytics} 实例
     * @return 本场景发送的事件条数（2 条）
     * @throws Exception 参数校验或上报失败时抛出
     */
    public static int triggerAnonymousBrowseAndSuperProps(AbiAnalytics sdk) throws Exception {
        AtomicInteger requestSeq = new AtomicInteger(100);

        // 1. 注册全局静态公共属性（自动合并至后续所有非用户画像的行为事件）
        sdk.setSuperProperties(DemoConfig.defaultSuperProperties());

        // 2. 注册动态公共属性回调（每次调用 track 时动态求值，优先级高于静态公共属性）
        sdk.setDynamicSuperProperties(() -> Map.of(
                "request_seq", requestSeq.incrementAndGet(),
                "trace_ts", Instant.parse("2026-11-10T02:00:00Z")
        ));

        return recordAnonymousBrowseEvents(sdk);
    }

    private static int recordAnonymousBrowseEvents(AbiAnalytics sdk) throws Exception {
        // 未登录访客浏览落地页（loginId 为空，仅传访客 distinctId）
        Map<String, Object> pageviewProps = new LinkedHashMap<>();
        pageviewProps.put("$url", "https://shop.example.com/products/pro-plan");
        pageviewProps.put("$title", "ABI Enterprise Pro Plan");
        pageviewProps.put("referrer_channel", "organic_search");
        sdk.track("", "vis_sess_9001", "$pageview", pageviewProps);

        // 访客查看商品详情
        Map<String, Object> productProps = new LinkedHashMap<>();
        productProps.put("sku_id", "SKU_PRO_2026");
        productProps.put("price", 299.00);
        productProps.put("in_stock", true);
        sdk.track("", "vis_sess_9001", "ProductViewed", productProps);
        return 2;
    }

    /**
     * 场景 2：用户注册与登录双 ID 自动身份绑定（对标数数科技：任意事件同时携带 {@code loginId} 与访客 {@code distinctId}，
     * 由 Flink 自动完成双 ID 实名映射）。
     *
     * @param sdk 已初始化的 {@link AbiAnalytics} 实例
     * @return 本场景发送的事件条数（2 条）
     * @throws Exception 事件上报失败时抛出
     */
    public static int triggerLoginIdentityBinding(AbiAnalytics sdk) throws Exception {
        // 1. 注册事件：同时携带 loginId 与访客 distinctId，Flink 流式引擎自动建立双 ID 绑定映射
        Map<String, Object> signupProps = new LinkedHashMap<>();
        signupProps.put("register_channel", "oauth_github");
        sdk.track("user_8848", "vis_sess_9001", "$signup", signupProps);

        // 2. 登录成功事件：继续携带双 ID 上报登录属性
        Map<String, Object> loginProps = new LinkedHashMap<>();
        loginProps.put("auth_method", "oauth_github");
        loginProps.put("mfa_verified", true);
        sdk.track("user_8848", "vis_sess_9001", "$login", loginProps);
        return 2;
    }

    /**
     * 场景 3：订单里程碑幂等上报 —— 演示确定性 {@code event_id} 同日重试幂等（{@link AbiAnalytics#trackWithId}）、
     * 超过 {@code 2^53 - 1} 的 64 位雪花长整型安全转字符串与 {@link Instant} 自动 UTC ISO-8601 格式化。
     *
     * @param sdk 已初始化的 {@link AbiAnalytics} 实例
     * @return 本场景发送的事件条数（3 条）
     * @throws Exception 参数校验或事件上报失败时抛出
     */
    public static int triggerOrderLifecycleTrackUpdateOverwrite(AbiAnalytics sdk) throws Exception {
        long snowflakeOrderId = 9007199254740999L; // 超过 JS 安全整数上限 2^53 - 1，SDK 自动序列化为字符串防精度丢失

        // 1. 订单创建：指定确定性业务主键作为 event_id 防重放
        Map<String, Object> initialProps = new LinkedHashMap<>();
        initialProps.put("order_id", snowflakeOrderId);
        initialProps.put("order_status", "created");
        initialProps.put("amount", 299.00);
        initialProps.put("currency", "USD");
        initialProps.put("item_skus", Arrays.asList("SKU_PRO_2026", "SKU_ADDON_AI"));
        initialProps.put("created_at", Instant.parse("2026-11-10T02:15:30Z"));

        sdk.trackWithId("user_8848", "vis_sess_9001", "OrderCreated", "evt_ord_created_20261110_8848", initialProps);

        // 2. 订单支付成功：独立里程碑事件携带确定性 event_id 防支付回调重试重复统计
        Map<String, Object> paidProps = new LinkedHashMap<>();
        paidProps.put("order_id", snowflakeOrderId);
        paidProps.put("order_status", "paid");
        paidProps.put("amount", 299.00);
        paidProps.put("payment_channel", "stripe");
        paidProps.put("paid_at", Instant.parse("2026-11-10T02:16:05Z"));
        sdk.trackWithId("user_8848", "vis_sess_9001", "OrderPaid", "evt_ord_paid_20261110_8848", paidProps);

        // 3. 订单最终结算：独立里程碑事件携带确定性 event_id
        Map<String, Object> settledProps = new LinkedHashMap<>();
        settledProps.put("order_id", snowflakeOrderId);
        settledProps.put("order_status", "settled");
        settledProps.put("amount", 269.10);
        settledProps.put("discount_code", "ANNUAL10");
        settledProps.put("settled_at", Instant.parse("2026-11-10T02:20:00Z"));
        sdk.trackWithId("user_8848", "vis_sess_9001", "OrderSettled", "evt_ord_settled_20261110_8848", settledProps);
        return 3;
    }

    /**
     * 场景 4：全套 7 种用户画像变更操作演示（{@code userSet}、{@code userSetOnce}、
     * {@code userAdd}、{@code userAppend}、{@code userUniqAppend}、{@code userUnset}、{@code userDelete}）。
     *
     * @param sdk 已初始化的 {@link AbiAnalytics} 实例
     * @return 本场景发送的事件条数（7 条）
     * @throws Exception 用户画像操作失败时抛出
     */
    public static int triggerUserProfileOperations(AbiAnalytics sdk) throws Exception {
        String loginId = "user_8848";
        String distinctId = "vis_sess_9001";

        // 1. 覆盖设置常规用户属性（$user_set）
        Map<String, Object> setProps = new LinkedHashMap<>();
        setProps.put("display_name", "Ada Lovelace");
        setProps.put("vip_tier", "gold");
        setProps.put("$city", "Singapore");
        sdk.userSet(loginId, distinctId, setProps);

        // 2. 仅首次设置不可变归因属性，如首访渠道与注册时间（$user_set_once）
        Map<String, Object> setOnceProps = new LinkedHashMap<>();
        setOnceProps.put("first_utm_source", "product_hunt");
        setOnceProps.put("first_registered_at", Instant.parse("2026-11-10T02:10:00Z"));
        sdk.userSetOnce(loginId, distinctId, setOnceProps);

        // 3. 数值型画像属性原子累加，如会员积分与累计消费额（$user_add）
        Map<String, Number> addProps = new LinkedHashMap<>();
        addProps.put("loyalty_points", 300);
        addProps.put("lifetime_spend", 269.10);
        sdk.userAdd(loginId, distinctId, addProps);

        // 4. 列表型属性追加元素，保留重复项（$user_append）
        sdk.userAppend(loginId, distinctId, Map.of(
                "viewed_categories", Arrays.asList("analytics", "bi_dashboard")
        ));

        // 5. 列表型属性集合去重追加元素（$user_uniq_append）
        sdk.userUniqAppend(loginId, distinctId, Map.of(
                "feature_flags", Arrays.asList("cohort_v2", "sql_copilot", "cohort_v2")
        ));

        // 6. 清空指定的临时用户属性（$user_unset）
        sdk.userUnset(loginId, distinctId, "legacy_trial_badge", "temp_onboarding_step");

        // 7. 注销并删除指定测试用户的画像记录（$user_del）
        sdk.userDelete("user_deleted_demo_99", "vis_deleted_99");
        return 7;
    }

    /**
     * 场景 5：使用同步 {@link DebugConsumer} 连接 ABI 采集网关执行在线 Dry-Run 严格 Schema 校验（仅校验不落库）。
     *
     * @param serverUrl    ABI 采集网关基础地址
     * @param projectId    ABI 项目 ID
     * @param projectToken ABI 项目采集 Token
     * @return 本场景校验通过的事件条数（1 条）
     * @throws Exception 网关 L4 严格 Schema 校验未通过或请求失败时抛出
     */
    public static int triggerDebugDryRunValidation(String serverUrl, long projectId, String projectToken) throws Exception {
        // dryRun=true 时网关同步返回严格校验结果，但不会将测试数据写入线上 Kafka / StarRocks
        try (AbiAnalytics debugSdk = new AbiAnalytics(new DebugConsumer(serverUrl, projectId, projectToken, true))) {
            Map<String, Object> debugProps = new LinkedHashMap<>();
            debugProps.put("cart_items", 3);
            debugProps.put("coupon_applied", true);
            debugProps.put("validated_at", Instant.parse("2026-11-10T02:22:00Z"));
            debugSdk.track("user_debug_01", "vis_debug_01", "CheckoutValidated", debugProps);
            debugSdk.flush();
        }
        return 1;
    }

    /**
     * 场景 6：使用 {@link LoggerConsumer} 将事件按 UTC 日期轮转写入本地 JSONL 文件（供 Filebeat / Vector 旁路采集）。
     *
     * @param outputDir {@code .jsonl} 日志文件输出目录
     * @return 本场景写入磁盘的事件条数（2 条）
     * @throws Exception 本地文件写入失败时抛出
     */
    public static int triggerLoggerConsumerDemo(Path outputDir) throws Exception {
        // 生成形如 abi_demo.YYYY-MM-DD.jsonl 的按日轮转本地事件文件
        try (AbiAnalytics loggerSdk = new AbiAnalytics(new LoggerConsumer(outputDir.toFile(), "abi_demo"))) {
            loggerSdk.track(
                    "user_batch_job_01",
                    "",
                    "NightlySettlementCompleted",
                    Map.of("processed_orders", 1250, "duration_ms", 842)
            );
            loggerSdk.userSet(
                    "user_batch_job_01",
                    "",
                    Map.of("last_job_status", "success")
            );
            loggerSdk.flush();
        }
        return 2;
    }

    /**
     * 端到端串联运行全部 6 个 ABI Java SDK 演示场景，并返回累计发送的事件总数（保留供编程式调用与集成单测使用）。
     *
     * @param serverUrl    ABI 采集网关基础地址（如 {@code http://127.0.0.1:8081}）
     * @param projectId    ABI 项目 ID（必须 {@code > 0}）
     * @param projectToken ABI 项目采集 Token
     * @return 全部场景累计发送的事件总数（共 17 条）
     * @throws Exception 任意场景执行失败时抛出
     */
    public static int runAllDemos(String serverUrl, long projectId, String projectToken) throws Exception {
        int totalEvents = 0;

        // 阶段一：通过生产级异步批量消费者（BatchConsumer）执行场景 1 ~ 场景 4
        BatchConsumer.Config cfg = new BatchConsumer.Config(serverUrl, projectId, projectToken);
        cfg.batchSize = 10;
        cfg.flushIntervalMs = 5000L;

        try (AbiAnalytics sdk = new AbiAnalytics(new BatchConsumer(cfg))) {
            totalEvents += triggerAnonymousBrowseAndSuperProps(sdk);
            totalEvents += triggerLoginIdentityBinding(sdk);
            totalEvents += triggerOrderLifecycleTrackUpdateOverwrite(sdk);
            totalEvents += triggerUserProfileOperations(sdk);
            sdk.flush();
        }

        // 阶段二：执行场景 5（DebugConsumer 同步在线 Dry-Run Schema 校验）
        totalEvents += triggerDebugDryRunValidation(serverUrl, projectId, projectToken);

        // 阶段三：在临时目录中执行场景 6（LoggerConsumer 本地 JSONL 落盘演示）并清理临时文件
        Path tempLogDir = Files.createTempDirectory("abi_java_sdk_demo_logs_");
        try {
            totalEvents += triggerLoggerConsumerDemo(tempLogDir);
        } finally {
            File[] files = tempLogDir.toFile().listFiles();
            if (files != null) {
                for (File f : files) {
                    f.delete();
                }
            }
            tempLogDir.toFile().delete();
        }

        return totalEvents;
    }

    /**
     * 命令行运行入口：执行清晰的两步式演示流程：
     * <ol>
     *   <li><b>配置并预览</b>：根据命令行参数生成唯一一份完整的 {@code POST /collect/api/v1/track/batch} 请求 JSON 预览；</li>
     *   <li><b>确认并提交</b>：交互式终端下提示 {@code [y/N]} 确认（传 {@code --yes} 或非交互环境自动确认），随后提交并输出唯一一份网关响应结果。</li>
     * </ol>
     *
     * @param args 可选命令行参数：{@code --server-url}、{@code --project-id}、{@code --project-token}、
     *             {@code --scenario=order|browse|identity|profile|all}、{@code --super-props}、
     *             {@code --dynamic-super}、{@code --dry-run}、{@code --yes}
     * @throws Exception 执行异常时抛出
     */
    public static void main(String[] args) throws Exception {
        DemoConfig config = DemoConfig.fromArgs(args);
        StagingConsumer staging = buildScenarioPreview(config);
        confirmAndSubmit(staging, config);
    }

    private static HttpServer startSilentMockGateway() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/collect/api/v1/track/batch", exchange -> {
            byte[] body = exchange.getRequestBody().readAllBytes();
            JsonNode root = MAPPER.readTree(body);
            JsonNode events = root.path("events");
            int accepted = events.isArray() ? events.size() : 0;
            boolean isDryRun = root.path("dry_run").asBoolean(false);

            Map<String, Object> data = new LinkedHashMap<>();
            data.put("accepted", accepted);
            data.put("rejected", 0);
            data.put("dry_run", isDryRun);

            Map<String, Object> resp = new LinkedHashMap<>();
            resp.put("code", 200);
            resp.put("message", "ok");
            resp.put("data", data);

            byte[] respBytes = MAPPER.writeValueAsBytes(resp);
            exchange.getResponseHeaders().set("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, respBytes.length);
            try (OutputStream os = exchange.getResponseBody()) {
                os.write(respBytes);
            }
        });
        server.start();
        return server;
    }

    private static String normalizeScenario(String raw) {
        if (raw == null || raw.isBlank()) {
            return "order";
        }
        return raw.trim().toLowerCase(Locale.ROOT);
    }

    private static Map<String, Object> parseSuperPropsJson(String json) {
        try {
            JsonNode node = MAPPER.readTree(json);
            if (node == null || !node.isObject()) {
                throw new IllegalArgumentException("--super-props 必须是 JSON 对象，例如 '{\"env\":\"prod\"}'");
            }
            return MAPPER.convertValue(node, new TypeReference<LinkedHashMap<String, Object>>() {});
        } catch (IllegalArgumentException ex) {
            throw ex;
        } catch (Exception ex) {
            throw new IllegalArgumentException("无法解析 --super-props JSON 对象: " + json, ex);
        }
    }

    private static boolean isBooleanLiteral(String token) {
        return token != null && ("true".equalsIgnoreCase(token.trim()) || "false".equalsIgnoreCase(token.trim()));
    }

    private static String envOrDefault(String key, String fallback) {
        String val = System.getenv(key);
        return (val != null && !val.isBlank()) ? val.trim() : fallback;
    }
}
