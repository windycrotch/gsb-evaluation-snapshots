"""VulnScanner 注入点来源 / 重定向逐跳 / 结果可追溯的补充测试。

全部使用本地自造的假 fetcher 与假 provider，不发起真实网络请求：

1. 正常命中（默认 q、params、显式参数名）并带上可追溯字段；
2. 重定向到云元数据被 SSRF 拦截：不产生 finding、汇总里计数、不请求内网；
3. 跳数超限：到达上限即停止，不把 3xx 响应体当作证据；
4. params 带原始值：原始值参与拼装且可从结果追溯。
"""

from __future__ import annotations

import json
import socket
from typing import Any
from unittest.mock import patch

import pytest

from web_crawler.pentest.vuln_scanner import (
    SOURCE_DEFAULT,
    SOURCE_EXPLICIT,
    SOURCE_ORIGINAL_VALUE,
    SOURCE_PARAMS,
    VulnFinding,
    VulnScanner,
    VulnScanResult,
    _inject,
    _resolve_test_params,
)

# ---------------------------------------------------------------------------
# 假对象
# ---------------------------------------------------------------------------


class _FakeResponse:
    """兼容 pentest 各模块 ``_normalize`` 的响应假对象。"""

    def __init__(
        self,
        status_code: int = 200,
        text: str = "",
        headers: dict[str, str] | None = None,
    ) -> None:
        self.status_code = status_code
        self.text = text
        self.headers = headers or {}
        self.content = text.encode("utf-8", errors="replace")


class _FakeFetcher:
    """按 URL 返回预置响应的假 fetcher（non-httpx 分支，allow_redirects 参数）。"""

    def __init__(self, responses: Any) -> None:
        self._responses = responses
        self.calls: list[str] = []

    def get(
        self,
        url: str,
        *,
        headers: dict[str, str] | None = None,
        allow_redirects: bool = False,
        timeout: float = 10.0,
    ) -> _FakeResponse:
        self.calls.append(url)
        if callable(self._responses):
            return self._responses(url)
        return self._responses


class _FakeProvider:
    """假 LLMProvider：固定返回一段 JSON。"""

    def __init__(self, content: str) -> None:
        self._content = content
        self.chat_calls: list[Any] = []

    def chat(self, messages: Any, **kwargs: Any) -> Any:
        self.chat_calls.append(messages)

        class _R:
            content = self._content

        return _R()


def _public_dns(host: str, *a: object, **kw: object) -> list[tuple]:
    """让所有公网主机名解析到公网地址，避免测试触网。"""
    return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]


# ---------------------------------------------------------------------------
# 注入点来源解析
# ---------------------------------------------------------------------------


def test_default_param_is_q_with_default_source() -> None:
    """params 与 param_names 都为空时默认探测 q，来源标记 default。"""
    assert _resolve_test_params(None, None) == [("q", SOURCE_DEFAULT, None)]
    assert _resolve_test_params({}, []) == [("q", SOURCE_DEFAULT, None)]


def test_params_keys_decide_names_and_empty_values_are_plain() -> None:
    """params 的键决定参数名；空值不产生原始值。"""
    assert _resolve_test_params({"id": ""}, None) == [("id", SOURCE_PARAMS, None)]


def test_params_non_empty_value_becomes_original_value() -> None:
    """params 非空字符串值作为原始值参与拼装。"""
    assert _resolve_test_params({"id": "42"}, None) == [("id", SOURCE_ORIGINAL_VALUE, "42")]


def test_param_names_merge_with_params_without_overriding() -> None:
    """显式 param_names 与 params 取并集，互不覆盖。"""
    resolved = _resolve_test_params({"id": "7"}, ["search"])
    assert ("id", SOURCE_ORIGINAL_VALUE, "7") in resolved
    assert ("search", SOURCE_EXPLICIT, None) in resolved
    assert len(resolved) == 2


def test_param_names_alone_are_explicit_source() -> None:
    """仅传 param_names 时只测这些参数名，来源标记 explicit。"""
    assert _resolve_test_params(None, ["a", "b"]) == [
        ("a", SOURCE_EXPLICIT, None),
        ("b", SOURCE_EXPLICIT, None),
    ]


