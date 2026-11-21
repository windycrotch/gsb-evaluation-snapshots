/** Breadcrumbs of the selection: skeleton › parent bones › bone › slot › attachment. */
import { describe, expect, it } from 'vitest';
import { MAX_CRUMB_PARENTS, breadcrumbs } from '../src/core/breadcrumbs';
import type { CrumbSelection } from '../src/core/breadcrumbs';
import { newBone } from '../src/core/model';
import { readSettings } from '../src/store/settings';
import { buildFixture } from './fixture';

const none: CrumbSelection = { bones: [], slot: null, attachment: null, constraint: null };
const labels = (c: { label: string }[]) => c.map((x) => x.label);

/** root › a › b › c › d, and a slot on d. */
function chain() {
  const doc = buildFixture().project.skeleton;
  doc.name = 'hero';
  doc.bones = [newBone({ name: 'root' })];
  for (const n of ['a', 'b', 'c', 'd']) doc.bones.push(newBone({ name: n, parent: doc.bones[doc.bones.length - 1].id }));
  doc.slots = doc.slots.slice(0, 1);
  doc.slots[0].bone = doc.bones[4].id;
  doc.slots[0].name = 'face';
  return doc;
}

describe('breadcrumbs', () => {
  it('is empty when nothing is selected', () => {
    expect(breadcrumbs(chain(), none)).toEqual([]);
  });

  it('lists the skeleton, the nearest parents and the bone', () => {
    const doc = chain();
    const c = breadcrumbs(doc, { ...none, bones: [doc.bones[4].id] }, 2);
    expect(labels(c)).toEqual(['hero', '…', 'b', 'c', 'd']);
    expect(c.map((x) => x.kind)).toEqual(['skeleton', 'more', 'bone', 'bone', 'bone']);
    expect(c[4].id).toBe(doc.bones[4].id);
  });

  it('has no "…" when every parent fits, and none at all with 0 parents', () => {
    const doc = chain();
    expect(labels(breadcrumbs(doc, { ...none, bones: [doc.bones[2].id] }, 5))).toEqual(['hero', 'root', 'a', 'b']);
    expect(labels(breadcrumbs(doc, { ...none, bones: [doc.bones[4].id] }, 0))).toEqual(['hero', '…', 'd']);
    expect(labels(breadcrumbs(doc, { ...none, bones: [doc.bones[0].id] }, 3))).toEqual(['hero', 'root']);
  });

  it('runs through the bone of the selected slot and ends at the attachment', () => {
    const doc = chain();
    const c = breadcrumbs(doc, { ...none, slot: doc.slots[0].id, attachment: 'mask', bones: [doc.bones[0].id] }, 1);
    expect(labels(c)).toEqual(['hero', '…', 'c', 'd', 'face', 'mask']);
    expect(c.map((x) => x.kind).slice(-2)).toEqual(['slot', 'attachment']);
    expect(c[4].id).toBe(doc.slots[0].id);
    expect(c[5].id).toBeUndefined();
  });

  it('says how many bones when several are selected, and shows a selected constraint', () => {
    const doc = chain();
    expect(labels(breadcrumbs(doc, { ...none, bones: [doc.bones[1].id, doc.bones[2].id] }))).toEqual(['hero', '2 bones']);
    const c = doc.constraints[0];
    if (c) expect(labels(breadcrumbs(doc, { ...none, constraint: c.id })).at(-1)).toBe(c.name);
  });

  it('clamps the number of parents and survives a selection that no longer exists', () => {
    const doc = chain();
    expect(breadcrumbs(doc, { ...none, bones: [doc.bones[4].id] }, 999).length).toBeLessThanOrEqual(MAX_CRUMB_PARENTS + 2);
    expect(breadcrumbs(doc, { ...none, bones: ['gone'] })).toEqual([]);
    expect(breadcrumbs(doc, { ...none, slot: 'gone' })).toEqual([]);
  });
});

describe('the setting', () => {
  it('is a whole number from 0 to 10', () => {
    expect(readSettings(JSON.stringify({ breadcrumbParents: 5 })).breadcrumbParents).toBe(5);
    expect(readSettings(JSON.stringify({ breadcrumbParents: 0 })).breadcrumbParents).toBe(0);
    expect(readSettings(JSON.stringify({ breadcrumbParents: 11 })).breadcrumbParents).toBe(3);
    expect(readSettings(JSON.stringify({ breadcrumbParents: 2.5 })).breadcrumbParents).toBe(3);
  });
});
