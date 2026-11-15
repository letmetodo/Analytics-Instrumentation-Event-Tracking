package abi

import (
	"compress/gzip"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type identityContractFile struct {
	MaxDistinctIDBytes int `json:"max_distinct_id_bytes"`
	MaxLoginIDBytes    int `json:"max_login_id_bytes"`
	Cases              []struct {
		Name                 string  `json:"name"`
		DistinctID           string  `json:"distinct_id"`
		LoginID              string  `json:"login_id"`
		Valid                bool    `json:"valid"`
		NormalizedDistinctID *string `json:"normalized_distinct_id"`
		NormalizedLoginID    *string `json:"normalized_login_id"`
	} `json:"cases"`
}

type eventAndPropContractFile struct {
	MaxSafeInteger int64 `json:"max_safe_integer"`
	EventNameCases []struct {
		EventName string `json:"event_name"`
		Valid     bool   `json:"valid"`
	} `json:"event_name_cases"`
	PropertyKeyCases []struct {
		Key   string `json:"key"`
		Valid bool   `json:"valid"`
	} `json:"property_key_cases"`
}

func TestIdentityGoldenVectors(t *testing.T) {
	raw, err := os.ReadFile("../spec/test-vectors/identity_cases.json")
	if err != nil {
		t.Fatalf("read identity_cases.json: %v", err)
	}
	var spec identityContractFile
	if err := json.Unmarshal(raw, &spec); err != nil {
		t.Fatalf("unmarshal identity_cases.json: %v", err)
	}
	if spec.MaxDistinctIDBytes != MaxDistinctIDBytes || spec.MaxLoginIDBytes != MaxLoginIDBytes {
		t.Fatalf("unexpected spec byte limits: distinct=%d login=%d", spec.MaxDistinctIDBytes, spec.MaxLoginIDBytes)
	}

	for _, tc := range spec.Cases {
		t.Run(tc.Name, func(t *testing.T) {
			d, l, err := NormalizeIdentityPair(tc.DistinctID, tc.LoginID)
			gotValid := err == nil
			if gotValid != tc.Valid {
				t.Fatalf("valid = %v (err=%v), want %v", gotValid, err, tc.Valid)
			}
			if tc.Valid && tc.NormalizedDistinctID != nil {
				if d != *tc.NormalizedDistinctID || l != *tc.NormalizedLoginID {
					t.Fatalf("normalized = (%q, %q), want (%q, %q)",
						d, l, *tc.NormalizedDistinctID, *tc.NormalizedLoginID)
				}
			}
		})
	}
}

func TestLoginIDOnlyDoesNotFallbackIntoDistinctID(t *testing.T) {
	mem := &memoryConsumer{}
	client := New(mem)

	longLoginID := strings.Repeat("u", 100) // 100 bytes (> 64B distinct_id limit, <= 128B login_id limit)
	if err := client.Track(longLoginID, "", "OrderPaid", map[string]any{"amount": 99.0}); err != nil {
		t.Fatalf("expected 100-byte login_id with empty distinct_id to succeed, got: %v", err)
	}
	events := mem.snapshot()
	if len(events) != 1 {
		t.Fatalf("expected 1 event, got %d", len(events))
	}
	if events[0].DistinctID != "" || events[0].LoginID != longLoginID {
		t.Fatalf("expected DistinctID=\"\" and LoginID=%q, got DistinctID=%q LoginID=%q",
			longLoginID, events[0].DistinctID, events[0].LoginID)
	}
	rawJSON, err := json.Marshal(events[0])
	if err != nil {
		t.Fatalf("marshal event: %v", err)
	}
	if !strings.Contains(string(rawJSON), `"distinct_id":""`) {
		t.Fatalf("wire JSON must contain empty distinct_id, got: %s", string(rawJSON))
	}
	if err := client.Track("   ", "\t", "OrderPaid", nil); err == nil {
		t.Fatal("expected error when both accountID and distinctID are empty")
	}
}

func TestEventAndPropertyGoldenVectors(t *testing.T) {
	raw, err := os.ReadFile("../spec/test-vectors/event_and_property_cases.json")
	if err != nil {
		t.Fatalf("read event_and_property_cases.json: %v", err)
	}
	var spec eventAndPropContractFile
	if err := json.Unmarshal(raw, &spec); err != nil {
		t.Fatalf("unmarshal event_and_property_cases.json: %v", err)
	}

	for _, tc := range spec.EventNameCases {
		_, err := ValidateEventName(tc.EventName)
		if (err == nil) != tc.Valid {
			t.Fatalf("ValidateEventName(%q) err=%v, want valid=%v", tc.EventName, err, tc.Valid)
		}
	}
	for _, tc := range spec.PropertyKeyCases {
		_, err := ValidatePropertyKey(tc.Key)
		if (err == nil) != tc.Valid {
			t.Fatalf("ValidatePropertyKey(%q) err=%v, want valid=%v", tc.Key, err, tc.Valid)
		}
	}
}

func TestBigIntegerConvertedToStringBeyondMaxSafeInteger(t *testing.T) {
	props, err := SanitizeProperties(map[string]any{
		"safe_int":   int64(9007199254740991),
		"unsafe_int": int64(9007199254740993),
		"list_mixed": []int64{42, 9007199254740995},
	})
	if err != nil {
		t.Fatalf("SanitizeProperties error: %v", err)
	}
	if _, ok := props["safe_int"].(int64); !ok {
		t.Fatalf("safe_int should remain int64, got %T", props["safe_int"])
	}
	if s, ok := props["unsafe_int"].(string); !ok || s != "9007199254740993" {
		t.Fatalf("unsafe_int should be converted to string '9007199254740993', got %#v", props["unsafe_int"])
	}
	list := props["list_mixed"].([]any)
	if list[1] != "9007199254740995" {
		t.Fatalf("list element > 2^53-1 should be converted to string, got %#v", list[1])
	}
}

func TestBatchConsumerRetryPreservesIdempotentEventIDAndConcurrentTrack(t *testing.T) {
	var attempts atomic.Int32
	var mu sync.Mutex
	var receivedBatches []TrackBatchPayload

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var batch TrackBatchPayload
		if err := json.NewDecoder(r.Body).Decode(&batch); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		call := attempts.Add(1)
		if call == 1 {
			// Simulate transient 503 on first delivery
			w.WriteHeader(http.StatusServiceUnavailable)
			_, _ = w.Write([]byte(`{"code":32080,"message":"kafka unavailable"}`))
			return
		}
		mu.Lock()
		receivedBatches = append(receivedBatches, batch)
		mu.Unlock()
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"code":200,"message":"success","data":{"accepted":` + "1" + `,"rejected":0}}`))
	}))
	defer srv.Close()

	consumer, err := NewBatchConsumer(BatchConfig{
		ServerURL:     srv.URL,
		ProjectID:     1,
		ProjectToken:  "abi_tok_test",
		BatchSize:     20,
		FlushInterval: 100 * time.Millisecond,
		MaxRetries:    2,
	})
	if err != nil {
		t.Fatalf("NewBatchConsumer: %v", err)
	}

	client := New(consumer)
	_ = client.SetSuperProperties(map[string]any{"$app_version": "3.4.0"})

	const workers = 25
	var wg sync.WaitGroup
	wg.Add(workers)
	for i := 0; i < workers; i++ {
		go func(idx int) {
			defer wg.Done()
			if err := client.Track("u_1001", "dev_001", "OrderPaid", map[string]any{
				"amount": 99.5,
				"seq":    idx,
			}); err != nil {
				t.Errorf("Track error: %v", err)
			}
		}(i)
	}
	wg.Wait()

	if err := client.UserSet("u_1001", "dev_001", map[string]any{"vip_level": 3}); err != nil {
		t.Fatalf("UserSet: %v", err)
	}
	if err := client.UserAdd("u_1001", "dev_001", map[string]any{"total_points": 50}); err != nil {
		t.Fatalf("UserAdd: %v", err)
	}
	if err := client.TrackWithOptions(TrackOptions{
		EventID:    "custom-evt-id-888",
		EventName:  "OrderPaid",
		AccountID:  "u_1001",
		DistinctID: "dev_001",
		Properties: map[string]any{"amount": 120.0},
	}); err != nil {
		t.Fatalf("TrackWithOptions: %v", err)
	}
	if err := client.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	mu.Lock()
	defer mu.Unlock()
	totalEvents := 0
	foundCustomID := false
	for _, b := range receivedBatches {
		totalEvents += len(b.Events)
		for _, e := range b.Events {
			if e.EventID == "custom-evt-id-888" {
				foundCustomID = true
			}
		}
	}
	if totalEvents != workers+3 {
		t.Fatalf("totalEvents = %d, want %d", totalEvents, workers+3)
	}
	if !foundCustomID {
		t.Fatal("expected custom-evt-id-888 from TrackWithOptions to be preserved")
	}
}

func TestUnsupportedMutableTrackMethodsRejectedWithoutEnqueue(t *testing.T) {
	staging := NewStagingConsumer(1, "tok_unsupported_test", true)
	client := New(staging)

	if err := client.TrackFirst("u_1001", "dev_001", "DeviceActivation", "chk_001", map[string]any{"channel": "ios"}); !errors.Is(err, ErrUnsupportedMutableTrack) {
		t.Fatalf("TrackFirst err = %v, want ErrUnsupportedMutableTrack", err)
	}
	if err := client.TrackUpdate("u_1001", "dev_001", "OrderPaid", "evt_001", map[string]any{"status": "PAID"}); !errors.Is(err, ErrUnsupportedMutableTrack) {
		t.Fatalf("TrackUpdate err = %v, want ErrUnsupportedMutableTrack", err)
	}
	if err := client.TrackOverwrite("u_1001", "dev_001", "OrderPaid", "evt_001", map[string]any{"status": "REFUNDED"}); !errors.Is(err, ErrUnsupportedMutableTrack) {
		t.Fatalf("TrackOverwrite err = %v, want ErrUnsupportedMutableTrack", err)
	}
	if got := len(staging.BuildRequestPayload().Events); got != 0 {
		t.Fatalf("len(staging.BuildRequestPayload().Events) = %d, want 0 (unsupported methods must not enqueue fake track events)", got)
	}
}

func TestLoggerConsumerRotatesAndWritesJSONL(t *testing.T) {
	dir := t.TempDir()
	now := time.Date(2026, 11, 10, 10, 0, 0, 0, time.UTC)
	consumer, err := NewLoggerConsumer(LoggerConfig{
		Directory:  dir,
		FilePrefix: "abi.track",
		RotateMode: RotateHourly,
		NowFunc:    func() time.Time { return now },
	})
	if err != nil {
		t.Fatalf("NewLoggerConsumer: %v", err)
	}
	client := New(consumer)
	if err := client.Track("acc_1", "dist_1", "PageView", map[string]any{"$url": "https://example.com"}); err != nil {
		t.Fatalf("Track: %v", err)
	}
	if err := client.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}

	expectedFile := filepath.Join(dir, "abi.track.2026-11-10-10")
	raw, err := os.ReadFile(expectedFile)
	if err != nil {
		t.Fatalf("read rotated log file: %v", err)
	}
	if !strings.Contains(string(raw), `"event_name":"PageView"`) {
		t.Fatalf("unexpected log content: %s", string(raw))
	}
}

func TestDebugConsumerSurfacesGatewayValidationError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var batch TrackBatchPayload
		_ = json.NewDecoder(r.Body).Decode(&batch)
		if !batch.Debug || !batch.DryRun {
			t.Errorf("expected debug=true and dry_run=true, got %+v", batch)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"code":200,"message":"success","data":{"accepted":0,"rejected":1,"dry_run":true,"errors":[{"index":0,"event_name":"PageView","reason":"timestamp is out of allowed window"}]}}`))
	}))
	defer srv.Close()

	consumer, err := NewDebugConsumer(DebugConfig{
		ServerURL:    srv.URL,
		ProjectID:    1,
		ProjectToken: "tok",
		DryRun:       true,
	})
	if err != nil {
		t.Fatalf("NewDebugConsumer: %v", err)
	}
	client := New(consumer)
	err = client.Track("acc_1", "dist_1", "PageView", nil)
	if err == nil || !strings.Contains(err.Error(), "timestamp is out of allowed window") {
		t.Fatalf("expected debug validation error, got %v", err)
	}
}

