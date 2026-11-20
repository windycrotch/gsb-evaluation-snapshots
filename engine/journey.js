// The deterministic lifecycle of one portal journey, shared by every entry
// path (world-list choice, walking into the gate, direct links). It owns no
// DOM or renderer state: all side effects are handed in, so the whole
// lifecycle is testable under Node without a browser.
//
// States:
//   IDLE    no journey in flight; a new begin() is accepted
//   ACTIVE  exactly one journey is in flight; every further begin() is ignored
//
// Every accepted begin() returns a ticket (an epoch number). A journey ends
// in exactly one of two ways:
//   fail    the navigation could not happen; end(ticket) moves back to IDLE
//           and runs onRestore('failure'), which must reset gate, player
//           and input so the visitor can choose another world.
//   restore the page came back from the browser's history (pageshow with
//           persisted === true). restore() is mutually exclusive with any
//           in-flight journey: it ends the current epoch and runs
//           onRestore('history'), so stale callbacks from the old journey
//           can never drive the restored page again.
export const JOURNEY_IDLE = 'idle';
export const JOURNEY_ACTIVE = 'active';
export const RESTORE_HISTORY = 'history';
export const RESTORE_FAILURE = 'failure';

export function createJourneyState({ onRestore } = {}) {
  let state = JOURNEY_IDLE;
  let epoch = 0;

  return {
    get state() { return state; },
    get active() { return state === JOURNEY_ACTIVE; },
    // The ticket of the next accepted journey without changing any state.
    peekTicket() { return epoch + 1; },
    // Claim the single in-flight slot. Returns the ticket, or null when a
    // journey is already active: the caller must treat null as "ignored",
    // never queue a second attempt.
    begin() {
      if (state === JOURNEY_ACTIVE) return null;
      state = JOURNEY_ACTIVE;
      return ++epoch;
    },
    // Whether `ticket` still owns the in-flight journey. Every async
    // continuation must check this before touching shared state.
    current(ticket) { return state === JOURNEY_ACTIVE && ticket === epoch; },
    // End an in-flight journey because navigation failed. Restoring from
    // IDLE still bumps the epoch, so callbacks older than a previous journey
    // keep failing their current() checks.
    end(ticket) {
      if (state !== JOURNEY_ACTIVE || ticket !== epoch) return false;
      state = JOURNEY_IDLE;
      epoch++;
      return true;
    },
    // A restored (BFCache) page always starts a new lifecycle: the previous
    // epoch, finished or not, can no longer advance anything here.
    restore(reason = RESTORE_HISTORY) {
      state = JOURNEY_IDLE;
      epoch++;
      onRestore?.(reason);
      return epoch;
    },
  };
}
