export type Lang = 'en' | 'ru' | 'es' | 'fr';
/** Order matters: when looking up a layout for a “foreign” character, languages are tried in this order. */
export const LANGS: readonly Lang[] = ['en', 'ru', 'es', 'fr'];

export const isLang = (x: unknown): x is Lang => typeof x === 'string' && (LANGS as readonly string[]).includes(x);

/** Language names in their own language — for the switcher. */
export const LANG_NAMES: Record<Lang, string> = { en: 'English', ru: 'Русский', es: 'Español', fr: 'Français' };

/**
 * Site language. Priority: `?lang=xx` in the URL → choice saved by the switcher →
 * the browser’s primary language (if supported) → English.
 */
export function detectLang(search: string, languages: readonly string[], stored?: string | null): Lang {
  const forced = new URLSearchParams(search).get('lang');
  if (isLang(forced)) return forced;
  if (isLang(stored)) return stored;
  const primary = languages[0]?.toLowerCase().split('-')[0] ?? '';
  return isLang(primary) ? primary : 'en';
}

/** Strings drawn inside the video. */
export interface VideoStrings {
  placeholder: string;
  delivered: string;
  /** Label on the “back to letters” key. */
  lettersKey: string;
  spaceKey: string;
  returnKey: string;
  /** End card caption above the site address. */
  cta: string;
}

export const VIDEO_STRINGS: Record<Lang, VideoStrings> = {
  en: {
    placeholder: 'Message',
    delivered: 'Delivered',
    lettersKey: 'ABC',
    spaceKey: 'space',
    returnKey: 'return',
    cta: 'Make your own',
  },
  ru: {
    placeholder: 'Сообщение',
    delivered: 'Доставлено',
    lettersKey: 'АБВ',
    spaceKey: 'Пробел',
    returnKey: 'Ввод',
    cta: 'Сделай такой же ответ',
  },
  es: {
    placeholder: 'Mensaje',
    delivered: 'Entregado',
    lettersKey: 'ABC',
    spaceKey: 'espacio',
    returnKey: 'intro',
    cta: 'Haz el tuyo',
  },
  fr: {
    placeholder: 'Message',
    delivered: 'Distribué',
    lettersKey: 'ABC',
    spaceKey: 'espace',
    returnKey: 'retour',
    cta: 'Fais le tien',
  },
};

export { UI_STRINGS, type UiKey } from './ui';
