import Foundation
import SwiftUI

/// 面向 iOS / macOS 的 `AbiAnalytics` 两步式无界面演练运行器：
/// 1. `previewScenarioJson(...)`：构建并返回 `POST /collect/api/v1/track/batch` 的具体请求 JSON 字符串；
/// 2. `confirmSubmit(...)`：确认发送当前待提交批次并回调单次响应状态与响应体。
public enum AbiSdkDemoRunner {
    /// 第 1 步：以 `autoFlush: false` 初始化并组装全套埋点场景参数（双 ID 身份映射、静态/动态公共属性、
    /// `timeEvent` 计时、`> 2^53 - 1` 大整数、独立里程碑事件与 `$user_*` 画像操作），
    /// 返回格式化后的待提交请求体 JSON 字符串（不会自动触发网络发送，也不追加历史日志）。
    @discardableResult
    public static func previewScenarioJson(
        serverUrl: String = "http://localhost:8081",
        projectId: Int64 = 1,
        projectToken: String = "abi_tok_ios_demo"
    ) -> String {
        let sdk = AbiAnalytics.shared
        sdk.initialize(
            serverUrl: serverUrl,
            projectId: projectId,
            projectToken: projectToken,
            appVersion: "2.1.0",
            batchSize: 50,
            debug: false,
            autoFlush: false
        )
        sdk.clearPendingQueue()
        sdk.clearSuperProperties()
        sdk.logout()

        try? sdk.identify("visitor_ios_demo_001")
        try? sdk.login("user_ios_8888")
        sdk.setSuperProperties(["channel": "AppStore_Demo", "vip_tier": "Gold"])
        sdk.setDynamicSuperProperties {
            ["dyn_sequence": 1]
        }

        sdk.timeEvent("OrderPaid")
        _ = sdk.track(
            "OrderPaid",
            properties: [
                "order_id": "ord_ios_1001",
                "amount": 299.95,
                "currency": "CNY",
                "big_int_order_seq": Int64(9007199254740993)
            ],
            eventId: "evt_ios_order_1001"
        )
        _ = sdk.track(
            "OrderSettled",
            properties: ["order_id": "ord_ios_1001", "order_status": "settled", "amount": 279.95],
            eventId: "evt_ios_order_settled_1001"
        )

        sdk.userSet(["vip_level": "Platinum", "city": "Shanghai"])
        sdk.userSetOnce(["first_install_channel": "AppStore"])
        sdk.userAdd(["loyalty_points": NSNumber(value: 100)])
        sdk.userAppend(["interests": ["analytics", "swift"]])
        sdk.userUniqAppend(["interests": ["swift", "starrocks"]])
        sdk.userUnset(["temporary_flag"])
        sdk.userDelete()

        return sdk.buildPendingBatchJsonString()
    }

    /// 第 2 步：确认提交当前待发请求队列，并在完成后回调 `(httpStatusCode, responseBody)`。
    public static func confirmSubmit(completion: ((Int, String) -> Void)? = nil) {
        AbiAnalytics.shared.flush(completion: completion)
    }
}

private struct StagedDraftAction {
    let label: String
    let apply: (AbiAnalytics) -> Void

    init(label: String, apply: @escaping (AbiAnalytics) -> Void) {
        self.label = label
        self.apply = apply
    }
}

/// 面向 `AbiAnalytics` 的 SwiftUI 两步式交互演练视图：
/// 上方配置身份、公共属性与事件参数并原地实时刷新唯一一份「待提交请求 JSON 预览」，
/// 点击「确认提交」按钮后发送并在底部展示单次响应结果（无历史刷屏日志数组）。
@available(iOS 15.0, macOS 12.0, *)
public struct AbiSdkDemoView: View {
    private static let defaultServerUrl = "http://localhost:8081"
    private let sdk = AbiAnalytics.shared

    @State private var distinctId: String
    @State private var loginId: String
    @State private var superPropsSummary: String
    @State private var pendingCount: Int

    @State private var staticSuperJsonText: String = "{\n  \"channel\": \"AppStore\",\n  \"vip_tier\": \"Gold\"\n}"
    @State private var superPropError: String = ""
    @State private var dynamicSuperEnabled: Bool = false
    @State private var dynamicSeq: Int = 1
    @State private var appendBatchMode: Bool = false
    @State private var orderTimerRunning: Bool = false
    @State private var lastOrderEventId: String = "evt_ios_order_001"

    @State private var stagedActions: [StagedDraftAction] = []
    @State private var requestJsonPreview: String

