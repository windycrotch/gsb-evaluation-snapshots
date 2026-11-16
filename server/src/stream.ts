/**
 * Shared stream teardown semantics for /api/stream/:id.
 *
 * Two transport paths live here so their end-of-stream rules stay identical:
 *
 * 1. In-memory buffers (demo WAVs): RFC 9110 single-range `bytes=` parsing.
 *    Unparseable/multi-range headers are ignored and the whole resource is
 *    served with 200; an unsatisfiable single range gets 416 with the
 *    unsatisfied-range Content-Range marker (`bytes ` + star + slash + size)
 *    and a JSON body.
 *
 * 2. Upstream proxy (real Yandex account audio host): upstream statuses other
 *    than 200/206/416 become a 502 UpstreamError. If response headers were
 *    already sent, no JSON or second `end()` is possible — we log and destroy
 *    the socket instead. A client disconnect (seek, next track, tab close)
 *    always destroys the upstream and is treated as a normal end, never an
 *    error.
 */
import type { Request, Response } from 'express';
import http from 'node:http';
import https from 'node:https';
import type { IncomingMessage } from 'node:http';
import type { ApiError } from '@shared';
import { UpstreamError, errorMessage } from './yandex';

/** A parsed, satisfiable byte range (both bounds inclusive). */
export type ParsedRange = { start: number; end: number } | 'unsatisfiable' | null;

/**
 * Parses a single-range `bytes=` header per RFC 9110 §14.1.2.
 *
 * Returns:
 *  - a normalized {start, end} for a satisfiable single range;
 *  - 'unsatisfiable' for a syntactically valid single range that cannot be
 *    served (start past the end, a zero-length suffix, end < start);
 *  - null when the header is absent/malformed or carries multiple ranges —
 *    callers then serve the whole representation with 200.
 */
export function parseRange(header: string | undefined, size: number): ParsedRange {
  if (typeof header !== 'string') return null;
  const text = header.trim();
  const m = /^bytes=(\d*)-(\d*)$/.exec(text);
  if (!m) return null; // malformed (incl. multi-range "bytes=0-1,2-3"): ignore
  const startStr = m[1] as string;
  const endStr = m[2] as string;
  if (!startStr && !endStr) return null; // "bytes=-": not a range spec at all

  if (!startStr) {
    // Suffix range: bytes=-N → the final N bytes.
    if (!/^\d+$/.test(endStr)) return null;
    const suffix = Number(endStr);
    if (suffix === 0) return 'unsatisfiable';
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }

  if (!/^\d+$/.test(startStr)) return null;
  const start = Number(startStr);
  if (start >= size) return 'unsatisfiable';

  if (!endStr) {
    // Open-ended range: bytes=N- → the remainder of the representation.
    return { start, end: size - 1 };
  }
  if (!/^\d+$/.test(endStr)) return null;
  const end = Number(endStr);
  if (end < start) return 'unsatisfiable';
  // An end past the resource is simply clamped per RFC 9110.
  return { start, end: Math.min(end, size - 1) };
}

/**
 * Serves an in-memory buffer with byte-range support. Never throws: a client
 * that disconnects mid-response just stops the write.
 */
