<?php

declare(strict_types=1);

/**
 * ABI PHP 服务端 SDK 单元测试与跨语言黄金测试向量契约验证套件。
 */

require_once __DIR__ . '/../src/AbiAnalytics.php';
require_once __DIR__ . '/../examples/demo.php';

use Anylink\AbiSdk\AbiAnalytics;
use Anylink\AbiSdk\AbiValidator;
use Anylink\AbiSdk\BatchConsumer;
use Anylink\AbiSdk\DebugConsumer;
use Anylink\AbiSdk\HttpBatchSender;
use Anylink\AbiSdk\LoggerConsumer;
use Anylink\AbiSdk\StagingConsumer;

final class AbiPhpSdkTestRunner
{
    private int $assertions = 0;

    public function assertTrue(bool $cond, string $message): void
    {
        $this->assertions++;
        if (!$cond) {
            throw new RuntimeException('Assertion failed: ' . $message);
        }
    }

    public function assertSame(mixed $expected, mixed $actual, string $message): void
    {
        $this->assertions++;
        if ($expected !== $actual) {
            throw new RuntimeException(sprintf(
                "%s\n  expected: %s\n  actual:   %s",
                $message,
                var_export($expected, true),
                var_export($actual, true)
            ));
        }
    }

    public function assertThrows(callable $fn, string $message): void
    {
        $this->assertions++;
        try {
            $fn();
        } catch (Throwable) {
            return;
        }
        throw new RuntimeException('Expected exception was not thrown: ' . $message);
    }

    public function runAll(): void
    {
        $this->testGoldenIdentityVectors();
        $this->testGoldenEventAndPropertyVectors();
        $this->testBigIntPrecisionAndSanitization();
        $this->testTimeExtractionAndStripping();
        $this->testSuperPropertiesAndUserIsolation();
        $this->testAllTrackAndUserProfileMethods();
        $this->testBatchAndDebugConsumers();
        $this->testLoggerConsumerRotation();
        $this->testTwoStepDemoPreviewAndConfirm();

        fwrite(STDOUT, sprintf(
            "[PASS] ABI PHP SDK all tests passed (%d assertions verified).\n",
            $this->assertions
        ));
    }

    private function testGoldenIdentityVectors(): void
    {
        $path = __DIR__ . '/../../spec/test-vectors/identity_cases.json';
        $raw = file_get_contents($path);
        $this->assertTrue($raw !== false, 'load identity_cases.json');
        $spec = json_decode((string) $raw, true, 512, JSON_THROW_ON_ERROR);

        $maxDistinct = (int) $spec['max_distinct_id_bytes'];
        $maxLogin = (int) $spec['max_login_id_bytes'];

        foreach ($spec['cases'] as $case) {
            $name = (string) $case['name'];
            $valid = (bool) $case['valid'];

            if ($valid) {
                $normDistinct = AbiValidator::normalizeIdentity((string) $case['distinct_id'], $maxDistinct);
                $normLogin = AbiValidator::normalizeIdentity((string) $case['login_id'], $maxLogin);

                $this->assertSame($case['normalized_distinct_id'], $normDistinct, "identity case {$name} distinct_id");
                $this->assertSame($case['normalized_login_id'], $normLogin, "identity case {$name} login_id");
            } else {
                $this->assertThrows(static function () use ($case, $maxDistinct, $maxLogin): void {
                    $d = AbiValidator::normalizeIdentity((string) $case['distinct_id'], $maxDistinct);
                    $l = AbiValidator::normalizeIdentity((string) $case['login_id'], $maxLogin);
                    if ($d === '' && $l === '') {
                        throw new InvalidArgumentException('empty identities');
                    }
                }, "identity invalid case {$name} must be rejected");
            }
        }
    }

    private function testGoldenEventAndPropertyVectors(): void
    {
        $path = __DIR__ . '/../../spec/test-vectors/event_and_property_cases.json';
        $raw = file_get_contents($path);
        $this->assertTrue($raw !== false, 'load event_and_property_cases.json');
        $spec = json_decode((string) $raw, true, 512, JSON_THROW_ON_ERROR);

        $this->assertSame(9007199254740991, (int) $spec['max_safe_integer'], 'max_safe_integer constant');

        foreach ($spec['event_name_cases'] as $case) {
            $evtName = (string) $case['event_name'];
            $valid = (bool) $case['valid'];
            if ($valid) {
                $this->assertSame($evtName, AbiValidator::validateEventName($evtName), "valid event_name {$evtName}");
            } else {
                $this->assertThrows(
                    static fn() => AbiValidator::validateEventName($evtName),
                    "invalid event_name {$evtName}"
                );
            }
        }

        foreach ($spec['property_key_cases'] as $case) {
            $key = (string) $case['key'];
            $valid = (bool) $case['valid'];
            if ($valid) {
                $this->assertSame($key, AbiValidator::validatePropertyKey($key), "valid property key {$key}");
            } else {
                $this->assertThrows(
                    static fn() => AbiValidator::validatePropertyKey($key),
                    "invalid property key {$key}"
                );
            }
        }
    }

