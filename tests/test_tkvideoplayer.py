"""Regression tests for TkinterVideo pause/seek/end behaviour.

Run with::

    python -m pytest tests -v

The tests generate a short clip locally (see ``make_test_video.py``) and drive
the real widget inside a Tk main loop, so they exercise the same code path as
``examples/sample_player.py``.

The clip is four seconds long (0s red, 1s green, 2s blue, 3s yellow); checking
the dominant colour of ``current_img()`` therefore tells us which second of the
video is on screen without relying on exact pixel values.
"""

import os
import sys
import time

import pytest

av = pytest.importorskip("av")
tk = pytest.importorskip("tkinter")

REPO_ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if REPO_ROOT not in sys.path:
    sys.path.insert(0, REPO_ROOT)

from tkVideoPlayer import TkinterVideo  # noqa: E402
from tests.make_test_video import SECOND_COLORS, generate_video  # noqa: E402

FPS = 10
SECONDS = 4
FRAME = 1.0 / FPS
# Frame-accurate seeking may land on the neighbouring frame; one frame of
# slack (the requirement's "frame precision" allowance) is accepted.
FRAME_TOLERANCE = FRAME + 1e-3


@pytest.fixture(scope="session")
def video_path(tmp_path_factory):
    path = tmp_path_factory.mktemp("media") / "colors.mp4"
    generate_video(str(path), seconds=SECONDS, fps=FPS)
    return str(path)


@pytest.fixture(scope="session")
def root():
    """One Tk root for the whole session.

    Creating/destroying several Tk roots in a row intermittently fails with
    "Can't find a usable tk.tcl"; reusing a root also matches how a real
    application runs.
    """
    try:
        root = tk.Tk()
    except tk.TclError as exc:  # pragma: no cover - headless CI
        pytest.skip(f"Tk is not available: {exc}")

    # Tk does not dispatch synthetic events to unmapped (withdrawn or
    # iconified) windows, so keep the window mapped but out of the way. The
    # tests drive root.update() themselves instead of mainloop().
    try:
        root.geometry("200x150+-10000+-10000")
        root.update()
    except tk.TclError:
        pass

    yield root
    try:
        root.destroy()
    except tk.TclError:
        pass


@pytest.fixture
def player(root, video_path):
    widget = TkinterVideo(master=root, scaled=False)
    widget.pack()
    widget.load(video_path)
    yield widget
    widget.stop()
    try:
        widget.destroy()
    except tk.TclError:
        pass
    pump(root, 0.05)


def pump(root, seconds=1.0, until=None):
    """Runs the Tk event loop for at most ``seconds`` or until ``until()``."""
    deadline = time.monotonic() + seconds
    while time.monotonic() < deadline:
        root.update()
        if until is not None and until():
            return True
        time.sleep(0.005)
    return until() if until is not None else True


def wait_until(root, predicate, timeout=5.0):
    assert pump(root, timeout, until=predicate), "condition was not met in time"


