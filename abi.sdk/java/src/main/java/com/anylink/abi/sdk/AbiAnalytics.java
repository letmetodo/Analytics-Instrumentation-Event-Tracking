package com.anylink.abi.sdk;

import java.io.Closeable;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.ZoneId;
import java.time.ZonedDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeFormatterBuilder;
import java.time.format.DateTimeParseException;
import java.time.format.ResolverStyle;
import java.time.temporal.ChronoField;
import java.util.*;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Supplier;

/**
 * ABI Java 服务端数据采集 SDK（语义兼容数数科技 ThinkingData TA Java SDK v3.4）。
 *
 * <p>提供线程安全的行为事件埋点、自定义事件发生时间（显式 {@link Date}/{@link Instant} 重载及属性内
 * {@code #time}/{@code $time} 自动提取）、动静态公共事件属性管理（{@code setSuperProperties} /
 * {@code unsetSuperProperty} / {@code getSuperProperties} / {@code clearSuperProperties} /
 * {@code setDynamicSuperProperties}）、双 ID（{@code loginId} + {@code distinctId}）流式自动身份绑定、
 * 可变事件生命周期更新（{@code trackUpdate} / {@code trackOverwrite}），以及完整的用户画像变更能力
 * （{@code $user_set}、{@code $user_set_once}、{@code $user_add}、{@code $user_unset}、
 * {@code $user_append}、{@code $user_uniq_append}、{@code $user_del}）。
 *
 * <h3>1. 三种消费者初始化示例</h3>
 * <pre>{@code
 * // A. 生产环境推荐：异步批量 HTTP 上报消费者（支持 Gzip 压缩与指数退避幂等重试）
 * BatchConsumer.Config config = new BatchConsumer.Config(
 *     "https://collect.example.com",
 *     101L,
 *     "abi_prod_token_xxx"
 * );
 * config.batchSize = 50;
 * config.flushIntervalMs = 2000L;
 * config.compressGzip = true;
 * AbiAnalytics sdk = new AbiAnalytics(new BatchConsumer(config));
 *
 * // B. 研发联调与 CI 门禁：同步在线严格 Schema / Dry-Run 预检消费者
 * AbiAnalytics debugSdk = new AbiAnalytics(
 *     new DebugConsumer("http://127.0.0.1:8081", 101L, "abi_dev_token", true)
 * );
 *
 * // C. 高吞吐离线落盘：按 UTC 日期轮转本地 JSONL 文件（供 Filebeat / Vector / LogBus 旁路采集）
 * AbiAnalytics loggerSdk = new AbiAnalytics(
 *     new LoggerConsumer(new File("/var/log/abi"), "abi_track")
 * );
 * }</pre>
 *
 * <h3>2. 端到端埋点与用户画像示例</h3>
 * <pre>{@code
 * try (AbiAnalytics sdk = new AbiAnalytics(new BatchConsumer(config))) {
 *     // 注册全局静态公共属性
 *     sdk.setSuperProperties(Map.of("app_env", "prod", "service_region", "ap-east-1"));
 *
 *     // 访客浏览 -> 双 ID 自动身份绑定并上报实名支付订单（支持 #time 或显式时间重载）
 *     sdk.track("", "vis_dev_01", "ProductViewed", Map.of("sku_id", "SKU_99"));
 *     sdk.track("user_8848", "vis_dev_01", "OrderPaid", Map.of(
 *         "order_id", 9007199254740999L, // 超过 2^53-1 的雪花长整型自动序列化为安全字符串
 *         "amount", 299.00,
 *         "paid_at", Instant.now()
 *     ), Instant.now());
 *
 *     // 更新用户画像（兼容 #time 指定画像操作时间；$user_* 事件自动排除公共属性）
 *     sdk.userSet("user_8848", "vis_dev_01", Map.of(
 *         "vip_tier", "gold",
 *         "#time", new Date()
 *     ));
 *     sdk.flush();
 * }
 * }</pre>
 *
 * @see com.anylink.abi.sdk.examples.AbiJavaSdkDemo
 */
