import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

// The viewer's text is one table, TEXT, with the Indonesian and the English side by side. A key the page asks for that
// is not in it stops the page, so every key used in the markup and the script has to be there, in both languages.
test('every viewer text is in TEXT, in Indonesian and English', () => {
  const html = readFileSync('src/editor.html', 'utf8');
  const src = html.slice(html.indexOf('const TEXT = {') + 13, html.indexOf('\n};', html.indexOf('const TEXT = {')) + 2);
  const TEXT = new Function(`return ${src}`)();
  for (const [k, v] of Object.entries(TEXT)) {
    assert.ok(Array.isArray(v) && v.length === 2, `${k}: needs [Indonesian, English]`);
    assert.equal(typeof v[0], typeof v[1], `${k}: both or neither are functions`);
    if (typeof v[0] === 'function') assert.equal(v[0].length, v[1].length, `${k}: both take the same arguments`);
    else assert.ok(v[0] && v[1], `${k}: empty text`);
  }
  const code = html.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  const used = new Set([
    ...[...code.matchAll(/\bL\('(\w+)'/g)].map(m => m[1]),
    ...[...code.matchAll(/\bL\([\w.]+ \? '(\w+)' : '(\w+)'\)/g)].flatMap(m => [m[1], m[2]]),
    ...[...code.matchAll(/data-label="(\w+)"/g)].map(m => m[1]),
    ...[...code.matchAll(/data-t="([^"]+)"/g)].flatMap(m => m[1].split(' ').map(p => p.split('=').at(-1))),
  ]);
  assert.ok(used.size > 50);
  for (const k of used) assert.ok(k in TEXT, `"${k}" is used but not in TEXT`);
});
