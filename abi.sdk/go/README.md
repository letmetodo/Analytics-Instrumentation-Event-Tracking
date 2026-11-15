# ABI Go 服务端 SDK (`github.com/anylink/abi-go-sdk`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`abi-go-sdk` 是 **ABI 企业级用户行为分析（UBA）与 BI 平台** 的官方 Go 服务端数据采集 SDK（API 设计对标数数科技 ThinkingData / 神策分析 Sensors Data）。SDK 采用纯 Go 标准库实现（**零第三方依赖**），内置严格的标识符与属性规范化校验、64 位大整数精度保护以及四种可插拔传输消费者（Consumer）。

---

## 1. 核心特性与四大 Consumer 架构

### 核心特性
- **零第三方依赖**：100% 基于 Go 1.22+ 标准库构建，不引入任何外部依赖包，杜绝依赖版本冲突。
- **并发安全**：`AbiAnalytics` 客户端及所有内置 Consumer 均采用并发安全设计，支持在全局单例模式下跨数千个 Goroutine 安全并发调用。
- **客户端前置强校验**：本地自动执行事件名与属性键正则校验（`^[a-zA-Z$#][a-zA-Z0-9_$#]{0,127}$`，且仅允许开放白名单中的系统预置名称）、UTF-8 编码检查及字节长度限制（`distinct_id`/`event_id` ≤ 64 字节，`login_id` ≤ 128 字节；`distinct_id` 与 `login_id` 至少一个非空，绝不将 `login_id` 回退复制进 `distinct_id`）。
- **64 位雪花 ID 精度安全（`> 2^53 - 1` 自动转字符串）**：对绝对值超过 IEEE-754 双精度安全整数上限（`9007199254740991`）的 `int64` / `uint64` 属性值（含数组元素），自动序列化为十进制字符串，彻底防止前端 JSON 解析或跨语言传输精度丢失。
- **静态与动态公共属性分层合并**：严格遵循 `静态公共属性 < 动态公共属性 < 单次事件属性` 覆盖优先级，并在 `$user_*` / `#user_*` 画像操作中自动隔离公共属性，防止行为环境字段污染用户画像表。
- **预置时间与客户端 IP 自动识别**：支持在事件属性中传入 `#time` / `$time`（自动解析为事件毫秒级 `timestamp` 并从 `properties` 中剥离）以及 `#ip` / `$ip`（供采集网关执行服务端 GeoIP 地域解析覆盖）。

### 四大 Consumer 架构

| Consumer 类型 | 构造函数 | 适用场景与核心能力 |
| :--- | :--- | :--- |
| **`StagingConsumer`** | `abi.NewStagingConsumer` | **两步式预览与确认提交**：将埋点事件暂存在内存队列中，先通过 `PreviewRequestJSON()` 预览即将发送至 `POST /collect/api/v1/track/batch` 的完整格式化 JSON（零网络副作用），核对无误后再通过 `SubmitToGateway()` 或 `ConfirmSubmit()` 正式提交。 |
| **`BatchConsumer`** | `abi.NewBatchConsumer` | **生产高吞吐异步批量上报**：支持内存缓冲队列、按批量条数（`BatchSize`，默认 50，最大 500）与时间间隔（`FlushInterval`，默认 3s）双触发异步刷盘、Gzip 压缩传输，以及针对 `429` / `5xx` 响应的指数退避幂等重试（保留原 `event_id` 确保 StarRocks 去重）。 |
| **`LoggerConsumer`** | `abi.NewLoggerConsumer` | **本地 JSONL 轮转落盘**：将事件按行序列化为 JSONL（Newline-delimited JSON）写入本地磁盘，支持按天（`RotateDaily`）、按小时（`RotateHourly`）及单文件大小上限（`MaxFileSizeMB`）自动切分轮转，完美配合 Filebeat / Vector / LogBus 旁路采集。 |
| **`DebugConsumer`** | `abi.NewDebugConsumer` | **研发期同步 L4 强校验与 `dry_run`**：逐条同步发送事件并开启 `debug=true`（可选 `DryRun: true` 仅校验不写入 Kafka / StarRocks），若触发网关 L3/L4 元数据或契约错误则立即返回详细拒绝原因。 |

---

## 2. 安装与环境要求

- **Go 版本要求**：Go `1.22` 及以上
- **第三方依赖**：无（仅依赖 Go 标准库）

```bash
go get github.com/anylink/abi-go-sdk
```

