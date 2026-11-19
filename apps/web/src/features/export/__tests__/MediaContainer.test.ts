import { describe, expect, it } from "vitest";
import type { ExportPlan } from "@cutaway/export-engine";
import type { ResolvedVideoConfig } from "../capabilities";
import { MediaContainer } from "../MediaContainer";

const plan = {
  format: "mp4",
  resolution: { width: 640, height: 480 },
  frameRate: 30,
} as ExportPlan;

const video = {
  encoderConfig: { codec: "avc1.42001f", width: 640, height: 480 },
  muxerCodec: "avc",
  codec: "h264",
} as ResolvedVideoConfig;

describe("MediaContainer", () => {
  it("finalises into bytes on the happy path", () => {
    // WebM: finalises fine with no chunks, unlike mp4-muxer, which needs at
    // least one encoded sample to describe the track.
    const webmVideo = { ...video, muxerCodec: "V_VP9" } as ResolvedVideoConfig;
    const container = MediaContainer.create({ ...plan, format: "webm" }, webmVideo, null);
    const bytes = container.finalize();
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(bytes.length).toBeGreaterThan(0);
  });

  it("refuses to finalise once discarded", () => {
    const container = MediaContainer.create(plan, video, null);
    container.discard();
    expect(() => container.finalize()).toThrow(/discarded/);
  });

  it("discard is idempotent", () => {
    const container = MediaContainer.create(plan, video, null);
    container.discard();
    expect(() => container.discard()).not.toThrow();
    expect(() => container.finalize()).toThrow(/discarded/);
  });
});