func TestBatchConsumerGzipCompressionAndTimeUTCFormatting(t *testing.T) {
	var gotGzipHeader bool
	var decodedPayload TrackBatchPayload

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Content-Encoding") == "gzip" {
			gotGzipHeader = true
			gr, err := gzip.NewReader(r.Body)
			if err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			defer gr.Close()
			raw, _ := io.ReadAll(gr)
			_ = json.Unmarshal(raw, &decodedPayload)
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{"code":200,"message":"success","data":{"accepted":1,"rejected":0}}`))
	}))
	defer srv.Close()

	consumer, err := NewBatchConsumer(BatchConfig{
		ServerURL:    srv.URL,
		ProjectID:    1,
		ProjectToken: "tok",
		CompressGzip: true,
	})
	if err != nil {
		t.Fatalf("NewBatchConsumer: %v", err)
	}
	client := New(consumer)
	ts := time.Date(2026, 11, 10, 8, 30, 0, 0, time.FixedZone("CST", 8*3600))
	if err := client.Track("acc_1", "dist_1", "Purchase", map[string]any{"paid_at": ts}); err != nil {
		t.Fatalf("Track: %v", err)
	}
	if err := client.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if !gotGzipHeader {
		t.Fatal("expected Content-Encoding: gzip header")
	}
	if len(decodedPayload.Events) != 1 || decodedPayload.Events[0].Properties["paid_at"] != "2026-11-10T00:30:00Z" {
		t.Fatalf("expected RFC3339 UTC timestamp '2026-11-10T00:30:00Z', got %+v", decodedPayload.Events)
	}
}

// memoryConsumer 是用于单元测试捕获已构造 TrackEvent 的内存 Consumer。
type memoryConsumer struct {
	mu     sync.Mutex
	events []TrackEvent
}

func (m *memoryConsumer) Add(event TrackEvent) error {
	m.mu.Lock()
	m.events = append(m.events, event)
	m.mu.Unlock()
	return nil
}

func (m *memoryConsumer) Flush() error { return nil }
func (m *memoryConsumer) Close() error { return nil }

func (m *memoryConsumer) snapshot() []TrackEvent {
	m.mu.Lock()
	defer m.mu.Unlock()
	out := make([]TrackEvent, len(m.events))
	copy(out, m.events)
	return out
}

// TestTimePropertyExtractionAndStripping 验证 properties["#time"] 与 "$time" 在 Track 及各画像操作（UserSet 等）中
// 自动提取为事件 Timestamp 且从最终 JSON properties 中剥离，并对非法值返回明确错误。
func TestTimePropertyExtractionAndStripping(t *testing.T) {
	mem := &memoryConsumer{}
	client := New(mem)

	fixedTime := time.Date(2026, 11, 10, 9, 15, 30, 123_000_000, time.UTC)

	// 1. Track 支持 properties["#time"] = time.Time，且不修改调用方原始 map，也不写入最终 JSON properties
	callerProps := map[string]any{
		"#time":  fixedTime,
		"amount": 88.5,
	}
	if err := client.Track("u_1001", "dev_001", "OrderPaid", callerProps); err != nil {
		t.Fatalf("Track with #time failed: %v", err)
	}
	if _, stillHas := callerProps["#time"]; !stillHas {
		t.Fatal("caller properties map must not be mutated")
	}

	// 2. UserSet / UserSetOnce / UserAdd / UserAppend / UserUniqAppend 均原生支持 properties["#time"] / "$time"
	ptrTime := time.Date(2026, 11, 10, 10, 20, 0, 0, time.UTC)
	if err := client.UserSet("u_1001", "dev_001", map[string]any{
		"#time":     &ptrTime,
		"vip_level": 5,
	}); err != nil {
		t.Fatalf("UserSet with *time.Time #time failed: %v", err)
	}
	if err := client.UserSetOnce("u_1001", "dev_001", map[string]any{
		"$time":   int64(1762746407), // 秒级时间戳
		"channel": "organic",
	}); err != nil {
		t.Fatalf("UserSetOnce with int64 seconds $time failed: %v", err)
	}
	if err := client.UserAdd("u_1001", "dev_001", map[string]any{
		"#time":        int(1762746407890), // 毫秒级时间戳
		"total_orders": 1,
	}); err != nil {
		t.Fatalf("UserAdd with int milliseconds #time failed: %v", err)
	}
	if err := client.UserAppend("u_1001", "dev_001", map[string]any{
		"#time": "2026-11-10T03:46:47Z", // RFC3339 字符串
		"tags":  []string{"high_value"},
	}); err != nil {
		t.Fatalf("UserAppend with RFC3339 #time failed: %v", err)
	}
	localLayoutStr := "2026-11-10 11:46:47"
	expectedLocalTs, err := time.ParseInLocation("2006-01-02 15:04:05", localLayoutStr, time.Local)
	if err != nil {
		t.Fatalf("ParseInLocation setup: %v", err)
	}
	if err := client.UserUniqAppend("u_1001", "dev_001", map[string]any{
		"#time":  localLayoutStr, // "2006-01-02 15:04:05" 字符串
		"badges": []string{"pioneer"},
	}); err != nil {
		t.Fatalf("UserUniqAppend with layout #time failed: %v", err)
	}

	// 3. 当 TrackOptions.Timestamp 显式非零时，优先使用 opts.Timestamp，同时仍剥离 properties["#time"]
	explicitOptTs := time.Date(2026, 11, 9, 0, 0, 0, 0, time.UTC)
	if err := client.TrackWithOptions(TrackOptions{
		EventName:  "BackfillEvent",
		AccountID:  "u_1001",
		DistinctID: "dev_001",
		Timestamp:  explicitOptTs,
		Properties: map[string]any{
			"#time":  fixedTime,
			"source": "import",
		},
	}); err != nil {
		t.Fatalf("TrackWithOptions with explicit Timestamp and #time failed: %v", err)
	}

	events := mem.snapshot()
	if len(events) != 7 {
		t.Fatalf("expected 7 events, got %d", len(events))
	}

	wantTimestamps := []int64{
		fixedTime.UnixMilli(),
		ptrTime.UnixMilli(),
		1762746407 * 1000,
		1762746407890,
		time.Date(2026, 11, 10, 3, 46, 47, 0, time.UTC).UnixMilli(),
		expectedLocalTs.UnixMilli(),
		explicitOptTs.UnixMilli(),
	}
	for i, evt := range events {
		if evt.Timestamp != wantTimestamps[i] {
			t.Fatalf("event[%d] (%s) Timestamp = %d, want %d", i, evt.EventName, evt.Timestamp, wantTimestamps[i])
		}
		if _, exists := evt.Properties["#time"]; exists {
			t.Fatalf("event[%d] (%s) must not retain #time in Properties: %+v", i, evt.EventName, evt.Properties)
		}
		if _, exists := evt.Properties["$time"]; exists {
			t.Fatalf("event[%d] (%s) must not retain $time in Properties: %+v", i, evt.EventName, evt.Properties)
		}
		rawJSON, err := json.Marshal(evt)
		if err != nil {
			t.Fatalf("marshal event[%d]: %v", i, err)
		}
		if strings.Contains(string(rawJSON), `"#time"`) || strings.Contains(string(rawJSON), `"$time"`) {
			t.Fatalf("event[%d] serialized JSON must not contain #time/$time: %s", i, string(rawJSON))
		}
	}

	// 4. 非法类型或无法解析的 #time / $time 必须返回明确 error
	var nilTimePtr *time.Time
	invalidCases := []struct {
		name  string
		props map[string]any
	}{
		{name: "unsupported_bool", props: map[string]any{"#time": true}},
		{name: "unsupported_float", props: map[string]any{"#time": 1762746407.5}},
		{name: "nil_time_ptr", props: map[string]any{"#time": nilTimePtr}},
		{name: "zero_time", props: map[string]any{"#time": time.Time{}}},
		{name: "non_positive_unix", props: map[string]any{"#time": int64(0)}},
		{name: "invalid_string_format", props: map[string]any{"#time": "2026/11/10 99:99:99"}},
		{name: "empty_string", props: map[string]any{"$time": "   "}},
	}
	for _, tc := range invalidCases {
		if err := client.Track("u_1001", "dev_001", "OrderPaid", tc.props); err == nil {
			t.Fatalf("case %s: expected error for invalid #time/$time, got nil", tc.name)
		}
	}
}

// TestSuperPropertiesAndDynamicSuperPropertiesPriority 验证 UnsetSuperProperty / GetSuperProperties / SetDynamicSuperProperties
// 的浅拷贝隔离、属性合并覆盖优先级（静态 < 动态 < 单次事件）以及不混入 $user_set 画像事件。
func TestSuperPropertiesAndDynamicSuperPropertiesPriority(t *testing.T) {
	mem := &memoryConsumer{}
	client := New(mem)

	// 1. 注册静态公共属性并验证 GetSuperProperties 浅拷贝隔离与 UnsetSuperProperty 移除能力
	if err := client.SetSuperProperties(map[string]any{
		"static_only":   "s_val",
		"override_by_d": "from_static",
		"override_by_e": "from_static",
		"to_be_unset":   "temp_val",
		"$app_version":  "1.0.0",
	}); err != nil {
		t.Fatalf("SetSuperProperties: %v", err)
	}

	gotSuper := client.GetSuperProperties()
	if gotSuper["to_be_unset"] != "temp_val" || gotSuper["static_only"] != "s_val" {
		t.Fatalf("unexpected GetSuperProperties snapshot: %+v", gotSuper)
	}
	// 修改返回副本不应污染 SDK 内部静态公共属性
	gotSuper["static_only"] = "mutated_outside"
	gotSuper["injected_outside"] = "bad"
	if client.GetSuperProperties()["static_only"] != "s_val" {
		t.Fatal("GetSuperProperties must return a shallow copy isolated from external mutation")
	}
	if _, exists := client.GetSuperProperties()["injected_outside"]; exists {
		t.Fatal("external map insertion leaked into internal superProps")
	}

	client.UnsetSuperProperty("to_be_unset")
	if _, exists := client.GetSuperProperties()["to_be_unset"]; exists {
		t.Fatal("expected to_be_unset to be removed after UnsetSuperProperty")
	}

	// 2. 注册动态公共属性（验证按次动态求值、SanitizeProperties 大整数清洗及覆盖优先级：静态 < 动态 < 单次事件）
	var dynCallCount atomic.Int64
	client.SetDynamicSuperProperties(func() map[string]any {
		seq := dynCallCount.Add(1)
		// 验证回调内调用 GetSuperProperties 不会发生锁重入死锁
		_ = client.GetSuperProperties()
		return map[string]any{
			"dyn_seq":       seq,
			"override_by_d": "from_dynamic",
			"override_by_e": "from_dynamic",
			"dyn_snowflake": int64(9007199254740993), // > 2^53-1，应被 SanitizeProperties 转为 string
		}
	})

	if err := client.Track("u_1001", "dev_001", "AddToCart", map[string]any{
		"override_by_e": "from_event",
		"sku_id":        "sku_88",
	}); err != nil {
		t.Fatalf("first Track: %v", err)
	}
	if err := client.Track("u_1001", "dev_001", "Checkout", map[string]any{
		"override_by_e": "from_event_2",
	}); err != nil {
		t.Fatalf("second Track: %v", err)
	}

	// 3. 验证 $user_set 画像事件不会混入静态公共属性与动态公共属性，也不会触发动态回调
	callsBeforeUserSet := dynCallCount.Load()
	if err := client.UserSet("u_1001", "dev_001", map[string]any{
		"vip_level": 4,
	}); err != nil {
		t.Fatalf("UserSet: %v", err)
	}
	if dynCallCount.Load() != callsBeforeUserSet {
		t.Fatalf("dynamic super properties callback should not be called for $user_set (before=%d, after=%d)",
			callsBeforeUserSet, dynCallCount.Load())
	}

	events := mem.snapshot()
	if len(events) != 3 {
		t.Fatalf("expected 3 events, got %d", len(events))
	}

	evt1 := events[0].Properties
	if evt1["static_only"] != "s_val" {
		t.Fatalf("expected static_only='s_val', got %#v", evt1["static_only"])
	}
	if _, exists := evt1["to_be_unset"]; exists {
		t.Fatalf("unsetting static property should exclude it from Track event: %+v", evt1)
	}
	if evt1["override_by_d"] != "from_dynamic" {
		t.Fatalf("dynamic super property should override static super property, got %#v", evt1["override_by_d"])
	}
	if evt1["override_by_e"] != "from_event" {
		t.Fatalf("event property should override both static and dynamic super properties, got %#v", evt1["override_by_e"])
	}
	if evt1["dyn_seq"] != int64(1) {
		t.Fatalf("expected first event dyn_seq=1, got %#v", evt1["dyn_seq"])
	}
	if s, ok := evt1["dyn_snowflake"].(string); !ok || s != "9007199254740993" {
		t.Fatalf("expected dynamic super property >2^53-1 to be sanitized to string, got %#v", evt1["dyn_snowflake"])
	}

	evt2 := events[1].Properties
	if evt2["dyn_seq"] != int64(2) {
		t.Fatalf("expected second event dyn_seq=2, got %#v", evt2["dyn_seq"])
	}

	userEvt := events[2]
	if userEvt.EventName != "$user_set" {
		t.Fatalf("expected $user_set, got %s", userEvt.EventName)
	}
	if len(userEvt.Properties) != 1 || userEvt.Properties["vip_level"] != int64(4) {
		t.Fatalf("$user_set must not contain static or dynamic super properties, got %+v", userEvt.Properties)
	}

	// 4. 并发竞态验证：多协程同时读写静态/动态公共属性与发送事件（配合 go test -race）
	var wg sync.WaitGroup
	for i := 0; i < 16; i++ {
		wg.Add(1)
		go func(id int) {
			defer wg.Done()
			_ = client.SetSuperProperties(map[string]any{"worker_flag": id})
			_ = client.GetSuperProperties()
			if id%2 == 0 {
				client.UnsetSuperProperty("worker_flag")
			}
			client.SetDynamicSuperProperties(func() map[string]any {
				return map[string]any{"dyn_worker": id}
			})
			_ = client.Track("u_race", "d_race", "ConcurrentEvent", map[string]any{"seq": id})
			_ = client.UserSet("u_race", "d_race", map[string]any{"level": id})
		}(i)
	}
	wg.Wait()
}

// TestStagingConsumerPreviewAndConfirmSubmit 验证 NewStagingConsumer 在调用 Track / SetSuperProperties / UserSet
// 以及 Flush / Close 时只暂存不发送，PreviewRequestJSON 输出完整请求 JSON，且仅在 ConfirmSubmit / SubmitToGateway 时真正发送。
func TestStagingConsumerPreviewAndConfirmSubmit(t *testing.T) {
	var httpCalls atomic.Int32
	var mu sync.Mutex
	var receivedPayloads []TrackBatchPayload

	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		httpCalls.Add(1)
		var reader io.Reader = r.Body
		if r.Header.Get("Content-Encoding") == "gzip" {
			gz, err := gzip.NewReader(r.Body)
			if err != nil {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			defer gz.Close()
			reader = gz
		}

		var batch TrackBatchPayload
		if err := json.NewDecoder(reader).Decode(&batch); err != nil {
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		mu.Lock()
		receivedPayloads = append(receivedPayloads, batch)
		mu.Unlock()

		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, `{"code":200,"message":"success","request_id":"req_stage_1","data":{"accepted":3,"rejected":0,"dry_run":true}}`)
	}))
	defer srv.Close()

	staging := NewStagingConsumer(9, "abi_tok_staging_test", true)
	client := New(staging)

	if err := client.SetSuperProperties(map[string]any{
		"$app_version": "2.5.0",
		"service_name": "order-service",
	}); err != nil {
		t.Fatalf("SetSuperProperties: %v", err)
	}
	client.SetDynamicSuperProperties(func() map[string]any {
		return map[string]any{
			"server_region": "ap-shanghai",
		}
	})

	if err := client.Track("acct_100", "vis_100", "$login", map[string]any{
		"login_method": "sso",
	}); err != nil {
		t.Fatalf("Track $login: %v", err)
	}
	if err := client.Track("acct_100", "vis_100", "OrderPaid", map[string]any{
		"snowflake_id": int64(9007199254740999),
		"amount":       199.5,
	}); err != nil {
		t.Fatalf("Track: %v", err)
	}
	if err := client.UserSet("acct_100", "vis_100", map[string]any{
		"vip_level": 2,
	}); err != nil {
		t.Fatalf("UserSet: %v", err)
	}

	// 调用 Flush 与 Close 不得触发任何真实网络请求
	if err := client.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	if err := client.Close(); err != nil {
		t.Fatalf("Close: %v", err)
	}
	if got := httpCalls.Load(); got != 0 {
		t.Fatalf("expected 0 HTTP calls before confirmation, got %d", got)
	}

	// 1. 验证 BuildRequestPayload 与 PreviewRequestJSON 格式化输出
	previewJSON, err := staging.PreviewRequestJSON()
	if err != nil {
		t.Fatalf("PreviewRequestJSON: %v", err)
	}
	if !strings.Contains(previewJSON, "\n  \"project_id\": 9,") {
		t.Fatalf("expected indented JSON preview containing project_id=9, got:\n%s", previewJSON)
	}

	var previewed TrackBatchPayload
	if err := json.Unmarshal([]byte(previewJSON), &previewed); err != nil {
		t.Fatalf("unmarshal preview JSON: %v", err)
	}
	if previewed.ProjectID != 9 || previewed.ProjectToken != "abi_tok_staging_test" || !previewed.DryRun {
		t.Fatalf("unexpected preview payload header: %+v", previewed)
	}
	if len(previewed.Events) != 3 {
		t.Fatalf("expected 3 staged events in preview, got %d", len(previewed.Events))
	}
	orderEvt := previewed.Events[1]
	if orderEvt.EventName != "OrderPaid" ||
		orderEvt.Properties["service_name"] != "order-service" ||
		orderEvt.Properties["server_region"] != "ap-shanghai" ||
		orderEvt.Properties["snowflake_id"] != "9007199254740999" {
		t.Fatalf("unexpected OrderPaid properties in preview: %+v", orderEvt.Properties)
	}
	userEvt := previewed.Events[2]
	if userEvt.EventName != "$user_set" || len(userEvt.Properties) != 1 {
		t.Fatalf("expected $user_set without super properties, got %+v", userEvt)
	}

	// 2. 验证参数边界保护
	if err := staging.ConfirmSubmit(nil); err == nil {
		t.Fatal("expected error when ConfirmSubmit target is nil")
	}
	if err := staging.ConfirmSubmit(staging); err == nil {
		t.Fatal("expected error when ConfirmSubmit target is self")
	}

	// 3. 验证 ConfirmSubmit(target Consumer) 确认后才真正发送至网关
	batchTarget, err := NewBatchConsumer(BatchConfig{
		ServerURL:    srv.URL,
		ProjectID:    9,
		ProjectToken: "abi_tok_staging_test",
	})
	if err != nil {
		t.Fatalf("NewBatchConsumer: %v", err)
	}
	defer batchTarget.Close()

	if err := staging.ConfirmSubmit(batchTarget); err != nil {
		t.Fatalf("ConfirmSubmit: %v", err)
	}
	if got := httpCalls.Load(); got != 1 {
		t.Fatalf("expected 1 HTTP call after ConfirmSubmit, got %d", got)
	}

	// 4. 验证 SubmitToGateway 直接发送预览请求体（保留 DryRun 等顶层字段）并返回 GatewayEnvelope
	env, err := staging.SubmitToGateway(BatchConfig{
		ServerURL:    srv.URL,
		CompressGzip: true,
	})
	if err != nil {
		t.Fatalf("SubmitToGateway: %v", err)
	}
	if got := httpCalls.Load(); got != 2 {
		t.Fatalf("expected 2 HTTP calls after SubmitToGateway, got %d", got)
	}
	if env == nil || env.Code != 200 || env.Data.Accepted != 3 || !env.Data.DryRun {
		t.Fatalf("unexpected GatewayEnvelope from SubmitToGateway: %+v", env)
	}

	mu.Lock()
	if len(receivedPayloads) != 2 {
		mu.Unlock()
		t.Fatalf("expected 2 received batches, got %d", len(receivedPayloads))
	}
	firstSent := receivedPayloads[0]
	secondSent := receivedPayloads[1]
	mu.Unlock()

	if len(firstSent.Events) != 3 || firstSent.Events[1].EventID != previewed.Events[1].EventID {
		t.Fatalf("ConfirmSubmit must preserve previewed EventID, got %+v vs %+v", firstSent.Events, previewed.Events)
	}
	if !secondSent.DryRun || len(secondSent.Events) != 3 || secondSent.Events[1].EventID != previewed.Events[1].EventID {
		t.Fatalf("SubmitToGateway must send exact previewed payload, got %+v", secondSent)
	}

	// 5. 验证 Reset 后配合修改公共属性重新录制预览
	staging.Reset()
	if _, err := staging.SubmitToGateway(BatchConfig{ServerURL: srv.URL}); err == nil {
		t.Fatal("expected error submitting empty staging consumer after Reset")
	}
	if err := client.SetSuperProperties(map[string]any{"service_name": "billing-service"}); err != nil {
		t.Fatalf("SetSuperProperties update: %v", err)
	}
	if err := client.Track("acct_100", "vis_100", "InvoiceIssued", map[string]any{"invoice_no": "INV-01"}); err != nil {
		t.Fatalf("Track after Reset: %v", err)
	}
	replayedJSON, err := staging.PreviewRequestJSON()
	if err != nil {
		t.Fatalf("PreviewRequestJSON after Reset: %v", err)
	}
	if !strings.Contains(replayedJSON, `"billing-service"`) || len(staging.Events()) != 1 {
		t.Fatalf("expected replayed preview with updated super property and 1 event, got:\n%s", replayedJSON)
	}
}