public class AbiAnalytics implements Closeable {
    /**
     * 区分秒级与毫秒级整型的阈值（{@code 10^11}）：小于该值的正整数按秒级时间戳乘以 1000 转为毫秒，
     * 大于等于该值的整数直接按毫秒级时间戳处理。
     */
    private static final long SECONDS_TIMESTAMP_UPPER_BOUND = 100_000_000_000L;

    private static final DateTimeFormatter SPACE_DATETIME_FORMATTER = new DateTimeFormatterBuilder()
            .appendPattern("uuuu-MM-dd HH:mm:ss")
            .optionalStart()
            .appendFraction(ChronoField.NANO_OF_SECOND, 1, 9, true)
            .optionalEnd()
            .toFormatter()
            .withResolverStyle(ResolverStyle.STRICT);

    private static final DateTimeFormatter ISO_LOCAL_DATETIME_FORMATTER = new DateTimeFormatterBuilder()
            .appendPattern("uuuu-MM-dd'T'HH:mm:ss")
            .optionalStart()
            .appendFraction(ChronoField.NANO_OF_SECOND, 1, 9, true)
            .optionalEnd()
            .toFormatter()
            .withResolverStyle(ResolverStyle.STRICT);

    private final Consumer consumer;
    private final Map<String, Object> superProperties = new ConcurrentHashMap<>();
    private volatile Supplier<Map<String, Object>> dynamicSuperProperties;

    /**
     * 使用指定的底层事件消费者创建 {@link AbiAnalytics} 实例。
     *
     * <pre>{@code
     * // 初始化异步批量上报客户端（建议在服务端作为全局单例复用）
     * BatchConsumer.Config cfg = new BatchConsumer.Config("http://127.0.0.1:8081", 1L, "abi_token");
     * AbiAnalytics sdk = new AbiAnalytics(new BatchConsumer(cfg));
     * }</pre>
     *
     * @param consumer 非空的事件消费者实现（{@link BatchConsumer}、{@link DebugConsumer} 或 {@link LoggerConsumer}）
     */
    public AbiAnalytics(Consumer consumer) {
        if (consumer == null) {
            throw new IllegalArgumentException("consumer must not be null");
        }
        this.consumer = consumer;
    }

    /**
     * 注册全局静态公共属性，自动合并到后续每一条非用户画像的行为事件中。
     * 注意：{@code $user_*} 系列用户画像事件会自动排除公共属性。
     *
     * <pre>{@code
     * // 注册应用版本、微服务名称与部署地域等静态公共属性
     * sdk.setSuperProperties(Map.of(
     *     "$app_version", "2.4.0",
     *     "service_name", "checkout-service",
     *     "deploy_region", "cn-shanghai"
     * ));
     * }</pre>
     *
     * @param props 待校验并合并的静态公共属性键值对
     */
    public void setSuperProperties(Map<String, Object> props) {
        Map<String, Object> sanitized = AbiValidator.sanitizeProperties(props);
        this.superProperties.putAll(sanitized);
    }

    /**
     * 移除指定名称的静态公共事件属性。若该属性名未注册则安全忽略。
     *
     * <pre>{@code
     * // 移除已注册的静态公共属性 deploy_region
     * sdk.unsetSuperProperty("deploy_region");
     * }</pre>
     *
     * @param key 待移除的静态公共属性名称（不可为 {@code null} 或空白字符串）
     * @throws IllegalArgumentException 当 {@code key} 为空或空白字符串时抛出
     */
    public void unsetSuperProperty(String key) {
        if (key == null || key.trim().isEmpty()) {
            throw new IllegalArgumentException("property key must not be null or empty");
        }
        this.superProperties.remove(key.trim());
    }

