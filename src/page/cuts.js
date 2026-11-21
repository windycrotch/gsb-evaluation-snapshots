// Cut lists for footage, served at /__motlab/cuts.js. Pure code: it draws frames it gets from openFootage().
import { clamp, ease, lerp } from './motion.js';

// A cut list over one recording: the parts to keep, played back to back. Made for talking heads with many jump
// cuts (skills/motlab/scripts/cut_pauses.py writes the list from the pauses in the voice).
//
//   const { cutList } = await import('/__motlab/cuts.js');
//   const cuts = await (await fetch('../cuts.json')).json();      // { segments: [{ from, to }, ...], dissolve, sections }
//   const edit = cutList(cuts, clip, { punch: [1, 1.12], glide: 0.2, drift: 0.01, x: 0.5, y: 0.4 });
//   await edit.draw(ctx, t, 0, 0, W, H);                          // the frame at t seconds into the edit
//
// Each part is framed by its zoom (from the segment, else the next value of `punch`, so jump cuts alternate between
// a wide and a closer framing) around the point x, y (fractions of the frame; a segment may set its own). `glide` eases
// from the previous part's zoom over that many seconds after a cut instead of jumping, and `drift` pushes in slowly
// (per second) so a part is never still. With `dissolve` (seconds, from the cut list or the options) parts overlap and
// fade into each other; that needs a second decoder of the same file as `clip2`, because both parts are drawn at once.
// edit.toOut(seconds in the file) gives the time in the edit, for words from a transcript of the recording.
//
// `section` (a name or a 0-based index into cuts.sections) plays one section of the list, so a long take can be one
// scene per section. A section is [{ name, from }, ...] in seconds of the recording, and starts at the cut nearest its
// `from`; it runs to the cut where the next one starts. Its scene's time 0 is that cut, and `offset` is where it starts
// in the whole edit, so scenes of consecutive sections joined by hard cuts stay in step with the cut voice.
// edit.captions(transcript) places the transcript's words on the scene's time, grouped into caption lines.
export function cutList(cuts, clip, { clip2 = null, punch = [1], glide = 0, drift = 0, x = 0.5, y = 0.5, dissolve, ease: easing = 'inOutCubic', section } = {}) {
  const list = Array.isArray(cuts) ? cuts : cuts.segments, D = dissolve ?? cuts.dissolve ?? 0;
  if (!list?.length) throw new Error('cutList: no segments');
  if (D > 0 && !clip2) throw new Error('cutList: a dissolve needs clip2, a second openFootage() of the same file');
  let at = 0;
  const all = list.map((s, i) => {
    const len = s.to - s.from;
    if (!(len > D)) throw new Error(`cutList: segment ${i + 1} (${s.from} to ${s.to}) is not longer than the dissolve`);
    const p = { from: s.from, to: s.to, len, at, zoom: s.zoom ?? punch[i % punch.length], x: s.x ?? x, y: s.y ?? y };
    at += len - D; return p;
  });
  const whole = at + D, E = ease[easing];
  let parts = all, offset = 0, duration = whole, name = null;
  if (section !== undefined) {
    const sections = cuts.sections;
    if (!Array.isArray(sections) || !sections.length) throw new Error('cutList: the cut list has no "sections"');
    const k = typeof section === 'number' ? section : sections.findIndex(s => s.name === section);
    if (!sections[k]) throw new Error(`cutList: no section ${JSON.stringify(section)}; the sections are ${sections.map(s => s.name).join(', ')}`);
    const first = sectionStart(all, sections[k].from), next = k + 1 < sections.length ? sectionStart(all, sections[k + 1].from) : all.length;
    if (next <= first) throw new Error(`cutList: section ${JSON.stringify(sections[k].name)} starts at the same cut as the one after it, so it has no parts`);
    offset = all[first].at; duration = (next < all.length ? all[next].at : whole) - offset; name = sections[k].name;
    parts = all.slice(first, next).map(p => ({ ...p, at: p.at - offset }));
  }
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
  // A word's time in this edit, or null when its start was cut out or lies outside this section.
  const place = src => { const p = parts.find(p => src >= p.from && src < p.to); return p && p.at + (src - p.from) < duration ? p : null; };
  return {
    duration, parts, offset, section: name,
    at(t) { const k = index(t), p = parts[k]; return { index: k, src: p.from + (t - p.at), zoom: zoomAt(k, t) }; },
    toOut(src) {
      for (const p of parts) { if (src < p.from) return p.at; if (src <= p.to) return p.at + (src - p.from); }
      return duration;
    },
    // transcript: Whisper's JSON ({ segments: [{ words: [{ word, start, end }] }] }) or a list of { word or text, start,
    // end }, in seconds of the recording. Words whose start was cut out are left out. A line ends at a pause longer
    // than maxGap, after . ? or !, or before it would pass maxChars, and stays up for `hold` seconds after its last word
    // unless the next line starts sooner. `shift` moves every word (Whisper's times were 0.23 s early in one take).
    captions(transcript, { maxChars = 32, maxGap = 0.6, hold = 0.3, shift = 0 } = {}) {
      const words = [];
      for (const w of transcriptWords(transcript)) {
        const start = w.start + shift, p = place(start);
        if (!p) continue;
        const end = Math.min(Math.max(w.end + shift, start), p.to);
        words.push({ text: w.text, start: p.at + (start - p.from), end: Math.min(p.at + (end - p.from), duration) });
      }
      const lines = [];
      for (const w of words) {
        const line = lines.at(-1), last = line?.words.at(-1);
        if (line && !(w.start - last.end > maxGap || /[.?!]["')\]]*$/.test(last.text) || line.text.length + 1 + w.text.length > maxChars)) {
          line.words.push(w); line.text += ' ' + w.text; line.end = w.end;
        } else lines.push({ text: w.text, start: w.start, end: w.end, words: [w] });
      }
      lines.forEach((l, i) => { l.end = Math.min(l.end + hold, lines[i + 1]?.start ?? duration, duration); });
      return lines;
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

// The part a section starts with: the one whose start (the cut before it) is nearest `from`.
function sectionStart(parts, from) {
  let best = 0;
  parts.forEach((p, k) => { if (Math.abs(p.from - from) < Math.abs(parts[best].from - from)) best = k; });
  return best;
}

function transcriptWords(t) {
  const list = Array.isArray(t) ? t : t?.segments ? t.segments.flatMap(s => s.words ?? []) : t?.words ?? [];
  return list.map(w => ({ text: String(w.word ?? w.text ?? '').trim(), start: Number(w.start), end: Number(w.end) }))
    .filter(w => w.text && Number.isFinite(w.start) && Number.isFinite(w.end)).sort((a, b) => a.start - b.start);
}
