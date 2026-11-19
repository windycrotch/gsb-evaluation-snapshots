"""Offline tests for the export pipeline.

No real FFmpeg, no sound card and no pygame window are needed: tests/fake_ffmpeg.py
receives the raw frame stream and writes a JSON report describing what was
recorded and muxed. WAV inputs are generated on the fly.
"""
import json
import os
from pathlib import Path

import pytest

from conftest import write_wav
from exporter import ExportManager

FAKE_FFMPEG = str(Path(__file__).resolve().parent / "fake_ffmpeg.py")
FPS = 10
WIDTH, HEIGHT = 4, 4
FRAME = b"\x10\x20\x30" * (WIDTH * HEIGHT)


def new_manager(tmp_path, fps=FPS):
    return ExportManager(out_dir=str(tmp_path / "exports"), fps=fps,
                         ffmpeg_path=FAKE_FFMPEG)


def advance(mgr, pos, playing=True):
    """One visualizer frame iteration: ask for due frames, write one grab."""
    due = mgr.frames_due(pos, playing=playing)
    if due > 0:
        mgr.write(FRAME, due)
    return due


def run_to(mgr, start, end, step=0.1):
    t = start
    while t <= end + 1e-9:
        advance(mgr, t)
        t = round(t + step, 6)


def finish(mgr, natural_end=True):
    mgr.stop(natural_end=natural_end)
    mgr.wait()
    assert not mgr.is_finalizing
    assert not mgr.is_recording


def read_report(path):
    with open(path, encoding="utf-8") as f:
        return json.load(f)


def test_fractional_duration_never_shortens_audio(tmp_path):
    """A song length that is not a frame multiple must be rounded up at the
    boundary, otherwise -shortest would cut the next song's audio."""
    t1 = write_wav(tmp_path / "odd.wav", 1.05)     # 1.05 s at 10 fps -> 10.5
    t2 = write_wav(tmp_path / "after.wav", 1.0)

    mgr = new_manager(tmp_path)
    assert mgr.start(WIDTH, HEIGHT)
    assert mgr.begin_track(t1, 1.05, "Odd") is True
    run_to(mgr, 0.0, 1.05)
    assert mgr.frames == 10                       # floor of the playhead

    assert mgr.begin_track(t2, 1.0, "After") is True
    assert mgr.frames == 11                       # padded up to 1.05 s
    # the chapter starts where the audio of song 1 really ends, not at the
    # padded frame boundary
    assert [c["start"] for c in mgr.chapters] == pytest.approx([0.0, 1.05])
    run_to(mgr, 0.0, 1.0)
    finish(mgr, natural_end=True)

    report = read_report(mgr.final_path)
    assert report["video_frames"] == 21            # ceil: never shorter than audio
    # the muxed file is cut at the audio length (2.05 s), so the last chapter
    # must end there as well
    assert [(c["start_ms"], c["end_ms"]) for c in report["chapters"]] == [
        (0, 1050), (1050, 2050)]


def test_normal_multi_track_export(tmp_path):
    t1 = write_wav(tmp_path / "one.wav", 2.0)
    t2 = write_wav(tmp_path / "two.wav", 1.5)
    t3 = write_wav(tmp_path / "three.wav", 1.0)

    mgr = new_manager(tmp_path)
    assert mgr.start(WIDTH, HEIGHT)

    assert mgr.begin_track(t1, 2.0, "Artist A - One") is True
    run_to(mgr, 0.0, 2.0)
    assert mgr.frames == 20

    assert mgr.begin_track(t2, 1.5, "Artist B - Two") is True
    run_to(mgr, 0.0, 1.5)
    assert mgr.frames == 35

    assert mgr.begin_track(t3, 1.0, "Three") is True
    run_to(mgr, 0.0, 1.0)
    assert mgr.frames == 45

    finish(mgr, natural_end=True)

    assert mgr.last_output == mgr.final_path
    assert os.path.isfile(mgr.final_path)
    assert "fertig" in mgr.status.lower()

    report = read_report(mgr.final_path)
    assert report["mode"] == "mux"
    assert report["video_frames"] == 45
    assert report["fps"] == FPS

    # video frames piped to ffmpeg == frames accounted for by the manager
    assert report["video_frames"] == mgr.frames

    # chapters cover exactly the recorded timeline, one per song
    chapters = report["chapters"]
    assert [c["title"] for c in chapters] == ["Artist A - One", "Artist B - Two", "Three"]
    assert [(c["start_ms"], c["end_ms"]) for c in chapters] == [
        (0, 2000), (2000, 3500), (3500, 4500)]

    # only the recorded tracks, in order, no silence placeholders
    audio = report["audio_inputs"]
    assert [a["kind"] for a in audio] == ["file", "file", "file"]
    assert [Path(a["path"]).name for a in audio] == ["one.wav", "two.wav", "three.wav"]

    # a clean run leaves no temp files behind
    assert not os.path.exists(mgr.temp_video)
    assert not os.path.exists(mgr.meta_path)
    assert not os.path.exists(mgr.log_path)


