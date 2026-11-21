// Auto vertical reframing, end to end at the pure-function level: the shot
// advice the model gives is checked, the clip is cut into frame-aligned
// pieces that sum to its length, each piece carries its own crop or stacked
// views, and the captions the preview and the export both draw stay whole
// across every composition switch.
//
// The seven paths these tests pin down are the ones an editor worries about:
//   1. a normal multi-shot reframe;
//   2. advice on the whole video's clock and advice counted from the stretch;
//   3. a shot boundary that lands inside a transition;
//   4. a crop that would spill out of the source;
//   5. captions cut in two by a composition switch;
//   6. reframing the same clip twice;
//   7. a failed reframe leaving the original clip editable.

import { describe, expect, it } from "vitest";
import { focusCrop, framedPieces, normalizeShots, type Shot } from "../src/shared/reframe";
import { MIN_CROP } from "../src/shared/crop";
import { captionRuns, captionTimeline, type PlacedClip } from "../src/shared/captions";
import { layOut } from "../src/shared/transition";
import { splitClip } from "../src/shared/split";
import { addFormat, formatView, liftView } from "../src/shared/formats";
import { validateEdl, type Edl } from "../src/server/edl";
import { frameTargets, applyFraming, type FrameTarget } from "../src/server/clips";
import type { Cue } from "../src/shared/transcript";

const HD = { width: 1920, height: 1080 };
const region = { x: 0.3, y: 0.2, width: 0.1, height: 0.5 };
const other = { x: 0.62, y: 0.2, width: 0.1, height: 0.5 };

/** A shot exactly as the model writes one: clocks as strings, untrusted. */
const advice = (from: string, to: string, layout = "speaker", subjects = [{ label: "speaker", region }], confidence = "high") => ({
  from,
  to,
  layout,
  confidence,
  reason: "speaker visible",
  subjects,
});

const shotsOf = (raw: unknown, start: number, end: number, shape = HD) => normalizeShots({ shots: raw }, start, end, shape);

const idFactory = () => {
  let n = 0;
  return () => `piece-${n++}`;
};

/** A 16:9 cut with one middle interview clip, a transition into it and one out. */
function interview(): Edl {
  return {
    version: 1,
    output: { width: 1280, height: 720, fps: 30 },
    main: {
      elements: [
        { id: "intro", type: "video", src: "asset:b", duration: 4 },
        { id: "talk", type: "video", src: "asset:a", trimStart: 120, duration: 10, transition: { type: "dissolve", duration: 1 }, fadeIn: 0.3, fadeOut: 0.4 },
        { id: "outro", type: "video", src: "asset:c", duration: 4, transition: { type: "wipe-left", duration: 0.5 } },
      ],
    },
    overlays: [],
    audio: [],
  };
}

/** The reframe as the editor's Apply does it: edit the 9:16 view, lift it back. */
function applyToView(doc: Edl, index: number, shots: Shot[], id: () => string): Edl {
  const tall = addFormat(doc, "9:16");
  expect(tall.formats).toHaveLength(1);
  const view = formatView(tall, "9:16");
  const clip = view.main.elements[index] as { id: string; duration?: number };
  const pieces = framedPieces(clip, clip.duration!, view.output.fps, shots, id);
  view.main.elements.splice(index, 1, ...pieces);
  return liftView(tall, view, "9:16");
}

/** Whole output frames the main track covers, as the export lays it out. */
const framesOf = (edl: Edl) => edl.main.elements.reduce((n, el) => n + Math.round(("duration" in el && el.duration ? el.duration : 0) * edl.output.fps), 0);

const timelineOf = (edl: Edl) =>
  layOut(
    edl.main.elements.map((el) => ("duration" in el && el.duration ? el.duration : 0)),
    edl.main.elements.map((el) => el.transition),
    edl.output.fps,
  );

const segment = (edl: Edl, id: string) => edl.main.elements.find((el) => el.id === id)!;