在 ABI 单体仓库内联调或测试时，可直接进入 `abi.sdk/go` 目录执行命令。

---

## 3. 服务端接入必填字段与客户端透传指南（IP / 身份 / 时间 / 幂等键）

### 3.1 为什么服务端 SDK 与前端 / 移动端 SDK 必填项不同？

- **前端 / 移动端 SDK（Web / iOS / Android / 小程序）**：运行在**单用户终端设备**上且由客户端直连采集网关。SDK 会自动在设备本地生成并持久化 `distinct_id`（访客/设备标识，对标数数科技 `getDistinctId()`），调用 `login(accountId)` 仅在本地内存中保存 `login_id`（不发送单独绑定事件），同时采集网关可直接从客户端 TCP 连接中提取用户真实公网 IP。
- **Go / Java 服务端 SDK**：是运行在**后端机房或云 VPC 内的无状态多用户共享单例**。服务端 SDK 既不能在内存中缓存单用户会话状态，直连 `:8081` 采集网关时暴露的也是**后端服务器内网/机房出口 IP**（使用 `LoggerConsumer` 落盘时更无客户端连接上下文）。因此，**用户身份、真实客户端 IP、实际业务发生时间、业务幂等键**均需由接入研发人员从当前请求上下文或消息体中显式传入。

### 3.2 服务端接入字段必填性与来源对照表

| 字段分类 | SDK 参数 / `properties` 键名 | 必填性级别 | 为什么需要 & 研发接入来源说明 |
| :--- | :--- | :--- | :--- |
| **用户身份标识**<br>(`login_id` / `distinct_id`) | Go: `accountID`(`login_id`) + `distinctID`(`distinct_id`)<br>或 `TrackOptions{AccountID, DistinctID}` | **【每次调用必填】** | 严格对齐数数科技双 ID 模型：协议层仅传输 `distinct_id`（访客/设备 ID，≤ 64 字节）与 `login_id`（实名账号 ID，≤ 128 字节），**两者至少一个非空**（当 `distinct_id` 为空时直接传输 `distinct_id: ""` 与 `login_id`，绝不将 `login_id` 回退复制进 `distinct_id`）。<br>若要打通**「前端访客浏览 → 后端下单支付」**全链路漏斗，前端需通过 HTTP 请求头（如 `X-ABI-Distinct-Id: abi.getDistinctId()`）将访客 `distinct_id` 透传给后端；当任意 `Track*` 或 `User*` 事件同时携带非空 `login_id` 与 `distinct_id` 时，Flink 流式引擎会自动完成双 ID 实名映射绑定。 |
| **用户真实客户端 IP**<br>(`#ip` / `$ip`) | `properties["#ip"]`<br>（或 `properties["$ip"]`） | **【需地域分析时必传】** | 服务端请求采集网关 `:8081` 时，网关 TCP 连接看到的是**后端服务器机房 IP**（`LoggerConsumer` 落盘更无连接 IP）。**若不传 `#ip` / `$ip`，所有服务端事件的国家/省/市地域都会变成机房所在地或局域网 IP！**<br>服务端必须从客户端 HTTP 请求头（`X-Forwarded-For` 首跳公网 IP 或 `X-Real-IP`）提取用户真实公网 IP，写入 `properties["#ip"]`（或 `"$ip"`）。采集网关与 Flink Job1 ETL 会优先按 `#ip` > `$ip` 解析国家/省/市（`$country` / `$province` / `$city`），并自动从入库 `properties` 中剥离该临时键。 |
| **事件发生时间**<br>(`#time` / `$time` / `Timestamp`) | `properties["#time"]` / `properties["$time"]`<br>或 `TrackOptions.Timestamp` | **【实时可省，异步 MQ / 回调 / 补数必传】** | 实时同步 HTTP 接口不传时默认取服务端当前时间；但在 **Kafka/RocketMQ 异步消费、第三方支付回调、离线跑批补数** 场景下，事件处理时间晚于实际发生时间，必须通过 `properties["#time"]`（支持 `time.Time`、毫秒时间戳、RFC3339 或 `"2006-01-02 15:04:05.000"`）或 `TrackOptions.Timestamp` 传入真实业务发生时间（须在项目 `ts_window_days` 窗口内，提取后自动从 `properties` 剥离）。 |
| **幂等事件 ID**<br>(`event_id`) | `TrackOptions.EventID` | **【MQ 消费与核心交易强烈推荐必传】** | 不传时 SDK 会自动生成随机 UUIDv4；但在 **MQ 消费重试、支付回调重放、离线补数重跑** 场景下，若每次重试生成新 UUID 会导致订单/金额重复统计。强烈推荐通过 `TrackWithOptions` 传入确定性业务主键（如 `"ord_paid_" + orderNo`，≤ 64 字节），利用 StarRocks 主键模型实现同日幂等去重（注：`TrackFirst` / `TrackUpdate` / `TrackOverwrite` 按 D7① / G6 门禁当前版本未开放，调用将返回 `ErrUnsupportedMutableTrack`）。 |
| **客户端设备上下文**<br>(`$os` / `$app_version` / `$device_model`) | `properties["$os"]`<br>`properties["$app_version"]`<br>`properties["$device_model"]` | **【按需从前端透传】** | 服务端无法自动获知用户的手机型号或客户端 App 版本。若需要在服务端事件（如支付成功）中按客户端 OS 或 App 版本做维度细分，需从前端请求头（如 `X-Client-OS`、`X-App-Version`）提取并写入单次事件 `properties`（切勿放入全局 `SetSuperProperties`，否则所有用户会被固定为同一版本）。 |

