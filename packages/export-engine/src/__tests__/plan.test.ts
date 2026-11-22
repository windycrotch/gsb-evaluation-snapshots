import { describe, expect, it } from "vitest";
import {
  staticValue,
  type Clip,
  type ExportSettings,
  type ProjectDocument,
  type ProjectEntities,
} from "@cutaway/types";
import {
  ExportPlanError,
  describeExport,
  frameDurationMicros,
  frameTimestampMicros,
  planExport,
  planFrameRange,
  planTransitionTails,
} from "../plan";
import { exportProgress } from "../progress";

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

  it("refuses when the only clip is hidden", () => {
    const doc = project(150);
    const clips = doc.entities.clips as Record<string, { hidden: boolean }>;
    clips.c1!.hidden = true;
    expect(() => planExport(doc, settings())).toThrow(/no clips/i);
  });

  it("refuses when the only clip sits on a hidden track", () => {
    const doc = project(150);
    const tracks = doc.entities.tracks as Record<string, { hidden: boolean }>;
    tracks.t1!.hidden = true;
    expect(() => planExport(doc, settings())).toThrow(/no clips/i);
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

/**
 * Two adjacent video clips on one track; clip B carries the transition into the
 * cut at frame `cut` with a tail of `tail` frames.
 */
function transitionProject(
  cut: number,
  tail: number,
  total: number,
  kind: "crossfade" | "dip" = "crossfade",
): ProjectDocument {
  const clips = {
    a: {
      id: "a",
      trackId: "t1",
      startFrame: 0,
      durationFrames: cut,
      hidden: false,
      transitionIn: null,
      content: { kind: "media", mediaId: "mA", mediaKind: "video" },
    },
    b: {
      id: "b",
      trackId: "t1",
      startFrame: cut,
      durationFrames: total - cut,
      hidden: false,
      transitionIn: { kind, durationFrames: tail },
      content: { kind: "media", mediaId: "mB", mediaKind: "video" },
    },
  } as unknown as ProjectEntities["clips"];

  return project(total, { clips });
}

describe("planExport — transition tails", () => {
  it("enumerates each tail window and keeps its frames inside totalFrames", () => {
    const doc = transitionProject(10, 4, 20);
    const plan = planExport(doc, settings());

    expect(plan.transitionTails).toEqual([
      {
        outgoingClipId: "a",
        incomingClipId: "b",
        startFrame: 10,
        endFrame: 14,
        durationFrames: 4,
      },
    ]);
    // Tail frames are entries of the same range, not extras bolted on top.
    expect(plan.frameRange).toEqual(Array.from({ length: 20 }, (_, i) => i));
    expect(plan.totalFrames).toBe(20);
    expect(plan.durationSeconds).toBeCloseTo(20 / 30);
    expect(planFrameRange(plan.startFrame, plan.endFrame)).toEqual(plan.frameRange);
  });

  it("plans dip-to-black transitions as tails as well as crossfades", () => {
    const plan = planExport(transitionProject(10, 6, 20, "dip"), settings());
    expect(plan.transitionTails).toEqual([
      {
        outgoingClipId: "a",
        incomingClipId: "b",
        startFrame: 10,
        endFrame: 16,
        durationFrames: 6,
      },
    ]);
  });

  it("clips the tail window to an exported sub-range", () => {
    const plan = planExport(
      transitionProject(10, 4, 20),
      settings({
        range: { start: 8, end: 12 },
      }),
    );

    expect(plan.transitionTails).toEqual([
      {
        outgoingClipId: "a",
        incomingClipId: "b",
        startFrame: 10,
        endFrame: 12,
        durationFrames: 2,
      },
    ]);
    expect(plan.totalFrames).toBe(4);
    expect(plan.frameRange).toEqual([8, 9, 10, 11]);
  });

  it("exposes no tail when the whole transition lies outside the range", () => {
    // Range ends exactly at the cut: none of the [10,14) tail is included.
    const plan = planExport(
      transitionProject(10, 4, 20),
      settings({
        range: { start: 4, end: 10 },
      }),
    );
    expect(plan.transitionTails).toEqual([]);
    expect(plan.totalFrames).toBe(6);
  });

  it("does not invent a tail across a gap", () => {
    const doc = transitionProject(10, 4, 20);
    (doc.entities.clips.b as Clip).startFrame = 12; // two-frame gap, not an exact cut
    expect(planTransitionTails(doc, 0, 20)).toEqual([]);
    expect(planExport(doc, settings()).transitionTails).toEqual([]);
  });

  it("does not plan tails for hidden clips or hidden tracks", () => {
    const hiddenClip = transitionProject(10, 4, 20);
    (hiddenClip.entities.clips.b as Clip).hidden = true;
    expect(planExport(hiddenClip, settings()).transitionTails).toEqual([]);

    const hiddenTrack = transitionProject(10, 4, 20);
    hiddenTrack.entities.tracks.t1!.hidden = true;
    // A hidden video track means nothing visible remains in range at all.
    expect(() => planExport(hiddenTrack, settings())).toThrow(ExportPlanError);
  });

  it("ignores transitions that involve audio clips, which never draw a tail", () => {
    const doc = transitionProject(10, 4, 20);
    // The UI forbids this combination, but a hand-edited document may contain it.
    (doc.entities.clips.b as Clip).content = {
      kind: "audio",
      mediaId: "aB",
      sourceInFrame: 0,
      speed: 1,
      volume: staticValue(1),
      muted: false,
      fadeInFrames: 0,
      fadeOutFrames: 0,
    };
    expect(planTransitionTails(doc, 0, 20)).toEqual([]);
  });

  it("counts several tails independently when multiple cuts have transitions", () => {
    const doc = transitionProject(10, 4, 30);
    const c = {
      id: "c",
      trackId: "t1",
      startFrame: 20,
      durationFrames: 10,
      hidden: false,
      transitionIn: { kind: "crossfade", durationFrames: 2 },
      content: { kind: "media", mediaId: "mC", mediaKind: "video" },
    } as unknown as Clip;
    // Clip B must end exactly at 20 for the second exact cut.
    (doc.entities.clips.b as Clip).durationFrames = 10;
    doc.entities.clips.c = c;

    const tails = planTransitionTails(doc, 0, 30);
    expect(tails.map((t) => [t.outgoingClipId, t.incomingClipId, t.durationFrames])).toEqual([
      ["a", "b", 4],
      ["b", "c", 2],
    ]);
    expect(planExport(doc, settings()).totalFrames).toBe(30);
  });

  it("catches a denominator that forgets the tail (negative check)", () => {
    const plan = planExport(transitionProject(10, 4, 20), settings());
    const tailFrames = plan.transitionTails.reduce((sum, tail) => sum + tail.durationFrames, 0);
    expect(tailFrames).toBe(4);

    // The old bug shape: totalFrames counts only the non-tail frames. Against
    // the frame list the loop actually renders it is visibly wrong, and the
    // derived progress hits ratio 1 while four frames remain unrendered.
    const buggyTotal = plan.totalFrames - tailFrames;
    expect(buggyTotal).not.toBe(plan.frameRange.length);
    expect(exportProgress("rendering", buggyTotal, buggyTotal).ratio).toBe(1);
    expect(buggyTotal).toBeLessThan(plan.frameRange.length);

    // The real denominator only reaches 1 on the final frame.
    expect(exportProgress("rendering", plan.totalFrames, plan.totalFrames).ratio).toBe(1);
    expect(exportProgress("rendering", buggyTotal, plan.totalFrames).ratio).toBeLessThan(1);
  });

  it("baseline: a project without transitions keeps the existing frame count and timing", () => {
    const plan = planExport(project(150), settings());
    expect(plan.transitionTails).toEqual([]);
    expect(plan.totalFrames).toBe(150);
    expect(plan.frameRange).toHaveLength(150);
    expect(plan.durationSeconds).toBeCloseTo(5);
    expect(frameTimestampMicros(plan, 0)).toBe(0);
    expect(frameTimestampMicros(plan, 30)).toBe(1_000_000);
    expect(frameDurationMicros(plan)).toBe(Math.round(1_000_000 / 30));
  });
});
