# ABI Go Server SDK (`github.com/anylink/abi-go-sdk`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`abi-go-sdk` is the official Go server-side data collection SDK for the **ABI Enterprise User Behavior Analytics (UBA) & BI Platform** (API design benchmarked against ThinkingData / Sensors Data). Built entirely with the Go standard library (**zero third-party dependencies**), the SDK provides strict client-side identifier and property normalization, 64-bit integer precision protection, and four pluggable transport consumers.

---

## 1. Key Features & Four-Consumer Architecture

### Key Features
- **Zero Third-Party Dependencies**: Built 100% on the Go 1.22+ standard library without external dependencies, eliminating dependency version conflicts in host microservices.
- **Concurrency-Safe by Design**: Both the `AbiAnalytics` client and all built-in Consumers are concurrency-safe and designed to be shared as a singleton across thousands of goroutines.
- **Strict Client-Side Pre-Validation**: Automatically validates event names and property keys against `^[a-zA-Z$#][a-zA-Z0-9_$#]{0,127}$` (enforcing an allowlist for `$` / `#` system-prefixed names), verifies UTF-8 encoding, and checks byte length limits (`distinct_id`/`event_id` ≤ 64 bytes, `login_id` ≤ 128 bytes; at least one of `distinct_id` or `login_id` must be non-empty, never copying `login_id` into `distinct_id`).
- **64-Bit Snowflake ID Precision Safety (`> 2^53 - 1` Auto-String Serialization)**: Automatically converts `int64` / `uint64` property values (including slice elements) whose absolute value exceeds the IEEE-754 double-precision safe integer limit (`9007199254740991`) into decimal strings, preventing precision loss in JavaScript parsers or cross-language pipelines.
- **Layered Static & Dynamic Super Properties**: Merges properties strictly following the precedence `Static Super Properties < Dynamic Super Properties < Per-Event Properties`, while automatically isolating super properties from `$user_*` / `#user_*` profile operations so behavioral context never pollutes the user profile table.
- **Built-in Event Time & Client IP Extraction**: Supports `#time` / `$time` in event properties (parsed into the event's millisecond `timestamp` and stripped from `properties`) and `#ip` / `$ip` (used by the Ingest Gateway for server-side GeoIP resolution override).

### Four-Consumer Architecture

| Consumer Type | Constructor | Primary Use Case & Capabilities |
| :--- | :--- | :--- |
| **`StagingConsumer`** | `abi.NewStagingConsumer` | **Two-Step Preview & Confirmed Submission**: Stages events in an in-memory queue so you can inspect the exact formatted `POST /collect/api/v1/track/batch` JSON via `PreviewRequestJSON()` (zero network side effects) before calling `SubmitToGateway()` or `ConfirmSubmit()`. |
| **`BatchConsumer`** | `abi.NewBatchConsumer` | **High-Throughput Async Batch Ingestion**: Buffers events in memory and flushes asynchronously by batch size (`BatchSize`, default 50, max 500) or interval (`FlushInterval`, default 3s), with Gzip compression and exponential-backoff idempotent retries on `429` / `5xx` (preserving `event_id` for StarRocks deduplication). |
| **`LoggerConsumer`** | `abi.NewLoggerConsumer` | **Local Rotating JSONL Persistence**: Writes events as newline-delimited JSON (JSONL) to local disk with automatic daily (`RotateDaily`), hourly (`RotateHourly`), and file-size (`MaxFileSizeMB`) rotation for sidecar log shippers (Filebeat / Vector / LogBus). |
| **`DebugConsumer`** | `abi.NewDebugConsumer` | **Synchronous L4 Validation & `dry_run`**: Sends events one by one synchronously with `debug=true` (and optional `DryRun: true` to validate without writing to Kafka / StarRocks), immediately returning detailed gateway L3/L4 rejection reasons. |

---

## 2. Installation & Requirements

- **Go Version**: Go `1.22` or higher
- **External Dependencies**: None (Go standard library only)

```bash
go get github.com/anylink/abi-go-sdk
```

When developing or running tests inside the ABI monorepo, run commands directly from the `abi.sdk/go` directory.

---

## 3. Required Server-Side Fields & Client Passthrough Guide (IP / Identity / Time / Idempotency Key)

### 3.1 Why Do Server-Side SDK Required Fields Differ from Frontend / Mobile SDKs?

- **Frontend / Mobile SDKs (Web / iOS / Android / Mini-Program)**: Run on a **single-user client device** and connect directly to the Ingest Gateway. The client SDK automatically generates and persists `distinct_id` (visitor/device ID, aligned with ThinkingData `getDistinctId()`), updates local `login_id` state on `login(accountId)` without sending a separate bind event, collects device context (`$os` / `$device_model` / `$app_version`), and allows the Ingest Gateway to extract the user's real public IP directly from the client TCP connection.
- **Go / Java Server-Side SDKs**: Run as a **stateless, multi-user shared singleton inside backend data centers or cloud VPCs**. A server SDK cannot cache single-user session state in memory, and its TCP connection to the `:8081` Ingest Gateway only exposes the **backend server's internal/IDC egress IP** (and `LoggerConsumer` disk logging has no network connection IP at all). Therefore, **user identity, real client IP, actual event occurrence time, and deterministic idempotency keys** must be explicitly passed by integration engineers from the current request context or message payload.

### 3.2 Server-Side Field Requirement & Source Reference Table

| Field Category | SDK Parameter / `properties` Key | Requirement Level | Why It Matters & Where to Extract It |
| :--- | :--- | :--- | :--- |
| **User Identity**<br>(`login_id` / `distinct_id`) | Go: `accountID`(`login_id`) + `distinctID`(`distinct_id`)<br>or `TrackOptions{AccountID, DistinctID}` | **[Required on Every Call]** | Strictly aligned with ThinkingData's dual-ID contract: only `distinct_id` (visitor/device ID, ≤ 64 bytes) and `login_id` (account ID, ≤ 128 bytes) exist on wire, and **at least one must be non-empty** (when `distinct_id` is empty, `distinct_id: ""` and `login_id` are sent directly without copying `login_id` into `distinct_id`).<br>To stitch the **"Frontend Visitor Browse → Backend Order Payment"** funnel, pass `distinct_id` from the frontend via an HTTP header (e.g., `X-ABI-Distinct-Id: abi.getDistinctId()`); whenever any `Track*` or `User*` event carries both `login_id` and `distinct_id`, Flink automatically binds the two identities. |
| **Real Client IP**<br>(`#ip` / `$ip`) | `properties["#ip"]`<br>(or `properties["$ip"]`) | **[Required for Geo Analysis]** | When a backend server connects to the `:8081` Ingest Gateway, the gateway TCP socket only sees the **backend server's data center IP** (`LoggerConsumer` has no socket IP at all). **If `#ip` / `$ip` is omitted, every server event's country/province/city will resolve to your data center location or private LAN IP!**<br>Extract the user's real public IP from HTTP headers (`X-Forwarded-For` first hop or `X-Real-IP`) and pass it in `properties["#ip"]` (or `"$ip"`). The Gateway and Flink Job1 ETL prioritize `#ip` > `$ip` to resolve `$country` / `$province` / `$city` and automatically strip the temporary IP key before persisting `properties`. |
| **Event Occurrence Time**<br>(`#time` / `$time` / `Timestamp`) | `properties["#time"]` / `properties["$time"]`<br>or `TrackOptions.Timestamp` | **[Optional for Real-Time; Required for Async MQ / Callbacks / Backfill]** | Synchronous real-time APIs default to the server's current wall clock when omitted. However, for **async Kafka/RocketMQ consumers, payment webhooks, or offline batch backfills**, you must pass the actual business occurrence time via `properties["#time"]` (accepts `time.Time`, unix ms, RFC3339, or `"2006-01-02 15:04:05.000"`) or `TrackOptions.Timestamp` (must fall within the project's `ts_window_days` window; automatically stripped from `properties` after extraction). |
| **Idempotent Event ID**<br>(`event_id`) | `TrackOptions.EventID` | **[Strongly Recommended for MQ & Core Transactions]** | When omitted, the SDK generates a random UUIDv4. However, if **MQ retries, webhook replays, or backfill reruns** generate a new UUID each time, duplicate events and inflated revenue metrics will occur. Pass a deterministic business key (e.g., `"ord_paid_" + orderNo`, ≤ 64 bytes) via `TrackWithOptions` for same-day idempotent deduplication (*Note: per D7① / G6 gate, `TrackFirst` / `TrackUpdate` / `TrackOverwrite` are unsupported in current version and return `ErrUnsupportedMutableTrack`*). |
| **Client Device Context**<br>(`$os` / `$app_version` / `$device_model`) | `properties["$os"]`<br>`properties["$app_version"]`<br>`properties["$device_model"]` | **[Passthrough from Frontend on Demand]** | Backend servers cannot auto-detect a user's phone model or client app version. If you need to break down server-side events (such as `OrderPaid`) by client OS or app version, forward them from frontend HTTP headers (e.g., `X-Client-OS`, `X-App-Version`) into per-event `properties` (never put per-user device info into global `SetSuperProperties`). |

