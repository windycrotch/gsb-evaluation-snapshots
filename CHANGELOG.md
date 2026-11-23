# Changelog

All notable changes to Samovar Lite are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and the project uses
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Playlist duration probing is now row-accurate: each entry queues its own ffprobe job, so
  duplicate paths each get a duration, results that arrive after a row was removed or the list
  was cleared are dropped instead of landing on a different entry, and clearing then
  re-importing the same files probes them again.
- Sorting or shuffling the playlist keeps the current-item marker on the same entry and no
  longer loses durations that were still being probed.
- Closing the window now stops the ffprobe worker thread deterministically (queued jobs are
  dropped, a probe in flight is killed, the thread is joined) and disconnects its signal, so
  no callback can reach the playlist after shutdown.

## [1.0.0] - 2026-10-09

First public release.

### Added

- Frameless dark player window with title bar, seek bar, volume bar and control row, drawn entirely
  by the application; idle screen; application icon.
- Playback through libmpv with copy-back hardware decoding (VA-API or NVDEC, chosen by the GPU that
  draws the window) and software fallback.
- Drag and drop of files, folders, URLs and subtitles; Ctrl+drop and drops on the playlist queue.
- Subtitles: automatic loading of files next to the video, UTF-8 detection with a configurable
  fallback code page (Windows-1256 by default), sync, size and position controls, secondary subtitle,
  encoding menu.
- PotPlayer-compatible keyboard shortcuts that also work with non-Latin keyboard layouts, and mouse
  actions on the video (click, double-click, drag, wheel, middle and side buttons).
- Right-click menu covering opening, playback, subtitles, video, audio, capture and window options.
- Playlist panel with automatic queuing of similar files, sorting, repeat modes and shuffle.
- Full screen with controls, title bar and playlist appearing at the screen edges, and subtitles that
  move above the controls.
- Control panel (10-band equalizer, picture, subtitles, speed), preferences, go-to-time, URL and
  information dialogs; playback information overlay.
- Per-file resume, recent files, window auto-fit to the video, screenshots to file and clipboard.
- Single-instance behaviour: a second launch hands its files to the running window.
- Screen-saver inhibition while a video plays.
- `install.sh` for a per-user installation with a menu entry.

### Fixed

- Black horizontal stripes on Intel graphics after the video size changed, by avoiding scalers that
  need lookup textures on Mesa's Intel driver.
- Window left at the wrong size when a file opened while a full-screen transition was in progress
  on Wayland.

[Unreleased]: https://github.com/AliMilani/samovar-lite/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/AliMilani/samovar-lite/releases/tag/v1.0.0
