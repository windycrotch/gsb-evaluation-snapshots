import { mat4, vec3 } from "gl-matrix";
import { computeTapRay, pickPlaneOnRay } from "../src/MathUtils";
import { PlaneTapAnimator } from "../src/PlaneTapAnimator";

/**
 * Reproducible acceptance tests for tap hit-testing and tap animation state.
 *
 * Run with `npm test`. Exits with a non-zero code when any check fails.
 */

let failures = 0;

function check(condition: boolean, name: string): void {
    if (condition) {
        console.log(`ok   - ${name}`);
    } else {
        failures++;
        console.error(`FAIL - ${name}`);
    }
}

function nearlyEqual(a: number, b: number, epsilon = 1e-6): boolean {
    return Math.abs(a - b) <= epsilon;
}

// Known camera and projection: camera at [0, -500, 100] looking at the
// origin of the plane formation, up is +Z.
const view = mat4.create();
mat4.lookAt(view, [0, -500, 100], [0, 0, 100], [0, 0, 1]);
const projection = mat4.create();
mat4.perspective(projection, 25 * Math.PI / 180, 800 / 600, 100, 2000);

const camera = vec3.create();
const direction = vec3.create();

// --- Ray construction ------------------------------------------------------

check(
    computeTapRay(0, 0, view, projection, camera, direction),
    "center tap: ray computed"
);
check(
    nearlyEqual(camera[0], 0, 1e-4) && nearlyEqual(camera[1], -500, 1e-4) && nearlyEqual(camera[2], 100, 1e-4),
    "center tap: ray starts at the camera position"
);
check(
    nearlyEqual(direction[0], 0, 1e-4) && direction[1] > 0.99 && nearlyEqual(direction[2], 0, 1e-4),
    "center tap: ray points straight ahead"
);
check(
    nearlyEqual(vec3.length(direction), 1, 1e-6),
    "center tap: ray direction is normalized"
);

// A degenerate (non-invertible) projection matrix must reject the tap.
const degenerateProjection = mat4.create();
mat4.multiply(degenerateProjection, projection, projection);
degenerateProjection[0] = 0;
degenerateProjection[5] = 0;
degenerateProjection[10] = 0;
degenerateProjection[15] = 0;
check(
    !computeTapRay(0, 0, view, degenerateProjection, camera, direction),
    "non-invertible projection: tap ignored"
);

// --- Picking along the ray -------------------------------------------------

// Clicking the screen center hits the plane straight ahead.
check(
    computeTapRay(0, 0, view, projection, camera, direction)
    && pickPlaneOnRay(
        camera[0], camera[1], camera[2],
        direction[0], direction[1], direction[2],
        [[0, 0, 100], [30, 0, 100]],
        35
    ) === 0,
    "center tap: hits the plane straight ahead"
);

// A plane behind the camera never counts, even at a tiny distance.
check(
    pickPlaneOnRay(
        camera[0], camera[1], camera[2],
        direction[0], direction[1], direction[2],
        [[0, -600, 100]],
        35
    ) === -1,
    "plane behind the camera: no hit"
);

// A plane exactly beside the camera (zero forward component) does not count.
check(
    pickPlaneOnRay(
        camera[0], camera[1], camera[2],
        direction[0], direction[1], direction[2],
        [[10, -500, 100]],
        35
    ) === -1,
    "plane beside the camera: no hit"
);

// Two planes within the radius: the one with the smaller perpendicular
// distance (20 vs 34) wins.
check(
    pickPlaneOnRay(
        camera[0], camera[1], camera[2],
        direction[0], direction[1], direction[2],
        [[20, 0, 100], [34, 0, 100]],
        35
    ) === 0,
    "distances 20 and 34: hits the closer one"
);

// Two planes outside the radius (36 and 40): no hit at all.
check(
    pickPlaneOnRay(
        camera[0], camera[1], camera[2],
        direction[0], direction[1], direction[2],
        [[36, 0, 100], [40, 0, 100]],
        35
    ) === -1,
    "distances 36 and 40: no hit"
);

// --- Animation state -------------------------------------------------------

const animator = new PlaneTapAnimator(5, 1000);

// A second tap on a plane whose animation is still running is ignored.
animator.tap(2);
animator.update(400); // t = 0.4 of the first tap
animator.tap(2);      // must be ignored, must not restart the timer
animator.update(700); // t = 1.1 of the first tap: finished
check(
    animator.getOffsetX(2) === 0
    && animator.getOffsetY(2) === 0
    && animator.getOffsetZ(2) === 0
    && animator.getBankingOffset(2) === 0,
    "re-tap while running: ignored, offsets return exactly to 0"
);

// After the animation ends, all offsets are exactly 0.
animator.tap(0);
animator.update(1000); // exactly t = 1
check(
    animator.getOffsetX(0) === 0
    && animator.getOffsetY(0) === 0
    && animator.getOffsetZ(0) === 0
    && animator.getBankingOffset(0) === 0,
    "animation end: offsets exactly 0"
);

// Formation switch: reset() clears running animations so no offset leaks
// onto a plane at a different position in the new formation.
animator.tap(3);
animator.update(400); // animation running, offsets non-zero
animator.reset();
let allZero = true;
for (let i = 0; i < 5; i++) {
    if (animator.getOffsetX(i) !== 0 || animator.getOffsetY(i) !== 0
        || animator.getOffsetZ(i) !== 0 || animator.getBankingOffset(i) !== 0) {
        allZero = false;
    }
}
check(allZero, "formation switch: reset clears all offsets");

// Right after the reset, a tap on the same index starts a fresh animation
// (the old one was not migrated).
animator.tap(3);
animator.update(400);
check(
    animator.getOffsetZ(3) !== 0,
    "formation switch: index can be tapped again immediately"
);

if (failures > 0) {
    console.error(`\n${failures} check(s) failed`);
    process.exit(1);
}
console.log("\nAll checks passed");