---

## 4. 快速开始与生产接入代码示例

### 4.1 两步式预览请求 JSON 与确认提交（`StagingConsumer`）

在研发联调或自动化断言中，推荐先预览完整请求 JSON，确认参数（含客户端透传 `#ip`、订单号 `order_id` 等）和公共属性无误后再提交至网关或转发给其他 Consumer：

```go
package main

import (
	"fmt"
	"log"

	abi "github.com/anylink/abi-go-sdk"
)

func main() {
	// 第 1 步：创建 StagingConsumer（projectID=1, dryRun=false），在内存中录制埋点
	staging := abi.NewStagingConsumer(1, "abi_tok_demo_go", false)
	sdk := abi.New(staging)

	_ = sdk.SetSuperProperties(map[string]any{
		"$platform":    "GoServer",
		"service_name": "order-service",
	})

	_ = sdk.Track("acct_900102", "vis_dev_7f8e9a01", "OrderPaid", map[string]any{
		"#ip":          "203.0.113.42",          // 从客户端 X-Forwarded-For / X-Real-IP 提取的真实公网 IP
		"order_id":     int64(9007199254740999), // > 2^53-1 雪花 ID，自动转为字符串 "9007199254740999"
		"order_no":     "ORD-20261110-8801",
		"amount":       2549.15,
		"$os":          "iOS",                   // 按需从前端请求头透传的客户端系统上下文
		"$app_version": "2.5.0",
	})

	// 预览完整 POST /collect/api/v1/track/batch 请求体 JSON（零网络请求）
	reqJSON, err := staging.PreviewRequestJSON()
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("=== 待提交请求 JSON 预览 ===")
	fmt.Println(reqJSON)

	// 第 2 步（方式 A）：确认无误后直接提交至 ABI 采集网关并获取响应信封
	env, err := staging.SubmitToGateway(abi.BatchConfig{
		ServerURL:    "http://127.0.0.1:8081",
		CompressGzip: true,
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("提交成功: accepted=%d, rejected=%d, request_id=%s\n",
		env.Data.Accepted, env.Data.Rejected, env.RequestID)

	// 第 2 步（方式 B）：或者通过 ConfirmSubmit 投递给任意已初始化的目标 Consumer（如 BatchConsumer / LoggerConsumer）
	// _ = staging.ConfirmSubmit(batchConsumer)
}
```

### 4.2 生产高吞吐 `BatchConsumer`、HTTP 请求头透传与全功能 API 示例

以下示例涵盖 `BatchConsumer` 初始化、从客户端 HTTP 请求头提取访客 `distinct_id` 与真实 IP、基于 `TrackWithOptions` 传入确定性幂等 `EventID`、行为事件上报（含 `#time`/`$time` 时间提取、`#ip`/`$ip` GeoIP 覆盖、超 `2^53 - 1` 大整数自动转字符串）以及全部 7 类用户画像操作：

