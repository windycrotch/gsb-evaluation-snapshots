# -----------------------------------------------------------------------------
# Tests for the export timeline (exporter.py) - no sound card, no FFmpeg.
#
# Run with:  python -m pytest tests -q
#
# A fake frame sink records how many frames were written; a fake player feeds a
# controllable track position into ExportManager.on_player_tick(), exactly like
# main.grab_export_frame() does. Nothing here starts a process or touches the
# system configuration.
# -----------------------------------------------------------------------------
import os
import sys

import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from exporter import ExportManager, block_message  # noqa: E402

FPS = 60
FRAME = b"\x00\x00\x00"
TOLERANCE = 1  # allowed rounding error in frames


class FakeSink:
    """Stands in for FFmpegFrameSink: just counts raw frames."""

    def __init__(self, width=32, height=18, fps=FPS):
        self.width, self.height, self.fps = width, height, fps
        self.frames = 0
        self.closed = False
        self.returncode = 0

    def write(self, data):
        self.frames += 1

    def close(self):
        self.closed = True

    def wait(self):
        return 0


class FakePlayer:
    """Controllable stand-in for FileProcessor's playback clock."""

    def __init__(self, state="playing", pos=0.0):
        self.state = state
        self.pos = pos

    def play(self, seconds):
        """Advance the audio clock by `seconds` while playing."""
        if self.state == "playing":
            self.pos += seconds

    def pause(self):
        self.state = "paused"

    def resume(self):
        self.state = "playing"

    def seek(self, pos):
        self.pos = pos


@pytest.fixture
def export(tmp_path):
    sink = FakeSink()
    ex = ExportManager(out_dir=str(tmp_path), fps=FPS, frame_sink=sink,
                       muxer=lambda: (True, ""))
    assert ex.start(sink.width, sink.height)
    return ex, sink


@pytest.fixture
def meta_capture(tmp_path):
    """An ExportManager whose fake muxer keeps a copy of the chapter file."""
    sink = FakeSink()
    captured = {}

    def fake_mux(manager=None):
        path = (manager or ex).meta_path
        with open(path, encoding="utf-8") as f:
            captured["text"] = f.read()
        return True, ""

    ex = ExportManager(out_dir=str(tmp_path), fps=FPS, frame_sink=sink,
                       muxer=fake_mux)
    assert ex.start(sink.width, sink.height)
    return ex, sink, captured


def tick(ex, player):
    """One rendered frame, like main.grab_export_frame()."""
    n = ex.on_player_tick(player.state, player.pos)
    if n > 0:
        ex.write(FRAME, n)
    return n


def run(ex, player, seconds, step=1.0 / FPS):
    """Simulate `seconds` of rendering with the player's clock."""
    elapsed = 0.0
    while elapsed < seconds - 1e-9:
        player.play(min(step, seconds - elapsed))
        tick(ex, player)
        elapsed += step


def finish(ex):
    ex.stop()
    ex.wait()


def written_frames(sink):
    # The writer thread drains the queue; joining via stop() guarantees it.
    return sink.frames


def assert_duration_matches(ex, expected_seconds):
    """Video frames == played audio seconds * fps (within 1 frame)."""
    assert abs(ex.frames - expected_seconds * FPS) <= TOLERANCE, (
        f"frames={ex.frames}, expected={expected_seconds * FPS:.2f}")


# --------------------------------------------------------------------- basics
def test_plain_playback_duration(export):
    ex, sink = export
    ex.begin_track("a.mp3", 10.0, "A", token=1)
    run(ex, FakePlayer(), 4.0)
    finish(ex)
    assert_duration_matches(ex, 4.0)
    assert written_frames(sink) == ex.frames


def test_pause_does_not_advance_timeline(export):
    ex, sink = export
    ex.begin_track("a.mp3", 10.0, "A", token=1)
    player = FakePlayer()
    run(ex, player, 3.0)
    frames_at_pause = ex.frames

    player.pause()
    # Wall clock runs on, the player clock is frozen: no frames may be written.
    for _ in range(120):
        tick(ex, player)
    assert ex.frames == frames_at_pause
    assert ex.frames == pytest.approx(3.0 * FPS, abs=TOLERANCE)

    player.resume()
    run(ex, player, 2.0)
    finish(ex)
    # 3 s before the pause + 2 s after it; the pause adds no time.
    assert_duration_matches(ex, 5.0)
    assert written_frames(sink) == ex.frames


