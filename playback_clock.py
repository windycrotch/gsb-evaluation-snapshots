# -----------------------------------------------------------------------------
#  Awesome-Audio-Visualizer 1.1.0 by Volkan Sah
#  License:      AGPL-3.0-or-later (siehe LICENSE)
# -----------------------------------------------------------------------------
# Playback clock: converts the audio playhead into a position that excludes
# paused time. Used by fileprocessor.FileProcessor and by the export tests.
#
# The video export is driven by this position. Two properties matter:
#   * while paused, position() does not advance (no video frames are made)
#   * after a resume, position() continues at the same audio sample
#
# pygame.mixer.music.get_pos() is not reliable across pauses on every SDL
# build (some versions count the paused time). Therefore the clock re-syncs to
# the audio playhead on every start/resume and only uses the *delta* since that
# sync point. Paused time can never leak into the position.
# -----------------------------------------------------------------------------
import time


class PlaybackClock:
    def __init__(self, position_ms, monotonic=time.monotonic):
        """position_ms: callable returning the audio playhead in milliseconds
        (or a negative value when unavailable)."""
        self._position_ms = position_ms
        self._monotonic = monotonic
        self.state = "stopped"
        self._base = 0.0
        self._sync_ms = 0
        self._clock = None
        self._paused_pos = 0.0

    # ------------------------------------------------------------------ state
    def start(self):
        """A track started at 0:00."""
        self.state = "playing"
        self._base = 0.0
        self._paused_pos = 0.0
        self._resync(0.0)

    def pause(self):
        if self.state != "playing":
            return
        self._paused_pos = self.position() or 0.0
        self.state = "paused"

    def resume(self):
        if self.state != "paused":
            return
        self.state = "playing"
        self._resync(self._paused_pos)

    def stop(self):
        self.state = "stopped"
        self._clock = None

    def _resync(self, base):
        self._base = base
        self._clock = self._monotonic()
        try:
            self._sync_ms = int(self._position_ms())
        except Exception:
            self._sync_ms = -1

    # --------------------------------------------------------------- position
    def position(self):
        """Seconds since the track started (paused time excluded), or None."""
        if self.state == "paused":
            return self._paused_pos
        if self.state != "playing" or self._clock is None:
            return None

        elapsed = max(0.0, self._monotonic() - self._clock)
        try:
            ms = int(self._position_ms())
        except Exception:
            ms = -1
        if ms < 0:
            # backend has no playhead (yet): fall back to wall time
            return self._base + elapsed
        if self._sync_ms < 0:
            # the backend needed a moment before it reported a position;
            # anchor now, keeping the time already elapsed so the position
            # never jumps backwards.
            self._base += elapsed
            self._sync_ms = ms
            self._clock = self._monotonic()
            elapsed = 0.0
        if ms < self._sync_ms:
            # playhead went backwards (should not happen): use wall time
            return self._base + elapsed
        # audio playhead (authoritative, bounded by the elapsed wall time so a
        # broken backend cannot jump ahead)
        return self._base + min(ms - self._sync_ms, (elapsed + 1.0) * 1000) / 1000.0
