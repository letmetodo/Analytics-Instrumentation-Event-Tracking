#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ABI Python 3 服务端 SDK 两步式交互与方法级演示程序（`examples/demo.py`）。

交互与调用流程遵循统一的两阶段设计：
- 第 1 步（预览阶段）：根据场景参数与公共属性配置，通过 `StagingConsumer` 构造并打印唯一一份
  `POST /collect/api/v1/track/batch` 请求 JSON 报文（此阶段零网络请求，可反复调整参数预览）；
- 第 2 步（确认提交阶段）：在交互式终端等待用户输入 `[y/N]` 确认（或传入 `--yes` 自动确认），
  确认后向 ABI 采集网关（未指定 `--server-url` 时自动启动本地临时 Mock 网关）提交请求并打印唯一一份响应 JSON。
"""

from __future__ import annotations

import argparse
import gzip
import http.server
import json
import os
import sys
import threading
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Optional, Tuple

# 确保从任意工作目录直接执行本脚本时均可导入上级目录中的 abi_sdk
_SDK_ROOT = Path(__file__).resolve().parents[1]
if str(_SDK_ROOT) not in sys.path:
    sys.path.insert(0, str(_SDK_ROOT))

from abi_sdk import (  # noqa: E402
    AbiAnalytics,
    AbiValidationError,
    StagingConsumer,
)

DEFAULT_SUPER_PROPS_JSON = (
    '{"$app_version":"2.5.0","$platform":"PythonServer","service_name":"order-service"}'
)


@dataclass
class DemoConfig:
    """两步式演示（第 1 步预览请求 JSON -> 第 2 步确认提交）的参数配置。"""

    server_url: str = ""
    project_id: int = 1
    project_token: str = "abi_tok_demo_py"
    scenario: str = "all"
    super_props_json: str = DEFAULT_SUPER_PROPS_JSON
    enable_dynamic_super: bool = True
    dry_run: bool = False
    compress_gzip: bool = True


def trigger_anonymous_browse_demo(sdk: AbiAnalytics) -> None:
    """场景 1：匿名访客浏览商品行为事件（`$pageview`、`ProductViewed`）。"""
    vis_id = "vis_py_7f8e9a01"
    client_ip = "203.0.113.42"

    sdk.track(
        account_id="",
        distinct_id=vis_id,
        event_name="$pageview",
        properties={
            "#ip": client_ip,
            "$url": "https://store.example.com/products/bi-enterprise",
            "$url_path": "/products/bi-enterprise",
            "$title": "ABI Enterprise Edition",
            "$referrer": "https://www.google.com",
        },
    )

    sdk.track(
        account_id="",
        distinct_id=vis_id,
        event_name="ProductViewed",
        properties={
            "#ip": client_ip,
            "product_id": "sku_abi_ent_2026",
            "product_name": "ABI Enterprise Analytics Suite",
            "category": "SaaS",
            "price": 2999.00,
        },
    )


def trigger_login_identity_bind_demo(sdk: AbiAnalytics) -> None:
    """场景 2：用户注册与登录（同时携带 `account_id` + `distinct_id` 由 Flink 自动关联身份）。"""
    account_id = "acct_900102"
    vis_id = "vis_py_7f8e9a01"
    client_ip = "203.0.113.42"

    sdk.track(
        account_id=account_id,
        distinct_id=vis_id,
        event_name="$signup",
        properties={
            "#ip": client_ip,
            "signup_channel": "github_oauth",
        },
    )

    sdk.track(
        account_id=account_id,
        distinct_id=vis_id,
        event_name="$login",
        properties={
            "#ip": client_ip,
            "login_method": "sso_oidc",
            "mfa_verified": True,
        },
    )


def trigger_order_lifecycle_demo(sdk: AbiAnalytics) -> None:
    """
    场景 3：核心交易订单里程碑事件（使用 `track(..., event_id=...)` 保障同日重试幂等）。
    演示 `#ip` 客户端真实 IP、`#time` 业务发生时间提取，以及超过 `2^53 - 1` 的 64 位雪花 ID 自动转字符串保护。
    """
    account_id = "acct_900102"
    vis_id = "vis_py_7f8e9a01"
    client_ip = "203.0.113.42"
    snowflake_order_id = 9007199254740999  # > 2^53 - 1 (9007199254740991)，自动序列化为字符串

    sdk.track(
        account_id=account_id,
        distinct_id=vis_id,
        event_name="OrderCreated",
        event_id="ord_created_20261110_8801",
        properties={
            "#ip": client_ip,
            "#time": "2026-11-10T10:00:00Z",
            "order_no": "ORD-20261110-8801",
            "snowflake_id": snowflake_order_id,
            "order_status": "CREATED",
            "payable_amount": 2999.00,
            "item_sku_list": ["sku_abi_ent_2026", "sku_addon_flink"],
            "sub_task_ids": [1001, 9007199254741024],
        },
    )

    sdk.track(
        account_id=account_id,
        distinct_id=vis_id,
        event_name="OrderPaid",
        event_id="ord_paid_20261110_8801",
        properties={
            "#ip": client_ip,
            "order_no": "ORD-20261110-8801",
            "snowflake_id": snowflake_order_id,
            "order_status": "PAID",
            "payable_amount": 2549.15,
            "coupon_code": "FIRST_ORDER_50",
            "discount_rate": 0.85,
            "payment_channel": "stripe_enterprise",
        },
    )

    sdk.track(
        account_id=account_id,
        distinct_id=vis_id,
        event_name="OrderFulfilled",
        event_id="ord_fulfilled_20261110_8801",
        properties={
            "#ip": client_ip,
            "order_no": "ORD-20261110-8801",
            "snowflake_id": snowflake_order_id,
            "order_status": "FULFILLED",
            "payable_amount": 2549.15,
            "invoice_issued": True,
            "fulfilled_at": datetime(2026, 11, 10, 10, 5, 0, tzinfo=timezone.utc),
        },
    )


def trigger_user_profile_demo(sdk: AbiAnalytics) -> None:
    """
    场景 4：全部 7 类用户画像操作（自动隔离静态与动态公共属性）：
    `user_set`、`user_set_once`、`user_add`、`user_append`、`user_uniq_append`、`user_unset`、`user_delete`。
    """
    account_id = "acct_900102"
    vis_id = "vis_py_7f8e9a01"

    sdk.user_set(
        account_id=account_id,
        distinct_id=vis_id,
        properties={
            "company_name": "Acme Analytics Corp",
            "plan_tier": "Enterprise",
            "seat_count": 50,
            "$city": "Shanghai",
        },
    )

    sdk.user_set_once(
        account_id=account_id,
        distinct_id=vis_id,
        properties={
            "first_utm_source": "github_release",
            "activated_at": datetime(2026, 11, 10, 8, 0, 0, tzinfo=timezone.utc),
        },
    )

    sdk.user_add(
        account_id=account_id,
        distinct_id=vis_id,
        properties={
            "cumulative_payment": 2549.15,
            "order_count": 1,
        },
    )

    sdk.user_append(
        account_id=account_id,
        distinct_id=vis_id,
        properties={
            "enabled_modules": ["event_analysis", "funnel_analysis"],
        },
    )

    sdk.user_uniq_append(
        account_id=account_id,
        distinct_id=vis_id,
        properties={
            "enabled_modules": ["funnel_analysis", "retention_analysis", "sql_ide"],
        },
    )

    sdk.user_unset(
        account_id,
        vis_id,
        "legacy_trial_tag",
        "onboarding_banner_dismissed",
    )

    sdk.user_delete(
        account_id="acct_gdpr_erased_01",
        distinct_id="vis_gdpr_erased_01",
    )


def build_demo_request_preview(cfg: DemoConfig) -> Tuple[str, StagingConsumer]:
    """
    第 1 步：根据 `DemoConfig` 初始化 `StagingConsumer` 与 `AbiAnalytics`，录制指定场景事件，
    并返回唯一一份格式化缩进后的 `POST /collect/api/v1/track/batch` 请求 JSON 字符串（零网络副作用）。
    """
    staging = StagingConsumer(
        project_id=cfg.project_id,
        project_token=cfg.project_token,
        dry_run=cfg.dry_run,
    )
    sdk = AbiAnalytics(staging)

    if cfg.super_props_json and cfg.super_props_json.strip():
        try:
            parsed_super = json.loads(cfg.super_props_json)
        except json.JSONDecodeError as exc:
            raise AbiValidationError(f"解析 --super-props JSON 失败: {exc}") from exc
        if not isinstance(parsed_super, dict):
            raise AbiValidationError("--super-props 顶层必须是 JSON 对象 (object)")
        if parsed_super:
            sdk.set_super_properties(parsed_super)

    if cfg.enable_dynamic_super:
        sdk.set_dynamic_super_properties(
            lambda: {
                "server_region": "ap-shanghai",
                "active_threads": threading.active_count(),
            }
        )

    scenario = (cfg.scenario or "all").strip().lower()
    if scenario == "browse":
        trigger_anonymous_browse_demo(sdk)
    elif scenario == "identity":
        trigger_login_identity_bind_demo(sdk)
    elif scenario == "order":
        trigger_order_lifecycle_demo(sdk)
    elif scenario == "profile":
        trigger_user_profile_demo(sdk)
    elif scenario == "all":
        trigger_anonymous_browse_demo(sdk)
        trigger_login_identity_bind_demo(sdk)
        trigger_order_lifecycle_demo(sdk)
        trigger_user_profile_demo(sdk)
    else:
        raise AbiValidationError(
            f"未知的 --scenario 参数值 {scenario!r}（可选值：browse | identity | order | profile | all）"
        )

    return staging.preview_request_json(indent=2), staging


def start_embedded_mock_gateway() -> Tuple[str, Callable[[], None]]:
    """在本地随机端口启动静默的内置 Mock 采集网关（支持 Gzip 解压并返回标准网关响应信封）。"""
    seq_lock = threading.Lock()
    batch_seq = {"val": 0}

    class _MockGatewayHandler(http.server.BaseHTTPRequestHandler):
        def do_POST(self) -> None:  # noqa: N802
            if self.path != "/collect/api/v1/track/batch":
                self.send_error(404, "Not Found")
                return
            content_len = int(self.headers.get("Content-Length", "0"))
            raw_body = self.rfile.read(content_len)
            if self.headers.get("Content-Encoding", "").lower() == "gzip":
                raw_body = gzip.decompress(raw_body)
            payload = json.loads(raw_body.decode("utf-8"))
            events = payload.get("events") or []
            with seq_lock:
                batch_seq["val"] += 1
                seq = batch_seq["val"]

            resp_obj = {
                "code": 200,
                "message": "success",
                "request_id": f"req_mock_py_{seq}",
                "data": {
                    "accepted": len(events),
                    "rejected": 0,
                    "dry_run": bool(payload.get("dry_run", False)),
                },
            }
            resp_bytes = json.dumps(resp_obj, ensure_ascii=False).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(resp_bytes)))
            self.end_headers()
            self.wfile.write(resp_bytes)

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            # 保持终端输出干净，仅打印唯一请求预览与唯一响应结果
            return

    server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _MockGatewayHandler)
    port = server.server_address[1]
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()

    def _close() -> None:
        server.shutdown()
        server.server_close()

    return f"http://127.0.0.1:{port}", _close


def confirm_submit_demo(
    staging: StagingConsumer, cfg: DemoConfig
) -> Tuple[Dict[str, Any], str]:
    """
    第 2 步：在用户确认请求 JSON 无误后，将 `StagingConsumer` 中暂存的事件批量提交至 ABI 采集网关
    （当 `cfg.server_url` 为空时自动启动内置本地 Mock 网关），并返回响应字典与格式化 JSON 字符串。
    """
    target_url = (cfg.server_url or "").strip()
    close_fn: Optional[Callable[[], None]] = None
    if not target_url:
        target_url, close_fn = start_embedded_mock_gateway()

    try:
        envelope = staging.submit_to_gateway(
            server_url=target_url,
            compress_gzip=cfg.compress_gzip,
        )
        resp_json = json.dumps(envelope, indent=2, ensure_ascii=False)
        return envelope, resp_json
    finally:
        if close_fn is not None:
            close_fn()


def _is_interactive_terminal() -> bool:
    """判断当前标准输入是否为真实交互式终端（排除管道与 /dev/null）。"""
    if not sys.stdin or not sys.stdin.isatty():
        return False
    try:
        stdin_stat = os.fstat(sys.stdin.fileno())
        devnull_stat = os.stat(os.devnull)
        if os.path.samestat(stdin_stat, devnull_stat):
            return False
    except OSError:
        return False
    return True


def main(argv: Optional[ list[str] ] = None) -> int:
    parser = argparse.ArgumentParser(
        description="ABI Python 3 服务端 SDK 两步式（1. 预览请求 JSON -> 2. 确认提交）演示程序"
    )
    parser.add_argument(
        "--server-url",
        default="",
        help="ABI 采集网关地址（默认留空，确认提交时自动启动内置本地 Mock 网关）",
    )
    parser.add_argument(
        "--project-id",
        type=int,
        default=1,
        help="ABI 项目数字 ID（默认: 1）",
    )
    parser.add_argument(
        "--token",
        default="abi_tok_demo_py",
        help="ABI 项目采集 Token",
    )
    parser.add_argument(
        "--scenario",
        default="all",
        choices=["browse", "identity", "order", "profile", "all"],
        help="演示场景：browse | identity | order | profile | all（默认: all）",
    )
    parser.add_argument(
        "--super-props",
        default=DEFAULT_SUPER_PROPS_JSON,
        help="自定义静态公共属性 JSON 字符串（传 '{}' 可不注入静态公共属性）",
    )
    parser.add_argument(
        "--no-dynamic-super",
        action="store_true",
        help="禁用动态公共属性回调",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="开启 dry_run=true（网关仅校验不落库）",
    )
    parser.add_argument(
        "--yes",
        "-y",
        action="store_true",
        help="自动确认提交（跳过终端 [y/N] 交互提示直接发送）",
    )

    args = parser.parse_args(argv)
    cfg = DemoConfig(
        server_url=args.server_url,
        project_id=args.project_id,
        project_token=args.token,
        scenario=args.scenario,
        super_props_json=args.super_props,
        enable_dynamic_super=not args.no_dynamic_super,
        dry_run=args.dry_run,
        compress_gzip=True,
    )

    try:
        preview_json, staging = build_demo_request_preview(cfg)
    except Exception as exc:
        print(f"[错误] 生成请求 JSON 预览失败: {exc}", file=sys.stderr)
        return 1

    print("=== 待提交请求 JSON 预览 (POST /collect/api/v1/track/batch) ===")
    print(preview_json)

    if not args.yes and _is_interactive_terminal():
        try:
            answer = input("\n是否确认提交上述请求参数？[y/N]: ")
        except EOFError:
            answer = "n"
        if answer.strip().lower() not in ("y", "yes"):
            print("已取消提交，未向采集网关发送任何请求。")
            return 0

    try:
        _, resp_json = confirm_submit_demo(staging, cfg)
    except Exception as exc:
        print(f"[错误] 提交请求至采集网关失败: {exc}", file=sys.stderr)
        return 1

    print("\n=== 提交响应结果 (Response JSON) ===")
    print(resp_json)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
