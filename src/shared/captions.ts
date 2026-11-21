// Project captions: one setting for the whole video, with the words coming
// from each clip's transcript.
//
// Text overlays are placed one by one. Captions are not: they are switched on
// for the project, styled once, and worked out from the transcripts every time
// they are shown or exported. Nothing is stored per caption, so trimming,
// splitting or reordering a clip moves its captions with the speech. The
// preview and the export both build captions here, then draw them through the
// shared text layout, so the two agree.

import { captionChunks, type Cue } from "./transcript";
import { blockHeight, charsPerLine, fitTop } from "./textLayout";

export interface CaptionStyle {
  /**
   * Font size as a share of the frame's shorter side. A share of the height
   * made the same setting nearly twice as large on a vertical video as on a
   * wide one, where each line then held half the words and captions wrapped
   * to three lines.
   */
  size: number;
  position: "bottom" | "top";
  /** Distance from that edge, as a share of the frame's height. */
  margin: number;
  /** A dark box behind the text, for legibility on busy footage. */
  background: boolean;
  /** A dark outline around the letters, the other way to keep them legible. */
  outline?: boolean;
  color: string;
  /** Longest caption, in characters, before it moves to the next one. */
  maxChars: number;
}

export interface ProjectCaptions {
  enabled: boolean;
  /** Language the transcripts are requested in. */
  lang: string;
  style: CaptionStyle;
}

export const DEFAULT_CAPTION_STYLE: CaptionStyle = {
  size: 0.055,
  position: "bottom",
  margin: 0.08,
  background: true,
  color: "#ffffff",
  maxChars: 32,
};

export const DEFAULT_CAPTIONS: ProjectCaptions = { enabled: false, lang: "en", style: DEFAULT_CAPTION_STYLE };

type Frame = { width: number; height: number };

/** A caption's font size in pixels at the video's resolution. */
export function captionFontSize(style: CaptionStyle, frame: Frame): number {
  return Math.max(8, Math.round(style.size * Math.min(frame.width, frame.height)));
}

/**
 * The longest caption this style gives on this frame: the chosen line length,
 * or less where that would not fit on two lines. The margin under two full
 * lines is for words that do not break evenly.
 */
export function captionChars(style: CaptionStyle, frame: Frame): number {
  const twoLines = Math.floor(2 * charsPerLine(captionFontSize(style, frame), frame.width) * 0.8);
  return Math.max(8, Math.min(style.maxChars, twoLines));
}

/** A main-track clip as it plays: where it starts on the video, and which part of its source. */
export interface PlacedClip {
  src: string;
  /** Seconds on the finished video. */
  start: number;
  /** Seconds it plays. */
  dur: number;
  /** Seconds into the source where it starts. */
  trimStart: number;
}

export interface CaptionLine {
  /** Seconds on the finished video. */
  from: number;
  to: number;
  text: string;
}

/**
 * Two clips play one unbroken stretch of one source: each starts where the
 * last ended, in the cut and in the source. A reframe's pieces always land on
 * whole output frames of the timeline and exact source times, so both are
 * compared to floating-point noise and nothing more: a window a person moved
 * by even a frame is a different stretch, and its words are left to play on
 * their own rather than folded into a neighbour's.
 */
const CONTIGUOUS = 1e-6;
function contiguous(a: PlacedClip, b: PlacedClip): boolean {
  return (
    a.src === b.src &&
    Math.abs(a.start + a.dur - b.start) <= CONTIGUOUS &&
    Math.abs(a.trimStart + a.dur - b.trimStart) <= CONTIGUOUS
  );
}

/**
 * Over a clip that was split into pieces (a reframe's per-shot segments, a
 * cut with the scissors) the same source runs on across the cut: one speech
 * cue can straddle two pieces. Chunking each piece on its own cut that cue
 * twice, so a group that crosses the boundary was shown twice (clamped to
 * the end of one and the start of the next) or, when both halves fall under
 * the minimum, lost from both — a half line at every composition switch.
 * Pieces that play one continuous stretch are therefore joined back into the
 * run they are, and captioned once.
 */
export function captionRuns(clips: PlacedClip[]): PlacedClip[] {
  const runs: PlacedClip[] = [];
  for (const clip of clips) {
    const last = runs[runs.length - 1];
    if (last && contiguous(last, clip)) {
      last.dur += clip.dur;
    } else {
      runs.push({ ...clip });
    }
  }
  return runs;
}

/** Every caption on the finished video: each clip's cues, cut to its window, moved to its place. */
export function captionTimeline(clips: PlacedClip[], cuesBySrc: Map<string, Cue[]>, maxChars: number): CaptionLine[] {
  const out: CaptionLine[] = [];
  for (const run of captionRuns(clips)) {
    const cues = cuesBySrc.get(run.src);
    if (!cues || cues.length === 0 || run.dur <= 0) continue;
    const window = { start: run.trimStart, end: run.trimStart + run.dur };
    for (const chunk of captionChunks(cues, window, maxChars)) {
      out.push({ from: run.start + chunk.from, to: run.start + chunk.to, text: chunk.text });
    }
  }
  return out;
}

/** The on-screen text a caption line becomes, in the same shape as a text overlay. */
export interface CaptionText {
  id: string;
  type: "text";
  text: string;
  startTime: number;
  duration: number;
  x: number;
  y: number;
  fontSize: number;
  color: string;
  background?: string;
  stroke?: TextStroke;
  align: "center";
}

export interface TextStroke {
  color: string;
  /** Pixels at the video's resolution, outside the letters. */
  width: number;
}

/** A caption's outline: dark, and heavy enough to read at any size. */
export function captionStroke(fontSize: number): TextStroke {
  return { color: "#000000", width: Math.max(1, Math.round(fontSize * 0.08)) };
}

/** The box behind a caption, when the style asks for one. */
const CAPTION_BOX = "#000000a6";

export function captionText(line: CaptionLine, style: CaptionStyle, frame: Frame, id: string): CaptionText {
  const fontSize = captionFontSize(style, frame);
  const height = blockHeight(line.text, fontSize, frame.width, "sans", style.background);
  // Bottom captions keep their bottom edge put and grow upwards as they wrap.
  const wanted = style.position === "top" ? style.margin : 1 - style.margin - height / frame.height;
  return {
    id,
    type: "text",
    text: line.text,
    startTime: Math.round(line.from * 1000) / 1000,
    duration: Math.max(0.05, Math.round((line.to - line.from) * 1000) / 1000),
    x: 0.5,
    y: fitTop(Math.max(0, wanted), height, frame.height),
    fontSize,
    color: style.color,
    ...(style.background ? { background: CAPTION_BOX } : {}),
    ...(style.outline ? { stroke: captionStroke(fontSize) } : {}),
    align: "center",
  };
}
