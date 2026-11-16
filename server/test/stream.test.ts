/**
 * Stream teardown semantics — fully local, no Yandex credentials, no WAN.
 *
 * Covers both paths of /api/stream/:id:
 *  - in-memory WAV buffer: valid 206 ranges, the three 416 cases, and 200
 *    fallback for unparseable/multi-range Range headers;
 *  - proxy against a local fake upstream: 500 → 502 JSON, 302 follow,
 *    mid-stream truncation (headers already sent), upstream 416 relay, and
 *    client early-abort destroying the upstream as a normal end.
 */
import { describe, test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import express from 'express';
import type { Request, Response } from 'express';
import { parseRange, proxyStream, serveBufferWithRange } from '../src/stream';
import { UpstreamError } from '../src/yandex';
import { FAKE_PAYLOAD, startFakeUpstream, type FakeUpstream } from './fake-upstream';

// ---------------------------------------------------------------------------
// Tiny express app exposing the same two routes the real server wires up.
// ---------------------------------------------------------------------------

interface TestServer {
  base: string;
  close: () => Promise<void>;
}

function startTestApp(upstream: FakeUpstream): Promise<TestServer> {
  const app = express();
  const wav = Buffer.alloc(100, 7); // small synthetic buffer, length is what matters

  app.get('/mem', (req: Request, res: Response) => {
    serveBufferWithRange(req, res, wav, 'audio/wav');
  });

  app.get('/proxy', (req: Request, res: Response) => {
    // `url` allows pointing at a second fake upstream (abort test); `to` is a
    // path on the shared fake.
    const target = (req.query.url as string) ?? `${upstream.url}${(req.query.to as string) ?? '/ok'}`;
    proxyStream(req, res, target).catch((err: unknown) => {
      if (res.headersSent) {
        // Mirrors index.ts: after headers, only log and sever the connection.
        console.error(`[test] post-header failure: ${(err as Error).message}`);
        res.destroy();
        return;
      }
      const status = err instanceof UpstreamError ? err.status : 502;
      res.status(status).json({ error: (err as Error).message });
    });
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        base: `http://127.0.0.1:${port}`,
        close: () =>
          new Promise<void>((ok, fail) => server.close((e) => (e ? fail(e) : ok()))),
      });
    });
    server.on('error', reject);
  });
}

interface RawResponse {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: Buffer;
}

function rawGet(base: string, path: string, range?: string): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const req = http.get(
      base + path,
      { headers: range ? { Range: range } : undefined },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) }),
        );
        res.on('error', reject);
      },
    );
    req.on('error', reject);
  });
}

let upstream: FakeUpstream;
let app: TestServer;

before(async () => {
  upstream = await startFakeUpstream();
  app = await startTestApp(upstream);
});

after(async () => {
  await app.close();
  await upstream.close();
});

beforeEach(() => {
  upstream.requests.length = 0;
});

// ---------------------------------------------------------------------------
// parseRange: RFC 9110 unit-level checks (size 100 buffer).
// ---------------------------------------------------------------------------

describe('parseRange (RFC 9110 single-range bytes=)', () => {
  const size = 100;

  test('full open range, bounded range, suffix range and end-clamp', () => {
    assert.deepEqual(parseRange('bytes=0-', size), { start: 0, end: 99 });
    assert.deepEqual(parseRange('bytes=10-19', size), { start: 10, end: 19 });
    assert.deepEqual(parseRange('bytes=-25', size), { start: 75, end: 99 });
    assert.deepEqual(parseRange('bytes=90-500', size), { start: 90, end: 99 });
    assert.deepEqual(parseRange('  bytes=10-19  ', size), { start: 10, end: 19 });
  });

  test('416 case 1: start past the end of the resource', () => {
    assert.equal(parseRange('bytes=100-', size), 'unsatisfiable');
    assert.equal(parseRange('bytes=999-1000', size), 'unsatisfiable');
  });

  test('416 case 2: zero-length suffix', () => {
    assert.equal(parseRange('bytes=-0', size), 'unsatisfiable');
  });

  test('416 case 3: end smaller than start', () => {
    assert.equal(parseRange('bytes=50-10', size), 'unsatisfiable');
  });

  test('unparseable and multi-range headers fall back to whole-resource null', () => {
    assert.equal(parseRange(undefined, size), null);
    assert.equal(parseRange('items=0-9', size), null);
    assert.equal(parseRange('bytes=abc-def', size), null);
    assert.equal(parseRange('bytes=-', size), null);
    assert.equal(parseRange('bytes=0-9,20-29', size), null); // multi-range not supported
  });
});