describe("a normal multi-shot reframe", () => {
  it("cuts on shot boundaries, keeps every piece's framing, and never changes the cut's length", () => {
    const shots = shotsOf([
      advice("0:02:00", "0:02:04", "speaker", [{ label: "wide", region: { x: 0.1, y: 0.05, width: 0.8, height: 0.9 } }]),
      advice("0:02:04", "0:02:06", "speaker", [{ label: "guest", region }]),
      advice("0:02:06", "0:02:10", "split", [{ label: "host", region: other }, { label: "guest", region }]),
    ], 120, 130);
    // The first is a wide shot: a portrait crop cannot hold it, so it stays whole.
    expect(shots.map((s) => s.layout)).toEqual(["whole", "speaker", "split"]);

    const before = interview();
    const after = applyToView(before, 1, shots, idFactory());
    expect(validateEdl(after)).toHaveProperty("edl");
    expect(framesOf(after)).toBe(framesOf(before));
    expect(timelineOf(after).total).toBe(timelineOf(before).total);

    const talk = after.main.elements.filter((el) => el.src === "asset:a");
    expect(talk).toHaveLength(3);
    expect(talk.reduce((n, el) => n + el.duration!, 0)).toBeCloseTo(10, 6);
    // The pieces run one into the next, a beat at 4 s and 6 s.
    expect(talk.map((el) => el.trimStart)).toEqual([120, 124, 126]);
    expect(talk.map((el) => el.duration)).toEqual([4, 2, 4]);
    // Framing rides on the format, not the shared cut.
    const framed = talk.map((el) => (el as { framing?: Record<string, unknown> }).framing?.["9:16"]);
    expect(framed[0]).toBeUndefined();
    expect(framed[1]).toMatchObject({ fit: "cover" });
    expect(framed[2]).toMatchObject({ split: { top: expect.any(Object), bottom: expect.any(Object) } });
    // 16:9 keeps the clip as it was.
    expect(before.main.elements[1]).toMatchObject({ id: "talk", trimStart: 120, duration: 10 });
  });

  it("puts the transition on the first piece only, and the outer fades on the outer pieces", () => {
    const shots = shotsOf([advice("0:02:00", "0:02:02"), advice("0:02:02", "0:02:05"), advice("0:02:05", "0:02:10")], 120, 130);
    const after = applyToView(interview(), 1, shots, idFactory());
    const talk = after.main.elements.filter((el) => el.src === "asset:a");
    expect(talk.map((el) => el.transition?.type ?? null)).toEqual(["dissolve", null, null]);
    expect(talk.map((el) => el.fadeIn ?? null)).toEqual([0.3, null, null]);
    expect(talk.map((el) => el.fadeOut ?? null)).toEqual([null, null, 0.4]);
  });
});

describe("whole-video clocks and stretch-relative clocks", () => {
  it("reads an answer on the whole video's clock", () => {
    const shots = shotsOf([advice("0:08:30", "0:08:37"), advice("0:08:37", "0:08:44")], 510, 524);
    expect(shots.map((s) => [s.from, s.to])).toEqual([[510, 517], [517, 524]]);
  });

  it("moves a whole answer counted from the stretch onto the video's clock", () => {
    const shots = shotsOf([advice("0:00:00", "0:00:06"), advice("0:00:06", "0:00:14")], 510, 524);
    expect(shots.map((s) => [s.from, s.to])).toEqual([[510, 516], [516, 524]]);
  });

  it("keeps a mixed answer's absolute shots and never shifts the rest by accident", () => {
    // One shot on the whole clock, one counted from the stretch: the mixed
    // answer is not a relative one, so the relative shot is out of range and
    // is dropped; the hole it leaves is kept whole and marked for review, not
    // silently cut away.
    const shots = shotsOf([advice("0:00:00", "0:00:06"), advice("0:08:36", "0:08:44")], 510, 524);
    expect(shots.map((s) => [s.from, s.to, s.layout, s.review])).toEqual([
      [510, 516, "whole", true],
      [516, 524, "speaker", false],
    ]);
    // Applied to the clip that runs 510..524, the section with no reliable
    // answer keeps the whole picture; the shot with one is framed.
    const doc = interview();
    doc.main.elements[1] = { id: "talk", type: "video", src: "asset:a", trimStart: 510, duration: 14, transition: { type: "dissolve", duration: 1 } };
    const after = applyToView(doc, 1, shots, idFactory());
    const talk = after.main.elements.filter((el) => el.src === "asset:a");
    expect(talk).toHaveLength(2);
    expect((talk[0] as { framing?: Record<string, unknown> }).framing?.["9:16"]).toBeUndefined();
    expect((talk[1] as { framing?: Record<string, unknown> }).framing?.["9:16"]).toMatchObject({ fit: "cover" });
    expect(framesOf(after)).toBe(framesOf(doc));
  });
});

