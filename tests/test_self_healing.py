"""PlaybackCore self-healing, driven through an injectable fake player.

Where test_player.py/test_truncation.py poke the core's slots directly,
these tests stand a headless FakePlayer in for QMediaPlayer and exercise
the whole chain — set_stream() load, backend signals (EndOfMedia/error),
the position poll watchdog, and the app-layer re-resolve round trip —
without a network or a sound card.

The paths pinned here mirror the failure contract:

* a truncated stream (EndOfMedia far short of the known runtime) rejoins
  the SAME song near its breakpoint on a freshly resolved URL;
* a rejoin needs real audio AND a position that actually advanced —
  zero-position deaths skip, they never re-feed a dead URL;
* the rejoin budget is bounded per track and, once spent, falls through
  to the single-shot error skip;
* healthy playback past the renewal window gives the budget back, so one
  flaky minute can't strand a whole song;
* the watchdog gives loading/buffering backends grace, then judges;
* while a crossfade takeover owns the room, the outgoing stream's
  errors, frozen positions and EndOfMedia relays are absorbed — only the
  promotion advances the queue, exactly once.
"""

import pytest
from PyQt6.QtMultimedia import QMediaPlayer

from hearth import config
from hearth.player import CrossfadeController, PlaybackCore

from .test_crossfade import FakeHandle
from .test_models import make_track


def tracks(n, **overrides):
    return [
        make_track(video_id=f"t{i}", title=f"Song {i}", **overrides)
        for i in range(n)
    ]


class _FakeSignal:
    """The sliver of pyqtSignal a headless backend needs (connect/emit)."""

    def __init__(self):
        self._slots = []

    def connect(self, slot):
        self._slots.append(slot)

    def disconnect(self, slot):
        try:
            self._slots.remove(slot)
        except ValueError:
            pass

    def emit(self, *args):
        for slot in list(self._slots):
            slot(*args)


class FakePlayer:
    """Headless QMediaPlayer stand-in for the full healing loop.

    Position and media status are scripted by the test (`_pos`,
    `_status`); the core drives it only through the Qt-style surface the
    real backend exposes, so every code path under test is production
    code — nothing reaches into the core's private ledger to fake state.
    """

    def __init__(self):
        self.playbackStateChanged = _FakeSignal()
        self.mediaStatusChanged = _FakeSignal()
        self.errorOccurred = _FakeSignal()
        self.durationChanged = _FakeSignal()
        self._pos = 0
        self._status = QMediaPlayer.MediaStatus.BufferedMedia
        self._state = QMediaPlayer.PlaybackState.StoppedState
        self.sources: list[str] = []
        self.positions: list[int] = []
        self.plays = 0
        self.stops = 0
        self.rates: list[float] = []

    # --- the Qt-style surface PlaybackCore ducks on ---

    def setSource(self, source):
        self.sources.append(str(source.toString()))

    def setPlaybackRate(self, rate):
        self.rates.append(float(rate))

    def play(self):
        self.plays += 1
        self._state = QMediaPlayer.PlaybackState.PlayingState
        self.playbackStateChanged.emit(self._state)

    def pause(self):
        self._state = QMediaPlayer.PlaybackState.PausedState
        self.playbackStateChanged.emit(self._state)

    def stop(self):
        self.stops += 1
        self._state = QMediaPlayer.PlaybackState.StoppedState

    def setPosition(self, ms):
        self._pos = int(ms)
        self.positions.append(int(ms))

    def setAudioOutput(self, _out):
        pass

    def playbackState(self):
        return self._state

    def mediaStatus(self):
        return self._status

    def position(self):
        return self._pos

    def duration(self):
        return 0

    # --- test scripting: the "backend" observing real failures ---

    def end_of_media(self):
        self._status = QMediaPlayer.MediaStatus.EndOfMedia
        self.mediaStatusChanged.emit(self._status)

    def fail(self, message="CDN dropped the stream"):
        self.errorOccurred.emit(QMediaPlayer.Error.ResourceError, message)


def _streaming_core() -> tuple[PlaybackCore, FakePlayer]:
    """A core whose lazy backend is already a connected FakePlayer."""
    core = PlaybackCore()
    fake = FakePlayer()
    core._player = fake
    core._audio_out = object()
    core._connect_backend()
    return core, fake


