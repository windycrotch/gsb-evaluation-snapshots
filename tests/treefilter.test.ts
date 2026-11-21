/** The hierarchy filter, "show everything hidden" and "show only the selection". */
import { beforeEach, describe, expect, it } from 'vitest';
import { filterTree, hiddenOf, isolation } from '../src/core/treeFilter';
import { validateProject } from '../src/core/validate';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import { emptySelection, uiStore } from '../src/store/ui';
import { isolateSelection, showAll } from '../src/store/visibilityActions';
import { buildFixture } from './fixture';

const doc = () => docStore.get().skeleton;

beforeEach(() => {
  const f = buildFixture();
  docStore.replace(f.project);
  uiStore.patch({
    mode: 'setup',
    tool: 'select',
    animationId: f.project.skeleton.animations[0].id,
    skinId: null,
    time: 0,
    selection: emptySelection,
    overrides: {},
    autoKey: true,
    playing: false,
  });
});

describe('filterTree', () => {
  it('shows everything for an empty filter', () => {
    expect(filterTree(doc(), '  ').active).toBe(false);
  });

  it('keeps matching bones with their ancestors, in any case', () => {
    const leaf = doc().bones[doc().bones.length - 1];
    const m = filterTree(doc(), leaf.name.toUpperCase());
    expect(m.active).toBe(true);
    expect(m.bones.has(leaf.id)).toBe(true);
    for (let at = leaf; at.parent;) {
      at = doc().bones.find((b) => b.id === at.parent)!;
      expect(m.bones.has(at.id)).toBe(true);
    }
  });

  it('needs every word and finds a slot by its name, its images and brings its bone', () => {
    const slot = doc().slots[0];
    const m = filterTree(doc(), slot.name);
    expect(m.slots.has(slot.id)).toBe(true);
    expect(m.bones.has(slot.bone)).toBe(true);
    expect(filterTree(doc(), `${slot.name} zzzz-not-there`).slots.size).toBe(0);
    const image = Object.keys(doc().skins[0].attachments[slot.id] ?? {})[0];
    if (image) expect(filterTree(doc(), image).slots.has(slot.id)).toBe(true);
  });

  it('matches nothing for a name nobody has', () => {
    const m = filterTree(doc(), 'qqqqqq');
    expect(m.bones.size + m.slots.size + m.constraints.size + m.skins.size + m.events.size).toBe(0);
  });
});

describe('isolation', () => {
  it('hides every other slot when a slot is selected', () => {
    const slot = doc().slots[0];
    const plan = isolation(doc(), [], slot.id)!;
    expect(plan.slots.has(slot.id)).toBe(false);
    expect(plan.slots.size).toBe(doc().slots.length - 1);
    expect(plan.bones.size).toBe(0);
  });

  it('keeps a selected bone with its children and hides the rest', () => {
    const bone = doc().bones[1];
    const plan = isolation(doc(), [bone.id], null)!;
    expect(plan.bones.has(bone.id)).toBe(false);
    expect(plan.bones.has(doc().bones[0].id)).toBe(true);
    for (const b of doc().bones) if (b.parent === bone.id) expect(plan.bones.has(b.id)).toBe(false);
  });

  it('has nothing to do without a selection', () => {
    expect(isolation(doc(), [], null)).toBeNull();
  });
});

describe('show all and show only the selection', () => {
  it('hides around the selection, then shows everything again, and undoes', () => {
    A.selectBone(doc().bones[1].id);
    const hid = isolateSelection();
    expect(hid).toBeGreaterThan(0);
    const after = hiddenOf(doc());
    expect(after.bones.length + after.slots.length).toBe(hid);
    expect(showAll()).toBe(hid);
    expect(hiddenOf(doc())).toEqual({ bones: [], slots: [] });
    docStore.undo();
    expect(hiddenOf(doc()).bones.length + hiddenOf(doc()).slots.length).toBe(hid);
    expect(validateProject(docStore.get())).toEqual([]);
  });

  it('says so instead of changing anything when there is nothing to do', () => {
    expect(showAll()).toBe(0);
    expect(isolateSelection()).toBe(-1);
  });
});
