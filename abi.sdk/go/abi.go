// Package abi 提供 ABI 企业级用户行为分析（UBA）与 BI 平台的 Go 服务端 SDK。
//
// SDK 内置标识符与属性规范化校验、超 2^53-1 64 位雪花 ID 自动字符串序列化保护，
// 并提供异步批量上报（BatchConsumer）、同步联调校验（DebugConsumer）、本地 JSONL 轮转落盘（LoggerConsumer）
// 以及内存暂存预览后确认提交（StagingConsumer）四种传输模式。
package abi

import (
	"bytes"
	"compress/gzip"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"net/http"
	"strings"
	"sync"
	"time"
)

// ErrUnsupportedMutableTrack 表示当前版本未开放首次去重与历史事件局部/覆盖更新接口（D7① / G6 门禁）。
var ErrUnsupportedMutableTrack = errors.New("abi: TrackFirst, TrackUpdate, and TrackOverwrite are unsupported in current version (D7① / G6 gate); use TrackWithOptions with deterministic EventID for same-day idempotency")

// TrackEvent 表示发送至 ABI 采集网关的单条事件传输结构（Wire Payload，严格对齐数数科技双 ID 契约）。
type TrackEvent struct {
	EventID    string         `json:"event_id,omitempty"`
	EventName  string         `json:"event_name"`
	DistinctID string         `json:"distinct_id"`
	LoginID    string         `json:"login_id,omitempty"`
	Timestamp  int64          `json:"timestamp"`
	Properties map[string]any `json:"properties"`
}

// TrackBatchPayload 表示请求 POST /collect/api/v1/track/batch 接口的批量上报 JSON 请求体。
type TrackBatchPayload struct {
	ProjectID    int64        `json:"project_id"`
	ProjectToken string       `json:"project_token"`
	Debug        bool         `json:"debug,omitempty"`
	DryRun       bool         `json:"dry_run,omitempty"`
	Events       []TrackEvent `json:"events"`
}

// TrackEventError 表示 Debug 联调模式下网关返回的单条事件校验失败详情。
type TrackEventError struct {
	Index     int    `json:"index"`
	EventID   string `json:"event_id,omitempty"`
	EventName string `json:"event_name,omitempty"`
	Reason    string `json:"reason"`
}

// GatewayEnvelope 对应 ABI 采集网关的标准 HTTP JSON 响应信封结构。
type GatewayEnvelope struct {
	Code      int    `json:"code"`
	Message   string `json:"message"`
	RequestID string `json:"request_id"`
	Data      struct {
		Accepted int               `json:"accepted"`
		Rejected int               `json:"rejected"`
		DryRun   bool              `json:"dry_run"`
		Errors   []TrackEventError `json:"errors,omitempty"`
	} `json:"data"`
}

// Consumer 定义 ABI 事件的底层传输与持久化策略接口（内置实现包括 BatchConsumer、LoggerConsumer、DebugConsumer、StagingConsumer）。
type Consumer interface {
	Add(event TrackEvent) error
	Flush() error
	Close() error
}

// TrackOptions 支持对单条上报事件进行完整自定义配置（包括指定业务 EventID、事件发生时间 Timestamp、账号标识 AccountID 及访客/设备标识 DistinctID）。
type TrackOptions struct {
	EventID    string
	EventName  string
	AccountID  string
	DistinctID string
	Timestamp  time.Time
	Properties map[string]any
}

// AbiAnalytics 是并发安全的 ABI Go 服务端 SDK 核心客户端（API 设计对标数数科技 ThinkingDataAnalytics）。
type AbiAnalytics struct {
	consumer          Consumer
	superMu           sync.RWMutex
	superProps        map[string]any
	dynamicSuperProps func() map[string]any
}

