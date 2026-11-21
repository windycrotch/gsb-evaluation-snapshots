/** Selection sets, constraint presets, saved window layouts and micro-move. */
import { beforeEach, describe, expect, it } from 'vitest';
import { newSelectionSet, pickSet, selectionIs, setBones } from '@/core/selsets';
import { arrowSteps, nudgeValue, stepOf } from '@/core/nudge';
import { applyPresetSettings, presetSettings, readPresets } from '@/core/presets';
import { emptyProject, newAnimation, newBone, newPhysicsConstraint, newPathConstraint } from '@/core/model';
import type { PhysicsConstraint } from '@/core/model';
import { repairProject } from '@/core/validate';
import { readNamedLayouts, uniqueLayoutName } from '@/store/layout';
import { DEFAULT_VIEWS } from '@/store/layout';
import { applySavedLayout, deleteSavedLayout, namedLayoutsStore, saveLayoutAs } from '@/store/layoutActions';
import { setSelection } from '@/store/actions';
import { docStore } from '@/store/doc';
import { nudgeBones, nudgeKeyValues, nudgeKeysTime } from '@/store/nudgeActions';
import { applyPreset, deletePreset, presetsStore, savePreset } from '@/store/presetActions';
import { deleteSelectionSet, renameSelectionSet, saveSelectionSet, selectSet, updateSelectionSet } from '@/store/selectionSetActions';
import { uiStore } from '@/store/ui';
import { exportAndLoad } from './official';

function rig() {
  const p = emptyProject();
  p.skeleton.bones = [];
  const root = newBone({ name: 'root' });
  const spine = newBone({ name: 'spine', parent: root.id, length: 40, y: 10 });
  const armL = newBone({ name: 'arm_L', parent: spine.id, length: 30, x: 40 });
  const armR = newBone({ name: 'arm_R', parent: spine.id, length: 30, x: 40 });
  const tail = newBone({ name: 'tail', parent: root.id, length: 30, x: -10 });
  p.skeleton.bones.push(root, spine, armL, armR, tail);
  docStore.replace(p);
  uiStore.patch({ mode: 'setup', overrides: {}, selectedKeys: [] });
  setSelection({});
  return { root, spine, armL, armR, tail };
}

describe('selection sets', () => {
  beforeEach(() => void rig());

  it('keeps the selected bones under a name; selecting the set selects them again', () => {
    const { armL, armR, tail } = rig();
    setSelection({ bones: [armL.id, armR.id] });
    const id = saveSelectionSet('arms')!;
    expect(docStore.get().skeleton.selectionSets).toEqual([{ id, name: 'arms', bones: [armL.id, armR.id] }]);
    setSelection({ bones: [tail.id] });
    selectSet(id);
    expect(uiStore.get().selection.bones).toEqual([armL.id, armR.id]);
  });

  it('with nothing selected there is nothing to keep', () => {
    expect(saveSelectionSet('none')).toBeNull();
    expect(docStore.get().skeleton.selectionSets).toBeUndefined();
  });

  it('names are unique; a rename and a deleted bone do not break a set', () => {
    const { armL, armR, tail } = rig();
    setSelection({ bones: [armL.id, armR.id] });
    const a = saveSelectionSet('limbs')!;
    setSelection({ bones: [tail.id] });
    const b = saveSelectionSet('limbs')!;
    const sets = docStore.get().skeleton.selectionSets!;
    expect(sets.map((s) => s.name)).toEqual(['limbs', 'limbs2']);
    docStore.update('rename', (d) => void (d.skeleton.bones.find((x) => x.id === armL.id)!.name = 'hand'));
    expect(setBones(docStore.get().skeleton, sets[0])).toEqual([armL.id, armR.id]);
    docStore.update('delete', (d) => void (d.skeleton.bones = d.skeleton.bones.filter((x) => x.id !== armL.id)));
    expect(setBones(docStore.get().skeleton, docStore.get().skeleton.selectionSets![0])).toEqual([armR.id]);
    renameSelectionSet(b, 'limbs');
    expect(docStore.get().skeleton.selectionSets![1].name).toBe('limbs2');
    renameSelectionSet(b, 'back');
    expect(docStore.get().skeleton.selectionSets![1].name).toBe('back');
    deleteSelectionSet(a);
    deleteSelectionSet(b);
    expect(docStore.get().skeleton.selectionSets).toBeUndefined();
  });

  it('update replaces the bones; Shift adds the set to the selection and takes it out again', () => {
    const { spine, armL, armR, tail } = rig();
    setSelection({ bones: [armL.id] });
    const id = saveSelectionSet('s')!;
    setSelection({ bones: [armL.id, armR.id] });
    updateSelectionSet(id);
    expect(docStore.get().skeleton.selectionSets![0].bones).toEqual([armL.id, armR.id]);
    setSelection({ bones: [tail.id] });
    selectSet(id, true);
    expect(uiStore.get().selection.bones).toEqual([tail.id, armL.id, armR.id]);
    selectSet(id, true);
    expect(uiStore.get().selection.bones).toEqual([tail.id]);
    const doc = docStore.get().skeleton;
    const set = doc.selectionSets![0];
    expect(selectionIs(doc, set, [armR.id, armL.id])).toBe(true);
    expect(selectionIs(doc, set, [armL.id])).toBe(false);
    expect(pickSet(doc, set, [spine.id], false)).toEqual([armL.id, armR.id]);
  });

  it('are undone as one step and stay out of the export', async () => {
    const { armL } = rig();
    setSelection({ bones: [armL.id] });
    saveSelectionSet('x');
    expect(docStore.get().skeleton.selectionSets).toHaveLength(1);
    const { json } = await exportAndLoad(docStore.get());
    expect(JSON.stringify(json)).not.toContain('selectionSets');
    docStore.undo();
    expect(docStore.get().skeleton.selectionSets).toBeUndefined();
  });

  it('a damaged list in a file is repaired on load', () => {
    const { root, armL } = rig();
    const p = structuredClone(docStore.get());
    p.skeleton.selectionSets = [
      { id: 'a', name: 'ok', bones: [armL.id, 'ghost', armL.id] },
      { id: 'b', name: 'empty', bones: ['ghost'] },
      { id: 'a', name: '', bones: [root.id] },
      null as never,
    ];
    const notes = repairProject(p);
    expect(notes.length).toBeGreaterThan(0);
    const sets = p.skeleton.selectionSets;
    expect(sets).toHaveLength(2);
    expect(sets[0].bones).toEqual([armL.id]);
    expect(new Set(sets.map((s) => s.id)).size).toBe(2);
    expect(new Set(sets.map((s) => s.name)).size).toBe(2);
    const q = structuredClone(docStore.get());
    (q.skeleton as unknown as Record<string, unknown>).selectionSets = 'nope';
    repairProject(q);
    expect(q.skeleton.selectionSets).toBeUndefined();
  });

  it('newSelectionSet drops bones that do not exist', () => {
    const { armL } = rig();
    const s = newSelectionSet(docStore.get().skeleton, [armL.id, 'ghost']);
    expect(s.bones).toEqual([armL.id]);
  });
});

