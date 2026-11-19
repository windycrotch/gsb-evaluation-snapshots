import { ByteRange } from '@gyroview/core';
import { describe, expect, it } from 'vitest';

import { HttpByteStream, type HttpByteStreamOptions } from './HttpByteStream';
import { HttpResource, type HttpResourceOptions } from './HttpResource';
import { RangeServer } from './test/rangeServer';

const URL = 'https://media.example/recording.insv';
const BODY = Uint8Array.from({ length: 100 }, (_, index) => index);
const NO_WAIT = [0, 0];
const QUICK_STALL = { stallTimeoutMs: 50 };

function streamWith(
  server: RangeServer,
  options: HttpResourceOptions = {},
  streamOptions: HttpByteStreamOptions = {},
): HttpByteStream {
  const resource = new HttpResource(URL, {
    fetch: server.fetch,
    retryDelaysMs: NO_WAIT,
    ...options,
  });
  return new HttpByteStream(resource, streamOptions);
}

async function bytesOf(stream: HttpByteStream, range: ByteRange): Promise<number[]> {
  const chunks = await Array.fromAsync(stream.stream(range));
  return chunks.flatMap((chunk) => [...chunk]);
}

/**
 * A monotonic clock whose reads run through `times` in turn, then hold the last.
 */
function clockReading(times: readonly number[]): () => number {
  let read = 0;
  return (): number => times[read++] ?? times.at(-1) ?? 0;
}

/**
 * A fetch that refuses every ordinary request (as a server withholding CORS does) while its
 * no-CORS probe still reaches the server, exactly as the browser would report the distinction.
 */
const corsBlocked: typeof fetch = (_input, init) =>
  init?.mode === 'no-cors'
    ? Promise.resolve(new Response(null, { status: 200 }))
    : Promise.reject(new TypeError('Failed to fetch'));

