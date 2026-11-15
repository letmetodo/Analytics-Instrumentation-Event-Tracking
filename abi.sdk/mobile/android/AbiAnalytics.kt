package com.anylink.abi.sdk.android

import android.content.Context
import android.content.SharedPreferences
import android.os.Build
import android.os.SystemClock
import org.json.JSONArray
import org.json.JSONObject
import java.io.OutputStreamWriter
import java.net.HttpURLConnection
import java.net.URL
import java.nio.charset.StandardCharsets
import java.util.Calendar
import java.util.Date
import java.util.GregorianCalendar
import java.util.Locale
import java.util.TimeZone
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit

/**
 * ABI Android Kotlin 数据采集分析 SDK（严格对齐 ThinkingData 数数科技规范）。
 *
 * 提供线程安全的双标识身份管理（`distinct_id` 访客/设备 ID 与 `login_id` 登录账号 ID，
 * 通过 `identify`、`login`、`logout` 纯本地状态更新并可选持久化至 `SharedPreferences`）、全局静态与动态公共属性、
 * 单调时钟事件计时（`timeEvent`）、同日固定 `eventId` 幂等重放，
 * 以及全套用户画像变更操作（`$user_set`、`$user_set_once`、`$user_add`、`$user_unset`、
 * `$user_append`、`$user_uniq_append`、`$user_del`）。
 *
 * ### 快速上手示例
 * ```kotlin
 * val sdk = AbiAnalytics.init(
 *     serverUrl = "http://10.0.2.2:8081",
 *     projectId = 1L,
 *     projectToken = "abi_tok_android_demo",
 *     appVersion = "2.1.0",
 *     batchSize = 20,
 *     debug = true,
 *     context = applicationContext
 * )
 *
 * // 1. 访客标识设置、公共属性注册与登录账号设置（纯本地状态切换，不触发网络事件）
 * sdk.identify("android_visitor_device_001")
 * sdk.setSuperProperties(mapOf("channel" to "GooglePlay", "vip_tier" to "Gold"))
 * sdk.login("user_android_10001")
 *
 * // 2. 事件秒表计时与同日固定 eventId 幂等上报
 * sdk.timeEvent("OrderPaid")
 * sdk.track("OrderPaid", mapOf("order_id" to "ord_9001", "amount" to 199.95), eventId = "evt_ord_9001")
 *
 * // 3. 用户画像变更与立即批量上报
 * sdk.userSet(mapOf("city" to "Shanghai"))
 * sdk.userAdd(mapOf("points" to 100))
 * sdk.flush()
 * ```
 */
