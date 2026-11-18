// A hand-authored 5px-tall bitmap font. Glyphs are 4px wide unless they need
// the extra column (M, W), and advance by their width + 1.
// Only uppercase is defined; `text()` upcases everything before lookup.

const GLYPHS = {
  A: '.##.|#..#|####|#..#|#..#',
  B: '###.|#..#|###.|#..#|###.',
  C: '.###|#...|#...|#...|.###',
  D: '###.|#..#|#..#|#..#|###.',
  E: '####|#...|###.|#...|####',
  F: '####|#...|###.|#...|#...',
  G: '.###|#...|#.##|#..#|.###',
  H: '#..#|#..#|####|#..#|#..#',
  I: '###.|.#..|.#..|.#..|###.',
  J: '..##|...#|...#|#..#|.##.',
  K: '#..#|#.#.|##..|#.#.|#..#',
  L: '#...|#...|#...|#...|####',
  M: '#...#|##.##|#.#.#|#...#|#...#',
  N: '#..#|##.#|#.##|#..#|#..#',
  O: '.##.|#..#|#..#|#..#|.##.',
  P: '###.|#..#|###.|#...|#...',
  Q: '.##.|#..#|#..#|#.#.|.#.#',
  R: '###.|#..#|###.|#.#.|#..#',
  S: '.###|#...|.##.|...#|###.',
  T: '####|.#..|.#..|.#..|.#..',
  U: '#..#|#..#|#..#|#..#|.##.',
  V: '#..#|#..#|#..#|.##.|.##.',
  W: '#...#|#...#|#.#.#|##.##|#...#',
  X: '#..#|#..#|.##.|#..#|#..#',
  Y: '#..#|#..#|.##.|.#..|.#..',
  Z: '####|..#.|.#..|#...|####',
  0: '.##.|#.##|##.#|#..#|.##.',
  1: '.#..|##..|.#..|.#..|###.',
  2: '###.|...#|.##.|#...|####',
  3: '###.|...#|.##.|...#|###.',
  4: '#..#|#..#|####|...#|...#',
  5: '####|#...|###.|...#|###.',
  6: '.###|#...|###.|#..#|.##.',
  7: '####|...#|..#.|.#..|.#..',
  8: '.##.|#..#|.##.|#..#|.##.',
  9: '.##.|#..#|.###|...#|###.',
  ' ': '....|....|....|....|....',
  '.': '....|....|....|....|.#..',
  ',': '....|....|....|.#..|#...',
  '-': '....|....|###.|....|....',
  '+': '....|.#..|###.|.#..|....',
  ':': '....|.#..|....|.#..|....',
  ';': '....|.#..|....|.#..|#...',
  '!': '.#..|.#..|.#..|....|.#..',
  '?': '###.|...#|.##.|....|.#..',
  '#': '#.#.|####|#.#.|####|#.#.',
  '/': '...#|..#.|.#..|#...|....',
  "'": '.#..|.#..|....|....|....',
  '(': '..#.|.#..|.#..|.#..|..#.',
  ')': '.#..|..#.|..#.|..#.|.#..',
  '<': '..#.|.#..|#...|.#..|..#.',
  '>': '#...|.#..|..#.|.#..|#...',
  '*': '#.#.|.#..|###.|.#..|#.#.',
  '=': '....|###.|....|###.|....',
  '%': '#..#|...#|.##.|#...|#..#',
  '~': '....|.#.#|#.#.|....|....',
  '&': '..##|..#.|..#.|###.|.##.', // music note
  '^': '.#..|###.|#.#.|....|....', // up arrow
  _: '....|....|#.#.|###.|.#..', // down arrow
  '@': '#.#.|####|####|.##.|....', // heart
  '$': '.#..|###.|####|###.|.#..', // sparkle / star
};

const CACHE = new Map();

function bits(ch) {
  let rows = CACHE.get(ch);
  if (rows) return rows;
  const src = GLYPHS[ch] ?? GLYPHS['?'];
  rows = src.split('|').map((r) => r.split('').map((c) => c === '#'));
  rows.width = rows[0].length;
  CACHE.set(ch, rows);
  return rows;
}

export const FONT_H = 5;
export const GAP = 1;

export function textWidth(str) {
  const s = String(str).toUpperCase();
  if (!s.length) return 0;
  let w = 0;
  for (const ch of s) w += bits(ch).width + GAP;
  return w - GAP;
}

/**
 * Draw a string of pixel text.
 * @param {import('./pixel.js').Pixel} p
 */
export function text(p, str, x, y, color, opts = {}) {
  const { shadow = null, wave = 0, waveT = 0 } = opts;
  const s = String(str).toUpperCase();
  let cx = Math.round(x);
  for (let i = 0; i < s.length; i++) {
    const rows = bits(s[i]);
    const dy = wave ? Math.round(Math.sin(waveT + i * 0.7) * wave) : 0;
    for (let ry = 0; ry < rows.length; ry++) {
      for (let rx = 0; rx < rows.width; rx++) {
        if (!rows[ry][rx]) continue;
        if (shadow) p.px(cx + rx + 1, y + ry + dy + 1, shadow);
        p.px(cx + rx, y + ry + dy, color);
      }
    }
    cx += rows.width + GAP;
  }
  return cx - GAP;
}

export function textCentered(p, str, cx, y, color, opts) {
  const w = textWidth(String(str));
  return text(p, str, Math.round(cx - w / 2), y, color, opts);
}

export function textRight(p, str, rx, y, color, opts) {
  return text(p, str, Math.round(rx - textWidth(String(str))), y, color, opts);
}