---

## 4. Quick Start & Production Integration Code Examples

### 4.1 Two-Step Request JSON Preview & Confirmed Submission (`StagingConsumer`)

During development debugging or automated contract tests, preview the complete request JSON first (including client-forwarded `"#ip"` and `"order_id"`) and submit it to the gateway (or forward to another Consumer) after verifying the payload:

```go
package main

import (
	"fmt"
	"log"

	abi "github.com/anylink/abi-go-sdk"
)

func main() {
	// Step 1: Create StagingConsumer (projectID=1, dryRun=false) and stage events in memory
	staging := abi.NewStagingConsumer(1, "abi_tok_demo_go", false)
	sdk := abi.New(staging)

	_ = sdk.SetSuperProperties(map[string]any{
		"$platform":    "GoServer",
		"service_name": "order-service",
	})

	_ = sdk.Track("acct_900102", "vis_dev_7f8e9a01", "OrderPaid", map[string]any{
		"#ip":          "203.0.113.42",          // Real client public IP extracted from X-Forwarded-For / X-Real-IP
		"order_id":     int64(9007199254740999), // > 2^53-1 Snowflake ID, auto-serialized as string "9007199254740999"
		"order_no":     "ORD-20261110-8801",
		"amount":       2549.15,
		"$os":          "iOS",                   // Client OS context forwarded from frontend headers on demand
		"$app_version": "2.5.0",
	})

	// Preview the complete POST /collect/api/v1/track/batch request JSON (zero network requests)
	reqJSON, err := staging.PreviewRequestJSON()
	if err != nil {
		log.Fatal(err)
	}
	fmt.Println("=== Request JSON Preview ===")
	fmt.Println(reqJSON)

	// Step 2 (Option A): Submit directly to the ABI Ingest Gateway and inspect the response envelope
	env, err := staging.SubmitToGateway(abi.BatchConfig{
		ServerURL:    "http://127.0.0.1:8081",
		CompressGzip: true,
	})
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("Submitted: accepted=%d, rejected=%d, request_id=%s\n",
		env.Data.Accepted, env.Data.Rejected, env.RequestID)

	// Step 2 (Option B): Or forward staged events to any target Consumer (e.g. BatchConsumer / LoggerConsumer)
	// _ = staging.ConfirmSubmit(batchConsumer)
}
```

