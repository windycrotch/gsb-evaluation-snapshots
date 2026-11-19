// ─────────────────────────────────────────────────────────────────────────
// The preview window state machine behind PreviewPlayer.
// ─────────────────────────────────────────────────────────────────────────
// Pure and DOM-free so the window rules are unit-testable without a player:
// the component feeds it playback positions and applies the actions it
// returns. One controller per film — a film switch builds a fresh one, so no
// countdown or end marker can leak from one preview into the next.
// ─────────────────────────────────────────────────────────────────────────

import { type Preview, isBeforePreview, isPastPreview, previewRemaining } from '../../../discover/model.js';

export type PreviewWindowSpec = Pick<Preview, 'startSec' | 'durationSec'>;

/** What the player should do in response to a playback position or stream end. */
export type PreviewAction =
  | { type: 'tick'; remaining: number } // inside the window: refresh the countdown
  | { type: 'seek-back'; to: number } // dragged before the window: jump to its start
  | { type: 'finish' } // the window's end: pause and show the end card
  | { type: 'ignore' }; // a stale position, or the window already ended

/**
 * Enforces one preview window: play from `startSec` for `durationSec`, then
 * end exactly once. The end card is a latch — after `finish` every further
 * report is ignored until `replay()` re-arms the window for another pass.
 */
export class PreviewWindowController {
  private endedFlag = false;
  private reachedWindow = false; // positions before the start offset applies are not seeks
  private seekingBack = false; // one seek back at a time, while old positions still arrive
  private remainingSec: number;

  constructor(private readonly window: PreviewWindowSpec) {
    this.remainingSec = window.durationSec;
  }

  /** Whether the window has played through and its end card is up. */
  get ended(): boolean {
    return this.endedFlag;
  }

  /** Seconds left in the window, for the countdown chip. */
  get remaining(): number {
    return this.remainingSec;
  }

  /** A playback position report (the player's TimeChanged event). */
  onTimeChanged(timeSec: number): PreviewAction {
    if (this.endedFlag) {
      return { type: 'ignore' }; // the end card is up; nothing moves until replay
    }
    if (isBeforePreview(this.window, timeSec)) {
      if (this.reachedWindow && !this.seekingBack) {
        this.seekingBack = true;
        return { type: 'seek-back', to: this.window.startSec }; // the user dragged before the window
      }
      return { type: 'ignore' };
    }
    this.reachedWindow = true;
    this.seekingBack = false;
    this.remainingSec = previewRemaining(this.window, timeSec);
    if (isPastPreview(this.window, timeSec)) {
      return this.finish();
    }
    return { type: 'tick', remaining: this.remainingSec };
  }

  /** The stream itself ended (PlaybackFinished): the window's end, wherever it fell. */
  onPlaybackFinished(): PreviewAction {
    return this.finish();
  }

  /**
   * Re-arm the window for another pass (the end card's replay): the countdown
   * goes back to full, the end latch opens, and playback restarts at the
   * returned position — the window's start.
   */
  replay(): number {
    this.endedFlag = false;
    this.reachedWindow = false;
    this.seekingBack = false;
    this.remainingSec = this.window.durationSec;
    return this.window.startSec;
  }

  private finish(): PreviewAction {
    if (this.endedFlag) {
      return { type: 'ignore' }; // the end card fires once per pass
    }
    this.endedFlag = true;
    this.remainingSec = 0;
    return { type: 'finish' };
  }
}