def dominant_second(widget):
    """Returns the index of the colour second currently displayed."""
    image = widget.current_img()
    assert image is not None, "no frame has been decoded yet"
    pixel = image.convert("RGB").getpixel((image.width // 2, image.height // 2))
    best = min(
        range(len(SECOND_COLORS)),
        key=lambda i: sum((a - b) ** 2 for a, b in zip(pixel, SECOND_COLORS[i])),
    )
    distance = sum((a - b) ** 2 for a, b in zip(pixel, SECOND_COLORS[best]))
    assert distance < 4000, f"unexpected frame colour {pixel!r}"
    return best


def start_playback(root, widget):
    """Starts playback and waits until frames are actually flowing."""
    widget.play()
    wait_until(root, lambda: widget.current_duration() > 0.2)
    widget.pause()
    pump(root, 0.2)


# ---------------------------------------------------------------------------
# 1. Seek while paused
# ---------------------------------------------------------------------------

@pytest.mark.parametrize("target", [1.0, 2.0, 3.0, 0.5, 2.5])
def test_seek_while_paused_updates_frame_and_duration(root, player, target):
    start_playback(root, player)
    assert player.is_paused()

    before = player.current_img()
    player.seek(target)

    # Wait for the seek to be applied *and* for a new frame to arrive; the
    # timestamp alone may already coincide with the target frame.
    wait_until(
        root,
        lambda: player.current_img() is not before
        and abs(player.current_duration() - target) <= FRAME_TOLERANCE,
    )

    # The displayed frame must match the requested second even though the
    # video is still paused.
    assert dominant_second(player) == int(target), (
        f"expected the frame from second {int(target)} to be displayed"
    )
    assert abs(player.current_duration() - target) <= FRAME_TOLERANCE
    assert player.is_paused() is True
    assert player.current_img() is not before, "the frame was not refreshed"
    pump(root, 0.2)
    assert player.is_paused() is True


def test_seek_while_paused_does_not_advance_playback(root, player):
    start_playback(root, player)
    before = player.current_img()
    player.seek(1.0)
    wait_until(
        root,
        lambda: player.current_img() is not before
        and abs(player.current_duration() - 1.0) <= FRAME_TOLERANCE,
    )

    # Stay paused for a while: the timestamp and frame must not drift.
    pump(root, 0.5)
    assert abs(player.current_duration() - 1.0) <= FRAME_TOLERANCE
    assert dominant_second(player) == 1
    assert player.is_paused() is True


def test_seek_before_play_shows_frame(root, player):
    """A seek issued before play() still refreshes the frame."""
    assert player.is_paused()
    player.seek(2.0)
    wait_until(root, lambda: abs(player.current_duration() - 2.0) <= FRAME_TOLERANCE)
    assert dominant_second(player) == 2
    assert player.is_paused() is True


def test_seek_while_playing_jumps_and_keeps_playing(root, player):
    player.play()
    wait_until(root, lambda: player.current_duration() > 0.3)

    player.seek(2.0)
    wait_until(root, lambda: player.current_duration() >= 2.0)
    assert player.is_paused() is False, "playback must continue after a seek"
    # It keeps advancing from the new position.
    start = player.current_duration()
    wait_until(root, lambda: player.current_duration() > start + 0.15)
    assert dominant_second(player) >= 2
    player.pause()


def test_rapid_seeks_end_on_the_last_request(root, player):
    start_playback(root, player)
    before = player.current_img()

    for target in (0.5, 3.0, 1.0, 2.0):
        player.seek(target)

    wait_until(
        root,
        lambda: player.current_img() is not before
        and abs(player.current_duration() - 2.0) <= FRAME_TOLERANCE,
        timeout=8.0,
    )
    assert dominant_second(player) == 2
    assert player.is_paused() is True


# ---------------------------------------------------------------------------
# 2. Out-of-range seek clamping
# ---------------------------------------------------------------------------

def test_seek_negative_is_clamped_to_zero(root, player):
    start_playback(root, player)
    player.seek(-5)  # must not raise

    wait_until(root, lambda: player.current_duration() <= FRAME_TOLERANCE)
    assert player.current_duration() >= 0
    assert abs(player.current_duration()) <= FRAME_TOLERANCE
    assert dominant_second(player) == 0
    assert player.is_paused() is True


def test_seek_beyond_duration_is_clamped(root, player):
    start_playback(root, player)

    duration = player.video_info()["duration"]
    assert duration == pytest.approx(SECONDS, abs=0.1)

    player.seek(duration + 10)  # must not raise

    wait_until(root, lambda: abs(player.current_duration() - duration) <= FRAME_TOLERANCE)
    assert player.current_duration() <= duration + 1e-6
    assert dominant_second(player) == SECONDS - 1, "expected the last second of the clip"
    assert player.is_paused() is True


def test_seek_exactly_at_duration(root, player):
    start_playback(root, player)
    duration = player.video_info()["duration"]

    player.seek(duration)
    wait_until(root, lambda: abs(player.current_duration() - duration) <= FRAME_TOLERANCE)
    assert player.current_duration() <= duration + 1e-6
    assert dominant_second(player) == SECONDS - 1


def test_seek_clamp_helper_handles_odd_input(player):
    # Non-numeric / NaN input should not crash either.
    for value in (float("nan"), "nonsense", None):
        assert player._clamp_seek_time(value) >= 0

    duration = player.video_info()["duration"]
    if duration:
        assert player._clamp_seek_time(duration * 4) == pytest.approx(duration)
    assert player._clamp_seek_time(-1) == 0


# ---------------------------------------------------------------------------
# 3. End of playback and replay
# ---------------------------------------------------------------------------

def test_ended_reports_duration_and_replays_from_start(root, player):
    ended = []
    player.bind("<<Ended>>", lambda event: ended.append(time.monotonic()))

    duration = player.video_info()["duration"] or SECONDS
    player.play()

    wait_until(root, lambda: bool(ended), timeout=SECONDS * 3 + 5)
    pump(root, 0.2)

    # After a natural end the timestamp reflects the clip length.
    assert player.current_duration() == pytest.approx(duration, abs=0.1)
    assert player.is_paused() is True
    assert dominant_second(player) == SECONDS - 1

    # play() after the end restarts from the beginning instead of staying
    # stuck at the last frame.
    ended.clear()
    player.play()
    assert player.is_paused() is False
    wait_until(root, lambda: 0 < player.current_duration() < duration - 0.5)

    assert dominant_second(player) in (0, 1)
    assert player.current_duration() > 0

    player.stop()
    pump(root, 0.1)


def test_seek_after_end_restarts_at_requested_position(root, player):
    ended = []
    player.bind("<<Ended>>", lambda event: ended.append(1))
    player.play()
    wait_until(root, lambda: bool(ended), timeout=SECONDS * 3 + 5)
    pump(root, 0.2)

    player.seek(1.0)
    wait_until(root, lambda: abs(player.current_duration() - 1.0) <= FRAME_TOLERANCE)
    assert dominant_second(player) == 1
    assert player.is_paused() is True


def test_play_pause_after_end_reaches_end_again(root, player):
    """A full replay must reach <<Ended>> a second time."""
    ended = []
    player.bind("<<Ended>>", lambda event: ended.append(time.monotonic()))

    player.play()
    wait_until(root, lambda: len(ended) >= 1, timeout=SECONDS * 3 + 5)

    player.play()
    wait_until(root, lambda: len(ended) >= 2, timeout=SECONDS * 3 + 5)
    assert len(ended) >= 2
    assert player.current_duration() == pytest.approx(
        player.video_info()["duration"], abs=0.1
    )


# ---------------------------------------------------------------------------
# 4. Event semantics
# ---------------------------------------------------------------------------

def test_load_itself_announces_duration(root, video_path):
    """load() opens the file paused, so the duration is known before play()."""
    widget = TkinterVideo(master=root, scaled=False)
    widget.pack()
    durations = []
    widget.bind("<<Duration>>", lambda event: durations.append(widget.video_info()["duration"]))
    try:
        widget.load(video_path)
        wait_until(root, lambda: bool(durations))
        assert durations[0] == pytest.approx(SECONDS, abs=0.1)
        assert widget.is_paused() is True
        assert widget.current_duration() == 0
    finally:
        widget.stop()
        widget.destroy()
        pump(root, 0.05)


def test_switch_video_while_playing(root, video_path, tmp_path):
    second = tmp_path / "short.mp4"
    generate_video(str(second), seconds=2, fps=FPS)

    widget = TkinterVideo(master=root, scaled=False)
    widget.pack()
    try:
        widget.load(video_path)
        widget.play()
        wait_until(root, lambda: widget.current_duration() > 0.3)

        widget.load(str(second))
        assert widget.current_duration() == 0
        assert widget.video_info()["duration"] == 0

        ended = []
        widget.bind("<<Ended>>", lambda event: ended.append(1))
        widget.play()
        wait_until(root, lambda: bool(ended), timeout=8)
        assert widget.current_duration() == pytest.approx(2.0, abs=0.1)
        assert widget.video_info()["duration"] == pytest.approx(2.0, abs=0.1)
    finally:
        widget.stop()
        widget.destroy()
        pump(root, 0.05)


def test_duration_event_fires_once_per_load(root, player):
    durations = []
    loads = []
    player.bind("<<Duration>>", lambda event: durations.append(player.video_info()["duration"]))
    player.bind("<<Loaded>>", lambda event: loads.append(1))

    ended = []
    player.bind("<<Ended>>", lambda event: ended.append(1))

    player.play()
    wait_until(root, lambda: bool(ended), timeout=SECONDS * 3 + 5)

    # Replaying must not re-emit <<Duration>>/<<Loaded>> for the same load.
    player.play()
    pump(root, 0.5)

    assert len(durations) == 1
    assert durations[0] == pytest.approx(SECONDS, abs=0.1)
    assert len(loads) == 1


def test_second_changed_and_frame_generated_events(root, player):
    seconds = []
    frames = []
    player.bind("<<SecondChanged>>", lambda event: seconds.append(player.current_duration()))
    player.bind("<<FrameGenerated>>", lambda event: frames.append(1))

    player.play()
    wait_until(root, lambda: player.current_duration() > 1.5)
    player.pause()

    assert len(frames) > 3, "frames are not being generated"
    assert len(seconds) >= 1, "<<SecondChanged>> is not being generated"
    assert all(value > 0 for value in seconds)


def test_progress_display_never_goes_backwards_while_playing(root, player):
    """Mirrors the sample player's slider, which reads current_duration()."""
    samples = []
    player.play()
    deadline = time.monotonic() + 1.5
    while time.monotonic() < deadline:
        root.update()
        samples.append(player.current_duration())
        time.sleep(0.01)
    player.pause()

    assert samples
    # Allow tiny non-monotonic jitter but no large backwards jump.
    assert max(samples) - samples[-1] < 0.5
