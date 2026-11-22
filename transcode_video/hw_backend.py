# This copyright notice applies to this file only
#
# SPDX-FileCopyrightText: Copyright (c) 2024 NVIDIA CORPORATION & AFFILIATES. All rights reserved.
# SPDX-License-Identifier: MIT
#
# Permission is hereby granted, free of charge, to any person obtaining a
# copy of this software and associated documentation files (the "Software"),
# to deal in the Software without restriction, including without limitation
# the rights to use, copy, modify, merge, publish, distribute, sublicense,
# and/or sell copies of the Software, and to permit persons to whom the
# Software is furnished to do so, subject to the following conditions:
#
# The above copyright notice and this permission notice shall be included in
# all copies or substantial portions of the Software.
#
# THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
# IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
# FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT.  IN NO EVENT SHALL
# THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
# LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
# FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER
# DEALINGS IN THE SOFTWARE.

"""Hardware backend abstraction for the transcode sample.

The production backend (:class:`NvCodecBackend`) drives the real
``PyNvVideoCodec`` demuxer/decoder/encoder and ``pycuda`` device-memory copies.
The GPU stack is imported lazily inside that class so that this module can be
imported on machines without a GPU.

For offline development and CI, :class:`StubBackend` is a self-contained,
pure-Python replacement.  It reads a small documented *stub container* file
(plain JSON, see :mod:`transcode_video.tests` helpers) instead of a real
multiplexed video and emits a deterministic, self-describing elementary
bitstream.  The backend is selected with the ``TRANSCODE_BACKEND`` environment
variable (``stub`` / ``nvc``) or explicitly through :func:`get_backend`; the
default is the real hardware backend.
"""

import json
import os
import uuid

# Backend name used when TRANSCODE_BACKEND is unset.
DEFAULT_BACKEND = "nvc"

# Keys understood by the failure-injection hooks of StubBackend.  They are
# always stripped before the parameters reach a real encoder.
INTERNAL_KEY_PREFIX = "_"
INTERNAL_FAIL_ENCODER_CREATE = "_fail_encoder_create"
INTERNAL_FAIL_ENCODE_AT_FRAME = "_fail_encode_at_frame"


class BackendError(RuntimeError):
    """Raised by a backend when a hardware/IO operation cannot complete."""


def strip_internal_keys(config_params):
    """Remove test-only/internal options from encoder config params."""
    return {k: v for k, v in (config_params or {}).items()
            if not str(k).startswith(INTERNAL_KEY_PREFIX)}


# ---------------------------------------------------------------------------
# Pure-Python offline backend
# ---------------------------------------------------------------------------

class StubFrame:
    """Stand-in for an :class:`common.nvc_utils.AppFrame` GPU allocation."""

    def __init__(self, width, height, fmt):
        self.width = int(width)
        self.height = int(height)
        self.format = fmt
        # An integer address keeps the same "gpuAlloc" attribute shape as the
        # real AppFrame without touching the CUDA driver.
        self.gpuAlloc = int(uuid.uuid4())
        if fmt == "NV12":
            self.frameSize = int(width * height * 3 / 2)
        else:
            self.frameSize = int(width * height * 3)


class _StubDecodedFrame:
    def __init__(self, width, height):
        self._width = width
        self._height = height

    def GetPtrToPlane(self, plane):
        # A fake device address; the stub memcpy is a no-op.
        return (plane + 1) * 4096


class StubDecoder:
    def __init__(self, codec_id, width, height):
        self._codec_id = codec_id
        self._width = width
        self._height = height

    def Decode(self, packet):
        frame_count = int(packet.get("frames", 0))
        return [_StubDecodedFrame(self._width, self._height)
                for _ in range(frame_count)]

    def GetWidth(self):
        return self._width

    def GetHeight(self):
        return self._height

    def GetFrameSize(self):
        return int(self._width * self._height * 3 / 2)


class StubDemuxer:
    """Iterates the packets of a JSON stub container.

    Container schema::

        {
          "stub_container": "stub-container-v1",
          "codec_id": "h264",
          "width": 320,
          "height": 240,
          "packets": [{"frames": 2}, {"frames": 3}, {"frames": 0}]
        }
    """

    MAGIC = "stub-container-v1"

    def __init__(self, filename):
        with open(filename, "r", encoding="utf-8") as handle:
            container = json.load(handle)
        if container.get("stub_container") != self.MAGIC:
            raise BackendError(
                "%s is not a stub container (missing 'stub_container' marker)"
                % filename)
        self._codec_id = container.get("codec_id", "h264")
        self._width = int(container.get("width", 0))
        self._height = int(container.get("height", 0))
        self._packets = list(container.get("packets", []))

    def __iter__(self):
        return iter(self._packets)

    def GetNvCodecId(self):
        return self._codec_id

    @property
    def width(self):
        return self._width

    @property
    def height(self):
        return self._height


