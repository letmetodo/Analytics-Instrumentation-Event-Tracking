#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ABI Python 3 服务端 SDK 标准 `unittest` 测试套件（`tests/test_abi_sdk.py`）。

覆盖范围：
1. 跨语言黄金测试向量（`spec/test-vectors/identity_cases.json` 与 `event_and_property_cases.json`）100% 契约验证；
2. 双身份（`distinct_id` 与 `login_id`）独立校验、控制字符前置拦截、Unicode 空白符裁剪与 UTF-8 字节上限（绝不将 `login_id` 回填至 `distinct_id`）；
3. Python `bool` 与 `int` 子类区分、超 `2^53 - 1` 大整数自动转十进制字符串、`NaN`/`Inf` 与非法列表元素拦截；
4. `#time` / `$time` 多格式时间提取与属性剥离；
5. `AbiAnalytics` 全套 API（公共属性优先级与画像隔离、`track*`、7 类 `user_*` 画像操作）；
6. 四大 Consumer（`StagingConsumer`、`BatchConsumer`、`LoggerConsumer`、`DebugConsumer`）及两步式 `demo.py` 集成测试。
"""

from __future__ import annotations

import gzip
import http.server
import json
import math
import os
import sys
import tempfile
import threading
import time
import unittest
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, List

_TESTS_DIR = Path(__file__).resolve().parent
_PYTHON_SDK_DIR = _TESTS_DIR.parent
_SPEC_VECTORS_DIR = _PYTHON_SDK_DIR.parent / "spec" / "test-vectors"

if str(_PYTHON_SDK_DIR) not in sys.path:
    sys.path.insert(0, str(_PYTHON_SDK_DIR))

from abi_sdk import (  # noqa: E402
    MAX_DISTINCT_ID_BYTES,
    MAX_EVENT_ID_BYTES,
    MAX_LOGIN_ID_BYTES,
    MAX_SAFE_INTEGER,
    AbiAnalytics,
    AbiGatewayError,
    AbiValidationError,
    BatchConsumer,
    DebugConsumer,
    LoggerConsumer,
    StagingConsumer,
    extract_event_time_and_strip,
    normalize_identity,
    resolve_identity,
    sanitize_properties,
    validate_event_name,
    validate_property_key,
)
from examples.demo import (  # noqa: E402
    DemoConfig,
    build_demo_request_preview,
    confirm_submit_demo,
)


class _TestGatewayServer:
    """用于单元测试的本地线程安全 HTTP Mock 采集网关。"""

    def __init__(self) -> None:
        self.requests: List[Dict[str, Any]] = []
        self.headers_history: List[Dict[str, str]] = []
        self.status_sequence: List[int] = []
        self.custom_response: Dict[str, Any] = {}
        self._lock = threading.Lock()

        parent = self

        class _Handler(http.server.BaseHTTPRequestHandler):
            def do_POST(self) -> None:  # noqa: N802
                content_len = int(self.headers.get("Content-Length", "0"))
                raw = self.rfile.read(content_len)
                if self.headers.get("Content-Encoding", "").lower() == "gzip":
                    raw = gzip.decompress(raw)
                payload = json.loads(raw.decode("utf-8"))

                with parent._lock:
                    parent.requests.append(payload)
                    parent.headers_history.append(
                        {k.lower(): v for k, v in self.headers.items()}
                    )
                    status = (
                        parent.status_sequence.pop(0)
                        if parent.status_sequence
                        else 200
                    )
                    custom_resp = dict(parent.custom_response)

                if status != 200:
                    err_obj = custom_resp or {
                        "code": 32060 if status == 429 else 32080,
                        "message": f"simulated status {status}",
                        "request_id": "req_err",
                    }
                    data_bytes = json.dumps(err_obj).encode("utf-8")
                    self.send_response(status)
                    self.send_header("Content-Type", "application/json")
                    self.send_header("Content-Length", str(len(data_bytes)))
                    self.end_headers()
                    self.wfile.write(data_bytes)
                    return

                resp_obj = custom_resp or {
                    "code": 200,
                    "message": "success",
                    "request_id": "req_ok_1",
                    "data": {
                        "accepted": len(payload.get("events", [])),
                        "rejected": 0,
                        "dry_run": bool(payload.get("dry_run", False)),
                    },
                }
                data_bytes = json.dumps(resp_obj).encode("utf-8")
                self.send_response(200)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(data_bytes)))
                self.end_headers()
                self.wfile.write(data_bytes)

            def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
                return

        self._httpd = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self.base_url = f"http://127.0.0.1:{self._httpd.server_address[1]}"
        self._thread = threading.Thread(target=self._httpd.serve_forever, daemon=True)
        self._thread.start()

    def close(self) -> None:
        self._httpd.shutdown()
        self._httpd.server_close()


class TestAbiPythonSdk(unittest.TestCase):
    """ABI Python 3 服务端 SDK 全量单元与契约测试。"""

    def test_golden_identity_vectors(self) -> None:
        """黄金测试向量 1：`identity_cases.json` 全量案例验证。"""
        vector_path = _SPEC_VECTORS_DIR / "identity_cases.json"
        self.assertTrue(vector_path.is_file(), f"Missing {vector_path}")
        data = json.loads(vector_path.read_text(encoding="utf-8"))

        self.assertEqual(data["max_distinct_id_bytes"], MAX_DISTINCT_ID_BYTES)
        self.assertEqual(data["max_login_id_bytes"], MAX_LOGIN_ID_BYTES)

        for case in data["cases"]:
            with self.subTest(case=case["name"]):
                if case["valid"]:
                    norm_d, norm_l = resolve_identity(
                        distinct_id=case["distinct_id"],
                        login_id=case["login_id"],
                    )
                    self.assertEqual(norm_d, case["normalized_distinct_id"])
                    self.assertEqual(norm_l, case["normalized_login_id"])
                else:
                    with self.assertRaises(AbiValidationError):
                        resolve_identity(
                            distinct_id=case["distinct_id"],
                            login_id=case["login_id"],
                        )

    def test_golden_event_and_property_vectors(self) -> None:
        """黄金测试向量 2：`event_and_property_cases.json` 全量案例验证。"""
        vector_path = _SPEC_VECTORS_DIR / "event_and_property_cases.json"
        self.assertTrue(vector_path.is_file(), f"Missing {vector_path}")
        data = json.loads(vector_path.read_text(encoding="utf-8"))

        self.assertEqual(data["max_safe_integer"], MAX_SAFE_INTEGER)

        for case in data["event_name_cases"]:
            with self.subTest(event_name=case["event_name"]):
                if case["valid"]:
                    self.assertEqual(
                        validate_event_name(case["event_name"]), case["event_name"]
                    )
                else:
                    with self.assertRaises(AbiValidationError):
                        validate_event_name(case["event_name"])

        for case in data["property_key_cases"]:
            with self.subTest(key=case["key"]):
                if case["valid"]:
                    self.assertEqual(validate_property_key(case["key"]), case["key"])
                else:
                    with self.assertRaises(AbiValidationError):
                        validate_property_key(case["key"])

    def test_identity_no_fallback_and_event_id_bounds(self) -> None:
        """测试 `distinct_id` 为空时绝不回填 `login_id`（支持 65..128B 长账号）及 `event_id` 边界。"""
        # 1. distinct_id 为空，login_id <= 64 字节 -> distinct_id 保持 ""，绝不回填 login_id
        d1, l1 = resolve_identity(distinct_id="", login_id="user_short")
        self.assertEqual(d1, "")
        self.assertEqual(l1, "user_short")

        # 2. distinct_id 为空，login_id 为 100 字节（65..128B）-> 合法，distinct_id 保持 ""
        long_login = "u" * 100
        d2, l2 = resolve_identity(distinct_id="", login_id=long_login)
        self.assertEqual(d2, "")
        self.assertEqual(l2, long_login)

        # 验证线上面报文：distinct_id="" 且 login_id=long_login，无回填污染
        staging = StagingConsumer(project_id=1, project_token="tok_id")
        sdk = AbiAnalytics(staging)
        sdk.track(account_id=long_login, distinct_id="", event_name="BackendWebhook")
        evt = staging.events[0]
        self.assertEqual(evt["distinct_id"], "")
        self.assertEqual(evt["login_id"], long_login)

        # 3. 两者全空 -> 报错
        with self.assertRaises(AbiValidationError):
            resolve_identity(distinct_id="   ", login_id="")

        # 4. event_id <= 64 UTF-8 字节与控制字符拦截
        self.assertEqual(normalize_identity("e" * 64, MAX_EVENT_ID_BYTES), "e" * 64)
        with self.assertRaises(AbiValidationError):
            normalize_identity("e" * 65, MAX_EVENT_ID_BYTES)
        with self.assertRaises(AbiValidationError):
            normalize_identity("evt\x00bad", MAX_EVENT_ID_BYTES)

    def test_bool_vs_int_and_safe_integer_serialization(self) -> None:
        """测试 Python `bool` 与 `int` 严格区分、超 `2^53 - 1` 大整数自动转字符串及非法值拦截。"""
        cleaned = sanitize_properties(
            {
                "flag_true": True,
                "flag_false": False,
                "safe_pos": MAX_SAFE_INTEGER,
                "safe_neg": -MAX_SAFE_INTEGER,
                "unsafe_pos": MAX_SAFE_INTEGER + 1,
                "unsafe_neg": -(MAX_SAFE_INTEGER + 2),
                "int64_min": -9223372036854775808,
                "mixed_list": [True, False, 42, MAX_SAFE_INTEGER + 9, "ok"],
                "ignored_none": None,
            }
        )
        self.assertIs(cleaned["flag_true"], True)
        self.assertIs(cleaned["flag_false"], False)
        self.assertIsInstance(cleaned["safe_pos"], int)
        self.assertEqual(cleaned["safe_pos"], 9007199254740991)
        self.assertEqual(cleaned["safe_neg"], -9007199254740991)
        self.assertEqual(cleaned["unsafe_pos"], "9007199254740992")
        self.assertEqual(cleaned["unsafe_neg"], "-9007199254740993")
        self.assertEqual(cleaned["int64_min"], "-9223372036854775808")
        self.assertEqual(
            cleaned["mixed_list"],
            [True, False, 42, "9007199254741000", "ok"],
        )
        self.assertIs(cleaned["mixed_list"][0], True)
        self.assertIs(cleaned["mixed_list"][1], False)
        self.assertNotIn("ignored_none", cleaned)

        # 拦截 NaN / Inf
        for bad_float in (math.nan, math.inf, -math.inf):
            with self.assertRaises(AbiValidationError):
                sanitize_properties({"bad": bad_float})
            with self.assertRaises(AbiValidationError):
                sanitize_properties({"bad_list": [1, bad_float]})

        # 拦截列表中的 None、嵌套 list 与嵌套 dict
        with self.assertRaises(AbiValidationError):
            sanitize_properties({"arr": ["a", None]})
        with self.assertRaises(AbiValidationError):
            sanitize_properties({"arr": [["nested"]]})
        with self.assertRaises(AbiValidationError):
            sanitize_properties({"arr": [{"nested": 1}]})

    def test_time_property_extraction_and_stripping(self) -> None:
        """测试 `#time` 与 `$time` 自动提取为毫秒 `timestamp` 并从 `properties` 中剥离。"""
        original = {
            "#time": "2026-11-10T10:00:00Z",
            "$ip": "203.0.113.88",
            "amount": 99.5,
        }
        stripped, ts_ms = extract_event_time_and_strip(original)
        self.assertEqual(ts_ms, 1794304800000)
        self.assertNotIn("#time", stripped)
        self.assertIn("#time", original)  # 原字典不被修改

        # 支持 datetime、秒级时间戳、毫秒级时间戳
        dt = datetime(2026, 11, 10, 10, 0, 0, tzinfo=timezone.utc)
        _, ts_dt = extract_event_time_and_strip({"$time": dt})
        self.assertEqual(ts_dt, 1794304800000)

        _, ts_sec = extract_event_time_and_strip({"#time": 1794304800})
        self.assertEqual(ts_sec, 1794304800000)

        _, ts_ms_num = extract_event_time_and_strip({"#time": 1794304800123})
        self.assertEqual(ts_ms_num, 1794304800123)

        # 拦截布尔值或非正数时间戳
        with self.assertRaises(AbiValidationError):
            extract_event_time_and_strip({"#time": True})
        with self.assertRaises(AbiValidationError):
            extract_event_time_and_strip({"#time": -100})

    def test_super_properties_precedence_and_user_event_isolation(self) -> None:
        """测试公共属性优先级（`super < dynamic_super < explicit`）及 `$user_*` 画像事件隔离。"""
        staging = StagingConsumer(project_id=1, project_token="tok_test")
        sdk = AbiAnalytics(staging)

        sdk.set_super_properties(
            {
                "env": "prod",
                "region": "static-region",
                "override_me": "from-static",
                "temp_key": "remove_me",
            }
        )
        sdk.unset_super_property("temp_key")
        self.assertNotIn("temp_key", sdk.get_super_properties())

        sdk.set_dynamic_super_properties(
            lambda: {
                "region": "dynamic-region",
                "override_me": "from-dynamic",
                "dyn_counter": 9007199254740995,
            }
        )

        sdk.track(
            account_id="u_1",
            distinct_id="anon_1",
            event_name="OrderPaid",
            properties={
                "override_me": "from-explicit",
                "#ip": "198.51.100.7",
            },
        )
        sdk.user_set(
            account_id="u_1",
            distinct_id="anon_1",
            properties={"vip_level": 5},
        )

        events = staging.events
        self.assertEqual(len(events), 2)

        track_props = events[0]["properties"]
        self.assertEqual(track_props["env"], "prod")
        self.assertEqual(track_props["region"], "dynamic-region")
        self.assertEqual(track_props["override_me"], "from-explicit")
        self.assertEqual(track_props["dyn_counter"], "9007199254740995")
        self.assertEqual(track_props["#ip"], "198.51.100.7")

        # 画像事件不得混入静态或动态公共属性
        user_props = events[1]["properties"]
        self.assertEqual(user_props, {"vip_level": 5})

        sdk.clear_super_properties()
        self.assertEqual(sdk.get_super_properties(), {})

    def test_all_analytics_methods_and_staging_consumer(self) -> None:
        """测试 `AbiAnalytics` 全方法集与 `StagingConsumer.confirm_submit` / `submit_to_gateway`。"""
        staging = StagingConsumer(project_id=1, project_token="tok_full", dry_run=True)
        sdk = AbiAnalytics(staging)

        sdk.track("acc_100", "vis_100", "$login", {"method": "sso"})
        sdk.track("acc_100", "vis_100", "ItemViewed", {"sku": "s1"})
        sdk.track(
            "acc_100",
            "vis_100",
            "OrderPaid",
            {"status": "PAID"},
            event_id="evt_ord_1",
        )

        # D7① / G6 门禁：未开放接口必须显式抛出 NotImplementedError 且绝不入队伪造 track 事件
        with self.assertRaises(NotImplementedError):
            sdk.track_first(
                "acc_100", "vis_100", "FirstActivate", "chk_001", {"channel": "web"}
            )
        with self.assertRaises(NotImplementedError):
            sdk.track_update(
                "acc_100", "vis_100", "OrderState", "evt_ord_1", {"status": "PAID"}
            )
        with self.assertRaises(NotImplementedError):
            sdk.track_overwrite(
                "acc_100", "vis_100", "OrderState", "evt_ord_1", {"status": "CLOSED"}
            )

        sdk.user_set("acc_100", "vis_100", {"name": "Alice"})
        sdk.user_set_once("acc_100", "vis_100", {"init_src": "organic"})
        sdk.user_add("acc_100", "vis_100", {"points": 10})
        sdk.user_append("acc_100", "vis_100", {"tags": ["a", "b"]})
        sdk.user_uniq_append("acc_100", "vis_100", {"tags": ["b", "c"]})
        sdk.user_unset("acc_100", "vis_100", "obsolete_1", "obsolete_2")
        sdk.user_delete("acc_100", "vis_100")

        # user_add 传入 bool 必须报错
        with self.assertRaises(AbiValidationError):
            sdk.user_add("acc_100", "vis_100", {"bad_bool": True})

        payload = staging.build_request_payload()
        self.assertEqual(payload["project_id"], 1)
        self.assertTrue(payload["dry_run"])
        self.assertEqual(len(payload["events"]), 10)

        event_names = [e["event_name"] for e in payload["events"]]
        self.assertEqual(
            event_names,
            [
                "$login",
                "ItemViewed",
                "OrderPaid",
                "$user_set",
                "$user_set_once",
                "$user_add",
                "$user_append",
                "$user_uniq_append",
                "$user_unset",
                "$user_del",
            ],
        )
        self.assertEqual(payload["events"][2]["event_id"], "evt_ord_1")

        # 测试 confirm_submit 转交至另一个 Consumer
        target_staging = StagingConsumer(project_id=2, project_token="tok_target")
        staging.confirm_submit(target_staging)
        self.assertEqual(len(target_staging.events), 10)

        staging.clear()
        self.assertEqual(len(staging.events), 0)

    def test_batch_consumer_gzip_and_retry_preserves_event_id(self) -> None:
        """测试 `BatchConsumer` Gzip 压缩、HTTP 429/503 重试及 `event_id` 幂等保持。"""
        server = _TestGatewayServer()
        try:
            # 前两次返回 429 与 503，第三次返回 200
            server.status_sequence = [429, 503, 200]
            consumer = BatchConsumer(
                server_url=server.base_url,
                project_id=10,
                project_token="tok_batch",
                batch_size=2,
                flush_interval=60.0,
                compress_gzip=True,
                max_retries=3,
            )
            sdk = AbiAnalytics(consumer)
            sdk.track(
                account_id="u_retry",
                distinct_id="anon_retry",
                event_name="PaymentConfirmed",
                event_id="fixed_evt_id_001",
                properties={"order_id": 9007199254740999},
            )
            sdk.close()

            self.assertEqual(len(server.requests), 3)
            for idx, req_payload in enumerate(server.requests):
                self.assertEqual(
                    req_payload["events"][0]["event_id"], "fixed_evt_id_001"
                )
                self.assertEqual(
                    req_payload["events"][0]["properties"]["order_id"],
                    "9007199254740999",
                )
                self.assertEqual(
                    server.headers_history[idx].get("content-encoding"), "gzip"
                )
        finally:
            server.close()

    def test_logger_consumer_utc_date_rotation(self) -> None:
        """测试 `LoggerConsumer` 按 UTC 日期自动切分本地 `.jsonl` 文件。"""
        with tempfile.TemporaryDirectory() as tmpdir:
            current_dt = [datetime(2026, 11, 10, 23, 59, 0, tzinfo=timezone.utc)]
            logger_consumer = LoggerConsumer(
                directory=tmpdir,
                file_prefix="abi.log",
                rotate_mode="DAILY",
                now_func=lambda: current_dt[0],
            )
            sdk = AbiAnalytics(logger_consumer)
            sdk.track("u_1", "anon_1", "DayOneEvent", {"step": 1})

            # 跨天切换至 2026-11-11
            current_dt[0] = datetime(2026, 11, 11, 0, 1, 0, tzinfo=timezone.utc)
            sdk.track("u_1", "anon_1", "DayTwoEvent", {"step": 2})
            sdk.close()

            file_day1 = Path(tmpdir) / "abi.log.2026-11-10.jsonl"
            file_day2 = Path(tmpdir) / "abi.log.2026-11-11.jsonl"
            self.assertTrue(file_day1.is_file())
            self.assertTrue(file_day2.is_file())

            evt1 = json.loads(file_day1.read_text(encoding="utf-8").strip())
            evt2 = json.loads(file_day2.read_text(encoding="utf-8").strip())
            self.assertEqual(evt1["event_name"], "DayOneEvent")
            self.assertEqual(evt2["event_name"], "DayTwoEvent")

    def test_debug_consumer_sync_validation(self) -> None:
        """测试 `DebugConsumer` 同步发送 `debug: True`、`dry_run` 及网关错误捕获。"""
        server = _TestGatewayServer()
        try:
            debug_consumer = DebugConsumer(
                server_url=server.base_url,
                project_id=1,
                project_token="tok_dbg",
                dry_run=True,
            )
            sdk = AbiAnalytics(debug_consumer)
            sdk.track("u_1", "anon_1", "DebugOkEvent", {"k": "v"})

            self.assertEqual(len(server.requests), 1)
            self.assertTrue(server.requests[0]["debug"])
            self.assertTrue(server.requests[0]["dry_run"])

            # 模拟网关返回 L4 校验拒绝
            server.custom_response = {
                "code": 200,
                "message": "success",
                "request_id": "req_dbg_reject",
                "data": {
                    "accepted": 0,
                    "rejected": 1,
                    "dry_run": True,
                    "errors": [
                        {
                            "index": 0,
                            "event_name": "DebugBadEvent",
                            "reason": "property type mismatch in metadata registry",
                        }
                    ],
                },
            }
            with self.assertRaises(AbiGatewayError) as ctx:
                sdk.track("u_1", "anon_1", "DebugBadEvent", {"k": "v"})
            self.assertIn("property type mismatch", str(ctx.exception))
        finally:
            server.close()

    def test_two_step_demo_preview_and_confirm(self) -> None:
        """测试 `examples/demo.py` 两步式预览请求 JSON 与确认提交全流程。"""
        cfg = DemoConfig(scenario="all", dry_run=True)
        preview_json, staging = build_demo_request_preview(cfg)
        preview_obj = json.loads(preview_json)
        self.assertEqual(preview_obj["project_id"], 1)
        self.assertTrue(preview_obj["dry_run"])
        self.assertGreaterEqual(len(preview_obj["events"]), 10)

        envelope, resp_json = confirm_submit_demo(staging, cfg)
        self.assertEqual(envelope["code"], 200)
        self.assertEqual(envelope["data"]["accepted"], len(preview_obj["events"]))
        self.assertTrue(json.loads(resp_json)["data"]["dry_run"])


if __name__ == "__main__":
    unittest.main()
