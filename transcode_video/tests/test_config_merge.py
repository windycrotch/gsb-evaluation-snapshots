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

"""Tests for JSON/CLI configuration merge precedence."""

import json

import pytest

from transcode_video.transcode import build_config


@pytest.fixture
def json_config(tmp_path):
    path = tmp_path / "encode.json"
    path.write_text(json.dumps({
        "codec": "hevc",
        "preset": "P5",
        "tuning_info": "high_quality",
        "rc": "vbr",
        "fps": 25,
        "gop": 250,
        "bitrate": "10M",
    }), encoding="utf-8")
    return path


def test_no_json_matches_historical_cli_behaviour():
    # Without JSON the CLI historically produced exactly these two keys.
    config = build_config("", codec="h264", preset="p1")
    assert config == {"preset": "P1", "codec": "h264"}


def test_no_json_omitted_preset_becomes_empty_uppercase_string():
    config = build_config("", codec="h264", preset=None)
    assert config == {"preset": "", "codec": "h264"}


def test_json_alone_is_preserved_verbatim(json_config):
    config = build_config(str(json_config))
    assert config["codec"] == "hevc"
    assert config["preset"] == "P5"
    assert config["tuning_info"] == "high_quality"
    assert config["rc"] == "vbr"
    assert config["fps"] == 25
    assert config["gop"] == 250
    assert config["bitrate"] == "10M"


def test_cli_codec_overrides_json_but_keeps_other_fields(json_config):
    config = build_config(str(json_config), codec="av1", preset=None)
    assert config["codec"] == "av1"            # CLI override, normalized
    assert config["preset"] == "P5"            # JSON value retained
    assert config["tuning_info"] == "high_quality"
    assert config["rc"] == "vbr"
    assert config["fps"] == 25
    assert config["bitrate"] == "10M"


def test_cli_preset_overrides_json_but_keeps_other_fields(json_config):
    config = build_config(str(json_config), codec=None, preset="p7")
    assert config["codec"] == "hevc"           # JSON value retained
    assert config["preset"] == "P7"            # CLI override, normalized
    assert config["rc"] == "vbr"
    assert config["gop"] == 250


def test_cli_both_override_json_and_other_fields_survive(json_config):
    config = build_config(str(json_config), codec="H264", preset="p1")
    assert config["codec"] == "h264"
    assert config["preset"] == "P1"
    # All unrelated JSON fields must survive the merge.
    for key in ("tuning_info", "rc", "fps", "gop", "bitrate"):
        assert key in config


def test_cli_does_not_delete_json_fields_not_mentioned_on_cli(json_config):
    before = build_config(str(json_config))
    after = build_config(str(json_config), codec="h264", preset="P1")
    assert set(before) == set(after)


def test_non_object_json_is_rejected(tmp_path):
    path = tmp_path / "bad.json"
    path.write_text("[1, 2, 3]", encoding="utf-8")
    with pytest.raises(ValueError):
        build_config(str(path), codec="h264", preset="P1")