// ---------------------------------------------------------------------------
// In-memory WAV path over real HTTP.
// ---------------------------------------------------------------------------

describe('in-memory buffer streaming', () => {
  test('valid range → 206 with matching Content-Range, Content-Length and body', async () => {
    const res = await rawGet(app.base, '/mem', 'bytes=10-19');
    assert.equal(res.status, 206);
    assert.equal(res.headers['content-range'], 'bytes 10-19/100');
    assert.equal(res.headers['content-length'], '10');
    assert.equal(res.headers['accept-ranges'], 'bytes');
    assert.equal(res.body.length, 10);
    assert.deepEqual(res.body, Buffer.alloc(10, 7));
  });

  test('open-ended and suffix ranges are honoured', async () => {
    const open = await rawGet(app.base, '/mem', 'bytes=90-');
    assert.equal(open.status, 206);
    assert.equal(open.headers['content-range'], 'bytes 90-99/100');
    assert.equal(open.body.length, 10);

    const suffix = await rawGet(app.base, '/mem', 'bytes=-20');
    assert.equal(suffix.status, 206);
    assert.equal(suffix.headers['content-range'], 'bytes 80-99/100');
    assert.equal(suffix.body.length, 20);
  });

  test('416: start out of bounds carries bytes */size and a JSON body', async () => {
    const res = await rawGet(app.base, '/mem', 'bytes=100-');
    assert.equal(res.status, 416);
    assert.equal(res.headers['content-range'], 'bytes */100');
    assert.equal(JSON.parse(res.body.toString('utf8')).error, 'Requested range not satisfiable');
  });

  test('416: zero suffix', async () => {
    const res = await rawGet(app.base, '/mem', 'bytes=-0');
    assert.equal(res.status, 416);
    assert.equal(res.headers['content-range'], 'bytes */100');
    assert.match(res.body.toString('utf8'), /not satisfiable/);
  });

  test('416: end before start', async () => {
    const res = await rawGet(app.base, '/mem', 'bytes=50-10');
    assert.equal(res.status, 416);
    assert.equal(res.headers['content-range'], 'bytes */100');
  });

  test('no Range / malformed / multi-range → whole resource with 200', async () => {
    const none = await rawGet(app.base, '/mem');
    assert.equal(none.status, 200);
    assert.equal(none.headers['content-length'], '100');
    assert.equal(none.body.length, 100);

    const malformed = await rawGet(app.base, '/mem', 'bytes=garbage');
    assert.equal(malformed.status, 200);
    assert.equal(malformed.body.length, 100);

    const multi = await rawGet(app.base, '/mem', 'bytes=0-9,20-29');
    assert.equal(multi.status, 200);
    assert.equal(multi.body.length, 100);
  });
});

// ---------------------------------------------------------------------------
// Proxy path against the local fake upstream.
// ---------------------------------------------------------------------------

