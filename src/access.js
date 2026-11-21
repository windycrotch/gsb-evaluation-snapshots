// Access to the viewer from a domain, for a viewer on a VPS behind a reverse proxy such as Caddy (docs/viewer.md).
// Off by default: then only 127.0.0.1 is served and nothing here runs. With a domain, every request needs a login
// (a password from MOTLAB_VIEWER_PASSWORD, then a session cookie) or, from motlab commands on the same machine, the
// token the viewer writes to ~/.motlab/viewer-token. That holds whatever Host header the proxy sends, so a proxy that
// rewrites Host to 127.0.0.1 does not skip the login.
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const TOKEN_FILE = join(homedir(), '.motlab', 'viewer-token');
export const MIN_PASSWORD = 12;
const COOKIE = 'motlab_session', DAYS = 30, TRIES = 5;   // 5 wrong passwords a minute, then wait

// The token for motlab commands on this machine, or null when the viewer runs without a domain.
export const readToken = () => { try { return readFileSync(TOKEN_FILE, 'utf8').trim() || null; } catch { return null; } };

export function createAccess({ domain, password, tokenFile = TOKEN_FILE } = {}) {
  if (!domain) return null;
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(domain)) throw new Error(`--domain takes a host name such as viewer.example.com, not "${domain}"`);
  if (!password || password.length < MIN_PASSWORD) throw new Error(`a viewer on a domain needs MOTLAB_VIEWER_PASSWORD set to a password of at least ${MIN_PASSWORD} characters`);
  const digest = s => createHash('sha256').update(String(s)).digest();
  const want = digest(password), token = randomBytes(32).toString('hex'), sessions = new Map(), failures = [];
  mkdirSync(dirname(tokenFile), { recursive: true });
  writeFileSync(tokenFile, token, { mode: 0o600 });
  const same = (a, b) => a.length === b.length && timingSafeEqual(a, b);
  const cookieOf = req => /(?:^|;\s*)motlab_session=([0-9a-f]{64})/.exec(req.headers.cookie || '')?.[1];
  const signedIn = req => {
    const id = cookieOf(req), until = id && sessions.get(id);
    if (until && until > Date.now()) return true;
    if (id) sessions.delete(id);
    const t = req.headers['x-motlab-token'];
    return typeof t === 'string' && same(digest(t), digest(token));
  };
  const local = host => /^(127\.0\.0\.1|localhost|\[::1\]):\d+$/.test(host);

  return {
    domain,
    close() { try { if (readFileSync(tokenFile, 'utf8').trim() === token) rmSync(tokenFile, { force: true }); } catch {} },
    // Whether a POST may write: from this host's own page (http:// on 127.0.0.1, https:// on the domain), or from a
    // motlab command, which sends no Origin.
    writeAllowed(req) {
      const host = req.headers.host || '', origin = req.headers.origin;
      if (host.toLowerCase() === domain.toLowerCase()) return !origin || origin === `https://${host}`;
      return local(host) && (!origin || origin === `http://${host}`);
    },
    // Handles the login routes and turns away a request without a session. Returns true when it answered.
    async guard(req, res, path, readBody) {
      if (path === '/login' && req.method === 'GET') return page(res, req, 200);
      if (path === '/login' && req.method === 'POST') {
        const now = Date.now();
        while (failures.length && failures[0] < now - 60000) failures.shift();
        if (failures.length >= TRIES) return page(res, req, 429, 'wait');
        const form = new URLSearchParams(await readBody(req)), next = safeNext(form.get('next'));
        if (!same(digest(form.get('password') ?? ''), want)) {
          failures.push(now);
          await new Promise(r => setTimeout(r, 400));
          return page(res, req, 401, 'wrong', next);
        }
        const id = randomBytes(32).toString('hex');
        sessions.set(id, now + DAYS * 864e5);
        res.writeHead(303, { Location: next, 'Set-Cookie': `${COOKIE}=${id}; Path=/; Max-Age=${DAYS * 86400}; HttpOnly; Secure; SameSite=Strict`, 'Cache-Control': 'no-store' });
        res.end();
        return true;
      }
      if (path === '/logout' && req.method === 'POST' && this.writeAllowed(req)) {
        sessions.delete(cookieOf(req));
        res.writeHead(303, { Location: '/login', 'Set-Cookie': `${COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict` }).end();
        return true;
      }
      if (signedIn(req)) return false;
      // Just enough for `motlab edit` and `stop` to recognise a viewer they have no token for; no pid or folder.
      if (path === '/__motlab/editor') { res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ motlab: 'editor', locked: true })); return true; }
      if (req.method === 'GET' && (req.headers.accept || '').includes('text/html')) {
        res.writeHead(302, { Location: `/login?next=${encodeURIComponent(path)}`, 'Cache-Control': 'no-store' }).end();
        return true;
      }
      res.writeHead(401, { 'Content-Type': 'text/plain' }).end('sign in first');
      return true;
    },
  };
}

