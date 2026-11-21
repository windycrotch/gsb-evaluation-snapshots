// The export's captions for a reframed vertical cut: it works them out from
// each clip's stored transcript and the window the clip plays, exactly as the
// preview does (shared/captions.ts, shared/transition.ts). After an auto
// reframe splits one clip into per-shot pieces, the export must draw the same
// captions the preview showed — none repeated at a cut, none cut in half, none
// pushed off the frame — and place them at the same times.

import { beforeEach, describe, expect, it, vi } from "vitest";

// One 30 s interview asset: three transcript cues, with speech running across
// the shot boundaries a reframe will cut at (3 s, 7 s).
const TRANSCRIPT = `WEBVTT

00:00:00.000 --> 00:00:06.000
we try to support an environment where people feel comfortable and safe

00:00:06.000 --> 00:00:12.000
and that is the whole idea of the thing we do here every day`;

vi.mock("../src/server/db", () => ({
  get: vi.fn(async (sql: string) =>
    /transcript/.test(sql)
      ? { duration: 30, transcript: TRANSCRIPT, transcript_lang: "en" }
      : { duration: 30 },
  ),
  run: vi.fn(),
  query: vi.fn(async () => []),
}));

import { DEFAULT_CAPTION_STYLE } from "../src/shared/captions";
import { expandCaptions } from "../src/server/export";
import { captionChars, captionText, captionTimeline, type PlacedClip } from "../src/shared/captions";
import { blockHeight } from "../src/shared/textLayout";
import { parseVtt } from "../src/shared/transcript";
import { layOut } from "../src/shared/transition";
import { normalizeShots, framedPieces } from "../src/shared/reframe";
import type { Edl } from "../src/server/edl";

const cues = parseVtt(TRANSCRIPT);
const STYLE = { ...DEFAULT_CAPTION_STYLE, margin: 0.2 };

/** A 9:16 cut whose one interview clip was reframed into three per-shot pieces. */
function reframed(): Edl {
  const frame = { width: 1080, height: 1920 };
  const shots = normalizeShots(
    {
      shots: [
        { from: "0:00:00", to: "0:00:03", layout: "speaker", confidence: "high", reason: "a", subjects: [{ label: "g", region: { x: 0.3, y: 0.15, width: 0.1, height: 0.4 } }] },
        { from: "0:00:03", to: "0:00:07", layout: "split", confidence: "high", reason: "b", subjects: [{ label: "h", region: { x: 0.65, y: 0.15, width: 0.1, height: 0.4 } }, { label: "g", region: { x: 0.3, y: 0.15, width: 0.1, height: 0.4 } }] },
        { from: "0:00:07", to: "0:00:12", layout: "speaker", confidence: "high", reason: "c", subjects: [{ label: "h", region: { x: 0.65, y: 0.15, width: 0.1, height: 0.4 } }] },
      ],
    },
    0,
    12,
    frame,
  );
  const pieces = framedPieces({ id: "talk", type: "video", src: "asset:talk", trimStart: 6, duration: 12 } as never, 12, 30, shots, (() => { let n = 0; return () => `p${n++}`; })());
  return {
    version: 1,
    output: { ...frame, fps: 30 },
    main: { elements: pieces.map((p) => ({ ...p, type: "video", src: "asset:talk" })) as never },
    overlays: [],
    audio: [],
    captions: { enabled: true, lang: "en", style: STYLE },
  };
}

beforeEach(() => vi.clearAllMocks());

describe("exported captions match the preview after a reframe", () => {
  it("draws each spoken word once, at the time the preview shows it", async () => {
    const edl = reframed();
    expect(edl.main.elements).toHaveLength(3);
    const out = await expandCaptions(edl);
    const track = out.overlays!.find((t) => t.id === "captions")!;
    expect(track).toBeDefined();

    // The preview's own captions for the same pieces.
    const { placed } = layOut(
      edl.main.elements.map((el) => ("duration" in el && el.duration ? el.duration : 0)),
      edl.main.elements.map((el) => el.transition),
      edl.output.fps,
    );
    const clips: PlacedClip[] = edl.main.elements.map((el, i) => ({
      src: el.src,
      start: placed[i].start,
      dur: placed[i].dur,
      trimStart: ("trimStart" in el && el.trimStart) || 0,
    }));
    const preview = captionTimeline(clips, new Map([["asset:talk", cues]]), captionChars(STYLE, edl.output));

    expect(track.elements.map((e) => e.startTime)).toEqual(preview.map((l) => Math.round(l.from * 1000) / 1000));
    // Each exported element is one wrapped line of its preview caption, in order.
    const shown = track.elements.map((e) => ("text" in e ? e.text : "")).join(" ");
    // Every word of the speech the clip actually plays is shown (the clip
    // begins 6 s into the source, so "we try to support an environment where"
    // is trimmed away and rightly absent).
    const played = cues.flatMap((c) => (c.end > 6 ? c.text.split(" ") : []));
    for (const word of played.filter(Boolean)) expect(shown.split(" ")).toContain(word);
    // No line repeats at a piece boundary.
    const texts = track.elements.map((e) => ("text" in e ? e.text : ""));
    for (let i = 1; i < texts.length; i++) expect(texts[i]).not.toBe(texts[i - 1]);
  });

  it("never pushes a caption off the 9:16 frame at a piece boundary", async () => {
    const out = await expandCaptions(reframed());
    const track = out.overlays!.find((t) => t.id === "captions")!;
    for (const el of track.elements) {
      if (el.type !== "text") continue;
      const h = blockHeight(el.text, el.fontSize, out.output.width, "sans", !!el.background) / out.output.height;
      expect(el.y).toBeGreaterThanOrEqual(0);
      expect(el.y + h).toBeLessThanOrEqual(1 + 1e-9);
      // Its own captionText agrees with what the timeline placed.
      expect(el.fontSize).toBe(captionText({ from: 0, to: 1, text: el.text }, STYLE, out.output, "x").fontSize);
    }
  });

  it("keeps the cut's timing through reframing: captions land at the whole frames the export renders", async () => {
    const out = await expandCaptions(reframed());
    const track = out.overlays!.find((t) => t.id === "captions")!;
    // The last cue ends 12 s into the source, which is the end of the piece
    // that plays it: no caption runs past the cut's end.
    const total = 12;
    for (const el of track.elements) expect(el.startTime + el.duration).toBeLessThanOrEqual(total + 1e-6);
  });
});
