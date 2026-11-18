import { describe, expect, it } from "vitest";
import type { ExportSettings, ProjectDocument, ProjectEntities } from "@cutaway/types";
import {
  ExportPlanError,
  describeExport,
  frameDurationMicros,
  frameTimestampMicros,
  planExport,
} from "../plan";

const settings = (over: Partial<ExportSettings> = {}): ExportSettings => ({
  format: "mp4",
  resolution: { width: 1920, height: 1080 },
  frameRate: 30,
  videoBitrate: 8_000_000,
  audioBitrate: 192_000,
  videoCodec: "h264",
  audioCodec: "aac",
  range: null,
  ...over,
});

/**
 * A project with one visible video clip spanning the whole timeline — the
 * ordinary case. `planExport` inspects clips to reject empty renders, so a
 * bare `{ durationFrames }` stub is no longer a valid document.
 */
const project = (durationFrames: number, over: Partial<ProjectEntities> = {}): ProjectDocument =>
  ({
    durationFrames,
    entities: {
      clips: {
        c1: {
          id: "c1",
          trackId: "t1",
          startFrame: 0,
          durationFrames,
          hidden: false,
          content: { kind: "media", mediaId: "m1", mediaKind: "video" },
        },
      },
      tracks: { t1: { id: "t1", kind: "video", hidden: false } },
      captionTracks: {},
      ...over,
    },
  }) as unknown as ProjectDocument;

/** A project whose timeline is empty — nothing to render at any frame. */
const emptyProject = (durationFrames: number): ProjectDocument =>
  project(durationFrames, { clips: {} });

describe("planExport — empty renders", () => {
  it("refuses a range with no clips at all rather than rendering a blank file", () => {
    expect(() => planExport(emptyProject(150), settings())).toThrow(ExportPlanError);
    expect(() => planExport(emptyProject(150), settings())).toThrow(/no clips/i);
  });

  it("refuses a sub-range that falls entirely outside every clip", () => {
    // One clip covering 0..50, exporting 100..150 — geometrically valid, empty.
    const doc = project(50);
    (doc as unknown as { durationFrames: number }).durationFrames = 200;
    expect(() => planExport(doc, settings({ range: { start: 100, end: 150 } }))).toThrow(
      /no clips/i,
    );
  });

  it("refuses when the only clip is hidden, and says it is hidden", () => {
    const doc = project(150);
    const clips = doc.entities.clips as Record<string, { hidden: boolean }>;
    clips.c1!.hidden = true;
    expect(() => planExport(doc, settings())).toThrow(ExportPlanError);
    expect(() => planExport(doc, settings())).toThrow(/hidden/i);
  });

  it("refuses when the only clip sits on a hidden track, and says it is hidden", () => {
    const doc = project(150);
    const tracks = doc.entities.tracks as Record<string, { hidden: boolean }>;
    tracks.t1!.hidden = true;
    expect(() => planExport(doc, settings())).toThrow(ExportPlanError);
    expect(() => planExport(doc, settings())).toThrow(/hidden/i);
  });

  it("allows an audio-only range but warns that the picture will be black", () => {
    const doc = project(150, {
      clips: {
        a1: {
          id: "a1",
          trackId: "t1",
          startFrame: 0,
          durationFrames: 150,
          hidden: false,
          content: { kind: "audio", mediaId: "m1" },
        },
      } as never,
    });
    const plan = planExport(doc, settings());
    expect(plan.warnings).toHaveLength(1);
    expect(plan.warnings[0]).toMatch(/black/i);
  });

  it("allows a caption-only range — captions draw something", () => {
    const doc = project(150, {
      clips: {},
      captionTracks: {
        ct1: { blocks: [{ startFrame: 10, endFrame: 40 }] },
      } as never,
    });
    expect(() => planExport(doc, settings())).not.toThrow();
  });

  it("reports no warnings for an ordinary export with visible clips", () => {
    expect(planExport(project(150), settings()).warnings).toEqual([]);
  });
});

