"""FileProcessor integration: pause-aware position + failure bookkeeping.

pygame and librosa are replaced by tiny stubs, so this runs offline on any
machine (no sound card, no SDL, no analysis).
"""
import sys
import time
import types

import pytest

from playback_clock import PlaybackClock


class FakeMusic:
    def __init__(self):
        self.ms = 0
        self.playing = False

    def init(self):
        pass

    def load(self, path):
        pass

    def play(self):
        self.playing = True
        self.ms = 0

    def stop(self):
        self.playing = False
        self.ms = 0

    def pause(self):
        self.playing = False

    def unpause(self):
        self.playing = True

    def get_busy(self):
        return self.playing

    def get_pos(self):
        return self.ms


@pytest.fixture()
def fileprocessor(monkeypatch):
    fake_music = FakeMusic()
    pygame_stub = types.ModuleType("pygame")
    pygame_stub.mixer = types.SimpleNamespace(
        init=lambda: None, music=fake_music)
    librosa_stub = types.ModuleType("librosa")
    librosa_stub.load = lambda *a, **k: (_ for _ in ()).throw(OSError("nope"))
    monkeypatch.setitem(sys.modules, "pygame", pygame_stub)
    monkeypatch.setitem(sys.modules, "librosa", librosa_stub)
    sys.modules.pop("fileprocessor", None)
    import fileprocessor as module
    fp = module.FileProcessor()
    yield fp, fake_music
    sys.modules.pop("fileprocessor", None)


class FakeClock:
    def __init__(self):
        self.now = 500.0

    def __call__(self):
        return self.now

    def tick(self, seconds):
        self.now += seconds


def test_position_pauses_without_advancing(fileprocessor):
    fp, music = fileprocessor
    clock = FakeClock()
    fp._clock = PlaybackClock(music.get_pos, monotonic=clock)
    fp.is_analyzed = True
    fp.duration = 10.0
    fp.playlist = ["song.wav"]
    fp.index = 0

    fp._play_from_start()
    clock.tick(1.2)
    music.ms = 1200
    assert fp.get_position() == pytest.approx(1.2)

    fp.toggle_play_pause()
    assert fp.playback_state == "paused"
    clock.tick(60.0)          # long pause
    music.ms = 61200          # backends that keep counting still must not leak
    assert fp.get_position() == pytest.approx(1.2)

    fp.toggle_play_pause()
    assert fp.playback_state == "playing"
    clock.tick(0.3)
    music.ms = 61500          # 1.2 s + 0.3 s of real playback
    assert fp.get_position() == pytest.approx(1.5)


def test_failed_analysis_is_reported_once(fileprocessor):
    fp, _music = fileprocessor
    fp.playlist = ["broken.wav"]

    def boom(path):
        raise OSError("cannot decode")

    fp._analyze = boom
    assert fp.play_index(0, autoplay=False) is True

    deadline = time.time() + 5
    while not fp.load_failed and time.time() < deadline:
        time.sleep(0.01)
    assert fp.load_failed is True
    assert fp.is_analyzed is False

    assert fp.pop_failed() == ["broken.wav"]
    assert fp.pop_failed() == []          # only reported once
    assert "broken.wav" in fp.pop_error()


def test_paused_track_is_not_treated_as_finished(fileprocessor):
    """Some backends report get_busy() == False while paused. The paused track
    must not advance the playlist (which would corrupt an export timeline)."""
    fp, music = fileprocessor
    fp.playlist = ["one.wav", "two.wav"]
    fp.index = 0
    fp.is_analyzed = True
    fp.duration = 10.0
    fp._play_from_start()

    fp.toggle_play_pause()                 # pause
    assert fp.playback_state == "paused"
    assert music.get_busy() is False       # backend looks "finished"

    fp.update()                            # must not advance the playlist
    assert fp.index == 0
    assert fp.playback_state == "paused"
    assert fp.ended_all is False

    fp.toggle_play_pause()                 # resume still works
    assert fp.playback_state == "playing"
