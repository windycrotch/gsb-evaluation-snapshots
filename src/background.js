// ╔══════════════════════════════════════════════════════════════════╗
// ║  YTSpoofingStream — Service Worker Resolver                      ║
// ║  Multi-client InnerTube resolver + per-client header spoofing    ║
// ╚══════════════════════════════════════════════════════════════════╝

import {
  createHarvestManager,
  isNo774Confirmed,
  HARVEST_OUTCOME,
} from './harvest-session.js';

const TAG = '[YTSS-SW]';
const VERSION = chrome.runtime.getManifest().version;

// ─── FULL CLIENT CONFIGURATIONS ──────────────────────────────────────
// WEB_REMIX first (best HQ success rate)
const CLIENTS = [
  {
    name: 'WEB_REMIX',
    clientName: 'WEB_REMIX',
    clientVersion: '1.20260901.12.00',
    clientId: '67',
    apiKey: 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30',
    ua: null,
    extraContext: {},
  },
  {
    name: 'TVHTML5',
    clientName: 'TVHTML5',
    // Taken from a live youtube.com/tv session (2026-08-01): the page sent
    // `x-youtube-client-version: 7.20260728.17.00` and the signed videoplayback URL
    // came back with `cver=7.20260728.17.00`. The previous value here was
    // 7.20230405.08.01 — roughly three years stale, and stale TV versions are one of
    // the documented causes of a 200 response whose playabilityStatus is
    // "This video is unavailable".
    clientVersion: '7.20260728.17.00',
    clientId: '7',
    apiKey: 'AIzaSyC9XL3ZjWddXya6X74dJoCTL-WEYFDNX30',
    ua: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/5.0 TV Safari/538.1',
    extraContext: {
      deviceMake: 'Samsung',
      deviceModel: 'SmartTV',
    },
  },
  {
    // ANDROID (clientId 3)
    name: 'ANDROID',
    clientName: 'ANDROID',
    clientVersion: '21.04.223',
    clientId: '3',
    apiKey: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
    ua: 'com.google.android.youtube/21.04.223 (Linux; U; Android 14; en_US) gzip',
    extraContext: {
      androidSdkVersion: 34,
      osName: 'Android',
      osVersion: '14',
    },
  },

  {
    // ANDROID_MUSIC — YouTube Music Android client
    name: 'ANDROID_MUSIC',
    clientName: 'ANDROID_MUSIC',
    clientVersion: '7.27.52',
    clientId: '21',
    apiKey: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
    ua: 'com.google.android.apps.youtube.music/7.27.52 (Linux; U; Android 14) gzip',
    extraContext: {
      androidSdkVersion: 34,
      osName: 'Android',
      osVersion: '14',
    },
  },
  {
    // ANDROID_VR — Oculus/Meta Quest client
    name: 'ANDROID_VR',
    clientName: 'ANDROID_VR',
    clientVersion: '1.58.1',
    clientId: '28',
    apiKey: 'AIzaSyA8eiZmM1FaDVjRy-df2KTyQ_vz_yYM39w',
    ua: 'Mozilla/5.0 (Linux; Android 10; Quest 2) AppleWebKit/537.36 (KHTML, like Gecko) OculusBrowser/15.0.0.0 Safari/537.36',
    extraContext: {
      androidSdkVersion: 29,
      osName: 'Android',
      osVersion: '10',
    },
  },
];


// Stable index per client — used to build the per-client DNR rule IDs and the
// `_ytss_c=<idx>` URL marker those rules match on. Must stay stable for the
// lifetime of the SW, so it is derived from array position exactly once.
CLIENTS.forEach((c, i) => { c.idx = i; });

// Ephemeral single-track tracking: only holds at most 1 video temporarily in-memory.
// Replaced/cleared upon video change. NEVER stored in session storage.
let currentNo774VideoId = null;
const confirmedNo774Videos = {
  has(v) { return Boolean(v && currentNo774VideoId === v); },
  add(v) { if (v && /^[\w-]{11}$/.test(v)) currentNo774VideoId = v; },
  delete(v) { if (currentNo774VideoId === v) currentNo774VideoId = null; },
  clear() { currentNo774VideoId = null; }
};
const VALID_LOCALES = new Set(['en', 'vi', 'ja', 'ru', 'zh-cn', 'zh-tw']);
const localeCache = new Map();

// ─── AUTHENTICATION ──────────────────────────────────────────────────
// YouTube web derives its Authorization header from up to three cookies, each with
// its own hash prefix. Sending only `SAPISIDHASH` while hashing a 3PAPISID value
// (the old behaviour) produces an Authorization the server rejects, so the request
// falls back to unauthenticated and Premium-only formats are stripped from it.
const SAPISID_COOKIES = [
  { name: 'SAPISID', prefix: 'SAPISIDHASH' },
  { name: '__Secure-1PAPISID', prefix: 'SAPISID1PHASH' },
  { name: '__Secure-3PAPISID', prefix: 'SAPISID3PHASH' },
];

const SAPISID_COOKIE_NAMES = new Set(SAPISID_COOKIES.map(c => c.name));
const sapisidHashCache = new Map();
const SAPISID_CACHE_TTL_MS = 15000;

if (chrome.cookies?.onChanged) {
  chrome.cookies.onChanged.addListener(({ cookie }) => {
    if (cookie && SAPISID_COOKIE_NAMES.has(cookie.name)) {
      sapisidHashCache.clear();
    }
  });
}

async function sha1Hex(input) {
  const buf = new TextEncoder().encode(input);
  const hash = await crypto.subtle.digest('SHA-1', buf);
  return Array.from(new Uint8Array(hash)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getSapisidHash(origin = 'https://www.youtube.com') {
  try {
    const cached = sapisidHashCache.get(origin);
    if (cached && Date.now() < cached.expiresAt) {
      return cached.header;
    }

    const ts = Math.floor(Date.now() / 1000);
    const cookies = await Promise.all(
      SAPISID_COOKIES.map(({ name }) => chrome.cookies.get({ url: origin, name }))
    );

    const hashTasks = [];
    for (let i = 0; i < SAPISID_COOKIES.length; i++) {
      const value = cookies[i]?.value;
      if (!value) continue;
      const { prefix } = SAPISID_COOKIES[i];
      hashTasks.push(
        sha1Hex(`${ts} ${value} ${origin}`).then(hex => `${prefix} ${ts}_${hex}`)
      );
    }

    const parts = await Promise.all(hashTasks);
    const header = parts.length ? parts.join(' ') : null;
    if (header) {
      sapisidHashCache.set(origin, { header, expiresAt: Date.now() + SAPISID_CACHE_TTL_MS });
    }
    return header;
  } catch (err) {
    return null;
  }
}

// ─── PAGE CONTEXT (visitorData / session index) ───────────────────────
// InnerTube drops high-quality formats when a spoofed client sends no visitorData
// that matches the logged-in session. inject.js reads these values out of the page's
// own ytcfg and relays them here via bridge.js (YTSS_PAGE_CONTEXT).
// Mirrored into chrome.storage.session so the values survive a service worker restart.
let pageContext = { visitorData: null, sessionIndex: null, delegatedSessionId: null };
let lastPersistedSts = 0;

async function loadPageContext() {
  try {
    const [s, l] = await Promise.all([
      chrome.storage.session.get('pageContext'),
      chrome.storage.local.get('lastKnownSts')
    ]);
    if (s.pageContext) pageContext = { ...pageContext, ...s.pageContext };
    const savedSts = Number(l.lastKnownSts);
    if (savedSts > 20000) {
      lastPersistedSts = savedSts;
      if (!pageContext.sts) pageContext.sts = savedSts;
    }
  } catch (e) { }
}
// Kept as a promise so request handlers can await it. Chrome evicts this worker
// after ~30s idle; without the await, the FETCH_HQ that woke it up would read an
// empty pageContext and resolve every client unauthenticated, which makes InnerTube
// strip the Premium-only formats for the rest of the page's life.
const pageContextReady = loadPageContext();

// This context is relayed from the page's MAIN world, which means any script
// running on youtube.com (ads, other extensions, an XSS) can post it too. Every
// field ends up in a credentialed request (headers or InnerTube payload), so each
// one is held to the shape YouTube actually uses and anything else is dropped.
const PAGE_CTX_FORMATS = {
  visitorData: /^[A-Za-z0-9_\-%=]{1,512}$/,
  sessionIndex: /^\d{1,2}$/,
  delegatedSessionId: /^\d{1,32}$/,
  sts: /^\d{4,6}$/,
  poToken: /^[A-Za-z0-9_\-+/=%]{1,2048}$/,
};
function validCtxValue(key, value) {
  if (typeof value !== 'string' && typeof value !== 'number') return false;
  return PAGE_CTX_FORMATS[key].test(String(value));
}

function setPageContext(ctx) {
  if (!ctx || typeof ctx !== 'object') return;
  const next = { ...pageContext };
  if (ctx.visitorData && validCtxValue('visitorData', ctx.visitorData)) next.visitorData = ctx.visitorData;
  if (ctx.sessionIndex !== undefined && ctx.sessionIndex !== null && validCtxValue('sessionIndex', ctx.sessionIndex)) {
    next.sessionIndex = String(ctx.sessionIndex);
  }
  // Accept an explicit null/'' as "clear it". Unlike visitorData and sessionIndex,
  // this field is not self-healing: a page that has left a brand/delegated account
  // reports null, and treating that as "no update" would pin a stale X-Goog-PageId
  // onto every later request for the rest of the browser session.
  if (ctx.delegatedSessionId === null || ctx.delegatedSessionId === '') {
    next.delegatedSessionId = null;
  } else if (typeof ctx.delegatedSessionId === 'string' && validCtxValue('delegatedSessionId', ctx.delegatedSessionId)) {
    next.delegatedSessionId = ctx.delegatedSessionId;
  }
  if (ctx.sts && validCtxValue('sts', ctx.sts)) next.sts = Number(ctx.sts);
  if (ctx.poToken && validCtxValue('poToken', ctx.poToken)) next.poToken = ctx.poToken;

  const changed = JSON.stringify(next) !== JSON.stringify(pageContext);
  pageContext = next;
  if (changed) {
    console.log(TAG, `[PageContext] visitorData=${next.visitorData ? 'set' : 'none'} authUser=${next.sessionIndex ?? '0'}`);
    chrome.storage.session.set({ pageContext: next }).catch(() => { });
    const nextSts = Number(next.sts);
    if (nextSts > 20000 && nextSts !== lastPersistedSts) {
      lastPersistedSts = nextSts;
      chrome.storage.local.set({ lastKnownSts: nextSts }).catch(() => { });
    }
  }
}


// ─── OAUTH 2.0 DEVICE FLOW (TVHTML5) ─────────────────────────────────
const OAUTH_CLIENTS = {
  TVHTML5: {
    storageKey: 'tvOAuthToken',
    clientId: '861556708454-d6dlm3lh05idd8npek18k6be8ba3oc68.apps.googleusercontent.com',
    clientSecret: 'SboVhoG9s0rNafixCSGGKXAT',
    scope: 'https://www.googleapis.com/auth/youtube'
  }
};

function resolveOAuthClientKey(clientType) {
  return (typeof clientType === 'string' && Object.prototype.hasOwnProperty.call(OAUTH_CLIENTS, clientType))
    ? clientType
    : 'TVHTML5';
}

const oauthPollSessions = {};
const pendingAuthKey = (clientType) => `pendingAuth_${clientType}`;

function savePendingAuth(clientType, pending) {
  chrome.storage.session.set({ [pendingAuthKey(clientType)]: pending }).catch(() => {});
}

function clearPendingAuth(clientType) {
  chrome.storage.session.remove(pendingAuthKey(clientType)).catch(() => {});
}

function stopPollingToken(clientType, clearSession = false) {
  const key = resolveOAuthClientKey(clientType);
  const session = oauthPollSessions[key];
  if (session) {
    session.cancelled = true;
    if (session.timerId) clearTimeout(session.timerId);
    oauthPollSessions[key] = null;
  }
  if (clearSession) {
    clearPendingAuth(key);
  }
}

async function requestDeviceCode(clientType = 'TVHTML5') {
  const key = resolveOAuthClientKey(clientType);
  const conf = OAUTH_CLIENTS[key];
  const resp = await fetch('https://oauth2.googleapis.com/device/code', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_id: conf.clientId,
      scope: conf.scope
    })
  });
  return await resp.json();
}

