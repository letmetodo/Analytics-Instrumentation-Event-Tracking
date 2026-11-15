#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ABI 企业级用户行为分析（UBA）与 BI 平台 —— Python 3 服务端数据采集 SDK。

本模块对标数数科技（ThinkingData）Python Server SDK v3.4 规范，100% 基于 Python 3 标准库实现（零第三方依赖），
内置与 ABI 采集网关（`:8081`）及 Flink 实时 ETL 完全对齐的字段契约校验：
1. 身份标识规范化：先拦截不可见 ASCII 控制字符（`0x00-0x08`、`0x0E-0x1F`、`0x7F`），再裁剪首尾 Unicode 空白符，
   并严格执行 UTF-8 字节上限（`distinct_id <= 64`、`login_id <= 128`、`event_id <= 64`）；
   `distinct_id` 与 `login_id` 至少一个非空，且当 `distinct_id` 为空时直接保留 `""`（绝不将 `login_id` 回填至 `distinct_id`）。
2. 事件名与属性名校验：自定义标识符须匹配 `^[A-Za-z_][A-Za-z0-9_]*$`（事件名 <= 128 字符，属性名 <= 64 字符），
   并放行系统预置事件（`$signup`、`$login`、`$user_*` 等）与系统预置属性别名（`#ip`/`$ip`、`#time`/`$time`、`$os` 等）。
3. 大整数精度保护与类型安全：先区分 `bool`（Python 中 `bool` 继承自 `int`），对绝对值超过 IEEE-754 安全整数上限
   `9007199254740991`（`2^53 - 1`）的整数（含列表元素）自动序列化为十进制字符串；拦截 `NaN`、`Infinity` 以及包含
   `None` 或嵌套容器的非法列表。
4. `#time` / `$time` 自动提取：支持 `datetime`、正数秒/毫秒时间戳及 ISO-8601 字符串，自动转换为顶层毫秒级 `timestamp`
   并从 `properties` 中剥离。
5. 四大可插拔 Consumer：`StagingConsumer`（两步式请求 JSON 预览与确认提交）、`BatchConsumer`（后台线程定时/定量异步批量上报、
   Gzip 压缩、`429`/`5xx` 幂等重试）、`LoggerConsumer`（按 UTC 日期切分本地 `.jsonl` 文件）、`DebugConsumer`（同步 L4 联调校验与 `dry_run`）。