describe("a boundary that lands inside a transition", () => {
  it("gives the transition to exactly one piece and never duplicates or drops a frame", () => {
    // The dissolve into `talk` is 1 s, centred: 0.5 s of it plays on `talk`.
    // A shot boundary 0.2 s in falls inside that half.
    const shots = shotsOf([advice("0:02:00", "0:02:00.2"), advice("0:02:00.2", "0:02:10")], 120, 130);
    const before = interview();
    const after = applyToView(before, 1, shots, idFactory());
    expect(validateEdl(after)).toHaveProperty("edl");
    const talk = after.main.elements.filter((el) => el.src === "asset:a");
    expect(talk).toHaveLength(2);
    // The transition sits on the piece it comes into, once.
    expect(talk.filter((el) => el.transition).map((el) => el.transition!.type)).toEqual(["dissolve"]);
    // Its first piece is only 0.2 s; the export shortens the dissolve to fit
    // rather than overlapping the next cut, and the timeline keeps its length.
    const beforeLayout = timelineOf(before).placed;
    const afterLayout = timelineOf(after).placed;
    expect(timelineOf(after).total).toBeCloseTo(timelineOf(before).total, 6);
    // Every clip still starts on its own frame count: no frame repeats, none vanishes.
    const starts = (placed: { start: number }[]) => placed.map((p) => p.start);
    expect(starts(afterLayout).slice(0, 2)).toEqual([0, beforeLayout[0].dur]);
    expect(framesOf(after)).toBe(framesOf(before));
  });

  it("keeps a boundary that lands exactly on the transition's edge inside one piece", () => {
    // The dissolve is 1 s; a cut at 0.5 s is exactly where its after-half ends.
    const shots = shotsOf([advice("0:02:00", "0:02:00.5"), advice("0:02:00.5", "0:02:10", "split", [{ label: "host", region: other }, { label: "guest", region }])], 120, 130);
    const after = applyToView(interview(), 1, shots, idFactory());
    const talk = after.main.elements.filter((el) => el.src === "asset:a");
    expect(talk).toHaveLength(2);
    expect(talk[0].transition?.duration).toBe(1);
    // The second piece is the stacked pair; the first is the speaker crop.
    expect((talk[1] as { framing?: Record<string, { split?: unknown }> }).framing?.["9:16"]?.split).toBeTruthy();
    expect(framesOf(after)).toBe(framesOf(interview()));
  });
});

describe("crops that would spill out of the source", () => {
  it("keeps whole when a subject's portrait crop cannot be contained", () => {
    const wide = { label: "wide", region: { x: 0.1, y: 0.05, width: 0.85, height: 0.9 } };
    const shots = shotsOf([advice("0:02:00", "0:02:10", "speaker", [wide])], 120, 130);
    expect(shots[0].layout).toBe("whole");
    expect(shots[0].review).toBe(true);
    // And it is never marked as cropped on the timeline.
    const after = applyToView(interview(), 1, shots, idFactory());
    const talk = after.main.elements.filter((el) => el.src === "asset:a");
    expect((talk[0] as { framing?: Record<string, unknown> }).framing?.["9:16"]).toBeUndefined();
  });

  it("drops a subject wholly or partly off the source and keeps whole", () => {
    for (const regionOff of [
      { x: 0.95, y: 0.2, width: 0.2, height: 0.3 }, // spills right
      { x: -0.1, y: 0.2, width: 0.3, height: 0.3 }, // spills left
      { x: 0.3, y: 0.85, width: 0.2, height: 0.3 }, // spills bottom
    ]) {
      const shots = shotsOf([advice("0:02:00", "0:02:10", "speaker", [{ label: "x", region: regionOff }])], 120, 130);
      expect(shots[0].layout).toBe("whole");
      expect(shots[0].review).toBe(true);
    }
  });

  it("keeps whole when one half of a stacked pair is illegal", () => {
    const shots = shotsOf([advice("0:02:00", "0:02:10", "split", [{ label: "guest", region }, { label: "wide", region: { x: 0.05, y: 0.05, width: 0.9, height: 0.9 } }])], 120, 130);
    expect(shots[0].layout).toBe("whole");
    expect(shots[0].review).toBe(true);
    // Applying it leaves the picture whole, so neither half is drawn wrong.
    const after = applyToView(interview(), 1, shots, idFactory());
    const talk = after.main.elements.filter((el) => el.src === "asset:a");
    expect((talk[0] as { framing?: Record<string, unknown> }).framing?.["9:16"]).toBeUndefined();
  });

  it("never suggests a crop below the service's floor", () => {
    // A tiny subject would frame tighter than MIN_CROP on one side.
    for (const w of [0.01, 0.02, 0.03, 0.04]) {
      const tiny = { x: 0.5, y: 0.5, width: w, height: w };
      const crop = focusCrop(tiny, HD, 9 / 16);
      expect(Math.min(crop.width, crop.height)).toBeGreaterThanOrEqual(MIN_CROP - 1e-9);
      // And still inside the source, still enclosing the subject.
      expect(crop.x).toBeGreaterThanOrEqual(0);
      expect(crop.y).toBeGreaterThanOrEqual(0);
      expect(crop.x + crop.width).toBeLessThanOrEqual(1.0001);
      expect(crop.y + crop.height).toBeLessThanOrEqual(1.0001);
      expect(crop.x).toBeLessThanOrEqual(tiny.x + 1e-9);
      expect(crop.y).toBeLessThanOrEqual(tiny.y + 1e-9);
    }
  });
});

