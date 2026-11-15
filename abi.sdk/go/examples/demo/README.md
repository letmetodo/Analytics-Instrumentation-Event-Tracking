# ABI Go 服务端 SDK 示例程序 (Demo)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

本目录包含 **ABI Go 服务端 SDK (`github.com/anylink/abi-go-sdk`)** 的两步式可交互演示程序 [`main.go`](./main.go)（纯 Go 标准库实现，零第三方依赖）。

为了方便开发者直观核对 SDK 生成的真实协议报文而不再被过程日志淹没，Demo 采用 **「1. 参数配置与请求 JSON 预览 (`POST /collect/api/v1/track/batch`) -> 2. 确认提交后才真正发送并输出响应 JSON」** 的工作流：

1. **第 1 步（暂存与预览）**：通过 `abi.NewStagingConsumer` 在内存中完成公共属性（静态/动态）合并、标识符校验及超 $2^{53}-1$ 64 位雪花 ID 字符串保护，输出唯一一份完整的待提交请求 JSON 预览（**零网络副作用**）。
2. **第 2 步（确认与提交）**：
   - 在交互式终端（TTY）且未传 `--yes` 时，提示开发者输入 `y` 回车确认提交（输入其他键立即取消，不发送任何请求）；
   - 在传了 `--yes` 或处于管道/CI 非交互环境（非 TTY）时，自动执行提交并输出单份网关 **`提交响应结果 (Response JSON)`**。

---

## 1. 快速启动

确保本地已安装 **Go 1.22+**。

### 方式一：交互式预览请求 JSON 并确认提交（默认订单场景）

在终端直接运行，程序会先完整打印 `POST /collect/api/v1/track/batch` 请求 JSON，并在输入 `y` 确认后自动通过内置本地 Mock 网关完成提交：

```bash
cd abi.sdk/go
go run ./examples/demo
```

### 方式二：非交互一键确认提交（自动化测试 / 快速联调）

传入 `--yes` 跳过终端交互确认，依次输出单份**待提交请求 JSON 预览**与单份**提交响应结果 JSON**：

```bash
cd abi.sdk/go
go run ./examples/demo --yes
```

### 方式三：自定义公共属性、场景并连接真实 ABI 采集网关 (`:8081`)

当本地或测试环境已启动 `abi.srv` 采集网关（默认监听 `:8081`）时，可自定义项目凭证、业务场景与公共属性后预览并提交：

```bash
cd abi.sdk/go
go run ./examples/demo \
  --server-url="http://127.0.0.1:8081" \
  --project-id=1 \
  --token="abi_tok_demo_go" \
  --scenario="all" \
  --super-props='{"$app_version":"2.6.0","$platform":"GoServer","service_name":"checkout-api"}' \
  --dynamic-super=true \
  --dry-run=true
```

---

## 2. 命令行参数说明

| 参数名 | 类型 | 默认值 | 说明 |
| :--- | :--- | :--- | :--- |
| `--server-url` | `string` | `""`（空字符串） | ABI 采集网关基础地址（如 `http://127.0.0.1:8081`）。为空时仅在**确认提交阶段**按需启动内置本地 Mock 网关（`127.0.0.1:0`）。 |
| `--project-id` | `int64` | `1` | ABI 目标项目 ID（对应请求体 `project_id`）。 |
| `--token` | `string` | `"abi_tok_demo_go"` | ABI 项目采集写入凭证（对应请求体 `project_token`）。 |
| `--scenario` | `string` | `"order"` | 要生成的演示场景：`browse` \| `identity` \| `order` \| `profile` \| `all`。 |
| `--super-props` | `string` | `'{"$app_version":"2.5.0","$platform":"GoServer","service_name":"order-service"}'` | 静态公共属性 JSON 字符串（传 `'{}'` 可不注入静态公共属性）。 |
| `--dynamic-super` | `bool` | `true` | 是否注册动态公共属性回调（自动在行为事件中注入 `server_region` 与实时 `goroutine_count`）。 |
| `--dry-run` | `bool` | `false` | 是否在请求体中携带 `"dry_run": true`（网关执行完整校验但不写入 Kafka / StarRocks）。 |
| `--yes` | `bool` | `false` | 非交互自动确认提交；当 `--yes=false` 且标准输入为交互终端时等待输入 `y` 确认。 |