def test_pause_resume_keeps_position(export):
    ex, _ = export
    ex.begin_track("a.mp3", 10.0, "A", token=1)
    player = FakePlayer()
    run(ex, player, 2.0)
    player.pause()
    tick(ex, player)
    player.resume()
    # First tick after resume must read 2.0 s, not jump ahead by paused time.
    tick(ex, player)
    assert ex.timeline_seconds() == pytest.approx(2.0, abs=1e-9)


def test_no_duplicate_begin_track_on_pause(export):
    ex, _ = export
    assert ex.begin_track("a.mp3", 10.0, "A", token=7) is True
    player = FakePlayer()
    run(ex, player, 1.0)
    player.pause()
    tick(ex, player)          # main loop keeps calling with the paused state
    player.resume()
    # The main loop re-reads the same serial after a pause: no new chapter.
    assert ex.begin_track("a.mp3", 10.0, "A", token=7) is False
    assert len(ex.chapter_starts()) == 1


def test_skip_track_chapters_monotonic(export):
    ex, _ = export
    ex.begin_track("a.mp3", 10.0, "A", token=1)
    player = FakePlayer()
    run(ex, player, 4.0)

    # Next track starts (main loop calls begin_track with a new serial).
    player.seek(0.0)
    assert ex.begin_track("b.mp3", 8.0, "B", token=2) is True
    player.play(0.0)
    run(ex, player, 3.0)
    finish(ex)

    starts = ex.chapter_starts()
    assert len(starts) == 2
    assert starts[0] < starts[1]
    # The soundtrack always contains the complete first file, so the video is
    # topped up to the full track length when the track is skipped early.
    assert starts[1] == pytest.approx(10.0, abs=TOLERANCE / FPS)
    assert_duration_matches(ex, 10.0 + 3.0)
    bounds = ex.chapter_bounds_ms()
    assert bounds[0][0] == 0
    assert bounds[0][1] == pytest.approx(10000, abs=17)
    assert bounds[-1][1] == pytest.approx(ex.frames * 1000 / FPS, abs=17)


def test_next_track_after_natural_end(export):
    ex, _ = export
    ex.begin_track("a.mp3", 3.0, "A", token=1)
    player = FakePlayer()
    run(ex, player, 3.0)
    # Track ran out, the player loads the next one (serial 2).
    assert ex.begin_track("b.mp3", 5.0, "B", token=2) is True
    player.seek(0.0)
    ex.begin_track("b.mp3", 5.0, "B", token=2)  # repeated call is a no-op
    run(ex, player, 1.0)
    finish(ex)
    assert len(ex.chapter_starts()) == 2
    assert ex.chapter_starts()[1] == pytest.approx(3.0, abs=1 / FPS)
    assert_duration_matches(ex, 4.0)


def test_early_stop_chapter_end_matches_video(export):
    ex, _ = export
    ex.begin_track("a.mp3", 10.0, "A", token=1)
    player = FakePlayer()
    run(ex, player, 2.5)
    finish(ex)

    bounds = ex.chapter_bounds_ms()
    video_ms = ex.frames * 1000.0 / FPS
    assert bounds[-1][1] <= video_ms + 1
    assert bounds[-1][1] >= video_ms - 1
    assert_duration_matches(ex, 2.5)


def test_early_stop_after_skip(export):
    ex, _ = export
    ex.begin_track("a.mp3", 10.0, "A", token=1)
    player = FakePlayer()
    run(ex, player, 6.0)
    player.seek(0.0)
    ex.begin_track("b.mp3", 10.0, "B", token=2)
    run(ex, player, 1.5)
    finish(ex)

    bounds = ex.chapter_bounds_ms()
    video_ms = ex.frames * 1000.0 / FPS
    assert len(bounds) == 2
    assert bounds[0][0] < bounds[1][0]
    assert bounds[0][1] == bounds[1][0]        # chapters are contiguous
    assert bounds[-1][1] <= video_ms + 1
    assert bounds[-1][1] >= video_ms - 1
    assert_duration_matches(ex, 10.0 + 1.5)


