# Post-processing state — contract and acceptance

The report this file answers: *switching quality, resizing the window, or changing
anti-aliasing makes the picture go dark, ghost, or lose the contact shadow.* All
three are symptoms of the same class of defect: **a half-applied tier**. The two
AO passes share one depth/normal g-buffer, the composer and the grade pass each
hold their own idea of the window size, and TAA keeps accumulation across frames.
Any switch that updates one of those and not its dependents produces exactly those
three looks.

## The state the pipeline now guarantees

Owner: `src/render/pipeline.js`. Everything below is enforced in `applyState()` /
`assemble()`, verified in the page by `World.pipeline.selfTest()`, and read out by
`World.pipeline.getState()` (also `World.pipeline.state`).

| invariant | what "wrong" looked like |
|---|---|
| **1. Contact AO is never enabled while broad AO is off.** Contact reads broad's depth+normal; broad off means nothing refreshes them, so contact reads a frozen buffer. | A dark band welded to the previous frame's geometry — "the shadow ghosted", "the picture went dark". |
| **2. Both AO passes share one half-res size**, recomputed from `logical size × pixelRatio` on every resize / DPR change / quality switch. | Contact AO at the old tier's resolution over a new-size frame — a dark smear or a vanished contact edge. |
| **3. Contact's `depthTexture`/`normalTexture` are the broad pass's *current* textures** (identity, not just equal dimensions). | After a resize the contact pass samples a discarded target: contact shadow "suddenly disappears". |
| **4. AA mode changes rebuild the ordered chain and drop temporal history**; a real resize drops it too. | Switching TAA→SMAA→TAA blends against pre-switch frames (ghost), or a stale full-size TAA accumulation (ghost). |
| **5. Composer, grade and SMAA follow the same effective size.** | Grade vignette / CA sized for the old window; SMAA lookup targets mismatched. |
| **6. Every mutator validates first; invalid input changes nothing** and is reported via `state.lastError`. | `setQuality('cinematic')` silently coerced to `ultra` — a failed switch reads as a success. |

### Queryable runtime state

```js
const s = World.pipeline.getState();
// {
//   ready, quality: 'ultra'|'high'|'medium', aa: 'smaa'|'taa',
//   pixelRatio, size: {width,height},                       // effective backing store
//   composer: {width,height}, grade: {width,height},
//   smaa: {present, enabled, width, height, threshold},
//   broadAO:   {enabled, samples, width, height},
//   contactAO: {enabled, requested, samples, width, height, sharesGBuffer},
//   aoTarget:  {width,height},                               // where the halves should be
//   taa: {active, accumulating, accumulateIndex},
//   chain: ['render','broadAO','contactAO','bloom','godray','output','grade','smaa'],
//   lastError: null | {method, input, reason, at},
// }
```

`World.pipeline.selfTest()` returns `[]` when healthy, else a list of violated
invariants as human-readable strings. It derives everything from the **live** pass
objects, not from intent, so a desync surfaces instead of hiding.

### Mutators

| call | validated? | notes |
|---|---|---|
| `setQuality('ultra'\|'high'\|'medium')` | unknown tier rejected | writes enable/samples/size as one step; contact follows broad |
| `setAA('smaa'\|'taa')` | unknown mode rejected | rebuilds chain, resets TAA history |
| `setBroadAO(bool)` | non-boolean rejected | off ⇒ contact off (request remembered) |
| `setContactAO(bool)` | non-boolean rejected | request remembered across a broad off/on |
| `setAOSamples(n)` | must be int in [1,32] | drives both AO passes to the same count |
| `resize(w, h)` | non-finite/≤0 rejected | re-derives DPR from `devicePixelRatio`, re-targets everything |
| `setSmaaThreshold`, `setVignette`, `setExposure`, `setBroadBlend`, `tuneContactAO` | range-checked | debug/A-B levers |

## Acceptance

Two local entries, both runnable offline, no extra dependencies.

### 1. State machine — `npm test`

```bash
npm test                      # = node tools/pipeline-selftest.mjs
node tools/pipeline-selftest.mjs --verbose
```

Drives the **real** `src/render/pipeline.js` with the real three.js passes and a
stub renderer, asserting the invariants and the `selfTest()` oracle after every
transition. Covered: fresh boot, the full quality ladder, the broad-AO-off
boundary, repeated and DPR-changing resizes, rapid AA round-trips, interleaved
resize×AA×quality stress, out-of-range sample counts, and rejected-input hygiene.
It also hand-corrupts an AO size mid-run to prove the oracle is not vacuous.

### 2. In the real game — `npm run test:pipeline:live`

```bash
npm run test:pipeline:live             # headless
node tools/pipeline-live-check.mjs --headed --keep --verbose
```

Spawns `vite` and a headless Chrome (CDP over Node's built-in `WebSocket`), boots
the actual app, and runs the same `selfTest()` oracle plus live quality / AA / AO
/ resize transitions through `World.pipeline`. It also checks the page logged no
exceptions. Skips cleanly if no Chrome/Edge is found or the port is taken (set
`CHROME_PATH` to override).

Expected tail from both:

```
OK — N scenarios, M checks
```

### Verification of the defects themselves

Run against the pre-fix `pipeline.js`, the same three reports reproduce through
the old public API:

- `setBroadAO(false)` left `contactPass.enabled === true` (defect 1)
- `setAA('taa')` left `SMAAPass` installed in the chain and `accumulateIndex`
  unset (defect 4)
- `resize(1600,900)` sized the composer via the argument but sized GTAO via
  `renderer.getSize()` — 1600×900 composer over a 640×360 AO that the caller
  never asked for (defect 2/5)

## Scope

Only `src/render/pipeline.js` (the RenderPipeline-owned file) changes behaviour.
`package.json` gains the script entries; `tools/` gains the two harnesses. No
other system, no HUD, no engine, no camera is touched. The F3 overlay already
imports nothing from the pipeline; if it is later extended to show the tiers it
can read `World.pipeline.getState()` directly.