    /**
     * 获取当前已注册的全部静态公共事件属性快照（返回防御性拷贝，外部修改不会影响 SDK 内部状态）。
     *
     * <pre>{@code
     * // 读取当前静态公共属性副本用于诊断日志
     * Map<String, Object> currentSuperProps = sdk.getSuperProperties();
     * }</pre>
     *
     * @return 当前静态公共属性的 {@link LinkedHashMap} 防御性拷贝
     */
    public Map<String, Object> getSuperProperties() {
        return new LinkedHashMap<>(this.superProperties);
    }

    /**
     * 清空已注册的全部静态公共属性。
     *
     * <pre>{@code
     * // 清空当前实例已缓存的所有静态公共属性
     * sdk.clearSuperProperties();
     * }</pre>
     */
    public void clearSuperProperties() {
        this.superProperties.clear();
    }

    /**
     * 注册动态公共属性回调函数，在每次上报行为事件（{@link #track}）时实时求值注入。
     * 属性合并覆盖优先级：{@code superProperties < dynamicSuperProperties < eventProperties}；
     * 注意：{@code $user_*} 与 {@code #user_*} 用户画像事件不会注入静态或动态公共属性。
     *
     * <pre>{@code
     * // 每次埋点时动态采集当前 JVM 空闲内存与链路追踪时间
     * sdk.setDynamicSuperProperties(() -> Map.of(
     *     "jvm_free_mem_mb", Runtime.getRuntime().freeMemory() / (1024 * 1024),
     *     "trace_time", Instant.now()
     * ));
     * }</pre>
     *
     * @param supplier 线程安全的动态属性提供函数（传 {@code null} 可取消注册）
     */
    public void setDynamicSuperProperties(Supplier<Map<String, Object>> supplier) {
        this.dynamicSuperProperties = supplier;
    }

    /**
     * 上报一条用户行为事件，并自动生成随机 UUID 作为 {@code event_id}。
     * 若 {@code properties} 中包含 {@code "#time"} 或 {@code "$time"}，将自动提取为顶层 {@code timestamp}
     * 并从 {@code properties} 中剥离（兼容数数 ThinkingData Java SDK 写法）。
     *
     * <pre>{@code
     * // 上报订单创建行为事件（雪花 ID 与 Instant 时间会自动执行安全转换）
     * String eventId = sdk.track(
     *     "user_1001",
     *     "vis_device_99",
     *     "OrderCreated",
     *     Map.of(
     *         "order_id", 9007199254740999L,
     *         "pay_amount", 199.50,
     *         "currency", "CNY",
     *         "items", List.of("sku_101", "sku_102"),
     *         "created_at", Instant.now()
     *     )
     * );
     * }</pre>
     *
     * @param loginId    已认证登录账号标识（最大 128 UTF-8 字节；未登录访客传 {@code ""} 或 {@code null}）
     * @param distinctId 访客或设备标识（最大 64 UTF-8 字节；纯后端任务仅有账号 ID 时可传 {@code ""} 或 {@code null}）
     * @param eventName  合法的自定义事件名或系统预置白名单事件名（如 {@code OrderCreated}、{@code $pageview}）
     * @param properties 事件自定义属性与系统预置属性集合（可选携带 {@code #time} / {@code $time}）
     * @return 最终生效的 {@code event_id}
     * @throws Exception 参数校验不通过或消费者写入失败时抛出
     */
    public String track(
            String loginId,
            String distinctId,
            String eventName,
            Map<String, Object> properties
    ) throws Exception {
        return trackWithId(loginId, distinctId, eventName, null, properties, null);
    }

