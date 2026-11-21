// The login for a viewer served on a domain (src/access.js), on a small server that uses it as the viewer does.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createAccess } from '../src/access.js';

const dir = mkdtempSync(join(tmpdir(), 'motlab-access-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const readBody = req => new Promise(ok => { let b = ''; req.on('data', d => b += d).on('end', () => ok(b)); });
const PASSWORD = 'correct horse battery', DOMAIN = 'viewer.example.com';

// Requests go through node:http, which sends the Host header it is given, as a reverse proxy does.
let base;
const call = (path, { method = 'GET', headers = {}, body } = {}) => new Promise((ok, no) => {
  const req = request(base + path, { method, headers: { host: DOMAIN, ...headers } }, res => {
    let text = ''; res.on('data', d => text += d).on('end', () => ok({ status: res.statusCode, headers: res.headers, text }));
  });
  req.on('error', no); req.end(body);
});
const form = fields => ({ 'content-type': 'application/x-www-form-urlencoded', body: String(new URLSearchParams(fields)) });
const login = (password, next = '/p/demo/') => { const { body, ...type } = form({ password, next }); return call('/login', { method: 'POST', body, headers: { origin: `https://${DOMAIN}`, ...type } }); };

test('a viewer on a domain needs a real host name and a long password', () => {
  assert.equal(createAccess({}), null);
  assert.throws(() => createAccess({ domain: DOMAIN, password: 'short', tokenFile: join(dir, 't0') }), /at least 12 characters/);
  assert.throws(() => createAccess({ domain: 'https://viewer.example.com/', password: PASSWORD, tokenFile: join(dir, 't0') }), /host name/);
});

test('every request needs the login or the local token, whatever Host the proxy sends', async () => {
  const tokenFile = join(dir, 'viewer-token'), access = createAccess({ domain: DOMAIN, password: PASSWORD, tokenFile });
  if (process.platform !== 'win32') assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  const token = readFileSync(tokenFile, 'utf8');
  const server = createServer(async (req, res) => {
    const path = new URL(req.url, 'http://x').pathname;
    if (await access.guard(req, res, path, readBody)) return;
    if (req.method === 'POST' && !access.writeAllowed(req)) return res.writeHead(403).end('forbidden');
    res.writeHead(200).end('inside');
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  try {
    // signed out: a page goes to the login, anything else is refused, also with a local Host header
    let r = await call('/p/demo/', { headers: { accept: 'text/html' } });
    assert.equal(r.status, 302); assert.equal(r.headers.location, '/login?next=%2Fp%2Fdemo%2F');
    assert.equal((await call('/p/demo/project.json')).status, 401);
    assert.equal((await call('/p/demo/project.json', { headers: { host: `127.0.0.1:${server.address().port}` } })).status, 401);
    assert.deepEqual(JSON.parse((await call('/__motlab/editor')).text), { motlab: 'editor', locked: true });
    assert.match((await call('/login', { headers: { 'accept-language': 'id-ID,id;q=0.9' } })).text, /Kata sandi/);
    // a wrong password, then the right one: a session cookie that is HttpOnly, Secure and SameSite=Strict
    r = await login('nope nope nope');
    assert.equal(r.status, 401); assert.match(r.text, /Wrong password/);
    r = await login(PASSWORD);
    assert.equal(r.status, 303); assert.equal(r.headers.location, '/p/demo/');
    const cookie = r.headers['set-cookie'][0];
    assert.match(cookie, /^motlab_session=[0-9a-f]{64}; Path=\/; Max-Age=2592000; HttpOnly; Secure; SameSite=Strict$/);
    const session = { cookie: cookie.split(';')[0] };
    assert.equal((await call('/p/demo/project.json', { headers: session })).text, 'inside');
    // writes need the page's own origin on the domain
    const post = origin => call('/p/demo/selection', { method: 'POST', body: '{}', headers: { ...session, origin } });
    assert.equal((await post(`https://${DOMAIN}`)).status, 200);
    assert.equal((await post('https://evil.example')).status, 403);
    assert.equal((await post(`http://${DOMAIN}`)).status, 403);
    // motlab commands on the machine use the token file instead
    assert.equal((await call('/p/demo/project.json', { headers: { 'x-motlab-token': token } })).text, 'inside');
    assert.equal((await call('/p/demo/project.json', { headers: { 'x-motlab-token': 'f'.repeat(64) } })).status, 401);
    // the login cannot send you to another site
    assert.equal((await login(PASSWORD, '//evil.example/')).headers.location, '/');
    // five wrong passwords in a minute and the next try waits, even with the right password
    for (let i = 0; i < 4; i++) await login('nope nope nope');
    assert.equal((await login(PASSWORD)).status, 429);
    // signing out ends the session
    r = await call('/logout', { method: 'POST', headers: { ...session, origin: `https://${DOMAIN}` } });
    assert.equal(r.status, 303);
    assert.equal((await call('/p/demo/project.json', { headers: session })).status, 401);
  } finally {
    await new Promise(r => server.close(r));
    access.close();
  }
  assert.ok(!existsSync(tokenFile), 'the token file is removed when the viewer ends');
});
