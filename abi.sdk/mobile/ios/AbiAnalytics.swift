import Foundation

/// ABI iOS / macOS Swift 数据采集分析 SDK（严格对齐 ThinkingData 数数科技规范）。
///
/// 提供基于 `NSLock` 的线程安全双标识身份管理（`distinct_id` 访客/设备 ID 与 `login_id` 登录账号 ID，
/// 通过 `identify`、`login`、`logout` 纯本地状态切换并持久化至 `UserDefaults`）、全局静态与动态公共属性、
/// 高精度系统运行时间事件计时（`timeEvent`）、同日固定 `eventId` 幂等重放，
/// 以及全套用户画像变更操作（`$user_set`、`$user_set_once`、`$user_add`、`$user_unset`、
/// `$user_append`、`$user_uniq_append`、`$user_del`）。
///
/// ### 快速上手示例
/// ```swift
/// let sdk = AbiAnalytics.shared
/// sdk.initialize(
///     serverUrl: "http://localhost:8081",
///     projectId: 1,
///     projectToken: "abi_tok_ios_demo",
///     appVersion: "2.1.0",
///     batchSize: 20,
///     debug: true
/// )
///
/// // 1. 访客标识设置、公共属性注册与登录账号设置（纯本地状态更新，不触发网络事件）
/// try? sdk.identify("ios_visitor_device_001")
/// sdk.setSuperProperties(["channel": "AppStore", "vip_tier": "Gold"])
/// try? sdk.login("user_ios_10001")
///
/// // 2. 事件计时与同日固定 eventId 幂等上报
/// sdk.timeEvent("OrderPaid")
/// _ = sdk.track("OrderPaid", properties: ["order_id": "ord_9001", "amount": 199.95], eventId: "evt_ord_9001")
///
/// // 3. 用户画像操作与手动批量上报
/// sdk.userSet(["city": "Shanghai"])
/// sdk.userAdd(["points": 100])
/// sdk.flush()
/// ```
public final class AbiAnalytics {
    /// 全局共享单例客户端。
    public static let shared = AbiAnalytics()

    public static let maxDistinctIdBytes = 64
    public static let maxLoginIdBytes = 128
    public static let maxEventNameChars = 128
    public static let maxPropKeyChars = 64
    public static let maxSafeInteger: Int64 = 9007199254740991
    private static let identifierRegex = try! NSRegularExpression(pattern: "^[A-Za-z_][A-Za-z0-9_]*$")
    private static let systemEvents: Set<String> = [
        "$signup", "$login", "$pageview",
        "$AppStart", "$AppEnd", "$AppClick", "$AppViewScreen",
        "$user_set", "#user_set",
        "$user_set_once", "#user_set_once",
        "$user_add", "#user_add",
        "$user_unset", "#user_unset",
        "$user_append", "#user_append",
        "$user_uniq_append", "#user_uniq_append",
        "$user_del", "#user_del"
    ]
    private static let systemProps: Set<String> = [
        "$os", "#os", "os",
        "$os_version", "#os_version", "os_version",
        "$app_version", "#app_version", "app_version",
        "$browser", "#browser", "browser",
        "$browser_version", "#browser_version", "browser_version",
        "$city", "#city", "city",
        "$province", "#province", "province",
        "$country", "#country", "country",
        "$country_code", "#country_code", "country_code",
        "$ip", "#ip", "ip",
        "$network", "#network", "network",
        "$network_type", "#network_type", "network_type",
        "$platform", "#platform", "platform",
        "$device_id", "#device_id", "device_id",
        "$session_id", "#session_id", "session_id",
        "$screen_width", "#screen_width", "screen_width",
        "$screen_height", "#screen_height", "screen_height",
        "$model", "#model", "model",
        "$device_model", "#device_model", "device_model",
        "$manufacturer", "#manufacturer", "manufacturer",
        "$carrier", "#carrier", "carrier",
        "$url", "#url", "url",
        "$url_path", "#url_path", "url_path",
        "$referrer", "#referrer", "referrer",
        "$title", "#title", "title",
        "$duration", "#duration", "duration",
        "$lib", "#lib", "lib",
        "$lib_version", "#lib_version", "lib_version",
        "$zone_offset", "#zone_offset", "zone_offset",
        "$first_check_id", "#first_check_id", "first_check_id"
    ]

