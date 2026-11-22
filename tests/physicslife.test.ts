/**
 * The lifecycle of a physics simulation: switching skins, reset keys and applying the same frame twice.
 *
 * - A physics constraint the skin excludes stops simulating (its bone follows the plain animation) and, when the skin comes
 *   back, restarts from rest — it does not resume with the velocity it had when it was hidden. The official runtime is shown
 *   the same lifecycle the editor's scene gives it (a hidden constraint starts over), so the runs are compared frame by frame.
 * - A reset key (of one constraint, or the global one of every constraint) brings all of its constraints to rest on the very
 *   frame that crosses it, and the swing after it is the official one.
 * - Applying the same time again neither advances nor clears the simulation; only an explicit reset clears it.
 *
 * Everything runs on a single-bone chain and on a two-bone chain, also on a scaled and mirrored skeleton, and again after an
 * export -> import round trip.
 */
import { describe, expect, it } from 'vitest';
import { applyAnimation, applyPhysicsResets } from '../src/core/animate';
import { exportSpineJson } from '../src/core/export/spineJson';
import { importSpineJson } from '../src/core/import/spineJson';
import { GLOBAL_PHYSICS, emptyProject, newAnimation, newBone, newPhysicsConstraint, newSkin } from '../src/core/model';
import type { Animation, Id, Project } from '../src/core/model';
import { compileSkeleton, createSkeleton } from '../src/core/skeleton';
import type { Skeleton } from '../src/core/skeleton';
import { S, exportAndLoad } from './official';

const key = (time: number, value: number[]) => ({ time, value });

/**
 * `driver` hangs the chain h1 - h2 that the animation "move" pushes around for two seconds. `h1 physics` belongs to the skin
 * "wavy" (the bone stays visible, only the constraint is skinned), `h2 physics` is always active. With `single` only h1 has a
 * constraint: a one-bone chain.
 */
function rig(opts: { single?: boolean; resets?: boolean } = {}): Project {
  const project = emptyProject('physics lifecycle');
  const doc = project.skeleton;
  const root = doc.bones[0].id;
  const driver = newBone({ name: 'driver', parent: root, x: 0, y: 100, length: 20 });
  const h1 = newBone({ name: 'h1', parent: driver.id, x: 60, length: 50 });
  const h2 = newBone({ name: 'h2', parent: h1.id, x: 50, length: 40 });
  doc.bones.push(driver, h1, h2);
  const a = newAnimation('move', 2);
  a.bones[driver.id] = {
    translate: [key(0, [0, 0]), key(0.5, [200, 100]), key(1, [-100, 50]), key(1.5, [150, -60]), key(2, [0, 0])],
    rotate: [key(0, [0]), key(0.5, [60]), key(1, [-40]), key(1.5, [30]), key(2, [0])],
  };
  doc.animations.push(a);
  const c1 = newPhysicsConstraint({ name: 'h1 physics', bone: h1.id, x: 1, y: 1, rotate: 1, gravity: 15, skinRequired: true });
  doc.constraints.push(c1);
  if (!opts.single) doc.constraints.push(newPhysicsConstraint({ name: 'h2 physics', bone: h2.id, rotate: 1, scaleX: 0.5 }));
  const skin = newSkin('wavy');
  skin.constraints.push(c1.id);
  doc.skins.push(skin);
  if (opts.resets) {
    a.physics[c1.id] = { reset: [key(0.73, [1])] };
    a.physics[GLOBAL_PHYSICS] = { reset: [key(1.37, [1])] };
  }
  return project;
}

/** Exports the project and re-imports it: the lifecycle behavior has to survive the round trip. */
function reimported(project: Project): Project {
  const json = exportSpineJson(project.skeleton);
  const imported = importSpineJson(JSON.parse(JSON.stringify(json)), 'x');
  expect(imported.warnings).toEqual([]);
  return imported.project;
}

const MATRIX = ['a', 'b', 'c', 'd', 'worldX', 'worldY'] as const;

function oursPose(sk: Skeleton) {
  return sk.bones.map((b) => ({ name: b.data.name, m: MATRIX.map((k) => b[k]) }));
}
function officialPose(sk: any) {
  return sk.bones.map((b: any) => ({ name: b.data.name, m: MATRIX.map((k) => b.appliedPose[k]) }));
}

/** The first bone/element where the two poses differ, for messages. */
function difference(a: ReturnType<typeof oursPose>, b: ReturnType<typeof oursPose>): string | null {
  for (let i = 0; i < a.length; i++)
    for (let k = 0; k < MATRIX.length; k++)
      if (!(Math.abs(a[i].m[k] - b[i].m[k]) <= 1e-4 * Math.max(1, Math.abs(a[i].m[k]), Math.abs(b[i].m[k]))))
        return `${a[i].name}.${MATRIX[k]}: ours ${a[i].m[k]} vs official ${b[i].m[k]}`;
  return null;
}