    private function testBigIntPrecisionAndSanitization(): void
    {
        $staging = new StagingConsumer(1, 'abi_tok_test');
        $sdk = new AbiAnalytics($staging);

        $sdk->track('u_1001', 'anon_1001', 'OrderPaid', [
            'safe_int' => 9007199254740991,
            'neg_safe_int' => -9007199254740991,
            'snowflake_id' => 9007199254740993,
            'neg_unsafe_int' => -9007199254740993,
            'min_int64' => PHP_INT_MIN,
            'id_list' => [100, 9007199254740999],
            'null_field' => null,
        ]);

        $events = $staging->getEvents();
        $this->assertSame(1, count($events), 'single tracked event');
        $props = $events[0]->properties;

        $this->assertSame(9007199254740991, $props['safe_int'], 'safe_int stays integer');
        $this->assertSame(-9007199254740991, $props['neg_safe_int'], 'neg_safe_int stays integer');
        $this->assertSame('9007199254740993', $props['snowflake_id'], '> 2^53-1 converted to string');
        $this->assertSame('-9007199254740993', $props['neg_unsafe_int'], '< -(2^53-1) converted to string');
        $this->assertSame((string) PHP_INT_MIN, $props['min_int64'], 'PHP_INT_MIN converted to string');
        $this->assertSame([100, '9007199254740999'], $props['id_list'], 'list big int converted to string');
        $this->assertTrue(!array_key_exists('null_field', $props), 'null property ignored');

        // 拦截 NaN / INF 与包含 null 的数组
        $this->assertThrows(static fn() => $sdk->track('u_1', 'a_1', 'Evt', ['bad' => NAN]), 'reject NAN');
        $this->assertThrows(static fn() => $sdk->track('u_1', 'a_1', 'Evt', ['bad' => INF]), 'reject INF');
        $this->assertThrows(static fn() => $sdk->track('u_1', 'a_1', 'Evt', ['bad' => ['ok', null]]), 'reject null in list');
        $this->assertThrows(static fn() => $sdk->track('u_1', 'a_1', 'Evt', ['bad' => ['nested' => 1]]), 'reject assoc array');
    }

    private function testTimeExtractionAndStripping(): void
    {
        $staging = new StagingConsumer(1, 'abi_tok_test');
        $sdk = new AbiAnalytics($staging);

        $sdk->track('u_1001', 'anon_1001', 'AsyncCallback', [
            '#time' => '2026-11-10T12:00:00Z',
            '$time' => '2026-11-09T12:00:00Z',
            '#ip' => '203.0.113.88',
            'amount' => 99.5,
        ]);

        $evt = $staging->getEvents()[0];
        $this->assertSame(1794312000000, $evt->timestamp, '#time overrides $time and sets top-level timestamp ms');
        $this->assertTrue(!array_key_exists('#time', $evt->properties), '#time stripped from properties');
        $this->assertTrue(!array_key_exists('$time', $evt->properties), '$time stripped from properties');
        $this->assertSame('203.0.113.88', $evt->properties['#ip'], '#ip preserved in properties for gateway GeoIP');
    }

    private function testSuperPropertiesAndUserIsolation(): void
    {
        $staging = new StagingConsumer(1, 'abi_tok_test');
        $sdk = new AbiAnalytics($staging);

        $sdk->setSuperProperties([
            '$platform' => 'PHPServer',
            'env' => 'prod',
            'override_key' => 'from_static',
            'temp_key' => 'remove_me',
        ]);
        $sdk->unsetSuperProperty('temp_key');
        $this->assertTrue(!array_key_exists('temp_key', $sdk->getSuperProperties()), 'unsetSuperProperty works');

        $sdk->setDynamicSuperProperties(static fn(): array => [
            'override_key' => 'from_dynamic',
            'dyn_only' => 'yes',
        ]);

        $sdk->track('u_1001', '', 'Purchase', [
            'override_key' => 'from_event',
        ]);
        $sdk->userSet('u_1001', '', [
            'vip_level' => 5,
        ]);

        $longLogin = str_repeat('u', 100);
        $sdk->track($longLogin, '', 'BackendWebhook', []);

        $events = $staging->getEvents();
        $trackEvt = $events[0];
        $userEvt = $events[1];
        $longEvt = $events[2];

        // 验证 distinct_id 为空时保持 ""，绝不将 login_id 回填至 distinct_id（含 65..128B 长账号）
        $this->assertSame('', $trackEvt->distinctId, 'distinct_id stays empty when omitted');
        $this->assertSame('u_1001', $trackEvt->loginId, 'login_id carries account_id');
        $this->assertSame('', $longEvt->distinctId, 'distinct_id stays empty for 100-byte login_id');
        $this->assertSame($longLogin, $longEvt->loginId, '100-byte login_id preserved');
        $this->assertSame('from_event', $trackEvt->properties['override_key'], 'event overrides dynamic and static');
        $this->assertSame('yes', $trackEvt->properties['dyn_only'], 'dynamic super property merged');
        $this->assertSame('PHPServer', $trackEvt->properties['$platform'], 'static super property merged');

        // 验证 $user_* 事件严格隔离静态与动态公共属性
        $this->assertSame(['vip_level' => 5], $userEvt->properties, '$user_set isolates super properties');

        $sdk->clearSuperProperties();
        $this->assertSame([], $sdk->getSuperProperties(), 'clearSuperProperties empties super properties');
    }

