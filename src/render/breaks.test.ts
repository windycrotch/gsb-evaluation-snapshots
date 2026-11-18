import { createCanvas } from '@napi-rs/canvas';
import { describe, expect, it } from 'vitest';
import { TAIL, generateTimeline, type Break, type Timeline, type TimelineOptions } from '../timeline';
import {
  MIN_BREAK_DURATION,
  breakAt,
  breakPose,
  drawExhale,
  exhaleWindow,
  isBreakActive,
} from './breaks';
import { renderFrame } from './renderFrame';

/**
 * Break timing after the timeline has been scaled to fit maxDuration.
 * The renderer must read only the break’s stored t0/t1 — the post-scale times — so the departure,
 * the smoke and the return stay inside the break, and a break squeezed to (almost) nothing is skipped
 * instead of dividing by zero or leaking a hand/smoke animation into the typing.
 */

const W = 240;
const TEXT = 'Sorry, give me a sec, then I will reply'; // long enough for two breaks

const gen = (o: Partial<TimelineOptions> = {}): Timeline =>
  generateTimeline({ text: TEXT, mode: 'breaks', seed: 4, lang: 'en', ...o });

const frame = (tl: Timeline, t: number): Uint8ClampedArray => {
  const canvas = createCanvas(W, W);
  const ctx = canvas.getContext('2d') as unknown as CanvasRenderingContext2D;
  renderFrame(ctx, tl, t, { width: W, height: W, watermark: 'test' });
  return ctx.getImageData(0, 0, W, W).data;
};

/** Number of pixels that differ visibly between two frames. */
const diff = (a: Uint8ClampedArray, b: Uint8ClampedArray): number => {
  let n = 0;
  for (let i = 0; i < a.length; i += 4) {
    if (Math.abs(a[i]! - b[i]!) + Math.abs(a[i + 1]! - b[i + 1]!) + Math.abs(a[i + 2]! - b[i + 2]!) > 12) n++;
  }
  return n;
};

/** The same timeline with the breaks removed — a reference frame with no break effects at all. */
const withoutBreaks = (tl: Timeline): Timeline => ({ ...tl, breaks: [] });

/** A ctx stub that only counts how many puffs drawExhale would fill. */
function exhalePuffs(): { ctx: CanvasRenderingContext2D; puffs: () => number } {
  let puffs = 0;
  const ctx = {
    save() {},
    restore() {},
    createRadialGradient: () => ({ addColorStop() {} }),
    set fillStyle(_v: unknown) {},
    beginPath() {},
    arc() {},
    fill() {
      puffs++;
    },
  };
  return { ctx: ctx as unknown as CanvasRenderingContext2D, puffs: () => puffs };
}

/** Breaks of the same seed with and without the length cap — the scaling factor between them. */
function scaledPair(maxDuration: number): { raw: Timeline; capped: Timeline; factor: number } {
  const raw = gen({ maxDuration: Infinity });
  const capped = gen({ maxDuration });
  const rawSend = raw.events.at(-1)!;
  const cappedSend = capped.events.at(-1)!;
  return { raw, capped, factor: cappedSend.t / rawSend.t };
}

