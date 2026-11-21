/**
 * Spine 4.0 / 4.1 / 4.2 files: the conversion to the 4.3 structure (`src/core/import/legacy.ts`) and what comes out of the import.
 * The poses of the 4.2 rig are compared with numbers recorded from the OFFICIAL 4.2 runtime (`fixtures/record-legacy42.mjs`).
 */
import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applyAnimation } from '../src/core/animate';
import { importSpineJson } from '../src/core/import/spineJson';
import { isLegacySpineJson, parseSpineVersion, upgradeLegacySpineJson } from '../src/core/import/legacy';
import { compileSkeleton, createSkeleton } from '../src/core/skeleton';
import { parityMismatch } from './fuzzkit';

const fixtureUrl = new URL('./fixtures/legacy42.json', import.meta.url);
const goldenUrl = new URL('./fixtures/legacy42.golden.json', import.meta.url);
const load = (): any => JSON.parse(readFileSync(fixtureUrl, 'utf8'));
const golden: any | null = existsSync(goldenUrl) ? JSON.parse(readFileSync(goldenUrl, 'utf8')) : null;

/** The same rig as a 4.1 file: the bone mode is called `transform` again (4.2 renamed it `inherit`). */
function as41(doc: any): any {
  const out = structuredClone(doc);
  out.skeleton.spine = '4.1.24';
  for (const b of out.bones) {
    if (b.inherit === undefined) continue;
    b.transform = b.inherit;
    delete b.inherit;
  }
  return out;
}

/** And as a 4.0 file: deform timelines live in `animations.<n>.deform` (4.1 moved them under `attachments`). */
function as40(doc: any): any {
  const out = as41(doc);
  out.skeleton.spine = '4.0.64';
  for (const a of Object.values<any>(out.animations)) {
    const deform = a.attachments;
    if (!deform) continue;
    const moved: any = {};
    for (const [skin, perSkin] of Object.entries<any>(deform))
      for (const [slot, perSlot] of Object.entries<any>(perSkin))
        for (const [att, tl] of Object.entries<any>(perSlot)) ((moved[skin] ??= {})[slot] ??= {})[att] = tl.deform;
    delete a.attachments;
    a.deform = moved;
  }
  return out;
}

describe('version detection', () => {
  it('reads the version of a header', () => {
    expect(parseSpineVersion('4.2.43')).toEqual([4, 2]);
    expect(parseSpineVersion('4.3.13')).toEqual([4, 3]);
    expect(parseSpineVersion('3.8.99')).toEqual([3, 8]);
    expect(parseSpineVersion('nightly')).toBeUndefined();
    expect(parseSpineVersion(undefined)).toBeUndefined();
  });

  it('knows old structures from new ones', () => {
    expect(isLegacySpineJson(load())).toBe(true);
    expect(isLegacySpineJson(as41(load()))).toBe(true);
    expect(isLegacySpineJson({ skeleton: { spine: '4.3.1' }, bones: [{ name: 'root' }], constraints: [] })).toBe(false);
    // no header: the separate constraint arrays give it away
    expect(isLegacySpineJson({ bones: [{ name: 'root' }], ik: [] })).toBe(true);
    expect(isLegacySpineJson({ bones: [{ name: 'root' }] })).toBe(false);
  });
});

