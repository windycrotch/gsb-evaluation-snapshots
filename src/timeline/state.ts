import type { KeyboardState } from '../keyboard/sim';
import type { KeyId } from '../keyboard/layout';
import type { Timeline } from './types';

export interface TypingState {
  /** Text typed by time t (array of graphemes). */
  graphemes: string[];
  /** What the keyboard currently shows. */
  kb: KeyboardState;
  /** Last press — for key highlight and the letter popup. */
  lastPress: { key: KeyId; t: number; kb: KeyboardState; inserted: string | null } | null;
  /** Send time, if already sent. */
  sentAt: number | null;
}

/** Input state at time t. Pure function: depends only on the timeline and t. */
export function stateAt(timeline: Timeline, t: number): TypingState {
  const graphemes: string[] = [];
  let lastPress: TypingState['lastPress'] = null;
  let sentAt: number | null = null;
  let kb: KeyboardState | null = null;

  for (const e of timeline.events) {
    if (e.t > t) {
      // The keyboard looks the way the next event will “see” it.
      kb = e.kb;
      break;
    }
    if (e.type === 'press') {
      if (e.effect.kind === 'insert') graphemes.push(e.effect.text);
      else if (e.effect.kind === 'delete') graphemes.pop();
      lastPress = { key: e.key, t: e.t, kb: e.kb, inserted: e.effect.kind === 'insert' ? e.effect.text : null };
    } else if (e.type === 'send') {
      sentAt = e.t;
    }
  }

  kb ??= timeline.events[timeline.events.length - 1]?.kb ?? { lang: timeline.lang, page: 'letters', shift: false, capsLock: false };
  return { graphemes, kb, lastPress, sentAt };
}
