# -----------------------------------------------------------------------------
#  Offline tests for exporter.py (ExportManager).
#
#  No real ffmpeg, sound card or network needed:
#   * ffmpeg is replaced by a small Python script ("fake ffmpeg") that
#     understands the two command lines ExportManager builds:
#       - record mode ("-f rawvideo ... -i - ... tmp_video.mp4"):
#         counts the raw frame bytes on stdin and writes a dummy video file
#       - mux mode ("-i video -i song1 ... -i meta.txt ... final.mp4"):
#         verifies all inputs exist and writes a JSON summary as the output
#   * the "songs" are short WAV files generated locally with the wave module.
#
#  Run:  python -m pytest tests/test_exporter.py -v
# -----------------------------------------------------------------------------
import json
import math
import os
import stat
import struct
import sys
import wave

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from exporter import ExportManager  # noqa: E402

FPS = 10
WIDTH, HEIGHT = 8, 6
FRAME = b"\x7f" * (WIDTH * HEIGHT * 3)   # one raw RGB frame


FAKE_FFMPEG_PY = r"""
import json, os, sys

def main():
    args = sys.argv[1:]
    out = args[-1]
    if "-f" in args and "rawvideo" in args:
        # ---- record mode: raw video frames arrive on stdin
        if os.environ.get("FAKE_FFMPEG_RECORD_FAIL"):
            sys.stderr.write("fake record failure\n")
            return 3
        n = 0
        while True:
            chunk = sys.stdin.buffer.read(1 << 16)
            if not chunk:
                break
            n += len(chunk)
        with open(out, "w") as f:
            json.dump({"video_bytes": n}, f)
        return 0
    # ---- mux mode
    if os.environ.get("FAKE_FFMPEG_MUX_FAIL"):
        sys.stderr.write("fake mux failure\n")
        return 4
    inputs = [args[i + 1] for i, a in enumerate(args) if a == "-i"]
    for p in inputs:
        if not os.path.exists(p):
            sys.stderr.write("missing input: %s\n" % p)
            return 5
    meta = ""
    for p in inputs:
        if p.endswith(".txt"):
            with open(p, encoding="utf-8") as f:
                meta = f.read()
    t = float(args[args.index("-t") + 1]) if "-t" in args else None
    with open(out, "w", encoding="utf-8") as f:
        json.dump({"inputs": inputs, "t": t, "meta": meta}, f)
    return 0

sys.exit(main())
"""


def make_fake_ffmpeg(dir_path):
    """Writes the fake ffmpeg script + an executable wrapper, returns the
    wrapper path (usable as ExportManager's ffmpeg_path)."""
    script = os.path.join(dir_path, "fake_ffmpeg.py")
    with open(script, "w", encoding="utf-8") as f:
        f.write(FAKE_FFMPEG_PY)
    if os.name == "nt":
        wrapper = os.path.join(dir_path, "ffmpeg.bat")
        with open(wrapper, "w", encoding="utf-8") as f:
            f.write('@echo off\r\n"%s" "%s" %%*\r\n' % (sys.executable, script))
    else:
        wrapper = os.path.join(dir_path, "ffmpeg")
        with open(wrapper, "w", encoding="utf-8") as f:
            f.write('#!/bin/sh\nexec "%s" "%s" "$@"\n' % (sys.executable, script))
        os.chmod(wrapper, os.stat(wrapper).st_mode | stat.S_IXUSR | stat.S_IXGRP | stat.S_IXOTH)
    return wrapper


def make_wav(path, seconds=0.5, freq=440.0, rate=44100):
    """Generates a short sine WAV (a 'song' for the playlist)."""
    n = int(seconds * rate)
    with wave.open(str(path), "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(
            struct.pack("<h", int(8000 * math.sin(2 * math.pi * freq * i / rate)))
            for i in range(n)))
    return str(path)


def parse_meta(meta_text):
    """Parses ffmetadata chapters -> [(start_ms, end_ms, title), ...]."""
    chapters, cur = [], None
    for line in meta_text.splitlines():
        line = line.strip()
        if line == "[CHAPTER]":
            cur = {}
        elif line.startswith("START="):
            cur["start"] = int(line.split("=", 1)[1])
        elif line.startswith("END="):
            cur["end"] = int(line.split("=", 1)[1])
        elif line.startswith("title=") and cur is not None and "start" in cur:
            cur["title"] = line.split("=", 1)[1]
            chapters.append((cur["start"], cur["end"], cur["title"]))
            cur = None
    return chapters


@pytest.fixture()
def ffmpeg(tmp_path):
    return make_fake_ffmpeg(str(tmp_path))


