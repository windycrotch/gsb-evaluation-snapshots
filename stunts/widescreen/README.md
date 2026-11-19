# The widescreen cockpit's sides (`widescreen/`)

On a wide window the 4:3 picture sits in the middle and the dashboard's rows are carried out to the
window's sides, so the cockpit reads as one wide one. This folder holds the part of that which decides
**what** the sides may show — kept apart from the drawing (`main.js`'s `drawCurve`) as pure functions of
a frame's snapshot, so it can be checked here without the game, without a browser, and without any of
the game's files.

## The rules (`sides.js`)

The page takes one snapshot of the screen per frame and draws every layer from it. The sides follow
these rules:

- **Same frame, same car.** Until a car's dashboard is remembered, the sides are the current frame's own
  columns — never an older frame's, never another car's.
- **Learning only from a race under way.** A car's dash height and plain-panel columns are remembered
  only after the picture has stood still for a second (`STABLE_FRAMES = 60`) in a race whose clock is
  running — never in a replay, and never while the clock is stopped (a menu or dialog over the paused
  race stops it, so the Replay Menu's own frame is never learned as the cockpit). Only a real dash is
  remembered (`60 < top < 190`): "no dash" is never learned.
- **Per car, per race.** The memory is keyed by the car's code. Another car's code — or the race's clock
  starting over (a new race, a restart, a rewind) — drops it: one car's dash is never drawn beside
  another car, nor a finished race's beside a new one.
- **Frames stopped ⇒ follow the visible frame.** While 3D frames are stopped (a stall, a pause, a menu),
  nothing is learned and nothing remembered is drawn; the stillness count starts over, so after the race
  resumes everything is worked out from the frames that actually arrive.

In `main.js` this shows up as: `frame()` watches the race's clock (`frame.clockRunAt`, `frame.raceSeq`),
`drawCurve` asks `StuntsSides.pick` for the sample to draw, and the whole side-fill block runs inside
`try/catch` — if the side computation ever throws, the sides go off for that frame, the original picture
still shows, and the next frame is still scheduled. What the Replay Menu's Display Options left is put
back only once the race's clock advances again (`og[4]`, see `worker.js`), and the per-race restore from
`localStorage` no longer overwrites it.

## The checks (`test/sides.test.js`)

Run, from anywhere (no game files, no browser, no dependencies):

```
node stunts/widescreen/test/sides.test.js
```

Synthetic 320×200 frames stand in for the snapshots `main.js` takes. The four scenes are the ones the
page had wrong:

1. **A normal race** — the sides are the frame's own until the dash is remembered after a still second;
   a pop-up over the dash (the gear change's) is never carried out to the sides.
2. **Changing cars** — the new car's sides come from its own frames; the old car's memory is dropped,
   both at a new race and on a car-code change within one.
3. **The Replay Menu and back** — the menu's frames (clock stopped) and a playing replay are never
   learned as the cockpit; back driving with the clock running, the same race's memory still serves;
   a restarted race reuses nothing of the old run.
4. **Dropped frames and resume** — a stall resets the stillness count, the sides follow the visible
   frame while frames are stopped, and the count is worked out afresh after resuming.

Plus a robustness pass: garbage frames never make `extract`/`pick` throw, and a frame with no dashboard
is never remembered.

The checks exit 0 when all pass, 1 otherwise, and print a line per check.
