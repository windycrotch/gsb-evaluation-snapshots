# 最热游玩榜：逐款人数采集状态、失败原因分类与汇总（全部离线，不联网）。
#
# 覆盖：
#   - classify_ccu_error   抓取路径真实异常 -> 失败原因类别
#   - fetch_ccu_status     单款采集 -> (人数|None, 原因|None)，0 是合法成功
#   - build_most_played    部分成功/部分失败（两种以上原因）的并发采集：
#                          排序、逐条状态、汇总计数；全部失败抛错回退；0 计入成功
#   - players_summary      汇总字段（含旧快照无状态字段的推断）
#   - /api/most-played     响应新增 summary 字段
#
# 运行方式：在仓库根目录执行  python -m pytest tests/test_most_played_status.py -q

import asyncio

import httpx
import pytest

import app as fastapi_app
import steamdata as sd


def _http_error(status: int) -> httpx.HTTPStatusError:
    req = httpx.Request("GET", "https://api.steampowered.com/ISteamUserStats/x")
    return httpx.HTTPStatusError(
        f"HTTP {status}", request=req, response=httpx.Response(status, request=req)
    )


# ---------- classify_ccu_error：失败原因分类 ----------


class TestClassifyCcuError:
    def test_transport_errors_are_network(self):
        """连接失败/超时等传输层异常 -> 网络错误。"""
        assert sd.classify_ccu_error(httpx.ConnectError("离线测试")) == "network_error"
        assert sd.classify_ccu_error(httpx.ReadTimeout("超时")) == "network_error"

    def test_429_and_403_are_rate_limited(self):
        """退避重试后仍被 429/403 拒绝 -> 限流。"""
        assert sd.classify_ccu_error(_http_error(429)) == "rate_limited"
        assert sd.classify_ccu_error(_http_error(403)) == "rate_limited"

    def test_other_http_status_is_http_error(self):
        """5xx 等其余状态错误与限流区分开。"""
        assert sd.classify_ccu_error(_http_error(500)) == "http_error"
        assert sd.classify_ccu_error(_http_error(404)) == "http_error"

    def test_invalid_payload_markers(self):
        """无效人数（ValueError）/结构缺失（KeyError）-> 接口返回无效人数。"""
        assert sd.classify_ccu_error(ValueError("Steam 未返回有效在线人数：1")) == "invalid_response"
        assert sd.classify_ccu_error(KeyError("response")) == "invalid_response"

    def test_unexpected_exception_is_unknown(self):
        assert sd.classify_ccu_error(RuntimeError("未预期")) == "unknown_error"


# ---------- fetch_ccu_status：单款采集结果 ----------


class TestFetchCcuStatus:
    def test_success_including_real_zero(self, monkeypatch):
        """人数 0 是合法成功，不是失败。"""
        monkeypatch.setattr(sd, "fetch_ccu", lambda appid: 0)
        assert sd.fetch_ccu_status(1) == (0, None)

    def test_failure_returns_reason(self, monkeypatch):
        def boom(appid):
            raise httpx.ConnectError("离线测试")

        monkeypatch.setattr(sd, "fetch_ccu", boom)
        assert sd.fetch_ccu_status(1) == (None, "network_error")

    def test_non_int_return_is_invalid_not_zero(self, monkeypatch):
        """被改写的 fetch_ccu 返回非法值时记为无效响应，不能静默当 0。"""
        monkeypatch.setattr(sd, "fetch_ccu", lambda appid: None)
        assert sd.fetch_ccu_status(1) == (None, "invalid_response")


# ---------- build_most_played：并发采集的排序 / 状态 / 汇总 ----------


def _build_env(monkeypatch, ccu_fn, appids=(1, 2, 3, 4, 5)):
    """钉死 build_most_played 的所有外部依赖：官方榜、人数、详情、落盘、采样。"""
    monkeypatch.setattr(
        sd,
        "fetch_most_played",
        lambda: [
            {"appid": a, "rank": i + 1, "last_week_rank": i + 1, "peak_in_game": 1000}
            for i, a in enumerate(appids)
        ],
    )
    monkeypatch.setattr(sd, "fetch_ccu", ccu_fn)
    monkeypatch.setattr(sd, "fetch_detail_cached", lambda *a: {"name": "G"})
    monkeypatch.setattr(sd, "_persist_detail_store", lambda: None)
    monkeypatch.setattr(sd, "_dump_json", lambda *a: None)
    monkeypatch.setattr(sd, "HISTORY", sd.HistoryRing())


