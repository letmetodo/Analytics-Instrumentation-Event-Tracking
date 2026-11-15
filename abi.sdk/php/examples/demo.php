<?php

declare(strict_types=1);

/**
 * ABI PHP 服务端 SDK 两步式交互演示程序（CLI Demo）：
 * 第 1 步：配置参数并在内存中生成唯一一份 `POST /collect/api/v1/track/batch` 请求 JSON 预览（零网络请求）；
 * 第 2 步：支持 `--yes` 自动确认或终端交互输入 `y` 确认提交，并打印单份采集网关响应 JSON。
 */

require_once __DIR__ . '/../src/AbiAnalytics.php';

use Anylink\AbiSdk\AbiAnalytics;
use Anylink\AbiSdk\StagingConsumer;

const DEFAULT_SUPER_PROPS_JSON = '{"$app_version":"2.5.0","$platform":"PHPServer","service_name":"order-service"}';

/**
 * 解析命令行参数。
 *
 * @param list<string> $argv
 * @return array{
 *   server_url: string,
 *   project_id: int,
 *   token: string,
 *   scenario: string,
 *   super_props: string,
 *   dynamic_super: bool,
 *   dry_run: bool,
 *   yes: bool
 * }
 */
function parseDemoArgs(array $argv): array
{
    $cfg = [
        'server_url' => '',
        'project_id' => 1,
        'token' => 'abi_tok_demo_php',
        'scenario' => 'order',
        'super_props' => DEFAULT_SUPER_PROPS_JSON,
        'dynamic_super' => true,
        'dry_run' => false,
        'yes' => false,
    ];

    foreach (array_slice($argv, 1) as $arg) {
        if ($arg === '--yes' || $arg === '-y') {
            $cfg['yes'] = true;
        } elseif ($arg === '--dry-run') {
            $cfg['dry_run'] = true;
        } elseif ($arg === '--no-dynamic-super') {
            $cfg['dynamic_super'] = false;
        } elseif (str_starts_with($arg, '--server-url=')) {
            $cfg['server_url'] = trim(substr($arg, strlen('--server-url=')));
        } elseif (str_starts_with($arg, '--project-id=')) {
            $cfg['project_id'] = (int) substr($arg, strlen('--project-id='));
        } elseif (str_starts_with($arg, '--token=')) {
            $cfg['token'] = trim(substr($arg, strlen('--token=')));
        } elseif (str_starts_with($arg, '--scenario=')) {
            $cfg['scenario'] = strtolower(trim(substr($arg, strlen('--scenario='))));
        } elseif (str_starts_with($arg, '--super-props=')) {
            $cfg['super_props'] = trim(substr($arg, strlen('--super-props=')));
        }
    }

    return $cfg;
}

/**
 * 第 1 步：根据演示参数构造 `StagingConsumer` 并录制对应场景的埋点事件，返回格式化请求 JSON 与暂存器。
 *
 * @param array<string, mixed> $cfg
 * @return array{0: string, 1: StagingConsumer}
 */
function buildDemoRequestPreview(array $cfg): array
{
    $projectId = (int) ($cfg['project_id'] ?? 1);
    $token = (string) ($cfg['token'] ?? 'abi_tok_demo_php');
    $dryRun = (bool) ($cfg['dry_run'] ?? false);

    $staging = new StagingConsumer($projectId, $token, $dryRun);
    $sdk = new AbiAnalytics($staging);

    $superPropsJson = trim((string) ($cfg['super_props'] ?? ''));
    if ($superPropsJson !== '' && $superPropsJson !== '{}') {
        $decoded = json_decode($superPropsJson, true, 512, JSON_THROW_ON_ERROR);
        if (is_array($decoded) && $decoded !== []) {
            $sdk->setSuperProperties($decoded);
        }
    }

    if (!empty($cfg['dynamic_super'])) {
        $sdk->setDynamicSuperProperties(static fn(): array => [
            'server_region' => 'ap-shanghai',
            'php_version' => PHP_VERSION,
        ]);
    }

    $scenario = strtolower(trim((string) ($cfg['scenario'] ?? 'order')));
    if ($scenario === '') {
        $scenario = 'order';
    }

    switch ($scenario) {
        case 'browse':
            triggerAnonymousBrowseDemo($sdk);
            break;
        case 'identity':
            triggerLoginIdentityBindDemo($sdk);
            break;
        case 'order':
            triggerOrderLifecycleDemo($sdk);
            break;
        case 'profile':
            triggerUserProfileDemo($sdk);
            break;
        case 'all':
            triggerAnonymousBrowseDemo($sdk);
            triggerLoginIdentityBindDemo($sdk);
            triggerOrderLifecycleDemo($sdk);
            triggerUserProfileDemo($sdk);
            break;
        default:
            throw new InvalidArgumentException(sprintf(
                '未知的 --scenario 参数值 "%s"（可选值：browse | identity | order | profile | all）',
                $scenario
            ));
    }

    return [$staging->previewRequestJson(), $staging];
}

