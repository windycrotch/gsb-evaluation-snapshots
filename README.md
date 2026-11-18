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

### Reopening local files from Recent Plays

Local videos and subtitles use temporary `blob:` URLs that do not survive a
page reload. When you click a local entry in **Recent Plays**:

- If your browser supports the [File System Access API](https://developer.mozilla.org/docs/Web/API/File_System_Access_API),
  Neovid reopens the file through the handle stored in IndexedDB (you may be
  asked for permission once) and resumes from the saved progress.
- Otherwise (or when the stored handle is missing/denied/stale), you are guided
  to re-pick the file(s); playback then resumes with the original progress and
  subtitle instead of only showing a warning.

Handles are kept in IndexedDB, never in `localStorage`, and are never written
into exported JSON files.

### Automated tests

The pure recent-store logic is covered by dependency-free tests run with the
Node.js built-in test runner (Node 18+):

```console
npm test
# or, without npm:
node --test tests/**/*.test.js
```

The suite covers local-entry reselect and progress restoration, the manual
re-pick fallback when no handle is available, import tolerance for local
entries (other records are preserved), and export output that contains no
handle fields. A hand-checkable import sample lives in
`tests/fixtures/sample-import.json`.

## Dependencies

- [SweetAlert2](https://sweetalert2.github.io/) v11.26.24
- [Font Awesome](https://fontawesome.com/) v7.2.0

## Issues & Bug Reports

Just fill an issue and describe it. We'll check it ASAP! or send an email to [info@neovid.top](mailto:info@neovid.top "info@neovid.top"). 

- Please complete the issue template