import {
  ByteRange,
  Ending,
  GyroViewError,
  isAbortError,
  ITERATION_END,
  type ByteStream,
} from '@gyroview/core';

import { contentRangeOf } from './contentRange';
import type { HttpResource } from './HttpResource';
import { passing } from './passingFailures';
import { brokenOff, truncated } from './rangeFailures';

/**
 * Long enough for a slow mobile network to deliver its next packet, short enough that playback
 * waiting on a dead connection recovers well before the viewer gives up.
 */
const DEFAULT_STALL_TIMEOUT_MS = 10_000;
/**
 * How many times one range is asked for again from its next received byte after its answer's
 * body broke off or stalled. A failure before the answer (a 5xx, an unreachable server) is
 * retried on the resource's own waits and does not spend one of these, so this bounds the body
 * resumes rather than every request: a server that keeps dropping the connection cannot hold the
 * player in a resume loop for ever.
 */
const DEFAULT_MAX_RESUMES = 5;
/**
 * The longest a whole range read may take, every resume and its waits included: a connection that
 * stalls again and again, each just under the stall timeout, otherwise resumes without end.
 */
const DEFAULT_MAX_READ_MS = 60_000;

type BodyReader = ReadableStreamDefaultReader<Uint8Array>;

export interface HttpByteStreamOptions {
  /**
   * How long a request may go without a byte before it is taken for stalled, given up and asked
   * for again from its next byte. Default 10 s.
   */
  readonly stallTimeoutMs?: number;
  /**
   * How many times a range may be asked for again from its next received byte, after an answer
   * whose body broke off or stalled. A failure before the answer is retried on the resource's own
   * waits and is not counted here. The read fails once this many resumes are spent. Default 5.
   */
  readonly maxResumes?: number;
  /**
   * The longest one range read may take in all, resumes and their waits included, before it is
   * given up as unreadable. Default 60 s.
   */
  readonly maxReadMs?: number;
  /**
   * The monotonic clock the read's total time is measured by, in milliseconds. Default
   * `performance.now`.
   */
  readonly now?: () => number;
}

/**
 * ByteStream over HTTP: a range is one request, its body handed on a chunk at a time as it
 * comes, and given up by aborting the request. A body that breaks off or stalls is asked for
 * again from its next byte, as the resource's retry rules allow, but only so many times and for
 * so long, so a server that never recovers fails the read instead of resuming without end.
 */
export class HttpByteStream implements ByteStream {
  private readonly stallTimeoutMs: number;
  private readonly maxResumes: number;
  private readonly maxReadMs: number;
  private readonly now: () => number;

  public constructor(
    private readonly resource: HttpResource,
    options: HttpByteStreamOptions = {},
  ) {
    this.stallTimeoutMs = options.stallTimeoutMs ?? DEFAULT_STALL_TIMEOUT_MS;
    this.maxResumes = options.maxResumes ?? DEFAULT_MAX_RESUMES;
    this.maxReadMs = options.maxReadMs ?? DEFAULT_MAX_READ_MS;
    this.now = options.now ?? ((): number => performance.now());
  }

  public stream(range: ByteRange): AsyncIterable<Uint8Array> {
    return {
      [Symbol.asyncIterator]: (): AsyncIterator<Uint8Array> =>
        new RangeReading({
          resource: this.resource,
          range,
          stallTimeoutMs: this.stallTimeoutMs,
          maxResumes: this.maxResumes,
          maxReadMs: this.maxReadMs,
          now: this.now,
        }),
    };
  }
}

interface ReadingParts {
  readonly resource: HttpResource;
  readonly range: ByteRange;
  readonly stallTimeoutMs: number;
  readonly maxResumes: number;
  readonly maxReadMs: number;
  readonly now: () => number;
}

/**
 * One request for what of the range has not come yet, and its body.
 */
interface Attempt {
  readonly request: AbortController;
  readonly body: Promise<BodyReader>;
}

/**
 * One range's requests and bodies. The answer must be the bytes asked for, every one and no
 * more; returning the iteration aborts the request at once, a chunk still awaited coming as the
 * end.
 */
class RangeReading implements AsyncIterator<Uint8Array> {
  private attempt: Attempt | undefined;
  private received = 0;
  private resumes = 0;
  /**
   * Whether the next request is a resume from the next received byte. A failure after the answer
   * (a body that broke off or stalled) sets it; one before the answer (a 5xx, an unreachable
   * server) is retried on the resource's own waits and asks the same bytes again, so it spends no
   * resume of its own.
   */
  private needsResume = false;
  /**
   * Whether the current attempt's answer (its 206 headers) has arrived. Only a failure from then
   * on is a body-level break-off that asks for the rest of the range.
   */
  private currentAnswered = false;
  private readonly startedAt: number;
  private readonly ending = new Ending();

  public constructor(private readonly parts: ReadingParts) {
    this.startedAt = parts.now();
  }

  public async next(): Promise<IteratorResult<Uint8Array>> {
    try {
      const chunk = await this.parts.resource.askingAgain(() => this.readChunk());
      if (chunk) return { done: false, value: chunk };
    } catch (error) {
      if (!this.ending.hasEnded()) {
        this.end();
        throw error;
      }
    }
    this.end();
    return ITERATION_END;
  }

  public return(): Promise<IteratorResult<Uint8Array>> {
    this.end();
    return Promise.resolve(ITERATION_END);
  }

