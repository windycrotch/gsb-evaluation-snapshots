import { Vertex } from './Vertex';
import { Bone } from './Bone';
import { pointToSegmentDistance } from './Distance';
import { HeatDiffusion } from './HeatDiffusion';
import { normalizeTopInfluences } from './SkinWeights';

export interface BoundedSkinInfluence {
    indices: number[];
    weights: number[];
}

export class WeightSolver {
    /**
     * Unbounded per-bone weights. If every raw weight is zero (the vertex is
     * outside the heat radius of every bone), the full weight is pinned to
     * the nearest bone so the result is always normalized and never NaN.
     */
    static solve(vertices: Vertex[], bones: Bone[], radius: number = 1.0): Map<number, number[]> {
        if (bones.length === 0) {
            throw new Error('[WeightSolver] Cannot solve weights without any bones');
        }

        const weights = new Map<number, number[]>();
        for (const v of vertices) {
            const vWeights: number[] = [];
            let sum = 0;
            let nearestIdx = 0;
            let nearestDist = Infinity;

            for (let i = 0; i < bones.length; i++) {
                const b = bones[i];
                const dist = pointToSegmentDistance(v.position, b.head, b.tail);
                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearestIdx = i;
                }
                const w = HeatDiffusion.calculateWeights(dist, radius);
                vWeights.push(w);
                sum += w;
            }

            if (sum > 0) {
                for (let i = 0; i < vWeights.length; i++) {
                    vWeights[i] /= sum;
                }
            } else {
                // Zero denominator fallback: nearest bone gets full weight.
                for (let i = 0; i < vWeights.length; i++) {
                    vWeights[i] = i === nearestIdx ? 1 : 0;
                }
            }
            weights.set(v.id, vWeights);
        }
        return weights;
    }

    /**
     * Solves skinning weights clamped to a maximum number of influences (default 4 for GPU skinning shaders).
     * Renormalizes the top influences so their sum equals exactly 1.0.
     * When all raw weights are zero (vertex beyond every bone's radius), the
     * full influence is pinned to a valid bone instead of emitting NaN/zeros.
     */
    static solveBounded(
        vertices: Vertex[],
        bones: Bone[],
        radius: number = 1.0,
        maxInfluences: number = 4
    ): Map<number, BoundedSkinInfluence> {
        if (bones.length === 0) {
            throw new Error('[WeightSolver] Cannot solve bounded weights without any bones');
        }

        const result = new Map<number, BoundedSkinInfluence>();

        for (const v of vertices) {
            const candidates: { index: number; weight: number }[] = [];
            let nearestIdx = 0;
            let nearestDist = Infinity;

            for (let bIdx = 0; bIdx < bones.length; bIdx++) {
                const b = bones[bIdx];
                const dist = pointToSegmentDistance(v.position, b.head, b.tail);
                if (dist < nearestDist) {
                    nearestDist = dist;
                    nearestIdx = bIdx;
                }
                const w = HeatDiffusion.calculateWeights(dist, radius);
                candidates.push({ index: bIdx, weight: w });
            }

            // Shared normalization: handles the zero-denominator fallback and
            // guarantees exactly maxInfluences slots summing to 1.
            const { indices, weights } = normalizeTopInfluences(
                candidates,
                maxInfluences,
                nearestIdx
            );
            result.set(v.id, { indices, weights });
        }

        return result;
    }
}