    private function testAllTrackAndUserProfileMethods(): void
    {
        $staging = new StagingConsumer(1, 'abi_tok_test', true);
        $sdk = new AbiAnalytics($staging);

        $sdk->track('acc_1', 'vis_1', '$login', ['method' => 'sso']);
        $sdk->trackWithOptions([
            'event_id' => 'evt_ord_1',
            'account_id' => 'acc_1',
            'distinct_id' => 'vis_1',
            'event_name' => 'OrderPaid',
            'properties' => ['status' => 'PAID'],
        ]);

        // D7① / G6 门禁：未开放接口必须显式抛异常且绝不入队伪造 track 事件
        $this->assertThrows(
            static fn() => $sdk->trackFirst('acc_1', 'vis_1', 'FirstActivate', 'chk_001', ['channel' => 'web']),
            'trackFirst rejects unsupported call'
        );
        $this->assertThrows(
            static fn() => $sdk->trackUpdate('acc_1', 'vis_1', 'OrderLifecycle', 'evt_ord_1', ['status' => 'PAID']),
            'trackUpdate rejects unsupported call'
        );
        $this->assertThrows(
            static fn() => $sdk->trackOverwrite('acc_1', 'vis_1', 'OrderLifecycle', 'evt_ord_1', ['status' => 'SETTLED']),
            'trackOverwrite rejects unsupported call'
        );

        $sdk->userSet('acc_1', 'vis_1', ['tier' => 'Pro']);
        $sdk->userSetOnce('acc_1', 'vis_1', ['first_channel' => 'organic']);
        $sdk->userAdd('acc_1', 'vis_1', ['points' => 10]);
        $sdk->userAppend('acc_1', 'vis_1', ['tags' => ['a', 'b']]);
        $sdk->userUniqAppend('acc_1', 'vis_1', ['tags' => ['b', 'c']]);
        $sdk->userUnset('acc_1', 'vis_1', 'temp_flag', 'old_badge');
        $sdk->userDelete('acc_1', 'vis_1');

        $events = $staging->getEvents();
        $this->assertSame(9, count($events), 'all 9 valid events recorded');
        $this->assertSame('$login', $events[0]->eventName, 'track emits $login with dual IDs');
        $this->assertSame('evt_ord_1', $events[1]->eventId, 'trackWithOptions preserves event_id');
        $this->assertSame('$user_set', $events[2]->eventName, 'userSet event_name');
        $this->assertSame('$user_set_once', $events[3]->eventName, 'userSetOnce event_name');
        $this->assertSame('$user_add', $events[4]->eventName, 'userAdd event_name');
        $this->assertSame('$user_append', $events[5]->eventName, 'userAppend event_name');
        $this->assertSame('$user_uniq_append', $events[6]->eventName, 'userUniqAppend event_name');
        $this->assertSame('$user_unset', $events[7]->eventName, 'userUnset event_name');
        $this->assertSame(['temp_flag' => 0, 'old_badge' => 0], $events[7]->properties, 'userUnset keys');
        $this->assertSame('$user_del', $events[8]->eventName, 'userDelete emits $user_del');

        // 校验 userAdd 拒绝非数值属性
        $this->assertThrows(
            static fn() => $sdk->userAdd('acc_1', 'vis_1', ['bad_str' => '100']),
            'userAdd rejects string value'
        );
    }