describe('constraints', () => {
  it('become one list in the order of their `order`, whatever their kind', () => {
    const { root } = upgradeLegacySpineJson(load());
    expect(root.constraints.map((c: any) => `${c.type}:${c.name}`)).toEqual([
      'ik:arm ik',
      'ik:leg ik',
      'ik:hand ik',
      'transform:tcA',
      'transform:tcB',
      'transform:tcC',
      'transform:tcD',
      'path:path tangent',
      'path:path chain',
      'path:path scale',
    ]);
    expect(root.ik).toBeUndefined();
    expect(root.transform).toBeUndefined();
    expect(root.path).toBeUndefined();
  });

  it('interleave kinds: `order` numbers them across all of them', () => {
    const doc = {
      bones: [{ name: 'root' }, { name: 'a', parent: 'root' }, { name: 't', parent: 'root' }],
      slots: [{ name: 's', bone: 'root' }],
      ik: [{ name: 'i', order: 1, bones: ['a'], target: 't' }],
      path: [{ name: 'p', order: 2, bones: ['a'], target: 's' }],
      transform: [{ name: 'x', order: 0, bones: ['a'], target: 't' }],
    };
    expect(upgradeLegacySpineJson(doc).root.constraints.map((c: any) => c.name)).toEqual(['x', 'i', 'p']);
  });

  it('keep the order of the file when `order` is missing', () => {
    const doc = {
      bones: [{ name: 'root' }],
      ik: [
        { name: 'i1', bones: ['root'], target: 'root' },
        { name: 'i2', bones: ['root'], target: 'root' },
      ],
      transform: [{ name: 't1', bones: ['root'], target: 'root' }],
    };
    expect(upgradeLegacySpineJson(doc).root.constraints.map((c: any) => c.name)).toEqual(['i1', 'i2', 't1']);
  });

  it('ik: `uniform` becomes the scaleY mode, the rest is kept', () => {
    const { root } = upgradeLegacySpineJson(load());
    const leg = root.constraints.find((c: any) => c.name === 'leg ik');
    expect(leg).toMatchObject({
      type: 'ik',
      bones: ['legU', 'legL'],
      target: 'footTarget',
      compress: true,
      stretch: true,
      scaleY: 'uniform',
    });
    const arm = root.constraints.find((c: any) => c.name === 'arm ik');
    expect(arm).toMatchObject({ mix: 0.8, softness: 10, bendPositive: false });
    expect(arm.scaleY).toBeUndefined();
    expect(root.constraints.find((c: any) => c.name === 'hand ik').skin).toBe(true);
  });

  it('transform: a table over all six properties, `local` / `relative` become the 4.3 flags', () => {
    const { root } = upgradeLegacySpineJson(load());
    const byName = (n: string) => root.constraints.find((c: any) => c.name === n);
    const a = byName('tcA');
    expect(a.source).toBe('tcSrc');
    expect(Object.keys(a.properties)).toEqual(['rotate', 'x', 'y', 'scaleX', 'scaleY', 'shearY']);
    expect(a.properties.scaleX).toEqual({ to: { scaleX: {} } });
    expect(a).toMatchObject({ rotation: 10, x: 5, y: -5, scaleX: 0.1, scaleY: 0.2, shearY: 5, mixRotate: 0.7, mixShearY: 0.3 });
    expect(a.localSource).toBeUndefined();
    expect(a.additive).toBeUndefined();
    expect(byName('tcB').additive).toBe(true);
    expect(byName('tcC')).toMatchObject({ localSource: true, localTarget: true });
    expect(byName('tcC').additive).toBeUndefined();
    expect(byName('tcD')).toMatchObject({ localSource: true, localTarget: true, additive: true });
  });

  it('path: the slot moves from `target` to `slot`', () => {
    const { root } = upgradeLegacySpineJson(load());
    const p = root.constraints.find((c: any) => c.name === 'path chain');
    expect(p).toMatchObject({
      type: 'path',
      slot: 'pathSlot',
      positionMode: 'fixed',
      spacingMode: 'fixed',
      rotateMode: 'chain',
      position: 20,
      spacing: 40,
      rotation: 20,
    });
    expect(p.target).toBeUndefined();
  });

  it('physics constraints keep their keys, and the 4.2 defaults (inertia 1, damping 1) are written down', () => {
    const doc = { bones: [{ name: 'root' }], physics: [{ name: 'hair', bone: 'root', order: 0, mass: 2, damping: 0.9 }] };
    const up = upgradeLegacySpineJson(doc);
    expect(up.root.constraints).toEqual([{ type: 'physics', name: 'hair', bone: 'root', order: 0, mass: 2, inertia: 1, damping: 0.9 }]);
    expect(up.warnings.some((w) => w.includes('physics'))).toBe(true);
  });

  it('report a local, absolute scale on a bone whose scale is not 1 (4.2 computes it differently)', () => {
    const doc = {
      bones: [{ name: 'root' }, { name: 'a', parent: 'root', scaleX: 1.5 }, { name: 'b', parent: 'root' }, { name: 't', parent: 'root' }],
      transform: [
        { name: 'odd', bones: ['a'], target: 't', local: true },
        { name: 'unit scale', order: 1, bones: ['b'], target: 't', local: true },
        { name: 'no scale mix', order: 2, bones: ['a'], target: 't', local: true, mixScaleX: 0, mixScaleY: 0 },
        { name: 'relative', order: 3, bones: ['a'], target: 't', local: true, relative: true },
        { name: 'world', order: 4, bones: ['a'], target: 't' },
      ],
    };
    const { warnings } = upgradeLegacySpineJson(doc);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('"odd"');
  });

  it('the rig of the fixture needs no warning', () => {
    expect(upgradeLegacySpineJson(load()).warnings).toEqual([]);
  });
});