    private var serverUrl: String = ""
    private var projectId: Int64 = 0
    private var projectToken: String = ""
    private var appVersion: String = "1.0.0"
    private var batchSize: Int = 20
    private var debug: Bool = false
    private var autoFlush: Bool = true

    private let queueLock = NSLock()
    private var _distinctId: String = UUID().uuidString.lowercased()
    private var _loginId: String = ""
    private var superProperties: [String: Any] = [:]
    private var dynamicSuperPropsProvider: (() -> [String: Any])?
    private var timers: [String: TimeInterval] = [:]
    private var eventQueue: [[String: Any]] = []
    private var flushTimer: Timer?
    private var isFlushing: Bool = false

    private static func distinctIdStorageKey(for projectId: Int64) -> String {
        return "abi_sdk_\(projectId)_distinct_id"
    }

    private static func loginIdStorageKey(for projectId: Int64) -> String {
        return "abi_sdk_\(projectId)_login_id"
    }

    /// 返回当前访客/设备标识 `distinct_id`（初始化自动生成 UUIDv4 并持久化，仅通过 `identify` 修改，不受 `login` 覆盖）。
    public var distinctId: String {
        queueLock.lock()
        defer { queueLock.unlock() }
        return _distinctId
    }

    /// 返回当前已设置的实名登录账号标识 `login_id`（未登录时为空字符串）。
    public var loginId: String {
        queueLock.lock()
        defer { queueLock.unlock() }
        return _loginId
    }

    /// 返回当前已设置的实名登录账号标识 `login_id`（与 `loginId` 等价，未登录时为空字符串）。
    public var currentLoginId: String {
        queueLock.lock()
        defer { queueLock.unlock() }
        return _loginId
    }

    /// 返回内存缓冲队列中尚未上报的事件条数。
    public var pendingQueueCount: Int {
        queueLock.lock()
        defer { queueLock.unlock() }
        return eventQueue.count
    }

    private init() {}

    /// 初始化配置共享单例 `AbiAnalytics` 客户端，从本地 `UserDefaults` 恢复或生成持久化 `distinct_id` 与 `login_id`；
    /// 当 `autoFlush` 为 `true`（默认）时在主运行循环启动 5 秒周期的后台批量刷新定时器。
    ///
    /// ```swift
    /// AbiAnalytics.shared.initialize(
    ///     serverUrl: "http://localhost:8081",
    ///     projectId: 1,
    ///     projectToken: "abi_tok_ios_demo",
    ///     autoFlush: true
    /// )
    /// ```
    public func initialize(
        serverUrl: String,
        projectId: Int64,
        projectToken: String,
        appVersion: String = "1.0.0",
        batchSize: Int = 20,
        debug: Bool = false,
        autoFlush: Bool = true
    ) {
        let defaults = UserDefaults.standard
        let distinctKey = Self.distinctIdStorageKey(for: projectId)
        let loginKey = Self.loginIdStorageKey(for: projectId)
        let restoredDistinct: String
        if projectId > 0,
           let savedDistinct = defaults.string(forKey: distinctKey),
           let validDistinct = try? Self.normalizeIdentity(savedDistinct, maxBytes: Self.maxDistinctIdBytes, field: "distinct_id") {
            restoredDistinct = validDistinct
        } else {
            let generated = UUID().uuidString.lowercased()
            if projectId > 0 {
                defaults.set(generated, forKey: distinctKey)
            }
            restoredDistinct = generated
        }
        let restoredLogin: String
        if projectId > 0,
           let savedLogin = defaults.string(forKey: loginKey),
           let validLogin = try? Self.normalizeIdentity(savedLogin, maxBytes: Self.maxLoginIdBytes, field: "login_id") {
            restoredLogin = validLogin
        } else {
            restoredLogin = ""
        }

        queueLock.lock()
        self.serverUrl = serverUrl.trimmingCharacters(in: CharacterSet(charactersIn: "/"))
        self.projectId = projectId
        self.projectToken = projectToken.trimmingCharacters(in: .whitespacesAndNewlines)
        self.appVersion = appVersion
        self.batchSize = max(1, min(batchSize, 500))
        self.debug = debug
        self.autoFlush = autoFlush
        self._distinctId = restoredDistinct
        self._loginId = restoredLogin
        queueLock.unlock()

        DispatchQueue.main.async {
            self.flushTimer?.invalidate()
            self.flushTimer = nil
            if autoFlush {
                self.flushTimer = Timer.scheduledTimer(withTimeInterval: 5.0, repeats: true) { [weak self] _ in
                    self?.flush()
                }
            }
        }
    }

