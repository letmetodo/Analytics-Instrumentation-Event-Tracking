#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ABI LogBus (`abi_logbus.py`) — 对标 ThinkingData LogBus 2 的本地 JSONL 日志扫描与批量转发守护工具。

核心职责：
1. 专为 Go / Java 服务端 SDK `LoggerConsumer` 落盘的按天/按小时滚动 `.jsonl` (`abi.log.*`) 文件设计；
2. 纯 Python 3 标准库实现（零第三方依赖），内置文件 Inode + 字节偏移量（Byte Offset）断点续传记录（`.abi_logbus_state.json`）；
3. 自动执行上报前协议归一化：
   - 提取 `properties["#time"]` / `properties["$time"]` 为顶层毫秒 `timestamp` 并剥离原字段；
   - 完整保留 `properties["#ip"]` / `properties["$ip"]` 供后端 Flink Job1 还原客户端真实地域（国家/省/市）；
   - 自动将超过 IEEE-754 安全整数范围（`> 2^53 - 1`）的 64 位整数转换为字符串；
   - 缺失 `event_id` 时自动补齐 UUIDv4，并在 `429` / `5xx` 退避重试期间保持同一 `event_id` 幂等；
4. 支持两步式交互演练：
   - 第一步（预览）：打印格式化后的唯一一份 `POST /collect/api/v1/track/batch` 待提交 JSON 报文；
   - 第二步（确认提交）：输入 `y` 或传入 `--yes` 后执行 Gzip 压缩批量上报并持久化断点 Offset。

快速验证命令：
  /opt/homebrew/bin/python3 abi.sdk/data-import/abi_logbus.py --demo --yes