describe("captions across a composition switch", () => {
  const cues: Cue[] = [
    { start: 120, end: 126, text: "we try to support an environment where people feel comfortable and safe" },
    { start: 126, end: 130, text: "and that is the whole idea of the thing we do here" },
  ];

  /**
   * The captions the preview and the export both draw for a cut: the placed
   * clips with their source windows, the cues, and the timeline's start for
   * each clip (as `layOut` puts them).
   */
  function captionsFor(edl: Edl, maxChars = 22) {
    const placed: PlacedClip[] = [];
    const { placed: at } = timelineOf(edl);
    edl.main.elements.forEach((el, i) => {
      if (el.type === "video" && el.src === "asset:a") {
        placed.push({ src: el.src, start: at[i].start, dur: at[i].dur, trimStart: el.trimStart ?? 0 });
      }
    });
    return captionTimeline(placed, new Map([["asset:a", cues]]), maxChars);
  }

  it("shows every word exactly once, however the shot boundary falls", () => {
    const words = cues.flatMap((c) => c.text.split(" "));
    for (const boundary of [123, 123.5, 124, 124.7, 125, 125.8, 126]) {
      const shots = shotsOf([advice("0:02:00", `0:02:${(boundary - 120).toFixed(3)}`.padStart(9, "0")), advice(`0:02:${(boundary - 120).toFixed(3)}`.padStart(9, "0"), "0:02:10")], 120, 130);
      const after = applyToView(interview(), 1, shots, idFactory());
      const lines = captionsFor(after);
      const shown = lines.flatMap((l) => l.text.split(" "));
      expect(shown, `boundary ${boundary}`).toEqual(words);
      // No line is repeated back to back at the cut.
      for (let i = 1; i < lines.length; i++) expect(lines[i].text, `boundary ${boundary}`).not.toBe(lines[i - 1].text);
    }
  });

  it("shows the same captions before and after a reframe: the switch moves nothing", () => {
    // Before: one clip playing 120-130 at 4 s into the cut.
    const whole = timelineOf(interview());
    const onePlaced: PlacedClip[] = [{ src: "asset:a", start: whole.placed[1].start, dur: 10, trimStart: 120 }];
    const before = captionTimeline(onePlaced, new Map([["asset:a", cues]]), 22);

    const shots = shotsOf([advice("0:02:00", "0:02:04"), advice("0:02:04", "0:02:07"), advice("0:02:07", "0:02:10")], 120, 130);
    const after = captionsFor(applyToView(interview(), 1, shots, idFactory()));
    expect(after).toEqual(before);
  });

  it("keeps a short word from vanishing when a boundary splits it", () => {
    const short: Cue[] = [{ start: 120, end: 120.3, text: "alpha beta" }];
    const split: PlacedClip[] = [
      { src: "asset:a", start: 0, dur: 0.15, trimStart: 120 },
      { src: "asset:a", start: 0.15, dur: 0.15, trimStart: 120.15 },
    ];
    const lines = captionTimeline(split, new Map([["asset:a", short]]), 22);
    expect(lines.map((l) => l.text)).toEqual(["alpha beta"]);
    expect(lines[0].from).toBeCloseTo(0, 6);
    expect(lines[0].to).toBeCloseTo(0.3, 6);
  });

  it("joins only a window that truly continues, and leaves a repeated or jumped window alone", () => {
    // 125-128 then 126-129: the second clip plays a stretch that overlaps and
    // then runs past the first, so it is its own window — the run must not be
    // folded into one (125-129 would re-read 126-128 twice).
    const jumped = captionRuns([
      { src: "asset:a", start: 0, dur: 3, trimStart: 125 },
      { src: "asset:a", start: 3, dur: 3, trimStart: 126 },
    ]);
    expect(jumped).toEqual([
      { src: "asset:a", start: 0, dur: 3, trimStart: 125 },
      { src: "asset:a", start: 3, dur: 3, trimStart: 126 },
    ]);
    // A window played twice in a row is two runs, not one 6 s stretch.
    const repeated = captionRuns([
      { src: "asset:a", start: 0, dur: 3, trimStart: 125 },
      { src: "asset:a", start: 3, dur: 3, trimStart: 125 },
    ]);
    expect(repeated).toHaveLength(2);
    // A piece that continues its neighbour exactly is one run.
    const straight = captionRuns([
      { src: "asset:a", start: 0, dur: 3, trimStart: 120 },
      { src: "asset:a", start: 3, dur: 4, trimStart: 123 },
    ]);
    expect(straight).toEqual([{ src: "asset:a", start: 0, dur: 7, trimStart: 120 }]);
    // A different source never joins, however the times line up.
    expect(captionRuns([
      { src: "asset:a", start: 0, dur: 3, trimStart: 0 },
      { src: "asset:b", start: 3, dur: 3, trimStart: 3 },
    ])).toHaveLength(2);
    // And the words of the jumped window are still shown, not swallowed.
    const cues: Cue[] = [
      { start: 125, end: 128, text: "first window words" },
      { start: 126, end: 129, text: "second window words" },
    ];
    const lines = captionTimeline([
      { src: "asset:a", start: 0, dur: 3, trimStart: 125 },
      { src: "asset:a", start: 3, dur: 3, trimStart: 126 },
    ], new Map([["asset:a", cues]]), 22);
    expect(lines.length).toBeGreaterThan(0);
  });
});