function triggerAnonymousBrowseDemo(AbiAnalytics $sdk): void
{
    $visId = 'vis_dev_7f8e9a01';
    $sdk->track('', $visId, '$pageview', [
        '#ip' => '203.0.113.42',
        '$url' => 'https://store.example.com/products/bi-enterprise',
        '$url_path' => '/products/bi-enterprise',
        '$title' => 'ABI Enterprise Edition',
        '$referrer' => 'https://www.google.com',
    ]);
    $sdk->track('', $visId, 'ProductViewed', [
        '#ip' => '203.0.113.42',
        'product_id' => 'sku_abi_ent_2026',
        'product_name' => 'ABI Enterprise Analytics Suite',
        'category' => 'SaaS',
        'price' => 2999.00,
    ]);
}

function triggerLoginIdentityBindDemo(AbiAnalytics $sdk): void
{
    $accountId = 'acct_900102';
    $visId = 'vis_dev_7f8e9a01';
    $sdk->track($accountId, $visId, '$signup', [
        '#ip' => '203.0.113.42',
        'signup_channel' => 'github_oauth',
    ]);
    $sdk->track($accountId, $visId, '$login', [
        '#ip' => '203.0.113.42',
        'login_method' => 'sso_oidc',
        'mfa_verified' => true,
    ]);
}

function triggerOrderLifecycleDemo(AbiAnalytics $sdk): void
{
    $accountId = 'acct_900102';
    $visId = 'vis_dev_7f8e9a01';
    $snowflakeOrderId = 9007199254740999; // 超过 2^53 - 1 (9007199254740991)，SDK 自动序列化为十进制字符串

    $sdk->trackWithOptions([
        'event_id' => 'ord_created_20261110_8801',
        'event_name' => 'OrderCreated',
        'account_id' => $accountId,
        'distinct_id' => $visId,
        'properties' => [
            '#ip' => '203.0.113.42',
            '#time' => '2026-11-10T10:00:00Z',
            'order_no' => 'ORD-20261110-8801',
            'snowflake_id' => $snowflakeOrderId,
            'order_status' => 'CREATED',
            'payable_amount' => 2999.00,
            'item_sku_list' => ['sku_abi_ent_2026', 'sku_addon_flink'],
            'sub_task_ids' => [1001, 9007199254741024],
        ],
    ]);

    $sdk->trackWithOptions([
        'event_id' => 'ord_paid_20261110_8801',
        'event_name' => 'OrderPaid',
        'account_id' => $accountId,
        'distinct_id' => $visId,
        'properties' => [
            '#ip' => '203.0.113.42',
            'order_no' => 'ORD-20261110-8801',
            'snowflake_id' => $snowflakeOrderId,
            'order_status' => 'PAID',
            'payable_amount' => 2549.15,
            'coupon_code' => 'FIRST_ORDER_50',
            'discount_rate' => 0.85,
            'payment_channel' => 'stripe_enterprise',
        ],
    ]);

    $sdk->trackWithOptions([
        'event_id' => 'ord_fulfilled_20261110_8801',
        'event_name' => 'OrderFulfilled',
        'account_id' => $accountId,
        'distinct_id' => $visId,
        'properties' => [
            '#ip' => '203.0.113.42',
            'order_no' => 'ORD-20261110-8801',
            'snowflake_id' => $snowflakeOrderId,
            'order_status' => 'FULFILLED',
            'payable_amount' => 2549.15,
            'invoice_issued' => true,
        ],
    ]);
}