// New 使用指定的 Consumer 创建并初始化一个新的 AbiAnalytics 客户端实例。
//
// 示例：
//
//	// 初始化异步批量上报 Consumer（支持 Gzip 压缩与失败重试）
//	consumer, err := abi.NewBatchConsumer(abi.BatchConfig{
//		ServerURL:     "http://127.0.0.1:8081",
//		ProjectID:     1,
//		ProjectToken:  "abi_tok_demo_go",
//		BatchSize:     50,
//		FlushInterval: 3 * time.Second,
//		CompressGzip:  true,
//	})
//	if err != nil {
//		log.Fatal(err)
//	}
//	sdk := abi.New(consumer)
//	defer sdk.Close() // 进程退出前确保缓冲事件全部刷盘
func New(consumer Consumer) *AbiAnalytics {
	return &AbiAnalytics{
		consumer:   consumer,
		superProps: make(map[string]any),
	}
}

// SetSuperProperties 注册全局静态公共属性；注册后的属性会自动合并到后续所有行为事件（Track*）中，但不会混入 $user_* / #user_* 画像事件。
// 属性合并覆盖优先级严格对齐数数 SDK：静态公共属性 < 动态公共属性 < 单次事件 properties。
//
// 示例：
//
//	err := sdk.SetSuperProperties(map[string]any{
//		"$app_version": "2.4.0",
//		"$platform":    "GoServer",
//		"service_name": "order-service",
//	})
func (a *AbiAnalytics) SetSuperProperties(props map[string]any) error {
	if a == nil {
		return fmt.Errorf("abi analytics client is nil")
	}
	clean, err := SanitizeProperties(props)
	if err != nil {
		return err
	}
	a.superMu.Lock()
	defer a.superMu.Unlock()
	for k, v := range clean {
		a.superProps[k] = v
	}
	return nil
}

// UnsetSuperProperty 根据属性名移除单个已注册的全局静态公共属性。
func (a *AbiAnalytics) UnsetSuperProperty(key string) {
	if a == nil {
		return
	}
	trimmed := strings.TrimSpace(key)
	a.superMu.Lock()
	delete(a.superProps, key)
	if trimmed != key {
		delete(a.superProps, trimmed)
	}
	a.superMu.Unlock()
}

// GetSuperProperties 返回当前已注册全局静态公共属性的浅拷贝副本；修改返回 map 不会影响 SDK 内部状态。
func (a *AbiAnalytics) GetSuperProperties() map[string]any {
	if a == nil {
		return map[string]any{}
	}
	a.superMu.RLock()
	defer a.superMu.RUnlock()
	cp := make(map[string]any, len(a.superProps))
	for k, v := range a.superProps {
		cp[k] = v
	}
	return cp
}

// ClearSuperProperties 清空已注册的所有全局静态公共属性。
func (a *AbiAnalytics) ClearSuperProperties() {
	if a == nil {
		return
	}
	a.superMu.Lock()
	a.superProps = make(map[string]any)
	a.superMu.Unlock()
}

// SetDynamicSuperProperties 注册动态公共属性回调函数（并发安全）；传入 nil 可移除已注册的动态回调。
// 在每次构造非 $user_* / #user_* 行为事件时动态调用 fn，返回值同样经过 SanitizeProperties 规范化清洗，
// 且合并优先级严格遵循：静态公共属性 < 动态公共属性 < 单次事件 properties。
//
// 示例：
//
//	sdk.SetDynamicSuperProperties(func() map[string]any {
//		return map[string]any{
//			"goroutine_count": runtime.NumGoroutine(),
//			"server_region":   "ap-shanghai",
//		}
//	})
func (a *AbiAnalytics) SetDynamicSuperProperties(fn func() map[string]any) {
	if a == nil {
		return
	}
	a.superMu.Lock()
	a.dynamicSuperProps = fn
	a.superMu.Unlock()
}

// Track 记录一条标准用户行为事件。accountID 与 distinctID 至少需要有一个非空。
//
// 示例：
//
//	err := sdk.Track("u_10086", "dev_anon_99a1", "OrderPaid", map[string]any{
//		"order_id":   "ORD-20261110-001",
//		"amount":     199.00,
//		"currency":   "CNY",
//		"item_ids":   []string{"sku_101", "sku_205"},
//		"snowflake":  int64(9007199254740993), // 超过 2^53-1 的大整数自动序列化为字符串
//	})
func (a *AbiAnalytics) Track(accountID, distinctID, eventName string, properties map[string]any) error {
	return a.TrackWithOptions(TrackOptions{
		EventName:  eventName,
		AccountID:  accountID,
		DistinctID: distinctID,
		Properties: properties,
	})
}

