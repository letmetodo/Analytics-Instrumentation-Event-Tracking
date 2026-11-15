<?php

declare(strict_types=1);

namespace Anylink\AbiSdk;

use Closure;
use BadMethodCallException;
use DateTimeImmutable;
use DateTimeInterface;
use InvalidArgumentException;
use JsonSerializable;
use RuntimeException;
use stdClass;
use Throwable;

/**
 * ABI PHP 服务端数据采集 SDK（零第三方依赖，兼容 PHP 8.1+）。
 *
 * 设计对标数数科技 ThinkingData PHP Server SDK v3.4，并与 ABI 采集网关
 * （`POST /collect/api/v1/track/batch`）及 Flink/StarRocks 实时湖仓契约严格对齐：
 * - 完整双身份归一化：控制字符拦截、UTF-8 编码与字节上限校验（`distinct_id <= 64`、`login_id <= 128`）、Unicode 空白裁剪，至少一个非空且绝不将 `login_id` 回填至 `distinct_id`；
 * - 超 IEEE-754 双精度安全整数范围（`> 2^53 - 1`，即 `9007199254740991`）的大整数自动转为十进制字符串，防止精度丢失；
 * - `#time` / `$time` 预置时间属性自动解析为顶层毫秒级 `timestamp` 并从 `properties` 中剥离；
 * - 静态公共属性与动态公共属性回调管理（优先级：静态 < 动态 < 单次事件属性），并与 `$user_*` / `#user_*` 画像事件严格隔离；
 * - 内置四大传输通道：`StagingConsumer`（两步式请求预览与确认提交）、`BatchConsumer`（批量缓冲 + Gzip + 退避重试）、
 *   `LoggerConsumer`（按天/按小时/按文件大小轮转的本地 JSONL 落盘）、`DebugConsumer`（同步 L4 强校验与 `dry_run` 演练）。
 */
final class AbiValidator
{
    public const MAX_EVENT_ID_BYTES = 64;
    public const MAX_DISTINCT_ID_BYTES = 64;
    public const MAX_LOGIN_ID_BYTES = 128;
    public const MAX_EVENT_NAME_CHARS = 128;
    public const MAX_CUSTOM_KEY_CHARS = 64;
    public const MAX_SAFE_INTEGER = 9007199254740991; // 2^53 - 1
    public const SDK_VERSION = 'abi-php-sdk/1.0.0';

    private const IDENTIFIER_REGEX = '/\A[A-Za-z_][A-Za-z0-9_]*\z/';

    /** @var array<string, bool> 系统预置事件白名单 */
    private const SYSTEM_EVENT_WHITELIST = [
        '$signup' => true,
        '$login' => true,
        '$pageview' => true,
        '$AppStart' => true,
        '$AppEnd' => true,
        '$AppClick' => true,
        '$AppViewScreen' => true,
        '$user_set' => true,
        '#user_set' => true,
        '$user_set_once' => true,
        '#user_set_once' => true,
        '$user_add' => true,
        '#user_add' => true,
        '$user_unset' => true,
        '#user_unset' => true,
        '$user_append' => true,
        '#user_append' => true,
        '$user_uniq_append' => true,
        '#user_uniq_append' => true,
        '$user_del' => true,
        '#user_del' => true,
    ];

    /** @var array<string, bool> 系统预置属性白名单 */
    private const SYSTEM_PROPERTY_WHITELIST = [
        '$os' => true, '#os' => true, 'os' => true,
        '$os_version' => true, '#os_version' => true, 'os_version' => true,
        '$app_version' => true, '#app_version' => true, 'app_version' => true,
        '$browser' => true, '#browser' => true, 'browser' => true,
        '$browser_version' => true, '#browser_version' => true, 'browser_version' => true,
        '$city' => true, '#city' => true, 'city' => true,
        '$province' => true, '#province' => true, 'province' => true,
        '$country' => true, '#country' => true, 'country' => true,
        '$country_code' => true, '#country_code' => true, 'country_code' => true,
        '$ip' => true, '#ip' => true, 'ip' => true,
        '$network' => true, '#network' => true, 'network' => true,
        '$network_type' => true, '#network_type' => true, 'network_type' => true,
        '$platform' => true, '#platform' => true, 'platform' => true,
        '$device_id' => true, '#device_id' => true, 'device_id' => true,
        '$session_id' => true, '#session_id' => true, 'session_id' => true,
        '$screen_width' => true, '#screen_width' => true, 'screen_width' => true,
        '$screen_height' => true, '#screen_height' => true, 'screen_height' => true,
        '$model' => true, '#model' => true, 'model' => true,
        '$device_model' => true, '#device_model' => true, 'device_model' => true,
        '$manufacturer' => true, '#manufacturer' => true, 'manufacturer' => true,
        '$carrier' => true, '#carrier' => true, 'carrier' => true,
        '$url' => true, '#url' => true, 'url' => true,
        '$url_path' => true, '#url_path' => true, 'url_path' => true,
        '$referrer' => true, '#referrer' => true, 'referrer' => true,
        '$title' => true, '#title' => true, 'title' => true,
        '$duration' => true, '#duration' => true, 'duration' => true,
        '$lib' => true, '#lib' => true, 'lib' => true,
        '$lib_version' => true, '#lib_version' => true, 'lib_version' => true,
        '$zone_offset' => true, '#zone_offset' => true, 'zone_offset' => true,
        '$first_check_id' => true, '#first_check_id' => true, 'first_check_id' => true,
    ];