describe("planExport — content summary", () => {
  it("counts the visible content of an ordinary range", () => {
    const doc = project(150, {
      clips: {
        v1: {
          id: "v1",
          trackId: "t1",
          startFrame: 0,
          durationFrames: 60,
          hidden: false,
          content: { kind: "media", mediaId: "m1", mediaKind: "video" },
        },
        v2: {
          id: "v2",
          trackId: "t1",
          startFrame: 60,
          durationFrames: 90,
          hidden: false,
          content: { kind: "media", mediaId: "m1", mediaKind: "video" },
        },
        a1: {
          id: "a1",
          trackId: "a1-track",
          startFrame: 0,
          durationFrames: 150,
          hidden: false,
          content: { kind: "audio", mediaId: "m1" },
        },
      } as never,
      tracks: {
        t1: { id: "t1", kind: "video", hidden: false },
        "a1-track": { id: "a1-track", kind: "audio", hidden: false },
      } as never,
      captionTracks: {
        ct1: {
          blocks: [
            { startFrame: 10, endFrame: 20 },
            { startFrame: 40, endFrame: 50 },
            { startFrame: 140, endFrame: 160 }, // straddles the end, still overlaps
          ],
        },
      } as never,
    });
    const plan = planExport(doc, settings());
    expect(plan.contentSummary).toEqual({
      visual: 2,
      audio: 1,
      captions: 3,
      warnings: [],
    });
    expect(plan.warnings).toEqual([]);
  });

  it("treats the range as half-open [start, end) at both ends", () => {
    // A background clip covers everything, so the range never goes empty; clip
    // c1 occupies exactly [50, 100) and should only add to the count when the
    // range actually includes a frame it occupies.
    const doc = project(100, {
      clips: {
        bg: {
          id: "bg",
          trackId: "t2",
          startFrame: 0,
          durationFrames: 200,
          hidden: false,
          content: { kind: "media", mediaId: "m1", mediaKind: "video" },
        },
        c1: {
          id: "c1",
          trackId: "t1",
          startFrame: 50,
          durationFrames: 50,
          hidden: false,
          content: { kind: "media", mediaId: "m1", mediaKind: "video" },
        },
      } as never,
      tracks: {
        t1: { id: "t1", kind: "video", hidden: false },
        t2: { id: "t2", kind: "video", hidden: false },
      } as never,
    });
    (doc as unknown as { durationFrames: number }).durationFrames = 200;

    // Ending exactly at c1's start excludes it.
    const before = planExport(doc, settings({ range: { start: 0, end: 50 } }));
    expect(before.contentSummary.visual).toBe(1); // background only

    // Starting exactly at c1's end excludes it too.
    const after = planExport(doc, settings({ range: { start: 100, end: 150 } }));
    expect(after.contentSummary.visual).toBe(1);

    // But its first frame is included.
    const touching = planExport(doc, settings({ range: { start: 50, end: 51 } }));
    expect(touching.contentSummary.visual).toBe(2);
  });

  it("excludes hidden clips and hidden-track clips from the counts", () => {
    const doc = project(150, {
      clips: {
        visible: {
          id: "visible",
          trackId: "t1",
          startFrame: 0,
          durationFrames: 150,
          hidden: false,
          content: { kind: "media", mediaId: "m1", mediaKind: "video" },
        },
        hiddenClip: {
          id: "hiddenClip",
          trackId: "t1",
          startFrame: 0,
          durationFrames: 150,
          hidden: true,
          content: { kind: "media", mediaId: "m1", mediaKind: "video" },
        },
        onHiddenTrack: {
          id: "onHiddenTrack",
          trackId: "t2",
          startFrame: 0,
          durationFrames: 150,
          hidden: false,
          content: { kind: "media", mediaId: "m1", mediaKind: "video" },
        },
      } as never,
      tracks: {
        t1: { id: "t1", kind: "video", hidden: false },
        t2: { id: "t2", kind: "video", hidden: true },
      } as never,
    });
    expect(planExport(doc, settings()).contentSummary.visual).toBe(1);
  });

  it("counts a range that only covers a transition tail as content", () => {
    // Clip A ends at 50; the next clip B starts exactly at 50 with a 10-frame
    // transitionIn, so the renderer keeps drawing A out to frame 60. B itself is
    // hidden here, leaving A's fade-out tail as the only thing in frames 52..58
    // — which must not be mistaken for an empty range.
    const doc = project(200, {
      clips: {
        a: {
          id: "a",
          trackId: "t1",
          startFrame: 0,
          durationFrames: 50,
          hidden: false,
          transitionIn: null,
          content: { kind: "media", mediaId: "m1", mediaKind: "video" },
        },
        b: {
          id: "b",
          trackId: "t1",
          startFrame: 50,
          durationFrames: 150,
          hidden: true,
          transitionIn: { kind: "crossfade", durationFrames: 10 },
          content: { kind: "media", mediaId: "m2", mediaKind: "video" },
        },
      } as never,
    });
    const plan = planExport(doc, settings({ range: { start: 52, end: 58 } }));
    expect(plan.contentSummary.visual).toBe(1);
    expect(plan.startFrame).toBe(52);
    expect(plan.endFrame).toBe(58);
  });

  it("counts both sides of a live crossfade", () => {
    // A ends at 50 and B starts exactly there with a 10-frame crossfade, so
    // frames 50..59 draw both. The range sits inside the overlap.
    const doc = project(200, {
      clips: {
        a: {
          id: "a",
          trackId: "t1",
          startFrame: 0,
          durationFrames: 50,
          hidden: false,
          transitionIn: null,
          content: { kind: "media", mediaId: "m1", mediaKind: "video" },
        },
        b: {
          id: "b",
          trackId: "t1",
          startFrame: 50,
          durationFrames: 150,
          hidden: false,
          transitionIn: { kind: "crossfade", durationFrames: 10 },
          content: { kind: "media", mediaId: "m2", mediaKind: "video" },
        },
      } as never,
    });
    const plan = planExport(doc, settings({ range: { start: 52, end: 58 } }));
    expect(plan.contentSummary.visual).toBe(2);
  });

  it("does not extend a clip's tail when the next clip is not an exact cut", () => {
    // A ends at 50, B starts at 55 with a fade-in — a gap, so there is nothing
    // to crossfade into. Frames 52..58 contain nothing renderable.
    const doc = project(200, {
      clips: {
        a: {
          id: "a",
          trackId: "t1",
          startFrame: 0,
          durationFrames: 50,
          hidden: false,
          transitionIn: null,
          content: { kind: "media", mediaId: "m1", mediaKind: "video" },
        },
        b: {
          id: "b",
          trackId: "t1",
          startFrame: 55,
          durationFrames: 145,
          hidden: false,
          transitionIn: { kind: "crossfade", durationFrames: 10 },
          content: { kind: "media", mediaId: "m1", mediaKind: "video" },
        },
      } as never,
    });
    expect(() => planExport(doc, settings({ range: { start: 50, end: 55 } }))).toThrow(/no clips/i);
  });

  it("reports an empty range on a hidden track as hidden, not as having no clips", () => {
    const doc = project(150, {
      clips: {
        v1: {
          id: "v1",
          trackId: "t1",
          startFrame: 0,
          durationFrames: 150,
          hidden: false,
          content: { kind: "media", mediaId: "m1", mediaKind: "video" },
        },
      } as never,
      tracks: { t1: { id: "t1", kind: "video", hidden: true } } as never,
    });
    expect(() => planExport(doc, settings())).toThrow(ExportPlanError);
    expect(() => planExport(doc, settings())).toThrow(/hidden/i);
    expect(() => planExport(doc, settings())).not.toThrow(/no clips/i);
  });

  it("reports an empty range as having no clips when nothing is hidden", () => {
    const doc = emptyProject(150);
    expect(() => planExport(doc, settings())).toThrow(/no clips/i);
    expect(() => planExport(doc, settings())).not.toThrow(/hidden/i);
  });
});

