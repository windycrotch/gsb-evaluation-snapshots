import {
  GyroViewError,
  hasErrorCode,
  isAbortError,
  milliseconds,
  millisecondsToSeconds,
  type ByteRange,
  type Seconds,
} from '@gyroview/core';

import {
  discardBody,
  EXPOSED_HEADERS_ADVICE,
  FIRST_BYTE_RANGE,
  httpRequest,
  plainHttpRequest,
  withAbortSignal,
  type HttpMethod,
  type HttpRequestOptions,
} from './httpRequest';
import {
  answerAskedAgain,
  askingAgain,
  DEFAULT_RETRY_DELAYS_MS,
  type RetryOptions,
} from './askingAgain';
import { contentRangeOf } from './contentRange';
import { isPassingStatus, passing, passingIfUnreachable } from './passingFailures';
import { isSameVersion, versionOf, type RecordingVersion } from './recordingVersion';

const HTTP_OK = 200;
const HTTP_PARTIAL_CONTENT = 206;
const FIRST_BYTE_HEADERS = { Range: FIRST_BYTE_RANGE };

export interface HttpResourceOptions extends HttpRequestOptions, RetryOptions {
  /**
   * The clock its requests are timed by, in milliseconds (`answerWait`). Default
   * `performance.now`.
   */
  readonly now?: () => number;
}

/**
 * One recording at a URL, as every reader of it sees it: its size, whether its server has shown
 * it lets this page read it (CORS), the version its first answer told of (ADR 0029), and how a
 * request that failed on the way is asked for again.
 * The server must answer `Range` requests with 206 and, for cross-origin use, send CORS headers
 * that expose `Content-Range`; both are hard requirements of playing a remote recording and are
 * reported with distinct error codes.
 *
 * An answer of another version than the first one's seals the resource: the answer in hand and
 * every request still running end at once, and from then on neither a range read nor a size
 * lookup returns anything, however often asked, until the caller reloads it. The old and the new
 * recording's bytes must never be put together.
 */
export class HttpResource {
  private readonly baseOptions: HttpRequestOptions;
  /**
   * The load signal the host gave at construction, if any: it ends every generation beside the
   * generation's own signal.
   */
  private readonly hostSignal: AbortSignal | undefined;
  private options: HttpRequestOptions;
  private readonly retryDelaysMs: readonly number[];
  private sizePromise: Promise<number> | undefined;
  /**
   * A range has come through: CORS is proven for this resource, so a request that fails from
   * here on failed on the way, whatever the diagnosis says of an error page without CORS headers.
   */
  private hasReadRange = false;
  private version: RecordingVersion | undefined;
  private readonly now: () => number;
  private shortestAnswerMs: number | undefined;
  /**
   * Ends every request of the current generation. A replacement aborts the generation and seals
   * the resource; a reload opens a new one.
   */
  private loadEnded = new AbortController();
  /**
   * The URL's recording was replaced while it played. While set, the resource answers no read and
   * no size lookup, each with `source-changed`, until it is reloaded.
   */
  private changed = false;

  /**
   * `signal` ends every request made for the resource, with the host's own `requestInit` signal.
   */
  public constructor(
    public readonly url: string,
    options: HttpResourceOptions = {},
    signal?: AbortSignal,
  ) {
    this.baseOptions = options;
    this.hostSignal = signal;
    this.options = this.buildOptions();
    this.retryDelaysMs = options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
    this.now = options.now ?? ((): number => performance.now());
  }

  /**
   * How long its server took to answer a byte range, from asking to the answer's headers: the
   * shortest wait of the ranges answered so far, so a first one slowed by a new connection, a
   * CORS preflight or a cold cache counts for nothing (ADR 0044). A HEAD, which a server may
   * answer from what it knows of the file without reading it, and a refusal tell nothing.
   * Undefined until a range was answered.
   */
  public answerWait(): Seconds | undefined {
    const shortest = this.shortestAnswerMs;
    return shortest === undefined ? undefined : millisecondsToSeconds(milliseconds(shortest));
  }

  /**
   * Whether an answer has shown the recording at the URL replaced while it played. A sealed
   * resource serves no bytes and no size until `reload`.
   */
  public hasSourceChanged(): boolean {
    return this.changed;
  }

  /**
   * Opens a new generation after a replacement: the sealing and every learned answer are
   * forgotten, the requests of the old generation, waits included, are ended, and the first
   * answer to come fixes the version afresh. Nothing but an explicit reload unseals the resource.
   */
  public reload(): void {
    this.changed = false;
    this.version = undefined;
    this.sizePromise = undefined;
    this.hasReadRange = false;
    this.shortestAnswerMs = undefined;
    const ended = this.loadEnded;
    this.loadEnded = new AbortController();
    this.options = this.buildOptions();
    ended.abort();
  }

  /**
   * One HEAD request (or a one-byte range where HEAD is refused or gives no length), each asked
   * for again as a range is while it fails on the way (ADR 0019); cached for the lifetime of the
   * generation once it succeeded; a failed lookup is retried on the next call. A resource sealed
   * by a replacement answers none of this: the cached length is the old recording's and must not
   * plan a single range of the new one.
   */
  public size(): Promise<number> {
    if (this.changed) return Promise.reject(this.changedError());
    this.sizePromise ??= this.rememberSize();
    return this.sizePromise;
  }

