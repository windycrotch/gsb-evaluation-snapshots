/**
 * Path constraints and path attachments: our solver against the OFFICIAL runtime (@esotericsoftware/spine-core 4.3.x) on the
 * fixture rig plus `addPathRig` (open / closed / weighted paths, every rotate / position / spacing mode, animated position, spacing,
 * mixes and deformation, an attachment that disappears, an "alt" skin with a different path). Mutants prove the comparison bites.
 */
import { describe, expect, it } from 'vitest';
import { applyAnimation } from '../src/core/animate';
import { removeBones, removeSlots } from '../src/core/edit';
import { exportSpineJson } from '../src/core/export/spineJson';
import { importSpineJson } from '../src/core/import/spineJson';
import { emptyProject, newBone, newPathConstraint, newSlot } from '../src/core/model';
import type { Project } from '../src/core/model';
import { compileSkeleton, createSkeleton, meshWorldVertices } from '../src/core/skeleton';
import type { Skeleton } from '../src/core/skeleton';
import { repairProject, validateProject } from '../src/core/validate';
import { buildFixture } from './fixture';
import { S, exportAndLoad, startLikeOfficial } from './official';
import { addPathRig } from './pathrig';

function build() {
  const f = buildFixture();
  const rig = addPathRig(f.project);
  return { project: f.project, rig };
}

