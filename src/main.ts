import './style.css';
import { loadWebAnalytics, setCommonProps, track, trackErrors } from './analytics';
import { renderVoiceRain } from './background';
import { chromeIntentUrl, isAndroid, isInAppBrowser } from './inapp';
import { UnsupportedError } from './encode/errors';
import { detectLang, isLang, UI_STRINGS, type Lang, type UiKey } from './i18n';
import { canShareFile, shareOrDownload } from './share/share';
import { splitGraphemes } from './timeline/graphemes';
import { MAX_CHARS, MAX_CHARS_ANY } from './timeline/limits';
import type { Mode } from './timeline/types';

/**
 * The video module (renderer + Mediabunny + fonts) loads separately: the page opens instantly
 * and the module is fetched in the background — once the user starts typing or the browser is idle.
 */
let videoModule: Promise<typeof import('./video')> | null = null;
const loadVideoModule = () => {
  videoModule ??= import('./video').catch((err) => {
    videoModule = null; // network hiccup — retry on the next click
    throw err;
  });
  return videoModule;
};
const prefetchVideo = () => {
  void loadVideoModule().catch(() => {});
  void import('./fonts').then((m) => m.loadFonts());
};

const LANG_KEY = 'pjt.lang';
const storage = {
  get: (k: string) => {
    try {
      return localStorage.getItem(k);
    } catch {
      return null; // private mode / blocked storage — just don't remember
    }
  },
  set: (k: string, v: string) => {
    try {
      localStorage.setItem(k, v);
    } catch {
      /* see above */
    }
  },
};

let lang: Lang = detectLang(location.search, navigator.languages ?? [navigator.language], storage.get(LANG_KEY));
let ui = UI_STRINGS[lang];

const canonical = document.createElement('link');
canonical.rel = 'canonical';
document.head.appendChild(canonical);

/** Translates the page in place: index.html is authored in English, texts are marked with data-i18n. */
function applyLang(next: Lang) {
  lang = next;
  ui = UI_STRINGS[lang];
  document.documentElement.lang = lang;
  document.title = ui.metaTitle;
  document.querySelector('meta[name="description"]')?.setAttribute('content', ui.metaDescription);
  // Canonical: the main URL, or its own ?lang=xx URL (listed via hreflang in index.html).
  const inUrl = new URLSearchParams(location.search).get('lang');
  canonical.href = `https://pleasejusttext.me/${inUrl === lang ? `?lang=${lang}` : ''}`;
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n]')) {
    el.textContent = ui[el.dataset.i18n as UiKey];
  }
  for (const el of document.querySelectorAll<HTMLTextAreaElement>('[data-i18n-placeholder]')) {
    el.placeholder = ui[el.dataset.i18nPlaceholder as UiKey];
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-i18n-aria]')) {
    el.setAttribute('aria-label', ui[el.dataset.i18nAria as UiKey]);
  }
  const code = document.getElementById('lang-code');
  if (code) code.textContent = lang.toUpperCase();
  setCommonProps({ lang });
}
applyLang(lang);

// Not at startup: page first, heavy stuff later. Focusing the input is a strong hint a video is coming.
if ('requestIdleCallback' in window) requestIdleCallback(prefetchVideo, { timeout: 4000 });
else setTimeout(prefetchVideo, 2500);
renderVoiceRain(document.getElementById('voice-rain')!);

trackErrors();
loadWebAnalytics(import.meta.env.VITE_CF_BEACON_TOKEN);
track('view');

// Social app in-app browser: suggest opening a real browser (on Android, a direct Open in Chrome button).
if (isInAppBrowser(navigator.userAgent)) {
  document.getElementById('inapp')!.hidden = false;
  if (isAndroid(navigator.userAgent)) {
    const btn = document.getElementById('open-chrome') as HTMLAnchorElement;
    btn.href = chromeIntentUrl(location.href);
    btn.hidden = false;
  }
}
document.querySelector('.why')?.addEventListener('click', () => track('why_click'));

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const form = $<HTMLFormElement>('form');
const textEl = $<HTMLTextAreaElement>('text');
const modeEl = $<HTMLSelectElement>('mode');
const counterEl = $<HTMLSpanElement>('counter');
const limitHintEl = $<HTMLParagraphElement>('limit-hint');
const renderBtn = $<HTMLButtonElement>('render');
const langEl = $<HTMLSelectElement>('lang');

const sheet = $<HTMLDialogElement>('sheet');
const sheetTitle = $<HTMLHeadingElement>('sheet-title');
const sheetCloseBtn = $<HTMLButtonElement>('sheet-close');
const sheetMedia = sheet.querySelector<HTMLElement>('.sheet-media')!;
const sheetProgress = $<HTMLElement>('sheet-progress');
const sheetPct = $<HTMLElement>('sheet-pct');
const sheetBar = $<HTMLElement>('sheet-bar');
const sheetNote = $<HTMLParagraphElement>('sheet-note');
const previewEl = $<HTMLVideoElement>('preview');
const shareBtn = $<HTMLButtonElement>('share');
const shareHint = $<HTMLParagraphElement>('share-hint');
const secondaryBtn = $<HTMLButtonElement>('sheet-secondary');

let current: { blob: Blob; url: string; mode: Mode } | null = null;
let rendering = false;
let overLimit = false;
let abort: AbortController | null = null;

/**
 * Limits count graphemes, not UTF-16 units (maxlength would count an emoji as 2–11 chars).
 * The global maximum is enforced by truncation; the per-mode limit (grandpa) is only highlighted,
 * so switching modes back doesn't lose text.
 */
