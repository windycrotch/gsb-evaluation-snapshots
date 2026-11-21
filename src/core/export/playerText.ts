/**
 * The words of the player page, in the two languages of the editor. The page is one file that goes to people who never saw the editor, so it
 * chooses its language by itself from the language of the browser that opens it (Russian when that is Russian, English for everything else).
 * Pure: the player script and the tests read the same table.
 */

export type PlayerLang = 'en' | 'ru';

const en = {
  play: 'Play',
  pause: 'Pause',
  background: 'Background',
  backgroundTip: 'Light or dark background',
  comment: 'Comment',
  commentTip: 'Put a comment on this moment of the animation',
  send: 'Send comments ({n})',
  sendTip: 'Download your comments as a file to send to the animator',
  close: 'Close',
  addComment: 'Add comment',
  yourName: 'Your name',
  whatShould: 'What should change here?',
  animation: 'Animation',
  skin: 'Skin',
  defaultSkin: 'default',
  dialogLabel: 'Comment',
  boneHint: 'Click a bone in the picture to point the comment at it',
  bone: 'Bone: {name}',
  clearBone: 'Do not point at a bone',
  couldNotStart: 'Could not start the player: {message}',
} as const;

export type PlayerKey = keyof typeof en;

const ru: Record<PlayerKey, string> = {
  play: 'Играть',
  pause: 'Пауза',
  background: 'Фон',
  backgroundTip: 'Светлый или тёмный фон',
  comment: 'Комментарий',
  commentTip: 'Оставить комментарий на этом моменте анимации',
  send: 'Отправить комментарии ({n})',
  sendTip: 'Скачать комментарии файлом, чтобы отправить аниматору',
  close: 'Закрыть',
  addComment: 'Добавить комментарий',
  yourName: 'Ваше имя',
  whatShould: 'Что здесь нужно изменить?',
  animation: 'Анимация',
  skin: 'Скин',
  defaultSkin: 'по умолчанию',
  dialogLabel: 'Комментарий',
  boneHint: 'Щёлкните кость на картинке, чтобы указать на неё в комментарии',
  bone: 'Кость: {name}',
  clearBone: 'Не указывать кость',
  couldNotStart: 'Не удалось запустить плеер: {message}',
};

export const PLAYER_TEXTS: Record<PlayerLang, Record<PlayerKey, string>> = { en, ru };

/** The language of the page for the language of the browser (`navigator.language`, `ru`, `ru-RU`, `RU_ru`…). */
export function playerLang(browserLanguage: string | null | undefined): PlayerLang {
  return typeof browserLanguage === 'string' && /^ru(?![a-z])/i.test(browserLanguage.trim()) ? 'ru' : 'en';
}

/** A text of the page in a language, with `{name}` places filled in. */
export function playerText(lang: PlayerLang, key: PlayerKey, vars: Record<string, string | number> = {}): string {
  return PLAYER_TEXTS[lang][key].replace(/\{(\w+)\}/g, (_, name: string) => (name in vars ? String(vars[name]) : `{${name}}`));
}
