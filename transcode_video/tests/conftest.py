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

"""Shared pytest fixtures for the transcode sample.

Everything here is constructed offline: the "video" inputs are tiny JSON
stub containers (see transcode_video.hw_backend.StubDemuxer) and no GPU,
pycuda or PyNvVideoCodec installation is required.
"""

import json
import os
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from transcode_video.hw_backend import (  # noqa: E402
    INTERNAL_FAIL_ENCODE_AT_FRAME,
    INTERNAL_FAIL_ENCODER_CREATE,
    StubBackend,
)
from transcode_video.transcode import transcode  # noqa: E402


def write_stub_container(path, frame_counts, width=320, height=240,
                         codec_id="h264"):
    """Write a stub container whose packets yield ``sum(frame_counts)`` frames.

    A zero entry in ``frame_counts`` produces a packet with no decodable
    frames, mirroring decoder buffering on real streams.
    """
    container = {
        "stub_container": "stub-container-v1",
        "codec_id": codec_id,
        "width": width,
        "height": height,
        "packets": [{"frames": count} for count in frame_counts],
    }
    with open(path, "w", encoding="utf-8") as handle:
        json.dump(container, handle)
    return path


@pytest.fixture
def backend():
    return StubBackend()


@pytest.fixture
def make_input(tmp_path):
    def _make(name="input.stub.json", frame_counts=(2, 3, 1), **kwargs):
        path = tmp_path / name
        write_stub_container(path, frame_counts, **kwargs)
        return path
    return _make


@pytest.fixture
def output_path(tmp_path):
    return tmp_path / "output.h264"


@pytest.fixture
def run_transcode(backend):
    """Call the real production transcode() with the offline backend."""
    def _run(in_path, out_path, config=None, **kwargs):
        return transcode(0, str(in_path), str(out_path),
                         config or {"codec": "h264", "preset": "P3"},
                         backend=backend, **kwargs)
    return _run


@pytest.fixture
def fail_encoder_create_config():
    return {"codec": "h264", "preset": "P3",
            INTERNAL_FAIL_ENCODER_CREATE: "boom"}


@pytest.fixture
def fail_encode_config():
    return {"codec": "h264", "preset": "P3",
            INTERNAL_FAIL_ENCODE_AT_FRAME: 2}
