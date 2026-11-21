/** Atlas per skin: which pictures go into which atlas, what the files are called, and the setting. */
import * as spine from '@esotericsoftware/spine-core';
import { describe, expect, it } from 'vitest';
import { packAtlas, writeAtlas } from '../src/core/export/atlas';
import { skinAtlasGroups, usedImages } from '../src/core/export/atlasBuild';
import { engineNeeds } from '../src/core/export/engineNeeds';
import { DEFAULT_EXPORT_SETTINGS, readExportSettings } from '../src/core/export/settings';
import { newSkin } from '../src/core/model';
import type { RegionAttachment, SkeletonDoc } from '../src/core/model';
import { buildFixture } from './fixture';

const region = (name: string, path: string): RegionAttachment => ({
  type: 'region',
  name,
  path,
  x: 0,
  y: 0,
  rotation: 0,
  scaleX: 1,
  scaleY: 1,
  width: 10,
  height: 10,
  color: [1, 1, 1, 1],
});

/** The fixture with two more skins: `red` (a picture of its own and one the default skin uses) and `blue` (a picture of its own and the one red has). */
function rig(): { doc: SkeletonDoc; slot: string } {
  const doc = buildFixture().project.skeleton;
  doc.skins = [doc.skins[0]]; // the fixture has skins of its own
  const slot = doc.slots[0].id;
  const used = usedImages({ skins: [doc.skins[0]] }).map((i) => i.name);
  const red = newSkin('red');
  red.attachments[slot] = { a: region('a', 'red_only'), b: region('b', used[0]), c: region('c', 'shared_skins') };
  const blue = newSkin('blue team!');
  blue.attachments[slot] = { a: region('a', 'blue_only'), c: region('c', 'shared_skins') };
  doc.skins.push(red, blue);
  return { doc, slot };
}

describe('skinAtlasGroups', () => {
  it('gives the default skin the plain name and every other skin its own atlas', () => {
    const { doc } = rig();
    const groups = skinAtlasGroups(doc, 'hero');
    expect(groups.map((g) => g.stem)).toEqual(['hero', 'hero-red', 'hero-blue_team_']);
    expect(groups.map((g) => g.skinId)).toEqual(doc.skins.map((s) => s.id));
  });

  it('puts into a skin atlas only the pictures the default skin does not use', () => {
    const { doc } = rig();
    const [base, red, blue] = skinAtlasGroups(doc, 'hero');
    const defaultNames = usedImages({ skins: [doc.skins[0]] }).map((i) => i.name);
    expect(base.names.sort()).toEqual([...defaultNames].sort());
    expect(red.names.sort()).toEqual(['red_only', 'shared_skins']);
    expect(blue.names.sort()).toEqual(['blue_only', 'shared_skins']);
  });

  it('every picture of the skeleton is in at least one atlas', () => {
    const { doc } = rig();
    const all = new Set(skinAtlasGroups(doc, 'x').flatMap((g) => g.names));
    for (const i of usedImages(doc)) expect(all.has(i.name)).toBe(true);
  });

  it('leaves out a skin that brings no picture of its own, and keeps the names unique', () => {
    const { doc, slot } = rig();
    const plain = newSkin('plain');
    plain.attachments[slot] = { a: region('a', usedImages({ skins: [doc.skins[0]] })[0].name) };
    doc.skins.push(plain);
    expect(skinAtlasGroups(doc, 'hero').map((g) => g.stem)).not.toContain('hero-plain');
    const twin = newSkin('red');
    twin.attachments[slot] = { a: region('a', 'twin_only') };
    doc.skins.push(twin);
    const stems = skinAtlasGroups(doc, 'hero').map((g) => g.stem);
    expect(new Set(stems).size).toBe(stems.length);
    expect(stems).toContain('hero-red_');
  });

  it('with one skin there is one atlas, named as before', () => {
    const doc = buildFixture().project.skeleton;
    doc.skins = [doc.skins[0]];
    const groups = skinAtlasGroups(doc, 'hero');
    expect(groups.map((g) => g.stem)).toEqual(['hero']);
  });

  it('is empty when no skin shows a picture', () => {
    const doc = buildFixture().project.skeleton;
    for (const skin of doc.skins) skin.attachments = {};
    expect(skinAtlasGroups(doc, 'hero')).toEqual([]);
  });
});

describe('the setting and the engine note', () => {
  it('is a flag that is off by default', () => {
    expect(DEFAULT_EXPORT_SETTINGS.atlasPerSkin).toBe(false);
    expect(readExportSettings({ atlasPerSkin: true }).atlasPerSkin).toBe(true);
    expect(readExportSettings({ atlasPerSkin: 'yes' }).atlasPerSkin).toBe(false);
  });

  it('adds a note for the engine only when there is more than one skin', () => {
    const { doc } = rig();
    expect(engineNeeds(doc, { atlasPerSkin: true }).map((n) => n.id)).toContain('perSkin');
    expect(engineNeeds(doc, { atlasPerSkin: false }).map((n) => n.id)).not.toContain('perSkin');
    const one = buildFixture().project.skeleton;
    one.skins = [one.skins[0]];
    expect(engineNeeds(one, { atlasPerSkin: true }).map((n) => n.id)).not.toContain('perSkin');
  });
});

describe('the atlases as the official runtime reads them', () => {
  const pack = (names: string[], stem: string) => {
    const pages = packAtlas(
      names.map((name) => ({ name, width: 20, height: 12 })),
      { padding: 1, pot: true },
    );
    return writeAtlas(pages, (i) => (pages.length === 1 ? `${stem}.png` : `${stem}-${i + 1}.png`), { pma: false, filter: 'Linear' });
  };

  it('each atlas file is a valid atlas, and the atlases glued together (the preview) hold every region', () => {
    const base = pack(['a', 'b'], 'hero');
    const red = pack(['red_only', 'shared_skins'], 'hero-red');
    for (const [text, regions] of [
      [base, ['a', 'b']],
      [red, ['red_only', 'shared_skins']],
    ] as const) {
      const atlas = new spine.TextureAtlas(text);
      expect(atlas.regions.map((r) => r.name).sort()).toEqual([...regions].sort());
    }
    const all = new spine.TextureAtlas([base, red].join('\n'));
    expect(all.pages.map((p) => p.name)).toEqual(['hero.png', 'hero-red.png']);
    expect(all.regions.map((r) => r.name).sort()).toEqual(['a', 'b', 'red_only', 'shared_skins']);
  });
});