describe("reframing the same clip twice", () => {
  it("gives exactly the same pieces twice, ids aside", () => {
    const shots = shotsOf([advice("0:02:00", "0:02:02"), advice("0:02:02", "0:02:06", "split", [{ label: "host", region: other }, { label: "guest", region }]), advice("0:02:06", "0:02:10")], 120, 130);
    const strip = (edl: Edl) =>
      edl.main.elements.filter((el) => el.src === "asset:a").map((el) => [el.trimStart, el.duration, (el as { framing?: unknown }).framing ?? null]);
    const first = applyToView(interview(), 1, shots, idFactory());
    const second = applyToView(interview(), 1, shots, idFactory());
    expect(strip(second)).toEqual(strip(first));
  });

  it("on the already-reframed cut, re-runs on each piece and keeps the same set", () => {
    const shots = shotsOf([advice("0:02:00", "0:02:02"), advice("0:02:02", "0:02:06", "split", [{ label: "host", region: other }, { label: "guest", region }]), advice("0:02:06", "0:02:10")], 120, 130);
    const once = applyToView(interview(), 1, shots, idFactory());
    // Reframe each piece again, as a person pressing the button a second time would.
    const id = idFactory();
    const view = formatView(once, "9:16");
    view.main.elements = view.main.elements.flatMap((el) => {
      const clip = el as { type: string; duration?: number; src?: string };
      if (clip.type !== "video" || !clip.src || clip.duration === undefined) return [el];
      return framedPieces(el as never, clip.duration, view.output.fps, shots, id);
    });
    const twice = liftView(once, view, "9:16");
    expect(validateEdl(twice)).toHaveProperty("edl");
    const shape = (edl: Edl) => edl.main.elements.filter((el) => el.src === "asset:a").map((el) => [el.trimStart, el.duration]);
    expect(shape(twice)).toEqual(shape(once));
    expect(framesOf(twice)).toBe(framesOf(once));
  });
});