def test_param_names_single_string_is_not_split_into_chars() -> None:
    """误传字符串 param_names 时按一个参数名处理，而非逐字符拆分。"""
    assert _resolve_test_params(None, "search") == [("search", SOURCE_EXPLICIT, None)]
    scanner = VulnScanner(fetcher=_FakeFetcher(_FakeResponse(text="clean")))
    result = scanner.scan("http://example.com/", param_names="search")  # type: ignore[arg-type]
    assert {p.param for p in result.summary.probes} == {"search"}


# ---------------------------------------------------------------------------
# 正常命中 + 可追溯字段
# ---------------------------------------------------------------------------


def test_scan_default_q_hit_is_traceable() -> None:
    """默认 q 命中时 finding 标记 param_source=default 且 redirects=0。"""
    fetcher = _FakeFetcher(_FakeResponse(text="Error: SQL syntax error"))
    scanner = VulnScanner(fetcher=fetcher)
    result = scanner.scan("http://example.com/?q=test")
    assert isinstance(result, VulnScanResult)
    assert result.findings
    finding = next(f for f in result.findings if f.type == "sql_injection")
    assert finding.param == "q"
    assert finding.param_source == SOURCE_DEFAULT
    assert finding.original_value is None
    assert finding.redirects == 0
    # 汇总可追溯：q 实际测了全部 payload
    probe = result.summary.probes[0]
    assert probe.param == "q"
    assert probe.source == SOURCE_DEFAULT
    assert probe.payloads_tested > 0
    assert probe.findings >= 1


def test_scan_param_names_only_tests_given_names() -> None:
    """param_names 只测指定参数名，不额外探测默认 q。"""
    fetcher = _FakeFetcher(_FakeResponse(text="clean page"))
    scanner = VulnScanner(fetcher=fetcher)
    result = scanner.scan("http://example.com/", param_names=["search"])
    assert {p.param for p in result.summary.probes} == {"search"}
    assert result.summary.probes[0].source == SOURCE_EXPLICIT
    assert all("search=" in url and "q=" not in url for url in fetcher.calls)


def test_scan_params_with_original_value_keeps_it_in_request_and_report() -> None:
    """params 带原始值时注入值为「原始值 + payload」，结果里可追溯。"""
    fetcher = _FakeFetcher(_FakeResponse(text="<script>alert(1)</script>"))
    scanner = VulnScanner(fetcher=fetcher)
    result = scanner.scan("http://example.com/item", params={"id": "100"})
    # 请求里原始值与 payload 拼在一起
    assert any("id=100%3Cscript%3Ealert%281%29%3C%2Fscript%3E" in u for u in fetcher.calls)
    hit = next(f for f in result.findings if f.type == "xss")
    assert hit.param == "id"
    assert hit.original_value == "100"
    assert hit.param_source == SOURCE_ORIGINAL_VALUE
    # to_dict 保留新增字段
    d = hit.to_dict()
    assert d["param_source"] == SOURCE_ORIGINAL_VALUE
    assert d["original_value"] == "100"


def test_inject_with_original_value_prefixes_payload() -> None:
    """_inject 在给定原始值时把 payload 追加到原始值之后。"""
    url = _inject("https://example.com/?a=1", "id", "'", original_value="42")
    assert "id=42%27" in url
    assert "a=1" in url


def test_scan_reports_skipped_empty_param_name() -> None:
    """空参数名无法构造注入点，汇总里给出跳过原因而不是静默跳过。"""
    scanner = VulnScanner(fetcher=_FakeFetcher(_FakeResponse(text="clean")))
    result = scanner.scan("http://example.com/", params={"": ""})
    probe = result.summary.probes[0]
    assert probe.skipped_reason == "empty_param_name"
    assert probe.payloads_tested == 0
    assert result.summary.skipped_params == [""]


def test_scan_url_still_returns_list_and_sets_last_summary() -> None:
    """旧接口 scan_url 仍返回 list，同时 last_summary 可查看拦截计数。"""
    scanner = VulnScanner(fetcher=_FakeFetcher(_FakeResponse(text="clean")))
    findings = scanner.scan_url("http://example.com/", params={"q": ""})
    assert findings == []
    assert scanner.last_summary is not None
    assert scanner.last_summary.blocked_count == 0


