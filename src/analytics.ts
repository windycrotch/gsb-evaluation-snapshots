/**
 * Product events → our Worker (/api/event) → Cloudflare Workers Analytics Engine.
 * The reply text is NEVER sent — only its length, mode, language and timings.
 * Visits/countries/referrers are tracked separately by Cloudflare Web Analytics (loadWebAnalytics).
 */
export type EventName =
  | 'view'
  | 'js_error'
  | 'lang_change'
  | 'why_click'
  | 'mode_change'
  | 'limit_hit'
  | 'render_start'
  | 'render_done'
  | 'render_fail'
  | 'render_cancel'
  | 'share_click'
  | 'share_result';

export interface EventProps {
  mode?: string;
  lang?: string;
  /** shared | cancelled | downloaded | unsupported | error; for lang_change — the previous language */
  result?: string;
  chars?: number;
  /** Render time, ms. */
  ms?: number;
  /** Video length, s. */
  sec?: number;
  /** File size, KB. */
  kb?: number;
}

const ENDPOINT = '/api/event';
const enabled = typeof location !== 'undefined' && !['localhost', '127.0.0.1'].includes(location.hostname);
let common: EventProps = {};

export function setCommonProps(props: EventProps): void {
  common = { ...common, ...props };
}

export function track(e: EventName, props: EventProps = {}): void {
  if (!enabled) return;
  try {
    const body = JSON.stringify({ e, ...common, ...props });
    // sendBeacon survives tab close and doesn't block the UI.
    if (!navigator.sendBeacon?.(ENDPOINT, new Blob([body], { type: 'application/json' }))) {
      void fetch(ENDPOINT, { method: 'POST', body, keepalive: true }).catch(() => {});
    }
  } catch {
    // analytics must never break the site
  }
}

/**
 * Uncaught JS errors — so we learn when something breaks on some phone.
 * Only the error message is sent (never user text), at most 3 per visit.
 */
export function trackErrors(): void {
  let sent = 0;
  const report = (msg: unknown) => {
    if (sent++ >= 3) return;
    track('js_error', { result: String(msg ?? 'unknown').slice(0, 32) });
  };
  addEventListener('error', (e) => report(e.message));
  addEventListener('unhandledrejection', (e) => report(e.reason instanceof Error ? e.reason.message : e.reason));
}

/** Cloudflare Web Analytics (cookieless). The token is set at production build time. */
export function loadWebAnalytics(token: string | undefined): void {
  if (!token || !enabled) return;
  const s = document.createElement('script');
  s.defer = true;
  s.src = 'https://static.cloudflareinsights.com/beacon.min.js';
  s.dataset.cfBeacon = JSON.stringify({ token });
  document.head.appendChild(s);
}
