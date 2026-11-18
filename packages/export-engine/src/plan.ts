/**
 * Turning a project + export settings into a concrete, validated render plan.
 *
 * This is the bridge between the document and the encode loop, and it is pure:
 * it decides *which frames* to render and *at what size and rate*, but never
 * touches a codec or a canvas. The same plan drives any backend, so what gets
 * encoded is exactly what the plan says — the frame count and timing can be
 * unit-tested without a browser.
 */

import type { Clip, ExportSettings, Frame, ProjectDocument, Size } from "@cutaway/types";

/**
 * What a range would actually render, reported back to the user.
 *
 * The counts are what the renderer will draw, not what geometrically overlaps:
 * hidden clips and clips on hidden tracks are excluded. This is the answer to
 * "did my export actually capture anything?" before the user waits for a file.
 */
export interface ExportContentSummary {
  /** Visible clips that draw something (video, image, text, …). */
  visual: number;
  /** Visible audio clips — they make a render worthwhile even with no picture. */
  audio: number;
  /** Caption blocks overlapping the range. */
  captions: number;
  /**
   * Non-fatal things worth telling the user before they wait for a render —
   * chiefly that the picture will be black. Empty for an ordinary export.
   */
  warnings: string[];
}

/** A validated, backend-agnostic description of an export job. */
export interface ExportPlan {
  /** First timeline frame to render (inclusive). */
  startFrame: Frame;
  /** One past the last frame to render (exclusive), half-open like the timeline. */
  endFrame: Frame;
  /** Number of frames to render — always `endFrame - startFrame`, and > 0. */
  totalFrames: number;
  /** Output pixel dimensions. Both even, as video codecs require. */
  resolution: Size;
  frameRate: number;
  /** Wall-clock length of the output in seconds. */
  durationSeconds: number;
  format: ExportSettings["format"];
  videoCodec: ExportSettings["videoCodec"];
  audioCodec: ExportSettings["audioCodec"];
  videoBitrate: number;
  audioBitrate: number;
  /** What the range will actually render, and any non-fatal caveats. */
  contentSummary: ExportContentSummary;
  /**
   * Non-fatal things worth telling the user before they wait for a render —
   * chiefly that the picture will be black. Empty for an ordinary export.
   *
   * Kept at the top level for convenience; it is the same array as
   * {@link ExportContentSummary.warnings}.
   */
  warnings: string[];
}

/** Counts for one bucket of a range scan, used to catch empty renders. */
interface RangeContent {
  /** Clips that draw something (video, image, text). */
  visual: number;
  /** Audio clips — they make a render worthwhile even with no picture. */
  audio: number;
  /** Caption blocks overlapping the range. */
  captions: number;
}

/** Visible and concealed content in a range, so errors can explain which it is. */
interface RangeScan {
  visible: RangeContent;
  /** Content the range *would* have if it were not hidden. */
  hidden: RangeContent;
}

/**
 * Finds the last frame at which a visual clip still draws, accounting for a
 * transition tail.
 *
 * The renderer's `transitionOpacity` pulls the outgoing clip past its own end
 * for the duration of the *next* clip's `transitionIn`, but only on an exact
 * cut (`next.startFrame === clipEnd`) — a gap has nothing to crossfade into.
 * Counting must match that exactly: a range covering only the fade-out tail is
 * still content, and refusing it would be a false "nothing to export". Audio
 * clips have no transition rendering, so they keep their plain end.
 */
function visibleEndFor(clip: Clip, next: Clip | undefined): Frame {
  const clipEnd = clip.startFrame + clip.durationFrames;
  if (clip.content.kind === "audio") return clipEnd;

  const transition = next?.transitionIn;
  if (
    next &&
    transition &&
    transition.durationFrames > 0 &&
    next.startFrame === clipEnd // only an exact cut crossfades
  ) {
    return clipEnd + transition.durationFrames;
  }
  return clipEnd;
}

/**
 * Counts what a range would actually render, and what it would render if
 * nothing were hidden.
 *
 * Hidden clips and clips on hidden tracks are skipped, because the renderer
 * skips them too — counting them would let a "there is content here" check pass
 * for a range that draws nothing. Ranges are half-open on both sides, matching
 * the timeline: `[start, end)`. Every caption block that overlaps the range
 * counts once.
 */