  /**
   * The next chunk; none at the range's end. An attempt that fails is dropped, so the next
   * asks anew for the rest of the range.
   */
  private async readChunk(): Promise<Uint8Array | undefined> {
    const { resource, range } = this.parts;
    await resource.ensureFits(range);
    if (this.ending.hasEnded() || range.length === 0) return undefined;
    this.attempt ??= this.attemptAtTheRest();
    const attempt = this.attempt;
    try {
      const read = await this.withinStallTimeout(this.readFrom(attempt));
      return this.taken(read);
    } catch (error) {
      // Only a failure once the answer arrived asks from the next byte; an earlier one is retried
      // on the resource's waits for the same bytes and spends no body resume.
      if (this.currentAnswered) this.needsResume = true;
      this.drop(attempt);
      throw error;
    }
  }

  /**
   * A new request for the bytes still missing. The first request is always made; a body-level
   * resume after it is opened only while the read's resume count and total time hold, so what
   * keeps failing for longer than either is reported, not asked again.
   */
  private attemptAtTheRest(): Attempt {
    if (this.needsResume) {
      this.ensureMayResume();
      this.needsResume = false;
    }
    const { range } = this.parts;
    const rest = ByteRange.of(range.offset + this.received, range.length - this.received);
    const request = new AbortController();
    this.currentAnswered = false;
    return { request, body: this.bodyOf(rest, request.signal) };
  }

  private ensureMayResume(): void {
    const { maxResumes, maxReadMs, now } = this.parts;
    if (this.resumes >= maxResumes) {
      throw this.resumeSpent(maxResumes);
    }
    if (now() - this.startedAt >= maxReadMs) {
      throw this.readTookTooLong(maxReadMs);
    }
    this.resumes += 1;
  }

  private resumeSpent(limit: number): GyroViewError {
    const { resource, range } = this.parts;
    return new GyroViewError(
      'source-unreadable',
      `${resource.url} did not complete the range at ${range.offset} after ${limit} ${limit === 1 ? 'resume' : 'resumes'} from its next byte`,
    );
  }

  private readTookTooLong(limitMs: number): GyroViewError {
    const { resource, range } = this.parts;
    return new GyroViewError(
      'source-unreadable',
      `${resource.url} did not complete the ${range.length}-byte range at ${range.offset} within ${limitMs} ms`,
    );
  }

  private async bodyOf(rest: ByteRange, signal: AbortSignal): Promise<BodyReader> {
    const response = await this.parts.resource.rangeAnswer(rest, signal);
    this.ensureAnswers(response, rest);
    this.currentAnswered = true;
    return response.body?.getReader() ?? new ReadableStream<Uint8Array>().getReader();
  }

  /**
   * A server may answer other bytes than asked (a cache serving a range it holds); the answer
   * says which in its Content-Range, where the page may read it.
   */
  private ensureAnswers(response: Response, rest: ByteRange): void {
    const answered = contentRangeOf(response);
    if (!answered) return;
    const asked = `${rest.offset}-${rest.end - 1}`;
    const given = `${answered.first}-${answered.last}`;
    if (given === asked) return;
    throw new GyroViewError(
      'source-unreadable',
      `${this.parts.resource.url} answered bytes ${given} to a request for bytes ${asked}`,
    );
  }

  private async readFrom(attempt: Attempt): Promise<ReadableStreamReadResult<Uint8Array>> {
    const body = await attempt.body;
    try {
      return await body.read();
    } catch (error) {
      if (isAbortError(error)) throw error;
      throw brokenOff(this.parts.resource.url, this.parts.range, error);
    }
  }

  /**
   * A request that brings no byte for the stall timeout, answer or body, is taken for stalled:
   * a connection a network change left dead never fails by itself.
   */
  private async withinStallTimeout<T>(pending: Promise<T>): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stalled = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(this.stalled());
      }, this.parts.stallTimeoutMs);
    });
    try {
      return await Promise.race([pending, stalled]);
    } finally {
      clearTimeout(timer);
    }
  }

  private stalled(): GyroViewError {
    const { resource, range, stallTimeoutMs } = this.parts;
    const message = `${resource.url} sent nothing of the ${range.length}-byte range at ${range.offset} for ${stallTimeoutMs} ms`;
    return passing(new GyroViewError('source-unreadable', message));
  }

  private taken(read: ReadableStreamReadResult<Uint8Array>): Uint8Array | undefined {
    if (read.done) {
      this.ensureWhole();
      return undefined;
    }
    this.count(read.value);
    return read.value;
  }

  private count(chunk: Uint8Array): void {
    const { resource, range } = this.parts;
    this.received += chunk.byteLength;
    if (this.received <= range.length) return;
    throw new GyroViewError(
      'source-unreadable',
      `${resource.url} sent more than the ${range.length}-byte range at ${range.offset}`,
    );
  }

  private ensureWhole(): void {
    const { resource, range } = this.parts;
    if (this.received !== range.length) throw truncated(resource.url, this.received, range);
  }

  private drop(attempt: Attempt): void {
    attempt.request.abort();
    if (this.attempt === attempt) this.attempt = undefined;
  }

  /**
   * Aborting the request once it is over, however it ended, also lets go of the listeners it
   * put on the resource's own signal.
   */
  private end(): void {
    this.ending.end();
    if (this.attempt) this.drop(this.attempt);
  }
}
