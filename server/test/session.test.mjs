/**
 * Acceptance suite for the observable playback session and the stream proxy.
 *
 * Run with:  npm run test:acceptance -w server
 *
 * It boots the real server (server/src/index.ts, via tsx) pointed at a local
 * fake Yandex upstream, then drives it over HTTP. Covers:
 *   1. normal track switching
 *   2. token failure falls back (mode/account/track unchanged)
 *   3. concurrent token submissions — the older result is discarded (409),
 *      /api/status shows the newest successful submission
 *   4. concurrent streams + client disconnects — upstream sockets are freed,
 *      later streams don't queue behind dead ones
 *   5. stale wave feedback is rejected with 409; current feedback is 204
 *   6. a demo track keeps playing across the demo→yandex switch
 *   7. /api/stream Range semantics are unchanged (200 / 206 / 416)
 *
 * NOTE: the fake upstream is a test double. Green here means the server's
 * session/lifecycle logic works; a real-Yandex smoke test still needs a token.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createFakeUpstream } from './fake-upstream.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '../..');

/** A free TCP port for the test server. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close((err) => (err ? reject(err) : resolve(port)));
    });
  });
}

function delay(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** Minimal HTTP JSON helper with a status + parsed body (never throws on 4xx). */
function request(base, method, urlPath, { body, headers = {}, signal } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
    const req = http.request(
      url,
      {
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...headers,
        },
        signal,
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks);
          let json = null;
          try {
            json = JSON.parse(text.toString('utf8'));
          } catch {
            // binary / empty body
          }
          resolve({ status: res.statusCode, headers: res.headers, body: json, raw: text });
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Starts a streaming GET and resolves as soon as the response headers arrive.
 * The caller gets the live response (so it can read/destroy mid-stream) plus a
 * `closed` promise that resolves when the socket goes away.
 */
function openStream(base, urlPath, { headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlPath, base);
    const req = http.request(url, { headers }, (res) => {
      let ended = false;
      const closed = new Promise((r) => {
        res.on('end', () => {
          ended = true;
          r();
        });
        res.on('close', () => r());
      });
      resolve({
        status: res.statusCode,
        headers: res.headers,
        res,
        ended: () => ended,
        closed,
        destroy: () => req.destroy(),
      });
    });
    req.on('error', reject);
    req.end();
  });
}