    /**
     * 归一化并校验身份标识（distinct_id / login_id / event_id）。
     *
     * 规则：
     * 1. 必须是合法的 UTF-8 字符串；
     * 2. 裁剪前先拦截 ASCII 控制字符（0x00–0x08、0x0E–0x1F、0x7F）；
     * 3. 裁剪首尾 Unicode 空白字符（保留字符串内部的合法 Unicode 空格，如全角空格 U+3000）；
     * 4. 裁剪后的 UTF-8 字节长度不得超过 $maxUtf8Bytes。
     */
    public static function normalizeIdentity(string $val, int $maxUtf8Bytes): string
    {
        if (!mb_check_encoding($val, 'UTF-8')) {
            throw new InvalidArgumentException('identity is not valid UTF-8');
        }

        // 在裁剪空白前拦截不可见控制字符（0x00-0x08, 0x0E-0x1F, 0x7F）
        if (preg_match('/[\x00-\x08\x0E-\x1F\x7F]/', $val) === 1) {
            throw new InvalidArgumentException('identity contains illegal ASCII control character');
        }

        // 裁剪首尾 Unicode 空白符（含 U+0085, U+00A0, U+2007, U+202F, U+3000 等）
        $trimmed = preg_replace(
            '/^[\p{Z}\p{Cc}\s\x{0085}\x{00A0}\x{2007}\x{202F}\x{3000}]+|[\p{Z}\p{Cc}\s\x{0085}\x{00A0}\x{2007}\x{202F}\x{3000}]+$/u',
            '',
            $val
        );
        if ($trimmed === null) {
            throw new InvalidArgumentException('failed to normalize identity string');
        }

        $byteLen = strlen($trimmed);
        if ($byteLen > $maxUtf8Bytes) {
            throw new InvalidArgumentException(sprintf(
                'identity exceeds max length of %d UTF-8 bytes (got %d)',
                $maxUtf8Bytes,
                $byteLen
            ));
        }

        return $trimmed;
    }

    /**
     * 校验自定义或系统预置事件名。
     */
    public static function validateEventName(string $name): string
    {
        $trimmed = trim($name);
        if ($trimmed === '') {
            throw new InvalidArgumentException('event_name must not be empty');
        }
        if (mb_strlen($trimmed, 'UTF-8') > self::MAX_EVENT_NAME_CHARS) {
            throw new InvalidArgumentException(sprintf(
                'event_name exceeds %d characters',
                self::MAX_EVENT_NAME_CHARS
            ));
        }
        if (isset(self::SYSTEM_EVENT_WHITELIST[$trimmed])) {
            return $trimmed;
        }
        if (preg_match(self::IDENTIFIER_REGEX, $trimmed) !== 1) {
            throw new InvalidArgumentException(sprintf(
                'invalid event_name "%s": must match ^[A-Za-z_][A-Za-z0-9_]*$',
                $trimmed
            ));
        }
        return $trimmed;
    }

    /**
     * 校验属性键名（支持系统预置属性白名单或最多 64 字符的自定义属性名）。
     */
    public static function validatePropertyKey(string $key): string
    {
        $trimmed = trim($key);
        if ($trimmed === '') {
            throw new InvalidArgumentException('property key must not be empty');
        }
        if (isset(self::SYSTEM_PROPERTY_WHITELIST[$trimmed])) {
            return $trimmed;
        }
        if (
            mb_strlen($trimmed, 'UTF-8') > self::MAX_CUSTOM_KEY_CHARS
            || preg_match(self::IDENTIFIER_REGEX, $trimmed) !== 1
        ) {
            throw new InvalidArgumentException(sprintf(
                'invalid property key "%s": must match ^[A-Za-z_][A-Za-z0-9_]*$ (max %d chars)',
                $trimmed,
                self::MAX_CUSTOM_KEY_CHARS
            ));
        }
        return $trimmed;
    }

    /**
     * 清洗并校验属性字典：
     * - 校验所有属性键名；
     * - 自动忽略值为 null 的键；
     * - 将绝对值超过 2^53 - 1 (9007199254740991) 的整数自动转换为十进制字符串；
     * - 将 DateTimeInterface 转为 UTC ISO-8601 字符串；
     * - 拦截 NaN / INF 非有限浮点数、嵌套关联数组及包含 null 的列表元素。
     *
     * @param array<string, mixed> $props
     * @return array<string, mixed>
     */
    public static function sanitizeProperties(array $props): array
    {
        $out = [];
        foreach ($props as $rawKey => $rawVal) {
            if (!is_string($rawKey)) {
                throw new InvalidArgumentException('property key must be a string');
            }
            $key = self::validatePropertyKey($rawKey);
            if ($rawVal === null) {
                continue;
            }
            $out[$key] = self::sanitizePropertyValue($key, $rawVal);
        }
        return $out;
    }

    /**
     * 清洗单个属性值。
     */
    public static function sanitizePropertyValue(string $key, mixed $val): mixed
    {
        if (is_bool($val) || is_string($val)) {
            return $val;
        }
        if (is_int($val)) {
            return self::normalizeSafeInt($val);
        }
        if (is_float($val)) {
            if (is_nan($val) || is_infinite($val)) {
                throw new InvalidArgumentException(sprintf('property "%s" has non-finite float value', $key));
            }
            return $val;
        }
        if ($val instanceof DateTimeInterface) {
            $utc = DateTimeImmutable::createFromInterface($val)->setTimezone(new \DateTimeZone('UTC'));
            return $utc->format('Y-m-d\TH:i:s\Z');
        }
        if (is_array($val)) {
            if (!array_is_list($val)) {
                throw new InvalidArgumentException(sprintf(
                    'property "%s" associative array / nested object is not supported',
                    $key
                ));
            }
            $list = [];
            foreach ($val as $idx => $elem) {
                if ($elem === null) {
                    throw new InvalidArgumentException(sprintf(
                        'property "%s" list contains null element at index %d',
                        $key,
                        $idx
                    ));
                }
                $list[] = self::sanitizeListElement($key, $elem);
            }
            return $list;
        }

        throw new InvalidArgumentException(sprintf(
            'property "%s" has unsupported value type %s',
            $key,
            get_debug_type($val)
        ));
    }

    /**
     * 清洗一维列表属性中的单个元素。
     */
    private static function sanitizeListElement(string $key, mixed $elem): mixed
    {
        if (is_bool($elem) || is_string($elem)) {
            return $elem;
        }
        if (is_int($elem)) {
            return self::normalizeSafeInt($elem);
        }
        if (is_float($elem)) {
            if (is_nan($elem) || is_infinite($elem)) {
                throw new InvalidArgumentException(sprintf('property "%s" list contains non-finite float', $key));
            }
            return $elem;
        }
        throw new InvalidArgumentException(sprintf(
            'property "%s" list contains unsupported element type %s',
            $key,
            get_debug_type($elem)
        ));
    }

