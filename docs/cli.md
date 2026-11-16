# Command line

```text
motlab render <project> [out.mp4] [--scale 2]     all scenes and audio in project.json, as one MP4
motlab start                                      the viewer in the background at http://127.0.0.1:4173, one for all projects
motlab edit   [project]                           open a project in the viewer, starting it first if needed
motlab stop | restart                             end the viewer, or start it again from the same folder
motlab stills <page.html> <outDir> <t1> <t2> ...  single frames as PNG or JPEG
motlab video  <page.html> <out.mp4> [options]     one page as an MP4
motlab events <page.html> <out.json>              the page's EVENTS, for syncing sound
motlab doctor                                     check Node, Chrome, ffmpeg and the skill's Python packages
motlab update [--dry-run]                         the newest motlab from GitHub, and the skills copied again where they were installed
motlab uninstall [--dry-run] [--yes]              remove the command, the skills, ~/.motlab and the encoder cache
```

The viewer commands are described in [the viewer](viewer.md), `motlab update` in [Updating](install.md#updating) and `motlab uninstall` in [Removing](install.md#removing).

`<project>` is a folder with `project.json`, or a project file in it such as `video/project-tiktok.json` (a [version](projects.md#versions)). `motlab --help` prints the same list and the engine folder.

## Single pages

```bash
motlab stills page.html outDir 0.5 2 4.25
motlab video page.html out.mp4 --fps 25 --scale 2
motlab events page.html events.json
```

`stills` writes files named after the time with two decimals, for example `0.50.png`, `2.00.png` and `4.25.png`, or JPEG with `--format jpg`. Its default scale is 1.

`stills`, `events` and `video` serve the nearest folder above the page that has a `project.json`, the same folder the viewer serves, so a scene can load `../` files. A page outside a project is served from its own folder. Pass `--root` to serve another folder.

When the page throws while loading, the error names the file, line and column, for example `SyntaxError: Illegal return statement (/scenes/bad.html:4:1)`.

## Options

`render` takes only `--scale`; the rest are for `video` (and `--root`, `--chrome`, `--scale` and `--format` for `stills`, and `--root` and `--chrome` for `events`).

| Option | Meaning |
|---|---|
| `--fps` | Frames per second, default 24 (`render` takes it from `project.json`) |
| `--scale` | Passed to the page as `?scale=`. 2 turns a 1920x1080 page into 4K. Default 2 for video and render, 1 for stills |
| `--audio` | Audio file to mux in (AAC 320k), cut to the video length |
| `--encoder` | `auto`, `hw` or `sw`, see [encoder choice](rendering.md#encoder-choice) |
| `--codec` | `auto`, `h264` or `hevc`. H.264 is kept unless HEVC is clearly faster |
| `--workers` | Split the frames over this many Chrome processes and join the parts with ffmpeg concat (default 1) |
| `--qp` | Constant QP for encoders that support it (default 18 for H.264, 20 for HEVC; lower is better and larger) |
| `--bitrate` | Use variable bitrate at this many Mbit/s instead of constant QP |
| `--mux` | `auto`, `mediabunny` or `raw`. Auto tries the in-page MP4 muxer, then a raw bitstream wrapped by ffmpeg |
| `--reprobe` | Time the encoders again instead of using the saved timings |
| `--root` | Folder to serve. Default is the nearest folder above the page with a `project.json`, else the page's folder |
| `--chrome` | Path to Chrome. Default: found automatically, or the `CHROME` environment variable |
| `--format` | `png` or `jpg`, for `stills` |

`--gpu` is accepted and ignored, so older commands that pass it keep working. Chrome always runs with `--enable-gpu --force_high_performance_gpu --enable-unsafe-swiftshader`; the last lets WebGL fall back to software where there is no GPU.

## Environment

| Variable | Meaning |
|---|---|
| `CHROME` | Path to Chrome or Chromium |
| `MOTLAB_CACHE_DIR` | Where the encoder timings are saved. Default `%LOCALAPPDATA%\motlab` on Windows, `~/.cache/motlab` elsewhere |

## Page contract

A scene page must have:

- `<canvas id="c">` with even width and height (H.264 and HEVC need them)
- `window.renderAt(t)`, which draws the frame at `t` seconds and may be async
- `window.TOTAL`, the length in seconds
- `window.ready`, a promise that resolves when fonts and assets are loaded

And may have:

- `window.EVENTS`, a list of `{ name, t }` for placing sound effects on beats
- support for `?t=` (show one frame, for opening the page by hand) and `?scale=` (the resolution multiplier)

The frame count is `round(TOTAL * fps)`, and frame `f` is drawn at `t = f / fps`. The page itself is never edited by the renderer: `src/page/runtime.js` is injected and drives it.