describe('constraint presets', () => {
  beforeEach(() => {
    rig();
    presetsStore.set({ list: [] });
  });

  const physics = () => {
    const { tail, spine } = rig();
    const a = newPhysicsConstraint({ name: 'tail physics', bone: tail.id, strength: 80, damping: 0.55, mass: 2, wind: 3, rotate: 0.5 });
    const b = newPhysicsConstraint({ name: 'spine physics', bone: spine.id });
    docStore.update('add', (d) => void d.skeleton.constraints.push(a, b));
    return { a, b };
  };
  const phys = (id: string) => docStore.get().skeleton.constraints.find((c) => c.id === id) as PhysicsConstraint;

  it('keeps the settings, not what the constraint points at, and puts them on another constraint', () => {
    const { a, b } = physics();
    const preset = savePreset(a.id, 'floppy')!;
    expect(preset.type).toBe('physics');
    expect(Object.keys(preset.settings)).not.toContain('bone');
    expect(Object.keys(preset.settings)).not.toContain('name');
    expect(applyPreset(b.id, preset.id)).toBeGreaterThan(0);
    const got = phys(b.id);
    expect([got.strength, got.damping, got.mass, got.wind, got.rotate]).toEqual([80, 0.55, 2, 3, 0.5]);
    expect(got.bone).toBe(b.bone);
    expect(got.name).toBe('spine physics');
    docStore.undo();
    expect(phys(b.id).strength).toBe(b.strength);
  });

  it('a preset of another kind is not applied; the same name replaces the preset', () => {
    const { tail, spine, root } = rig();
    const a = newPhysicsConstraint({ name: 'p', bone: tail.id, strength: 10 });
    const path = newPathConstraint({ name: 'path', bones: [spine.id], target: 'slot' });
    docStore.update('add', (d) => void d.skeleton.constraints.push(a, path));
    const preset = savePreset(a.id, 'one')!;
    expect(applyPreset(path.id, preset.id)).toBe(0);
    docStore.update('edit', (d) => void ((d.skeleton.constraints.find((c) => c.id === a.id) as PhysicsConstraint).strength = 99));
    const again = savePreset(a.id, 'ONE')!;
    expect(again.id).toBe(preset.id);
    expect(presetsStore.get().list).toHaveLength(1);
    expect(presetsStore.get().list[0].settings.strength).toBe(99);
    deletePreset(preset.id);
    expect(presetsStore.get().list).toHaveLength(0);
    expect(root).toBeDefined();
  });

  it('a path preset keeps the modes and leaves the bones and target', () => {
    const { spine, tail } = rig();
    const one = newPathConstraint({
      name: 'a',
      bones: [spine.id],
      target: 's1',
      positionMode: 'percent',
      spacingMode: 'proportional',
      rotateMode: 'chainScale',
      offsetRotation: 12,
    });
    const two = newPathConstraint({ name: 'b', bones: [tail.id], target: 's2' });
    docStore.update('add', (d) => void d.skeleton.constraints.push(one, two));
    const preset = savePreset(one.id, 'ribbon')!;
    applyPreset(two.id, preset.id);
    const got = docStore.get().skeleton.constraints.find((c) => c.id === two.id)!;
    expect(got).toMatchObject({
      positionMode: 'percent',
      spacingMode: 'proportional',
      rotateMode: 'chainScale',
      offsetRotation: 12,
      bones: [tail.id],
      target: 's2',
    });
  });

  it('a damaged setting is skipped and physics values stay in their limits', () => {
    const { b } = physics();
    const c = structuredClone(b);
    const before = c.strength;
    const changed = applyPresetSettings(c, { strength: 'strong', damping: 7, mass: -4, bone: 'x', global: { inertia: true } }, (p, v) =>
      p === 'damping' ? Math.min(1, v) : p === 'mass' ? Math.max(0.01, v) : v,
    );
    expect(c.strength).toBe(before);
    expect(c.damping).toBe(1);
    expect(c.mass).toBe(0.01);
    expect(c.bone).toBe(b.bone);
    expect(c.global.inertia).toBe(false); // an object with a missing key does not fit
    expect(changed).toBe(2);
    expect(presetSettings(c).global).toEqual(c.global);
  });

  it('the stored library is read for what it is worth', () => {
    const raw = JSON.stringify([
      { id: '1', name: 'good', type: 'physics', settings: { strength: 5 } },
      { id: '2', name: 'good', type: 'physics', settings: { strength: 6 } },
      { id: '3', name: '', type: 'ik', settings: {} },
      { id: '4', name: 'odd', type: 'wobble', settings: {} },
      { id: '5', name: 'list', type: 'ik', settings: [] },
      7,
    ]);
    const list = readPresets(raw);
    expect(list.map((p) => p.name)).toEqual(['good', 'good2']);
    expect(readPresets('not json')).toEqual([]);
    expect(readPresets(null)).toEqual([]);
  });
});