def test_pause_produces_no_frames_and_resume_catches_up(tmp_path):
    track = write_wav(tmp_path / "paused.wav", 2.0)

    mgr = new_manager(tmp_path)
    assert mgr.start(WIDTH, HEIGHT)
    assert mgr.begin_track(track, 2.0, "Pause Test")

    run_to(mgr, 0.0, 0.8, step=0.1)
    assert mgr.frames == 8

    # paused player: same audio position, no frames may be produced at all
    for _ in range(50):
        assert advance(mgr, 0.8, playing=False) == 0
    assert mgr.frames == 8

    # paused, but a stale caller passes a position -> still no frames
    assert mgr.frames_due(1.3, playing=False) == 0
    assert mgr.frames == 8

    # resume: audio continues at the same position; the paused time is lost,
    # so the very next frames are the ones due for 0.9 / 1.0 ...
    assert advance(mgr, 0.8, playing=True) == 0
    assert advance(mgr, 0.9, playing=True) == 1
    run_to(mgr, 1.0, 2.0, step=0.1)
    assert mgr.frames == 20

    finish(mgr, natural_end=True)
    report = read_report(mgr.final_path)
    assert report["video_frames"] == 20
    assert [(c["start_ms"], c["end_ms"]) for c in report["chapters"]] == [(0, 2000)]
    assert [a["kind"] for a in report["audio_inputs"]] == ["file"]


def test_track_boundary_pads_lagging_renderer_and_keeps_chapter_start(tmp_path):
    t1 = write_wav(tmp_path / "short.wav", 2.0)
    t2 = write_wav(tmp_path / "next.wav", 1.0)

    mgr = new_manager(tmp_path)
    assert mgr.start(WIDTH, HEIGHT)
    assert mgr.begin_track(t1, 2.0, "Short")

    # renderer lagged: only 15 of 20 frames were produced before the song ends
    run_to(mgr, 0.0, 1.5)
    assert mgr.frames == 15

    assert mgr.begin_track(t2, 1.0, "Next") is True
    # the exporter pads the previous chapter up to its audio end, so the new
    # chapter starts exactly at 2.0 s and not at the lagging frame count
    assert mgr.frames == 20
    assert [c["start"] for c in mgr.chapters] == [0.0, 2.0]

    run_to(mgr, 0.0, 1.0)
    finish(mgr, natural_end=True)

    report = read_report(mgr.final_path)
    assert report["video_frames"] == 30
    assert [(c["start_ms"], c["end_ms"]) for c in report["chapters"]] == [
        (0, 2000), (2000, 3000)]


def test_failed_track_is_skipped_and_later_tracks_continue(tmp_path):
    good1 = write_wav(tmp_path / "good1.wav", 1.0)
    missing = tmp_path / "broken.wav"   # never created -> analysis unusable
    good2 = write_wav(tmp_path / "good2.wav", 1.0)

    mgr = new_manager(tmp_path)
    assert mgr.start(WIDTH, HEIGHT)

    assert mgr.begin_track(good1, 1.0, "Good One") is True
    run_to(mgr, 0.0, 1.0)
    assert mgr.frames == 10

    # the main loop reports the analysis failure, and the track never starts
    mgr.note_skipped(str(missing), "broken.wav")
    assert mgr.begin_track(str(missing), 1.0, "Broken") is False
    assert mgr.frames == 10                    # no frames, no new chapter
    assert [c["title"] for c in mgr.chapters] == ["Good One"]
    assert mgr.chapters[0]["end"] == pytest.approx(1.0)

    assert mgr.begin_track(good2, 1.0, "Good Two") is True
    assert [c["start"] for c in mgr.chapters] == [0.0, 1.0]
    run_to(mgr, 0.0, 1.0)
    finish(mgr, natural_end=True)

    assert os.path.isfile(mgr.final_path)
    report = read_report(mgr.final_path)
    assert report["video_frames"] == 20
    assert [c["title"] for c in report["chapters"]] == ["Good One", "Good Two"]
    assert [(c["start_ms"], c["end_ms"]) for c in report["chapters"]] == [
        (0, 1000), (1000, 2000)]

    # broken track is not part of the concatenated audio
    audio = report["audio_inputs"]
    assert [Path(a["path"]).name for a in audio] == ["good1.wav", "good2.wav"]
    assert [s["path"] for s in mgr.skipped][-1] == str(missing)


