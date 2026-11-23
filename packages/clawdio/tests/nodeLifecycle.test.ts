import assert from "node:assert/strict";
import test from "node:test";

import {
  bindNodeLifecycle,
  postParameter,
  type WorkletNodeEvents,
} from "../src/nodes/utils.ts";

/**
 * Minimal stand-in for `AudioWorkletNode`. The lifecycle helper only touches
 * the message port, `disconnect`, and window events, so a small fake is enough
 * to exercise it without a browser.
 */
const createFakeNode = () => {
  const posted: unknown[] = [];
  let connected = true;
  let onmessage: ((event: MessageEvent) => void) | null = null;

  const node = {
    port: {
      postMessage(message: unknown) {
        posted.push(message);
      },
      get onmessage() {
        return onmessage;
      },
      set onmessage(handler: ((event: MessageEvent) => void) | null) {
        onmessage = handler;
      },
    },
    disconnect() {
      connected = false;
    },
    addEventListener() {},
  };

  return {
    node: node as unknown as AudioWorkletNode,
    posted,
    isConnected: () => connected,
    getOnMessage: () => onmessage,
  };
};

const createWindow = () => {
  const listeners = new Map<string, Array<() => void>>();
  const win = {
    addEventListener(type: string, handler: () => void) {
      const handlers = listeners.get(type) ?? [];
      handlers.push(handler);
      listeners.set(type, handlers);
    },
    removeEventListener(type: string, handler: () => void) {
      const handlers = listeners.get(type) ?? [];
      listeners.set(
        type,
        handlers.filter((candidate) => candidate !== handler)
      );
    },
    dispatch(type: string) {
      for (const handler of listeners.get(type) ?? []) handler();
    },
    listenerCount(type: string) {
      return (listeners.get(type) ?? []).length;
    },
  };
  return win;
};

test("disconnecting the node posts dispose exactly once", () => {
  const { node, posted, isConnected } = createFakeNode();
  const dispose = bindNodeLifecycle(node);

  assert.ok(isConnected());
  node.disconnect();
  assert.equal(isConnected(), false);

  const disposeMessages = posted.filter(
    (message) => (message as { type: string }).type === "dispose"
  );
  assert.equal(disposeMessages.length, 1);

  // A second disconnect (common in cleanup paths) must not re-post.
  node.disconnect();
  assert.equal(
    posted.filter((message) => (message as { type: string }).type === "dispose")
      .length,
    1
  );

  dispose();
});

test("disconnecting from a specific destination is not treated as teardown", () => {
  const { node, posted } = createFakeNode();
  const dispose = bindNodeLifecycle(node);

  // A node can be disconnected from one target while still being used.
  node.disconnect({} as AudioNode);
  assert.equal(posted.length, 0);

  dispose();
});

test("explicit dispose posts dispose and disconnects audio", () => {
  const { node, posted, isConnected } = createFakeNode();
  const dispose = bindNodeLifecycle(node);

  dispose();
  assert.equal(isConnected(), false);
  assert.equal(
    posted.filter((message) => (message as { type: string }).type === "dispose")
      .length,
    1
  );
  // Idempotent.
  dispose();
  assert.equal(
    posted.filter((message) => (message as { type: string }).type === "dispose")
      .length,
    1
  );
});

test("pagehide tears down the worklet and removes window listeners", () => {
  const previousWindow = (globalThis as { window?: unknown }).window;
  const win = createWindow();
  (globalThis as { window?: unknown }).window = win;

  try {
    const { node, posted, getOnMessage } = createFakeNode();
    bindNodeLifecycle(node);

    assert.equal(win.listenerCount("pagehide"), 1);
    assert.equal(win.listenerCount("beforeunload"), 1);

    win.dispatch("pagehide");

    assert.equal(
      posted.filter(
        (message) => (message as { type: string }).type === "dispose"
      ).length,
      1
    );
    // Handler cleared so no dangling port messages after unload.
    assert.equal(getOnMessage(), null);
    assert.equal(win.listenerCount("pagehide"), 0);
    assert.equal(win.listenerCount("beforeunload"), 0);
  } finally {
    (globalThis as { window?: unknown }).window = previousWindow;
  }
});

test("postParameter tolerates a closed port", () => {
  const node = {
    port: {
      postMessage() {
        throw new Error("port closed");
      },
    },
  } as unknown as AudioWorkletNode;

  assert.doesNotThrow(() => postParameter(node, "set-bits", 8));
});

test("postParameter forwards the protocol message shape", () => {
  const { node, posted } = createFakeNode();
  postParameter(node, "set-cutoff", 0.5);
  assert.deepEqual(posted, [{ type: "set-cutoff", data: 0.5 }]);
});

test("worklet events surface parameter errors to the caller", async () => {
  const { handleNodeMessage } = await import("../src/nodes/utils.ts");
  const { node } = createFakeNode();
  const errors: unknown[] = [];
  const events: WorkletNodeEvents = {
    onParameterError: (payload) => errors.push(payload),
  };

  const handler = handleNodeMessage(node, { bits: 4 }, events);
  handler({
    data: {
      type: "parameter-error",
      data: { parameter: "bits", value: 0, message: "Invalid bits" },
    },
  } as MessageEvent);

  assert.equal(errors.length, 1);
  assert.deepEqual(errors[0], {
    parameter: "bits",
    value: 0,
    message: "Invalid bits",
  });
});

test("wasm-loaded replies with init-module carrying the config", async () => {
  const { handleNodeMessage } = await import("../src/nodes/utils.ts");
  const { node, posted } = createFakeNode();

  const handler = handleNodeMessage(node, { bits: 6, normfreq: 0.2 });
  handler({ data: { type: "wasm-loaded" } } as MessageEvent);

  assert.deepEqual(posted, [
    { type: "init-module", data: { bits: 6, normfreq: 0.2 } },
  ]);
});
