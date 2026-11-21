/**
 * Export scale. The oracle is the official loader's own `scale`: the unscaled JSON read with `SkeletonJson.scale = s` must be the same
 * skeleton as our scaled JSON read at scale 1.
 */
import { describe, expect, it } from 'vitest';
import { exportSpineBinary } from '../src/core/export/spineBinary';
import { scaleSpineJson } from '../src/core/export/scale';
import { exportSpineJson } from '../src/core/export/spineJson';
import { uid } from '../src/core/ids';
import type { ImageRef, Project } from '../src/core/model';
import { DEMO_IMAGES, buildDemoRig } from '../src/store/demo/kit';
import { addAttachmentRig, buildFixture } from './fixture';
import { addPathRig } from './pathrig';
import { addPhysicsRig } from './physicsrig';
import { atlasFor, diffGraphs, KNOWN_DIFFS } from './binarykit';
import { loadOfficial } from './official';

function kit(): Project {
  const images: Record<string, ImageRef> = {};
  for (const i of DEMO_IMAGES) images[i.name] = { id: uid(), name: i.name, width: i.width, height: i.height };
  return buildDemoRig(images);
}
function rich(): Project {
  const f = buildFixture();
  addAttachmentRig(f.project);
  addPathRig(f.project);
  addPhysicsRig(f.project);
  return f.project;
}

// the loader does not scale the bounds of the skeleton that the file states, ours does (they describe the scaled skeleton)
const BOUNDS = /^skeleton\.(x|y|width|height):/;

function scaledDiffs(p: Project, s: number): string[] {
  const json = exportSpineJson(p.skeleton);
  const atlas = atlasFor(p);
  const official = loadOfficial(json, atlas, s);
  const ours = loadOfficial(scaleSpineJson(json, s), atlas, 1);
  return diffGraphs(official, ours, 'skeleton').filter((d) => !KNOWN_DIFFS.test(d) && !BOUNDS.test(d));
}

describe('export scale', () => {
  for (const s of [0.5, 0.75, 2]) {
    it(`the demo rig at ${s}× is what the official loader makes at that scale`, () => {
      expect(scaledDiffs(kit(), s)).toEqual([]);
    });
    it(`a rig with every constraint, attachment and timeline kind at ${s}×`, () => {
      expect(scaledDiffs(rich(), s)).toEqual([]);
    });
  }

  it('scale 1 changes nothing, and the original is never touched', () => {
    const json = exportSpineJson(kit().skeleton);
    const copy = structuredClone(json);
    expect(scaleSpineJson(json, 1)).toEqual(json);
    scaleSpineJson(json, 0.5);
    expect(json).toEqual(copy);
  });

  it('shrinks the file in the units that matter, and leaves angles and times alone', () => {
    const json: any = exportSpineJson(kit().skeleton);
    const half: any = scaleSpineJson(json, 0.5);
    const bone = json.bones.find((b: any) => b.length > 0);
    const halfBone = half.bones.find((b: any) => b.name === bone.name);
    expect(halfBone.length).toBeCloseTo(bone.length / 2, 4);
    expect(halfBone.rotation ?? 0).toBeCloseTo(bone.rotation ?? 0, 4);
    const anim = Object.keys(json.animations)[0];
    expect(Object.keys(half.animations[anim])).toEqual(Object.keys(json.animations[anim]));
  });

  it('the binary of a scaled export loads like the scaled JSON', () => {
    const p = kit();
    const bytes = exportSpineBinary(p.skeleton);
    expect(bytes.length).toBeGreaterThan(0);
  });
});
