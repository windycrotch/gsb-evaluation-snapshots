/**
 * A local, fully controllable stand-in for the Yandex Music upstream, used by
 * the acceptance suite in ./session.test.mjs.
 *
 * It implements just enough of the real API surface for the server to work:
 *   GET /account/status
 *   GET /tracks/:id/download-info
 *   GET /download-info/:id      (the per-variant XML)
 *   GET /get-mp3/...            (the actual audio bytes, Range-aware)
 * plus control knobs under /__ctl so a test can make a token validation slow,
 * make a stream stall, cap concurrent audio sockets (modelling an audio host's
 * per-client limit), and observe how many upstream audio sockets are open or
 * were aborted.
 *
 * This is a TEST DOUBLE. Passing against it proves the server's session and
 * connection-lifecycle logic, NOT that the real Yandex flow works — that needs
 * real credentials (see docs/yandex-api.md).
 */
import http from 'node:http';

const AUDIO_BYTES = 256 * 1024;

export function createFakeUpstream() {
  /** token → { uid, login } */
  const tokens = new Map();
  const ctl = {
    tokenDelayMs: 0,
    resolveDelayMs: 0,
    audioDelayMs: 0,
    waveDelayMs: 0,
    /** bytes/sec while streaming audio; 0 = as fast as possible. */
    audioBytesPerSec: 0,
    /** Max simultaneous audio responses; extra requests queue (host limit). */
    maxConcurrentAudio: 8,
    audioStarted: 0,
    audioAborted: 0,
    audioOpen: 0,
    audioQueued: 0,
    audioCompleted: 0,
    /** Feedback requests the rotor received. */
    waveFeedback: 0,
  };
  /** Requests waiting for an audio slot. */
  const waiters = [];
  let baseUrl = '';
  let waveSeq = 0;

  function acquireAudioSlot() {
    if (ctl.audioOpen < ctl.maxConcurrentAudio) {
      ctl.audioOpen += 1;
      return Promise.resolve();
    }
    ctl.audioQueued += 1;
    return new Promise((resolve) => {
      waiters.push(() => {
        ctl.audioQueued -= 1;
        ctl.audioOpen += 1;
        resolve();
      });
    });
  }

  function releaseAudioSlot() {
    ctl.audioOpen -= 1;
    const next = waiters.shift();
    if (next) next();
  }

  function json(res, status, body) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(body));
  }

  function parseBody(req) {
    return new Promise((resolve) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        if (!raw) return resolve({});
        try {
          resolve(JSON.parse(raw));
        } catch {
          resolve({});
        }
      });
    });
  }

  function audioFor(trackId) {
    const buf = Buffer.alloc(AUDIO_BYTES);
    for (let i = 0; i < buf.length; i++) buf[i] = (i * 31 + trackId.length) & 0xff;
    return buf;
  }

  async function handleAudio(req, res, trackId) {
    let closed = false;
    const close = (completed) => {
      if (closed) return;
      closed = true;
      if (completed) ctl.audioCompleted += 1;
      else ctl.audioAborted += 1;
      releaseAudioSlot();
    };
    res.on('close', () => close(false));
    // A client abort before we even start writing must free the slot too.
    req.on('aborted', () => close(false));

    await acquireAudioSlot();
    if (res.destroyed) {
      close(false);
      return;
    }
    ctl.audioStarted += 1;

    const body = audioFor(trackId);
    const range = req.headers.range;
    let status = 200;
    let start = 0;
    let end = body.length - 1;
    const extra = { 'Accept-Ranges': 'bytes', 'Content-Type': 'audio/mpeg' };
    let sliced = false;
    if (typeof range === 'string') {
      const m = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
      if (m && (m[1] || m[2])) {
        if (!m[1]) {
          const suffix = Number(m[2]);
          start = Math.max(0, body.length - suffix);
          end = body.length - 1;
          sliced = true;
        } else {
          start = Number(m[1]);
          if (start >= body.length) {
            res.writeHead(416, { 'Content-Range': `bytes */${body.length}` });
            res.end();
            close(false);
            return;
          }
          end = m[2] ? Math.min(Number(m[2]), body.length - 1) : body.length - 1;
          sliced = true;
        }
        if (sliced) {
          status = 206;
          extra['Content-Range'] = `bytes ${start}-${end}/${body.length}`;
          extra['Content-Length'] = String(end - start + 1);
        }
      }
    }
    if (!sliced) extra['Content-Length'] = String(body.length);

    res.writeHead(status, extra);
    const slice = body.subarray(start, end + 1);

    // Bytes are delivered on a timer so a test can hold the stream open; at
    // full speed (audioBytesPerSec = 0) this completes in a couple of ticks.
    const began = Date.now();
    let offset = 0;
    const pump = () => {
      if (res.destroyed) return close(false);
      if (closed) return;
      if (offset >= slice.length) {
        res.end();
        close(true);
        return;
      }
      let allowed = slice.length;
      if (ctl.audioBytesPerSec > 0) {
        const elapsed = (Date.now() - began) / 1000;
        allowed = Math.floor(ctl.audioBytesPerSec * elapsed) - offset;
      }
      const take = Math.min(allowed, 16 * 1024, slice.length - offset);
      if (take <= 0) {
        setTimeout(pump, 10);
        return;
      }
      const ok = res.write(slice.subarray(offset, offset + take));
      offset += take;
      if (!ok) res.once('drain', pump);
      else setTimeout(pump, ctl.audioBytesPerSec > 0 ? 10 : 0);
    };
    setTimeout(pump, ctl.audioDelayMs);
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost');
      const path = url.pathname;

      if (path === '/__ctl/state') return json(res, 200, ctl);

      if (path === '/__ctl/reset') {
        Object.assign(ctl, {
          tokenDelayMs: 0,
          resolveDelayMs: 0,
          audioDelayMs: 0,
          waveDelayMs: 0,
          audioBytesPerSec: 0,
          maxConcurrentAudio: 8,
          audioStarted: 0,
          audioAborted: 0,
          audioOpen: 0,
          audioQueued: 0,
          audioCompleted: 0,
          waveFeedback: 0,
        });
        return json(res, 200, ctl);
      }

      if (path === '/__ctl/knobs' && req.method === 'POST') {
        const body = await parseBody(req);
        for (const key of [
          'tokenDelayMs',
          'resolveDelayMs',
          'audioDelayMs',
          'waveDelayMs',
          'audioBytesPerSec',
          'maxConcurrentAudio',
        ]) {
          if (typeof body[key] === 'number') ctl[key] = body[key];
        }
        return json(res, 200, ctl);
      }

      // --- "Моя волна" rotor: just enough for fetchWave / sendWaveFeedback ---
      if (/^\/rotor\/station\/[^/]+\/tracks$/.test(path)) {
        const token = (req.headers.authorization ?? '').replace(/^OAuth\s+/, '');
        if (!tokens.has(token)) return json(res, 401, { error: 'unauthorized' });
        if (ctl.waveDelayMs > 0) await new Promise((r) => setTimeout(r, ctl.waveDelayMs));
        waveSeq += 1;
        const sequence = Array.from({ length: 30 }, (_, i) => ({
          type: 'music',
          track: {
            id: `wave-${waveSeq}-${i}`,
            title: `Wave ${waveSeq}/${i}`,
            durationMs: 180000,
            available: true,
            artists: [{ name: 'Rotor' }],
            albums: [{ id: 1, title: 'Radio' }],
          },
        }));
        return json(res, 200, { result: { batchId: `batch-${waveSeq}`, sequence } });
      }

      if (/^\/rotor\/station\/[^/]+\/feedback$/.test(path)) {
        const token = (req.headers.authorization ?? '').replace(/^OAuth\s+/, '');
        if (!tokens.has(token)) return json(res, 401, { error: 'unauthorized' });
        await parseBody(req);
        ctl.waveFeedback += 1;
        return json(res, 200, { result: 'ok' });
      }

      if (path === '/__ctl/token' && req.method === 'POST') {
        const body = await parseBody(req);
        tokens.set(String(body.token), {
          uid: body.uid ?? 1,
          login: body.login ?? 'tester',
          // Per-token validation latency: lets a test make an *older* token
          // validate slower than a newer one, which is the race under test.
          delayMs: typeof body.delayMs === 'number' ? body.delayMs : 0,
        });
        return json(res, 200, { ok: true });
      }

      if (path === '/account/status') {
        const token = (req.headers.authorization ?? '').replace(/^OAuth\s+/, '');
        const account = tokens.get(token);
        const delay = (account?.delayMs ?? 0) || ctl.tokenDelayMs;
        if (delay > 0) await new Promise((r) => setTimeout(r, delay));
        if (!account) return json(res, 401, { error: 'unauthorized' });
        return json(res, 200, {
          result: { account: { uid: account.uid, login: account.login } },
        });
      }

      const dl = /^\/tracks\/([^/]+)\/download-info$/.exec(path);
      if (dl) {
        if (ctl.resolveDelayMs > 0) await new Promise((r) => setTimeout(r, ctl.resolveDelayMs));
        const token = (req.headers.authorization ?? '').replace(/^OAuth\s+/, '');
        if (!tokens.has(token)) return json(res, 401, { error: 'unauthorized' });
        const trackId = decodeURIComponent(dl[1]);
        return json(res, 200, {
          result: [
            {
              codec: 'mp3',
              bitrateInKbps: 320,
              preview: false,
              downloadInfoUrl: `${baseUrl}/download-info/${encodeURIComponent(trackId)}`,
            },
          ],
        });
      }

      const info = /^\/download-info\/([^/]+)$/.exec(path);
      if (info) {
        const trackId = decodeURIComponent(info[1]);
        // The host carries an explicit http:// scheme so resolveStreamUrl talks
        // to this fake instead of the real CDN (see server/src/yandex.ts).
        const xml =
          `<download-info><host>${baseUrl}</host>` +
          `<path>/t/${trackId}.mp3</path><ts>1700000000</ts><s>fakesig</s></download-info>`;
        res.writeHead(200, { 'Content-Type': 'application/xml' });
        return res.end(xml);
      }

      const mp3 = /^\/get-mp3\/[^/]+\/[^/]+\/t\/([^.]+)\.mp3$/.exec(path);
      if (mp3) return await handleAudio(req, res, decodeURIComponent(mp3[1]));

      return json(res, 404, { error: 'not found' });
    } catch (err) {
      if (!res.headersSent) json(res, 500, { error: String(err) });
      else res.destroy();
    }
  });

  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({
        server,
        tokens,
        ctl,
        get baseUrl() {
          return baseUrl;
        },
        close: () =>
          new Promise((r) => {
            server.closeAllConnections?.();
            server.close(() => r());
          }),
      });
    });
  });
}
