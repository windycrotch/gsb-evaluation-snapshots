/**
 * Physics constraints (Spine 4.2+) against the OFFICIAL 4.3 runtime, frame by frame: a spring simulation keeps state between
 * frames, so every frame of a played animation is compared, not just one pose. The deliberate bugs at the end show that the
 * comparison would notice them.
 */
import { describe, expect, it } from 'vitest';
import { applyAnimation, applyPhysicsResets } from '../src/core/animate';
import { exportSpineJson } from '../src/core/export/spineJson';
import { importSpineJson } from '../src/core/import/spineJson';
import { GLOBAL_PHYSICS, emptyProject, newAnimation, newBone, newPhysicsConstraint, newSkin } from '../src/core/model';
import type { Id, PhysicsConstraint, Project } from '../src/core/model';
import { compileSkeleton, createSkeleton } from '../src/core/skeleton';
import { S, exportAndLoad } from './official';

interface Rig {
  project: Project;
  id: Record<string, Id>;
  constraint: Record<string, PhysicsConstraint>;
}

const key = (time: number, value: number[], curve?: any) => ({ time, value, ...(curve !== undefined ? { curve } : {}) });

/**
 * A hair-like chain h1 - h2 - h3 hanging on `driver`, which the animation "move" pushes around and spins for two seconds.
 * `configure` adds the physics constraints.
 */
function rig(configure: (r: Rig) => void, opts: { referenceScale?: number } = {}): Rig {
  const project = emptyProject('physics');
  const doc = project.skeleton;
  const id: Record<string, Id> = { root: doc.bones[0].id };
  const bone = (name: string, parent: string, p: any = {}) => {
    const b = newBone({ name, parent: id[parent], length: 50, ...p });
    doc.bones.push(b);
    id[name] = b.id;
  };
  bone('driver', 'root', { x: 0, y: 100, length: 20 });
  bone('h1', 'driver', { x: 60, length: 50 });
  bone('h2', 'h1', { x: 50, length: 50 });
  bone('h3', 'h2', { x: 50, length: 40 });
  bone('side', 'driver', { x: 0, y: -60, length: 30, rotation: -90 });
  if (opts.referenceScale) doc.referenceScale = opts.referenceScale;

  const a = newAnimation('move', 2);
  a.bones[id.driver] = {
    translate: [
      key(0, [0, 0]),
      key(0.5, [200, 100], [0.3, 0, 0.7, 1, 0.3, 0, 0.7, 1]),
      key(1, [-100, 50]),
      key(1.5, [150, -60], 'stepped'),
      key(2, [0, 0]),
    ],
    rotate: [key(0, [0]), key(0.5, [60]), key(1, [-40], [0.25, 0, 0.75, 1]), key(1.5, [30]), key(2, [0])],
  };
  doc.animations.push(a);
  const r: Rig = { project, id, constraint: {} };
  configure(r);
  return r;
}

/** Adds a constraint on bone `name` to the rig (`partial` overrides the defaults). */
function physics(r: Rig, name: string, partial: Partial<PhysicsConstraint> = {}): PhysicsConstraint {
  const c = newPhysicsConstraint({ name: `${name} physics`, bone: r.id[name], ...partial });
  r.project.skeleton.constraints.push(c);
  r.constraint[name] = c;
  return c;
}

/** Frame lengths: a steady 60 Hz, then lengths that do not fit the simulation step. */
function frames(total = 1.95): number[] {
  const out: number[] = [];
  let t = 0;
  for (let i = 0; t < total; i++) {
    const dt = i < 60 ? 1 / 60 : [0.004, 0.03, 0.0167, 0.011, 0.05][i % 5];
    out.push(dt);
    t += dt;
  }
  return out;
}

interface Pose {
  name: string;
  m: number[];
}

const MATRIX = ['a', 'b', 'c', 'd', 'worldX', 'worldY'] as const;

function officialPose(sk: any): Pose[] {
  return sk.bones.map((b: any) => ({ name: b.data.name, m: MATRIX.map((k) => b.appliedPose[k]) }));
}
function oursPose(sk: ReturnType<typeof createSkeleton>): Pose[] {
  return sk.bones.map((b) => ({ name: b.data.name, m: MATRIX.map((k) => b[k]) }));
}