describe('HttpByteStream resume', () => {
  it('resumes a stream that broke off from the next byte and completes it whole', async () => {
    const server = new RangeServer(BODY, { etag: '"v1"' });
    server.breakOff(40);
    const stream = streamWith(server);

    await expect(bytesOf(stream, ByteRange.of(0, 100))).resolves.toEqual([...BODY]);
    expect(server.rangesAsked).toEqual(['bytes=0-99', 'bytes=40-99']);
  });

  it('keeps the received count across several resumes and never repeats a byte', async () => {
    const server = new RangeServer(BODY, { etag: '"v1"' });
    server.breakOff(25);
    server.breakOff(25);
    server.breakOff(25);
    const stream = streamWith(server);

    await expect(bytesOf(stream, ByteRange.of(0, 100))).resolves.toEqual([...BODY]);
    expect(server.rangesAsked).toEqual(['bytes=0-99', 'bytes=25-99', 'bytes=50-99', 'bytes=75-99']);
  });

  it('resumes from the middle of a sub-range, keeping the original range for its checks', async () => {
    const server = new RangeServer(BODY, { etag: '"v1"' });
    // The 20-byte range at offset 10 breaks after 8 bytes; the resume asks for the other 12.
    server.breakOff(8);
    const stream = streamWith(server);

    await expect(bytesOf(stream, ByteRange.of(10, 20))).resolves.toEqual([
      ...BODY.subarray(10, 30),
    ]);
    expect(server.rangesAsked).toEqual(['bytes=10-29', 'bytes=18-29']);
  });

  it('resumes a range that stalled once no byte came for the stall timeout', async () => {
    const server = new RangeServer(BODY, { etag: '"v1"' });
    server.stall(30);
    const stream = streamWith(server, {}, QUICK_STALL);

    await expect(bytesOf(stream, ByteRange.of(0, 100))).resolves.toEqual([...BODY]);
    expect(server.rangesAsked).toEqual(['bytes=0-99', 'bytes=30-99']);
  });

  it('counts a resumed request that breaks off again against the same received count, not from zero', async () => {
    const server = new RangeServer(BODY, { etag: '"v1"' });
    server.stall(30);
    server.breakOff(20);
    const stream = streamWith(server, {}, QUICK_STALL);

    await expect(bytesOf(stream, ByteRange.of(0, 100))).resolves.toEqual([...BODY]);
    expect(server.rangesAsked).toEqual([
      'bytes=0-99', // stalled after 30
      'bytes=30-99', // resumed, then broke off after 20 more (received now 50)
      'bytes=50-99', // whole
    ]);
  });

  it('reports source-changed, not a spliced body, when the server changes version on resume', async () => {
    const server = new RangeServer(BODY, { etag: '"v1"' });
    server.breakOff(40);
    // The first answer breaks off after pinning version v1; the resumed answer is of a new file.
    server.replaceBeforeNextRange(
      BODY.map((byte) => (byte + 1) % 256),
      '"v2"',
    );
    const stream = streamWith(server);

    await expect(bytesOf(stream, ByteRange.of(0, 100))).rejects.toMatchObject({
      code: 'source-changed',
      message: `${URL} was replaced while it played; load it again`,
    });
    expect(server.rangesAsked).toEqual(['bytes=0-99', 'bytes=40-99']);
  });

  it('does not ask again for source-changed: the version refusal stands at once', async () => {
    const server = new RangeServer(BODY, { etag: '"v1"' });
    server.breakOff(40);
    server.replaceBeforeNextRange(BODY, '"v2"');
    const stream = streamWith(server);

    await expect(bytesOf(stream, ByteRange.of(0, 100))).rejects.toMatchObject({
      code: 'source-changed',
    });
    // The break-off asked for one resume; the version refusal was not retried into a third range.
    expect(server.rangesAsked).toEqual(['bytes=0-99', 'bytes=40-99']);
  });

  it('fails at once with range-unsupported when a server answers 200 to a resumed range', async () => {
    const server = new RangeServer(BODY, { etag: '"v1"' });
    server.breakOff(40);
    let gets = 0;
    // The first range breaks off; the resumed range is answered with a whole-file 200.
    const fetchOnceBroken: typeof fetch = (input, init) => {
      const isGet = (init?.method ?? 'GET') === 'GET';
      const isResumedRange = isGet && gets >= 1;
      if (isGet) gets += 1;
      return isResumedRange
        ? Promise.resolve(new Response(BODY, { status: 200 }))
        : server.fetch(input, init);
    };
    const resource = new HttpResource(URL, { fetch: fetchOnceBroken, retryDelaysMs: NO_WAIT });
    const stream = new HttpByteStream(resource);

    await expect(bytesOf(stream, ByteRange.of(0, 100))).rejects.toMatchObject({
      code: 'range-unsupported',
    });
    expect(gets).toBe(2);
  });

  it('fails at once with cors when the first range is refused before any range came through', async () => {
    const stream = streamWith(new RangeServer(BODY), { fetch: corsBlocked });

    await expect(bytesOf(stream, ByteRange.of(0, 100))).rejects.toMatchObject({ code: 'cors' });
  });

  it('stops resuming once the resume count is spent, so a dead server is not asked for ever', async () => {
    const server = new RangeServer(BODY, { etag: '"v1"' });
    for (let index = 0; index < 10; index += 1) server.breakOff(10);
    // Two resumes allowed: first request + two resumes = three requests in all.
    const stream = streamWith(server, {}, { maxResumes: 2 });

    await expect(bytesOf(stream, ByteRange.of(0, 100))).rejects.toMatchObject({
      code: 'source-unreadable',
      message: expect.stringContaining('after 2 resumes') as string,
    });
    expect(server.rangesAsked).toEqual(['bytes=0-99', 'bytes=10-99', 'bytes=20-99']);
  });

  it('does not count the first request against the resume limit', async () => {
    const server = new RangeServer(BODY, { etag: '"v1"' });
    const stream = streamWith(server, {}, { maxResumes: 0 });

    // No break-off: the single first request completes, and no resume was needed.
    await expect(bytesOf(stream, ByteRange.of(0, 100))).resolves.toEqual([...BODY]);
    expect(server.rangesAsked).toEqual(['bytes=0-99']);
  });

  it('does not spend a body resume on a 5xx retried before the answer, so a later break-off still resumes', async () => {
    const server = new RangeServer(BODY, { etag: '"v1"' });
    server.breakOff(10);
    // The first two GETs fail on the way with 503 (each retried on the resource's waits); the
    // third is the body that breaks off. With only one resume allowed, the read must still finish.
    let gets = 0;
    const fetchWithFailures: typeof fetch = (input, init) => {
      const isGet = (init?.method ?? 'GET') === 'GET';
      if (isGet) {
        gets += 1;
        if (gets <= 2) return Promise.resolve(new Response(null, { status: 503 }));
      }
      return server.fetch(input, init);
    };
    const stream = streamWith(server, { fetch: fetchWithFailures }, { maxResumes: 1 });

    await expect(bytesOf(stream, ByteRange.of(0, 100))).resolves.toEqual([...BODY]);
    expect(gets).toBe(4);
    expect(server.rangesAsked).toEqual(['bytes=0-99', 'bytes=10-99']);
  });

  it('stops resuming once the total read time is spent', async () => {
    const server = new RangeServer(BODY, { etag: '"v1"' });
    for (let index = 0; index < 10; index += 1) server.breakOff(10);
    // The resource times its own answers on a separate clock; the stream's clock reads the start
    // as 0 and the first resume as 2 000 ms, past the 1 s budget.
    const resource = new HttpResource(URL, {
      fetch: server.fetch,
      retryDelaysMs: NO_WAIT,
      now: (): number => 0,
    });
    const stream = new HttpByteStream(resource, {
      maxResumes: 10,
      maxReadMs: 1000,
      now: clockReading([0, 2000]),
    });

    await expect(bytesOf(stream, ByteRange.of(0, 100))).rejects.toMatchObject({
      code: 'source-unreadable',
      message: expect.stringContaining('within 1000 ms') as string,
    });
    // The first request broke off; its resume was refused by the time budget before another GET.
    expect(server.rangesAsked).toEqual(['bytes=0-99']);
  });

  it('lets a read that stays within its total time resume several times', async () => {
    const server = new RangeServer(BODY, { etag: '"v1"' });
    server.breakOff(10);
    server.breakOff(10);
    const resource = new HttpResource(URL, {
      fetch: server.fetch,
      retryDelaysMs: NO_WAIT,
      now: (): number => 0,
    });
    const stream = new HttpByteStream(resource, {
      maxResumes: 5,
      maxReadMs: 1000,
      now: clockReading([0, 10, 20]),
    });

    await expect(bytesOf(stream, ByteRange.of(0, 100))).resolves.toEqual([...BODY]);
    expect(server.rangesAsked).toEqual(['bytes=0-99', 'bytes=10-99', 'bytes=20-99']);
  });

  it('keeps two concurrent ranges apart: their counts, resumes and cancellation do not cross', async () => {
    const server = new RangeServer(BODY, { etag: '"v1"' });
    // The first range asked stalls; the second range (another reader) streams whole.
    server.stall(10);
    const stream = streamWith(server, {}, QUICK_STALL);

    const first = stream.stream(ByteRange.of(0, 40))[Symbol.asyncIterator]();
    const second = stream.stream(ByteRange.of(60, 20))[Symbol.asyncIterator]();

    const firstChunk = await first.next();
    expect(firstChunk.done === true ? 0 : [...firstChunk.value]).toEqual([...BODY.subarray(0, 10)]);
    const secondWhole: number[] = [];
    for (;;) {
      const read = await second.next();
      if (read.done) break;
      secondWhole.push(...read.value);
    }
    expect(secondWhole).toEqual([...BODY.subarray(60, 80)]);

    // The first range resumes from byte 10 of its own range, never touching the second's.
    const firstRest: number[] = [];
    for (;;) {
      const read = await first.next();
      if (read.done) break;
      firstRest.push(...read.value);
    }
    expect(firstRest).toEqual([...BODY.subarray(10, 40)]);
    expect(server.rangesAsked).toEqual(['bytes=0-39', 'bytes=60-79', 'bytes=10-39']);
  });

  it('cancels only its own request when one of two concurrent ranges is given up', async () => {
    const server = new RangeServer(BODY, { etag: '"v1"' });
    server.stall(10);
    const stream = streamWith(server, {}, QUICK_STALL);

    const first = stream.stream(ByteRange.of(0, 40))[Symbol.asyncIterator]();
    const second = stream.stream(ByteRange.of(60, 20))[Symbol.asyncIterator]();
    await first.next();
    const secondChunk = await second.next();
    await first.return?.();

    // The second range still completes on its own request, with no resume from the cancellation.
    const secondBytes = secondChunk.done ? [] : [...secondChunk.value];
    for (;;) {
      const read = await second.next();
      if (read.done) break;
      secondBytes.push(...read.value);
    }
    expect(secondBytes).toEqual([...BODY.subarray(60, 80)]);
    expect(server.rangesAsked).toEqual(['bytes=0-39', 'bytes=60-79']);
  });
});
