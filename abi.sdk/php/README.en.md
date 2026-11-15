# ABI PHP Server SDK (`anylink/abi-php-sdk`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`abi-php-sdk` is the official PHP server-side data collection SDK for the **ABI Enterprise User Behavior Analytics (UBA) & BI Platform**, benchmarked against ThinkingData PHP Server SDK v3.4. Built for **PHP 8.1+** with **zero third-party dependencies**, it provides full identity normalization, automatic string conversion for 64-bit integers exceeding `2^53 - 1` (`9007199254740991`), `#time` / `$time` extraction, and four pluggable consumers (`StagingConsumer`, `BatchConsumer`, `LoggerConsumer`, `DebugConsumer`).

---

## 1. Key Features & Consumer Architecture

- **Zero External Dependencies (PHP 8.1+)**: Uses only standard PHP extensions (`json`, `mbstring`, `zlib`, and native HTTP streams).
- **Strict Identity & Schema Normalization**: Rejects ASCII control characters (`0x00–0x08`, `0x0E–0x1F`, `0x7F`) before trimming, strips leading/trailing Unicode whitespace while preserving internal ideographic spaces (`U+3000`), enforces UTF-8 byte limits (visitor/device ID `distinct_id` and `event_id` ≤ 64 bytes, account ID `login_id` ≤ 128 bytes), requires at least one of `distinct_id` or `login_id` to be non-empty, and never copies `login_id` into `distinct_id`.
- **64-Bit Snowflake ID Precision Safety (`> 2^53 - 1`)**: Automatically converts integers whose absolute value exceeds `9007199254740991` (including inside 1D arrays) into decimal strings so downstream JSON parsers never lose low-bit precision.
- **Super Properties & Dynamic Super Properties**: Supports `setSuperProperties`, `unsetSuperProperty`, `clearSuperProperties`, `getSuperProperties`, and `setDynamicSuperProperties` with precedence `static < dynamic < event properties`, while isolating `$user_*` / `#user_*` profile operations.
- **Four Pluggable Consumers**:
  - `StagingConsumer`: Two-step workflow — preview the exact formatted `POST /collect/api/v1/track/batch` request JSON via `previewRequestJson()` before calling `submitToGateway()` or `confirmSubmit()`.
  - `BatchConsumer`: Buffered batch HTTP ingestion with Gzip compression and exponential backoff retry on HTTP `429` / `5xx` (preserving `event_id` for idempotent deduplication).
  - `LoggerConsumer`: Writes newline-delimited JSON (JSONL) to rotating local files (`DAILY` / `HOURLY` and `maxFileSizeMB`) for Filebeat / Vector / LogBus collection without blocking PHP-FPM workers.
  - `DebugConsumer`: Synchronous single-event validation with `debug: true` and optional `dry_run: true`.

---

## 2. Server-Side Integration Guide for Laravel / Symfony / PHP-FPM

Because PHP server processes are shared across all users and sit behind reverse proxies or inside background workers:

1. **Pass Real Client IP via `#ip` (`$_SERVER['HTTP_X_FORWARDED_FOR']`)**: The gateway sees the PHP server's internal IP on the TCP socket. Extract the first public IP from `$_SERVER['HTTP_X_FORWARDED_FOR']` (or `Request::ip()` in Laravel / `$request->getClientIp()` in Symfony) and pass it in `properties['#ip']` so Flink GeoIP resolves the user's true country, province, and city.
2. **Always Pass User Identity Per Call**: Pass `accountId` (wire field `login_id`) and/or the client-forwarded visitor `distinctId` (e.g., from `$_SERVER['HTTP_X_ABI_DISTINCT_ID']`) on every call. Whenever both are present on any event or profile call, Flink binds the identities automatically.
3. **Pass `#time` and Deterministic `event_id` in Async Queue Workers**: In Laravel Queue or Symfony Messenger jobs, pass the actual business occurrence time via `properties['#time']` (automatically extracted to top-level millisecond `timestamp` and stripped from `properties`) and a deterministic `event_id` (e.g. `"ord_paid_{$orderNo}"`) via `trackWithOptions` for idempotent retries.

```php
<?php

require_once __DIR__ . '/src/AbiAnalytics.php';

use Anylink\AbiSdk\AbiAnalytics;
use Anylink\AbiSdk\StagingConsumer;

function resolveClientIp(array $server): string
{
    if (!empty($server['HTTP_X_FORWARDED_FOR'])) {
        return trim(explode(',', (string) $server['HTTP_X_FORWARDED_FOR'])[0]);
    }
    return trim((string) ($server['HTTP_X_REAL_IP'] ?? $server['REMOTE_ADDR'] ?? ''));
}

$staging = new StagingConsumer(projectId: 1, projectToken: 'abi_tok_demo_php');
$sdk = new AbiAnalytics($staging);

$sdk->setSuperProperties([
    '$platform' => 'PHPServer',
    'service_name' => 'order-service',
]);

$sdk->trackWithOptions([
    'event_id' => 'ord_paid_ORD-20261110-8801',
    'event_name' => 'OrderPaid',
    'account_id' => 'acct_900102',
    'distinct_id' => $_SERVER['HTTP_X_ABI_DISTINCT_ID'] ?? 'vis_dev_7f8e9a01',
    'properties' => [
        '#ip' => resolveClientIp($_SERVER) ?: '203.0.113.42',
        '#time' => '2026-11-10T10:00:00Z',
        'order_id' => 9007199254740999, // > 2^53-1 converted to "9007199254740999"
        'amount' => 2549.15,
    ],
]);

// Step 1: Preview formatted request JSON
echo $staging->previewRequestJson() . "\n";

// Step 2: Confirm and submit to ABI Ingest Gateway
// $resp = $staging->submitToGateway('http://127.0.0.1:8081');
```

---

## 3. Verification & CLI Demo Commands

```bash
# Run golden test vector contract checks and unit tests
/usr/local/bin/php /Users/zhongjie/data/anylink/abi/abi.sdk/php/tests/abi_sdk_test.php

# Run the two-step CLI Demo (preview single request JSON -> confirm and print response JSON)
/usr/local/bin/php /Users/zhongjie/data/anylink/abi/abi.sdk/php/examples/demo.php --yes
```