def test_file_vanishing_before_mux_keeps_timeline(tmp_path):
    t1 = write_wav(tmp_path / "keep.wav", 1.0)
    t2 = write_wav(tmp_path / "vanish.wav", 1.0)

    mgr = new_manager(tmp_path)
    assert mgr.start(WIDTH, HEIGHT)
    assert mgr.begin_track(t1, 1.0, "Keep") is True
    run_to(mgr, 0.0, 1.0)
    assert mgr.begin_track(t2, 1.0, "Vanish") is True
    run_to(mgr, 0.0, 1.0)

    os.remove(t2)   # disappears between analysis and mux
    finish(mgr, natural_end=True)

    report = read_report(mgr.final_path)
    assert report["video_frames"] == 20
    assert [(c["start_ms"], c["end_ms"]) for c in report["chapters"]] == [
        (0, 1000), (1000, 2000)]
    kinds = [a["kind"] for a in report["audio_inputs"]]
    assert kinds == ["file", "silence"]     # silence keeps later chapters in sync
    assert report["audio_inputs"][1]["duration"] == pytest.approx(1.0)
    assert os.path.exists(mgr.log_path)     # diagnostic log is kept


def test_empty_recording_cleans_up_and_reports_status(tmp_path):
    mgr = new_manager(tmp_path)
    assert mgr.start(WIDTH, HEIGHT)

    # no track ever started, no frames written (e.g. all files failed)
    mgr.note_skipped(str(tmp_path / "nope.wav"), "nope.wav")
    finish(mgr, natural_end=True)

    assert mgr.last_output is None
    assert not os.path.exists(mgr.final_path)
    assert not os.path.exists(mgr.temp_video)
    assert not os.path.exists(mgr.meta_path)
    assert not os.path.exists(mgr.log_path)
    assert "nichts aufgenommen" in mgr.status

    # a second export can start normally afterwards
    assert mgr.is_recording is False and mgr.is_finalizing is False


def test_started_track_without_frames_is_treated_as_empty(tmp_path):
    track = write_wav(tmp_path / "silent.wav", 1.0)
    mgr = new_manager(tmp_path)
    assert mgr.start(WIDTH, HEIGHT)
    assert mgr.begin_track(track, 1.0, "No Frames") is True
    # stopped before a single frame was produced
    finish(mgr, natural_end=False)
    assert mgr.last_output is None
    assert "nichts aufgenommen" in mgr.status
    assert not os.path.exists(mgr.final_path)
    assert not os.path.exists(mgr.temp_video)


def test_wait_blocks_until_finalization_is_done(tmp_path):
    track = write_wav(tmp_path / "wait.wav", 1.0)
    mgr = new_manager(tmp_path)
    assert mgr.start(WIDTH, HEIGHT)
    assert mgr.begin_track(track, 1.0, "Wait") is True
    run_to(mgr, 0.0, 1.0)

    mgr.stop(natural_end=True)
    assert mgr.is_recording is False
    assert mgr.is_finalizing is True       # cleanup runs on its own thread

    mgr.wait()
    assert mgr.is_finalizing is False
    assert os.path.isfile(mgr.final_path)
    assert mgr.last_output == mgr.final_path
    mgr.wait()                             # second call must be a no-op


def test_export_blocks_source_switch_and_fullscreen(tmp_path):
    mgr = new_manager(tmp_path)
    for action in ("load", "source", "switch", "fullscreen"):
        assert mgr.blocks(action) is False
    assert mgr.blocks("toggle-play") is False

    assert mgr.start(WIDTH, HEIGHT)
    for action in ("load", "source", "switch", "fullscreen"):
        assert mgr.blocks(action) is True
    assert mgr.blocks("toggle-play") is False   # pausing stays allowed

    finish(mgr, natural_end=False)
    for action in ("load", "source", "switch", "fullscreen"):
        assert mgr.blocks(action) is False