    /// 自定义设置访客/设备标识 `distinct_id`（UTF-8 编码不超过 64 字节，持久化至本地 `distinct_id` 存储键，不发送网络事件）。
    ///
    /// ```swift
    /// try AbiAnalytics.shared.identify("ios_visitor_device_001")
    /// ```
    public func identify(_ distinctId: String) throws {
        let norm = try Self.normalizeIdentity(distinctId, maxBytes: Self.maxDistinctIdBytes, field: "distinct_id")
        queueLock.lock()
        self._distinctId = norm
        let pid = self.projectId
        queueLock.unlock()
        if pid > 0 {
            UserDefaults.standard.set(norm, forKey: Self.distinctIdStorageKey(for: pid))
        }
    }

    /// 设置实名登录账号标识 `login_id`（UTF-8 编码不超过 128 字节，持久化至本地存储；绝不覆盖 `distinct_id`，且不自动触发任何网络事件）。
    ///
    /// ```swift
    /// try AbiAnalytics.shared.login("user_ios_10001")
    /// ```
    public func login(_ accountId: String) throws {
        let normLogin = try Self.normalizeIdentity(accountId, maxBytes: Self.maxLoginIdBytes, field: "login_id")
        queueLock.lock()
        self._loginId = normLogin
        let pid = self.projectId
        queueLock.unlock()
        if pid > 0 {
            UserDefaults.standard.set(normLogin, forKey: Self.loginIdStorageKey(for: pid))
        }
    }

    /// 退出登录，清空当前 `loginId` 并保持访客标识 `distinctId` 不变（不发送网络事件）。
    ///
    /// ```swift
    /// AbiAnalytics.shared.logout()
    /// ```
    public func logout() {
        queueLock.lock()
        self._loginId = ""
        let pid = self.projectId
        queueLock.unlock()
        if pid > 0 {
            UserDefaults.standard.removeObject(forKey: Self.loginIdStorageKey(for: pid))
        }
    }

    /// 注册全局静态公共属性，自动合并到后续所有非 `$user_*` / `#user_*` 画像事件中。
    ///
    /// ```swift
    /// AbiAnalytics.shared.setSuperProperties(["channel": "AppStore", "ab_group": "v2"])
    /// ```
    public func setSuperProperties(_ props: [String: Any]) {
        queueLock.lock()
        for (k, v) in props {
            if let normKey = try? Self.validatePropertyKey(k),
               let normVal = try? Self.sanitizeValue(v) {
                self.superProperties[normKey] = normVal
            }
        }
        queueLock.unlock()
    }

