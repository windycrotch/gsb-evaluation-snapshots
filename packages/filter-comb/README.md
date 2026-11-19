# @audio/filter-comb [![npm](https://img.shields.io/npm/v/@audio/filter-comb)](https://www.npmjs.com/package/@audio/filter-comb) [![MIT](https://img.shields.io/badge/MIT-%E0%A5%90-white)](https://github.com/krishnized/license)

Comb filter — feedforward (FIR) and feedback (IIR)

```
npm install @audio/filter-comb
```

```js
import comb from '@audio/filter-comb'
```

Adds a delayed copy of the signal to itself — notches and peaks at harmonics of $f_s / D$.

**Feedforward**: $H(z) = 1 + g \cdot z^{-D}$ — dips at $f = \frac{(2k+1) f_s}{2D}$, depth depends on $g$: a true null only at $|g|=1$; the default $g=0.5$ gives a $-6\,\text{dB}$ dip, not a notch<br>
**Feedback**: $H(z) = \dfrac{1}{1 - g \cdot z^{-D}}$ — peaks at $f = \frac{k \cdot f_s}{D}$

```js
comb(buffer, { delay: 10, fs: 48000, gain: 0.6, type: 'feedback' })
```

| Param | Default | |
|---|---|---|
| `delay` | — | required, delay in **milliseconds**, converted to sample frames at `fs` (a whole number given with no `fs` is read as whole frames) |
| `fs` | `44100` | sample rate, Hz — changing it on a reused params object restarts the delay glide |
| `gain` | `0.5` | feedforward/feedback coefficient `g`; `|gain| ≥ 1` is held just inside 1 so feedback stays bounded |
| `type` | `'feedforward'` | `'feedforward'` (FIR, dips) or `'feedback'` (IIR, peaks) |

Pass the same `params` object on every call — the ring buffer and write pointer persist across blocks:

```js
let params = { delay: 10, fs: 48000, gain: 0.6, type: 'feedback' }
for (let buf of stream) comb(buf, params)
```

The delay is live, read as @audio/effect's delay lines read theirs: a delay between two samples is read between them (linear interpolation of the two adjacent frames), and a new one glides from where the last call ended — the read moving at most half a frame longer and at most a frame shorter per frame, never an instant jump. The ring is allocated once for the longest delay and shorter delays reuse it; only a delay longer than the ring holds makes a new one, empty. Its `gain` is smoothed (20 ms) and glided sample by sample in the `/audio` processor: a host's ramp of it is one line, the same however the host cuts its calls. A new `type` still switches in one sample: feedforward keeps its input in the line and feedback its output, so a fade would need the feedback recursion running at all times. A delay under one frame, a non-finite delay or an invalid `fs`/`type` throws; no call leaves NaN or Infinity in the output.

**Use when:** flanging, chorus (with modulated delay), Karplus-Strong string synthesis, room mode modeling.

---

Part of [@audio/filter](https://github.com/audiojs/filter) — the filter family umbrella. This README is generated from the umbrella docs.

MIT © [audiojs](https://github.com/audiojs)