def test_partial_failures_keep_rows_with_per_item_status(monkeypatch):
    """部分成功 + 两种不同原因的失败：失败条目保留、置后、不拿 0 冒充未知。"""

    def ccu(appid):
        if appid == 1:
            return 500
        if appid == 2:
            raise httpx.ConnectError("离线测试")  # 网络错误
        if appid == 3:
            return 0  # 真实 0 人在线 = 成功
        if appid == 4:
            raise _http_error(429)  # 限流
        return 300  # appid 5

    _build_env(monkeypatch, ccu)
    items = sd.build_most_played()
    by_appid = {it["appid"]: it for it in items}

    # 排序：有效人数降序（含 0），失败条目排在有效人数之后并保持官方榜相对顺序
    assert [it["appid"] for it in items] == [1, 5, 3, 2, 4]

    # 成功条目：状态 ok、无失败原因；0 人在线同样计为成功
    assert by_appid[1]["players_status"] == "ok" and by_appid[1]["players_error"] is None
    assert by_appid[3]["players_status"] == "ok" and by_appid[3]["players"] == 0

    # 失败条目：人数保持 None，原因分类可区分
    assert by_appid[2]["players"] is None
    assert by_appid[2]["players_status"] == "failed"
    assert by_appid[2]["players_error"] == "network_error"
    assert by_appid[4]["players"] is None
    assert by_appid[4]["players_status"] == "failed"
    assert by_appid[4]["players_error"] == "rate_limited"

    # 失败条目不计算周变化；成功条目按实时排名正常计算
    assert by_appid[2]["delta"] is None and by_appid[4]["delta"] is None
    assert by_appid[1]["delta"] == 0 and by_appid[5]["delta"] == 3

    # 汇总：候选 5、成功 3（含 0 人在线）、失败 2，按原因聚合
    assert sd.players_summary(items) == {
        "candidates": 5,
        "ok": 3,
        "failed": 2,
        "failures_by_reason": {"network_error": 1, "rate_limited": 1},
    }


def test_total_failure_raises_and_does_not_overwrite_previous_board(monkeypatch):
    """全部失败：按现有规则抛错，且不落盘覆盖上一份榜单。"""
    dumps = []
    _build_env(monkeypatch, lambda appid: (_ for _ in ()).throw(httpx.ConnectError("x")))
    monkeypatch.setattr(sd, "_dump_json", lambda *a: dumps.append(a))
    with pytest.raises(RuntimeError, match="有效在线人数"):
        sd.build_most_played()
    assert not dumps  # 上一份榜单（LAST_MP_LIVE）必须原样保留


def test_zero_players_counts_as_success_and_sorts(monkeypatch):
    """人数为 0：计入成功、参与排序（排在大于 0 的之后、失败之前）。"""
    _build_env(monkeypatch, lambda appid: 0, appids=(1, 2))
    items = sd.build_most_played()
    assert [it["players"] for it in items] == [0, 0]
    assert all(it["players_status"] == "ok" for it in items)
    summary = sd.players_summary(items)
    assert summary["ok"] == 2 and summary["failed"] == 0
    assert summary["failures_by_reason"] == {}


# ---------- players_summary：汇总字段 ----------


def test_summary_infers_status_for_legacy_rows():
    """旧磁盘快照没有状态字段：按人数是否为空推断，失败原因记 unknown。"""
    items = [{"players": 5}, {"players": None}, {"players": 0}]
    assert sd.players_summary(items) == {
        "candidates": 3,
        "ok": 2,
        "failed": 1,
        "failures_by_reason": {"unknown_error": 1},
    }


# ---------- /api/most-played：响应携带 summary ----------


def test_api_response_includes_collection_summary(monkeypatch):
    monkeypatch.setattr(fastapi_app, "charts_cache", fastapi_app.TTLCache(60))
    items = [
        {"appid": 1, "players": 10, "players_status": "ok", "players_error": None},
        {"appid": 2, "players": None, "players_status": "failed",
         "players_error": "rate_limited"},
    ]
    monkeypatch.setattr(sd, "build_most_played", lambda: items)

    async def scenario():
        transport = httpx.ASGITransport(app=fastapi_app.app)
        async with httpx.AsyncClient(transport=transport, base_url="http://test") as client:
            resp = await client.get("/api/most-played?force=1")
        assert resp.status_code == 200
        body = resp.json()
        assert body["summary"] == {
            "candidates": 2,
            "ok": 1,
            "failed": 1,
            "failures_by_reason": {"rate_limited": 1},
        }
        statuses = {it["appid"]: it["players_status"] for it in body["items"]}
        assert statuses == {1: "ok", 2: "failed"}
        assert body["items"][1]["players"] is None  # 不用 0 冒充未知

    asyncio.run(scenario())