export function serveBufferWithRange(
  req: Request,
  res: Response,
  buf: Buffer,
  contentType: string,
): void {
  res.setHeader('Accept-Ranges', 'bytes');
  const range = parseRange(req.headers.range, buf.length);
  if (range === 'unsatisfiable') {
    res.setHeader('Content-Range', `bytes */${buf.length}`);
    res.status(416).json({ error: 'Requested range not satisfiable' } satisfies ApiError);
    return;
  }
  if (range) {
    res.status(206);
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${buf.length}`);
    res.setHeader('Content-Length', String(range.end - range.start + 1));
    res.end(buf.subarray(range.start, range.end + 1));
    return;
  }
  // No (parseable) Range header: full representation with 200.
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Length', String(buf.length));
  res.end(buf);
}

/** Pick the transport for a URL — https in production, http for test fakes. */
function transportFor(url: string): typeof https {
  return new URL(url).protocol === 'http:' ? (http as unknown as typeof https) : https;
}

/**
 * Proxies a signed upstream audio URL to the client, forwarding Range and
 * relaying 200/206/416 statuses and the relevant entity headers. Follows a
 * small number of redirects.
 *
 * Resolution rules:
 *  - Any other upstream status (or an unreachable upstream) rejects with an
 *    UpstreamError(502) while our response headers are still unsent, so the
 *    route handler can emit a JSON 502.
 *  - Once our headers are sent and the upstream fails mid-body, there is no
 *    valid way to add an error: the failure is logged and the connection is
 *    destroyed (truncated body, no double `end()` / no JSON after bytes).
 *  - `close` on the client response (seek, track switch, tab close) destroys
 *    the in-flight upstream immediately and resolves normally.
 */
export function proxyStream(
  req: Request,
  res: Response,
  url: string,
  redirectsLeft = 3,
): Promise<void> {
  const headers: Record<string, string> = { 'User-Agent': 'Yandex-Music-API' };
  if (typeof req.headers.range === 'string') headers['Range'] = req.headers.range;

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    /** The currently active upstream socket, replaced on every redirect. */
    let upstream: http.ClientRequest | null = null;

    const finish = (err?: unknown): void => {
      if (settled) return;
      settled = true;
      if (err) reject(err instanceof Error ? err : new Error(String(err)));
      else resolve();
    };

    // The client may already have gone away while the caller was awaiting the
    // signed-URL resolution — the `close` event would then have fired before
    // our listener exists. Treat that as an immediate, normal end.
    if (res.destroyed) {
      resolve();
      return;
    }

    // Client went away (seek, next track, tab close): drop whatever upstream
    // request is in flight — including one still connecting or a redirect
    // chain being followed. This is a normal end, not an error.
    res.on('close', function abortUpstreamOnClose(): void {
      if (res.writableFinished) return; // clean end after the full body
      upstream?.destroy();
      finish();
    });

    const follow = (nextUrl: string, remaining: number): void => {
      const transport = transportFor(nextUrl);
      // Flips on once our response status/headers are committed. Past that
      // point upstream failures can only be logged + connection-destroyed,
      // never converted into an HTTP error response.
      let ourHeadersSent = false;
      const current = transport.get(nextUrl, { headers }, (u: IncomingMessage) => {
        // Connected: cancel the connect timeout so the stream may idle while
        // the browser buffers ahead and pauses reading (backpressure) — a long
        // idle is normal for audio playback and must NOT kill the upstream.
        current.setTimeout(0);
        const status = u.statusCode ?? 502;

        // Follow redirects (some audio hosts 302 to a CDN edge).
        if (status >= 300 && status < 400 && u.headers.location && remaining > 0) {
          u.resume();
          follow(new URL(u.headers.location, nextUrl).toString(), remaining - 1);
          return;
        }

        if (status !== 200 && status !== 206 && status !== 416) {
          u.resume();
          finish(new UpstreamError(502, `Audio host responded ${status}`));
          return;
        }

        res.status(status);
        for (const name of ['content-type', 'content-length', 'content-range'] as const) {
          const value = u.headers[name];
          if (value) res.setHeader(name, value);
        }
        if (!u.headers['content-type']) res.setHeader('Content-Type', 'audio/mpeg');
        res.setHeader('Accept-Ranges', u.headers['accept-ranges'] ?? 'bytes');

        if (status === 416) {
          // Relay the upstream's unsatisfiable-range answer; headers above
          // carry its Content-Range when present.
          u.resume();
          res.end();
          finish();
          return;
        }

        ourHeadersSent = true;
        // Body streaming begins here — any failure past this point can no
        // longer be reported as JSON. Log and sever the connection instead.
        u.on('error', (err) => {
          if (settled) return; // client abort already tore everything down
          console.error(
            `[stream] upstream failed after ${res.statusCode} headers were sent: ${errorMessage(err)}`,
          );
          res.destroy();
          finish();
        });
        u.on('end', () => finish());
        u.pipe(res);
      });
      upstream = current;

      current.on('error', (err) => {
        if (settled) return;
        // A client abort destroys the upstream on purpose — don't turn that
        // teardown into an UpstreamError.
        if (res.destroyed || res.writableEnded) {
          finish();
          return;
        }
        if (ourHeadersSent) {
          // The socket died after our response headers were committed (the
          // error can surface on either the request or the response stream).
          // No JSON/second end() is legal anymore: log and cut the client off.
          console.error(
            `[stream] upstream socket failed after headers were sent: ${errorMessage(err)}`,
          );
          res.destroy();
          finish();
          return;
        }
        finish(new UpstreamError(502, `Could not reach audio host: ${errorMessage(err)}`));
      });
      current.setTimeout(15_000, () => current.destroy(new Error('audio host connect timed out')));
    };

    follow(url, redirectsLeft);
  });
}