    /// 按属性名移除单个已注册的全局静态公共属性。
    ///
    /// ```swift
    /// AbiAnalytics.shared.unsetSuperProperty("ab_group")
    /// ```
    public func unsetSuperProperty(_ key: String) {
        let trimmed = key.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return }
        queueLock.lock()
        self.superProperties.removeValue(forKey: trimmed)
        queueLock.unlock()
    }

    /// 清空所有已注册的全局静态公共属性。
    ///
    /// ```swift
    /// AbiAnalytics.shared.clearSuperProperties()
    /// ```
    public func clearSuperProperties() {
        queueLock.lock()
        self.superProperties.removeAll()
        queueLock.unlock()
    }

    /// 获取当前已注册全局静态公共属性的拷贝快照。
    ///
    /// ```swift
    /// let currentProps = AbiAnalytics.shared.getSuperProperties()
    /// ```
    public func getSuperProperties() -> [String: Any] {
        queueLock.lock()
        let snapshot = self.superProperties
        queueLock.unlock()
        return snapshot
    }

    /// 注册（或置空移除）动态公共属性回调函数；每次上报非 `$user_*` / `#user_*` 事件时动态合并，
    /// 优先级高于静态公共属性、低于单次事件 `properties`。
    ///
    /// ```swift
    /// AbiAnalytics.shared.setDynamicSuperProperties {
    ///     ["network_state": "wifi"]
    /// }
    /// ```
    public func setDynamicSuperProperties(_ provider: (() -> [String: Any])?) {
        queueLock.lock()
        self.dynamicSuperPropsProvider = provider
        queueLock.unlock()
    }

    /// 为指定 `eventName` 启动高精度计时器（基于 `systemUptime`）；
    /// 下一次上报同名 `track` 事件时自动计算并附加秒级 `$duration` 属性。
    ///
    /// ```swift
    /// AbiAnalytics.shared.timeEvent("OrderPaid")
    /// AbiAnalytics.shared.track("OrderPaid", properties: ["amount": 99.0])
    /// ```
    public func timeEvent(_ eventName: String) {
        guard let normEvent = try? Self.validateEventName(eventName) else { return }
        queueLock.lock()
        self.timers[normEvent] = ProcessInfo.processInfo.systemUptime
        queueLock.unlock()
    }

    /// 采集并入队一条自定义业务事件或系统保留事件，返回归一化后的幂等 `event_id`。
    ///
    /// 支持通过可选参数 `timestamp` 指定事件发生时间；若 `properties` 中包含 `"#time"` 或 `"$time"`
    /// （支持 `Date`、`Int64`、`Int`、`Double`、`NSNumber`、ISO8601 `String`），会自动提取为顶层毫秒 `timestamp`
    /// 并在属性校验前从 `properties` 中剥离。
    /// 超出 IEEE-754 安全整数范围（`> 9007199254740991`）的 64 位整数会自动转换为十进制字符串保护精度。
    ///
    /// ```swift
    /// let eventId = AbiAnalytics.shared.track(
    ///     "OrderPaid",
    ///     properties: [
    ///         "order_id": "ord_1001",
    ///         "amount": 299.95,
    ///         "snowflake_seq": Int64(9007199254740993) // 自动序列化为字符串
    ///     ]
    /// )
    /// ```
    @discardableResult
    public func track(
        _ eventName: String,
        properties: [String: Any] = [:],
        eventId: String? = nil,
        timestamp: Date? = nil
    ) -> String {
        guard let normEvent = try? Self.validateEventName(eventName) else { return "" }
        if let explicitDate = timestamp {
            let explicitMs = Int64((explicitDate.timeIntervalSince1970 * 1000.0).rounded())
            guard explicitMs > 0 else { return "" }
        }
        let resolvedEventId: String
        if let customId = eventId, !customId.isEmpty {
            guard let validId = try? Self.normalizeIdentity(customId, maxBytes: Self.maxDistinctIdBytes, field: "event_id") else {
                return ""
            }
            resolvedEventId = validId
        } else {
            resolvedEventId = UUID().uuidString.lowercased()
        }

        var rawTimeVal: Any?
        var hasTimeKey = false
        var hasHashTime = false
        var filteredProps: [String: Any] = [:]
        for (k, v) in properties {
            let trimmedKey = k.trimmingCharacters(in: .whitespacesAndNewlines)
            if trimmedKey == "#time" {
                hasTimeKey = true
                hasHashTime = true
                rawTimeVal = v
            } else if trimmedKey == "$time" {
                hasTimeKey = true
                if !hasHashTime {
                    rawTimeVal = v
                }
            } else {
                filteredProps[k] = v
            }
        }

        var extractedTimeMs: Int64?
        if hasTimeKey, let timeVal = rawTimeVal, !(timeVal is NSNull) {
            guard let parsedMs = Self.parseTimePropertyMs(timeVal) else {
                return ""
            }
            extractedTimeMs = parsedMs
        }

        var sanitizedCustomProps: [String: Any] = [:]
        for (k, v) in filteredProps {
            if v is NSNull { continue }
            guard let normKey = try? Self.validatePropertyKey(k),
                  let normVal = try? Self.sanitizeValue(v) else {
                return ""
            }
            sanitizedCustomProps[normKey] = normVal
        }

        let isUserEvent = normEvent.hasPrefix("$user_") || normEvent.hasPrefix("#user_")
        var dynProvider: (() -> [String: Any])?
        if !isUserEvent {
            queueLock.lock()
            dynProvider = self.dynamicSuperPropsProvider
            queueLock.unlock()
        }

        var sanitizedDynProps: [String: Any] = [:]
        if let provider = dynProvider {
            let dynRaw = provider()
            for (k, v) in dynRaw {
                if v is NSNull { continue }
                let trimmed = k.trimmingCharacters(in: .whitespacesAndNewlines)
                if trimmed == "#time" || trimmed == "$time" { continue }
                if let normKey = try? Self.validatePropertyKey(k),
                   let normVal = try? Self.sanitizeValue(v) {
                    sanitizedDynProps[normKey] = normVal
                }
            }
        }

        queueLock.lock()
        var merged: [String: Any] = isUserEvent ? [:] : [
            "$lib": "abi-ios-sdk",
            "$lib_version": "1.0.0",
            "$os": "iOS",
            "$app_version": self.appVersion
        ]
        if !isUserEvent {
            for (k, v) in self.superProperties {
                merged[k] = v
            }
            for (k, v) in sanitizedDynProps {
                merged[k] = v
            }
        }
        if let started = self.timers.removeValue(forKey: normEvent) {
            let elapsed = max(0.0, ProcessInfo.processInfo.systemUptime - started)
            merged["$duration"] = (elapsed * 1000).rounded() / 1000
        }
        for (k, v) in sanitizedCustomProps {
            merged[k] = v
        }

        let resolvedTimestampMs: Int64
        if let explicitDate = timestamp {
            resolvedTimestampMs = Int64((explicitDate.timeIntervalSince1970 * 1000.0).rounded())
        } else if let extracted = extractedTimeMs {
            resolvedTimestampMs = extracted
        } else {
            resolvedTimestampMs = Int64((Date().timeIntervalSince1970 * 1000.0).rounded())
        }

        var dto: [String: Any] = [
            "event_id": resolvedEventId,
            "event_name": normEvent,
            "distinct_id": self._distinctId,
            "timestamp": resolvedTimestampMs,
            "properties": merged
        ]
        if !self._loginId.isEmpty {
            dto["login_id"] = self._loginId
        }
        self.eventQueue.append(dto)
        let shouldFlush = self.autoFlush && (self.eventQueue.count >= self.batchSize || self.debug)
        queueLock.unlock()

        if shouldFlush {
            flush()
        }
        return resolvedEventId
    }

    /// 清空内存缓冲队列中尚未上报的所有待发事件。
    public func clearPendingQueue() {
        queueLock.lock()
        self.eventQueue.removeAll()
        queueLock.unlock()
    }

    /// 构造当前待提交给 `POST /collect/api/v1/track/batch` 的完整请求体字典
    /// （结构：`{ project_id, project_token, debug?, events: [...] }`）。
    public func buildPendingBatchPayload() -> [String: Any] {
        queueLock.lock()
        var payload: [String: Any] = [
            "project_id": self.projectId,
            "project_token": self.projectToken,
            "events": self.eventQueue
        ]
        if self.debug {
            payload["debug"] = true
        }
        queueLock.unlock()
        return payload
    }

    /// 输出格式化后的 `POST /collect/api/v1/track/batch` 具体待提交请求 JSON 字符串。
    public func buildPendingBatchJsonString() -> String {
        let payload = buildPendingBatchPayload()
        var options: JSONSerialization.WritingOptions = [.prettyPrinted]
        if #available(iOS 11.0, macOS 10.13, *) {
            options.insert(.sortedKeys)
        }
        if #available(iOS 13.0, macOS 10.15, *) {
            options.insert(.withoutEscapingSlashes)
        }
        guard JSONSerialization.isValidJSONObject(payload),
              let data = try? JSONSerialization.data(withJSONObject: payload, options: options),
              let jsonStr = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return jsonStr
    }

    /// 可修改事件局部更新接口（当前版本未开放）。
    ///
    /// - Note: **[当前版本未开放 / Unsupported in current version]** 详见 RESTFUL_API.md §3.3 (D7① / G6 gate)。
    ///   调用此方法会输出显式错误日志并返回空字符串 `""`，绝不静默向 `eventQueue` 入队普通 `track` 事件。
    @available(*, deprecated, message: "当前版本未开放 (RESTFUL_API.md §3.3 D7① / G6 gate)，调用将被拦截且不入队")
    @discardableResult
    public func trackUpdate(_ eventName: String, eventId: String, properties: [String: Any]) -> String {
        NSLog("[AbiAnalytics] ERROR: trackUpdate is unsupported in current version (RESTFUL_API.md §3.3 D7① / G6 gate); event '%@' was dropped without enqueueing.", eventName)
        return ""
    }

    /// 可修改事件全量覆盖重写接口（当前版本未开放）。
    ///
    /// - Note: **[当前版本未开放 / Unsupported in current version]** 详见 RESTFUL_API.md §3.3 (D7① / G6 gate)。
    ///   调用此方法会输出显式错误日志并返回空字符串 `""`，绝不静默向 `eventQueue` 入队普通 `track` 事件。
    @available(*, deprecated, message: "当前版本未开放 (RESTFUL_API.md §3.3 D7① / G6 gate)，调用将被拦截且不入队")
    @discardableResult
    public func trackOverwrite(_ eventName: String, eventId: String, properties: [String: Any]) -> String {
        NSLog("[AbiAnalytics] ERROR: trackOverwrite is unsupported in current version (RESTFUL_API.md §3.3 D7① / G6 gate); event '%@' was dropped without enqueueing.", eventName)
        return ""
    }

    /// 覆盖设置用户画像属性（上报 `$user_set`，存在同名字段则覆盖）。
    public func userSet(_ properties: [String: Any]) { _ = track("$user_set", properties: properties) }
    /// 首次设置用户画像属性（上报 `$user_set_once`，仅在目标属性尚未赋值时生效）。
    public func userSetOnce(_ properties: [String: Any]) { _ = track("$user_set_once", properties: properties) }
    /// 原子累加数值型用户画像属性（上报 `$user_add`，负数代表扣减）。
    public func userAdd(_ properties: [String: NSNumber]) { _ = track("$user_add", properties: properties) }
    /// 清空指定的用户画像属性键数组（上报 `$user_unset`）。
    public func userUnset(_ keys: [String]) {
        var props: [String: Any] = [:]
        keys.forEach { props[$0] = 0 }
        _ = track("$user_unset", properties: props)
    }
    /// 向列表类型的用户画像属性追加元素（上报 `$user_append`）。
    public func userAppend(_ properties: [String: [Any]]) { _ = track("$user_append", properties: properties) }
    /// 向列表类型的用户画像属性去重追加元素（上报 `$user_uniq_append`）。
    public func userUniqAppend(_ properties: [String: [Any]]) { _ = track("$user_uniq_append", properties: properties) }
    /// 标记删除当前主体的用户画像记录（上报 `$user_del`）。
    public func userDelete() { _ = track("$user_del") }

    /// 异步将内存队列中的事件分批发送至采集网关 `/collect/api/v1/track/batch`。
    /// 网络断连、HTTP 429 限流或 5xx 服务端异常时会自动保留原始队列及 `event_id` 供下次幂等重试。
    public func flush(completion: ((Int, String) -> Void)? = nil) {
        queueLock.lock()
        if self.eventQueue.isEmpty {
            queueLock.unlock()
            completion?(200, "{\"code\":200,\"message\":\"当前无待提交事件\"}")
            return
        }
        guard !self.isFlushing else {
            queueLock.unlock()
            return
        }
        self.isFlushing = true
        let count = min(self.batchSize, self.eventQueue.count)
        let batch = Array(self.eventQueue.prefix(count))
        let sentIds = Set(batch.compactMap { $0["event_id"] as? String })
        let urlStr = self.serverUrl.hasSuffix("/collect/api/v1/track/batch")
            ? self.serverUrl
            : "\(self.serverUrl)/collect/api/v1/track/batch"
        var payload: [String: Any] = [
            "project_id": self.projectId,
            "project_token": self.projectToken,
            "events": batch
        ]
        if self.debug { payload["debug"] = true }
        queueLock.unlock()

        Self.postJson(urlStr: urlStr, payload: payload) { status, responseBody in
            self.queueLock.lock()
            let shouldRemove = (200...299).contains(status) || ((400...499).contains(status) && status != 429)
            if shouldRemove {
                self.eventQueue.removeAll { item in
                    guard let id = item["event_id"] as? String else { return false }
                    return sentIds.contains(id)
                }
            }
            self.isFlushing = false
            let hasMore = shouldRemove && !self.eventQueue.isEmpty
            self.queueLock.unlock()
            if hasMore {
                self.flush(completion: completion)
            } else {
                completion?(status, responseBody)
            }
        }
    }

    private static func validateEventName(_ raw: String) throws -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.count <= maxEventNameChars else {
            throw NSError(domain: "AbiAnalytics", code: 400, userInfo: [NSLocalizedDescriptionKey: "invalid event_name"])
        }
        if systemEvents.contains(trimmed) {
            return trimmed
        }
        let range = NSRange(trimmed.startIndex..<trimmed.endIndex, in: trimmed)
        guard identifierRegex.firstMatch(in: trimmed, options: [], range: range) != nil else {
            throw NSError(domain: "AbiAnalytics", code: 400, userInfo: [NSLocalizedDescriptionKey: "invalid event_name"])
        }
        return trimmed
    }

    private static func validatePropertyKey(_ raw: String) throws -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else {
            throw NSError(domain: "AbiAnalytics", code: 400, userInfo: [NSLocalizedDescriptionKey: "empty property key"])
        }
        if systemProps.contains(trimmed) {
            return trimmed
        }
        let range = NSRange(trimmed.startIndex..<trimmed.endIndex, in: trimmed)
        guard trimmed.count <= maxPropKeyChars,
              identifierRegex.firstMatch(in: trimmed, options: [], range: range) != nil else {
            throw NSError(domain: "AbiAnalytics", code: 400, userInfo: [NSLocalizedDescriptionKey: "invalid property key"])
        }
        return trimmed
    }

    private static func normalizeEpochNumber(_ n: Int64) -> Int64? {
        guard n > 0 else { return nil }
        if n >= 1_000_000_000 && n < 100_000_000_000 {
            return n * 1000
        }
        return n
    }

    private static func parseTimePropertyMs(_ val: Any) -> Int64? {
        if val is Bool {
            return nil
        }
        if let num = val as? NSNumber, CFGetTypeID(num) == CFBooleanGetTypeID() {
            return nil
        }
        if let date = val as? Date {
            let ms = Int64((date.timeIntervalSince1970 * 1000.0).rounded())
            return ms > 0 ? ms : nil
        }
        if let i64 = val as? Int64 {
            return normalizeEpochNumber(i64)
        }
        if let i = val as? Int {
            return normalizeEpochNumber(Int64(i))
        }
        if let d = val as? Double {
            guard d.isFinite, d > 0 else { return nil }
            if d >= 1_000_000_000 && d < 100_000_000_000 {
                return Int64((d * 1000.0).rounded())
            }
            return Int64(d.rounded())
        }
        if let f = val as? Float {
            let d = Double(f)
            guard d.isFinite, d > 0 else { return nil }
            if d >= 1_000_000_000 && d < 100_000_000_000 {
                return Int64((d * 1000.0).rounded())
            }
            return Int64(d.rounded())
        }
        if let num = val as? NSNumber {
            if CFNumberIsFloatType(num) {
                let d = num.doubleValue
                guard d.isFinite, d > 0 else { return nil }
                if d >= 1_000_000_000 && d < 100_000_000_000 {
                    return Int64((d * 1000.0).rounded())
                }
                return Int64(d.rounded())
            }
            return normalizeEpochNumber(num.int64Value)
        }
        if let str = val as? String {
            return parseIsoDateStringMs(str)
        }
        return nil
    }

    private static func parseIsoDateStringMs(_ raw: String) -> Int64? {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty else { return nil }
        if trimmed.count >= 10 && trimmed.count <= 16 && trimmed.allSatisfy({ $0.isASCII && $0.isNumber }) {
            if let epoch = Int64(trimmed) {
                return normalizeEpochNumber(epoch)
            }
        }
        if #available(iOS 10.0, macOS 10.12, *) {
            let isoFrac = ISO8601DateFormatter()
            isoFrac.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
            if let d = isoFrac.date(from: trimmed) {
                let ms = Int64((d.timeIntervalSince1970 * 1000.0).rounded())
                return ms > 0 ? ms : nil
            }
            let isoBasic = ISO8601DateFormatter()
            isoBasic.formatOptions = [.withInternetDateTime]
            if let d = isoBasic.date(from: trimmed) {
                let ms = Int64((d.timeIntervalSince1970 * 1000.0).rounded())
                return ms > 0 ? ms : nil
            }
        }
        let posixLocale = Locale(identifier: "en_US_POSIX")
        let df = DateFormatter()
        df.locale = posixLocale
        let tzFormats = [
            "yyyy-MM-dd'T'HH:mm:ss.SSSZZZZZ",
            "yyyy-MM-dd'T'HH:mm:ssZZZZZ",
            "yyyy-MM-dd HH:mm:ss.SSSZZZZZ",
            "yyyy-MM-dd HH:mm:ssZZZZZ"
        ]
        for fmt in tzFormats {
            df.dateFormat = fmt
            if let d = df.date(from: trimmed) {
                let ms = Int64((d.timeIntervalSince1970 * 1000.0).rounded())
                return ms > 0 ? ms : nil
            }
        }
        df.timeZone = TimeZone.current
        let localFormats = [
            "yyyy-MM-dd HH:mm:ss.SSS",
            "yyyy-MM-dd HH:mm:ss",
            "yyyy-MM-dd'T'HH:mm:ss.SSS",
            "yyyy-MM-dd'T'HH:mm:ss"
        ]
        for fmt in localFormats {
            df.dateFormat = fmt
            if let d = df.date(from: trimmed) {
                let ms = Int64((d.timeIntervalSince1970 * 1000.0).rounded())
                return ms > 0 ? ms : nil
            }
        }
        return nil
    }

    private static func sanitizeValue(_ val: Any) throws -> Any {
        if let i64 = val as? Int64 {
            if i64 == Int64.min || i64 > maxSafeInteger || i64 < -maxSafeInteger {
                return String(i64)
            }
            return i64
        }
        if let i = val as? Int {
            let i64 = Int64(i)
            if i64 == Int64.min || i64 > maxSafeInteger || i64 < -maxSafeInteger {
                return String(i64)
            }
            return i64
        }
        if let d = val as? Double {
            guard d.isFinite else {
                throw NSError(domain: "AbiAnalytics", code: 400, userInfo: [NSLocalizedDescriptionKey: "non-finite double"])
            }
            return d
        }
        if let f = val as? Float {
            guard f.isFinite else {
                throw NSError(domain: "AbiAnalytics", code: 400, userInfo: [NSLocalizedDescriptionKey: "non-finite float"])
            }
            return Double(f)
        }
        if val is String || val is Bool || val is NSNumber {
            return val
        }
        if let arr = val as? [Any] {
            return try arr.map { elem in
                if elem is [Any] || elem is [String: Any] || elem is NSNull {
                    throw NSError(domain: "AbiAnalytics", code: 400, userInfo: [NSLocalizedDescriptionKey: "invalid list element"])
                }
                return try sanitizeValue(elem)
            }
        }
        throw NSError(domain: "AbiAnalytics", code: 400, userInfo: [NSLocalizedDescriptionKey: "unsupported property type"])
    }

    private static func normalizeIdentity(_ raw: String, maxBytes: Int, field: String) throws -> String {
        for scalar in raw.unicodeScalars {
            let v = scalar.value
            if (v < 0x20 && (v < 0x09 || v > 0x0D)) || v == 0x7F {
                throw NSError(domain: "AbiAnalytics", code: 400, userInfo: [NSLocalizedDescriptionKey: "\(field) contains control char"])
            }
        }
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, trimmed.utf8.count <= maxBytes else {
            throw NSError(domain: "AbiAnalytics", code: 400, userInfo: [NSLocalizedDescriptionKey: "\(field) invalid byte length"])
        }
        return trimmed
    }

    private static func postJson(urlStr: String, payload: [String: Any], completion: @escaping (Int, String) -> Void) {
        guard let url = URL(string: urlStr),
              let data = try? JSONSerialization.data(withJSONObject: payload) else {
            completion(0, "无效的网关地址或请求体序列化失败")
            return
        }
        var req = URLRequest(url: url, timeoutInterval: 5.0)
        req.httpMethod = "POST"
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = data
        URLSession.shared.dataTask(with: req) { respData, res, err in
            let code = (res as? HTTPURLResponse)?.statusCode ?? 0
            if let err = err, code == 0 {
                completion(0, err.localizedDescription)
                return
            }
            let bodyText = respData.flatMap { String(data: $0, encoding: .utf8) } ?? ""
            completion(code, bodyText)
        }.resume()
    }
}
