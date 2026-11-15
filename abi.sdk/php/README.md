# ABI PHP 服务端 SDK (`anylink/abi-php-sdk`)

**语言 / Language / 言語**: [简体中文](README.md) | [English](README.en.md) | [日本語](README.ja.md)

`abi-php-sdk` 是 **ABI 企业级用户行为分析（UBA）与 BI 平台** 的官方 PHP 服务端数据采集 SDK（API 设计对标数数科技 ThinkingData PHP Server SDK v3.4）。SDK 面向 **PHP 8.1+** 零第三方依赖构建，内置完整的身份标识与属性规范化校验、超 `2^53 - 1` 64 位大整数精度保护以及四种可插拔传输通道（Consumer）。

---

## 1. 核心特性与四大 Consumer 架构

### 核心特性
- **零第三方依赖（PHP 8.1+ 原生实现）**：直接基于 PHP 标准扩展（`json`、`mbstring`、`zlib`、标准 HTTP 流）构建，无需额外安装 Guzzle 等重型依赖即可开箱运行。
- **客户端前置强校验**：本地自动执行身份标识归一化（拦截 `0x00–0x08`、`0x0E–0x1F`、`0x7F` 控制字符，裁剪首尾 Unicode 空白符并保留内部全角空格，严格校验 UTF-8 字节上限：访客/设备 ID `distinct_id` 与 `event_id` ≤ 64 字节，实名账号 `login_id` ≤ 128 字节；至少一个非空且绝不将 `login_id` 回填至 `distinct_id`）及事件名/属性键白名单与正则校验。
- **64 位雪花 ID 精度安全（`> 2^53 - 1` 自动转十进制字符串）**：对绝对值超过 IEEE-754 双精度安全整数上限（`9007199254740991`）的 64 位整型属性值（含一维列表元素），自动序列化为十进制字符串，防止前端 JS 或跨语言 JSON 解析丢失低位精度。
- **静态与动态公共属性分层合并**：支持 `setSuperProperties`、`unsetSuperProperty`、`clearSuperProperties`、`getSuperProperties` 与 `setDynamicSuperProperties`，严格遵循 `静态公共属性 < 动态公共属性 < 单次事件属性` 覆盖优先级，并在 `$user_*` / `#user_*` 用户画像操作中自动隔离公共属性。
- **`#time` / `$time` 与 `#ip` / `$ip` 预置字段支持**：支持在 `properties` 中传入 `#time` 或 `$time`（自动解析为顶层毫秒级 `timestamp` 并从 `properties` 中剥离），以及传入客户端真实 `#ip` / `$ip` 供采集网关与 Flink ETL 解析国家/省/市地域信息。

### 四大 Consumer 架构

| Consumer 类型 | 类名 | 适用场景与核心能力 |
| :--- | :--- | :--- |
| **`StagingConsumer`** | `Anylink\AbiSdk\StagingConsumer` | **两步式预览与确认提交**：将埋点事件暂存在内存中，先通过 `previewRequestJson()` 预览即将发送至 `POST /collect/api/v1/track/batch` 的完整格式化 JSON（零网络请求），核对无误后再通过 `submitToGateway()` 或 `confirmSubmit()` 正式提交。 |
| **`BatchConsumer`** | `Anylink\AbiSdk\BatchConsumer` | **生产批量缓冲上报**：支持内存缓冲队列、按批量条数（`batchSize`，默认 50，最大 500）自动刷盘、Gzip 压缩传输，以及针对 HTTP `429` / `5xx` 的指数退避幂等重试（保留原 `event_id` 确保 StarRocks 去重）。 |
| **`LoggerConsumer`** | `Anylink\AbiSdk\LoggerConsumer` | **本地 JSONL 轮转落盘（PHP-FPM 高并发推荐）**：将事件按行序列化为 JSONL 写入本地磁盘，支持按天（`DAILY`）、按小时（`HOURLY`）及单文件体积上限（`maxFileSizeMB`）自动切分轮转，配合 Filebeat / Vector / LogBus 异步采集，完全不阻塞 PHP-FPM Worker 响应时间。 |
| **`DebugConsumer`** | `Anylink\AbiSdk\DebugConsumer` | **研发期同步 L4 强校验与 `dry_run`**：逐条同步发送事件并开启 `debug=true`（可选 `dryRun=true` 仅校验不落库），遇到 Schema 校验错误立即抛出详细异常。 |

---

## 2. 安装与快速引入

- **PHP 版本要求**：PHP `8.1` 及以上（需开启内置 `mbstring`、`json`、`zlib`）
- **直接引入单文件**：

