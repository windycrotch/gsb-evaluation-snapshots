import { charKey, letterRows, pageChars } from '../keyboard/layout';
import { KeyboardSim, type Press } from '../keyboard/sim';
import { splitGraphemes } from './graphemes';
import { createRng, range } from './prng';
import { MAX_CHARS } from './limits';
import type { Break, Mode, Timeline, TimelineEvent, TimelineOptions } from './types';

/** Delay before the first key press, s. */
export const LEAD_IN = 0.8;
/**
 * How long the video lasts after sending, s: ~1.4 s to read the sent message
 * plus the end card (END_CARD) with the site link.
 */
export const TAIL = 2.6;
/** Duration of the “Make your own → pleasejusttext.me” end card, s (part of TAIL). */
export const END_CARD = 1.2;
export const DEFAULT_MAX_DURATION = 60;

type Span = [number, number];

interface Profile {
  /** Pause after a letter key. */
  key: Span;
  /** Extra pause after a space or punctuation. */
  word: Span;
  /** Pause after a modifier key (shift, 123, 🌐). */
  switch: Span;
  /** Probability of a typo on a letter. */
  typo: number;
  /** Probability of “hunting” for a letter by hovering over others first. */
  hover: number;
  /** Probability of erasing everything and retyping before sending. */
  eraseAll: number;
}

const PROFILES: Record<Mode, Profile> = {
  normal: { key: [0.09, 0.2], word: [0.05, 0.3], switch: [0.1, 0.25], typo: 0, hover: 0, eraseAll: 0 },
  grandpa: { key: [0.5, 1.1], word: [0.6, 1.6], switch: [0.6, 1.4], typo: 0, hover: 0.6, eraseAll: 0 },
  typos: { key: [0.07, 0.15], word: [0.03, 0.2], switch: [0.08, 0.18], typo: 0.12, hover: 0, eraseAll: 0.3 },
  // Long nails: a bit slower and careful, but now and then a nail catches the neighbouring key.
  manicure: { key: [0.12, 0.26], word: [0.08, 0.35], switch: [0.14, 0.3], typo: 0.05, hover: 0, eraseAll: 0 },
  // Types like normal, but keeps stepping away for coffee or a smoke (see planBreaks).
  breaks: { key: [0.09, 0.2], word: [0.05, 0.3], switch: [0.1, 0.25], typo: 0, hover: 0, eraseAll: 0 },
};

/** Break length, s: enough to leave, take a sip / a drag and come back. */
const BREAK_LEN: Record<Break['kind'], Span> = { coffee: [4.6, 5.4], smoke: [5.4, 6.4] };

/**
 * After how many typed graphemes to take a break: 1 break for short replies, up to 3 for long ones,
 * spread evenly and snapped to the nearest word boundary (people pause between words).
 */
function planBreaks(graphemes: string[]): number[] {
  const n = graphemes.length;
  const count = n < 20 ? 1 : n < 70 ? 2 : 3;
  const spaces = graphemes.flatMap((g, i) => (g === ' ' ? [i + 1] : []));
  const at = new Set<number>();
  for (let k = 1; k <= count; k++) {
    const ideal = Math.round((n * k) / (count + 1));
    const snapped = spaces.reduce((best, p) => (Math.abs(p - ideal) < Math.abs(best - ideal) ? p : best), Infinity);
    at.add(Math.abs(snapped - ideal) <= 8 ? snapped : Math.min(n, Math.max(1, ideal)));
  }
  return [...at];
}

const WORD_BREAK = /[\s.,!?;:—-]/;