  /**
   * Servers clamp out-of-range requests instead of failing them; the port contracts want a
   * typed error, so the range is checked against the (cached) size first.
   */
  public async ensureFits(range: ByteRange): Promise<void> {
    range.ensureWithin(await this.size(), `resource ${this.url}`);
  }

  /**
   * Runs `attempt`, and after a short wait again, a few times, while it fails on the way: one
   * dropped connection must not end a long playback, nor a server's 5xx or its 429 asking the
   * player to slow down. What asking again cannot change (an abort, any other refusal, a server
   * ignoring ranges, CORS) fails at once. A replacement found meanwhile fails every attempt and
   * every wait at once with `source-changed`: it is not a failure on the way, and is never retried.
   */
  public async askingAgain<T>(attempt: () => Promise<T>): Promise<T> {
    try {
      return await askingAgain(
        () => this.attemptUnlessChanged(attempt),
        this.retryDelaysMs,
        this.options.requestInit?.signal,
      );
    } catch (error) {
      throw this.afterChange(error);
    }
  }

  /**
   * The server's answer to a byte range, its body still to be read: a 206, or the refusal it
   * amounts to. `signal` ends this request alone.
   */
  public async rangeAnswer(range: ByteRange, signal?: AbortSignal): Promise<Response> {
    this.ensureReadable();
    const options = signal ? withAbortSignal(this.options, signal) : this.options;
    const response = await this.requestRange(range, options);
    if (response.status !== HTTP_PARTIAL_CONTENT) {
      discardBody(response);
      throw this.afterChange(this.refusalOf(response.status));
    }
    this.hasReadRange = true;
    this.ensureUnchanged(response);
    return response;
  }

  /**
   * Every answer is of the version the first one told of: bytes of a recording replaced while it
   * plays must not be put together with the old ones'. Finding another version seals the resource
   * and ends its whole generation.
   */
  private ensureUnchanged(response: Response): void {
    const seen = versionOf(response);
    this.version ??= seen;
    if (isSameVersion(this.version, seen)) return;
    discardBody(response);
    this.seal();
    throw this.changedError();
  }

  /**
   * A request that did not get through for want of a network is worth another try; one CORS
   * refused before any range came through is not.
   */
  private async requestRange(range: ByteRange, options: HttpRequestOptions): Promise<Response> {
    const headers = { Range: `bytes=${range.offset}-${range.end - 1}` };
    try {
      // Once CORS is proven, a failure needs no diagnosing request to the failing server.
      return await this.timed(() =>
        this.hasReadRange
          ? plainHttpRequest(this.url, { method: 'GET', headers }, options)
          : httpRequest(this.url, { method: 'GET', headers }, options),
      );
    } catch (error) {
      throw this.afterChange(
        this.hasReadRange ? this.passingOnceAnswered(error) : passingIfUnreachable(error),
      );
    }
  }

  private passingOnceAnswered(error: unknown): unknown {
    const message = `${this.url} could not be reached for a byte range`;
    return isAbortError(error)
      ? error
      : passing(new GyroViewError('source-unreadable', message, { cause: error }));
  }

  private refusalOf(status: number): GyroViewError {
    if (status === HTTP_OK) {
      return new GyroViewError(
        'range-unsupported',
        `${this.url} ignores Range requests (answered 200 to a byte range)`,
      );
    }
    const message = `${this.url} answered ${status} to a byte range`;
    return isPassingStatus(status)
      ? passing(new GyroViewError('source-unreadable', message))
      : new GyroViewError('source-unreadable', message);
  }

  private async rememberSize(): Promise<number> {
    try {
      return await this.fetchSize();
    } catch (error) {
      this.sizePromise = undefined;
      throw this.afterChange(error);
    }
  }

  private async fetchSize(): Promise<number> {
    const response = await this.sizeAnswer('HEAD');
    discardBody(response);
    if (isPassingStatus(response.status)) return this.sizeDespiteFailingHead(response.status);
    // A refused HEAD (a 405, a 403 from a URL signed for GET alone, a 501) says nothing about
    // the file: the byte range the player needs anyway answers, and names any real problem.
    if (!response.ok) return this.sizeFromContentRange();
    this.ensureUnchanged(response);
    const contentLength = Number(response.headers.get('content-length'));
    const hasContentLength = Number.isSafeInteger(contentLength) && contentLength > 0;
    return hasContentLength ? contentLength : this.sizeFromContentRange();
  }

  /**
   * Some servers omit Content-Length on HEAD or refuse HEAD; a one-byte range reveals the total.
   */
  private async sizeFromContentRange(): Promise<number> {
    return this.totalOfFirstByte(await this.sizeAnswer('GET', FIRST_BYTE_HEADERS));
  }

