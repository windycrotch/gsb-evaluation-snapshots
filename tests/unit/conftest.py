"""Shared pytest fixtures: an offscreen Qt app, isolated settings and a Player on a fake engine.

Every test runs with QT_QPA_PLATFORM=offscreen and a throw-away XDG_CONFIG_HOME, so the suite never
opens a window on a real display and never reads or writes a real user configuration directory.
"""

from __future__ import annotations

import os

import pytest

# Must be set before any PySide6 import in this process.
os.environ.setdefault("QT_QPA_PLATFORM", "offscreen")

from _fakes import FakeEngine  # noqa: E402
from PySide6.QtCore import QTimer  # noqa: E402
from PySide6.QtWidgets import QApplication  # noqa: E402

from samovar_lite import settings as settings_module  # noqa: E402
from samovar_lite.app import Player  # noqa: E402
from samovar_lite.settings import Settings  # noqa: E402


@pytest.fixture(scope="session")
def qapp():
    app = QApplication.instance() or QApplication([])
    yield app


@pytest.fixture
def config_home(tmp_path, monkeypatch):
    """Redirect all Settings paths into a temporary directory and return its config root."""
    home = tmp_path / "home"
    config = home / ".config"
    config.mkdir(parents=True)
    monkeypatch.setenv("XDG_CONFIG_HOME", str(config))
    monkeypatch.setenv("HOME", str(home))
    # Belt and braces: even a direct import of the module constants cannot reach a real profile.
    monkeypatch.setattr(settings_module, "CONFIG_DIR", str(config / "samovar-lite"))
    monkeypatch.setattr(settings_module, "CONFIG_FILE", str(config / "samovar-lite" / "settings.json"))
    monkeypatch.setattr(settings_module, "LEGACY_FILE", str(config / "fast-pot-player" / "settings.json"))
    return config


@pytest.fixture
def settings(config_home):
    return Settings(str(config_home / "samovar-lite" / "settings.json"))


@pytest.fixture
def fake_engine(settings):
    return FakeEngine(settings)


@pytest.fixture
def player(qapp, settings, fake_engine, monkeypatch):
    # The engine factory is how production code plugs a real Engine in; tests inject the fake.
    p = Player(settings, engine_factory=lambda s: fake_engine)
    fake_engine.player = p
    # Bypass the real GL handshake: the fake engine never renders, so mark the widget ready and
    # flush anything queued while the (nonexistent) OpenGL context was being waited for.
    p._gl_ready = True
    pending, p._pending_open = p._pending_open, []
    for paths, append in pending:
        p.open_paths(paths, append)
    yield p
    # Keep tests independent even if a test forgot to close the player.
    if not p._closing:
        try:
            p.close()
        except RuntimeError:
            pass


@pytest.fixture
def immediate_timers(monkeypatch):
    """Make QTimer.singleShot fire its slot synchronously (error auto-advance waits become instant)."""

    def immediate(ms, slot, *args):
        slot()

    monkeypatch.setattr(QTimer, "singleShot", staticmethod(immediate))
    return immediate
