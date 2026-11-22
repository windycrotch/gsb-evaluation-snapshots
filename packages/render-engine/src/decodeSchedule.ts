/**
 * Planning which video frames an export will need, before it needs them.
 *
 * A frame-exact exporter decodes video with WebCodecs rather than by seeking a
 * `<video>` element, and the efficient decoding paths want the *whole* list of
 * wanted timestamps up front: given them in order, a decoder walks the stream
 * once and decodes each packet at most once, instead of re-decoding from a
 * keyframe for every single frame.
 *
 * So this walks the export's frame list ahead of time and records, per video
 * media, the source timestamps that will be asked for and the order they'll be
 * asked in. It is pure and derived from the same `resolveScene` the render loop
 * uses, which is what guarantees the schedule matches what the loop actually
 * requests — one entry per request, in the same sequence.
 *
 * The frames themselves come from the export plan's `frameRange` (the
 * plan-based overload), so transition tails are scheduled on the same authority
 * that drives the render loop rather than being re-counted here.
 */

import type { Frame, Id, ProjectDocument } from "@cutaway/types";
import { resolveScene } from "./scene";

/**
 * Source timestamps (seconds) each video media will be asked for, in request
 * order. Keyed by media id; only videos appear — images and GIFs aren't decoded
 * frame by frame.
 */
export type VideoDecodeSchedule = Map<Id, number[]>;

/** A plan-shaped source of the frame enumeration (structurally matched). */
export interface FramePlan {
  /** Every timeline frame the export will render, in order. */
  frameRange: readonly number[];
}

/**
 * Builds the decode schedule for the half-open frame range
 * `[startFrame, endFrame)`.
 *
 * A media that appears on several frames gets one entry per frame, and a media
 * used by two clips at once gets one entry per clip — the schedule mirrors
 * requests, not distinct times, so the consumer can pull exactly one decoded
 * frame per request and stay in lockstep.
 */
export function planVideoDecodeSchedule(
  project: ProjectDocument,
  startFrame: Frame,
  endFrame: Frame,
): VideoDecodeSchedule;
/**
 * Builds the decode schedule from an export plan's frame enumeration. Prefer
 * this overload from the export pipeline: it schedules exactly the frames the
 * render loop will ask for — transition tails included — because both read the
 * same `plan.frameRange` instead of each computing a frame count.
 */
export function planVideoDecodeSchedule(
  project: ProjectDocument,
  plan: FramePlan,
): VideoDecodeSchedule;
export function planVideoDecodeSchedule(
  project: ProjectDocument,
  startOrPlan: Frame | FramePlan,
  endFrame?: Frame,
): VideoDecodeSchedule {
  const frames =
    typeof startOrPlan === "object"
      ? startOrPlan.frameRange
      : enumerateRange(startOrPlan, endFrame as Frame);
  return planFromFrames(project, frames);
}

function enumerateRange(startFrame: Frame, endFrame: Frame): number[] {
  const frames: number[] = [];
  for (let frame = startFrame; frame < endFrame; frame += 1) frames.push(frame);
  return frames;
}

/**
 * Walks `frames` in order and records, per video media, one source timestamp per
 * decode request the render loop will make.
 */
function planFromFrames(project: ProjectDocument, frames: readonly number[]): VideoDecodeSchedule {
  const schedule: VideoDecodeSchedule = new Map();

  for (const frame of frames) {
    for (const node of resolveScene(project, frame).nodes) {
      if (node.content.kind !== "media" || node.content.mediaKind !== "video") continue;

      const times = schedule.get(node.content.mediaId);
      // Never negative: a timestamp before the start of the stream is not a
      // thing a decoder can seek to, and clamping matches what playback shows.
      const time = Math.max(0, node.content.sourceTimeSeconds);
      if (times) times.push(time);
      else schedule.set(node.content.mediaId, [time]);
    }
  }

  return schedule;
}