    /**
     * 上报一条指定历史或自定义发生时间（{@link Date}）的用户行为事件。
     * 当显式传入非空 {@code eventTime} 时，顶层 {@code timestamp} 以 {@code eventTime} 为准；
     * {@code properties} 中的 {@code "#time"} 与 {@code "$time"} 仍会被校验并自动移除。
     *
     * <pre>{@code
     * // 补采指定历史 Date 时刻发生的订单创建事件
     * String eventId = sdk.track(
     *     "user_1001",
     *     "vis_device_99",
     *     "OrderCreated",
     *     Map.of("amount", 199.50),
     *     new Date(1762740000000L)
     * );
     * }</pre>
     *
     * @param loginId    已认证登录账号标识（最大 128 UTF-8 字节）
     * @param distinctId 访客或设备标识（最大 64 UTF-8 字节）
     * @param eventName  事件名称
     * @param properties 事件属性集合
     * @param eventTime  显式指定的事件发生时间（传 {@code null} 时回退至 {@code #time}/{@code $time} 或当前系统时间）
     * @return 最终生效的 {@code event_id}
     * @throws Exception 参数校验不通过或消费者写入失败时抛出
     */
    public String track(
            String loginId,
            String distinctId,
            String eventName,
            Map<String, Object> properties,
            Date eventTime
    ) throws Exception {
        return trackWithId(
                loginId,
                distinctId,
                eventName,
                null,
                properties,
                eventTime != null ? eventTime.toInstant() : null
        );
    }

    /**
     * 上报一条指定历史或自定义发生时间（{@link Instant}）的用户行为事件。
     * 当显式传入非空 {@code eventTime} 时，顶层 {@code timestamp} 以 {@code eventTime} 为准；
     * {@code properties} 中的 {@code "#time"} 与 {@code "$time"} 仍会被校验并自动移除。
     *
     * <pre>{@code
     * // 使用精确 Instant 指定事件发生时间上报行为事件
     * String eventId = sdk.track(
     *     "user_1001",
     *     "vis_device_99",
     *     "OrderCreated",
     *     Map.of("amount", 199.50),
     *     Instant.parse("2026-11-10T02:15:30Z")
     * );
     * }</pre>
     *
     * @param loginId    已认证登录账号标识（最大 128 UTF-8 字节）
     * @param distinctId 访客或设备标识（最大 64 UTF-8 字节）
     * @param eventName  事件名称
     * @param properties 事件属性集合
     * @param eventTime  显式指定的事件发生时间（传 {@code null} 时回退至 {@code #time}/{@code $time} 或当前系统时间）
     * @return 最终生效的 {@code event_id}
     * @throws Exception 参数校验不通过或消费者写入失败时抛出
     */
    public String track(
            String loginId,
            String distinctId,
            String eventName,
            Map<String, Object> properties,
            Instant eventTime
    ) throws Exception {
        return trackWithId(loginId, distinctId, eventName, null, properties, eventTime);
    }

    /**
     * 保留方法签名，但在当前版本显式抛出 {@link UnsupportedOperationException} 且不入队任何事件（D7① / G6 门禁）。
     * @deprecated [当前版本未开放 / Unsupported in current version]
     * 严守 D7① / G6 门禁，当前 StarRocks dwd_events 存储模型尚未开放首次去重支持；如需同日重试幂等请使用 {@link #trackWithId}。
     */
    @Deprecated
    public String trackFirst(
            String loginId,
            String distinctId,
            String eventName,
            String firstCheckId,
            Map<String, Object> properties
    ) throws Exception {
        throw new UnsupportedOperationException(
                "trackFirst is unsupported in current version (D7① / G6 gate); use trackWithId for same-day idempotency"
        );
    }

    /**
     * 使用显式指定的确定性 {@code eventId} 上报用户行为事件（适用于同一事件日期分区内的消息重试幂等去重）。
     *
     * <pre>{@code
     * // 使用业务唯一主键作为确定性 eventId 上报初始订单状态
     * String eventId = sdk.trackWithId(
     *     "user_1001",
     *     "vis_device_99",
     *     "OrderState",
     *     "evt_order_20261110_001",
     *     Map.of("order_status", "created", "amount", 199.50)
     * );
     * }</pre>
     *
     * @param loginId    已认证登录账号标识（最大 128 UTF-8 字节）
     * @param distinctId 访客或设备标识（最大 64 UTF-8 字节）
     * @param eventName  事件名称
     * @param eventId    显式指定的事件 ID（传 {@code null} 或空白字符串时自动生成 UUID）
     * @param properties 事件属性键值对
     * @return 最终生效的 {@code event_id}
     * @throws Exception 参数校验不通过或消费者写入失败时抛出
     */
    public String trackWithId(
            String loginId,
            String distinctId,
            String eventName,
            String eventId,
            Map<String, Object> properties
    ) throws Exception {
        return trackWithId(loginId, distinctId, eventName, eventId, properties, null);
    }

