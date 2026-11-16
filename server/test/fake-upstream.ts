/**
 * Local fake audio upstream for the proxy tests. Plain node:http server —
 * no external network, no Yandex credentials. Behaviour is selected per path:
 *
 *   /ok[?chunks=N]          200, body delivered in small chunks (slow drip)
 *   /range                  echoes Range back as 206 + Content-Range
 *   /fail500                500 with a JSON-ish body
 *   /redirect               302 → /ok
 *   /redirect-relative      302 → /ok (relative Location, RFC 9110 ref)
 *   /upstream-416           416 with Content-Range unsatisfied marker
 *   /truncate               200, one chunk, then the upstream socket dies
 *   /abort-observed         200 slow drip; records whether the socket was
 *                           destroyed by the proxy (client-abort test)
 */
import http from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeUpstream {
  url: string;
  /** Requests the fake received, with the Range header the proxy forwarded. */
  requests: Array<{ url: string; range?: string }>;
  /** Number of upstream sockets destroyed before their natural 'close'. */
  destroyedSockets: number;
  close: () => Promise<void>;
}

const PAYLOAD = Buffer.from(
  'FAKE-AUDIO-PAYLOAD-'.repeat(16).slice(0, 256),
  'utf8',
);

export function startFakeUpstream(): Promise<FakeUpstream> {
  const requests: FakeUpstream['requests'] = [];
  let destroyedSockets = 0;

  const server = http.createServer((req, res) => {
    requests.push({ url: req.url ?? '/', range: req.headers.range });

    req.socket.on('close', (hadError: boolean) => {
      // `destroyed` on a fully-consumed socket is false; a proxy-side abort
      // leaves it true.
      if (req.socket.destroyed || hadError) destroyedSockets += 1;
    });

    const pathname = (req.url ?? '/').split('?')[0] as string;

    switch (pathname) {
      case '/fail500':
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'simulated upstream failure' }));
        return;

      case '/redirect':
        res.writeHead(302, { Location: '/ok' });
        res.end();
        return;

      case '/redirect-relative':
        res.writeHead(302, { Location: 'ok' });
        res.end();
        return;

      case '/upstream-416':
        res.writeHead(416, {
          'Content-Range': `bytes */${PAYLOAD.length}`,
          'Content-Type': 'audio/mpeg',
        });
        res.end();
        return;

      case '/range': {
        const m = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '');
        const start = m ? Number(m[1]) : 0;
        const end = m && m[2] ? Number(m[2]) : PAYLOAD.length - 1;
        res.writeHead(206, {
          'Content-Type': 'audio/mpeg',
          'Content-Range': `bytes ${start}-${end}/${PAYLOAD.length}`,
          'Content-Length': String(end - start + 1),
          'Accept-Ranges': 'bytes',
        });
        res.end(PAYLOAD.subarray(start, end + 1));
        return;
      }

      case '/truncate':
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(PAYLOAD.length),
        });
        // Flush the head + first chunk before dying, so the proxy really is
        // mid-body when the upstream fails (destroying synchronously could
        // RST the socket and discard the buffered head on some platforms).
        res.write(PAYLOAD.subarray(0, 16), () => {
          setTimeout(() => res.destroy(), 15);
        });
        return;

      case '/ok':
      case '/abort-observed':
      default: {
        res.writeHead(200, {
          'Content-Type': 'audio/mpeg',
          'Content-Length': String(PAYLOAD.length),
          'Accept-Ranges': 'bytes',
        });
        const chunkSize = 16;
        let offset = 0;
        const drip = (): void => {
          if (offset >= PAYLOAD.length) {
            res.end();
            return;
          }
          const next = Math.min(offset + chunkSize, PAYLOAD.length);
          res.write(PAYLOAD.subarray(offset, next));
          offset = next;
          setTimeout(drip, 10);
        };
        drip();
      }
    }
  });

  return new Promise((resolve, reject) => {
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        get destroyedSockets() {
          return destroyedSockets;
        },
        close: () =>
          new Promise<void>((closeResolve, closeReject) =>
            server.close((err) => (err ? closeReject(err) : closeResolve())),
          ),
      });
    });
  });
}

export const FAKE_PAYLOAD = PAYLOAD;