/** How far apart two poses are (the biggest single difference). */
function distance(a: ReturnType<typeof oursPose>, b: ReturnType<typeof oursPose>): number {
  let d = 0;
  for (let i = 0; i < a.length; i++) for (let k = 0; k < MATRIX.length; k++) d = Math.max(d, Math.abs(a[i].m[k] - b[i].m[k]));
  return d;
}

interface Run {
  project: Project;
  sd: any;
  ours: Skeleton;
  official: any;
  state: any;
  /** Animation time of the last applied frame (-1 before the first, like Spine's track entries). */
  time: number;
}

function startRun(project: Project, skin: string | null, scale?: [number, number]): Run {
  const { skeletonData: sd } = exportAndLoad(project);
  const doc = project.skeleton;
  const skinId = skin ? doc.skins.find((s) => s.name === skin)!.id : null;
  const ours = createSkeleton(compileSkeleton(doc), skinId);
  const official = new S.Skeleton(sd);
  if (skin) official.setSkin(sd.findSkin(skin));
  official.setupPose();
  if (scale) {
    ours.scaleX = scale[0];
    ours.scaleY = scale[1];
    official.scaleX = scale[0];
    official.scaleY = scale[1];
  }
  const state = new S.AnimationState(new S.AnimationStateData(sd));
  state.setAnimation(0, 'move', false);
  return { project, sd, ours, official, state, time: -1 };
}

/** One played frame, the way a game does it: apply, advance the clock, update the world with Physics.update. */
function frame(run: Run, dt: number) {
  const anim: Animation = run.project.skeleton.animations[0];
  run.state.update(dt);
  run.state.apply(run.official);
  run.official.update(dt);
  run.official.updateWorldTransform(S.Physics.update);
  const last = run.time;
  run.time = (run.time < 0 ? 0 : run.time) + dt;
  applyAnimation(run.ours, anim, run.time);
  applyPhysicsResets(run.ours, anim, last, run.time);
  run.ours.update(dt);
  run.ours.updateWorldTransform('update');
}

/** Plays `n` frames and expects the two runtimes to agree on every one of them. */
function play(run: Run, n: number, what: string, dt = 1 / 60) {
  for (let i = 0; i < n; i++) {
    frame(run, dt);
    const diff = difference(oursPose(run.ours), officialPose(run.official));
    expect(diff, `${what}, frame ${i}`).toBeNull();
  }
}

/**
 * Switches the skin of both runtimes. Ours deactivates the constraints the skin excludes and restarts them from rest when
 * they return; the official runtime keeps their state, so the test tells it to do what the editor's scene does: a constraint
 * that is (or was) hidden starts over.
 */
function switchSkin(run: Run, skin: string | null) {
  const wasActive = new Map<unknown, boolean>();
  for (const c of run.official.physics as any[]) wasActive.set(c, c.active);
  const data = run.ours.data;
  run.ours.setSkin(skin ? (data.skins.find((s) => s.name === skin) ?? null) : null);
  run.official.setSkin(skin ? run.sd.findSkin(skin) : null);
  for (const c of run.official.physics as any[]) {
    if (!c.active || !wasActive.get(c)) c.reset(run.official);
  }
}

const SCALES: [number, number][] = [
  [1, 1],
  [-1.5, 2],
  [0.5, -1],
];

