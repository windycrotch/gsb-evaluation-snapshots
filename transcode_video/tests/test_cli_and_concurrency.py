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

"""End-to-end CLI tests, including two-process contention on one output.

These exercise the real argparse entry point in transcode.py through a
subprocess, proving argument parsing and transcode() genuinely cooperate.
The offline stub backend is selected with TRANSCODE_BACKEND=stub so no GPU
is required.
"""

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import pytest

from transcode_video.tests.conftest import write_stub_container
from transcode_video.transcode import main, parse_args

REPO_ROOT = Path(__file__).resolve().parents[2]
SCRIPT = REPO_ROOT / "transcode_video" / "transcode.py"
PACKET_RE = re.compile(rb"\[([0-9a-f]+)\|(frame|end)\|seq=(\d+)\|")


def run_cli(*cli_args, extra_env=None):
    env = dict(os.environ)
    env["TRANSCODE_BACKEND"] = "stub"
    if extra_env:
        env.update(extra_env)
    return subprocess.run(
        [sys.executable, str(SCRIPT), *cli_args],
        cwd=str(REPO_ROOT),
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
    )


@pytest.fixture
def json_config(tmp_path):
    path = tmp_path / "encode.json"
    path.write_text(json.dumps({
        "codec": "hevc",
        "preset": "P5",
        "tuning_info": "high_quality",
        "rc": "vbr",
        "fps": 25,
        "bitrate": "10M",
    }), encoding="utf-8")
    return path


def test_parser_wires_all_arguments():
    args = parse_args([
        "-g", "0", "-i", "in.mp4", "-o", "out.h264",
        "-c", "H264", "-p", "p4", "-json", "cfg.json"])
    assert args.gpu_id == 0
    assert args.in_file_path == Path("in.mp4")
    assert args.out_file_path == Path("out.h264")
    assert args.codec == "H264"
    assert args.preset == "p4"
    assert args.config_file == "cfg.json"


def test_parser_omitted_preset_is_none_not_empty_string():
    args = parse_args(["-i", "in.mp4", "-o", "out.h264", "-c", "h264"])
    assert args.preset is None


def test_cli_normal_multiframe_run(tmp_path):
    in_path = tmp_path / "in.json"
    write_stub_container(in_path, (3, 4))  # 7 frames
    out_path = tmp_path / "out.h264"

    result = run_cli("-i", str(in_path), "-o", str(out_path),
                     "-c", "h264", "-p", "P1")
    assert result.returncode == 0, result.stderr
    assert out_path.exists()
    packets = PACKET_RE.findall(out_path.read_bytes())
    assert len(packets) == 8  # 7 frames + end packet
    assert packets[-1][1] == b"end"


def test_cli_empty_input_exits_zero_with_empty_file(tmp_path):
    in_path = tmp_path / "empty.json"
    write_stub_container(in_path, ())
    out_path = tmp_path / "out.h264"

    result = run_cli("-i", str(in_path), "-o", str(out_path), "-c", "h264")
    assert result.returncode == 0, result.stderr
    assert out_path.exists()
    assert out_path.read_bytes() == b""


def test_cli_mixed_json_and_cli_config(tmp_path, json_config):
    in_path = tmp_path / "in.json"
    write_stub_container(in_path, (2,))
    out_path = tmp_path / "out.h264"

    # First prove the real CLI accepts the mixed invocation end to end.
    result = run_cli("-i", str(in_path), "-o", str(out_path),
                     "-c", "av1", "-p", "p2",
                     "-json", str(json_config))
    assert result.returncode == 0, result.stderr

    # Then rebuild the config exactly as main() does and inspect what the
    # encoder receives, proving the merge precedence.
    from transcode_video.hw_backend import StubBackend
    from transcode_video.transcode import build_config, transcode
    merged_config = build_config(str(json_config), codec="av1", preset="p2")
    backend = StubBackend()
    transcode(0, str(in_path), str(out_path), merged_config, backend=backend)

    merged = backend.encoder_configs[-1]
    assert merged["codec"] == "av1"       # CLI override, normalized
    assert merged["preset"] == "P2"       # CLI override, normalized
    assert merged["tuning_info"] == "high_quality"  # JSON fields retained
    assert merged["rc"] == "vbr"
    assert merged["fps"] == 25
    assert merged["bitrate"] == "10M"


