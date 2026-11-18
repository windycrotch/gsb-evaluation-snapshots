# SPDX-FileCopyrightText: Copyright (c) 2024-2026 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: Apache-2.0
#
# Licensed under the Apache License, Version 2.0 (the "License");
# you may not use this file except in compliance with the License.
# You may obtain a copy of the License at
#
# http://www.apache.org/licenses/LICENSE-2.0
#
# Unless required by applicable law or agreed to in writing, software
# distributed under the License is distributed on an "AS IS" BASIS,
# WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
# See the License for the specific language governing permissions and
# limitations under the License.

"""
Tests for the streaming codec fixes in common/vpf_utils.py.

These tests replace the heavy GPU dependencies (PyNvVideoCodec / PyNvCodec /
PytorchNvCodec / cvcuda / av) with lightweight CPU-only stand-ins, so they can
run under plain pytest without a GPU:

1. The decoder rebuilds its pre-allocated RGB tensor when the batch size
   changes, so every output batch matches the current batch size.
2. Decoder flush sizes the last batch from the frames actually flushed
   (which may be fewer than total_frames suggests) instead of an estimate.
3. Decoder flush returns None when no frames are flushed at all.
4. The encoder reads width/height from an NHWC tensor without swapping them
   for non-square frames, and rebuilds its YUV tensor on batch size change.
"""

import enum
import os
import sys
import types
from types import SimpleNamespace

import numpy as np
import pytest
import torch

# ---------------------------------------------------------------------------
# Lightweight stubs for the heavy dependencies, installed before importing
# common.vpf_utils (which imports them at module load time).
# ---------------------------------------------------------------------------


class _FakeCvcudaTensor:
    """Stand-in for cvcuda.Tensor. Only a shape-carrying container."""

    def __init__(self, shape, dtype=None, layout=None):
        self.shape = tuple(int(s) for s in shape)
        self.dtype = dtype
        self.layout = layout
        self.data = np.zeros(self.shape, dtype=np.uint8)

    def cuda(self):
        # Used by the encoder before torch.as_tensor(...); return a CPU tensor.
        return torch.from_numpy(self.data)


def _fake_as_tensor(data, layout=None):
    return _FakeCvcudaTensor(tuple(data.shape), layout=layout)


def _fake_cvtcolor_into(dst, src, code):
    # Mimic the real operator's hard requirement: batch dims must agree.
    if dst.shape[0] != src.shape[0]:
        raise ValueError(
            f"cvtcolor_into batch mismatch: dst {dst.shape} vs src {src.shape}"
        )


cvcuda_stub = types.ModuleType("cvcuda")
cvcuda_stub.Tensor = _FakeCvcudaTensor
cvcuda_stub.as_tensor = _fake_as_tensor
cvcuda_stub.cvtcolor_into = _fake_cvtcolor_into
cvcuda_stub.ColorConversion = SimpleNamespace(
    YUV2RGB_NV12="YUV2RGB_NV12",
    YUV2RGB="YUV2RGB",
    RGB2YUV_NV12="RGB2YUV_NV12",
)
cvcuda_stub.Type = SimpleNamespace(U8="uint8")
cvcuda_stub.TensorLayout = SimpleNamespace(NHWC="NHWC")


class _FakePlane:
    """Stand-in for a VPF surface plane (all accessors are methods in VPF)."""

    def __init__(self, width, height):
        self._width = width
        self._height = height

    def GpuMem(self):
        return 0

    def Width(self):
        return self._width

    def Height(self):
        return self._height

    def Pitch(self):
        return self._width

    def ElemSize(self):
        return 1


