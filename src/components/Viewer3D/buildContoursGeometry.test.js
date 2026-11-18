import { describe, it, expect } from "vitest";
import { buildContoursPoints } from "./buildContoursGeometry";

const bounds = { sceneWidth: 100, sceneDepth: 100 };
const scale = { verticalScale: 1 };

/** Smooth 3x3 ramp — contours exist at levels 1, 2 and 3. */
function ramp() {
  return {
    elevations: Float32Array.from([
      0, 1, 2,
      1, 2, 3,
      2, 3, 4,
    ]),
    width: 3,
    height: 3,
  };
}

describe("buildContoursPoints floodedCells", () => {
  it("keeps all segments when no flood mask is supplied", () => {
    const points = buildContoursPoints(ramp(), bounds, scale, [1, 2, 3]);
    expect(points.length).toBeGreaterThan(0);
  });

  it("drops every segment when all quads are flooded", () => {
    const dryPoints = buildContoursPoints(ramp(), bounds, scale, [1, 2, 3]);
    expect(dryPoints.length).toBeGreaterThan(0);

    const allFlooded = new Array(9).fill(true);
    const points = buildContoursPoints(
      ramp(),
      bounds,
      scale,
      [1, 2, 3],
      allFlooded,
    );
    expect(points.length).toBe(0);
  });

  it("leaves unflooded quads untouched", () => {
    const dry = new Array(9).fill(false);
    const base = buildContoursPoints(ramp(), bounds, scale, [1, 2, 3]);
    const masked = buildContoursPoints(ramp(), bounds, scale, [1, 2, 3], dry);
    expect(masked.length).toBe(base.length);
  });

  it("drops only the segments of flooded quads", () => {
    // Only the top-left quad (cells 0,1,3,4) is flooded.
    const mask = [
      true, true, false,
      true, true, false,
      false, false, false,
    ];
    const base = buildContoursPoints(ramp(), bounds, scale, [1, 2, 3]);
    const masked = buildContoursPoints(ramp(), bounds, scale, [1, 2, 3], mask);
    expect(masked.length).toBeLessThan(base.length);
    expect(masked.length).toBeGreaterThan(0);
  });

  it("tolerates a single-row heightmap", () => {
    const hm = {
      elevations: Float32Array.from([0, 1, 2]),
      width: 3,
      height: 1,
    };
    const flooded = [true, true, true];
    expect(() =>
      buildContoursPoints(hm, bounds, scale, [1], flooded),
    ).not.toThrow();
    // Degenerate (no 2D quads) => no segments.
    expect(buildContoursPoints(hm, bounds, scale, [1], flooded).length).toBe(0);
  });
});