// TrackFirst 保留方法签名，但在当前版本显式拒绝并不入队任何事件（D7① / G6 门禁）。
//
// Deprecated: 当前版本未开放（受限于 StarRocks dwd_events 表结构与 D7① / G6 门禁，TrackFirst 直接返回 ErrUnsupportedMutableTrack；如需同日幂等重放请通过 TrackWithOptions 传入固定 EventID）。
func (a *AbiAnalytics) TrackFirst(accountID, distinctID, eventName, firstCheckID string, properties map[string]any) error {
	return fmt.Errorf("%w: TrackFirst", ErrUnsupportedMutableTrack)
}

// TrackUpdate 保留方法签名，但在当前版本显式拒绝并不入队任何事件（D7① / G6 门禁）。
//
// Deprecated: 当前版本未开放（受限于 StarRocks dwd_events 表结构与 D7① / G6 门禁，TrackUpdate 直接返回 ErrUnsupportedMutableTrack，避免伪装普通 track 抹除未传属性或跨天产生重复行；如需同日幂等重放请通过 TrackWithOptions 传入固定 EventID）。
func (a *AbiAnalytics) TrackUpdate(accountID, distinctID, eventName, eventID string, properties map[string]any) error {
	return fmt.Errorf("%w: TrackUpdate", ErrUnsupportedMutableTrack)
}

// TrackOverwrite 保留方法签名，但在当前版本显式拒绝并不入队任何事件（D7① / G6 门禁）。
//
// Deprecated: 当前版本未开放（受限于 StarRocks dwd_events 表结构与 D7① / G6 门禁，TrackOverwrite 直接返回 ErrUnsupportedMutableTrack，避免跨天产生重复行；如需同日幂等重放请通过 TrackWithOptions 传入固定 EventID）。
func (a *AbiAnalytics) TrackOverwrite(accountID, distinctID, eventName, eventID string, properties map[string]any) error {
	return fmt.Errorf("%w: TrackOverwrite", ErrUnsupportedMutableTrack)
}

// UserSet 设置用户画像属性（$user_set）；若属性已存在则覆盖为最新值。
//
// 示例：
//
//	err := sdk.UserSet("u_10086", "dev_anon_99a1", map[string]any{
//		"vip_level": 3,
//		"city":      "Shanghai",
//		"plan_tier": "Enterprise",
//	})
func (a *AbiAnalytics) UserSet(accountID, distinctID string, properties map[string]any) error {
	return a.sendUserEvent(accountID, distinctID, "$user_set", properties)
}

// UserSetOnce 仅当用户画像属性尚未被设置过时写入初始值（$user_set_once），适用于首次归因渠道、注册时间等不可变属性。
//
// 示例：
//
//	err := sdk.UserSetOnce("u_10086", "dev_anon_99a1", map[string]any{
//		"first_utm_source": "google_sem",
//		"registered_at":    time.Now().UTC(),
//	})
func (a *AbiAnalytics) UserSetOnce(accountID, distinctID string, properties map[string]any) error {
	return a.sendUserEvent(accountID, distinctID, "$user_set_once", properties)
}

// UserAdd 对数值型用户画像属性执行原子增量累加（$user_add），传入非数值类型属性将返回校验错误。
//
// 示例：
//
//	err := sdk.UserAdd("u_10086", "dev_anon_99a1", map[string]any{
//		"total_orders": 1,
//		"total_spent":  199.00,
//	})
func (a *AbiAnalytics) UserAdd(accountID, distinctID string, properties map[string]any) error {
	for k, v := range properties {
		// 允许携带 #time / $time 指定画像操作发生时间，交由 buildEvent 统一解析并剥离
		trimmed := strings.TrimSpace(k)
		if trimmed == "#time" || trimmed == "$time" {
			continue
		}
		switch v.(type) {
		case int, int8, int16, int32, int64, uint, uint8, uint16, uint32, uint64, float32, float64:
		default:
			return fmt.Errorf("UserAdd property %q must be numeric, got %T", k, v)
		}
	}
	return a.sendUserEvent(accountID, distinctID, "$user_add", properties)
}

