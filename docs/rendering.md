# Rendering

How `motlab render`, `motlab video` and Export turn scene pages into an MP4, how the encoder is chosen, and what was measured. The screenshot pipeline in the tables captures each frame from Chrome as a JPEG and pipes it to ffmpeg libx264, the way DOM-based video tools capture frames. motlab was built to avoid that step.

## Steps

1. A small static server serves the project folder (the nearest folder above the page with a `project.json`, else the page's folder, or `--root`) on `127.0.0.1`.
2. Chrome starts with `--headless=new --enable-gpu --force_high_performance_gpu --enable-unsafe-swiftshader`. The GPU actually in use is read from `WEBGL_debug_renderer_info` and printed at the start.
3. `src/page/runtime.js` is injected into the page. For each frame it calls `renderAt`, makes a `VideoFrame` from the canvas and feeds it to a `VideoEncoder`.
4. Mediabunny muxes the encoded chunks into an MP4 inside the page, which is POSTed to Node. If that fails, the engine retries with a raw Annex B bitstream.
5. ffmpeg copies the stream (`-c copy`) into the final file. This pass writes BT.709 tags with the encoder's range into the bitstream, joins the parts from parallel mode, adds audio and moves `moov` to the front. It always runs, even after a successful Mediabunny mux, because the encoders tag colour inconsistently (see quirks).
6. ffprobe counts the frames and duration of the final file. The render fails if they do not match.

Temporary files go to the system temp folder and are removed afterwards. The output is written as `.part` and renamed at the end.

The code is plain JavaScript ESM with JSDoc and no TypeScript. Half of it runs inside Chrome and is served straight from disk, so TypeScript would mean two languages or a build step. CDP uses Node's built-in `WebSocket`.

## Encoder choice

The first time a resolution is rendered, the engine times four candidates (H.264 and HEVC, hardware and software) for a few seconds. The result is saved per machine, resolution, fps and worker count in `%LOCALAPPDATA%\motlab\encoder-probe.json` (`~/.cache/motlab` outside Windows, or the folder in `MOTLAB_CACHE_DIR`).

- `auto` picks the fastest encoder that supports constant QP. In current Chrome only the hardware encoders do. If none does, it picks the fastest.
- `hw` picks the fastest hardware encoder.
- `sw` picks a software encoder. It is the fastest option, but Chrome's software H.264 encoder ignores bitrate above a certain quality ceiling, so fine line art at 1080p comes out slightly below a JPEG screenshot pipeline.

H.264 is kept unless HEVC is at least 25% faster.

Why hardware with constant QP is the default and not simply the fastest encoder: on the 2D template at 1080p, software H.264 reached SSIM 0.9945 against 0.9983 for the screenshot pipeline, while hardware at QP 18 (H.264) or 20 (HEVC) was always above it. At 4K the software encoder matches the screenshot pipeline and its timing is steadier, while hardware is sometimes twice as slow. That is the reason to revisit this default later.

## Why canvas and WebCodecs

DOM pages have to be screenshotted before they can be encoded. A canvas can go straight into the encoder. These options were compared and not chosen:

| Option | How it works | Why not |
|---|---|---|
| Remotion | React DOM, screenshot per frame | Heavy, and a paid license for companies of four or more |
| HyperFrames (Apache 2.0) | HTML with data attributes, Puppeteer and FFmpeg | Closest in concept, but capture is still a screenshot |
| Motion Canvas / Revideo (MIT) | Canvas and TypeScript | Its own API, so existing canvas scenes would need rewriting |
| Native (Rust/wgpu, Skia) | No browser | The web preview would no longer match the render, and three.js is lost |

The engine is neutral about style. It only fixes technical things: the page contract, tracks, resolution, fps and encoder. Style and content come from each project's reference folder and the user's direction.

## Measurements

Measured on one Windows laptop (Ryzen 7 5800H, RTX 3060 Laptop, Chrome 157). The 2D and 3D scene templates, 8 seconds at 25 fps (200 frames), total time of one CLI command including Chrome start-up, with the encoder probe already saved. The first probe for a new resolution adds about 5 seconds. SSIM is against 200 lossless PNG frames.

| Case | Screenshot pipeline (JPEG to libx264, GPU drawing) | `auto` (H.264 hardware, QP 18) | `--encoder sw` |
|---|---|---|---|
| 2D 1080p | 6.3 s, SSIM 0.9983 | 5.9 s, SSIM 0.9987 | 2.9 s, SSIM 0.9945 |
| 3D 1080p | 8.3 s, SSIM 0.9984 | 5.6 s, SSIM 0.9992 | 3.3 s, SSIM 0.9989 |
| 2D 4K | 17.5 s, SSIM 0.9989 | 6.9 s or 13.4 s, SSIM 0.9992 | 6.7 s, SSIM 0.9985 |
| 3D 4K | 25.6 s, SSIM 0.9984 | 6.9 s or 13.1 s, SSIM 0.9994 | 6.3 s, SSIM 0.9992 |

An earlier synthetic benchmark (a 2D canvas with a gradient, 160 moving cards and text, frames per second in one Chrome process) shows where the gain comes from. Piping JPEG frames to ffmpeg libx264, as screenshot renderers do, ran at 26 fps at 1080p and 7.9 at 4K. WebCodecs ran at 70 and 17 with `prefer-hardware`, and 105 and 27 with `prefer-software`. The screenshot path is limited by reading frames out of Chrome, not by encoding.

The two 4K `auto` numbers are the two throughput states of the hardware encoder (see quirks). The sample project renders at 4K in about 21 seconds including the first probe, and a 720p export from the viewer takes about 13 seconds.

A 10-minute render at 4K (the benchmark scene below looped for 600 s, 18,000 frames, hardware H.264 at QP 18) took 1,126 s in all, 17.0 fps while encoding, and made a 3.16 GB MP4. Its last seconds decoded cleanly and a frame at 595 s matched a still of the page (SSIM 0.994). Other tests ran on the laptop at the same time, so a quiet machine should be faster. At this QP a busy 4K scene comes to about 5 MB a second. `motlab video --bitrate` makes smaller files; `render` and Export have no such option.

`--workers` only helps when `renderAt` is expensive. It did nothing for the two templates, where drawing is cheap and the encoder is the limit. A test page with 160 shadowed cards went from 14 fps (one process) to 35 fps (two) at 4K. The hardware encoder tops out around 35 fps in total at 4K, however many processes run.

## Against Remotion and HyperFrames

The same scene rendered by three tools on one laptop (Ryzen 7 5800H, RTX 3060 Laptop, Windows 11, on mains power), all three with the same Chrome 157.0.8103.51. The scene is a turning gradient, 160 cards that move, turn, scale and fade with a number on each, a title, a frame counter and a progress bar, at 1920x1080, 30 fps, 10 seconds (300 frames). motlab draws it on a canvas. Remotion 4.0.543 and HyperFrames 0.9.52 render it twice: as HTML elements, which is how they are normally used, and on a canvas with motlab's own drawing code, to tell the drawing apart from the capture.

Time is the whole command as a user runs it (Chrome start-up, Remotion's bundling, muxing), the median of three runs, with motlab's encoder probe already saved. SSIM is the mean over 10 frames against lossless PNG stills of the canvas page. For the HTML versions it also counts the small differences between how HTML and a canvas draw the same shapes, so compare those among themselves. The code is in [bench/](../bench/README.md).

| Tool and setting | Time | fps overall | SSIM | File |
|---|---|---|---|---|
| motlab, `--encoder sw` | 9.5 s | 31.5 | 0.986 | 29.9 MB |
| motlab, default (hardware H.264, QP 18) | 12.6 s | 23.7 | 0.988 | 25.4 MB |
| motlab, `--workers 4` | 12.3 s | 24.4 | 0.989 | 25.7 MB |
| HyperFrames, HTML, `--workers 1` | 27.2 s | 11.0 | 0.966 | 20.5 MB |
| HyperFrames, canvas, default | 27.6 s | 10.9 | 0.987 | 20.3 MB |
| HyperFrames, HTML, default (6 workers) | 30.9 s | 9.7 | 0.965 | 19.6 MB |
| Remotion, HTML, `--concurrency=1` | 30.7 s | 9.8 | 0.948 | 18.5 MB |
| Remotion, canvas, default | 38.7 s | 7.8 | 0.967 | 19.8 MB |
| Remotion, HTML, default | 39.0 s | 7.7 | 0.948 | 18.5 MB |

What it shows, for this scene on this laptop:

- motlab took 9.5 to 12.6 s. The fastest HyperFrames setting took 27.2 s and the fastest Remotion setting 30.7 s, so motlab was 2.2 to 2.9 times faster than HyperFrames and 2.4 to 3.2 times faster than Remotion.
- Giving the other two motlab's canvas drawing did not make them faster (HyperFrames 27.6 s against 27.2 s, Remotion 38.7 s against 39.0 s). The gap comes from taking a screenshot of every frame, not from HTML drawing.
- More parallel workers did not help any of the three. HyperFrames' default of 6 workers was slower than one, and Remotion's default concurrency slower than one. motlab with 4 workers matched one; its first run took 24.9 s because the encoder probe ran again for the new worker count.
- Remotion's lower SSIM comes from its default JPEG frames. Its PNG option was not tried. motlab's files are larger, 25 to 30 MB against 18.5 to 20.5 MB.

At 4K (`SCALE=2 node run.mjs`: motlab `--scale 2`, Remotion `--scale=2`, HyperFrames `--resolution landscape-4k`; all nine files 3840x2160 with 300 frames), on the same laptop with nothing else running:

| Tool and setting | Time | fps overall | SSIM | File |
|---|---|---|---|---|
| motlab, `--workers 4` | 13.1 s | 22.9 | 0.994 | 53.1 MB |
| motlab, `--encoder sw` | 14.8 s | 20.3 | 0.993 | 84.4 MB |
| motlab, default (hardware H.264, QP 18) | 19.4 s | 15.4 | 0.994 | 52.6 MB |
| Remotion, canvas, default | 48.9 s | 6.1 | 0.977 | 33.6 MB |
| HyperFrames, canvas, default | 50.9 s | 5.9 | 0.984 | 38.3 MB |
| Remotion, HTML, `--concurrency=1` | 53.8 s | 5.6 | 0.964 | 42.8 MB |
| HyperFrames, HTML, default (6 workers) | 54.3 s | 5.5 | 0.972 | 46.9 MB |
| Remotion, HTML, default | 61.1 s | 4.9 | 0.964 | 42.8 MB |
| HyperFrames, HTML, `--workers 1` | 71.8 s | 4.2 | 0.972 | 46.9 MB |

- motlab took 13.1 to 19.4 s, and the fastest of the others 48.9 s (Remotion on a canvas) and 53.8 s (Remotion with HTML), so motlab was 2.5 to 3.7 times faster than the fastest of them, and 2.8 to 4.1 times faster with HTML scenes.
- At 4K more workers helped: HyperFrames' 6 workers beat one (54.3 s against 71.8 s), the reverse of 1080p, and motlab's 4 workers beat one. motlab's default runs were 15.3, 20.2 and 19.4 s, the hardware encoder's two speeds again (see quirks); its first run with 4 workers took 23.8 s because the encoder probe ran again.
- Drawing on a canvas made the other two faster at 4K (Remotion 48.9 s against 53.8 s), unlike at 1080p.
- motlab drew on the RTX 3060. Remotion and HyperFrames do not pass `--force_high_performance_gpu`, so their Chrome drew on the integrated Radeon: in one more 1080p run of each canvas setting, the Windows GPU counters showed their Chrome on the Radeon's 3D engine and not on the RTX 3060.

### motlab on the integrated GPU

To compare on the same GPU, motlab ran again on the Radeon (`IGPU=1 node run.mjs`, and `IGPU=1 SCALE=2` for 4K) through [bench/motlab-igpu.mjs](../bench/motlab-igpu.mjs), which leaves out `--force_high_performance_gpu`. motlab's `GPU:` line named the Radeon (ANGLE on Direct3D 11), and in one 1080p run the Windows GPU counters showed its Chrome on the Radeon's 3D engine only. Only motlab was run again; the Remotion and HyperFrames times are the ones above.

| motlab setting | 1080p on the Radeon | 1080p on the RTX 3060 | 4K on the Radeon | 4K on the RTX 3060 |
|---|---|---|---|---|
| `--encoder sw` | 8.0 s (SSIM 0.986, 29.9 MB) | 9.5 s | 13.2 s (0.993, 84.4 MB) | 14.8 s |
| default | 10.3 s (0.988, 25.4 MB) | 12.6 s | 22.5 s (0.993, 40.7 MB) | 19.4 s |
| `--workers 4` | 12.0 s (0.989, 25.6 MB) | 12.3 s | 14.0 s (0.994, 53.1 MB) | 13.1 s |

- On the Radeon motlab took 8.0 to 12.0 s at 1080p, against 27.2 s for HyperFrames and 30.7 s for Remotion at their fastest settings (2.3 to 3.4 and 2.6 to 3.8 times as long). At 4K it took 13.2 to 22.5 s, against 48.9 s for the fastest of the other two (2.2 to 3.7 times as long). The gap is about the same as with motlab on the RTX 3060.
- motlab was not slower on the Radeon. At 1080p every setting was a little faster, and at 4K software encoding was faster (13.2 s against 14.8 s). Why was not measured; one guess is that the frames stay on the GPU that also holds the hardware encoder.
- At 4K the default picked HEVC on the Radeon (the saved probe found it clearly faster there), so that file is HEVC and smaller (40.7 MB). On the RTX 3060 it picked H.264.

### Without a GPU

The same benchmark with Chrome drawing in software (`CPU=1 node run.mjs`, and `CPU=1 SCALE=2` for 4K), on the same laptop with nothing else running. All three use ANGLE on SwiftShader (`--use-gl=angle --use-angle=swiftshader --enable-unsafe-swiftshader`): HyperFrames through `--no-browser-gpu`, Remotion through `--gl=swangle`, and motlab through [bench/motlab-cpu.mjs](../bench/motlab-cpu.mjs), which swaps motlab's GPU flags for these (motlab has no option for it). motlab encodes with `--encoder sw`; Remotion and HyperFrames encode with ffmpeg on the CPU by default. motlab's `GPU:` line named SwiftShader, and in one 1080p run each of motlab, Remotion's canvas and HyperFrames' canvas, the Windows GPU counters showed no GPU work from their Chrome. The GPUs were still in the laptop, so this is software drawing on a laptop CPU, not a measured machine without a GPU. SSIM is against the same stills as above, drawn on the GPU. motlab's SSIM was measured again after the colour range fix below (one run each); the times are from before it, and the fix changes only the tags ffmpeg writes.

At 1080p:

| Tool and setting | Time | fps overall | SSIM | File | With a GPU |
|---|---|---|---|---|---|
| motlab, `--encoder sw --workers 4` | 19.2 s | 15.6 | 0.982 | 30.0 MB | |
| motlab, `--encoder sw` | 27.0 s | 11.1 | 0.983 | 29.9 MB | 9.5 s |
| HyperFrames, canvas, default | 28.3 s | 10.6 | 0.987 | 20.4 MB | 27.6 s |
| HyperFrames, HTML, default (6 workers) | 29.4 s | 10.2 | 0.965 | 20.5 MB | 30.9 s |
| HyperFrames, HTML, `--workers 1` | 30.5 s | 9.8 | 0.965 | 20.5 MB | 27.2 s |
| Remotion, canvas, default | 46.7 s | 6.4 | 0.967 | 21.2 MB | 38.7 s |
| Remotion, HTML, `--concurrency=1` | 50.7 s | 5.9 | 0.948 | 18.6 MB | 30.7 s |
| Remotion, HTML, default | 60.1 s | 5.0 | 0.948 | 18.6 MB | 39.0 s |

At 4K:

| Tool and setting | Time | fps overall | SSIM | File | With a GPU |
|---|---|---|---|---|---|
| HyperFrames, canvas, default | 43.4 s | 6.9 | 0.985 | 36.5 MB | 50.9 s |
| HyperFrames, HTML, default (6 workers) | 50.7 s | 5.9 | 0.972 | 49.0 MB | 54.3 s |
| motlab, `--encoder sw --workers 4` | 60.7 s | 4.9 | 0.991 | 83.9 MB | |
| HyperFrames, HTML, `--workers 1` | 63.2 s | 4.8 | 0.972 | 49.0 MB | 71.8 s |
| motlab, `--encoder sw` | 67.3 s | 4.5 | 0.992 | 84.5 MB | 14.8 s |
| Remotion, canvas, default | 72.4 s | 4.1 | 0.977 | 35.7 MB | 48.9 s |
| Remotion, HTML, `--concurrency=1` | 130.6 s | 2.3 | 0.964 | 42.9 MB | 53.8 s |
| Remotion, HTML, default | 154.2 s | 1.9 | 0.964 | 42.9 MB | 61.1 s |

- motlab lost the most without a GPU. With `--encoder sw` it took 2.8 times as long at 1080p (27.0 s against 9.5 s) and 4.5 times as long at 4K (67.3 s against 14.8 s). Which part slowed down, the drawing in SwiftShader or the software encoder at 4K, was not measured.
- At 1080p motlab was still the fastest: 19.2 s with 4 workers, against 28.3 s for HyperFrames and 46.7 s for Remotion at their fastest settings (1.5 and 2.4 times as long). With one worker it was about as fast as HyperFrames (27.0 s against 28.3 s).
- At 4K HyperFrames was the fastest. Its canvas setting took 43.4 s and its default HTML setting 50.7 s, against motlab's 60.7 s with 4 workers. motlab was still faster than Remotion (72.4 s at its fastest).
- HyperFrames barely changed: 1080p within 1 to 3 s of its GPU times, and at 4K it was faster on SwiftShader than on the integrated Radeon (43.4 s against 50.9 s on a canvas). Remotion took 1.2 to 2.5 times as long, most of all with HTML at 4K.
- The first motlab run of three settings took longer (46.3 s, 88.6 s and 131.5 s) because the encoder probe ran again (see quirks); the medians leave those runs out.

Not measured: macOS, where HyperFrames turns on a capture through `drawElementImage` that its help calls about twice as fast; Linux; Remotion and HyperFrames with the browsers they download themselves; Remotion with PNG frames; scenes heavy on text layout, images or footage; and Remotion's cloud rendering.

## Quirks

- Headless Chrome uses the integrated Radeon GPU by default. `--force_high_performance_gpu` moves it to the RTX 3060. Check with `WEBGL_debug_renderer_info`.
- WebCodecs in headless Chrome supports hardware H.264 and HEVC, but not hardware AV1 or VP9, and not software HEVC.
- WebCodecs does not seem to use NVENC: `nvidia-smi` shows zero encoder sessions during a hardware encode. Chrome probably uses the AMD encoder through Media Foundation, but that is not confirmed.
- The hardware encoder is not always faster. In one process, software is faster at 1080p (about 120 fps against 48) and at 4K (about 40 fps against 17 to 34).
- The hardware encoder has two throughput states. At 4K it runs at about 34 fps or about 17 fps and switches between runs with no code change. H.264 and HEVC are affected together. The cause is unknown, so measure several times before concluding anything about speed.
- The saved encoder probe keeps one machine, named by Chrome, GPU, CPU and platform. A render on another GPU, or on SwiftShader, probes again and replaces the saved results, so switching back and forth probes every time.
- The hardware encoder hangs after a mid-stream `flush()`: the next `encode()` never finishes. Flush only once, at the end.
- Software H.264 ignores bitrate. Targets of 2, 22, 60 or 200 Mbit/s give nearly the same file. `quantizer` mode is not supported for software H.264. `contentHint: 'detail'` raises quality slightly but is slower.
- Hardware H.264 and HEVC support `bitrateMode: 'quantizer'`. QP is passed per frame with `encode(frame, { avc: { quantizer } })`.
- Colour tags in the bitstream are inconsistent: hardware H.264 writes none, hardware HEVC writes `colour_primaries=0`, and software H.264 writes an sRGB transfer. ffmpeg always overwrites the VUI with BT.709 and the encoder's range through `h264_metadata` or `hevc_metadata`.
- The range depends on how Chrome draws. On a GPU, a canvas frame becomes limited range YUV; when Chrome draws in software (SwiftShader, or a CI runner without a GPU) it becomes full range, with both the hardware and the software encoder. The encoder's `decoderConfig.colorSpace.fullRange` says which, and motlab tags the file from it. Before that, software-drawn renders were tagged limited and decoded with shifted colours: `#30E2A8` came back as (41, 243, 179) instead of (48, 226, 168). Found by the CI runs; reproduced on the test laptop with SwiftShader, where the fixed render decodes as (49, 226, 169).
- WebGL needs `--enable-unsafe-swiftshader` to fall back to software where there is no usable GPU: without it a Linux CI runner has no WebGL2, so scene transitions fail. motlab always passes it; with a GPU it changes nothing.
- The encoder config needs a sensible `framerate`. 240 is rejected.
- `shadowBlur` on a 2D canvas is expensive: 160 shadow blurs cap every pipeline at about 32 fps at 1080p.
- `willReadFrequently: true` makes the canvas CPU-backed and nearly halves WebCodecs speed. Do not use it on a render canvas.
- ffmpeg's `sine` source is very quiet (amplitude 1/8). Check synthetic audio with `volumedetect`.
- The ffmpeg build used for these measurements does not support `-pattern_type glob`. Use numbered patterns or make contact sheets from the video.