describe('animations', () => {
  it('4.0 deform timelines are moved under `attachments` (4.1 and later already have them there)', () => {
    const doc = as40(load());
    const before = doc.animations.idle.deform;
    expect(before.default.tailMesh.tailMesh).toHaveLength(3);
    const { root } = upgradeLegacySpineJson(doc);
    expect(root.animations.idle.deform).toBeUndefined();
    expect(root.animations.idle.attachments.default.tailMesh.tailMesh.deform).toHaveLength(3);
    expect(root.animations.idle.attachments.default.armMesh.armMesh.deform).toHaveLength(2);
    // the input is not touched
    expect(doc.animations.idle.deform).toBe(before);
  });

  it('keep deform that is already in place and everything else of an animation', () => {
    const doc = load();
    const { root } = upgradeLegacySpineJson(doc);
    expect(root.animations.idle.attachments).toEqual(doc.animations.idle.attachments);
    expect(root.animations.idle.ik).toEqual(doc.animations.idle.ik);
    expect(root.animations.still).toEqual(doc.animations.still);
  });
});

describe('import', () => {
  it('a 4.2 file opens with its constraints, timelines and skins', () => {
    const { project, warnings } = importSpineJson(load(), 'legacy');
    const doc = project.skeleton;
    expect(doc.constraints.map((c) => `${c.type}:${c.name}`)).toEqual([
      'ik:arm ik',
      'ik:leg ik',
      'ik:hand ik',
      'transform:tcA',
      'transform:tcB',
      'transform:tcC',
      'transform:tcD',
      'path:path tangent',
      'path:path chain',
      'path:path scale',
    ]);
    const tcC = doc.constraints.find((c) => c.name === 'tcC');
    expect(tcC).toMatchObject({ type: 'transform', localSource: true, localTarget: true, additive: false });
    if (tcC?.type === 'transform') expect(tcC.properties.map((p) => p.prop)).toEqual(['rotate', 'x', 'y', 'scaleX', 'scaleY', 'shearY']);
    const idle = doc.animations.find((a) => a.name === 'idle')!;
    expect(Object.keys(idle.ik)).toHaveLength(2);
    expect(Object.keys(idle.transform)).toHaveLength(3);
    expect(Object.keys(idle.path)).toHaveLength(3);
    expect(Object.keys(idle.deform[doc.skins[0].id] ?? {})).toHaveLength(2);
    const alt = doc.skins.find((s) => s.name === 'alt')!;
    expect(alt.bones).toHaveLength(1);
    expect(alt.constraints).toHaveLength(1);
    // the artist is told where the file came from, and nothing about the constraints
    expect(warnings.some((w) => w.includes('4.2.43') && w.includes('converted'))).toBe(true);
    expect(warnings.filter((w) => /constraint|IK|path/.test(w))).toEqual([]);
  });

  it('a 4.0 / 4.1 file gives the same document', () => {
    const base = importSpineJson(load(), 'x').project.skeleton;
    for (const [doc, label] of [
      [as41(load()), '4.1'],
      [as40(load()), '4.0'],
    ] as const) {
      const got = importSpineJson(doc, 'x');
      expect(
        got.warnings.some((w) => w.includes(label)),
        label,
      ).toBe(true);
      const d = got.project.skeleton;
      expect(
        d.constraints.map((c) => c.name),
        label,
      ).toEqual(base.constraints.map((c) => c.name));
      expect(
        d.bones.map((b) => `${b.name}:${b.inherit}`),
        label,
      ).toEqual(base.bones.map((b) => `${b.name}:${b.inherit}`));
      const idle = d.animations.find((a) => a.name === 'idle')!;
      expect(Object.keys(idle.deform[d.skins[0].id] ?? {}), label).toHaveLength(2);
    }
  });

  it('4.0, 4.1 and 4.2 files of the same rig pose identically', () => {
    const pose = (doc: any) => {
      const d = importSpineJson(doc, 'x').project.skeleton;
      const sk = createSkeleton(compileSkeleton(d));
      applyAnimation(
        sk,
        d.animations.find((a) => a.name === 'idle')!,
        0.37,
      );
      sk.updateWorldTransform();
      return sk.bones.map((b) => [b.data.name, b.a, b.b, b.c, b.d, b.worldX, b.worldY]);
    };
    const base = pose(load());
    expect(pose(as41(load()))).toEqual(base);
    expect(pose(as40(load()))).toEqual(base);
  });

  it('what is imported exports to a file the official 4.3 runtime poses like we do', () => {
    // transform constraints in all four modes, 1- and 2-bone IK with uniform stretch, open / closed paths, weighted meshes, skins
    const { project } = importSpineJson(load(), 'legacy');
    expect(parityMismatch(project)).toBeNull();
  });

  it('a 4.2 physics constraint and its timelines are imported with the 4.2 defaults', () => {
    const doc = load();
    doc.physics = [{ name: 'hair', order: 10, bone: 'head', mass: 2, rotate: 1 }];
    doc.animations.idle.physics = {
      hair: {
        mix: [
          { time: 0, value: 1 },
          { time: 1, value: 0.5 },
        ],
        reset: [{ time: 0.5 }],
      },
    };
    const { project, warnings } = importSpineJson(doc, 'x');
    const hair = project.skeleton.constraints.find((c) => c.name === 'hair');
    expect(hair).toMatchObject({ type: 'physics', rotate: 1, mass: 2, inertia: 1, damping: 1, fps: 60, strength: 100, mix: 1 });
    const idle = project.skeleton.animations.find((a) => a.name === 'idle')!;
    expect(Object.values(idle.physics)[0].mix).toHaveLength(2);
    expect(Object.values(idle.physics)[0].reset).toHaveLength(1);
    expect(warnings.some((w) => w.includes('4.3 simulation'))).toBe(true);
  });

  it('a 4.3 file is not touched by the conversion', () => {
    const { warnings } = importSpineJson({ skeleton: { spine: '4.3.13' }, bones: [{ name: 'root' }], constraints: [] }, 'x');
    expect(warnings).toEqual([]);
  });
});

