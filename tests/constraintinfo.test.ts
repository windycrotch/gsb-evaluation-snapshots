/** The constraint debug view's data: who drives which bones, how strongly, and which links the selection brings into focus. */
import { describe, expect, it } from 'vitest';
import { boneStages, constraintLinks, focusLinks, isQuiet, linkLabel, linksTouching, stageDelta, turn } from '../src/core/constraintInfo';
import { compileSkeleton, createSkeleton } from '../src/core/skeleton';
import { buildFixture } from './fixture';
import { addPathRig } from './pathrig';
import { addPhysicsRig } from './physicsrig';

function posed() {
  const { project } = buildFixture();
  addPathRig(project);
  addPhysicsRig(project);
  const data = compileSkeleton(project.skeleton);
  const sk = createSkeleton(data, null);
  sk.updateWorldTransform('pose');
  return { project, sk };
}

describe('constraintLinks', () => {
  it('has a link for every active constraint, with the kind and the bones it moves', () => {
    const { sk } = posed();
    const links = constraintLinks(sk);
    expect(links.length).toBe(sk.constraints.filter((c) => c.active).length);
    for (const l of links) {
      expect(l.strength).toBeGreaterThanOrEqual(0);
      expect(l.strength).toBeLessThanOrEqual(1);
      if (l.kind !== 'slider') expect(l.driven.length).toBeGreaterThan(0);
    }
    const kinds = new Set(links.map((l) => l.kind));
    for (const k of ['ik', 'transform', 'path', 'physics'] as const) expect(kinds.has(k)).toBe(true);
  });

  it('an IK link is driven by its target and moves its chain; a path or physics link has no driver bone', () => {
    const { sk } = posed();
    for (const l of constraintLinks(sk)) {
      const c = sk.constraintById(l.id)!;
      if (c.kind === 'ik') {
        expect(l.driver).toBe(c.target);
        expect(l.driven).toEqual(c.bones);
        expect(l.strength).toBeCloseTo(Math.max(0, Math.min(1, c.mix)), 12);
      }
      if (c.kind === 'path' || c.kind === 'physics') expect(l.driver).toBeNull();
      if (c.kind === 'transform') expect(l.driver).toBe(c.source);
    }
  });

  it('skips a constraint that is not active', () => {
    const { sk } = posed();
    const first = sk.constraints[0];
    first.active = false;
    expect(constraintLinks(sk).some((l) => l.id === first.data.id)).toBe(false);
  });
});

describe('focusLinks', () => {
  it('the selected constraint alone; else the links that touch the selected bones; else every link', () => {
    const { sk } = posed();
    const links = constraintLinks(sk);
    const ik = links.find((l) => l.kind === 'ik')!;
    expect([...focusLinks(links, ik.id, [])]).toEqual([ik.id]);
    const touching = focusLinks(links, null, [ik.driven[0].data.id]);
    expect(touching.has(ik.id)).toBe(true);
    expect(touching.size).toBe(linksTouching(links, new Set([ik.driven[0].data.id])).length);
    expect(focusLinks(links, null, []).size).toBe(links.length);
    // a bone that no constraint touches, and a constraint that is not there, fall back to all
    expect(focusLinks(links, 'nope', ['no-such-bone']).size).toBe(links.length);
  });

  it('a bone that is the driver counts as touched too', () => {
    const { sk } = posed();
    const links = constraintLinks(sk);
    const ik = links.find((l) => l.kind === 'ik')!;
    expect(linksTouching(links, new Set([ik.driver!.data.id])).map((l) => l.id)).toContain(ik.id);
  });
});

describe('linkLabel', () => {
  it('shows the strength only when it is not full', () => {
    const base = { id: 'x', name: 'arm ik', kind: 'ik' as const, driver: null, driven: [] };
    expect(linkLabel({ ...base, strength: 1 })).toBe('arm ik');
    expect(linkLabel({ ...base, strength: 0.456 })).toBe('arm ik 46%');
    expect(linkLabel({ ...base, strength: 0 })).toBe('arm ik 0%');
  });
});

