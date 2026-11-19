# Moog Filter

Moog filter implemented as a Rust module that gets exported to web using WASM.

## Parameters

Parameters can be updated at runtime — no need to recreate the module:

- `set_cutoff(cutoff: f32) -> bool` — normalized cutoff, clamped to
  `0.0..=1.0`. NaN and ±Infinity are rejected.
- `set_resonance(resonance: f32) -> bool` — resonance, clamped to
  `0.0..=4.0`. NaN and ±Infinity are rejected.

Both return `true` when accepted and `false` when rejected (the module
keeps its previous value). `process()` always emits finite samples.

## Development

Read the [shared module documentation](../README.MD) for a full guide on running this locally.

## Credits

- Based on [Tuna.js](https://github.com/Theodeus/tuna/blob/master/tuna.js#L1092)
- [Guide to Synth Filter Types: Ladders, Steiner-Parkers, and More](https://reverb.com/news/a-guide-to-synth-filter-types-ladders-steiner-parkers-and-more)
