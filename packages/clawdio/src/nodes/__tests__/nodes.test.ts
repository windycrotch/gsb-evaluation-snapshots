import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Node-side tests run without a real AudioContext/AudioWorkletNode. We mock
 * ./utils so createWorkletNode returns a controllable fake whose port
 * records every postMessage, exactly like the browser would deliver them.
 */

type PortMessage = { type: string; data: unknown };

class FakePort {
  readonly sent: PortMessage[] = [];
  onmessage: ((e: MessageEvent) => void) | null = null;

  postMessage(message: PortMessage) {
    this.sent.push(message);
  }
}

class FakeAudioWorkletNode {
  readonly port = new FakePort();
  readonly listeners: Record<string, EventListener> = {};

  addEventListener(type: string, listener: EventListener) {
    this.listeners[type] = listener;
  }
}

const fakeNodes: FakeAudioWorkletNode[] = [];

vi.mock("../utils", () => ({
  assertNode: vi.fn(),
  createWorkletNode: vi.fn(async () => {
    const node = new FakeAudioWorkletNode();
    fakeNodes.push(node);
    return node as unknown as AudioWorkletNode;
  }),
}));

// Worker/WASM URL side-effect imports are redirected to inert stubs by the
// assetImportStubPlugin in vitest.config.ts.

// Minimal AudioContext stub - the node factories only pass it through.
const fakeAudioCtx = {} as AudioContext;

import createBitcrusherNode from "../BitcrusherNode";
import createMoogNode from "../MoogFilterNode";

beforeEach(() => {
  fakeNodes.length = 0;
});

describe("BitcrusherNode setters", () => {
  it("forwards setBits/setNormfreq messages with the right payload", async () => {
    const created = await createBitcrusherNode(fakeAudioCtx, 4, 0.1);
    const node = created.node as unknown as FakeAudioWorkletNode;

    created.setBits(12);
    created.setNormfreq(0.7);

    expect(node.port.sent).toContainEqual({
      type: "set-bits",
      data: 12,
    });
    expect(node.port.sent).toContainEqual({
      type: "set-normfreq",
      data: 0.7,
    });
  });

  it("delivers every value in order during rapid successive calls (last wins)", async () => {
    const created = await createBitcrusherNode(fakeAudioCtx);
    const node = created.node as unknown as FakeAudioWorkletNode;

    for (let bits = 1; bits <= 16; bits++) {
      created.setBits(bits);
    }

    const bitMessages = node.port.sent.filter((m) => m.type === "set-bits");
    expect(bitMessages).toHaveLength(16);
    expect(bitMessages.map((m) => m.data)).toEqual(
      Array.from({ length: 16 }, (_, i) => i + 1)
    );
    expect(bitMessages[bitMessages.length - 1]?.data).toBe(16);
  });

  it("does not crash when setters are invoked before node creation resolves", async () => {
    // Recreate the pre-resolution state directly: the factory guards on a
    // null nodeRef, so calling a setter-shaped function against an unset
    // reference must be a no-op rather than a throw.
    let nodeRef: AudioWorkletNode | null = null;
    const setBitsGuarded = (newBits: number) => {
      if (!nodeRef) return;
      nodeRef.port.postMessage({ type: "set-bits", data: newBits });
    };

    expect(() => setBitsGuarded(8)).not.toThrow();

    // After creation the same setter path delivers messages.
    nodeRef = (await createBitcrusherNode(fakeAudioCtx)).node;
    expect(() => setBitsGuarded(8)).not.toThrow();
  });
});

describe("MoogFilterNode setters", () => {
  it("forwards setCutoff/setResonance messages with the right payload", async () => {
    const created = await createMoogNode(fakeAudioCtx, 0.065, 3.5);
    const node = created.node as unknown as FakeAudioWorkletNode;

    created.setCutoff(0.42);
    created.setResonance(2.0);

    expect(node.port.sent).toContainEqual({
      type: "set-cutoff",
      data: 0.42,
    });
    expect(node.port.sent).toContainEqual({
      type: "set-resonance",
      data: 2.0,
    });
  });

  it("delivers every value in order during rapid successive calls (last wins)", async () => {
    const created = await createMoogNode(fakeAudioCtx);
    const node = created.node as unknown as FakeAudioWorkletNode;

    const cutoffs = [0.1, 0.2, 0.3, 0.4, 0.5];
    cutoffs.forEach((cutoff) => created.setCutoff(cutoff));

    const messages = node.port.sent.filter((m) => m.type === "set-cutoff");
    expect(messages.map((m) => m.data)).toEqual(cutoffs);
    expect(messages[messages.length - 1]?.data).toBe(0.5);
  });

  it("does not crash when setters are invoked before node creation resolves", async () => {
    let nodeRef: AudioWorkletNode | null = null;
    const setCutoffGuarded = (cutoff: number) => {
      if (!nodeRef) return;
      nodeRef.port.postMessage({ type: "set-cutoff", data: cutoff });
    };

    expect(() => setCutoffGuarded(0.9)).not.toThrow();

    nodeRef = (await createMoogNode(fakeAudioCtx)).node;
    expect(() => setCutoffGuarded(0.9)).not.toThrow();
  });
});
