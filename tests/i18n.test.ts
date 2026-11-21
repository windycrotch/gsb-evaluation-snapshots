import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { setLang, tr } from '@/i18n';
import { RU } from '@/i18n/ru';

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(p);
  }
  return out;
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patternRes = Object.keys(RU)
  .filter((k) => /\{#?\}/.test(k))
  .map(
    (k) =>
      new RegExp(
        '^' +
          k
            .split(/(\{#?\})/)
            .map((tok) => (tok === '{}' ? '(.+?)' : tok === '{#}' ? '(\\d+(?:\\.\\d+)?)' : escapeRe(tok)))
            .join('') +
          '$',
      ),
  );
const covered = (text: string) => Object.prototype.hasOwnProperty.call(RU, text) || patternRes.some((re) => re.test(text));

/** Plain English text, not code that happens to sit between angle brackets. */
const looksLikeText = (t: string) =>
  /^[A-Za-z][A-Za-z0-9 .,:!'"()+\-–—·…→⇄←/&%×−°]*$/.test(t) && /[A-Za-z]{2}/.test(t) && !t.includes('&&');

/** UI strings written literally in the sources: JSX text, text props, toasts, undo labels, menu items. */
function staticStrings(): { file: string; text: string }[] {
  const out: { file: string; text: string }[] = [];
  const seen = new Set<string>();
  const add = (file: string, raw: string) => {
    const text = raw.replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    if (!looksLikeText(text) || seen.has(text)) return;
    seen.add(text);
    out.push({ file, text });
  };
  for (const dir of ['src/editor', 'src/store']) {
    for (const f of sources(join(process.cwd(), dir))) {
      const src = readFileSync(f, 'utf8');
      const file = f.replace(/\\/g, '/').replace(/^.*\/src\//, 'src/');
      if (f.endsWith('.tsx')) {
        for (const m of src.matchAll(/>([^<>{}]+)</g)) add(file, m[1]);
        for (const m of src.matchAll(/\b(?:title|label|placeholder|aria-label|alt)="([^"{}]+)"/g)) add(file, m[1]);
      }
      for (const m of src.matchAll(/\b(?:toast|item)\(\s*'([^'$\\]+)'/g)) add(file, m[1]);
      for (const m of src.matchAll(/\.update\(\s*'([^'$\\]+)'/g)) add(file, m[1]);
      for (const m of src.matchAll(/\b(?:label|title|hint|text):\s*'([^'$\\]+)'/g)) add(file, m[1]);
    }
  }
  return out;
}

describe('interface language', () => {
  afterAll(() => setLang('en'));

  it('keeps the placeholders of every pattern', () => {
    for (const [en, ru] of Object.entries(RU)) {
      const parts = (en.match(/\{#?\}/g) ?? []).length;
      const used = [...ru.matchAll(/\{(\d*)\}/g)];
      if (parts === 0) {
        expect(used.length, `"${en}" has no {} but its translation does`).toBe(0);
        continue;
      }
      expect(used.length, `"${en}" drops its {}`).toBeGreaterThan(0);
      let next = 0;
      for (const m of used) {
        const index = m[1] ? Number(m[1]) : ++next;
        expect(index >= 1 && index <= parts, `"${en}" -> "${ru}" refers to part ${index} of ${parts}`).toBe(true);
      }
    }
  });

  it('translates, keeps surrounding spaces, and leaves English, numbers and unknown text alone', () => {
    setLang('ru');
    expect(tr('Save')).toBe('Сохранить');
    expect(tr('  Save ')).toBe('  Сохранить ');
    expect(tr('arm-upper')).toBe('arm-upper');
    expect(tr('42')).toBe('42');
    expect(tr('')).toBe('');
    setLang('en');
    expect(tr('Save')).toBe('Save');
  });

  it('translates texts built from parts, including the parts', () => {
    setLang('ru');
    expect(tr('Copied 3 keys')).toBe('Скопировано ключей: 3');
    expect(tr('Copied 1 key')).toBe('Скопировано ключей: 1');
    expect(tr('Set Rotation key at the playhead')).toBe('Поставить ключ «Поворот» в текущем кадре');
    expect(tr('Undo Move vertices')).toBe('Отменить: Переместить вершины');
    expect(tr('Mesh: 24 vertices, 40 triangles')).toBe('Меш: вершин — 24, треугольников — 40');
    expect(tr('"leg" is part of the IK constraint "walk" — remove the constraint to move it')).toBe(
      '«leg» входит в IK-констрейнт «walk» — удали констрейнт, чтобы переместить кость',
    );
    expect(tr('Opened bolt.bone2d (2 problems repaired, 1 image could not be read)')).toBe(
      'Открыто: bolt.bone2d (исправлено проблем: 2, не удалось прочитать картинок: 1)',
    );
    expect(tr('Opened bolt.bone2d')).toBe('Открыто: bolt.bone2d');
    expect(tr('arm · rotation')).toBe('arm · поворот');
    expect(tr('Interpolation · 3 keys')).toBe('Интерполяция · ключей: 3');
    setLang('en');
  });

  it('translates the counters of the empty inspector and the hint titles', () => {
    setLang('ru');
    expect(tr('Bones: 12')).toBe('Кости: 12');
    expect(tr('Warnings: 3')).toBe('Предупреждения: 3');
    expect(tr('Click to read all')).not.toBe('Click to read all');
    expect(tr('Click to fold')).not.toBe('Click to fold');
  });

  it('has a Russian text for every static UI string in the sources', () => {
    const strings = staticStrings();
    expect(strings.length).toBeGreaterThan(150); // the scan itself works
    const missing = strings.filter((s) => !covered(s.text)).map((s) => `${s.file}: ${s.text}`);
    expect(missing, 'add these to src/i18n/ru.ts').toEqual([]);
  });
});