    /**
     * 对超出 IEEE-754 双精度安全整数上限（> 2^53 - 1）的 64 位整数执行字符串保护。
     */
    public static function normalizeSafeInt(int $val): int|string
    {
        if ($val === PHP_INT_MIN || $val > self::MAX_SAFE_INTEGER || $val < -self::MAX_SAFE_INTEGER) {
            return (string) $val;
        }
        return $val;
    }

    /**
     * 生成符合 RFC 4122 规范的 UUIDv4 字符串。
     */
    public static function generateUuidV4(): string
    {
        try {
            $bytes = random_bytes(16);
        } catch (Throwable) {
            return sprintf('evt-%d-%d', (int) (microtime(true) * 1000000), mt_rand(1000, 9999));
        }
        $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
        $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
        $hex = bin2hex($bytes);
        return sprintf(
            '%s-%s-%s-%s-%s',
            substr($hex, 0, 8),
            substr($hex, 8, 4),
            substr($hex, 12, 4),
            substr($hex, 16, 4),
            substr($hex, 20, 12)
        );
    }

    /**
     * 从属性字典中检测并剥离 `#time` / `$time` 预置时间字段（不修改调用方原始数组）。
     *
     * @param array<string, mixed> $props
     * @return array{0: array<string, mixed>, 1: ?int} [剥离后的属性字典, 解析出的毫秒时间戳或 null]
     */
    public static function extractEventTimeAndStrip(array $props, ?int $explicitTimestampMs = null): array
    {
        if ($props === []) {
            return [$props, $explicitTimestampMs];
        }

        $stripped = [];
        $hasHashTime = false;
        $hashTimeVal = null;
        $hasDollarTime = false;
        $dollarTimeVal = null;

        foreach ($props as $k => $v) {
            $trimmed = is_string($k) ? trim($k) : '';
            if ($trimmed === '#time') {
                $hasHashTime = true;
                $hashTimeVal = $v;
            } elseif ($trimmed === '$time') {
                $hasDollarTime = true;
                $dollarTimeVal = $v;
            } else {
                $stripped[$k] = $v;
            }
        }

        if ($explicitTimestampMs !== null && $explicitTimestampMs > 0) {
            return [$stripped, $explicitTimestampMs];
        }

        $resolvedMs = null;
        if ($hasDollarTime) {
            $resolvedMs = self::parseEventTimeValue('$time', $dollarTimeVal);
        }
        if ($hasHashTime) {
            $resolvedMs = self::parseEventTimeValue('#time', $hashTimeVal);
        }

        return [$stripped, $resolvedMs];
    }

    /**
     * 将 `#time` / `$time` 属性值解析为 Unix 毫秒时间戳。
     */
    public static function parseEventTimeValue(string $key, mixed $raw): int
    {
        if ($raw instanceof DateTimeInterface) {
            return (int) round((float) $raw->format('U.u') * 1000);
        }
        if (is_int($raw)) {
            if ($raw <= 0) {
                throw new InvalidArgumentException(sprintf(
                    'invalid %s property: unix timestamp must be positive, got %d',
                    $key,
                    $raw
                ));
            }
            // 以 100,000,000,000 (1e11) 区分秒与毫秒
            return $raw >= 100_000_000_000 ? $raw : $raw * 1000;
        }
        if (is_float($raw)) {
            if (is_nan($raw) || is_infinite($raw) || $raw <= 0) {
                throw new InvalidArgumentException(sprintf('invalid %s property: non-positive float timestamp', $key));
            }
            return $raw >= 100_000_000_000.0 ? (int) round($raw) : (int) round($raw * 1000);
        }
        if (is_string($raw)) {
            $s = trim($raw);
            if ($s === '') {
                throw new InvalidArgumentException(sprintf('invalid %s property: time string must not be empty', $key));
            }
            // 仅接受标准日期时间格式（ISO-8601 / RFC3339 或 YYYY-MM-DD HH:MM:SS[.sss]）
            if (preg_match('/^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}/', $s) !== 1) {
                throw new InvalidArgumentException(sprintf(
                    'invalid %s property "%s": expected ISO-8601 or "YYYY-MM-DD HH:MM:SS"',
                    $key,
                    $raw
                ));
            }
            try {
                $dt = new DateTimeImmutable($s);
                return (int) round((float) $dt->format('U.u') * 1000);
            } catch (Throwable $e) {
                throw new InvalidArgumentException(sprintf(
                    'invalid %s property "%s": %s',
                    $key,
                    $raw,
                    $e->getMessage()
                ), 0, $e);
            }
        }
        throw new InvalidArgumentException(sprintf(
            'invalid %s property: unsupported value type %s',
            $key,
            get_debug_type($raw)
        ));
    }

    /**
     * 规范化网关批量接口地址。
     */
    public static function resolveBatchEndpoint(string $serverUrl): string
    {
        $trimmed = rtrim(trim($serverUrl), '/');
        if ($trimmed === '') {
            throw new InvalidArgumentException('serverUrl must not be empty');
        }
        if (str_ends_with($trimmed, '/collect/api/v1/track/batch')) {
            return $trimmed;
        }
        return $trimmed . '/collect/api/v1/track/batch';
    }
}

/**
 * 表示单条发送至 ABI 采集网关的事件传输结构（Wire Payload）。
 */
final class TrackEvent implements JsonSerializable
{
    /**
     * @param array<string, mixed> $properties
     */
    public function __construct(
        public readonly string $eventId,
        public readonly string $eventName,
        public readonly string $distinctId,
        public readonly string $loginId,
        public readonly int $timestamp,
        public readonly array $properties = [],
    ) {
    }