class AbiAnalytics private constructor(
    private val serverUrl: String,
    private val projectId: Long,
    private val projectToken: String,
    private val appVersion: String = "1.0.0",
    private val batchSize: Int = 20,
    private val debug: Boolean = false,
    private val autoFlush: Boolean = true,
    private val prefs: SharedPreferences? = null
) {
    companion object {
        const val MAX_DISTINCT_ID_BYTES = 64
        const val MAX_LOGIN_ID_BYTES = 128
        const val MAX_EVENT_NAME_CHARS = 128
        const val MAX_PROP_KEY_CHARS = 64
        const val MAX_SAFE_INTEGER = 9007199254740991L
        private const val PREF_KEY_DISTINCT_ID = "distinct_id"
        private const val PREF_KEY_LOGIN_ID = "login_id"
        private val IDENTIFIER_REGEX = Regex("^[A-Za-z_][A-Za-z0-9_]*$")
        private val DIGITS_EPOCH_REGEX = Regex("^\\d{10,16}$")
        private val ISO_DATETIME_REGEX = Regex(
            "^(\\d{4})-(\\d{2})-(\\d{2})[Tt ](\\d{2}):(\\d{2}):(\\d{2})(?:\\.(\\d{1,9}))?(Z|z|[+-]\\d{2}:?\\d{2})?$"
        )
        private val SYSTEM_EVENTS = setOf(
            "\$signup", "\$login", "\$pageview",
            "\$AppStart", "\$AppEnd", "\$AppClick", "\$AppViewScreen",
            "\$user_set", "#user_set",
            "\$user_set_once", "#user_set_once",
            "\$user_add", "#user_add",
            "\$user_unset", "#user_unset",
            "\$user_append", "#user_append",
            "\$user_uniq_append", "#user_uniq_append",
            "\$user_del", "#user_del"
        )
        private val SYSTEM_PROPS = setOf(
            "\$os", "#os", "os",
            "\$os_version", "#os_version", "os_version",
            "\$app_version", "#app_version", "app_version",
            "\$browser", "#browser", "browser",
            "\$browser_version", "#browser_version", "browser_version",
            "\$city", "#city", "city",
            "\$province", "#province", "province",
            "\$country", "#country", "country",
            "\$country_code", "#country_code", "country_code",
            "\$ip", "#ip", "ip",
            "\$network", "#network", "network",
            "\$network_type", "#network_type", "network_type",
            "\$platform", "#platform", "platform",
            "\$device_id", "#device_id", "device_id",
            "\$session_id", "#session_id", "session_id",
            "\$screen_width", "#screen_width", "screen_width",
            "\$screen_height", "#screen_height", "screen_height",
            "\$model", "#model", "model",
            "\$device_model", "#device_model", "device_model",
            "\$manufacturer", "#manufacturer", "manufacturer",
            "\$carrier", "#carrier", "carrier",
            "\$url", "#url", "url",
            "\$url_path", "#url_path", "url_path",
            "\$referrer", "#referrer", "referrer",
            "\$title", "#title", "title",
            "\$duration", "#duration", "duration",
            "\$lib", "#lib", "lib",
            "\$lib_version", "#lib_version", "lib_version",
            "\$zone_offset", "#zone_offset", "zone_offset",
            "\$first_check_id", "#first_check_id", "first_check_id"
        )

        @Volatile
        private var instance: AbiAnalytics? = null

        /**
         * 初始化全局单例 [AbiAnalytics] 实例。
         * 当 [autoFlush] 为 `true`（默认）时启动 5 秒周期的后台批量刷新线程；
         * 当 [autoFlush] 为 `false` 时禁用后台定时刷新与 [track] 自动触发，由调用方手动确认提交。
         *
         * ```kotlin
         * val sdk = AbiAnalytics.init(
         *     serverUrl = "http://10.0.2.2:8081", // Android 模拟器访问宿主机网关地址
         *     projectId = 1L,
         *     projectToken = "abi_tok_android_demo",
         *     autoFlush = false
         * )
         * ```
         */
        @JvmStatic
        @JvmOverloads
        fun init(
            serverUrl: String,
            projectId: Long,
            projectToken: String,
            appVersion: String = "1.0.0",
            batchSize: Int = 20,
            debug: Boolean = false,
            autoFlush: Boolean = true,
            context: Context? = null
        ): AbiAnalytics {
            instance?.executor?.shutdownNow()
            val sharedPrefs = context?.applicationContext?.getSharedPreferences(
                "abi_sdk_$projectId",
                Context.MODE_PRIVATE
            )
            return AbiAnalytics(
                serverUrl.trimEnd('/'),
                projectId,
                projectToken.trim(),
                appVersion,
                batchSize,
                debug,
                autoFlush,
                sharedPrefs
            ).also {
                instance = it
            }
        }

        /**
         * 获取已初始化的全局单例 [AbiAnalytics] 实例；若尚未调用 [init] 则抛出 [IllegalStateException]。
         */
        @JvmStatic
        fun getInstance(): AbiAnalytics =
            instance ?: throw IllegalStateException("AbiAnalytics.init(...) must be called first")
    }

    /**
     * 当前访客/设备标识 `distinct_id`（初始化自动生成 UUIDv4 并持久化至 `distinct_id` 键，仅通过 [identify] 修改，不受 [login] 覆盖）。
     */
    @Volatile
    var distinctId: String = ""
        private set

    /**
     * 当前已设置的实名登录账号标识 `login_id`（未登录时为空字符串）。
     */
    @Volatile
    var loginId: String = ""
        private set

    /** 内存队列中当前待提交的事件条数。 */
    val pendingQueueSize: Int
        get() = queue.size

    /** 最近一次 [flush] 请求返回的 HTTP 状态码（网络不可达时为 0）。 */
    @Volatile
    var lastFlushStatusCode: Int = 0
        private set

    /** 最近一次 [flush] 请求返回的响应体或错误信息。 */
    @Volatile
    var lastFlushResponseBody: String = ""
        private set

    private val superProperties = ConcurrentHashMap<String, Any>()

    @Volatile
    private var dynamicSuperPropsProvider: (() -> Map<String, Any?>)? = null

    private val timers = ConcurrentHashMap<String, Long>()
    private val queue = ConcurrentLinkedQueue<JSONObject>()
    private val executor = Executors.newSingleThreadScheduledExecutor()

    init {
        val savedDistinct = prefs?.getString(PREF_KEY_DISTINCT_ID, null)?.let {
            runCatching { normalizeIdentity(it, MAX_DISTINCT_ID_BYTES, "distinct_id") }.getOrNull()
        }
        distinctId = if (savedDistinct != null) {
            savedDistinct
        } else {
            UUID.randomUUID().toString().also { generated ->
                prefs?.edit()?.putString(PREF_KEY_DISTINCT_ID, generated)?.apply()
            }
        }
        loginId = prefs?.getString(PREF_KEY_LOGIN_ID, null)?.let {
            runCatching { normalizeIdentity(it, MAX_LOGIN_ID_BYTES, "login_id") }.getOrNull()
        } ?: ""

        if (autoFlush) {
            executor.scheduleWithFixedDelay({ flush() }, 5, 5, TimeUnit.SECONDS)
        }
    }

    /**
     * 清空内存缓冲队列中尚未上报的所有待发事件。
     */
    fun clearPendingQueue() {
        queue.clear()
    }

    /**
     * 构造当前待提交给 `POST /collect/api/v1/track/batch` 的完整请求体 JSON 对象
     * （结构：`{ project_id, project_token, debug?, events: [...] }`）。
     */
    fun buildPendingBatchPayload(): JSONObject {
        val eventsArray = JSONArray()
        queue.forEach { eventsArray.put(it) }
        return JSONObject().apply {
            put("project_id", projectId)
            put("project_token", projectToken)
            if (debug) put("debug", true)
            put("events", eventsArray)
        }
    }

    /**
     * 自定义覆盖访客/设备标识 `distinct_id`（UTF-8 编码不超过 64 字节，持久化至本地 `distinct_id` 存储键，不发送网络事件）。
     *
     * ```kotlin
     * sdk.identify("android_visitor_device_001")
     * ```
     */
    fun identify(customDistinctId: String) {
        val norm = normalizeIdentity(customDistinctId, MAX_DISTINCT_ID_BYTES, "distinct_id")
        distinctId = norm
        prefs?.edit()?.putString(PREF_KEY_DISTINCT_ID, norm)?.apply()
    }

    /**
     * 设置实名登录账号标识 `login_id`（UTF-8 编码不超过 128 字节，持久化至本地存储；绝不覆盖 `distinctId`，且不自动触发任何网络事件）。
     *
     * ```kotlin
     * sdk.login("user_android_10001")
     * ```
     */
    fun login(accountId: String) {
        val normLogin = normalizeIdentity(accountId, MAX_LOGIN_ID_BYTES, "login_id")
        loginId = normLogin
        prefs?.edit()?.putString(PREF_KEY_LOGIN_ID, normLogin)?.apply()
    }

    /**
     * 退出登录，清空当前 `loginId` 并保持访客标识 `distinctId` 不变（不发送网络事件）。
     *
     * ```kotlin
     * sdk.logout()
     * ```
     */
    fun logout() {
        loginId = ""
        prefs?.edit()?.remove(PREF_KEY_LOGIN_ID)?.apply()
    }

    /**
     * 设置全局静态公共属性，自动合并到后续所有业务与系统事件中（不含 `$user_*` / `#user_*` 用户画像事件）。
     *
     * ```kotlin
     * sdk.setSuperProperties(mapOf("channel" to "GooglePlay", "ab_bucket" to "B"))
     * ```
     */
    fun setSuperProperties(props: Map<String, Any>) {
        props.forEach { (k, v) ->
            val normKey = validatePropertyKey(k)
            superProperties[normKey] = sanitizeValue(normKey, v)
        }
    }

    /**
     * 按属性名移除单个已注册的全局静态公共属性。
     */
    fun unsetSuperProperty(key: String) {
        val trimmed = key.trim()
        if (trimmed.isNotEmpty()) {
            superProperties.remove(trimmed)
        }
    }

    /**
     * 清空所有已注册的全局静态公共属性。
     */
    fun clearSuperProperties() {
        superProperties.clear()
    }

    /**
     * 获取当前已注册全局静态公共属性的浅拷贝快照。
     */
    fun getSuperProperties(): Map<String, Any> = superProperties.toMap()

    /**
     * 注册（或置空移除）动态公共属性回调函数；每次上报非 `$user_*` / `#user_*` 事件时动态合并，
     * 优先级高于静态公共属性、低于单次事件 `properties`。
     */
    fun setDynamicSuperProperties(provider: (() -> Map<String, Any?>)?) {
        dynamicSuperPropsProvider = provider
    }

    /**
     * 为指定 [eventName] 启动基于单调时钟（`elapsedRealtime`）的计时器；
     * 下一次上报同名 [track] 事件时自动计算并注入秒级 `$duration` 属性。
     *
     * ```kotlin
     * sdk.timeEvent("OrderPaid")
     * sdk.track("OrderPaid", mapOf("amount" to 99.0))
     * ```
     */
    fun timeEvent(eventName: String) {
        val normEvent = validateEventName(eventName)
        timers[normEvent] = SystemClock.elapsedRealtime()
    }

    /**
     * 采集并入队一条自定义业务事件或系统保留事件，返回归一化后的幂等 `event_id`。
     *
     * 支持通过可选参数 [timestampMs] 指定事件发生毫秒时间戳；若 [properties] 中包含 `"#time"` 或 `"$time"`
     * （支持 `java.util.Date`、`Long`、`String`），会自动提取为顶层毫秒 `timestamp` 并在属性校验前剥离。
     * 超出 IEEE-754 安全整数范围（`> 9007199254740991L`）的 `Long` 类型属性会自动序列化为十进制字符串。
     *
     * ```kotlin
     * val evtId = sdk.track(
     *     eventName = "OrderPaid",
     *     properties = mapOf(
     *         "order_id" to "ord_1001",
     *         "amount" to 299.0,
     *         "snowflake_seq" to 9007199254740993L // 自动转为字符串保护大整数精度
     *     )
     * )
     * ```
     */
    @JvmOverloads
    fun track(
        eventName: String,
        properties: Map<String, Any?> = emptyMap(),
        eventId: String? = null,
        timestampMs: Long? = null
    ): String {
        val normEvent = validateEventName(eventName)
        if (timestampMs != null) {
            require(timestampMs > 0L) { "timestampMs must be positive" }
        }
        val isUserEvent = normEvent.startsWith("\$user_") || normEvent.startsWith("#user_")
        val resolvedEventId = if (!eventId.isNullOrBlank()) {
            normalizeIdentity(eventId, 64, "event_id")
        } else {
            UUID.randomUUID().toString()
        }

        var rawTimeVal: Any? = null
        var rawTimeKey: String? = null
        var hasHashTime = false
        val filteredProps = LinkedHashMap<String, Any?>(properties.size)
        properties.forEach { (k, v) ->
            val trimmedKey = k.trim()
            when (trimmedKey) {
                "#time" -> {
                    hasHashTime = true
                    rawTimeKey = "#time"
                    rawTimeVal = v
                }
                "\$time" -> {
                    if (!hasHashTime) {
                        rawTimeKey = "\$time"
                        rawTimeVal = v
                    }
                }
                else -> filteredProps[k] = v
            }
        }
        val extractedTimeMs = if (rawTimeKey != null && rawTimeVal != null) {
            parseTimePropertyMs(rawTimeKey!!, rawTimeVal!!)
        } else {
            null
        }

        val sanitizedCustomProps = LinkedHashMap<String, Any>(filteredProps.size)
        filteredProps.forEach { (k, v) ->
            val normKey = validatePropertyKey(k)
            if (v != null) {
                sanitizedCustomProps[normKey] = sanitizeValue(normKey, v)
            }
        }

        val propsObj = JSONObject().apply {
            if (!isUserEvent) {
                put("\$lib", "abi-android-sdk")
                put("\$lib_version", "1.0.0")
                put("\$os", "Android")
                put("\$os_version", Build.VERSION.RELEASE ?: "")
                put("\$model", Build.MODEL ?: "")
                put("\$manufacturer", Build.MANUFACTURER ?: "")
                put("\$app_version", appVersion)
                superProperties.forEach { (k, v) -> put(k, v) }
                dynamicSuperPropsProvider?.invoke()?.forEach { (k, v) ->
                    val trimmed = k.trim()
                    if (trimmed != "#time" && trimmed != "\$time") {
                        val normKey = validatePropertyKey(k)
                        if (v != null) {
                            put(normKey, sanitizeValue(normKey, v))
                        }
                    }
                }
            }
            timers.remove(normEvent)?.let { startMs ->
                val elapsedSec = (SystemClock.elapsedRealtime() - startMs).coerceAtLeast(0L) / 1000.0
                put("\$duration", elapsedSec)
            }
            sanitizedCustomProps.forEach { (k, v) -> put(k, v) }
        }

        val resolvedTimestamp = timestampMs ?: extractedTimeMs ?: System.currentTimeMillis()

        val evt = JSONObject().apply {
            put("event_id", resolvedEventId)
            put("event_name", normEvent)
            put("distinct_id", distinctId)
            if (loginId.isNotEmpty()) put("login_id", loginId)
            put("timestamp", resolvedTimestamp)
            put("properties", propsObj)
        }

        queue.add(evt)
        if (autoFlush && (queue.size >= batchSize || debug)) {
            executor.execute { flush() }
        }
        return resolvedEventId
    }

    /**
     * 可修改事件局部更新接口（当前版本未开放）。
     *
     * **[当前版本未开放 / Unsupported in current version]** 详见 RESTFUL_API.md §3.3 (D7① / G6 gate)。
     * 调用此方法将直接抛出 [UnsupportedOperationException]，绝不静默入队普通 `track` 事件。
     */
    @Deprecated("当前版本未开放 (RESTFUL_API.md §3.3 D7① / G6 gate)，调用将抛出 UnsupportedOperationException")
    fun trackUpdate(eventName: String, eventId: String, properties: Map<String, Any?>): String {
        throw UnsupportedOperationException(
            "trackUpdate is unsupported in current version (RESTFUL_API.md §3.3 D7① / G6 gate); emit distinct milestone events via track(...) instead"
        )
    }

    /**
     * 可修改事件全量覆盖重写接口（当前版本未开放）。
     *
     * **[当前版本未开放 / Unsupported in current version]** 详见 RESTFUL_API.md §3.3 (D7① / G6 gate)。
     * 调用此方法将直接抛出 [UnsupportedOperationException]，绝不静默入队普通 `track` 事件。
     */
    @Deprecated("当前版本未开放 (RESTFUL_API.md §3.3 D7① / G6 gate)，调用将抛出 UnsupportedOperationException")
    fun trackOverwrite(eventName: String, eventId: String, properties: Map<String, Any?>): String {
        throw UnsupportedOperationException(
            "trackOverwrite is unsupported in current version (RESTFUL_API.md §3.3 D7① / G6 gate); emit distinct milestone events via track(...) instead"
        )
    }

    /** 覆盖设置用户画像属性（上报 `$user_set`）。 */
    fun userSet(properties: Map<String, Any?>) = track("\$user_set", properties)

    /** 首次设置用户画像属性，仅在目标字段尚未赋值时生效（上报 `$user_set_once`）。 */
    fun userSetOnce(properties: Map<String, Any?>) = track("\$user_set_once", properties)

    /** 原子累加数值型用户画像属性（上报 `$user_add`，负数代表扣减）。 */
    fun userAdd(properties: Map<String, Number>) = track("\$user_add", properties)

    /** 清空指定的用户画像属性键（上报 `$user_unset`）。 */
    fun userUnset(vararg keys: String) = track("\$user_unset", keys.associateWith { 0 })

    /** 向列表类型的用户画像属性追加元素（上报 `$user_append`）。 */
    fun userAppend(properties: Map<String, List<Any>>) = track("\$user_append", properties)

    /** 向列表类型的用户画像属性去重追加元素（上报 `$user_uniq_append`）。 */
    fun userUniqAppend(properties: Map<String, List<Any>>) = track("\$user_uniq_append", properties)

    /** 标记删除当前主体的用户画像记录（上报 `$user_del`）。 */
    fun userDelete() = track("\$user_del")

    /**
     * 同步将内存缓冲队列中的事件分批发送至采集网关 `/collect/api/v1/track/batch`（请在工作线程调用）。
     */
    @Synchronized
    fun flush() {
        while (queue.isNotEmpty()) {
            val batch = mutableListOf<JSONObject>()
            val iter = queue.iterator()
            while (iter.hasNext() && batch.size < batchSize) {
                batch.add(iter.next())
            }
            if (batch.isEmpty()) return

            val payload = JSONObject().apply {
                put("project_id", projectId)
                put("project_token", projectToken)
                put("events", JSONArray(batch))
                if (debug) put("debug", true)
            }
            val endpoint = if (serverUrl.endsWith("/collect/api/v1/track/batch")) {
                serverUrl
            } else {
                "$serverUrl/collect/api/v1/track/batch"
            }
            val status = postJson(endpoint, payload.toString())
            if (status in 200..299 || (status in 400..499 && status != 429)) {
                repeat(batch.size) { queue.poll() }
            } else {
                // 网络异常、429 限流或 5xx 服务端故障时保留原队列与 event_id，等待下一轮幂等重试
                return
            }
        }
    }

    private fun postJson(urlStr: String, body: String): Int {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(urlStr).openConnection() as HttpURLConnection).apply {
                requestMethod = "POST"
                connectTimeout = 5000
                readTimeout = 5000
                doOutput = true
                setRequestProperty("Content-Type", "application/json")
            }
            OutputStreamWriter(conn.outputStream, StandardCharsets.UTF_8).use { it.write(body) }
            val code = conn.responseCode
            val stream = if (code in 200..299) conn.inputStream else conn.errorStream
            val respText = stream?.bufferedReader(StandardCharsets.UTF_8)?.use { it.readText() } ?: ""
            lastFlushStatusCode = code
            lastFlushResponseBody = respText
            code
        } catch (e: Exception) {
            lastFlushStatusCode = 0
            lastFlushResponseBody = e.message ?: e::class.java.simpleName
            0
        } finally {
            conn?.disconnect()
        }
    }

    private fun validateEventName(raw: String): String {
        val trimmed = raw.trim()
        require(trimmed.isNotEmpty() && trimmed.length <= MAX_EVENT_NAME_CHARS) { "invalid event_name" }
        require(SYSTEM_EVENTS.contains(trimmed) || IDENTIFIER_REGEX.matches(trimmed)) { "invalid event_name: $trimmed" }
        return trimmed
    }

    private fun validatePropertyKey(raw: String): String {
        val trimmed = raw.trim()
        require(trimmed.isNotEmpty()) { "property key cannot be empty" }
        if (SYSTEM_PROPS.contains(trimmed)) return trimmed
        require(trimmed.length <= MAX_PROP_KEY_CHARS && IDENTIFIER_REGEX.matches(trimmed)) { "invalid property key: $trimmed" }
        return trimmed
    }

    private fun normalizeEpochMs(n: Long, key: String): Long {
        require(n > 0L) { "property $key timestamp must be positive" }
        return if (n in 1_000_000_000L..99_999_999_999L) n * 1000L else n
    }

    private fun parseTimePropertyMs(key: String, raw: Any): Long {
        return when (raw) {
            is Date -> {
                val ms = raw.time
                require(ms > 0L) { "property $key Date timestamp must be positive" }
                ms
            }
            is Long -> normalizeEpochMs(raw, key)
            is Int -> normalizeEpochMs(raw.toLong(), key)
            is Short -> normalizeEpochMs(raw.toLong(), key)
            is Double -> {
                require(raw.isFinite() && raw > 0.0) { "property $key has invalid numeric timestamp" }
                if (raw >= 1_000_000_000.0 && raw < 100_000_000_000.0) {
                    Math.round(raw * 1000.0)
                } else {
                    Math.round(raw)
                }
            }
            is Float -> {
                val d = raw.toDouble()
                require(d.isFinite() && d > 0.0) { "property $key has invalid numeric timestamp" }
                if (d >= 1_000_000_000.0 && d < 100_000_000_000.0) {
                    Math.round(d * 1000.0)
                } else {
                    Math.round(d)
                }
            }
            is String -> parseIsoOrDateTimeStringMs(key, raw)
            else -> throw IllegalArgumentException("property $key has unsupported time type ${raw::class.java.name}")
        }
    }

    private fun parseIsoOrDateTimeStringMs(key: String, raw: String): Long {
        val s = raw.trim()
        require(s.isNotEmpty()) { "property $key timestamp string cannot be empty" }
        if (DIGITS_EPOCH_REGEX.matches(s)) {
            val epoch = s.toLongOrNull()
                ?: throw IllegalArgumentException("property $key has invalid numeric timestamp: $raw")
            return normalizeEpochMs(epoch, key)
        }
        val match = ISO_DATETIME_REGEX.matchEntire(s)
            ?: throw IllegalArgumentException("property $key has invalid datetime format: $raw")
        val year = match.groupValues[1].toInt()
        val month = match.groupValues[2].toInt()
        val day = match.groupValues[3].toInt()
        val hour = match.groupValues[4].toInt()
        val minute = match.groupValues[5].toInt()
        val second = match.groupValues[6].toInt()
        val fracRaw = match.groupValues[7]
        val millis = if (fracRaw.isEmpty()) {
            0
        } else {
            fracRaw.padEnd(3, '0').substring(0, 3).toInt()
        }
        val tzRaw = match.groupValues[8]
        val tz: TimeZone = when {
            tzRaw.isEmpty() -> TimeZone.getDefault()
            tzRaw.equals("Z", ignoreCase = true) -> TimeZone.getTimeZone("GMT")
            else -> {
                val normalizedOffset = if (tzRaw.contains(":")) {
                    tzRaw
                } else {
                    "${tzRaw.substring(0, 3)}:${tzRaw.substring(3, 5)}"
                }
                val tzHour = normalizedOffset.substring(1, 3).toInt()
                val tzMin = normalizedOffset.substring(4, 6).toInt()
                require(tzHour in 0..23 && tzMin in 0..59) {
                    "property $key has invalid timezone offset: $raw"
                }
                TimeZone.getTimeZone("GMT$normalizedOffset")
            }
        }
        val cal = GregorianCalendar(tz, Locale.US).apply {
            isLenient = false
            clear()
            set(Calendar.YEAR, year)
            set(Calendar.MONTH, month - 1)
            set(Calendar.DAY_OF_MONTH, day)
            set(Calendar.HOUR_OF_DAY, hour)
            set(Calendar.MINUTE, minute)
            set(Calendar.SECOND, second)
            set(Calendar.MILLISECOND, millis)
        }
        val ms = try {
            cal.timeInMillis
        } catch (e: IllegalArgumentException) {
            throw IllegalArgumentException("property $key has invalid calendar date: $raw", e)
        }
        require(ms > 0L) { "property $key timestamp must be positive" }
        return ms
    }

    private fun sanitizeValue(key: String, v: Any): Any {
        return when (v) {
            is String, is Boolean, is Int, is Short, is Byte -> v
            is Long -> if (v == Long.MIN_VALUE || v > MAX_SAFE_INTEGER || v < -MAX_SAFE_INTEGER) v.toString() else v
            is Double -> {
                require(!v.isNaN() && !v.isInfinite()) { "property $key has non-finite Double" }
                v
            }
            is Float -> {
                require(!v.isNaN() && !v.isInfinite()) { "property $key has non-finite Float" }
                v.toDouble()
            }
            is List<*> -> {
                val arr = JSONArray()
                for (elem in v) {
                    require(elem != null && elem !is List<*> && elem !is Map<*, *>) {
                        "property $key list contains null or nested element"
                    }
                    arr.put(sanitizeValue(key, elem))
                }
                arr
            }
            else -> throw IllegalArgumentException("property $key has unsupported type ${v::class.java.name}")
        }
    }

    private fun isIdentityWhitespace(ch: Char): Boolean =
        Character.isWhitespace(ch) || Character.isSpaceChar(ch) || ch == '\u0085' || ch == '\u00A0'

    private fun normalizeIdentity(raw: String, maxBytes: Int, field: String): String {
        for (ch in raw) {
            val code = ch.code
            if ((code < 0x20 && (code < 0x09 || code > 0x0D)) || code == 0x7F) {
                throw IllegalArgumentException("$field contains control character")
            }
        }
        val trimmed = raw.trim { isIdentityWhitespace(it) }
        require(trimmed.isNotEmpty()) { "$field cannot be empty" }
        val byteLen = trimmed.toByteArray(StandardCharsets.UTF_8).size
        require(byteLen <= maxBytes) { "$field exceeds $maxBytes UTF-8 bytes" }
        return trimmed
    }
}
