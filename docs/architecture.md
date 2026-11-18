# Architecture

**Files:** `main.js`, `preload.js`, `src/app.js`, `src/core/layout.js`

## Process model

Standard Electron split, kept deliberately thin.

**Main process** (`main.js`) owns the window and nothing else. The window is
frameless, transparent, non-resizable, always-on-top at the `floating` level,
and has no native shadow — the shadow is drawn into the canvas so it stays
pixel-art. There's no application menu, so the app reads as a desktop object
rather than a program.

Renderer files are served over a custom `app://` scheme registered as
`standard` and `secure`, rather than `file://`. This is what makes ES module
imports work in the renderer; `file://` module imports are blocked by CORS.

**Preload** (`preload.js`) exposes a small `window.shell` bridge over
`contextBridge`: `cycleScale`, `togglePin`, `menu`, `quit`, `hide`, plus
`onFocusChange` and `onScaleChange` subscriptions. Context isolation is on and
node integration is off; the renderer never touches Node.

**Renderer** (`src/app.js`) is a single `App` class that owns all state and
drives one `requestAnimationFrame` loop.

## Window sizing

`ART` in `main.js` (`196 × 166`) must stay in sync with `ART` in
`src/core/layout.js`. The window content size is exactly `ART × scale`, so the
canvas CSS size is an integer multiple of its backing size and every logical
pixel maps to a whole number of screen pixels. Scale cycles through 2×, 3×
(default) and 4×.

## Input routing

The canvas can't receive precise hit-testing on its own, and the whole body is
a `-webkit-app-region: drag` surface so the window can be moved from anywhere.
Interactive areas are therefore transparent `div`s in `#hit`, generated in
`App.buildZones` from the same constants in `src/core/layout.js` that the
renderer draws from, and marked `no-drag`. One source of geometry, two
consumers.

Zones exist for the screen (petting), both knobs, all 30 keys, and the pin and
close icons. `App.layoutZones` repositions them whenever the window scale
changes.

A knob zone serves two gestures. `onPointerDown` starts a drag; if the pointer
comes back up without having moved past the drag threshold, it counts as a click
instead (`App.pressKnob`) — which is how the sound knob steps through the presets
in the current pack.

Keyboard input is bound on `window` and uses `event.code`, so the mapping
follows physical key positions rather than the user's layout.

## The frame loop

`App.frame` runs once per animation frame and does, in order:

1. Sample the analyser for level and scope data.
2. Advance key glows, knob angles, and the shake decay.
3. Update the pet with `dt`, level, voice count and focus; drain its emote queue
   into the display.
4. Update the display and spark particle systems.
5. Refresh the shared `state` object.
6. Draw.

## State

There is one mutable `state` object, rebuilt in place each frame and passed to
every draw function. It carries the theme, the current scale, the current pack
and the preset inside it, key and pad tables, audio level and scope, the pet's
expression, and UI flags. Renderers are pure functions of it — they never reach
back into `App`.

## Draw order and the shell cache

The static shell (body, bevels, brand, screen recess, housings, key panel,
screws) only changes when the theme or window scale changes, so it's rendered
once into a snapshot and blitted at the start of each frame. `shellDirty` is set
on preset change (the theme tints the info bar) and on resize.

After the blit:

1. `drawScreenGlow` — screen light spilling onto the shell
2. `drawChrome` — pin, close, power LED, info bar text, hint line
3. `display.draw` — everything inside the glass
4. both knobs, the LED meter, the keys
5. spark particles, clipped to the keyboard panel

## Coordinate system

Everything is in logical pixels, in canvas space, with the `PAD` margin already
added. `src/core/layout.js` is the single source for every rectangle. Screen
contents are additionally described in screen-local coordinates inside
`src/render/display.js` (header 0–6, content 8–46, scope 48–61, horizon at 34).