function triggerUserProfileDemo(AbiAnalytics $sdk): void
{
    $accountId = 'acct_900102';
    $visId = 'vis_dev_7f8e9a01';

    $sdk->userSet($accountId, $visId, [
        'company_name' => 'Acme Analytics Corp',
        'plan_tier' => 'Enterprise',
        'seat_count' => 50,
        '$city' => 'Shanghai',
    ]);
    $sdk->userSetOnce($accountId, $visId, [
        'first_utm_source' => 'github_release',
        'activated_at' => new DateTimeImmutable('2026-11-10T10:00:00Z'),
    ]);
    $sdk->userAdd($accountId, $visId, [
        'cumulative_payment' => 2549.15,
        'order_count' => 1,
    ]);
    $sdk->userAppend($accountId, $visId, [
        'enabled_modules' => ['event_analysis', 'funnel_analysis'],
    ]);
    $sdk->userUniqAppend($accountId, $visId, [
        'enabled_modules' => ['funnel_analysis', 'retention_analysis', 'sql_ide'],
    ]);
    $sdk->userUnset($accountId, $visId, 'legacy_trial_tag', 'onboarding_banner_dismissed');
    $sdk->userDelete('acct_gdpr_erased_01', 'vis_gdpr_erased_01');
}

/**
 * 第 2 步：确认提交后将请求发送至采集网关（未指定 `--server-url` 时自动通过内置本地网关处理并返回标准响应信封）。
 *
 * @param array<string, mixed> $cfg
 */
function confirmSubmitDemo(StagingConsumer $staging, array $cfg): string
{
    $serverUrl = trim((string) ($cfg['server_url'] ?? ''));
    if ($serverUrl !== '') {
        $resp = $staging->submitToGateway($serverUrl, true);
        return json_encode($resp, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    }

    // 未指定外部网关时，使用本地内置回执模拟采集网关响应，保证 CLI Demo 零外部依赖随时可验证
    $payload = $staging->buildRequestPayload();
    $eventsCount = is_array($payload['events'] ?? null) ? count($payload['events']) : 0;
    $envelope = [
        'code' => 200,
        'message' => 'success',
        'request_id' => 'req_mock_php_1',
        'data' => [
            'accepted' => $eventsCount,
            'rejected' => 0,
            'dry_run' => (bool) ($payload['dry_run'] ?? false),
        ],
    ];
    return json_encode($envelope, JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
}

if (realpath($_SERVER['SCRIPT_FILENAME'] ?? '') === __FILE__) {
    try {
        $cfg = parseDemoArgs($argv);
        [$previewJson, $staging] = buildDemoRequestPreview($cfg);

        fwrite(STDOUT, "=== 待提交请求 JSON 预览 (POST /collect/api/v1/track/batch) ===\n");
        fwrite(STDOUT, $previewJson . "\n");

        $isTty = function_exists('stream_isatty') && @stream_isatty(STDIN);
        if (!$cfg['yes'] && $isTty) {
            fwrite(STDOUT, "\n是否确认提交上述请求参数？输入 y 回车确认提交，其他键取消: ");
            $line = fgets(STDIN);
            if ($line === false || strtolower(trim($line)) !== 'y') {
                fwrite(STDOUT, "已取消提交，未向采集网关发送任何请求。\n");
                exit(0);
            }
        }

        $respJson = confirmSubmitDemo($staging, $cfg);
        fwrite(STDOUT, "\n=== 提交响应结果 (Response JSON) ===\n");
        fwrite(STDOUT, $respJson . "\n");
    } catch (Throwable $e) {
        fwrite(STDERR, sprintf("[错误] %s\n", $e->getMessage()));
        exit(1);
    }
}
