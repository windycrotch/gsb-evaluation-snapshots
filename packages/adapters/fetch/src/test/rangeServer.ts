interface AskedRange {
  readonly first: number;
  readonly last: number;
}

/**
 * What one byte-range answer does instead of streaming its whole body.
 */
export type RangeBehaviour =
  | { readonly kind: 'full' }
  | { readonly kind: 'break'; readonly afterBytes: number }
  | { readonly kind: 'stall'; readonly afterBytes: number };

export interface RangeServerOptions {
  /**
   * The version every answer names, as an `ETag`; replacing it stands for the recording being
   * replaced at the URL while it plays.
   */
  readonly etag?: string;
  /**
   * Answer each request after this many milliseconds, so the resource's answer wait can be made
   * slow without a real network.
   */
  readonly answerDelayMs?: number;
}

/**
 * An in-process `fetch` for the stream tests: serves one byte array by Range, wholly through
 * self-made `Response` and `ReadableStream` objects (no HTTP server), and logs the ranges it was
 * asked for. Each range answer's behaviour is taken from a queue, so a stream's whole chain of
 * breaks, stalls and full answers can be scripted deterministically.
 */
export class RangeServer {
  public answerDelayMs: number;
  private etag: string | undefined;
  private readonly behaviours: RangeBehaviour[] = [];
  private readonly rangeLog: string[] = [];
  private pendingReplacement: { readonly bytes: Uint8Array; readonly etag: string } | undefined;

  public constructor(
    private bytes: Uint8Array,
    options: RangeServerOptions = {},
  ) {
    this.etag = options.etag;
    this.answerDelayMs = options.answerDelayMs ?? 0;
  }

  /**
   * The `Range` header of every GET, in the order they were asked.
   */
  public get rangesAsked(): readonly string[] {
    return [...this.rangeLog];
  }

  public get fetch(): typeof fetch {
    return (_input, init) => this.answer(init);
  }

  /**
   * The recording at the URL is replaced: other bytes and another version.
   */
  public replace(bytes: Uint8Array, etag: string): void {
    this.bytes = bytes;
    this.etag = etag;
  }

  /**
   * Replace the recording before the next range answer is composed. The first answer has already
   * pinned the old version by then, so only the resumed answer is of the new recording.
   */
  public replaceBeforeNextRange(bytes: Uint8Array, etag: string): void {
    this.pendingReplacement = { bytes, etag };
  }

  /**
   * The next range answer breaks off (its stream errors) after `afterBytes` bytes.
   */
  public breakOff(afterBytes: number): void {
    this.behaviours.push({ kind: 'break', afterBytes });
  }

  /**
   * The next range answer sends `afterBytes` bytes and then never closes.
   */
  public stall(afterBytes: number): void {
    this.behaviours.push({ kind: 'stall', afterBytes });
  }

  private async answer(init?: RequestInit): Promise<Response> {
    return (init?.method ?? 'GET') === 'HEAD' ? this.headAnswer() : this.getAnswer(init);
  }

  private async getAnswer(init?: RequestInit): Promise<Response> {
    if (this.answerDelayMs > 0) await delay(this.answerDelayMs);
    const header = new Headers(init?.headers).get('range') ?? '';
    this.rangeLog.push(header);
    this.applyPendingReplacement();
    const asked = parseRange(header);
    return asked ? this.rangeAnswer(asked) : new Response(this.bytes as BodyInit, { status: 200 });
  }

  private headAnswer(): Response {
    const headers = new Headers({ 'Content-Length': String(this.bytes.byteLength) });
    // Name the version on the size lookup too, as an object store does: otherwise it would pin
    // a size-only version that later ETag differences count as unchanged.
    if (this.etag !== undefined) headers.set('ETag', this.etag);
    return new Response(null, { headers });
  }

  private applyPendingReplacement(): void {
    // The replacement takes effect from the second range on, so the first answer still pins the
    // old version before the resumed one is of the new recording.
    if (this.pendingReplacement === undefined || this.rangeLog.length < 2) return;
    const { bytes, etag } = this.pendingReplacement;
    this.pendingReplacement = undefined;
    this.replace(bytes, etag);
  }

  private rangeAnswer(asked: AskedRange): Response {
    const first = Math.min(asked.first, this.bytes.byteLength - 1);
    const last = Math.min(asked.last, this.bytes.byteLength - 1);
    const headers = new Headers({
      'Content-Range': `bytes ${first}-${last}/${this.bytes.byteLength}`,
    });
    if (this.etag !== undefined) headers.set('ETag', this.etag);
    const behaviour = this.behaviours.shift() ?? ({ kind: 'full' } satisfies RangeBehaviour);
    return new Response(this.bodyFor(first, last, behaviour), { status: 206, headers });
  }

  private bodyFor(
    first: number,
    last: number,
    behaviour: RangeBehaviour,
  ): ReadableStream<Uint8Array> {
    const slice = this.bytes.subarray(first, last + 1);
    if (behaviour.kind === 'full') {
      return new ReadableStream<Uint8Array>({
        start(controller): void {
          controller.enqueue(slice);
          controller.close();
        },
      });
    }
    // The part that crossed the network before the connection went wrong is handed over first;
    // the reader must receive it, as it would over a real socket.
    const partial = slice.subarray(0, behaviour.afterBytes);
    return new ReadableStream<Uint8Array>({
      start(controller): void {
        controller.enqueue(partial);
      },
      pull(controller): void {
        if (behaviour.kind === 'break') {
          controller.error(new Error('the connection dropped'));
        }
        // A stall does nothing here: neither enqueue more nor close, so the read stays pending
        // until the client gives up on its stall timeout.
      },
    });
  }
}

function parseRange(header: string): AskedRange | undefined {
  const match = /^bytes=(\d+)-(\d+)$/u.exec(header);
  return match ? { first: Number(match[1]), last: Number(match[2]) } : undefined;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
