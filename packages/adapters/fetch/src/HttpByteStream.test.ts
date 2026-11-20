import { ByteRange } from '@gyroview/core';
import { describeByteStreamContract } from '@gyroview/core/testing';
import { afterAll, describe, expect, it } from 'vitest';

import { HttpByteStream, type HttpByteStreamOptions } from './HttpByteStream';
import { HttpResource, type HttpResourceOptions } from './HttpResource';
import { TestServer, type TestServerBehaviour } from './test/testServer';

const BODY = Uint8Array.from({ length: 100 }, (_, index) => index);
const NO_WAIT = [0, 0];
const SLOW = { throttle: { chunkBytes: 10, intervalMs: 50 } };

const servers: TestServer[] = [];

async function serve(bytes: Uint8Array, behaviour: TestServerBehaviour = {}): Promise<TestServer> {
  const server = await TestServer.start(bytes, behaviour);
  servers.push(server);
  return server;
}

afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop()));
});

function streamOf(
  url: string,
  options: HttpResourceOptions = {},
  streamOptions: HttpByteStreamOptions = {},
): HttpByteStream {
  return new HttpByteStream(new HttpResource(url, options), streamOptions);
}

function rangesAskedOf(server: TestServer): (string | undefined)[] {
  return server.requests
    .filter((request) => request.method === 'GET')
    .map((request) => request.range);
}

async function bytesOf(stream: HttpByteStream, range: ByteRange): Promise<number[]> {
  const chunks = await Array.fromAsync(stream.stream(range));
  return chunks.flatMap((chunk) => [...chunk]);
}

/**
 * A fetch that answers every byte range with `answer` and passes the size lookup on.
 */
function answeringRanges(answer: () => Response): typeof fetch {
  return (input, init) => (init?.method === 'GET' ? Promise.resolve(answer()) : fetch(input, init));
}

/**
 * A fetch that passes the first byte range on and answers every later one with a server error.
 */
function laterRangesFailing(): typeof fetch {
  let ranges = 0;
  return (input, init) => {
    if (init?.method === 'GET') ranges += 1;
    const isLaterRange = init?.method === 'GET' && ranges > 1;
    return isLaterRange ? Promise.resolve(new Response(null, { status: 503 })) : fetch(input, init);
  };
}

/**
 * A fetch that answers the first byte range with a server error and passes everything on.
 */
function firstRangeFailing(): typeof fetch {
  let ranges = 0;
  return (input, init) => {
    if (init?.method === 'GET') ranges += 1;
    const isFirstRange = init?.method === 'GET' && ranges === 1;
    return isFirstRange ? Promise.resolve(new Response(null, { status: 503 })) : fetch(input, init);
  };
}

describeByteStreamContract('over HTTP', async (bytes) => {
  const server = await serve(bytes);
  return streamOf(server.url);
});

/**
 * Replaces the server's recording once the first byte range has been answered, so its version is
 * the one the stream fixed on: the resume that follows reads from the new recording.
 */
function replacedAfterFirstRange(
  server: TestServer,
  validators: Parameters<TestServer['replace']>[1],
): typeof fetch {
  return async (input, init) => {
    const response = await fetch(input, init);
    if (init?.method === 'GET' && response.status === 206) {
      const ranges = server.requests.filter((request) => request.method === 'GET').length;
      if (ranges === 1) server.replace(new Uint8Array(100), validators);
    }
    return response;
  };
}

