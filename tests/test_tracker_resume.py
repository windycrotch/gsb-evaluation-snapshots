"""跟踪器在重连场景下的验收测试：

- 重连后轨迹编号延续（走 on_stream_resume 续轨，而非 reset 重新分配）；
- 超时丢失轨迹被清理，removed_stracks 有界；
- 同进程多个跟踪器实例 ID 互不串号（模拟多路 Pipeline）。
"""

import numpy as np
import pytest

from bytetrack.fast_byte_tracker import FastByteTracker
from bytetrack.basetrack import TrackState


def _det(x=10.0, y=10.0, w=40.0, h=70.0, score=0.9):
    return np.array([[x, y, x + w, y + h, score, 0]], dtype=np.float32)


def _tracker(track_buffer=30, removed_buffer=128):
    return FastByteTracker(
        frame_rate=25,
        track_buffer=track_buffer,
        removed_buffer=removed_buffer,
    )


def test_ids_continue_after_stream_resume():
    tracker = _tracker()
    for _ in range(5):
        out = tracker.update(_det())
    id_before = int(out[0, 6])

    # 模拟断流：解码器重连成功，协调层调用续轨钩子
    tracker.on_stream_resume()
    assert len(tracker.tracked_stracks) == 0
    assert len(tracker.lost_stracks) == 1
    assert tracker.lost_stracks[0].state == TrackState.Lost

    # 目标在同一位置重新出现：应通过 lost→tracked 匹配捞回，编号不变
    out = tracker.update(_det())
    assert len(out) == 1
    assert int(out[0, 6]) == id_before


def test_new_target_after_resume_gets_next_id_not_restart():
    tracker = _tracker()
    out = tracker.update(_det())
    first_id = int(out[0, 6])
    tracker.on_stream_resume()

    # 重连后出现的是一个全新目标（位置完全不同，IoU 为 0）。
    # ByteTrack 原生语义：frame_id>1 时新建轨迹第一帧为 unconfirmed，不进输出，
    # 第二帧确认后才输出；但 ID 在 activate 时已分配。
    new_det = np.array([[400, 400, 460, 480, 0.95, 0]], dtype=np.float32)
    tracker.update(new_det)
    new_id = max(t.track_id for t in tracker.tracked_stracks)
    assert new_id == first_id + 1
    # 第二帧确认后，输出里能看到新编号
    out = tracker.update(new_det)
    assert int(out[0, 6]) == new_id
    # ID 计数器没有被 reset 回 0/1
    assert tracker.id_counter._count >= new_id


def test_reset_restarts_ids_but_resume_does_not():
    t_resume = _tracker()
    t_reset = _tracker()
    for t in (t_resume, t_reset):
        t.update(_det())

    t_resume.on_stream_resume()
    t_reset.reset()

    new_pos = np.array([[200, 200, 240, 270, 0.9, 0]], dtype=np.float32)

    # reset 后新建轨迹从 1 开始（首帧即确认，因为 frame_id 回到 1）
    out_reset = t_reset.update(new_pos)
    assert int(out_reset[0, 6]) == 1

    # resume 后新轨迹延续计数器（unconfirmed 首帧不进输出，直接查内部状态）
    t_resume.update(new_pos)
    resume_id = max(t.track_id for t in t_resume.tracked_stracks)
    assert resume_id == 2


def test_lost_tracks_are_cleaned_after_timeout():
    tracker = _tracker(track_buffer=5)
    tracker.update(_det())
    tid = int(tracker.tracked_stracks[0].track_id)

    # 目标消失：先 lost，超过 max_time_lost 后 removed
    for _ in range(tracker.max_time_lost + 2):
        tracker.update(np.empty((0, 6), dtype=np.float32))

    assert len(tracker.tracked_stracks) == 0
    assert len(tracker.lost_stracks) == 0
    removed_ids = {t.track_id for t in tracker.removed_stracks}
    assert tid in removed_ids


def test_removed_stracks_bounded_under_long_run():
    tracker = _tracker(track_buffer=2, removed_buffer=64)
    empty = np.empty((0, 6), dtype=np.float32)

    # 持续制造短命轨迹：每帧一个新位置的高置信检测，下一帧消失
    for k in range(400):
        x = float((k * 37) % 400)
        tracker.update(_det(x=x))
        tracker.update(empty)

    assert len(tracker.removed_stracks) <= tracker.removed_buffer
    # lost 表同样有界（超时清理在每个 update 内执行）
    assert len(tracker.lost_stracks) <= tracker.removed_buffer


def test_parallel_trackers_have_independent_id_spaces():
    # 同进程两个跟踪器（对应多路 Pipeline 的同进程测试/合并推理场景）
    t1, t2 = _tracker(), _tracker()
    o1 = t1.update(_det())
    o2 = t2.update(_det())
    assert int(o1[0, 6]) == int(o2[0, 6]) == 1

    # 各自续轨、各自新建，编号空间始终独立
    t1.on_stream_resume()
    t2.on_stream_resume()
    new_det = np.array([[300, 300, 340, 370, 0.9, 0]], dtype=np.float32)
    # 新目标首帧 unconfirmed，用内部状态断言分配到的编号
    t1.update(new_det)
    t2.update(new_det)
    assert max(t.track_id for t in t1.tracked_stracks) == 2
    assert max(t.track_id for t in t2.tracked_stracks) == 2


def test_stable_tracking_keeps_constant_id_on_moving_object():
    tracker = _tracker()
    ids = []
    for k in range(30):
        out = tracker.update(_det(x=10 + k * 2, y=10 + k))
        ids.append(int(out[0, 6]))
    assert set(ids) == {1}