```php
require_once __DIR__ . '/path/to/abi.sdk/php/src/AbiAnalytics.php';

use Anylink\AbiSdk\AbiAnalytics;
use Anylink\AbiSdk\StagingConsumer;
use Anylink\AbiSdk\BatchConsumer;
use Anylink\AbiSdk\LoggerConsumer;
use Anylink\AbiSdk\DebugConsumer;
```

---

## 3. Laravel / Symfony / PHP-FPM 服务端接入必读指南（`#ip` / 每次必传身份 / 异步 `#time` / 幂等 `event_id`）

### 3.1 为什么 PHP 服务端 SDK 与前端 JS / App SDK 传参职责不同？

PHP 服务端运行在后端容器或机房内（PHP-FPM / Swoole / Laravel Octane / 队列 Worker），是**无状态多用户共享环境**：
1. **每次调用必传用户身份（`accountId` / `distinctId`）**：服务端不能在单例中缓存当前登录用户，每次调用 `track*` / `user*` 必须显式传入当前请求用户的实名账号 `accountId`（线上面字段 `login_id` ≤ 128 字节）与/或前端透传的访客 `distinctId`（≤ 64 字节），至少一个非空；仅传 `accountId` 时线上面直接发送 `distinct_id: ""` 与 `login_id: "<account>"`（绝不将 `login_id` 回填至 `distinct_id`）。当任意事件或画像调用同时携带 `accountId` 与 `distinctId` 时，Flink 实时流自动完成身份关联。
2. **从 `$_SERVER['HTTP_X_FORWARDED_FOR']` 提取真实客户端 IP 传入 `#ip`**：当 PHP 服务器请求 `:8081` 采集网关时，网关 TCP 连接看到的是**后端 PHP 机房内网 IP**（使用 `LoggerConsumer` 落盘时更无连接 IP）。若不显式传 `#ip`，所有服务端埋点的国家/省份/城市都会变成机房 IP！
3. **异步队列（Laravel Queue / Symfony Messenger）必传 `#time` 与幂等 `event_id`**：异步任务消费时间晚于实际业务发生时间，且队列重试可能重放同一任务，必须显式传入实际业务发生时间 `#time` 与确定性业务主键 `event_id`（如 `"ord_paid_{$orderNo}"`）。

### 3.2 Laravel / Symfony / 原生 PHP-FPM 提取客户端 IP 与透传访客 ID 工具函数

```php
<?php

/**
 * 从 PHP-FPM ($_SERVER) 或 Laravel / Symfony Request 中提取客户端真实公网 IP。
 * 优先解析反向代理 X-Forwarded-For 的首跳公网 IP，其次取 X-Real-IP 或 REMOTE_ADDR。
 */
function resolveClientIp(array $server = []): string
{
    $srv = $server !== [] ? $server : $_SERVER;
    if (!empty($srv['HTTP_X_FORWARDED_FOR'])) {
        $parts = explode(',', (string) $srv['HTTP_X_FORWARDED_FOR']);
        $firstIp = trim($parts[0]);
        if ($firstIp !== '') {
            return $firstIp;
        }
    }
    if (!empty($srv['HTTP_X_REAL_IP'])) {
        return trim((string) $srv['HTTP_X_REAL_IP']);
    }
    return trim((string) ($srv['REMOTE_ADDR'] ?? ''));
}

/**
 * 提取前端 Web / App 通过请求头 X-ABI-Distinct-Id 透传的访客设备标识，打通前后端转化漏斗。
 */
function resolveVisitorId(array $server = []): string
{
    $srv = $server !== [] ? $server : $_SERVER;
    return trim((string) ($srv['HTTP_X_ABI_DISTINCT_ID'] ?? ''));
}
```

---

## 4. 代码示例

### 4.1 两步式预览请求 JSON 与确认提交（`StagingConsumer`）

```php
<?php

require_once __DIR__ . '/src/AbiAnalytics.php';

use Anylink\AbiSdk\AbiAnalytics;
use Anylink\AbiSdk\StagingConsumer;

// 第 1 步：创建 StagingConsumer 在内存中录制事件并预览完整请求 JSON（零网络请求）
$staging = new StagingConsumer(projectId: 1, projectToken: 'abi_tok_demo_php', dryRun: false);
$sdk = new AbiAnalytics($staging);

$sdk->setSuperProperties([
    '$platform' => 'PHPServer',
    'service_name' => 'order-service',
]);

$sdk->track('acct_900102', 'anon_dev_7f8e9a01', 'OrderPaid', [
    '#ip' => '203.0.113.42',          // 从 $_SERVER['HTTP_X_FORWARDED_FOR'] 提取的客户端真实公网 IP
    'order_id' => 9007199254740999,   // > 2^53-1 雪花 ID，SDK 自动转为字符串 "9007199254740999"
    'order_no' => 'ORD-20261110-8801',
    'amount' => 2549.15,
]);

echo "=== 待提交请求 JSON 预览 ===\n";
echo $staging->previewRequestJson() . "\n";

// 第 2 步：确认无误后提交至采集网关（或通过 $staging->confirmSubmit($batchConsumer) 投递给目标 Consumer）
$resp = $staging->submitToGateway('http://127.0.0.1:8081', compressGzip: true);
echo "=== 提交响应结果 ===\n";
echo json_encode($resp, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE) . "\n";
```

