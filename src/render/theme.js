import { mix, shade, withAlpha } from './pixel.js';

// Shell colours. Deliberately cool + desaturated so the screen accent pops.
export const SHELL = {
  ink: '#0b0d14',
  edgeHi: '#79839f',
  hi: '#5a6480',
  base: '#3f4762',
  mid: '#333a52',
  lo: '#272d40',
  deep: '#1b1f2e',
  groove: '#151824',
  cream: '#f3ecda',
  creamMid: '#d5cbb3',
  creamLo: '#a49a84',
  creamDeep: '#7b7361',
  bezel: '#101320',
  bezelHi: '#2b3247',
  red: '#ff5f6d',
  amber: '#ffb648',
  white: '#ffffff',
};

/** Build a coherent screen palette from a single accent colour. */
export function screenTheme(accent) {
  const deep = mix('#03060a', accent, 0.08);
  return {
    accent,
    bg: deep,
    bgHi: mix(deep, accent, 0.1),
    grid: mix(deep, accent, 0.22),
    dim: mix(deep, accent, 0.38),
    mid: mix(deep, accent, 0.62),
    fg: accent,
    hi: shade(accent, 0.55),
    glow: withAlpha(accent, 0.28),
    shadow: mix(deep, '#000000', 0.5),
  };
}

export const CACHED = new Map();
export function themeFor(accent) {
  let t = CACHED.get(accent);
  if (!t) {
    t = screenTheme(accent);
    CACHED.set(accent, t);
  }
  return t;
}