describe('breaks mode: the timeline is scaled, the break times scale with it', () => {
  it('multiplies event and break times by the same factor', () => {
    const { raw, capped, factor } = scaledPair(20);
    expect(capped.duration).toBeCloseTo(20);
    expect(factor).toBeLessThan(1); // squeezed, not stretched
    expect(capped.breaks.length).toBe(raw.breaks.length);
    raw.breaks.forEach((b, i) => {
      const c = capped.breaks[i]!;
      expect(c.kind).toBe(b.kind);
      expect(c.t0).toBeCloseTo(b.t0 * factor, 9);
      expect(c.t1).toBeCloseTo(b.t1 * factor, 9);
      // and the send still sits exactly TAIL before the end
      expect(capped.duration - capped.events.at(-1)!.t).toBeCloseTo(TAIL, 9);
    });
  });

  it('stretching to the voice message keeps breaks proportional too', () => {
    const raw = gen({ maxDuration: Infinity });
    const stretched = gen({ voiceSeconds: 40 });
    const factor = stretched.events.at(-1)!.t / raw.events.at(-1)!.t;
    expect(factor).toBeGreaterThan(1);
    raw.breaks.forEach((b, i) => {
      expect(stretched.breaks[i]!.t0).toBeCloseTo(b.t0 * factor, 9);
      expect(stretched.breaks[i]!.t1).toBeCloseTo(b.t1 * factor, 9);
    });
  });

  it('a huge voiceSeconds stretches the video and the breaks stay inside it', () => {
    const tl = gen({ voiceSeconds: 500 }); // longer than the cap → stretched up to maxDuration
    expect(tl.duration).toBeCloseTo(60);
    expect(tl.breaks.length).toBeGreaterThan(0);
    for (const b of tl.breaks) {
      expect(b.t0).toBeGreaterThanOrEqual(0);
      expect(b.t1).toBeLessThanOrEqual(tl.events.at(-1)!.t);
      expect(isBreakActive(b)).toBe(true);
      expect(exhaleWindow(b) === null ? 'coffee' : 'smoke').toBe(b.kind);
    }
    const noBreaks = withoutBreaks(tl);
    for (const b of tl.breaks) {
      expect(diff(frame(tl, b.t0 - 0.02), frame(noBreaks, b.t0 - 0.02))).toBe(0);
      expect(diff(frame(tl, (b.t0 + b.t1) / 2), frame(noBreaks, (b.t0 + b.t1) / 2))).toBeGreaterThan(200);
      expect(diff(frame(tl, b.t1 + 0.02), frame(noBreaks, b.t1 + 0.02))).toBe(0);
    }
  });

  it('a huge voiceSeconds plus a tight cap squeezes the timeline and the breaks', () => {
    const raw = gen({ maxDuration: Infinity });
    const tl = generateTimeline({ text: TEXT, mode: 'breaks', seed: 4, lang: 'en', voiceSeconds: 500, maxDuration: 20 });
    expect(tl.duration).toBeCloseTo(20);
    const factor = tl.events.at(-1)!.t / raw.events.at(-1)!.t;
    expect(factor).toBeLessThan(1);
    raw.breaks.forEach((b, i) => {
      const c = tl.breaks[i]!;
      expect(c.t0).toBeCloseTo(b.t0 * factor, 6);
      expect(c.t1).toBeCloseTo(b.t1 * factor, 6);
      // The scaled break owns its interval: nothing animates just outside it.
      const noBreaks = withoutBreaks(tl);
      expect(diff(frame(tl, c.t0 - 0.01), frame(noBreaks, c.t0 - 0.01))).toBe(0);
      expect(diff(frame(tl, c.t1 + 0.01), frame(noBreaks, c.t1 + 0.01))).toBe(0);
    });
  });
});

describe('breakPose: only inside the break, driven by the stored t0/t1', () => {
  it('no departure, no prop, no raise outside [t0, t1]', () => {
    const tl = gen();
    expect(tl.breaks.length).toBeGreaterThanOrEqual(1);
    for (const b of tl.breaks) {
      for (const t of [b.t0 - 0.001, b.t0 - 0.5, b.t1 + 0.001, b.t1 + 0.5]) {
        if (t < 0) continue;
        expect(breakAt(tl, t)).toBeNull();
        const pose = breakPose(b, t);
        expect(pose.prop).toBeNull();
        expect(pose.raise).toBe(0);
        expect(pose.offset.x).toBe(0);
        expect(pose.offset.y).toBe(0);
      }
    }
  });

  it('the hand is away and the prop raised mid-break', () => {
    const tl = gen();
    for (const b of tl.breaks) {
      const mid = (b.t0 + b.t1) / 2;
      expect(breakAt(tl, mid)).toBe(b);
      const pose = breakPose(b, mid);
      expect(pose.prop).toBe(b.kind);
      expect(pose.raise).toBe(1);
      expect(pose.offset).toEqual({ x: -130, y: 230 }); // at the mouth
    }
  });

  it('returns to the keyboard exactly at t1 and stays there', () => {
    const tl = gen();
    for (const b of tl.breaks) {
      const pose = breakPose(b, b.t1);
      expect(pose.offset).toEqual({ x: 0, y: 0 });
      expect(pose.prop).toBeNull();
    }
  });

  it('a scaled break plays the same choreography, just faster', () => {
    const { raw, capped } = scaledPair(8);
    raw.breaks.forEach((b, i) => {
      const c = capped.breaks[i]!;
      // Same fraction → same pose, for every break, even though the seconds are different.
      for (const u of [0, 0.05, 0.3, 0.5, 0.75, 0.9, 1]) {
        const a = breakPose(b, b.t0 + (b.t1 - b.t0) * u);
        const z = breakPose(c, c.t0 + (c.t1 - c.t0) * u);
        expect(z.offset.x).toBeCloseTo(a.offset.x, 6);
        expect(z.offset.y).toBeCloseTo(a.offset.y, 6);
        expect(z.prop).toBe(a.prop);
        expect(z.raise).toBeCloseTo(a.raise, 9);
      }
      // The scaled break owns its own interval — the raw one proves nothing about the renderer.
      expect(breakAt(capped, c.t0)).toBe(c);
      expect(breakAt(capped, c.t1)).toBe(c);
    });
  });

  it('reads the stored (scaled) times, not the pre-scale ones', () => {
    const { raw, capped } = scaledPair(8);
    const rawBreak = raw.breaks[0]!;
    const t = 5.5; // inside the raw smoke break, but after every break of the squeezed timeline
    expect(t).toBeGreaterThan(rawBreak.t0);
    expect(t).toBeLessThan(rawBreak.t1);
    expect(capped.breaks.every((b) => t > b.t1)).toBe(true);
    // Choreographed on the raw seconds the hand would still be holding the cigarette…
    expect(breakPose(rawBreak, t).prop).toBe('smoke');
    // …but the renderer follows the scaled timeline, where the break is long over.
    expect(breakAt(capped, t)).toBeNull();
  });
});