"""

from __future__ import annotations

import copy
import gzip
import json
import math
import os
import re
import threading
import time
import urllib.error
import urllib.request
import uuid
from datetime import date, datetime, timezone
from typing import Any, Callable, Dict, Iterable, List, Optional, Sequence, Tuple, Union

__all__ = [
    "MAX_EVENT_ID_BYTES",
    "MAX_DISTINCT_ID_BYTES",
    "MAX_LOGIN_ID_BYTES",
    "MAX_EVENT_NAME_CHARS",
    "MAX_CUSTOM_KEY_CHARS",
    "MAX_SAFE_INTEGER",
    "SDK_VERSION",
    "AbiValidationError",
    "AbiUnsupportedError",
    "AbiGatewayError",
    "Consumer",
    "StagingConsumer",
    "BatchConsumer",
    "LoggerConsumer",
    "DebugConsumer",
    "AbiAnalytics",
    "normalize_identity",
    "resolve_identity",
    "validate_event_name",
    "validate_property_key",
    "sanitize_properties",
    "extract_event_time_and_strip",
    "generate_uuid_v4",
]

# ============================================================================
# 协议常量与系统白名单定义
# ============================================================================

MAX_EVENT_ID_BYTES: int = 64
MAX_DISTINCT_ID_BYTES: int = 64
MAX_LOGIN_ID_BYTES: int = 128
MAX_EVENT_NAME_CHARS: int = 128
MAX_CUSTOM_KEY_CHARS: int = 64
MAX_SAFE_INTEGER: int = 9007199254740991  # IEEE-754 最大安全整数: 2^53 - 1
SDK_VERSION: str = "abi-python-sdk/1.0.0"

_IDENTIFIER_REGEX = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

SYSTEM_EVENT_WHITELIST = frozenset(
    {
        "$signup",
        "$login",
        "$pageview",
        "$AppStart",
        "$AppEnd",
        "$AppClick",
        "$AppViewScreen",
        "$user_set",
        "#user_set",
        "$user_set_once",
        "#user_set_once",
        "$user_add",
        "#user_add",
        "$user_unset",
        "#user_unset",
        "$user_append",
        "#user_append",
        "$user_uniq_append",
        "#user_uniq_append",
        "$user_del",
        "#user_del",
    }
)

_BASE_SYSTEM_PROPERTIES = (
    "os",
    "os_version",
    "app_version",
    "browser",
    "browser_version",
    "city",
    "province",
    "country",
    "country_code",
    "ip",
    "time",
    "network",
    "network_type",
    "platform",
    "device_id",
    "session_id",
    "screen_width",
    "screen_height",
    "model",
    "device_model",
    "manufacturer",
    "carrier",
    "url",
    "url_path",
    "referrer",
    "title",
    "duration",
    "lib",
    "lib_version",
    "zone_offset",
    "first_check_id",
)

SYSTEM_PROPERTY_WHITELIST = frozenset(
    alias
    for base in _BASE_SYSTEM_PROPERTIES
    for alias in (f"${base}", f"#{base}", base)
)


class AbiValidationError(ValueError):
    """客户端本地数据契约校验异常（身份标识、事件名、属性名或属性值不合法时抛出）。"""


class AbiUnsupportedError(NotImplementedError):
    """当前版本尚未开放的高级接口异常（D7① / G6 门禁）。"""


class AbiGatewayError(RuntimeError):
    """采集网关 HTTP 通信或服务端校验拒绝异常。"""

    def __init__(
        self,
        message: str,
        status_code: int = 0,
        response_data: Optional[Dict[str, Any]] = None,
    ) -> None:
        super().__init__(message)
        self.status_code = status_code
        self.response_data = response_data


# ============================================================================
# 核心校验与规范化函数
# ============================================================================


def _is_unicode_whitespace(ch: str) -> bool:
    """判断字符是否属于 Unicode 空白符（对齐 Java/Go 网关裁剪策略）。"""
    return ch.isspace() or ch in ("\u0085", "\u00a0", "\u2007", "\u202f")


def _strip_unicode_whitespace(val: str) -> str:
    """仅裁剪字符串首尾的 Unicode 空白符，保留字符串内部的空白符（如全角空格 U+3000）。"""
    start = 0
    end = len(val)
    while start < end and _is_unicode_whitespace(val[start]):
        start += 1
    while end > start and _is_unicode_whitespace(val[end - 1]):
        end -= 1
    return val[start:end]


def normalize_identity(val: Optional[str], max_utf8_bytes: int) -> str:
    """
    校验并规范化单个身份标识字段（`distinct_id` / `login_id` / `event_id`）。

    严格执行顺序：
    1. 验证字符串为合法 UTF-8；
    2. 在裁剪前拦截不可见 ASCII 控制字符（`0x00-0x08`、`0x0E-0x1F`、`0x7F`）；
    3. 裁剪首尾 Unicode 空白符（保留内部空白符）；
    4. 校验裁剪后的 UTF-8 字节长度不超过 `max_utf8_bytes`。
    """
    if val is None:
        return ""
    if not isinstance(val, str):
        raise AbiValidationError(f"identity must be a str, got {type(val).__name__}")

    try:
        val.encode("utf-8", errors="strict")
    except UnicodeEncodeError as exc:
        raise AbiValidationError("identity is not valid UTF-8") from exc

    for ch in val:
        code = ord(ch)
        if (code < 0x20 and (code < 0x09 or code > 0x0D)) or code == 0x7F:
            raise AbiValidationError(
                f"identity contains prohibited ASCII control character U+{code:04X}"
            )

    trimmed = _strip_unicode_whitespace(val)
    utf8_len = len(trimmed.encode("utf-8"))
    if utf8_len > max_utf8_bytes:
        raise AbiValidationError(
            f"identity exceeds maximum length of {max_utf8_bytes} UTF-8 bytes (got {utf8_len})"
        )
    return trimmed


def resolve_identity(
    distinct_id: Optional[str] = "",
    login_id: Optional[str] = "",
) -> Tuple[str, str]:
    """
    校验并归一化 `(distinct_id, login_id)` 双身份字段（对标 ThinkingData 服务端契约）。

    规则：
    - `distinct_id`（访客/设备 ID，<= 64 UTF-8 字节）与 `login_id`（实名账号 ID，<= 128 UTF-8 字节）至少一个非空；
    - 当 `distinct_id` 为空时直接保留 `""`，绝不将 `login_id` 回填至 `distinct_id`。
    """
    norm_distinct = normalize_identity(distinct_id, MAX_DISTINCT_ID_BYTES)
    norm_login = normalize_identity(login_id, MAX_LOGIN_ID_BYTES)

    if not norm_distinct and not norm_login:
        raise AbiValidationError(
            "at least one valid identity (distinct_id or login_id) is required"
        )

    return norm_distinct, norm_login


def validate_event_name(name: str) -> str:
    """校验自定义事件名或系统预置事件名（最长 128 字符）。"""
    if not isinstance(name, str):
        raise AbiValidationError(f"event_name must be a str, got {type(name).__name__}")
    trimmed = _strip_unicode_whitespace(name)
    if not trimmed:
        raise AbiValidationError("event_name must not be empty")
    if len(trimmed) > MAX_EVENT_NAME_CHARS:
        raise AbiValidationError(
            f"event_name exceeds {MAX_EVENT_NAME_CHARS} characters"
        )
    if trimmed in SYSTEM_EVENT_WHITELIST:
        return trimmed
    if not _IDENTIFIER_REGEX.match(trimmed):
        raise AbiValidationError(
            f"invalid event_name {trimmed!r}: must match ^[A-Za-z_][A-Za-z0-9_]*$ or be a whitelisted system event"
        )
    return trimmed


def validate_property_key(key: str) -> str:
    """校验自定义属性名（最长 64 字符）或系统预置属性名。"""
    if not isinstance(key, str):
        raise AbiValidationError(f"property key must be a str, got {type(key).__name__}")
    trimmed = _strip_unicode_whitespace(key)
    if not trimmed:
        raise AbiValidationError("property key must not be empty")
    if trimmed in SYSTEM_PROPERTY_WHITELIST:
        return trimmed
    if len(trimmed) > MAX_CUSTOM_KEY_CHARS or not _IDENTIFIER_REGEX.match(trimmed):
        raise AbiValidationError(
            f"invalid property key {trimmed!r}: must match ^[A-Za-z_][A-Za-z0-9_]*$ (max {MAX_CUSTOM_KEY_CHARS} chars)"
        )
    return trimmed


def _normalize_int(val: int) -> Union[int, str]:
    """对绝对值超过 2^53 - 1 (9007199254740991) 的大整数自动转为十进制字符串，保护精度。"""
    if abs(val) > MAX_SAFE_INTEGER:
        return str(val)
    return val


def _format_datetime(dt: Union[datetime, date]) -> str:
    """将 datetime 或 date 格式化为标准 ISO-8601 字符串。"""
    if isinstance(dt, datetime):
        if dt.tzinfo is not None:
            utc_dt = dt.astimezone(timezone.utc)
            return utc_dt.isoformat().replace("+00:00", "Z")
        return dt.isoformat()
    return dt.isoformat()


def _sanitize_list_element(key: str, index: int, elem: Any) -> Any:
    """校验并规范化一维列表中的单个标量元素（禁止 None 及嵌套列表/字典）。"""
    if elem is None:
        raise AbiValidationError(
            f"property {key!r} list contains None element at index {index}"
        )
    # 必须先判断 bool，因为在 Python 中 isinstance(True, int) 为 True
    if isinstance(elem, bool):
        return elem
    if isinstance(elem, int):
        return _normalize_int(elem)
    if isinstance(elem, float):
        if math.isnan(elem) or math.isinf(elem):
            raise AbiValidationError(
                f"property {key!r} list contains non-finite float at index {index}"
            )
        return elem
    if isinstance(elem, str):
        return elem
    if isinstance(elem, (datetime, date)):
        return _format_datetime(elem)
    raise AbiValidationError(
        f"property {key!r} list contains unsupported element type {type(elem).__name__} at index {index}"
    )


def _sanitize_property_value(key: str, val: Any) -> Any:
    """校验并规范化单个属性值。"""
    # 必须先判断 bool，因为在 Python 中 bool 是 int 的子类
    if isinstance(val, bool):
        return val
    if isinstance(val, int):
        return _normalize_int(val)
    if isinstance(val, float):
        if math.isnan(val) or math.isinf(val):
            raise AbiValidationError(f"property {key!r} has non-finite float value")
        return val
    if isinstance(val, str):
        return val
    if isinstance(val, (datetime, date)):
        return _format_datetime(val)
    if isinstance(val, (list, tuple)):
        return [
            _sanitize_list_element(key, idx, item) for idx, item in enumerate(val)
        ]
    raise AbiValidationError(
        f"property {key!r} has unsupported value type {type(val).__name__}"
    )


def sanitize_properties(
    props: Optional[Dict[str, Any]], allow_none_keys: bool = False
) -> Dict[str, Any]:
    """
    校验属性字典的所有键名并规范化属性值：
    - 拦截非法属性键名；
    - 忽略顶层值为 `None` 的属性（除非 `allow_none_keys=True`）；
    - 对绝对值超过 `9007199254740991`（`2^53 - 1`）的 `int` 自动转为十进制字符串；
    - 拦截 `NaN`、`Infinity` 以及包含 `None` 或嵌套 `list`/`dict` 的列表。
    """
    if not props:
        return {}
    if not isinstance(props, dict):
        raise AbiValidationError(
            f"properties must be a dict, got {type(props).__name__}"
        )
    cleaned: Dict[str, Any] = {}
    for raw_key, raw_val in props.items():
        key = validate_property_key(raw_key)
        if raw_val is None:
            if allow_none_keys:
                cleaned[key] = ""
            continue
        cleaned[key] = _sanitize_property_value(key, raw_val)
    return cleaned


def _parse_time_to_millis(key: str, raw: Any) -> int:
    """
    将 `#time` / `$time` 或显式 `timestamp` 解析为 Unix 毫秒时间戳：
    支持 `datetime`、正数秒/毫秒时间戳（自动按 `1e11` 区分秒与毫秒）及 ISO-8601 / RFC3339 字符串。
    """
    if isinstance(raw, bool) or raw is None:
        raise AbiValidationError(
            f"invalid {key}: unsupported time value {raw!r}"
        )
    if isinstance(raw, datetime):
        if raw.tzinfo is None:
            ts_sec = raw.replace(tzinfo=timezone.utc).timestamp()
        else:
            ts_sec = raw.timestamp()
        ms = int(round(ts_sec * 1000))
        if ms <= 0:
            raise AbiValidationError(f"invalid {key}: timestamp must be positive")
        return ms
    if isinstance(raw, (int, float)):
        if isinstance(raw, float) and (math.isnan(raw) or math.isinf(raw)):
            raise AbiValidationError(f"invalid {key}: non-finite timestamp")
        if raw <= 0:
            raise AbiValidationError(
                f"invalid {key}: unix timestamp must be positive, got {raw}"
            )
        # 以 1e11 (100,000,000,000) 区分秒与毫秒
        if raw >= 100_000_000_000:
            return int(raw)
        return int(round(raw * 1000))
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            raise AbiValidationError(f"invalid {key}: time string must not be empty")
        iso_candidate = text
        if iso_candidate.endswith(("Z", "z")):
            iso_candidate = iso_candidate[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(iso_candidate)
        except ValueError as exc:
            raise AbiValidationError(
                f"invalid {key} string {raw!r}: expected ISO-8601 / RFC3339 format"
            ) from exc
        if dt.tzinfo is None:
            ts_sec = dt.replace(tzinfo=timezone.utc).timestamp()
        else:
            ts_sec = dt.timestamp()
        ms = int(round(ts_sec * 1000))
        if ms <= 0:
            raise AbiValidationError(f"invalid {key}: timestamp must be positive")
        return ms
    raise AbiValidationError(
        f"invalid {key}: unsupported time type {type(raw).__name__}"
    )


def extract_event_time_and_strip(
    props: Optional[Dict[str, Any]],
    explicit_timestamp: Optional[Any] = None,
) -> Tuple[Dict[str, Any], int]:
    """
    检测并从 `properties` 副本中剥离 `#time` 与 `$time` 字段（不修改调用方传入的原字典），
    同时解析并返回最终的毫秒级事件时间戳 `timestamp`。

    优先级：`explicit_timestamp` > `properties["#time"]` > `properties["$time"]` > 当前系统毫秒时间。
    """
    stripped: Dict[str, Any] = {}
    has_hash_time = False
    hash_time_val: Any = None
    has_dollar_time = False
    dollar_time_val: Any = None

    if props:
        if not isinstance(props, dict):
            raise AbiValidationError(
                f"properties must be a dict, got {type(props).__name__}"
            )
        for k, v in props.items():
            if not isinstance(k, str):
                raise AbiValidationError(
                    f"property key must be a str, got {type(k).__name__}"
                )
            trimmed_key = _strip_unicode_whitespace(k)
            if trimmed_key == "#time":
                has_hash_time = True
                hash_time_val = v
            elif trimmed_key == "$time":
                has_dollar_time = True
                dollar_time_val = v
            else:
                stripped[k] = v

    # 即便显式传入了 timestamp，也对 #time / $time 做格式合法性校验或优先使用显式 timestamp
    resolved_ms: Optional[int] = None
    if has_dollar_time and dollar_time_val is not None:
        resolved_ms = _parse_time_to_millis("$time", dollar_time_val)
    if has_hash_time and hash_time_val is not None:
        resolved_ms = _parse_time_to_millis("#time", hash_time_val)
    if explicit_timestamp is not None:
        resolved_ms = _parse_time_to_millis("timestamp", explicit_timestamp)

    if resolved_ms is None:
        resolved_ms = int(time.time() * 1000)

    return stripped, resolved_ms


def generate_uuid_v4() -> str:
    """生成标准 RFC 4122 UUIDv4 字符串，用作默认事件幂等主键 `event_id`。"""
    return str(uuid.uuid4())


def _resolve_batch_endpoint(server_url: str) -> str:
    """将网关基础地址补全为完整的 `/collect/api/v1/track/batch` 端点 URL。"""
    trimmed = (server_url or "").strip().rstrip("/")
    if not trimmed:
        raise AbiValidationError("server_url must not be empty")
    if trimmed.endswith("/collect/api/v1/track/batch"):
        return trimmed
    return f"{trimmed}/collect/api/v1/track/batch"


def _send_http_batch_request(
    endpoint: str,
    payload: Dict[str, Any],
    compress_gzip: bool = False,
    timeout: float = 10.0,
    max_retries: int = 0,
) -> Dict[str, Any]:
    """
    使用 Python 标准库 `urllib.request` 发送批量 JSON 请求至 ABI 采集网关。
    支持可选 Gzip 压缩，并针对 HTTP `429` / `5xx` 或瞬态网络异常执行指数退避重试（保留原 `event_id`）。
    """
    raw_bytes = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers: Dict[str, str] = {
        "Content-Type": "application/json; charset=utf-8",
        "User-Agent": SDK_VERSION,
    }
    body_bytes = raw_bytes
    if compress_gzip:
        body_bytes = gzip.compress(raw_bytes)
        headers["Content-Encoding"] = "gzip"

    attempts = max(0, int(max_retries)) + 1
    last_error: Optional[Exception] = None

    for attempt in range(attempts):
        if attempt > 0:
            backoff = min(0.05 * (2 ** (attempt - 1)), 2.0)
            time.sleep(backoff)

        req = urllib.request.Request(
            endpoint,
            data=body_bytes,
            headers=headers,
            method="POST",
        )
        try:
            with urllib.request.urlopen(req, timeout=timeout) as resp:
                status_code = resp.getcode() or 200
                resp_body = resp.read().decode("utf-8", errors="replace")
                try:
                    envelope = json.loads(resp_body) if resp_body else {}
                except json.JSONDecodeError as exc:
                    raise AbiGatewayError(
                        f"failed to decode gateway JSON response (status={status_code}): {resp_body}",
                        status_code=status_code,
                    ) from exc

                if status_code != 200 or envelope.get("code", 200) != 200:
                    raise AbiGatewayError(
                        f"gateway rejected request (status={status_code}, code={envelope.get('code')}): {envelope.get('message', resp_body)}",
                        status_code=status_code,
                        response_data=envelope,
                    )
                return envelope

        except urllib.error.HTTPError as exc:
            status_code = exc.code
            err_body = ""
            try:
                err_body = exc.read().decode("utf-8", errors="replace")
            except Exception:
                pass
            finally:
                try:
                    exc.close()
                except Exception:
                    pass
            if status_code == 429 or status_code >= 500:
                last_error = AbiGatewayError(
                    f"gateway retryable HTTP {status_code}: {err_body}",
                    status_code=status_code,
                )
                continue
            envelope_data: Optional[Dict[str, Any]] = None
            try:
                envelope_data = json.loads(err_body) if err_body else None
            except Exception:
                envelope_data = None
            raise AbiGatewayError(
                f"gateway non-retryable HTTP {status_code}: {err_body}",
                status_code=status_code,
                response_data=envelope_data,
            ) from exc

        except (urllib.error.URLError, TimeoutError, OSError) as exc:
            last_error = AbiGatewayError(f"gateway network error: {exc}")
            continue

    assert last_error is not None
    raise last_error


# ============================================================================
# 四大 Consumer 实现
# ============================================================================


class Consumer:
    """ABI 服务端 SDK 传输消费者抽象基类。"""

    def add(self, event: Dict[str, Any]) -> None:
        """接收一条已完成校验与规范化的事件字典。"""
        raise NotImplementedError

    def flush(self) -> None:
        """立即刷盘或同步发送当前缓冲的事件。"""

    def close(self) -> None:
        """排空缓冲并释放底层资源。"""

    def __enter__(self) -> "Consumer":
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.close()


class StagingConsumer(Consumer):
    """
    内存暂存消费者（支持「第 1 步：预览唯一一份请求 JSON -> 第 2 步：确认后提交」的两步式工作流）。

    在显式调用 `confirm_submit(target_consumer)` 或 `submit_to_gateway(server_url)` 之前，
    所有通过 `AbiAnalytics` 录制的事件仅保存在内存列表中，不会触发任何网络或磁盘 I/O。
    """

    def __init__(
        self,
        project_id: int,
        project_token: str,
        dry_run: bool = False,
        debug: bool = False,
    ) -> None:
        if isinstance(project_id, bool) or not isinstance(project_id, int) or project_id <= 0:
            raise AbiValidationError("project_id must be a positive integer")
        if not isinstance(project_token, str) or not project_token.strip():
            raise AbiValidationError("project_token must be a non-empty string")
        self.project_id: int = project_id
        self.project_token: str = project_token.strip()
        self.dry_run: bool = bool(dry_run)
        self.debug: bool = bool(debug)
        self._lock = threading.RLock()
        self._events: List[Dict[str, Any]] = []

    def add(self, event: Dict[str, Any]) -> None:
        """将校验通过的事件深拷贝暂存至内存列表。"""
        with self._lock:
            self._events.append(copy.deepcopy(event))

    def flush(self) -> None:
        """空操作：确保在显式确认提交前不会静默外发请求。"""

    def close(self) -> None:
        """空操作：保留暂存数据供预览或提交。"""

    def clear(self) -> None:
        """清空当前已暂存的所有事件（修改参数重新生成预览时调用）。"""
        with self._lock:
            self._events.clear()

    def reset(self) -> None:
        """`clear()` 的别名方法，清空暂存事件。"""
        self.clear()

    def set_debug(self, debug: bool) -> None:
        """设置批量请求报文顶层的 `debug` 标志。"""
        with self._lock:
            self.debug = bool(debug)

    def set_dry_run(self, dry_run: bool) -> None:
        """设置批量请求报文顶层的 `dry_run` 标志。"""
        with self._lock:
            self.dry_run = bool(dry_run)

    @property
    def events(self) -> List[Dict[str, Any]]:
        """返回当前暂存事件列表的深拷贝快照。"""
        with self._lock:
            return copy.deepcopy(self._events)

    def build_request_payload(self) -> Dict[str, Any]:
        """构造即将发送至 `POST /collect/api/v1/track/batch` 的完整请求体字典。"""
        with self._lock:
            payload: Dict[str, Any] = {
                "project_id": self.project_id,
                "project_token": self.project_token,
                "debug": self.debug,
                "dry_run": self.dry_run,
                "events": copy.deepcopy(self._events),
            }
            return payload

    def preview_request_json(self, indent: int = 2) -> str:
        """生成格式化缩进后的 `POST /collect/api/v1/track/batch` 完整请求 JSON 字符串。"""
        payload = self.build_request_payload()
        return json.dumps(payload, indent=indent, ensure_ascii=False)

    def confirm_submit(self, target_consumer: Consumer) -> None:
        """
        确认无误后，将当前暂存的全部事件正式转交至目标 `Consumer`（如 `BatchConsumer`、
        `LoggerConsumer` 或 `DebugConsumer`）并立即触发 `flush()`。
        """
        if target_consumer is None:
            raise AbiValidationError("target_consumer must not be None")
        if target_consumer is self:
            raise AbiValidationError(
                "target_consumer must not be the same StagingConsumer instance"
            )
        staged = self.events
        for evt in staged:
            target_consumer.add(evt)
        target_consumer.flush()

    def submit_to_gateway(
        self,
        server_url: str,
        compress_gzip: bool = False,
        timeout: float = 10.0,
        max_retries: int = 3,
    ) -> Dict[str, Any]:
        """
        确认无误后，直接将暂存的请求报文发送至 ABI 采集网关 `POST /collect/api/v1/track/batch`，
        并返回网关响应 JSON 字典。
        """
        endpoint = _resolve_batch_endpoint(server_url)
        payload = self.build_request_payload()
        if not payload["events"]:
            raise AbiValidationError("no staged events to submit")
        return _send_http_batch_request(
            endpoint=endpoint,
            payload=payload,
            compress_gzip=compress_gzip,
            timeout=timeout,
            max_retries=max_retries,
        )


class BatchConsumer(Consumer):
    """
    生产级高吞吐异步批量上报消费者。

    特性：
    - 后台守护线程按批量条数（`batch_size`，默认 50，上限 500）与时间间隔（`flush_interval`，默认 3.0 秒）自动刷盘；
    - 支持 Gzip 请求体压缩（`compress_gzip=True`）；
    - 遇到 HTTP `429`（限流）或 `5xx`（服务端瞬态异常）时执行指数退避重试，且严格保留每条事件的原始 `event_id` 不变，
      配合 StarRocks 主键模型实现端到端幂等去重。
    """

    def __init__(
        self,
        server_url: str,
        project_id: int,
        project_token: str,
        batch_size: int = 50,
        flush_interval: float = 3.0,
        max_cache_size: int = 10000,
        timeout: float = 10.0,
        max_retries: int = 3,
        compress_gzip: bool = True,
        on_error: Optional[Callable[[Exception, List[Dict[str, Any]]], None]] = None,
    ) -> None:
        self.endpoint: str = _resolve_batch_endpoint(server_url)
        if isinstance(project_id, bool) or not isinstance(project_id, int) or project_id <= 0:
            raise AbiValidationError("project_id must be a positive integer")
        if not isinstance(project_token, str) or not project_token.strip():
            raise AbiValidationError("project_token must be a non-empty string")

        self.project_id: int = project_id
        self.project_token: str = project_token.strip()
        self.batch_size: int = min(max(int(batch_size), 1), 500)
        self.flush_interval: float = float(flush_interval) if flush_interval > 0 else 3.0
        self.max_cache_size: int = max(int(max_cache_size), self.batch_size)
        self.timeout: float = float(timeout) if timeout > 0 else 10.0
        self.max_retries: int = max(int(max_retries), 0)
        self.compress_gzip: bool = bool(compress_gzip)
        self.on_error = on_error

        self._lock = threading.Lock()
        self._buffer: List[Dict[str, Any]] = []
        self._closed: bool = False
        self._wake_event = threading.Event()
        self._worker = threading.Thread(
            target=self._background_loop,
            name="abi-sdk-batch-consumer",
            daemon=True,
        )
        self._worker.start()

    def add(self, event: Dict[str, Any]) -> None:
        """将事件加入内存缓冲队列；当达到 `batch_size` 时唤醒后台线程立即发送。"""
        with self._lock:
            if self._closed:
                raise AbiValidationError("BatchConsumer is already closed")
            if len(self._buffer) >= self.max_cache_size:
                raise AbiValidationError(
                    f"BatchConsumer buffer overflow (max_cache_size={self.max_cache_size})"
                )
            self._buffer.append(copy.deepcopy(event))
            should_wake = len(self._buffer) >= self.batch_size

        if should_wake:
            self._wake_event.set()

    def _background_loop(self) -> None:
        """后台定时与定量刷盘循环。"""
        while True:
            self._wake_event.wait(timeout=self.flush_interval)
            self._wake_event.clear()
            with self._lock:
                is_closed = self._closed
            try:
                self.flush()
            except Exception:
                # 后台线程捕获异常（已在 flush 中触发 on_error 回调），防止守护线程退出
                pass
            if is_closed:
                break

    def flush(self) -> None:
        """同步排空当前缓冲区中的所有事件并按批次发送至采集网关。"""
        while True:
            with self._lock:
                if not self._buffer:
                    return
                batch = self._buffer[: self.batch_size]
                self._buffer = self._buffer[self.batch_size :]

            payload = {
                "project_id": self.project_id,
                "project_token": self.project_token,
                "debug": False,
                "dry_run": False,
                "events": batch,
            }
            try:
                _send_http_batch_request(
                    endpoint=self.endpoint,
                    payload=payload,
                    compress_gzip=self.compress_gzip,
                    timeout=self.timeout,
                    max_retries=self.max_retries,
                )
            except Exception as exc:
                if self.on_error is not None:
                    self.on_error(exc, batch)
                raise

    def close(self) -> None:
        """停止后台刷新线程并将剩余缓冲事件全部刷盘发送。"""
        with self._lock:
            if self._closed:
                return
            self._closed = True
        self._wake_event.set()
        if self._worker.is_alive():
            self._worker.join(timeout=max(self.timeout * 2, 5.0))
        self.flush()


class LoggerConsumer(Consumer):
    """
    本地 JSONL 轮转落盘消费者（配合 Filebeat / Vector / LogBus 旁路采集）。

    默认按 UTC 日期（`YYYY-MM-DD`）自动切分 `.jsonl` 文件（例如 `abi.log.2026-11-10.jsonl`），
    也支持按 UTC 小时（`HOURLY`）及单文件字节上限（`max_file_size_mb`）自动分片。
    """

    ROTATE_DAILY = "DAILY"
    ROTATE_HOURLY = "HOURLY"

    def __init__(
        self,
        directory: str,
        file_prefix: str = "abi.log",
        rotate_mode: str = ROTATE_DAILY,
        max_file_size_mb: float = 0,
        now_func: Optional[Callable[[], datetime]] = None,
    ) -> None:
        if not isinstance(directory, str) or not directory.strip():
            raise AbiValidationError("directory is required for LoggerConsumer")
        self.directory: str = directory.strip()
        prefix = (file_prefix or "abi.log").strip()
        if prefix.endswith(".jsonl"):
            prefix = prefix[:-6]
        self.file_prefix: str = prefix or "abi.log"
        mode = (rotate_mode or self.ROTATE_DAILY).strip().upper()
        if mode not in (self.ROTATE_DAILY, self.ROTATE_HOURLY):
            raise AbiValidationError(
                f"invalid rotate_mode {rotate_mode!r}: expected 'DAILY' or 'HOURLY'"
            )
        self.rotate_mode: str = mode
        self.max_file_size_bytes: int = (
            int(max_file_size_mb * 1024 * 1024) if max_file_size_mb > 0 else 0
        )
        self.now_func: Callable[[], datetime] = now_func or (
            lambda: datetime.now(timezone.utc)
        )

        os.makedirs(self.directory, exist_ok=True)

        self._lock = threading.Lock()
        self._current_period: str = ""
        self._current_index: int = 0
        self._current_bytes: int = 0
        self._file: Optional[Any] = None
        self._current_file_path: str = ""
        self._closed: bool = False

    @property
    def current_file_path(self) -> str:
        """返回当前正在写入的 `.jsonl` 文件绝对或相对路径。"""
        with self._lock:
            return self._current_file_path

    def _resolve_utc_period(self) -> str:
        now = self.now_func()
        if now.tzinfo is None:
            utc_now = now.replace(tzinfo=timezone.utc)
        else:
            utc_now = now.astimezone(timezone.utc)
        if self.rotate_mode == self.ROTATE_HOURLY:
            return utc_now.strftime("%Y-%m-%d-%H")
        return utc_now.strftime("%Y-%m-%d")

    def _ensure_file_locked(self, incoming_bytes: int) -> None:
        period = self._resolve_utc_period()
        need_rotate = (
            self._file is None
            or self._current_period != period
            or (
                self.max_file_size_bytes > 0
                and self._current_bytes + incoming_bytes > self.max_file_size_bytes
            )
        )
        if not need_rotate:
            return

        if self._file is not None:
            try:
                self._file.flush()
                self._file.close()
            except Exception:
                pass
            self._file = None

        if self._current_period != period:
            self._current_period = period
            self._current_index = 0
        else:
            self._current_index += 1

        if self._current_index == 0:
            filename = f"{self.file_prefix}.{self._current_period}.jsonl"
        else:
            filename = (
                f"{self.file_prefix}.{self._current_period}_{self._current_index}.jsonl"
            )
        full_path = os.path.join(self.directory, filename)
        f = open(full_path, mode="ab")
        self._file = f
        self._current_file_path = full_path
        try:
            self._current_bytes = os.path.getsize(full_path)
        except OSError:
            self._current_bytes = 0

    def add(self, event: Dict[str, Any]) -> None:
        """将单条事件序列化为单行 UTF-8 JSON 并追加写入当前 UTC 日期的 `.jsonl` 文件。"""
        line_bytes = (json.dumps(event, ensure_ascii=False) + "\n").encode("utf-8")
        with self._lock:
            if self._closed:
                raise AbiValidationError("LoggerConsumer is already closed")
            self._ensure_file_locked(len(line_bytes))
            assert self._file is not None
            self._file.write(line_bytes)
            self._current_bytes += len(line_bytes)

    def flush(self) -> None:
        """将操作系统文件缓冲区刷盘。"""
        with self._lock:
            if self._file is not None:
                self._file.flush()

    def close(self) -> None:
        """刷盘并关闭当前打开的日志文件句柄。"""
        with self._lock:
            if self._closed:
                return
            self._closed = True
            if self._file is not None:
                try:
                    self._file.flush()
                finally:
                    self._file.close()
                    self._file = None


class DebugConsumer(Consumer):
    """
    研发联调消费者（同步逐条发送并开启网关 L4 严格 Schema 校验）。

    每次调用 `add` 时立即向采集网关发送包含 `debug: True` 与 `dry_run` 标志的请求；
    若网关报告任何校验拒绝（`data.rejected > 0` 或 `data.errors` 非空），立即抛出 `AbiGatewayError`。
    """

    def __init__(
        self,
        server_url: str,
        project_id: int,
        project_token: str,
        dry_run: bool = False,
        timeout: float = 10.0,
    ) -> None:
        self.endpoint: str = _resolve_batch_endpoint(server_url)
        if isinstance(project_id, bool) or not isinstance(project_id, int) or project_id <= 0:
            raise AbiValidationError("project_id must be a positive integer")
        if not isinstance(project_token, str) or not project_token.strip():
            raise AbiValidationError("project_token must be a non-empty string")
        self.project_id: int = project_id
        self.project_token: str = project_token.strip()
        self.dry_run: bool = bool(dry_run)
        self.timeout: float = float(timeout) if timeout > 0 else 10.0
        self.last_response: Optional[Dict[str, Any]] = None

    def add(self, event: Dict[str, Any]) -> None:
        """同步发送单条事件并校验网关 Debug 响应。"""
        payload = {
            "project_id": self.project_id,
            "project_token": self.project_token,
            "debug": True,
            "dry_run": self.dry_run,
            "events": [copy.deepcopy(event)],
        }
        envelope = _send_http_batch_request(
            endpoint=self.endpoint,
            payload=payload,
            compress_gzip=False,
            timeout=self.timeout,
            max_retries=0,
        )
        self.last_response = envelope
        data = envelope.get("data") if isinstance(envelope.get("data"), dict) else {}
        rejected = data.get("rejected", 0)
        errors = data.get("errors") or []
        if rejected > 0 or errors:
            reason = (
                errors[0].get("reason", "unknown reason")
                if errors and isinstance(errors[0], dict)
                else "event rejected in debug mode"
            )
            raise AbiGatewayError(
                f"debug validation failed for event {event.get('event_name')!r}: {reason}",
                status_code=200,
                response_data=envelope,
            )


# ============================================================================
# AbiAnalytics 核心客户端
# ============================================================================


class AbiAnalytics:
    """
    ABI Python 3 服务端数据采集核心客户端（API 对标 ThinkingData Python Server SDK v3.4）。

    线程安全，支持在多线程 Web 服务（FastAPI / Django / Flask）或异步消费者进程中作为全局单例复用。
    """

    def __init__(self, consumer: Consumer) -> None:
        if consumer is None or not isinstance(consumer, Consumer):
            raise AbiValidationError(
                "consumer must be a valid Consumer instance (StagingConsumer, BatchConsumer, LoggerConsumer, or DebugConsumer)"
            )
        self._consumer: Consumer = consumer
        self._super_lock = threading.RLock()
        self._super_properties: Dict[str, Any] = {}
        self._dynamic_super_properties_fn: Optional[Callable[[], Dict[str, Any]]] = None

    @property
    def consumer(self) -> Consumer:
        """返回底层绑定的 `Consumer` 实例。"""
        return self._consumer

    # ------------------------------------------------------------------------
    # 公共属性管理（Super Properties & Dynamic Super Properties）
    # ------------------------------------------------------------------------

    def set_super_properties(self, properties: Dict[str, Any]) -> None:
        """
        注册全局静态公共属性。

        静态公共属性会自动注入后续所有行为事件（`track*` 等），
        但**不会**注入 `$user_*` / `#user_*` 用户画像事件，防止环境字段污染用户画像宽表。
        合并优先级：`静态公共属性 < 动态公共属性 < 单次事件显式 properties`。
        """
        cleaned = sanitize_properties(properties)
        with self._super_lock:
            self._super_properties.update(cleaned)

    def unset_super_property(self, key: str) -> None:
        """根据属性名移除单个已注册的全局静态公共属性。"""
        if not isinstance(key, str):
            return
        trimmed = _strip_unicode_whitespace(key)
        with self._super_lock:
            self._super_properties.pop(key, None)
            self._super_properties.pop(trimmed, None)

    def clear_super_properties(self) -> None:
        """清空所有已注册的全局静态公共属性。"""
        with self._super_lock:
            self._super_properties.clear()

    def get_super_properties(self) -> Dict[str, Any]:
        """返回当前已注册全局静态公共属性的深拷贝副本。"""
        with self._super_lock:
            return copy.deepcopy(self._super_properties)

    def set_dynamic_super_properties(
        self, fn: Optional[Callable[[], Dict[str, Any]]]
    ) -> None:
        """
        注册动态公共属性回调函数（传入 `None` 可清除）。

        每次构造非 `$user_*` / `#user_*` 行为事件时动态调用 `fn()`，返回值会经过 `sanitize_properties` 校验，
        并按 `静态公共属性 < 动态公共属性 < 单次事件显式 properties` 的优先级合并。
        """
        if fn is not None and not callable(fn):
            raise AbiValidationError("dynamic super properties provider must be callable")
        with self._super_lock:
            self._dynamic_super_properties_fn = fn

    # ------------------------------------------------------------------------
    # 行为事件上报（携带 login_id + distinct_id 时由 Flink 自动完成身份关联）
    # ------------------------------------------------------------------------

    def track(
        self,
        account_id: str = "",
        distinct_id: str = "",
        event_name: str = "",
        properties: Optional[Dict[str, Any]] = None,
        *,
        login_id: str = "",
        event_id: str = "",
        timestamp: Optional[Any] = None,
    ) -> None:
        """
        上报一条标准用户行为事件。

        支持两种常见调用风格：
        1. 位置参数风格（对标数数 SDK）：`sdk.track(account_id, distinct_id, event_name, properties)`
        2. 关键字参数风格：`sdk.track(event_name="OrderPaid", login_id="u_1", distinct_id="vis_1", properties={...})`
        """
        evt = self._build_event(
            event_name=event_name,
            distinct_id=distinct_id,
            login_id=login_id if login_id else account_id,
            properties=properties,
            event_id=event_id,
            timestamp=timestamp,
            include_super_props=True,
        )
        self._consumer.add(evt)

    def track_first(
        self,
        account_id: str = "",
        distinct_id: str = "",
        event_name: str = "",
        first_check_id: str = "",
        properties: Optional[Dict[str, Any]] = None,
        *,
        login_id: str = "",
        event_id: str = "",
        timestamp: Optional[Any] = None,
    ) -> None:
        """
        保留方法签名，但在当前版本显式抛出 `AbiUnsupportedError`（`NotImplementedError`）且不入队任何事件（D7① / G6 门禁）。

        .. deprecated:: [当前版本未开放 / Unsupported in current version]
           严守 D7① / G6 门禁，当前 StarRocks dwd_events 存储模型尚未开放 track_first 首次去重支持；如需同日重试幂等请调用 `track(..., event_id=...)`。
        """
        raise AbiUnsupportedError(
            "track_first is unsupported in current version (D7① / G6 gate); use track(..., event_id=...) for same-day idempotency"
        )

    def track_update(
        self,
        account_id: str = "",
        distinct_id: str = "",
        event_name: str = "",
        event_id: str = "",
        properties: Optional[Dict[str, Any]] = None,
        *,
        login_id: str = "",
        timestamp: Optional[Any] = None,
    ) -> None:
        """
        保留方法签名，但在当前版本显式抛出 `AbiUnsupportedError`（`NotImplementedError`）且不入队任何事件（D7① / G6 门禁）。

        .. deprecated:: [当前版本未开放 / Unsupported in current version]
           严守 D7① / G6 门禁，当前 StarRocks dwd_events 存储模型尚未开放局部更新支持，禁止伪装普通 track 抹掉未传属性。
        """
        raise AbiUnsupportedError(
            "track_update is unsupported in current version (D7① / G6 gate); use track(..., event_id=...) for same-day idempotency"
        )

    def track_overwrite(
        self,
        account_id: str = "",
        distinct_id: str = "",
        event_name: str = "",
        event_id: str = "",
        properties: Optional[Dict[str, Any]] = None,
        *,
        login_id: str = "",
        timestamp: Optional[Any] = None,
    ) -> None:
        """
        保留方法签名，但在当前版本显式抛出 `AbiUnsupportedError`（`NotImplementedError`）且不入队任何事件（D7① / G6 门禁）。

        .. deprecated:: [当前版本未开放 / Unsupported in current version]
           严守 D7① / G6 门禁，当前 StarRocks dwd_events 存储模型尚未开放跨分区整行覆盖重写支持。
        """
        raise AbiUnsupportedError(
            "track_overwrite is unsupported in current version (D7① / G6 gate); use track(..., event_id=...) for same-day idempotency"
        )

    # ------------------------------------------------------------------------
    # 7 类用户画像方法（自动隔离静态与动态公共属性）
    # ------------------------------------------------------------------------

    def user_set(
        self,
        account_id: str = "",
        distinct_id: str = "",
        properties: Optional[Dict[str, Any]] = None,
        *,
        login_id: str = "",
        event_id: str = "",
        timestamp: Optional[Any] = None,
    ) -> None:
        """覆盖设置用户画像属性（`$user_set`）：存在则覆盖，不存在则新增。"""
        if not properties:
            raise AbiValidationError("properties must not be empty for user_set")
        self._send_user_event(
            op_name="$user_set",
            account_id=account_id,
            distinct_id=distinct_id,
            login_id=login_id,
            properties=properties,
            event_id=event_id,
            timestamp=timestamp,
        )

    def user_set_once(
        self,
        account_id: str = "",
        distinct_id: str = "",
        properties: Optional[Dict[str, Any]] = None,
        *,
        login_id: str = "",
        event_id: str = "",
        timestamp: Optional[Any] = None,
    ) -> None:
        """仅当用户画像属性尚未设置时首次写入（`$user_set_once`），适用于首次渠道、注册时间等归因字段。"""
        if not properties:
            raise AbiValidationError("properties must not be empty for user_set_once")
        self._send_user_event(
            op_name="$user_set_once",
            account_id=account_id,
            distinct_id=distinct_id,
            login_id=login_id,
            properties=properties,
            event_id=event_id,
            timestamp=timestamp,
        )

    def user_add(
        self,
        account_id: str = "",
        distinct_id: str = "",
        properties: Optional[Dict[str, Any]] = None,
        *,
        login_id: str = "",
        event_id: str = "",
        timestamp: Optional[Any] = None,
    ) -> None:
        """对数值型用户画像属性执行原子累加/扣减（`$user_add`）；传入非数值属性（含 `bool`）将报错。"""
        if not properties or not isinstance(properties, dict):
            raise AbiValidationError("properties must be a non-empty dict for user_add")
        for k, v in properties.items():
            trimmed_k = _strip_unicode_whitespace(k) if isinstance(k, str) else ""
            if trimmed_k in ("#time", "$time"):
                continue
            if isinstance(v, bool) or not isinstance(v, (int, float)):
                raise AbiValidationError(
                    f"user_add property {k!r} must be numeric (int or float), got {type(v).__name__}"
                )
        self._send_user_event(
            op_name="$user_add",
            account_id=account_id,
            distinct_id=distinct_id,
            login_id=login_id,
            properties=properties,
            event_id=event_id,
            timestamp=timestamp,
        )

    def user_append(
        self,
        account_id: str = "",
        distinct_id: str = "",
        properties: Optional[Dict[str, Any]] = None,
        *,
        login_id: str = "",
        event_id: str = "",
        timestamp: Optional[Any] = None,
    ) -> None:
        """向列表型用户画像属性末尾追加元素（`$user_append`，保留重复项）。"""
        if not properties or not isinstance(properties, dict):
            raise AbiValidationError(
                "properties must be a non-empty dict for user_append"
            )
        for k, v in properties.items():
            trimmed_k = _strip_unicode_whitespace(k) if isinstance(k, str) else ""
            if trimmed_k in ("#time", "$time"):
                continue
            if not isinstance(v, (list, tuple)):
                raise AbiValidationError(
                    f"user_append property {k!r} must be a list or tuple, got {type(v).__name__}"
                )
        self._send_user_event(
            op_name="$user_append",
            account_id=account_id,
            distinct_id=distinct_id,
            login_id=login_id,
            properties=properties,
            event_id=event_id,
            timestamp=timestamp,
        )

    def user_uniq_append(
        self,
        account_id: str = "",
        distinct_id: str = "",
        properties: Optional[Dict[str, Any]] = None,
        *,
        login_id: str = "",
        event_id: str = "",
        timestamp: Optional[Any] = None,
    ) -> None:
        """向列表型用户画像属性追加元素并自动去重（`$user_uniq_append`）。"""
        if not properties or not isinstance(properties, dict):
            raise AbiValidationError(
                "properties must be a non-empty dict for user_uniq_append"
            )
        for k, v in properties.items():
            trimmed_k = _strip_unicode_whitespace(k) if isinstance(k, str) else ""
            if trimmed_k in ("#time", "$time"):
                continue
            if not isinstance(v, (list, tuple)):
                raise AbiValidationError(
                    f"user_uniq_append property {k!r} must be a list or tuple, got {type(v).__name__}"
                )
        self._send_user_event(
            op_name="$user_uniq_append",
            account_id=account_id,
            distinct_id=distinct_id,
            login_id=login_id,
            properties=properties,
            event_id=event_id,
            timestamp=timestamp,
        )

    def user_unset(
        self,
        account_id: str = "",
        distinct_id: str = "",
        *keys: Union[str, Sequence[str]],
        login_id: str = "",
        event_id: str = "",
        timestamp: Optional[Any] = None,
    ) -> None:
        """清空指定的用户画像属性键（`$user_unset`），支持传入多个属性名字符串或属性名列表。"""
        flat_keys: List[str] = []
        for item in keys:
            if isinstance(item, str):
                flat_keys.append(item)
            elif isinstance(item, (list, tuple, set)):
                for sub in item:
                    if not isinstance(sub, str):
                        raise AbiValidationError(
                            f"user_unset key must be a str, got {type(sub).__name__}"
                        )
                    flat_keys.append(sub)
            else:
                raise AbiValidationError(
                    f"user_unset key must be a str, got {type(item).__name__}"
                )
        if not flat_keys:
            raise AbiValidationError("at least one property key is required for user_unset")
        props = {k: 0 for k in flat_keys}
        self._send_user_event(
            op_name="$user_unset",
            account_id=account_id,
            distinct_id=distinct_id,
            login_id=login_id,
            properties=props,
            event_id=event_id,
            timestamp=timestamp,
        )

    def user_delete(
        self,
        account_id: str = "",
        distinct_id: str = "",
        *,
        login_id: str = "",
        event_id: str = "",
        timestamp: Optional[Any] = None,
    ) -> None:
        """删除当前用户的画像记录（`$user_del`）。"""
        self._send_user_event(
            op_name="$user_del",
            account_id=account_id,
            distinct_id=distinct_id,
            login_id=login_id,
            properties={},
            event_id=event_id,
            timestamp=timestamp,
        )

    def flush(self) -> None:
        """立即刷盘或同步提交底层 `Consumer` 缓冲的事件。"""
        self._consumer.flush()

    def close(self) -> None:
        """排空缓冲并安全关闭底层 `Consumer`。"""
        self._consumer.close()

    def __enter__(self) -> "AbiAnalytics":
        return self

    def __exit__(self, exc_type: Any, exc_val: Any, exc_tb: Any) -> None:
        self.close()

    # ------------------------------------------------------------------------
    # 内部事件组装逻辑
    # ------------------------------------------------------------------------

    def _send_user_event(
        self,
        op_name: str,
        account_id: str,
        distinct_id: str,
        login_id: str,
        properties: Optional[Dict[str, Any]],
        event_id: str,
        timestamp: Optional[Any],
    ) -> None:
        evt = self._build_event(
            event_name=op_name,
            distinct_id=distinct_id,
            login_id=login_id if login_id else account_id,
            properties=properties,
            event_id=event_id,
            timestamp=timestamp,
            include_super_props=False,
        )
        self._consumer.add(evt)

    def _build_event(
        self,
        event_name: str,
        distinct_id: str,
        login_id: str,
        properties: Optional[Dict[str, Any]],
        event_id: str,
        timestamp: Optional[Any],
        include_super_props: bool,
    ) -> Dict[str, Any]:
        valid_event_name = validate_event_name(event_name)

        norm_distinct, norm_login = resolve_identity(
            distinct_id=distinct_id,
            login_id=login_id,
        )

        norm_event_id = ""
        if event_id:
            norm_event_id = normalize_identity(event_id, MAX_EVENT_ID_BYTES)
        if not norm_event_id:
            norm_event_id = generate_uuid_v4()

        props_without_time, resolved_ts_ms = extract_event_time_and_strip(
            properties, explicit_timestamp=timestamp
        )
        clean_explicit_props = sanitize_properties(props_without_time)

        final_props: Dict[str, Any] = {}
        is_user_event = valid_event_name.startswith("$user_") or valid_event_name.startswith("#user_")

        if include_super_props and not is_user_event:
            with self._super_lock:
                static_copy = copy.deepcopy(self._super_properties)
                dynamic_fn = self._dynamic_super_properties_fn

            final_props.update(static_copy)
            if dynamic_fn is not None:
                dyn_raw = dynamic_fn()
                if dyn_raw:
                    dyn_without_time, _ = extract_event_time_and_strip(dyn_raw)
                    clean_dyn = sanitize_properties(dyn_without_time)
                    final_props.update(clean_dyn)

        final_props.update(clean_explicit_props)

        event_dict: Dict[str, Any] = {
            "event_id": norm_event_id,
            "event_name": valid_event_name,
            "distinct_id": norm_distinct,
            "timestamp": resolved_ts_ms,
            "properties": final_props,
        }
        if norm_login:
            event_dict["login_id"] = norm_login

        return event_dict