    /**
     * 使用显式指定的确定性 {@code eventId} 与事件发生时间（{@link Instant}）上报用户行为事件。
     *
     * <p>时间解析优先级：显式非空 {@code eventTime} &gt; {@code properties["#time"]} &gt;
     * {@code properties["$time"]} &gt; {@link System#currentTimeMillis()}。{@code "#time"} 与 {@code "$time"}
     * 支持 {@link Date}、{@link Instant}、{@link Long}/{@link Integer}（毫秒或秒级时间戳）、
     * ISO-8601 字符串及 {@code "yyyy-MM-dd HH:mm:ss"} 字符串，并在校验后自动从上报 {@code properties} 中移除。
     *
     * <pre>{@code
     * // 同时指定幂等 eventId 与事件发生时间 Instant
     * String eventId = sdk.trackWithId(
     *     "user_1001",
     *     "vis_device_99",
     *     "OrderState",
     *     "evt_order_20261110_001",
     *     Map.of("order_status", "created", "amount", 199.50),
     *     Instant.parse("2026-11-10T02:15:30Z")
     * );
     * }</pre>
     *
     * @param loginId    已认证登录账号标识（最大 128 UTF-8 字节）
     * @param distinctId 访客或设备标识（最大 64 UTF-8 字节）
     * @param eventName  事件名称
     * @param eventId    显式指定的事件 ID（传 {@code null} 或空白字符串时自动生成 UUID）
     * @param properties 事件属性键值对
     * @param eventTime  显式指定的事件发生时间（传 {@code null} 时提取 {@code #time}/{@code $time} 或取当前时间）
     * @return 最终生效的 {@code event_id}
     * @throws Exception 参数校验不通过或消费者写入失败时抛出
     */
    public String trackWithId(
            String loginId,
            String distinctId,
            String eventName,
            String eventId,
            Map<String, Object> properties,
            Instant eventTime
    ) throws Exception {
        String[] pair = AbiValidator.normalizeIdentityPair(distinctId, loginId);
        String normDistinct = pair[0];
        String normLogin = pair[1];

        String normEvent = AbiValidator.validateEventName(eventName);
        boolean isUserEvent = normEvent.startsWith("$user_") || normEvent.startsWith("#user_");
        String resolvedEventId = (eventId != null && !eventId.isBlank())
                ? AbiValidator.normalizeIdentity(eventId, AbiValidator.MAX_EVENT_ID_BYTES, "event_id")
                : UUID.randomUUID().toString();

        Long propTimestampMs = null;
        Map<String, Object> propsWithoutTime = null;
        if (properties != null && !properties.isEmpty()) {
            propsWithoutTime = new LinkedHashMap<>(properties.size());
            boolean hasHashTime = false;
            for (Map.Entry<String, Object> entry : properties.entrySet()) {
                String rawKey = entry.getKey();
                String trimmedKey = rawKey != null ? rawKey.trim() : null;
                if ("#time".equals(trimmedKey)) {
                    propTimestampMs = parseTimeValue("#time", entry.getValue());
                    hasHashTime = true;
                } else if ("$time".equals(trimmedKey)) {
                    long dollarTimeMs = parseTimeValue("$time", entry.getValue());
                    if (!hasHashTime) {
                        propTimestampMs = dollarTimeMs;
                    }
                } else {
                    propsWithoutTime.put(rawKey, entry.getValue());
                }
            }
        }

        final long resolvedTimestamp;
        if (eventTime != null) {
            try {
                resolvedTimestamp = eventTime.toEpochMilli();
            } catch (ArithmeticException ex) {
                throw new IllegalArgumentException("invalid eventTime: " + eventTime, ex);
            }
            if (resolvedTimestamp <= 0) {
                throw new IllegalArgumentException("eventTime must be positive epoch millis: " + resolvedTimestamp);
            }
        } else if (propTimestampMs != null) {
            resolvedTimestamp = propTimestampMs;
        } else {
            resolvedTimestamp = System.currentTimeMillis();
        }

        Map<String, Object> mergedProps = new LinkedHashMap<>();
        if (!isUserEvent) {
            mergedProps.putAll(superProperties);
            Supplier<Map<String, Object>> dyn = this.dynamicSuperProperties;
            if (dyn != null) {
                Map<String, Object> dynProps = dyn.get();
                if (dynProps != null) {
                    mergedProps.putAll(AbiValidator.sanitizeProperties(dynProps));
                }
            }
        }
        if (propsWithoutTime != null && !propsWithoutTime.isEmpty()) {
            mergedProps.putAll(AbiValidator.sanitizeProperties(propsWithoutTime));
        }

        Map<String, Object> record = new LinkedHashMap<>();
        record.put("event_id", resolvedEventId);
        record.put("event_name", normEvent);
        record.put("distinct_id", normDistinct);
        if (!normLogin.isEmpty()) {
            record.put("login_id", normLogin);
        }
        record.put("timestamp", resolvedTimestamp);
        record.put("properties", mergedProps);

        consumer.add(record);
        return resolvedEventId;
    }