def test_failed_mux_leaves_no_fake_final_file(tmp_path):
    """A failing FFmpeg must not leave a truncated mp4 as if it succeeded."""
    track = write_wav(tmp_path / "muxfail.wav", 1.0)
    failing = tmp_path / "fail_ffmpeg.py"
    failing.write_text(
        "import sys\n"
        "data = sys.stdin.buffer.read() if '-' in sys.argv else b''\n"
        "sys.stderr.write('simulated encoder failure\n')\n"
        "sys.exit(1)\n",
        encoding="utf-8")

    mgr = ExportManager(out_dir=str(tmp_path / "exports"), fps=FPS,
                        ffmpeg_path=str(failing))
    assert mgr.start(WIDTH, HEIGHT)
    assert mgr.begin_track(track, 1.0, "Fail") is True
    run_to(mgr, 0.0, 1.0)
    finish(mgr, natural_end=True)

    assert mgr.last_output is None
    assert "fehlgeschlagen" in mgr.status.lower()
    # the recording itself failed -> no result file, only the log survives
    assert not os.path.exists(mgr.final_path)
    assert not os.path.exists(mgr.temp_video)
    assert os.path.exists(mgr.log_path)


def test_missing_ffmpeg_reports_start_failure(tmp_path):
    mgr = ExportManager(out_dir=str(tmp_path / "exports"), fps=FPS,
                        ffmpeg_path=str(tmp_path / "does-not-exist-ffmpeg.exe"))
    assert mgr.start(WIDTH, HEIGHT) is False
    assert "FFmpeg" in mgr.status
    assert mgr.is_recording is False
    assert list((tmp_path / "exports").iterdir()) == []


def test_many_fractional_tracks_do_not_drift(tmp_path):
    """Chapter starts follow the concatenated audio exactly. Deriving them
    from rounded frame counts would drift by ~a frame per track."""
    durations = [0.97, 1.03, 0.91, 1.11, 0.99, 1.07, 0.95, 1.05]
    tracks = [write_wav(tmp_path / f"t{i}.wav", d) for i, d in enumerate(durations)]

    mgr = new_manager(tmp_path)
    assert mgr.start(WIDTH, HEIGHT)
    expected, t = [], 0.0
    for i, (path, dur) in enumerate(zip(tracks, durations)):
        assert mgr.begin_track(path, dur, f"T{i}") is True
        expected.append(int(round(t * 1000)))
        run_to(mgr, 0.0, dur, step=0.05)
        t += dur
    finish(mgr, natural_end=True)

    report = read_report(mgr.final_path)
    starts = [c["start_ms"] for c in report["chapters"]]
    assert starts == expected
    # video is never shorter than the audio, at most one frame longer
    total = sum(durations)
    assert total * FPS <= report["video_frames"] <= total * FPS + len(tracks)
    # the last chapter ends where the audio ends (-shortest cuts there)
    assert report["chapters"][-1]["end_ms"] == int(round(total * 1000))


def test_second_export_reuses_manager_cleanly(tmp_path):
    t1 = write_wav(tmp_path / "a.wav", 1.0)
    t2 = write_wav(tmp_path / "b.wav", 0.5)

    mgr = new_manager(tmp_path)
    assert mgr.start(WIDTH, HEIGHT)
    assert mgr.begin_track(t1, 1.0, "First run") is True
    run_to(mgr, 0.0, 1.0)
    finish(mgr, natural_end=True)
    first = mgr.final_path
    assert mgr.frames == 10
    assert [c["title"] for c in mgr.chapters] == ["First run"]

    assert mgr.start(WIDTH, HEIGHT)          # fresh state
    assert mgr.frames == 0
    assert mgr.chapters == []
    assert mgr.begin_track(t2, 0.5, "Second run") is True
    run_to(mgr, 0.0, 0.5)
    finish(mgr, natural_end=True)
    assert mgr.blocks("load") is False
    assert mgr.frames == 5                   # counter was reset
    assert mgr.final_path != first

    report = read_report(mgr.final_path)
    assert report["video_frames"] == 5
    assert [c["title"] for c in report["chapters"]] == ["Second run"]
    assert [(c["start_ms"], c["end_ms"]) for c in report["chapters"]] == [(0, 500)]


def test_start_is_refused_while_recording_or_finalizing(tmp_path):
    track = write_wav(tmp_path / "c.wav", 1.0)
    mgr = new_manager(tmp_path)
    assert mgr.start(WIDTH, HEIGHT)
    assert mgr.start(WIDTH, HEIGHT) is False        # already recording
    assert "läuft bereits" in mgr.status

    mgr.is_finalizing = True                        # as set by stop()
    assert mgr.start(WIDTH, HEIGHT) is False
    mgr.is_finalizing = False

    assert mgr.begin_track(track, 1.0, "One") is True
    run_to(mgr, 0.0, 1.0)
    finish(mgr, natural_end=True)
    assert mgr.start(WIDTH, HEIGHT) is True         # allowed once finished
    assert mgr.frames == 0
    mgr.stop()
    mgr.wait()
