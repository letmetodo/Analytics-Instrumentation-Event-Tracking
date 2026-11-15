#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Unit tests for ABI LogBus (`abi_logbus.py`) and DataX template contract."""

from __future__ import annotations

import json
from pathlib import Path
import tempfile
import unittest

import abi_logbus


HERE = Path(__file__).resolve().parent
SPEC_DIR = HERE.parent / "spec" / "test-vectors"


class TestAbiLogbus(unittest.TestCase):
    def test_identity_golden_vectors(self) -> None:
        cases_doc = json.loads((SPEC_DIR / "identity_cases.json").read_text(encoding="utf-8"))
        self.assertEqual(cases_doc["max_distinct_id_bytes"], abi_logbus.MAX_DISTINCT_ID_BYTES)
        self.assertEqual(cases_doc["max_login_id_bytes"], abi_logbus.MAX_LOGIN_ID_BYTES)

        for case in cases_doc["cases"]:
            raw = {
                "event_name": "OrderPaid",
                "distinct_id": case["distinct_id"],
                "login_id": case["login_id"],
                "timestamp": 1762768800000,
                "properties": {"amount": 10},
            }
            if case["valid"]:
                norm = abi_logbus.normalize_event_record(raw)
                self.assertEqual(norm["distinct_id"], case["normalized_distinct_id"], case["name"])
                self.assertEqual(norm.get("login_id", ""), case["normalized_login_id"], case["name"])
            else:
                with self.assertRaises(ValueError, msg=case["name"]):
                    abi_logbus.normalize_event_record(raw)

    def test_event_and_property_golden_vectors(self) -> None:
        cases_doc = json.loads((SPEC_DIR / "event_and_property_cases.json").read_text(encoding="utf-8"))
        self.assertEqual(cases_doc["max_safe_integer"], abi_logbus.MAX_SAFE_INTEGER)

        for case in cases_doc["event_name_cases"]:
            raw = {
                "event_name": case["event_name"],
                "distinct_id": "vis_01",
                "timestamp": 1762768800000,
                "properties": {"amount": 1},
            }
            if case["valid"]:
                norm = abi_logbus.normalize_event_record(raw)
                self.assertEqual(norm["event_name"], case["event_name"])
            else:
                with self.assertRaises(ValueError, msg=case["event_name"]):
                    abi_logbus.normalize_event_record(raw)

        for case in cases_doc["property_key_cases"]:
            raw = {
                "event_name": "OrderPaid",
                "distinct_id": "vis_01",
                "timestamp": 1762768800000,
                "properties": {case["key"]: "v"},
            }
            if case["valid"]:
                norm = abi_logbus.normalize_event_record(raw)
                self.assertIn(case["key"], norm["properties"])
            else:
                with self.assertRaises(ValueError, msg=case["key"]):
                    abi_logbus.normalize_event_record(raw)

    def test_long_login_id_never_copied_into_distinct_id(self) -> None:
        long_login_id = "u" * 100
        norm = abi_logbus.normalize_event_record(
            {
                "event_id": "evt_100b_login",
                "event_name": "OrderPaid",
                "distinct_id": "",
                "login_id": long_login_id,
                "properties": {
                    "#time": "2026-11-10T10:00:05Z",
                    "order_id": 9007199254740993,
                    "#ip": "203.0.113.88",
                },
            }
        )
        self.assertEqual(norm["distinct_id"], "")
        self.assertEqual(norm["login_id"], long_login_id)
        self.assertEqual(norm["timestamp"], 1794304805000)
        self.assertNotIn("#time", norm["properties"])
        self.assertEqual(norm["properties"]["order_id"], "9007199254740993")
        self.assertEqual(norm["properties"]["#ip"], "203.0.113.88")

    def test_demo_preview_and_submit(self) -> None:
        rc_preview = abi_logbus.run_demo(confirm_yes=False, preview_only=True)
        self.assertEqual(rc_preview, 0)
        rc_submit = abi_logbus.run_demo(confirm_yes=True, preview_only=False)
        self.assertEqual(rc_submit, 0)

    def test_offset_checkpoint_roundtrip(self) -> None:
        with tempfile.TemporaryDirectory(prefix="abi_logbus_ut_") as tmp:
            log_dir = Path(tmp)
            jsonl_path = log_dir / "abi.log.2026-11-10"
            records = [
                {
                    "event_id": "evt_dual_1",
                    "event_name": "$login",
                    "distinct_id": "vis_01",
                    "login_id": "acct_01",
                    "timestamp": 1762768800000,
                    "properties": {"#ip": "203.0.113.88"},
                }
            ]
            jsonl_path.write_text("\n".join(json.dumps(r) for r in records) + "\n", encoding="utf-8")
            events, next_offset = abi_logbus.read_next_batch(jsonl_path, 0, 10)
            self.assertEqual(len(events), 1)
            self.assertEqual(events[0]["event_name"], "$login")
            self.assertEqual(events[0]["distinct_id"], "vis_01")
            self.assertEqual(events[0]["login_id"], "acct_01")
            self.assertGreater(next_offset, 0)

    def test_datax_template_uses_dual_id_only(self) -> None:
        datax_path = HERE / "datax" / "ta-datax-abi-writer.json"
        doc = json.loads(datax_path.read_text(encoding="utf-8"))
        col_map = doc["job"]["content"][0]["writer"]["parameter"]["columnMapping"]
        self.assertIn("distinct_id", col_map)
        self.assertIn("login_id", col_map)
        self.assertEqual(set(col_map.keys()), {"event_id", "login_id", "distinct_id", "timestamp", "properties"})


if __name__ == "__main__":
    unittest.main()