```go
package main

import (
	"log"
	"net/http"
	"runtime"
	"strings"
	"time"

	abi "github.com/anylink/abi-go-sdk"
)

// extractClientIP 从反向代理请求头中提取客户端真实公网 IP（避免将后端机房 IP 误记为用户地域）
func extractClientIP(r *http.Request) string {
	if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	return strings.TrimSpace(r.Header.Get("X-Real-IP"))
}

func main() {
	// 1. 初始化生产高吞吐异步批量 Consumer（支持 Gzip 压缩与指数退避重试）
	consumer, err := abi.NewBatchConsumer(abi.BatchConfig{
		ServerURL:     "http://127.0.0.1:8081",
		ProjectID:     1,
		ProjectToken:  "abi_tok_prod_xxx",
		BatchSize:     100,
		FlushInterval: 2 * time.Second,
		MaxCacheSize:  10000,
		Timeout:       10 * time.Second,
		MaxRetries:    3,
		CompressGzip:  true,
		OnError: func(err error, dropped []abi.TrackEvent) {
			log.Printf("[ABI SDK] 批量上报失败 (dropped=%d): %v", len(dropped), err)
		},
	})
	if err != nil {
		log.Fatal(err)
	}

	sdk := abi.New(consumer)
	defer sdk.Close() // 进程退出前排空缓冲队列并安全关闭

	// 2. 静态公共属性管理（仅放服务端自身环境属性，切勿放入单个用户的 IP 或设备信息）
	_ = sdk.SetSuperProperties(map[string]any{
		"$platform":    "GoServer",
		"service_name": "checkout-service",
		"temp_flag":    "will_be_removed",
	})
	sdk.UnsetSuperProperty("temp_flag")
	currentSuper := sdk.GetSuperProperties()
	_ = currentSuper
	// 如需清空全部静态公共属性可调用：sdk.ClearSuperProperties()

	// 3. 动态公共属性（每次构造行为事件时实时求值，优先级：静态公共属性 < 动态公共属性 < 事件属性）
	sdk.SetDynamicSuperProperties(func() map[string]any {
		return map[string]any{
			"server_region":   "ap-shanghai",
			"goroutine_count": runtime.NumGoroutine(),
		}
	})

	// 模拟从当前请求上下文与前端透传 Header（如 X-ABI-Distinct-Id、X-Forwarded-For）获取身份与客户端 IP
	accountID := "acct_900102"
	distinctID := "vis_dev_7f8e9a01" // 来自前端透传 Header: r.Header.Get("X-ABI-Distinct-Id")
	clientIP := "203.0.113.42"       // 来自 extractClientIP(r)

	// 4. 双 ID 自动身份关联：无需调用任何单独身份绑定接口；任意 Track* 或 User* 事件同时携带 accountID (login_id) 与 distinctID 时，Flink 自动完成实名归一
	_ = sdk.Track(accountID, distinctID, "$login", map[string]any{
		"#ip":          clientIP,
		"login_method": "sso_oidc",
	})

	// 5. 行为事件上报
	// 5.1 标准行为事件 Track（含 #ip 客户端真实 IP、#time 实际业务发生时间、order_id 雪花大整数自动转字符串）
	_ = sdk.Track(accountID, distinctID, "OrderPaid", map[string]any{
		"#time":        "2026-11-10 14:30:00.125", // 或传 time.Time / 毫秒时间戳 / "$time"，自动提取为事件 timestamp 并从 properties 中剥离
		"#ip":          clientIP,                  // 必传客户端真实公网 IP（支持 "#ip" 或 "$ip"），避免地域变成后端机房 IP
		"order_id":     int64(9007199254740999),   // 超过 2^53-1 (9007199254740991)，自动转为字符串 "9007199254740999"
		"order_no":     "ORD-20261110-8801",
		"amount":       2549.15,
		"item_skus":    []string{"sku_abi_ent", "sku_addon_flink"},
		"$os":          "iOS",                     // 按需从前端请求头透传的客户端上下文
		"$app_version": "2.5.0",
	})

	// 5.1b MQ 消费 / 支付回调推荐使用 TrackWithOptions 显式指定幂等 EventID 与业务发生时间 Timestamp
	_ = sdk.TrackWithOptions(abi.TrackOptions{
		EventID:    "ord_paid_ORD-20261110-8801", // 确定性业务主键，防止 MQ 重放重复计数
		EventName:  "OrderPaid",
		AccountID:  accountID,
		DistinctID: distinctID,                   // 同时携带前端透传的访客 distinct_id，打通前后端转化漏斗（若无前端上下文可传 ""）
		Timestamp:  time.Now().UTC(),             // 异步消费时传入实际业务发生时间
		Properties: map[string]any{
			"#ip":      clientIP,
			"order_id": int64(9007199254740999),
			"order_no": "ORD-20261110-8801",
			"amount":   2549.15,
		},
	})

	// 5.2 订单履约状态推进请拆分为独立里程碑事件（注：按 D7① / G6 门禁，TrackFirst / TrackUpdate / TrackOverwrite 当前版本未开放，调用将直接返回 ErrUnsupportedMutableTrack 且不入队）
	_ = sdk.TrackWithOptions(abi.TrackOptions{
		EventID:    "ord_fulfilled_ORD-20261110-8801",
		EventName:  "OrderFulfilled",
		AccountID:  accountID,
		DistinctID: distinctID,
		Properties: map[string]any{
			"#ip":            clientIP,
			"order_id":       int64(9007199254740999),
			"order_status":   "FULFILLED",
			"paid_amount":    2549.15,
			"invoice_issued": true,
		},
	})

	// 6. 全部 7 类用户画像操作（自动隔离静态/动态公共属性）
	// 6.1 UserSet ($user_set)：覆盖设置用户画像属性
	_ = sdk.UserSet(accountID, distinctID, map[string]any{
		"company_name": "Acme Analytics Corp",
		"plan_tier":    "Enterprise",
		"seat_count":   50,
	})

	// 6.2 UserSetOnce ($user_set_once)：仅当属性不存在时初始化写入（如首次归因渠道）
	_ = sdk.UserSetOnce(accountID, distinctID, map[string]any{
		"first_utm_source": "github_release",
		"registered_at":    time.Now().UTC(),
	})

	// 6.3 UserAdd ($user_add)：数值型画像属性原子累加（非数值类型会在客户端直接拦截报错）
	_ = sdk.UserAdd(accountID, distinctID, map[string]any{
		"cumulative_payment": 2549.15,
		"order_count":        1,
	})

	// 6.4 UserAppend ($user_append)：向列表型画像属性追加元素（不去重）
	_ = sdk.UserAppend(accountID, distinctID, map[string]any{
		"browsed_categories": []string{"uba", "funnel"},
	})

	// 6.5 UserUniqAppend ($user_uniq_append)：向列表型画像属性去重追加元素
	_ = sdk.UserUniqAppend(accountID, distinctID, map[string]any{
		"certified_badges": []string{"early_adopter", "enterprise_admin"},
	})

	// 6.6 UserUnset ($user_unset)：清空指定的用户画像属性键
	_ = sdk.UserUnset(accountID, distinctID, "trial_flag", "legacy_coupon")

	// 6.7 UserDelete ($user_del)：删除该用户的画像记录
	// _ = sdk.UserDelete(accountID, distinctID)
}
```