    /**
     * 转为符合采集网关 JSON 协议的数组表示（空 properties 编码为 stdClass 对象 `{}`）。
     *
     * @return array<string, mixed>
     */
    public function toArray(): array
    {
        $data = [
            'event_id' => $this->eventId,
            'event_name' => $this->eventName,
            'distinct_id' => $this->distinctId,
        ];
        if ($this->loginId !== '') {
            $data['login_id'] = $this->loginId;
        }
        $data['timestamp'] = $this->timestamp;
        $data['properties'] = $this->properties === [] ? new stdClass() : $this->properties;
        return $data;
    }

    public function jsonSerialize(): mixed
    {
        return $this->toArray();
    }
}

/**
 * Consumer 定义 ABI 事件的底层传输与持久化接口。
 */
interface ConsumerInterface
{
    /**
     * 接收一条已完成本地规范化校验的事件。
     */
    public function add(TrackEvent $event): void;

    /**
     * 立即将缓冲区中的事件刷盘或发送至网关。
     */
    public function flush(): void;

    /**
     * 刷盘排空所有缓冲事件并安全关闭消费者。
     */
    public function close(): void;
}

/**
 * 内部通用 HTTP 批量报文发送器（基于 PHP 标准流 / cURL，零第三方依赖）。
 */
final class HttpBatchSender
{
    /**
     * 可选的自定义 HTTP 传输处理器（用于单元测试或自定义 HTTP 客户端接入）。
     * 签名：`fn(string $endpoint, list<string> $headers, string $bodyBytes, float $timeoutSec): array{0: int, 1: string, 2: ?string}`
     *
     * @var ?Closure(string, list<string>, string, float): array{0: int, 1: string, 2: ?string}
     */
    private static ?Closure $customTransport = null;

    /**
     * 设置或清除自定义 HTTP 传输回调（传 null 恢复默认 PHP stream 传输）。
     *
     * @param ?callable(string, list<string>, string, float): array{0: int, 1: string, 2: ?string} $transport
     */
    public static function setCustomTransport(?callable $transport): void
    {
        self::$customTransport = $transport !== null ? Closure::fromCallable($transport) : null;
    }

    /**
     * 发送批量 JSON 请求至采集网关并返回解析后的响应数组。
     *
     * @param array<string, mixed> $payload
     * @return array<string, mixed>
     */
    public static function sendPayload(
        string $serverUrl,
        array $payload,
        bool $compressGzip = false,
        float $timeoutSec = 10.0,
        int $maxRetries = 0
    ): array {
        $endpoint = AbiValidator::resolveBatchEndpoint($serverUrl);
        $jsonBytes = json_encode(
            $payload,
            JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR
        );

        $bodyBytes = $jsonBytes;
        $headers = [
            'Content-Type: application/json; charset=utf-8',
            'User-Agent: ' . AbiValidator::SDK_VERSION,
        ];

        if ($compressGzip) {
            $compressed = gzencode($jsonBytes);
            if ($compressed === false) {
                throw new RuntimeException('failed to gzip batch payload');
            }
            $bodyBytes = $compressed;
            $headers[] = 'Content-Encoding: gzip';
        }

        $maxAttempts = max(1, $maxRetries + 1);
        $lastError = null;

        for ($attempt = 0; $attempt < $maxAttempts; $attempt++) {
            if ($attempt > 0) {
                $backoffMs = min(2000, 50 * (1 << ($attempt - 1)));
                usleep($backoffMs * 1000);
            }

            [$statusCode, $respBody, $transportErr] = self::$customTransport !== null
                ? (self::$customTransport)($endpoint, $headers, $bodyBytes, $timeoutSec)
                : self::executeHttpPost($endpoint, $headers, $bodyBytes, $timeoutSec);
            if ($transportErr !== null) {
                $lastError = new RuntimeException('send batch request failed: ' . $transportErr);
                continue;
            }

            if ($statusCode === 429 || $statusCode >= 500) {
                $lastError = new RuntimeException(sprintf(
                    'gateway retryable status %d: %s',
                    $statusCode,
                    $respBody
                ));
                continue;
            }

            $decoded = json_decode($respBody, true);
            if (!is_array($decoded)) {
                throw new RuntimeException(sprintf(
                    'gateway returned non-JSON response (status=%d): %s',
                    $statusCode,
                    $respBody
                ));
            }

            $code = (int) ($decoded['code'] ?? 0);
            if ($statusCode !== 200 || $code !== 200) {
                $msg = (string) ($decoded['message'] ?? 'unknown gateway error');
                throw new RuntimeException(sprintf(
                    'gateway error (status=%d, code=%d): %s',
                    $statusCode,
                    $code,
                    $msg
                ));
            }

            return $decoded;
        }

        throw $lastError ?? new RuntimeException('send batch request failed');
    }

    /**
     * @param list<string> $headers
     * @return array{0: int, 1: string, 2: ?string}
     */
    private static function executeHttpPost(string $endpoint, array $headers, string $bodyBytes, float $timeoutSec): array
    {
        $context = stream_context_create([
            'http' => [
                'method' => 'POST',
                'header' => implode("\r\n", $headers) . "\r\n",
                'content' => $bodyBytes,
                'timeout' => max(1.0, $timeoutSec),
                'ignore_errors' => true,
            ],
        ]);

        $http_response_header = [];
        $respBody = @file_get_contents($endpoint, false, $context);
        if ($respBody === false) {
            $err = error_get_last();
            return [0, '', $err['message'] ?? 'stream connection failed'];
        }

        $statusCode = 200;
        if (isset($http_response_header[0]) && preg_match('#HTTP/\S+\s+(\d{3})#', $http_response_header[0], $m) === 1) {
            $statusCode = (int) $m[1];
        }

        return [$statusCode, $respBody, null];
    }
}

/**
 * StagingConsumer 支持「第 1 步：暂存事件并预览完整请求 JSON -> 第 2 步：确认后才真正提交」的内存队列消费者。
 *
 * 在显式调用 `confirmSubmit()` 或 `submitToGateway()` 之前，`flush()` 与 `close()` 均不会触发任何网络发送。
 */
final class StagingConsumer implements ConsumerInterface
{
    /** @var list<TrackEvent> */
    private array $events = [];
    private bool $debug = false;

