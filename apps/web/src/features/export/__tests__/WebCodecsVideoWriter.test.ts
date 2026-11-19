/**
 * Unit tests for the WebCodecs writer adapter, with a stubbed `VideoEncoder`
 * and `VideoFrame` so the real class runs in Node.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExportPlan } from "@cutaway/export-engine";
import type { ResolvedVideoConfig } from "../capabilities";
import type { MediaContainer } from "../MediaContainer";
import { WebCodecsVideoWriter } from "../WebCodecsVideoWriter";

class FakeVideoEncoder {
  state: "configured" | "closed" = "configured";
  encodeQueueSize = 0;
  configure = vi.fn();
  encode = vi.fn();
  flush = vi.fn(async () => {});
  close = vi.fn(() => {
    this.state = "closed";
  });
  constructor(
    public callbacks: {
      output: (chunk: unknown, meta?: unknown) => void;
      error: (error: Error) => void;
    },
  ) {}
}

class FakeVideoFrame {
  close = vi.fn();
  constructor(
    public source: unknown,
    public init: unknown,
  ) {}
}

const plan = { frameRate: 30 } as ExportPlan;
const config = { encoderConfig: { codec: "avc1.42001f" } } as ResolvedVideoConfig;

function fakeContainer() {
  return {
    addVideoChunk: vi.fn(),
    finalize: vi.fn(() => new Uint8Array([1, 2, 3])),
    discard: vi.fn(),
  } as unknown as MediaContainer & {
    addVideoChunk: ReturnType<typeof vi.fn>;
    finalize: ReturnType<typeof vi.fn>;
    discard: ReturnType<typeof vi.fn>;
  };
}

const encoders: FakeVideoEncoder[] = [];
const lastEncoder = () => encoders.at(-1)!;

beforeEach(() => {
  encoders.length = 0;
  vi.stubGlobal(
    "VideoEncoder",
    class extends FakeVideoEncoder {
      constructor(callbacks: FakeVideoEncoder["callbacks"]) {
        super(callbacks);
        encoders.push(this);
      }
    },
  );
  vi.stubGlobal("VideoFrame", FakeVideoFrame);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("WebCodecsVideoWriter", () => {
  it("abort() discards the shared container", () => {
    const container = fakeContainer();
    const writer = WebCodecsVideoWriter.create(plan, container, config);

    writer.abort!();

    expect(container.discard).toHaveBeenCalledOnce();
  });

  it("finalize() flushes the encoder and finalises the container", async () => {
    const container = fakeContainer();
    const writer = WebCodecsVideoWriter.create(plan, container, config);

    const bytes = await writer.finalize();

    expect(lastEncoder().flush).toHaveBeenCalledOnce();
    expect(container.finalize).toHaveBeenCalledOnce();
    expect(bytes).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("dispose() closes the encoder exactly once", () => {
    const writer = WebCodecsVideoWriter.create(plan, fakeContainer(), config);

    writer.dispose!();
    writer.dispose!();

    expect(lastEncoder().close).toHaveBeenCalledOnce();
  });

  it("an encoder error surfaces on the next addFrame", async () => {
    const writer = WebCodecsVideoWriter.create(plan, fakeContainer(), config);
    lastEncoder().callbacks.error(new Error("hardware encoder died"));

    await expect(
      writer.addFrame(new FakeVideoFrame(null, null) as never, 0, 33_333),
    ).rejects.toThrow("hardware encoder died");
  });
});