export interface PlayOptions {
  dts?: number[];
  /** Mutates our compiled constraints before the run (the deliberate bugs). */
  tweak?: (sk: ReturnType<typeof createSkeleton>) => void;
  skin?: string;
  /** Scale of the skeleton (both runtimes). */
  scale?: [number, number];
}

/**
 * Plays "move" in both runtimes the way a game does (state.update, state.apply, skeleton.update, updateWorldTransform with
 * Physics.update) and returns the first frame where a bone differs, or null.
 */
function firstDifference(
  r: Rig,
  opts: PlayOptions = {},
): { frame: number; bone: string; what: string; ours: number; official: number } | null {
  const { skeletonData: sd } = exportAndLoad(r.project);
  const doc = r.project.skeleton;
  const anim = doc.animations[0];
  const data = compileSkeleton(doc);
  const skinId = opts.skin ? doc.skins.find((s) => s.name === opts.skin)!.id : null;
  const ours = createSkeleton(data, skinId);
  const official = new S.Skeleton(sd);
  if (opts.skin) official.setSkin(sd.findSkin(opts.skin));
  official.setupPose();
  if (opts.scale) {
    ours.scaleX = opts.scale[0];
    ours.scaleY = opts.scale[1];
    official.scaleX = opts.scale[0];
    official.scaleY = opts.scale[1];
  }
  opts.tweak?.(ours);
  const state = new S.AnimationState(new S.AnimationStateData(sd));
  state.setAnimation(0, 'move', false);
  let time = -1; // the animation starts at -1, like Spine's track entries
  const list = opts.dts ?? frames();
  for (let f = 0; f < list.length; f++) {
    const dt = list[f];
    state.update(dt);
    state.apply(official);
    official.update(dt);
    official.updateWorldTransform(S.Physics.update);
    const last = time;
    time = (time < 0 ? 0 : time) + dt;
    applyAnimation(ours, anim, time);
    applyPhysicsResets(ours, anim, last, time);
    ours.update(dt);
    ours.updateWorldTransform('update');
    const a = oursPose(ours);
    const b = officialPose(official);
    for (let i = 0; i < a.length; i++) {
      for (let k = 0; k < 6; k++) {
        const x = a[i].m[k];
        const y = b[i].m[k];
        if (!(Math.abs(x - y) <= 1e-4 * Math.max(1, Math.abs(x), Math.abs(y))))
          return { frame: f, bone: a[i].name, what: MATRIX[k], ours: x, official: y };
      }
    }
  }
  return null;
}

/** How far the chain moves from where it would hang without physics: proves a scenario really exercises the simulation. */
function swing(r: Rig, bone: string): number {
  const doc = r.project.skeleton;
  const withPhysics = createSkeleton(compileSkeleton(doc));
  const plain = createSkeleton(compileSkeleton({ ...doc, constraints: [] }));
  let most = 0;
  let t = 0;
  for (const dt of frames()) {
    t += dt;
    for (const sk of [withPhysics, plain]) {
      applyAnimation(sk, doc.animations[0], t);
      sk.update(dt);
      sk.updateWorldTransform(sk === withPhysics ? 'update' : 'none');
    }
    const a = withPhysics.boneById(r.id[bone])!;
    const b = plain.boneById(r.id[bone])!;
    most = Math.max(most, Math.hypot(a.worldX - b.worldX, a.worldY - b.worldY) + Math.abs(a.a - b.a) * 50 + Math.abs(a.c - b.c) * 50);
  }
  return most;
}

