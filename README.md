<div align="center">
    <img src="https://github.com/sepandhaghighi/neovid/raw/main/assets/logo.png" alt="Neovid Logo" width="300">
    <h1>🎬 Neovid: Minimal Web Video Player</h1>
    <br/>
    <a href="https://neovid.top"><img src="https://img.shields.io/badge/demo-neovid.top-green.svg"></a>
    <a href="https://github.com/sepandhaghighi/neovid"><img alt="GitHub repo size" src="https://img.shields.io/github/repo-size/sepandhaghighi/neovid"></a>
    <a href="https://github.com/sepandhaghighi/neovid"><img src="https://img.shields.io/github/stars/sepandhaghighi/neovid.svg?style=social&label=Stars"></a>
</div>

## Overview

**Neovid** is a minimal web-based video player designed to be simple, fast, and mobile-friendly.  
It supports both online and local video playback with optional subtitles.

🌐 **Live Demo:** [https://neovid.top](https://neovid.top)

<table>
	<tr> 
		<td align="center">Code Quality</td>
		<td align="center"><a href="https://www.codefactor.io/repository/github/sepandhaghighi/neovid"><img src="https://www.codefactor.io/repository/github/sepandhaghighi/neovid/badge" alt="CodeFactor"></a></td>
		<td align="center"><a href="https://app.codacy.com/gh/sepandhaghighi/neovid/dashboard?utm_source=gh&utm_medium=referral&utm_content=&utm_campaign=Badge_grade"><img src="https://app.codacy.com/project/badge/Grade/203287198d2a482a9154002565e44cc8"></a></td>
	</tr>
</table>

## Features

- **Mobile responsive** design  
- **Play video from URL or local file**  
- **Subtitle support**  
- **Recent plays history** (tracks last 30 videos)  
- **Progress tracking**: remembers last watched percentage per video
- **Query string loader**: automatically loads video and subtitle URLs from `video=` and `subtitle=` parameters
- **Watch time**: tracks total time spent watching videos
- **Export recent history**: download your recent plays data as a JSON file  
- **Import recent history**: restore or replace recent plays data from a previously exported file
- **Direct download buttons**: download video and subtitle files from URL sources

## Usage

### Play a Video
1. In the **Video** section, choose how you want to load your video:
   - **URL** → Paste a direct video link (e.g., `.mp4`, `.webm`)
   - **Local File** → Select a video file from your device
2. In the **Subtitle** section, choose how to load subtitles (optional):
   - **URL** → Enter a `.vtt` or `.srt` subtitle link
   - **Local File** → Select a subtitle file from your device
3. Click **Play Video**

### Recent Plays
- Neovid automatically saves the **last 30 videos** and your **view progress**
- Data is stored locally in your browser (no server involved)
- You can **export** your recent plays to a file for backup or transfer
- You can **import** a previously exported file to restore your recent plays

## Keyboard Shortcuts

The following keyboard shortcuts are available on desktop browsers:

| Action | Shortcut |
| ------- | -------- |
| Play / Pause | <kbd>Space</kbd> |
| Rewind 10 seconds | <kbd>←</kbd> |
| Forward 10 seconds | <kbd>→</kbd> |
| Volume Up | <kbd>↑</kbd> |
| Volume Down | <kbd>↓</kbd> |
| Mute / Unmute | <kbd>M</kbd> |
| Fullscreen | <kbd>F</kbd> |
| Picture-in-Picture | <kbd>P</kbd> |
| Jump to End | <kbd>End</kbd> |

> [!NOTE]
> Keyboard shortcuts are disabled while typing in an input field or interacting with a dropdown menu.

## Local Development

To test Neovid locally, you can use [Ghps](https://github.com/sepandhaghighi/ghps) a minimal GitHub Pages simulator written in pure Python.

Install Ghps:

```console
pip install "ghps>=0.8"
```

Run:

```console
ghps
```

Then open your browser and visit:

```console
http://localhost:5005
```

## Automated Tests

The list/player state logic lives in the DOM-free [`core.js`](core.js) module and is covered by an automated test suite using the [Node.js built-in test runner](https://nodejs.org/api/test.html) — **no `npm install` or third-party dependency is required** (Node.js 18+).

Run the suite from the project root with either:

```console
npm test
```

or directly:

```console
node --test tests/core.test.js tests/dom.integration.test.js
```

There are two suites:

- `tests/core.test.js` — unit tests for the DOM-free state module (entry identity, playback tokens, import validation/rollback, completion threshold, legacy migration).
- `tests/dom.integration.test.js` — loads the real `script.js` inside a sandbox with lightweight DOM/localStorage/`<video>` stubs and drives the same events the browser fires, verifying the page wiring end to end.

Both suites cover the four key scenarios plus supporting guarantees:

| Scenario | What is verified |
| -------- | ---------------- |
| Normal import | Imported list, progress percentages, completion mark (≥ 97%) and resume position all come from the backup; files with more than 30 entries keep the first 30 in export order; importing while a video plays detaches the player so no late event writes to replaced entries |
| Invalid import rollback | Invalid JSON, non-array payloads and illegal fields (out-of-range `progress`, bad `videoType`/`subtitleType`, wrong field types) show an error and leave the existing list byte-for-byte unchanged — no partial writes |
| Delete current entry | Playback continues but progress writes stop immediately; replaying the same video creates a brand new entry starting at 0% |
| Rapid video switching | Late `timeupdate` events carrying an old playback token (or arriving before the new media's `loadstart`) are rejected, so the old video can never overwrite the new video's progress |

### Manual verification in the browser

With the local server running (`ghps`, then `http://localhost:5005`):

1. **Import** — play a video to build a list, use **Export**, edit the JSON (or craft an invalid one), then **Import**:
   - Valid file: the list, progress bars, ✓ completion marks and **Resume Last** immediately reflect the imported data.
   - Invalid file (broken JSON / `progress: 150` / `videoType: "disk"`): an error alert appears and the original list is untouched.
   - Start a video playing, then import a backup: the player keeps playing, but the imported list never receives progress from the old video.
2. **Delete current** — while a video plays, remove its entry via the trash icon. The video keeps playing; reopen DevTools → Application → Local Storage and confirm `recentVideos` no longer changes as it plays. Play the same URL again: it appears as a new entry at `0%`.
3. **Fast switching** — start video A, then immediately start video B (and C). Only the currently loaded video's entry accumulates progress; A and B keep their earlier values.
4. **Export** — after the steps above, **Export** again and confirm the downloaded JSON exactly matches the visible list (order, ids, progress).

## Dependencies

- [SweetAlert2](https://sweetalert2.github.io/) v11.26.24
- [Font Awesome](https://fontawesome.com/) v7.2.0

## Issues & Bug Reports

Just fill an issue and describe it. We'll check it ASAP! or send an email to [info@neovid.top](mailto:info@neovid.top "info@neovid.top"). 

- Please complete the issue template