async function startPollingToken(
  clientType,
  device_code,
  interval = 5,
  expiresIn = 1800,
  user_code = null,
  resumeDeadline = null,
  initialDelayMs = null,
  lastPollAt = 0
) {
  const key = resolveOAuthClientKey(clientType);
  const conf = OAUTH_CLIENTS[key];
  stopPollingToken(key, false);

  let delaySec = Math.max(1, Number(interval) || 5);
  const ttlSec = Math.max(1, Number(expiresIn) || 1800);
  const deadline = Number.isFinite(resumeDeadline) ? resumeDeadline : (Date.now() + ttlSec * 1000);
  const session = {
    timerId: null,
    cancelled: false,
    user_code: user_code || null,
    device_code,
    interval: delaySec,
    deadline,
    lastPollAt: lastPollAt || Date.now()
  };
  oauthPollSessions[key] = session;

  const persistSessionState = () => {
    savePendingAuth(key, {
      user_code: session.user_code,
      device_code: session.device_code,
      interval: delaySec,
      deadline: session.deadline,
      lastPollAt: session.lastPollAt
    });
  };
  persistSessionState();

  return new Promise((resolve, reject) => {
    const scheduleNext = (overrideMs = null) => {
      if (session.cancelled) return;
      const waitMs = overrideMs !== null ? Math.max(50, overrideMs) : delaySec * 1000;
      if (Date.now() + waitMs > deadline) {
        stopPollingToken(key, true);
        reject('expired_token');
        return;
      }
      session.timerId = setTimeout(pollOnce, waitMs);
    };

    const pollOnce = async () => {
      if (session.cancelled) return;
      if (Date.now() >= deadline) {
        stopPollingToken(key, true);
        reject('expired_token');
        return;
      }
      session.lastPollAt = Date.now();
      persistSessionState();
      try {
        const resp = await fetch('https://oauth2.googleapis.com/token', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            client_id: conf.clientId,
            client_secret: conf.clientSecret,
            device_code: device_code,
            grant_type: 'urn:ietf:params:oauth:grant-type:device_code'
          })
        });
        const data = await resp.json();
        if (session.cancelled) return;

        if (data.access_token) {
          stopPollingToken(key, true);
          data.expires_at = Date.now() + (data.expires_in * 1000);
          await chrome.storage.local.set({ [conf.storageKey]: data });
          resolve(data);
        } else if (data.error === 'slow_down') {
          delaySec += 5;
          session.interval = delaySec;
          persistSessionState();
          scheduleNext();
        } else if (data.error === 'authorization_pending') {
          scheduleNext();
        } else {
          stopPollingToken(key, true);
          reject(data.error || 'Unknown error');
        }
      } catch (e) {
        stopPollingToken(key, true);
        reject(e.message);
      }
    };

    scheduleNext(initialDelayMs);
  });
}

const clientTokenCache = new Map();

async function getClientAccessToken(clientType) {
  const conf = OAUTH_CLIENTS[clientType];
  if (!conf) return null;

  let token = clientTokenCache.has(conf.storageKey) ? clientTokenCache.get(conf.storageKey) : undefined;
  if (token === undefined) {
    const storage = await chrome.storage.local.get(conf.storageKey);
    token = storage[conf.storageKey] || null;
    clientTokenCache.set(conf.storageKey, token);
  }
  if (!token || !token.access_token) return null;

  const expiresAt = Number(token.expires_at);
  const needsRefresh = !Number.isFinite(expiresAt) || Date.now() > expiresAt - 5 * 60 * 1000;

  if (needsRefresh) {
    if (!token.refresh_token) {
      return null;
    }
    try {
      const resp = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          client_id: conf.clientId,
          client_secret: conf.clientSecret,
          refresh_token: token.refresh_token,
          grant_type: 'refresh_token'
        })
      });
      const data = await resp.json();
      if (data.access_token) {
        token = {
          ...token,
          access_token: data.access_token,
          expires_in: data.expires_in,
          expires_at: Date.now() + (data.expires_in * 1000),
        };
        clientTokenCache.set(conf.storageKey, token);
        await chrome.storage.local.set({ [conf.storageKey]: token });
        console.log(TAG, `[OAuth] refreshed ${clientType} access_token, valid ${Math.round(data.expires_in / 60)}min`);
      } else {
        if (data.error === 'invalid_grant') {
          clientTokenCache.set(conf.storageKey, null);
          await chrome.storage.local.remove(conf.storageKey).catch(() => {});
        }
        return null;
      }
    } catch (e) {
      return null;
    }
  }
  return token.access_token;
}

// ─── DECLARATIVENETREQUEST: HEADER SPOOFING ──────────────────────────
const ORIGIN_RULE_ID       = 9000;
const MEDIA_RULE_ID_BASE   = 9100;
const SABR_BLOCK_RULE_ID   = 9200;
const BLACKLIST_BLOCK_RULE_ID = 9201;
const SW_BLOCK_RULE_ID     = 9300;
const API_UA_RULE_ID_BASE  = 9400;
const CORS_RULE_ID         = 9500;
const CORS_YTM_RULE_ID     = 9501;

// Persistent rules:
// 1. Spoof Origin/Referer/Sec-Fetch-* headers on ALL player API requests
// 2. Spoof User-Agent on the SW's own player API request, per client. Each client
//    tags its request URL with `_ytss_c=<idx>` and gets its OWN rule matching that
//    tag, so all clients can be resolved in parallel without clobbering each other.
// 3. Spoof User-Agent on googlevideo.com media segment fetches based on the client
//    ('c=' parameter). Without this, googlevideo.com returns 403 for TV/Mobile URLs
//    played on Desktop.
let _setupRulesChain = Promise.resolve();