// UserUnset 清空并重置指定的用户画像属性键（$user_unset）。
//
// 示例：
//
//	err := sdk.UserUnset("u_10086", "dev_anon_99a1", "temp_coupon_tag", "trial_expired_flag")
func (a *AbiAnalytics) UserUnset(accountID, distinctID string, keys ...string) error {
	props := make(map[string]any, len(keys))
	for _, k := range keys {
		props[k] = ""
	}
	return a.sendUserEvent(accountID, distinctID, "$user_unset", props)
}

// UserAppend 向列表型用户画像属性追加新元素（$user_append，不去重）。
//
// 示例：
//
//	err := sdk.UserAppend("u_10086", "dev_anon_99a1", map[string]any{
//		"browsed_categories": []string{"analytics", "observability"},
//	})
func (a *AbiAnalytics) UserAppend(accountID, distinctID string, properties map[string]any) error {
	return a.sendUserEvent(accountID, distinctID, "$user_append", properties)
}

// UserUniqAppend 向列表型用户画像属性去重追加元素（$user_uniq_append）。
//
// 示例：
//
//	err := sdk.UserUniqAppend("u_10086", "dev_anon_99a1", map[string]any{
//		"owned_badges": []string{"early_adopter", "pro_analyst"},
//	})
func (a *AbiAnalytics) UserUniqAppend(accountID, distinctID string, properties map[string]any) error {
	return a.sendUserEvent(accountID, distinctID, "$user_uniq_append", properties)
}

// UserDelete 删除指定用户的画像记录及其全部画像属性（$user_del）。
//
// 示例：
//
//	err := sdk.UserDelete("u_10086", "dev_anon_99a1")
func (a *AbiAnalytics) UserDelete(accountID, distinctID string) error {
	return a.sendUserEvent(accountID, distinctID, "$user_del", nil)
}

// TrackWithOptions 执行本地标识符与属性规范化校验，并提交完整自定义配置的事件（如指定历史 Timestamp 或幂等 EventID）。
func (a *AbiAnalytics) TrackWithOptions(opts TrackOptions) error {
	if a == nil || a.consumer == nil {
		return fmt.Errorf("abi analytics consumer is not initialized")
	}
	evt, err := a.buildEvent(opts, true)
	if err != nil {
		return err
	}
	return a.consumer.Add(evt)
}

func (a *AbiAnalytics) sendUserEvent(accountID, distinctID, opEventName string, properties map[string]any) error {
	if a == nil || a.consumer == nil {
		return fmt.Errorf("abi analytics consumer is not initialized")
	}
	evt, err := a.buildEvent(TrackOptions{
		EventName:  opEventName,
		AccountID:  accountID,
		DistinctID: distinctID,
		Properties: properties,
	}, false)
	if err != nil {
		return err
	}
	return a.consumer.Add(evt)
}