describe("planExport", () => {
  it("plans the full timeline when no range is set", () => {
    const plan = planExport(project(150), settings());
    expect(plan.startFrame).toBe(0);
    expect(plan.endFrame).toBe(150);
    expect(plan.totalFrames).toBe(150);
    expect(plan.durationSeconds).toBeCloseTo(5);
  });

  it("honours an explicit range", () => {
    const plan = planExport(project(300), settings({ range: { start: 30, end: 90 } }));
    expect(plan.totalFrames).toBe(60);
    expect(plan.durationSeconds).toBeCloseTo(2);
  });

  it("rejects an empty timeline", () => {
    expect(() => planExport(project(0), settings())).toThrow(ExportPlanError);
  });

  it("rejects a zero-length or inverted range", () => {
    expect(() => planExport(project(300), settings({ range: { start: 50, end: 50 } }))).toThrow(
      ExportPlanError,
    );
    expect(() => planExport(project(300), settings({ range: { start: 90, end: 30 } }))).toThrow(
      ExportPlanError,
    );
  });

  it("rejects odd dimensions that codecs cannot encode", () => {
    expect(() =>
      planExport(project(30), settings({ resolution: { width: 1921, height: 1080 } })),
    ).toThrow(/even/);
  });

  it("rejects a non-positive frame rate", () => {
    expect(() => planExport(project(30), settings({ frameRate: 0 }))).toThrow(ExportPlanError);
  });

  it("carries codec and bitrate settings into the plan", () => {
    const plan = planExport(project(30), settings({ videoCodec: "vp9", videoBitrate: 12_000_000 }));
    expect(plan.videoCodec).toBe("vp9");
    expect(plan.videoBitrate).toBe(12_000_000);
  });
});

describe("frame timing", () => {
  it("derives timestamps from the index so they never drift", () => {
    const plan = planExport(project(90), settings({ frameRate: 30 }));
    expect(frameTimestampMicros(plan, 0)).toBe(0);
    expect(frameTimestampMicros(plan, 30)).toBe(1_000_000);
    expect(frameTimestampMicros(plan, 90)).toBe(3_000_000);
  });

  it("computes a nominal frame duration", () => {
    const plan = planExport(project(90), settings({ frameRate: 25 }));
    expect(frameDurationMicros(plan)).toBe(40_000);
  });
});

describe("describeExport", () => {
  it("summarises size, rate, duration, and frame count", () => {
    const plan = planExport(project(150), settings());
    expect(describeExport(plan)).toBe("1920×1080 · 30 fps · 0:05 · 150 frames");
  });
});
