// The browser-facing half of a portal journey. It turns the pure state
// machine in journey.js into the real flow: show the loading screen, build
// the door link, mark the history entry and session as "departed", navigate,
// and either fail cleanly back to an interactive world or yield to a
// BFCache restore. All ambient APIs are read through `host` so the module
// stays testable under Node; portal.js supplies the real implementations.
import { createJourneyState, RESTORE_HISTORY, RESTORE_FAILURE } from './journey.js';

// If the document is still here this long after navigate(), the navigation
// did not take (a blocked or dropped cross-origin link). Treat it as a
// failure and restore the world instead of leaving the gate busy forever.
const NAV_FAILURE_MS = 4000;
// Two painted frames, matching the previous behaviour, so the loading
// screen is up before the browser swaps documents.
const twoFrames = raf => new Promise(resolve => raf(() => raf(resolve)));

export function createJourney(host) {
  const {
    showLoading, finishLoading, makeLink, navigate,
    requestFrame = typeof requestAnimationFrame === 'function' ? requestAnimationFrame : fn => setTimeout(fn, 16),
    setTimer = setTimeout, clearTimer = clearTimeout,
    addPageShow = fn => safeAdd('pageshow', fn),
    addPageHide = fn => safeAdd('pagehide', fn),
    markDeparted = () => {},
    clearDeparted = () => {},
    markHistory = () => {},
    clearHistory = () => {},
    failureDelayMs = NAV_FAILURE_MS,
    onRestore = null,
  } = host;

  // Test hosts inject their own event registry; in a browser this binds to
  // the window's events. Guarded so the module also loads under Node.
  function safeAdd(type, fn) {
    try { if (typeof addEventListener === 'function') addEventListener(type, fn); } catch {}
  }

  const machine = createJourneyState({ onRestore: reason => restore(reason) });
  let failureTimer = null;

  function clearFailureTimer() {
    if (failureTimer == null) return;
    clearTimer(failureTimer);
    failureTimer = null;
  }

  // One restore path for both endings. A BFCache restore paints its own
  // returning screen; a navigation failure dismisses the departing one.
  // Either way every stale continuation is invalidated by the epoch bump
  // before the outer onRestore runs, so old callbacks cannot re-enter this
  // lifecycle or drive a gate that has already been reset.
  function restore(reason) {
    clearFailureTimer();
    clearDeparted();
    clearHistory();
    if (reason === RESTORE_FAILURE) {
      finishLoading();
    } else {
      showLoading(host.returnLabel(), 1);
      void twoFrames(requestFrame).then(() => finishLoading());
    }
    onRestore?.(reason);
  }

  // A page going into the BFCache or navigating away cancels the failure
  // watchdog: the journey succeeded from this document's point of view.
  addPageHide(() => clearFailureTimer());
  addPageShow(event => {
    if (!event.persisted) return;
    machine.restore(RESTORE_HISTORY);
  });

  function fail(ticket) {
    if (!machine.end(ticket)) return false;
    restore(RESTORE_FAILURE);
    return true;
  }

  return {
    isActive: () => machine.active,
    isCurrent: ticket => machine.current(ticket),
    // Claim the in-flight slot before any animation or request starts.
    // Returns a ticket, or null when a journey is already in progress:
    // callers ignore a null instead of queuing another attempt.
    begin: () => machine.begin(),
    // Run the claimed journey. `ticket` must come from begin(). A false
    // result means the visitor stays on this world and everything has been
    // reset for another attempt; true means navigation was triggered.
    async run(ticket, { label, preview = null, next }) {
      if (!machine.current(ticket)) return false;
      showLoading(label, 0.08, preview);
      let href = null;
      try {
        href = await makeLink(next);
      } catch { href = null; }
      if (!machine.current(ticket) || !href) { fail(ticket); return false; }
      await twoFrames(requestFrame);
      if (!machine.current(ticket)) return false;
      markHistory();
      markDeparted();
      // Arm the watchdog before navigating; pagehide disarms it when the
      // document is actually being replaced or cached.
      failureTimer = setTimer(() => {
        failureTimer = null;
        fail(ticket);
      }, failureDelayMs);
      try { navigate(href); } catch { fail(ticket); return false; }
      return true;
    },
    // Test/debug escape hatch: cancel the navigation-failure watchdog
    // (used when a test holds the navigation on purpose).
    disableFailureWatch() { clearFailureTimer(); },
    // End the in-flight journey as a failure and run the restore path.
    // Used when a caller validates the destination only after claiming the
    // slot (the walk-in animation holds it across that time).
    fail: ticket => fail(ticket),
  };
}
