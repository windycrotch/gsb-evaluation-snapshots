import { mat4, vec3 } from "gl-matrix";

const matViewProjection = mat4.create();
const matViewProjectionInverted = mat4.create();
const matViewInverted = mat4.create();

/**
 * Computes the world-space pick ray for a tap: it starts at the camera
 * position and passes through the given NDC point on the far plane.
 *
 * Writes the camera position into `outCamera` and the normalized ray
 * direction into `outDirection` and returns `true`. Returns `false` when the
 * view or view-projection matrix is not invertible, in which case the tap
 * must be ignored.
 */
export function computeTapRay(
    ndcX: number,
    ndcY: number,
    viewMatrix: mat4,
    projectionMatrix: mat4,
    outCamera: vec3,
    outDirection: vec3
): boolean {
    mat4.multiply(matViewProjection, projectionMatrix, viewMatrix);
    if (mat4.invert(matViewProjectionInverted, matViewProjection) === null
        || mat4.invert(matViewInverted, viewMatrix) === null) {
        return false;
    }
    mat4.getTranslation(outCamera, matViewInverted);

    // Unproject the far-plane point of the tap (gl-matrix divides by w).
    vec3.set(outDirection, ndcX, ndcY, 1);
    vec3.transformMat4(outDirection, outDirection, matViewProjectionInverted);
    vec3.subtract(outDirection, outDirection, outCamera);

    const length = vec3.length(outDirection);
    if (length === 0) {
        return false;
    }

    vec3.scale(outDirection, outDirection, 1 / length);
    return true;
}

/**
 * Picks the plane closest to the ray starting at the camera and going along
 * the given normalized direction.
 *
 * A plane counts as hit when its center is in front of the camera and its
 * perpendicular distance to the ray is smaller than `hitRadius`. When
 * several planes are within the radius, the one with the smallest
 * perpendicular distance wins. Returns the index of the hit plane or -1.
 */
export function pickPlaneOnRay(
    cameraX: number,
    cameraY: number,
    cameraZ: number,
    directionX: number,
    directionY: number,
    directionZ: number,
    positions: ReadonlyArray<readonly number[]>,
    hitRadius: number
): number {
    let hitIndex = -1;
    let hitDistance = hitRadius;

    for (let i = 0; i < positions.length; i++) {
        const toPlaneX = positions[i][0] - cameraX;
        const toPlaneY = positions[i][1] - cameraY;
        const toPlaneZ = positions[i][2] - cameraZ;

        // Ignore planes behind the camera.
        const alongRay = toPlaneX * directionX + toPlaneY * directionY + toPlaneZ * directionZ;
        if (alongRay <= 0) {
            continue;
        }

        // Perpendicular distance to the ray: |toPlane|^2 - along^2.
        const distanceSq = toPlaneX * toPlaneX + toPlaneY * toPlaneY + toPlaneZ * toPlaneZ - alongRay * alongRay;
        const distance = Math.sqrt(Math.max(distanceSq, 0));

        if (distance < hitDistance) {
            hitDistance = distance;
            hitIndex = i;
        }
    }

    return hitIndex;
}
