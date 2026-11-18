import { Box3, type Mesh, type Vector3 } from 'three'

/**
 * Ray-marching tuning constant preserved from the original GLSL/TSL shaders.
 *
 * The original fragment shaders advanced each march step by
 * `0.0288 * length(scale)`. For the default unit box (`BoxGeometry(1, 1, 1)`)
 * under an identity transform the world-space bounding box is exactly
 * `(1, 1, 1)`, whose length is `sqrt(3)`, so keeping this coefficient keeps the
 * step length — and therefore the look — byte-for-byte identical at scale
 * `(1, 1, 1)`. It is derived from `1 / (ITERATIONS * sqrt(3))` for the default
 * 20 iterations, i.e. roughly one diagonal box-length worth of marching.
 */
export const FIRE_STEP_FACTOR = 0.0288

// Reused scratch object so per-frame `update()` calls allocate nothing.
const scratchBox = new Box3()

/**
 * Measures the mesh's actual world-space axis-aligned bounding box.
 *
 * Unlike reading `mesh.scale` directly, this honors the full world transform
 * (including parent transforms and rotations) and always returns non-negative
 * extents. A flipped (negative) scale mirrors the object but cannot produce a
 * negative box size, and a collapsed (zero) axis yields a zero extent rather
 * than `NaN`/`Infinity`.
 *
 * @param mesh - The fire mesh whose world bounding box should be measured.
 * @param target - Vector that receives the bounding box's `(width, height, depth)`.
 * @returns The `target` vector, populated with the non-negative box extents.
 */
export function writeWorldBoundingBoxSize(mesh: Mesh, target: Vector3): Vector3 {
  scratchBox.setFromObject(mesh)
  // `Box3.getSize` subtracts min from max, so every component is guaranteed to
  // be finite and >= 0 regardless of the sign of any scale component.
  scratchBox.getSize(target)
  return target
}

/**
 * Computes the scalar ray-march step length (in world units) from a bounding
 * box's extents.
 *
 * The L2 norm of the box size grows monotonically as the bounding box grows in
 * any axis and equals `sqrt(3)` for the unit cube, which reproduces the
 * historical `0.0288 * length(scale)` result under the default identity
 * transform.
 *
 * @param boxSize - Non-negative bounding-box extents (see {@link writeWorldBoundingBoxSize}).
 * @returns The per-step marching distance. Always finite; `0` only for a fully
 *          degenerate (zero-volume) box.
 */
export function computeFireStep(boxSize: Vector3): number {
  return FIRE_STEP_FACTOR * boxSize.length()
}
