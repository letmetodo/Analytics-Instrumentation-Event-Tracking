package abi_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	abi "github.com/anylink/abi-go-sdk"
)

// ExampleNewBatchConsumer 演示使用异步批量上报器完成公共属性注册、身份绑定、行为事件追踪（常规/同日幂等）及全部 7 种用户画像操作。
func ExampleNewBatchConsumer() {
	var mu sync.Mutex
	var receivedEvents []abi.TrackEvent

	// 启动本地模拟 ABI 采集网关用于演示验证
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var batch abi.TrackBatchPayload
		_ = json.NewDecoder(r.Body).Decode(&batch)
		mu.Lock()
		receivedEvents = append(receivedEvents, batch.Events...)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"code":200,"message":"success","data":{"accepted":%d,"rejected":0}}`, len(batch.Events))
	}))
	defer gateway.Close()

	consumer, err := abi.NewBatchConsumer(abi.BatchConfig{
		ServerURL:     gateway.URL,
		ProjectID:     1,
		ProjectToken:  "abi_tok_demo_go",
		BatchSize:     20,
		FlushInterval: 500 * time.Millisecond,
	})
	if err != nil {
		panic(err)
	}

	sdk := abi.New(consumer)

	// 1. 注册全局静态公共属性（自动合并至所有 Track* 行为事件，不会混入用户画像事件）
	_ = sdk.SetSuperProperties(map[string]any{
		"$app_version": "2.4.0",
		"env":          "prod",
	})

	// 2. 用户登录事件：同时携带 account_id (login_id) 与访客/设备 distinct_id，Flink 流式引擎自动完成双 ID 实名绑定
	_ = sdk.Track("u_10086", "dev_vis_99a1", "$login", map[string]any{
		"login_method": "sso",
	})

	// 3. 上报用户行为事件（常规事件与携带确定性 EventID 的同日幂等交易事件）
	_ = sdk.Track("u_10086", "dev_vis_99a1", "OrderCreated", map[string]any{
		"order_id":     "ORD-20261110-001",
		"snowflake_id": int64(9007199254740993), // 超过 2^53-1 的大整数会自动序列化为字符串
		"amount":       199.00,
	})
	_ = sdk.TrackWithOptions(abi.TrackOptions{
		EventID:    "evt_ord_paid_001",
		EventName:  "OrderPaid",
		AccountID:  "u_10086",
		DistinctID: "dev_vis_99a1",
		Properties: map[string]any{
			"order_id":     "ORD-20261110-001",
			"order_status": "PAID",
			"amount":       199.00,
		},
	})

	// 4. 变更用户画像属性（覆盖设置、首次设置、数值累加、列表追加、去重追加、属性清空、画像删除）
	_ = sdk.UserSet("u_10086", "dev_vis_99a1", map[string]any{
		"vip_level": 3,
		"city":      "Shanghai",
	})
	_ = sdk.UserSetOnce("u_10086", "dev_vis_99a1", map[string]any{
		"first_utm_source": "google_sem",
	})
	_ = sdk.UserAdd("u_10086", "dev_vis_99a1", map[string]any{
		"total_orders": 1,
		"total_spent":  199.00,
	})
	_ = sdk.UserAppend("u_10086", "dev_vis_99a1", map[string]any{
		"browsed_categories": []string{"analytics", "observability"},
	})
	_ = sdk.UserUniqAppend("u_10086", "dev_vis_99a1", map[string]any{
		"owned_badges": []string{"early_adopter", "pro_analyst"},
	})
	_ = sdk.UserUnset("u_10086", "dev_vis_99a1", "temp_coupon_tag")
	_ = sdk.UserDelete("u_10086", "dev_vis_99a1")

	// 5. 进程退出前刷盘并关闭客户端，确保所有内存缓冲事件投递完成
	_ = sdk.Close()

	mu.Lock()
	defer mu.Unlock()
	fmt.Printf("已投递事件总数: %d\n", len(receivedEvents))
	fmt.Printf("首条事件: %s (login_id=%s, distinct_id=%s)\n",
		receivedEvents[0].EventName, receivedEvents[0].LoginID, receivedEvents[0].DistinctID)
	fmt.Printf("snowflake_id 类型=%T 值=%v\n",
		receivedEvents[1].Properties["snowflake_id"], receivedEvents[1].Properties["snowflake_id"])
	fmt.Printf("末条事件: %s\n", receivedEvents[len(receivedEvents)-1].EventName)

	// Output:
	// 已投递事件总数: 10
	// 首条事件: $login (login_id=u_10086, distinct_id=dev_vis_99a1)
	// snowflake_id 类型=string 值=9007199254740993
	// 末条事件: $user_del
}

// ExampleNewDebugConsumer 演示在开发联调阶段使用 DebugConsumer（开启 DryRun 模式）同步校验埋点格式且不产生落库副作用。
func ExampleNewDebugConsumer() {
	gateway := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var batch abi.TrackBatchPayload
		_ = json.NewDecoder(r.Body).Decode(&batch)
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprintf(w, `{"code":200,"message":"success","data":{"accepted":%d,"rejected":0,"dry_run":%v}}`,
			len(batch.Events), batch.DryRun)
	}))
	defer gateway.Close()

	consumer, err := abi.NewDebugConsumer(abi.DebugConfig{
		ServerURL:    gateway.URL,
		ProjectID:    1,
		ProjectToken: "abi_tok_demo_go",
		DryRun:       true, // 仅在网关执行同步校验，不持久化写入 Kafka 或 StarRocks
	})
	if err != nil {
		panic(err)
	}

	sdk := abi.New(consumer)
	defer sdk.Close()

	// 同步发送单条事件，若网关校验失败将直接返回详细错误
	err = sdk.Track("u_10086", "dev_anon_99a1", "CheckoutStarted", map[string]any{
		"cart_size": 3,
		"coupon":    "WELCOME10",
	})
	fmt.Printf("Dry-Run 校验错误: %v\n", err)

	// Output:
	// Dry-Run 校验错误: <nil>
}

// ExampleNewLoggerConsumer 演示使用 LoggerConsumer 将事件按小时轮转写入本地 JSONL 文件（适用于 Filebeat / Vector 采集链路）。
func ExampleNewLoggerConsumer() {
	tempDir, err := os.MkdirTemp("", "abi-logger-example-*")
	if err != nil {
		panic(err)
	}
	defer os.RemoveAll(tempDir)

	// 固定时间戳以确定演示生成的按小时轮转日志文件名
	fixedTime := time.Date(2026, 11, 10, 14, 0, 0, 0, time.UTC)
	consumer, err := abi.NewLoggerConsumer(abi.LoggerConfig{
		Directory:  tempDir,
		FilePrefix: "abi.track",
		RotateMode: abi.RotateHourly,
		NowFunc:    func() time.Time { return fixedTime },
	})
	if err != nil {
		panic(err)
	}

	sdk := abi.New(consumer)
	_ = sdk.Track("u_10086", "dev_anon_99a1", "PageView", map[string]any{
		"$url":   "https://abi.example.com/analytics/event",
		"$title": "Event Analysis",
	})
	_ = sdk.Close()

	// 验证按小时切分的 JSONL 日志文件已落盘且包含目标事件
	logFile := filepath.Join(tempDir, "abi.track.2026-11-10-14")
	raw, err := os.ReadFile(logFile)
	if err != nil {
		panic(err)
	}
	fmt.Printf("轮转日志文件已生成: %v\n", len(raw) > 0)
	fmt.Printf("包含 PageView 事件: %v\n", strings.Contains(string(raw), `"event_name":"PageView"`))

	// Output:
	// 轮转日志文件已生成: true
	// 包含 PageView 事件: true
}
