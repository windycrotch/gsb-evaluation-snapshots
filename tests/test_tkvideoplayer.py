"""Tests for the TkinterVideo player state machine.

Covers: source switching, seeking while paused, out-of-range seeks,
replay after <<Ended>>, and concurrent stop()/load() calls.

Small test videos are generated locally with PyAV, no external media needed.
"""

import time
import threading
import tkinter as tk

import av
import pytest
from PIL import Image

from tkVideoPlayer import TkinterVideo


FPS = 10
SIZE = (64, 48)


def make_video(path, color, duration=2.0, fps=FPS, size=SIZE):
    """Creates a tiny solid-color video file with PyAV."""
    container = av.open(str(path), "w")
    stream = container.add_stream("mpeg4", rate=fps)
    stream.width, stream.height = size
    stream.pix_fmt = "yuv420p"
    stream.codec_context.gop_size = fps  # keyframe every second so seeks land accurately

    for _ in range(int(duration * fps)):
        frame = av.VideoFrame.from_image(Image.new("RGB", size, color))
        for packet in stream.encode(frame):
            container.mux(packet)

    for packet in stream.encode():  # flush
        container.mux(packet)

    container.close()
    return str(path)


@pytest.fixture(scope="module")
def videos(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("media")
    return {
        # 2 second clips in different colors so frames are distinguishable
        "red": make_video(tmp / "red.mp4", (200, 0, 0), duration=2.0),
        "green": make_video(tmp / "green.mp4", (0, 200, 0), duration=2.0),
        # very short clip for end-of-stream / replay tests
        "short": make_video(tmp / "short.mp4", (0, 0, 200), duration=0.5),
    }


@pytest.fixture(scope="session")
def root():
    # one interpreter for the whole session: repeatedly creating and
    # destroying Tk interpreters in one process is fragile
    r = tk.Tk()
    r.withdraw()
    yield r
    r.destroy()


@pytest.fixture
def player(root):
    p = TkinterVideo(root, scaled=False)
    p.set_size(SIZE)
    p.pack()
    p.winfo_id()  # force the underlying window to exist, or event_generate
                  # silently drops virtual events for this widget
    root.update()
    yield p
    try:
        p.stop()
        p.destroy()
    except Exception:
        pass


def pump(root, condition, timeout=10.0, interval_ms=5):
    """Runs the tk event loop until condition() is true or the timeout expires.

    Uses a real mainloop so the decode thread's cross-thread tkinter calls
    (event_generate etc.) are marshaled correctly.
    """
    deadline = time.monotonic() + timeout

    def check():
        if condition() or time.monotonic() >= deadline:
            root.quit()
        else:
            root.after(interval_ms, check)

    root.after(interval_ms, check)
    root.mainloop()
    root.update_idletasks()
    return condition()


def dominant_color(img):
    r, g, b = img.convert("RGB").resize((1, 1)).getpixel((0, 0))
    return r, g, b


class EventLog:
    def __init__(self, player):
        self.events = []
        self.timed = []  # (name, monotonic timestamp)
        for name in ("<<Loaded>>", "<<Duration>>", "<<FrameGenerated>>",
                     "<<SecondChanged>>", "<<Ended>>"):
            player.bind(name, self._make_handler(name))

    def _make_handler(self, name):
        def handler(event):
            self.events.append(name)
            self.timed.append((name, time.monotonic()))
        return handler

    def count(self, name):
        return self.events.count(name)

    def clear(self):
        self.events.clear()
        self.timed.clear()


def test_load_and_play_generates_events(root, player, videos):
    log = EventLog(player)

    player.load(videos["red"])
    player.play()

    assert pump(root, lambda: log.count("<<Loaded>>") == 1)
    assert pump(root, lambda: log.count("<<FrameGenerated>>") >= 3)
    assert player.video_info()["framerate"] == FPS
    assert 1.5 < player.video_info()["duration"] <= 2.5
    assert player.video_info()["framesize"] == SIZE
    assert player.current_frame_number() >= 3
    assert player.current_duration() > 0
    assert player.current_img() is not None
    assert not player.is_paused()


def test_switch_source_kills_old_thread_and_blocks_stale_events(root, player, videos):
    log = EventLog(player)

    player.load(videos["red"])
    player.play()
    # let the red video play close to its 2s end, so a leaked old thread
    # would emit <<SecondChanged>> (frame 20) and <<Ended>> within ~0.2s
    assert pump(root, lambda: player.current_frame_number() >= 18)

    old_thread = player._load_thread
    assert old_thread is not None and old_thread.is_alive()

    # switch source mid-playback
    player.load(videos["green"])

    # the old decode thread must be fully terminated before load() returns
    assert not old_thread.is_alive()

    player.play()
    assert pump(root, lambda: log.count("<<Loaded>>") >= 2)  # green's <<Loaded>>

    # the old red thread is dead and its queued events are dropped by the
    # player, so everything logged from here on belongs to the green video
    log.clear()
    t0 = time.monotonic()

    # watch the first 1.5s of the 2s green video: its own <<SecondChanged>>
    # fires at ~1.0s and <<Ended>> at ~2.0s, so within this window the green
    # video can only produce <<SecondChanged>> near the 1s mark and no
    # <<Ended>> at all; anything else can only be stale red pollution
    pump(root, lambda: False, timeout=1.5)

    assert log.count("<<Ended>>") == 0
    for name, ts in log.timed:
        if name == "<<SecondChanged>>":
            assert ts - t0 >= 0.7, "stale <<SecondChanged>> from the old video"

    # frames now come from the green video
    assert player.current_frame_number() > 2
    r, g, b = dominant_color(player.current_img())
    assert g > r and g > b


def test_seek_while_paused_updates_frame_immediately(root, player, videos):
    player.load(videos["red"])
    player.play()
    assert pump(root, lambda: player.current_frame_number() > 5)

    player.pause()
    assert pump(root, lambda: True, timeout=0.1)  # let the loop settle
    assert player.is_paused()

    img_before = player.current_img()

    player.seek(1)

    # the seek must take effect without resuming playback
    assert pump(root, lambda: player.current_frame_number() >= FPS * 1)
    assert player.is_paused()
    assert 0.5 <= player.current_duration() <= 1.5
    assert player.current_img() is not None
    assert player.current_img() is not img_before

    # resuming continues from the seek position
    frame_at_seek = player.current_frame_number()
    player.play()
    assert pump(root, lambda: player.current_frame_number() > frame_at_seek + 2)


def test_seek_is_clamped_to_valid_range(root, player, videos):
    player.load(videos["red"])
    player.play()
    assert pump(root, lambda: player.video_info()["duration"] > 0)
    duration = player.video_info()["duration"]

    player.stop()  # no decode thread: the raw stored request is inspectable

    player.seek(-5)
    assert player._seek_requested == 0

    player.seek(9999)
    assert player._seek_requested == duration

    # behavioral check: negative seek lands at the start of the video
    player.seek(-5)
    player.play()
    assert pump(root, lambda: player.current_frame_number() >= 1)
    assert player.current_duration() < 1.0


def test_seek_to_duration_ends_video(root, player, videos):
    log = EventLog(player)
    player.load(videos["red"])
    player.play()
    assert pump(root, lambda: player.video_info()["duration"] > 0)
    duration = player.video_info()["duration"]

    player.seek(duration + 100)  # clamped to duration -> immediate EOF

    assert pump(root, lambda: log.count("<<Ended>>") == 1)
    assert player.current_duration() <= duration
    assert player.is_paused()


def test_replay_after_end(root, player, videos):
    log = EventLog(player)
    player.load(videos["short"])
    player.play()

    assert pump(root, lambda: log.count("<<Ended>>") == 1)
    assert log.count("<<Loaded>>") == 1
    assert player.is_paused()

    # pressing play again restarts from the beginning
    player.play()
    assert pump(root, lambda: player.current_frame_number() >= 1)
    assert pump(root, lambda: log.count("<<Ended>>") == 2)

    # the full event sequence repeats, except <<Loaded>>
    assert log.count("<<Loaded>>") == 1
    assert log.count("<<FrameGenerated>>") >= 8


def test_ended_handler_may_call_play_for_looping(root, player, videos):
    ended_count = []

    def on_end(event):
        ended_count.append(1)
        if len(ended_count) < 3:
            player.play()  # loop, like examples/loop_example.py

    player.bind("<<Ended>>", on_end)
    player.load(videos["short"])
    player.play()

    assert pump(root, lambda: len(ended_count) >= 3, timeout=30)


def test_concurrent_stop_and_load(root, player, videos):
    log = EventLog(player)
    player.load(videos["red"])
    player.play()
    assert pump(root, lambda: player.current_frame_number() > 2)

    # hammer stop/play/load from the event thread while decoding runs
    for _ in range(5):
        player.stop()
        player.play()
        player.stop()

    player.load(videos["green"])
    player.stop()
    player.load(videos["red"])
    player.play()

    log.clear()
    assert pump(root, lambda: log.count("<<Loaded>>") == 1)
    assert pump(root, lambda: player.current_frame_number() > 2)
    r, g, b = dominant_color(player.current_img())
    assert r > g and r > b

    player.stop()
    assert player.current_frame_number() == 0
    assert player.current_duration() == 0
    assert player.is_paused()


def test_stop_without_video_and_double_stop(root, player):
    player.stop()  # nothing loaded, must not raise
    player.stop()
    assert player.is_paused()
    assert player.current_frame_number() == 0
    assert player.metadata() == {}


def test_play_pause_idempotent(root, player, videos):
    player.load(videos["red"])
    player.play()
    player.play()  # second play while running is a no-op
    assert pump(root, lambda: player.current_frame_number() > 2)
    first_thread = player._load_thread

    player.pause()
    player.pause()
    assert player.is_paused()

    player.play()  # resume on the same thread
    assert player._load_thread is first_thread
    assert not player.is_paused()
    assert pump(root, lambda: player.current_frame_number() > 4)
