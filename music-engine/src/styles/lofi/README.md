# Lofi Plugin

Beat-based lofi / chillhop / jazzhop generator.

- Time Model: `beat` (BPM / bar / section)
- Main instruments: `electric-piano`, `bass`, `kick`, `snare`, `hat` (+ optional `pluck`)
- Main FX: `reverb` (required), `tape`, `vinyl`, `delay`, `eq`, `saturation`

## Musical characteristics

- Jazz-flavoured progressions (maj7 / m7 / m9 / maj9 / 7 / sus2 / sus4 / 6) chosen by seed + mood + scale
- Voice-led piano voicings (inversions, rootless variants, octave displacement)
- Motif-based melody with variation (transpose / invert / thin / octave)
- Root/fifth/octave bass with chromatic approach notes, density by energy
- 4 drum kits (boom-bap / lazy / bouncy / busy), swing on offbeat eighths
- Humanization: timing ±15 ms, velocity ±10%, pan ±0.1 (seed controlled)
- Infinite arrangement: Intro → (A / A' / B / A) cycles with seeded variation

## Seed behavior

Same seed + parameters + plugin version → identical event sequence,
independently of how the timeline is chunked into generation windows.

The style's only seed input is the engine-provided string
`${userSeed}|lofi|v${version}`. It builds its root RNG once with
`SeededRandom.forStyle(seed, LOFI_STYLE_ID)` and never hand-concatenates a
`::lofi` suffix itself. Every purpose then gets an independent stream via
`fork(tag)` — `arrangement` (which forks `cycle:N`), `section:N`,
`bar:N` (harmony rhythm / bass / drums / melody), `humanize`, `arc` — so
call-order changes and window chunking can never reshuffle unrelated parts.
`Math.random()` is forbidden inside the style.

## Example

```ts
engine.registerStyle(lofiPlugin);
engine.useStyle('lofi');
await engine.start();
```