describe('physics constraint vs the official 4.3 runtime, frame by frame', () => {
  it('rotates a chain of bones hanging on a moving one', () => {
    const r = rig((r) => {
      physics(r, 'h1', { rotate: 1 });
      physics(r, 'h2', { rotate: 1 });
      physics(r, 'h3', { rotate: 1 });
    });
    expect(swing(r, 'h3')).toBeGreaterThan(5);
    expect(firstDifference(r)).toBeNull();
  });

  it('moves a bone in x and y with wind and gravity', () => {
    const r = rig((r) => {
      physics(r, 'h1', { x: 1, y: 1, rotate: 0, gravity: 20, wind: 5, strength: 60, mass: 2, damping: 0.8 });
      physics(r, 'side', { x: 0.6, y: 1, rotate: 0.4, inertia: 0.9, limit: 40 });
    });
    expect(swing(r, 'h1')).toBeGreaterThan(5);
    expect(firstDifference(r)).toBeNull();
  });

  it('stretches along the bone, with every scaleY mode', () => {
    for (const mode of ['none', 'uniform', 'volume'] as const) {
      const r = rig((r) => {
        physics(r, 'h2', { rotate: 0, scaleX: 1, scaleY: mode, inertia: 0.8, strength: 40 });
        physics(r, 'h3', { rotate: 0.5, scaleX: 0.5, scaleY: mode });
      });
      expect(firstDifference(r), mode).toBeNull();
    }
  });

  it('shears and rotates together', () => {
    const r = rig((r) => {
      physics(r, 'h1', { rotate: 0.5, shearX: 1 });
      physics(r, 'h2', { rotate: 0, shearX: 0.7, gravity: 10 });
    });
    expect(firstDifference(r)).toBeNull();
  });

  it('steps at its own rate: 30, 120 and 240 steps per second, short and long frames', () => {
    for (const fps of [30, 120, 240]) {
      const r = rig((r) => {
        physics(r, 'h1', { fps, rotate: 1, x: 0.5 });
        physics(r, 'h2', { fps, rotate: 0.8, scaleX: 0.3 });
      });
      expect(firstDifference(r), `${fps} fps`).toBeNull();
    }
  });

  it('limits how far a jump can push it, and blends with mix', () => {
    const r = rig((r) => {
      physics(r, 'h1', { x: 1, y: 1, rotate: 1, limit: 5, mix: 0.6 });
      physics(r, 'h2', { x: 1, rotate: 1, limit: 0, mix: 1 });
      physics(r, 'h3', { rotate: 1, mix: 0, x: 1 });
    });
    expect(firstDifference(r)).toBeNull();
  });

  it('uses the reference scale of the skeleton for wind and gravity', () => {
    const r = rig(
      (r) => {
        physics(r, 'h1', { x: 1, y: 1, rotate: 1, gravity: 30, wind: 10 });
        physics(r, 'h2', { scaleX: 1, rotate: 1, gravity: 30, wind: 10 });
      },
      { referenceScale: 250 },
    );
    expect(firstDifference(r)).toBeNull();
  });

  it('follows a scaled and mirrored skeleton', () => {
    const r = rig((r) => {
      physics(r, 'h1', { x: 1, y: 1, rotate: 1, limit: 100, gravity: 10 });
      physics(r, 'h2', { rotate: 1, scaleX: 1 });
    });
    expect(firstDifference(r, { scale: [-1.5, 2] })).toBeNull();
    expect(firstDifference(r, { scale: [0.5, -1] })).toBeNull();
  });

  it('is driven by animated parameters, curves included', () => {
    const r = rig((r) => {
      physics(r, 'h1', { rotate: 1, x: 0.5 });
      physics(r, 'h2', { rotate: 1 });
    });
    const a = r.project.skeleton.animations[0];
    a.physics[r.constraint.h1.id] = {
      inertia: [key(0, [0.9]), key(1, [0.2], [0.3, 0, 0.7, 1]), key(2, [0.7])],
      strength: [key(0, [100]), key(1.2, [30])],
      damping: [key(0, [0.85]), key(1, [0.5], 'stepped'), key(1.5, [0.95])],
      mass: [key(0, [1]), key(1, [4], [0.2, 0, 0.8, 1])],
      wind: [key(0.3, [0]), key(1.5, [40])],
      gravity: [key(0.2, [0]), key(1.9, [25])],
      mix: [key(0, [1]), key(0.8, [0.4]), key(1.6, [1])],
    };
    expect(firstDifference(r)).toBeNull();
  });

  it('is driven by the global timelines of the constraints that opt in', () => {
    const r = rig((r) => {
      physics(r, 'h1', {
        rotate: 1,
        global: { inertia: true, strength: false, damping: true, mass: false, wind: true, gravity: false, mix: false },
      });
      physics(r, 'h2', {
        rotate: 1,
        x: 0.5,
        global: { inertia: false, strength: true, damping: false, mass: true, wind: true, gravity: true, mix: true },
      });
      physics(r, 'h3', { rotate: 1 });
    });
    r.project.skeleton.animations[0].physics[GLOBAL_PHYSICS] = {
      inertia: [key(0, [0.3]), key(1.5, [0.9])],
      strength: [key(0, [80]), key(1.5, [20])],
      damping: [key(0, [0.6]), key(1.5, [0.9])],
      mass: [key(0, [1]), key(1.5, [3])],
      wind: [key(0, [0]), key(1.5, [30])],
      gravity: [key(0, [5]), key(1.5, [15])],
      mix: [key(0, [1]), key(1.5, [0.5])],
    };
    expect(firstDifference(r)).toBeNull();
  });

  it('restarts when a reset key is reached', () => {
    const r = rig((r) => {
      physics(r, 'h1', { rotate: 1, x: 1 });
      physics(r, 'h2', { rotate: 1 });
      physics(r, 'h3', { rotate: 1 });
    });
    const a = r.project.skeleton.animations[0];
    a.physics[r.constraint.h1.id] = { reset: [key(0, [1]), key(0.73, [1])] };
    a.physics[GLOBAL_PHYSICS] = { reset: [key(1.37, [1])] };
    expect(firstDifference(r)).toBeNull();
  });

  it('only runs when its skin is active', () => {
    const r = rig((r) => {
      physics(r, 'h1', { rotate: 1, skinRequired: true });
      physics(r, 'h2', { rotate: 1 });
    });
    const skin = newSkin('wavy');
    skin.constraints.push(r.constraint.h1.id);
    r.project.skeleton.skins.push(skin);
    expect(firstDifference(r)).toBeNull();
    expect(firstDifference(r, { skin: 'wavy' })).toBeNull();
  });

  it('keeps the simulation when the pose is applied again, and restarts on a reset', () => {
    const r = rig((r) => {
      physics(r, 'h1', { rotate: 1, x: 1, y: 1 });
      physics(r, 'h2', { rotate: 1, scaleX: 1 });
    });
    const { skeletonData: sd } = exportAndLoad(r.project);
    const doc = r.project.skeleton;
    const ours = createSkeleton(compileSkeleton(doc));
    const official = new S.Skeleton(sd);
    official.setupPose();
    const state = new S.AnimationState(new S.AnimationStateData(sd));
    state.setAnimation(0, 'move', false);
    let t = 0;
    for (let i = 0; i < 40; i++) {
      t += 1 / 60;
      state.update(1 / 60);
      state.apply(official);
      official.update(1 / 60);
      official.updateWorldTransform(S.Physics.update);
      applyAnimation(ours, doc.animations[0], t);
      ours.update(1 / 60);
      ours.updateWorldTransform('update');
    }
    // the same frame again without time passing: Physics.pose applies what the simulation has now
    for (const [mode, theirs] of [
      ['pose', S.Physics.pose],
      ['reset', S.Physics.reset],
    ] as const) {
      state.apply(official);
      official.updateWorldTransform(theirs);
      applyAnimation(ours, doc.animations[0], t);
      ours.updateWorldTransform(mode);
      const a = oursPose(ours);
      const b = officialPose(official);
      for (let i = 0; i < a.length; i++)
        for (let k = 0; k < 6; k++) expect(a[i].m[k], `${mode}: ${a[i].name}.${MATRIX[k]}`).toBeCloseTo(b[i].m[k], 3);
    }
  });
});