    public function __construct(
        private readonly int $projectId,
        private readonly string $projectToken,
        private bool $dryRun = false,
    ) {
        if ($this->projectId <= 0) {
            throw new InvalidArgumentException('projectId must be greater than 0');
        }
        if (trim($this->projectToken) === '') {
            throw new InvalidArgumentException('projectToken must not be empty');
        }
    }

    public function add(TrackEvent $event): void
    {
        $this->events[] = $event;
    }

    public function flush(): void
    {
        // 空操作：确保在显式确认提交前不会静默发送
    }

    public function close(): void
    {
        // 空操作：保留暂存事件供预览与确认提交
    }

    public function setDebug(bool $debug): void
    {
        $this->debug = $debug;
    }

    public function setDryRun(bool $dryRun): void
    {
        $this->dryRun = $dryRun;
    }

    public function reset(): void
    {
        $this->events = [];
    }

    /**
     * 返回当前已暂存的所有事件列表。
     *
     * @return list<TrackEvent>
     */
    public function getEvents(): array
    {
        return $this->events;
    }

    /**
     * 构造即将发送至 `POST /collect/api/v1/track/batch` 的完整请求体数组。
     *
     * @return array<string, mixed>
     */
    public function buildRequestPayload(): array
    {
        $payload = [
            'project_id' => $this->projectId,
            'project_token' => trim($this->projectToken),
        ];
        if ($this->debug) {
            $payload['debug'] = true;
        }
        if ($this->dryRun) {
            $payload['dry_run'] = true;
        }
        $payload['events'] = array_map(static fn(TrackEvent $e): array => $e->toArray(), $this->events);
        return $payload;
    }

    /**
     * 输出格式化缩进后的 `POST /collect/api/v1/track/batch` 完整请求 JSON 字符串（零网络副作用）。
     */
    public function previewRequestJson(): string
    {
        return json_encode(
            $this->buildRequestPayload(),
            JSON_PRETTY_PRINT | JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_PRESERVE_ZERO_FRACTION | JSON_THROW_ON_ERROR
        );
    }

    /**
     * 在确认无误后，将当前暂存的所有事件正式投递至目标 Consumer（如 BatchConsumer / LoggerConsumer / DebugConsumer）并执行 flush。
     */
    public function confirmSubmit(ConsumerInterface $target): void
    {
        if ($target === $this) {
            throw new InvalidArgumentException('target consumer must not be the same StagingConsumer');
        }
        foreach ($this->events as $event) {
            $target->add($event);
        }
        $target->flush();
    }

    /**
     * 在确认无误后，直接将暂存的请求报文发送至 ABI 采集网关并返回网关响应信封。
     *
     * @return array<string, mixed>
     */
    public function submitToGateway(
        string $serverUrl,
        bool $compressGzip = true,
        float $timeoutSec = 10.0,
        int $maxRetries = 0
    ): array {
        if ($this->events === []) {
            throw new RuntimeException('no staged events to submit');
        }
        return HttpBatchSender::sendPayload(
            $serverUrl,
            $this->buildRequestPayload(),
            $compressGzip,
            $timeoutSec,
            $maxRetries
        );
    }
}

/**
 * BatchConsumer 内存缓冲批量上报消费者（支持按批量阈值自动刷盘、Gzip 压缩与 429/5xx 指数退避重试）。
 */
final class BatchConsumer implements ConsumerInterface
{
    /** @var list<TrackEvent> */
    private array $buffer = [];
    private bool $closed = false;
    private readonly int $batchSize;
    private readonly int $maxCacheSize;
    private readonly float $timeoutSec;
    private readonly int $maxRetries;

    /**
     * @param ?Closure(Throwable, list<TrackEvent>): void $onError
     */
    public function __construct(
        private readonly string $serverUrl,
        private readonly int $projectId,
        private readonly string $projectToken,
        int $batchSize = 50,
        int $maxCacheSize = 10000,
        private readonly bool $compressGzip = true,
        float $timeoutSec = 10.0,
        int $maxRetries = 3,
        private readonly ?Closure $onError = null,
    ) {
        if (trim($this->serverUrl) === '') {
            throw new InvalidArgumentException('serverUrl is required');
        }
        if ($this->projectId <= 0 || trim($this->projectToken) === '') {
            throw new InvalidArgumentException('projectId and projectToken are required');
        }
        $this->batchSize = max(1, min(500, $batchSize));
        $this->maxCacheSize = max(1, $maxCacheSize);
        $this->timeoutSec = $timeoutSec > 0 ? $timeoutSec : 10.0;
        $this->maxRetries = max(0, $maxRetries);
    }

    public function add(TrackEvent $event): void
    {
        if ($this->closed) {
            throw new RuntimeException('batch consumer is closed');
        }
        if (count($this->buffer) >= $this->maxCacheSize) {
            throw new RuntimeException(sprintf('batch consumer buffer full (max=%d)', $this->maxCacheSize));
        }
        $this->buffer[] = $event;
        if (count($this->buffer) >= $this->batchSize) {
            $this->flush();
        }
    }

    public function flush(): void
    {
        while ($this->buffer !== []) {
            $batch = array_splice($this->buffer, 0, $this->batchSize);
            $payload = [
                'project_id' => $this->projectId,
                'project_token' => trim($this->projectToken),
                'events' => array_map(static fn(TrackEvent $e): array => $e->toArray(), $batch),
            ];
            try {
                HttpBatchSender::sendPayload(
                    $this->serverUrl,
                    $payload,
                    $this->compressGzip,
                    $this->timeoutSec,
                    $this->maxRetries
                );
            } catch (Throwable $e) {
                if ($this->onError !== null) {
                    ($this->onError)($e, $batch);
                }
                throw $e;
            }
        }
    }

    public function close(): void
    {
        if ($this->closed) {
            return;
        }
        $this->closed = true;
        $this->flush();
    }
}

/**
 * LoggerConsumer 本地磁盘 JSONL 轮转落盘消费者（配合 Filebeat / Vector / LogBus 旁路采集）。
 */
final class LoggerConsumer implements ConsumerInterface
{
    public const ROTATE_DAILY = 'DAILY';
    public const ROTATE_HOURLY = 'HOURLY';

