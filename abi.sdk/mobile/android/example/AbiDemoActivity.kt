package com.anylink.abi.sdk.android.example

import android.app.Activity
import android.graphics.Color
import android.graphics.Typeface
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import com.anylink.abi.sdk.android.AbiAnalytics
import org.json.JSONArray
import org.json.JSONObject

/**
 * [AbiAnalytics] 原生 Android 交互式演练页（Activity）与两步式无界面演练入口。
 *
 * 采用与 Web `interactive-demo.html` 完全一致的两步式流程：
 * 1. 配置身份、静态/动态公共属性与业务/画像事件，原地实时刷新唯一一份「待提交请求 JSON 预览」；
 * 2. 点击「确认提交」按钮触发 `sdk.flush()`，并更新唯一一份「最近一次提交结果」（彻底取消无限追加日志刷屏）。
 */
class AbiDemoActivity : Activity() {

    private class StagedDraftAction(
        val label: String,
        val apply: (AbiAnalytics) -> Unit
    )

    private lateinit var sdk: AbiAnalytics
    private lateinit var statusView: TextView
    private lateinit var superJsonInput: EditText
    private lateinit var superErrorView: TextView
    private lateinit var dynamicToggleBtn: Button
    private lateinit var appendBatchCheckBox: CheckBox
    private lateinit var timerHintView: TextView
    private lateinit var draftSummaryView: TextView
    private lateinit var requestPreviewView: TextView
    private lateinit var confirmSubmitBtn: Button
    private lateinit var responseStatusView: TextView
    private lateinit var responsePreviewView: TextView

    private val stagedActions = mutableListOf<StagedDraftAction>()
    private var dynamicSuperEnabled = false
    private var dynamicSequence = 1
    private var orderTimerRunning = false
    private var isSubmitting = false
    private var lastOrderEventId: String = "evt_android_order_001"

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        sdk = AbiAnalytics.init(
            serverUrl = DEFAULT_SERVER_URL,
            projectId = 1L,
            projectToken = "abi_tok_android_demo",
            appVersion = "2.1.0",
            batchSize = 50,
            debug = false,
            autoFlush = false, // 禁用后台定时刷新与自动上报，严格由「确认提交」按钮触发
            context = applicationContext
        )
        sdk.logout()
        sdk.setSuperProperties(
            mapOf(
                "channel" to "GooglePlay",
                "vip_tier" to "Gold"
            )
        )

        val density = resources.displayMetrics.density
        fun dp(value: Int): Int = (value * density).toInt()

