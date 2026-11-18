import { describe, it, expect, beforeEach } from 'vitest';
import * as THREE from 'three';
import { MeshAnalyzer } from '../src/topology/MeshAnalyzer';
import { calculateSkinWeights, normalizeTopInfluences } from '../src/math/SkinWeights';
import { WeightSolver } from '../src/math/WeightSolver';
import { Vertex } from '../src/math/Vertex';
import { Bone } from '../src/math/Bone';
import { Vec3 } from '../src/math/Vec3';
import { AutoRigger } from '../src/core/AutoRigger';
import { JointType, SkeletonRig, Joint } from '../src/types';

function makeJoint(type: JointType, x: number, y: number, z: number): Joint {
  return { type, position: { x, y, z }, confidence: 1 };
}

/** Minimal 3-joint rig: Hips -> Spine -> Chest, all on the Y axis. */
function makeMiniRig(): SkeletonRig {
  return {
    joints: {
      [JointType.Hips]: makeJoint(JointType.Hips, 0, 0, 0),
      [JointType.Spine]: makeJoint(JointType.Spine, 0, 1, 0),
      [JointType.Chest]: makeJoint(JointType.Chest, 0, 2, 0),
    } as Record<JointType, Joint>,
    hierarchy: {
      [JointType.Hips]: [JointType.Spine],
      [JointType.Spine]: [JointType.Chest],
      [JointType.Chest]: [],
    } as Record<JointType, JointType[]>,
  };
}

function makeMesh(positions: number[]): THREE.Mesh {
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
  return new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
}

function assertFiniteAndNormalized(
  skinIndices: Uint16Array,
  skinWeights: Float32Array,
  vertexCount: number,
  boneCount: number
): void {
  expect(skinIndices.length).toBe(vertexCount * 4);
  expect(skinWeights.length).toBe(vertexCount * 4);
  for (let v = 0; v < vertexCount; v++) {
    let sum = 0;
    for (let k = 0; k < 4; k++) {
      const idx = skinIndices[v * 4 + k];
      const w = skinWeights[v * 4 + k];
      expect(Number.isInteger(idx)).toBe(true);
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(boneCount);
      expect(Number.isFinite(w)).toBe(true);
      expect(w).toBeGreaterThanOrEqual(0);
      sum += w;
    }
    expect(sum).toBeCloseTo(1.0, 6);
  }
}