### `--scenario` 可选场景一览

- `order`（**默认**）：订单全生命周期事件（`TrackWithOptions` 确定性幂等主键演练；注：按 D7① / G6 门禁，`TrackFirst` / `TrackUpdate` / `TrackOverwrite` 统一标注为当前版本未开放）及超 $2^{53}-1$ 64 位雪花 ID 自动字符串序列化。
- `browse`：未登录访客浏览采集（仅携带访客 `distinct_id`：`$pageview` 与 `ProductViewed`）。
- `identity`：用户注册与登录双 ID 自动关联（`$signup` + `$login` 同时携带 `login_id` 与访客 `distinct_id`，由 Flink 自动完成实名绑定）。
- `profile`：针对用户画像表的全部 7 种 `$user_*` 操作（自动隔离静态/动态公共属性，防止行为级公共字段污染画像表）。
- `all`：一次性按顺序组合生成上述全部 4 类场景的完整批量请求报文。

---

## 3. 两步式可调用代码参考（先预览 JSON，确认后再发送）

业务代码或联调工具可直接参考 [`main.go`](./main.go) 中暴露的 `BuildDemoRequestPreview` 与 `ConfirmSubmitDemo`，或直接使用 SDK 提供的 `abi.NewStagingConsumer`：

```go
package main

import (
	"fmt"
	"log"

	abi "github.com/anylink/abi-go-sdk"
)

func previewThenSubmitExample() {
	// 第 1 步：初始化内存暂存 Consumer（dryRun=false），配置公共属性并录制埋点事件
	staging := abi.NewStagingConsumer(1, "abi_tok_demo_go", false)
	sdk := abi.New(staging)

	_ = sdk.SetSuperProperties(map[string]any{
		"$app_version": "2.5.0",
		"$platform":    "GoServer",
		"service_name": "order-service",
	})
	_ = sdk.Track("acct_900102", "vis_dev_7f8e9a01", "OrderPaid", map[string]any{
		"order_no":     "ORD-20261110-8801",
		"snowflake_id": int64(9007199254740999), // > 2^53-1，预览 JSON 中自动序列化为 "9007199254740999"
		"amount":       2549.15,
	})

	// 查看即将提交至 POST /collect/api/v1/track/batch 的完整格式化 JSON（此时尚未发起任何网络请求）
	reqJSON, err := staging.PreviewRequestJSON()
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("待提交请求 JSON 预览:\n", reqJSON)

	// 第 2 步：核对无误后确认提交，发送至网关并获取响应信封（也可通过 staging.ConfirmSubmit(batchConsumer) 投递给任意 Consumer）
	respEnv, err := staging.SubmitToGateway(abi.BatchConfig{
		ServerURL:    "http://127.0.0.1:8081",
		CompressGzip: true,
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("网关确认接收事件数: accepted=%d, rejected=%d, request_id=%s\n",
		respEnv.Data.Accepted, respEnv.Data.Rejected, respEnv.RequestID)
}
```

> **提示**：若在预览后需要修改公共属性重新生成报文，可调用 `staging.Reset()` 清空暂存队列，更新 `sdk.SetSuperProperties(...)` 后重新录制并调用 `staging.PreviewRequestJSON()`。

---

## 4. 生产环境高吞吐异步集成参考

在线上高并发微服务中，完成前期报文预览与联调验证后，推荐在进程启动时初始化全局唯一的异步批量 `*abi.BatchConsumer`（支持 Gzip 压缩、定时/定量双触发与 429/5xx 幂等重试），并在进程退出前调用 `analytics.Close()` 确保缓冲事件全部刷盘：

```go
consumer, err := abi.NewBatchConsumer(abi.BatchConfig{
	ServerURL:     "http://127.0.0.1:8081",
	ProjectID:     1,
	ProjectToken:  "abi_tok_demo_go",
	BatchSize:     100,
	FlushInterval: 2 * time.Second,
	CompressGzip:  true,
})
if err != nil {
	log.Fatal(err)
}
analytics := abi.New(consumer)
defer analytics.Close()
```
