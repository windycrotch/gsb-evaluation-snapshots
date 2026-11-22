"""StubDecoder 的验收测试：断流重连、连续异常帧重拉、PTS 单调、缓冲复用。

这些场景在生产链路由 FFmpeg/NVDEC 触发（av_read_frame 失败、NPP 异常），
桩用脚本化事件确定性复现同样的状态转移。
"""

import numpy as np
import pytest

from streaming.stub_decoder import StreamEndedError, StreamEvent, StreamScript, StubDecoder


def drain(decoder, n):
    frames, pts = [], []
    for _ in range(n):
        f, p = decoder.next_frame()
        # 解码器复用同一块缓冲，跨帧持有必须先拷贝，否则所有引用都会指向最后一帧
        # （覆盖语义见 test_frame_buffer.py）
        frames.append(f.copy())
        pts.append(p)
    return frames, pts


def test_normal_frames_content_and_pts_correct():
    dec = StubDecoder(StreamScript(total_frames=20), fps=25.0)
    frames, pts = drain(dec, 20)

    delta = 1.0 / 25.0
    assert pts[0] == pytest.approx(0.0)
    assert all(b > a for a, b in zip(pts, pts[1:]))
    assert all((b - a) == pytest.approx(delta, abs=1e-12) for a, b in zip(pts, pts[1:]))
    # 快照内容逐帧不同（角落字节写入递增的源序号）
    assert [f[0, 0, 0] for f in frames] == list(range(20))
    # 尺寸不变只分配一次缓冲
    assert dec.buffer_allocations == 1


def test_outage_triggers_reconnect_and_pts_keeps_monotonic():
    script = StreamScript(
        events=[StreamEvent("outage", at=10, length=3)],
        total_frames=25,
    )
    dec = StubDecoder(script, fps=25.0)
    frames, pts = drain(dec, 25)

    assert dec.reconnect_count == 1
    assert all(b > a for a, b in zip(pts, pts[1:]))
    gaps = [b - a for a, b in zip(pts, pts[1:])]
    # 断流恢复后不允许出现大跳：所有输出间隔都应接近标称帧间隔
    assert max(gaps) == pytest.approx(1.0 / 25.0, abs=1e-9)
    # 25 个交付帧对应 24 个间隔，时间轴连续
    assert pts[-1] == pytest.approx(24 / 25.0, abs=1e-9)


def test_consume_reconnect_is_edge_triggered():
    script = StreamScript(
        events=[StreamEvent("outage", at=5, length=2)],
        total_frames=12,
    )
    dec = StubDecoder(script, fps=25.0)
    for _ in range(8):
        dec.next_frame()
    assert dec.reconnect_count == 1
    assert dec.consume_reconnect() is True
    # 标志只生效一次
    assert dec.consume_reconnect() is False


def test_consecutive_bad_frames_trigger_repull_and_reset_streak():
    # 第 8 帧起连续 5 个坏帧 → 触发重拉；之后恢复正常
    script = StreamScript(
        events=[StreamEvent("bad", at=8, length=5)],
        total_frames=20,
    )
    dec = StubDecoder(script, fps=25.0, bad_frame_threshold=5)
    frames, pts = drain(dec, 20)

    # 坏帧被跳过且触发了一次重拉
    assert dec.reconnect_count == 1
    assert dec.finished is False
    # 重拉后坏帧计数清零，正常帧继续
    assert all(b > a for a, b in zip(pts, pts[1:]))
    assert len(frames) == 20


def test_reconnect_budget_exhaustion_raises():
    script = StreamScript(
        events=[
            StreamEvent("outage", at=3, length=2),
            StreamEvent("outage", at=6, length=2),
        ],
        total_frames=20,
    )
    dec = StubDecoder(script, fps=25.0, max_reconnects=1)
    with pytest.raises(StreamEndedError):
        drain(dec, 20)
    assert dec.finished is True


def test_source_pts_reset_after_reconnect_does_not_go_backwards():
    script = StreamScript(
        events=[StreamEvent("pts_reset", at=10)],
        total_frames=20,
    )
    dec = StubDecoder(script, fps=25.0)
    _, pts = drain(dec, 20)
    assert all(b > a for a, b in zip(pts, pts[1:]))


def test_multiple_outages_stay_bounded_and_monotonic():
    script = StreamScript(
        events=[
            StreamEvent("outage", at=5, length=2),
            StreamEvent("outage", at=12, length=4),
            StreamEvent("outage", at=18, length=1),
        ],
        total_frames=30,
    )
    dec = StubDecoder(script, fps=25.0)
    _, pts = drain(dec, 30)
    assert dec.reconnect_count == 3
    assert all(b > a for a, b in zip(pts, pts[1:]))
    gaps = [b - a for a, b in zip(pts, pts[1:])]
    assert max(gaps) == pytest.approx(1.0 / 25.0, abs=1e-9)