    /**
     * 保留方法签名，但在当前版本显式抛出 {@link UnsupportedOperationException} 且不入队任何事件（D7① / G6 门禁）。
     *
     * @deprecated [当前版本未开放 / Unsupported in current version]
     * 严守 D7① / G6 门禁，当前 StarRocks dwd_events 存储模型尚未开放局部更新支持，禁止伪装成普通 track 覆盖抹掉其他属性。
     */
    @Deprecated
    public String trackUpdate(
            String loginId,
            String distinctId,
            String eventName,
            String eventId,
            Map<String, Object> properties
    ) throws Exception {
        throw new UnsupportedOperationException(
                "trackUpdate is unsupported in current version (D7① / G6 gate); use trackWithId for same-day idempotency"
        );
    }

    /**
     * 保留方法签名，但在当前版本显式抛出 {@link UnsupportedOperationException} 且不入队任何事件（D7① / G6 门禁）。
     *
     * @deprecated [当前版本未开放 / Unsupported in current version]
     * 严守 D7① / G6 门禁，当前 StarRocks dwd_events 存储模型尚未开放跨分区覆盖重写支持。
     */
    @Deprecated
    public String trackOverwrite(
            String loginId,
            String distinctId,
            String eventName,
            String eventId,
            Map<String, Object> properties
    ) throws Exception {
        throw new UnsupportedOperationException(
                "trackOverwrite is unsupported in current version (D7① / G6 gate); use trackWithId for same-day idempotency"
        );
    }

    /**
     * 设置或覆盖用户画像属性（对应系统事件 {@code $user_set}）。
     * 若 {@code properties} 中包含 {@code "#time"} 或 {@code "$time"}，会自动提取为顶层事件时间戳并从画像属性中移除。
     *
     * <pre>{@code
     * // 更新用户昵称、会员等级与操作发生时间（兼容数数 ThinkingData #time 写法）
     * sdk.userSet(
     *     "user_1001",
     *     "vis_device_99",
     *     Map.of("nickname", "Alice", "vip_tier", "platinum", "city", "Shanghai", "#time", new Date())
     * );
     * }</pre>
     */
    public String userSet(String loginId, String distinctId, Map<String, Object> properties) throws Exception {
        return track(loginId, distinctId, "$user_set", properties);
    }

