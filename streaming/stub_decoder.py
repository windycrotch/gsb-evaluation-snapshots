"""不依赖摄像头 / GPU / FFmpeg 的解码器桩。

``StubDecoder`` 在帧序列、断流重连、坏帧计数、PTS 对齐、缓冲复用这五件事上
模拟 ``cpp.Decoder`` 的外部行为，使整条 Pipeline 可以在普通开发机上测试。

桩与生产链路的差异见 ``tests/README.md``。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import List, Optional, Tuple

import numpy as np

from .frame_buffer import ReusableFrameBuffer
from .pts_align import PtsAligner


class StreamEndedError(RuntimeError):
    """重连次数用尽，流彻底无信号（对应 C++ 侧抛出的"无信号，重连N次失败"）。"""


@dataclass
class StreamEvent:
    """脚本化的流事件。

    kind:
        ``"frame"``   正常帧；
        ``"outage"``  断流：随后 ``length`` 次取帧触发读取失败并自动重连；
        ``"bad"``     连续 ``length`` 个解码异常帧（对应生产侧 NPP/帧数据异常，
                      累计到阈值后触发重拉）；
        ``"pts_jump"`` 下一帧的源 pts 相对正常节奏额外偏移 ``offset_s`` 秒；
        ``"pts_reset"`` 源 pts 回到 0（模拟摄像头重启后时间戳归零）。
    """

    kind: str
    at: int = 0
    length: int = 1
    offset_s: float = 0.0


@dataclass
class StreamScript:
    """按帧号编排的确定性事件脚本。"""

    events: List[StreamEvent] = field(default_factory=list)
    total_frames: int = 60

    def __post_init__(self):
        self._by_frame = {}
        for ev in self.events:
            self._by_frame.setdefault(ev.at, []).append(ev)
    def at(self, frame_no: int) -> List[StreamEvent]:
        return self._by_frame.get(frame_no, [])


class StubDecoder:
    """``cpp.Decoder`` 的纯 Python 桩，接口对齐：``next_frame() -> (ndarray, pts)``。

    与生产侧一致的行为：

    * 尺寸不变时返回的数组复用同一块内存（见 :class:`ReusableFrameBuffer`）；
    * 输出 pts 由 :class:`PtsAligner` 对齐，断流/时间戳回退后仍单调递增；
    * 连续坏帧达到 ``bad_frame_threshold`` 触发重拉；
    * 重连有次数上限（``max_reconnects``），耗尽后抛 :class:`StreamEndedError`；
    * 重连成功后置位 ``reconnect_count``，供协调层通知跟踪器续轨。
    """

    def __init__(
        self,
        script: Optional[StreamScript] = None,
        fps: float = 25.0,
        width: int = 64,
        height: int = 48,
        max_reconnects: int = 5,
        bad_frame_threshold: int = 5,
        max_delay_ms: int = 200,
    ) -> None:
        self.script = script or StreamScript()
        self.fps = fps
        self.width = width
        self.height = height
        # 0 表示无限重连（与生产侧 max_reconnects=0 的语义一致）
        self.max_reconnects = max_reconnects
        self.bad_frame_threshold = bad_frame_threshold

        self._aligner = PtsAligner(fps=fps, max_delay_s=max_delay_ms / 1000.0)
        self._buffer = ReusableFrameBuffer()
        # 源帧序号（断流期间不增长），用于生成确定性画面与源 pts
        self._source_index = 0
        # 已交付的正常帧计数
        self._delivered = 0
        self._bad_streak = 0
        self._outage_remaining = 0
        self._bad_remaining = 0
        self._pending_pts_offset = 0.0
        self._source_pts_reset = False
        # 已消费过的事件 id（同一帧号在重连重试循环中可能多次进入，
        # 事件只能生效一次，否则 outage 会被反复触发直到重连预算耗尽）
        self._applied_events: set = set()

        self.reconnect_count = 0
        self.reconnect_attempts_failed = 0
        self._reconnect_pending = False
        self.finished = False

    # 与 pybind 暴露的生产接口同名 -------------------------------------------
    def get_fps(self) -> float:
        return self.fps

    def get_width(self) -> int:
        return self.width

    def get_height(self) -> int:
        return self.height

    def consume_reconnect(self) -> bool:
        """读取并清除"上一次 next_frame 期间发生过重连"标志。"""
        if self.reconnect_count > 0 and getattr(self, "_reconnect_pending", False):
            self._reconnect_pending = False
            return True
        return False

    # -- 内部状态机 ----------------------------------------------------------
    def _apply_events(self) -> None:
        for ev in self.script.at(self._delivered):
            if id(ev) in self._applied_events:
                continue
            self._applied_events.add(id(ev))
            if ev.kind == "outage":
                self._outage_remaining += ev.length
            elif ev.kind == "bad":
                self._bad_remaining += ev.length
            elif ev.kind == "pts_jump":
                self._pending_pts_offset += ev.offset_s
            elif ev.kind == "pts_reset":
                self._source_pts_reset = True
            else:
                raise ValueError(f"未知事件类型: {ev.kind}")

    def _try_reconnect(self) -> bool:
        # max_reconnects == 0 表示无限重连，与 cpp/Decoder.cpp 的 while 条件一致
        if self.max_reconnects != 0 and self.reconnect_count >= self.max_reconnects:
            self.finished = True
            return False
        # 桩的重连立即成功（生产侧有 reconnect_delay_ms 的 sleep 与 open 超时）
        self.reconnect_count += 1
        self._reconnect_pending = True
        self._outage_remaining = 0
        self._bad_streak = 0
        # 与 C++ try_reconnect 对齐：重置源 pts 基准，保留输出轴
        self._aligner.on_reconnect()
        return True

    def _make_frame(self) -> np.ndarray:
        # 画面内容由源序号决定，灰度值随序号缓慢变化；角落写入源序号的低 8 位，
        # 相邻帧该字节必然不同（序号连续递增），便于测试断言"帧内容正确"。
        value = int((self._source_index * 7) % 200) + 1
        raw = np.full((self.height, self.width, 3), value, dtype=np.uint8)
        raw[0, 0] = self._source_index & 0xFF
        return self._buffer.write(raw)

    def _source_pts(self) -> float:
        if self._source_pts_reset:
            self._source_pts_reset = False
            base = 0.0
        else:
            base = self._source_index / self.fps
        return base + self._pending_pts_offset

    def next_frame(self) -> Tuple[np.ndarray, float]:
        if self.finished:
            raise StreamEndedError("流已结束且重连次数耗尽")

        while True:
            if self._delivered >= self.script.total_frames:
                raise StreamEndedError("脚本帧已全部交付")

            self._apply_events()

            # 断流：模拟 av_read_frame 失败 → 重连
            if self._outage_remaining > 0:
                self._outage_remaining -= 1
                if not self._try_reconnect():
                    raise StreamEndedError("断流后重连次数耗尽")
                continue

            # 坏帧：模拟 process_frame 抛异常 → 跳过；连续超阈值触发重拉
            if self._bad_remaining > 0:
                self._bad_remaining -= 1
                self._bad_streak += 1
                if self._bad_streak >= self.bad_frame_threshold:
                    # 生产侧：重拉时 flush 解码器、重建 format/codec 上下文
                    if not self._try_reconnect():
                        raise StreamEndedError("连续异常帧后重拉失败")
                continue

            # 正常帧
            source_pts = self._source_pts()
            out_pts = self._aligner.align(source_pts)
            frame = self._make_frame()

            self._source_index += 1
            self._delivered += 1
            self._bad_streak = 0
            return frame, out_pts

    @property
    def buffer_allocations(self) -> int:
        return self._buffer.allocs
