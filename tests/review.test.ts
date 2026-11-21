/**
 * Regression tests for defects found while reviewing the editor. Every test drives the real editor actions on the
 * nasty fixture rig and then checks the two invariants that matter:
 *   1. the document validator finds nothing to repair, and
 *   2. the exported JSON loads in the OFFICIAL Spine 4.3 runtime.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import { exportSpineJson } from '../src/core/export/spineJson';
import { deformLength, meshWorldPositions } from '../src/core/mesh';
import { repairProject, validateProject } from '../src/core/validate';
import * as A from '../src/store/actions';
import { docStore } from '../src/store/doc';
import * as I from '../src/store/ikActions';
import * as M from '../src/store/meshActions';
import * as P from '../src/store/polygonActions';
import { emptySelection, uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';
import { exportAndLoad } from './official';

const doc = () => docStore.get().skeleton;
const bone = (name: string) => doc().bones.find((b) => b.name === name)!;
const slot = (name: string) => doc().slots.find((s) => s.name === name)!;
const defaultSkin = () => doc().skins[0];
const hasBone = (id: string) => doc().bones.some((b) => b.id === id);

function load() {
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
}

function healthy(label: string) {
  const project = docStore.get();
  expect(validateProject(project), `${label}: validator`).toEqual([]);
  expect(() => exportAndLoad(project), `${label}: official loader`).not.toThrow();
}

describe('review: the fixture itself is healthy', () => {
  it('has nothing to repair and loads officially', () => {
    load();
    healthy('fixture');
  });
});

describe('review: deform keys follow mesh edits', () => {
  beforeEach(load);

  it('deleting an attachment removes its deform timelines (the official loader rejects dangling ones)', () => {
    const head = slot('head');
    A.deleteAttachment(head.id, 'head');
    healthy('after deleteAttachment');
    expect(doc().animations[0].deform[defaultSkin().id]?.[head.id]).toBeUndefined();
  });

  it('adding a vertex appends a zero pair to every deform key', () => {
    const head = slot('head');
    const skinId = defaultSkin().id;
    const old = structuredClone(doc().animations[0].deform[skinId][head.id].head);
    const { mats, slotMat } = M.setupMats();
    const w = meshWorldPositions(M.getMesh(head.id, 'head')!, slotMat(head.id), mats);
    const idx = M.addMeshVertex(head.id, 'head', (w[0] + w[2] + w[4] + w[6]) / 4 + 3, (w[1] + w[3] + w[5] + w[7]) / 4 + 2);
    expect(idx).toBe(4);
    const keys = doc().animations[0].deform[skinId][head.id].head;
    expect(keys.map((k) => k.value.length)).toEqual([10, 10, 10]);
    keys.forEach((k, i) => {
      expect(k.value.slice(0, 8)).toEqual(old[i].value);
      expect(k.value.slice(8)).toEqual([0, 0]);
    });
    healthy('after addMeshVertex');
    docStore.undo();
    expect(doc().animations[0].deform[skinId][head.id].head.map((k) => k.value.length)).toEqual([8, 8, 8]);
  });

  it('deleting a vertex removes its pair from every deform key', () => {
    const head = slot('head');
    const skinId = defaultSkin().id;
    const old = structuredClone(doc().animations[0].deform[skinId][head.id].head);
    M.deleteMeshVertices(head.id, 'head', [3]);
    const keys = doc().animations[0].deform[skinId][head.id].head;
    expect(keys.map((k) => k.value.length)).toEqual([6, 6, 6]);
    keys.forEach((k, i) => expect(k.value).toEqual(old[i].value.slice(0, 6)));
    healthy('after deleteMeshVertices');
  });

  it('painting weights keeps weighted deform keys the right size', () => {
    const arm = slot('arm');
    const skinId = defaultSkin().id;
    const mesh0 = M.getMesh(arm.id, 'arm')!;
    const before = deformLength(mesh0, hasBone);
    const sumBefore = doc().animations[0].deform[skinId][arm.id].arm[1].value.reduce((s, v) => s + Math.abs(v), 0);
    uiStore.patch({ brush: { size: 800, strength: 1, mode: 'add', bone: bone('armLower').id, feather: 100, locked: [] } });
    const { mats, slotMat } = M.setupMats();
    const w = meshWorldPositions(mesh0, slotMat(arm.id), mats);
    M.paintWeights(arm.id, 'arm', { x: w[0], y: w[1] }, bone('armLower').id);
    const mesh1 = M.getMesh(arm.id, 'arm')!;
    const after = deformLength(mesh1, hasBone);
    expect(after).not.toBe(before); // the brush really changed the influence layout (some added, some dropped)
    const keys = doc().animations[0].deform[skinId][arm.id].arm;
    for (const k of keys) expect(k.value.length).toBe(after);
    // values of influences that survive stay on their own influence; new ones start at zero
    expect(keys[1].value.reduce((s, v) => s + Math.abs(v), 0)).toBeLessThanOrEqual(sumBefore + 1e-9);
    healthy('after paintWeights');
  });

  it('binding an unweighted mesh drops its (now meaningless) deform keys', () => {
    const head = slot('head');
    M.bindMeshToBones(head.id, 'head', [bone('head').id, bone('torso').id]);
    expect(M.getMesh(head.id, 'head')!.weights).not.toBeNull();
    expect(doc().animations[0].deform[defaultSkin().id]?.[head.id]).toBeUndefined();
    healthy('after bind');
    docStore.undo(); // one undo restores both the mesh and the keys
    expect(M.getMesh(head.id, 'head')!.weights).toBeNull();
    expect(doc().animations[0].deform[defaultSkin().id][head.id].head).toHaveLength(3);
  });

  it('re-tracing / quad conversion never leaves stale keys', () => {
    const head = slot('head');
    M.retriangulateMesh(head.id, 'head');
    healthy('after retriangulate');
  });
});

describe('review: deleting things leaves no dangling data', () => {
  beforeEach(load);

  it('deleting a transform constraint removes its mix timeline', () => {
    const c = doc().constraints.find((x) => x.name === 'gear drive')!;
    expect(doc().animations[0].transform[c.id]).toBeDefined();
    I.deleteConstraint(c.id);
    expect(doc().animations[0].transform[c.id]).toBeUndefined();
    healthy('after deleteConstraint');
  });

  it('deleting a bone keeps weighted vertices in place (no vertex collapses to the origin)', () => {
    const arm = slot('arm');
    const before = (() => {
      const { mats, slotMat } = M.setupMats();
      return Array.from(meshWorldPositions(M.getMesh(arm.id, 'arm')!, slotMat(arm.id), mats));
    })();
    A.deleteBones([bone('armLower').id]);
    const mesh = M.getMesh(arm.id, 'arm')!;
    expect(mesh.weights!.every((list) => list.length > 0)).toBe(true);
    const { mats, slotMat } = M.setupMats();
    const after = Array.from(meshWorldPositions(mesh, slotMat(arm.id), mats));
    // vertex 4 was bound to armLower only. (The others may move: the arm IK disappears together with the bone.)
    expect(after[8]).toBeCloseTo(before[8], 3);
    expect(after[9]).toBeCloseTo(before[9], 3);
    healthy('after deleteBones');
  });

  it('deleting a skin, event or animation leaves nothing behind', () => {
    const alt = doc().skins.find((s) => s.name === 'alt')!;
    A.deleteSkin(alt.id);
    A.deleteEvent(doc().events[0].id);
    healthy('after deleting skin + event');
    A.deleteAnimation(doc().animations[0].id);
    healthy('after deleting the animation');
  });
});

describe('selection never refers to something that is gone', () => {
  beforeEach(load);

  it('undoing the creation of the selected attachment clears the selection (the Inspector used to crash on it)', () => {
    const stop = docStore.subscribe(A.sanitizeSelection); // what the app does
    try {
      A.selectBone(bone('torso').id);
      const made = P.createPolygon('clipping', [
        [-50, 0],
        [50, 0],
        [0, 80],
      ]);
      expect(made).not.toBeNull();
      expect(uiStore.get().selection.slot).toBe(made!.slotId);
      docStore.undo();
      const sel = uiStore.get().selection;
      expect(sel.slot).toBeNull();
      expect(sel.attachment).toBeNull();
      expect(sel.bones).toEqual([bone('torso').id]); // the bone is still there
      docStore.redo();
      expect(doc().slots.some((s) => s.id === made!.slotId)).toBe(true);
    } finally {
      stop();
    }
  });

  it('deleting the selected bone or constraint clears it as well', () => {
    const stop = docStore.subscribe(A.sanitizeSelection);
    try {
      A.setSelection({ bones: [bone('tail').id] });
      A.deleteBones([bone('tail').id]);
      expect(uiStore.get().selection.bones).toEqual([]);
      const ik = doc().constraints.find((c) => c.type === 'ik')!;
      A.setSelection({ constraint: ik.id });
      I.deleteConstraint(ik.id);
      expect(uiStore.get().selection.constraint).toBeNull();
    } finally {
      stop();
    }
  });
});

describe('review: structural rules', () => {
  beforeEach(load);

  it('a bone that is the second bone of a two-bone IK cannot be reparented elsewhere', () => {
    const lower = bone('legLower');
    const parent = lower.parent;
    A.reparentBone(lower.id, bone('torso').id);
    expect(bone('legLower').parent).toBe(parent);
    healthy('after refused reparent');
  });

  it('IK on the root bone is refused (the official runtime loads it, then crashes on the first frame)', () => {
    const root = doc().bones[0];
    expect(I.createIkFromDrag(root.id, null, 10, 10, true)).toBeNull();
    expect(doc().constraints.some((c) => c.type === 'ik' && c.bones.includes(root.id))).toBe(false);
    // and a file that already contains one gets repaired when it is opened
    const f = buildFixture();
    f.project.skeleton.constraints.push({
      id: 'rootik',
      type: 'ik',
      name: 'root ik',
      bones: [f.project.skeleton.bones[0].id],
      target: f.project.skeleton.bones[3].id,
      mix: 1,
      softness: 0,
      bendPositive: true,
      compress: false,
      stretch: false,
      scaleY: 'none',
      skinRequired: false,
    });
    expect(repairProject(f.project).some((m) => m.includes('root bone'))).toBe(true);
    expect(f.project.skeleton.constraints.some((c) => c.id === 'rootik')).toBe(false);
  });

  it('an animation can never be shorter than its last key', () => {
    const anim = doc().animations[0];
    A.setAnimationDuration(anim.id, 0.1);
    expect(doc().animations[0].duration).toBeGreaterThanOrEqual(1.2 - 1e-9);
    healthy('after setAnimationDuration');
  });
});

describe('review: moving keys', () => {
  beforeEach(load);

  it('a key can be dragged in several steps (the ref follows the key, results keep the input order)', () => {
    const torso = bone('torso');
    const anim = doc().animations[0];
    const rot = anim.bones[torso.id].rotate!;
    const t0 = rot[1].time; // 0.4
    // first step
    let refs = A.moveKeysBy([{ kind: 'bone', target: torso.id, prop: 'rotate', time: t0 }], 0.1);
    expect(refs[0].time).toBeCloseTo(t0 + 0.1, 6);
    // second step uses the ref the first one returned
    refs = A.moveKeysBy(refs, 0.1);
    expect(refs[0].time).toBeCloseTo(t0 + 0.2, 6);
    expect(doc().animations[0].bones[torso.id].rotate!.map((k) => +k.time.toFixed(3))).toEqual([0, 0.6, 0.7, 1.2]);
    // a stale ref moves nothing and says so
    const stale = A.moveKeysBy([{ kind: 'bone', target: torso.id, prop: 'rotate', time: t0 }], 0.1);
    expect(stale[0].time).toBeCloseTo(t0, 6);
    expect(doc().animations[0].bones[torso.id].rotate!.map((k) => +k.time.toFixed(3))).toEqual([0, 0.6, 0.7, 1.2]);
    healthy('after moving keys');
  });

  it('refs of several timelines come back in the order they were given', () => {
    const torso = bone('torso');
    const head = bone('head');
    const a = { kind: 'bone' as const, target: torso.id, prop: 'rotate', time: 0.4 };
    const b = { kind: 'bone' as const, target: head.id, prop: 'rotate', time: 0.6 };
    const c = { kind: 'bone' as const, target: torso.id, prop: 'rotate', time: 0.7 };
    const out = A.moveKeysBy([a, b, c], 0.05);
    expect(out.map((r) => [r.target, +r.time.toFixed(3)])).toEqual([
      [torso.id, 0.45],
      [head.id, 0.65],
      [torso.id, 0.75],
    ]);
  });

  it('moving an event key onto another event keeps both (several events may fire at one time)', () => {
    const anim = doc().animations[0];
    const hit = doc().events[0];
    A.setMode('animate');
    uiStore.patch({ time: 0.9 });
    A.keyEvent(hit.id); // a third event key at 0.9 (the fixture has 0.5 and 0.9)
    expect(doc().animations[0].events.length).toBe(3);
    A.moveKeysBy([{ kind: 'event', target: '', prop: '', time: 0.5 }], 0.4);
    expect(doc().animations[0].events.length).toBe(3);
    expect(anim.id).toBe(doc().animations[0].id);
    healthy('after moving events');
  });
});

describe('review: robustness against bad data', () => {
  it('never exports NaN or Infinity (JSON would turn them into null)', () => {
    const f = buildFixture();
    const b = f.project.skeleton.bones.find((x) => x.name === 'head')!;
    b.x = NaN;
    b.rotation = Infinity;
    f.project.skeleton.animations[0].bones[b.id] = {
      rotate: [
        { time: 0, value: [NaN] },
        { time: 1, value: [10] },
      ],
    };
    const text = JSON.stringify(exportSpineJson(f.project.skeleton));
    // (`"name":null` is legal: it is the "hide the attachment" key)
    expect(text).not.toMatch(/"(x|y|rotation|value|time|width|height|mix\w*|offset)":null|NaN|Infinity/);
    expect(text).toContain('"head"');
  });

  it('repairs a damaged project so that it loads and exports', () => {
    const f = buildFixture();
    const p = f.project;
    const d = p.skeleton;
    d.bones[3].parent = 'does-not-exist';
    d.bones[4].name = d.bones[5].name; // duplicate names
    d.bones[6].x = NaN;
    d.slots[0].bone = 'gone';
    const ik = d.constraints[0];
    if (ik.type === 'ik') ik.target = 'gone';
    const anim = d.animations[0];
    anim.bones['missing-bone'] = { rotate: [{ time: 0, value: [1] }] };
    anim.ik['missing-ik'] = [{ time: 0, value: [1, 0], bendPositive: true, compress: false, stretch: false }];
    anim.drawOrder[0].order.push('missing-slot');
    anim.events.push({ time: 0.3, event: 'missing-event' });
    anim.bones[d.bones[2].id] = {
      rotate: [
        { time: 0.5, value: [3] },
        { time: 0.1, value: [1] },
        { time: 0.1, value: [2] },
        { time: NaN, value: [9] },
      ],
    };
    anim.duration = 0.2;
    const msgs = repairProject(p);
    expect(msgs.length).toBeGreaterThan(8);
    expect(repairProject(p)).toEqual([]); // idempotent
    expect(() => exportAndLoad(p)).not.toThrow();
    expect(anim.duration).toBeGreaterThanOrEqual(1.2 - 1e-9);
    const keys = anim.bones[d.bones[2].id].rotate!;
    expect(keys.map((k) => k.time)).toEqual([0.1, 0.5]);
    expect(keys[0].value).toEqual([2]); // the later key at the same time wins
  });

  it('drops stale deform keys when a project is opened', () => {
    const f = buildFixture();
    const p = f.project;
    const head = p.skeleton.slots.find((s) => s.name === 'head')!;
    const mesh = p.skeleton.skins[0].attachments[head.id].head;
    if (mesh.type === 'mesh') mesh.uvs.push(0.5, 0.5); // vertex count changed behind the keys' back
    if (mesh.type === 'mesh') mesh.vertices.push(0, 0);
    expect(repairProject(p).some((m) => m.includes('deform'))).toBe(true);
    expect(p.skeleton.animations[0].deform[p.skeleton.skins[0].id]?.[head.id]).toBeUndefined();
    expect(() => exportAndLoad(p)).not.toThrow();
  });
});