def test_cli_midstream_failure_exits_nonzero_and_removes_output(tmp_path):
    in_path = tmp_path / "in.json"
    write_stub_container(in_path, (5,))
    out_path = tmp_path / "out.h264"

    result = run_cli("-i", str(in_path), "-o", str(out_path),
                     "-c", "h264", "-p", "P1",
                     extra_env={"TRANSCODE_FAIL_ENCODE_AT_FRAME": "2"})
    assert result.returncode == 1
    assert "transcode failed" in result.stderr
    assert not out_path.exists()
    leftovers = [name for name in os.listdir(tmp_path)
                 if name.endswith(".tmp")]
    assert leftovers == []


def test_cli_bad_input_exits_nonzero_without_output(tmp_path):
    in_path = tmp_path / "bad.json"
    in_path.write_text('{"stub_container": "nope"}', encoding="utf-8")
    out_path = tmp_path / "out.h264"
    result = run_cli("-i", str(in_path), "-o", str(out_path), "-c", "h264")
    assert result.returncode == 1
    assert not out_path.exists()


def test_two_processes_same_output_never_interleave(tmp_path):
    # Two distinct inputs, one shared destination, run in parallel processes.
    input_a = tmp_path / "a.json"
    input_b = tmp_path / "b.json"
    write_stub_container(input_a, (10, 10), width=320, height=240)
    write_stub_container(input_b, (7, 7), width=640, height=480)
    shared_output = tmp_path / "shared.h264"

    env = dict(os.environ, TRANSCODE_BACKEND="stub")
    common = [sys.executable, str(SCRIPT), "-o", str(shared_output),
              "-c", "h264", "-p", "P1"]
    proc_a = subprocess.Popen(common + ["-i", str(input_a)],
                              cwd=str(REPO_ROOT), env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    proc_b = subprocess.Popen(common + ["-i", str(input_b)],
                              cwd=str(REPO_ROOT), env=env,
                              stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    out_a, err_a = proc_a.communicate()
    out_b, err_b = proc_b.communicate()

    # At least one job must finish successfully; a failure is an acceptable
    # outcome for the loser, an interleaved file is not.
    codes = {proc_a.returncode, proc_b.returncode}
    assert 0 in codes, (err_a.decode(), err_b.decode())
    assert codes <= {0, 1}

    assert shared_output.exists()
    data = shared_output.read_bytes()
    packets = PACKET_RE.findall(data)
    assert packets, "output contains no recognizable bitstream packets"

    # Coherence check: every packet in the final file comes from exactly one
    # encoder instance and carries one consistent frame size. Any interleaving
    # of the two streams would show two stream ids / two resolutions.
    stream_ids = {match[0] for match in packets}
    resolutions = {
        (int(m.group(1)), int(m.group(2)))
        for m in re.finditer(
            rb"\[[0-9a-f]+\|(?:frame|end)\|seq=\d+\|(\d+)x(\d+)\]", data)
    }
    assert len(stream_ids) == 1, "two streams were spliced together"
    assert len(resolutions) == 1, "frames of two resolutions were spliced"

    # The winning stream is complete: all frame seq numbers plus the end tail.
    frame_seqs = [int(seq) for _, kind, seq in packets if kind == b"frame"]
    kinds = [kind for _, kind, _ in packets]
    assert frame_seqs == list(range(len(frame_seqs)))
    assert kinds[-1] == b"end"

    # No staged temp files survive either process.
    leftovers = [name for name in os.listdir(tmp_path)
                 if name.endswith(".tmp")]
    assert leftovers == []


def test_main_returns_zero_on_success(tmp_path, make_input, output_path,
                                      monkeypatch):
    in_path = make_input(frame_counts=(1, 1))
    monkeypatch.setenv("TRANSCODE_BACKEND", "stub")
    rc = main(["-i", str(in_path), "-o", str(output_path),
               "-c", "h264", "-p", "P1"])
    assert rc == 0
    assert output_path.exists()