async function setupStaticRules(force = false) {
  const run = async () => {
    try {
      const [storage, existingRules, sessionMeta] = await Promise.all([
        chrome.storage.local.get('enabled'),
        chrome.declarativeNetRequest.getSessionRules(),
        chrome.storage.session.get('dnrMeta').catch(() => ({})),
      ]);
      const existingIds = existingRules.map(r => r.id);
      const isEnabled = storage.enabled !== false;
      const dnrMeta = sessionMeta?.dnrMeta;

      if (!force && dnrMeta?.version === VERSION && dnrMeta?.enabled === isEnabled) {
        const hasCoreRules = !isEnabled
          ? existingIds.length === 0
          : existingIds.length === dnrMeta.count && existingIds.includes(ORIGIN_RULE_ID);
        if (hasCoreRules) return;
      }

      // Always clear any lingering/legacy dynamic rules (e.g. wildcard CORS rules with id 101)
      if (force || dnrMeta?.version !== VERSION) {
        try {
          const existingDynamic = await chrome.declarativeNetRequest.getDynamicRules();
          if (existingDynamic.length > 0) {
            await chrome.declarativeNetRequest.updateDynamicRules({
              removeRuleIds: existingDynamic.map(r => r.id),
              addRules: [],
            });
            console.log(TAG, '[DNR] Cleaned up ' + existingDynamic.length + ' stale dynamic rules.');
          }
        } catch (e) {}
      }

      if (!isEnabled) {
        if (existingIds.length > 0) {
          await chrome.declarativeNetRequest.updateSessionRules({
            removeRuleIds: [...new Set(existingIds)],
            addRules: [],
          });
        }
        chrome.storage.session.set({ dnrMeta: { version: VERSION, enabled: false, count: 0 } }).catch(() => {});
        console.log(TAG, 'Extension is DISABLED: Wiped all declarativeNetRequest rules.');
        return;
      }

    const ITAG_774_MEDIA_RULE_ID = 9195;
    const YTM_STATS_BLOCK_RULE_ID = 9196;
    const YTM_FRAME_RULE_ID = 9197;
    const YTM_API_RULE_ID = 9198;
    const WEB_REMIX_MEDIA_RULE_ID = 9199;
    const TVHTML5_MEDIA_RULE_ID = 9193;
    const rulesToAdd = [];
    const rulesToRemove = [...existingIds, ORIGIN_RULE_ID, TVHTML5_MEDIA_RULE_ID, ITAG_774_MEDIA_RULE_ID, YTM_STATS_BLOCK_RULE_ID, YTM_FRAME_RULE_ID, YTM_API_RULE_ID, WEB_REMIX_MEDIA_RULE_ID, SABR_BLOCK_RULE_ID, BLACKLIST_BLOCK_RULE_ID, SW_BLOCK_RULE_ID, CORS_RULE_ID, CORS_YTM_RULE_ID];

    // 1. Origin spoofing for www.youtube.com API requests.
    rulesToAdd.push({
      id: ORIGIN_RULE_ID,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'set', value: 'https://www.youtube.com' },
          { header: 'Referer', operation: 'set', value: 'https://www.youtube.com/' },
          { header: 'Sec-Fetch-Site', operation: 'set', value: 'same-origin' },
          { header: 'Sec-Fetch-Mode', operation: 'set', value: 'cors' },
        ],
      },
      condition: {
        urlFilter: '*youtubei/v1/player*',
        excludedRequestDomains: ['music.youtube.com'],
        resourceTypes: ['xmlhttprequest', 'other'],
      },
    });

    // 1b. Dedicated Origin & Referer for music.youtube.com API requests
    rulesToAdd.push({
      id: YTM_API_RULE_ID,
      priority: 10,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'set', value: 'https://music.youtube.com' },
          { header: 'Referer', operation: 'set', value: 'https://music.youtube.com/' },
          { header: 'Sec-Fetch-Site', operation: 'set', value: 'same-origin' },
          { header: 'Sec-Fetch-Mode', operation: 'set', value: 'cors' },
        ],
      },
      condition: {
        urlFilter: '*music.youtube.com/youtubei/v1/*',
        resourceTypes: ['xmlhttprequest', 'other'],
      },
    });

    // 1c. Remove frame restrictions for music.youtube.com in the offscreen harvester ONLY.
    // tabIds: [TAB_ID_NONE] limits this to requests that do not belong to a tab
    // (our offscreen document). Without it, any website could frame
    // music.youtube.com with the user's session (clickjacking / data leak).
    rulesToAdd.push({
      id: YTM_FRAME_RULE_ID,
      priority: 25,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'X-Frame-Options', operation: 'remove' },
          { header: 'Content-Security-Policy', operation: 'remove' },
        ],
      },
      condition: {
        urlFilter: '*music.youtube.com/*',
        resourceTypes: ['sub_frame'],
        tabIds: [chrome.tabs.TAB_ID_NONE],
      },
    });

    // 1d. Block playback telemetry and heartbeat from music.youtube.com to prevent
    // triggering concurrent stream limits (TOO_MANY_STREAMS_PER_USER)
    rulesToAdd.push({
      id: YTM_STATS_BLOCK_RULE_ID,
      priority: 30,
      action: { type: 'block' },
      condition: {
        regexFilter: '^https?://music\\.youtube\\.com/(?:api/stats/|youtubei/v1/playback/)',
        resourceTypes: ['xmlhttprequest', 'ping', 'other'],
      },
    });

    // 2. Per-client User-Agent for the player API request.
    CLIENTS.forEach((c) => {
      const ruleId = API_UA_RULE_ID_BASE + c.idx;
      rulesToRemove.push(ruleId);
      if (!c.ua) return;

      rulesToAdd.push({
        id: ruleId,
        priority: 20,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'User-Agent', operation: 'set', value: c.ua },
          ],
        },
        condition: {
          urlFilter: `*youtubei/v1/player*_ytss_c=${c.idx}*`,
          resourceTypes: ['xmlhttprequest', 'other'],
        },
      });
    });

    // 3. Media segment User-Agent spoofing for each client.
    CLIENTS.forEach((c) => {
      const ruleId = MEDIA_RULE_ID_BASE + c.idx;
      rulesToRemove.push(ruleId);
      if (!c.ua) return;

      rulesToAdd.push({
        id: ruleId,
        priority: 2,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [
            { header: 'User-Agent', operation: 'set', value: c.ua }
          ],
          responseHeaders: [
            { header: 'Access-Control-Allow-Origin', operation: 'set', value: 'https://www.youtube.com' },
            { header: 'Access-Control-Allow-Credentials', operation: 'set', value: 'true' },
            { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS, POST' },
            { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' },
            { header: 'Access-Control-Expose-Headers', operation: 'set', value: 'Content-Length, Content-Range, Accept-Ranges, Client-Protocol, Content-Type, X-Bandwidth-Est, X-Bandwidth-Est2, X-Bandwidth-Est3, X-Head-Time-Millis, X-Head-Seqnum, X-Response-Itag, X-Segment-Lmt, X-Walltime-Ms' },
          ],
        },
        condition: {
          regexFilter: `^https?://.*\\.googlevideo\\.com/(?:videoplayback|initplayback).*(?:[?&]c=|/c/)${c.clientName}(?:[&/]|$)`,
          initiatorDomains: ['youtube.com'],
          excludedInitiatorDomains: ['music.youtube.com'],
          resourceTypes: ['xmlhttprequest', 'media', 'other', 'main_frame', 'sub_frame'],
        },
      });
    });

    // 3b. Origin & Referer spoofing for WEB_REMIX media streams (prevents 403 on googlevideo.com)
    rulesToAdd.push({
      id: WEB_REMIX_MEDIA_RULE_ID,
      priority: 15,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://music.youtube.com/' },
          { header: 'Origin', operation: 'set', value: 'https://music.youtube.com' },
        ],
        responseHeaders: [
          { header: 'Access-Control-Allow-Origin', operation: 'set', value: 'https://www.youtube.com' },
          { header: 'Access-Control-Allow-Credentials', operation: 'set', value: 'true' },
          { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
          { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' },
          { header: 'Access-Control-Expose-Headers', operation: 'set', value: 'Content-Length, Content-Range, Accept-Ranges' },
        ],
      },
      condition: {
        regexFilter: '^https?://.*\\.googlevideo\\.com/videoplayback.*(?:[?&]c=|/c/)WEB_REMIX(?:[&/]|.*)',
        initiatorDomains: ['youtube.com'],
        excludedInitiatorDomains: ['music.youtube.com'],
        resourceTypes: ['media', 'xmlhttprequest', 'other'],
      },
    });

    // 3c. Dedicated rule for all ITAG 774 media streams (unconditional music referer, UA, and CORS)
    rulesToAdd.push({
      id: ITAG_774_MEDIA_RULE_ID,
      priority: 25,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Referer', operation: 'set', value: 'https://music.youtube.com/' },
          { header: 'Origin', operation: 'set', value: 'https://music.youtube.com' },
          { header: 'User-Agent', operation: 'set', value: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36' },
        ],
        responseHeaders: [
          { header: 'Access-Control-Allow-Origin', operation: 'set', value: 'https://www.youtube.com' },
          { header: 'Access-Control-Allow-Credentials', operation: 'set', value: 'true' },
          { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
          { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' },
          { header: 'Access-Control-Expose-Headers', operation: 'set', value: 'Content-Length, Content-Range, Accept-Ranges' },
        ],
      },
      condition: {
        regexFilter: '^https?://.*\\.googlevideo\\.com/videoplayback.*(?:[?&]itag=|/itag/)774(?:[&/]|.*)',
        initiatorDomains: ['youtube.com'],
        excludedInitiatorDomains: ['music.youtube.com'],
        resourceTypes: ['media', 'xmlhttprequest', 'other'],
      },
    });

    // 3d. Dedicated rule for all TVHTML5 media & SABR streams (Smart-TV UA and CORS)
    rulesToRemove.push(TVHTML5_MEDIA_RULE_ID);
    rulesToAdd.push({
      id: TVHTML5_MEDIA_RULE_ID,
      priority: 30,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'User-Agent', operation: 'set', value: 'Mozilla/5.0 (SMART-TV; Linux; Tizen 5.0) AppleWebKit/538.1 (KHTML, like Gecko) Version/5.0 TV Safari/538.1' },
        ],
        responseHeaders: [
          { header: 'Access-Control-Allow-Origin', operation: 'set', value: 'https://www.youtube.com' },
          { header: 'Access-Control-Allow-Credentials', operation: 'set', value: 'true' },
          { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS, POST' },
          { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' },
          { header: 'Access-Control-Expose-Headers', operation: 'set', value: 'Content-Length, Content-Range, Accept-Ranges, Client-Protocol, Content-Type, X-Bandwidth-Est, X-Bandwidth-Est2, X-Bandwidth-Est3, X-Head-Time-Millis, X-Head-Seqnum, X-Response-Itag, X-Segment-Lmt, X-Walltime-Ms' },
        ],
      },
      condition: {
        regexFilter: '^https?://.*\\.googlevideo\\.com/(?:videoplayback|initplayback).*(?:[?&]c=|/c/)TVHTML5(?:[&/]|.*)',
        resourceTypes: ['media', 'xmlhttprequest', 'other'],
      },
    });

    // 4. Block the streaming_data_emergency_itag_blacklist endpoint on www.youtube.com.
    rulesToRemove.push(BLACKLIST_BLOCK_RULE_ID);
    rulesToAdd.push({
      id: BLACKLIST_BLOCK_RULE_ID,
      priority: 5,
      action: { type: 'block' },
      condition: {
        urlFilter: '*streaming_data_emergency_itag_blacklist*',
        resourceTypes: ['xmlhttprequest', 'other'],
      },
    });

    // 5. Block YouTube Service Worker on www.youtube.com ONLY (Never block music.youtube.com)
    rulesToRemove.push(SW_BLOCK_RULE_ID);
    rulesToAdd.push({
      id: SW_BLOCK_RULE_ID,
      priority: 6,
      action: { type: 'block' },
      condition: {
        regexFilter: '^https?://www\\.youtube\\.com/sw\\.js',
        resourceTypes: ['script', 'other', 'xmlhttprequest'],
      },
    });

    // 6a. Enable CORS headers for googlevideo.com so Web Audio API FFT analyser can measure full spectrum on YouTube
    rulesToRemove.push(CORS_RULE_ID);
    rulesToAdd.push({
      id: CORS_RULE_ID,
      priority: 10,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'Access-Control-Allow-Origin', operation: 'set', value: 'https://www.youtube.com' },
          { header: 'Access-Control-Allow-Credentials', operation: 'set', value: 'true' },
          { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
          { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' },
          { header: 'Access-Control-Expose-Headers', operation: 'set', value: 'Content-Length, Content-Range, Accept-Ranges' }
        ]
      },
      condition: {
        urlFilter: '||googlevideo.com',
        initiatorDomains: ['youtube.com'],
        excludedInitiatorDomains: ['music.youtube.com'],
        resourceTypes: ['xmlhttprequest', 'media', 'other']
      }
    });

    // 6b. Enable CORS headers for music.youtube.com so YTM harvester iframe & YTM playback don't fail
    rulesToRemove.push(CORS_YTM_RULE_ID);
    rulesToAdd.push({
      id: CORS_YTM_RULE_ID,
      priority: 10,
      action: {
        type: 'modifyHeaders',
        responseHeaders: [
          { header: 'Access-Control-Allow-Origin', operation: 'set', value: 'https://music.youtube.com' },
          { header: 'Access-Control-Allow-Credentials', operation: 'set', value: 'true' },
          { header: 'Access-Control-Allow-Methods', operation: 'set', value: 'GET, HEAD, OPTIONS' },
          { header: 'Access-Control-Allow-Headers', operation: 'set', value: '*' },
          { header: 'Access-Control-Expose-Headers', operation: 'set', value: 'Content-Length, Content-Range, Accept-Ranges' }
        ]
      },
      condition: {
        urlFilter: '||googlevideo.com',
        initiatorDomains: ['music.youtube.com'],
        resourceTypes: ['xmlhttprequest', 'media', 'other']
      }
    });

      await chrome.declarativeNetRequest.updateSessionRules({
        removeRuleIds: [...new Set(rulesToRemove)],
        addRules: rulesToAdd,
      });
      chrome.storage.session.set({ dnrMeta: { version: VERSION, enabled: true, count: rulesToAdd.length } }).catch(() => {});
      console.log(TAG, `Static DNR rules enabled (${rulesToAdd.length} rules: Origin + per-client API UA + Media UA + Blacklist/SW Block + CORS).`);
    } catch (e) {
      console.log(TAG, 'Failed to setup static rules:', e);
    }
  };
  _setupRulesChain = _setupRulesChain.then(run, run);
  return _setupRulesChain;
}

