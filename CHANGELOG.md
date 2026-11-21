# Changelog

All notable changes to this project will be documented in this file.

This project adheres to [Semantic Versioning](https://semver.org) and follows the [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format.

---

## [1.4.0] - 2026-09-07

### Added

- **Consent Gate**: Optional opt-in component that pauses YouTube and Vimeo script loads until consent is granted. Supports an internal overlay with Web Storage (purposes, third-country notice, and a link to the provider's privacy policy), a settings-menu revoke control, or an external cookie manager via `consent.setHandler()`.
- **Dash**: enables full v5 support (4.7.x also still supported)

### Changed

- **Dependencies**: Updated development dependencies, as well as Hls.js and Dash.js to their latest versions

### Fixed

- **Dash**: Quality menu used dash.js 5's portal-filtered representation list, so automatic quality switches after a resize could miss the menu and throw in `Menu.setIndex`
- **CSS**: some smaller CSS fixes
- **Docs**: added some missing docs

## [1.3.0] - 2025-12-19

### Added

- **Multi-Engine Architecture**: New pluggable engine system with capability-based selection and runtime switching. Engines can be registered and dynamically selected based on media type and capabilities.
- **Engine API**: New player methods `addEngine()`, `removeEngine()`, `getEngine()`, `setEngine()`, and `canPlay()` for managing media engines.
- **Engine Events**: New events `player/engine/set` and `player/engine/switched` for tracking engine changes.
- **Engine Docs**: New `docs/guides/Engines.md` covering multi-engine usage, capabilities, suspend/resume, events, and namespaced APIs.
- **YouTube Provider**: Built-in engine for YouTube video playback with full player UI integration.
- **Vimeo Provider**: Built-in engine for Vimeo video playback with full player UI integration.
- **Capability-aware Components**: The following components now support the engine capability system, and update themselves on engine switches: `Play`, `PlayOverlay`, `PlaybackRate`, `Loop`, `PictureInPicture`, `Time`, `Title`, `Keyboard`, `Scrubber`, `Subtitles`, `AudioChain`, `AudioControls`, `VideoControls` and `AnalyserVideo`.
- **Data update-aware components**: the following components are reacting to the new `data/update`event: `Chapters`, `Title` and the new `SubtitlesUi`
- **State Preservation**: Player state (playback position, paused state, volume, muted state, picture-in-picture) is now preserved (if possible) when switching between media items in playlists.
- **Data API**: New `data.updateMediaData` API allows for partial media data updates.
- **Media Session Component**: This new component uses the Media Session API for better support for system media controls, including artwork and playlist support.
- **UI Wake Lock**: Optional Screen Wake Lock integration to keep the display on while playing and release it on pause/end/errors or when the tab is hidden.
- **Orientation Lock**: A new option for the Fullscreen Conmponent that controls the screen orientation when entering FS mode.
- **Script Loader Utility**: New centralized `scriptLoader` utility for loading external JavaScript libraries (Dash.js, Hls.js, ChromeCast API) with deduplication, cancellation support, and improved error handling.
- **SubtitleUi**: New component which provides subtitle settings independently from the Subtitles component.
- **Demo Page**: New demo examples for YouTube and Vimeo providers.
- **Notifications**: New "Warning" display state supported.
- **Automatic Workspace Folders**: Direct source editing in chrome support via `vite-plugin-devtools-json`.

### Changed

- **ChromeCast Refactoring**: Completely refactored ChromeCast component to work as a media engine with improved state management, better error handling, and unified API integration. In addition, ChromeCCast now also works in secure mode.
- **Media Component**: Refactored to work as the default `video` engine with capability-based registration.
- **Data Component**: `data.setMediaIndex` now preserves current media state when options are omitted.
- **Subtitles Component**: Simplified subtitles component by removing internal menu system.
- **Streaming Plugins**: Dash.js and Hls.js plugins now use the centralized script loader utility for more reliable library loading with deduplication.
- **Playlist Navigation**: Playlist now preserves player state (playback position, paused state, volume, muted) when switching between media items.
- **API Namespace**: Engine-specific APIs now use namespace prefix format (e.g., `video:media.load`, `chromecast:media.play`) to support multiple engines.
- **Locale Error Messages**: Updated error messages for library loading failures to use dynamic library names and improved messaging.
- **Enhanced Locale Messages**: Changed locale strings for script loader errors and Picture-in-Picture browser restrictions in all supported languages.
- **CSS Library**: Updated CSS with various improvements and fixes.
- **JSDoc Formatting**: Cleaned up JSDoc formatting across the codebase.
- **JSDoc Configuration**: Updated to version 1.3.0, added canonical URL and sitemap configuration for better SEO.
- **Know Issues Page**: Moved the "Known Issues" Section in the readme to a dedicated page.
- **Dependencies**: Updated development dependencies.

### Fixed

- **Script Loading**: Fixed duplicate script loading issues when multiple player instances or components request the same external library.
- **State Management**: Fixed state not being preserved correctly when switching between different media types (native video, YouTube, Vimeo, etc.).
- **ChromeCast State**: Fixed ChromeCast state synchronization issues and improved connection handling.
- **Picture-in-Picture**: Improved Picture-in-Picture support detection and error handling, especially for iframe-embedded videos.
- **Playlist State**: Fixed playlist not preserving playback state when navigating between items.
- **Subtitles Rendering**: Improved subtitle rendering when switching between engines.
- **domSmithInputRange**: Touch interactions now properly respect the `disabled` state.
- **Mobile UI**: Fixed problem where media would play on first touch inadvertently.

## [1.2.3] - 2025-11-09

### Added

- Overlays: there are new options to control when overlays are shown, by the new `show` property in the overlay item media data.
  - `always` (default): Overlay is always shown
  - `start`: Overlay is shown at the start of the media (playback has to be paused as well)
  - `end`: Overlay is shown at the end of the media (playback has to be paused as well)
  - `play`: Overlay is shown when the media is playing
  - `paused`: Overlay is shown when the media is paused
- Note that when `cueIn` or `cueOut` are specified, the `show` property is overridden.

### Changed

- Overlays: when applying `scale` to images, those are now rendered as regular images (using `object-size`) instead of background images
- Updated dev dependencies

### Fixed

- Playlist: fixed error when overlays where present, but none of them was a poster image

## [1.2.2] - 2025-10-29

### Fixed

- `window.requestIdleCallback()` now should be cancelled correctly.

## [1.2.1] - 2025-10-29

### Added

- The player can now be initialized only if it is actually visible in the viewport (using Intersection Observer on the target element). Use the config `player.initOnIntersection` and set it to `true` (or specify a specific observer config) to enable this feature. This is especially useful if you have several players below the fold and want to avoid impact on page load.
- In addition, the player initialization can also be deferred using the new `player.initOnIdle` config option. In this case, the player will be initialized using the `window.requestIdleCallback()` method (not available in Safari, using rAF fallback in this case).
- Both methods can also be combined. In this case, the first trigger "wins", and the player will be initialized only once.

### Fixed

- Some minor typos in the docs

## [1.2.0] – 2025-10-26

### Added

- Playlist: prev / next icons will be greyed out when navigation is not possible (i.e. last segment is reached)
- UI: new API `ui.resize` (which forces recalculating player width and height)
- Overlays: added type `html` for HTML-based overlays
- Overlays: added option `sanitizeHTML` to prevent XSS attacks from unsafe HTML (enabled by default and enforced in the secure build). This (severely) limits the allowed HTML.
- Demo: added link on the logo to the new visionplayer.io microsite
- Added new default iconset
- Added options in the UI component to change the iconset back to the filled version

### Changed

- Updated dev dependencies
- More CSS resets to make player more resilient to outside CSS
- Updated screenshot in README.md

### Fixed

- When UI autohide is enabled, the UI no longer reappears immediately when a popup was open at the time of hiding
- Prevent default event handling in the keyboard component when an action is detected, so it does not interfere with scrolling etc.
- Thumbnail positioning should now also work when using non pixel units for scrubber width
- UI scale should now honor the respective player config setting
- Additional minor CSS fixes
- Fixed docs in Media.md and Media.js
- Fixed links to docs in demo
- Removed broken link in HLS demo
- Additional fixes in demo

## [1.1.1] – 2025-10-15

### Fixed

- Playlist title now retained when switching player language
- Thumbnail positioning in scrubber should be properly centered now
- Thumbnail positioning fixed when switching playlist media
- Small typo in English translation
- Fixed JSDocs in ScrubberTooltip.js

### Changed

- Changed demo data for updated trailer

## [1.1.0] – 2025-10-06

### Added

- New API: `fullscreen.enter()` and `fullscreen.leave()`

### Fixed

- Mobile menu in the demo has improved scrollbar handling
- Improved scroll locking for iOS devices when using the mobile menu

### Changed

- Updated dev dependencies

## [1.0.1] – 2025-08-07

### Fixed

- Removed dead code in DomSmith
- Fixed docs in srtParser

### Changed

- Updated dev dependencies

---

## [1.0.0] – 2025-07-06

### Added

- This marks the first release of **VisionPlayer**
- **Fully modular architecture** — Components can be easily added, removed, or replaced without modifying the core, with nearly 50 components already provided.
- **Native HTML5 video support** — Plays MP4, WebM, and other browser-supported formats.
- **Multi-language and multi-quality stream selection** — Each stream can offer multiple languages, resolutions, and encodings. Quality can be automatically selected depending on screen resolution.
- **Streaming support** — DASH and HLS support, both VOD and Live Streaming, fully integrated into the player UI including subtitles, audio and quality selection.
- **FairPlay, Widevine, and PlayReady DRM** — Encrypted media playback for premium content.
- **Chromecast and AirPlay** — External device playback handling with full UI synchronization.
- **Playback Controls** — Play/pause, scrubber, volume, playback rate, fullscreen, loop and more.
- **Playlist Management** — Seamless navigation between multiple media items, with optional shuffle and loop modes.
- **Subtitle support** — WebVTT rendering with support for positioning, all writing modes and built in HTML sanitiser, TTML (IMSC1/EBU-TT-D) handling, and native `<track>` integration for iOS compatibility.
- **Dynamic Overlays** — Posters, images and other content at defined cue points.
- **Thumbnails** — Display thumbnails in the scrubber tooltip or use them for a special scrubbing mode.
- **Chapters** — Display Chapters in the controller or scrubber tooltip.
- **Picture-in-Picture** — Play video in a separate overlay window.
- **Picture and Audio Ccontrols** — Adjust video brightness, contrast, and more, or fine-tune your audio with a multiband equalizer.
- **Advanced Accessibility** — Comprehensive accessibility features including Picture & Audio Controls for visual/auditory impairments, keyboard navigation, and screen reader support.
- **Local playback** — Play local media by selecting or dragging and dropping files.
- **Audio and Video Visualizations** — Including bar visualizer, ambient light effects, and waveform displays.
- **Extensive Media Data Format** — With support for extensible metadata and multiple media variants, representations, and encodings.
- **Extended Localization** — Builds includes the following out‑of‑the‑box UI translations: English, German, Spanish, Portuguese, French, Italian, Russian, Chinese (Simplified), Japanese, Korean, Hindi, Arabic & Turkish.
- **Scalable, responsive UI** — UI intelligently adapts to every player size, UI scale factor is dynamically changeable by the user.
- **Theme support** — Built-in dark and light modes, with CSS custom properties for full theming flexibility.
- **Easy Embedding** — Supports converting existing video tags and any other elements with `data-vip` attributes, optionally with autoloading.
- **Minimal global footprint** — Only one exported class (`VisionPlayer`), with everything else modular and encapsulated.
- **Single, zero dependency bundle File** — VisionPlayer bundles all code, styles, SVG assets and language files into a zero-dependency single build artifact – making integration seamless.
- **Optimized Performance** — GPU-accelerated transitions, minimal reflows, and efficient DOM updates.
- **Security Features** — Optional Secure Mode with Shadow DOM, API protection and XSS prevention.
- **1-Minute Setup** — Get from `npm install` to working demo in under 60 seconds with vite dev server.
