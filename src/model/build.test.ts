import { describe, expect, it } from "vitest";
import { strFromU8, unzipSync } from "fflate";

import {
  buildDownload,
  downloadFilename,
  exportRotation,
  type BoxDimensions,
} from "./build";

const DIMS: BoxDimensions = {
  height: 52,
  width: 80,
  depth: 60,
  radius: 6,
  wall: 2,
  bottom: 3,
};

// The clips stick out 6.5mm beyond the back face of the box
const CLIP_DEPTH = 6.5;

interface BBox {
  min: [number, number, number];
  max: [number, number, number];
}

// Extract the bounding box of the vertices stored in a 3MF blob
async function boundingBox(blob: Blob): Promise<BBox> {
  const files = unzipSync(new Uint8Array(await blob.arrayBuffer()));
  const xml = strFromU8(files["3D/3dmodel.model"]);

  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];

  const vertices = xml.matchAll(
    /<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)" \/>/g,
  );
  for (const m of vertices) {
    const p = [Number(m[1]), Number(m[2]), Number(m[3])];
    for (let i = 0; i < 3; i++) {
      min[i] = Math.min(min[i], p[i]);
      max[i] = Math.max(max[i], p[i]);
    }
  }

  return { min, max };
}

describe("exportRotation", () => {
  it("keeps the front orientation as-is", () => {
    expect(exportRotation(0)).toBe(0);
  });

  it("rotates the back orientation (CW or CCW) by 180 degrees", () => {
    expect(exportRotation(1)).toBe(180);
    expect(exportRotation(-1)).toBe(180);
  });
});

describe("downloadFilename", () => {
  it("is skapa-width-depth-height.3mf", () => {
    expect(downloadFilename(DIMS)).toBe("skapa-80-60-52.3mf");
  });
});

describe("buildDownload", () => {
  it("exports the model as-is (clips towards -Y) when at the front", async () => {
    const bbox = await boundingBox(await buildDownload(DIMS, 0));

    // The clips are on the -Y side, sticking out beyond the box
    expect(bbox.min[1]).toBeCloseTo(-DIMS.depth / 2 - CLIP_DEPTH, 3);
    expect(bbox.max[1]).toBeCloseTo(DIMS.depth / 2, 3);
    expect(bbox.min[0]).toBeCloseTo(-DIMS.width / 2, 3);
    expect(bbox.max[0]).toBeCloseTo(DIMS.width / 2, 3);
  }, 30000);

  it.each([1, -1] as const)(
    "exports the model rotated 180° around Z (clips towards +Y) when at the back (%i)",
    async (orientation) => {
      const front = await boundingBox(await buildDownload(DIMS, 0));
      const back = await boundingBox(await buildDownload(DIMS, orientation));

      // A 180° rotation around Z maps (x, y, z) to (-x, -y, z)
      for (let i = 0; i < 2; i++) {
        expect(back.min[i]).toBeCloseTo(-front.max[i], 3);
        expect(back.max[i]).toBeCloseTo(-front.min[i], 3);
      }
      expect(back.min[2]).toBeCloseTo(front.min[2], 3);
      expect(back.max[2]).toBeCloseTo(front.max[2], 3);

      // Concretely: the clips now stick out towards +Y
      expect(back.min[1]).toBeCloseTo(-DIMS.depth / 2, 3);
      expect(back.max[1]).toBeCloseTo(DIMS.depth / 2 + CLIP_DEPTH, 3);
    },
    30000,
  );
});