describe('skin switch', () => {
  for (const single of [false, true]) {
    for (const scale of SCALES) {
      it(`a hidden constraint stops, and restarts from rest when its skin returns (${single ? 'single bone' : 'two-bone chain'}, scale ${scale})`, () => {
        const run = startRun(rig({ single }), 'wavy', scale);
        play(run, 36, 'skin on'); // 0.6 s: both constraints swing
        switchSkin(run, null);
        play(run, 30, 'skin off'); // the skinned constraint is out: h1 follows the plain animation, h2 swings on
        switchSkin(run, 'wavy');
        play(run, 30, 'skin back'); // from rest, exactly what the official runtime does when the constraint is reset
      });
    }
  }

  it('the restart is observable: switching away and back is not the same as never switching', () => {
    const toggled = startRun(rig(), 'wavy');
    play(toggled, 36, 'on');
    switchSkin(toggled, null);
    play(toggled, 30, 'off');
    switchSkin(toggled, 'wavy');
    const steady = startRun(rig(), 'wavy');
    // the same frames without the detour: 36 + 30 frames, then compare the next ones
    play(steady, 66, 'steady');
    let most = 0;
    for (let i = 0; i < 12; i++) {
      frame(toggled, 1 / 60);
      frame(steady, 1 / 60);
      most = Math.max(most, distance(oursPose(toggled.ours), oursPose(steady.ours)));
    }
    expect(most).toBeGreaterThan(0.5);
  });

  it('a hidden constraint does not move its visible bone', () => {
    const project = rig();
    const run = startRun(project, 'wavy');
    play(run, 36, 'skin on');
    switchSkin(run, null);
    // while the skin is off, h1 is exactly where the animation puts it (compare with a skeleton that has no constraints)
    const doc = project.skeleton;
    const plain = createSkeleton(compileSkeleton({ ...doc, constraints: [] }));
    let t = 0.6;
    for (let i = 0; i < 20; i++) {
      frame(run, 1 / 60);
      t += 1 / 60;
      applyAnimation(plain, doc.animations[0], t);
      plain.updateWorldTransform('none');
      const id: Id = doc.bones.find((b) => b.name === 'h1')!.id;
      const a = run.ours.boneById(id)!;
      const b = plain.boneById(id)!;
      expect(a.worldX, `frame ${i} worldX`).toBeCloseTo(b.worldX, 6);
      expect(a.worldY, `frame ${i} worldY`).toBeCloseTo(b.worldY, 6);
    }
  });
});

describe('reset keys', () => {
  for (const single of [false, true]) {
    for (const scale of SCALES) {
      it(`single and global reset keys bring every constraint to rest on their frame (${single ? 'single bone' : 'two-bone chain'}, scale ${scale})`, () => {
        const run = startRun(rig({ single, resets: true }), 'wavy', scale);
        play(run, 110, 'reset keys'); // crosses the reset at 0.73 (one constraint) and the global one at 1.37
      });
    }
  }

  it('the reset keys change the swing (otherwise the comparison above says nothing)', () => {
    const withResets = startRun(rig({ resets: true }), 'wavy');
    const without = startRun(rig(), 'wavy');
    let most = 0;
    for (let i = 0; i < 110; i++) {
      frame(withResets, 1 / 60);
      frame(without, 1 / 60);
      most = Math.max(most, distance(oursPose(withResets.ours), oursPose(without.ours)));
    }
    expect(most).toBeGreaterThan(0.5);
  });
});

describe('the same frame applied again', () => {
  for (const scale of SCALES) {
    it(`neither advances nor clears the simulation; only a reset clears it (scale ${scale})`, () => {
      const run = startRun(rig(), 'wavy', scale);
      play(run, 40, 'warmup');
      const anim = run.project.skeleton.animations[0];
      const t = run.time;
      // the same frame again, three times, without time passing: Physics.pose shows what the simulation has, unchanged
      let first: ReturnType<typeof oursPose> | null = null;
      for (let i = 0; i < 3; i++) {
        run.state.apply(run.official);
        run.official.updateWorldTransform(S.Physics.pose);
        applyAnimation(run.ours, anim, t);
        run.ours.updateWorldTransform('pose');
        const pose = oursPose(run.ours);
        const diff = difference(pose, officialPose(run.official));
        expect(diff, `reapply ${i}`).toBeNull();
        if (first) expect(distance(pose, first), `reapply ${i} is stable`).toBe(0);
        first = pose;
      }
      // the swing continues from where it was: the state was neither advanced nor cleared
      play(run, 20, 'after reapplying');
      // an explicit reset is what clears it
      const tReset = run.time;
      run.state.apply(run.official);
      run.official.updateWorldTransform(S.Physics.reset);
      applyAnimation(run.ours, anim, tReset);
      run.ours.updateWorldTransform('reset');
      expect(difference(oursPose(run.ours), officialPose(run.official)), 'reset clears').toBeNull();
      play(run, 20, 'after the reset');
    });
  }
});

describe('after an export -> import round trip', () => {
  it('playback, skin switches and reset keys behave the same', () => {
    const project = reimported(rig({ resets: true }));
    const run = startRun(project, 'wavy');
    play(run, 36, 'skin on');
    switchSkin(run, null);
    play(run, 30, 'skin off');
    switchSkin(run, 'wavy');
    play(run, 80, 'skin back, across both reset keys');
  });

  it('the imported document still exports to the same file', () => {
    const project = rig({ resets: true });
    const first = exportSpineJson(project.skeleton);
    const second = exportSpineJson(reimported(project).skeleton);
    expect(second).toEqual(first);
  });
});
