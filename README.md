# PlayCanvas Texture Tool

[![Github Release](https://img.shields.io/github/v/release/playcanvas/texture-tool)](https://github.com/playcanvas/texture-tool/releases)
[![License](https://img.shields.io/github/license/playcanvas/texture-tool)](https://github.com/playcanvas/texture-tool/blob/main/LICENSE)
[![Discord](https://img.shields.io/badge/Discord-5865F2?style=flat&logo=discord&logoColor=white&color=black)](https://discord.gg/RSaMRzg)
[![Reddit](https://img.shields.io/badge/Reddit-FF4500?style=flat&logo=reddit&logoColor=white&color=black)](https://www.reddit.com/r/PlayCanvas)
[![X](https://img.shields.io/badge/X-000000?style=flat&logo=x&logoColor=white&color=black)](https://x.com/intent/follow?screen_name=playcanvas)

| [User Manual](https://developer.playcanvas.com) | [API Reference](https://api.playcanvas.com) | [Blog](https://blog.playcanvas.com) | [Forum](https://forum.playcanvas.com) |

The PlayCanvas Texture Tool is a browser-based utility for inspecting, visualizing, and reprojecting textures and environment maps.

You can find a live version at:

https://playcanvas.com/texture-tool

## Features

- **Texture Inspection** - View texture dimensions, pixel format, structure (2D/cubemap), and encoding
- **Mipmap Visualization** - Browse individual mipmap levels
- **Cubemap Face Navigation** - View and inspect individual cubemap faces
- **Alpha Channel** - Toggle alpha channel visualization with checkerboard background
- **Filtering Toggle** - Switch between linear and nearest filtering
- **Reprojection** - Convert between equirectangular and cubemap projections
- **Export** - Save textures as PNG, WebP (lossless), or HDR files

## Supported Formats

The texture tool can load the following texture formats:

| Format | Extension       |
| ------ | --------------- |
| PNG    | `.png`          |
| JPEG   | `.jpg`, `.jpeg` |
| WebP   | `.webp`         |
| HDR    | `.hdr`          |
| DDS    | `.dds`          |
| KTX    | `.ktx`, `.ktx2` |
| Basis  | `.basis`        |
| PVR    | `.pvr`          |

## Viewing Textures

Drag and drop texture files directly into the tool to load them. Multiple textures can be loaded and inspected simultaneously using the file browser panel.

### Supported URL Parameters

Some URL query parameters are available to control the texture tool:

| Parameter | Description                                                 | Example                                                                                |
| --------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| `load`    | Specify URL to a texture to load                            | [?load=URL](https://playcanvas.com/texture-tool/?load=https://example.com/texture.png) |
| `type`    | Override the view type (gamma, linear, rgbm, rgbe, rgbp, a) | `?type=gamma`                                                                          |

## How to build

Ensure you have [Node.js](https://nodejs.org) installed (v22.0+). Then, from a command prompt, run:

```
npm install
npm run build
```

This will invoke Rollup and output the built tool to the `dist` folder. To invoke Rollup with the `--watch` flag (which rebuilds the tool on saving any source file), do:

```
npm run build:watch
```

## How to run

Run:

    npm run serve

Open a browser and navigate to http://localhost:3000.

## Development

Run:

    npm run develop

Open a browser and navigate to http://localhost:3000.

## Browser export tests

The export chain (pixel readback → encode → download) is covered by a browser
test suite that runs against a real build in headless Chrome/Edge. It generates
its own 2x2 PNG fixtures (`test/fixtures`), so no external assets are required.

```
npm test
```

This generates fixtures, builds the app and the test bundle, then runs:

- `test/browser-tests.js` — loads the real export panel and PNG/WebP
  exporters into a page and verifies:
    - a normal export downloads a file named after the selected texture (PNG
      and WebP);
    - switching the selected texture mid-export does not retarget, un-busy or
      re-enable the in-flight export;
    - repeated clicks while busy are ignored and produce a single export;
    - the PNG and WebP exporters reject a second concurrent run with an error
      (both promises settle) and accept work afterwards;
    - an encoding failure restores the button text/busy style and allows a
      retry;
    - the PNG worker rejects on worker/encode errors and recovers by
      replacing the worker;
    - a failed or half-initialized WebP wasm module is never cached and is
      retried by the next export;
    - removing or unloading a texture mid-export ends the export with an
      error instead of downloading pixels;
    - cubemap faces are encoded before any file is downloaded, so a failure
      never leaves a partial set;
    - each format exporter can run independently.
- `test/run-app-smoke.mjs` — loads the built app with `?load=<fixture>` and
  verifies the real UI still exports the URL-loaded texture.

Both runners look for Chrome/Edge (or Chromium) and exit non-zero if any
assertion fails. Set `CHROME_PATH` (or pass `--browser <path>` to
`run-browser-tests.mjs`) to use a specific binary; set `DEBUG_TEST=1` to print
the browser's console output on failure.

## Library integration testing

The Texture Tool is built on the following open source libraries:

| Library                                                       | Details                           |
| ------------------------------------------------------------- | --------------------------------- |
| [PlayCanvas Engine](https://github.com/playcanvas/engine)     | Texture loading and GPU rendering |
| [Observer](https://github.com/playcanvas/playcanvas-observer) | Data binding                      |
| [PCUI](https://github.com/playcanvas/pcui)                    | Front-end component library       |

To test the integration of these libraries use [npm link](https://docs.npmjs.com/cli/v9/commands/npm-link). Follow these steps:

1. Create a global link from source

    ```sh
    cd <library>
    npm link
    ```

2. Create a link to the global link

    ```sh
    cd texture-tool
    npm link <library>
    ```
