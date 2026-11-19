# Changelog
All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](http://keepachangelog.com/en/1.0.0/)
and this project adheres to [Semantic Versioning](http://semver.org/spec/v2.0.0.html).

## [Unreleased]
### Added
- `.ghps` config
### Changed
- Unnecessary page reload bug fixed
- `loadFromQuery` function modified
- `README.md` updated
## [1.5] - 2026-11-20
### Added
- `recent-store.js` shared module with source-based record identity
- Local test suite under `tests/` (`node --test`)
### Changed
- Recent records are now deduplicated by video source (file name for local entries) instead of title
- Progress updates, resume positioning and removal all target the same source-based record
- Backup import rejects duplicate entries and truncates lists longer than 30 entries; failed imports leave the existing list untouched
- Local file entries switch the form to local mode and prompt for reselection instead of failing silently on stale blob URLs
- ObjectURLs are revoked only after the player detaches them and never while still referenced by the current playback
- Service worker cache bumped to v1.5; old caches are deleted during activation
- Offline navigation requests fall back to the cached homepage (network-first)
- Pending service-worker update prompt is shown once and triggers a single page reload
## [1.4] - 2026-10-03
### Added
- `KeyP` keyboard shortcut
- `End` keyboard shortcut
- Remember volume and mute state
- `getVolume` function
- `setVolume` function
- `getMuted` function
- `setMuted` function
- `restoreAudioSettings` function
### Changed
- `README.md` updated
## [1.3] - 2026-08-29
### Added
- `Space` keyboard shortcut
- `ArrowLeft` keyboard shortcut
- `ArrowRight` keyboard shortcut
- `ArrowUp` keyboard shortcut 
- `ArrowDown` keyboard shortcut
- `KeyF` keyboard shortcut
- `KeyM` keyboard shortcut
- `revokeCurrentMedia` function
### Changed
- `README.md` updated
## [1.2] - 2026-06-22
### Added
- Resume-last button
- Reset watch time button
### Changed
- `createRecentItem` function modified
## [1.1] - 2026-05-24
### Added
- Remove-all button
### Changed
- Icons updated
- `service-worker.js` modified
- `README.md` updated
- Download buttons style updated
## [1.0] - 2026-05-15
### Added
- `showAlert` function
- `showConfirm` function
- `showPrompt` function
### Changed
- `renderRecent` function modified
- `playVideo` function modified
- `subSrc` renamed to `subtitleSrc`
- `subType` renamed to `subtitleType`
- `subFile` renamed to `subtitleFile`
- `README.md` updated
- `service-worker.js` modified
- Update bug fixed
## [0.9] - 2026-04-21
### Added
- Video download button
- Subtitle download button
- `getRecent` function
- `setRecent` function
- `getWatchTime` function
- `setWatchTime` function
### Changed
- `README.md` updated
- `service-worker.js` modified
- `playVideo` function modified
## [0.8] - 2026-03-26
### Added
- Watch later button
### Changed
- `README.md` updated
- Recent plays history size changed to 30
- Offline-first bug fixed
## [0.7] - 2026-02-23
### Added
- PWA setup
- Export file name dialog
### Changed
- `Recently Played` section text selection disabled
- Import button bug fixed
## [0.6] - 2026-01-06
### Added
- `CODE_OF_CONDUCT.md`
- Skip button
- Export button
- Import button
### Changed
- `README.md` updated
- `404.html` links bug fixed
- Window resizing bug fixed
- Recent plays history size changed to 25
## [0.5] - 2025-12-17
### Added
- Watch time
- Remove confirmation dialog
### Changed
- Recent plays history size changed to 20
- `renderRecent` function updated
- `README.md` updated
## [0.4] - 2025-12-02
### Added
- [Statcounter](https://statcounter.com/) script
- Video progress background
- `Completed Video` sign
- `Remove` button
### Changed
- Reloading bug fixed
- `saveRecent` function bug fixed
- Video form scroll bug fixed
## [0.3] - 2025-11-17
### Added
- 404 page
- Query string loader for video and subtitle parameters
- `sitemap.xml`
- `robots.txt`
- `SECURITY.md`
### Changed
- `README.md` updated
- Logo updated
- Title updated
- Video load hover bug fixed
- Subtitle load hover bug fixed
## [0.2] - 2025-10-31
### Added
- Video resume support
### Changed
- `Recently Played` section size bug fixed
- `saveRecent` function bug fixed
- Reloading bug fixed
## [0.1] - 2025-10-18
### Added
- Load video from file
- Load video from URL
- Load subtitle from file
- Load subtitle from URL


[Unreleased]: https://github.com/sepandhaghighi/neovid/compare/v1.5...main
[1.5]: https://github.com/sepandhaghighi/neovid/compare/v1.4...v1.5
[1.4]: https://github.com/sepandhaghighi/neovid/compare/v1.3...v1.4
[1.3]: https://github.com/sepandhaghighi/neovid/compare/v1.2...v1.3
[1.2]: https://github.com/sepandhaghighi/neovid/compare/v1.1...v1.2
[1.1]: https://github.com/sepandhaghighi/neovid/compare/v1.0...v1.1
[1.0]: https://github.com/sepandhaghighi/neovid/compare/v0.9...v1.0
[0.9]: https://github.com/sepandhaghighi/neovid/compare/v0.8...v0.9
[0.8]: https://github.com/sepandhaghighi/neovid/compare/v0.7...v0.8
[0.7]: https://github.com/sepandhaghighi/neovid/compare/v0.6...v0.7
[0.6]: https://github.com/sepandhaghighi/neovid/compare/v0.5...v0.6
[0.5]: https://github.com/sepandhaghighi/neovid/compare/v0.4...v0.5
[0.4]: https://github.com/sepandhaghighi/neovid/compare/v0.3...v0.4
[0.3]: https://github.com/sepandhaghighi/neovid/compare/v0.2...v0.3
[0.2]: https://github.com/sepandhaghighi/neovid/compare/v0.1...v0.2
[0.1]: https://github.com/sepandhaghighi/neovid/compare/157a4dd...v0.1
