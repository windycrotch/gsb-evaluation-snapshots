/** Select next to the hierarchy filter: every bone and slot that matches, selected at once. */
import { beforeEach, describe, expect, it } from 'vitest';
import { filterTree, selectionOfMatch } from '../src/core/treeFilter';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';

const doc = () => docStore.get().skeleton;

beforeEach(() => {
  docStore.replace(buildFixture().project);
  uiStore.patch({ selection: emptySelection });
});

describe('what matches', () => {
  it('lists the bones whose own name matches, in the order of the document, without their ancestors', () => {
    const m = filterTree(doc(), 'arm');
    const byName = doc()
      .bones.filter((b) => /arm/i.test(b.name))
      .map((b) => b.id);
    expect(byName.length).toBeGreaterThan(1);
    expect(m.matchedBones).toEqual(byName);
    // the ancestors are shown but not selected
    expect(m.bones.size).toBeGreaterThan(m.matchedBones.length);
    for (const id of m.matchedBones) expect(m.bones.has(id)).toBe(true);
  });

  it('lists the slots that match by their name or by the name of one of their images', () => {
    const m = filterTree(doc(), 'arm');
    expect(m.matchedSlots.length).toBeGreaterThan(0);
    for (const id of m.matchedSlots) expect(m.slots.has(id)).toBe(true);
    expect(m.matchedSlots).toEqual(
      doc()
        .slots.filter((s) => m.slots.has(s.id))
        .map((s) => s.id),
    );
  });

  it('has nothing for an empty filter or one that matches nothing', () => {
    expect(filterTree(doc(), '').matchedBones).toEqual([]);
    expect(filterTree(doc(), '   ').matchedSlots).toEqual([]);
    const none = filterTree(doc(), 'zzzzzz');
    expect(none.matchedBones).toEqual([]);
    expect(none.matchedSlots).toEqual([]);
    expect(selectionOfMatch(filterTree(doc(), ''))).toEqual({ bones: [], slot: null, extraSlots: [] });
  });

  it('works with a regular expression and with wildcards', () => {
    const named = doc()
      .bones.filter((b) => /^arm/.test(b.name))
      .map((b) => b.id);
    expect(filterTree(doc(), '/^arm/').matchedBones).toEqual(named);
    expect(filterTree(doc(), 'arm*').matchedBones).toEqual(expect.arrayContaining(named));
  });
});

describe('the selection it makes', () => {
  it('selects the matching bones, and the first matching slot with the others selected together', () => {
    const m = filterTree(doc(), 'arm');
    const n = A.selectMatches(m);
    const sel = uiStore.get().selection;
    expect(sel.bones).toEqual(m.matchedBones);
    expect(sel.slot).toBe(m.matchedSlots[0]);
    expect(sel.extraSlots ?? []).toEqual(m.matchedSlots.slice(1));
    expect(n).toBe(m.matchedBones.length + m.matchedSlots.length);
  });

  it('changes nothing when nothing matches', () => {
    A.selectBone(doc().bones[1].id);
    const before = JSON.stringify(uiStore.get().selection);
    expect(A.selectMatches(filterTree(doc(), 'zzzzzz'))).toBe(0);
    expect(JSON.stringify(uiStore.get().selection)).toBe(before);
  });

  it('the selected slots work together for the weight tools', async () => {
    const M = await import('../src/store/meshActions');
    const m = filterTree(doc(), 'arm');
    A.selectMatches(m);
    // the matching slot that shows a mesh is part of the group of meshes
    const group = M.weightGroup();
    for (const g of group) expect(m.matchedSlots).toContain(g.slotId);
  });
});
