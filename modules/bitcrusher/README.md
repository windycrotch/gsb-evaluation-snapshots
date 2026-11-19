# Bitcrusher

Bitcrusher effect implemented as a Rust module that gets exported to web using WASM.

## Parameters

Parameters can be updated at runtime — no need to recreate the module:

- `set_bits(bits: f32) -> bool` — bit depth, clamped to `1..=16`
  (float inputs are rounded). NaN and ±Infinity are rejected.
- `set_normfreq(normfreq: f32) -> bool` — normalized sample/hold
  frequency, clamped to `0.0..=1.0`. NaN and ±Infinity are rejected.

Both return `true` when accepted and `false` when rejected (the module
keeps its previous value). `process()` always emits finite samples.

## Development

Read the [shared module documentation](../README.MD) for a full guide on running this locally.
