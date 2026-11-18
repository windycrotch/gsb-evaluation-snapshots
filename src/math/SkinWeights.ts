import { SkeletonRig, JointType } from '../types';

export interface BoneSegment {
  boneIndex: number;
  ax: number; ay: number; az: number;
  bx: number; by: number; bz: number;
}

export interface WeightCandidate {
  index: number;
  weight: number;
}

/**
 * Distance from a point to a line segment in plain-number 3D space.
 * Degenerate segments (head === tail) collapse to point-to-point distance,
 * so the result is always a finite, non-negative number for finite inputs.
 */
export function distancePointToSegment3D(
  px: number, py: number, pz: number,
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number
): number {
  const abx = bx - ax;
  const aby = by - ay;
  const abz = bz - az;
  const apx = px - ax;
  const apy = py - ay;
  const apz = pz - az;

  const abLenSq = abx * abx + aby * aby + abz * abz;
  if (abLenSq < 1e-12) {
    return Math.sqrt(apx * apx + apy * apy + apz * apz);
  }

  const t = Math.max(0, Math.min(1, (apx * abx + apy * aby + apz * abz) / abLenSq));
  const dx = px - (ax + t * abx);
  const dy = py - (ay + t * aby);
  const dz = pz - (az + t * abz);
  return Math.sqrt(dx * dx + dy * dy + dz * dz);
}

/**
 * Builds world-space bone segments from a rig's hierarchy. Joint indices
 * follow the insertion order of `rig.joints`, which is the same ordering
 * used by THREE.Skeleton bones created in MeshAnalyzer.
 *
 * Throws a diagnostic error when the hierarchy references a joint that does
 * not exist in `rig.joints`, instead of silently producing NaN segments.
 */
export function buildBoneSegments(rig: SkeletonRig): BoneSegment[] {
  const boneTypes = Object.keys(rig.joints) as JointType[];
  const knownTypes = new Set<JointType>(boneTypes);
  const segments: BoneSegment[] = [];

  for (let b = 0; b < boneTypes.length; b++) {
    const parentType = boneTypes[b];
    const parentPos = rig.joints[parentType].position;
    const children = rig.hierarchy[parentType] ?? [];

    if (children.length === 0) {
      // Leaf joint: zero-length point capsule.
      segments.push({
        boneIndex: b,
        ax: parentPos.x, ay: parentPos.y, az: parentPos.z,
        bx: parentPos.x, by: parentPos.y, bz: parentPos.z,
      });
      continue;
    }

    for (const childType of children) {
      if (!knownTypes.has(childType)) {
        throw new Error(
          `[SkinWeights] Hierarchy of joint "${parentType}" references unknown joint "${childType}", which is missing from rig.joints`
        );
      }
      const childPos = rig.joints[childType].position;
      segments.push({
        boneIndex: b,
        ax: parentPos.x, ay: parentPos.y, az: parentPos.z,
        bx: childPos.x, by: childPos.y, bz: childPos.z,
      });
    }
  }

  return segments;
}

/**
 * Selects and normalizes the strongest influences for one vertex.
 *
 * Guarantees:
 *  - exactly `maxInfluences` index/weight slots are returned;
 *  - every weight is finite and non-negative;
 *  - the weights sum to exactly 1.
 *
 * When every candidate weight is zero or non-finite (the weight denominator
 * would be 0, e.g. a vertex extremely far from every bone segment), full
 * weight is pinned to `fallbackIndex` (normally the nearest bone) instead
 * of producing NaN.
 */
export function normalizeTopInfluences(
  candidates: WeightCandidate[],
  maxInfluences: number = 4,
  fallbackIndex: number = 0
): { indices: number[]; weights: number[] } {
  const sorted = candidates
    .filter(c => Number.isFinite(c.weight) && c.weight > 0)
    .sort((a, b) => b.weight - a.weight);

  const top = sorted.slice(0, maxInfluences);
  const sum = top.reduce((acc, c) => acc + c.weight, 0);

  const indices = new Array<number>(maxInfluences).fill(0);
  const weights = new Array<number>(maxInfluences).fill(0);

  if (sum > 0) {
    for (let i = 0; i < top.length; i++) {
      indices[i] = top[i].index;
      weights[i] = top[i].weight / sum;
    }
  } else {
    // All influences vanished (zero denominator): pin to a valid bone.
    indices[0] = fallbackIndex;
    weights[0] = 1;
  }

  return { indices, weights };
}

/**
 * Fills GPU skinning buffers for every vertex in `positions`.
 *
 * Robust against:
 *  - zero vertices (returns immediately; zero-length buffers stay valid);
 *  - degenerate meshes whose vertices all coincide;
 *  - vertices so far from every bone segment that raw weights underflow to 0;
 *  - non-finite position components (treated as maximally distant, never NaN).
 */
export function calculateSkinWeights(
  positions: ArrayLike<number>,
  rig: SkeletonRig,
  falloff: number,
  skinIndices: Uint16Array,
  skinWeights: Float32Array,
  maxInfluences: number = 4
): void {
  const vertexCount = Math.floor(positions.length / 3);
  if (vertexCount === 0) {
    // Empty mesh: nothing to bind. Zero-length attributes are valid.
    return;
  }

  const segments = buildBoneSegments(rig);
  if (segments.length === 0) {
    throw new Error('[SkinWeights] Cannot compute skin weights: rig contains no joints');
  }

  const required = vertexCount * maxInfluences;
  if (skinIndices.length < required || skinWeights.length < required) {
    throw new Error(
      `[SkinWeights] Output buffers too small: need ${required} slots per buffer for ${vertexCount} vertices`
    );
  }

  const safeFalloff = Number.isFinite(falloff) && falloff > 0 ? falloff : 2.0;

  for (let i = 0; i < vertexCount; i++) {
    const vx = positions[i * 3 + 0];
    const vy = positions[i * 3 + 1];
    const vz = positions[i * 3 + 2];

    let nearestIndex = segments[0].boneIndex;
    let nearestDist = Infinity;
    const candidates: WeightCandidate[] = [];

    for (const seg of segments) {
      const rawDist = distancePointToSegment3D(
        vx, vy, vz,
        seg.ax, seg.ay, seg.az,
        seg.bx, seg.by, seg.bz
      );
      const dist = Number.isFinite(rawDist) ? rawDist : 1e9;
      if (dist < nearestDist) {
        nearestDist = dist;
        nearestIndex = seg.boneIndex;
      }
      const rawWeight = 1.0 / Math.pow(dist + 0.001, safeFalloff);
      candidates.push({
        index: seg.boneIndex,
        weight: Number.isFinite(rawWeight) ? rawWeight : 0,
      });
    }

    const { indices, weights } = normalizeTopInfluences(
      candidates,
      maxInfluences,
      nearestIndex
    );

    for (let k = 0; k < maxInfluences; k++) {
      skinIndices[i * maxInfluences + k] = indices[k];
      skinWeights[i * maxInfluences + k] = weights[k];
    }
  }
}