    /**
     * 仅在用户画像属性尚未设置时写入初始值（对应系统事件 {@code $user_set_once}），
     * 适用于首次获客渠道、注册时间等不可覆盖属性。
     *
     * <pre>{@code
     * // 记录首次广告来源与注册时间（若已有值则忽略后续更新）
     * sdk.userSetOnce(
     *     "user_1001",
     *     "vis_device_99",
     *     Map.of("first_utm_source", "google_ads", "registered_at", Instant.now())
     * );
     * }</pre>
     */
    public String userSetOnce(String loginId, String distinctId, Map<String, Object> properties) throws Exception {
        return track(loginId, distinctId, "$user_set_once", properties);
    }

    /**
     * 对数值型用户画像属性执行原子增减累加（对应系统事件 {@code $user_add}，传入负数表示扣减）。
     *
     * <pre>{@code
     * // 原子增加用户积分与累计消费金额
     * sdk.userAdd(
     *     "user_1001",
     *     "vis_device_99",
     *     Map.of("loyalty_points", 50, "total_spent", 199.50)
     * );
     * }</pre>
     */
    public String userAdd(String loginId, String distinctId, Map<String, Number> properties) throws Exception {
        Map<String, Object> cast = new LinkedHashMap<>();
        if (properties != null) {
            for (Map.Entry<String, Number> e : properties.entrySet()) {
                if (e.getValue() == null) {
                    throw new IllegalArgumentException("userAdd property " + e.getKey() + " must be non-null numeric");
                }
                cast.put(e.getKey(), e.getValue());
            }
        }
        return track(loginId, distinctId, "$user_add", cast);
    }

    /**
     * 清空一个或多个指定的用户画像属性（对应系统事件 {@code $user_unset}）。
     *
     * <pre>{@code
     * // 清理用户已过期的临时优惠券标记与试用标识
     * sdk.userUnset("user_1001", "vis_device_99", "temp_coupon_code", "trial_flag");
     * }</pre>
     */
    public String userUnset(String loginId, String distinctId, String... keys) throws Exception {
        Map<String, Object> props = new LinkedHashMap<>();
        for (String key : keys) {
            AbiValidator.validatePropertyKey(key);
            props.put(key, 0);
        }
        return track(loginId, distinctId, "$user_unset", props);
    }

    /**
     * 向列表类型的用户画像属性追加元素，不执行去重（对应系统事件 {@code $user_append}）。
     *
     * <pre>{@code
     * // 追加用户近期浏览过的商品类目
     * sdk.userAppend(
     *     "user_1001",
     *     "vis_device_99",
     *     Map.of("recent_categories", List.of("electronics", "books"))
     * );
     * }</pre>
     */
    public String userAppend(String loginId, String distinctId, Map<String, List<Object>> properties) throws Exception {
        Map<String, Object> cast = properties != null ? new LinkedHashMap<>(properties) : Collections.emptyMap();
        return track(loginId, distinctId, "$user_append", cast);
    }

    /**
     * 向列表类型的用户画像属性追加元素并执行集合去重（对应系统事件 {@code $user_uniq_append}）。
     *
     * <pre>{@code
     * // 去重追加用户已获得的成就勋章列表
     * sdk.userUniqAppend(
     *     "user_1001",
     *     "vis_device_99",
     *     Map.of("owned_badges", List.of("early_adopter", "vip_2026"))
     * );
     * }</pre>
     */
    public String userUniqAppend(String loginId, String distinctId, Map<String, List<Object>> properties) throws Exception {
        Map<String, Object> cast = properties != null ? new LinkedHashMap<>(properties) : Collections.emptyMap();
        return track(loginId, distinctId, "$user_uniq_append", cast);
    }

