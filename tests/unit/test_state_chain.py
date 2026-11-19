"""State-chain tests: open/switch, failure auto-advance and shutdown ownership.

These tests drive the real Player against a FakeEngine (no libmpv/GL needed), use a temporary
settings directory and generated short video files, and never touch a real user configuration
directory (see conftest.py). They pin the requirement that the visible title, progress bar,
secondary subtitles and resume position always belong to the same file.
"""

from __future__ import annotations

import os

import pytest
from _fakes import command_names, make_clip, make_subtitle

from samovar_lite import settings as settings_module
from samovar_lite.app import MAX_LOAD_FAILURES


@pytest.fixture
def two_episodes(tmp_path):
    one = make_clip(tmp_path / "Show.S01E01.mp4")
    two = make_clip(tmp_path / "Show.S01E02.mp4")
    sub = make_subtitle(tmp_path / "Show.S01E01.srt", "episode one subtitle")
    return one, two, sub


def _start(player, engine, path):
    """Open a single file and let the fake engine report it loaded and playing."""
    player.open_paths([path])
    engine.file_loaded()
    assert player._file_ready
    assert player.current_path == path


def test_settings_are_fully_isolated(config_home):
    # The settings path (redirected by the conftest fixture) resolves inside the temporary XDG
    # config home, never the real user profile.
    assert os.path.abspath(settings_module.CONFIG_FILE).startswith(os.path.abspath(str(config_home)))
    assert not os.path.exists(settings_module.CONFIG_FILE)  # nothing written before the player acts


# ------------------------------------------------------------------------------------------------
# 1) switching files clears the old file's subtitles, then re-applies only current-file subtitles
# ------------------------------------------------------------------------------------------------
def test_switching_file_clears_subtitles_bound_to_old_file(player, fake_engine, two_episodes):
    one, two, sub = two_episodes
    _start(player, fake_engine, one)
    player.add_subtitles([sub])
    assert command_names(fake_engine, "sub-add"), "external subtitle should be added to episode 1"
    assert player._file_subs == [sub]

    switch_marker = len(fake_engine.commands)
    player.next_file()

    # The outgoing file's subtitles are detached before the new file is loaded...
    clears = [c for c in fake_engine.commands[switch_marker:] if c[0] == "sub-remove"]
    assert clears == [("sub-remove", "all")]
    assert ("secondary-sid", "no") in fake_engine.sets
    # ...and nothing bound to the old file survives into the pending/current subtitle sets.
    assert player._file_subs == []
    assert player._pending_subs == []
    # The engine was told to load episode 2, and the title bar already names episode 2.
    assert fake_engine.loads[-1][0] == two
    assert "Show.S01E02" in player.title.title

    fake_engine.file_loaded()
    # After episode 2 loads there must be no sub-add of episode 1's subtitle.
    later_sub_adds = [c for c in fake_engine.commands[switch_marker:] if c[0] == "sub-add"]
    assert later_sub_adds == []
    assert player._file_subs == []
    assert player.current_path == two


def test_reselected_subtitle_shows_up_in_info_panel(player, fake_engine, two_episodes):
    one, two, sub = two_episodes
    _start(player, fake_engine, one)
    player.add_subtitles([sub])
    player.next_file()
    fake_engine.file_loaded()
    assert player._file_subs == [], "old subtitle must not follow into episode 2"

    sub_two = make_subtitle(os.path.join(os.path.dirname(two), "Show.S01E02.srt"), "episode two subtitle")
    player.add_subtitles([sub_two])
    assert player._file_subs == [sub_two]
    assert command_names(fake_engine, "sub-add")[-1][1] == sub_two

    # The info panel is rebuilt from live engine state; the reselected subtitle must be listed.
    fake_engine.emit_prop(
        "track-list",
        [
            {"type": "video", "selected": True, "id": 1, "codec": "h264"},
            {"type": "sub", "selected": True, "id": 2, "external": True, "title": "Show.S01E02.srt"},
        ],
    )
    player.info_visible = True
    player._update_info()
    info = player.video_area.osd.info
    assert "Subtitle" in info
    assert "Show.S01E02.srt" in info
    # And the file named in the panel header is the file the subtitle belongs to.
    assert "Show.S01E02.mp4" in info