@pytest.fixture()
def songs(tmp_path):
    return [make_wav(os.path.join(str(tmp_path), "song%d.wav" % i),
                     seconds=0.5, freq=220.0 * (i + 1))
            for i in range(3)]


@pytest.fixture()
def ex(tmp_path, ffmpeg):
    return ExportManager(out_dir=str(tmp_path / "exports"), fps=FPS, ffmpeg_path=ffmpeg)


def finish(ex):
    """stop() + wait for the finalizer thread."""
    ex.wait()
    return ex.result


# ------------------------------------------------------------------ chapters
def test_chapter_registered_once_per_track_start(ex, songs):
    assert ex.start(WIDTH, HEIGHT)
    ex.begin_track(songs[0], 2.0, "Song A", token=1)
    ex.begin_track(songs[0], 2.0, "Song A", token=1)   # same start reported twice
    assert len(ex._chapters) == 1
    assert len(ex._tracks) == 1

    ex.begin_track(songs[1], 3.0, "Song B", token=2)   # next song
    assert len(ex._chapters) == 2
    # chapter start = cumulative duration of the songs played before it
    assert ex._chapters[0]["start"] == 0.0
    assert ex._chapters[1]["start"] == pytest.approx(2.0)

    ex.begin_track(songs[2], 1.5, "Song C", token=3)
    assert ex._chapters[2]["start"] == pytest.approx(2.0 + 3.0)
    ex.stop()
    assert finish(ex) == ExportManager.RESULT_CANCELLED   # no frames written


def test_pause_freezes_timeline_and_resume_continues(ex, songs):
    assert ex.start(WIDTH, HEIGHT)
    ex.begin_track(songs[0], 10.0, "Song A", token=1)

    n = ex.frames_due(1.0)                 # 1s played
    assert n == 1 * FPS
    ex.write(FRAME, n)

    # paused: audio position does not move -> nothing is due
    assert ex.frames_due(1.0) == 0
    assert ex.frames_due(None) == 0        # main.py passes None while paused
    assert ex.frames == 1 * FPS

    # resumed at 2.5s: exactly the missing frames are requested
    n = ex.frames_due(2.5)
    assert n == 15
    ex.write(FRAME, n)
    assert ex.frames == 25

    ex.stop(track_pos=2.5)
    assert finish(ex) == ExportManager.RESULT_OK


def test_early_stop_covers_stop_moment_and_clamps_last_chapter(ex, songs):
    assert ex.start(WIDTH, HEIGHT)
    ex.begin_track(songs[0], 2.0, "Song A", token=1)
    ex.write(FRAME, ex.frames_due(2.0))    # song A played out: 20 frames
    ex.begin_track(songs[1], 5.0, "Song B", token=2)
    ex.write(FRAME, ex.frames_due(1.0))    # only 1.0s of song B rendered so far

    ex.stop(track_pos=1.3)                 # user stops at 1.3s of song B
    assert finish(ex) == ExportManager.RESULT_OK

    # video was topped up to the stop moment: 2.0 + 1.3 = 3.3s
    assert ex.frames == 33
    data = json.load(open(ex.last_output, encoding="utf-8"))
    assert data["t"] == pytest.approx(3.3, abs=1e-3)   # audio cut at video end

    chapters = parse_meta(data["meta"])
    assert chapters == [(0, 2000, "Song A"), (2000, 3300, "Song B")]
    # last chapter ends exactly at the real video end, never beyond it
    assert chapters[-1][1] <= round(ex.frames / ex.fps * 1000)


def test_natural_end_tops_up_to_audio_end(ex, songs):
    assert ex.start(WIDTH, HEIGHT)
    ex.begin_track(songs[0], 2.0, "Song A", token=1)
    ex.write(FRAME, ex.frames_due(1.7))    # rendering lagged behind a bit

    ex.stop(natural_end=True)              # last song ran out
    assert finish(ex) == ExportManager.RESULT_OK
    assert ex.frames == 20                 # topped up to the full 2.0s

    data = json.load(open(ex.last_output, encoding="utf-8"))
    assert data["t"] == pytest.approx(2.0, abs=1e-3)
    assert parse_meta(data["meta"]) == [(0, 2000, "Song A")]


