import { describe, it, expect } from "vitest";
// Register the processor so a real instance can be constructed.
import "../bitcrusher";
import { getRegisteredProcessor } from "./setup";

const microtask = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("initWasm failure handling", () => {
  it("reports an init-wasm-failed message instead of an unhandled rejection", async () => {
    const Ctor = getRegisteredProcessor(
      "clawdio-bitcrusher"
    ) as unknown as {
      new (): {
        port: {
          deliver: (data: unknown) => void;
          outbound: unknown[];
        };
        process: (
          inputs: Float32Array[][],
          outputs: Float32Array[][]
        ) => boolean;
      };
    };

    const processor = new Ctor();

    // Hand over bytes that are not a valid WebAssembly module.
    expect(() =>
      processor.port.deliver({
        type: "init-wasm",
        data: new Uint8Array([0, 1, 2, 3, 4, 5, 6, 7]).buffer,
      })
    ).not.toThrow();

    // Let the compile promise settle (it rejects asynchronously).
    await microtask();
    await microtask();

    expect(processor.port.outbound).toContainEqual(
      expect.objectContaining({ type: "init-wasm-failed" })
    );

    // No "wasm-loaded" handshake, so the node side never inits a module and
    // process() remains a safe no-op that keeps the processor alive.
    expect(processor.port.outbound).not.toContainEqual(
      expect.objectContaining({ type: "wasm-loaded" })
    );
    expect(processor.process([], [])).toBe(true);
  });
});