    private function testBatchAndDebugConsumers(): void
    {
        $attempts = 0;
        $receivedPayloads = [];

        HttpBatchSender::setCustomTransport(static function (
            string $endpoint,
            array $headers,
            string $bodyBytes,
            float $timeoutSec
        ) use (&$attempts, &$receivedPayloads): array {
            $attempts++;
            $isGzip = in_array('Content-Encoding: gzip', $headers, true);
            $rawJson = $isGzip ? (string) gzdecode($bodyBytes) : $bodyBytes;
            $decoded = json_decode($rawJson, true, 512, JSON_THROW_ON_ERROR);
            $receivedPayloads[] = $decoded;

            // 第 1 次模拟 429 限流触发指数退避重试
            if ($attempts === 1) {
                return [429, '{"code":32060,"message":"rate limit exceeded"}', null];
            }

            if (!empty($decoded['debug']) && ($decoded['events'][0]['event_name'] ?? '') === 'TriggerDebugReject') {
                return [200, json_encode([
                    'code' => 200,
                    'message' => 'success',
                    'request_id' => 'req_dbg_err',
                    'data' => [
                        'accepted' => 0,
                        'rejected' => 1,
                        'errors' => [
                            ['index' => 0, 'reason' => 'property type mismatch in L4 schema'],
                        ],
                    ],
                ]), null];
            }

            return [200, json_encode([
                'code' => 200,
                'message' => 'success',
                'request_id' => 'req_batch_ok',
                'data' => [
                    'accepted' => count($decoded['events'] ?? []),
                    'rejected' => 0,
                ],
            ]), null];
        });

        try {
            $batchConsumer = new BatchConsumer(
                serverUrl: 'http://127.0.0.1:8081',
                projectId: 1,
                projectToken: 'abi_tok_batch',
                batchSize: 2,
                compressGzip: true,
                maxRetries: 2
            );
            $sdk = new AbiAnalytics($batchConsumer);
            $sdk->track('u_1', 'anon_1', 'EventOne', ['step' => 1]);
            $sdk->track('u_1', 'anon_1', 'EventTwo', ['step' => 2]); // 达到 batchSize=2 自动触发 flush（且经过 1 次 429 重试）

            $this->assertSame(2, $attempts, 'BatchConsumer retried once after 429 and succeeded');
            $this->assertSame(
                $receivedPayloads[0]['events'][0]['event_id'],
                $receivedPayloads[1]['events'][0]['event_id'],
                'event_id preserved across 429 retry'
            );

            $debugConsumer = new DebugConsumer('http://127.0.0.1:8081', 1, 'abi_tok_dbg', true);
            $dbgSdk = new AbiAnalytics($debugConsumer);
            $dbgSdk->track('u_1', 'anon_1', 'ValidDebugEvent', ['ok' => true]);

            $this->assertThrows(
                static fn() => $dbgSdk->track('u_1', 'anon_1', 'TriggerDebugReject', ['bad' => 1]),
                'DebugConsumer throws when gateway reports rejected > 0'
            );
        } finally {
            HttpBatchSender::setCustomTransport(null);
        }
    }

    private function testLoggerConsumerRotation(): void
    {
        $tmpDir = sys_get_temp_dir() . '/abi_php_sdk_test_' . uniqid('', true);
        $logger = new LoggerConsumer(
            directory: $tmpDir,
            filePrefix: 'abi.log',
            rotateMode: LoggerConsumer::ROTATE_DAILY,
            nowFunc: static fn() => new DateTimeImmutable('2026-11-10T08:00:00Z')
        );
        $sdk = new AbiAnalytics($logger);
        $sdk->track('u_log_1', 'anon_log_1', 'ServerBooted', ['port' => 8080]);
        $sdk->close();

        $expectedFile = $tmpDir . '/abi.log.2026-11-10';
        $this->assertTrue(is_file($expectedFile), 'logger file created');
        $lines = file($expectedFile, FILE_IGNORE_NEW_LINES | FILE_SKIP_EMPTY_LINES);
        $this->assertSame(1, is_array($lines) ? count($lines) : 0, 'one JSONL line written');

        @unlink($expectedFile);
        @rmdir($tmpDir);
    }

    private function testTwoStepDemoPreviewAndConfirm(): void
    {
        [$previewJson, $staging] = buildDemoRequestPreview([
            'project_id' => 1,
            'token' => 'abi_tok_demo_php',
            'scenario' => 'all',
            'super_props' => DEFAULT_SUPER_PROPS_JSON,
            'dynamic_super' => true,
            'dry_run' => true,
        ]);

        $decodedReq = json_decode($previewJson, true, 512, JSON_THROW_ON_ERROR);
        $this->assertSame(1, $decodedReq['project_id'], 'demo preview project_id');
        $this->assertSame(true, $decodedReq['dry_run'], 'demo preview dry_run');
        $this->assertSame(14, count($decodedReq['events']), 'demo all scenario contains 14 events');

        $respJson = confirmSubmitDemo($staging, ['server_url' => '']);
        $decodedResp = json_decode($respJson, true, 512, JSON_THROW_ON_ERROR);
        $this->assertSame(200, $decodedResp['code'], 'demo response code 200');
        $this->assertSame(14, $decodedResp['data']['accepted'], 'demo response accepted 14');
    }
}

(new AbiPhpSdkTestRunner())->runAll();