    @State private var isSubmitting: Bool = false
    @State private var responseStatusHint: String = "尚未提交"
    @State private var responsePreview: String = "点击上方「确认提交」按钮发送待提交请求 JSON，此处仅展示最近一次响应结果。"
    @State private var responseIsError: Bool = false

    public init() {
        let client = AbiAnalytics.shared
        client.initialize(
            serverUrl: Self.defaultServerUrl,
            projectId: 1,
            projectToken: "abi_tok_ios_demo",
            appVersion: "2.1.0",
            batchSize: 50,
            debug: false,
            autoFlush: false // 禁用定时与自动触发 flush()，严格由「确认提交」按钮发送
        )
        client.logout()
        client.clearPendingQueue()
        client.clearSuperProperties()
        client.setSuperProperties(["channel": "AppStore", "vip_tier": "Gold"])
        _ = client.track(
            "ProductView",
            properties: [
                "sku_id": "sku_kb_pro",
                "product_name": "ABI 无线双模机械键盘 Pro",
                "price": 199.0,
                "in_stock": true
            ]
        )

        _distinctId = State(initialValue: client.distinctId)
        _loginId = State(initialValue: client.currentLoginId)
        _superPropsSummary = State(initialValue: Self.compactJsonString(client.getSuperProperties()))
        _pendingCount = State(initialValue: client.pendingQueueCount)
        _requestJsonPreview = State(initialValue: client.buildPendingBatchJsonString())
    }

    public var body: some View {
        ScrollView {
            VStack(alignment: .leading, spacing: 14) {
                headerStatusSection
                identitySection
                superPropertiesSection
                batchModeToggleSection
                behaviorEventsSection
                userProfileSection
                Divider()
                requestPreviewSection
                responseSection
            }
            .padding()
        }
        .onAppear {
            if stagedActions.isEmpty {
                stagedActions = [makeProductViewAction()]
                rebuildDraftPreview()
            }
        }
    }