describe('Skinning robustness: degenerate geometry', () => {
  const analyzer = new MeshAnalyzer();

  it('binds a zero-vertex mesh into a usable SkinnedMesh with a complete skeleton', () => {
    const rig = makeMiniRig();
    const mesh = makeMesh([]);
    const skinIndices = new Uint16Array(0);
    const skinWeights = new Float32Array(0);

    const skinned = analyzer.bindSkeletonWithWeights(mesh, rig, skinIndices, skinWeights);

    expect(skinned).toBeInstanceOf(THREE.SkinnedMesh);
    expect(skinned.skeleton.bones.length).toBe(3);
    expect(skinned.skeleton.bones.map(b => b.name)).toEqual([
      JointType.Hips,
      JointType.Spine,
      JointType.Chest,
    ]);

    const indexAttr = skinned.geometry.getAttribute('skinIndex') as THREE.BufferAttribute;
    const weightAttr = skinned.geometry.getAttribute('skinWeight') as THREE.BufferAttribute;
    expect(indexAttr).toBeDefined();
    expect(weightAttr).toBeDefined();
    expect(indexAttr.count).toBe(0);
    expect(weightAttr.count).toBe(0);

    // Every bone position must remain finite even with no vertex data.
    for (const bone of skinned.skeleton.bones) {
      expect(Number.isFinite(bone.position.x)).toBe(true);
      expect(Number.isFinite(bone.position.y)).toBe(true);
      expect(Number.isFinite(bone.position.z)).toBe(true);
    }
  });

  it('produces normalized, in-bounds weights for a fully degenerate mesh (all vertices coincide)', () => {
    const rig = makeMiniRig();
    // 5 vertices all at the same point.
    const positions = new Array(5).fill([7, 7, 7]).flat();
    const vertexCount = positions.length / 3;
    const skinIndices = new Uint16Array(vertexCount * 4);
    const skinWeights = new Float32Array(vertexCount * 4);

    calculateSkinWeights(new Float32Array(positions), rig, 2.0, skinIndices, skinWeights);
    assertFiniteAndNormalized(skinIndices, skinWeights, vertexCount, 3);

    // Same input point -> identical weight profile for every vertex.
    for (let v = 1; v < vertexCount; v++) {
      for (let k = 0; k < 4; k++) {
        expect(skinWeights[v * 4 + k]).toBe(skinWeights[k]);
        expect(skinIndices[v * 4 + k]).toBe(skinIndices[k]);
      }
    }

    const skinned = analyzer.bindSkeletonWithWeights(makeMesh(positions), rig, skinIndices, skinWeights);
    expect(skinned).toBeInstanceOf(THREE.SkinnedMesh);
    const boundWeights = skinned.geometry.getAttribute('skinWeight') as THREE.BufferAttribute;
    for (let i = 0; i < boundWeights.count * 4; i++) {
      expect(Number.isNaN(boundWeights.array[i])).toBe(false);
    }
  });

  it('falls back to a nearest-bone pin when every raw weight underflows to zero (zero denominator)', () => {
    const rig = makeMiniRig();
    // A vertex far away combined with a steep falloff makes every raw weight
    // 1 / (dist + 0.001)^falloff underflow to exactly 0, i.e. a zero
    // denominator after the top-4 selection.
    const positions = new Float32Array([1e6, 1e6, 1e6]);
    const skinIndices = new Uint16Array(4);
    const skinWeights = new Float32Array(4);

    calculateSkinWeights(positions, rig, 100, skinIndices, skinWeights);

    expect(skinWeights.some(w => Number.isNaN(w))).toBe(false);
    expect(skinWeights[0]).toBe(1);
    expect(skinWeights[1]).toBe(0);
    expect(skinWeights[2]).toBe(0);
    expect(skinWeights[3]).toBe(0);
    expect(skinIndices[0]).toBeGreaterThanOrEqual(0);
    expect(skinIndices[0]).toBeLessThan(3);
    assertFiniteAndNormalized(skinIndices, skinWeights, 1, 3);
  });

  it('normalizeTopInfluences pins a valid index when all candidate weights are zero', () => {
    const result = normalizeTopInfluences(
      [
        { index: 0, weight: 0 },
        { index: 1, weight: 0 },
        { index: 2, weight: 0 },
      ],
      4,
      2
    );
    expect(result.indices).toEqual([2, 0, 0, 0]);
    expect(result.weights).toEqual([1, 0, 0, 0]);
  });

  it('WeightSolver.solveBounded stays normalized when the vertex is beyond every heat radius', () => {
    // Radius 1.0, but the vertex is 100 units away from every bone -> all raw weights 0.
    const vertex = new Vertex(new Vec3(100, 100, 100), 0);
    const bones = [
      new Bone('b0', new Vec3(0, 0, 0), new Vec3(0, 1, 0)),
      new Bone('b1', new Vec3(0, 1, 0), new Vec3(0, 2, 0)),
    ];

    const bounded = WeightSolver.solveBounded([vertex], bones, 1.0, 4);
    const influence = bounded.get(0)!;
    expect(influence.weights.every(w => Number.isFinite(w))).toBe(true);
    expect(influence.weights.reduce((a, b) => a + b, 0)).toBeCloseTo(1.0);
    expect(influence.weights[0]).toBe(1);
    expect(influence.indices.every(i => i >= 0 && i < 2)).toBe(true);

    const plain = WeightSolver.solve([vertex], bones, 1.0);
    expect(plain.get(0)!.reduce((a, b) => a + b, 0)).toBeCloseTo(1.0);
  });

  it('sanitizes upstream indices/weights that are out of bounds or non-normalized', () => {
    const rig = makeMiniRig();
    const mesh = makeMesh([0, 0, 0, 0, 1, 0]);
    // Vertex 0: out-of-range index + NaN weight. Vertex 1: weights summing to 0.
    const badIndices = new Uint16Array([999, 1, 2, 0, 0, 1, 2, 0]);
    const badWeights = new Float32Array([NaN, 0.5, 0.5, 0, 0, 0, 0, 0]);

    const skinned = analyzer.bindSkeletonWithWeights(mesh, rig, badIndices, badWeights);
    const indices = (skinned.geometry.getAttribute('skinIndex') as THREE.BufferAttribute).array as Uint16Array;
    const weights = (skinned.geometry.getAttribute('skinWeight') as THREE.BufferAttribute).array as Float32Array;

    for (const idx of indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(3);
    }
    for (let v = 0; v < 2; v++) {
      const sum = weights[v * 4] + weights[v * 4 + 1] + weights[v * 4 + 2] + weights[v * 4 + 3];
      expect(sum).toBeCloseTo(1.0, 6);
      for (let k = 0; k < 4; k++) {
        expect(Number.isFinite(weights[v * 4 + k])).toBe(true);
      }
    }
  });
});