    private string $currentPeriod = '';
    private int $currentIndex = 0;
    private int $currentBytes = 0;
    /** @var resource|null */
    private $fileHandle = null;
    private bool $closed = false;

    /**
     * @param ?Closure(): DateTimeInterface $nowFunc
     */
    public function __construct(
        private readonly string $directory,
        private readonly string $filePrefix = 'abi.log',
        private readonly string $rotateMode = self::ROTATE_DAILY,
        private readonly int $maxFileSizeMB = 0,
        private readonly ?Closure $nowFunc = null,
    ) {
        if (trim($this->directory) === '') {
            throw new InvalidArgumentException('directory is required for LoggerConsumer');
        }
        if (!is_dir($this->directory) && !mkdir($this->directory, 0755, true) && !is_dir($this->directory)) {
            throw new RuntimeException('failed to create log directory: ' . $this->directory);
        }
    }

    public function add(TrackEvent $event): void
    {
        if ($this->closed) {
            throw new RuntimeException('logger consumer is closed');
        }
        $line = json_encode($event->toArray(), JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR) . "\n";
        $this->ensureFile(strlen($line));
        $written = fwrite($this->fileHandle, $line);
        if ($written === false) {
            throw new RuntimeException('failed to write event to log file');
        }
        $this->currentBytes += $written;
    }

    public function flush(): void
    {
        if (is_resource($this->fileHandle)) {
            fflush($this->fileHandle);
        }
    }

    public function close(): void
    {
        if ($this->closed) {
            return;
        }
        $this->closed = true;
        if (is_resource($this->fileHandle)) {
            fflush($this->fileHandle);
            fclose($this->fileHandle);
            $this->fileHandle = null;
        }
    }

    private function ensureFile(int $incomingBytes): void
    {
        $now = $this->nowFunc !== null ? ($this->nowFunc)() : new DateTimeImmutable();
        $period = $this->rotateMode === self::ROTATE_HOURLY
            ? $now->format('Y-m-d-H')
            : $now->format('Y-m-d');
        $maxBytes = $this->maxFileSizeMB > 0 ? $this->maxFileSizeMB * 1024 * 1024 : 0;

        $needRotate = !is_resource($this->fileHandle)
            || $this->currentPeriod !== $period
            || ($maxBytes > 0 && ($this->currentBytes + $incomingBytes) > $maxBytes);

        if (!$needRotate) {
            return;
        }

        if (is_resource($this->fileHandle)) {
            fflush($this->fileHandle);
            fclose($this->fileHandle);
            $this->fileHandle = null;
        }

        if ($this->currentPeriod !== $period) {
            $this->currentPeriod = $period;
            $this->currentIndex = 0;
        } else {
            $this->currentIndex++;
        }

        $prefix = trim($this->filePrefix) !== '' ? trim($this->filePrefix) : 'abi.log';
        $fileName = $this->currentIndex > 0
            ? sprintf('%s.%s_%d', $prefix, $this->currentPeriod, $this->currentIndex)
            : sprintf('%s.%s', $prefix, $this->currentPeriod);
        $fullPath = rtrim($this->directory, DIRECTORY_SEPARATOR) . DIRECTORY_SEPARATOR . $fileName;

        $fh = fopen($fullPath, 'ab');
        if ($fh === false) {
            throw new RuntimeException('failed to open log file: ' . $fullPath);
        }
        clearstatcache(true, $fullPath);
        $size = filesize($fullPath);
        $this->currentBytes = $size !== false ? $size : 0;
        $this->fileHandle = $fh;
    }
}

/**
 * DebugConsumer 同步联调消费者（逐条发送并开启 `debug=true` 及可选 `dry_run=true`，遇到 L3/L4 校验错误立即抛出异常）。
 */
final class DebugConsumer implements ConsumerInterface
{
    public function __construct(
        private readonly string $serverUrl,
        private readonly int $projectId,
        private readonly string $projectToken,
        private readonly bool $dryRun = false,
        private readonly float $timeoutSec = 10.0,
    ) {
        if (trim($this->serverUrl) === '') {
            throw new InvalidArgumentException('serverUrl is required');
        }
        if ($this->projectId <= 0 || trim($this->projectToken) === '') {
            throw new InvalidArgumentException('projectId and projectToken are required');
        }
    }

    public function add(TrackEvent $event): void
    {
        $payload = [
            'project_id' => $this->projectId,
            'project_token' => trim($this->projectToken),
            'debug' => true,
            'dry_run' => $this->dryRun,
            'events' => [$event->toArray()],
        ];

        $resp = HttpBatchSender::sendPayload($this->serverUrl, $payload, false, $this->timeoutSec, 0);
        $data = is_array($resp['data'] ?? null) ? $resp['data'] : [];
        $rejected = (int) ($data['rejected'] ?? 0);
        $errors = is_array($data['errors'] ?? null) ? $data['errors'] : [];

        if ($rejected > 0 || $errors !== []) {
            $reason = isset($errors[0]['reason']) ? (string) $errors[0]['reason'] : 'rejected by gateway debug validation';
            throw new RuntimeException(sprintf(
                'debug validation failed for event "%s": %s',
                $event->eventName,
                $reason
            ));
        }
    }

    public function flush(): void
    {
        // 同步逐条发送，无需额外 flush
    }

    public function close(): void
    {
        // 无需释放额外资源
    }
}

/**
 * AbiAnalytics 是 ABI PHP 服务端 SDK 的核心入口类（API 对标数数科技 ThinkingDataAnalytics）。
 */
final class AbiAnalytics
{
    /** @var array<string, mixed> 全局静态公共属性 */
    private array $superProps = [];

    /** @var ?Closure(): array<string, mixed> 动态公共属性回调 */
    private ?Closure $dynamicSuperProps = null;

    public function __construct(
        private readonly ConsumerInterface $consumer
    ) {
    }

