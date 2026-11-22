"""输出 PTS 对齐状态机（``cpp/Decoder.cpp`` 中 ``align_pts`` 的参考实现）。

设计目标（对应运维诉求）：

* **单调递增**：无论源帧时间戳回退、重复还是跳变，输出 pts 永远严格递增；
* **间隔接近标称帧率**：正常帧按源 delta 输出（保留真实节奏），异常 delta 被钳到
  标称帧间隔，断流恢复后按标称间隔续接，不出现大跳或回退；
* **重连续接**：重连后源时间戳通常从 0 重新开始，本状态机不依赖源绝对值，只依赖
  相邻帧 delta，因此重连后自动从 ``last_output_pts + nominal_delta`` 续接。

与旧 C++ 实现的差异：旧实现用 EMA 平滑 ``nominal_frame_delta``
（``0.98*old + 0.02*clamped``），长时间运行后标称间隔会被带偏，且 EMA 状态在
重连后残留。本实现把**标称间隔当作不可变常量**（只在流信息变化时显式更新），
平滑作用只体现在对单帧 delta 的钳制上，避免长期漂移。
"""

from __future__ import annotations


class PtsAligner:
    """把可能抖动/回退/重置的源 pts 对齐成单调递增的输出 pts（单位：秒）。

    Parameters
    ----------
    fps:
        标称帧率。``<= 0`` 时退化为 ``fallback_delta``。
    max_delay_s:
        单帧 delta 的允许偏差窗口（对应生产侧 ``max_delay_ms``）。源 delta 落在
        ``[nominal - tol, nominal + tol]`` 之外时，按标称间隔输出。
    fallback_delta:
        帧率未知时的兜底帧间隔（秒），默认 25fps。
    """

    def __init__(
        self,
        fps: float = 0.0,
        max_delay_s: float = 0.2,
        fallback_delta: float = 0.04,
    ) -> None:
        self.fallback_delta = fallback_delta
        self.max_delay_s = max_delay_s
        # 标称间隔是常量，不随帧内容漂移
        self._nominal_delta = self._delta_from_fps(fps)
        self._reset_stream_state()

    @staticmethod
    def _delta_from_fps(fps: float) -> float:
        return 1.0 / fps if fps and fps > 0.0 else 0.0

    def _reset_stream_state(self) -> None:
        self.last_input_pts: float = -1.0
        self.last_output_pts: float = -1.0
        self.pts_offset: float = 0.0
        self._emitted = 0

    # -- 生命周期 -----------------------------------------------------------
    @property
    def nominal_delta(self) -> float:
        return self._nominal_delta if self._nominal_delta > 0.0 else self.fallback_delta

    def update_fps(self, fps: float) -> None:
        """流信息变化（如重连后 SPS 中帧率改变）时显式更新标称间隔。"""
        delta = self._delta_from_fps(fps)
        if delta > 0.0:
            self._nominal_delta = delta

    def on_reconnect(self) -> None:
        """重连成功后调用：只重置"源时间戳基准"，保留输出基准。

        - ``last_output_pts`` 保留 → 输出时间轴不倒退、不跳变；
        - ``last_input_pts`` 复位 → 新流的首帧被当作新序列起点，其源 pts
          （通常从 0 开始）不会与旧流的末尾值产生负 delta；
        - 标称间隔保持不变（除非 ``update_fps`` 显式变更）。
        """
        self.last_input_pts = -1.0
        # 输出基准不动：下一帧从 last_output_pts + nominal_delta 续接
        self.pts_offset = 0.0

    def reset(self) -> None:
        """彻底重置（对应解码器对象重建的场景）。"""
        self._reset_stream_state()

    # -- 核心转换 -----------------------------------------------------------
    def align(self, source_pts: float) -> float:
        """输入一帧的源 pts（秒，``<0`` 表示源未提供时间戳），返回输出 pts。"""
        expected = self.nominal_delta

        # 情况 1：源没有时间戳，直接按标称间隔补点
        if source_pts is None or source_pts < 0.0:
            return self._advance(expected)

        # 情况 2：新序列首帧（启动或重连后）。不使用源绝对值，只锚定输出轴
        if self.last_input_pts < 0.0:
            self.last_input_pts = float(source_pts)
            out = self._advance(expected)
            self.pts_offset = out - float(source_pts)
            return out

        # 情况 3：常规帧。只看相邻 delta，天然免疫源时间戳整体回跳
        raw_delta = float(source_pts) - self.last_input_pts
        self.last_input_pts = float(source_pts)

        tol = self.max_delay_s if self.max_delay_s > 0.0 else expected * 2.0
        min_delta = max(0.0, expected - tol)
        max_delta = expected + tol
        if not (min_delta <= raw_delta <= max_delta):
            # 网络抖动/丢包/回退导致的异常间隔：钳回标称间隔
            raw_delta = expected

        out = self.last_output_pts + raw_delta
        self.last_output_pts = out
        self.pts_offset = out - float(source_pts)
        self._emitted += 1
        return out

    def _advance(self, delta: float) -> float:
        if self.last_output_pts < 0.0:
            self.last_output_pts = 0.0
        else:
            self.last_output_pts += delta
        self._emitted += 1
        return self.last_output_pts

    @property
    def emitted_frames(self) -> int:
        return self._emitted
