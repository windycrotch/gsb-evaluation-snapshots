"""Test doubles for the libmpv engine and helpers for deterministic state chains.

The real Engine needs libmpv plus an OpenGL context, neither of which is available in a headless
test run. FakeEngine reproduces the Engine facade (signals, get/set/cmd/load/shutdown, the ``lib``
handle used when the video widget is built) and records every call so tests can assert which file
and which subtitle commands the Player issued. Nothing here ever touches a real mpv core.
"""

from __future__ import annotations

import shutil
import subprocess
from types import SimpleNamespace

from PySide6.QtCore import QObject


class _RecordingSignal:
    """Minimal stand-in for a Qt Signal whose disconnect() must be observable in tests.

    Qt's SignalInstance is read-only, so its disconnect cannot be monkeypatched; this object keeps
    the same connect/emit/disconnect surface while recording every disconnection in order.
    """

    def __init__(self, record):
        self._slots = []
        self._record = record

    def connect(self, slot):
        self._slots.append(slot)

    def disconnect(self, slot=None):
        self._record(slot)
        if slot in self._slots:
            self._slots.remove(slot)
        return True

    def emit(self, *args):
        for slot in list(self._slots):
            slot(*args)


class FakeEngine(QObject):
    """In-process stand-in for engine.Engine: stores properties instead of forwarding to mpv."""

    def __init__(self, settings, silent: bool = False, verbose: bool = False, parent=None):
        super().__init__(parent)
        self.settings = settings
        self.silent = silent
        self.verbose = verbose
        # Set by the player fixture once the owning Player exists.
        self.player = None
        self.log_lines = []
        self._alive = True
        self._props: dict = {}
        # Test instrumentation: signal disconnections and their order during shutdown.
        self.disconnects: list[str] = []
        # Recording signals mirror the real Engine's prop/event Signal surface.
        self.prop = _RecordingSignal(lambda slot: self.disconnects.append("prop"))
        self.event = _RecordingSignal(lambda slot: self.disconnects.append("event"))
        # History of engine calls, in order.
        self.commands: list[tuple] = []
        self.sets: list[tuple] = []
        self.loads: list[tuple] = []
        self.shutdown_calls = 0
        # Token stamped on the next end-file event. The Player is the source of truth for load
        # identity; tests can also set this explicitly to simulate a reply from a stale load.
        self.active_load_token = None
        # The video widget only stores this proc address object; it is never invoked without GL.
        self.lib = SimpleNamespace(
            MpvGlGetProcAddressFn=lambda fn: fn,
            lazy_decoder=None,
        )

    # -- test-side helpers ----------------------------------------------------------------------
    def emit_prop(self, name, value):
        if self._alive:
            self.prop.emit(name, value)

    def emit_event(self, name, data=None):
        if self._alive:
            self.event.emit(name, data or {})

    def file_loaded(self):
        """Simulate mpv finishing the current loadfile successfully."""
        self.emit_event("file-loaded", {"event": "file-loaded"})
        # A loaded file leaves idle mode; the Player keys has_file() off idle-active.
        self.emit_prop("idle-active", False)

    def load_failed(self, token=None):
        """Simulate mpv reporting an end-file error, tagged with the load it belongs to."""
        self.emit_event(
            "end-file",
            {"event": "end-file", "reason": "error", "samovar_load_token": self._token(token)},
        )
        self.emit_prop("idle-active", True)

    def _token(self, token):
        if token is not None:
            return token
        if self.player is not None:
            return self.player._end_token
        return self.active_load_token

    # -- Engine facade --------------------------------------------------------------------------
    def get(self, name, default=None):
        return self._props.get(name, default)

    def set(self, name, value) -> bool:
        if not self._alive:
            return False
        self.sets.append((name, value))
        self._props[name] = value
        return True

    def cmd(self, *args) -> bool:
        if not self._alive:
            return False
        self.commands.append(tuple(str(a) for a in args))
        return True

    def load(self, path: str, start=None) -> bool:
        if not self._alive:
            return False
        self.loads.append((path, start))
        return True

    def cmd_sync(self, *args):
        if not self._alive:
            return None
        self.commands.append(tuple(str(a) for a in args))
        return None

    def add(self, name, delta, lo=None, hi=None):
        value = (self._props.get(name, 0) or 0) + delta
        if lo is not None:
            value = max(lo, value)
        if hi is not None:
            value = min(hi, value)
        self.set(name, value)
        return value

    def shutdown(self):
        if not self._alive:
            return
        self._alive = False
        self.shutdown_calls += 1


def make_clip(path, seconds=2, size="320x240"):
    """Create a real short clip with ffmpeg when present, otherwise an empty placeholder.

    The Player's state-chain logic never decodes the media itself (the fake engine does not), so a
    placeholder path is enough to drive open/switch/failure flows. On a machine with ffmpeg the same
    helper yields a genuine playable file, matching how the end-to-end smoke test builds its media.
    """
    path = str(path)
    ffmpeg = shutil.which("ffmpeg")
    if ffmpeg:
        subprocess.run(
            [
                ffmpeg,
                "-nostdin",
                "-v",
                "error",
                "-y",
                "-f",
                "lavfi",
                "-i",
                "testsrc2=size=%s:rate=24:duration=%d" % (size, seconds),
                "-c:v",
                "libx264",
                "-preset",
                "ultrafast",
                "-pix_fmt",
                "yuv420p",
                path,
            ],
            check=True,
            stdin=subprocess.DEVNULL,
        )
    else:
        open(path, "wb").close()
    return path


def make_subtitle(path, text="hello"):
    with open(path, "w", encoding="utf-8") as fh:
        fh.write("1\n00:00:00,200 --> 00:00:05,000\n%s\n" % text)
    return str(path)


def command_names(engine, head):
    """All recorded engine commands whose first element equals *head*."""
    return [c for c in engine.commands if c and c[0] == head]