def test_switching_settles_old_position_before_loading_new(player, fake_engine, settings, two_episodes):
    one, two, _ = two_episodes
    _start(player, fake_engine, one)
    fake_engine.emit_prop("duration", 100.0)
    fake_engine.emit_prop("time-pos", 33.0)
    assert player._last_pos == 33.0

    player.next_file()
    # Episode 1's position is settled during the switch, before episode 2 reports anything.
    assert settings.get_position(one) == pytest.approx(33.0)
    # Episode 2 starts with a clean progress display.
    assert player.seek.position == 0.0
    assert player._last_pos == 0.0
    assert "Show.S01E02" in player.title.title


# ------------------------------------------------------------------------------------------------
# 2) a failing file carries neither subtitles nor a resume position into the next file
# ------------------------------------------------------------------------------------------------
def test_failed_file_does_not_pollute_next_file(player, fake_engine, settings, tmp_path, immediate_timers):
    bad = make_clip(tmp_path / "broken.mp4")
    good = make_clip(tmp_path / "healthy.mp4")
    stale_sub = make_subtitle(tmp_path / "broken.srt", "subtitle of the broken file")
    player.open_paths([bad, good])
    fake_engine.file_loaded()
    player.add_subtitles([stale_sub])
    assert player._file_subs == [stale_sub]
    marker = len(fake_engine.commands)

    fake_engine.load_failed()  # broken.mp4 fails -> automatic advance to healthy.mp4

    # The failure chain moved on to the next file...
    assert player.current_path == good
    assert player._pending_subs == []
    assert player._file_subs == []
    # ...without re-adding the broken file's subtitle...
    assert [c for c in fake_engine.commands[marker:] if c[0] == "sub-add"] == []
    # ...and without remembering a resume position for the file that failed.
    assert settings.get_position(bad) is None

    fake_engine.file_loaded()
    assert player.current_path == good
    assert player._file_ready
    assert player._fail_count == 0, "a successful load resets the consecutive-failure count"
    assert [c for c in fake_engine.commands[marker:] if c[0] == "sub-add"] == []
    # The visible title belongs to the healthy file, never to the one that failed.
    assert "healthy.mp4" in player.title.title
    assert "broken.mp4" not in player.title.title


def test_consecutive_failures_stop_auto_advance_and_show_error(player, fake_engine, tmp_path, immediate_timers):
    clips = [make_clip(tmp_path / ("clip%d.mp4" % i)) for i in range(MAX_LOAD_FAILURES + 1)]
    player.open_paths(clips)
    fake_engine.file_loaded()

    for _ in range(MAX_LOAD_FAILURES):
        fake_engine.load_failed()

    # Three consecutive failures: automatic advancement stops even though a row remains.
    assert player._fail_count == MAX_LOAD_FAILURES
    assert player._error_stopped is True
    assert player.video_area.osd.center_text == "Playback stopped"
    # The last attempted file is still the current one; the untouched fourth clip was not opened.
    assert player.current_path == clips[MAX_LOAD_FAILURES - 1]
    assert len(fake_engine.loads) == MAX_LOAD_FAILURES
    # Every failed file's position was explicitly cleared, never saved.
    for failed in clips[:MAX_LOAD_FAILURES]:
        assert fake_engine.player.settings.get_position(failed) is None


def test_stale_error_from_an_old_load_is_ignored(player, fake_engine, tmp_path, immediate_timers):
    first = make_clip(tmp_path / "first.mp4")
    second = make_clip(tmp_path / "second.mp4")
    player.open_paths([first, second])
    fake_engine.file_loaded()
    current_token = player._end_token
    # A manual switch supersedes the first load before any error arrives.
    player.next_file()
    assert player._end_token != current_token

    before = player._fail_count
    fake_engine.load_failed(token=current_token)  # reply belonging to the superseded load
    assert player._fail_count == before
    assert player.current_path == second
    assert player._error_stopped is False


