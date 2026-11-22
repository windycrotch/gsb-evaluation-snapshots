"""解码器与跟踪器之间的重连协同层。

生产链路里两个组件原本各自独立演进：

* 解码器重连时只重置 FFmpeg/PTS 相关状态；
* 跟踪器对"断了多久"一无所知，只会因为长期没检测而把轨迹超时清理。

:class:`StreamCoordinator` 把两边粘起来：每次取帧后检查解码器的重连标志，
重连成功的第一时间通知跟踪器进入"续轨"状态（保留 ID 计数器与轨迹表，只把
在跑的轨迹标记为 lost 等待重新匹配），从而实现**画面继续、编号不跳变**。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Optional, Tuple

import numpy as np


@dataclass
class FramePacket:
    """一次协调取帧的结果。

    frame:
        解码器复用缓冲里的帧。**所有权归解码器**，下一次 :meth:`step` 会覆盖；
        需要跨帧持有请先 ``.copy()`` / ``.clone()``。
    pts:
        对齐后的单调递增输出时间戳（秒）。
    frame_no:
        协调层视角的连续帧号（断流不回退）。
    resumed:
        本帧是否为重连恢复后的第一帧。
    reconnect_count:
        解码器累计重连次数。
    """

    frame: np.ndarray
    pts: float
    frame_no: int
    resumed: bool
    reconnect_count: int


class StreamCoordinator:
    def __init__(self, decoder: Any, tracker: Optional[Any] = None) -> None:
        self.decoder = decoder
        self.tracker = tracker
        self.frame_no = 0
        self.last_pts: float = -1.0
        self.reconnect_count = 0

    def _check_reconnect(self) -> bool:
        """兼容两类解码器：带 consume_reconnect() 的桩 / 生产 Decoder。"""
        consumer = getattr(self.decoder, "consume_reconnect", None)
        if consumer is not None:
            return bool(consumer())
        # 生产 C++ Decoder 走 reconnect_count 属性的边沿检测
        count = getattr(self.decoder, "reconnect_count", 0)
        if count > self.reconnect_count:
            self.reconnect_count = count
            return True
        return False

    def step(self) -> FramePacket:
        """取一帧并完成重连协同，返回 :class:`FramePacket`。

        解码器抛出的终止异常（桩的 ``StreamEndedError`` / 生产侧 runtime_error）
        原样向上抛，由调用方决定结束 Pipeline。
        """
        frame, pts = self.decoder.next_frame()

        resumed = self._check_reconnect()
        if resumed:
            self.reconnect_count = getattr(self.decoder, "reconnect_count", self.reconnect_count)
            if self.tracker is not None and hasattr(self.tracker, "on_stream_resume"):
                # 续轨而非 reset：保留 track_id 计数与 lost 轨迹，等待 IoU 重新匹配
                self.tracker.on_stream_resume()

        # 防御性断言：任何解码器实现都必须保证输出 pts 严格单调
        if self.last_pts >= 0.0 and not (pts > self.last_pts):
            raise RuntimeError(
                f"解码器输出 pts 非单调: {self.last_pts} -> {pts}，链路状态已损坏"
            )
        self.last_pts = pts
        self.frame_no += 1
        return FramePacket(
            frame=frame,
            pts=pts,
            frame_no=self.frame_no,
            resumed=resumed,
            reconnect_count=self.reconnect_count,
        )

    def track(self, detections: np.ndarray) -> np.ndarray:
        """在当前帧上跑跟踪器（封装一层便于单测与未来插桩）。"""
        if self.tracker is None:
            raise RuntimeError("未挂载 tracker")
        return self.tracker.update(detections)
