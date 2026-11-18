# Bunny-hop core — fixed 128 Hz, frame-rate independent

A minimal, runnable and checkable implementation of the Source-style bunny-hop
mechanic: build speed in the air by angling your strafe sideways to your view,
and re-jump on the landing tick to chain the gains. The physics is a small set
of pure, DOM-free modules with a fixed simulation step; the browser is only an
input source and an interpolating renderer.

## The rules, exactly as implemented

- **Fixed 128 Hz simulation.** `STEP_SECONDS = 1/128`. Each renderer frame adds
  its elapsed time to an accumulator, then consumes **whole** physics steps; the
  leftover time stays for the next frame. Rendering interpolates between the
  last two ticks and never writes back, so frame rate cannot change physics.
- **Air acceleration with a 30 u/s wish cap, uncapped per-tick gain.** In the
  air the wish-direction speed is hard-capped at `MAX_AIR_WISH_SPEED = 30`
  u/s, but the acceleration *added* each tick is not capped by total speed.
  Pointing the wish direction sideways of your current velocity keeps the
  projected speed under 30 while still adding velocity — that is the whole
  skill. Ground movement uses the normal ground cap (320 u/s) instead.
- **Fixed ground settlement order.** On a ground tick the jump check runs
  **first** (a jumping tick skips friction), then Source friction, then ground
  acceleration. Air ticks run air acceleration with no friction.
- **Mouse displacement is averaged across driven ticks.** A frame's horizontal
  mouse displacement is split evenly over every physics step that frame drives.
  A frame that drives zero ticks defers its displacement rather than dropping
  it, so high- and low-refresh machines produce the same trajectory for the
  same physical input.
- **Auto-hop does one thing.** When enabled it re-jumps on the tick a landing
  occurs and touches nothing else — no yaw, no horizontal velocity, no keys. It
  can be switched off in the pause menu; with it off a landing tick stays
  grounded.

## Layout

```
src/
  constants.js    all public tuning constants (128 Hz, 30 u/s, gravity, ...)
  physics.js      pure functions: friction, accelerate, airAccelerate, wishDirection
  engine.js       PhysicsEngine: accumulator, per-frame mouse split, fixed tick order
  driver.js       scripted input harness (frame re-bucketing for cross-rate runs)
  browser-main.js DOM/pointer-lock wiring + interpolating canvas renderer
scripts/
  sample.mjs      reproducible input -> per-step position / hSpeed / grounded
  build-site.mjs  zero-dependency bundler for the browser page
  serve.mjs       zero-dependency static server for local play
test/
  physics.test.js        21 rule/acceptance tests (node --test, no dependencies)
  browser-bundle.test.js DOM-stub smoke test of the generated bundle
examples/site/           playable page (index.html + generated game.bundle.js)
examples/output/         JSON trace dumps written by the sample
```

## Run it

```bash
npm test            # 22 tests, including the three acceptance checks
npm run sample      # writes examples/output/sample-trace.json and prints a summary
npm run build:site  # regenerate examples/site/game.bundle.js from src/
npm run serve       # http://localhost:8123/examples/site/  (click to lock the mouse)
```

Controls: `W A S D` move, `Space` or mouse wheel jump, `R` reset, `Esc` pauses
and opens the menu where auto-hop can be toggled.

## Reproducible sample

`npm run sample` takes a fixed initial position/yaw, an explicit per-frame
mouse-displacement sequence and a key sequence, then prints every 128 Hz step:
position, horizontal speed, `grounded`, plus `landed`/`jumped` flags. The same
canonical tick schedule is re-bucketed into 128 Hz and 64 Hz renderer frames;
the script asserts the two traces are byte-identical and dumps both to
`examples/output/sample-trace.json`.

### Why the sample uses segment-constant mouse values

The engine averages a frame's mouse displacement over its ticks. An input whose
per-tick displacement is constant inside each frame is therefore recreated
tick-for-tick at any frame rate that is an integer multiple of 128 Hz, which is
what makes the sample bit-exact across rates. Feedback-style re-aiming —
recomputing the sweep from the live velocity each tick, the advanced human
technique — produces larger speed chains but its intermediate per-tick yaw
depends on the frame bucketing, so it cannot be bit-identical across rates.
That gain mechanic is still covered deterministically by the **AC3b** test
using the pure air-acceleration rule (a fixed ~85° re-aim gains on 40/40 ticks
while total speed stays far above 30 u/s).

## Acceptance criteria and where they are checked

1. **Same input at two frame rates gives the same trajectory** — tests
   `AC1` (128 vs 64 Hz) and `AC1b` (128 vs 32 Hz) compare full step records
   byte-for-byte; the sample asserts the same for its own schedule.
2. **Auto-hop off: the landing tick does not auto-jump** — test `AC2` runs the
   identical input with auto-hop on/off and asserts the off run stays grounded
   on and after the landing tick.
3. **Air wish speed truncated at 30 u/s while real gains accumulate** — tests
   `AC3` (pure rule; head-on wish above 30 adds nothing, sideways wish still
   gains) and `AC3b` (a strafe chain grows on every tick past 30 u/s).

Supporting tests cover the accumulator remainder, even mouse split (including
zero-tick deferral), jump-edge timing across rates, the friction-before-accel
order, deterministic 96-tick flight length, no friction in air, and that
`renderState()` never mutates the simulation.

## Tuning constants

All values live in `src/constants.js` and are plain numbers: gravity 800
u/s², jump speed 300 u/s, stop speed 100, ground friction 4, ground
acceleration 10, air acceleration 100, air wish cap 30 u/s, ground wish cap
320 u/s. Coordinates use +x forward at yaw 0 and +y to the player's right;
positive mouse `movementX` increases yaw.