describe.skipIf(!golden)('poses of the 4.2 rig against the official 4.2 runtime', () => {
  const close = (x: number, y: number) => Math.abs(x - y) <= 2e-4 * Math.max(1, Math.abs(x), Math.abs(y));
  for (const [label, make] of [
    ['4.2', load],
    ['4.1', () => as41(load())],
    ['4.0', () => as40(load())],
  ] as const) {
    for (const pose of golden?.poses ?? []) {
      it(`${label}: skin ${pose.skin ?? 'default'}, ${pose.animation ?? 'setup pose'} at ${pose.time}`, () => {
        const doc = importSpineJson(make(), 'x').project.skeleton;
        const data = compileSkeleton(doc);
        const sk = createSkeleton(data, pose.skin ? doc.skins.find((s) => s.name === pose.skin)!.id : null);
        applyAnimation(sk, pose.animation ? (doc.animations.find((a) => a.name === pose.animation) ?? null) : null, pose.time);
        sk.updateWorldTransform();
        const problems: string[] = [];
        for (const [name, m] of Object.entries<number[]>(pose.bones)) {
          const b = sk.bones.find((x) => x.data.name === name);
          if (!b) {
            problems.push(`bone ${name} is missing`);
            continue;
          }
          [b.a, b.b, b.c, b.d, b.worldX, b.worldY].forEach((v, i) => {
            if (!close(v, m[i])) problems.push(`${name}.${['a', 'b', 'c', 'd', 'worldX', 'worldY'][i]}: ours ${v}, 4.2 ${m[i]}`);
          });
        }
        for (const [name, s] of Object.entries<any>(pose.slots)) {
          const slot = sk.slots.find((x) => x.data.name === name)!;
          if (slot.attachmentName !== s.attachment)
            problems.push(`slot ${name}: attachment ours ${slot.attachmentName}, 4.2 ${s.attachment}`);
          slot.color.forEach((v, i) => {
            if (Math.abs(v - s.color[i]) > 2e-2) problems.push(`slot ${name}: color[${i}] ours ${v}, 4.2 ${s.color[i]}`);
          });
          if (s.dark && slot.dark)
            slot.dark.forEach(
              (v, i) => Math.abs(v - s.dark[i]) > 2e-2 && problems.push(`slot ${name}: dark[${i}] ours ${v}, 4.2 ${s.dark[i]}`),
            );
        }
        expect(sk.drawOrder.map((s) => s.data.name)).toEqual(pose.drawOrder);
        expect(problems).toEqual([]);
      });
    }
  }
});