describe('Skeleton construction: hierarchy validation and local positions', () => {
  const analyzer = new MeshAnalyzer();

  it('places Hips at its world position and children at child-world minus parent-world', () => {
    const rig = makeMiniRig();
    const mesh = makeMesh([0, 0.5, 0]);
    const skinned = analyzer.bindSkeletonWithWeights(
      mesh,
      rig,
      new Uint16Array([0, 0, 0, 0]),
      new Float32Array([1, 0, 0, 0])
    );

    const hips = skinned.skeleton.getBoneByName(JointType.Hips)!;
    const spine = skinned.skeleton.getBoneByName(JointType.Spine)!;
    const chest = skinned.skeleton.getBoneByName(JointType.Chest)!;

    // Root uses its own world coordinates.
    expect(hips.position.toArray()).toEqual([0, 0, 0]);
    // Non-root local positions are child world - parent world.
    expect(spine.position.toArray()).toEqual([0, 1, 0]);
    expect(chest.position.toArray()).toEqual([0, 1, 0]);

    // World positions reconstructed through the hierarchy must match rig data.
    hips.updateMatrixWorld(true);
    const spineWorld = new THREE.Vector3();
    const chestWorld = new THREE.Vector3();
    spine.getWorldPosition(spineWorld);
    chest.getWorldPosition(chestWorld);
    expect(spineWorld.toArray()).toEqual([0, 1, 0]);
    expect(chestWorld.toArray()).toEqual([0, 2, 0]);
  });

  it('throws a diagnostic error when the hierarchy references a joint missing from rig.joints', () => {
    const rig = makeMiniRig();
    rig.hierarchy[JointType.Spine] = [JointType.Neck]; // Neck is not in joints
    const mesh = makeMesh([0, 0, 0]);

    expect(() =>
      analyzer.bindSkeletonWithWeights(mesh, rig, new Uint16Array(4), new Float32Array([1, 0, 0, 0]))
    ).toThrowError(/missing from rig\.joints/);

    // The same malformed rig must be rejected by the weight pipeline too.
    expect(() =>
      calculateSkinWeights(
        new Float32Array([0, 0, 0]),
        rig,
        2.0,
        new Uint16Array(4),
        new Float32Array(4)
      )
    ).toThrowError(/unknown joint/);
  });

  it('throws a diagnostic error when a joint in rig.joints is missing from the hierarchy', () => {
    const rig = makeMiniRig();
    // Chest is defined in joints but nothing references it.
    rig.hierarchy[JointType.Spine] = [];
    const mesh = makeMesh([0, 0, 0]);

    expect(() =>
      analyzer.bindSkeletonWithWeights(mesh, rig, new Uint16Array(4), new Float32Array([1, 0, 0, 0]))
    ).toThrowError(/missing from the hierarchy/);
  });

  it('throws a diagnostic error when the hierarchy has an entry for an unknown parent', () => {
    const rig = makeMiniRig();
    (rig.hierarchy as Record<string, string[]>)[JointType.Neck] = []; // Neck not in joints
    const mesh = makeMesh([0, 0, 0]);

    expect(() =>
      analyzer.bindSkeletonWithWeights(mesh, rig, new Uint16Array(4), new Float32Array([1, 0, 0, 0]))
    ).toThrowError(/missing from rig\.joints/);
  });

  it('throws a diagnostic error when the rig has no Hips root', () => {
    const rig = makeMiniRig();
    delete (rig.joints as Partial<Record<JointType, Joint>>)[JointType.Hips];
    const mesh = makeMesh([0, 0, 0]);

    expect(() =>
      analyzer.bindSkeletonWithWeights(mesh, rig, new Uint16Array(4), new Float32Array([1, 0, 0, 0]))
    ).toThrowError(/Hips/);
  });
});