/** Polls `fn` until truthy or times out. */
async function waitFor(fn, { timeoutMs = 4000, intervalMs = 25, label = 'condition' } = {}) {
  const start = Date.now();
  for (;;) {
    if (await fn()) return;
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for ${label}`);
    await delay(intervalMs);
  }
}

async function ctl(upstream, urlPath, method = 'GET', body) {
  return request(upstream.baseUrl, method, urlPath, { body });
}

describe('ya-namp playback session + stream proxy', () => {
  let upstream;
  let server;
  let baseUrl;
  let logs = '';

  before(async () => {
    upstream = await createFakeUpstream();
    const port = await freePort();
    baseUrl = `http://127.0.0.1:${port}`;
    server = spawn(
      process.execPath,
      ['--import', 'tsx', path.join(repoRoot, 'server/src/index.ts')],
      {
        cwd: repoRoot,
        env: {
          ...process.env,
          PORT: String(port),
          YANDEX_API_BASE: upstream.baseUrl,
          YANDEX_TOKEN: '', // keep the .env bootstrap out of the way
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    server.stdout.on('data', (c) => (logs += c.toString()));
    server.stderr.on('data', (c) => (logs += c.toString()));
    await waitFor(
      async () => {
        try {
          const r = await request(baseUrl, 'GET', '/api/status');
          return r.status === 200;
        } catch {
          return false;
        }
      },
      { timeoutMs: 20_000, label: 'server boot' },
    );
  });

  after(async () => {
    if (server) server.kill('SIGKILL');
    if (upstream) await upstream.close();
    if (server && server.exitCode && server.exitCode !== 0 && /Error/.test(logs)) {
      // eslint-disable-next-line no-console
      console.error('[server logs]\n' + logs);
    }
  });

  /** Fresh token that the fake accepts; `delayMs` staggers validations. */
  async function makeToken(name, { delayMs = 0 } = {}) {
    const token = `tok-${name}-${Math.random().toString(36).slice(2)}`;
    await ctl(upstream, '/__ctl/token', 'POST', { token, login: name, uid: 100, delayMs });
    return token;
  }

  describe('1. normal track switching', () => {
    it('announcing a new track bumps the generation and updates currentTrackId', async () => {
      const a = await request(baseUrl, 'POST', '/api/session/track', { body: { trackId: 'track-A' } });
      assert.equal(a.status, 200);
      assert.equal(a.body.currentTrackId, 'track-A');
      const genA = a.body.generation;

      const same = await request(baseUrl, 'POST', '/api/session/track', {
        body: { trackId: 'track-A' },
      });
      assert.equal(same.body.generation, genA, 're-announcing the same track is a no-op');

      const b = await request(baseUrl, 'POST', '/api/session/track', { body: { trackId: 'track-B' } });
      assert.ok(b.body.generation > genA, 'a different track bumps the generation');
      assert.equal(b.body.currentTrackId, 'track-B');

      const status = await request(baseUrl, 'GET', '/api/status');
      assert.equal(status.body.currentTrackId, 'track-B');
      assert.equal(status.body.generation, b.body.generation);
      assert.equal(status.body.mode, 'demo');
      assert.equal(status.body.account, null);
    });

    it('rejects a session-track announcement without a trackId', async () => {
      const r = await request(baseUrl, 'POST', '/api/session/track', { body: {} });
      assert.equal(r.status, 400);
    });
  });

  describe('2. token failure falls back', () => {
    it('an invalid token keeps the previous mode/account/track', async () => {
      const prev = (await request(baseUrl, 'GET', '/api/status')).body;
      const r = await request(baseUrl, 'POST', '/api/token', { body: { token: 'definitely-invalid' } });
      assert.equal(r.status, 401);
      assert.ok(typeof r.body.error === 'string' && r.body.error.length > 0);
      const now = (await request(baseUrl, 'GET', '/api/status')).body;
      assert.deepEqual(
        { mode: now.mode, account: now.account, currentTrackId: now.currentTrackId, generation: now.generation },
        { mode: prev.mode, account: prev.account, currentTrackId: prev.currentTrackId, generation: prev.generation },
      );
    });
  });

  describe('3. concurrent token submissions', () => {
    it('a slow older validation cannot overwrite a newer successful one', async () => {
      const slow = await makeToken('slow-account', { delayMs: 350 });
      const fast = await makeToken('fast-account', { delayMs: 0 });

      // Fire the slow one first, then the fast one ~30ms later.
      const slowReq = request(baseUrl, 'POST', '/api/token', { body: { token: slow } });
      await delay(30);
      const fastReq = request(baseUrl, 'POST', '/api/token', { body: { token: fast } });

      const fastRes = await fastReq;
      assert.equal(fastRes.status, 200, 'the newer submission succeeds');
      assert.equal(fastRes.body.account.login, 'fast-account');

      const slowRes = await slowReq;
      assert.equal(slowRes.status, 409, 'the older submission is discarded, not committed');

      const status = (await request(baseUrl, 'GET', '/api/status')).body;
      assert.equal(status.mode, 'yandex');
      assert.equal(status.account.login, 'fast-account', 'status shows the newest successful submission');
      assert.equal(status.generation, fastRes.body.generation);
    });

    it('a slow older *invalid* token cannot report failure over a newer success', async () => {
      // An unregistered token is 401'd by the fake; the global knob makes that
      // 401 arrive slowly, so it lands after the newer, fast success.
      const unknownSlow = `unknown-${Math.random().toString(36).slice(2)}`;
      await ctl(upstream, '/__ctl/knobs', 'POST', { tokenDelayMs: 300 });

      const slowReq = request(baseUrl, 'POST', '/api/token', { body: { token: unknownSlow } });
      await delay(30);
      await ctl(upstream, '/__ctl/knobs', 'POST', { tokenDelayMs: 0 });
      const good = await makeToken('post-race', { delayMs: 0 });
      const goodRes = await request(baseUrl, 'POST', '/api/token', { body: { token: good } });
      assert.equal(goodRes.status, 200);

      const slowRes = await slowReq;
      assert.equal(slowRes.status, 409, 'the stale failure is discarded, not surfaced as a rejection');

      const status = (await request(baseUrl, 'GET', '/api/status')).body;
      assert.equal(status.account.login, 'post-race');
    });
  });

  describe('4. concurrent streams + disconnects', () => {
    it('a client disconnect frees the upstream socket; later streams do not queue', async () => {
      // Connect an account (the fake upstream serves audio for it).
      const token = await makeToken('streamer', { delayMs: 0 });
      const auth = await request(baseUrl, 'POST', '/api/token', { body: { token } });
      assert.equal(auth.status, 200);

      // One audio slot only: a leaked upstream would starve every later stream.
      await ctl(upstream, '/__ctl/reset');
      await ctl(upstream, '/__ctl/knobs', 'POST', {
        maxConcurrentAudio: 1,
        audioBytesPerSec: 32 * 1024, // ~8s for 256KiB, so it stays open
      });

      for (let i = 0; i < 4; i++) {
        // The app announces the track it is switching to; the stream follows.
        await request(baseUrl, 'POST', '/api/session/track', { body: { trackId: `live-${i}` } });
        const stream = await openStream(baseUrl, `/api/stream/live-${i}`);
        assert.equal(stream.status, 200, `stream ${i} opened`);
        await delay(60); // let a little audio flow
        stream.destroy(); // simulate seek / next track / tab close
        await stream.closed;
        // The upstream socket must be released, not left dangling holding the slot.
        await waitFor(async () => {
          const s = (await ctl(upstream, '/__ctl/state')).body;
          return s.audioOpen === 0;
        }, { label: `upstream socket freed after stream ${i}` });
      }

      // A fresh stream still starts promptly (nothing is queued ahead of it).
      const state0 = (await ctl(upstream, '/__ctl/state')).body;
      assert.equal(state0.audioQueued, 0, 'no upstream requests stuck in the queue');

      const started = Date.now();
      await request(baseUrl, 'POST', '/api/session/track', { body: { trackId: 'final' } });
      const final = await openStream(baseUrl, '/api/stream/final');
      assert.equal(final.status, 200);
      const elapsed = Date.now() - started;
      assert.ok(elapsed < 2000, `a later stream opened promptly (${elapsed}ms)`);
      final.destroy();
      await final.closed;
    });

    it('after an announcement, a late stream for the previous track does not revert the session', async () => {
      // The app announces B; the browser's old src for A then fires one last
      // Range request while tearing down. That stale request must not move the
      // session back to A, and a seek on the current track must not bump the
      // generation (the playhead's own feedback would then be rejected).
      const announced = await request(baseUrl, 'POST', '/api/session/track', {
        body: { trackId: 'demo-3' },
      });
      const gen = announced.body.generation;

      const late = await request(baseUrl, 'GET', '/api/stream/demo-4', {
        headers: { Range: 'bytes=0-99' },
      });
      assert.equal(late.status, 206, 'the stale track still streams if requested explicitly');

      const after = (await request(baseUrl, 'GET', '/api/status')).body;
      assert.equal(after.currentTrackId, 'demo-3', 'session did not revert to the old track');
      assert.equal(after.generation, gen, 'generation unchanged by a stale stream request');

      const seek = await request(baseUrl, 'GET', '/api/stream/demo-3', {
        headers: { Range: 'bytes=5000-5099' },
      });
      assert.equal(seek.status, 206);
      const afterSeek = (await request(baseUrl, 'GET', '/api/status')).body;
      assert.equal(afterSeek.currentTrackId, 'demo-3');
      assert.equal(afterSeek.generation, gen, 'a seek on the current track is not a new session');
    });

    it('many overlapping streams that are all abandoned release every upstream socket', async () => {
      // Same track id = browser Range re-fetches / retries of the *same* track,
      // which must not invalidate each other (only a track change does).
      await request(baseUrl, 'POST', '/api/session/track', { body: { trackId: 'multi-same' } });
      await ctl(upstream, '/__ctl/reset');
      await ctl(upstream, '/__ctl/knobs', 'POST', {
        maxConcurrentAudio: 4,
        audioBytesPerSec: 16 * 1024,
      });
      const streams = await Promise.all(
        Array.from({ length: 4 }, () => openStream(baseUrl, '/api/stream/multi-same')),
      );
      streams.forEach((s) => assert.equal(s.status, 200));
      await delay(80);
      streams.forEach((s) => s.destroy());
      await Promise.all(streams.map((s) => s.closed));
      await waitFor(async () => {
        const s = (await ctl(upstream, '/__ctl/state')).body;
        return s.audioOpen === 0 && s.audioQueued === 0;
      }, { label: 'all upstream sockets freed' });
    });

    it('a stream superseded by a session change is dropped (409) instead of proxied', async () => {
      await request(baseUrl, 'POST', '/api/session/track', { body: { trackId: 'slow-track' } });
      await ctl(upstream, '/__ctl/reset');
      await ctl(upstream, '/__ctl/knobs', 'POST', { resolveDelayMs: 250 });
      // Start resolving a stream, then move the session on before it resolves.
      const streamReq = request(baseUrl, 'GET', '/api/stream/slow-track');
      await delay(40);
      await request(baseUrl, 'POST', '/api/session/track', { body: { trackId: 'other-track' } });
      const r = await streamReq;
      await ctl(upstream, '/__ctl/knobs', 'POST', { resolveDelayMs: 0 });
      assert.equal(r.status, 409, 'stale stream resolution is rejected');
      const state = (await ctl(upstream, '/__ctl/state')).body;
      assert.equal(state.audioStarted, 0, 'no upstream audio connection was opened for the stale stream');
    });
  });

  describe('5. wave feedback generation guarding', () => {
    it('accepts feedback for the current session and rejects stale feedback with 409', async () => {
      // Establish a known current generation.
      const snap = (await request(baseUrl, 'POST', '/api/session/track', { body: { trackId: 'wave-track-1' } })).body;
      const currentGen = snap.generation;

      const ok = await request(baseUrl, 'POST', '/api/wave/feedback', {
        body: { sessionId: 's', trackId: 'wave-track-1', event: 'trackStarted', generation: currentGen },
      });
      assert.equal(ok.status, 204, 'feedback for the current session is accepted');

      // Move the session on: this is the "old track's feedback arrives late" case.
      const moved = (await request(baseUrl, 'POST', '/api/session/track', { body: { trackId: 'wave-track-2' } })).body;
      assert.ok(moved.generation > currentGen);

      const stale = await request(baseUrl, 'POST', '/api/wave/feedback', {
        body: { sessionId: 's', trackId: 'wave-track-1', event: 'trackFinished', generation: currentGen },
      });
      assert.equal(stale.status, 409, 'feedback for an outdated session is rejected, not silently 204');
      assert.ok(typeof stale.body.error === 'string');
    });

    it('rejects feedback with a missing generation (never treated as current)', async () => {
      const r = await request(baseUrl, 'POST', '/api/wave/feedback', {
        body: { sessionId: 's', trackId: 'x', event: 'skip' },
      });
      assert.equal(r.status, 409);
    });

    it('rejects a malformed feedback payload with 400', async () => {
      const r = await request(baseUrl, 'POST', '/api/wave/feedback', {
        body: { trackId: 'x', event: 'nonsense', generation: 1 },
      });
      assert.equal(r.status, 400);
    });

    it('/api/wave echoes the current generation', async () => {
      const r = await request(baseUrl, 'GET', '/api/wave');
      assert.equal(r.status, 200);
      assert.equal(typeof r.body.generation, 'number');
      const status = (await request(baseUrl, 'GET', '/api/status')).body;
      assert.equal(r.body.generation, status.generation);
    });
  });

  describe('6. demo track keeps playing across the demo→yandex switch', () => {
    it('a demo track streams (with Range) before and after connecting an account', async () => {
      // Demo bytes stream from memory in every mode.
      const before = await request(baseUrl, 'GET', '/api/stream/demo-1', {
        headers: { Range: 'bytes=0-1023' },
      });
      assert.equal(before.status, 206);
      assert.equal(before.raw.length, 1024);
      assert.equal(before.headers['accept-ranges'], 'bytes');

      // Switch to a real account.
      const token = await makeToken('demo-switch', { delayMs: 0 });
      const auth = await request(baseUrl, 'POST', '/api/token', { body: { token } });
      assert.equal(auth.status, 200);
      assert.equal(auth.body.account.login, 'demo-switch');

      // The same demo track still streams, unchanged.
      const after = await request(baseUrl, 'GET', '/api/stream/demo-1', {
        headers: { Range: 'bytes=0-1023' },
      });
      assert.equal(after.status, 206);
      assert.equal(after.raw.length, 1024);
      assert.equal(after.headers['accept-ranges'], 'bytes');

      const status = (await request(baseUrl, 'GET', '/api/status')).body;
      assert.equal(status.mode, 'yandex');
      assert.equal(status.account.login, 'demo-switch');
    });
  });

  describe('7. /api/stream Range semantics unchanged', () => {
    it('serves 200 with full bytes, 206 for a range, and 416 for an unsatisfiable range', async () => {
      const full = await request(baseUrl, 'GET', '/api/stream/demo-2');
      assert.equal(full.status, 200);
      assert.equal(full.headers['accept-ranges'], 'bytes');
      assert.equal(Number(full.headers['content-length']), full.raw.length);

      const ranged = await request(baseUrl, 'GET', '/api/stream/demo-2', {
        headers: { Range: 'bytes=100-199' },
      });
      assert.equal(ranged.status, 206);
      assert.equal(ranged.raw.length, 100);
      assert.match(ranged.headers['content-range'], /^bytes 100-199\/\d+$/);

      const suffix = await request(baseUrl, 'GET', '/api/stream/demo-2', {
        headers: { Range: 'bytes=-50' },
      });
      assert.equal(suffix.status, 206);
      assert.equal(suffix.raw.length, 50);

      const bad = await request(baseUrl, 'GET', '/api/stream/demo-2', {
        headers: { Range: `bytes=${full.raw.length + 10}-` },
      });
      assert.equal(bad.status, 416);
      assert.equal(bad.headers['content-range'], `bytes */${full.raw.length}`);
    });

    it('forwards Range to the upstream and relays 206/Content-Range for a proxied track', async () => {
      await request(baseUrl, 'POST', '/api/session/track', { body: { trackId: 'range-track' } });
      await ctl(upstream, '/__ctl/reset');
      const proxied = await request(baseUrl, 'GET', '/api/stream/range-track', {
        headers: { Range: 'bytes=10-19' },
      });
      assert.equal(proxied.status, 206);
      assert.equal(proxied.raw.length, 10);
      assert.match(proxied.headers['content-range'], /^bytes 10-19\/\d+$/);
      assert.equal(proxied.headers['accept-ranges'], 'bytes');
    });
  });
});
