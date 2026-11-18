# Rendering

**Files:** `src/render/pixel.js`, `font.js`, `theme.js`, `device.js`,
`display.js`, `particles.js`, `src/core/layout.js`

## The pixel buffer

`Pixel` wraps an `ImageData` at the logical resolution (`196 × 166`) and writes
bytes directly. Nothing uses the 2D context's shape API, so there is no
anti-aliasing anywhere and every draw call lands on exactly one pixel. The
canvas is upscaled by CSS with `image-rendering: pixelated`.

Provided: `px`, `add` (additive light, for glow and bloom), `rect`, `frame`,
`hline`, `vline`, `rrect` (fill or stroke, with hand-tuned pixel corners),
`circle`, `ring`, `ellipse`, `line`, `vgrad` (dithered), plus `pushClip`/
`popClip`, `setOffset`, `snapshot`/`blit` and `shiftRows`.

Two of these carry more weight than they look:

- **`add`** only brightens pixels that already have alpha, which is what makes
  glows read as light coming *out of* the device rather than a haze over it.
- **`setOffset`** shifts subsequent draws while clip rectangles stay fixed.
  That's how the screen shake works: the picture vibrates inside the glass while
  the glass and the HUD stay still.

`shiftRows` displaces whole rows sideways and is used for the glitch effect when
the sound changes.

Colours are hex strings parsed and cached into RGBA tuples. `mix`, `shade` and
`withAlpha` compose them; `bayer` gives a 4×4 ordered-dither threshold, used
everywhere a soft edge is needed without leaving pixel-art rules.

## Font

`src/render/font.js` is a hand-authored bitmap font, 5 px tall, 4 px wide except
`M` and `W` which get a fifth column. Glyphs advance by width + 1. Uppercase,
digits, punctuation, plus a music note (`&`), heart (`@`), star (`$`) and
arrows. `text`, `textCentered` and `textRight` all take an optional shadow and a
per-character wave offset.

## Layout

`src/core/layout.js` holds every rectangle in canvas space with the `PAD` margin
already applied. It is imported by the renderers *and* by `App.buildZones`,
which generates the DOM hit areas, so geometry can never drift between what you
see and what you can click.

## Theme

`SHELL` is a fixed cool-grey palette for the case, plus cream for the keys.
`screenTheme(accent)` derives a whole screen palette — background, grid, dim,
mid, foreground, highlight, glow, shadow — from a single accent colour, which is
why adding a preset recolours the entire device for free. Results are cached per
accent.

## Device

`device.js` splits into a static layer and dynamic chrome. `drawShadow` and
`drawShell` produce everything that only changes with theme or scale, and are
cached as a snapshot. `drawChrome`, `drawKnob`, `drawLeds` and `drawKeys` run
every frame.

Knobs sweep 260°, with position ticks around the bezel, a rotating knurl
pattern that sells the turn, a pointer, and a glow ring that fades after a
detent. Under the label is a row of position dots; a knob that carries two values
(the sound knob: pack, then preset) gets a second, finer row below it, so the
sub-value reads as subordinate rather than as a peer.

A knob is also a button. On click the cap travels exactly one pixel into its
housing — one pixel is all a 32 px knob has, and it's enough — the cap gradient
darkens, a shadow line appears where the housing now overhangs it, the rim lights
up, and one thin ring of light leaves the knob over about 400 ms. All of that
feedback is `add` only. An earlier version painted the rings opaque as well and it
read as a gold band stuck around the knob instead of a flash.

The press animation snaps in and eases out (`1 - exp(-34 dt)` down, `-12 dt` up),
so a keyboard-triggered press is still visible even though no pointer is holding
the knob down.

Keys are drawn as physical objects: a socket, a gradient face, a bottom lip for
thickness that disappears when pressed, an accent tint while held, and a dithered
afterglow that decays after release.

## Display

The screen is 96 × 62, divided into a header (0–6), the pet's area (8–46) and
the oscilloscope (48–61), with the horizon at 34.

The backdrop is a scrolling perspective floor: lines converging on a vanishing
point at the horizon, plus horizontal rows spaced by a squared curve and
scrolled at a speed that tracks the audio level. The horizon lights up from the
centre with the sound. Above it is a sparse star field that brightens as the pet
gets sleepy.

Glass treatment goes on last and does not shake: scanlines every third row, a
corner vignette, and a single soft highlight in the top-left.

## Particles

One small system (`particles.js`) serves both the screen emotes and the key
sparks. Kinds: `glyph` (floating font characters), `label` (note names),
`ripple` (expanding rings), and plain `dot` sparks with gravity. Key sparks are
clipped to the keyboard panel so flying note names never collide with the info
bar.

## Performance

The whole frame is a few hundred thousand pixel writes, which is comfortable at
60 fps. The static shell cache removes the largest fixed cost. If a new effect
needs a full-screen per-pixel pass, check it against the existing dither passes
first — several of them already cover the same area.