def _rejoin(core, lost, index, url):
    """Simulate the app layer: re-resolve and feed the fresh URL back."""
    track, resume_ms = lost[index]
    core.set_stream(track, url, resume_ms=resume_ms)


# --- truncation: premature EndOfMedia heals the same song in place ---


def test_truncated_stream_rejoins_near_breakpoint_with_fresh_url(qapp):
    core, fake = _streaming_core()
    lost = []
    core.stream_lost.connect(lambda t, ms: lost.append((t, ms)))
    core.start_queue(tracks(2))                       # 213s tracks
    t0 = core.engine.current
    core.set_stream(t0, "https://cdn.example.com/a?expire=1")

    # audio demonstrably flows and advances 50s into the song
    core._note_playing(True)
    fake._pos = 50_000
    core._emit_position()
    assert core._stream_played and core._last_pos_ms == 50_000

    fake.end_of_media()                               # CDN cut it early

    # the queue did NOT move — the same song is healed in place, and the
    # app is asked for a brand-new resolution at the breakpoint
    assert core.engine.current.video_id == "t0"
    assert [(t.video_id, ms) for t, ms in lost] == [("t0", 50_000)]

    _rejoin(core, lost, 0, "https://cdn.example.com/a?expire=2")
    assert fake.sources[-1] == "https://cdn.example.com/a?expire=2"
    # rejoined near the breakpoint, backed off so the new stream can't
    # tip straight back into its own EndOfMedia
    assert fake.positions == [50_000 - config.STREAM_RESUME_BACKSTEP_MS]
    assert fake.plays == 2
    assert core.engine.current.video_id == "t0"


def test_natural_end_through_fake_player_still_advances(qapp):
    core, fake = _streaming_core()
    seen = []
    core.track_changed.connect(seen.append)
    core.start_queue(tracks(2))
    core.set_stream(core.engine.current, "https://cdn.example.com/a")
    core._note_playing(True)
    # past the 92% truncation threshold of the 213s track: a real finish
    fake._pos = int(213 * 1000 * config.STREAM_TRUNCATION_RATIO) + 1_000
    core._emit_position()
    fake.end_of_media()
    assert core.engine.current.video_id == "t1"
    assert seen[-1].video_id == "t1"


# --- the proof-of-audio gate: no positional progress, no rejoin ---


def test_truncation_at_zero_position_skips_instead_of_rejoining(qapp):
    core, fake = _streaming_core()
    lost = []
    core.stream_lost.connect(lambda t, ms: lost.append((t, ms)))
    seen = []
    core.track_changed.connect(seen.append)
    core.start_queue(tracks(2))
    core.set_stream(core.engine.current, "https://cdn.example.com/dead")
    core._note_playing(True)                          # backend flickered Playing…
    assert core._stream_played and core._last_pos_ms == 0   # …but never advanced

    fake.end_of_media()

    assert not lost                                   # the dead URL is not re-fed
    assert core.engine.current.video_id == "t1"
    assert seen[-1].video_id == "t1"


def test_watchdog_zero_position_never_rejoins_even_with_playing_proof(qapp):
    core, fake = _streaming_core()
    lost = []
    core.stream_lost.connect(lambda t, ms: lost.append((t, ms)))
    core.start_queue(tracks(2))
    core.set_stream(core.engine.current, "https://cdn.example.com/dead")
    core._note_playing(True)
    fake._pos = 0                                     # frozen at zero the whole time

    for _ in range(config.STALL_POLLS):
        core._emit_position()

    assert not lost                                   # no song to rejoin
    assert core.engine.current.video_id == "t1"      # clean skip
    assert not core._playing


def test_watchdog_advanced_position_rejoins_frozen_stream(qapp):
    core, fake = _streaming_core()
    lost = []
    core.stream_lost.connect(lambda t, ms: lost.append((t, ms)))
    core.start_queue(tracks(1))
    core.set_stream(core.engine.current, "https://cdn.example.com/a")
    core._note_playing(True)
    fake._pos = 90_000                                # well underway, then frozen
    core._emit_position()

    for _ in range(config.STALL_POLLS):
        core._emit_position()

    assert [(t.video_id, ms) for t, ms in lost] == [("t0", 90_000)]
    assert core.engine.current.video_id == "t0"      # healed, not skipped


