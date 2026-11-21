# Benchmark

One scene rendered by motlab, Remotion and HyperFrames on the same machine. The results and what they leave out are in [docs/rendering.md](../docs/rendering.md#against-remotion-and-hyperframes).

The scene is in `shared.js`: a turning gradient, 160 cards that move, turn, scale and fade with a number on each, a title, a frame counter and a progress bar, at 1920x1080, 30 fps, 10 seconds. Every value is a function of time. `drawCanvas` draws it on a 2D canvas, and `dom` with `applyDom` build and move the same thing as HTML elements.

| Folder | What renders it |
|---|---|
| `motlab/canvas.html` | motlab, the canvas |
| `remotion/src/Root.jsx` | Remotion, composition `Dom` (HTML elements) and `Canvas` (the canvas code) |
| `hyperframes/dom`, `hyperframes/canvas` | HyperFrames, HTML elements and the canvas code, each moved from a GSAP timeline |

## Running it

You need what motlab needs (Node 24, Chrome, ffmpeg). Remotion and HyperFrames are installed in this folder only, at the versions that were measured:

```bash
cd bench
npm ci
node run.mjs
```

It runs every setting three times, one after another, and prints a table and `results.json`: the median wall time of the whole command, frames per second over that time, the file size, and SSIM of 10 frames against lossless PNG stills of the canvas page. All three tools use the Chrome that motlab finds (or `CHROME`), and Remotion's and HyperFrames' telemetry is turned off. `RUNS=1` runs each once, `ONLY=motlab-sw,hf-dom` picks settings by name, and `SCALE=2` renders at 4K into `results-4k.json`. `CPU=1` runs the settings with Chrome drawing in software (SwiftShader) and CPU encoders only, into `results-cpu.json` (or `results-cpu-4k.json` with `SCALE=2`); motlab runs through `motlab-cpu.mjs` for that, which gives it the same Chrome flags as HyperFrames' `--no-browser-gpu`. `IGPU=1` runs only the motlab settings, through `motlab-igpu.mjs` without `--force_high_performance_gpu`, so that on a laptop with two GPUs it draws on the integrated one, as Remotion and HyperFrames do (`results-igpu.json`, `results-igpu-4k.json`).

`npm ci` downloads these tools under their own licences, which motlab's MIT licence does not cover. Remotion's is not an open source licence: it is free for individuals, companies of up to 3 employees, non-profits and for evaluating it, and other companies need a paid company licence ([its licence](https://github.com/remotion-dev/remotion/blob/main/LICENSE.md)). HyperFrames is Apache-2.0, and GSAP has its own free licence from Webflow. If you run it on behalf of a company, check Remotion's terms first.

Close other programs first, and run motlab once before timing so its encoder probe is saved. The first run with a new `--workers` count probes again and is slower.