const OAUTH_STORAGE_KEYS = new Set(Object.values(OAUTH_CLIENTS).map(c => c.storageKey));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes) return;

  for (const key of OAUTH_STORAGE_KEYS) {
    if (changes[key] !== undefined) {
      clientTokenCache.delete(key);
    }
  }

  if (changes.enabled !== undefined) {
    setupStaticRules(true);
    if (changes.enabled.newValue === false) {
      console.log(TAG, '[Settings] Extension disabled — tearing down background SW state');
      harvestManager.cancelActive('EXTENSION_DISABLED');
      chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_HARVEST' }).catch(() => {});
      scheduleOffscreenClose(0);
      confirmedNo774Videos.clear();
      chrome.storage.session.get(null).then(all => {
        const hqKeys = Object.keys(all || {}).filter(k => k.startsWith('hq_') || k.startsWith('tvctx_') || k.startsWith('no774_'));
        if (hqKeys.length > 0) chrome.storage.session.remove(hqKeys).catch(() => {});
      }).catch(() => {});
    }
  }
  if (changes.operationMode !== undefined) {
    console.log(TAG, `[Settings] Operation mode changed to ${changes.operationMode.newValue}, clearing SW session cache`);
    confirmedNo774Videos.clear();
    chrome.storage.session.get(null).then(all => {
      const hqKeys = Object.keys(all || {}).filter(k => k.startsWith('hq_') || k.startsWith('tvctx_') || k.startsWith('no774_'));
      if (hqKeys.length > 0) chrome.storage.session.remove(hqKeys).catch(() => {});
    }).catch(() => {});
  }
});

// (setupStaticRules is called at the end of the file)