# --- bounded budget: exhausted rejoins become one honest skip ---


def test_rejoin_budget_exhausted_then_skips(qapp):
    core, fake = _streaming_core()
    lost = []
    core.stream_lost.connect(lambda t, ms: lost.append((t, ms)))
    core.start_queue(tracks(3))
    t0 = core.engine.current
    core.set_stream(t0, "https://cdn.example.com/a?expire=0")
    core._note_playing(True)
    fake._pos = 10_000                                # inside the 30s renewal window
    core._emit_position()

    for i in range(config.STREAM_MAX_RECOVERIES):
        fake.end_of_media()
        # each rejoin lands but never plays far enough to renew the budget
        _rejoin(core, lost, i, f"https://cdn.example.com/a?expire={i + 1}")
        core._note_playing(True)
        fake._pos = lost[i][1]                        # barely re-buffered
        core._emit_position()

    assert len(lost) == config.STREAM_MAX_RECOVERIES
    assert core._retries == config.STREAM_MAX_RECOVERIES

    fake.end_of_media()                               # one truncation too many

    assert len(lost) == config.STREAM_MAX_RECOVERIES  # no further rejoin…
    assert core.engine.current.video_id == "t1"       # …one bounded skip instead


def test_consecutive_error_skips_eventually_stop(qapp):
    """Each genuinely-played track earns one error skip; a long enough
    run of deaths stops playback with an honest status instead of
    hopping through the whole queue."""
    core, fake = _streaming_core()
    statuses = []
    core.status.connect(statuses.append)
    core.start_queue(tracks(core.MAX_ERROR_SKIPS + 4))

    for _ in range(core.MAX_ERROR_SKIPS + 1):
        track = core.engine.current
        core.set_stream(track, "https://cdn.example.com/a")
        core._note_playing(True)                      # each track genuinely plays…
        fake._pos = 12_000
        core._emit_position()
        # …its rejoin budget is already spent, so this death falls
        # straight through to the bounded error-skip path
        core._recovered_id = track.video_id
        core._retries = config.STREAM_MAX_RECOVERIES
        fake.fail()

    assert not core._playing
    assert core.engine.current.video_id == f"t{core.MAX_ERROR_SKIPS}"
    assert any("too many errors" in s for s in statuses)


# --- healthy playback earns the budget back ---


def test_healthy_playback_renews_rejoin_budget(qapp):
    core, fake = _streaming_core()
    lost = []
    core.stream_lost.connect(lambda t, ms: lost.append((t, ms)))
    core.start_queue(tracks(1))
    t0 = core.engine.current
    core.set_stream(t0, "https://cdn.example.com/a?expire=0")
    core._note_playing(True)
    fake._pos = 10_000
    core._emit_position()

    for i in range(config.STREAM_MAX_RECOVERIES):    # spend the whole budget
        fake.end_of_media()
        _rejoin(core, lost, i, f"https://cdn.example.com/a?expire={i + 1}")
        core._note_playing(True)
        fake._pos = lost[i][1]
        core._emit_position()
    assert core._retries == config.STREAM_MAX_RECOVERIES

    # the new stream then plays healthily past the renewal window
    fake._pos = core._stream_anchor_ms + config.STREAM_RECOVERY_RESET_MS + 1
    core._emit_position()
    fake.end_of_media()

    assert len(lost) == config.STREAM_MAX_RECOVERIES + 1
    assert core._retries == 1                        # renewed: a fresh first try
    assert core.engine.current.video_id == "t0"      # still the same song


# --- watchdog grace: loading/buffering is alive, just shy ---


