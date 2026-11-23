# Tests

The test suite runs entirely in Node — no browser or real AudioContext needed.
A small observable Web Audio mock (`tests/helpers/web-audio-mock.js`) records
every `connect`/`disconnect` and lets tests dispatch synchronous `ended`
events, so graph topology and node lifecycle can be asserted deterministically.

## Run

```bash
npm install
npm test
```

## Layout

- `tests/unit/node-registry.test.js` — direct tests of the lifecycle-aware
  registry (`src/base/node-registry.js`).
- `tests/integration/graph-lifecycle.test.jsx` — mounts the real React
  components (`RPipeline`, `RSplit`, `RGain`, `ROscillator`, `RBufferSource`)
  with `react-test-renderer` and drives them through the lifecycle scenarios.
- `tests/helpers/late-node.jsx` — a node that only publishes itself to the
  registry when `release()` is called, used to prove deferred connections are
  backfilled once a missing target registers.

## Covered scenarios

1. **Normal reconnection** — siblings connect in JSX order on mount; a parent
   re-render keeps the same AudioNode instances, atomically moves their
   registry entries to the freshly generated identifiers and preserves the
   graph; parallel `RSplit` branches all reach the destination.
2. **Missing target, then backfill** — connecting to an unregistered Symbol is
   deferred (never connected to `undefined`) and fulfilled as soon as the
   target registers. An upstream that registered first never permanently loses
   its link to a downstream node that appears later.
3. **Unmount and repeated unmount** — unmounting a child removes its registry
   key and every parent's connection to it; whole-graph unmount leaves the
   registry empty; repeated cleanup and `disconnect` failures never throw.
4. **Rapid identifier changes** — many back-to-back identifier replacements
   leave only the newest key, with inbound bookkeeping following the move.

Additionally, source-node rebuilds are covered: an `ended` event on an
`Oscillator`/`BufferSource` re-registers a fresh instance under the same key,
replays inbound connections onto it and re-points its own pending outbound
connections; an `ended` event delivered after unmount cannot resurrect an
entry.
