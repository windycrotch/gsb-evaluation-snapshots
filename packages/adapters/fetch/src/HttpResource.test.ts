import { ByteRange } from '@gyroview/core';
import { afterAll, describe, expect, it } from 'vitest';

import type { HttpFetch } from './httpRequest';
import { HttpResource } from './HttpResource';
import { TestServer } from './test/testServer';

const URL_OF_FILE = 'https://media.example/VID_20260814_132640_00_013.insv';
const FILE_SIZE = 4096;
const NO_WAIT = [0, 0];

const servers: TestServer[] = [];

async function serve(
  bytes: Uint8Array,
  behaviour: Parameters<typeof TestServer.start>[1] = {},
): Promise<TestServer> {
  const server = await TestServer.start(bytes, behaviour);
  servers.push(server);
  return server;
}

afterAll(async () => {
  await Promise.all(servers.map((server) => server.stop()));
});

/**
 * A clock that reads each of `times` in turn, in milliseconds.
 */
function clockReading(times: readonly number[]): () => number {
  let read = 0;
  return (): number => {
    const time = times[read] ?? times.at(-1) ?? 0;
    read += 1;
    return time;
  };
}

/**
 * A server that knows the file: its size to a HEAD, its bytes to a range.
 */
const server: HttpFetch = (_url, init) => {
  const range = /^bytes=(\d+)-(\d+)$/u.exec(new Headers(init.headers).get('range') ?? '');
  if (!range) return Promise.resolve(new Response(null, { headers: { 'Content-Length': '4096' } }));
  const [first, last] = [Number(range[1]), Number(range[2])];
  const headers = { 'Content-Range': `bytes ${first}-${last}/${FILE_SIZE}` };
  return Promise.resolve(new Response(new Uint8Array(last - first + 1), { status: 206, headers }));
};

/**
 * Reads each range's answer and lets its body go, as a reader that took what it needed.
 */
async function readRanges(resource: HttpResource, ranges: readonly ByteRange[]): Promise<void> {
  for (const range of ranges) {
    const answer = await resource.askingAgain(() => resource.rangeAnswer(range));
    await answer.body?.cancel();
  }
}

describe('HttpResource', () => {
  it('knows no wait for an answer before a request was answered', () => {
    expect(new HttpResource(URL_OF_FILE, { fetch: server }).answerWait()).toBeUndefined();
  });

  it('takes the shortest wait for a range, so a first one slowed by a new connection counts for nothing', async () => {
    const resource = new HttpResource(URL_OF_FILE, {
      fetch: server,
      now: clockReading([0, 1200, 2000, 2750]),
    });

    await readRanges(resource, [ByteRange.of(0, 10), ByteRange.of(10, 10)]);

    expect(resource.answerWait()).toBeCloseTo(0.75);
  });

  it('times no HEAD, which a server may answer without reading the file', async () => {
    const resource = new HttpResource(URL_OF_FILE, {
      fetch: server,
      now: clockReading([0, 1000, 1850]),
    });

    await resource.size();
    await readRanges(resource, [ByteRange.of(0, 10)]);

    expect(resource.answerWait()).toBeCloseTo(0.85);
  });

  it('times no refusal, which a gateway may answer at once', async () => {
    let isBusy = true;
    const resource = new HttpResource(URL_OF_FILE, {
      fetch: (url, init): Promise<Response> => {
        const answer = isBusy
          ? Promise.resolve(new Response(null, { status: 503 }))
          : server(url, init);
        isBusy = false;
        return answer;
      },
      now: clockReading([0, 1000, 1850]),
      retryDelaysMs: [0],
    });

    await readRanges(resource, [ByteRange.of(0, 10)]);

    expect(resource.answerWait()).toBeCloseTo(0.85);
  });

  it('times no request that failed', async () => {
    const resource = new HttpResource(URL_OF_FILE, {
      fetch: (): Promise<Response> => Promise.reject(new TypeError('offline')),
      now: clockReading([0, 5]),
      retryDelaysMs: [],
    });

    await expect(resource.size()).rejects.toThrow();

    expect(resource.answerWait()).toBeUndefined();
  });
});

const FIRST_VERSION = { lastModified: 'Wed, 30 Sep 2026 10:00:00 GMT' } as const;
const SECOND_VERSION = { lastModified: 'Thu, 01 Oct 2026 10:00:00 GMT' } as const;