class _FakeSurface:
    """Stand-in for a VPF NV12 surface. Plane height is 1.5x RGB height."""

    def __init__(self, width=0, height=0, empty=False):
        self._width = width
        self._height = height
        self._empty = empty

    def Empty(self):
        return self._empty

    def PlanePtr(self):
        return _FakePlane(self._width, (self._height * 3) // 2)


class _FakeSurfaceFactory:
    """Records the dimensions of the last Surface.Make call."""

    last_make = None

    @staticmethod
    def Make(format, width, height, context=None, gpu_id=None):
        _FakeSurfaceFactory.last_make = {"width": width, "height": height}
        return _FakeSurface(width, height)


class _FakePacketData:
    def __init__(self):
        self.key = self.pts = self.dts = 0
        self.pos = self.bsl = self.duration = 0


class _FakePyNvDecoder:
    """Async-decoder stand-in with scripted decode/flush results."""

    def __init__(self, w, h, pix_fmt, codec, ctx_handle, str_handle):
        self.decode_queue = []  # surfaces returned by DecodeSurfaceFromPacket
        self.flush_queue = []  # surfaces returned by FlushSingleSurface

    def DecodeSurfaceFromPacket(self, packet_data, packet):
        if self.decode_queue:
            return self.decode_queue.pop(0)
        return _FakeSurface(empty=True)

    def FlushSingleSurface(self):
        if self.flush_queue:
            return self.flush_queue.pop(0)
        return _FakeSurface(empty=True)


class _FakePyNvEncoder:
    def __init__(self, opts, ctx_handle, str_handle):
        self.opts = opts

    def EncodeSingleSurface(self, surface, packet):
        return True

    def FlushSinglePacket(self, packet):
        return False


class _PixelFormat(enum.IntEnum):
    YUV420 = 0
    NV12 = 1
    YUV444 = 2


class _CudaVideoCodec(enum.IntEnum):
    H264 = 0
    HEVC = 1


class _ColorSpace(enum.IntEnum):
    UNSPEC = 0
    BT_601 = 1


class _ColorRange(enum.IntEnum):
    UDEF = 0
    MPEG = 1


nvc_stub = types.ModuleType("PyNvCodec")
nvc_stub.PixelFormat = _PixelFormat
nvc_stub.CudaVideoCodec = _CudaVideoCodec
nvc_stub.ColorSpace = _ColorSpace
nvc_stub.ColorRange = _ColorRange
nvc_stub.PacketData = _FakePacketData
nvc_stub.Surface = _FakeSurfaceFactory
nvc_stub.PyNvDecoder = _FakePyNvDecoder
nvc_stub.PyNvEncoder = _FakePyNvEncoder
nvc_stub.ColorspaceConversionContext = lambda cspace, crange: (cspace, crange)
nvc_stub.PyFFmpegDemuxer = None  # client-side only, not exercised here


def _makefromDevicePtrUint8(gpu_mem, width, height, pitch, elem_size):
    # VPF exports the NV12 plane as a [H, W] uint8 torch tensor.
    return torch.zeros((height, width), dtype=torch.uint8)


pnvc_stub = types.ModuleType("PytorchNvCodec")
pnvc_stub.makefromDevicePtrUint8 = _makefromDevicePtrUint8
pnvc_stub.TensorToDptr = lambda *args, **kwargs: None

pynvvideocodec_stub = types.ModuleType("PyNvVideoCodec")

av_stub = types.ModuleType("av")
av_stub.open = lambda *args, **kwargs: None
av_stub.packet = SimpleNamespace(Packet=lambda data: data)

sys.modules["cvcuda"] = cvcuda_stub
sys.modules["PyNvCodec"] = nvc_stub
sys.modules["PytorchNvCodec"] = pnvc_stub
sys.modules["PyNvVideoCodec"] = pynvvideocodec_stub
sys.modules["av"] = av_stub

_REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _REPO_ROOT not in sys.path:
    sys.path.insert(0, _REPO_ROOT)

from common import vpf_utils  # noqa: E402

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

WIDTH, HEIGHT = 16, 8  # NV12 plane height is 12 (1.5x)
PACKET_DATA1 = (1, 0, 0)  # key, pts, dts
PACKET_DATA2 = (0, 0, 0)  # pos, bsl, duration


class _FakeLogger:
    def log_info(self, msg):
        pass

    def info(self, msg):
        pass

    def debug(self, msg):
        pass

    def warning(self, msg):
        pass


def _make_decoder(batch_size=2, total_frames=4):
    dec = vpf_utils.nvstreamingdecoder("server", _FakeLogger())
    metadata = (
        batch_size,
        WIDTH,
        HEIGHT,
        30,  # fps
        total_frames,
        int(_PixelFormat.NV12),
        int(_CudaVideoCodec.HEVC),
        int(_ColorSpace.BT_601),
        int(_ColorRange.MPEG),
    )
    dec.server_setup(
        0, SimpleNamespace(handle=0), SimpleNamespace(handle=0), metadata
    )
    return dec


def _recv_packet(dec, is_last=False):
    return dec.server_recv(b"packet", PACKET_DATA1, PACKET_DATA2, is_last)


# ---------------------------------------------------------------------------
# Decoder tests
# ---------------------------------------------------------------------------


def test_decoder_rebuilds_rgb_tensor_on_batch_size_change():
    """After the client re-initiates with a different batch size, the decoded
    batch tensor must match the new batch size (not the first-seen one)."""
    dec = _make_decoder(batch_size=2)

    # First stream: batch size 2.
    dec.nvDec.decode_queue = [_FakeSurface(WIDTH, HEIGHT) for _ in range(2)]
    assert _recv_packet(dec) is None  # batch not full yet
    out = _recv_packet(dec)
    assert out.shape == (2, HEIGHT, WIDTH, 3)

    # Client re-initiates with batch size 3 on the same decoder object:
    # metadata is refreshed but the pre-allocated tensor still has batch 2.
    dec.frame_batch_size = 3
    dec.nvDec.decode_queue = [_FakeSurface(WIDTH, HEIGHT) for _ in range(3)]
    assert _recv_packet(dec) is None
    assert _recv_packet(dec) is None
    out = _recv_packet(dec)
    # Must not raise a batch mismatch in cvtcolor_into, and must match bs=3.
    assert out.shape == (3, HEIGHT, WIDTH, 3)


def test_decoder_flush_uses_actual_flushed_frame_count():
    """When the async decoder flushes fewer frames than total_frames implies,
    the last batch must be sized by the actual frames collected."""
    dec = _make_decoder(batch_size=4, total_frames=10)

    # One decoded frame waits unbatched; 5 frames decoded so far in total.
    dec.frame_batch = [torch.zeros((HEIGHT * 3 // 2, WIDTH), dtype=torch.uint8)]
    dec.total_decoded = 5
    # The old estimate would be 1 + 10 - 5 = 6, but only 2 frames flush out.
    dec.nvDec.flush_queue = [_FakeSurface(WIDTH, HEIGHT) for _ in range(2)]

    out = dec.flush()
    # 1 buffered + 2 flushed = 3 actual frames; no dimension mismatch raised.
    assert out.shape == (3, HEIGHT, WIDTH, 3)
    assert dec.total_decoded == 7


def test_decoder_flush_returns_none_when_no_frames():
    """Flushing an already-drained decoder returns None, not an empty tensor."""
    dec = _make_decoder(batch_size=2, total_frames=2)
    dec.total_decoded = 2  # everything already decoded, nothing left to flush

    assert dec.flush() is None


# ---------------------------------------------------------------------------
# Encoder test
# ---------------------------------------------------------------------------


def test_encoder_non_square_frame_keeps_width_height(monkeypatch):
    """NHWC input with H != W must not get its width/height swapped, and the
    YUV tensor must be (re)allocated on first use and on batch size change."""
    enc = vpf_utils.nvstreamingencoder("server", _FakeLogger())
    enc.server_setup(None, SimpleNamespace(handle=0), SimpleNamespace(handle=0), 30)

    # torch.as_tensor(..., device="cuda") needs no GPU in this test.
    real_as_tensor = torch.as_tensor
    monkeypatch.setattr(
        torch, "as_tensor", lambda data, device=None: real_as_tensor(data)
    )

    # NHWC: N=2, H=4, W=8 (non-square on purpose).
    frame_batch = _FakeCvcudaTensor((2, 4, 8, 3), layout="NHWC")
    packets = enc.server_send(frame_batch)

    assert len(packets) == 2
    assert (enc.width, enc.height) == (8, 4)
    # Encoder resolution string is "WxH".
    assert enc.nvEnc.opts["s"] == "8x4"
    # NV12 batch tensor: (N, 1.5*H, W, 1) — not (N, 1.5*W, H, 1).
    assert enc.cvcuda_YUVtensor_batch.shape == (2, 6, 8, 1)
    # The VPF surface must be created with the same unswapped dimensions.
    assert _FakeSurfaceFactory.last_make == {"width": 8, "height": 4}

    # Batch size change triggers re-allocation with the new batch dim.
    enc.server_send(_FakeCvcudaTensor((3, 4, 8, 3), layout="NHWC"))
    assert enc.cvcuda_YUVtensor_batch.shape == (3, 6, 8, 1)