describe('path constraints vs the official runtime', () => {
  const { project, rig } = build();
  const doc = project.skeleton;
  const { skeletonData: sd } = exportAndLoad(project);
  const data = compileSkeleton(doc);
  const walk = doc.animations.find((a) => a.name === 'walk')!;

  const pathBones = Object.keys(rig.boneId).filter((n) => /^(rp|tn|lp|pr|wf|wp)\d$/.test(n));

  const compare = (t: number | null, opts: { skin?: string; mutate?: (s: Skeleton) => void; tolerance?: number } = {}) => {
    const official = new S.Skeleton(sd);
    if (opts.skin) official.setSkin(sd.findSkin(opts.skin));
    official.setupPose();
    if (t !== null) {
      const state = new S.AnimationState(new S.AnimationStateData(sd));
      state.setAnimation(0, 'walk', false);
      state.update(t);
      state.apply(official);
    }
    official.updateWorldTransform(S.Physics.update);
    const ours = createSkeleton(data, opts.skin ? doc.skins.find((s) => s.name === opts.skin)!.id : undefined);
    startLikeOfficial(ours);
    applyAnimation(ours, t === null ? null : walk, t ?? 0);
    opts.mutate?.(ours);
    ours.updateWorldTransform();
    const tol = opts.tolerance ?? 3e-4;
    let compared = 0;
    for (const ob of official.bones) {
      const mine = ours.bones[data.boneIndex.get(rig.boneId[ob.data.name] ?? doc.bones.find((b) => b.name === ob.data.name)!.id)!];
      const q = ob.appliedPose;
      const pairs: [string, number, number][] = [
        ['a', mine.a, q.a],
        ['b', mine.b, q.b],
        ['c', mine.c, q.c],
        ['d', mine.d, q.d],
        ['worldX', mine.worldX, q.worldX],
        ['worldY', mine.worldY, q.worldY],
      ];
      for (const [what, x, y] of pairs) {
        if (!(Math.abs(x - y) <= tol * Math.max(1, Math.abs(x), Math.abs(y))))
          throw new Error(`t=${t} skin=${opts.skin ?? 'default'} bone ${ob.data.name}.${what}: ours=${x} official=${y}`);
      }
      if (pathBones.includes(ob.data.name)) compared++;
    }
    return compared;
  };

  it('the official loader accepts the export and reads every path property', () => {
    const constraints = sd.constraints.filter((c: any) => c instanceof S.PathConstraintData);
    expect(constraints.length).toBe(6);
    const byName = (n: string) => constraints.find((c: any) => c.name === n);
    expect(byName('rope follow').rotateMode).toBe(S.RotateMode.Chain);
    expect(byName('rope tangent').rotateMode).toBe(S.RotateMode.Tangent);
    expect(byName('rope tangent').positionMode).toBe(S.PositionMode.Fixed);
    expect(byName('rope tangent').spacingMode).toBe(S.SpacingMode.Fixed);
    expect(byName('rope tangent').offsetRotation).toBe(10);
    expect(byName('loop scale').rotateMode).toBe(S.RotateMode.ChainScale);
    expect(byName('loop proportional').spacingMode).toBe(S.SpacingMode.Proportional);
    expect(byName('weighted partial').setupPose.mixY).toBeCloseTo(0.5, 6);
    expect(byName('rope follow').slot.name).toBe('ropePath');
    expect(byName('rope follow').bones.map((b: any) => b.name)).toEqual(['rp1', 'rp2', 'rp3', 'rp4']);

    const skin = sd.findSkin('default');
    const slotIndex = (n: string) => sd.findSlot(n).index;
    const open = skin.getAttachment(slotIndex('ropePath'), 'ropeA');
    const closed = skin.getAttachment(slotIndex('loopPath'), 'loopB');
    const weighted = skin.getAttachment(slotIndex('wPath'), 'wpath');
    expect([open.closed, open.constantSpeed, open.worldVerticesLength]).toEqual([false, true, 24]);
    expect([closed.closed, closed.constantSpeed, closed.worldVerticesLength]).toEqual([true, false, 18]);
    expect(closed.lengths.slice(0, 3).every((v: number, i: number, a: number[]) => v > 0 && (i === 0 || v > a[i - 1]))).toBe(true);
    expect(weighted.bones).not.toBeNull();
    expect(sd.findAnimation('walk').timelines.some((t: any) => t instanceof S.PathConstraintMixTimeline)).toBe(true);
    expect(sd.findAnimation('walk').timelines.some((t: any) => t instanceof S.PathConstraintPositionTimeline)).toBe(true);
    expect(sd.findAnimation('walk').timelines.some((t: any) => t instanceof S.PathConstraintSpacingTimeline)).toBe(true);
  });

  it('matches in setup pose (default and alt skin)', () => {
    expect(compare(null)).toBe(pathBones.length);
    compare(null, { skin: 'alt' });
  });

  for (const t of [0.05, 0.1, 0.25, 0.33, 0.45, 0.55, 0.7, 0.85, 0.93, 1.05, 1.15]) {
    it(`matches at t=${t}`, () => {
      compare(t);
    });
  }

  it('matches with the alt skin (a different path under the same name)', () => {
    for (const t of [0.1, 0.4, 0.7, 1.13]) compare(t, { skin: 'alt' });
  });

  it('every constraint really moves its bones (the comparison is not vacuous)', () => {
    const pose = (mutate?: (s: Skeleton) => void) => {
      const s = createSkeleton(data);
      applyAnimation(s, walk, 0.4);
      mutate?.(s);
      s.updateWorldTransform();
      return s;
    };
    const base = pose();
    for (const key of ['rope', 'tangent', 'scale', 'proportional', 'weighted', 'partial']) {
      const off = pose((s) => void (s.pathById(rig.constraintId[key])!.mix = [0, 0, 0]));
      const c = doc.constraints.find((x) => x.id === rig.constraintId[key])!;
      if (c.type !== 'path') throw new Error('not a path constraint');
      let moved = 0;
      for (const id of c.bones) {
        const i = data.boneIndex.get(id)!;
        moved = Math.max(moved, Math.hypot(base.bones[i].worldX - off.bones[i].worldX, base.bones[i].worldY - off.bones[i].worldY));
      }
      expect(moved, `constraint "${c.name}" barely moves its bones`).toBeGreaterThan(5);
    }
  });

  describe('mutants are caught', () => {
    const times = [0.2, 0.4, 0.7];
    const mutants: [string, (s: Skeleton) => void][] = [
      ['rope position', (s) => void (s.pathById(rig.constraintId.rope)!.position += 0.06)],
      ['rope spacing', (s) => void (s.pathById(rig.constraintId.rope)!.spacing += 6)],
      ['tangent position', (s) => void (s.pathById(rig.constraintId.tangent)!.position += 12)],
      ['tangent rotate mix', (s) => void (s.pathById(rig.constraintId.tangent)!.mix[0] -= 0.5)],
      ['loop scale position', (s) => void (s.pathById(rig.constraintId.scale)!.position += 0.05)],
      ['loop proportional spacing', (s) => void (s.pathById(rig.constraintId.proportional)!.spacing += 0.5)],
      ['weighted follow position', (s) => void (s.pathById(rig.constraintId.weighted)!.position += 20)],
      ['weighted partial mix y', (s) => void (s.pathById(rig.constraintId.partial)!.mix[2] += 0.4)],
      ['a path bone', (s) => void (s.boneById(rig.boneId.wA)!.x += 6)],
    ];
    for (const [name, mutate] of mutants) {
      it(name, () => {
        for (const t of times) expect(() => compare(t, { mutate }), `${name} at t=${t}`).toThrow(/ours=/);
      });
    }
  });

  it('a path whose attachment is hidden does nothing (loop paths between 0.9 and 1.0)', () => {
    const s = createSkeleton(data);
    applyAnimation(s, walk, 0.93);
    expect(s.slotAttachment(s.slotById(rig.slotId.loopPath)!)).toBeNull();
    compare(0.93);
  });

  it('deform keys move the path (the bones follow the deformed curve)', () => {
    const points = (t: number | null) => {
      const s = createSkeleton(data);
      applyAnimation(s, t === null ? null : walk, t ?? 0);
      s.updateWorldTransform();
      const slot = s.slotById(rig.slotId.ropePath)!;
      const att = s.slotAttachment(slot)!;
      if (att.kind !== 'path') throw new Error('not a path');
      const out: number[] = [];
      meshWorldVertices(s, slot, att, slot.deform.length ? slot.deform : null, out);
      return out;
    };
    const setup = points(null);
    const deformed = points(0.55);
    // vertex 4 of the path (the second anchor) has a deform key of (5, 14) at 0.6
    expect(Math.hypot(deformed[8] - setup[8], deformed[9] - setup[9])).toBeGreaterThan(0.1);
  });
});