class StubEncoder:
    """Deterministic fake encoder producing a self-describing bitstream."""

    def __init__(self, width, height, fmt, config_params):
        fail_create = config_params.get(INTERNAL_FAIL_ENCODER_CREATE)
        if fail_create:
            raise BackendError(
                "Injected encoder-creation failure: %s" % fail_create)
        self.width = int(width)
        self.height = int(height)
        self.format = fmt
        self.config = strip_internal_keys(config_params)
        self._stream_id = uuid.uuid4().hex
        self._frame_idx = 0
        self._fail_at = config_params.get(INTERNAL_FAIL_ENCODE_AT_FRAME)

    def _packet(self, kind, seq):
        # Every emitted chunk carries this encoder's unique stream id, which
        # lets tests prove that two concurrent jobs never interleave chunks.
        payload = ("[%s|%s|seq=%d|%dx%d]"
                   % (self._stream_id, kind, seq, self.width, self.height))
        return payload.encode("ascii")

    def Encode(self, frame):
        if self._fail_at is not None and self._frame_idx == int(self._fail_at):
            raise BackendError(
                "Injected Encode() failure at frame %d" % self._frame_idx)
        packet = self._packet("frame", self._frame_idx)
        self._frame_idx += 1
        return packet

    def EndEncode(self):
        return self._packet("end", self._frame_idx)


class StubBackend:
    """Offline, dependency-free backend used for local testing without a GPU."""

    name = "stub"

    def __init__(self):
        # Test hooks (also drivable through TRANSCODE_* environment variables).
        self.fail_encoder_create = os.environ.get(
            "TRANSCODE_FAIL_ENCODER_CREATE", "") or None
        fail_at = os.environ.get("TRANSCODE_FAIL_ENCODE_AT_FRAME", "")
        self.fail_encode_at_frame = int(fail_at) if fail_at else None
        # Records the clean config of every encoder created in this process.
        self.encoder_configs = []

    def create_demuxer(self, filename):
        return StubDemuxer(filename)

    def create_decoder(self, gpu_id, codec_id, demuxer):
        return StubDecoder(codec_id, demuxer.width, demuxer.height)

    def alloc_frame(self, width, height, fmt):
        return StubFrame(width, height, fmt)

    def memcpy_dtod(self, dst, src, size):
        # Device-to-device copy is a no-op in the offline backend.
        return None

    def create_encoder(self, width, height, fmt, config_params):
        params = dict(config_params or {})
        if self.fail_encoder_create is not None and \
                INTERNAL_FAIL_ENCODER_CREATE not in params:
            params[INTERNAL_FAIL_ENCODER_CREATE] = self.fail_encoder_create
        if self.fail_encode_at_frame is not None and \
                INTERNAL_FAIL_ENCODE_AT_FRAME not in params:
            params[INTERNAL_FAIL_ENCODE_AT_FRAME] = self.fail_encode_at_frame
        encoder = StubEncoder(width, height, fmt, params)
        self.encoder_configs.append(dict(encoder.config))
        return encoder


# ---------------------------------------------------------------------------
# Production hardware backend (GPU stack imported lazily)
# ---------------------------------------------------------------------------

class NvCodecBackend:
    """Production backend backed by PyNvVideoCodec + pycuda."""

    name = "nvc"

    def __init__(self):
        try:
            import pycuda.driver as cuda  # noqa: F401
            import PyNvVideoCodec as nvc  # noqa: F401
            from common.nvc_utils import AppFrame  # noqa: F401
        except ImportError as exc:  # pragma: no cover - requires a GPU host
            raise BackendError(
                "The hardware backend requires pycuda and PyNvVideoCodec; "
                "install them or run with TRANSCODE_BACKEND=stub for offline "
                "testing. Original error: %s" % exc) from exc
        self._cuda = cuda
        self._nvc = nvc
        self._AppFrame = AppFrame

    def create_demuxer(self, filename):
        return self._nvc.CreateDemuxer(filename=filename)

    def create_decoder(self, gpu_id, codec_id, demuxer):
        # The original sample hard-codes gpuid/context/stream to 0; the
        # gpu_id argument is retained for API compatibility and documented as
        # unused upstream.
        return self._nvc.CreateDecoder(gpuid=0,
                                       codec=codec_id,
                                       cudacontext=0,
                                       cudastream=0,
                                       usedevicememory=True)

    def alloc_frame(self, width, height, fmt):
        return self._AppFrame(width, height, fmt)

    def memcpy_dtod(self, dst, src, size):
        self._cuda.memcpy_dtod(dst, src, size)

    def create_encoder(self, width, height, fmt, config_params):
        clean_params = strip_internal_keys(config_params)
        return self._nvc.CreateEncoder(width, height, fmt, False,
                                       **clean_params)


def get_backend(name=None):
    """Return a backend instance by name.

    Selection order: explicit *name* argument, then the ``TRANSCODE_BACKEND``
    environment variable, then :data:`DEFAULT_BACKEND` (the real GPU backend).
    """
    selected = (name or os.environ.get("TRANSCODE_BACKEND")
                or DEFAULT_BACKEND).lower()
    if selected == "stub":
        return StubBackend()
    if selected in ("nvc", "nvcodec", "hardware"):
        return NvCodecBackend()
    raise BackendError("Unknown backend %r (expected 'stub' or 'nvc')"
                       % selected)