// ─── INNERTUBE NATIVE FETCHER ─────────────────────────────────────────
async function fetchFromClient(videoId, client, preloadedToken = undefined) {
  // This worker gets evicted after ~30s idle, and the FETCH_HQ that wakes it back up
  // races the session-storage restore. Without this await the first request after every
  // eviction goes out with no visitorData/authUser, InnerTube answers without the
  // Premium formats, and the page has no way to know it should re-send its context.
  await pageContextReady;
  const origin = 'https://www.youtube.com';
  let auth = null;
  let bearerToken = null;

  const isMobileClient = client.name.startsWith('ANDROID') || client.name === 'IOS';
  const isTVClient = client.name.startsWith('TVHTML5');

  // Auth strategy:
  // TVHTML5: Check TV login before fetch! If not logged into Premium -> skip TV client
  // WEB_REMIX / TVHTML5_SIMPLY: SAPISIDHASH
  // Mobile clients (ANDROID, IOS, etc.): No web SAPISIDHASH (causes HTTP 400 Bad Request)
  if (isTVClient) {
    bearerToken = preloadedToken !== undefined ? preloadedToken : await getClientAccessToken('TVHTML5');
    if (!bearerToken) {
      console.log(TAG, `[${client.name}] TV client requires login (Premium) -> Skipping fetch.`);
      return { source: client.name, error: 'NO_TV_LOGIN', audioFormats: [] };
    }
    auth = `Bearer ${bearerToken}`;
  }

  if (!auth && !isMobileClient) {
    auth = await getSapisidHash(origin);
  }

  // Headers — when using Bearer token or Mobile, omit web-only AuthUser/VisitorId
  const headers = {
    'Content-Type': 'application/json',
  };
  
  // Only Web and TV clients send client info in headers. Mobile clients only send it in the JSON body.
  if (!isMobileClient) {
    headers['X-Youtube-Client-Name'] = client.clientId;
    headers['X-Youtube-Client-Version'] = client.clientVersion;
  }
  if (!isMobileClient) {
    headers['X-Origin'] = origin;
  }
  if (!bearerToken && !isMobileClient) {
    headers['X-Goog-AuthUser'] = pageContext.sessionIndex ?? '0';
    if (pageContext.delegatedSessionId) {
      headers['X-Goog-PageId'] = pageContext.delegatedSessionId;
    }
  }

  // visitorData: send ONLY for WEB_REMIX when using web cookies.
  // Pairing Web visitorData with TV/Mobile clients causes "Video unavailable" or HTTP 400.
  const allowVisitorData = !bearerToken && !isMobileClient && client.name === 'WEB_REMIX';
  if (allowVisitorData && pageContext.visitorData) {
    headers['X-Goog-Visitor-Id'] = pageContext.visitorData;
  }
  if (auth) headers['Authorization'] = auth;

  // Payload — each client's own identity
  const clientObj = {
    clientName: client.clientName,
    clientVersion: client.clientVersion,
    hl: pageContext.hl || 'vi',
    gl: pageContext.gl || 'VN',
    ...client.extraContext,
  };
  if (client.ua) clientObj.userAgent = client.ua;
  if (allowVisitorData && pageContext.visitorData) clientObj.visitorData = pageContext.visitorData;

  // TVHTML5-specific client fields
  if (isTVClient) {
    clientObj.deviceCategory = 'TV';
    clientObj.clientFormFactor = 'LARGE_FORM_FACTOR';
  }

  // Build context — TVHTML5 needs user + request blocks to pass validation
  const context = { client: clientObj };
  if (isTVClient) {
    context.user = {
      lockedSafetyMode: false,
      audioQuality: 'AUDIO_QUALITY_HIGH'
    };
    context.request = {
      useSsl: true,
      internalExperimentFlags: [
        { key: 'tv_high_quality_audio', value: 'true' },
        { key: 'html5_audio_quality', value: 'high' }
      ]
    };
  }

  const payload = {
    context,
    videoId,
    contentCheckOk: true,
    racyCheckOk: true,
    playbackContext: {
      contentPlaybackContext: {
        ...(client.name !== 'WEB_REMIX' && { signatureTimestamp: pageContext.sts || 20767 }),
        audioQualityPreference: 'AUDIO_QUALITY_HIGH',
      },
    },
  };

  if (!isMobileClient || client.name === 'ANDROID_VR') {
    payload.playbackContext.contentPlaybackContext.html5Preference = 'HTML5_PREF_WANTS';
  }

  if (client.name === 'WEB_REMIX' && pageContext.poToken) {
    payload.serviceIntegrityDimensions = {
      poToken: pageContext.poToken
    };
    context.request = context.request || {};
    context.request.useSsl = true;
  }

  // Always include key=client.apiKey on the URL. InnerTube API gateway requires it for all clients.
  const url = `${origin}/youtubei/v1/player?key=${client.apiKey}&prettyPrint=false&_ytss_c=${client.idx}`;

  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
      credentials: bearerToken ? 'omit' : 'include',
    });

    if (!resp.ok) {
      console.log(TAG, `[${client.name}] HTTP ${resp.status} | Auth: ${auth ? auth.split(' ')[0] : 'none'}`);
      return { source: client.name, error: `HTTP ${resp.status}`, audioFormats: [] };
    }

    const data = await resp.json();

    if (data.playabilityStatus?.status === 'OK' && data.streamingData) {
      const allFormats = data.streamingData.adaptiveFormats || [];
      const audio = allFormats.filter(f => (f.mimeType || '').includes('audio/'));

      // _cver rides along so inject.js can restore the exact client version this URL
      // was signed under, instead of guessing from a table that can drift out of sync.
      const result = {
        source: client.name,
        audioFormats: audio.map(f => ({ ...f, _src: client.name, _cver: client.clientVersion })),
      };

      // ── Capture TVHTML5 streaming context.
      //    TVHTML5 returns a legitimately-signed SABR config that already contains
      //    774 in its format table. We persist the whole streamingData blob
      //    (minus the formats we already extracted) so inject.js can drive its own
      //    SABR session against the TV endpoint. Only capture for TVHTML5 (WEB/Android
      //    configs omit 774).
      if (isTVClient && data.streamingData.serverAbrStreamingUrl) {
        const ustreamerCfg = data.streamingData.ustreamerConfig
          || data.playerConfig?.mediaCommonConfig?.mediaUstreamerRequestConfig?.videoPlaybackUstreamerConfig
          || null;
        result.streamingContext = {
          source: client.name,
          clientVersion: client.clientVersion,
          serverAbrStreamingUrl: data.streamingData.serverAbrStreamingUrl,
          // ustreamerConfig is the signed SABR config blob. May be a base64 string
          // or an object depending on InnerTube variant; preserve as-is.
          ustreamerConfig: ustreamerCfg,
          // poToken / visitorData the TV session was negotiated under.
          // Echoed in SABR POST headers to avoid opaque 403s.
          poToken: pageContext.poToken || null,
          visitorData: data.responseContext?.visitorData || clientObj.visitorData || null,
          // Signature timestamp the TV player was signed under.
          sts: pageContext.sts || 20767,
          ts: Date.now(),
        };
        console.log(TAG, `[${client.name}] captured streamingContext: sabrUrl=present ustreamerConfig=${ustreamerCfg ? 'present' : 'absent'}`);
      }

      return result;
    }

    const reason = data.playabilityStatus?.reason || data.playabilityStatus?.status || 'No Stream';
    return { source: client.name, error: reason, audioFormats: [] };
  } catch (err) {
    return { source: client.name, error: err.message, audioFormats: [] };
  }
}

// ─── OFFSCREEN HARVESTER & WEBREQUEST LISTENER ───────────────────────
let offscreenIdleTimer = null;

function scheduleOffscreenClose(delayMs = 180000) {
  if (offscreenIdleTimer) clearTimeout(offscreenIdleTimer);
  offscreenIdleTimer = setTimeout(async () => {
    offscreenIdleTimer = null;
    if (harvestManager.isActive() || harvestManager.pendingCount > 0) return;
    if (chrome.offscreen && chrome.offscreen.hasDocument && await chrome.offscreen.hasDocument()) {
      try {
        await chrome.offscreen.closeDocument();
        console.log(TAG, '[Harvester] Offscreen document auto-slept (closed after 180s idle to free RAM)');
      } catch (e) {}
    }
  }, delayMs);
}

async function ensureOffscreenDocument() {
  if (offscreenIdleTimer) {
    clearTimeout(offscreenIdleTimer);
    offscreenIdleTimer = null;
  }
  if (chrome.offscreen) {
    if (await chrome.offscreen.hasDocument?.()) {
      return;
    }
    try {
      await chrome.offscreen.createDocument({
        url: chrome.runtime.getURL('src/harvester.html'),
        reasons: ['IFRAME_SCRIPTING', 'DOM_PARSER', 'AUDIO_PLAYBACK'],
        justification: 'Harvest HQ audio streams from YouTube Music and TV',
      });
      console.log(TAG, '[Harvester] Offscreen document created on-demand');
    } catch (err) {
      if (!err.message?.includes('Only a single offscreen document may be created')) {
        console.log(TAG, '[Harvester] Offscreen creation notice:', err);
      }
    }
  }
}

const HARVESTER_URL = chrome.runtime.getURL('src/harvester.html');

// Single source of truth for offscreen harvest sessions. Guarantees:
//  - at most one active session; a new track cancels the old session with an
//    explicit CANCELLED outcome, so old results can never reach the new track;
//  - the 8s timeout only yields TIMEOUT (never a "confirmed no 774" verdict);
//  - every session settles exactly once and always tears the iframe down.
const harvestManager = createHarvestManager({
  log: (...a) => console.log(TAG, '[Harvest]', ...a),
  ensureOffscreen: ensureOffscreenDocument,
  sendToOffscreen: (msg) => chrome.runtime.sendMessage(msg),
  scheduleIdleClose: () => scheduleOffscreenClose(),
  runtimeId: chrome.runtime.id,
  harvesterUrl: HARVESTER_URL,
});

async function harvestViaYtm(videoId) {
  // Same-video duplicate requests join the in-flight session instead of
  // spawning a second harvester iframe.
  return harvestManager.start(videoId);
}

if (chrome.webRequest && chrome.webRequest.onBeforeRequest) {
  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      const url = details.url;
      if (!url || !url.includes('videoplayback')) return;

      // STRICT: ONLY intercept genuine ITAG 774 Opus ~280kbps
      const is774 = url.includes('itag=774') || url.includes('/itag/774');
      if (!is774) return;

      // CRITICAL: Only intercept requests originating from the offscreen
      // harvester document (tabId === -1). Never touch the user's active
      // YouTube tab (tabId >= 0) or anything initiated by www.youtube.com.
      if (details.tabId !== -1) return;
      if (details.initiator && details.initiator.includes('www.youtube.com')) return;

      console.log(TAG, `[WebRequest] Intercepted deciphered ITAG 774 stream for ${harvestManager.getActiveVideoId()}`);
      harvestManager.deliverWebRequest(url);
    },
    { urls: ["*://*.googlevideo.com/videoplayback*"] }
  );
}

// ─── MESSAGE HANDLER ─────────────────────────────────────────────────
const VALID_OP_MODES = new Set(['HYBRID_HQ', 'YTM_HARVESTER', 'TV_HEADLESS', 'TV_UMP_MSE', 'TV_RELAY', 'AUTO']);