def test_natural_end_stop_fills_full_track(export):
    ex, _ = export
    ex.begin_track("a.mp3", 6.0, "A", token=1)
    player = FakePlayer()
    run(ex, player, 5.0)
    ex.stop(natural_end=True)   # last song ran out
    ex.wait()
    assert_duration_matches(ex, 6.0)
    bounds = ex.chapter_bounds_ms()
    assert bounds[-1][1] == pytest.approx(ex.frames * 1000.0 / FPS, abs=1)


def test_slow_renderer_duplicates_frames(export):
    ex, _ = export
    ex.begin_track("a.mp3", 20.0, "A", token=1)
    player = FakePlayer()
    # 10 FPS rendering for 2 s of audio: each tick must write ~6 frames.
    run(ex, player, 2.0, step=0.1)
    finish(ex)
    assert_duration_matches(ex, 2.0)


def test_loading_state_freezes_timeline(export):
    ex, _ = export
    ex.begin_track("a.mp3", 10.0, "A", token=1)
    player = FakePlayer()
    run(ex, player, 1.0)
    frames_before = ex.frames
    player.state = "stopped"   # e.g. a new track is being loaded
    for _ in range(60):
        tick(ex, player)
    assert ex.frames == frames_before


def test_chapters_never_overlap_or_go_backwards(export):
    ex, _ = export
    player = FakePlayer()
    durations = [5.0, 0.5, 3.0, 2.0]
    for i, dur in enumerate(durations, start=1):
        assert ex.begin_track(f"{i}.mp3", dur, f"T{i}", token=i) is True
        player.seek(0.0)
        run(ex, player, min(dur, 1.0))
    finish(ex)

    bounds = ex.chapter_bounds_ms()
    assert len(bounds) == len(durations)
    for (s0, e0, _), (s1, e1, _) in zip(bounds, bounds[1:]):
        assert s0 < e0
        assert s1 >= e0            # monotonic and non-overlapping
    assert bounds[-1][1] <= ex.frames * 1000.0 / FPS + 1


def test_meta_file_matches_chapter_bounds(meta_capture):
    ex, _, captured = meta_capture
    ex.begin_track("a.mp3", 10.0, "A", token=1)
    player = FakePlayer()
    run(ex, player, 2.0)
    player.seek(0.0)
    ex.begin_track("b.mp3", 10.0, "B", token=2)
    run(ex, player, 1.0)
    finish(ex)

    text = captured["text"]
    starts = [int(line.split("=")[1]) for line in text.splitlines()
              if line.startswith("START=")]
    ends = [int(line.split("=")[1]) for line in text.splitlines()
            if line.startswith("END=")]
    assert len(starts) == len(ends) == 2
    assert starts[0] == 0
    assert starts[1] == ends[0]
    assert ends[-1] == pytest.approx(ex.frames * 1000.0 / FPS, abs=1)
    assert starts == [b[0] for b in ex.chapter_bounds_ms()]
    assert ends == [b[1] for b in ex.chapter_bounds_ms()]


def test_stop_is_not_pause_and_vice_versa(export):
    ex, _ = export
    ex.begin_track("a.mp3", 10.0, "A", token=1)
    player = FakePlayer()
    run(ex, player, 1.0)
    player.pause()
    assert ex.is_recording            # pausing never ends the export
    tick(ex, player)
    assert ex.is_recording
    finish(ex)
    assert not ex.is_recording
    assert ex.is_finalizing or ex.last_output is not None


def test_early_stop_while_paused(export):
    ex, sink = export
    ex.begin_track("a.mp3", 10.0, "A", token=1)
    player = FakePlayer()
    run(ex, player, 3.0)
    player.pause()
    for _ in range(120):
        tick(ex, player)
    finish(ex)
    assert_duration_matches(ex, 3.0)
    assert written_frames(sink) == ex.frames


def test_repeated_pause_resume_accumulates_only_played_time(export):
    ex, _ = export
    ex.begin_track("a.mp3", 30.0, "A", token=1)
    player = FakePlayer()
    played = 0.0
    for chunk in (1.5, 0.75, 2.25, 0.5):
        run(ex, player, chunk)
        played += chunk
        player.pause()
        # A long pause: the wall clock advances a lot, the export must not.
        for _ in range(300):
            tick(ex, player)
        player.resume()
        # One post-resume frame that repeats the frozen position.
        tick(ex, player)
    finish(ex)
    assert_duration_matches(ex, played)
    assert len(ex.chapter_starts()) == 1


