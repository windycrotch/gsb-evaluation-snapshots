import { LANGS, type Lang } from '../i18n';
import { charKey, pageChars, type KeyId, type Page } from './layout';

export interface KeyboardState {
  lang: Lang;
  page: Page;
  /** Next letter is uppercase (⇧ is lit). Also true while capsLock is on. */
  shift: boolean;
  /** Caps Lock (double tap on ⇧): uppercase until turned off. */
  capsLock: boolean;
}

const isUpper = (c: string) => c !== c.toLocaleLowerCase();

/** What a press does to the text. */
export type Effect = { kind: 'insert'; text: string } | { kind: 'delete' } | { kind: 'none' };

/** One physical press: which key, on which keyboard page, and how the text changed. */
export interface Press {
  key: KeyId;
  /** Keyboard state AT THE MOMENT of the press (the renderer needs it to locate the key). */
  kb: KeyboardState;
  effect: Effect;
}

const PAGES: Page[] = ['letters', 'symbols', 'symbols2'];

/** iOS-style long press: ё on е, ¿ on ?, « on " and so on (é → e and ñ → n are handled via NFD below). */
const ALIASES: Record<string, string> = {
  ё: 'е',
  ъ: 'ь',
  '¿': '?',
  '¡': '!',
  '«': '"',
  '»': '"',
  '“': '"',
  '”': '"',
  '„': '"',
  '’': "'",
  '‘': "'",
  '…': '.',
  '—': '-',
  '–': '-',
  œ: 'o',
  æ: 'a',
};

function baseChar(c: string): string {
  if (ALIASES[c]) return ALIASES[c];
  const stripped = c.normalize('NFD').replace(/\p{M}/gu, '');
  return stripped.length === 1 ? stripped : c;
}

/**
 * Where to find a character: language + page + whether shift is needed + which key to press.
 * Languages are tried in `langs` order, current one first: digits, punctuation and accented
 * letters (long press) exist almost everywhere, so we don’t switch layouts for them.
 */
export function locate(c: string, langs: readonly Lang[]): { lang: Lang; page: Page; shift: boolean; key: string } | null {
  const lower = c.toLocaleLowerCase();
  const isUpper = lower !== c;
  const candidates = [lower, baseChar(lower)];
  for (const lang of langs) {
    for (const page of PAGES) {
      const set = pageChars(lang, page);
      for (const cand of candidates) {
        if (set.has(cand)) return { lang, page, shift: isUpper && page === 'letters', key: cand };
      }
    }
  }
  return null;
}

/**
 * Step-by-step keyboard model: turns text characters into a sequence of presses
 * (shift, page and layout switches), tracking its own state.
 */
export class KeyboardSim {
  state: KeyboardState;
  /** Layouts “enabled” on the phone; 🌐 cycles through them. */
  readonly langs: readonly Lang[];

  constructor(langs: readonly Lang[]) {
    this.langs = langs;
    this.state = { lang: langs[0]!, page: 'letters', shift: false, capsLock: false };
  }

  private press(key: KeyId, effect: Effect = { kind: 'none' }): Press {
    const p: Press = { key, kb: { ...this.state }, effect };
    this.apply(key, effect);
    return p;
  }

  private apply(key: KeyId, effect: Effect): void {
    const s = this.state;
    switch (key) {
      case 'shift':
        if (s.capsLock) s.capsLock = s.shift = false;
        else s.shift = !s.shift;
        return;
      case 'to-letters':
        s.page = 'letters';
        return;
      case 'to-symbols':
        s.page = 'symbols';
        return;
      case 'to-symbols2':
        s.page = 'symbols2';
        return;
      case 'globe':
        s.lang = this.langs[(this.langs.indexOf(s.lang) + 1) % this.langs.length]!;
        s.page = 'letters';
        return;
      case 'space':
        // Like iOS: after a space the keyboard returns to letters.
        s.page = 'letters';
        return;
    }
    if (effect.kind === 'insert' && s.page === 'letters' && !s.capsLock) s.shift = false;
  }

  /**
   * Presses needed to type grapheme `g`. `next` is the following grapheme: for a run of
   * uppercase letters we enable Caps Lock with a double tap, like on an iPhone.
   */
  type(g: string, next?: string): Press[] {
    if (g === ' ') return [this.press('space', { kind: 'insert', text: ' ' })];

    const cur = this.langs.indexOf(this.state.lang);
    const loc = locate(g, [...this.langs.slice(cur), ...this.langs.slice(0, cur)]);
    if (!loc) {
      // Emoji and anything unknown go through the emoji key.
      return [this.press('emoji', { kind: 'insert', text: g })];
    }

    const presses: Press[] = [];
    while (this.state.lang !== loc.lang) presses.push(this.press('globe'));
    if (this.state.page !== loc.page) {
      if (loc.page === 'letters') presses.push(this.press('to-letters'));
      else {
        if (this.state.page === 'letters') presses.push(this.press('to-symbols'));
        if (loc.page === 'symbols2') presses.push(this.press('to-symbols2'));
        else if (this.state.page === 'symbols2') presses.push(this.press('to-symbols'));
      }
    }
    if (this.state.page === 'letters') presses.push(...this.shiftFor(loc.shift, next));
    presses.push(this.press(charKey(loc.key), { kind: 'insert', text: g }));
    return presses;
  }

  /** Bring ⇧ / Caps Lock to the required case. */
  private shiftFor(upper: boolean, next: string | undefined): Press[] {
    const s = this.state;
    if (!upper) return s.shift ? [this.press('shift')] : [];
    if (s.capsLock) return [];
    const run = next !== undefined && isUpper(next);
    if (!run) return s.shift ? [] : [this.press('shift')];
    const presses = s.shift ? [] : [this.press('shift')];
    // Second tap on ⇧ — Caps Lock.
    presses.push({ key: 'shift', kb: { ...s }, effect: { kind: 'none' } });
    s.capsLock = s.shift = true;
    return presses;
  }

  /**
   * Layouts needed to type the text: the site language plus any without which some
   * character can’t be typed (e.g. Cyrillic on the English site).
   */
  static langsFor(graphemes: readonly string[], siteLang: Lang): Lang[] {
    const langs: Lang[] = [siteLang];
    for (const g of graphemes) {
      if (locate(g, langs)) continue;
      const loc = locate(g, LANGS);
      if (loc && !langs.includes(loc.lang)) langs.push(loc.lang);
    }
    return langs;
  }

  backspace(): Press {
    return this.press('backspace', { kind: 'delete' });
  }
}