describe('HttpByteStream', () => {
  it('hands each chunk on as it comes, before the range has all come', async () => {
    const server = await serve(BODY, SLOW);
    const chunks = streamOf(server.url).stream(ByteRange.of(0, 40))[Symbol.asyncIterator]();
    const first = await chunks.next();
    expect(first.done === true ? 0 : first.value.byteLength).toBeLessThan(40);
    await chunks.return?.();
  });

  it('ends the request at once when given up', async () => {
    const server = await serve(BODY, SLOW);
    const chunks = streamOf(server.url).stream(ByteRange.of(0, 100))[Symbol.asyncIterator]();
    await chunks.next();
    await chunks.return?.();
    await expect.poll(() => server.requests.at(-1)?.wasCutShort).toBe(true);
  });

  it('asks again for a range whose server fails on the way, and streams it', async () => {
    const server = await serve(BODY);
    const stream = streamOf(server.url, { fetch: firstRangeFailing(), retryDelaysMs: NO_WAIT });
    await expect(bytesOf(stream, ByteRange.of(10, 20))).resolves.toEqual([
      ...BODY.subarray(10, 30),
    ]);
  });

  it('reports a server that ignores Range requests with the range-unsupported code', async () => {
    const server = await serve(BODY, { ignoresRanges: true });
    await expect(bytesOf(streamOf(server.url), ByteRange.of(10, 20))).rejects.toMatchObject({
      code: 'range-unsupported',
    });
  });

  it('fails a range answered from other bytes than asked, naming both', async () => {
    const server = await serve(BODY);
    const otherBytes = answeringRanges(
      () =>
        new Response(BODY.subarray(0, 20), {
          status: 206,
          headers: { 'Content-Range': 'bytes 0-19/100' },
        }),
    );
    await expect(
      bytesOf(streamOf(server.url, { fetch: otherBytes }), ByteRange.of(10, 20)),
    ).rejects.toMatchObject({
      code: 'source-unreadable',
      message: `${server.url} answered bytes 0-19 to a request for bytes 10-29`,
    });
  });

  it('fails a range whose body comes short with source-truncated', async () => {
    const server = await serve(BODY);
    const short = answeringRanges(() => new Response(BODY.subarray(10, 25), { status: 206 }));
    await expect(
      bytesOf(streamOf(server.url, { fetch: short }), ByteRange.of(10, 20)),
    ).rejects.toMatchObject({
      code: 'source-truncated',
      message: `${server.url} returned 15 bytes for a 20-byte range at 10`,
    });
  });

  it('fails a range whose body runs past it', async () => {
    const server = await serve(BODY);
    const long = answeringRanges(() => new Response(BODY.subarray(10, 35), { status: 206 }));
    await expect(
      bytesOf(streamOf(server.url, { fetch: long }), ByteRange.of(10, 20)),
    ).rejects.toMatchObject({
      code: 'source-unreadable',
      message: `${server.url} sent more than the 20-byte range at 10`,
    });
  });

  it('asks for the rest of a range that broke off, from its next byte', async () => {
    const server = await serve(BODY, { breaksOffRanges: 1 });
    const stream = streamOf(server.url, { retryDelaysMs: NO_WAIT });
    await expect(bytesOf(stream, ByteRange.of(0, 100))).resolves.toEqual([...BODY]);
    expect(rangesAskedOf(server)).toEqual(['bytes=0-99', 'bytes=50-99']);
  });

  it('asks for the rest of a range that stalled, once no byte came for the stall timeout', async () => {
    const server = await serve(BODY, { stallsRanges: 1 });
    const stream = streamOf(server.url, { retryDelaysMs: NO_WAIT }, { stallTimeoutMs: 100 });
    await expect(bytesOf(stream, ByteRange.of(0, 100))).resolves.toEqual([...BODY]);
    expect(rangesAskedOf(server)).toEqual(['bytes=0-99', 'bytes=50-99']);
    expect(server.requests.find((request) => request.method === 'GET')?.wasCutShort).toBe(true);
  });

  it('fails a range whose rest cannot be had once the retries are spent', async () => {
    const server = await serve(BODY, { breaksOffRanges: 1 });
    const stream = streamOf(server.url, { fetch: laterRangesFailing(), retryDelaysMs: NO_WAIT });
    await expect(bytesOf(stream, ByteRange.of(0, 100))).rejects.toMatchObject({
      code: 'source-unreadable',
      message: `${server.url} answered 503 to a byte range`,
    });
  });

  it('given up while stalled, ends the request and asks for nothing more', async () => {
    const server = await serve(BODY, { stallsRanges: 1 });
    const chunks = streamOf(server.url).stream(ByteRange.of(0, 100))[Symbol.asyncIterator]();
    await chunks.next();
    const awaited = chunks.next();
    await chunks.return?.();
    await expect(awaited).resolves.toMatchObject({ done: true });
    await expect.poll(() => server.requests.at(-1)?.wasCutShort).toBe(true);
    expect(rangesAskedOf(server)).toEqual(['bytes=0-99']);
  });

  it('asks no more for a size whose lookup still failed once its own waits ran out', async () => {
    const server = await serve(BODY, { failsWith: 503 });
    const stream = streamOf(server.url, { retryDelaysMs: NO_WAIT });
    await expect(bytesOf(stream, ByteRange.of(10, 20))).rejects.toMatchObject({
      code: 'source-unreadable',
      message: expect.stringContaining('answered 503 to a byte range') as string,
    });
    const methods = server.requests.map((request) => request.method);
    expect(methods).toEqual(['HEAD', 'HEAD', 'HEAD', 'GET']);
  });

  it('fails with source-changed once the recording at the URL is replaced', async () => {
    const server = await serve(BODY, {
      validators: { lastModified: 'Wed, 30 Sep 2026 10:00:00 GMT' },
    });
    const stream = streamOf(server.url);
    await bytesOf(stream, ByteRange.of(0, 10));
    server.replace(BODY, { lastModified: 'Thu, 01 Oct 2026 10:00:00 GMT' });
    await expect(bytesOf(stream, ByteRange.of(10, 10))).rejects.toMatchObject({
      code: 'source-changed',
    });
  });

  it('reports source-changed, not source-unreadable, when a resume after a break meets the replacement', async () => {
    const server = await serve(BODY, {
      breaksOffRanges: 1,
      validators: { etag: '"v1"' },
    });
    const fetching = replacedAfterFirstRange(server, { etag: '"v2"' });
    const stream = streamOf(server.url, { fetch: fetching, retryDelaysMs: NO_WAIT });

    await expect(bytesOf(stream, ByteRange.of(0, 100))).rejects.toMatchObject({
      code: 'source-changed',
      message: `${server.url} was replaced while it played; load it again`,
    });
    // The first range broke off, its resume alone met the replacement: no retry on source-changed.
    expect(rangesAskedOf(server)).toEqual(['bytes=0-99', 'bytes=50-99']);
  });

  it('reports source-changed when a resume after a stall meets the replacement, without retrying', async () => {
    const server = await serve(BODY, {
      stallsRanges: 1,
      validators: { etag: '"v1"' },
    });
    const fetching = replacedAfterFirstRange(server, { etag: '"v2"' });
    const stream = streamOf(
      server.url,
      { fetch: fetching, retryDelaysMs: NO_WAIT },
      { stallTimeoutMs: 100 },
    );

    await expect(bytesOf(stream, ByteRange.of(0, 100))).rejects.toMatchObject({
      code: 'source-changed',
    });
    expect(rangesAskedOf(server)).toEqual(['bytes=0-99', 'bytes=50-99']);
  });

  it('answers neither a byte nor the old size once sealed, until the resource is reloaded', async () => {
    const server = await serve(BODY, {
      validators: { lastModified: 'Wed, 30 Sep 2026 10:00:00 GMT' },
    });
    const resource = new HttpResource(server.url);
    const stream = new HttpByteStream(resource);
    await expect(resource.size()).resolves.toBe(BODY.byteLength);
    await bytesOf(stream, ByteRange.of(0, 10));
    const requestsAtChange = server.requests.length;
    server.replace(
      Uint8Array.from({ length: 250 }, () => 1),
      {
        lastModified: 'Thu, 01 Oct 2026 10:00:00 GMT',
      },
    );

    await expect(bytesOf(stream, ByteRange.of(10, 10))).rejects.toMatchObject({
      code: 'source-changed',
    });
    await expect(resource.size()).rejects.toMatchObject({ code: 'source-changed' });
    await expect(bytesOf(stream, ByteRange.of(20, 10))).rejects.toMatchObject({
      code: 'source-changed',
    });
    expect(server.requests.length).toBe(requestsAtChange + 1);

    resource.reload();
    await expect(resource.size()).resolves.toBe(250);
    await expect(bytesOf(stream, ByteRange.of(0, 10))).resolves.toEqual(
      Array.from({ length: 10 }, () => 1),
    );
  });

  it('resumes a range that broke off when only the network blinked and the version held', async () => {
    const server = await serve(BODY, {
      breaksOffRanges: 1,
      validators: { etag: '"v1"' },
    });
    const stream = streamOf(server.url, { retryDelaysMs: NO_WAIT });

    await expect(bytesOf(stream, ByteRange.of(0, 100))).resolves.toEqual([...BODY]);
    expect(rangesAskedOf(server)).toEqual(['bytes=0-99', 'bytes=50-99']);
  });

  it('resumes a stalled range once the network carries bytes again, the version held', async () => {
    const server = await serve(BODY, {
      stallsRanges: 1,
      validators: { etag: '"v1"' },
    });
    const stream = streamOf(server.url, { retryDelaysMs: NO_WAIT }, { stallTimeoutMs: 100 });

    await expect(bytesOf(stream, ByteRange.of(0, 100))).resolves.toEqual([...BODY]);
    expect(rangesAskedOf(server)).toEqual(['bytes=0-99', 'bytes=50-99']);
  });

  it('aborts the in-flight request and starts nothing new when a read is given up after a break', async () => {
    const server = await serve(BODY, {
      breaksOffRanges: 1,
      validators: { etag: '"v1"' },
    });
    // The resume after the break is answered but its body is held open, so the read is still in
    // flight when it is given up; the stream's abort closes the held body.
    let ranges = 0;
    const holdingResume: typeof fetch = async (input, init) => {
      if (init?.method === 'GET') ranges += 1;
      const response = await fetch(input, init);
      if (init?.method !== 'GET') return response;
      if (ranges !== 2) return response;
      const signal = init.signal;
      const held = new ReadableStream<Uint8Array>({
        start(controller): void {
          signal?.addEventListener(
            'abort',
            () => {
              controller.error(signal.reason);
            },
            { once: true },
          );
        },
      });
      return new Response(held, {
        status: 206,
        headers: { 'Content-Range': 'bytes 50-99/100' },
      });
    };
    const stream = streamOf(server.url, { fetch: holdingResume, retryDelaysMs: NO_WAIT });
    const chunks = stream.stream(ByteRange.of(0, 100))[Symbol.asyncIterator]();
    await chunks.next();
    // The first body broke off after half its bytes; the next read asks for the rest and waits.
    const readingOn = chunks.next();
    await expect.poll(() => rangesAskedOf(server)).toEqual(['bytes=0-99', 'bytes=50-99']);
    const requestsOnReturn = server.requests.length;

    // Giving up aborts the request for the rest and starts nothing afterwards.
    await expect(chunks.return?.()).resolves.toMatchObject({ done: true });
    await expect(readingOn).resolves.toMatchObject({ done: true });
    await new Promise((resolve) => {
      setTimeout(resolve, 50);
    });
    // No third request follows the aborted resume, and the aborted signal ended the held body.
    expect(rangesAskedOf(server)).toEqual(['bytes=0-99', 'bytes=50-99']);
    expect(server.requests.length).toBe(requestsOnReturn);
    await expect(chunks.next()).resolves.toMatchObject({ done: true });
  });
});