"""

from __future__ import annotations

import argparse
from datetime import datetime, timezone
import fnmatch
import gzip
from http.server import BaseHTTPRequestHandler, HTTPServer
import json
import os
from pathlib import Path
import re
import socket
import sys
import tempfile
import threading
import time
from typing import Any, Dict, List, Optional, Tuple
import urllib.error
import urllib.request
import uuid

MAX_DISTINCT_ID_BYTES = 64
MAX_LOGIN_ID_BYTES = 128
MAX_EVENT_ID_BYTES = 64
MAX_EVENT_NAME_LEN = 128
MAX_PROP_KEY_LEN = 64
MAX_SAFE_INTEGER = 9007199254740991
SECONDS_TO_MS_THRESHOLD = 100_000_000_000

_IDENTIFIER_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")

PROTECTED_SYSTEM_EVENTS = frozenset(
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

PROTECTED_SYSTEM_PROP_ALIASES = frozenset(
    {
        "$ip",
        "#ip",
        "ip",
        "$country",
        "#country",
        "country",
        "$country_code",
        "#country_code",
        "country_code",
        "$province",
        "#province",
        "province",
        "$city",
        "#city",
        "city",
        "$os",
        "#os",
        "os",
        "$os_version",
        "#os_version",
        "os_version",
        "$device_model",
        "#device_model",
        "device_model",
        "$model",
        "#model",
        "model",
        "$manufacturer",
        "#manufacturer",
        "manufacturer",
        "$device_id",
        "#device_id",
        "device_id",
        "$session_id",
        "#session_id",
        "session_id",
        "$browser",
        "#browser",
        "browser",
        "$browser_version",
        "#browser_version",
        "browser_version",
        "$app_version",
        "#app_version",
        "app_version",
        "$lib",
        "#lib",
        "lib",
        "$lib_version",
        "#lib_version",
        "lib_version",
        "$network",
        "#network",
        "network",
        "$network_type",
        "#network_type",
        "network_type",
        "$platform",
        "#platform",
        "platform",
        "$carrier",
        "#carrier",
        "carrier",
        "$screen_height",
        "#screen_height",
        "screen_height",
        "$screen_width",
        "#screen_width",
        "screen_width",
        "$url",
        "#url",
        "url",
        "$url_path",
        "#url_path",
        "url_path",
        "$title",
        "#title",
        "title",
        "$referrer",
        "#referrer",
        "referrer",
        "$duration",
        "#duration",
        "duration",
        "$zone_offset",
        "#zone_offset",
        "zone_offset",
        "$first_check_id",
        "#first_check_id",
        "first_check_id",
    }
)


def validate_event_name(raw_name: Any) -> str:
    if not isinstance(raw_name, str):
        raise ValueError("missing required field 'event_name'")
    trimmed = raw_name.strip()
    if not trimmed:
        raise ValueError("missing required field 'event_name'")
    if len(trimmed) > MAX_EVENT_NAME_LEN:
        raise ValueError(f"event_name exceeds {MAX_EVENT_NAME_LEN} chars")
    if trimmed in PROTECTED_SYSTEM_EVENTS:
        return trimmed
    if not _IDENTIFIER_RE.match(trimmed):
        raise ValueError(f"invalid event_name: {trimmed!r}")
    return trimmed


def validate_property_key(raw_key: Any) -> str:
    if not isinstance(raw_key, str):
        raise ValueError("property key must be a string")
    trimmed = raw_key.strip()
    if not trimmed:
        raise ValueError("property key cannot be empty")
    if trimmed in PROTECTED_SYSTEM_PROP_ALIASES:
        return trimmed
    if len(trimmed) > MAX_PROP_KEY_LEN or not _IDENTIFIER_RE.match(trimmed):
        raise ValueError(f"invalid property key: {trimmed!r}")
    return trimmed


def _normalize_identity_field(val: Any, max_utf8_bytes: int, field_name: str) -> str:
    if val is None:
        return ""
    if not isinstance(val, str):
        val = str(val)
    for ch in val:
        cp = ord(ch)
        if 0xD800 <= cp <= 0xDFFF:
            raise ValueError(f"{field_name} contains invalid UTF-16 surrogate")
        if (cp < 0x20 and not (0x09 <= cp <= 0x0D)) or cp == 0x7F:
            raise ValueError(f"{field_name} contains ASCII control character U+{cp:04X}")
    trimmed = val.strip()
    encoded = trimmed.encode("utf-8")
    if len(encoded) > max_utf8_bytes:
        raise ValueError(f"{field_name} exceeds {max_utf8_bytes} UTF-8 bytes (got {len(encoded)})")
    return trimmed


def parse_event_timestamp(raw: Any) -> int:
    """将毫秒/秒时间戳或 ISO-8601 日期字符串统一解析为毫秒级 Unix 时间戳。"""
    if isinstance(raw, (int, float)) and not isinstance(raw, bool):
        if raw <= 0:
            raise ValueError(f"timestamp must be positive, got {raw}")
        return int(round(raw * 1000)) if raw < SECONDS_TO_MS_THRESHOLD else int(round(raw))
    if isinstance(raw, str):
        text = raw.strip()
        if not text:
            raise ValueError("timestamp string cannot be empty")
        if text.endswith("Z"):
            text = text[:-1] + "+00:00"
        elif " " in text and "T" not in text:
            text = text.replace(" ", "T", 1)
        dt = datetime.fromisoformat(text)
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        ms = int(round(dt.timestamp() * 1000))
        if ms <= 0:
            raise ValueError(f"invalid parsed timestamp: {raw}")
        return ms
    raise ValueError(f"unsupported timestamp value: {raw!r}")


def sanitize_large_ints(val: Any) -> Any:
    """对超出 IEEE-754 双精度安全整数范围 (> 2^53 - 1) 的整数执行无损字符串化。"""
    if isinstance(val, bool) or val is None:
        return val
    if isinstance(val, int):
        if abs(val) > MAX_SAFE_INTEGER:
            return str(val)
        return val
    if isinstance(val, list):
        return [sanitize_large_ints(item) for item in val]
    if isinstance(val, dict):
        return {str(k): sanitize_large_ints(v) for k, v in val.items()}
    return val


def normalize_event_record(raw_obj: Dict[str, Any]) -> Dict[str, Any]:
    """将 LoggerConsumer 单行 JSONL 记录规范化为网关标准 TrackEventDTO（对标 ThinkingData 双 ID 契约）。"""
    raw_event_name = raw_obj.get("event_name") if raw_obj.get("event_name") is not None else raw_obj.get("#event_name")
    event_name = validate_event_name(raw_event_name)

    login_id = _normalize_identity_field(
        raw_obj.get("login_id") if raw_obj.get("login_id") is not None else raw_obj.get("#account_id"),
        MAX_LOGIN_ID_BYTES,
        "login_id",
    )
    distinct_id = _normalize_identity_field(
        raw_obj.get("distinct_id") if raw_obj.get("distinct_id") is not None else raw_obj.get("#distinct_id"),
        MAX_DISTINCT_ID_BYTES,
        "distinct_id",
    )

    if not distinct_id and not login_id:
        raise ValueError("missing identity: at least one of distinct_id or login_id is required")

    raw_props = raw_obj.get("properties")
    props: Dict[str, Any] = dict(raw_props) if isinstance(raw_props, dict) else {}

    extracted_ts: Optional[int] = None
    if "#time" in props:
        if props["#time"] is not None:
            extracted_ts = parse_event_timestamp(props["#time"])
        del props["#time"]
    if "$time" in props:
        if props["$time"] is not None and extracted_ts is None:
            extracted_ts = parse_event_timestamp(props["$time"])
        del props["$time"]

    validated_props: Dict[str, Any] = {}
    for raw_k, raw_v in props.items():
        norm_k = validate_property_key(raw_k)
        validated_props[norm_k] = sanitize_large_ints(raw_v)

    top_ts = raw_obj.get("timestamp") or raw_obj.get("#time")
    if top_ts is not None and top_ts != 0:
        resolved_ts = parse_event_timestamp(top_ts)
    elif extracted_ts is not None:
        resolved_ts = extracted_ts
    else:
        resolved_ts = int(time.time() * 1000)

    event_id = _normalize_identity_field(
        raw_obj.get("event_id") if raw_obj.get("event_id") is not None else raw_obj.get("#uuid"),
        MAX_EVENT_ID_BYTES,
        "event_id",
    )
    if not event_id:
        event_id = str(uuid.uuid4())

    normalized: Dict[str, Any] = {
        "event_id": event_id,
        "event_name": event_name,
        "distinct_id": distinct_id,
        "timestamp": resolved_ts,
        "properties": validated_props,
    }
    if login_id:
        normalized["login_id"] = login_id
    return normalized


def resolve_batch_endpoint(server_url: str) -> str:
    trimmed = server_url.strip().rstrip("/")
    if trimmed.endswith("/collect/api/v1/track/batch"):
        return trimmed
    return f"{trimmed}/collect/api/v1/track/batch"


class OffsetStateStore:
    """持久化管理每个日志文件的读取断点（Inode + Byte Offset）。"""

    def __init__(self, state_file: Path) -> None:
        self.state_file = state_file
        self.files: Dict[str, Dict[str, Any]] = {}
        self.load()

    def load(self) -> None:
        if not self.state_file.exists():
            self.files = {}
            return
        try:
            data = json.loads(self.state_file.read_text(encoding="utf-8"))
            if isinstance(data, dict) and isinstance(data.get("files"), dict):
                self.files = data["files"]
        except Exception:
            self.files = {}

    def get_offset(self, file_path: Path) -> int:
        key = str(file_path.resolve())
        entry = self.files.get(key)
        if not entry:
            return 0
        try:
            stat = file_path.stat()
            if entry.get("inode") == stat.st_ino and int(entry.get("offset", 0)) <= stat.st_size:
                return int(entry.get("offset", 0))
        except OSError:
            return 0
        return 0

    def update_offset(self, file_path: Path, new_offset: int) -> None:
        key = str(file_path.resolve())
        stat = file_path.stat()
        self.files[key] = {
            "inode": stat.st_ino,
            "offset": new_offset,
            "file_size": stat.st_size,
            "updated_at": datetime.now(timezone.utc).isoformat(),
        }
        payload = {
            "version": 1,
            "files": self.files,
        }
        tmp_path = self.state_file.with_suffix(".tmp")
        tmp_path.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        tmp_path.replace(self.state_file)


def discover_log_files(log_dir: Path, pattern: str) -> List[Path]:
    """扫描日志目录下匹配的 JSONL 日志文件并按文件名排序。"""
    if not log_dir.exists():
        return []
    patterns = [p.strip() for p in pattern.split(",") if p.strip()]
    matched: List[Path] = []
    for entry in sorted(log_dir.iterdir(), key=lambda p: p.name):
        if not entry.is_file() or entry.name.startswith("."):
            continue
        if any(fnmatch.fnmatch(entry.name, pat) for pat in patterns):
            matched.append(entry)
    return matched


def read_next_batch(
    file_path: Path,
    start_offset: int,
    batch_size: int,
) -> Tuple[List[Dict[str, Any]], int]:
    """从指定字节偏移量读取最多 batch_size 条合法事件，返回 (events, next_offset)。"""
    events: List[Dict[str, Any]] = []
    current_offset = start_offset
    with file_path.open("rb") as f:
        f.seek(start_offset)
        while len(events) < batch_size:
            line_bytes = f.readline()
            if not line_bytes:
                break
            # 若最后一行尚未写入换行符（LoggerConsumer 正在写入中），等待下次轮询
            if not line_bytes.endswith(b"\n") and f.tell() == file_path.stat().st_size:
                raw_check = line_bytes.decode("utf-8", errors="replace").strip()
                try:
                    json.loads(raw_check)
                except Exception:
                    break
            next_pos = f.tell()
            line_str = line_bytes.decode("utf-8", errors="replace").strip()
            if not line_str:
                current_offset = next_pos
                continue
            raw_obj = json.loads(line_str)
            if not isinstance(raw_obj, dict):
                raise ValueError(f"JSONL line must be a JSON object in {file_path.name}")
            events.append(normalize_event_record(raw_obj))
            current_offset = next_pos
    return events, current_offset


def build_batch_payload(
    project_id: int,
    project_token: str,
    events: List[Dict[str, Any]],
    debug: bool = False,
    dry_run: bool = False,
) -> Dict[str, Any]:
    payload: Dict[str, Any] = {
        "project_id": project_id,
        "project_token": project_token,
        "events": events,
    }
    if debug:
        payload["debug"] = True
    if dry_run:
        payload["dry_run"] = True
    return payload


def send_batch_http(
    endpoint: str,
    payload: Dict[str, Any],
    use_gzip: bool = True,
    max_retries: int = 3,
    timeout_sec: float = 10.0,
) -> Tuple[int, str]:
    """向采集网关发送 POST /collect/api/v1/track/batch 请求，支持 Gzip 与 429/5xx 指数退避重试。"""
    raw_json = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    headers: Dict[str, str] = {
        "Content-Type": "application/json",
        "User-Agent": "abi-logbus/1.0.0",
    }
    if use_gzip:
        body_bytes = gzip.compress(raw_json)
        headers["Content-Encoding"] = "gzip"
    else:
        body_bytes = raw_json

    backoff = 0.5
    for attempt in range(max_retries + 1):
        req = urllib.request.Request(endpoint, data=body_bytes, headers=headers, method="POST")
        try:
            with urllib.request.urlopen(req, timeout=timeout_sec) as resp:
                resp_body = resp.read().decode("utf-8", errors="replace")
                return resp.status, resp_body
        except urllib.error.HTTPError as e:
            err_body = e.read().decode("utf-8", errors="replace") if e.fp else str(e)
            if (e.code == 429 or e.code >= 500) and attempt < max_retries:
                time.sleep(backoff)
                backoff *= 2
                continue
            return e.code, err_body
        except urllib.error.URLError as e:
            if attempt < max_retries:
                time.sleep(backoff)
                backoff *= 2
                continue
            raise RuntimeError(f"network error sending batch to {endpoint}: {e}") from e
    return 500, '{"code":50000,"message":"exhausted retries"}'


def is_port_open(host: str, port: int, timeout: float = 0.4) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.settimeout(timeout)
        return sock.connect_ex((host, port)) == 0


class _DemoIngestHandler(BaseHTTPRequestHandler):
    """内置自包含演练网关处理器（当本地 :8081 未启动时用于完成端到端 HTTP + Gzip 闭环验证）。"""

    def do_POST(self) -> None:  # noqa: N802
        length = int(self.headers.get("Content-Length", "0"))
        raw = self.rfile.read(length)
        if self.headers.get("Content-Encoding") == "gzip":
            raw = gzip.decompress(raw)
        body = json.loads(raw.decode("utf-8"))
        events = body.get("events", [])
        resp = {
            "code": 200,
            "message": "ok",
            "data": {
                "project_id": body.get("project_id"),
                "accepted": len(events),
                "dry_run": bool(body.get("dry_run", False)),
                "gzip": self.headers.get("Content-Encoding") == "gzip",
            },
            "request_id": f"req_logbus_demo_{uuid.uuid4().hex[:12]}",
        }
        out = json.dumps(resp, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        return


def run_demo(
    confirm_yes: bool,
    preview_only: bool,
    explicit_server_url: str = "",
    project_id: int = 1,
    project_token: str = "abi_tok_logbus_demo_2026",
) -> int:
    """运行内置 LoggerConsumer -> LogBus 两步式预览与确认提交自包含演练。"""
    with tempfile.TemporaryDirectory(prefix="abi_logbus_demo_") as tmp_dir:
        log_dir = Path(tmp_dir)
        sample_file = log_dir / "abi.log.2026-11-10"
        sample_lines = [
            {
                "event_id": "018f6b9c-7c40-7000-8000-000000000101",
                "event_name": "$login",
                "distinct_id": "vis_device_logbus_01",
                "login_id": "user_10086",
                "timestamp": 1762768800000,
                "properties": {
                    "$lib": "abi-go-sdk",
                    "$lib_version": "1.0.0",
                    "#ip": "203.0.113.88",
                    "login_method": "sso_oidc",
                },
            },
            {
                "event_id": "ord_paid_20261110_9001",
                "event_name": "OrderPaid",
                "distinct_id": "vis_device_logbus_01",
                "login_id": "user_10086",
                "properties": {
                    "$lib": "abi-go-sdk",
                    "$lib_version": "1.0.0",
                    "#ip": "203.0.113.88",
                    "#time": "2026-11-10T10:00:05Z",
                    "order_id": 9007199254740993,
                    "amount": 299.5,
                    "currency": "CNY",
                },
            },
            {
                "event_id": "018f6b9c-7c40-7000-8000-000000000103",
                "event_name": "$user_set",
                "distinct_id": "vis_device_logbus_01",
                "login_id": "user_10086",
                "timestamp": 1762768810000,
                "properties": {
                    "vip_level": "diamond",
                    "city": "Shanghai",
                },
            },
        ]
        sample_file.write_text(
            "\n".join(json.dumps(item, ensure_ascii=False) for item in sample_lines) + "\n",
            encoding="utf-8",
        )

        mock_server: Optional[HTTPServer] = None
        server_url = explicit_server_url.strip()
        if not server_url:
            mock_server = HTTPServer(("127.0.0.1", 0), _DemoIngestHandler)
            port = mock_server.server_port
            server_url = f"http://127.0.0.1:{port}"
            thread = threading.Thread(target=mock_server.serve_forever, daemon=True)
            thread.start()

        try:
            return process_directory_once(
                log_dir=log_dir,
                file_pattern="abi.log*,*.jsonl",
                server_url=server_url,
                project_id=project_id,
                project_token=project_token,
                batch_size=50,
                use_gzip=True,
                debug=False,
                dry_run=True,
                state_file=log_dir / ".abi_logbus_state.json",
                preview_only=preview_only,
                confirm_yes=confirm_yes,
            )
        finally:
            if mock_server is not None:
                mock_server.shutdown()
                mock_server.server_close()


def process_directory_once(
    log_dir: Path,
    file_pattern: str,
    server_url: str,
    project_id: int,
    project_token: str,
    batch_size: int,
    use_gzip: bool,
    debug: bool,
    dry_run: bool,
    state_file: Path,
    preview_only: bool,
    confirm_yes: bool,
) -> int:
    state = OffsetStateStore(state_file)
    files = discover_log_files(log_dir, file_pattern)
    if not files:
        print(f"[ABI LogBus] 未在目录 {log_dir} 下找到匹配 '{file_pattern}' 的日志文件。")
        return 0

    endpoint = resolve_batch_endpoint(server_url)
    total_sent = 0

    for file_path in files:
        while True:
            start_offset = state.get_offset(file_path)
            events, next_offset = read_next_batch(file_path, start_offset, batch_size)
            if not events:
                break

            payload = build_batch_payload(
                project_id=project_id,
                project_token=project_token,
                events=events,
                debug=debug,
                dry_run=dry_run,
            )

            print("=== [Step 1/2] ABI LogBus 待提交请求报文预览 (Request Preview) ===")
            print(f"Target Endpoint : POST {endpoint}")
            print(f"Source File     : {file_path.name} (offset {start_offset} -> {next_offset} bytes)")
            print(f"Batch Size      : {len(events)} events | Content-Encoding: {'gzip' if use_gzip else 'identity'}")
            print(json.dumps(payload, ensure_ascii=False, indent=2))

            if preview_only:
                print("[ABI LogBus] 当前为 --preview 仅预览模式，未发送网络请求，断点 Offset 保持不变。")
                return 0

            if not confirm_yes:
                if sys.stdin.isatty():
                    ans = input("\n是否确认提交该批次至采集网关？[y/N]: ").strip().lower()
                    if ans not in ("y", "yes"):
                        print("[ABI LogBus] 已取消提交，断点 Offset 未变更。")
                        return 0
                else:
                    print("[ABI LogBus] 非交互式终端请显式传入 --yes 确认提交，或使用 --preview 仅预览。")
                    return 1

            status, resp_text = send_batch_http(
                endpoint=endpoint,
                payload=payload,
                use_gzip=use_gzip,
            )
            print("\n=== [Step 2/2] ABI LogBus 批量提交结果与 Offset 断点记录 ===")
            print(f"HTTP Status     : {status}")
            print(f"Gateway Response: {resp_text}")

            if 200 <= status < 300:
                state.update_offset(file_path, next_offset)
                total_sent += len(events)
                print(
                    f"Checkpoint Saved: {state_file.name} -> {file_path.name} offset={next_offset} "
                    f"(累计成功转发 {total_sent} 条事件)"
                )
            else:
                print(
                    f"[ABI LogBus] 网关返回非 2xx 状态码 ({status})，保留原 Offset ({start_offset}) 以便下次幂等重试。",
                    file=sys.stderr,
                )
                return 2

    return 0


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="ABI LogBus — 本地 LoggerConsumer JSONL 日志目录扫描与批量转发工具（对标 ThinkingData LogBus 2）"
    )
    parser.add_argument("--log-dir", type=str, default="./logs", help="LoggerConsumer 产出的 JSONL 日志目录路径")
    parser.add_argument(
        "--file-pattern",
        type=str,
        default="abi.log*,*.jsonl",
        help="匹配日志文件名通配符（逗号分隔，默认 'abi.log*,*.jsonl'）",
    )
    parser.add_argument(
        "--server-url",
        type=str,
        default="",
        help="ABI 采集网关地址（默认 http://localhost:8081；--demo 模式下未指定时自动启动内置本地 Mock 网关）",
    )
    parser.add_argument("--project-id", type=int, default=1, help="目标项目数字 ID（默认 1）")
    parser.add_argument(
        "--project-token",
        type=str,
        default="abi_tok_demo_001",
        help="目标项目采集上报密钥（project_token）",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=100,
        help="单次 HTTP 批量上报最大事件条数（1..500，默认 100）",
    )
    parser.add_argument(
        "--no-gzip",
        action="store_true",
        help="禁用 Gzip 请求体压缩（默认启用 Content-Encoding: gzip）",
    )
    parser.add_argument("--debug", action="store_true", help="开启 debug 校验模式")
    parser.add_argument("--dry-run", action="store_true", help="开启 dry_run 演练模式（仅校验不落库）")
    parser.add_argument(
        "--state-file",
        type=str,
        default="",
        help="自定义断点续传状态文件路径（默认保存在 <log-dir>/.abi_logbus_state.json）",
    )
    parser.add_argument(
        "--daemon",
        action="store_true",
        help="开启常驻守护进程模式，按 --interval 秒数持续轮询新增日志",
    )
    parser.add_argument("--interval", type=float, default=2.0, help="常驻轮询间隔秒数（默认 2.0s）")
    parser.add_argument(
        "--preview",
        action="store_true",
        help="第一步：仅打印格式化后的待提交请求 JSON 预览，不发送请求且不推进断点",
    )
    parser.add_argument(
        "--yes",
        "-y",
        action="store_true",
        help="第二步：在预览后自动确认提交至采集网关并更新断点 Offset",
    )
    parser.add_argument(
        "--demo",
        action="store_true",
        help="运行内置自包含演练（自动生成模拟 LoggerConsumer JSONL 日志并完成预览与上报验证）",
    )

    args = parser.parse_args(argv)
    batch_size = max(1, min(args.batch_size, 500))

    if args.demo:
        return run_demo(
            confirm_yes=args.yes,
            preview_only=args.preview,
            explicit_server_url=args.server_url,
            project_id=args.project_id,
            project_token=args.project_token,
        )

    resolved_server_url = args.server_url.strip() or "http://localhost:8081"
    log_dir = Path(args.log_dir)
    state_file = Path(args.state_file) if args.state_file else (log_dir / ".abi_logbus_state.json")

    if not args.daemon:
        return process_directory_once(
            log_dir=log_dir,
            file_pattern=args.file_pattern,
            server_url=resolved_server_url,
            project_id=args.project_id,
            project_token=args.project_token,
            batch_size=batch_size,
            use_gzip=not args.no_gzip,
            debug=args.debug,
            dry_run=args.dry_run,
            state_file=state_file,
            preview_only=args.preview,
            confirm_yes=args.yes,
        )

    print(f"[ABI LogBus] 已启动常驻监听模式，监控目录: {log_dir} (间隔 {args.interval}s)")
    try:
        while True:
            process_directory_once(
                log_dir=log_dir,
                file_pattern=args.file_pattern,
                server_url=resolved_server_url,
                project_id=args.project_id,
                project_token=args.project_token,
                batch_size=batch_size,
                use_gzip=not args.no_gzip,
                debug=args.debug,
                dry_run=args.dry_run,
                state_file=state_file,
                preview_only=False,
                confirm_yes=True,
            )
            time.sleep(max(0.5, args.interval))
    except KeyboardInterrupt:
        print("\n[ABI LogBus] 收到退出信号，已安全保存断点 Offset 并退出。")
        return 0


if __name__ == "__main__":
    sys.exit(main())