def test_scan_network_failure_counted_as_failed_not_clean() -> None:
    """请求异常时计入 failed_count，避免"没扫到"被误读成"没问题"。"""

    class _BoomFetcher:
        def __init__(self) -> None:
            self.calls: list[str] = []

        def get(self, url: str, **kwargs: Any) -> Any:
            self.calls.append(url)
            raise ConnectionError("network down")

    scanner = VulnScanner(fetcher=_BoomFetcher())
    result = scanner.scan("http://example.com/", param_names=["q"])
    assert result.findings == []
    probe = result.summary.probes[0]
    assert probe.failed == probe.payloads_tested > 0
    assert result.summary.failed_count == probe.payloads_tested


# ---------------------------------------------------------------------------
# 重定向逐跳跟随
# ---------------------------------------------------------------------------


def test_redirect_followed_to_public_target_and_counted() -> None:
    """3xx + Location 指向公网时逐跳跟随，finding 记录跳数。"""

    def responses(url: str) -> _FakeResponse:
        if url.startswith("http://example.com/start"):
            return _FakeResponse(status_code=302, headers={"Location": "http://final.example/"})
        if url.startswith("http://final.example/"):
            return _FakeResponse(text="Error: SQL syntax error near 'x'")
        return _FakeResponse(text="clean")

    fetcher = _FakeFetcher(responses)
    scanner = VulnScanner(fetcher=fetcher)
    with patch("socket.getaddrinfo", _public_dns):
        result = scanner.scan("http://example.com/start")
    hits = result.findings
    assert hits
    assert all(f.redirects == 1 for f in hits)
    assert result.summary.blocked_count == 0
    assert any(u == "http://final.example/" for u in fetcher.calls)


def test_redirect_to_metadata_is_blocked_no_finding_no_inner_content() -> None:
    """302 → 云元数据：停止跟随、不产生 finding、不请求内网、汇总计数。"""

    def responses(url: str) -> _FakeResponse:
        if url.startswith("http://169.254."):
            return _FakeResponse(text="root:x:0:0 leaked")  # 不应被请求到
        return _FakeResponse(
            status_code=302, headers={"Location": "http://169.254.169.254/latest/meta-data/"}
        )

    fetcher = _FakeFetcher(responses)
    scanner = VulnScanner(fetcher=fetcher)
    with patch("socket.getaddrinfo", _public_dns):
        result = scanner.scan("http://example.com/?q=1")
    # 没有任何 finding 来自内网响应
    assert result.findings == []
    # 只请求了原始 URL，未跟随到元数据端点
    assert all("169.254." not in url for url in fetcher.calls)
    # 每次探测都被拦截并在汇总里看到次数
    assert result.summary.blocked_count == result.summary.probes[0].payloads_tested
    assert result.summary.blocked_count > 0
    assert result.summary.probes[0].findings == 0


def test_redirect_to_loopback_is_blocked() -> None:
    """302 → 环回地址同样被拦截。"""
    fetcher = _FakeFetcher(
        _FakeResponse(status_code=301, headers={"Location": "http://127.0.0.1:8080/admin"})
    )
    scanner = VulnScanner(fetcher=fetcher)
    with patch("socket.getaddrinfo", _public_dns):
        result = scanner.scan("http://example.com/", param_names=["q"])
    assert result.summary.blocked_count > 0
    assert all("127.0.0.1" not in url for url in fetcher.calls)
    assert result.findings == []


def test_redirect_private_allowed_when_explicit() -> None:
    """allow_private_hosts=True 时重定向到内网被放行（显式授权）。"""

    def responses(url: str) -> _FakeResponse:
        if url.startswith("http://example.com/"):
            return _FakeResponse(
                status_code=302, headers={"Location": "http://192.168.1.1:8080/admin"}
            )
        return _FakeResponse(text="clean")

    fetcher = _FakeFetcher(responses)
    scanner = VulnScanner(fetcher=fetcher, allow_private_hosts=True)
    with patch("socket.getaddrinfo", _public_dns):
        result = scanner.scan("http://example.com/", param_names=["q"])
    assert result.summary.blocked_count == 0
    assert "http://192.168.1.1:8080/admin" in fetcher.calls


