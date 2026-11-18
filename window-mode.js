"use strict";

/**
 * Window mode helpers shared by the main process and local tests.
 *
 * The main process keeps the imperative window surgery (resizing, always-on-top,
 * fullscreen) but derives both the `windowModeChanged` broadcast and the
 * `getWindowModeSnapshot` query from these functions so the two can never drift.
 */

const MIN_SCALE = 0.15;
const COMPACT_MAX_WIDTH = 720;
const COMPACT_MAX_HEIGHT = 420;
// A blur that happened right after a shrink (e.g. focus bouncing between the
// mini player and the app that took focus) must not shrink again.
const BLUR_SHRINK_MIN_INTERVAL_MS = 250;

/**
 * Scale used for the renderer UI, matching the historical notifyMode formula.
 * @param {number} width
 * @param {number} height
 * @returns {number}
 */
function computeScale(width, height) {
  if (!(width > 0) || !(height > 0)) return 1;
  return Math.max(MIN_SCALE, Math.min(width / 1920, height / 1080));
}

/**
 * Build the authoritative window-mode snapshot.
 *
 * @param {{isMiniPlayer: boolean, isPinned: boolean,
 *          translucentFullscreenBypass?: boolean}} mode
 * @param {{isDestroyed?: Function, isFullScreen?: Function,
 *          getContentBounds?: Function}|null} win
 * @returns {{isMiniPlayer: boolean, isPinned: boolean, isFullScreen: boolean,
 *            isCompact: boolean, scale: number}}
 */
function getWindowModeSnapshot(mode, win) {
  const state = mode || {};
  const isMiniPlayer = Boolean(state.isMiniPlayer);
  const isPinned = Boolean(state.isPinned);

  let width = 0;
  let height = 0;
  let fullScreen = false;
  if (win && (typeof win.isDestroyed !== "function" || !win.isDestroyed())) {
    try {
      if (typeof win.getContentBounds === "function") {
        const bounds = win.getContentBounds() || {};
        width = Number(bounds.width) || 0;
        height = Number(bounds.height) || 0;
      }
    } catch (_) {}
    try {
      if (typeof win.isFullScreen === "function") {
        fullScreen = Boolean(win.isFullScreen());
      }
    } catch (_) {}
  }

  return {
    isMiniPlayer,
    isPinned,
    // Same meaning as the historical notifyMode broadcast: native fullscreen or
    // the translucent fullscreen work-area bypass.
    isFullScreen: Boolean(fullScreen || state.translucentFullscreenBypass),
    // A degenerate size (0x0, e.g. a destroyed or not-yet-created window) is not
    // evidence of a compact window; only a real measurement triggers it.
    isCompact: Boolean(
      isMiniPlayer ||
        (width > 0 && width <= COMPACT_MAX_WIDTH) ||
        (height > 0 && height <= COMPACT_MAX_HEIGHT)
    ),
    scale: computeScale(width, height),
  };
}

/**
 * Only the main window's own top-level renderer may read the snapshot.
 * Popups, devtools, other webContents and sub-frames are rejected.
 *
 * @param {{sender?: object, senderFrame?: object|null,
 *          mainWindow?: {isDestroyed?: Function, webContents?: object}|null}} ctx
 * @returns {boolean}
 */
function isAuthorizedSnapshotSender(ctx) {
  const input = ctx || {};
  const sender = input.sender;
  const mainWindow = input.mainWindow;
  if (!sender) return false;
  if (typeof sender.isDestroyed === "function" && sender.isDestroyed()) {
    return false;
  }
  if (!mainWindow) return false;
  if (typeof mainWindow.isDestroyed === "function" && mainWindow.isDestroyed()) {
    return false;
  }
  if (!mainWindow.webContents || sender !== mainWindow.webContents) return false;
  const mainFrame = mainWindow.webContents.mainFrame;
  if (input.senderFrame && mainFrame && input.senderFrame !== mainFrame) {
    return false;
  }
  return true;
}

/**
 * Decide what a window `blur` should do.
 *
 * Rules:
 *  - Only a pinned, non-mini window may auto-shrink. Once pinning is off the
 *    window must never shrink on blur again.
 *  - A mini player only re-asserts always-on-top; its bounds must not change.
 *  - Shrinks closer together than BLUR_SHRINK_MIN_INTERVAL_MS are ignored,
 *    where "last shrink" is tracked on the caller's side.
 *
 * @param {{isPinned: boolean, isMiniPlayer: boolean, now: number,
 *          lastShrinkTime: number, minIntervalMs?: number}} input
 * @returns {"ignore"|"repin"|"shrink"}
 */
function planBlurAction(input) {
  const {
    isPinned,
    isMiniPlayer,
    now,
    lastShrinkTime,
  } = input || {};
  if (!isPinned) return "ignore";
  if (isMiniPlayer) return "repin";

  const minInterval =
    Number.isFinite(input && input.minIntervalMs) && input.minIntervalMs >= 0
      ? input.minIntervalMs
      : BLUR_SHRINK_MIN_INTERVAL_MS;
  const last = Number.isFinite(lastShrinkTime) ? lastShrinkTime : 0;
  const current = Number.isFinite(now) ? now : 0;
  if (current - last < minInterval) return "ignore";
  return "shrink";
}

/**
 * Apply the blur policy to whatever window object / callbacks the caller
 * provides. Keeping the decision and the effects together here lets the main
 * process and the local tests exercise the exact same code path with a fake
 * window.
 *
 * @param {{mode: {isPinned: boolean, isMiniPlayer: boolean},
 *          win?: {isDestroyed?: Function},
 *          now: number, lastShrinkTime: number,
 *          isAlwaysOnTop?: Function, applyAlwaysOnTop?: Function,
 *          shrink?: Function}} ctx
 * @returns {{action: "ignore"|"repin"|"shrink"}}
 */
function applyBlurPolicy(ctx) {
  const input = ctx || {};
  const mode = input.mode || {};
  const win = input.win;
  if (win && typeof win.isDestroyed === "function" && win.isDestroyed()) {
    return { action: "ignore" };
  }

  const action = planBlurAction({
    isPinned: Boolean(mode.isPinned),
    isMiniPlayer: Boolean(mode.isMiniPlayer),
    now: input.now,
    lastShrinkTime: input.lastShrinkTime,
  });

  if (action === "repin") {
    const alreadyOnTop =
      typeof input.isAlwaysOnTop !== "function" || input.isAlwaysOnTop();
    if (!alreadyOnTop && typeof input.applyAlwaysOnTop === "function") {
      input.applyAlwaysOnTop(true);
    }
    return { action };
  }

  if (action === "shrink" && typeof input.shrink === "function") {
    input.shrink();
  }

  return { action };
}

module.exports = {
  MIN_SCALE,
  COMPACT_MAX_WIDTH,
  COMPACT_MAX_HEIGHT,
  BLUR_SHRINK_MIN_INTERVAL_MS,
  computeScale,
  getWindowModeSnapshot,
  isAuthorizedSnapshotSender,
  planBlurAction,
  applyBlurPolicy,
};