describe('saved layouts', () => {
  beforeEach(() => {
    namedLayoutsStore.set({ list: [] });
    uiStore.patch({ views: { ...DEFAULT_VIEWS }, panel: { left: 270, right: 300, bottom: 300 } });
  });

  it('keeps the windows and their sizes under a name and brings them back', () => {
    uiStore.patch({ views: { ...DEFAULT_VIEWS, timeline: false, poses: true }, panel: { left: 200, right: 310, bottom: 150 } });
    const mine = saveLayoutAs('Mesh')!;
    uiStore.patch({ views: { ...DEFAULT_VIEWS }, panel: { left: 270, right: 300, bottom: 300 } });
    applySavedLayout(mine.id);
    expect(uiStore.get().views.poses).toBe(true);
    expect(uiStore.get().views.timeline).toBe(false);
    expect(uiStore.get().panel).toEqual({ left: 200, right: 310, bottom: 150 });
  });

  it('the same name replaces the arrangement, a delete removes it', () => {
    const a = saveLayoutAs('Setup')!;
    uiStore.patch({ views: { ...DEFAULT_VIEWS, metrics: true } });
    const b = saveLayoutAs('setup')!;
    expect(b.id).toBe(a.id);
    expect(namedLayoutsStore.get().list).toHaveLength(1);
    expect(namedLayoutsStore.get().list[0].views.metrics).toBe(true);
    expect(saveLayoutAs('   ')).toBeNull();
    deleteSavedLayout(a.id);
    expect(namedLayoutsStore.get().list).toHaveLength(0);
  });

  it('the stored list is read for what it is worth', () => {
    const raw = JSON.stringify([
      { id: 'a', name: 'One', views: { tree: false, ghost: true }, panel: { left: 50, right: 300, bottom: 300 } },
      { id: 'b', name: 'one', views: DEFAULT_VIEWS, panel: { left: 300, right: 300, bottom: 300 } },
      { id: 'c', name: ' ', views: DEFAULT_VIEWS },
      { name: 'no id' },
      'x',
    ]);
    const list = readNamedLayouts(raw);
    expect(list.map((l) => l.name)).toEqual(['One', 'one 2']);
    expect(list[0].views.tree).toBe(false);
    expect(list[0].views.inspector).toBe(true);
    expect(list[0].panel.left).not.toBe(50); // a size outside 100..1200 is not taken
    expect(readNamedLayouts('{}')).toEqual([]);
    expect(uniqueLayoutName([{ name: 'A' }, { name: 'a 2' }], 'a')).toBe('a 3');
  });
});

