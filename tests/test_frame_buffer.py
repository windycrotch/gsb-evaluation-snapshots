"""ReusableFrameBuffer 的验收测试：同尺寸复用存储、尺寸变化才重分配、
跨帧持有旧引用会读到被覆盖的内容（与 C++ reusable_buf 同一份所有权语义）。
"""

import numpy as np

from streaming.frame_buffer import ReusableFrameBuffer


def test_same_size_reuses_same_storage():
    buf = ReusableFrameBuffer()
    a = buf.write(np.full((48, 64, 3), 1, dtype=np.uint8))
    b = buf.write(np.full((48, 64, 3), 2, dtype=np.uint8))
    c = buf.write(np.full((48, 64, 3), 3, dtype=np.uint8))

    # 底层只分配过一次
    assert buf.allocs == 1
    # 返回的是同一个数组对象
    assert a is b is c
    assert a.shape == (48, 64, 3)


def test_holding_old_reference_reads_overwritten_content():
    """复用语义的核心警示：调用方跨帧持有的旧帧会被下一帧覆盖。

    生产链路（NVDEC→NPP→bgr_buf_）同理，所以 main.py 在同一轮取帧内完成
    检测/绘制/编码，需要保留时显式 .cpu()/.clone()。
    """
    buf = ReusableFrameBuffer()
    first = buf.write(np.full((10, 10, 3), 7, dtype=np.uint8))
    first_snapshot = first.copy()  # 正确做法：先拷贝再跨帧持有

    buf.write(np.full((10, 10, 3), 9, dtype=np.uint8))

    # 旧引用已被覆盖
    assert np.all(first == 9)
    # 拷贝不受影响
    assert np.all(first_snapshot == 7)


def test_size_change_reallocates_and_old_buffer_detaches():
    buf = ReusableFrameBuffer()
    small = buf.write(np.zeros((8, 8, 3), dtype=np.uint8))
    assert buf.allocs == 1

    large = buf.write(np.zeros((16, 16, 3), dtype=np.uint8))
    assert buf.allocs == 2
    assert small is not large
    assert large.shape == (16, 16, 3)

    # 切回原尺寸会再次分配（与 C++ 侧尺寸不匹配即 torch::empty 的分支一致）
    again = buf.write(np.zeros((8, 8, 3), dtype=np.uint8))
    assert buf.allocs == 3
    assert again is not small


def test_content_roundtrip():
    buf = ReusableFrameBuffer()
    frame = np.arange(4 * 5 * 3, dtype=np.uint8).reshape(4, 5, 3)
    out = buf.write(frame)
    assert np.array_equal(out, frame)
