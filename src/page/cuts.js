// Cut lists for footage, served at /__motlab/cuts.js. Pure code: it draws frames it gets from openFootage().
import { clamp, ease, lerp } from './motion.js';

// A cut list over one recording: the parts to keep, played back to back. Made for talking heads with many jump
// cuts (skills/motlab/scripts/cut_pauses.py writes the list from the pauses in the voice).
//
//   const { cutList } = await import('/__motlab/cuts.js');
//   const cuts = await (await fetch('../cuts.json')).json();      // { segments: [{ from, to }, ...], dissolve }
//   const edit = cutList(cuts, clip, { punch: [1, 1.12], glide: 0.2, drift: 0.01, x: 0.5, y: 0.4 });
//   await edit.draw(ctx, t, 0, 0, W, H);                          // the frame at t seconds into the edit
//
// Each part is framed by its zoom (from the segment, else the next value of `punch`, so jump cuts alternate between
// a wide and a closer framing) around the point x, y (fractions of the frame; a segment may set its own). `glide` eases
// from the previous part's zoom over that many seconds after a cut instead of jumping, and `drift` pushes in slowly
// (per second) so a part is never still. With `dissolve` (seconds, from the cut list or the options) parts overlap and
// fade into each other; that needs a second decoder of the same file as `clip2`, because both parts are drawn at once.
// edit.toOut(seconds in the file) gives the time in the edit, for words from a transcript of the recording.
export function cutList(cuts, clip, { clip2 = null, punch = [1], glide = 0, drift = 0, x = 0.5, y = 0.5, dissolve, ease: easing = 'inOutCubic' } = {}) {
  const list = Array.isArray(cuts) ? cuts : cuts.segments, D = dissolve ?? cuts.dissolve ?? 0;
  if (!list?.length) throw new Error('cutList: no segments');
  if (D > 0 && !clip2) throw new Error('cutList: a dissolve needs clip2, a second openFootage() of the same file');
  let at = 0;
  const parts = list.map((s, i) => {
    const len = s.to - s.from;
    if (!(len > D)) throw new Error(`cutList: segment ${i + 1} (${s.from} to ${s.to}) is not longer than the dissolve`);
    const p = { from: s.from, to: s.to, len, at, zoom: s.zoom ?? punch[i % punch.length], x: s.x ?? x, y: s.y ?? y };
    at += len - D; return p;
  });
  const duration = at + D, E = ease[easing];
  const index = t => { let k = 0; while (k + 1 < parts.length && parts[k + 1].at <= t + 1e-9) k++; return k; };
  const zoomAt = (k, t) => {   // the zoom of part k at edit time t
    const p = parts[k], into = t - p.at, z = k && glide > 0 ? lerp(parts[k - 1].zoom, p.zoom, E(clamp(into / glide))) : p.zoom;
    return z * (1 + drift * into);
  };
  async function drawPart(ctx, k, t, alpha, dx, dy, dw, dh) {
    const p = parts[k], c = D > 0 ? [clip, clip2][k % 2] : clip, f = await c.frame(p.from + (t - p.at));
    const s = Math.max(dw / c.width, dh / c.height) * zoomAt(k, t), w = c.width * s, h = c.height * s;
    const ox = clamp(dx + dw / 2 - p.x * w, dx + dw - w, dx), oy = clamp(dy + dh / 2 - p.y * h, dy + dh - h, dy);   // never shows an edge
    ctx.save(); ctx.beginPath(); ctx.rect(dx, dy, dw, dh); ctx.clip(); ctx.globalAlpha = alpha;
    f.draw(ctx, ox, oy, w, h); ctx.restore();
  }
  return {
    duration, parts,
    at(t) { const k = index(t), p = parts[k]; return { index: k, src: p.from + (t - p.at), zoom: zoomAt(k, t) }; },
    toOut(src) {
      for (const p of parts) { if (src < p.from) return p.at; if (src <= p.to) return p.at + (src - p.from); }
      return duration;
    },
    async draw(ctx, t, dx, dy, dw, dh) {
      t = clamp(t, 0, duration - 1e-6);
      const k = index(t), into = t - parts[k].at;
      if (k && D > 0 && into < D) {   // the end of the part before, then this part fading in over it
        await drawPart(ctx, k - 1, t, 1, dx, dy, dw, dh);
        return drawPart(ctx, k, t, E(into / D), dx, dy, dw, dh);
      }
      return drawPart(ctx, k, t, 1, dx, dy, dw, dh);
    },
  };
}