def test_redirect_chain_is_capped_at_max_redirects() -> None:
    """无限重定向在 _MAX_REDIRECTS 处停止，且 3xx 响应体不被当作证据。"""
    counter = {"n": 0}

    def responses(url: str) -> _FakeResponse:
        counter["n"] += 1
        return _FakeResponse(
            status_code=301,
            text="root:x:0:0",  # 即使 3xx 带体也不得判为漏洞
            headers={"Location": f"http://example.com/next{counter['n']}"},
        )

    fetcher = _FakeFetcher(responses)
    scanner = VulnScanner(fetcher=fetcher)
    with patch("socket.getaddrinfo", _public_dns):
        result = scanner.scan("http://example.com/", param_names=["q"])
    probe = result.summary.probes[0]
    # 每个探测最多 1 + 5 次请求（初始 + 5 跳），不会无限制跟随
    assert len(fetcher.calls) == probe.payloads_tested * (VulnScanner._MAX_REDIRECTS + 1)
    assert result.findings == []
    assert result.summary.redirect_capped_count == probe.payloads_tested


def test_redirect_followed_per_hop_ssrf_check_on_dns_resolution() -> None:
    """每一跳都做 host 复查（含 DNS）：解析到私网的中间跳也会被拦截。"""

    def responses(url: str) -> _FakeResponse:
        if url.startswith("http://example.com/"):
            return _FakeResponse(status_code=302, headers={"Location": "http://rebind.evil/"})
        return _FakeResponse(text="root:x:0:0")

    def dns(host: str, *a: object, **kw: object) -> list[tuple]:
        if host == "rebind.evil":
            return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("10.0.0.5", 0))]
        return [(socket.AF_INET, socket.SOCK_STREAM, 6, "", ("93.184.216.34", 0))]

    fetcher = _FakeFetcher(responses)
    scanner = VulnScanner(fetcher=fetcher)
    with patch("socket.getaddrinfo", dns):
        result = scanner.scan("http://example.com/", param_names=["q"])
    assert result.findings == []
    assert result.summary.blocked_count > 0
    assert all("rebind.evil" not in url for url in fetcher.calls)


# ---------------------------------------------------------------------------
# 假 provider（LLM 路径）也带可追溯字段
# ---------------------------------------------------------------------------


def test_llm_finding_carries_source_and_redirects() -> None:
    """LLM 路径的 finding 同样带参数来源与跳数。"""
    provider = _FakeProvider(
        json.dumps({"vulnerable": True, "type": "xss", "evidence": "ok", "severity": "high"})
    )

    def responses(url: str) -> _FakeResponse:
        if url.startswith("http://example.com/"):
            return _FakeResponse(status_code=302, headers={"Location": "http://final.example/"})
        return _FakeResponse(text="<html>ok</html>")

    fetcher = _FakeFetcher(responses)
    scanner = VulnScanner(fetcher=fetcher, provider=provider)
    with patch("socket.getaddrinfo", _public_dns):
        result = scanner.scan("http://example.com/", params={"name": "alice"})
    assert result.findings
    hit = result.findings[0]
    assert hit.param_source == SOURCE_ORIGINAL_VALUE
    assert hit.original_value == "alice"
    assert hit.redirects == 1
    assert hit.to_dict()["redirects"] == 1


# ---------------------------------------------------------------------------
# to_dict 兼容性
# ---------------------------------------------------------------------------


def test_to_dict_keeps_legacy_fields_only_when_optional_missing() -> None:
    """未填写可选字段时 to_dict 与旧结构完全一致（不含新键）。"""
    f = VulnFinding(
        type="sql_injection",
        param="q",
        payload="'",
        evidence="SQL syntax",
        severity="high",
    )
    assert f.to_dict() == {
        "type": "sql_injection",
        "param": "q",
        "payload": "'",
        "evidence": "SQL syntax",
        "severity": "high",
    }


def test_summary_to_dict_shape() -> None:
    """汇总 to_dict 暴露每个参数的测试量、跳过原因与拦截计数。"""
    scanner = VulnScanner(fetcher=_FakeFetcher(_FakeResponse(text="clean")))
    result = scanner.scan("http://example.com/", params={"a": "", "": ""})
    d = result.summary.to_dict()
    assert d["url"] == "http://example.com/"
    assert d["findings_total"] == 0
    assert d["blocked_count"] == 0
    assert d["failed_count"] == 0
    assert d["skipped_params"] == [""]
    assert {p["param"] for p in d["probes"]} == {"a", ""}


@pytest.mark.parametrize("value", ["", None])
def test_resolve_ignores_non_string_or_empty_original(value: Any) -> None:
    """params 值非字符串或为空时不产生原始值（保持旧行为）。"""
    resolved = _resolve_test_params({"id": value}, None)
    assert resolved == [("id", SOURCE_PARAMS, None)]