    /**
     * 注册全局静态公共属性；会自动合并至后续所有非 `$user_*` / `#user_*` 的行为事件中。
     * 覆盖优先级严格遵循：静态公共属性 < 动态公共属性 < 单次事件属性。
     *
     * @param array<string, mixed> $props
     */
    public function setSuperProperties(array $props): void
    {
        $clean = AbiValidator::sanitizeProperties($props);
        foreach ($clean as $k => $v) {
            $this->superProps[$k] = $v;
        }
    }

    /**
     * 根据属性键名移除单个已注册的全局静态公共属性。
     */
    public function unsetSuperProperty(string $key): void
    {
        $trimmed = trim($key);
        unset($this->superProps[$key], $this->superProps[$trimmed]);
    }

    /**
     * 清空所有已注册的全局静态公共属性。
     */
    public function clearSuperProperties(): void
    {
        $this->superProps = [];
    }

    /**
     * 获取当前已注册的全局静态公共属性副本。
     *
     * @return array<string, mixed>
     */
    public function getSuperProperties(): array
    {
        return $this->superProps;
    }

    /**
     * 注册动态公共属性回调函数（每次构造行为事件时动态调用，传入 null 可移除）。
     *
     * @param ?callable(): array<string, mixed> $callback
     */
    public function setDynamicSuperProperties(?callable $callback): void
    {
        $this->dynamicSuperProps = $callback !== null ? Closure::fromCallable($callback) : null;
    }

    /**
     * 上报一条标准用户行为事件（`$accountId` 与 `$distinctId` 至少需要提供一个非空字符串）。
     *
     * @param array<string, mixed> $properties
     */
    public function track(string $accountId, string $distinctId, string $eventName, array $properties = []): void
    {
        $this->trackWithOptions([
            'account_id' => $accountId,
            'distinct_id' => $distinctId,
            'event_name' => $eventName,
            'properties' => $properties,
        ]);
    }

    /**
     * 保留方法签名，但在当前版本显式抛出 `BadMethodCallException` 且绝不入队伪造的普通 `track` 事件（D7① / G6 门禁）。
     *
     * @deprecated [当前版本未开放 / Unsupported in current version] 严守 D7① / G6 门禁，当前版本 dwd_events 存储模型尚未开放首次去重支持；如需同日重试幂等请调用 `trackWithOptions` 传入确定性 `event_id`。
     * @param array<string, mixed> $properties
     */
    public function trackFirst(
        string $accountId,
        string $distinctId,
        string $eventName,
        string $firstCheckId,
        array $properties = []
    ): void {
        throw new BadMethodCallException(
            'trackFirst is unsupported in current version (D7① / G6 gate); use trackWithOptions with deterministic event_id for same-day idempotency'
        );
    }

    /**
     * 保留方法签名，但在当前版本显式抛出 `BadMethodCallException` 且绝不入队伪造的普通 `track` 事件（D7① / G6 门禁）。
     *
     * @deprecated [当前版本未开放 / Unsupported in current version] 严守 D7① / G6 门禁，当前版本 dwd_events 存储模型尚未开放局部更新支持。
     * @param array<string, mixed> $properties
     */
    public function trackUpdate(
        string $accountId,
        string $distinctId,
        string $eventName,
        string $eventId,
        array $properties = []
    ): void {
        throw new BadMethodCallException(
            'trackUpdate is unsupported in current version (D7① / G6 gate); use trackWithOptions with deterministic event_id for same-day idempotency'
        );
    }

    /**
     * 保留方法签名，但在当前版本显式抛出 `BadMethodCallException` 且绝不入队伪造的普通 `track` 事件（D7① / G6 门禁）。
     *
     * @deprecated [当前版本未开放 / Unsupported in current version] 严守 D7① / G6 门禁，当前版本 dwd_events 存储模型尚未开放跨分区覆盖重写支持。
     * @param array<string, mixed> $properties
     */
    public function trackOverwrite(
        string $accountId,
        string $distinctId,
        string $eventName,
        string $eventId,
        array $properties = []
    ): void {
        throw new BadMethodCallException(
            'trackOverwrite is unsupported in current version (D7① / G6 gate); use trackWithOptions with deterministic event_id for same-day idempotency'
        );
    }

    /**
     * 覆盖设置用户画像属性（`$user_set`）。
     *
     * @param array<string, mixed> $properties
     */
    public function userSet(string $accountId, string $distinctId, array $properties): void
    {
        $this->sendUserEvent($accountId, $distinctId, '$user_set', $properties);
    }

    /**
     * 仅当用户画像属性尚未设置时首次写入（`$user_set_once`），适用于注册渠道、激活时间等不可变归因字段。
     *
     * @param array<string, mixed> $properties
     */
    public function userSetOnce(string $accountId, string $distinctId, array $properties): void
    {
        $this->sendUserEvent($accountId, $distinctId, '$user_set_once', $properties);
    }

    /**
     * 对数值型用户画像属性执行原子增量累加（`$user_add`）；传入非数值属性将直接抛出异常。
     *
     * @param array<string, mixed> $properties
     */
    public function userAdd(string $accountId, string $distinctId, array $properties): void
    {
        foreach ($properties as $k => $v) {
            $trimmed = is_string($k) ? trim($k) : '';
            if ($trimmed === '#time' || $trimmed === '$time') {
                continue;
            }
            if (!is_int($v) && !is_float($v)) {
                throw new InvalidArgumentException(sprintf(
                    'userAdd property "%s" must be numeric (int or float), got %s',
                    (string) $k,
                    get_debug_type($v)
                ));
            }
        }
        $this->sendUserEvent($accountId, $distinctId, '$user_add', $properties);
    }

    /**
     * 向列表型（Array）用户画像属性末尾追加元素（`$user_append`，不去重）。
     *
     * @param array<string, mixed> $properties
     */
    public function userAppend(string $accountId, string $distinctId, array $properties): void
    {
        foreach ($properties as $k => $v) {
            $trimmed = is_string($k) ? trim($k) : '';
            if ($trimmed === '#time' || $trimmed === '$time') {
                continue;
            }
            if (!is_array($v) || !array_is_list($v)) {
                throw new InvalidArgumentException(sprintf(
                    'userAppend property "%s" must be a sequential list array',
                    (string) $k
                ));
            }
        }
        $this->sendUserEvent($accountId, $distinctId, '$user_append', $properties);
    }

