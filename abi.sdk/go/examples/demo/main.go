// Demo 演示程序采用「1. 配置参数并预览具体请求 JSON -> 2. 确认提交后发送并打印网关响应 JSON」两步式交互流程，
// 帮助开发者直观核对 ABI Go 服务端 SDK 构造的 POST /collect/api/v1/track/batch 请求报文。
package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"encoding/json"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"os"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	abi "github.com/anylink/abi-go-sdk"
)

const defaultSuperPropsJSON = `{"$app_version":"2.5.0","$platform":"GoServer","service_name":"order-service"}`

// DemoConfig 定义两步式演示（配置预览 -> 确认提交）的完整运行参数。
type DemoConfig struct {
	ServerURL          string
	ProjectID          int64
	ProjectToken       string
	Scenario           string
	SuperPropsJSON     string
	EnableDynamicSuper bool
	DryRun             bool
	CompressGzip       bool
}

func main() {
	var (
		serverURL    = flag.String("server-url", "", "ABI 采集网关基础地址（为空时在确认提交阶段自动启动内置本地 Mock 网关）")
		projectID    = flag.Int64("project-id", 1, "ABI 项目 ID")
		token        = flag.String("token", "abi_tok_demo_go", "ABI 项目采集写入 Token")
		scenario     = flag.String("scenario", "order", "要生成的演示场景：browse | identity | order | profile | all")
		superProps   = flag.String("super-props", defaultSuperPropsJSON, "自定义静态公共属性 JSON 字符串（传 {} 可不注入默认静态公共属性）")
		dynamicSuper = flag.Bool("dynamic-super", true, "是否注册动态公共属性回调（server_region、goroutine_count）")
		dryRun       = flag.Bool("dry-run", false, "是否在批量请求中开启 dry_run=true（网关仅校验不落库）")
		autoConfirm  = flag.Bool("yes", false, "非交互自动确认提交（跳过终端确认提示直接发送）")
	)
	flag.Parse()

	cfg := DemoConfig{
		ServerURL:          strings.TrimSpace(*serverURL),
		ProjectID:          *projectID,
		ProjectToken:       strings.TrimSpace(*token),
		Scenario:           strings.ToLower(strings.TrimSpace(*scenario)),
		SuperPropsJSON:     strings.TrimSpace(*superProps),
		EnableDynamicSuper: *dynamicSuper,
		DryRun:             *dryRun,
		CompressGzip:       true,
	}

	// 第 1 步：配置参数并生成完整的待提交请求 JSON 预览（此阶段不产生任何网络请求）
	previewJSON, staging, err := BuildDemoRequestPreview(cfg)
	if err != nil {
		fmt.Fprintf(os.Stderr, "[错误] 生成请求 JSON 预览失败: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("=== 待提交请求 JSON 预览 (POST /collect/api/v1/track/batch) ===")
	fmt.Println(previewJSON)

	// 第 2 步：交互终端且未传 --yes 时等待开发者确认；非 TTY（管道/自动化测试）或传了 --yes 时自动确认提交
	if !*autoConfirm && isInteractiveTerminal(os.Stdin) {
		fmt.Print("\n是否确认提交上述请求参数？输入 y 回车确认提交，其他键取消: ")
		reader := bufio.NewReader(os.Stdin)
		line, _ := reader.ReadString('\n')
		if !strings.EqualFold(strings.TrimSpace(line), "y") {
			fmt.Println("已取消提交，未向采集网关发送任何请求。")
			return
		}
	}

	_, respJSON, err := ConfirmSubmitDemo(staging, cfg)
	if err != nil {
		if respJSON != "" {
			fmt.Println("\n=== 提交响应结果 (Response JSON) ===")
			fmt.Println(respJSON)
		}
		fmt.Fprintf(os.Stderr, "[错误] 提交请求至采集网关失败: %v\n", err)
		os.Exit(1)
	}

	fmt.Println("\n=== 提交响应结果 (Response JSON) ===")
	fmt.Println(respJSON)
}

// BuildDemoRequestPreview 第 1 步：根据配置参数初始化 SDK 与 StagingConsumer，执行所选埋点场景，
// 并返回格式化后的 POST /collect/api/v1/track/batch 完整请求 JSON 字符串（零网络副作用）。
func BuildDemoRequestPreview(cfg DemoConfig) (string, *abi.StagingConsumer, error) {
	if cfg.ProjectID <= 0 {
		return "", nil, fmt.Errorf("project-id 必须大于 0（当前值: %d）", cfg.ProjectID)
	}
	if strings.TrimSpace(cfg.ProjectToken) == "" {
		return "", nil, fmt.Errorf("token 不能为空")
	}

	staging := abi.NewStagingConsumer(cfg.ProjectID, cfg.ProjectToken, cfg.DryRun)
	sdk := abi.New(staging)

	if strings.TrimSpace(cfg.SuperPropsJSON) != "" {
		staticProps, err := parseSuperPropertiesJSON(cfg.SuperPropsJSON)
		if err != nil {
			return "", nil, fmt.Errorf("解析 --super-props 失败: %w", err)
		}
		if len(staticProps) > 0 {
			if err := sdk.SetSuperProperties(staticProps); err != nil {
				return "", nil, fmt.Errorf("设置静态公共属性失败: %w", err)
			}
		}
	}

	if cfg.EnableDynamicSuper {
		sdk.SetDynamicSuperProperties(func() map[string]any {
			return map[string]any{
				"server_region":   "ap-shanghai",
				"goroutine_count": runtime.NumGoroutine(),
			}
		})
	}

	mode := strings.ToLower(strings.TrimSpace(cfg.Scenario))
	if mode == "" {
		mode = "order"
	}
	switch mode {
	case "browse":
		if err := TriggerAnonymousBrowseDemo(sdk); err != nil {
			return "", nil, err
		}
	case "identity":
		if err := TriggerLoginIdentityBindDemo(sdk); err != nil {
			return "", nil, err
		}
	case "order":
		if err := TriggerOrderLifecycleDemo(sdk); err != nil {
			return "", nil, err
		}
	case "profile":
		if err := TriggerUserProfileDemo(sdk); err != nil {
			return "", nil, err
		}
	case "all":
		if err := TriggerAnonymousBrowseDemo(sdk); err != nil {
			return "", nil, err
		}
		if err := TriggerLoginIdentityBindDemo(sdk); err != nil {
			return "", nil, err
		}
		if err := TriggerOrderLifecycleDemo(sdk); err != nil {
			return "", nil, err
		}
		if err := TriggerUserProfileDemo(sdk); err != nil {
			return "", nil, err
		}
	default:
		return "", nil, fmt.Errorf("未知的 --scenario 参数值 %q（可选值：browse | identity | order | profile | all）", mode)
	}

	previewJSON, err := staging.PreviewRequestJSON()
	if err != nil {
		return "", nil, err
	}
	return previewJSON, staging, nil
}

// ConfirmSubmitDemo 第 2 步：在确认请求 JSON 无误后，将 StagingConsumer 中暂存的报文提交至 ABI 采集网关
// （若 cfg.ServerURL 为空则自动启动临时本地 Mock 网关接收），并返回响应结构与格式化后的 Response JSON。
func ConfirmSubmitDemo(staging *abi.StagingConsumer, cfg DemoConfig) (*abi.GatewayEnvelope, string, error) {
	if staging == nil {
		return nil, "", fmt.Errorf("staging consumer 不能为空")
	}

	targetURL := strings.TrimSpace(cfg.ServerURL)
	if targetURL == "" {
		mockURL, closeFn, err := startEmbeddedMockGateway()
		if err != nil {
			return nil, "", fmt.Errorf("启动内置 Mock 采集网关失败: %w", err)
		}
		defer closeFn()
		targetURL = mockURL
	}

	env, submitErr := staging.SubmitToGateway(abi.BatchConfig{
		ServerURL:    targetURL,
		ProjectID:    cfg.ProjectID,
		ProjectToken: cfg.ProjectToken,
		CompressGzip: cfg.CompressGzip,
	})

	var respJSON string
	if env != nil {
		var buf bytes.Buffer
		enc := json.NewEncoder(&buf)
		enc.SetEscapeHTML(false)
		enc.SetIndent("", "  ")
		if err := enc.Encode(env); err == nil {
			respJSON = strings.TrimRight(buf.String(), "\n")
		}
	}
	if submitErr != nil {
		return env, respJSON, submitErr
	}
	return env, respJSON, nil
}

// TriggerAnonymousBrowseDemo 构造用户登录前的访客浏览行为事件（仅携带访客 distinct_id：$pageview、ProductViewed）。
func TriggerAnonymousBrowseDemo(sdk *abi.AbiAnalytics) error {
	distinctID := "vis_dev_7f8e9a01"

	if err := sdk.Track("", distinctID, "$pageview", map[string]any{
		"$url":      "https://store.example.com/products/bi-enterprise",
		"$url_path": "/products/bi-enterprise",
		"$title":    "ABI Enterprise Edition",
		"$referrer": "https://www.google.com",
	}); err != nil {
		return fmt.Errorf("上报 $pageview 失败: %w", err)
	}

	if err := sdk.Track("", distinctID, "ProductViewed", map[string]any{
		"product_id":   "sku_abi_ent_2026",
		"product_name": "ABI Enterprise Analytics Suite",
		"category":     "SaaS",
		"price":        2999.00,
	}); err != nil {
		return fmt.Errorf("上报 ProductViewed 失败: %w", err)
	}
	return nil
}

// TriggerLoginIdentityBindDemo 构造用户注册与登录成功事件（$signup、$login），同时携带 login_id 与访客 distinct_id，
// 由 Flink 流式引擎自动完成双 ID 实名身份映射（无需发送任何单独绑定事件）。
func TriggerLoginIdentityBindDemo(sdk *abi.AbiAnalytics) error {
	accountID := "acct_900102"
	distinctID := "vis_dev_7f8e9a01"

	if err := sdk.Track(accountID, distinctID, "$signup", map[string]any{
		"register_channel": "github_oauth",
	}); err != nil {
		return fmt.Errorf("上报 $signup 失败: %w", err)
	}

	if err := sdk.Track(accountID, distinctID, "$login", map[string]any{
		"login_method": "sso_oidc",
		"mfa_verified": true,
	}); err != nil {
		return fmt.Errorf("上报 $login 失败: %w", err)
	}
	return nil
}

// TriggerOrderLifecycleDemo 构造订单里程碑事件（使用 TrackWithOptions 指定确定性 EventID 保障同日重试幂等），
// 演示超过 2^53-1 的 64 位雪花 ID 自动转为字符串安全序列化。
func TriggerOrderLifecycleDemo(sdk *abi.AbiAnalytics) error {
	accountID := "acct_900102"
	distinctID := "vis_dev_7f8e9a01"
	snowflakeOrderID := int64(9007199254740999) // 超过 2^53-1 (9007199254740991)，SDK 自动转为字符串传输

	if err := sdk.TrackWithOptions(abi.TrackOptions{
		EventID:    "ord_created_20261110_8801",
		EventName:  "OrderCreated",
		AccountID:  accountID,
		DistinctID: distinctID,
		Timestamp:  time.Now().UTC(),
		Properties: map[string]any{
			"order_no":       "ORD-20261110-8801",
			"snowflake_id":   snowflakeOrderID,
			"order_status":   "CREATED",
			"payable_amount": 2999.00,
			"item_sku_list":  []string{"sku_abi_ent_2026", "sku_addon_flink"},
			"sub_task_ids":   []int64{1001, 9007199254741024},
		},
	}); err != nil {
		return fmt.Errorf("上报 OrderCreated 失败: %w", err)
	}

	if err := sdk.TrackWithOptions(abi.TrackOptions{
		EventID:    "ord_paid_20261110_8801",
		EventName:  "OrderPaid",
		AccountID:  accountID,
		DistinctID: distinctID,
		Timestamp:  time.Now().UTC(),
		Properties: map[string]any{
			"order_no":        "ORD-20261110-8801",
			"snowflake_id":    snowflakeOrderID,
			"order_status":    "PAID",
			"payable_amount":  2549.15,
			"coupon_code":     "FIRST_ORDER_50",
			"discount_rate":   0.85,
			"payment_channel": "stripe_enterprise",
		},
	}); err != nil {
		return fmt.Errorf("上报 OrderPaid 失败: %w", err)
	}

	if err := sdk.TrackWithOptions(abi.TrackOptions{
		EventID:    "ord_fulfilled_20261110_8801",
		EventName:  "OrderFulfilled",
		AccountID:  accountID,
		DistinctID: distinctID,
		Timestamp:  time.Now().UTC(),
		Properties: map[string]any{
			"order_no":       "ORD-20261110-8801",
			"snowflake_id":   snowflakeOrderID,
			"order_status":   "FULFILLED",
			"payable_amount": 2549.15,
			"invoice_issued": true,
			"fulfilled_at":   time.Now().UTC(),
		},
	}); err != nil {
		return fmt.Errorf("上报 OrderFulfilled 失败: %w", err)
	}
	return nil
}

// TriggerUserProfileDemo 构造全部 7 种用户画像属性变更操作（不会混入静态/动态公共属性）：
// UserSet、UserSetOnce、UserAdd、UserAppend、UserUniqAppend、UserUnset 与 UserDelete。
func TriggerUserProfileDemo(sdk *abi.AbiAnalytics) error {
	accountID := "acct_900102"
	distinctID := "vis_dev_7f8e9a01"

	if err := sdk.UserSet(accountID, distinctID, map[string]any{
		"company_name": "Acme Analytics Corp",
		"plan_tier":    "Enterprise",
		"seat_count":   50,
		"$city":        "Shanghai",
	}); err != nil {
		return fmt.Errorf("调用 UserSet 失败: %w", err)
	}

	if err := sdk.UserSetOnce(accountID, distinctID, map[string]any{
		"first_utm_source": "github_release",
		"activated_at":     time.Now().UTC(),
	}); err != nil {
		return fmt.Errorf("调用 UserSetOnce 失败: %w", err)
	}

	if err := sdk.UserAdd(accountID, distinctID, map[string]any{
		"cumulative_payment": 2549.15,
		"order_count":        1,
	}); err != nil {
		return fmt.Errorf("调用 UserAdd 失败: %w", err)
	}

	if err := sdk.UserAppend(accountID, distinctID, map[string]any{
		"enabled_modules": []string{"event_analysis", "funnel_analysis"},
	}); err != nil {
		return fmt.Errorf("调用 UserAppend 失败: %w", err)
	}

	if err := sdk.UserUniqAppend(accountID, distinctID, map[string]any{
		"enabled_modules": []string{"funnel_analysis", "retention_analysis", "sql_ide"},
	}); err != nil {
		return fmt.Errorf("调用 UserUniqAppend 失败: %w", err)
	}

	if err := sdk.UserUnset(accountID, distinctID, "legacy_trial_tag", "onboarding_banner_dismissed"); err != nil {
		return fmt.Errorf("调用 UserUnset 失败: %w", err)
	}

	if err := sdk.UserDelete("acct_gdpr_erased_01", "vis_gdpr_erased_01"); err != nil {
		return fmt.Errorf("调用 UserDelete 失败: %w", err)
	}
	return nil
}

func parseSuperPropertiesJSON(raw string) (map[string]any, error) {
	dec := json.NewDecoder(strings.NewReader(raw))
	dec.UseNumber()

	var decoded map[string]any
	if err := dec.Decode(&decoded); err != nil {
		return nil, err
	}
	if decoded == nil {
		return nil, fmt.Errorf("JSON 顶层必须是对象 (object)")
	}
	var extra any
	if err := dec.Decode(&extra); err != io.EOF {
		return nil, fmt.Errorf("包含多余的非预期 JSON 内容")
	}

	out := make(map[string]any, len(decoded))
	for k, v := range decoded {
		out[k] = normalizeJSONNumberValue(v)
	}
	return out, nil
}

func normalizeJSONNumberValue(v any) any {
	switch val := v.(type) {
	case json.Number:
		if i, err := val.Int64(); err == nil {
			return i
		}
		if u, err := strconv.ParseUint(val.String(), 10, 64); err == nil {
			return u
		}
		if f, err := val.Float64(); err == nil {
			return f
		}
		return val.String()
	case []any:
		list := make([]any, len(val))
		for i, elem := range val {
			list[i] = normalizeJSONNumberValue(elem)
		}
		return list
	case map[string]any:
		m := make(map[string]any, len(val))
		for k, elem := range val {
			m[k] = normalizeJSONNumberValue(elem)
		}
		return m
	default:
		return v
	}
}

func isInteractiveTerminal(f *os.File) bool {
	if f == nil {
		return false
	}
	fi, err := f.Stat()
	if err != nil {
		return false
	}
	if (fi.Mode() & os.ModeCharDevice) == 0 {
		return false
	}
	// os/exec 默认会将未指定 Stdin 的子进程重定向至 os.DevNull（/dev/null 在 Unix 下同样带有 ModeCharDevice），需显式排除
	if devNullFi, err := os.Stat(os.DevNull); err == nil && os.SameFile(fi, devNullFi) {
		return false
	}
	return true
}

// startEmbeddedMockGateway 在本地随机端口启动静默的内置 Mock 采集网关，支持 Gzip 请求体解压与标准回执响应。
func startEmbeddedMockGateway() (string, func(), error) {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", nil, err
	}

	var batchSeq atomic.Int64
	mux := http.NewServeMux()
	mux.HandleFunc("/collect/api/v1/track/batch", func(w http.ResponseWriter, r *http.Request) {
		var reader io.Reader = r.Body
		if r.Header.Get("Content-Encoding") == "gzip" {
			gz, err := gzip.NewReader(r.Body)
			if err != nil {
				http.Error(w, "invalid gzip body", http.StatusBadRequest)
				return
			}
			defer gz.Close()
			reader = gz
		}

		var payload abi.TrackBatchPayload
		if err := json.NewDecoder(reader).Decode(&payload); err != nil {
			http.Error(w, "invalid json body", http.StatusBadRequest)
			return
		}

		seq := batchSeq.Add(1)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		_, _ = fmt.Fprintf(w, `{"code":200,"message":"success","request_id":"req_mock_%d","data":{"accepted":%d,"rejected":0,"dry_run":%v}}`,
			seq, len(payload.Events), payload.DryRun)
	})

	srv := &http.Server{Handler: mux}
	go func() {
		_ = srv.Serve(ln)
	}()

	baseURL := "http://" + ln.Addr().String()
	closeFn := func() {
		_ = srv.Close()
	}
	return baseURL, closeFn, nil
}
