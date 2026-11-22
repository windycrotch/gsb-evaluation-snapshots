"""PtsAligner 的验收测试：单调递增、标称间隔、断流重连、时间戳回退/跳变。

覆盖验收项：
- 正常连续帧下 pts 正确且间隔接近标称帧率；
- 模拟断流重连后 pts 仍单调、无大跳/回退；
- 源 pts 归零、回退、重复、抖动等异常输入均不破坏单调性。
"""

import math

import pytest

from streaming.pts_align import PtsAligner


def test_normal_continuous_frames_follow_nominal_rate():
    fps = 25.0
    aligner = PtsAligner(fps=fps, max_delay_s=0.2)
    delta = 1.0 / fps

    pts_out = [aligner.align(i * delta) for i in range(100)]

    # 首帧锚定在 0
    assert pts_out[0] == pytest.approx(0.0)
    # 严格单调递增
    assert all(b > a for a, b in zip(pts_out, pts_out[1:]))
    # 每帧间隔等于标称帧间隔（源节奏正常时不钳制、不平滑）
    gaps = [b - a for a, b in zip(pts_out, pts_out[1:])]
    assert all(g == pytest.approx(delta, abs=1e-12) for g in gaps)
    # 第 100 帧位置接近 99 个标称间隔
    assert pts_out[-1] == pytest.approx(99 * delta, abs=1e-9)


def test_monotonic_under_source_pts_rollback_and_duplicate():
    aligner = PtsAligner(fps=25.0)
    delta = 1.0 / 25.0

    out = [aligner.align(i * delta) for i in range(10)]
    last_good = out[-1]

    # 源时间戳突然回退到 0（摄像头重启）
    out.append(aligner.align(0.0))
    assert out[-1] > last_good
    # 回退帧按标称间隔续接，不产生大跳
    assert out[-1] == pytest.approx(last_good + delta, abs=1e-12)

    # 源时间戳重复
    duplicate_src = 9 * delta
    out.append(aligner.align(duplicate_src))
    assert out[-1] > out[-2]
    assert out[-1] == pytest.approx(out[-2] + delta, abs=1e-12)

    assert all(b > a for a, b in zip(out, out[1:]))


def test_large_jump_is_clamped_to_nominal_delta():
    aligner = PtsAligner(fps=25.0, max_delay_s=0.2)
    delta = 1.0 / 25.0

    aligner.align(0.0)
    aligner.align(delta)
    # 网络丢包后源 pts 向前跳 10 秒（远超 max_delay 容差）
    out = aligner.align(10.0)

    # 输出不跟随大跳，只前进一个标称间隔
    assert out == pytest.approx(2 * delta, abs=1e-12)


def test_small_jitter_within_tolerance_is_preserved():
    aligner = PtsAligner(fps=25.0, max_delay_s=0.2)
    delta = 1.0 / 25.0

    aligner.align(0.0)
    # ±50ms 抖动在 200ms 容差窗口内，保留真实节奏
    jittered = delta + 0.05
    out = aligner.align(jittered)
    assert out == pytest.approx(jittered, abs=1e-12)


def test_reconnect_keeps_output_axis_and_remains_monotonic():
    aligner = PtsAligner(fps=25.0)
    delta = 1.0 / 25.0

    before = [aligner.align(i * delta) for i in range(30)]
    axis_before = aligner.last_output_pts

    # 断流重连：源时间戳基准复位，输出轴保留
    aligner.on_reconnect()
    assert aligner.last_input_pts == -1.0
    assert aligner.last_output_pts == axis_before

    # 新流的首帧源 pts 从 0 开始
    after_first = aligner.align(0.0)
    assert after_first == pytest.approx(axis_before + delta, abs=1e-12)

    # 后续帧继续单调，间隔仍是标称值
    rest = [aligner.align(i * delta) for i in range(1, 30)]
    all_pts = before + [after_first] + rest
    assert all(b > a for a, b in zip(all_pts, all_pts[1:]))
    gaps = [b - a for a, b in zip(all_pts, all_pts[1:])]
    assert all(math.isclose(g, delta, abs_tol=1e-12) for g in gaps)


def test_missing_source_pts_advances_nominally():
    aligner = PtsAligner(fps=25.0)
    delta = 1.0 / 25.0

    first = aligner.align(-1.0)
    second = aligner.align(-1.0)
    assert first == 0.0
    assert second == pytest.approx(delta, abs=1e-12)


def test_nominal_delta_never_drifts_over_long_run():
    # 旧实现的 EMA 会让 nominal_frame_delta 长期漂移；参考实现必须保持常量
    aligner = PtsAligner(fps=25.0, max_delay_s=0.2)
    nominal = aligner.nominal_delta

    for i in range(10_000):
        # 交替制造轻微抖动，试图"带偏"标称间隔
        pts = i * nominal + (0.01 if i % 2 else -0.01)
        aligner.align(pts)

    assert aligner.nominal_delta == pytest.approx(nominal, abs=1e-15)


def test_update_fps_changes_nominal_delta_explicitly():
    aligner = PtsAligner(fps=25.0)
    assert aligner.nominal_delta == pytest.approx(1.0 / 25.0)
    aligner.update_fps(30.0)
    assert aligner.nominal_delta == pytest.approx(1.0 / 30.0)
