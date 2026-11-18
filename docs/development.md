# Development

## Running

```bash
npm install
npm start
```

## Screenshot harness

Iterating on pixel art through a live always-on-top window is slow. `tools/shots.mjs`
launches the app offscreen, drives it into a given state, captures the page with
`webContents.capturePage()` and exits.

```bash
node tools/shots.mjs idle mood:ecstatic sound:5 fast hero
```

PNGs land in `.shots/` (gitignored) at the window's backing resolution, so they
can be inspected pixel by pixel.

Demo specs are handled by `App.runDemo`:

| Spec | Effect |
| --- | --- |
| `mood:<name>` | Pins the pet's mood and clears the boot message |
| `play` | Plays three notes in sequence |
| `chord` | Holds a three-note chord |
| `fast` | Hammers keys, for stress and the strained/dizzy moods |
| `scale:<n>` / `sound:<n>` | Turns a knob by `n` detents (`pack:` is an alias for `sound:`) |
| `preset:<n>` | Clicks the sound knob `n` times, stepping presets inside the pack |
| `press` | Holds the sound knob down and clicks it, for the pressed-in artwork |
| `audit` | Renders every preset offline and reports its level — see [audio.md](audio.md) |
| `pet` | Pets the creature |
| `hero` | Chord, high affection, no boot message — the README image |

`DESKSYNTH_SHOT_DELAY` (default 1400 ms) controls when the capture happens; the
boot message lasts 2 s, so drop below that only with `mood:` or `hero`, which
clear it. `press` fires its click at 1100 ms, so capture between about 1150 and
1400 ms to catch the shockwave ring before it fades. `audit` needs 25000 ms.

Each run wipes `.shots/` first, so pass every state you want in one invocation if
you're comparing them.

The underlying environment variables work directly too:

```bash
DESKSYNTH_SHOT=/tmp/out.png DESKSYNTH_DEMO=chord npx electron .
```

The README images are harness output: `hero` for `docs/desksynth.png`, a grid of
`pack:<n>` shots for `docs/packs.png`, `mood:<name>` screen crops for
`docs/moods.png`, and `idle` beside `press` for `docs/knob.png`. Captures come out
at the window's backing resolution (6× on a retina display), so downscale by
whole numbers only — a non-integer resize smears the pixels.

## Debugging

Renderer errors and warnings are forwarded to the terminal by a
`console-message` handler in `main.js`, along with `did-fail-load` and
`render-process-gone`. A silent renderer failure shows up as a window that never
appears, because `show()` is wired to `ready-to-show`.

## Gotchas

**`ELECTRON_RUN_AS_NODE`** — if this is set in your shell, `electron .` runs the
binary as plain Node and nothing happens. `tools/shots.mjs` strips it; for
`npm start` you may need `unset ELECTRON_RUN_AS_NODE`.

**Electron binary install** — the `postinstall` step downloads a ~100 MB binary.
If it's skipped or blocked, `npm start` fails with "Electron failed to install
correctly". Fix by deleting `node_modules/electron` and reinstalling, or by
extracting the cached zip from `~/Library/Caches/electron` into
`node_modules/electron/dist` and writing `path.txt`.

**ES modules need the `app://` scheme.** Loading the renderer over `file://`
breaks module imports with a CORS error. The custom protocol registered in
`main.js` exists for this reason.

**Two copies of `ART`.** `main.js` sizes the window and `src/core/layout.js`
sizes the canvas. Change one and you must change the other, or the canvas will
be scaled non-integrally and the pixel art will smear.

## Project layout

```
main.js              Electron shell
preload.js           IPC bridge
src/app.js           State, input, frame loop
src/audio/           engine, dsp, voice, scales, audit
src/audio/packs/     one file per sound pack, aggregated by presets.js
src/core/            layout, keymap, pet
src/render/          pixel, font, theme, device, display, face, particles
tools/shots.mjs      Screenshot harness
docs/                These documents
```
