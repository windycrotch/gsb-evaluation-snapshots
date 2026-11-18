# Cross-chunk feature acceptance samples

Local, headless checks for the cross-chunk feature merge order (trees growing
over chunk borders). They load the real game sources into a Node `vm` context
— no browser or WebGL needed — and drive the actual `generateChunk` /
`Chunk.decorate` / `generateRadius` code paths.

Run each with Node from the repository root:

```
node tests/cross-chunk-features.js
node tests/loader-consistency.js
node tests/loader-soak.js
```

What they cover:

- **cross-chunk-features.js** — the acceptance scenario: two adjacent chunks
  A and B where a tree crown in A reaches into B.
  1. B is byte-identical whether the world is built A→B or B→A.
  2. An `airOnly` leaf never overwrites an existing block; a forced block
     (trunk) does.
  3. A crown block the player dug out stays air after the chunk is
     regenerated and decorated again (edits apply after features).
  4. A feature block placed more than one chunk away still throws.
- **loader-consistency.js** — walks the player up to the same forest from
  opposite directions through the real chunk loader and compares the
  resulting chunks, also against direct generation.
- **loader-soak.js** — the same comparison across 3 seeds and 4 load orders
  (walk east / west / north / teleport).