describe('frames: break effects only between t0 and t1', () => {
  it('the frame before t0 and after t1 is identical to one with no breaks at all', () => {
    const tl = gen();
    const noBreaks = withoutBreaks(tl);
    for (const b of tl.breaks) {
      expect(diff(frame(tl, b.t0 - 0.02), frame(noBreaks, b.t0 - 0.02))).toBe(0);
      expect(diff(frame(tl, b.t1 + 0.02), frame(noBreaks, b.t1 + 0.02))).toBe(0);
    }
  });

  it('mid-break the hand is visibly gone from the keyboard', () => {
    const tl = gen();
    const noBreaks = withoutBreaks(tl);
    for (const b of tl.breaks) {
      const mid = (b.t0 + b.t1) / 2;
      expect(diff(frame(tl, mid), frame(noBreaks, mid))).toBeGreaterThan(500);
    }
  });

  it('renders every frame of a compressed timeline without throwing, effects still inside breaks', () => {
    const { capped } = scaledPair(8);
    const noBreaks = withoutBreaks(capped);
    for (let t = 0; t <= capped.duration; t += 1 / 30) frame(capped, t);
    for (const b of capped.breaks) {
      if (!isBreakActive(b)) continue;
      expect(diff(frame(capped, b.t0 - 0.01), frame(noBreaks, b.t0 - 0.01))).toBe(0);
      expect(diff(frame(capped, (b.t0 + b.t1) / 2), frame(noBreaks, (b.t0 + b.t1) / 2))).toBeGreaterThan(200);
      expect(diff(frame(capped, b.t1 + 0.01), frame(noBreaks, b.t1 + 0.01))).toBe(0);
    }
  });
});

describe('smoke / exhale timing', () => {
  it('stays inside the smoke break, on the scaled times', () => {
    const tl = gen();
    const smoke = tl.breaks.filter((b) => b.kind === 'smoke');
    expect(smoke.length).toBeGreaterThan(0);
    for (const b of smoke) {
      const win = exhaleWindow(b)!;
      expect(win.start).toBeGreaterThanOrEqual(b.t0);
      expect(win.end).toBeLessThanOrEqual(b.t1);

      const before = exhalePuffs();
      drawExhale(before.ctx, { ...tl, breaks: [b] }, b.t0 - 0.01, 800);
      expect(before.puffs()).toBe(0);

      const inside = exhalePuffs();
      drawExhale(inside.ctx, { ...tl, breaks: [b] }, (win.start + win.end) / 2, 800);
      expect(inside.puffs()).toBeGreaterThan(0);

      const after = exhalePuffs();
      drawExhale(after.ctx, { ...tl, breaks: [b] }, b.t1 + 0.01, 800);
      expect(after.puffs()).toBe(0);
    }
  });

  it('coffee breaks never exhale', () => {
    const tl = gen();
    for (const b of tl.breaks.filter((b) => b.kind === 'coffee')) {
      expect(exhaleWindow(b)).toBeNull();
      const c = exhalePuffs();
      for (let t = b.t0; t <= b.t1; t += (b.t1 - b.t0) / 20) drawExhale(c.ctx, { ...tl, breaks: [b] }, t, 800);
      expect(c.puffs()).toBe(0);
    }
  });

  it('a compressed smoke break exhales for its own (shorter) window, not a fixed 2.2 s', () => {
    const { raw, capped } = scaledPair(8);
    const rawSmoke = raw.breaks.find((b) => b.kind === 'smoke')!;
    const cappedSmoke = capped.breaks.find((b) => b.kind === 'smoke')!;
    const rawWin = exhaleWindow(rawSmoke)!;
    const capWin = exhaleWindow(cappedSmoke)!;
    expect(capWin.end - capWin.start).toBeLessThan(rawWin.end - rawWin.start);
    expect(capWin.end).toBeLessThanOrEqual(cappedSmoke.t1);
  });
});