function contentInRange(project: ProjectDocument, start: Frame, end: Frame): RangeScan {
  const { clips, tracks, captionTracks } = project.entities;
  const visible: RangeContent = { visual: 0, audio: 0, captions: 0 };
  const hidden: RangeContent = { visual: 0, audio: 0, captions: 0 };

  // Group by track and sort by start, mirroring how the renderer pairs each
  // clip with the next one on its track to resolve transition tails.
  const clipsByTrack = new Map<string, Clip[]>();
  for (const clip of Object.values(clips)) {
    const trackClips = clipsByTrack.get(clip.trackId);
    if (trackClips) trackClips.push(clip);
    else clipsByTrack.set(clip.trackId, [clip]);
  }

  for (const trackClips of clipsByTrack.values()) {
    trackClips.sort((a, b) => a.startFrame - b.startFrame);

    trackClips.forEach((clip, index) => {
      const drawEnd = visibleEndFor(clip, trackClips[index + 1]);
      if (drawEnd <= start || clip.startFrame >= end) return;

      const bucket = clip.hidden || tracks[clip.trackId]?.hidden ? hidden : visible;
      if (clip.content.kind === "audio") bucket.audio += 1;
      else bucket.visual += 1;
    });
  }

  for (const track of Object.values(captionTracks)) {
    for (const block of track.blocks) {
      if (block.endFrame > start && block.startFrame < end) {
        visible.captions += 1;
      }
    }
  }

  return { visible, hidden };
}

/** Thrown when settings cannot produce a valid export. Carries a user-facing reason. */
export class ExportPlanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExportPlanError";
  }
}

/**
 * Builds a render plan, or throws {@link ExportPlanError} with a reason the UI
 * can show. Validation lives here rather than in the encoder so a bad request is
 * rejected before any expensive resource is allocated.
 */
export function planExport(project: ProjectDocument, settings: ExportSettings): ExportPlan {
  const startFrame = settings.range ? settings.range.start : 0;
  const endFrame = settings.range ? settings.range.end : project.durationFrames;

  if (endFrame <= startFrame) {
    throw new ExportPlanError(
      "Nothing to export — the timeline is empty or the selected range has no length.",
    );
  }

  const { width, height } = settings.resolution;
  if (width <= 0 || height <= 0) {
    throw new ExportPlanError("Export resolution must be positive.");
  }
  // Every mainstream video codec requires even dimensions (chroma subsampling
  // works on 2×2 blocks). Reject rather than silently rounding, so the output
  // size is never a surprise.
  if (width % 2 !== 0 || height % 2 !== 0) {
    throw new ExportPlanError(`Export dimensions must be even (got ${width}×${height}).`);
  }

  if (settings.frameRate <= 0) {
    throw new ExportPlanError("Frame rate must be greater than zero.");
  }

  const totalFrames = endFrame - startFrame;

  // A range with nothing in it renders a file that is blank and silent. That is
  // never what someone means by "export", and letting it through silently is
  // indistinguishable from a broken encoder — so refuse it with the reason.
  // The reason distinguishes "the range is empty" from "the content is there but
  // hidden", because the fix for each is different.
  const { visible: content, hidden } = contentInRange(project, startFrame, endFrame);
  if (content.visual === 0 && content.audio === 0 && content.captions === 0) {
    const hiddenTotal = hidden.visual + hidden.audio + hidden.captions;
    if (hiddenTotal > 0) {
      throw new ExportPlanError(
        `Nothing to export in this range — all ${hiddenTotal} item(s) it contains are hidden. Make the clips or their tracks visible and try again.`,
      );
    }
    throw new ExportPlanError(
      "Nothing to export in this range — it contains no clips. Check your in/out points.",
    );
  }

  // Audio-only is legitimate (a podcast, a music bed) but the picture *will* be
  // black, so say so up front rather than letting it look like a failed render.
  const warnings: string[] = [];
  if (content.visual === 0 && content.captions === 0) {
    warnings.push("This range has audio but no visible clips, so the picture will be black.");
  }

  const contentSummary: ExportContentSummary = {
    visual: content.visual,
    audio: content.audio,
    captions: content.captions,
    warnings,
  };

  return {
    startFrame,
    endFrame,
    totalFrames,
    resolution: { width, height },
    frameRate: settings.frameRate,
    durationSeconds: totalFrames / settings.frameRate,
    format: settings.format,
    videoCodec: settings.videoCodec,
    audioCodec: settings.audioCodec,
    videoBitrate: settings.videoBitrate,
    audioBitrate: settings.audioBitrate,
    contentSummary,
    warnings,
  };
}

/** Presentation timestamp of a plan-relative frame index, in microseconds. */
export function frameTimestampMicros(plan: ExportPlan, frameIndex: number): number {
  // Derived from the index, never accumulated, so rounding never drifts across a
  // long export — the same reason the preview clock derives the playhead.
  return Math.round((frameIndex * 1_000_000) / plan.frameRate);
}

/** Nominal duration of one frame in microseconds. */
export function frameDurationMicros(plan: ExportPlan): number {
  return Math.round(1_000_000 / plan.frameRate);
}

/** A short human summary, e.g. `1920×1080 · 30 fps · 0:05 · 150 frames`. */
export function describeExport(plan: ExportPlan): string {
  const totalSeconds = Math.round(plan.durationSeconds);
  const mm = Math.floor(totalSeconds / 60);
  const ss = String(totalSeconds % 60).padStart(2, "0");
  return `${plan.resolution.width}×${plan.resolution.height} · ${plan.frameRate} fps · ${mm}:${ss} · ${plan.totalFrames} frames`;
}