# ------------------------------------------------------------------------------------------------
# 3) shutdown: one cleanup, one settings write, late callbacks ignored, correct position ownership
# ------------------------------------------------------------------------------------------------
def test_repeated_close_runs_cleanup_and_settings_write_once(player, fake_engine, settings):
    settings_path = settings.path
    player.close()
    assert fake_engine.shutdown_calls == 1
    assert player._settings_written is True
    assert os.path.exists(settings_path)

    # A second close (repeated Ctrl+Q / window-manager close) is a no-op.
    player.close()
    player.close()
    assert fake_engine.shutdown_calls == 1
    assert player.video_area.video._closed is True


def test_callbacks_arriving_during_shutdown_are_ignored(player, fake_engine):
    player.close()
    # Engine replies that arrive after signals are disconnected / the GL context is released must
    # neither resurrect state nor touch a released widget.
    fake_engine.emit_prop("time-pos", 123.0)
    fake_engine.emit_prop("idle-active", False)
    fake_engine.emit_event("file-loaded", {"event": "file-loaded"})
    fake_engine.emit_event("end-file", {"event": "end-file", "reason": "error", "samovar_load_token": 1})
    assert player._file_ready is False
    assert player._last_pos == 0.0


def test_close_during_switch_keeps_saved_position_of_old_file(player, fake_engine, settings, two_episodes):
    one, two, _ = two_episodes
    _start(player, fake_engine, one)
    fake_engine.emit_prop("duration", 200.0)
    fake_engine.emit_prop("time-pos", 55.0)

    # Switch to episode 2 but close before it finishes loading.
    player.next_file()
    assert player._loading is True
    assert player.current_path == two
    player.close()

    # Episode 1 keeps the position settled at switch time; episode 2 never overwrites it.
    assert settings.get_position(one) == pytest.approx(55.0)
    assert settings.get_position(two) is None
    # A late file-loaded for episode 2 after close cannot save any position for it.
    fake_engine.emit_event("file-loaded", {"event": "file-loaded"})
    fake_engine.emit_prop("time-pos", 88.0)
    assert settings.get_position(two) is None
    assert settings.get_position(one) == pytest.approx(55.0)


def test_close_order_timers_gl_context_signals_engine(player, fake_engine, monkeypatch):
    events = []

    for name in ("_save_timer", "_info_timer", "_cursor_timer"):
        timer = getattr(player, name)
        monkeypatch.setattr(timer, "stop", lambda n=name: events.append(("timer-stop", n)))
    monkeypatch.setattr(player.video_area.video, "shutdown", lambda: events.append(("video-shutdown", None)))
    monkeypatch.setattr(player.engine, "shutdown", lambda: events.append(("engine-shutdown", None)))
    # The recording fake's signals log disconnections as they happen.
    fake_engine.disconnects.clear()
    original_disconnects = fake_engine.prop, fake_engine.event

    def record(kind):
        def _disconnect(slot):
            events.append(("disconnect", kind))
        return _disconnect

    fake_engine.prop.disconnect = record("prop")
    fake_engine.event.disconnect = record("event")

    player.close()

    names = [e[0] for e in events]
    timer_stops = [i for i, e in enumerate(events) if e[0] == "timer-stop"]
    video_i = names.index("video-shutdown")
    disconnect_i = names.index("disconnect")
    engine_i = names.index("engine-shutdown")
    # All timers stop first; then the GL render context is released, signals disconnected, engine
    # closed last.
    assert max(timer_stops) < video_i < disconnect_i < engine_i
    assert {e[1] for e in events if e[0] == "disconnect"} == {"prop", "event"}
    assert original_disconnects  # signals existed before close
