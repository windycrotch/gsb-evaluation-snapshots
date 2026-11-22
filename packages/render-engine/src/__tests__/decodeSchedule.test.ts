import { describe, expect, it } from "vitest";
import type { Clip, ProjectDocument, Track } from "@cutaway/types";
import { staticValue } from "@cutaway/types";
import { createClip, createProject, createTrack } from "@cutaway/utils";
import { planVideoDecodeSchedule } from "../decodeSchedule";
import { resolveScene } from "../scene";

function videoContent(mediaId = "m1", speed = 1, sourceInFrame = 0) {
  return {
    kind: "video" as const,
    mediaId,
    sourceInFrame,
    speed,
    volume: staticValue(1),
    muted: false,
  };
}

function imageContent(mediaId = "img1") {
  return { kind: "image" as const, mediaId };
}

function projectWith(tracks: Track[], clips: Clip[]): ProjectDocument {
  const base = createProject();
  return {
    ...base,
    entities: {
      ...base.entities,
      tracks: Object.fromEntries(tracks.map((t) => [t.id, t])),
      clips: Object.fromEntries(clips.map((c) => [c.id, c])),
    },
    trackOrder: tracks.map((t) => t.id),
  };
}

/** One video clip starting at frame 0, `durationFrames` long. */
function singleVideoProject(durationFrames = 5, speed = 1): ProjectDocument {
  const track = createTrack({ kind: "video", index: 0 });
  const clip = createClip({
    trackId: track.id,
    startFrame: 0,
    durationFrames,
    content: videoContent("m1", speed),
  });
  return projectWith([track], [clip]);
}

