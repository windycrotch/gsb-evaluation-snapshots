/**
 * The Worker only receives product events. Cloudflare serves the static site itself without
 * invoking this code, so the site keeps working even if Workers limits are hit.
 *
 * POST /api/event  {e, mode?, lang?, result?, chars?, ms?, sec?, kb?}
 *   → Workers Analytics Engine (dataset from wrangler.jsonc).
 *
 * Data point layout (scripts/stats.ts relies on it):
 *   index1 = event
 *   blob1 = event, blob2 = mode, blob3 = lang, blob4 = country, blob5 = platform, blob6 = browser, blob7 = result
 *   double1 = chars, double2 = ms, double3 = sec, double4 = kb
 */

interface AnalyticsEngineDataset {
  writeDataPoint(point: { indexes?: string[]; blobs?: string[]; doubles?: number[] }): void;
}

interface Env {
  ASSETS: { fetch(request: Request): Promise<Response> };
  EVENTS?: AnalyticsEngineDataset;
}

const EVENTS = new Set([
  'view',
  'js_error',
  'lang_change',
  'why_click',
  'mode_change',
  'limit_hit',
  'render_start',
  'render_done',
  'render_fail',
  'render_cancel',
  'share_click',
  'share_result',
]);
const MAX_BODY = 2048;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === '/api/event') return handleEvent(request, env);
    return env.ASSETS.fetch(request);
  },
};

async function handleEvent(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') return new Response(null, { status: 405 });

  const raw = await request.text();
  if (raw.length > MAX_BODY) return new Response(null, { status: 413 });

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return new Response(null, { status: 400 });
  }
  const event = str(data.e);
  if (!EVENTS.has(event)) return new Response(null, { status: 400 });

  const cf = (request as Request & { cf?: { country?: string } }).cf;
  const ua = request.headers.get('user-agent') ?? '';

  env.EVENTS?.writeDataPoint({
    indexes: [event],
    blobs: [event, str(data.mode), str(data.lang), cf?.country ?? '', platform(ua), browser(ua), str(data.result)],
    doubles: [num(data.chars), num(data.ms), num(data.sec), num(data.kb)],
  });
  return new Response(null, { status: 204 });
}

const str = (v: unknown) => (typeof v === 'string' ? v.slice(0, 32) : '');
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : 0);

function platform(ua: string): string {
  if (/iPhone|iPad|iPod/.test(ua)) return 'ios';
  if (/Android/.test(ua)) return 'android';
  if (/Macintosh|Windows|Linux|CrOS/.test(ua)) return 'desktop';
  return 'other';
}

function browser(ua: string): string {
  if (/Telegram/i.test(ua)) return 'telegram';
  if (/Instagram|FBAN|FBAV|FB_IAB|FBIOS/.test(ua)) return 'meta-inapp';
  if (/TikTok|musical_ly|BytedanceWebview/i.test(ua)) return 'tiktok-inapp';
  if (/CriOS|Chrome\//.test(ua) && !/Edg\//.test(ua)) return 'chrome';
  if (/Edg\//.test(ua)) return 'edge';
  if (/FxiOS|Firefox\//.test(ua)) return 'firefox';
  if (/Safari\//.test(ua)) return 'safari';
  return 'other';
}
