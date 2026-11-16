# Local verification — mode / sand consistency

These checks are local-only and never ship to the site. They prove the
player's invariant under every entry path (address-bar links, the arrow
buttons, the sliders):

> After a mode switch, once the sand has settled, **every settled grain lies
> within `0.0012` plate units of the current mode's nodal line** (the same
> threshold and amplitude/slope distance semantics as `shake()` in
> `js/app.js`), and grains that have not settled keep moving on the next
> frame.

No browser audio is involved. A seeded PRNG (mulberry32) is injected through
the app's `setRng()` seam, so grain placement and the jitter inside `shake()`
are reproducible run to run. The frequency formulas, Bessel computation and
mode shapes in `js/cymatics.js` are untouched.

## Files

- `harness.js` — loads the real `js/cymatics.js` + `js/app.js` in a `vm`
  sandbox with minimal DOM/canvas stubs, no `requestAnimationFrame` loop and
  no `AudioContext`; exposes the symbols the checks drive.
- `verify.js` — the acceptance suite (Node assert). Covers URL by-name entry,
  nearest-frequency fallback, unknown-name fallback on both plates, out-of-
  range and boundary `size`/`mix`, same-frequency twin modes (`0,5` ↔ `3,4`),
  full-spectrum arrow walks, end clamping, all three `settle` branches,
  re-entrant `settle`, moving-unsettled-grains, mix/shape/slider redraws and
  seeded reproducibility.
- `stress.js` — randomized interleaving of every entry path across several
  seeds, driven by a manual loop that mirrors the production rAF sleep/wake
  semantics; asserts the invariant after every switch and that no grain is
  left moving once the loop sleeps.
- `index.html` + `browser.js` — an observable in-browser page that loads the
  production scripts, injects the same seeded generator, runs the same
  assertions and paints each re-settled figure on the real player canvas.

## Run

```sh
# headless, no browser needed
node verify/verify.js
node verify/stress.js

# observable in a browser (open directly, no server required)
# verify/index.html
```

Expected output: `19 passed, 0 failed`, `STRESS PASS`, and `10/10 passed` in
the browser page.
