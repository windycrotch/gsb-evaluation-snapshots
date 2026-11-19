// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Arnold Wender / Wender Media

/**
 * The single source of truth for "the last finished take".
 *
 * Recording and exporting live in different modules and are triggered from
 * different places (transport bar, application menu), but they must agree on
 * what the most recent take is. Keeping it here rather than inside
 * AudioRecorder means:
 *
 *  · stop() can publish the take before its promise resolves, so an Export
 *    Audio fired immediately after stopping always finds it;
 *  · export can be tested without spinning up a recorder;
 *  · a failed or empty stop never destroys a previously good take.
 */
let lastTake: Blob | null = null

/** Publish a finished take. Called by AudioRecorder when a stop succeeds. */
export function setLastTake(blob: Blob): void {
  lastTake = blob
}

/** The most recent finished take, or null if nothing has been recorded. */
export function getLastTake(): Blob | null {
  return lastTake
}

/** Forget the last take. Exposed for tests and for explicit user resets. */
export function clearLastTake(): void {
  lastTake = null
}
