# FFmpeg export render engine

Framework-agnostic export pipeline used by
`../components/FfmpegRender.tsx`.

- `render-engine.ts` — the pure pipeline: frame planning, the capture loop,
  MP4/GIF ffmpeg arguments, cancellation and temporary-file cleanup. It has no
  DOM or `html2canvas-pro` imports of its own; all browser interaction is
  injected through the `RenderPlatform` interface.
- `browser-platform.ts` — the real browser implementation of `RenderPlatform`
  (canvas, `html2canvas-pro`, fonts, animation frames).
- `render-engine.test.ts` — dependency-free tests run with Node's built-in
  test runner. The FFmpeg virtual filesystem and every browser API are faked
  in-process, so the tests need no network, no WASM download and no media.

## Run the tests

Requires Node ≥ 22.6 (native TypeScript type stripping). No install step and
no third-party test framework are needed:

```sh
node --test components/video-editor/export-modal/lib/render-engine.test.ts
```

## What the tests pin down

- **Empty timeline** — `totalDuration <= 0` (or non-finite) and a zero frame
  count fail with `EmptyTimelineError` before any frame file is written and
  before `ffmpeg.exec` is ever called, leaving a retryable state.
- **Cancellation** — aborting before start, mid-capture and between the GIF
  palette and encode steps stops the loop/encoder and removes every temporary
  file (frames + `palette.png` + output).
- **GIF frame-rate alignment** — the GIF branch caps the frame rate at 10fps
  and derives the captured frame count, the `-framerate` input and the `fps=`
  filters from that same reduced rate, so frame count and rate never disagree.
  Successful and failed GIF runs both clean up frame and palette files.
- **MP4 compatibility** — the quality/speed (`preset`/`crf`) and resolution
  mappings, and the exact ffmpeg argument order, are unchanged.