describe('proxy streaming', () => {
  test('upstream 200 is relayed end to end and Range is forwarded', async () => {
    const res = await rawGet(app.base, '/proxy?to=/ok', 'bytes=0-31');
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-type'], 'audio/mpeg');
    assert.deepEqual(res.body, FAKE_PAYLOAD);
    assert.equal(upstream.requests[0]?.range, 'bytes=0-31');
  });

  test('upstream 206 Content-Range/Content-Length pass through', async () => {
    const res = await rawGet(app.base, '/proxy?to=/range', 'bytes=8-23');
    assert.equal(res.status, 206);
    assert.equal(res.headers['content-range'], 'bytes 8-23/256');
    assert.equal(res.headers['content-length'], '16');
    assert.deepEqual(res.body, FAKE_PAYLOAD.subarray(8, 24));
  });

  test('upstream 500 (before our headers) becomes a 502 UpstreamError JSON', async () => {
    const res = await rawGet(app.base, '/proxy?to=/fail500');
    assert.equal(res.status, 502);
    const body = JSON.parse(res.body.toString('utf8')) as { error: string };
    assert.match(body.error, /Audio host responded 500/);
  });

  test('upstream 302 redirect is followed (absolute and relative Location)', async () => {
    const absolute = await rawGet(app.base, '/proxy?to=/redirect');
    assert.equal(absolute.status, 200);
    assert.deepEqual(absolute.body, FAKE_PAYLOAD);
    assert.equal(upstream.requests[0]?.url, '/redirect');
    assert.equal(upstream.requests[1]?.url, '/ok');

    const relative = await rawGet(app.base, '/proxy?to=/redirect-relative');
    assert.equal(relative.status, 200);
    assert.deepEqual(relative.body, FAKE_PAYLOAD);
  });

  test('upstream 416 is relayed as 416 with its Content-Range', async () => {
    const res = await rawGet(app.base, '/proxy?to=/upstream-416', 'bytes=9999-');
    assert.equal(res.status, 416);
    assert.equal(res.headers['content-range'], 'bytes */256');
  });

  test('mid-stream upstream failure after headers: socket destroyed, no JSON appended', async () => {
    const res = await new Promise<RawResponse>((resolve, reject) => {
      const req = http.get(app.base + '/proxy?to=/truncate', (r) => {
        const chunks: Buffer[] = [];
        r.on('data', (c: Buffer) => chunks.push(c));
        // A destroyed upstream ends the response abnormally: 'aborted' or 'close'.
        r.on('aborted', () =>
          resolve({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks) }),
        );
        r.on('close', () =>
          resolve({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks) }),
        );
        r.on('error', () =>
          resolve({ status: r.statusCode ?? 0, headers: r.headers, body: Buffer.concat(chunks) }),
        );
      });
      req.on('error', reject);
    });

    assert.equal(res.status, 200); // headers were already sent as 200
    assert.ok(res.body.length > 0 && res.body.length < FAKE_PAYLOAD.length);
    // Crucial invariant: nothing resembling a JSON error trails the audio bytes.
    assert.doesNotMatch(res.body.toString('utf8'), /error|UpstreamError/i);
  });

  test('client early abort destroys the upstream and resolves as a normal end', async () => {
    const observed = await startFakeUpstream();
    try {
      const abortOutcome = await new Promise<'aborted'>((resolve, reject) => {
        const req = http.get(
          app.base + `/proxy?url=${encodeURIComponent(observed.url + '/abort-observed')}`,
          (res) => {
            res.on('data', () => {
              // Simulate a seek / track switch / tab close after the first bytes.
              req.destroy();
              resolve('aborted');
            });
            res.on('error', () => resolve('aborted'));
          },
        );
        req.on('error', () => resolve('aborted'));
        setTimeout(() => reject(new Error('client abort test timed out')), 5000);
      });
      assert.equal(abortOutcome, 'aborted');

      // Give the proxy's 'close' handler a tick to destroy the upstream socket.
      await new Promise((r) => setTimeout(r, 150));
      assert.ok(
        observed.destroyedSockets >= 1,
        `expected upstream socket destruction, got ${observed.destroyedSockets}`,
      );
    } finally {
      await observed.close();
    }
  });
});