// Only a path on this site, so the login cannot be used to send someone elsewhere.
const safeNext = n => typeof n === 'string' && /^\/(?!\/)[^\s\\]*$/.test(n) ? n : '/';

const TEXT = {
  id: { title: 'Masuk ke motlab', field: 'Kata sandi', go: 'Masuk', wrong: 'Kata sandi salah.', wait: 'Terlalu banyak percobaan. Coba lagi sebentar lagi.' },
  en: { title: 'Sign in to motlab', field: 'Password', go: 'Sign in', wrong: 'Wrong password.', wait: 'Too many tries. Try again in a minute.' },
};
const esc = s => String(s).replace(/[&<>"']/g, c => `&#${c.charCodeAt(0)};`);

// The login page, in Indonesian when the browser asks for it first, else English. Colours and type follow DESIGN.md.
function page(res, req, code, problem, next) {
  const t = /^\s*id\b/i.test(req.headers['accept-language'] || '') ? TEXT.id : TEXT.en, lang = t === TEXT.id ? 'id' : 'en';
  next ??= safeNext(new URL(req.url, 'http://x').searchParams.get('next'));
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY', 'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" });
  res.end(`<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${t.title}</title>
<style>
  :root { --text: #1f1f1e; --muted: #666561; --edge: #dcdcda; --canvas: #ececec; --red: #b8322a; --blue: #2c6fe0; }
  * { box-sizing: border-box; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--canvas); color: var(--text); font: 14px/1.4 ui-sans-serif, system-ui, "Segoe UI", sans-serif; }
  main { width: min(340px, 100%); padding: 24px; border-radius: 12px; background: #fff; box-shadow: 0 8px 28px rgba(0,0,0,.12); }
  h1 { margin: 0 0 16px; font-size: 16px; font-weight: 600; }
  label { display: block; margin-bottom: 6px; color: var(--muted); }
  input { width: 100%; height: 40px; padding: 0 10px; border: 1px solid var(--edge); border-radius: 8px; font: inherit; color: inherit; }
  input:focus-visible, button:focus-visible { outline: 2px solid var(--blue); outline-offset: 2px; }
  button { width: 100%; height: 40px; margin-top: 12px; border: 0; border-radius: 8px; background: var(--text); color: #fff; font: inherit; font-weight: 600; cursor: pointer; }
  button:hover { background: #3a3a38; }
  p { margin: 10px 0 0; color: var(--red); }
</style></head><body><main>
<h1>${t.title}</h1>
<form method="post" action="/login">
  <input type="hidden" name="next" value="${esc(next)}">
  <label for="pw">${t.field}</label>
  <input id="pw" name="password" type="password" autocomplete="current-password" required autofocus${problem ? ' aria-describedby="problem"' : ''}>
  <button type="submit">${t.go}</button>
  ${problem ? `<p id="problem" role="alert">${t[problem]}</p>` : ''}
</form></main></body></html>`);
  return true;
}
