# Runtime Parameter Updates — Verification Guide

This document covers how the Bitcrusher and Moog filter chains support
changing parameters while audio is running, and how to verify the
behavior locally.

## What changed

### Rust / WASM modules (`modules/`)

Both modules now expose runtime parameter setters in addition to their
constructors. Every setter validates its input through the shared
helpers in the `clawdio-shared` crate (`modules/shared/src/lib.rs`):

| Module      | Setter                         | Legal range | Rejected inputs            |
| ----------- | ------------------------------ | ----------- | -------------------------- |
| Bitcrusher  | `set_bits(bits: f32) -> bool`  | `1..=16`    | NaN, ±Infinity             |
| Bitcrusher  | `set_normfreq(f: f32) -> bool` | `0.0..=1.0` | NaN, ±Infinity             |
| Moog        | `set_cutoff(f: f32) -> bool`   | `0.0..=1.0` | NaN, ±Infinity             |
| Moog        | `set_resonance(f: f32) -> bool` | `0.0..=4.0` | NaN, ±Infinity            |

- A setter returns `true` when the value was accepted (out-of-range
  values are clamped to the nearest boundary) and `false` when it was
  rejected. Rejected values leave the module state untouched.
- `BitcrusherModule` stores `normfreq` internally, so `process()` uses
  the live value without an extra argument crossing the WASM boundary.
- Both DSP loops sanitize non-finite input samples and guarantee every
  output sample is finite.

### Audio worklets (`packages/clawdio/src/workers/`)

- `bitcrusher.ts` and `moog.ts` handle `set-bits`, `set-normfreq`,
  `set-cutoff` and `set-resonance` by updating both the local field and
  the live WASM instance via the new setters — so the sound changes
  immediately.
- If the WASM module is not ready yet (still compiling, or a previous
  load failed), the latest value per parameter is cached in
  `PendingParams` (last write wins). When `init-module` creates the
  module, all cached values are applied once, so the effective value
  equals the last message received.
- Illegal values (NaN, ±Infinity, non-numbers) are rejected before they
  reach the module; a warning is logged and the previous value is kept.
- If WASM initialization or a processing call throws, the worklet stops
  writing dirty data, fills the outputs with silence and keeps the
  processor alive (returning `true`). The next successful parameter
  update or a fresh `init-wasm`/`init-module` handshake clears the
  failure state and resumes audio.
- The existing handshake is unchanged: `init-wasm` →
  `wasm-loaded` → `init-module`. A failed load additionally posts the
  additive `wasm-load-failed` message (unknown message types are safely
  ignored by existing main-thread code).
- Pink Noise is untouched and keeps its original behavior.

## Running the tests

### 1. Rust unit/integration tests

From the `modules/` directory:

```bash
cargo test
```

This runs, among others:

- Bitcrusher: `test_set_bits_takes_effect_at_runtime`,
  `test_set_normfreq_takes_effect_at_runtime`,
  `test_setters_reject_non_finite_values`,
  `test_non_finite_input_samples_are_sanitized`
- Moog: `test_set_cutoff_takes_effect_at_runtime`,
  `test_set_resonance_takes_effect_at_runtime`,
  `test_setters_reject_non_finite_values`,
  `test_constructor_rejects_non_finite_parameters`,
  `test_non_finite_input_samples_are_sanitized`
- Shared: `sanitize_f32` / `sanitize_usize` clamping and rejection tests

### 2. Worklet tests (real WASM, Node + Vitest)

The Vitest suite instantiates the actual compiled WASM artifacts
(`modules/*/pkg`) inside Node and drives the worklet classes with a fake
`AudioWorkletProcessor`/`MessagePort` harness
(`src/workers/test-harness.ts`).

First build the WASM packages once (requires
[wasm-pack](https://github.com/rustwasm/wasm-pack); `wasm-opt` is
disabled in the module `Cargo.toml` so no binaryen download is needed):

```bash
wasm-pack build modules/bitcrusher --target web
wasm-pack build modules/moog --target web
yarn install   # links modules/*/pkg into node_modules
```

Then, from `packages/clawdio/`:

```bash
yarn test
```

Key scenarios covered:

- **Handshake contract** — `wasm-loaded` is still posted and the Rust
  module is constructed after `init-module`.
- **Silent until ready** — `process()` before WASM is ready returns
  silence without throwing.
- **Set-before-ready** — `set-*` messages posted before initialization
  are cached; only the last value is applied once the module exists
  (`caches parameters set before the module is ready...`).
- **Live updates** — a `set-*` message after initialization calls the
  corresponding WASM setter immediately and changes the audible output.
- **Illegal values rejected** — NaN/Infinity/string payloads never reach
  the WASM module and the previous parameters remain in effect.
- **Out-of-range clamping** — e.g. `set-bits: 999` is applied as `16`.
- **Failure → silence → recovery** — a throwing `process()` mutes the
  output; a later parameter update resumes audio. Garbage WASM bytes
  produce `wasm-load-failed`, silence, and a clean recovery after a
  valid re-handshake.

### 3. Manual browser check

```bash
yarn workspace clawdio-examples dev
```

Open the example app, start audio, and drag the Bitcrusher **Bits** /
**Norm Freq** sliders and the Moog **Cutoff** / **Resonance** sliders.
The timbre should change immediately while the note keeps playing. To
exercise the failure path, throttling the network in DevTools while the
WASM is loading will surface the `wasm-load-failed` branch — audio
stays silent instead of glitching, and recovers on retry.
