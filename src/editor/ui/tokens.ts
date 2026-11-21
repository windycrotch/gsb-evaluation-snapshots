/**
 * The design tokens (src/styles/tokens.css) for code that draws on a canvas.
 *
 * A canvas cannot use `var(--accent)`, so the viewport overlay, the dopesheet and the graph editor read the same custom properties from the
 * computed style of the page. The values are cached (drawing runs every frame); the cache is dropped when the stylesheet is hot-replaced
 * in development, and an empty answer (the stylesheet has not arrived yet, or there is no document) is never cached.
 */

const cache = new Map<string, string>();
const shaded = new Map<string, string>();

/** The value of a custom property, as written in the stylesheet: `token('--accent')`. Empty text where there is no document (tests). */
export function token(name: `--${string}`): string {
  let v = cache.get(name);
  if (v === undefined) {
    v = typeof document === 'undefined' ? '' : getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    if (v) cache.set(name, v);
  }
  return v;
}

/** A length token in pixels: `px('--h-tl-row')` is 24. */
export function px(name: `--${string}`): number {
  return parseFloat(token(name)) || 0;
}

/** Drops the cached values (the stylesheet changed). */
export function refreshTokens() {
  cache.clear();
  shaded.clear();
}

/** `#rgb`, `#rrggbb`, `rgb(r, g, b)` or `rgba(r, g, b, a)` as [r, g, b] in 0..255, or null. */
export function parseColor(text: string): [number, number, number] | null {
  const t = text.trim();
  let m = /^#([0-9a-f]{3})$/i.exec(t);
  if (m) return [...m[1]].map((c) => parseInt(c + c, 16)) as [number, number, number];
  m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(t);
  if (m) return [parseInt(m[1], 16), parseInt(m[2], 16), parseInt(m[3], 16)];
  m = /^rgba?\(\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)\s*[, ]\s*(\d+(?:\.\d+)?)/i.exec(t);
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])];
  return null;
}

/** A colour token with another opacity: `alpha('--accent', 0.2)` is 'rgba(49,208,170,0.2)'. */
export function alpha(name: `--${string}`, a: number): string {
  const key = `${name}|${a}`;
  let v = shaded.get(key);
  if (v === undefined) {
    const rgb = parseColor(token(name));
    if (!rgb) return token(name); // not known yet: do not remember the fallback
    v = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${a})`;
    shaded.set(key, v);
  }
  return v;
}

// A stylesheet replaced by hot reload must reach the canvases without a page reload.
(import.meta as ImportMeta & { hot?: { on(event: string, cb: () => void): void } }).hot?.on('vite:afterUpdate', refreshTokens);

/** The design tokens of the marker colours, in palette order (a marker saves its position in this list). */
export const MARKER_TOKENS = ['--marker-1', '--marker-2', '--marker-3', '--marker-4', '--marker-5', '--marker-6'] as const;