### 4.2 High-Throughput `BatchConsumer`, HTTP Header Passthrough & Complete API Reference

The example below covers `BatchConsumer` initialization, extracting visitor `distinct_id` and real client IP from HTTP headers, passing a deterministic idempotent `EventID` via `TrackWithOptions`, behavioral event tracking (including `#time`/`$time` extraction, `#ip`/`$ip` GeoIP override, and `> 2^53 - 1` large integer conversion), and all 7 user profile methods:

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

// extractClientIP extracts the user's real public IP from reverse-proxy headers (preventing data center IP attribution)
func extractClientIP(r *http.Request) string {
	if xff := strings.TrimSpace(r.Header.Get("X-Forwarded-For")); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	return strings.TrimSpace(r.Header.Get("X-Real-IP"))
}

func main() {
	// 1. Initialize production high-throughput async BatchConsumer (Gzip compression + exponential backoff retry)
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
			log.Printf("[ABI SDK] batch delivery failed (dropped=%d): %v", len(dropped), err)
		},
	})
	if err != nil {
		log.Fatal(err)
	}

	sdk := abi.New(consumer)
	defer sdk.Close() // Drain buffered events and close cleanly before process exit

	// 2. Static super properties (only register service-level metadata; never put single-user IP or device info here)
	_ = sdk.SetSuperProperties(map[string]any{
		"$platform":    "GoServer",
		"service_name": "checkout-service",
		"temp_flag":    "will_be_removed",
	})
	sdk.UnsetSuperProperty("temp_flag")
	currentSuper := sdk.GetSuperProperties()
	_ = currentSuper
	// Call sdk.ClearSuperProperties() if you need to clear all static super properties

	// 3. Dynamic super properties (evaluated per behavioral event; precedence: Static < Dynamic < Event Properties)
	sdk.SetDynamicSuperProperties(func() map[string]any {
		return map[string]any{
			"server_region":   "ap-shanghai",
			"goroutine_count": runtime.NumGoroutine(),
		}
	})

	// Simulate extracting identity and client IP from current request context and frontend headers (e.g. X-ABI-Distinct-Id, X-Forwarded-For)
	accountID := "acct_900102"
	distinctID := "vis_dev_7f8e9a01" // Forwarded from frontend header: r.Header.Get("X-ABI-Distinct-Id")
	clientIP := "203.0.113.42"       // Extracted via extractClientIP(r)

	// 4. Automatic dual-ID binding: whenever any Track* or User* event carries both accountID (login_id) and distinctID, Flink binds them automatically
	_ = sdk.Track(accountID, distinctID, "$login", map[string]any{
		"#ip":          clientIP,
		"login_method": "sso_oidc",
	})

	// 5. Behavioral event tracking
	// 5.1 Standard Track (with #ip real client IP override, #time custom event time, and order_id > 2^53-1 string conversion)
	_ = sdk.Track(accountID, distinctID, "OrderPaid", map[string]any{
		"#time":        "2026-11-10 14:30:00.125", // Or pass time.Time / unix ms / "$time"; extracted as event timestamp and stripped from properties
		"#ip":          clientIP,                  // Pass real client public IP ("#ip" or "$ip") so GeoIP resolves user location instead of server IDC
		"order_id":     int64(9007199254740999),   // Exceeds 2^53-1 (9007199254740991), auto-serialized as "9007199254740999"
		"order_no":     "ORD-20261110-8801",
		"amount":       2549.15,
		"item_skus":    []string{"sku_abi_ent", "sku_addon_flink"},
		"$os":          "iOS",                     // Client context forwarded from frontend request headers on demand
		"$app_version": "2.5.0",
	})

	// 5.1b For MQ consumers / payment webhooks, use TrackWithOptions with a deterministic EventID and business Timestamp
	_ = sdk.TrackWithOptions(abi.TrackOptions{
		EventID:    "ord_paid_ORD-20261110-8801", // Deterministic business primary key for MQ retry idempotency
		EventName:  "OrderPaid",
		AccountID:  accountID,
		DistinctID: distinctID,                   // Include frontend visitor distinct_id to stitch full-funnel attribution (pass "" if unavailable)
		Timestamp:  time.Now().UTC(),             // Actual business occurrence time for async processing
		Properties: map[string]any{
			"#ip":      clientIP,
			"order_id": int64(9007199254740999),
			"order_no": "ORD-20261110-8801",
			"amount":   2549.15,
		},
	})

	// 5.2 Emit distinct milestone events for state transitions (Note: per D7① / G6 gate, TrackFirst/TrackUpdate/TrackOverwrite are unsupported in current version and return ErrUnsupportedMutableTrack without enqueueing)
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

	// 6. All 7 User Profile Operations (automatically isolated from static/dynamic super properties)
	// 6.1 UserSet ($user_set): Overwrite user profile properties
	_ = sdk.UserSet(accountID, distinctID, map[string]any{
		"company_name": "Acme Analytics Corp",
		"plan_tier":    "Enterprise",
		"seat_count":   50,
	})

	// 6.2 UserSetOnce ($user_set_once): Set immutable profile properties only if not previously set
	_ = sdk.UserSetOnce(accountID, distinctID, map[string]any{
		"first_utm_source": "github_release",
		"registered_at":    time.Now().UTC(),
	})

	// 6.3 UserAdd ($user_add): Atomically increment numeric profile properties (rejects non-numeric values client-side)
	_ = sdk.UserAdd(accountID, distinctID, map[string]any{
		"cumulative_payment": 2549.15,
		"order_count":        1,
	})

	// 6.4 UserAppend ($user_append): Append elements to a list profile property (without deduplication)
	_ = sdk.UserAppend(accountID, distinctID, map[string]any{
		"browsed_categories": []string{"uba", "funnel"},
	})

	// 6.5 UserUniqAppend ($user_uniq_append): Append unique elements to a list profile property
	_ = sdk.UserUniqAppend(accountID, distinctID, map[string]any{
		"certified_badges": []string{"early_adopter", "enterprise_admin"},
	})

	// 6.6 UserUnset ($user_unset): Reset specified user profile property keys
	_ = sdk.UserUnset(accountID, distinctID, "trial_flag", "legacy_coupon")

	// 6.7 UserDelete ($user_del): Delete the user's profile record
	// _ = sdk.UserDelete(accountID, distinctID)
}
```

### 4.3 Local JSONL Persistence (`LoggerConsumer`) & Synchronous Debugging (`DebugConsumer`)

```go
// LoggerConsumer: Write events as rotating JSONL files on local disk for Filebeat / Vector
// Note: Disk logging has no client TCP connection context; you MUST pass "#ip" in properties if GeoIP analysis is required
loggerConsumer, err := abi.NewLoggerConsumer(abi.LoggerConfig{
	Directory:     "/var/log/abi-events",
	FilePrefix:    "abi.log",
	RotateMode:    abi.RotateDaily, // Supports abi.RotateDaily ("DAILY") or abi.RotateHourly ("HOURLY")
	MaxFileSizeMB: 256,             // Splits into _1, _2 shards when file size exceeds 256MB
})

// DebugConsumer: Synchronously validate each event against Gateway L4 metadata rules during development
debugConsumer, err := abi.NewDebugConsumer(abi.DebugConfig{
	ServerURL:    "http://127.0.0.1:8081",
	ProjectID:    1,
	ProjectToken: "abi_tok_demo_go",
	DryRun:       true, // true validates on the gateway without writing to Kafka / StarRocks
})
```

---

## 5. Interactive CLI Demo & Verification Tests

### Run the Interactive CLI Demo ([`examples/demo`](./examples/demo/README.en.md))

```bash
cd abi.sdk/go

# Preview request JSON interactively and enter 'y' in the terminal to submit
go run ./examples/demo

# Non-interactive one-command preview and submission across all 4 scenarios
go run ./examples/demo --scenario="all" --yes
```

See [`examples/demo/README.en.md`](./examples/demo/README.en.md) for the full list of CLI flags.

### Run Unit Tests & Race Detector

The test suite covers cross-language Golden Test Vectors, large integer precision protection, concurrent race detection, and all four Consumers:

```bash
cd abi.sdk/go
go test -race -v ./...
```