export function generateTimeline(opts: TimelineOptions): Timeline {
  const { mode, seed, lang, maxDuration = DEFAULT_MAX_DURATION } = opts;
  const rng = createRng(seed);
  const profile = PROFILES[mode];
  const events: TimelineEvent[] = [];
  const graphemes = splitGraphemes(opts.text.replace(/\s+/g, ' ').trim()).slice(0, MAX_CHARS[mode]);
  const sim = new KeyboardSim(KeyboardSim.langsFor(graphemes, lang));
  const pick = <T>(arr: readonly T[]): T => arr[Math.floor(rng() * arr.length)]!;

  let t = LEAD_IN;
  const breaks: Break[] = [];
  const breakAt = mode === 'breaks' ? planBreaks(graphemes) : [];
  /** Alternates coffee and smoke, starting with a random one (rng only in this mode: other modes stay as they were). */
  let nextKind: Break['kind'] = breakAt.length && rng() < 0.5 ? 'coffee' : 'smoke';
  const takeBreak = () => {
    t += range(rng, 0.25, 0.5);
    const t0 = t;
    t += range(rng, ...BREAK_LEN[nextKind]);
    breaks.push({ kind: nextKind, t0, t1: t });
    nextKind = nextKind === 'coffee' ? 'smoke' : 'coffee';
    t += range(rng, 0.3, 0.5);
  };

  const emit = (p: Press, quick = false) => {
    events.push({ t, type: 'press', ...p });
    if (quick) {
      t += range(rng, 0.08, 0.14); // double tap on ⇧
    } else if (p.effect.kind === 'insert') {
      t += range(rng, ...profile.key);
      if (WORD_BREAK.test(p.effect.text)) t += range(rng, ...profile.word);
    } else if (p.effect.kind === 'delete') {
      t += range(rng, 0.1, 0.18);
    } else {
      t += range(rng, ...profile.switch);
    }
  };

  const emitAll = (presses: Press[]) => {
    presses.forEach((p, i) => {
      if (p.key.startsWith('c:') && rng() < profile.hover) searchFor(p);
      emit(p, p.key === 'shift' && presses[i + 1]?.key === 'shift');
    });
  };

  /** Grandpa hovers over random keys before finding the right one. */
  const searchFor = (p: Press) => {
    const candidates = [...pageChars(p.kb.lang, p.kb.page)];
    const n = 1 + Math.floor(rng() * 2);
    for (let i = 0; i < n; i++) {
      events.push({ t, type: 'hover', key: charKey(pick(candidates)), kb: p.kb });
      t += range(rng, 0.3, 0.7);
    }
  };

  /** Types the whole text; with typos if `withTypos` is set and the mode allows them. */
  const typeText = (withTypos: boolean) => {
    let noTyposUntil = withTypos ? -1 : Infinity;
    let i = 0;
    while (i < graphemes.length) {
      const presses = sim.type(graphemes[i]!, graphemes[i + 1]);
      const last = presses[presses.length - 1]!;
      const typo = i > noTyposUntil && rng() < profile.typo && makeTypo(last, pick);
      emitAll(presses);
      if (!typo) {
        i++;
        if (breakAt.includes(i) && breaks.length < breakAt.length) takeBreak();
        continue;
      }
      // Type 0–3 more graphemes, notice, erase, retype without typos.
      const extra = Math.min(Math.floor(rng() * 4), graphemes.length - 1 - i);
      for (let j = 1; j <= extra; j++) emitAll(sim.type(graphemes[i + j]!, graphemes[i + j + 1]));
      t += range(rng, 0.3, 0.8);
      for (let j = 0; j <= extra; j++) emit(sim.backspace());
      t += range(rng, 0.1, 0.3);
      noTyposUntil = i + extra;
    }
  };

  typeText(profile.typo > 0);

  if (graphemes.length >= 8 && rng() < profile.eraseAll) {
    // “Nah, not like that”: hold backspace, erase everything, type it again.
    t += range(rng, 0.8, 1.6);
    for (let i = 0; i < graphemes.length; i++) {
      events.push({ t, type: 'press', ...sim.backspace() });
      t += Math.max(0.04, 0.14 - i * 0.02);
    }
    t += range(rng, 0.5, 1);
    typeText(false);
  }

  t += range(rng, 0.2, 0.5);
  events.push({ t, type: 'send', kb: { ...sim.state } });

  // Fit the length: no shorter than the voice message, no longer than the cap. The tail is not stretched.
  const voiceSeconds = opts.voiceSeconds ?? Math.round(range(rng, 20, 95));
  const minDuration = Math.min(opts.voiceSeconds ?? 0, maxDuration);
  let duration = t + TAIL;
  const target = duration < minDuration ? minDuration : duration > maxDuration ? maxDuration : duration;
  if (target !== duration) {
    const factor = (target - TAIL) / t;
    for (const e of events) e.t *= factor;
    for (const b of breaks) {
      b.t0 *= factor;
      b.t1 *= factor;
    }
    duration = target;
  }

  return { events, duration, mode, breaks, lang, voiceSeconds };
}

/** Replaces the last press with a neighbouring key. Returns true on success. */
function makeTypo(last: Press, pick: <T>(arr: readonly T[]) => T): boolean {
  if (last.effect.kind !== 'insert' || last.kb.page !== 'letters' || !last.key.startsWith('c:')) return false;
  const rows = letterRows(last.kb.lang);
  const ch = last.key.slice(2);
  const r = rows.findIndex((row) => row.includes(ch));
  if (r < 0) return false;
  const c = rows[r]!.indexOf(ch);
  const neighbours = [rows[r]![c - 1], rows[r]![c + 1], rows[r - 1]?.[c], rows[r + 1]?.[c]].filter(
    (x): x is string => !!x,
  );
  if (!neighbours.length) return false;
  const nb = pick(neighbours);
  const upper = last.effect.text !== last.effect.text.toLocaleLowerCase();
  last.key = charKey(nb);
  last.effect = { kind: 'insert', text: upper ? nb.toLocaleUpperCase() : nb };
  return true;
}