### 4.3 本地 JSONL 落盘（`LoggerConsumer`）与同步联调（`DebugConsumer`）

```go
// LoggerConsumer：按天或按小时将事件以 JSONL 落盘，供 Filebeat / Vector 采集
// 注意：落盘模式下完全没有客户端 TCP 连接上下文，如需地域分析，事件 properties 中必须显式传入 "#ip"
loggerConsumer, err := abi.NewLoggerConsumer(abi.LoggerConfig{
	Directory:     "/var/log/abi-events",
	FilePrefix:    "abi.log",
	RotateMode:    abi.RotateDaily, // 支持 abi.RotateDaily ("DAILY") 或 abi.RotateHourly ("HOURLY")
	MaxFileSizeMB: 256,             // 单文件超过 256MB 自动追加 _1, _2 分片序号
})

// DebugConsumer：研发期同步发送单条事件并开启网关 L4 元数据强校验
debugConsumer, err := abi.NewDebugConsumer(abi.DebugConfig{
	ServerURL:    "http://127.0.0.1:8081",
	ProjectID:    1,
	ProjectToken: "abi_tok_demo_go",
	DryRun:       true, // true 表示仅由网关执行完整校验，不落库 Kafka / StarRocks
})
```

---

## 5. 交互式 CLI Demo 与单元测试验证

### 运行交互式 CLI Demo（[`examples/demo`](./examples/demo/README.md)）

```bash
cd abi.sdk/go

# 交互式预览请求 JSON 并在终端输入 y 确认提交
go run ./examples/demo

# 非交互一键预览并提交（适合 CI 或快速验证全部 4 类场景）
go run ./examples/demo --scenario="all" --yes
```

更多命令行参数说明请参见 [`examples/demo/README.md`](./examples/demo/README.md)。

### 运行测试与并发竞态检查

SDK 包含黄金测试向量（Golden Test Vectors）契约测试、大整数安全转换测试、并发竞态测试及四大 Consumer 完整集成测试：

```bash
cd abi.sdk/go
go test -race -v ./...
```