describe('path constraints: geometry that can be checked by hand', () => {
  /** root + two bones on a straight 300 unit path along x. */
  function straight(
    over: Partial<Parameters<typeof newPathConstraint>[0]>,
    closed = false,
    constantSpeed = true,
  ): { project: Project; sk: Skeleton; ids: string[] } {
    const project = emptyProject('hand');
    const d = project.skeleton;
    const a = newBone({ name: 'a', parent: d.bones[0].id, length: 50, y: 40, x: -20 });
    const b = newBone({ name: 'b', parent: a.id, length: 50, x: 50 });
    d.bones.push(a, b);
    const slot = newSlot({ name: 'path', bone: d.bones[0].id, attachment: 'p' });
    d.slots.push(slot);
    d.skins[0].attachments[slot.id] = {
      p: closed
        ? {
            type: 'path',
            name: 'p',
            color: [1, 1, 1, 1],
            closed: true,
            constantSpeed,
            weights: null,
            vertices: [0, 33, 0, 0, 100, 0, 200, 0, 300, 0, 300, 33, 300, 67, 300, 100, 200, 100, 100, 100, 0, 100, 0, 67],
          }
        : {
            type: 'path',
            name: 'p',
            color: [1, 1, 1, 1],
            closed: false,
            constantSpeed,
            weights: null,
            vertices: [0, 0, 0, 0, 100, 0, 200, 0, 300, 0, 300, 0],
          },
    };
    d.constraints.push(newPathConstraint({ name: 'c', bones: [a.id, b.id], target: slot.id, ...over }));
    const sk = createSkeleton(compileSkeleton(d));
    sk.updateWorldTransform();
    return { project, sk, ids: [a.id, b.id] };
  }

  it('fixed position and spacing put the bones at known places (constant speed and setup lengths agree on a straight path)', () => {
    for (const constantSpeed of [true, false]) {
      const { sk, ids } = straight(
        { positionMode: 'fixed', spacingMode: 'fixed', rotateMode: 'tangent', position: 120, spacing: 50 },
        false,
        constantSpeed,
      );
      const [a, b] = ids.map((id) => sk.boneById(id)!);
      expect(
        [a.worldX, a.worldY].map((v) => +v.toFixed(3)),
        `constantSpeed=${constantSpeed}`,
      ).toEqual([120, 0]);
      expect([b.worldX, b.worldY].map((v) => +v.toFixed(3))).toEqual([170, 0]);
      expect(Math.abs(Math.atan2(a.c, a.a))).toBeLessThan(1e-6); // tangent: pointing along +x
    }
  });

  it('percent position and percent spacing', () => {
    const { sk, ids } = straight({ positionMode: 'percent', spacingMode: 'percent', rotateMode: 'tangent', position: 0.5, spacing: 0.1 });
    const [a, b] = ids.map((id) => sk.boneById(id)!);
    expect(+a.worldX.toFixed(3)).toBe(150);
    expect(+b.worldX.toFixed(3)).toBe(180);
  });

  it('positions beyond the ends continue along the end tangents (before: negative, after: past the length)', () => {
    const before = straight({ positionMode: 'fixed', spacingMode: 'fixed', rotateMode: 'tangent', position: -30, spacing: 10 });
    expect(+before.sk.boneById(before.ids[0])!.worldX.toFixed(3)).toBe(-30);
    const after = straight({ positionMode: 'fixed', spacingMode: 'fixed', rotateMode: 'tangent', position: 330, spacing: 10 });
    expect(+after.sk.boneById(after.ids[0])!.worldX.toFixed(3)).toBe(330);
  });

  it('a closed path wraps around (position past the length comes back to the start)', () => {
    // a 300 x 100 rectangle with straight edges: 800 units around; 0.25 of it is 200 units along the bottom edge
    for (const constantSpeed of [true, false]) {
      for (const position of [0.25, 1.25, -0.75]) {
        const { sk, ids } = straight(
          { positionMode: 'percent', spacingMode: 'fixed', rotateMode: 'tangent', position, spacing: 10 },
          true,
          constantSpeed,
        );
        const a = sk.boneById(ids[0])!;
        expect([+a.worldX.toFixed(2), +a.worldY.toFixed(2)], `position ${position}, constantSpeed=${constantSpeed}`).toEqual([200, 0]);
      }
    }
  });

  it('mix 0 leaves the bones alone', () => {
    const { sk, ids } = straight({
      positionMode: 'fixed',
      spacingMode: 'fixed',
      rotateMode: 'tangent',
      position: 120,
      spacing: 50,
      mix: { rotate: 0, x: 0, y: 0 },
    });
    const a = sk.boneById(ids[0])!;
    expect(a.worldX).toBeCloseTo(-20, 4);
    expect(a.worldY).toBeCloseTo(40, 4);
  });
});