/** Worker mock that echoes transferable buffers and returns a minimal valid rig. */
class EchoMockWorker {
  onmessage: any;
  onerror: any;
  postMessage(data: any) {
    if (data.type === 'INIT') {
      setTimeout(() => this.onmessage({ data: { type: 'INIT_DONE', msgId: data.msgId } }), 1);
    } else if (data.type === 'RIG') {
      const { indicesBuffer, weightsBuffer } = data.payload;
      setTimeout(() => {
        this.onmessage({
          data: {
            type: 'RIG_DONE',
            msgId: data.msgId,
            payload: {
              rig: makeMiniRig(),
              indicesBuffer,
              weightsBuffer,
            },
          },
        });
      }, 1);
    }
  }
}

describe('AutoRigger end-to-end with local fixtures (no ONNX)', () => {
  beforeEach(() => {
    // @ts-ignore
    global.Worker = EchoMockWorker;
  });

  it('returns a usable SkinnedMesh for a zero-vertex upload', async () => {
    const engine = new AutoRigger();
    await engine.init();

    const skinned = await engine.rig(makeMesh([]));

    expect(skinned).toBeInstanceOf(THREE.SkinnedMesh);
    expect(skinned.skeleton.bones.length).toBe(3);
    const indexAttr = skinned.geometry.getAttribute('skinIndex') as THREE.BufferAttribute;
    const weightAttr = skinned.geometry.getAttribute('skinWeight') as THREE.BufferAttribute;
    expect(indexAttr.count).toBe(0);
    expect(weightAttr.count).toBe(0);
  });

  it('rejects geometry without a position attribute with a diagnostic error', async () => {
    const engine = new AutoRigger();
    await engine.init();

    const emptyGeometry = new THREE.BufferGeometry();
    const mesh = new THREE.Mesh(emptyGeometry);
    await expect(engine.rig(mesh)).rejects.toThrowError(/position/);
  });

  it('binds a degenerate single-point mesh end-to-end without NaN', async () => {
    const engine = new AutoRigger();
    await engine.init();

    const skinned = await engine.rig(makeMesh([3, 3, 3, 3, 3, 3]));
    const weights = (skinned.geometry.getAttribute('skinWeight') as THREE.BufferAttribute).array as Float32Array;
    const indices = (skinned.geometry.getAttribute('skinIndex') as THREE.BufferAttribute).array as Uint16Array;

    for (const w of weights) {
      expect(Number.isFinite(w)).toBe(true);
    }
    for (const idx of indices) {
      expect(idx).toBeGreaterThanOrEqual(0);
      expect(idx).toBeLessThan(skinned.skeleton.bones.length);
    }
    for (let v = 0; v < 2; v++) {
      const sum = weights[v * 4] + weights[v * 4 + 1] + weights[v * 4 + 2] + weights[v * 4 + 3];
      expect(sum).toBeCloseTo(1.0, 6);
    }
  });
});
