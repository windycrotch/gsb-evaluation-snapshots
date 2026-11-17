---
title: Thumbnail Previews
description: Show timeline thumbnail previews from a WebVTT sprite sheet. Compatible with standard ffmpeg workflows.
---

# Thumbnail Previews

Hovering the timeline shows a thumbnail preview from the video. vue-player reads a [WebVTT](https://developer.mozilla.org/en-US/docs/Web/API/WebVTT_API) file that maps time ranges to image frames — either individual images or a sprite sheet.

## Basic Usage

Pass the URL of a WebVTT file to the `thumbnails` prop:

```vue
<template>
  <VideoPlayer
    src="https://example.com/video.mp4"
    thumbnails="https://example.com/thumbnails.vtt"
  />
</template>
```

## VTT File Format

### Individual Images

Each cue points to a separate image file:

```
WEBVTT

00:00:00.000 --> 00:00:05.000
/thumbnails/frame_000.jpg

00:00:05.000 --> 00:00:10.000
/thumbnails/frame_005.jpg

00:00:10.000 --> 00:00:15.000
/thumbnails/frame_010.jpg
```

### Sprite Sheet (recommended)

All frames packed into a single image, referenced with `#xywh=x,y,w,h` fragments. This is the most efficient approach — one HTTP request for all thumbnails:

```
WEBVTT

00:00:00.000 --> 00:00:05.000
/thumbnails/sprite.jpg#xywh=0,0,160,90

00:00:05.000 --> 00:00:10.000
/thumbnails/sprite.jpg#xywh=160,0,160,90

00:00:10.000 --> 00:00:15.000
/thumbnails/sprite.jpg#xywh=320,0,160,90
```

## Generating Thumbnails with ffmpeg

### Individual frames (one image per 5 seconds)

```sh
ffmpeg -i video.mp4 \
  -vf "fps=1/5,scale=160:90" \
  -q:v 5 \
  thumbnails/frame_%03d.jpg
```

Then generate the VTT manually or with a script.

### Sprite sheet

```sh
mkdir -p thumbnails
ffmpeg -i video.mp4 \
  -vf "fps=1/5,scale=160:90,tile=10x10" \
  -frames:v 1 \
  -update 1 \
  -q:v 5 \
  thumbnails/sprite.jpg
```

The `tile=10x10` filter packs up to 100 frames into a single image in a 10-column grid.

## Relative URLs

Relative paths in the VTT file are resolved relative to the VTT file's own URL, so you can keep the VTT and images in the same directory:

```
WEBVTT

00:00:00.000 --> 00:00:05.000
frame_000.jpg#xywh=0,0,160,90
```

## Failure Handling and Boundaries

The preview degrades predictably when assets or data are imperfect:

- **Cross-origin / unreachable image** — if the VTT parses but a sprite or image request is blocked (for example by CORS), the preview shows an explicit failure hint with an alert icon instead of a blank box. Playback, seeking and the time/chapter tooltip are unaffected.
- **Missing or invalid `xywh` fragment** — non-numeric, negative or zero-sized coordinates never produce a mis-cropped frame. The cue falls back to displaying the whole image.
- **Unreachable, empty or fully invalid VTT** — when the WebVTT file cannot be fetched, returns an empty body, or contains no usable cue, the preview area is hidden entirely. The timeline, seek behaviour and chapter hints keep working.
- **Half-open time intervals** — a hover position landing exactly on a cue's end time matches the *next* cue (`[start, end)` semantics).
- **Out-of-range positions** — positions before the first cue hide the preview; positions past the last cue (including videos whose duration exceeds the thumbnail span) show the nearest valid frame rather than an out-of-range cue.

## ThumbnailCue Type

If you need to parse the VTT manually or generate cues programmatically, use the thumbnail utilities from `@vue-player/core`. `loadThumbnailVtt` also reports the load status, so you can distinguish "not configured" from "failed to load":

```ts
import { findThumbnailCue, loadThumbnailVtt } from '@vue-player/core'

const { status, cues } = await loadThumbnailVtt('https://example.com/thumbnails.vtt')
// status: 'none' | 'loading' | 'ready' | 'error'

if (status === 'ready') {
  const cue = findThumbnailCue(cues, 12.5) // boundary-safe cue lookup
}
```

The legacy `parseThumbnailVtt(url)` helper is retained; it resolves directly to the cue array (empty on any failure).

Each returned cue has the following shape:

```ts
interface ThumbnailCue {
  start: number // cue start time in seconds
  end: number // cue end time in seconds
  url: string // absolute image URL
  x?: number // sprite x offset (px)
  y?: number // sprite y offset (px)
  w?: number // sprite frame width (px)
  h?: number // sprite frame height (px)
}
```
