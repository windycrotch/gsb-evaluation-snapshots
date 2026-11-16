// ╔══════════════════════════════════════════════════════════════════╗
// ║  YTSpoofingStream — Harvest Session Manager                      ║
// ║  Exactly one active offscreen harvest session at a time.         ║
// ║  Every session settles exactly once with one terminal outcome.   ║
// ║                                                                  ║
// ║  This module has NO direct chrome.* dependency: every browser    ║
// ║  API is injected via createHarvestManager(deps) so the whole     ║
// ║  state machine can be exercised offline by node:test with fakes. ║
// ╚══════════════════════════════════════════════════════════════════╝

'use strict';

// Terminal outcome kinds — mutually exclusive, this is the single ending
// of a session. The FETCH_HQ handler maps these onto page-facing fields.
export const HARVEST_OUTCOME = {
  SUCCESS: 'success',     // a verified itag 774 URL was delivered
  CANCELLED: 'cancelled', // superseded by a newer track / explicitly stopped
  TIMEOUT: 'timeout',     // 8s deadline elapsed; NOT a "no 774" verdict
  NO_774: 'no774',        // the source positively reported the track has no 774
  FAILED: 'failed',       // source gave up for an inconclusive reason (messaging
                          // error, track mismatch, unplayable for other reasons)
};

export const HARVEST_TIMEOUT_MS = 8000;

// Abort reasons that constitute a positive "this video really has no 774"
// verdict. Any other abort reason is treated as inconclusive (FAILED).
const CONCLUSIVE_NO774_REASON = 'NO_774_STREAM';
const CONCLUSIVE_NO774_PREFIX = 'UNPLAYABLE';

// ─── Pure validators (also unit-tested directly) ─────────────────────

// The harvested URL is fed straight to the player as its audio source, so only
// accept a genuine https googlevideo.com videoplayback URL for itag 774.
export function isValid774Url(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return false;
  let u;
  try {
    u = new URL(raw);
  } catch (e) {
    return false;
  }
  if (u.protocol !== 'https:') return false;
  if (!/(?:^|\.)googlevideo\.com$/.test(u.hostname)) return false;
  if (!u.pathname.includes('/videoplayback')) return false;
  return u.searchParams.get('itag') === '774' || u.pathname.includes('/itag/774');
}

// Harvest results must come from our own offscreen document: same extension id,
// no hosting tab (offscreen documents have sender.tab === undefined), and a
// sender URL that is the extension's own harvester.html. Content scripts in
// youtube.com tabs (and other extensions) must not be able to forge results.
export function isHarvesterSender(sender, runtimeId, harvesterUrl) {
  return Boolean(
    sender
    && sender.id === runtimeId
    && !sender.tab
    && typeof sender.url === 'string'
    && sender.url.startsWith(harvesterUrl)
  );
}

// ─── URL cleaning (shared with the webRequest interception path) ─────

export function cleanStreamUrl(rawUrl) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl;
  try {
    const u = new URL(rawUrl);
    u.searchParams.delete('range');
    u.searchParams.delete('rn');
    u.searchParams.delete('rbuf');
    u.searchParams.delete('ump');
    u.searchParams.delete('sabr');
    u.searchParams.delete('alr');
    u.searchParams.delete('sq');
    return u.toString();
  } catch (e) {
    return rawUrl
      .replace(/[?&]range=[^&]*/g, '')
      .replace(/[?&]rn=[^&]*/g, '')
      .replace(/[?&]rbuf=[^&]*/g, '')
      .replace(/[?&]ump=[^&]*/g, '')
      .replace(/[?&]sabr=[^&]*/g, '')
      .replace(/[?&]alr=[^&]*/g, '')
      .replace(/[?&]sq=[^&]*/g, '');
  }
}

// ─── Pure policy: when is "no 774" actually confirmed? ───────────────
// Each entry: { provider, status } where status is one of
// 'success' | 'no774' | 'cancelled' | 'timeout' | 'failed' | 'skipped'.
// A confirmation requires EVERY APPLICABLE source (i.e. sources that were
// actually allowed and able to run) to have finished cleanly with a positive
// no-774 verdict. Timeouts, cancellations, fetch failures and skipped sources
// all prevent the temporary marker from being written.
export function isNo774Confirmed(sourceStatuses) {
  if (!Array.isArray(sourceStatuses) || sourceStatuses.length === 0) return false;
  const applicable = sourceStatuses.filter(s => s && s.status !== 'skipped');
  if (applicable.length === 0) return false;
  return applicable.every(s => s.status === 'no774');
}