describe('boneStages', () => {
  const fresh = () => {
    const { project } = buildFixture();
    addPathRig(project);
    const sk = createSkeleton(compileSkeleton(project.skeleton), null);
    return { project, sk };
  };
  const worldOf = (sk: ReturnType<typeof fresh>['sk']) => sk.bones.map((b) => [b.a, b.b, b.c, b.d, b.worldX, b.worldY]);

  it('lists the constraints that move a bone, in the order they run', () => {
    const { sk } = fresh();
    sk.updateWorldTransform('none');
    let seen = 0;
    for (const link of constraintLinks(sk)) {
      if (link.kind === 'physics') continue;
      for (const bone of link.driven) {
        const st = boneStages(sk, bone.data.id)!;
        expect(st.stages.some((s) => s.id === link.id)).toBe(true);
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(0);
  });

  it('looking between the steps ends in the same pose as a plain update', () => {
    // one look at a fresh skeleton per bone: a second update of the same skeleton is a different thing (a path-constrained bone keeps its last world pose)
    const { project } = buildFixture();
    const make = () => createSkeleton(compileSkeleton(project.skeleton), null);
    const plain = make();
    plain.updateWorldTransform('none');
    let looked = 0;
    for (const link of constraintLinks(plain)) {
      for (const bone of link.driven) {
        const b = make();
        b.updateWorldTransform('none', () => {});
        boneStages(make(), bone.data.id);
        expect(worldOf(b)).toEqual(worldOf(plain));
        looked++;
      }
    }
    expect(looked).toBeGreaterThan(0);
  });

  it('a bone no constraint moves has no stages, and an unknown bone has none at all', () => {
    const { sk } = fresh();
    sk.updateWorldTransform('none');
    const moved = new Set(constraintLinks(sk).flatMap((l) => l.driven.map((b) => b.data.id)));
    const free = sk.bones.find((b) => !moved.has(b.data.id))!;
    expect(boneStages(sk, free.data.id)!.stages).toEqual([]);
    expect(boneStages(sk, 'nope')).toBeNull();
  });

  it('the first stage finds the pose of the animation, and every stage is told apart by its constraint', () => {
    const { sk } = fresh();
    sk.updateWorldTransform('none');
    for (const link of constraintLinks(sk)) {
      if (link.kind === 'physics') continue;
      for (const bone of link.driven) {
        const st = boneStages(sk, bone.data.id)!;
        expect(new Set(st.stages.map((s) => s.id)).size).toBe(st.stages.length);
        expect(st.start.rotation).toBe(bone.rotation);
      }
    }
  });

  it('an IK constraint at 0% changes nothing, at 100% it turns the bone', () => {
    const { project } = buildFixture();
    const run = (mix: number) => {
      // a copy each time: the compiled skeleton is kept per document object
      const doc = structuredClone(project.skeleton);
      const ik = doc.constraints.find((c) => c.type === 'ik')!;
      ik.mix = mix;
      const target = doc.bones.find((b) => b.id === ik.target)!;
      target.x += 60; // the target is away from where the chain reaches
      target.y += 40;
      const sk = createSkeleton(compileSkeleton(doc), null);
      sk.updateWorldTransform('none');
      const link = constraintLinks(sk).find((l) => l.id === ik.id)!;
      const st = boneStages(sk, link.driven[0].data.id)!;
      return stageDelta(st.stages.find((s) => s.id === ik.id)!);
    };
    expect(isQuiet(run(0))).toBe(true);
    expect(isQuiet(run(1))).toBe(false);
  });

  it('physics is not listed', () => {
    const { project } = buildFixture();
    addPhysicsRig(project);
    const sk = createSkeleton(compileSkeleton(project.skeleton), null);
    sk.updateWorldTransform('none');
    for (const link of constraintLinks(sk).filter((l) => l.kind === 'physics'))
      for (const bone of link.driven) expect(boneStages(sk, bone.data.id)!.stages.some((s) => s.kind === 'physics')).toBe(false);
  });
});

describe('numbers of a stage', () => {
  it('turns the short way round', () => {
    expect(turn(170, -170)).toBeCloseTo(20, 9);
    expect(turn(-170, 170)).toBeCloseTo(-20, 9);
    expect(turn(10, 40)).toBeCloseTo(30, 9);
    expect(turn(0, 180)).toBeCloseTo(180, 9);
  });

  it('the delta of equal poses is quiet', () => {
    const p = { x: 1, y: 2, rotation: 30, scaleX: 1, scaleY: 1, shearY: 0 };
    expect(isQuiet(stageDelta({ before: p, after: { ...p } }))).toBe(true);
    expect(isQuiet(stageDelta({ before: p, after: { ...p, rotation: 31 } }))).toBe(false);
  });
});