func (a *AbiAnalytics) buildEvent(opts TrackOptions, includeSuperProps bool) (TrackEvent, error) {
	eventName, err := ValidateEventName(opts.EventName)
	if err != nil {
		return TrackEvent{}, err
	}
	normDistinct, normLogin, err := NormalizeIdentityPair(opts.DistinctID, opts.AccountID)
	if err != nil {
		return TrackEvent{}, err
	}

	eventID := opts.EventID
	if eventID != "" {
		normEvtID, err := NormalizeIdentity(eventID, MaxEventIDBytes)
		if err != nil {
			return TrackEvent{}, fmt.Errorf("invalid event_id: %w", err)
		}
		eventID = normEvtID
	}
	if eventID == "" {
		eventID = GenerateUUIDv4()
	}

	// 对标数数 SDK 2.1：支持在 properties 中通过 "#time" 或 "$time" 指定事件时间，
	// 并在调用 SanitizeProperties 前从属性副本中剥离，避免写入最终 JSON properties。
	propsWithoutTime, resolvedTs, err := extractEventTimeAndStrip(opts.Properties, opts.Timestamp)
	if err != nil {
		return TrackEvent{}, err
	}

	cleanProps, err := SanitizeProperties(propsWithoutTime)
	if err != nil {
		return TrackEvent{}, err
	}

	finalProps := make(map[string]any, len(cleanProps)+4)
	isUserEvent := strings.HasPrefix(eventName, "$user_") || strings.HasPrefix(eventName, "#user_")
	if includeSuperProps && !isUserEvent {
		a.superMu.RLock()
		for k, v := range a.superProps {
			finalProps[k] = v
		}
		dynamicFn := a.dynamicSuperProps
		a.superMu.RUnlock()

		// 在锁外执行动态公共属性回调（防止回调内重入 SDK 读锁导致死锁），按“静态 < 动态 < 单次事件”覆盖合并
		if dynamicFn != nil {
			cleanDyn, err := SanitizeProperties(dynamicFn())
			if err != nil {
				return TrackEvent{}, fmt.Errorf("invalid dynamic super properties: %w", err)
			}
			for k, v := range cleanDyn {
				finalProps[k] = v
			}
		}
	}
	for k, v := range cleanProps {
		finalProps[k] = v
	}

	tsMs := time.Now().UnixMilli()
	if !resolvedTs.IsZero() {
		tsMs = resolvedTs.UnixMilli()
	}

	return TrackEvent{
		EventID:    eventID,
		EventName:  eventName,
		DistinctID: normDistinct,
		LoginID:    normLogin,
		Timestamp:  tsMs,
		Properties: finalProps,
	}, nil
}

// extractEventTimeAndStrip 从传入属性中检测并剥离 "#time" / "$time" 预置时间字段（不修改调用方原始 map）。
// 当 explicitTs 为零值时，将 "#time"（优先）或 "$time" 解析为事件发生时间。
func extractEventTimeAndStrip(props map[string]any, explicitTs time.Time) (map[string]any, time.Time, error) {
	if len(props) == 0 {
		return props, explicitTs, nil
	}

	hasTimeKey := false
	for k := range props {
		trimmed := strings.TrimSpace(k)
		if trimmed == "#time" || trimmed == "$time" {
			hasTimeKey = true
			break
		}
	}
	if !hasTimeKey {
		return props, explicitTs, nil
	}

	var (
		stripped      = make(map[string]any, len(props))
		hasHashTime   bool
		hashTimeVal   any
		hasDollarTime bool
		dollarTimeVal any
	)
	for k, v := range props {
		switch strings.TrimSpace(k) {
		case "#time":
			hasHashTime = true
			hashTimeVal = v
		case "$time":
			hasDollarTime = true
			dollarTimeVal = v
		default:
			stripped[k] = v
		}
	}

	if !explicitTs.IsZero() {
		return stripped, explicitTs, nil
	}

	var resolved time.Time
	if hasDollarTime {
		parsed, err := parseEventTimeValue("$time", dollarTimeVal)
		if err != nil {
			return nil, time.Time{}, err
		}
		resolved = parsed
	}
	if hasHashTime {
		parsed, err := parseEventTimeValue("#time", hashTimeVal)
		if err != nil {
			return nil, time.Time{}, err
		}
		resolved = parsed
	}
	return stripped, resolved, nil
}