describe('micro-move', () => {
  beforeEach(() => void rig());

  it('steps: a unit of position or rotation, a hundredth of scale, Shift is ten times', () => {
    expect([stepOf('translate'), stepOf('rotate'), stepOf('shearx'), stepOf('scale'), stepOf('scalex')]).toEqual([1, 1, 1, 0.01, 0.01]);
    expect(arrowSteps('arrowright', false)).toEqual({ dx: 1, dy: 0 });
    expect(arrowSteps('arrowleft', true)).toEqual({ dx: -10, dy: 0 });
    expect(arrowSteps('arrowup', false)).toEqual({ dx: 0, dy: 1 });
    expect(arrowSteps('arrowdown', true)).toEqual({ dx: 0, dy: -10 });
    expect(nudgeValue('rotate', [10], 1)).toEqual([11]);
    expect(nudgeValue('translate', [3, 4], -2)).toEqual([3, 2]);
    expect(nudgeValue('scale', [1, 1], 10)[0]).toBeCloseTo(1.1, 9);
    expect(nudgeValue('translatex', [5], 1)).toEqual([6]);
    expect(nudgeValue('rotate', [], 1)).toEqual([]);
  });

  it('moves the selected bones by a unit in the scene, a child of a selected bone comes along on its own', () => {
    const { spine, armL, tail } = rig();
    setSelection({ bones: [tail.id] });
    expect(nudgeBones(5, 0)).toBe(1);
    expect(docStore.get().skeleton.bones.find((b) => b.id === tail.id)!.x).toBeCloseTo(-5, 6);
    setSelection({ bones: [spine.id, armL.id] });
    expect(nudgeBones(0, 3)).toBe(1);
    const bones = docStore.get().skeleton.bones;
    expect(bones.find((b) => b.id === spine.id)!.y).toBeCloseTo(13, 6);
    expect(bones.find((b) => b.id === armL.id)!.y).toBeCloseTo(0, 6);
    setSelection({});
    expect(nudgeBones(1, 1)).toBe(0);
  });

  it('follows a rotated parent: the arrow moves the bone along the scene axes', () => {
    const { spine, armL } = rig();
    docStore.update('turn', (d) => void (d.skeleton.bones.find((b) => b.id === spine.id)!.rotation = 90));
    setSelection({ bones: [armL.id] });
    nudgeBones(1, 0);
    const b = docStore.get().skeleton.bones.find((x) => x.id === armL.id)!;
    // a scene step to the right is a step "down" in the frame of a parent turned 90 degrees
    expect(b.x).toBeCloseTo(40, 6);
    expect(b.y).toBeCloseTo(-1, 6);
  });

  it('keys: Alt+arrows move the selected keys by a frame and nudge their values', () => {
    const { armL } = rig();
    const a = newAnimation('a', 2);
    a.bones[armL.id] = {
      rotate: [
        { time: 0, value: [0] },
        { time: 1, value: [40] },
      ],
      translate: [
        { time: 0, value: [0, 0] },
        { time: 1, value: [5, 5] },
      ],
    };
    docStore.update('anim', (d) => void d.skeleton.animations.push(a));
    const fps = docStore.get().skeleton.fps;
    uiStore.patch({ mode: 'animate', animationId: a.id, time: 0 });
    const ref = (prop: string, time: number) => JSON.stringify(['bone', armL.id, prop, time]);
    uiStore.patch({ selectedKeys: [ref('rotate', 1), ref('translate', 1)] });
    expect(nudgeKeyValues(2)).toBe(2);
    const anim = () => docStore.get().skeleton.animations[0].bones[armL.id];
    expect(anim().rotate![1].value).toEqual([42]);
    expect(anim().translate![1].value).toEqual([5, 7]);
    expect(nudgeKeysTime(-3)).toBe(2);
    const t = 1 - 3 / fps;
    expect(anim().rotate![1].time).toBeCloseTo(t, 6);
    expect(uiStore.get().selectedKeys).toHaveLength(2);
    // a key never goes before the start
    nudgeKeysTime(-1000);
    expect(anim().rotate![0].time).toBe(0);
    expect(anim().rotate!.every((k) => k.time >= 0)).toBe(true);
    uiStore.patch({ selectedKeys: [] });
    expect(nudgeKeyValues(1)).toBe(0);
  });
});
