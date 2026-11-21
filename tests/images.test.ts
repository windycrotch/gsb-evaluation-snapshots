/** Image names: renaming makes every attachment follow, folders come from "/", and the unused ones are found. */
import { describe, expect, it } from 'vitest';
import { baseOf, cleanImageName, folderOf, imageGroups, imageUsage, renameImage, unusedImages } from '../src/core/images';
import { uid } from '../src/core/ids';
import type { ImageRef, Project } from '../src/core/model';
import { exportSpineJson } from '../src/core/export/spineJson';
import { DEMO_IMAGES, buildDemoRig } from '../src/store/demo/kit';

function kit(): Project {
  const images: Record<string, ImageRef> = {};
  for (const i of DEMO_IMAGES) images[i.name] = { id: uid(), name: i.name, width: i.width, height: i.height };
  return buildDemoRig(images);
}

describe('image names', () => {
  it('splits a name into folder and base', () => {
    expect(folderOf('hero/arm/left')).toBe('hero/arm');
    expect(baseOf('hero/arm/left')).toBe('left');
    expect(folderOf('arm')).toBe('');
    expect(baseOf('arm')).toBe('arm');
  });

  it('cleans what a person typed', () => {
    expect(cleanImageName('  hero / arm  ')).toBe('hero/arm');
    expect(cleanImageName('//a///b/')).toBe('a/b');
    expect(cleanImageName('  /  ')).toBe('');
  });

  it('groups by folder, the root first', () => {
    expect(imageGroups(['b/x', 'a', 'a/y', 'b/z', 'c'])).toEqual([
      ['', ['a', 'c']],
      ['a', ['a/y']],
      ['b', ['b/x', 'b/z']],
    ]);
  });
});

describe('rename and usage', () => {
  it('every attachment that shows the image follows the new name, in every skin', () => {
    const p = kit();
    const from = p.images[0].name;
    const shown = (name: string) => {
      let n = 0;
      for (const skin of p.skeleton.skins)
        for (const slot of Object.values(skin.attachments))
          for (const a of Object.values(slot)) if ((a.type === 'region' || a.type === 'mesh') && a.path === name) n++;
      return n;
    };
    const before = shown(from);
    expect(before).toBeGreaterThan(0);
    const r = renameImage(p, from, ' parts / ' + from);
    expect(r).toEqual({ ok: true, name: 'parts/' + from });
    expect(shown(from)).toBe(0);
    expect(shown('parts/' + from)).toBe(before);
    expect(p.images.some((i) => i.name === 'parts/' + from)).toBe(true);
  });

  it('refuses an empty name and a name another image has, and changes nothing', () => {
    const p = kit();
    const [a, b] = p.images;
    const copy = structuredClone(p);
    expect(renameImage(p, a.name, '  ')).toEqual({ ok: false, reason: 'empty' });
    expect(renameImage(p, a.name, b.name)).toEqual({ ok: false, reason: 'taken' });
    expect(renameImage(p, 'nothing', 'x')).toEqual({ ok: false, reason: 'missing' });
    expect(p).toEqual(copy);
  });

  it('renaming to the same name is a no-op', () => {
    const p = kit();
    expect(renameImage(p, p.images[0].name, p.images[0].name).ok).toBe(true);
  });

  it('finds the images no attachment shows', () => {
    const p = kit();
    expect(unusedImages(p)).toEqual([]);
    p.images.push({ id: uid(), name: 'spare', width: 8, height: 8 });
    expect(unusedImages(p)).toEqual(['spare']);
    expect(imageUsage(p.skeleton).has('spare')).toBe(false);
  });

  it('the export uses the new name as the atlas region path', () => {
    const p = kit();
    const from = p.images[0].name;
    renameImage(p, from, 'folder/' + from);
    const json = JSON.stringify(exportSpineJson(p.skeleton));
    expect(json).toContain('folder/' + from);
  });
});