// parseEventTimeValue 解析 "#time" / "$time" 属性值，支持 time.Time、*time.Time、秒/毫秒级整型时间戳、
// RFC3339 字符串及 "2006-01-02 15:04:05"（兼容毫秒后缀）格式字符串。
func parseEventTimeValue(key string, raw any) (time.Time, error) {
	switch v := raw.(type) {
	case time.Time:
		if v.IsZero() {
			return time.Time{}, fmt.Errorf("invalid %s property: time value must not be zero", key)
		}
		return v, nil
	case *time.Time:
		if v == nil {
			return time.Time{}, fmt.Errorf("invalid %s property: *time.Time must not be nil", key)
		}
		if v.IsZero() {
			return time.Time{}, fmt.Errorf("invalid %s property: time value must not be zero", key)
		}
		return *v, nil
	case int:
		return parseUnixTimestampInt64(key, int64(v))
	case int64:
		return parseUnixTimestampInt64(key, v)
	case int32:
		return parseUnixTimestampInt64(key, int64(v))
	case uint:
		if uint64(v) > math.MaxInt64 {
			return time.Time{}, fmt.Errorf("invalid %s property: timestamp %d overflows int64", key, v)
		}
		return parseUnixTimestampInt64(key, int64(v))
	case uint64:
		if v > math.MaxInt64 {
			return time.Time{}, fmt.Errorf("invalid %s property: timestamp %d overflows int64", key, v)
		}
		return parseUnixTimestampInt64(key, int64(v))
	case uint32:
		return parseUnixTimestampInt64(key, int64(v))
	case string:
		s := strings.TrimSpace(v)
		if s == "" {
			return time.Time{}, fmt.Errorf("invalid %s property: time string must not be empty", key)
		}
		if parsed, err := time.Parse(time.RFC3339Nano, s); err == nil {
			return parsed, nil
		}
		if parsed, err := time.Parse(time.RFC3339, s); err == nil {
			return parsed, nil
		}
		if parsed, err := time.ParseInLocation("2006-01-02 15:04:05.999999999", s, time.Local); err == nil {
			return parsed, nil
		}
		if parsed, err := time.ParseInLocation("2006-01-02 15:04:05", s, time.Local); err == nil {
			return parsed, nil
		}
		return time.Time{}, fmt.Errorf("invalid %s property %q: expected RFC3339 or \"2006-01-02 15:04:05\"", key, v)
	default:
		return time.Time{}, fmt.Errorf("invalid %s property: unsupported value type %T", key, raw)
	}
}

// parseUnixTimestampInt64 将整型 Unix 时间戳按数量级自动识别为秒或毫秒并转为 time.Time。
func parseUnixTimestampInt64(key string, ts int64) (time.Time, error) {
	if ts <= 0 {
		return time.Time{}, fmt.Errorf("invalid %s property: unix timestamp must be positive, got %d", key, ts)
	}
	// 以 1e11（100,000,000,000）区分秒与毫秒：秒级对应公元 5138 年，毫秒级对应 1973-03-03。
	if ts >= 100_000_000_000 {
		return time.UnixMilli(ts), nil
	}
	return time.Unix(ts, 0), nil
}

// Flush 立即将底层 Consumer 中缓冲的所有待发送事件刷盘或同步提交。
func (a *AbiAnalytics) Flush() error {
	if a == nil || a.consumer == nil {
		return nil
	}
	return a.consumer.Flush()
}

// Close 刷盘排空所有缓冲事件并安全关闭底层 Consumer（推荐在进程退出前通过 defer 调用）。
func (a *AbiAnalytics) Close() error {
	if a == nil || a.consumer == nil {
		return nil
	}
	return a.consumer.Close()
}

// StagingConsumer 是支持「1. 暂存事件并预览完整请求 JSON -> 2. 确认后才真正提交」的内存队列 Consumer。
//
// 在显式调用 ConfirmSubmit 或 SubmitToGateway 之前，所有通过 AbiAnalytics 记录的行为与画像事件
// 仅保存在内存中（Flush 与 Close 均不会触发网络发送），适用于参数联调预览、交互式确认上报及自动化测试断言。
type StagingConsumer struct {
	mu           sync.RWMutex
	projectID    int64
	projectToken string
	debug        bool
	dryRun       bool
	events       []TrackEvent
}

// NewStagingConsumer 创建一个内存暂存队列消费者（实现 Consumer 接口）。
func NewStagingConsumer(projectID int64, projectToken string, dryRun bool) *StagingConsumer {
	return &StagingConsumer{
		projectID:    projectID,
		projectToken: strings.TrimSpace(projectToken),
		dryRun:       dryRun,
		events:       make([]TrackEvent, 0),
	}
}

// Add 将已通过 SDK 规范化校验与公共属性合并的事件暂存到内存队列中（不发起任何网络请求）。
func (s *StagingConsumer) Add(event TrackEvent) error {
	if s == nil {
		return fmt.Errorf("staging consumer is nil")
	}
	cloned := cloneTrackEvent(event)
	s.mu.Lock()
	s.events = append(s.events, cloned)
	s.mu.Unlock()
	return nil
}