describe("planVideoDecodeSchedule", () => {
  it("records one timestamp per frame a video is on screen", () => {
    const schedule = planVideoDecodeSchedule(singleVideoProject(5), 0, 5);

    expect([...schedule.keys()]).toEqual(["m1"]);
    expect(schedule.get("m1")).toHaveLength(5);
  });

  it("matches exactly what the render loop asks resolveScene for", () => {
    // The schedule is only useful if it mirrors the loop request-for-request;
    // this pins that contract rather than re-deriving the timing maths.
    const project = singleVideoProject(5);
    const expected: number[] = [];
    for (let frame = 0; frame < 5; frame += 1) {
      for (const node of resolveScene(project, frame).nodes) {
        if (node.content.kind === "media" && node.content.mediaKind === "video") {
          expected.push(node.content.sourceTimeSeconds);
        }
      }
    }

    expect(planVideoDecodeSchedule(project, 0, 5).get("m1")).toEqual(expected);
  });

  it("honours the export range rather than the whole timeline", () => {
    const schedule = planVideoDecodeSchedule(singleVideoProject(10), 4, 7);
    expect(schedule.get("m1")).toHaveLength(3);
  });

  it("returns timestamps in ascending order for a normal clip", () => {
    const times = planVideoDecodeSchedule(singleVideoProject(6), 0, 6).get("m1")!;
    expect([...times].sort((a, b) => a - b)).toEqual(times);
  });

  it("advances faster than realtime when the clip is sped up", () => {
    const normal = planVideoDecodeSchedule(singleVideoProject(4, 1), 0, 4).get("m1")!;
    const fast = planVideoDecodeSchedule(singleVideoProject(4, 2), 0, 4).get("m1")!;
    expect(fast[3]).toBeGreaterThan(normal[3]!);
  });

  it("ignores images — only video is decoded frame by frame", () => {
    const track = createTrack({ kind: "video", index: 0 });
    const clip = createClip({
      trackId: track.id,
      startFrame: 0,
      durationFrames: 3,
      content: imageContent("img1"),
    });

    expect(planVideoDecodeSchedule(projectWith([track], [clip]), 0, 3).size).toBe(0);
  });

  it("keeps one entry per clip when a media is used twice at once", () => {
    // Two clips of the same source overlapping means two decode requests per
    // frame; collapsing them would desynchronise the puller.
    const track = createTrack({ kind: "video", index: 0 });
    const other = createTrack({ kind: "video", index: 1 });
    const clips = [track, other].map((t) =>
      createClip({
        trackId: t.id,
        startFrame: 0,
        durationFrames: 3,
        content: videoContent("m1"),
      }),
    );

    expect(
      planVideoDecodeSchedule(projectWith([track, other], clips), 0, 3).get("m1"),
    ).toHaveLength(6);
  });

  it("tracks each media separately", () => {
    const track = createTrack({ kind: "video", index: 0 });
    const first = createClip({
      trackId: track.id,
      startFrame: 0,
      durationFrames: 2,
      content: videoContent("m1"),
    });
    const second = createClip({
      trackId: track.id,
      startFrame: 2,
      durationFrames: 3,
      content: videoContent("m2"),
    });
    const schedule = planVideoDecodeSchedule(projectWith([track], [first, second]), 0, 5);

    expect(schedule.get("m1")).toHaveLength(2);
    expect(schedule.get("m2")).toHaveLength(3);
  });

  it("never schedules a negative timestamp", () => {
    // A clip trimmed to start before its source begins would otherwise ask for
    // a time no decoder can produce.
    const track = createTrack({ kind: "video", index: 0 });
    const clip = createClip({
      trackId: track.id,
      startFrame: 0,
      durationFrames: 4,
      content: videoContent("m1", 1, -30),
    });
    const times = planVideoDecodeSchedule(projectWith([track], [clip]), 0, 4).get("m1")!;

    expect(times.every((t) => t >= 0)).toBe(true);
  });

  it("is empty for a range with no video", () => {
    expect(planVideoDecodeSchedule(createProject(), 0, 10).size).toBe(0);
  });

  /**
   * Two adjacent clips with a crossfade: the outgoing clip keeps drawing across
   * its tail `[cut, cut + tail)`, so each tail frame produces two video requests
   * (one per clip), mirroring what `resolveScene` hands the render loop.
   */
  function crossfadeProject(
    cut: number,
    tail: number,
    total: number,
    sameMedia = false,
  ): ProjectDocument {
    const track = createTrack({ kind: "video", index: 0 });
    const outgoing = createClip({
      id: "out",
      trackId: track.id,
      startFrame: 0,
      durationFrames: cut,
      content: videoContent("mA"),
    });
    const incoming = {
      ...createClip({
        id: "in",
        trackId: track.id,
        startFrame: cut,
        durationFrames: total - cut,
        content: videoContent(sameMedia ? "mA" : "mB"),
      }),
      transitionIn: { kind: "crossfade" as const, durationFrames: tail },
    };
    return projectWith([track], [outgoing, incoming]);
  }

  it("schedules the outgoing clip's tail frames past its own end", () => {
    const project = crossfadeProject(10, 4, 20);
    const schedule = planVideoDecodeSchedule(project, 0, 20);

    // mA plays frames 0..13 (its 10 own frames plus tail frames 10..13), mB
    // plays its 10 frames 10..19.
    expect(schedule.get("mA")).toHaveLength(14);
    expect(schedule.get("mB")).toHaveLength(10);
    expect([...schedule.keys()].sort()).toEqual(["mA", "mB"]);
  });

  it("schedules one request per clip when the same media is shared across a tail", () => {
    // Both clips use mA: during the four tail frames the media is needed twice
    // per frame — collapsing them would leave the puller one frame short.
    const project = crossfadeProject(10, 4, 20, true);
    const schedule = planVideoDecodeSchedule(project, 0, 20);

    // 14 outgoing requests + 10 incoming requests, all against the same media.
    expect(schedule.size).toBe(1);
    expect(schedule.get("mA")).toHaveLength(24);
  });

  it("matches resolveScene request-for-request across a transition tail", () => {
    const project = crossfadeProject(10, 4, 20);
    const expected: { mediaId: string; time: number }[] = [];
    for (let frame = 0; frame < 20; frame += 1) {
      for (const node of resolveScene(project, frame).nodes) {
        if (node.content.kind === "media" && node.content.mediaKind === "video") {
          expected.push({
            mediaId: node.content.mediaId,
            time: Math.max(0, node.content.sourceTimeSeconds),
          });
        }
      }
    }

    const flattened = [...planVideoDecodeSchedule(project, 0, 20)].flatMap(([mediaId, times]) =>
      times.map((time) => ({ mediaId, time })),
    );
    // Same multiset of (media, time) requests — the schedule never invents or
    // drops a request relative to what the loop will actually make.
    expect(flattened.sort(compareRequests)).toEqual(expected.sort(compareRequests));
  });

  it("accepts a plan-shaped frame enumeration and schedules exactly those frames", () => {
    const project = crossfadeProject(10, 4, 20);
    const frameRange = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13];

    const fromPlan = planVideoDecodeSchedule(project, { frameRange });
    const fromRange = planVideoDecodeSchedule(project, 0, 14);
    expect(fromPlan).toEqual(fromRange);
  });

  it("covers a sub-range that ends mid-tail without over- or under-scheduling", () => {
    const project = crossfadeProject(10, 4, 20);
    // [8, 12): plain frames 8,9 and tail frames 10,11.
    const schedule = planVideoDecodeSchedule(project, 8, 12);
    expect(schedule.get("mA")).toHaveLength(4); // 8,9 plus two tail requests
    expect(schedule.get("mB")).toHaveLength(2); // 10,11
  });
});

function compareRequests(
  a: { mediaId: string; time: number },
  b: { mediaId: string; time: number },
): number {
  return a.mediaId.localeCompare(b.mediaId) || a.time - b.time;
}