    /**
     * 向列表型（Array）用户画像属性追加元素并自动集合去重（`$user_uniq_append`）。
     *
     * @param array<string, mixed> $properties
     */
    public function userUniqAppend(string $accountId, string $distinctId, array $properties): void
    {
        foreach ($properties as $k => $v) {
            $trimmed = is_string($k) ? trim($k) : '';
            if ($trimmed === '#time' || $trimmed === '$time') {
                continue;
            }
            if (!is_array($v) || !array_is_list($v)) {
                throw new InvalidArgumentException(sprintf(
                    'userUniqAppend property "%s" must be a sequential list array',
                    (string) $k
                ));
            }
        }
        $this->sendUserEvent($accountId, $distinctId, '$user_uniq_append', $properties);
    }

    /**
     * 清空并重置指定的用户画像属性键（`$user_unset`）。
     *
     * @param string|list<string> ...$keys
     */
    public function userUnset(string $accountId, string $distinctId, string|array ...$keys): void
    {
        $props = [];
        foreach ($keys as $item) {
            if (is_array($item)) {
                foreach ($item as $subKey) {
                    $props[(string) $subKey] = 0;
                }
            } else {
                $props[$item] = 0;
            }
        }
        $this->sendUserEvent($accountId, $distinctId, '$user_unset', $props);
    }

    /**
     * 删除指定用户的画像记录（`$user_del`）。
     */
    public function userDelete(string $accountId, string $distinctId): void
    {
        $this->sendUserEvent($accountId, $distinctId, '$user_del', []);
    }

    /**
     * 支持完整自定义选项的事件上报（支持指定确定性幂等 `event_id` 及毫秒 `timestamp`）。
     *
     * @param array{
     *   event_id?: string,
     *   event_name: string,
     *   account_id?: string,
     *   login_id?: string,
     *   distinct_id?: string,
     *   timestamp?: int|DateTimeInterface,
     *   properties?: array<string, mixed>
     * } $options
     */
    public function trackWithOptions(array $options): void
    {
        $event = $this->buildEvent($options, true);
        $this->consumer->add($event);
    }

    /**
     * 立即将底层 Consumer 缓冲区中的待发送事件刷盘或提交。
     */
    public function flush(): void
    {
        $this->consumer->flush();
    }

    /**
     * 刷盘排空所有缓冲事件并安全关闭底层 Consumer。
     */
    public function close(): void
    {
        $this->consumer->close();
    }

    /**
     * @param array<string, mixed> $properties
     */
    private function sendUserEvent(string $accountId, string $distinctId, string $opEventName, array $properties): void
    {
        $event = $this->buildEvent([
            'event_name' => $opEventName,
            'account_id' => $accountId,
            'distinct_id' => $distinctId,
            'properties' => $properties,
        ], false);
        $this->consumer->add($event);
    }

    /**
     * @param array<string, mixed> $options
     */
    private function buildEvent(array $options, bool $includeSuperProps): TrackEvent
    {
        $rawEventName = (string) ($options['event_name'] ?? '');
        $eventName = AbiValidator::validateEventName($rawEventName);

        $rawDistinct = (string) ($options['distinct_id'] ?? '');
        $rawAccount = (string) ($options['account_id'] ?? $options['login_id'] ?? '');

        $normDistinct = AbiValidator::normalizeIdentity($rawDistinct, AbiValidator::MAX_DISTINCT_ID_BYTES);
        $normLogin = AbiValidator::normalizeIdentity($rawAccount, AbiValidator::MAX_LOGIN_ID_BYTES);

        // 对标 ThinkingData 双 ID 契约：至少一个非空，且绝不将 login_id 回填至 distinct_id
        if ($normDistinct === '' && $normLogin === '') {
            throw new InvalidArgumentException('at least one of account_id (login_id) or distinct_id is required');
        }

        $rawEventId = (string) ($options['event_id'] ?? '');
        $eventId = '';
        if ($rawEventId !== '') {
            $eventId = AbiValidator::normalizeIdentity($rawEventId, AbiValidator::MAX_EVENT_ID_BYTES);
        }
        if ($eventId === '') {
            $eventId = AbiValidator::generateUuidV4();
        }

        $explicitTsMs = null;
        if (isset($options['timestamp'])) {
            $tsOpt = $options['timestamp'];
            if ($tsOpt instanceof DateTimeInterface) {
                $explicitTsMs = (int) round((float) $tsOpt->format('U.u') * 1000);
            } elseif (is_int($tsOpt) && $tsOpt > 0) {
                $explicitTsMs = $tsOpt >= 100_000_000_000 ? $tsOpt : $tsOpt * 1000;
            }
        }

        $rawProps = is_array($options['properties'] ?? null) ? $options['properties'] : [];
        [$propsWithoutTime, $resolvedTsMs] = AbiValidator::extractEventTimeAndStrip($rawProps, $explicitTsMs);
        $cleanProps = AbiValidator::sanitizeProperties($propsWithoutTime);

        $finalProps = [];
        $isUserEvent = str_starts_with($eventName, '$user_') || str_starts_with($eventName, '#user_');

        if ($includeSuperProps && !$isUserEvent) {
            foreach ($this->superProps as $k => $v) {
                $finalProps[$k] = $v;
            }
            if ($this->dynamicSuperProps !== null) {
                $dynRaw = ($this->dynamicSuperProps)();
                if (is_array($dynRaw)) {
                    $cleanDyn = AbiValidator::sanitizeProperties($dynRaw);
                    foreach ($cleanDyn as $k => $v) {
                        $finalProps[$k] = $v;
                    }
                }
            }
        }

        foreach ($cleanProps as $k => $v) {
            $finalProps[$k] = $v;
        }

        $timestampMs = $resolvedTsMs ?? (int) round(microtime(true) * 1000);

        return new TrackEvent(
            eventId: $eventId,
            eventName: $eventName,
            distinctId: $normDistinct,
            loginId: $normLogin,
            timestamp: $timestampMs,
            properties: $finalProps,
        );
    }
}
