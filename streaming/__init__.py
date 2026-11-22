"""解码—跟踪链路在断流/重连场景下的协同组件。

本包是纯 Python 实现，承担两个职责：

1. 作为 ``cpp/Decoder.cpp``（NVDEC + FFmpeg 生产链路）关键状态机的**可本地测试
   参考实现**：PTS 对齐（``PtsAligner``）、显存复用（``ReusableFrameBuffer``）、
   断流重连（``StubDecoder``）两边语义保持一致，测试不依赖摄像头或 GPU。
2. 提供不依赖任何原生扩展的桩（stub），让整条 Pipeline 的协同逻辑可以在普通
   开发机上跑通（见 ``tests/`` 与 ``tests/README.md`` 中桩与生产链路的差异说明）。
"""

from .pts_align import PtsAligner
from .frame_buffer import ReusableFrameBuffer
from .stub_decoder import StubDecoder, StreamScript, StreamEvent
from .coordinator import StreamCoordinator, FramePacket

__all__ = [
    "PtsAligner",
    "ReusableFrameBuffer",
    "StubDecoder",
    "StreamScript",
    "StreamEvent",
    "StreamCoordinator",
    "FramePacket",
]
