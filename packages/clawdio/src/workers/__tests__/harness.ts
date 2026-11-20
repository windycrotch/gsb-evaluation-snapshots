import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  AudioWorkletProcessor,
  FakeMessagePort,
  getRegisteredProcessor,
  type WorkletProcessorCtor,
} from "./worklet-globals";

// Locally built wasm-pack packages (see vitest.config.ts aliases). Tests
// always exercise this fresh output instead of an npm-cached 0.1.0 copy.
const localPkgDir = (packageName: string): string => {
  const crate = packageName.replace("clawdio-", "");
  return fileURLToPath(
    new URL(`../../../../../modules/${crate}/pkg`, import.meta.url)
  );
};

/**
 * Resolve the .wasm bytes next to a wasm-pack glue package. The worklet
 * glue normally fetches them over HTTP; in tests we hand the ArrayBuffer
 * straight to the init function, exactly like `initWasm` does in production
 * (`WebAssembly.compile(event.data)`).
 */
export function loadWasmBytes(packageName: string): ArrayBuffer {
  const wasmName = `${packageName.replace(/-/g, "_")}_bg.wasm`;
  const wasmPath = `${localPkgDir(packageName)}/${wasmName}`;
  const bytes = readFileSync(wasmPath);
  // A Node Buffer may be a view into a shared pooled ArrayBuffer, so slice
  // by the view's own bounds rather than returning the whole pool.
  return bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength
  ) as ArrayBuffer;
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Poll until the worklet posts a message of the given type. The WASM init
 * chain (compile -> instantiate -> postMessage) spans several macrotasks,
 * so a single flush is not enough to synchronize reliably.
 */
async function waitForMessage(
  port: FakeMessagePort,
  type: string,
  timeoutMs = 3000
): Promise<unknown> {
  const start = Date.now();
  for (;;) {
    const found = port.outbound.find(
      (m) => (m as { type?: string })?.type === type
    );
    if (found) return found;
    if (Date.now() - start > timeoutMs) {
      throw new Error(
        `timed out waiting for worklet message "${type}", got: ${JSON.stringify(port.outbound)}`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

export type WorkletHarness = {
  processor: InstanceType<WorkletProcessorCtor>;
  port: FakeMessagePort;
  /** Outbound messages posted by the worklet (live array reference). */
  messages: unknown[];
  /** Send a node -> worklet message and wait for it to be handled. */
  send: (data: unknown) => Promise<void>;
  /** Run one render quantum with one mono channel and capture the output. */
  processBlock: (input: Float32Array | number[]) => Float32Array;
  /** Run many blocks back to back. */
  processBlocks: (
    count: number,
    makeInput: (block: number) => Float32Array
  ) => Float32Array[];
};

/**
 * Boot a registered worklet through the same handshake as production:
 * init-wasm -> worklet replies "wasm-loaded" -> node replies init-module.
 */
export async function createWorkletHarness(
  processorName: string,
  packageName: string,
  initConfig: unknown,
  ctorOverride?: WorkletProcessorCtor
): Promise<WorkletHarness> {
  const Ctor = ctorOverride ?? getRegisteredProcessor(processorName);
  if (!Ctor) {
    throw new Error(`Processor "${processorName}" was not registered`);
  }

  const processor = new Ctor();
  const port = (processor as unknown as { port: FakeMessagePort }).port;

  const send = async (data: unknown) => {
    port.deliver(data);
    await flush();
  };

  // Load WASM exactly as nodes/utils.ts does: ArrayBuffer -> compile.
  await send({ type: "init-wasm", data: loadWasmBytes(packageName) });

  // The real node side replies with init-module on "wasm-loaded".
  await waitForMessage(port, "wasm-loaded");
  await send({ type: "init-module", data: initConfig });

  const processBlock: WorkletHarness["processBlock"] = (input) => {
    const inputArray =
      input instanceof Float32Array ? input : Float32Array.from(input);
    const output = new Float32Array(inputArray.length);
    processor.process([[inputArray]], [[output]]);
    return output;
  };

  const processBlocks: WorkletHarness["processBlocks"] = (count, makeInput) => {
    const results: Float32Array[] = [];
    for (let block = 0; block < count; block++) {
      results.push(processBlock(makeInput(block)));
    }
    return results;
  };

  return {
    processor,
    port,
    messages: port.outbound,
    send,
    processBlock,
    processBlocks,
  };
}

export { AudioWorkletProcessor };