describe('path constraints in the document', () => {
  it('a document with the rig needs no repair', () => {
    expect(validateProject(build().project)).toEqual([]);
  });

  it('export -> import -> export is the same JSON and the imported rig agrees with the official runtime', () => {
    const { project } = build();
    const json = exportSpineJson(project.skeleton);
    const { project: back, warnings } = importSpineJson(JSON.parse(JSON.stringify(json)), 'roundtrip');
    expect(warnings).toEqual([]);
    expect(JSON.stringify(exportSpineJson(back.skeleton))).toBe(JSON.stringify(json));
    expect(validateProject(back)).toEqual([]);
    expect(back.skeleton.constraints.filter((c) => c.type === 'path')).toHaveLength(6);
  });

  it('removing the slot of a path removes its constraints and timelines; removing a bone of the chain does too', () => {
    const a = build();
    removeSlots(a.project.skeleton, new Set([a.rig.slotId.ropePath]));
    expect(a.project.skeleton.constraints.some((c) => c.type === 'path' && c.name.startsWith('rope'))).toBe(false);
    expect(Object.keys(a.project.skeleton.animations[0].path).length).toBe(4);
    expect(validateProject(a.project)).toEqual([]);
    const b = build();
    removeBones(b.project.skeleton, [b.rig.boneId.lp2]);
    expect(b.project.skeleton.constraints.some((c) => c.name === 'loop scale')).toBe(false);
    expect(validateProject(b.project)).toEqual([]);
    exportAndLoad(b.project);
  });

  it('repair drops broken paths, constraints and keys instead of exporting something the official loader rejects', () => {
    const { project, rig } = build();
    const d = project.skeleton;
    const skin = d.skins[0];
    // a path with a broken vertex count, a constraint without its slot, deform keys of the wrong size, a bad timeline
    (skin.attachments[rig.slotId.ropePath].ropeA as { vertices: number[] }).vertices.pop();
    const c = d.constraints.find((x) => x.name === 'loop scale')!;
    if (c.type === 'path') c.target = 'nope';
    d.animations[0].path[rig.constraintId.partial].mix = [{ time: 0, value: [1, 1] }];
    const notes = repairProject(project);
    expect(notes.join('\n')).toMatch(/at least 2 nodes|invalid vertices/);
    expect(notes.join('\n')).toMatch(/target slot does not exist/);
    expect(validateProject(project)).toEqual([]);
    expect(() => exportAndLoad(project)).not.toThrow();
    expect(d.animations[0].deform[skin.id]?.[rig.slotId.ropePath]).toBeUndefined();
  });
});
