/** The single-file player page: the page is made of data and one self-contained script, safe inside HTML. */
import { describe, expect, it } from 'vitest';
import playerScript from 'virtual:bone2d-player';
import { playerPageHtml, readPlayerPayload } from '../src/core/export/playerPage';
import type { PlayerPayload } from '../src/core/export/playerPage';
import { buildFixture } from './fixture';

function payload(extra: Partial<PlayerPayload> = {}): PlayerPayload {
  const { project } = buildFixture();
  return { title: 'Hero', skeleton: project.skeleton, images: { head: 'data:image/png;base64,AAAA' }, smooth: true, ...extra };
}

describe('the player script', () => {
  it('is one self-contained script: no imports, no network', () => {
    expect(typeof playerScript).toBe('string');
    expect(playerScript.length).toBeGreaterThan(20000);
    expect(playerScript).not.toMatch(/^\s*import[\s{]/m);
    expect(playerScript).not.toMatch(/\brequire\(/);
    expect(playerScript).not.toMatch(/https?:\/\/(?!www\.w3\.org)[a-z0-9.-]+\.(com|io|net|org)\//i);
    // it plays: the renderer, the posing and the page elements it needs are in it
    for (const needle of ['webgl2', 'b2d-data', 'stage', 'requestAnimationFrame']) expect(playerScript).toContain(needle);
  });
});

describe('the page', () => {
  it('carries the data as a JSON block that reads back unchanged', () => {
    const p = payload();
    const html = playerPageHtml(p, 'console.log(1)');
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(readPlayerPayload(html)).toEqual(p);
    expect(html).toContain('<canvas id="stage">');
    expect(html).toContain('console.log(1)');
  });

  it('cannot be broken out of by a name or a script that contains </script>', () => {
    const p = payload({ title: 'a</script><script>alert(1)</script>&amp;' });
    const html = playerPageHtml(p, 'var s = "</script><b>";');
    // the only closing tags are the ones the page itself writes
    expect((html.match(/<\/script>/gi) ?? []).length).toBe(2);
    expect(readPlayerPayload(html)?.title).toBe(p.title);
    expect(html).toContain('<title>a&lt;/script&gt;&lt;script&gt;alert(1)&lt;/script&gt;&amp;amp;</title>');
  });

  it('survives the line separators that end a JavaScript string', () => {
    const title = ['a', String.fromCharCode(0x2028), 'b', String.fromCharCode(0x2029), 'c'].join('');
    const html = playerPageHtml(payload({ title }), '');
    // inside the data block (a script) they would end a JavaScript string; in the title they are plain text
    const block = /<script id="b2d-data"[^>]*>([\s\S]*?)<\/script>/.exec(html)![1];
    expect(block).not.toMatch(new RegExp('[\u2028\u2029]'));
    expect(readPlayerPayload(html)?.title).toBe(title);
  });

  it('keeps every animation and skin of the skeleton', () => {
    const p = payload();
    const back = readPlayerPayload(playerPageHtml(p, ''))!;
    expect(back.skeleton.animations.map((a) => a.name)).toEqual(p.skeleton.animations.map((a) => a.name));
    expect(back.skeleton.skins.length).toBe(p.skeleton.skins.length);
  });

  it('returns null for text that is no player page', () => {
    expect(readPlayerPayload('<html></html>')).toBeNull();
  });
});