// Map a terminal harvest outcome to the page-facing error string and flags.
// CANCELLED / TIMEOUT / illegal-data are deliberately distinct so the page
// never mistakes a transient ending for a confirmed absence of 774.
function harvestFailureResponse(outcome, opMode) {
  const base = { success: false, results: [], confirmedNo774: false, opMode };
  switch (outcome) {
    case HARVEST_OUTCOME.CANCELLED:
      return { ...base, error: 'HARVEST_CANCELLED', cancelled: true, timedOut: false, invalidData: false };
    case HARVEST_OUTCOME.TIMEOUT:
      return { ...base, error: 'HARVEST_TIMEOUT', cancelled: false, timedOut: true, invalidData: false };
    case HARVEST_OUTCOME.FAILED:
      return { ...base, error: 'HARVEST_INVALID_DATA', cancelled: false, timedOut: false, invalidData: true };
    default:
      return { ...base, error: 'HARVEST_INVALID_DATA', cancelled: false, timedOut: false, invalidData: true };
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender?.id !== chrome.runtime.id) return;

  if (msg.type === 'OFFSCREEN_HARVEST_SUCCESS') {
    // Strict source + payload validation lives inside the manager: the message
    // must come from our own offscreen document AND carry an https
    // googlevideo.com videoplayback URL with itag 774. Anything else is
    // refused with received:false and can never reach the player.
    const received = harvestManager.handleHarvestSuccess(msg, sender);
    sendResponse({ received });
    return true;
  }

  if (msg.type === 'OFFSCREEN_HARVEST_ABORT') {
    const received = harvestManager.handleHarvestAbort(msg, sender);
    sendResponse({ received });
    return true;
  }

  if (msg.type === 'CONFIRM_NO_774') {
    const { videoId } = msg;
    if (videoId && /^[\w-]{11}$/.test(videoId)) {
      confirmedNo774Videos.add(videoId);
      chrome.storage.session.remove([`hq_${videoId}`, `tvctx_${videoId}`]).catch(() => {});
      console.log(TAG, `[CONFIRM_NO_774] Video ${videoId} temporarily marked as NO 774 in SW (ephemeral).`);
    }
    sendResponse({ received: true });
    return true;
  }

  if (msg.type === 'GET_LOCALE') {
    const l = VALID_LOCALES.has(msg.lang) ? msg.lang : 'en';
    if (localeCache.has(l)) {
      sendResponse({ success: true, lang: l, strings: localeCache.get(l) });
      return true;
    }
    (async () => {
      try {
        let url = chrome.runtime.getURL(`locales/${l}.json`);
        let res = await fetch(url);
        if (!res.ok && l !== 'en') {
          url = chrome.runtime.getURL('locales/en.json');
          res = await fetch(url);
        }
        if (res.ok) {
          const strings = await res.json();
          localeCache.set(l, strings);
          sendResponse({ success: true, lang: l, strings });
          return;
        }
      } catch (err) {
        void err;
      }
      sendResponse({ success: false });
    })();
    return true;
  }

  if (msg.type === 'CLEAR_VIDEO_CACHE') {
    const { videoId } = msg;
    if (videoId && /^[\w-]{11}$/.test(videoId)) {
      chrome.storage.session.remove([`hq_${videoId}`, `tvctx_${videoId}`, `no774_${videoId}`]).catch(() => {});
      confirmedNo774Videos.delete(videoId);
    } else if (!videoId) {
      confirmedNo774Videos.clear();
    }
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === 'OFFSCREEN_STOP_HARVEST') {
    harvestManager.cancelActive('MANUAL_STOP');
    chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_HARVEST' }).catch(() => {});
    scheduleOffscreenClose();
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === 'RELOAD_RULES') {
    setupStaticRules(true).then(() => sendResponse({ success: true })).catch(() => sendResponse({ success: false }));
    return true;
  }

  if (msg.type === 'RELOAD_EXTENSION') {
    // Only extension pages (popup) may reload the extension. Content scripts in
    // youtube.com tabs must not, or any page script could loop it as a DoS.
    if (sender.id !== chrome.runtime.id || sender.tab) {
      sendResponse({ success: false });
      return true;
    }
    chrome.runtime.reload();
    sendResponse({ success: true });
    return true;
  }

  if (msg.type === 'FETCH_HQ') {
    const { videoId, title, author, preferredSource, excludeSource, forceFresh } = msg;
    // Ignore anything that isn't a real 11-char YouTube ID.
    if (!/^[\w-]{11}$/.test(videoId || '')) {
      sendResponse({ success: false, results: [], error: 'invalid videoId' });
      return true;
    }

    // Ephemeral single-track tracking: clear if new videoId is requested or forced fresh
    if (currentNo774VideoId && currentNo774VideoId !== videoId) {
      confirmedNo774Videos.clear();
    }
    if (forceFresh) {
      confirmedNo774Videos.delete(videoId);
    }

    if (confirmedNo774Videos.has(videoId)) {
      console.log(TAG, `[FETCH_HQ] Video ${videoId} is temporarily confirmed to have NO 774. SW doing nothing.`);
      sendResponse({ success: false, results: [], error: 'NO_774_STREAM', confirmedNo774: true });
      return true;
    }

    if (msg.context) setPageContext(msg.context);

    (async () => {
      const storage = await chrome.storage.local.get(['preferredClient', 'enabled', 'operationMode']);
      if (storage.enabled === false) {
        sendResponse({ success: false, results: [], error: 'disabled' });
        return;
      }

      // msg.opMode comes from the page; only accept known modes.
      const requestedMode = VALID_OP_MODES.has(msg.opMode) ? msg.opMode : null;
      let opMode = requestedMode || storage.operationMode || 'HYBRID_HQ';
      if (opMode === 'TV_UMP_MSE') opMode = 'TV_HEADLESS';

      const isModeStale = async () => {
        const cur = await chrome.storage.local.get(['enabled', 'operationMode']);
        if (cur.enabled === false) return true;
        let curOp = cur.operationMode || 'HYBRID_HQ';
        if (curOp === 'TV_UMP_MSE') curOp = 'TV_HEADLESS';
        return curOp !== opMode;
      };

      const tvClient = CLIENTS.find(c => c.name === 'TVHTML5');

      // ── HYBRID MODE: HYBRID_HQ (Bidirectional Smart Failover: TV UMP MSE <-> YTM Harvester)
      if (opMode === 'HYBRID_HQ') {
        const PROV_YTM = 'YTM_HARVESTER';
        const PROV_TV = 'TVHTML5';

        // Per-provider status records feeding isNo774Confirmed(). 'skipped'
        // means the provider was not applicable (excluded or no TV login) and
        // therefore cannot contribute to a positive no-774 verdict.
        const sourceStatuses = [];
        const tvToken = excludeSource === PROV_TV ? null : await getClientAccessToken('TVHTML5');
        const tvEligible = Boolean(tvToken);
        const ytmEligible = excludeSource !== PROV_YTM;
        sourceStatuses.push({ provider: PROV_TV, status: tvEligible ? null : 'skipped' });
        sourceStatuses.push({ provider: PROV_YTM, status: ytmEligible ? null : 'skipped' });
        const setStatus = (provider, status) => {
          const rec = sourceStatuses.find(s => s.provider === provider);
          if (rec) rec.status = status;
        };

        let winner = null;            // { source, audioFormats, streamingContext }
        let ytmOutcome = null;        // raw terminal outcome from the harvest manager

        const tryYtm = async () => {
          console.log(TAG, `[FETCH_HQ] [Hybrid] Hunting for 774 via YTM Harvester on ${videoId}...`);
          const r = await harvestViaYtm(videoId);
          ytmOutcome = r;
          if (r?.outcome === HARVEST_OUTCOME.SUCCESS && r.formats?.some(f => f.itag === 774)) {
            setStatus(PROV_YTM, 'success');
            winner = { source: PROV_YTM, audioFormats: r.formats, streamingContext: null };
            return;
          }
          if (r?.outcome === HARVEST_OUTCOME.NO_774) {
            setStatus(PROV_YTM, 'no774');
          } else if (r?.outcome === HARVEST_OUTCOME.CANCELLED) {
            setStatus(PROV_YTM, 'cancelled');
          } else if (r?.outcome === HARVEST_OUTCOME.TIMEOUT) {
            setStatus(PROV_YTM, 'timeout');
          } else {
            setStatus(PROV_YTM, 'failed');
          }
        };

        const tryTv = async () => {
          if (!tvEligible) {
            console.log(TAG, `[FETCH_HQ] [Hybrid] TV client skipped (excluded or no TV login)`);
            return;
          }
          console.log(TAG, `[FETCH_HQ] [Hybrid] Checking TV client for ${videoId} with Premium login...`);
          try {
            const tvRes = tvClient ? await fetchFromClient(videoId, tvClient, tvToken) : null;
            if (tvRes?.audioFormats?.some(f => f.itag === 774)) {
              setStatus(PROV_TV, 'success');
              winner = { source: PROV_TV, audioFormats: tvRes.audioFormats, streamingContext: tvRes?.streamingContext || null };
              return;
            }
            // The InnerTube call completed normally and returned no 774 format:
            // a positive verdict. HTTP errors return empty audioFormats + error
            // and are treated as inconclusive instead.
            if (tvRes && !tvRes.error) setStatus(PROV_TV, 'no774');
            else setStatus(PROV_TV, 'failed');
          } catch (e) {
            console.log(TAG, `[FETCH_HQ] [Hybrid] TV client fallback:`, e);
            setStatus(PROV_TV, 'failed');
          }
        };

        // Preserve the original provider ordering/preferences.
        const tvTokenAvailable = tvEligible;
        let firstProv = tvTokenAvailable ? PROV_TV : PROV_YTM;
        let secondProv = tvTokenAvailable ? PROV_YTM : null;

        if (excludeSource === PROV_YTM) {
          firstProv = PROV_TV;
          secondProv = null;
        } else if (excludeSource === PROV_TV) {
          firstProv = PROV_YTM;
          secondProv = null;
        } else if (preferredSource === PROV_YTM) {
          firstProv = PROV_YTM;
          secondProv = tvTokenAvailable ? PROV_TV : null;
        } else if (preferredSource === PROV_TV) {
          firstProv = PROV_TV;
          secondProv = PROV_YTM;
        }

        const runProvider = async (p) => {
          if (p === PROV_YTM) await tryYtm();
          else await tryTv();
        };
        const eligibleProviders = [firstProv, secondProv].filter(p =>
          p && ((p === PROV_YTM && ytmEligible) || (p === PROV_TV && tvEligible))
        );

        for (const prov of eligibleProviders) {
          if (winner) break;
          // A cancelled harvest means the user already switched tracks: stop
          // immediately, never run another source for the obsolete video.
          if (ytmOutcome?.outcome === HARVEST_OUTCOME.CANCELLED) break;
          console.log(TAG, `[FETCH_HQ] [Hybrid] Trying provider ${prov} for ${videoId}`);
          await runProvider(prov);
        }

        if (winner) {
          console.log(TAG, `[FETCH_HQ] [Hybrid] Successfully acquired ITAG 774 via ${winner.source} for ${videoId}`);
          chrome.storage.session.set({
            [`hq_${videoId}`]: {
              videoId,
              formats: winner.audioFormats,
              streamingContext: winner.streamingContext,
              source: winner.source,
              ts: Date.now()
            }
          }).catch(() => {});
          if (winner.streamingContext) {
            chrome.storage.session.set({ [`tvctx_${videoId}`]: winner.streamingContext }).catch(() => {});
          }
          sendResponse({
            success: true,
            results: [{ source: winner.source, audioFormats: winner.audioFormats }],
            streamingContext: winner.streamingContext,
            opMode: 'HYBRID_HQ',
            usedSource: winner.source
          });
          return;
        }

        // Cancellation is a distinct ending: never write the no-774 marker.
        if (ytmOutcome?.outcome === HARVEST_OUTCOME.CANCELLED) {
          console.log(TAG, `[FETCH_HQ] [Hybrid] Harvest cancelled for ${videoId} (not marking confirmedNo774).`);
          sendResponse({
            success: false, results: [], error: 'HARVEST_CANCELLED',
            confirmedNo774: false, cancelled: true, timedOut: false, invalidData: false, opMode: 'HYBRID_HQ'
          });
          return;
        }

        // Timeout only means "we did not get an answer in time" — never a
        // positive no-774 verdict.
        if (ytmOutcome?.outcome === HARVEST_OUTCOME.TIMEOUT || await isModeStale()) {
          console.log(TAG, `[FETCH_HQ] [Hybrid] Harvest timed out / superseded for ${videoId} (not marking confirmedNo774).`);
          sendResponse({
            success: false, results: [], error: 'HARVEST_TIMEOUT',
            confirmedNo774: false, cancelled: false, timedOut: true,
            invalidData: Boolean(ytmOutcome?.rejectedMessages), opMode: 'HYBRID_HQ'
          });
          return;
        }

        // Illegal/inconclusive data ending (offscreen messaging failure etc.).
        if (ytmOutcome?.outcome === HARVEST_OUTCOME.FAILED) {
          console.log(TAG, `[FETCH_HQ] [Hybrid] Harvest failed inconclusively for ${videoId} (not marking confirmedNo774).`);
          sendResponse({
            success: false, results: [], error: 'HARVEST_INVALID_DATA',
            confirmedNo774: false, cancelled: false, timedOut: false, invalidData: true, opMode: 'HYBRID_HQ'
          });
          return;
        }

        // Only when EVERY APPLICABLE source finished normally and positively
        // reported no 774 do we write the temporary confirmed-no-774 marker.
        if (isNo774Confirmed(sourceStatuses)) {
          console.log(TAG, `[FETCH_HQ] [Hybrid] All applicable sources confirmed NO 774 for ${videoId} -> retaining native stream (ITAG 251).`);
          confirmedNo774Videos.add(videoId);
          sendResponse({
            success: false, results: [], error: 'NO_774_STREAM',
            confirmedNo774: true, cancelled: false, timedOut: false, invalidData: false, opMode: 'HYBRID_HQ'
          });
          return;
        }

        // Defensive fallback: anything not covered above is inconclusive and
        // must never poison the single-track no-774 marker.
        console.log(TAG, `[FETCH_HQ] [Hybrid] Inconclusive harvest for ${videoId} (not marking confirmedNo774).`);
        sendResponse({
          success: false, results: [], error: 'HARVEST_INVALID_DATA',
          confirmedNo774: false, cancelled: false, timedOut: false, invalidData: true, opMode: 'HYBRID_HQ'
        });
      }

      // ── MODE: YTM_HARVESTER (Direct 774 Opus from YouTube Music)
      if (opMode === 'YTM_HARVESTER') {
        console.log(TAG, `[FETCH_HQ] Mode (YTM_HARVESTER) harvesting for exact video ${videoId}...`);
        const harvest = await harvestViaYtm(videoId);

        if (harvest?.outcome === HARVEST_OUTCOME.SUCCESS && harvest.formats?.some(f => f.itag === 774)) {
          const formats = harvest.formats;
          console.log(TAG, `[FETCH_HQ] YTM_HARVESTER successfully harvested 774 for exact video ${videoId}!`);
          const results = [{ source: 'YTM_HARVESTER', audioFormats: formats }];
          chrome.storage.session.set({
            [`hq_${videoId}`]: { videoId, formats, streamingContext: null, ts: Date.now() }
          }).catch(() => {});
          sendResponse({ success: true, results, streamingContext: null, opMode: 'YTM_HARVESTER' });
          return;
        }

        if (harvest?.outcome === HARVEST_OUTCOME.NO_774) {
          // Only the single source's positive verdict writes the marker.
          console.log(TAG, `[FETCH_HQ] YTM_HARVESTER: source confirmed NO 774 for ${videoId}.`);
          confirmedNo774Videos.add(videoId);
          sendResponse({
            success: false, results: [], error: 'NO_774_STREAM',
            confirmedNo774: true, cancelled: false, timedOut: false, invalidData: false, opMode: 'YTM_HARVESTER'
          });
          return;
        }

        if (await isModeStale()) {
          console.log(TAG, `[FETCH_HQ] YTM_HARVESTER: mode changed mid-harvest for ${videoId} (not marking confirmedNo774).`);
          sendResponse({
            success: false, results: [], error: 'HARVEST_TIMEOUT',
            confirmedNo774: false, cancelled: false, timedOut: true, invalidData: false, opMode: 'YTM_HARVESTER'
          });
          return;
        }

        // Cancelled / timeout / illegal data — each gets its own fields, and
        // the confirmed-no-774 marker is never written for any of them.
        sendResponse(harvestFailureResponse(harvest?.outcome, 'YTM_HARVESTER'));
        return;
      }

      // ── MODE: TV_HEADLESS / TV_RELAY (TV SABR 774 UMP Demuxer or Native SABR Relay)
      if (opMode === 'TV_HEADLESS' || opMode === 'TV_RELAY') {
        console.log(TAG, `[FETCH_HQ] Mode (${opMode}) resolving for ${videoId}...`);
        const tvToken = await getClientAccessToken('TVHTML5');
        if (!tvToken) {
          console.log(TAG, `[FETCH_HQ] ${opMode}: No TV login (Premium required) -> Stopping.`);
          sendResponse({ success: false, results: [], error: 'NO_TV_LOGIN', opMode });
          return;
        }

        const tvRes = tvClient ? await fetchFromClient(videoId, tvClient, tvToken) : null;
        const tvHas774 = tvRes?.audioFormats?.some(f => f.itag === 774);
        const tvCtx = tvRes?.streamingContext || null;
        if (tvCtx) {
          chrome.storage.session.set({ [`tvctx_${videoId}`]: tvCtx }).catch(() => {});
        }

        if (!tvHas774) {
          console.log(TAG, `[FETCH_HQ] ${opMode}: Exact video ${videoId} has NO 774 on TV -> Cancelling.`);
          confirmedNo774Videos.add(videoId);
          sendResponse({ success: false, results: [], error: 'NO_774_STREAM', confirmedNo774: true, opMode });
          return;
        }

        console.log(TAG, `[FETCH_HQ] ${opMode}: Delivering authenticated TVHTML5 ITAG 774 for ${videoId}`);
        const results = [{ source: 'TVHTML5', audioFormats: tvRes.audioFormats }];
        chrome.storage.session.set({
          [`hq_${videoId}`]: { videoId, formats: tvRes.audioFormats, streamingContext: tvCtx, ts: Date.now() }
        }).catch(() => {});
        sendResponse({ success: true, results, streamingContext: tvCtx, opMode });
        return;
      }

      // ── FALLBACK / AUTO: Multi-client innerTube resolver
      const pref = storage.preferredClient || 'AUTO';
      let targetClients = [...CLIENTS];
      if (pref !== 'AUTO') {
        const matched = CLIENTS.find(c => c.name === pref);
        if (matched) {
          targetClients = [matched, ...CLIENTS.filter(c => c.name !== pref)];
        }
      }

      // Query clients sequentially starting with preferred client to avoid slamming YouTube
      // with simultaneous multi-device requests that trigger concurrent stream limits (TOO_MANY_STREAMS_PER_USER).
      const results = [];
      for (const c of targetClients) {
        const res = await fetchFromClient(videoId, c);
        if (res && res.audioFormats?.length > 0) {
          results.push(res);
          const has774 = res.audioFormats.some(f => f.itag === 774 || f._origItag === 774);
          if (has774 || res.streamingContext) {
            break; // Found high-quality 774 stream; stop querying further clients
          }
        } else if (res) {
          results.push(res);
        }
      }
      const tvCtx = results.find(r => r.streamingContext)?.streamingContext || null;

      const has774 = results.some(r => r.audioFormats?.some(f => f.itag === 774 || f._origItag === 774));
      if (has774) {
        const merged = results.flatMap(r => r.audioFormats || []);
        chrome.storage.session.set({
          [`hq_${videoId}`]: { videoId, formats: merged, streamingContext: tvCtx, ts: Date.now() }
        }).catch(() => {});
        sendResponse({ success: true, results, streamingContext: tvCtx, opMode: 'AUTO' });
        return;
      }

      console.log(TAG, `[FETCH_HQ] AUTO: Video ${videoId} has NO 774 across all clients.`);
      confirmedNo774Videos.add(videoId);
      sendResponse({ success: false, results: [], error: 'NO_774_STREAM', confirmedNo774: true, opMode: 'AUTO' });
    })();

    return true;
  }

  if (msg.type === 'START_CLIENT_AUTH' || msg.type === 'START_TV_AUTH') {
    if (sender.tab) {
      sendResponse({ success: false, error: 'unauthorized' });
      return true;
    }
    const clientType = resolveOAuthClientKey(msg.client);
    (async () => {
      try {
        const codeData = await requestDeviceCode(clientType);
        if (codeData && codeData.device_code && codeData.user_code) {
          startPollingToken(
            clientType,
            codeData.device_code,
            codeData.interval || 5,
            codeData.expires_in || 1800,
            codeData.user_code
          ).catch(err => console.log(TAG, `${clientType} OAuth error:`, err));
          sendResponse({ success: true, data: codeData });
        } else {
          stopPollingToken(clientType, true);
          sendResponse({
            success: false,
            error: codeData?.error_description || codeData?.error || 'Invalid device code response'
          });
        }
      } catch (err) {
        sendResponse({ success: false, error: err.message });
      }
    })();
    return true;
  }

  if (msg.type === 'CHECK_CLIENT_AUTH' || msg.type === 'CHECK_TV_AUTH') {
    if (sender.tab) {
      sendResponse({ isAuth: false });
      return true;
    }
    const clientType = resolveOAuthClientKey(msg.client);
    const storageKey = OAUTH_CLIENTS[clientType].storageKey;
    (async () => {
      const [localData, sessionData] = await Promise.all([
        chrome.storage.local.get(storageKey),
        chrome.storage.session.get(pendingAuthKey(clientType)).catch(() => ({}))
      ]);
      const isAuth = !!(localData[storageKey] && localData[storageKey].access_token);
      if (isAuth) {
        if (oauthPollSessions[clientType] || sessionData?.[pendingAuthKey(clientType)]) {
          stopPollingToken(clientType, true);
        }
        sendResponse({ isAuth: true, waiting: false });
        return;
      }

      const activeSession = oauthPollSessions[clientType];
      const savedPending = sessionData?.[pendingAuthKey(clientType)];
      if (activeSession && !activeSession.cancelled && Date.now() < activeSession.deadline) {
        sendResponse({
          isAuth: false,
          waiting: true,
          code: activeSession.user_code || savedPending?.user_code || null
        });
        return;
      }

      if (savedPending && savedPending.device_code && savedPending.user_code && Date.now() < savedPending.deadline) {
        const intervalSec = Math.max(1, Number(savedPending.interval) || 5);
        const elapsed = Date.now() - (savedPending.lastPollAt || 0);
        const initialDelayMs = Math.max(50, intervalSec * 1000 - elapsed);
        startPollingToken(
          clientType,
          savedPending.device_code,
          intervalSec,
          Math.ceil((savedPending.deadline - Date.now()) / 1000),
          savedPending.user_code,
          savedPending.deadline,
          initialDelayMs,
          savedPending.lastPollAt || Date.now()
        ).catch(err => console.log(TAG, `${clientType} resumed OAuth error:`, err));
        sendResponse({
          isAuth: false,
          waiting: true,
          code: savedPending.user_code
        });
        return;
      }

      if (savedPending) {
        clearPendingAuth(clientType);
      }
      sendResponse({ isAuth: false, waiting: false });
    })();
    return true;
  }

  if (msg.type === 'LOGOUT_CLIENT' || msg.type === 'LOGOUT_TV') {
    if (sender.tab) {
      sendResponse({ success: false });
      return true;
    }
    const clientType = resolveOAuthClientKey(msg.client);
    const storageKey = OAUTH_CLIENTS[clientType].storageKey;
    chrome.storage.local.remove(storageKey).then(() => {
      stopPollingToken(clientType, true);
      sendResponse({ success: true });
    });
    return true;
  }

  // ── Inject.js queries the captured TVHTML5 streaming context
  //    (serverAbrStreamingUrl + ustreamerConfig) for a given videoId.
  //    Returns null if TVHTML5 hasn't been fetched yet or didn't return SABR.
  if (msg.type === 'GET_TVCTX') {
    const { videoId } = msg;
    if (!videoId || !/^[\w-]{11}$/.test(videoId)) { sendResponse({ streamingContext: null }); return true; }
    chrome.storage.session.get(`tvctx_${videoId}`).then(s => {
      const ctx = s[`tvctx_${videoId}`];
      if (ctx && (Date.now() - ctx.ts <= 3600000)) {
        sendResponse({ streamingContext: ctx });
      } else {
        sendResponse({ streamingContext: null });
      }
    }).catch(() => sendResponse({ streamingContext: null }));
    return true;
  }

  // ── Page context relayed from inject.js via bridge.js.
  //    Supplies visitorData / session index so spoofed clients look like the
  //    real logged-in session (see setPageContext).
  if (msg.type === 'PAGE_CONTEXT_UPDATE') {
    setPageContext(msg.context);
    sendResponse({ ok: true });
    return true;
  }

  if (msg.type === 'SW_PING') {
    sendResponse({ ready: true, version: VERSION });
    return;
  }
});