### 4.2 完整生产功能示例（公共属性、身份绑定、行为事件与 7 类用户画像操作）

```php
<?php

require_once __DIR__ . '/src/AbiAnalytics.php';

use Anylink\AbiSdk\AbiAnalytics;
use Anylink\AbiSdk\BatchConsumer;

$consumer = new BatchConsumer(
    serverUrl: 'http://127.0.0.1:8081',
    projectId: 1,
    projectToken: 'abi_tok_prod_xxx',
    batchSize: 50,
    compressGzip: true,
    maxRetries: 3
);
$sdk = new AbiAnalytics($consumer);

// 1. 静态与动态公共属性管理（自动隔离 $user_* 画像事件）
$sdk->setSuperProperties([
    '$platform' => 'PHPServer',
    'service_name' => 'checkout-api',
]);
$sdk->setDynamicSuperProperties(static fn(): array => [
    'server_region' => 'ap-shanghai',
    'php_version' => PHP_VERSION,
]);

$accountId = 'acct_900102';
$visId = resolveVisitorId($_SERVER) ?: 'vis_dev_7f8e9a01';
$clientIp = resolveClientIp($_SERVER) ?: '203.0.113.42';

// 2. 登录与行为事件：同时携带 accountId 与 distinctId 时 Flink 自动完成身份关联
$sdk->track($accountId, $visId, '$login', ['#ip' => $clientIp, 'login_method' => 'sso_oidc']);

// 3. 标准事件、首次事件、可更新与可重写事件、异步幂等事件
$sdk->track($accountId, $visId, 'OrderPaid', [
    '#ip' => $clientIp,
    '#time' => '2026-11-10T10:00:00Z', // 自动提取为顶层毫秒 timestamp 并从 properties 剥离
    'order_id' => 9007199254740999,    // > 2^53-1 大整数自动转为字符串
    'amount' => 2549.15,
]);

$sdk->trackWithOptions([
    'event_id' => 'ord_paid_ORD-20261110-8801', // 确定性业务幂等主键，防止 Laravel Queue 重试重复统计
    'event_name' => 'OrderPaid',
    'account_id' => $accountId,
    'distinct_id' => $visId,
    'properties' => [
        '#ip' => $clientIp,
        '#time' => 1794304800000,
        'order_no' => 'ORD-20261110-8801',
        'amount' => 2549.15,
    ],
]);

// 注：按 D7① / G6 门禁，trackFirst/trackUpdate/trackOverwrite 当前版本未开放（调用会抛出 BadMethodCallException 且不入队）；状态推进请上报独立里程碑事件
$sdk->trackWithOptions([
    'event_id' => 'ord_fulfilled_ORD-20261110-8801',
    'event_name' => 'OrderFulfilled',
    'account_id' => $accountId,
    'distinct_id' => $visId,
    'properties' => ['#ip' => $clientIp, 'order_status' => 'FULFILLED'],
]);

// 4. 全部 7 类用户画像操作（$user_set / $user_set_once / $user_add / $user_append / $user_uniq_append / $user_unset / $user_del）
$sdk->userSet($accountId, $visId, ['plan_tier' => 'Enterprise', 'seat_count' => 50]);
$sdk->userSetOnce($accountId, $visId, ['first_utm_source' => 'google_sem']);
$sdk->userAdd($accountId, $visId, ['cumulative_payment' => 2549.15, 'order_count' => 1]);
$sdk->userAppend($accountId, $visId, ['enabled_modules' => ['event_analysis', 'funnel_analysis']]);
$sdk->userUniqAppend($accountId, $visId, ['enabled_modules' => ['funnel_analysis', 'retention_analysis']]);
$sdk->userUnset($accountId, $visId, 'legacy_trial_tag', 'temp_flag');
// $sdk->userDelete($accountId, $visId);

// 请求结束或 Worker 退出前刷盘关闭
$sdk->close();
```

---

## 5. 验证与运行 CLI Demo

```bash
# 运行黄金测试向量契约与全量单元测试
/usr/local/bin/php /Users/zhongjie/data/anylink/abi/abi.sdk/php/tests/abi_sdk_test.php

# 运行两步式 CLI Demo（第 1 步预览请求 JSON，第 2 步自动确认并输出响应 JSON）
/usr/local/bin/php /Users/zhongjie/data/anylink/abi/abi.sdk/php/examples/demo.php --yes
```