    @ViewBuilder
    private var headerStatusSection: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("ABI iOS Swift SDK 交互式演练")
                .font(.title2)
                .bold()
            Text("访客标识 (distinct_id): \(distinctId)")
                .font(.system(.caption, design: .monospaced))
            Text("登录账号 ID (login_id): \(loginId.isEmpty ? "(未登录)" : loginId)")
                .font(.system(.caption, design: .monospaced))
            Text("静态公共属性 (superProperties): \(superPropsSummary)")
                .font(.system(.caption, design: .monospaced))
            Text("动态公共属性: \(dynamicSuperEnabled ? "已启用 (dyn_sequence=\(dynamicSeq), network_state=wifi)" : "未启用")")
                .font(.system(.caption, design: .monospaced))
        }
        .padding(12)
        .frame(maxWidth: .infinity, alignment: .leading)
        .overlay(
            RoundedRectangle(cornerRadius: 8)
                .stroke(Color.secondary.opacity(0.3), lineWidth: 1)
        )
    }

    @ViewBuilder
    private var identitySection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("1. 身份与会话参数").font(.headline)
            Text("identify / login / logout 均为纯本地状态切换（不触发额外事件），原地同步下方待提交请求 JSON")
                .font(.caption)
                .foregroundColor(.secondary)
            HStack(spacing: 8) {
                Button("切换随机访客 ID (identify)") {
                    let customVisitor = "visitor_ios_\(Int(Date().timeIntervalSince1970) % 10000)"
                    try? sdk.identify(customVisitor)
                    ensureDefaultDraftIfEmpty()
                    rebuildDraftPreview()
                }
                .buttonStyle(.bordered)

                Button("设置登录账号 (login)") {
                    try? sdk.login("user_ios_10001")
                    ensureDefaultDraftIfEmpty()
                    rebuildDraftPreview()
                }
                .buttonStyle(.bordered)

                Button("退出登录 (logout)") {
                    sdk.logout()
                    ensureDefaultDraftIfEmpty()
                    rebuildDraftPreview()
                }
                .buttonStyle(.bordered)
            }
        }
    }

    @ViewBuilder
    private var superPropertiesSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("2. 公共属性配置 (Super Properties)").font(.headline)
            Text("自动合入非 $user_* 事件，修改后原地重算下方请求 JSON")
                .font(.caption)
                .foregroundColor(.secondary)

            TextEditor(text: $staticSuperJsonText)
                .font(.system(.caption, design: .monospaced))
                .disableAutocorrection(true)
                .frame(minHeight: 68, maxHeight: 96)
                .padding(4)
                .overlay(
                    RoundedRectangle(cornerRadius: 6)
                        .stroke(Color.secondary.opacity(0.35), lineWidth: 1)
                )

            if !superPropError.isEmpty {
                Text(superPropError)
                    .font(.caption)
                    .foregroundColor(.red)
            }

            HStack(spacing: 8) {
                Button("应用静态公共属性") {
                    applyStaticSuperProperties()
                }
                .buttonStyle(.bordered)

                Button("启用动态公共属性：\(dynamicSuperEnabled ? "开" : "关")") {
                    dynamicSuperEnabled.toggle()
                    if dynamicSuperEnabled {
                        dynamicSeq += 1
                    }
                    ensureDefaultDraftIfEmpty()
                    rebuildDraftPreview()
                }
                .buttonStyle(.bordered)

                Button("清空公共属性") {
                    superPropError = ""
                    dynamicSuperEnabled = false
                    sdk.clearSuperProperties()
                    sdk.setDynamicSuperProperties(nil)
                    ensureDefaultDraftIfEmpty()
                    rebuildDraftPreview()
                }
                .buttonStyle(.bordered)
            }
        }
    }

    @ViewBuilder
    private var batchModeToggleSection: some View {
        Toggle(
            "多条拼批模式（开启后点击事件会追加到待提交 events 数组；关闭时仅预览当前单条）",
            isOn: $appendBatchMode
        )
        .font(.subheadline)
    }

    @ViewBuilder
    private var behaviorEventsSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("3. 行为事件参数构建").font(.headline)
            HStack(spacing: 8) {
                Button("商品浏览事件 (ProductView)") {
                    stageAction(makeProductViewAction())
                }
                .buttonStyle(.bordered)

                Button("① 开始计时 (timeEvent)") {
                    sdk.timeEvent("OrderPaid")
                    orderTimerRunning = true
                }
                .buttonStyle(.bordered)

                Button("② 上报支付事件 ($duration)") {
                    let hadRunningTimer = orderTimerRunning
                    orderTimerRunning = false
                    let orderNo = "ord_ios_\(Int(Date().timeIntervalSince1970) % 100000)"
                    var cachedId: String?
                    var capturedDuration: Double?
                    stageAction(
                        StagedDraftAction(label: "OrderPaid($duration)") { client in
                            if capturedDuration == nil && !hadRunningTimer {
                                client.timeEvent("OrderPaid")
                            }
                            var props: [String: Any] = [
                                "order_id": orderNo,
                                "amount": 199.95,
                                "currency": "CNY"
                            ]
                            if let dur = capturedDuration {
                                props["$duration"] = dur
                            }
                            let evtId = client.track("OrderPaid", properties: props, eventId: cachedId)
                            cachedId = evtId
                            lastOrderEventId = evtId
                            if capturedDuration == nil {
                                let payload = client.buildPendingBatchPayload()
                                if let events = payload["events"] as? [[String: Any]],
                                   let lastProps = events.last?["properties"] as? [String: Any],
                                   let durVal = lastProps["$duration"] as? Double {
                                    capturedDuration = durVal
                                }
                            }
                        }
                    )
                }
                .buttonStyle(.bordered)
            }

            HStack(spacing: 8) {
                Button("64 位雪花大整数 (> 2^53-1)") {
                    var cachedId: String?
                    stageAction(
                        StagedDraftAction(label: "OrderPaid(BigInt)") { client in
                            cachedId = client.track(
                                "OrderPaid",
                                properties: [
                                    "order_id": "ord_snowflake_01",
                                    "snowflake_seq": Int64(9007199254740993),
                                    "amount": 299.0
                                ],
                                eventId: cachedId
                            )
                        }
                    )
                }
                .buttonStyle(.bordered)

                Button("固定 eventId 幂等事件 (OrderSettled)") {
                    stageAction(
                        StagedDraftAction(label: "OrderSettled(eventId)") { client in
                            _ = client.track(
                                "OrderSettled",
                                properties: ["order_id": "ord_snowflake_01", "order_status": "settled", "amount": 199.95],
                                eventId: "evt_ios_order_settled_01"
                            )
                        }
                    )
                }
                .buttonStyle(.bordered)
            }

            if orderTimerRunning {
                Text("⏱ OrderPaid 秒表计时中：点击「② 上报支付事件 ($duration)」即可将实测秒数写入下方请求 JSON。")
                    .font(.caption)
                    .foregroundColor(.orange)
            }
        }
    }

    @ViewBuilder
    private var userProfileSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            Text("4. 用户画像操作参数构建 ($user_*)").font(.headline)
            HStack(spacing: 8) {
                Button("覆盖设置 (userSet)") {
                    stageAction(
                        StagedDraftAction(label: "userSet") { client in
                            client.userSet(["vip_level": "Diamond", "city": "Shanghai"])
                        }
                    )
                }
                .buttonStyle(.bordered)

                Button("首次设置 (userSetOnce)") {
                    stageAction(
                        StagedDraftAction(label: "userSetOnce") { client in
                            client.userSetOnce(["first_channel": "AppStore"])
                        }
                    )
                }
                .buttonStyle(.bordered)

                Button("数值累加 (userAdd +100)") {
                    stageAction(
                        StagedDraftAction(label: "userAdd") { client in
                            client.userAdd(["loyalty_points": NSNumber(value: 100)])
                        }
                    )
                }
                .buttonStyle(.bordered)
            }

            HStack(spacing: 8) {
                Button("列表追加 (userAppend)") {
                    stageAction(
                        StagedDraftAction(label: "userAppend") { client in
                            client.userAppend(["tags": ["ios", "vip"]])
                        }
                    )
                }
                .buttonStyle(.bordered)

                Button("去重追加 (userUniqAppend)") {
                    stageAction(
                        StagedDraftAction(label: "userUniqAppend") { client in
                            client.userUniqAppend(["tags": ["vip", "annual"]])
                        }
                    )
                }
                .buttonStyle(.bordered)

                Button("清空属性 (userUnset)") {
                    stageAction(
                        StagedDraftAction(label: "userUnset") { client in
                            client.userUnset(["temp_badge"])
                        }
                    )
                }
                .buttonStyle(.bordered)

                Button("删除画像 (userDelete)") {
                    stageAction(
                        StagedDraftAction(label: "userDelete") { client in
                            client.userDelete()
                        }
                    )
                }
                .buttonStyle(.bordered)
            }
        }
    }

    @ViewBuilder
    private var requestPreviewSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                VStack(alignment: .leading, spacing: 2) {
                    Text("面板 A：待提交请求 JSON 预览 (POST /collect/api/v1/track/batch)")
                        .font(.headline)
                    Text("当前共 \(pendingCount) 条待提交事件 · Endpoint: \(Self.defaultServerUrl)/collect/api/v1/track/batch")
                        .font(.caption)
                        .foregroundColor(.secondary)
                }
                Spacer()
            }

            HStack(spacing: 10) {
                Button("重置待发参数") {
                    orderTimerRunning = false
                    stagedActions = [makeProductViewAction()]
                    rebuildDraftPreview()
                }
                .buttonStyle(.bordered)

                Button(isSubmitting ? "提交中..." : "确认提交") {
                    handleConfirmSubmit()
                }
                .buttonStyle(.borderedProminent)
                .tint(.green)
                .disabled(isSubmitting || pendingCount == 0)
            }

            Text(requestJsonPreview)
                .font(.system(.caption, design: .monospaced))
                .foregroundColor(.white)
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(red: 0.06, green: 0.09, blue: 0.16))
                .cornerRadius(8)
        }
    }

    @ViewBuilder
    private var responseSection: some View {
        VStack(alignment: .leading, spacing: 8) {
            HStack {
                Text("面板 B：最近一次提交结果 (Response)")
                    .font(.headline)
                Spacer()
                Text(responseStatusHint)
                    .font(.caption)
                    .foregroundColor(responseIsError ? .red : .green)
            }

            Text(responsePreview)
                .font(.system(.caption, design: .monospaced))
                .foregroundColor(responseIsError ? Color(red: 0.99, green: 0.64, blue: 0.69) : Color(red: 0.65, green: 0.95, blue: 0.82))
                .padding(12)
                .frame(maxWidth: .infinity, alignment: .leading)
                .background(Color(red: 0.06, green: 0.09, blue: 0.16))
                .cornerRadius(8)
        }
    }

    private func makeProductViewAction() -> StagedDraftAction {
        var cachedId: String?
        return StagedDraftAction(label: "ProductView") { client in
            cachedId = client.track(
                "ProductView",
                properties: [
                    "sku_id": "sku_kb_pro",
                    "product_name": "ABI 无线双模机械键盘 Pro",
                    "price": 199.0,
                    "in_stock": true
                ],
                eventId: cachedId
            )
        }
    }

    private func ensureDefaultDraftIfEmpty() {
        if stagedActions.isEmpty {
            stagedActions = [makeProductViewAction()]
        }
    }

    private func stageAction(_ action: StagedDraftAction) {
        if appendBatchMode {
            stagedActions.append(action)
        } else {
            stagedActions = [action]
        }
        rebuildDraftPreview()
    }

    private func syncDynamicSuperProperties() {
        if dynamicSuperEnabled {
            let seqSnapshot = dynamicSeq
            sdk.setDynamicSuperProperties {
                [
                    "dyn_sequence": seqSnapshot,
                    "network_state": "wifi"
                ]
            }
        } else {
            sdk.setDynamicSuperProperties(nil)
        }
    }

    private func applyStaticSuperProperties() {
        let trimmed = staticSuperJsonText.trimmingCharacters(in: .whitespacesAndNewlines)
        if trimmed.isEmpty {
            superPropError = ""
            sdk.clearSuperProperties()
            ensureDefaultDraftIfEmpty()
            rebuildDraftPreview()
            return
        }
        guard let data = trimmed.data(using: .utf8),
              let rawObj = try? JSONSerialization.jsonObject(with: data, options: []),
              let dict = rawObj as? [String: Any] else {
            superPropError = "静态公共属性 JSON 格式无效，请输入合法 JSON 对象（例如 {\"channel\": \"AppStore\"}）"
            return
        }
        let previous = sdk.getSuperProperties()
        sdk.clearSuperProperties()
        sdk.setSuperProperties(dict)
        if !dict.isEmpty && sdk.getSuperProperties().isEmpty {
            sdk.setSuperProperties(previous)
            superPropError = "静态公共属性键名或值类型不合法（键名需为字母或下划线开头）"
            return
        }
        superPropError = ""
        ensureDefaultDraftIfEmpty()
        rebuildDraftPreview()
    }

    private func rebuildDraftPreview() {
        sdk.clearPendingQueue()
        syncDynamicSuperProperties()
        for action in stagedActions {
            action.apply(sdk)
        }
        distinctId = sdk.distinctId
        loginId = sdk.currentLoginId
        superPropsSummary = Self.compactJsonString(sdk.getSuperProperties())
        pendingCount = sdk.pendingQueueCount
        requestJsonPreview = sdk.buildPendingBatchJsonString()
    }

    private func handleConfirmSubmit() {
        let submittedCount = sdk.pendingQueueCount
        guard !isSubmitting, submittedCount > 0 else { return }
        isSubmitting = true

        sdk.flush { statusCode, rawBody in
            DispatchQueue.main.async {
                let remaining = sdk.pendingQueueCount
                let succeeded = (200...299).contains(statusCode) && remaining == 0
                let formatted = Self.prettyFormatJsonIfPossible(rawBody)

                isSubmitting = false
                if succeeded {
                    if dynamicSuperEnabled {
                        dynamicSeq += 1
                    }
                    stagedActions = []
                    rebuildDraftPreview()
                    responseIsError = false
                    responseStatusHint = "HTTP \(statusCode) OK · 已提交 \(submittedCount) 条事件"
                    responsePreview = formatted.isEmpty
                        ? "{\n  \"code\" : 200,\n  \"message\" : \"提交成功\",\n  \"submitted_events\" : \(submittedCount)\n}"
                        : formatted
                } else {
                    pendingCount = remaining
                    let statusLabel = statusCode == 0 ? "网关未连接" : "HTTP \(statusCode)"
                    responseIsError = true
                    responseStatusHint = "\(statusLabel) · 待重试 \(remaining) 条"
                    responsePreview = "提交未完成（\(statusLabel)）：\n\(formatted.isEmpty ? "无法连接 \(Self.defaultServerUrl)/collect/api/v1/track/batch" : formatted)\n说明：若本地未启动 :8081 采集网关，SDK 已保留队列中的原始 event_id 供下次幂等重试。"
                }
            }
        }
    }

    private static func compactJsonString(_ dict: [String: Any]) -> String {
        guard JSONSerialization.isValidJSONObject(dict),
              let data = try? JSONSerialization.data(withJSONObject: dict, options: [.sortedKeys]),
              let str = String(data: data, encoding: .utf8) else {
            return "{}"
        }
        return str
    }

    private static func prettyFormatJsonIfPossible(_ raw: String) -> String {
        let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty,
              let data = trimmed.data(using: .utf8),
              let obj = try? JSONSerialization.jsonObject(with: data, options: []),
              let prettyData = try? JSONSerialization.data(withJSONObject: obj, options: [.prettyPrinted, .sortedKeys]),
              let prettyStr = String(data: prettyData, encoding: .utf8) else {
            return trimmed
        }
        return prettyStr
    }
}