@pytest.mark.parametrize(
    "status_name",
    ["LoadingMedia", "BufferingMedia", "StalledMedia"],
)
def test_watchdog_gives_loading_buffering_grace(qapp, status_name):
    core, fake = _streaming_core()
    lost = []
    core.stream_lost.connect(lambda t, ms: lost.append((t, ms)))
    core.start_queue(tracks(2))
    core.set_stream(core.engine.current, "https://cdn.example.com/slow")
    core._note_playing(True)
    fake._status = getattr(QMediaPlayer.MediaStatus, status_name)
    fake._pos = 0

    for _ in range(config.STALL_POLLS * 3):          # far past the stall threshold…
        core._emit_position()

    assert not lost                                  # …but grace means no judgment
    assert core.engine.current.video_id == "t0"
    assert core._stall_polls == 0

    # once the backend settles while still frozen, the watchdog judges:
    # a zero-position stream skips rather than rejoining
    fake._status = QMediaPlayer.MediaStatus.BufferedMedia
    for _ in range(config.STALL_POLLS):
        core._emit_position()
    assert not lost
    assert core.engine.current.video_id == "t1"


# --- crossfade takeover: the outgoing stream can no longer heal anything ---


@pytest.fixture()
def enabled(qapp, monkeypatch):
    monkeypatch.setattr(config, "CROSSFADE_ENABLED", True)
    return qapp


def _primed_takeover():
    """A flag-on core, fake primary, primed shadow, ramp not yet engaged."""
    core, fake = _streaming_core()
    core.shadow_factory = FakeHandle
    core.set_crossfade(2)
    core.start_queue(tracks(3))
    core.set_stream(core.engine.current, "https://cdn.example.com/t0")
    core._playing = True
    core.queue_changed.emit()
    core.prime_shadow(tracks(3)[1], "https://cdn.example.com/t1")
    assert core._xf.state == CrossfadeController.PRIMED
    return core, fake


def test_crossfade_takeover_absorbs_old_stream_error(enabled):
    core, fake = _primed_takeover()
    lost = []
    core.stream_lost.connect(lambda t, ms: lost.append((t, ms)))
    core._on_end_of_media()                          # natural end engages the ramp
    assert core._xf.state == CrossfadeController.CROSSFADING

    core._note_playing(True)
    fake.fail("outgoing stream died mid-ramp")       # the old primary errors

    assert not lost                                  # absorbed: no rejoin…
    assert core.engine.current.video_id == "t0"      # …and no queue movement
    assert core._playing

    for _ in range(20):                              # run the 2s ramp
        core._xf_tick()
    assert core.engine.current.video_id == "t1"      # promotion: the ONE advance


def test_crossfade_takeover_absorbs_truncated_end_of_media(enabled):
    core, fake = _primed_takeover()
    lost = []
    core.stream_lost.connect(lambda t, ms: lost.append((t, ms)))
    core._on_end_of_media()                          # ramp takes over
    assert core._xf.state == CrossfadeController.CROSSFADING

    # a late, truncation-looking relay from the outgoing stream
    core._note_playing(True)
    core._last_pos_ms = 40_000
    fake.end_of_media()

    assert not lost                                  # it must not rejoin the dead…
    assert core._xf.state == CrossfadeController.CROSSFADING
    assert core.engine.current.video_id == "t0"

    for _ in range(20):
        core._xf_tick()
    assert core.engine.current.video_id == "t1"      # promotion still advances once


def test_crossfade_takeover_frozen_position_does_not_trigger_watchdog(enabled):
    core, fake = _primed_takeover()
    lost = []
    core.stream_lost.connect(lambda t, ms: lost.append((t, ms)))
    core._on_end_of_media()
    fake._pos = 60_000                               # old primary frozen mid-ramp
    core._playing = True
    core._last_pos_ms = 60_000

    for _ in range(config.STALL_POLLS * 2):
        core._emit_position()

    assert not lost                                  # the watchdog stands down
    assert core.engine.current.video_id == "t0"      # nothing advanced yet
    for _ in range(20):
        core._xf_tick()
    assert core.engine.current.video_id == "t1"      # the promotion alone moves it


def test_primed_shadow_before_takeover_still_heals_primary(enabled):
    """PRIMED is pre-takeover: until the ramp actually engages, the
    primary owns the room and its mid-song deaths heal normally."""
    core, fake = _primed_takeover()
    lost = []
    core.stream_lost.connect(lambda t, ms: lost.append((t, ms)))
    core._note_playing(True)
    fake._pos = 50_000
    core._emit_position()

    fake.fail("CDN 403")

    assert [(t.video_id, ms) for t, ms in lost] == [("t0", 50_000)]
    assert core.engine.current.video_id == "t0"