// ─── Session manager ─────────────────────────────────────────────────

export function createHarvestManager(deps = {}) {
  const timers = deps.timers || {
    setTimeout: (...a) => globalThis.setTimeout(...a),
    clearTimeout: (...a) => globalThis.clearTimeout(...a),
  };
  const timeoutMs = Number.isFinite(Number(deps.timeoutMs)) ? Number(deps.timeoutMs) : HARVEST_TIMEOUT_MS;
  const log = deps.log || (() => {});
  const ensureOffscreen = deps.ensureOffscreen || (async () => {});
  const sendToOffscreen = deps.sendToOffscreen || (async () => {});
  const scheduleIdleClose = deps.scheduleIdleClose || (() => {});
  const runtimeId = deps.runtimeId || '';
  const harvesterUrl = deps.harvesterUrl || '';

  let seq = 0;
  let active = null;          // the single active session, or null
  const pending = new Map();  // videoId -> Promise (duplicate-request coalescing)

  function stopFrame() {
    // Tear the harvester iframe down on EVERY terminal path so a hidden frame
    // never keeps playing after the session ends.
    try {
      Promise.resolve(sendToOffscreen({ type: 'OFFSCREEN_STOP_HARVEST' })).catch(() => {});
    } catch (e) { /* no document alive — nothing to stop */ }
  }

  // The one-and-only settlement path. Idempotent: late messages belonging to
  // an already-settled session can never resolve it a second time.
  function settle(session, outcome, extra = {}) {
    if (!session || session.settled) return;
    session.settled = true;
    timers.clearTimeout(session.timer);
    if (active === session) active = null;
    stopFrame();
    scheduleIdleClose();
    const result = {
      outcome,
      videoId: session.videoId,
      sessionId: session.sessionId,
      formats: Array.isArray(extra.formats) ? extra.formats : [],
      reason: extra.reason ?? null,
      // Lets the upper layer distinguish "we were fed illegal data" even when
      // the session itself eventually ends in a timeout.
      rejectedMessages: session.rejectedCount,
    };
    log(`session #${session.sessionId} (${session.videoId}) settled: ${outcome}`, result);
    session.resolve(result);
  }

  function build774Format(msg) {
    const cleanUrl = cleanStreamUrl(msg.url);

    let realBitrate = msg.averageBitrate || msg.bitrate;
    if (!realBitrate && msg.contentLength && msg.approxDurationMs) {
      const c = Number(msg.contentLength);
      const d = Number(msg.approxDurationMs) / 1000;
      if (c > 0 && d > 0) realBitrate = Math.round((c * 8) / d);
    }
    if (!realBitrate) {
      try {
        const u = new URL(cleanUrl);
        const clen = u.searchParams.get('clen');
        const dur = u.searchParams.get('dur');
        if (clen && dur) {
          const c = parseFloat(clen);
          const d = parseFloat(dur);
          if (c > 0 && d > 0) realBitrate = Math.round((c * 8) / d);
        }
      } catch (e) {}
    }
    realBitrate = realBitrate || 256000;

    return {
      itag: 774,
      _origItag: 774,
      url: cleanUrl,
      _directUrl: cleanUrl,
      mimeType: 'audio/webm; codecs="opus"',
      bitrate: realBitrate,
      averageBitrate: msg.averageBitrate || realBitrate,
      contentLength: msg.contentLength,
      approxDurationMs: msg.approxDurationMs,
      audioQuality: 'AUDIO_QUALITY_HIGH',
      _src: 'YTM_HARVESTER',
    };
  }

  // Open (or join) the session for a video.
  //  - A second request for the SAME video reuses the in-flight promise.
  //  - A request for a DIFFERENT video cancels the old session (its promise
  //    settles with CANCELLED) and takes over. Old results can never land on
  //    the new track because routing goes through the active session only.
  function start(videoId) {
    const existing = pending.get(videoId);
    if (existing) {
      log(`joining in-flight harvest session for ${videoId}`);
      return existing;
    }

    for (const otherVid of [...pending.keys()]) {
      if (otherVid !== videoId) pending.delete(otherVid);
    }
    if (active && active.videoId !== videoId) {
      log(`superseding harvest session for ${active.videoId} (new target: ${videoId})`);
      settle(active, HARVEST_OUTCOME.CANCELLED, { reason: 'SUPERSEDED' });
    }

    const sessionId = ++seq;
    const session = {
      sessionId,
      videoId,
      settled: false,
      timer: null,
      rejectedCount: 0,
      resolve: null,
    };

    const promise = new Promise((resolve) => {
      session.resolve = resolve;

      // The 8s timeout ONLY marks a timeout. It must never be interpreted as
      // "this video has no 774".
      session.timer = timers.setTimeout(() => {
        settle(session, HARVEST_OUTCOME.TIMEOUT);
      }, timeoutMs);

      active = session;

      Promise.resolve()
        .then(() => ensureOffscreen())
        .then(() => {
          // Offscreen creation is async; a newer session may have superseded
          // us while we waited. Never start a frame for a dead session.
          if (session.settled || active !== session) return;
          return sendToOffscreen({ type: 'OFFSCREEN_HARVEST_YTM', videoId });
        })
        .catch((err) => {
          settle(session, HARVEST_OUTCOME.FAILED, {
            reason: `OFFSCREEN_MESSAGE_ERROR: ${(err && err.message) || err}`,
          });
        });
    }).finally(() => {
      if (pending.get(videoId) === promise) pending.delete(videoId);
    });

    pending.set(videoId, promise);
    return promise;
  }

  // OFFSCREEN_HARVEST_SUCCESS from the offscreen document.
  // Returns the receipt the sender gets: false means the message was rejected
  // (forged sender or illegal URL) and must not influence any session.
  function handleHarvestSuccess(msg, sender) {
    if (!isHarvesterSender(sender, runtimeId, harvesterUrl) || !isValid774Url(msg && msg.url)) {
      if (active) active.rejectedCount += 1;
      log('rejected OFFSCREEN_HARVEST_SUCCESS: bad sender or illegal URL', { sender, url: msg && msg.url });
      return false;
    }

    const session = active;
    if (!session || session.settled || session.videoId !== msg.videoId) {
      // Valid message, but nobody is waiting for it (stale/late report).
      log('ignored stale OFFSCREEN_HARVEST_SUCCESS', { videoId: msg && msg.videoId });
      return true;
    }

    settle(session, HARVEST_OUTCOME.SUCCESS, { formats: [build774Format(msg)] });
    return true;
  }

  // OFFSCREEN_HARVEST_ABORT from the offscreen document.
  function handleHarvestAbort(msg, sender) {
    if (!isHarvesterSender(sender, runtimeId, harvesterUrl)) {
      if (active) active.rejectedCount += 1;
      log('rejected OFFSCREEN_HARVEST_ABORT: bad sender');
      return false;
    }

    const session = active;
    if (!session || session.settled || session.videoId !== msg.videoId) {
      return true;
    }

    const reason = String((msg && msg.reason) || 'ABORT');
    const conclusive = reason === CONCLUSIVE_NO774_REASON
      || reason.startsWith(CONCLUSIVE_NO774_PREFIX);
    settle(
      session,
      conclusive ? HARVEST_OUTCOME.NO_774 : HARVEST_OUTCOME.FAILED,
      { reason }
    );
    return true;
  }

  // webRequest interception path (the deciphered URL observed on the wire).
  // All tab/initiator guards live in the background listener; here we only
  // enforce session ownership and the docid/videoId match.
  function deliverWebRequest(rawUrl) {
    const session = active;
    if (!session || session.settled) return false;
    try {
      const u = new URL(rawUrl);
      const docid = u.searchParams.get('docid');
      if (docid && session.videoId && docid !== session.videoId) {
        log(`ignored webRequest 774 with docid=${docid} for session ${session.videoId}`);
        return false;
      }
    } catch (e) {
      return false;
    }
    settle(session, HARVEST_OUTCOME.SUCCESS, { formats: [build774Format({ url: rawUrl })] });
    return true;
  }

  // Explicit stop (page requested teardown, extension disabled, etc.).
  function cancelActive(reason = 'CANCELLED') {
    if (active && !active.settled) {
      settle(active, HARVEST_OUTCOME.CANCELLED, { reason });
    }
  }

  return {
    start,
    handleHarvestSuccess,
    handleHarvestAbort,
    deliverWebRequest,
    cancelActive,
    isActive: () => Boolean(active && !active.settled),
    getActiveVideoId: () => (active ? active.videoId : null),
    get pendingCount() { return pending.size; },
    // Test/debug only.
    _reset() {
      if (active && !active.settled) timers.clearTimeout(active.timer);
      active = null;
      pending.clear();
      seq = 0;
    },
  };
}