function updateLimit() {
  let g = splitGraphemes(textEl.value);
  if (g.length > MAX_CHARS_ANY) {
    g = g.slice(0, MAX_CHARS_ANY);
    textEl.value = g.join('');
  }
  const limit = MAX_CHARS[modeEl.value as Mode];
  const wasOver = overLimit;
  overLimit = g.length > limit;
  if (overLimit && !wasOver) track('limit_hit', { mode: modeEl.value, chars: g.length });
  counterEl.textContent = `${g.length}/${limit}`;
  counterEl.classList.toggle('over', overLimit);
  limitHintEl.hidden = !overLimit;
  const tooLong = modeEl.value === 'breaks' ? ui.breaksTooLong : ui.grandpaTooLong;
  limitHintEl.textContent = overLimit ? tooLong.replace('{n}', String(limit)) : '';
  renderBtn.disabled = rendering || overLimit;
}
textEl.addEventListener('input', updateLimit);
textEl.addEventListener('focus', prefetchVideo, { once: true });
modeEl.addEventListener('change', () => {
  track('mode_change', { mode: modeEl.value });
  updateLimit();
});
updateLimit();

// ——— Result sheet: rendering (progress + Cancel) → ready (video + Send) | error ———

type SheetState = { kind: 'rendering'; progress: number } | { kind: 'ready' } | { kind: 'error'; unsupported: boolean };
let sheetState: SheetState | null = null;

function renderSheet() {
  const st = sheetState;
  if (!st) return;
  const isRendering = st.kind === 'rendering';
  const isReady = st.kind === 'ready';

  sheetTitle.textContent = isRendering ? ui.renderingTitle : isReady ? ui.videoReady : ui.failed;
  sheetMedia.hidden = st.kind === 'error';
  sheetProgress.hidden = !isRendering;
  previewEl.hidden = !isReady;
  if (isRendering) setProgress(st.progress);

  const note = isRendering ? ui.rendering : st.kind === 'error' && st.unsupported ? ui.unsupported : '';
  sheetNote.textContent = note;
  sheetNote.hidden = !note;

  shareBtn.hidden = shareHint.hidden = !isReady;
  if (isReady && current) {
    const canShare = canShareFile(current.blob);
    shareBtn.textContent = canShare ? ui.share : ui.download;
    shareHint.textContent = canShare ? ui.shareHint : ui.downloadHint;
  }
  secondaryBtn.textContent = isRendering ? ui.cancel : isReady ? ui.makeAnother : ui.close;
}

let lastPct = -1;
function setProgress(fraction: number) {
  const pct = Math.round(fraction * 100);
  if (pct === lastPct) return; // onProgress fires on every frame
  lastPct = pct;
  sheetPct.textContent = `${pct}%`;
  sheetBar.style.width = `${pct}%`;
  sheetProgress.setAttribute('aria-valuenow', String(pct));
}

function openSheet(state: SheetState) {
  sheetState = state;
  lastPct = -1;
  renderSheet();
  document.documentElement.classList.add('modal-open');
  if (!sheet.open) sheet.showModal();
}

// Closing by any means (×, Cancel, Esc) aborts an in-progress render.
sheet.addEventListener('close', () => {
  abort?.abort();
  sheetState = null;
  previewEl.pause();
  document.documentElement.classList.remove('modal-open');
});
sheetCloseBtn.addEventListener('click', () => sheet.close());
secondaryBtn.addEventListener('click', () => {
  const makeAnother = sheetState?.kind === 'ready';
  sheet.close();
  if (makeAnother) textEl.focus();
});

// Language switcher: translate without reloading (text, mode and the finished video stay),
// remember the choice and put ?lang= in the URL so reloads and shared links keep the language.
langEl.value = lang;
langEl.addEventListener('change', () => {
  const next = langEl.value;
  if (!isLang(next) || next === lang) return;
  const prev = lang;
  storage.set(LANG_KEY, next);
  const url = new URL(location.href);
  url.searchParams.set('lang', next);
  history.replaceState(null, '', url);
  applyLang(next);
  updateLimit();
  renderSheet();
  track('lang_change', { result: prev });
});

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const text = textEl.value.trim();
  if (!text || overLimit || rendering) return;

  rendering = true;
  renderBtn.disabled = true;
  const controller = new AbortController();
  abort = controller;
  openSheet({ kind: 'rendering', progress: 0 });

  const mode = modeEl.value as Mode;
  const chars = splitGraphemes(text).length;
  const started = performance.now();
  track('render_start', { mode, chars });

  try {
    const { makeVideo } = await loadVideoModule();
    const { blob, duration } = await makeVideo(text, lang, mode, setProgress, controller.signal);

    if (current) URL.revokeObjectURL(current.url);
    current = { blob, url: URL.createObjectURL(blob), mode };
    previewEl.src = current.url;
    track('render_done', {
      mode,
      chars,
      ms: Math.round(performance.now() - started),
      sec: Math.round(duration),
      kb: Math.round(blob.size / 1024),
    });
    if (sheet.open) {
      sheetState = { kind: 'ready' };
      renderSheet();
      void previewEl.play().catch(() => {}); // muted autoplay is allowed, but just in case
    }
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      track('render_cancel', { mode, chars, ms: Math.round(performance.now() - started) });
      return;
    }
    console.error(err);
    const unsupported = err instanceof UnsupportedError;
    track('render_fail', { mode, chars, result: unsupported ? 'unsupported' : 'error' });
    if (sheet.open) {
      sheetState = { kind: 'error', unsupported };
      renderSheet();
    }
  } finally {
    if (abort === controller) abort = null;
    rendering = false;
    updateLimit();
  }
});

// Separate button: share must be called from a user gesture.
shareBtn.addEventListener('click', async () => {
  if (!current) return;
  const { mode } = current;
  track('share_click', { mode });
  const result = await shareOrDownload(current.blob, 'reply.mp4');
  track('share_result', { mode, result });
});
