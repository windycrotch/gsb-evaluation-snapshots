"""Tests for the pause-aware playback clock that drives the export."""
import pytest

from playback_clock import PlaybackClock


class FakeAudio:
    def __init__(self):
        self.ms = 0

    def __call__(self):
        return self.ms


class FakeClock:
    def __init__(self):
        self.now = 1000.0

    def __call__(self):
        return self.now

    def tick(self, seconds):
        self.now += seconds


def make():
    audio, clock = FakeAudio(), FakeClock()
    return PlaybackClock(audio, monotonic=clock), audio, clock


def test_position_excludes_paused_time():
    pc, audio, clock = make()
    pc.start()
    clock.tick(1.0)
    audio.ms = 1000
    assert pc.position() == pytest.approx(1.0)

    pc.pause()
    frozen = pc.position()
    clock.tick(30.0)          # a long pause
    audio.ms = 31000          # some SDL builds count paused time in get_pos()
    assert pc.position() == frozen

    pc.resume()
    clock.tick(0.5)
    audio.ms = 31500
    assert pc.position() == pytest.approx(frozen + 0.5)


def test_resume_does_not_double_count_with_lagging_playhead():
    pc, audio, clock = make()
    pc.start()
    clock.tick(1.0)
    audio.ms = 900             # playhead lags slightly behind wall clock
    assert pc.position() == pytest.approx(0.9)

    pc.pause()
    pc.resume()
    clock.tick(0.25)
    audio.ms = 1150            # exactly the paused sample + 250 ms
    assert pc.position() == pytest.approx(1.15)
    assert pc.position() == pytest.approx(0.9 + 0.25)


def test_stopped_has_no_position_and_start_resets():
    pc, audio, clock = make()
    assert pc.position() is None
    pc.start()
    clock.tick(2.0)
    audio.ms = 2000
    assert pc.position() == pytest.approx(2.0)
    pc.stop()
    assert pc.position() is None
    pc.start()
    assert pc.position() == 0.0


def test_backend_reporting_no_position_yet_does_not_jump_back():
    """get_pos() is -1 right after play() on some systems. The clock must fall
    back to wall time, then anchor to the playhead without going backwards."""
    pc, audio, clock = make()
    audio.ms = -1
    pc.start()

    clock.tick(0.4)
    assert pc.position() == pytest.approx(0.4)     # wall-clock fallback
    clock.tick(0.1)
    audio.ms = 500                                 # backend reports now
    assert pc.position() == pytest.approx(0.5)     # 0.4 + 0.1, not 0.5 - 0.4
    clock.tick(0.2)
    audio.ms = 700
    assert pc.position() == pytest.approx(0.7)


def test_broken_backend_cannot_jump_ahead():
    """A playhead that reports garbage must be bounded by elapsed wall time."""
    pc, audio, clock = make()
    pc.start()
    clock.tick(0.2)
    audio.ms = 60_000                      # nonsense
    assert pc.position() == pytest.approx(1.2)     # elapsed + 1 s grace
