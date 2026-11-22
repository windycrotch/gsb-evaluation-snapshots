"""长时间运行稳定性测试：轨迹表规模有界、PTS 无漂移、缓冲分配次数有界。

用轻量帧（64x48）跑数千帧，模拟天级运行中的关键资源：
- 跟踪器三张表（tracked/lost/removed）不会随帧数线性膨胀；
- 解码器复用缓冲只在尺寸变化时分配，长期运行分配次数恒定；
- 输出 pts 严格单调且与标称帧率保持一致（无累积漂移）。
"""

import numpy as np
import pytest

from bytetrack.fast_byte_tracker import FastByteTracker
from streaming.stub_decoder import StreamEvent, StreamScript, StubDecoder
from streaming.coordinator import StreamCoordinator


def test_long_run_track_tables_stay_bounded():
    fps = 25.0
    n_frames = 3000
    tracker = FastByteTracker(
        frame_rate=fps,
        track_buffer=30,
        removed_buffer=128,
    )
    # 周期性让目标消失/出现，持续制造 lost -> removed 流转
    rng = np.random.default_rng(42)

    for f in range(1, n_frames + 1):
        if f % 200 < 120:
            x = float(10 + (f % 80))
            det = np.array([[x, 10, x + 40, 80, 0.9, 0]], dtype=np.float32)
        else:
            det = np.empty((0, 6), dtype=np.float32)
        tracker.update(det)

        # 每帧都断言有界，而不是只在末尾检查一次
        assert len(tracker.tracked_stracks) <= 2
        assert len(tracker.lost_stracks) <= tracker.max_time_lost + 2
        assert len(tracker.removed_stracks) <= tracker.removed_buffer

    # 终态仍然有界
    assert len(tracker.removed_stracks) <= 128
    # ID 计数器随真实新轨迹数增长（这是预期的，计数器本身只是一个 int，不持有轨迹内存）
    assert tracker.id_counter._count > 0


def test_long_run_pts_stays_monotonic_and_nominal():
    fps = 25.0
    n_frames = 2000
    # 每隔几百帧插一次断流
    events = [
        StreamEvent("outage", at=300, length=4),
        StreamEvent("outage", at=900, length=2),
        StreamEvent("pts_reset", at=1500),
    ]
    decoder = StubDecoder(
        StreamScript(events=events, total_frames=n_frames),
        fps=fps,
    )
    coord = StreamCoordinator(decoder)

    pts = []
    for _ in range(n_frames):
        pkt = coord.step()
        pts.append(pkt.pts)

    # 严格单调
    assert all(b > a for a, b in zip(pts, pts[1:]))
    # 每个间隔都等于标称帧间隔（断流/重置都被钳制）
    delta = 1.0 / fps
    gaps = np.diff(pts)
    np.testing.assert_allclose(gaps, delta, atol=1e-10)
    # 总时长与帧数严格对应，无累积漂移
    assert pts[-1] == pytest.approx((n_frames - 1) * delta, abs=1e-9)
    # 复用缓冲在全程尺寸不变时只分配一次
    assert decoder.buffer_allocations == 1


def test_long_run_repeated_outages_keep_tracker_state_bounded():
    fps = 25.0
    events = [StreamEvent("outage", at=100 + i * 150, length=2) for i in range(10)]
    decoder = StubDecoder(
        StreamScript(events=events, total_frames=1600),
        fps=fps,
        max_reconnects=20,
    )
    tracker = FastByteTracker(frame_rate=fps, track_buffer=25, removed_buffer=64)
    coord = StreamCoordinator(decoder, tracker)

    resume_seen = 0
    for _ in range(1600):
        pkt = coord.step()
        resume_seen += int(pkt.resumed)
        det = np.array([[12, 12, 52, 82, 0.9, 0]], dtype=np.float32)
        coord.track(det)

    assert resume_seen == 10
    assert decoder.reconnect_count == 10
    assert len(tracker.removed_stracks) <= 64
    assert len(tracker.lost_stracks) <= tracker.max_time_lost + 2
