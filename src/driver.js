// Scripted input driver: turns explicit, reproducible input sequences into
// renderer frames and feeds them to PhysicsEngine. Pure data in, snapshots out
// — the same machinery backs the local sample and the acceptance tests.

import { PhysicsEngine } from './engine.js';
import { STEP_SECONDS } from './constants.js';

/**
 * One renderer-frame input record.
 * @typedef {object} FrameInput
 * @property {number} dt frame duration in seconds
 * @property {number} [mouseDX] horizontal mouse displacement this frame (px)
 * @property {object} [keys] held movement keys
 * @property {boolean} [jumpPressed] jump key edge this frame
 * @property {number} [jumpTickOffset] 0-based tick offset within the frame at which the edge fires (harness only)
 */

/**
 * Run an engine over an explicit list of renderer frames.
 * @param {object} initial forwarded to PhysicsEngine constructor
 * @param {FrameInput[]} frames
 * @returns {{engine:PhysicsEngine, records:object[], frames:FrameInput[]}}
 */
export function runFrames(initial, frames) {
  const engine = new PhysicsEngine(initial);
  const records = [];
  for (const f of frames) {
    const result = engine.frame(f);
    records.push(...result.records);
  }
  return { engine, records, frames };
}

/**
 * Rebucket a per-tick input schedule into renderer frames at a chosen rate.
 *
 * The canonical schedule is defined on the 128 Hz tick grid: one entry per
 * tick with the exact mouseDX that tick must receive and the held keys.
 * Contiguous groups of N = stepsPerFrame ticks become one renderer frame.
 *
 * Two things make the re-bucketed run bit-identical to the 128 Hz reference:
 *   1. A frame's mouse displacement is the SUM of its ticks' values; the
 *      engine splits that total evenly over the N ticks it drives, so each
 *      physical tick receives its canonical mouseDX at any rate.
 *   2. A jump edge carries its 0-based OFFSET within the frame. An edge on
 *      tick 32 is offset 0 at 128 Hz (one-tick frame) and offset 1 at 64 Hz
 *      (frame covering ticks 31..32), so PhysicsEngine fires it on physical
 *      tick 32 in both runs.
 *
 * Key states must be constant inside one frame (the engine applies one held
 * key set to every tick of a frame); schedules must place key changes on
 * frame boundaries, which is enforced below.
 *
 * @param {Array<{mouseDX?:number, keys?:object, jumpPressed?:boolean}>} tickInputs
 * @param {number} stepsPerFrame ticks consumed per rendered frame (e.g. 1 = 128 Hz, 2 = 64 Hz)
 * @returns {FrameInput[]}
 */
export function framesFromTickInputs(tickInputs, stepsPerFrame) {
  if (!Number.isInteger(stepsPerFrame) || stepsPerFrame < 1) {
    throw new Error('stepsPerFrame must be a positive integer');
  }
  const N = stepsPerFrame;
  const frames = [];
  for (let start = 0; start < tickInputs.length; start += N) {
    const slice = tickInputs.slice(start, start + N);
    let mouseDX = 0;
    let jumpTickOffset = -1;
    const keys = slice[0]?.keys ? { ...slice[0].keys } : undefined;
    slice.forEach((t, j) => {
      mouseDX += t.mouseDX || 0;
      if (t.jumpPressed) jumpTickOffset = j;
      if (t.keys && keys) {
        for (const k of ['forward', 'back', 'left', 'right']) {
          if (!!t.keys[k] !== !!keys[k]) {
            throw new Error(
              `tick ${start + j + 1} mixes key states inside one ${N}-tick frame; ` +
              'schedule key changes on frame boundaries for this rate',
            );
          }
        }
      }
    });
    /** @type {FrameInput} */
    const frame = { dt: slice.length * STEP_SECONDS, mouseDX };
    if (keys) frame.keys = keys;
    if (jumpTickOffset >= 0) {
      frame.jumpPressed = true;
      frame.jumpTickOffset = jumpTickOffset;
    }
    frames.push(frame);
  }
  return frames;
}

/**
 * Compact segment builder for sample scripts. Each segment repeats the same
 * per-tick input `ticks` times, so short human-readable specs expand into a
 * full deterministic tick schedule.
 *
 * @param {Array<{ticks:number, mouseDX?:number, keys?:object, jumpPressed?:boolean}>} segments
 * @returns {Array<{mouseDX:number, keys:object, jumpPressed:boolean}>}
 */
export function tickSchedule(segments) {
  const out = [];
  for (const seg of segments) {
    for (let i = 0; i < seg.ticks; i++) {
      out.push({
        mouseDX: seg.mouseDX || 0,
        keys: seg.keys ? { ...seg.keys } : { forward: false, back: false, left: false, right: false },
        // A jump edge fires only on the first tick of the segment.
        jumpPressed: i === 0 && !!seg.jumpPressed,
      });
    }
  }
  return out;
}