describe('very short / degenerate breaks are skipped safely', () => {
  it('a break squeezed below the minimum is inactive and draws nothing', () => {
    // maxDuration just above TAIL: the factor is tiny, so the ~5 s breaks shrink to well under 0.2 s.
    const tl = gen({ maxDuration: TAIL + 0.2 });
    expect(tl.breaks.length).toBeGreaterThan(0);
    for (const b of tl.breaks) {
      expect(b.t1 - b.t0).toBeLessThan(MIN_BREAK_DURATION);
      expect(isBreakActive(b)).toBe(false);
      expect(exhaleWindow(b)).toBeNull();
      for (let t = 0; t <= tl.duration; t += 0.05) expect(breakAt(tl, t)).toBeNull();
      const c = exhalePuffs();
      drawExhale(c.ctx, tl, (b.t0 + b.t1) / 2, 800);
      expect(c.puffs()).toBe(0);
    }
  });

  it('renders a timeline whose breaks collapsed to zero length without throwing', () => {
    const tl = gen({ maxDuration: TAIL });
    expect(tl.breaks.length).toBeGreaterThan(0);
    for (const b of tl.breaks) expect(b.t1 - b.t0).toBe(0);
    for (let t = 0; t <= tl.duration; t += 1 / 30) {
      expect(() => frame(tl, t)).not.toThrow();
    }
    // …and the last frame is still a normal (break-free) frame.
    expect(diff(frame(tl, tl.duration - 0.01), frame(withoutBreaks(tl), tl.duration - 0.01))).toBe(0);
  });

  it('copes with a cap so small that the scaling factor even inverts the breaks', () => {
    // Below TAIL the send time itself becomes negative, so t1 < t0 — still no throw, no effects.
    const tl = gen({ maxDuration: TAIL / 2 });
    for (const b of tl.breaks) expect(b.t1 - b.t0).toBeLessThan(0);
    for (let t = 0; t <= tl.duration; t += 1 / 30) {
      expect(() => frame(tl, t)).not.toThrow();
    }
    expect(diff(frame(tl, tl.duration - 0.01), frame(withoutBreaks(tl), tl.duration - 0.01))).toBe(0);
  });

  it('breakPose is finite and neutral for zero-length, inverted and NaN intervals', () => {
    const bad: Break[] = [
      { kind: 'smoke', t0: 3, t1: 3 },
      { kind: 'coffee', t0: 4, t1: 2 },
      { kind: 'smoke', t0: Number.NaN, t1: Number.NaN },
      { kind: 'smoke', t0: 0, t1: Number.POSITIVE_INFINITY },
    ];
    for (const b of bad) {
      expect(isBreakActive(b)).toBe(false);
      for (const t of [0, 2, 3, 4, Number.NaN]) {
        const pose = breakPose(b, t);
        expect(Number.isFinite(pose.offset.x)).toBe(true);
        expect(Number.isFinite(pose.offset.y)).toBe(true);
        expect(pose.prop).toBeNull();
        expect(pose.raise).toBe(0);
      }
      expect(exhaleWindow(b)).toBeNull();
    }
  });
});

describe('other modes are unaffected', () => {
  it('normal mode has no breaks, so no departure or smoke is ever drawn', () => {
    const tl = generateTimeline({ text: TEXT, mode: 'normal', seed: 4, lang: 'en' });
    expect(tl.breaks).toEqual([]);
    const c = exhalePuffs();
    for (let t = 0; t <= tl.duration; t += 0.5) {
      expect(breakAt(tl, t)).toBeNull();
      drawExhale(c.ctx, tl, t, 800);
    }
    expect(c.puffs()).toBe(0);
  });
});
