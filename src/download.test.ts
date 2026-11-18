import { describe, expect, it } from "vitest";

import { DownloadManager, type DownloadUpdate } from "./download";
import {
  downloadFilename,
  type BoxDimensions,
  type Orientation,
} from "./model/build";

const DIMS_A: BoxDimensions = {
  height: 52,
  width: 80,
  depth: 60,
  radius: 6,
  wall: 2,
  bottom: 3,
};
const DIMS_B: BoxDimensions = { ...DIMS_A, width: 100 };
const DIMS_C: BoxDimensions = { ...DIMS_A, width: 120, depth: 70 };

interface BuildCall {
  dims: BoxDimensions;
  orientation: Orientation;
}

// A DownloadManager with a fake (instant, record-keeping) build function
function setup(initial: BoxDimensions = DIMS_A) {
  const builds: BuildCall[] = [];
  const updates: DownloadUpdate[] = [];

  const manager = new DownloadManager(
    initial,
    async (dims, orientation) => {
      builds.push({ dims, orientation });
      return new Blob([JSON.stringify({ dims, orientation })]);
    },
    downloadFilename,
    (update) => updates.push(update),
  );

  return { builds, updates, manager };
}

// Let pending promises (builds) resolve
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

async function payload(
  update: DownloadUpdate,
): Promise<{ dims: BoxDimensions; orientation: Orientation }> {
  return JSON.parse(await update.blob.text());
}

describe("DownloadManager", () => {
  it("exports the front orientation when the part rests at the front", async () => {
    const { updates, manager } = setup();

    manager.setDimensions(DIMS_A);
    await flush();

    expect(updates).toHaveLength(1);
    expect(updates[0].filename).toBe("skapa-80-60-52.3mf");
    expect((await payload(updates[0])).orientation).toBe(0);
  });

  it("exports the back orientation once the part settles at the back", async () => {
    const { updates, manager } = setup();

    manager.setDimensions(DIMS_A);
    await flush();
    expect(updates).toHaveLength(1);

    // The part snaps to the back and the rotation animation runs
    manager.setOrientation(1);
    manager.setRotating(true);
    await flush();

    // No update while the animation is running
    expect(updates).toHaveLength(1);

    // The animation settles: the download is regenerated for the back
    manager.setRotating(false);
    await flush();

    expect(updates).toHaveLength(2);
    expect(updates[1].filename).toBe("skapa-80-60-52.3mf");
    expect((await payload(updates[1])).orientation).toBe(1);
  });

  it("does not update the download while a rotation animation is running", async () => {
    const { updates, manager } = setup();

    manager.setDimensions(DIMS_A);
    await flush();
    expect(updates).toHaveLength(1);

    // Dimensions change mid-rotation: no update, no build
    manager.setRotating(true);
    manager.setDimensions(DIMS_B);
    await flush();
    expect(updates).toHaveLength(1);

    // Once settled, a single update with the last committed dimensions
    manager.setRotating(false);
    await flush();
    expect(updates).toHaveLength(2);
    expect(updates[1].filename).toBe("skapa-100-60-52.3mf");
    expect((await payload(updates[1])).dims.width).toBe(100);
  });

  it("does not deliver a build that finishes mid-rotation", async () => {
    const { updates, manager } = setup();

    manager.setDimensions(DIMS_A);
    await flush();
    expect(updates).toHaveLength(1);

    // A build is requested, but a rotation starts before it finishes
    manager.setDimensions(DIMS_B);
    manager.setRotating(true);
    await flush();

    // The finished build is discarded rather than delivered mid-rotation
    expect(updates).toHaveLength(1);

    // It is regenerated once the part settles
    manager.setRotating(false);
    await flush();
    expect(updates).toHaveLength(2);
    expect(updates[1].filename).toBe("skapa-100-60-52.3mf");
  });

  it("still exports the back orientation after a dimension change at the back", async () => {
    const { updates, manager } = setup();

    // Settle at the back
    manager.setOrientation(1);
    manager.setRotating(true);
    manager.setRotating(false);
    await flush();
    expect(updates).toHaveLength(1);
    expect((await payload(updates[0])).orientation).toBe(1);

    // Rapid successive dimension changes, then stop
    manager.setDimensions(DIMS_B);
    manager.setDimensions(DIMS_C);
    await flush();

    // The final download matches the last committed dimensions, still
    // exported with the back orientation
    const last = updates[updates.length - 1];
    expect(last.filename).toBe("skapa-120-70-52.3mf");
    const p = await payload(last);
    expect(p.orientation).toBe(1);
    expect(p.dims.width).toBe(120);
    expect(p.dims.depth).toBe(70);

    // No delivered update carries the stale intermediate dimensions
    for (const update of updates) {
      expect((await payload(update)).dims.width).not.toBe(100);
    }
  });
});
