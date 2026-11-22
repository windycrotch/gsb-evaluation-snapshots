"""端到端协同测试（桩链路）：StreamCoordinator 把解码器与跟踪器粘起来。

覆盖验收项：
- 正常连续帧下帧内容与 pts 正确；
- 断流重连后 pts 仍单调、轨迹编号延续；
- 连续异常帧触发重拉时缓冲与状态被正确重置；
- 多路并发下各 Pipeline 互不串扰；
- 帧缓冲复用的覆盖语义（跨帧持有旧帧读到新内容）。
"""

from concurrent.futures import ThreadPoolExecutor

import numpy as np
import pytest

from bytetrack.fast_byte_tracker import FastByteTracker
from streaming.coordinator import StreamCoordinator
from streaming.stub_decoder import StreamEndedError, StreamEvent, StreamScript, StubDecoder


def _det_at(frame_no, x=10.0):
    # 检测桩：固定位置的高置信目标
    return np.array([[x, 10, x + 40, 80, 0.9, 0]], dtype=np.float32)


def _make_pipeline(script, fps=25.0, track_buffer=30):
    decoder = StubDecoder(script, fps=fps)
    tracker = FastByteTracker(frame_rate=fps, track_buffer=track_buffer)
    return decoder, StreamCoordinator(decoder, tracker), tracker


def test_normal_pipeline_frame_content_and_pts():
    decoder, coord, tracker = _make_pipeline(StreamScript(total_frames=30))
    packets = []
    corners = []
    for _ in range(30):
        pkt = coord.step()
        coord.track(_det_at(pkt.frame_no))
        corners.append(int(pkt.frame[0, 0, 0]))  # 立即读值，不等缓冲被覆盖
        packets.append(pkt)

    pts = [p.pts for p in packets]
    assert all(b > a for a, b in zip(pts, pts[1:]))
    assert packets[0].frame_no == 1 and packets[-1].frame_no == 30
    # 帧号连续，没有 resumed 误报
    assert all(not p.resumed for p in packets)
    # 逐帧内容递增（角落字节是源序号）
    assert corners == list(range(30))


def test_reconnect_resumes_track_ids_and_pts_monotonic():
    script = StreamScript(
        events=[StreamEvent("outage", at=10, length=3)],
        total_frames=30,
    )
    decoder, coord, tracker = _make_pipeline(script)

    seen_ids = []
    pts_series = []
    resumed_packets = []
    for _ in range(30):
        pkt = coord.step()
        out = coord.track(_det_at(pkt.frame_no))
        seen_ids.append(int(out[0, 6]))
        pts_series.append(pkt.pts)
        if pkt.resumed:
            resumed_packets.append(pkt)

    # 恰好一次重连，且只标记在恢复后的第一帧
    assert len(resumed_packets) == 1
    assert decoder.reconnect_count == 1
    # 轨迹编号从头到尾保持 1，没有因重连重新分配
    assert set(seen_ids) == {1}
    # pts 全程严格单调
    assert all(b > a for a, b in zip(pts_series, pts_series[1:]))
    # 重连前后的间隔仍是标称值，没有大跳
    delta = 1.0 / 25.0
    gaps = [b - a for a, b in zip(pts_series, pts_series[1:])]
    assert max(gaps) == pytest.approx(delta, abs=1e-9)


def test_bad_frame_streak_repull_resets_decoder_state():
    script = StreamScript(
        events=[StreamEvent("bad", at=8, length=5)],
        total_frames=25,
    )
    decoder, coord, tracker = _make_pipeline(script, track_buffer=30)

    ids, pts = [], []
    for _ in range(25):
        pkt = coord.step()
        out = coord.track(_det_at(pkt.frame_no))
        ids.append(int(out[0, 6]))
        pts.append(pkt.pts)

    # 触发了一次重拉，协调层感知到重连并续轨
    assert decoder.reconnect_count == 1
    assert decoder._bad_streak == 0  # 重拉后坏帧计数已重置
    assert set(ids) == {1}           # 编号延续
    assert all(b > a for a, b in zip(pts, pts[1:]))


def test_multi_pipeline_no_cross_talk_under_concurrency():
    def run_pipeline(seed):
        # 每路脚本的断流时刻不同，模拟现场各路独立抖动
        script = StreamScript(
            events=[StreamEvent("outage", at=5 + seed, length=2)],
            total_frames=40,
        )
        decoder = StubDecoder(script, fps=25.0)
        tracker = FastByteTracker(frame_rate=25.0, track_buffer=20)
        coord = StreamCoordinator(decoder, tracker)

        ids, pts, reconnects = [], [], 0
        for _ in range(40):
            pkt = coord.step()
            out = coord.track(_det_at(pkt.frame_no, x=10 + seed))
            ids.append(int(out[0, 6]))
            pts.append(pkt.pts)
            reconnects += int(pkt.resumed)
        return ids, pts, reconnects, decoder.reconnect_count, len(tracker.removed_stracks)

    n_pipelines = 8
    with ThreadPoolExecutor(max_workers=n_pipelines) as pool:
        results = list(pool.map(run_pipeline, range(n_pipelines)))

    for ids, pts, reconnects, rec_count, removed_size in results:
        # 每路独立编号空间，都从 1 开始且只维持一条轨迹
        assert set(ids) == {1}
        assert reconnects == 1 and rec_count == 1
        assert all(b > a for a, b in zip(pts, pts[1:]))
        assert removed_size <= 256


def test_frame_buffer_ownership_overwrite_semantics():
    """调用方若跨帧持有旧帧，下一帧会读到被覆盖的内容。

    生产侧 C++ reusable_buf 与本桩语义一致；main.process_one_frame 在单轮内
    消费完帧并显式 .cpu() 拷贝，不跨帧持有，这里固化该约定。
    """
    decoder = StubDecoder(StreamScript(total_frames=4), fps=25.0)
    f1, _ = decoder.next_frame()
    f1_ref = f1
    f1_copy = f1.copy()

    f2, _ = decoder.next_frame()
    # 复用同一块存储
    assert f1_ref is f2
    # 旧引用内容已被第二帧覆盖
    assert np.array_equal(f1_ref, f2)
    # 提前拷贝的快照保持第一帧内容
    assert not np.array_equal(f1_copy, f2)


def test_coordinator_detects_non_monotonic_pts_from_broken_decoder():
    class BrokenDecoder(StubDecoder):
        def __init__(self):
            super().__init__(StreamScript(total_frames=3), fps=25.0)
            self._flip = False

        def next_frame(self):
            frame, _ = super().next_frame()
            self._flip = not self._flip
            # 故意制造回退的 pts
            pts = 0.04 if self._flip else 0.0
            return frame, pts

    coord = StreamCoordinator(BrokenDecoder())
    coord.step()
    with pytest.raises(RuntimeError, match="非单调"):
        coord.step()


def test_stream_ended_propagates_to_caller():
    decoder = StubDecoder(
        StreamScript(events=[StreamEvent("outage", at=2, length=2)], total_frames=10),
        max_reconnects=1,
    )
    # 第一次断流用掉唯一的重连预算；若之后再断则抛出终止异常
    decoder._try_reconnect()
    coord = StreamCoordinator(decoder)
    with pytest.raises(StreamEndedError):
        for _ in range(10):
            coord.step()
