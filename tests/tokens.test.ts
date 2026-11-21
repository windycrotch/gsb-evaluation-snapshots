/**
 * The rules of the design system (src/styles/tokens.css):
 *  - every token that the stylesheets and the canvas code name exists;
 *  - no colour is written as a hex literal in the editor: it is a token (the canvas code reads them through ui/tokens.ts);
 *  - the text colours have WCAG AA contrast (4.5 : 1) on every surface they are drawn on;
 *  - sizes that the stylesheet and the canvas code both know (the timeline row) are the same number.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { alpha, parseColor, px, refreshTokens, token } from '@/editor/ui/tokens';

const root = process.cwd();
const read = (p: string) => readFileSync(join(root, p), 'utf8');

function files(dir: string, ext: RegExp, out: string[] = []): string[] {
  for (const e of readdirSync(join(root, dir), { withFileTypes: true })) {
    const p = `${dir}/${e.name}`;
    if (e.isDirectory()) files(p, ext, out);
    else if (ext.test(e.name)) out.push(p);
  }
  return out;
}

const withoutComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, '');

/** name -> value of every custom property of tokens.css. */
function readTokens(): Map<string, string> {
  const out = new Map<string, string>();
  for (const m of withoutComments(read('src/styles/tokens.css')).matchAll(/(--[a-z0-9-]+)\s*:\s*([^;]+);/g)) out.set(m[1], m[2].trim());
  return out;
}
const TOKENS = readTokens();

/** Relative luminance of #rrggbb, WCAG 2.x. */
function luminance(hex: string): number {
  const rgb = parseColor(hex);
  if (!rgb) throw new Error(`not an opaque colour: ${hex}`);
  const [r, g, b] = rgb.map((v) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(fg: string, bg: string): number {
  const a = luminance(TOKENS.get(fg)!);
  const b = luminance(TOKENS.get(bg)!);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

describe('design tokens', () => {
  it('defines what the stylesheets and the canvas code name', () => {
    const missing: string[] = [];
    for (const f of [...files('src', /\.(css|ts|tsx)$/)]) {
      const src = read(f);
      for (const m of src.matchAll(/var\((--[a-z0-9-]+)/g)) if (!TOKENS.has(m[1])) missing.push(`${f}: var(${m[1]})`);
      if (f.endsWith('.css')) continue;
      // token('--accent'), alpha('--accent', 0.5) and the tables of names
      for (const m of src.matchAll(/['"`](--[a-z0-9-]+)['"`]/g)) if (!TOKENS.has(m[1])) missing.push(`${f}: '${m[1]}'`);
    }
    expect(missing).toEqual([]);
    for (let i = 1; i <= 4; i++) expect(TOKENS.has(`--curve-${i}`)).toBe(true); // the graph editor builds these names
  });

  it('has no colour literal in the editor: a colour is a token', () => {
    // the generated player page (what a game developer gets in the export) is not the editor's interface
    const allowed = new Set(['src/editor/exportSpine.ts']);
    const found: string[] = [];
    for (const f of files('src/editor', /\.(ts|tsx)$/)) {
      if (allowed.has(f)) continue;
      read(f)
        .split('\n')
        .forEach((line, i) => {
          if (/^\s*(\/\/|\*|\/\*)/.test(line)) return;
          if (/['"`]#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})['"`]/.test(line))
            found.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
    }
    for (const f of files('src/styles', /\.css$/)) {
      if (f.endsWith('tokens.css')) continue;
      withoutComments(read(f))
        .split('\n')
        .forEach((line, i) => {
          if (/#(?:[0-9a-fA-F]{8}|[0-9a-fA-F]{6}|[0-9a-fA-F]{3})\b/.test(line) || /rgba?\(/.test(line))
            found.push(`${f}:${i + 1}: ${line.trim().slice(0, 100)}`);
        });
    }
    expect(found).toEqual([]);
  });

  it('has AA contrast (4.5 : 1) for text on every surface', () => {
    const surfaces = ['--bg', '--sunken', '--sunken-2', '--viewport', '--panel', '--panel-2', '--panel-3'];
    const texts = [
      '--text',
      '--text-dim',
      '--muted',
      '--accent',
      '--animate',
      '--danger',
      '--kind-ik',
      '--kind-transform',
      '--kind-slider',
      '--kind-path',
      '--kind-physics',
    ];
    const low: string[] = [];
    for (const t of texts) for (const s of surfaces) if (contrast(t, s) < 4.5) low.push(`${t} on ${s}: ${contrast(t, s).toFixed(2)}`);
    // text that sits on a fill of its own
    for (const [fg, bg] of [
      ['--accent-ink', '--accent'],
      ['--animate-ink', '--animate'],
      ['--danger-ink', '--panel-3'],
      ['--tl-label', '--tl-ruler'],
      ['--tl-label-strong', '--tl-ruler'],
    ] as const) {
      if (contrast(fg, bg) < 4.5) low.push(`${fg} on ${bg}: ${contrast(fg, bg).toFixed(2)}`);
    }
    expect(low).toEqual([]);
  });

  it('keeps the timeline row height of the stylesheet and of the canvas the same', () => {
    const rowH = Number(/export const ROW_H = (\d+)/.exec(read('src/editor/timeline/Dopesheet.tsx'))?.[1]);
    expect(`${rowH}px`).toBe(TOKENS.get('--h-tl-row'));
  });
});

describe('tokens for the canvas', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    refreshTokens();
  });

  const stubPage = (values: Record<string, string>) => {
    vi.stubGlobal('document', { documentElement: {} });
    vi.stubGlobal('getComputedStyle', () => ({ getPropertyValue: (name: string) => (values[name] ? ` ${values[name]}` : '') }));
  };

  it('parses #rgb, #rrggbb, rgb() and rgba()', () => {
    expect(parseColor('#31d0aa')).toEqual([49, 208, 170]);
    expect(parseColor('#fa0')).toEqual([255, 170, 0]);
    expect(parseColor('rgba(255, 159, 67, 0.5)')).toEqual([255, 159, 67]);
    expect(parseColor('rgb(1 2 3)')).toEqual([1, 2, 3]);
    expect(parseColor('1px solid red')).toBeNull();
  });

  it('reads a token once, never remembers a missing one, and forgets on refresh', () => {
    const values: Record<string, string> = {};
    stubPage(values);
    expect(token('--accent')).toBe(''); // the stylesheet is not there yet
    values['--accent'] = '#31d0aa';
    expect(token('--accent')).toBe('#31d0aa'); // ...and the empty answer was not kept
    values['--accent'] = '#ffffff';
    expect(token('--accent')).toBe('#31d0aa'); // cached
    refreshTokens();
    expect(token('--accent')).toBe('#ffffff');
  });

  it('gives a colour token another opacity, and a length token as a number', () => {
    stubPage({ '--accent': '#31d0aa', '--h-tl-row': '24px', '--animate-line': 'rgba(255, 159, 67, 0.5)' });
    expect(alpha('--accent', 0.2)).toBe('rgba(49,208,170,0.2)');
    expect(alpha('--animate-line', 0.9)).toBe('rgba(255,159,67,0.9)');
    expect(px('--h-tl-row')).toBe(24);
    expect(px('--missing')).toBe(0);
  });

  it('answers with nothing, not an error, where there is no page', () => {
    expect(token('--accent')).toBe('');
    expect(alpha('--accent', 0.5)).toBe('');
  });
});