        val rootScroll = ScrollView(this)
        val container = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(24))
        }

        statusView = TextView(this).apply {
            textSize = 13f
            typeface = Typeface.MONOSPACE
            setBackgroundColor(Color.parseColor("#F1F5F9"))
            setTextColor(Color.parseColor("#0F172A"))
            setPadding(dp(12), dp(10), dp(12), dp(10))
        }
        container.addView(statusView)

        fun addSectionHeader(title: String, subtitle: String? = null) {
            val header = TextView(this).apply {
                text = title
                textSize = 15f
                setTypeface(typeface, Typeface.BOLD)
                setTextColor(Color.parseColor("#0F172A"))
                setPadding(0, dp(14), 0, dp(2))
            }
            container.addView(header)
            if (!subtitle.isNullOrEmpty()) {
                val sub = TextView(this).apply {
                    text = subtitle
                    textSize = 12f
                    setTextColor(Color.parseColor("#64748B"))
                    setPadding(0, 0, 0, dp(6))
                }
                container.addView(sub)
            }
        }

        fun addActionButton(label: String, action: () -> Unit): Button {
            val btn = Button(this).apply {
                text = label
                isAllCaps = false
                setOnClickListener { action() }
            }
            container.addView(btn)
            return btn
        }

        // 1. 身份与会话参数
        addSectionHeader("1. 身份与会话参数", "identify / login / logout 均为纯本地状态切换（不触发额外事件），原地重算待提交请求 JSON")
        addActionButton("切换随机访客 ID (identify)") {
            val customVisitor = "visitor_android_${System.currentTimeMillis() % 10000}"
            sdk.identify(customVisitor)
            ensureDefaultDraftIfEmpty()
            rebuildDraftPreview()
        }
        addActionButton("设置登录账号 (login)") {
            sdk.login("user_android_10001")
            ensureDefaultDraftIfEmpty()
            rebuildDraftPreview()
        }
        addActionButton("退出登录 (logout)") {
            sdk.logout()
            ensureDefaultDraftIfEmpty()
            rebuildDraftPreview()
        }

        // 2. 公共属性配置
        addSectionHeader("2. 公共属性配置 (Super Properties)", "自动合入非 \$user_* 事件，修改后实时刷新下方请求体")
        superJsonInput = EditText(this).apply {
            setText("{\n  \"channel\": \"GooglePlay\",\n  \"vip_tier\": \"Gold\"\n}")
            textSize = 12.5f
            typeface = Typeface.MONOSPACE
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_FLAG_MULTI_LINE
            minLines = 3
            setBackgroundColor(Color.parseColor("#F8FAFC"))
            setPadding(dp(10), dp(8), dp(10), dp(8))
        }
        container.addView(superJsonInput)

        superErrorView = TextView(this).apply {
            textSize = 12f
            setTextColor(Color.parseColor("#DC2626"))
            visibility = View.GONE
            setPadding(0, dp(4), 0, dp(4))
        }
        container.addView(superErrorView)

        addActionButton("应用静态公共属性") {
            applyStaticSuperPropertiesFromInput()
        }
        dynamicToggleBtn = addActionButton("启用动态公共属性：关") {
            dynamicSuperEnabled = !dynamicSuperEnabled
            if (dynamicSuperEnabled) {
                dynamicSequence += 1
            }
            ensureDefaultDraftIfEmpty()
            rebuildDraftPreview()
        }
        addActionButton("清空公共属性") {
            superErrorView.visibility = View.GONE
            dynamicSuperEnabled = false
            sdk.clearSuperProperties()
            sdk.setDynamicSuperProperties(null)
            ensureDefaultDraftIfEmpty()
            rebuildDraftPreview()
        }

        // 多条拼批开关
        appendBatchCheckBox = CheckBox(this).apply {
            text = "多条拼批模式（勾选后点击事件追加到 events 数组；未勾选每次仅预览单条事件）"
            textSize = 13f
            setPadding(dp(4), dp(10), dp(4), dp(6))
        }
        container.addView(appendBatchCheckBox)

        // 3. 行为事件参数构建
        addSectionHeader("3. 行为事件参数构建", "点击生成或追加待提交请求 JSON")
        addActionButton("商品浏览事件 (ProductView)") {
            stageAction(createProductViewAction())
        }
        addActionButton("① 开始事件计时 (timeEvent)") {
            sdk.timeEvent("OrderPaid")
            orderTimerRunning = true
            timerHintView.visibility = View.VISIBLE
        }
        addActionButton("② 上报支付事件 (\$duration)") {
            val hadTimer = orderTimerRunning
            orderTimerRunning = false
            timerHintView.visibility = View.GONE
            val orderNo = "ord_${System.currentTimeMillis() % 100000}"
            var cachedEventId: String? = null
            var capturedDuration: Double? = null
            stageAction(
                StagedDraftAction("OrderPaid(\$duration)") { instance ->
                    if (capturedDuration == null && !hadTimer) {
                        instance.timeEvent("OrderPaid")
                    }
                    val props = LinkedHashMap<String, Any?>().apply {
                        put("order_id", orderNo)
                        put("amount", 299.95)
                        put("currency", "CNY")
                        if (capturedDuration != null) {
                            put("\$duration", capturedDuration)
                        }
                    }
                    val id = instance.track(
                        eventName = "OrderPaid",
                        properties = props,
                        eventId = cachedEventId
                    )
                    cachedEventId = id
                    lastOrderEventId = id
                    if (capturedDuration == null) {
                        val events = instance.buildPendingBatchPayload().optJSONArray("events")
                        val lastEvt = if (events != null && events.length() > 0) {
                            events.optJSONObject(events.length() - 1)
                        } else {
                            null
                        }
                        val durVal = lastEvt?.optJSONObject("properties")?.optDouble("\$duration")
                        if (durVal != null && !durVal.isNaN()) {
                            capturedDuration = durVal
                        }
                    }
                }
            )
        }
        addActionButton("64 位雪花大整数 (BigInt > 2^53-1)") {
            var cachedEventId: String? = null
            stageAction(
                StagedDraftAction("OrderPaid(BigInt)") { instance ->
                    cachedEventId = instance.track(
                        eventName = "OrderPaid",
                        properties = mapOf(
                            "order_id" to "ord_snowflake_01",
                            "snowflake_seq" to 9007199254740993L,
                            "amount" to 299.0
                        ),
                        eventId = cachedEventId
                    )
                }
            )
        }
        addActionButton("固定 eventId 幂等事件 (OrderSettled)") {
            stageAction(
                StagedDraftAction("OrderSettled(eventId)") { instance ->
                    instance.track(
                        eventName = "OrderSettled",
                        properties = mapOf("order_id" to "ord_snowflake_01", "order_status" to "settled", "amount" to 299.95),
                        eventId = "evt_android_order_settled_01"
                    )
                }
            )
        }

        timerHintView = TextView(this).apply {
            text = "⏱ OrderPaid 秒表计时中：点击「② 上报支付事件 (\$duration)」即可将实测秒数写入下方请求参数。"
            textSize = 12f
            setTextColor(Color.parseColor("#B45309"))
            visibility = View.GONE
            setPadding(0, dp(4), 0, dp(4))
        }
        container.addView(timerHintView)

        // 4. 用户画像操作参数构建 ($user_*)
        addSectionHeader("4. 用户画像操作参数构建 (\$user_*)", "自动隔离公共属性 · 对应 abi.dim_users")
        addActionButton("覆盖设置画像 (userSet)") {
            stageAction(
                StagedDraftAction("userSet") {
                    it.userSet(mapOf("vip_level" to "Platinum", "city" to "Shanghai"))
                }
            )
        }
        addActionButton("首次设置画像 (userSetOnce)") {
            stageAction(
                StagedDraftAction("userSetOnce") {
                    it.userSetOnce(mapOf("first_install_channel" to "GooglePlay"))
                }
            )
        }
        addActionButton("数值累加画像 (userAdd +100)") {
            stageAction(
                StagedDraftAction("userAdd") {
                    it.userAdd(mapOf("loyalty_points" to 100))
                }
            )
        }
        addActionButton("列表追加画像 (userAppend)") {
            stageAction(
                StagedDraftAction("userAppend") {
                    it.userAppend(mapOf("interests" to listOf("analytics", "kotlin")))
                }
            )
        }
        addActionButton("列表去重追加 (userUniqAppend)") {
            stageAction(
                StagedDraftAction("userUniqAppend") {
                    it.userUniqAppend(mapOf("interests" to listOf("kotlin", "starrocks")))
                }
            )
        }
        addActionButton("清空指定画像 (userUnset)") {
            stageAction(
                StagedDraftAction("userUnset") {
                    it.userUnset("temp_campaign_flag")
                }
            )
        }
        addActionButton("删除用户画像 (userDelete)") {
            stageAction(
                StagedDraftAction("userDelete") {
                    it.userDelete()
                }
            )
        }

        // 面板 A：待提交请求 JSON 预览 + 重置待发参数 + 确认提交按钮
        addSectionHeader(
            "面板 A：待提交请求 JSON 预览 (POST /collect/api/v1/track/batch)",
            "Endpoint: $DEFAULT_SERVER_URL/collect/api/v1/track/batch"
        )
        draftSummaryView = TextView(this).apply {
            textSize = 12f
            setTextColor(Color.parseColor("#334155"))
            setPadding(0, 0, 0, dp(6))
        }
        container.addView(draftSummaryView)

        val actionRow = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            setPadding(0, 0, 0, dp(8))
        }
        val resetDraftBtn = Button(this).apply {
            text = "重置待发参数"
            isAllCaps = false
            setOnClickListener {
                orderTimerRunning = false
                timerHintView.visibility = View.GONE
                stagedActions.clear()
                stagedActions.add(createProductViewAction())
                rebuildDraftPreview()
            }
        }
        confirmSubmitBtn = Button(this).apply {
            text = "确认提交"
            isAllCaps = false
            setBackgroundColor(Color.parseColor("#10B981"))
            setTextColor(Color.parseColor("#022C22"))
            setTypeface(typeface, Typeface.BOLD)
            setOnClickListener { handleConfirmSubmit() }
        }
        actionRow.addView(resetDraftBtn)
        actionRow.addView(confirmSubmitBtn)
        container.addView(actionRow)

        requestPreviewView = TextView(this).apply {
            textSize = 12f
            typeface = Typeface.MONOSPACE
            setBackgroundColor(Color.parseColor("#0F172A"))
            setTextColor(Color.parseColor("#E2E8F0"))
            setPadding(dp(12), dp(12), dp(12), dp(12))
            setTextIsSelectable(true)
        }
        container.addView(requestPreviewView)

        // 面板 B：最近一次提交结果（仅在点击「确认提交」后更新）
        addSectionHeader("面板 B：最近一次提交结果 (Response)", "仅在点击「确认提交」发送后更新单次响应状态与结果")
        responseStatusView = TextView(this).apply {
            text = "尚未提交"
            textSize = 12f
            setTextColor(Color.parseColor("#475569"))
            setPadding(0, 0, 0, dp(6))
        }
        container.addView(responseStatusView)

        responsePreviewView = TextView(this).apply {
            text = "点击上方「确认提交」发送待提交请求 JSON。"
            textSize = 12f
            typeface = Typeface.MONOSPACE
            setBackgroundColor(Color.parseColor("#0F172A"))
            setTextColor(Color.parseColor("#A7F3D0"))
            setPadding(dp(12), dp(12), dp(12), dp(12))
            setTextIsSelectable(true)
        }
        container.addView(responsePreviewView)

        rootScroll.addView(container)
        setContentView(rootScroll)

        stagedActions.add(createProductViewAction())
        rebuildDraftPreview()
    }

    private fun createProductViewAction(): StagedDraftAction {
        var cachedEventId: String? = null
        return StagedDraftAction("ProductView") { instance ->
            cachedEventId = instance.track(
                eventName = "ProductView",
                properties = mapOf(
                    "sku_id" to "sku_kb_pro",
                    "product_name" to "ABI 无线双模机械键盘 Pro",
                    "price" to 199.0,
                    "in_stock" to true
                ),
                eventId = cachedEventId
            )
        }
    }

    private fun ensureDefaultDraftIfEmpty() {
        if (stagedActions.isEmpty()) {
            stagedActions.add(createProductViewAction())
        }
    }

    private fun stageAction(action: StagedDraftAction) {
        if (appendBatchCheckBox.isChecked) {
            stagedActions.add(action)
        } else {
            stagedActions.clear()
            stagedActions.add(action)
        }
        rebuildDraftPreview()
    }

    private fun syncDynamicSuperProps() {
        if (dynamicSuperEnabled) {
            val seqSnapshot = dynamicSequence
            sdk.setDynamicSuperProperties {
                mapOf(
                    "dyn_sequence" to seqSnapshot,
                    "network_state" to "wifi"
                )
            }
            dynamicToggleBtn.text = "启用动态公共属性：开"
        } else {
            sdk.setDynamicSuperProperties(null)
            dynamicToggleBtn.text = "启用动态公共属性：关"
        }
    }

    private fun applyStaticSuperPropertiesFromInput() {
        val raw = superJsonInput.text?.toString()?.trim().orEmpty()
        val previousProps = sdk.getSuperProperties()
        try {
            val parsedMap = LinkedHashMap<String, Any>()
            if (raw.isNotEmpty()) {
                val jsonObj = JSONObject(raw)
                val keys = jsonObj.keys()
                while (keys.hasNext()) {
                    val key = keys.next()
                    val value = jsonObj.get(key)
                    if (value === JSONObject.NULL) continue
                    parsedMap[key] = convertJsonValue(value)
                }
            }
            sdk.clearSuperProperties()
            sdk.setSuperProperties(parsedMap)
            superErrorView.visibility = View.GONE
            ensureDefaultDraftIfEmpty()
            rebuildDraftPreview()
        } catch (e: Exception) {
            sdk.clearSuperProperties()
            sdk.setSuperProperties(previousProps)
            superErrorView.text = "静态公共属性 JSON 格式或键值有误：${e.message}"
            superErrorView.visibility = View.VISIBLE
        }
    }

    private fun convertJsonValue(value: Any): Any =
        when (value) {
            is JSONArray -> {
                val list = ArrayList<Any>(value.length())
                for (i in 0 until value.length()) {
                    val elem = value.get(i)
                    require(elem !== JSONObject.NULL && elem !is JSONObject && elem !is JSONArray) {
                        "列表属性元素仅支持基础类型"
                    }
                    list.add(elem)
                }
                list
            }
            is JSONObject -> throw IllegalArgumentException("公共属性值不支持嵌套 JSON 对象")
            else -> value
        }

    private fun rebuildDraftPreview() {
        sdk.clearPendingQueue()
        syncDynamicSuperProps()
        stagedActions.forEach { it.apply(sdk) }

        val payload = sdk.buildPendingBatchPayload()
        val pendingCount = sdk.pendingQueueSize
        requestPreviewView.text = payload.toString(2)
        draftSummaryView.text = "当前共 $pendingCount 条待提交事件"
        confirmSubmitBtn.isEnabled = !isSubmitting && pendingCount > 0

        val loginLabel = sdk.loginId.ifEmpty { "(未登录)" }
        val superSummary = JSONObject(sdk.getSuperProperties()).toString()
        val dynSummary = if (dynamicSuperEnabled) {
            "已启用 (dyn_sequence=$dynamicSequence, network_state=wifi)"
        } else {
            "未启用"
        }
        statusView.text = buildString {
            appendLine("ABI Android SDK 交互式演练")
            appendLine("distinct_id   : ${sdk.distinctId}")
            appendLine("login_id      : $loginLabel")
            appendLine("superProps    : $superSummary")
            append("dynamicSuper  : $dynSummary")
        }
    }

    private fun handleConfirmSubmit() {
        val submittedCount = sdk.pendingQueueSize
        if (isSubmitting || submittedCount == 0) return
        isSubmitting = true
        confirmSubmitBtn.isEnabled = false
        confirmSubmitBtn.text = "提交中..."

        Thread {
            sdk.flush()
            val code = sdk.lastFlushStatusCode
            val rawBody = sdk.lastFlushResponseBody
            val remaining = sdk.pendingQueueSize
            val succeeded = code in 200..299 && remaining == 0

            val formattedBody = if (rawBody.isNotBlank()) {
                try {
                    JSONObject(rawBody).toString(2)
                } catch (_: Exception) {
                    rawBody
                }
            } else {
                ""
            }

            runOnUiThread {
                isSubmitting = false
                confirmSubmitBtn.text = "确认提交"
                if (succeeded) {
                    if (dynamicSuperEnabled) {
                        dynamicSequence += 1
                    }
                    stagedActions.clear()
                    rebuildDraftPreview()
                    responseStatusView.setTextColor(Color.parseColor("#059669"))
                    responseStatusView.text = "HTTP $code OK · 已提交 $submittedCount 条事件"
                    responsePreviewView.setTextColor(Color.parseColor("#A7F3D0"))
                    responsePreviewView.text = formattedBody.ifEmpty {
                        JSONObject().apply {
                            put("code", 200)
                            put("message", "提交成功")
                            put("submitted_events", submittedCount)
                        }.toString(2)
                    }
                } else {
                    confirmSubmitBtn.isEnabled = sdk.pendingQueueSize > 0
                    val statusText = if (code == 0) "网关未连接" else "HTTP $code"
                    responseStatusView.setTextColor(Color.parseColor("#DC2626"))
                    responseStatusView.text = "$statusText · 队列剩余 $remaining 条待发"
                    responsePreviewView.setTextColor(Color.parseColor("#FDA4AF"))
                    responsePreviewView.text = buildString {
                        appendLine("请求结果：$statusText")
                        if (formattedBody.isNotEmpty()) {
                            appendLine(formattedBody)
                        }
                        append("说明：若宿主机未启动 :8081 采集网关，SDK 已保留原始 event_id 供下次幂等重试。")
                    }
                }
            }
        }.start()
    }

    companion object {
        private const val DEFAULT_SERVER_URL = "http://10.0.2.2:8081"

        /**
         * 两步式无界面演练（第 1 步）：配置身份、静态/动态公共属性、计时与幂等里程碑事件及全套 `$user_*` 画像操作，
         * 构建并返回即将提交给 `POST /collect/api/v1/track/batch` 的格式化具体请求 JSON 字符串（不自动触发发送）。
         */
        @JvmStatic
        fun previewScenarioPayload(sdk: AbiAnalytics): String {
            sdk.clearPendingQueue()
            sdk.clearSuperProperties()
            sdk.logout()

            sdk.identify("visitor_android_demo_001")
            sdk.login("user_android_8888")
            sdk.setSuperProperties(mapOf("channel" to "GooglePlay_Demo", "env" to "staging"))
            sdk.setDynamicSuperProperties { mapOf("dyn_sequence" to 1) }

            sdk.timeEvent("OrderPaid")
            sdk.track(
                eventName = "OrderPaid",
                properties = mapOf(
                    "order_id" to "ord_android_1001",
                    "amount" to 199.0,
                    "big_int_order_seq" to 9007199254740993L
                ),
                eventId = "evt_android_order_1001"
            )
            sdk.track(
                eventName = "OrderSettled",
                properties = mapOf("order_id" to "ord_android_1001", "order_status" to "settled", "amount" to 189.0),
                eventId = "evt_android_order_settled_1001"
            )

            sdk.userSet(mapOf("vip_level" to "Diamond", "city" to "Beijing"))
            sdk.userSetOnce(mapOf("first_channel" to "organic"))
            sdk.userAdd(mapOf("loyalty_points" to 100))
            sdk.userAppend(mapOf("tags" to listOf("mobile", "vip")))
            sdk.userUniqAppend(mapOf("tags" to listOf("vip", "annual")))
            sdk.userUnset("legacy_flag")
            sdk.userDelete()

            return sdk.buildPendingBatchPayload().toString(2)
        }

        /**
         * 两步式无界面演练（第 2 步）：确认提交当前待发队列（请在工作线程调用），并返回单份响应 JSON 摘要。
         */
        @JvmStatic
        fun confirmSubmit(sdk: AbiAnalytics): String {
            val pendingBefore = sdk.pendingQueueSize
            sdk.flush()
            return JSONObject().apply {
                put("http_status", sdk.lastFlushStatusCode)
                put("submitted_count", pendingBefore - sdk.pendingQueueSize)
                put("remaining_queue_size", sdk.pendingQueueSize)
                put("response_body", sdk.lastFlushResponseBody)
            }.toString(2)
        }
    }
}