def test_chapter_without_frames_is_dropped(ex, songs):
    """Stop exactly at a track boundary: the next chapter got 0 frames and
    must not appear in the metadata (its start would be the video end)."""
    assert ex.start(WIDTH, HEIGHT)
    ex.begin_track(songs[0], 2.0, "Song A", token=1)
    ex.write(FRAME, ex.frames_due(2.0))
    ex.begin_track(songs[1], 5.0, "Song B", token=2)

    ex.stop(track_pos=0.0)                 # stopped right at the boundary
    assert finish(ex) == ExportManager.RESULT_OK
    assert ex.frames == 20

    data = json.load(open(ex.last_output, encoding="utf-8"))
    chapters = parse_meta(data["meta"])
    assert chapters == [(0, 2000, "Song A")]
    assert all(end <= 2000 for _, end, _ in chapters)


# ------------------------------------------------------------------- cleanup
def test_success_cleans_up_temp_files(ex, songs):
    assert ex.start(WIDTH, HEIGHT)
    ex.begin_track(songs[0], 1.0, "Song A", token=1)
    ex.write(FRAME, ex.frames_due(1.0))
    ex.stop(natural_end=True)
    assert finish(ex) == ExportManager.RESULT_OK

    assert os.path.exists(ex.last_output)
    for p in (ex.temp_video, ex.meta_path, ex.log_path):
        assert not os.path.exists(p), p


def test_mux_failure_state_and_cleanup(ex, songs, monkeypatch):
    monkeypatch.setenv("FAKE_FFMPEG_MUX_FAIL", "1")
    assert ex.start(WIDTH, HEIGHT)
    ex.begin_track(songs[0], 1.0, "Song A", token=1)
    ex.write(FRAME, ex.frames_due(1.0))
    ex.stop(natural_end=True)
    assert finish(ex) == ExportManager.RESULT_MUX_FAILED

    assert "Merge fehlgeschlagen" in ex.status
    assert not os.path.exists(ex.final_path)
    assert not os.path.exists(ex.temp_video)   # temp video removed
    assert not os.path.exists(ex.meta_path)    # metadata removed
    assert os.path.exists(ex.log_path)         # log kept for diagnosis
    assert "fake mux failure" in open(ex.log_path, encoding="utf-8").read()


def test_record_failure_state_and_cleanup(ex, songs, monkeypatch):
    monkeypatch.setenv("FAKE_FFMPEG_RECORD_FAIL", "1")
    assert ex.start(WIDTH, HEIGHT)
    ex.begin_track(songs[0], 1.0, "Song A", token=1)
    ex.write(FRAME, ex.frames_due(0.5))
    ex.stop()
    assert finish(ex) == ExportManager.RESULT_RECORD_FAILED

    assert "fehlgeschlagen" in ex.status
    assert not os.path.exists(ex.temp_video)
    assert not os.path.exists(ex.meta_path)
    assert os.path.exists(ex.log_path)         # log kept for diagnosis


def test_cancel_when_nothing_recorded(ex):
    assert ex.start(WIDTH, HEIGHT)
    ex.stop()                                  # never wrote a frame or track
    assert finish(ex) == ExportManager.RESULT_CANCELLED

    assert "abgebrochen" in ex.status
    for p in (ex.temp_video, ex.meta_path, ex.log_path, ex.final_path):
        assert not os.path.exists(p), p        # nothing left behind


def test_result_states_are_distinguishable(ex, songs, monkeypatch):
    """ok / cancelled / record_failed / mux_failed are four distinct values."""
    states = {ExportManager.RESULT_OK, ExportManager.RESULT_CANCELLED,
              ExportManager.RESULT_RECORD_FAILED, ExportManager.RESULT_MUX_FAILED,
              ExportManager.RESULT_ERROR}
    assert len(states) == 5


# ------------------------------------------------------------------ full run
def test_full_playlist_records_all_songs(ex, songs):
    """Two songs play to the end (auto-advance), then natural end."""
    assert ex.start(WIDTH, HEIGHT)
    ex.begin_track(songs[0], 1.0, "Song A", token=1)
    ex.write(FRAME, ex.frames_due(1.0))
    ex.begin_track(songs[1], 1.5, "Song B", token=2)
    ex.write(FRAME, ex.frames_due(1.5))
    ex.stop(natural_end=True)
    assert finish(ex) == ExportManager.RESULT_OK

    assert ex.frames == 25                   # 1.0s + 1.5s at 10 fps
    data = json.load(open(ex.last_output, encoding="utf-8"))
    # both original audio files were concatenated (+ video + metadata inputs)
    assert songs[0] in data["inputs"] and songs[1] in data["inputs"]
    assert data["t"] == pytest.approx(2.5, abs=1e-3)
    chapters = parse_meta(data["meta"])
    assert chapters == [(0, 1000, "Song A"), (1000, 2500, "Song B")]