  /**
   * Its server still failed the HEAD once the waits ran out: one byte range, asked once, as the
   * server has had its waits, may yet tell the size, as from a server whose HEAD alone is broken.
   * Where that range hides Content-Range, only the HEAD could have told the size, as on Google
   * Drive's API, so the failing HEAD is named rather than the server's CORS headers.
   */
  private async sizeDespiteFailingHead(headStatus: number): Promise<number> {
    const response = await this.request('GET', FIRST_BYTE_HEADERS);
    try {
      return this.totalOfFirstByte(response);
    } catch (error) {
      if (!hasErrorCode(error, 'cors')) throw error;
      const message = `${this.url} still answered ${headStatus} to HEAD, and its byte ranges hide Content-Range; cannot determine the file size`;
      throw new GyroViewError('source-unreadable', message, { cause: error });
    }
  }

  private totalOfFirstByte(response: Response): number {
    discardBody(response);
    // A whole-page 200 here is as often a missing file behind a fallback page as a server that
    // ignores ranges, so it stays unreadable; the status tells the host which.
    if (response.status !== HTTP_PARTIAL_CONTENT) {
      throw new GyroViewError(
        'source-unreadable',
        `${this.url} answered ${response.status} to a byte range; cannot determine the file size`,
      );
    }
    this.hasReadRange = true;
    this.ensureUnchanged(response);
    return this.totalOf(response);
  }

  private totalOf(response: Response): number {
    // Across origins the header is hidden unless the server exposes it.
    const isHidden = !response.headers.has('content-range') && response.type === 'cors';
    if (isHidden) throw this.hiddenContentRange();
    const total = contentRangeOf(response)?.total;
    if (total === undefined) {
      throw new GyroViewError(
        'source-unreadable',
        `${this.url} reports neither Content-Length nor Content-Range; cannot determine the file size`,
      );
    }
    return total;
  }

  private hiddenContentRange(): GyroViewError {
    return new GyroViewError(
      'cors',
      `${this.url} answered a byte range but hides its Content-Range from this origin; add ${EXPOSED_HEADERS_ADVICE}`,
    );
  }

  /**
   * The answer to a request for the size, asked for again while it fails on the way: the size is
   * the first thing read, and a moment's 503 or a phone changing cells must not fail the
   * recording.
   */
  private async sizeAnswer(
    method: HttpMethod,
    headers?: Record<string, string>,
  ): Promise<Response> {
    try {
      return await answerAskedAgain(
        () => this.request(method, headers),
        this.retryDelaysMs,
        this.options.requestInit?.signal,
      );
    } catch (error) {
      throw this.afterChange(error);
    }
  }

  private request(method: HttpMethod, headers?: Record<string, string>): Promise<Response> {
    return this.timed(() =>
      httpRequest(this.url, { method, ...(headers && { headers }) }, this.options),
    );
  }

  /**
   * The request, its wait noted when it brought a range's bytes (206); one that failed, was
   * given up or was refused tells nothing.
   */
  private async timed(send: () => Promise<Response>): Promise<Response> {
    const askedAt = this.now();
    const response = await send();
    if (response.status !== HTTP_PARTIAL_CONTENT) return response;
    const waitMs = this.now() - askedAt;
    this.shortestAnswerMs = Math.min(waitMs, this.shortestAnswerMs ?? waitMs);
    return response;
  }

  /**
   * The settings every request of this generation carries: the generation's own end signal and
   * the host's signals, so aborting the generation reaches every request and every wait at once.
   * Each combined controller takes its listeners along when it aborts, so a generation leaves
   * none on a long-lived host signal.
   */
  private buildOptions(): HttpRequestOptions {
    const signalled = withAbortSignal(this.baseOptions, this.loadEnded.signal);
    return this.hostSignal ? withAbortSignal(signalled, this.hostSignal) : signalled;
  }

  /**
   * An attempt made only while the resource is still of its first version. A sealed resource
   * fails it at once, without a request, so asking again can neither fetch bytes nor spend waits
   * on a recording that was replaced.
   */
  private async attemptUnlessChanged<T>(attempt: () => Promise<T>): Promise<T> {
    this.ensureReadable();
    try {
      return await attempt();
    } catch (error) {
      throw this.afterChange(error);
    }
  }

  private ensureReadable(): void {
    if (this.changed) throw this.changedError();
  }

  /**
   * While the resource is sealed, whatever a request reports of its end names the replacement:
   * the generation's own abort, a body broken off by it, a refusal an answer came back with.
   * Before a replacement, every error passes on unchanged, an abort among them.
   */
  private afterChange(error: unknown): unknown {
    if (!this.changed) return error;
    return hasErrorCode(error, 'source-changed') ? error : this.changedError(error);
  }

  /**
   * Seals the resource and ends every request and wait of the generation in flight, so no old
   * byte and no old length can be answered any more.
   */
  private seal(): void {
    if (this.changed) return;
    this.changed = true;
    this.sizePromise = undefined;
    this.loadEnded.abort(this.changedError());
  }

  private changedError(cause?: unknown): GyroViewError {
    return new GyroViewError(
      'source-changed',
      `${this.url} was replaced while it played; load it again`,
      cause === undefined ? undefined : { cause },
    );
  }
}
