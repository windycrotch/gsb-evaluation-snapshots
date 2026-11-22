"""固定尺寸帧缓冲复用（对应 ``cpp/Decoder.cpp`` 的 ``reusable_buf``）。

生产链路里 NVDEC→NPP 输出的 BGR tensor 缓存在 Decoder 成员 ``bgr_buf_`` /
``resized_buf_`` 中：尺寸不变时所有帧复用同一块显存，避免每帧
``torch::empty`` 触发的缓存分配器抖动。代价是**下一次取帧会覆盖上一帧的
内容**——调用方若需跨帧持有旧帧，必须先 ``.clone()`` / ``.cpu()`` 拷贝。

本类在 CPU numpy 数组上复刻同一份所有权语义，供本地测试与纯 Python 链路使用。
"""

from __future__ import annotations

from typing import Optional, Tuple

import numpy as np


class ReusableFrameBuffer:
    """按 (H, W, channels) 复用同一块数组的帧缓冲。

    维度不变时 :meth:`get` 永远返回同一个数组对象（``id()`` 不变、
    ``data_ptr``/``ctypes.data`` 不变）；尺寸变化时才重新分配，旧数组自然释放，
    与 C++ 侧 ``cache.defined() && size 匹配`` 的分支一一对应。
    """

    def __init__(self, channels: int = 3, dtype=np.uint8) -> None:
        self.channels = channels
        self.dtype = dtype
        self._buf: Optional[np.ndarray] = None
        self._shape: Optional[Tuple[int, int, int]] = None
        self.allocs = 0  # 测试用：实际发生底层分配的次数

    def get(self, height: int, width: int) -> np.ndarray:
        shape = (height, width, self.channels)
        if self._buf is None or self._shape != shape:
            self._buf = np.empty(shape, dtype=self.dtype)
            self._shape = shape
            self.allocs += 1
        return self._buf

    def write(self, frame: np.ndarray) -> np.ndarray:
        """把 ``frame`` 拷入复用缓冲并返回缓冲本身。

        返回值与上一次 :meth:`write` 的返回值共享存储（尺寸不变时），因此旧引用
        会读到新内容——这正是生产侧需要调用方注意的覆盖语义。
        """
        frame = np.asarray(frame)
        buf = self.get(frame.shape[0], frame.shape[1])
        np.copyto(buf, frame)
        return buf

    @property
    def shape(self):
        return self._shape

    def release(self) -> None:
        self._buf = None
        self._shape = None