    /**
     * 标记删除当前用户的画像记录（对应系统事件 {@code $user_del}）。
     *
     * <pre>{@code
     * // 用户注销账号时清理其画像数据
     * sdk.userDelete("user_1001", "vis_device_99");
     * }</pre>
     */
    public String userDelete(String loginId, String distinctId) throws Exception {
        return track(loginId, distinctId, "$user_del", Collections.emptyMap());
    }

    /**
     * 强制底层消费者立即将缓冲区中的所有待上报事件刷新发送或落盘。
     *
     * <pre>{@code
     * // 批处理作业结束前主动刷新缓冲区
     * sdk.flush();
     * }</pre>
     */
    public void flush() throws Exception {
        consumer.flush();
    }

    /**
     * 刷新所有缓冲中的待发送事件，并安全关闭释放底层消费者线程与连接资源。
     */
    @Override
    public void close() {
        consumer.close();
    }

    private static long parseTimeValue(String key, Object raw) {
        if (raw == null) {
            throw new IllegalArgumentException(key + " must not be null");
        }
        if (raw instanceof Date) {
            long ms = ((Date) raw).getTime();
            if (ms <= 0) {
                throw new IllegalArgumentException("invalid " + key + " Date timestamp: " + ms);
            }
            return ms;
        }
        if (raw instanceof Instant) {
            final long ms;
            try {
                ms = ((Instant) raw).toEpochMilli();
            } catch (ArithmeticException ex) {
                throw new IllegalArgumentException("invalid " + key + " Instant value: " + raw, ex);
            }
            if (ms <= 0) {
                throw new IllegalArgumentException("invalid " + key + " Instant timestamp: " + ms);
            }
            return ms;
        }
        if (raw instanceof Long || raw instanceof Integer) {
            long num = ((Number) raw).longValue();
            if (num <= 0) {
                throw new IllegalArgumentException("invalid " + key + " numeric timestamp: " + num);
            }
            return num < SECONDS_TIMESTAMP_UPPER_BOUND ? num * 1000L : num;
        }
        if (raw instanceof String) {
            String str = ((String) raw).trim();
            if (str.isEmpty()) {
                throw new IllegalArgumentException(key + " string must not be empty");
            }
            Long parsedMs = tryParseTimestampString(str);
            if (parsedMs == null || parsedMs <= 0) {
                throw new IllegalArgumentException("invalid " + key + " string value: " + raw);
            }
            return parsedMs;
        }
        throw new IllegalArgumentException("unsupported " + key + " type: " + raw.getClass().getName());
    }

    private static Long tryParseTimestampString(String str) {
        try {
            return Instant.parse(str).toEpochMilli();
        } catch (DateTimeParseException | ArithmeticException ignored) {
        }

        try {
            return ZonedDateTime.parse(str, DateTimeFormatter.ISO_ZONED_DATE_TIME).toInstant().toEpochMilli();
        } catch (DateTimeParseException | ArithmeticException ignored) {
        }

        try {
            return OffsetDateTime.parse(str, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toInstant().toEpochMilli();
        } catch (DateTimeParseException | ArithmeticException ignored) {
        }

        if (str.length() > 19 && str.charAt(10) == ' ') {
            String normalizedIso = str.substring(0, 10) + 'T' + str.substring(11);
            try {
                return OffsetDateTime.parse(normalizedIso, DateTimeFormatter.ISO_OFFSET_DATE_TIME).toInstant().toEpochMilli();
            } catch (DateTimeParseException | ArithmeticException ignored) {
            }
        }

        try {
            return LocalDateTime.parse(str, SPACE_DATETIME_FORMATTER)
                    .atZone(ZoneId.systemDefault())
                    .toInstant()
                    .toEpochMilli();
        } catch (DateTimeParseException | ArithmeticException ignored) {
        }

        try {
            return LocalDateTime.parse(str, ISO_LOCAL_DATETIME_FORMATTER)
                    .atZone(ZoneId.systemDefault())
                    .toInstant()
                    .toEpochMilli();
        } catch (DateTimeParseException | ArithmeticException ignored) {
        }

        return null;
    }
}