chrome.runtime.onInstalled.addListener(() => {
  setupStaticRules(true);
});

chrome.runtime.onStartup.addListener(() => {
  setupStaticRules(true);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'ytss-keepalive') {
    chrome.storage.local.get('enabled').then(st => {
      if (st.enabled === false) return;
      chrome.declarativeNetRequest.getSessionRules().then(rules => {
        const hasOriginRule = rules.some(r => r.id === ORIGIN_RULE_ID);
        if (!hasOriginRule) {
          console.log(TAG, '[Keepalive] DNR rules missing — re-applying...');
          setupStaticRules(true);
        }
      }).catch(() => {});
    }).catch(() => {});
  }
});

// ─── TAB ACTIVATION: PUSH HQ UPGRADE FROM SW ─────────────────────────
// When the user switches to a YouTube tab, the SW (running outside the throttled
// page context) immediately checks if there are cached HQ formats for the
// current video and sends an upgrade trigger to inject.js via the bridge.
// This is more reliable than relying on page timers (which Chrome may freeze
// for background tabs), ensuring the upgrade fires the instant the tab is focused.
// Must match HQ_CACHE_TTL_MS in inject.js (signed stream URLs live ~6h; we use 1h).
const HQ_CACHE_TTL_MS = 3600000;
chrome.tabs.onActivated.addListener(async ({ tabId }) => {
  try {
    const storage = await chrome.storage.local.get('enabled');
    if (storage.enabled === false) return;
    const tab = await chrome.tabs.get(tabId);
    if (!tab.url || !tab.url.includes('youtube.com/watch')) return;

    const url = new URL(tab.url);
    const videoId = url.searchParams.get('v');
    if (!videoId) return;

    if (confirmedNo774Videos.has(videoId)) return;

    const stored = await chrome.storage.session.get(`hq_${videoId}`);
    const entry = stored[`hq_${videoId}`];
    if (!entry || !entry.formats?.length || (Date.now() - entry.ts) > HQ_CACHE_TTL_MS || (entry.videoId && entry.videoId !== videoId)) return;
    const has774 = entry.formats.some(f => f.itag === 774 || f._origItag === 774);
    if (!has774) return;

    console.log(TAG, `[TabActivated] YouTube tab focused for ${videoId}, pushing HQ upgrade trigger`);
    chrome.tabs.sendMessage(tabId, {
      type: 'YTSS_TRIGGER_UPGRADE',
      videoId,
    }).catch(() => {}); // Tab may not have content script ready — ignore errors
  } catch (e) {
    // Tab may have been closed or navigated away — ignore
  }
});

// Only apply DNR rules and keepalive alarm on wake-up if missing or version changed.
setupStaticRules(false);
chrome.alarms.get('ytss-keepalive', (existing) => {
  if (!existing) {
    chrome.alarms.create('ytss-keepalive', { periodInMinutes: 1 / 3 });
  }
});
