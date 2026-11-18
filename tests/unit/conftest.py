"""Shared pytest setup.

Playlist panel tests instantiate real Qt widgets; force the headless platform so
they work on CI (and Windows/macOS) without a display. Must be set before
QApplication is created.
"""

import os

import pytest

os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")


class SignalSpy:
    """Context manager counting emissions of a Qt signal while it is active."""

    def __init__(self, signal):
        self.signal = signal
        self.count = 0

    def __enter__(self):
        self.signal.connect(self._slot)
        return self

    def __exit__(self, exc_type, exc, tb):
        self.signal.disconnect(self._slot)
        return False

    def _slot(self, *args):
        self.count += 1


@pytest.fixture
def signal_spy():
    return SignalSpy