// Flush 对于 StagingConsumer 为空操作，确保在调用 ConfirmSubmit / SubmitToGateway 前不会静默发送。
func (s *StagingConsumer) Flush() error {
	return nil
}

// Close 对于 StagingConsumer 为空操作，保留已暂存事件以供预览或确认提交。
func (s *StagingConsumer) Close() error {
	return nil
}

// SetDebug 设置生成 POST /collect/api/v1/track/batch 请求体时的 debug 字段。
func (s *StagingConsumer) SetDebug(debug bool) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.debug = debug
	s.mu.Unlock()
}

// SetDryRun 设置生成 POST /collect/api/v1/track/batch 请求体时的 dry_run 字段。
func (s *StagingConsumer) SetDryRun(dryRun bool) {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.dryRun = dryRun
	s.mu.Unlock()
}

// Reset 清空当前暂存的所有事件（适用于修改公共属性或配置后重新录制并预览请求报文）。
func (s *StagingConsumer) Reset() {
	if s == nil {
		return
	}
	s.mu.Lock()
	s.events = make([]TrackEvent, 0)
	s.mu.Unlock()
}

// Events 返回当前已暂存事件的深拷贝快照切片。
func (s *StagingConsumer) Events() []TrackEvent {
	if s == nil {
		return []TrackEvent{}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	out := make([]TrackEvent, len(s.events))
	for i, evt := range s.events {
		out[i] = cloneTrackEvent(evt)
	}
	return out
}

// BuildRequestPayload 构造即将发送至 POST /collect/api/v1/track/batch 的完整请求结构体快照。
func (s *StagingConsumer) BuildRequestPayload() TrackBatchPayload {
	if s == nil {
		return TrackBatchPayload{Events: []TrackEvent{}}
	}
	s.mu.RLock()
	defer s.mu.RUnlock()
	events := make([]TrackEvent, len(s.events))
	for i, evt := range s.events {
		events[i] = cloneTrackEvent(evt)
	}
	return TrackBatchPayload{
		ProjectID:    s.projectID,
		ProjectToken: s.projectToken,
		Debug:        s.debug,
		DryRun:       s.dryRun,
		Events:       events,
	}
}

// PreviewRequestJSON 输出格式化缩进后的 POST /collect/api/v1/track/batch 完整请求 JSON 字符串。
func (s *StagingConsumer) PreviewRequestJSON() (string, error) {
	if s == nil {
		return "", fmt.Errorf("staging consumer is nil")
	}
	payload := s.BuildRequestPayload()
	var buf bytes.Buffer
	enc := json.NewEncoder(&buf)
	enc.SetEscapeHTML(false)
	enc.SetIndent("", "  ")
	if err := enc.Encode(payload); err != nil {
		return "", fmt.Errorf("marshal request preview json: %w", err)
	}
	return strings.TrimRight(buf.String(), "\n"), nil
}

// ConfirmSubmit 在确认无误后将当前暂存的所有事件正式投递至目标 Consumer（如 BatchConsumer / DebugConsumer / LoggerConsumer）并执行 Flush。
func (s *StagingConsumer) ConfirmSubmit(target Consumer) error {
	if s == nil {
		return fmt.Errorf("staging consumer is nil")
	}
	if target == nil {
		return fmt.Errorf("target consumer is nil")
	}
	if target == Consumer(s) {
		return fmt.Errorf("target consumer must not be the same StagingConsumer")
	}
	payload := s.BuildRequestPayload()
	for _, evt := range payload.Events {
		if err := target.Add(evt); err != nil {
			return err
		}
	}
	return target.Flush()
}

// SubmitToGateway 在确认无误后直接将预览的 TrackBatchPayload 发送至 ABI 采集网关（POST /collect/api/v1/track/batch），
// 并返回网关解析后的标准响应信封 GatewayEnvelope。
func (s *StagingConsumer) SubmitToGateway(cfg BatchConfig) (*GatewayEnvelope, error) {
	if s == nil {
		return nil, fmt.Errorf("staging consumer is nil")
	}
	if strings.TrimSpace(cfg.ServerURL) == "" {
		return nil, fmt.Errorf("ServerURL is required")
	}
	payload := s.BuildRequestPayload()
	if payload.ProjectID <= 0 && cfg.ProjectID > 0 {
		payload.ProjectID = cfg.ProjectID
	}
	if payload.ProjectToken == "" && strings.TrimSpace(cfg.ProjectToken) != "" {
		payload.ProjectToken = strings.TrimSpace(cfg.ProjectToken)
	}
	if payload.ProjectID <= 0 || strings.TrimSpace(payload.ProjectToken) == "" {
		return nil, fmt.Errorf("ProjectID and ProjectToken are required")
	}
	if len(payload.Events) == 0 {
		return nil, fmt.Errorf("no staged events to submit")
	}

	bodyBytes, err := json.Marshal(payload)
	if err != nil {
		return nil, fmt.Errorf("marshal batch payload: %w", err)
	}
	if cfg.CompressGzip {
		var compressed bytes.Buffer
		gz := gzip.NewWriter(&compressed)
		if _, err := gz.Write(bodyBytes); err != nil {
			_ = gz.Close()
			return nil, fmt.Errorf("gzip batch payload: %w", err)
		}
		if err := gz.Close(); err != nil {
			return nil, fmt.Errorf("close gzip writer: %w", err)
		}
		bodyBytes = compressed.Bytes()
	}

	timeout := cfg.Timeout
	if timeout <= 0 {
		timeout = 10 * time.Second
	}
	client := cfg.HTTPClient
	if client == nil {
		client = &http.Client{Timeout: timeout}
	}
	endpoint := resolveBatchEndpoint(cfg.ServerURL)

	maxRetries := cfg.MaxRetries
	if maxRetries < 0 {
		maxRetries = 0
	}
	maxAttempts := maxRetries + 1

	var lastErr error
	for attempt := 0; attempt < maxAttempts; attempt++ {
		if attempt > 0 {
			backoff := time.Duration(50*(1<<(attempt-1))) * time.Millisecond
			if backoff > 2*time.Second {
				backoff = 2 * time.Second
			}
			time.Sleep(backoff)
		}

		req, err := http.NewRequest(http.MethodPost, endpoint, bytes.NewReader(bodyBytes))
		if err != nil {
			return nil, fmt.Errorf("create request: %w", err)
		}
		req.Header.Set("Content-Type", "application/json")
		if cfg.CompressGzip {
			req.Header.Set("Content-Encoding", "gzip")
		}
		req.Header.Set("User-Agent", SDKVersion)

		resp, err := client.Do(req)
		if err != nil {
			lastErr = fmt.Errorf("send batch request: %w", err)
			continue
		}
		respBytes, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
		_ = resp.Body.Close()

		if resp.StatusCode == http.StatusTooManyRequests || resp.StatusCode >= 500 {
			lastErr = fmt.Errorf("gateway retryable status %d: %s", resp.StatusCode, string(respBytes))
			continue
		}

		var env GatewayEnvelope
		if err := json.Unmarshal(respBytes, &env); err != nil {
			if resp.StatusCode != http.StatusOK {
				return nil, fmt.Errorf("gateway rejected batch (status=%d): %s", resp.StatusCode, string(respBytes))
			}
			return nil, fmt.Errorf("decode gateway response: %w", err)
		}
		if resp.StatusCode != http.StatusOK || env.Code != 200 {
			return &env, fmt.Errorf("gateway error (status=%d, code=%d): %s", resp.StatusCode, env.Code, env.Message)
		}
		return &env, nil
	}
	return nil, lastErr
}

func cloneTrackEvent(evt TrackEvent) TrackEvent {
	cp := evt
	if evt.Properties != nil {
		propsCopy := make(map[string]any, len(evt.Properties))
		for k, v := range evt.Properties {
			if slice, ok := v.([]any); ok {
				sc := make([]any, len(slice))
				copy(sc, slice)
				propsCopy[k] = sc
			} else {
				propsCopy[k] = v
			}
		}
		cp.Properties = propsCopy
	}
	return cp
}