describe("a failed reframe leaves the clip editable", () => {
  it("keeps the clip whole when the analysis fails, with its trims intact", () => {
    // A frame target whose analysis never answered: the clip is left as it was.
    const doc = interview();
    const targets = frameTargets([{ project: "draft", name: "this cut", edl: doc }], new Map([["asset:a", 1500], ["asset:b", 10], ["asset:c", 10]]));
    if ("error" in targets) throw new Error(targets.error);
    expect(targets[0].parts.length).toBeGreaterThan(0);
    // One part failed: nothing is applied, and the cut it was read from still
    // has the interview clip exactly as it was, so it can be trimmed again.
    const failed: FrameTarget = { ...targets[0], parts: targets[0].parts.map((p) => ({ ...p, status: "failed", error: "boom" })) };
    const applied = applyFraming(failed);
    if ("error" in applied) throw new Error(applied.error);
    // The route only frames a cut once every part is done; when one failed it
    // leaves the clip in place, unchanged, rather than cutting it short.
    const talk = applied.edl.main.elements.filter((el) => el.src === "asset:a");
    expect(talk).toHaveLength(1);
    expect(talk[0]).toMatchObject({ id: "talk", trimStart: 120, duration: 10 });
    // The clip can still be trimmed and split afterwards.
    const [a, b] = splitClip({ ...talk[0], duration: 10 } as never, 4, 10, "second")!;
    expect([a.duration, b.trimStart, b.duration]).toEqual([4, 124, 6]);
  });

  it("keeps the whole picture and marks it for review when the advice is unusable", () => {
    const shots = shotsOf([advice("garbage", "nonsense")], 120, 130);
    expect(shots).toHaveLength(1);
    expect(shots[0]).toMatchObject({ layout: "whole", review: true });
    expect(shots[0].from).toBe(120);
    expect(shots[0].to).toBe(130);
    // It is still applied as a single whole piece, so the time it covers is not lost.
    const after = applyToView(interview(), 1, shots, idFactory());
    expect(framesOf(after)).toBe(framesOf(interview()));
  });
});

describe("pieces add up to the clip, at any rate", () => {
  it("sums to the same whole frames, at 24, 30 and 60 fps, for many boundary sets", () => {
    for (const fps of [24, 30, 60]) {
      for (const [start, duration] of [[0, 10], [120, 10], [510.0004, 14], [0, 0.12]] as const) {
        for (const boundaries of [[0.02, 0.07], [0.05, 0.11, 0.16], [1.017, 2.33], [duration * 0.3, duration * 0.33, duration * 0.5]]) {
          const uniq = [...new Set(boundaries.map((b) => Math.round(b * 1000) / 1000).filter((b) => b > 0 && b < duration))].sort((a, b) => a - b);
          const shots = shotsOf(uniq.map((b, i) => advice(`0:00:${String(b).padStart(6, "0")}`, `0:00:${String(uniq[i + 1] ?? duration).padStart(6, "0")}`)), start, start + duration);
          const pieces = framedPieces({ id: "c", trimStart: start, duration }, duration, fps, shots, idFactory());
          const frames = pieces.reduce((n, p) => n + Math.round(p.duration! * fps), 0);
          expect(frames, `${fps} ${start} ${duration}`).toBe(Math.max(1, Math.round(duration * fps)));
          expect(pieces.every((p) => p.duration! >= 0.05 - 1e-9)).toBe(true);
          // Contiguous: each piece starts where the last ended.
          for (let i = 1; i < pieces.length; i++) {
            expect(pieces[i].trimStart).toBeCloseTo(pieces[i - 1].trimStart! + pieces[i - 1].duration!, 6);
          }
        }
      }
    }
  });

  it("keeps a minimum-duration clip as one piece", () => {
    const piece = framedPieces({ id: "tiny", duration: 0.05 }, 0.05, 30, [], idFactory())[0];
    expect(piece.duration).toBe(0.05);
    const odd = framedPieces({ id: "odd", duration: 1.017 }, 1.017, 30, [], idFactory())[0];
    // No cut: the clip keeps its exact length, not a rounded frame count.
    expect(odd.duration).toBe(1.017);
  });
});
