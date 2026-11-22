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

"""Tests for the transcode() lifecycle: normal run, empty stream, failures."""

import os
import re

import pytest

from transcode_video.hw_backend import BackendError
from transcode_video.transcode import _AtomicOutput, transcode

PACKET_RE = re.compile(rb"\[([0-9a-f]+)\|(frame|end)\|seq=(\d+)\|(\d+)x(\d+)\]")


def parse_packets(data):
    return [(m.group(1).decode(), m.group(2).decode(), int(m.group(3)),
             int(m.group(4)), int(m.group(5)))
            for m in PACKET_RE.finditer(data)]


def list_temp_files(directory):
    return [name for name in os.listdir(directory)
            if name.startswith(".transcode-") and name.endswith(".tmp")]


def test_normal_multiframe_transcode(make_input, output_path, run_transcode):
    in_path = make_input(frame_counts=(2, 3, 1))  # 6 frames total
    frame_count = run_transcode(in_path, output_path)

    assert frame_count == 6
    assert output_path.exists()
    packets = parse_packets(output_path.read_bytes())
    # Six frame packets followed by the single flush/end packet.
    assert len(packets) == 7
    assert [kind for _, kind, _, _, _ in packets[:-1]] == ["frame"] * 6
    assert packets[-1][1] == "end"
    assert [seq for _, kind, seq, _, _ in packets if kind == "frame"] == \
        [0, 1, 2, 3, 4, 5]
    # Dimensions propagated from the stub container.
    assert {(w, h) for _, _, _, w, h in packets} == {(320, 240)}
    # Every packet comes from one encoder instance (single coherent stream).
    assert {stream for stream, _, _, _, _ in packets} == {packets[0][0]}
    # No staged temp files are left behind after a successful run.
    assert list_temp_files(output_path.parent) == []


def test_packet_with_zero_frames_does_not_create_encoder(
        make_input, output_path, run_transcode, backend):
    in_path = make_input(frame_counts=(0, 2, 0, 1))  # 3 real frames
    frame_count = run_transcode(in_path, output_path)
    assert frame_count == 3
    packets = parse_packets(output_path.read_bytes())
    assert len(packets) == 4  # 3 frames + end


def test_empty_input_completes_normally_with_empty_output(
        make_input, output_path, run_transcode, backend):
    # No packets at all: demuxer yields nothing, decoder never outputs frames.
    in_path = make_input(frame_counts=())
    frame_count = run_transcode(in_path, output_path)

    assert frame_count == 0
    # A recognizable empty result: the file exists, is valid and zero-length,
    # rather than a crash in EndEncode() or a half-written artifact.
    assert output_path.exists()
    assert output_path.read_bytes() == b""
    assert list_temp_files(output_path.parent) == []


def test_packets_but_zero_decodable_frames_completes_normally(
        make_input, output_path, run_transcode):
    in_path = make_input(frame_counts=(0, 0, 0))
    frame_count = run_transcode(in_path, output_path)
    assert frame_count == 0
    assert output_path.exists()
    assert output_path.read_bytes() == b""
    assert list_temp_files(output_path.parent) == []


def test_encoder_creation_failure_cleans_up_output(
        make_input, output_path, fail_encoder_create_config, backend):
    in_path = make_input(frame_counts=(2, 2))
    with pytest.raises(BackendError):
        transcode(0, str(in_path), str(output_path),
                  fail_encoder_create_config, backend=backend)

    # No seemingly-successful but incomplete file at the destination.
    assert not output_path.exists()
    assert list_temp_files(output_path.parent) == []


def test_midstream_encode_failure_cleans_up_partial_output(
        make_input, output_path, fail_encode_config, backend):
    in_path = make_input(frame_counts=(5,))  # failure injected at frame 2
    with pytest.raises(BackendError):
        transcode(0, str(in_path), str(output_path),
                  fail_encode_config, backend=backend)

    assert not output_path.exists()
    assert list_temp_files(output_path.parent) == []


def test_failure_replaces_previously_good_output_instead_of_truncating_it(
        make_input, output_path, run_transcode, fail_encode_config, backend):
    good_input = make_input(name="good.json", frame_counts=(2, 2))
    run_transcode(good_input, output_path)
    good_bytes = output_path.read_bytes()
    assert good_bytes

    bad_input = make_input(name="bad.json", frame_counts=(5,))
    with pytest.raises(BackendError):
        transcode(0, str(bad_input), str(output_path),
                  fail_encode_config, backend=backend)

    # The previous good output is untouched, never truncated into a partial
    # file, because the failed run staged everything in a temp file.
    assert output_path.exists()
    assert output_path.read_bytes() == good_bytes
    assert list_temp_files(output_path.parent) == []


def test_demuxer_failure_leaves_no_output_at_all(tmp_path, output_path,
                                                 run_transcode):
    bogus = tmp_path / "bogus.json"
    bogus.write_text('{"stub_container": "wrong-marker", "packets": []}',
                     encoding="utf-8")
    with pytest.raises(BackendError):
        run_transcode(bogus, output_path)
    assert not output_path.exists()
    assert list_temp_files(output_path.parent) == []


def test_atomic_output_rollback_removes_tempfile(tmp_path):
    destination = tmp_path / "out.h264"
    output = _AtomicOutput(destination)
    output.write(b"partial")
    output.rollback()
    assert not destination.exists()
    assert list_temp_files(tmp_path) == []


def test_atomic_output_context_commit_and_rollback(tmp_path):
    destination = tmp_path / "out.h264"
    with _AtomicOutput(destination) as output:
        output.write(b"complete")
    assert destination.read_bytes() == b"complete"

    with pytest.raises(RuntimeError):
        with _AtomicOutput(tmp_path / "out2.h264") as output:
            output.write(b"never committed")
            raise RuntimeError("boom")
    assert not (tmp_path / "out2.h264").exists()
    assert list_temp_files(tmp_path) == []