describe('HttpResource version sealing', () => {
  it('serves ranges and the size of one unchanged recording', async () => {
    const server = await serve(new Uint8Array(100), { validators: FIRST_VERSION });
    const resource = new HttpResource(server.url, { retryDelaysMs: NO_WAIT });

    await expect(resource.size()).resolves.toBe(100);
    const answer = await resource.askingAgain(() => resource.rangeAnswer(ByteRange.of(0, 10)));
    await answer.body?.cancel();

    expect(resource.hasSourceChanged()).toBe(false);
  });

  it('seals on a range of another version and never serves a byte again, nor retries', async () => {
    const server = await serve(new Uint8Array(100), { validators: FIRST_VERSION });
    const resource = new HttpResource(server.url, { retryDelaysMs: NO_WAIT });
    const first = await resource.askingAgain(() => resource.rangeAnswer(ByteRange.of(0, 10)));
    await first.body?.cancel();
    server.replace(new Uint8Array(100), SECOND_VERSION);
    const requestsAtChange = server.requests.length;

    await expect(
      resource.askingAgain(() => resource.rangeAnswer(ByteRange.of(10, 10))),
    ).rejects.toMatchObject({
      code: 'source-changed',
      message: `${server.url} was replaced while it played; load it again`,
    });
    expect(resource.hasSourceChanged()).toBe(true);

    // A sealed resource refuses at once, asking the server nothing however often it is asked.
    await expect(resource.rangeAnswer(ByteRange.of(20, 10))).rejects.toMatchObject({
      code: 'source-changed',
    });
    expect(server.requests.length).toBe(requestsAtChange + 1);
  });

  it('seals on a size lookup of another version instead of returning the new length', async () => {
    const server = await serve(new Uint8Array(100), { validators: FIRST_VERSION });
    const resource = new HttpResource(server.url, { retryDelaysMs: NO_WAIT });
    // A range fixes the version first, so a later lookup has one to hold its answer to.
    const first = await resource.askingAgain(() => resource.rangeAnswer(ByteRange.of(0, 1)));
    await first.body?.cancel();
    server.replace(new Uint8Array(250), SECOND_VERSION);
    // No cached size yet: the lookup goes to the network, meets the new version and seals,
    // rather than answering with the new recording's length.
    await expect(resource.size()).rejects.toMatchObject({ code: 'source-changed' });
    expect(resource.hasSourceChanged()).toBe(true);
    await expect(resource.size()).rejects.toMatchObject({ code: 'source-changed' });
  });

  it('keeps the cached size sealed: no old length answers a size query after a replacement', async () => {
    const server = await serve(new Uint8Array(100), { validators: FIRST_VERSION });
    const resource = new HttpResource(server.url, { retryDelaysMs: NO_WAIT });
    // The length is learned from a range before the size is ever asked.
    const first = await resource.askingAgain(() => resource.rangeAnswer(ByteRange.of(0, 10)));
    await first.body?.cancel();
    server.replace(new Uint8Array(250), SECOND_VERSION);
    let changed: unknown;
    try {
      await resource.askingAgain(() => resource.rangeAnswer(ByteRange.of(10, 10)));
    } catch (error) {
      changed = error;
    }
    expect(changed).toMatchObject({ code: 'source-changed' });
    const requestsAtChange = server.requests.length;

    // Even the cached lookup must not hand back the old recording's length, and must not fetch.
    await expect(resource.size()).rejects.toMatchObject({ code: 'source-changed' });
    await expect(resource.size()).rejects.toMatchObject({ code: 'source-changed' });
    expect(server.requests.length).toBe(requestsAtChange);
  });

  it('ends a request still running when the replacement is found by another read', async () => {
    const server = await serve(new Uint8Array(100), {
      validators: FIRST_VERSION,
      throttle: { chunkBytes: 10, intervalMs: 30 },
    });
    const resource = new HttpResource(server.url, { retryDelaysMs: NO_WAIT });
    const longAnswer = resource.askingAgain(() => resource.rangeAnswer(ByteRange.of(0, 100)));
    const response = await longAnswer;
    const reader = response.body!.getReader();
    await reader.read();
    server.replace(new Uint8Array(100), SECOND_VERSION);

    await expect(
      resource.askingAgain(() => resource.rangeAnswer(ByteRange.of(0, 1))),
    ).rejects.toMatchObject({ code: 'source-changed' });

    // The sealing aborted the first generation's request mid-body; undici hands its reader the
    // reason the generation ended.
    await expect(reader.read()).rejects.toMatchObject({ code: 'source-changed' });
    await expect.poll(() => server.requests.at(0)?.wasCutShort).toBe(true);
    expect(resource.hasSourceChanged()).toBe(true);
  });

  it('still reads after a request that failed on the way once the network is back', async () => {
    const server = await serve(new Uint8Array(100), { validators: FIRST_VERSION });
    let ranges = 0;
    const flaky: typeof fetch = (input, init) => {
      if (init?.method === 'GET') ranges += 1;
      return ranges === 1 ? Promise.reject(new TypeError('network changed')) : fetch(input, init);
    };
    const resource = new HttpResource(server.url, {
      fetch: flaky,
      retryDelaysMs: NO_WAIT,
    });

    const answer = await resource.askingAgain(() => resource.rangeAnswer(ByteRange.of(0, 100)));
    await answer.body?.cancel();

    expect(resource.hasSourceChanged()).toBe(false);
    expect(
      server.requests.filter((request) => request.method === 'GET').map((request) => request.range),
    ).toEqual(['bytes=0-99']);
  });

  it('serves again after reload, of the new version and its size, ending the old generation', async () => {
    const server = await serve(new Uint8Array(100), {
      validators: FIRST_VERSION,
      throttle: { chunkBytes: 10, intervalMs: 30 },
    });
    const resource = new HttpResource(server.url, { retryDelaysMs: NO_WAIT });
    const response = await resource.askingAgain(() => resource.rangeAnswer(ByteRange.of(0, 100)));
    const reader = response.body!.getReader();
    await reader.read();
    server.replace(new Uint8Array(250), SECOND_VERSION);
    await expect(
      resource.askingAgain(() => resource.rangeAnswer(ByteRange.of(0, 1))),
    ).rejects.toMatchObject({ code: 'source-changed' });
    await expect(reader.read()).rejects.toMatchObject({ code: 'source-changed' });

    resource.reload();

    expect(resource.hasSourceChanged()).toBe(false);
    await expect(resource.size()).resolves.toBe(250);
    const answer = await resource.askingAgain(() => resource.rangeAnswer(ByteRange.of(0, 10)));
    await answer.body?.cancel();
    // The new generation fixes the version afresh: another answer of it is no change.
    expect(resource.hasSourceChanged()).toBe(false);
  });
});