describe('physics in the exported file', () => {
  const full = () =>
    rig((r) => {
      physics(r, 'h1', {
        x: 0.4,
        y: 0.2,
        rotate: 0.9,
        scaleX: 0.3,
        scaleY: 'volume',
        shearX: 0.2,
        limit: 120,
        fps: 45,
        inertia: 0.7,
        strength: 80,
        damping: 0.9,
        mass: 2.5,
        wind: 3,
        gravity: 7,
        mix: 0.8,
        global: { inertia: true, strength: false, damping: false, mass: true, wind: false, gravity: false, mix: true },
        skinRequired: true,
      });
      physics(r, 'h2', {});
    });

  it('writes the constraint the way the 4.3 loader reads it, and leaves defaults out', () => {
    const r = full();
    const json: any = exportSpineJson(r.project.skeleton);
    const [a, b] = json.constraints.filter((c: any) => c.type === 'physics');
    expect(a).toMatchObject({
      name: 'h1 physics',
      bone: 'h1',
      skin: true,
      x: 0.4,
      y: 0.2,
      rotate: 0.9,
      scaleX: 0.3,
      scaleY: 'volume',
      shearX: 0.2,
      limit: 120,
      fps: 45,
      inertia: 0.7,
      strength: 80,
      damping: 0.9,
      mass: 2.5,
      wind: 3,
      gravity: 7,
      mix: 0.8,
      inertiaGlobal: true,
      massGlobal: true,
      mixGlobal: true,
    });
    expect(a.strengthGlobal).toBeUndefined();
    expect(b).toEqual({ type: 'physics', name: 'h2 physics', bone: 'h2', rotate: 1 });
  });

  it('survives export -> import -> export', () => {
    const r = full();
    const a = r.project.skeleton.animations[0];
    a.physics[r.constraint.h1.id] = {
      inertia: [key(0, [0.5]), key(1, [0.9], [0.3, 0, 0.7, 1])],
      mass: [key(0.5, [2])],
      reset: [key(0.7, [1])],
    };
    a.physics[GLOBAL_PHYSICS] = { wind: [key(0, [1]), key(1, [9])] };
    const first = exportSpineJson(r.project.skeleton);
    const imported = importSpineJson(JSON.parse(JSON.stringify(first)), 'x');
    expect(imported.warnings).toEqual([]);
    const second = exportSpineJson(imported.project.skeleton);
    expect(second).toEqual(first);
    const move: any = (first.animations as any).move;
    expect(Object.keys(move.physics).sort()).toEqual(['', 'h1 physics']);
    expect(move.physics['h1 physics'].reset).toEqual([{ time: 0.7 }]);
  });

  it('the official loader accepts it, and skin lists and the reference scale come through', () => {
    const r = rig((r) => physics(r, 'h1', { skinRequired: true }), { referenceScale: 180 });
    const skin = newSkin('wavy');
    skin.constraints.push(r.constraint.h1.id);
    r.project.skeleton.skins.push(skin);
    const { skeletonData, json } = exportAndLoad(r.project);
    expect(skeletonData.referenceScale).toBe(180);
    expect((json as any).skins.find((s: any) => s.name === 'wavy').physics).toEqual(['h1 physics']);
    const back = importSpineJson(JSON.parse(JSON.stringify(json)), 'x').project.skeleton;
    expect(back.referenceScale).toBe(180);
    expect(back.skins.find((s) => s.name === 'wavy')!.constraints).toHaveLength(1);
  });
});

