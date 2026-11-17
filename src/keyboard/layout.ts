import type { Lang } from '../i18n';

/**
 * iOS-like layouts. Pure data + geometry, no DOM:
 * used both by the timeline generator (what to press) and the renderer (where to draw).
 */
export type Page = 'letters' | 'symbols' | 'symbols2';

export type SpecialKey =
  | 'shift'
  | 'backspace'
  | 'to-letters'
  | 'to-symbols'
  | 'to-symbols2'
  | 'globe'
  | 'space'
  | 'return'
  | 'emoji';

/** A character key id is `c:<char>`, a special key id is its name. */
export type KeyId = SpecialKey | `c:${string}`;

export const charKey = (c: string): KeyId => `c:${c}`;

interface KeySpec {
  id: KeyId;
  /** Width in units (1 = a regular letter). */
  w: number;
}

const LETTER_ROWS: Record<Lang, string[]> = {
  en: ['qwertyuiop', 'asdfghjkl', 'zxcvbnm'],
  ru: ['йцукенгшщзх', 'фывапролджэ', 'ячсмитьбю'],
  es: ['qwertyuiop', 'asdfghjklñ', 'zxcvbnm'],
  fr: ['azertyuiop', 'qsdfghjklm', "wxcvbn'"],
};

const CURRENCY: Record<Lang, string> = { en: '$', ru: '₽', es: '€', fr: '€' };

const chars = (s: string, w = 1): KeySpec[] => Array.from(s, (c) => ({ id: charKey(c), w }));

/** Key rows of a page (without the bottom row with the space bar). */
function pageRows(lang: Lang, page: Page): KeySpec[][] {
  switch (page) {
    case 'letters': {
      const [r1, r2, r3] = LETTER_ROWS[lang] as [string, string, string];
      return [
        chars(r1),
        chars(r2),
        [{ id: 'shift', w: 1.4 }, ...chars(r3), { id: 'backspace', w: 1.4 }],
      ];
    }
    case 'symbols':
      return [
        chars('1234567890'),
        chars(`-/:;()${CURRENCY[lang]}&@"`),
        [{ id: 'to-symbols2', w: 1.4 }, ...chars(".,?!'", 1.4), { id: 'backspace', w: 1.4 }],
      ];
    case 'symbols2':
      return [
        chars('[]{}#%^*+='),
        chars('_\\|~<>€£¥•'),
        [{ id: 'to-symbols', w: 1.4 }, ...chars(".,?!'", 1.4), { id: 'backspace', w: 1.4 }],
      ];
  }
}

/** Character rows of the letters page — used to pick a “neighbouring” key for typos. */
export function letterRows(lang: Lang): string[][] {
  return LETTER_ROWS[lang].map((r) => Array.from(r));
}

/** All characters available on a page. */
export function pageChars(lang: Lang, page: Page): Set<string> {
  const set = new Set<string>();
  for (const row of pageRows(lang, page)) {
    for (const k of row) if (k.id.startsWith('c:')) set.add(k.id.slice(2));
  }
  return set;
}

export interface KeyRect {
  id: KeyId;
  x: number;
  y: number;
  w: number;
  h: number;
}

/**
 * Keyboard geometry in pixels relative to its top-left corner.
 * 4 rows of keys + a bottom strip with the emoji key, like on an iPhone.
 */
export function keyboardGeometry(lang: Lang, page: Page, width: number, height: number): KeyRect[] {
  const rows = pageRows(lang, page);
  const baseUnits = Math.max(...rows.map((r) => r.reduce((s, k) => s + (k.w === 1 ? 1 : 0), 0)), 10);
  const padX = width * 0.01;
  const innerW = width - padX * 2;
  const unit = innerW / baseUnits;
  const gap = unit * 0.14;

  const barH = height * 0.26;
  const rowH = (height - barH) / 4;
  const keyH = rowH * 0.8;
  const rects: KeyRect[] = [];

  rows.forEach((row, ri) => {
    const units = row.reduce((s, k) => s + k.w, 0);
    const u = Math.min(unit, innerW / units);
    let x = padX + (innerW - units * u) / 2;
    const y = ri * rowH + (rowH - keyH) / 2;
    for (const k of row) {
      rects.push({ id: k.id, x: x + gap / 2, y, w: k.w * u - gap, h: keyH });
      x += k.w * u;
    }
  });

  // Bottom row: [123/ABC] [🌐] [ space ] [return]
  const y4 = 3 * rowH + (rowH - keyH) / 2;
  const bottom: { id: KeyId; frac: number }[] = [
    { id: page === 'letters' ? 'to-symbols' : 'to-letters', frac: 0.12 },
    { id: 'globe', frac: 0.12 },
    { id: 'space', frac: 0.52 },
    { id: 'return', frac: 0.24 },
  ];
  let x = padX;
  for (const b of bottom) {
    const w = innerW * b.frac;
    rects.push({ id: b.id, x: x + gap / 2, y: y4, w: w - gap, h: keyH });
    x += w;
  }

  // Strip below the keyboard (where the iPhone home indicator lives): emoji on the left
  const e = Math.min(keyH, barH * 0.45);
  rects.push({ id: 'emoji', x: padX + unit * 0.3, y: 4 * rowH + barH * 0.1, w: e, h: e });

  return rects;
}