def test_pause_with_backend_drift_does_not_advance(export):
    """Some backends keep reporting a moving position while paused."""
    ex, _ = export
    ex.begin_track("a.mp3", 20.0, "A", token=1)
    player = FakePlayer()
    run(ex, player, 2.0)
    player.pause()
    tick(ex, player)                 # first paused tick: pause point is fixed
    frames_before = ex.frames
    # Report a creeping position while still paused.
    for _ in range(120):
        player.pos += 1.0 / FPS
        tick(ex, player)
    assert ex.frames == frames_before
    player.resume()
    run(ex, player, 1.0)
    finish(ex)
    # Only the truly played 3 s count, not the drift.
    assert_duration_matches(ex, 3.0)


def test_begin_track_without_token_is_idempotent(export):
    ex, _ = export
    assert ex.begin_track("a.mp3", 10.0, "A") is True
    assert ex.begin_track("a.mp3", 10.0, "A") is False   # no audio played yet
    run(ex, FakePlayer(), 1.0)
    assert len(ex.chapter_starts()) == 1


def test_chapter_count_stable_across_main_loop_ticks(export):
    """Resuming must not create chapters even if the serial is re-read."""
    ex, _ = export
    player = FakePlayer()
    ex.begin_track("a.mp3", 10.0, "A", token=3)
    for _ in range(3):
        run(ex, player, 0.5)
        player.pause()
        tick(ex, player)
        player.resume()
        # main.py re-checks the serial every frame; same value -> no chapter.
        assert ex.begin_track("a.mp3", 10.0, "A", token=3) is False
    finish(ex)
    assert len(ex.chapter_starts()) == 1
    assert ex.chapter_starts() == [0.0]


def test_blocked_actions_have_visible_messages():
    for action in ("skip", "prev", "load", "fullscreen"):
        assert block_message(action)
    assert block_message("unknown")  # never empty -> notice is visible


# --------------------------------------------------- preserved file behaviour
def test_early_stop_before_any_frame_of_new_chapter(export):
    """E right after a skip must not leave the last chapter past the video."""
    ex, _ = export
    player = FakePlayer()
    ex.begin_track("a.mp3", 10.0, "A", token=1)
    run(ex, player, 2.0)
    player.seek(0.0)
    ex.begin_track("b.mp3", 10.0, "B", token=2)   # chapter 2 starts now
    finish(ex)                                    # ...and E immediately after
    bounds = ex.chapter_bounds_ms()
    video_ms = ex.frames * 1000.0 / FPS
    assert bounds[-1][0] < video_ms
    assert bounds[-1][1] >= bounds[-1][0] + 1
    assert bounds[-1][1] <= video_ms + 1


def test_success_cleans_temp_files(export):
    ex, _ = export
    ex.begin_track("a.mp3", 10.0, "A", token=1)
    run(ex, FakePlayer(), 1.0)
    finish(ex)
    assert ex.last_output == ex.final_path
    assert os.path.dirname(ex.final_path) == str(ex.out_dir)
    name = os.path.basename(ex.final_path)
    assert name.startswith("visualizer_") and name.endswith(".mp4")
    for path in (ex.temp_video, ex.meta_path, ex.log_path):
        assert not os.path.exists(path)


def test_mux_failure_keeps_log_and_video(tmp_path):
    sink = FakeSink()
    ex = ExportManager(out_dir=str(tmp_path), fps=FPS, frame_sink=sink,
                       muxer=lambda: (False, "boom"))
    assert ex.start(sink.width, sink.height)
    ex.begin_track("a.mp3", 10.0, "A", token=1)
    run(ex, FakePlayer(), 1.0)
    finish(ex)
    assert "Merge fehlgeschlagen" in ex.status
    assert ex.temp_video in ex.status
    with open(ex.log_path, encoding="utf-8") as f:
        assert "--- mux ---" in f.read()
    assert os.path.exists(ex.meta_path)          # nothing deleted on failure