describe('the comparison catches a wrong simulation', () => {
  const base = () =>
    rig((r) => {
      physics(r, 'h1', { x: 1, y: 1, rotate: 1, scaleX: 0.5, gravity: 15, wind: 4 });
      physics(r, 'h2', { rotate: 1 });
    });
  const mutated = (name: string, tweak: (data: any) => void) =>
    it(name, () => {
      expect(
        firstDifference(base(), {
          tweak: (sk) => {
            const c = sk.constraints.find((x) => x.kind === 'physics' && x.data.name === 'h1 physics') as any;
            tweak(c.data);
            c.setToSetupPose();
          },
        }),
      ).not.toBeNull();
    });

  // the setup values live in the compiled data (every frame starts from them), so that is what gets broken
  mutated('inertia', (d) => (d.inertia *= 0.8));
  mutated('strength', (d) => (d.strength *= 1.2));
  mutated('damping', (d) => (d.damping = 0.8));
  mutated('mass', (d) => (d.massInverse *= 1.3));
  mutated('wind', (d) => (d.wind = 0));
  mutated('gravity', (d) => (d.gravity = -15));
  mutated('mix', (d) => (d.mix = 0.7));
  mutated('step', (d) => (d.step = 1 / 30));
  mutated('limit', (d) => (d.limit = 2));
});
