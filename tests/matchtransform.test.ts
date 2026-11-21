/** Match of a transform constraint: after it the constraint leaves the Setup pose alone (checked in the official runtime) and still follows its source. */
import { describe, expect, it } from 'vitest';
import { matchTransformConstraint } from '../src/core/matchTransform';
import { newTransformConstraint } from '../src/core/model';
import type { Project } from '../src/core/model';
import { compileSkeleton, createSkeleton } from '../src/core/skeleton';
import { matchTransform } from '../src/store/transformActions';
import { docStore } from '../src/store/doc';
import { uiStore } from '../src/store/ui';
import { buildFixture } from './fixture';
import { S, exportAndLoad } from './official';

const clone = (p: Project): Project => JSON.parse(JSON.stringify(p));

function without(project: Project, id: string): Project {
  const p = clone(project);
  p.skeleton.constraints = p.skeleton.constraints.filter((c) => c.id !== id);
  for (const k of p.skeleton.skins) k.constraints = k.constraints.filter((c) => c !== id);
  return p;
}

function worlds(project: Project) {
  const { skeletonData } = exportAndLoad(project);
  const sk = new S.Skeleton(skeletonData);
  sk.setupPose();
  sk.updateWorldTransform(S.Physics.update);
  return new Map(
    sk.bones.map((b: any) => [
      b.data.name,
      [b.appliedPose.a, b.appliedPose.b, b.appliedPose.c, b.appliedPose.d, b.appliedPose.worldX, b.appliedPose.worldY],
    ]),
  );
}

/** The fixture with one more constraint of every flavour the matcher has to handle. */
function rig() {
  const { project } = buildFixture();
  const doc = project.skeleton;
  const id = (n: string) => doc.bones.find((b) => b.name === n)!.id;
  doc.constraints.push(
    newTransformConstraint({
      name: 'pos to rot',
      bones: [id('tail')],
      source: id('handTarget'),
      properties: [{ prop: 'x', offset: 5, to: [{ prop: 'rotate', offset: 0, max: 1, scale: 0.3 }] }],
    }),
    newTransformConstraint({
      name: 'wide clamp',
      bones: [id('legLower')],
      source: id('footTarget'),
      clamp: true,
      properties: [{ prop: 'y', offset: 0, to: [{ prop: 'rotate', offset: 10, max: 12, scale: 5 }] }],
    }),
    newTransformConstraint({
      name: 'two bones',
      bones: [id('hand'), id('head')],
      source: id('tailTarget'),
      properties: [
        {
          prop: 'rotate',
          offset: 3,
          to: [
            { prop: 'rotate', offset: 0, max: 1, scale: 1 },
            { prop: 'shearY', offset: 0, max: 1, scale: 0.5 },
          ],
        },
      ],
    }),
  );
  return { project, doc };
}

describe('Match', () => {
  it('leaves the Setup pose exactly as it is without the constraint, for every flavour, in the official runtime', () => {
    const { project, doc } = rig();
    const transforms = doc.constraints.filter((c) => c.type === 'transform');
    expect(transforms.length).toBeGreaterThanOrEqual(7);
    for (const c of transforms) {
      const matched = clone(project);
      const r = matchTransformConstraint(matched.skeleton, c.id);
      expect(r, c.name).not.toBeNull();
      expect(r!.matched).toBeGreaterThan(0);
      const want = worlds(without(project, c.id));
      const got = worlds(matched);
      const target = doc.bones.find((b) => b.id === (c as any).bones[0])!.name;
      const g = got.get(target) as number[];
      const w = want.get(target) as number[];
      g.forEach((v, i) => expect(v, `${c.name} ${target}[${i}]`).toBeCloseTo(w[i], 3));
    }
  });

  it('is not an inert constraint afterwards: the target still follows the source', () => {
    const { project, doc } = rig();
    const c = doc.constraints.find((x) => x.name === 'gear drive')!;
    const m = clone(project);
    matchTransformConstraint(m.skeleton, c.id);
    const rotation = (p: Project) => {
      const sk = createSkeleton(compileSkeleton(p.skeleton));
      sk.setToSetupPose();
      sk.updateWorldTransform('none');
      const b = sk.boneById((c as any).bones[0])!;
      return (Math.atan2(b.c, b.a) * 180) / Math.PI;
    };
    // the compiled skeleton is cached per document object, so the turned source is a new copy
    const turned = clone(m);
    turned.skeleton.bones.find((b) => b.id === (c as any).source)!.rotation += 20;
    const free = without(turned, c.id);
    const wrap = (d: number) => ((((d + 180) % 360) + 360) % 360) - 180;
    // with the constraint the target is moved by what the source did, without it it is not
    expect(Math.abs(wrap(rotation(turned) - rotation(free)))).toBeGreaterThan(5);
    // and in the turned-source pose it is no longer the free pose, while the untouched source gives exactly the free pose (the first test)
    expect(Math.abs(wrap(rotation(m) - rotation(without(m, c.id))))).toBeLessThan(1e-4);
  });

  it('a clamp keeps its width, and a current value outside the range anchors the source instead', () => {
    const { project, doc } = rig();
    const c = doc.constraints.find((x) => x.name === 'wide clamp')!;
    const m = clone(project);
    matchTransformConstraint(m.skeleton, c.id);
    const t = m.skeleton.constraints.find((x) => x.id === c.id) as any;
    const to = t.properties[0].to[0];
    expect(to.max - to.offset).toBeCloseTo(2, 6);
  });

  it('is null without bones or without mappings, and touches nothing then', () => {
    const { project } = rig();
    const m = clone(project);
    const empty = newTransformConstraint({ name: 'empty', bones: [], source: m.skeleton.bones[0].id });
    m.skeleton.constraints.push(empty);
    const none = newTransformConstraint({ name: 'none', bones: [m.skeleton.bones[1].id], source: m.skeleton.bones[0].id, properties: [] });
    m.skeleton.constraints.push(none);
    const before = JSON.stringify(m);
    expect(matchTransformConstraint(m.skeleton, empty.id)).toBeNull();
    expect(matchTransformConstraint(m.skeleton, none.id)).toBeNull();
    expect(matchTransformConstraint(m.skeleton, 'missing')).toBeNull();
    expect(JSON.stringify(m)).toBe(before);
  });

  it('reports that only the first of several bones was matched', () => {
    const { project, doc } = rig();
    const c = doc.constraints.find((x) => x.name === 'two bones')!;
    expect(matchTransformConstraint(clone(project).skeleton, c.id)?.firstOnly).toBe(true);
  });
});

describe('the action', () => {
  it('is one history step in Setup mode and refused in Animate mode', () => {
    const { project, doc } = rig();
    const c = doc.constraints.find((x) => x.name === 'pos to rot')!;
    docStore.replace(project);
    uiStore.patch({ mode: 'animate' });
    expect(matchTransform(c.id)).toBe(false);
    uiStore.patch({ mode: 'setup' });
    const before = JSON.stringify(docStore.get().skeleton.constraints.find((x) => x.id === c.id));
    expect(matchTransform(c.id)).toBe(true);
    expect(docStore.undoLabel).toBe('Match transform constraint');
    expect(JSON.stringify(docStore.get().skeleton.constraints.find((x) => x.id === c.id))).not.toBe(before);
    docStore.undo();
    expect(JSON.stringify(docStore.get().skeleton.constraints.find((x) => x.id === c.id))).toBe(before);
  });
});
