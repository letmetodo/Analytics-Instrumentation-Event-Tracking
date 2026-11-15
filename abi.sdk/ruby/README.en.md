# ABI Ruby Server SDK (`abi_sdk`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`abi_sdk` is the official Ruby server-side data collection SDK for the **ABI Enterprise User Behavior Analytics (UBA) & BI Platform**, benchmarked against ThinkingData Ruby Server SDK v3.4. Built entirely on the **Ruby standard library (zero third-party gems, compatible with Ruby 2.6+ / 3.x)**, it provides full identity normalization, automatic string conversion for 64-bit integers exceeding `2^53 - 1` (`9007199254740991`), `#time` / `$time` extraction, and four pluggable consumers (`StagingConsumer`, `BatchConsumer`, `LoggerConsumer`, `DebugConsumer`).

---

## 1. Key Features & Consumer Architecture

- **Zero External Gem Dependencies (Ruby 2.6+ / 3.x)**: Uses only Ruby standard libraries (`json`, `net/http`, `zlib`, `securerandom`, `time`).
- **Dual Naming Convention (`snake_case` & `camelCase`)**: Supports both idiomatic Ruby `snake_case` (`set_super_properties`, `track`, `user_set`) and cross-language `camelCase` (`setSuperProperties`, `track`, `userSet`). (*Note: per D7① / G6 gate, `track_first`/`track_update`/`track_overwrite` are marked unsupported in current version*).
- **Strict ThinkingData-Aligned Dual-ID & Schema Normalization**: Rejects ASCII control characters (`0x00–0x08`, `0x0E–0x1F`, `0x7F`) before trimming, strips leading/trailing Unicode whitespace while preserving internal ideographic spaces (`U+3000`), and enforces UTF-8 byte limits (`distinct_id` / `event_id` ≤ 64 bytes, `login_id` ≤ 128 bytes; at least one of `distinct_id` or `login_id` must be non-empty, never copying `login_id` into `distinct_id`). Whenever any event or profile call carries both `account_id` (`login_id`) and `distinct_id`, Flink automatically links them in `identity_map`.
- **64-Bit Snowflake ID Precision Safety (`> 2^53 - 1`)**: Automatically converts integers whose absolute value exceeds `9007199254740991` (including inside 1D arrays) into decimal strings.
- **Super Properties & Dynamic Super Properties**: Supports `set_super_properties`, `unset_super_property`, `clear_super_properties`, `get_super_properties`, and `set_dynamic_super_properties` with precedence `static < dynamic < event properties`, while isolating `$user_*` / `#user_*` profile operations.
- **Four Pluggable Consumers**: `StagingConsumer` (two-step request JSON preview & confirmation), `BatchConsumer` (thread-safe buffered batch HTTP + Gzip + exponential backoff retry on `429`/`5xx`), `LoggerConsumer` (`DAILY` / `HOURLY` / `max_file_size_mb` JSONL file rotation), and `DebugConsumer` (synchronous L4 validation with `debug: true` and `dry_run: true`).

---

## 2. Server-Side Integration Guide for Rails / Rack / Sidekiq

1. **Extract Client IP from `request.remote_ip` and Pass `#ip`**: When a Puma/Unicorn server or Sidekiq worker connects to the gateway (`:8081`), the TCP socket IP is your backend data-center IP. Extract the user's real public IP via Rails `request.remote_ip` (or Rack `env['HTTP_X_FORWARDED_FOR']`) and pass it in `properties['#ip']` so Flink GeoIP resolves the user's true country, province, and city.
2. **Always Pass User Identity Per Call**: Pass `account_id` (`login_id`, ≤ 128 UTF-8 bytes) and/or the client-forwarded visitor `distinct_id` (≤ 64 UTF-8 bytes, e.g., from `request.headers['X-ABI-Distinct-Id']`) on every call (at least one must be non-empty).
3. **Pass `#time` and Deterministic `event_id` in Sidekiq / ActiveJob**: Pass the actual business occurrence time via `properties['#time']` (automatically extracted to top-level millisecond `timestamp` and stripped from `properties`) and a deterministic `event_id` (e.g. `"ord_paid_#{order.order_no}"`) via `track_with_options` so Sidekiq retries never double-count events.

```ruby
require_relative 'lib/abi_sdk'

staging = AbiSdk::StagingConsumer.new(project_id: 1, project_token: 'abi_tok_demo_ruby')
sdk = AbiSdk::AbiAnalytics.new(staging)

sdk.set_super_properties('$platform' => 'RubyServer', 'service_name' => 'order-service')

sdk.track_with_options(
  event_id: 'ord_paid_ORD-20261110-8801',
  event_name: 'OrderPaid',
  account_id: 'acct_900102',
  distinct_id: 'vis_dev_7f8e9a01',
  properties: {
    '#ip' => '203.0.113.42', # from Rails request.remote_ip
    '#time' => '2026-11-10T10:00:00Z',
    'order_id' => 9_007_199_254_740_999, # > 2^53-1 converted to "9007199254740999"
    'amount' => 2549.15
  }
)

# Step 1: Preview formatted request JSON
puts staging.preview_request_json

# Step 2: Confirm and submit to ABI Ingest Gateway
# resp = staging.submit_to_gateway(server_url: 'http://127.0.0.1:8081')
```

---

## 3. Verification & CLI Demo Commands

```bash
# Run golden test vector contract checks and unit tests
/usr/bin/ruby /Users/zhongjie/data/anylink/abi/abi.sdk/ruby/test/abi_sdk_test.rb

# Run the two-step CLI Demo (preview single request JSON -> confirm and print response JSON)
/usr/bin/ruby /Users/zhongjie/data/anylink/abi/abi.sdk/ruby/examples/demo.rb --yes
```
