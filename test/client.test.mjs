// Unit tests for the two client-side pieces of the multiplayer loop that don't
// need a browser: the reconnecting socket (src/net.js) and the room roster
// (src/room.js). They use a fake WebSocket, so no server is involved.
//
//   npm test

import test from "node:test";
import assert from "node:assert/strict";
import { createRoomSocket, REPLACED_CLOSE_CODE } from "../src/net.js";
import { createRoomView } from "../src/room.js";

// Minimal stand-in for the browser's WebSocket, driven by the test.
class FakeSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.readyState = 0; // CONNECTING
    this.sent = [];
    FakeSocket.instances.push(this);
  }
  send(data) {
    this.sent.push(data);
  }
  close() {
    this.readyState = 3;
    this.onclose?.({ code: 1000 });
  }
  // --- test controls ---
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  message(obj) {
    this.onmessage?.({ data: JSON.stringify(obj) });
  }
  drop(code = 1006) {
    this.readyState = 3;
    this.onclose?.({ code });
  }
}

// A controllable clock so retries don't need real time.
function fakeTimers() {
  let now = 0;
  const jobs = [];
  return {
    setTimeout(fn, ms) {
      const job = { fn, at: now + ms, id: jobs.length + 1 };
      jobs.push(job);
      return job.id;
    },
    clearTimeout(id) {
      const job = jobs.find((j) => j.id === id);
      if (job) job.cancelled = true;
    },
    tick(ms) {
      now += ms;
      for (const job of jobs) if (!job.cancelled && job.at <= now) {
        job.cancelled = true;
        job.fn();
      }
    },
    get pending() {
      return jobs.filter((j) => !j.cancelled).length;
    },
  };
}

function makeSocket() {
  FakeSocket.instances = [];
  const timers = fakeTimers();
  const seen = [];
  const closes = [];
  const replaced = [];
  const sock = createRoomSocket({
    url: "ws://test/ws/lobby",
    clientId: "tab-1",
    retryMs: 2000,
    WebSocket: FakeSocket,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onOpen: () => seen.push({ type: "open" }),
    onMessage: (data) => seen.push({ type: "message", data: JSON.parse(data) }),
    onClose: () => closes.push(1),
    onReplaced: () => replaced.push(1),
  });
  return { sock, timers, seen, closes, replaced };
}

test("reconnect: a drop retries after 2 s with the same per-tab id", () => {
  const { sock, timers, seen } = makeSocket();
  sock.connect();
  assert.equal(FakeSocket.instances.length, 1);
  const first = FakeSocket.instances[0];
  assert.match(first.url, /client=tab-1/);

  first.open();
  assert.deepEqual(seen, [{ type: "open" }]);
  assert.equal(sock.send({ t: "hello" }), true);
  assert.deepEqual(first.sent, ['{"t":"hello"}']);

  first.drop();
  assert.equal(sock.connected, false);
  assert.equal(timers.pending, 1, "one retry is scheduled");
  assert.equal(FakeSocket.instances.length, 1, "nothing connects before the delay");

  timers.tick(1999);
  assert.equal(FakeSocket.instances.length, 1);
  timers.tick(1);
  assert.equal(FakeSocket.instances.length, 2, "reconnected after 2 s");
  assert.equal(FakeSocket.instances[1].url, first.url, "same client id, same room");

  // messages from the replaced socket must not reach the game
  first.message({ t: "chat", text: "stale" });
  assert.ok(!seen.some((e) => e.type === "message"), "ignored");
  FakeSocket.instances[1].open();
  FakeSocket.instances[1].message({ t: "you", id: "new" });
  assert.deepEqual(seen.at(-1), { type: "message", data: { t: "you", id: "new" } });
});

test("reconnect: being replaced by the server stops the retry loop", () => {
  const { sock, timers, replaced } = makeSocket();
  sock.connect();
  const s = FakeSocket.instances[0];
  s.open();
  s.drop(REPLACED_CLOSE_CODE);
  assert.equal(replaced.length, 1);
  assert.equal(timers.pending, 0, "no retry after 4001");
  timers.tick(10_000);
  assert.equal(FakeSocket.instances.length, 1);
  assert.equal(sock.replaced, true);
});

test("reconnect: send() is safe before and during a reconnect", () => {
  const { sock, timers } = makeSocket();
  sock.connect();
  assert.equal(sock.send({ t: "pos" }), false, "while connecting");
  FakeSocket.instances[0].open();
  assert.equal(sock.send({ t: "pos" }), true);
  FakeSocket.instances[0].drop();
  assert.equal(sock.send({ t: "pos" }), false, "while waiting to retry");
  timers.tick(2000);
  assert.equal(sock.send({ t: "pos" }), false, "while the retry is connecting");
});

test("room view: state after a reconnect replaces the roster instead of adding to it", () => {
  const added = [];
  const removed = [];
  const view = createRoomView({
    onAdd: (p) => added.push(p.id),
    onRemove: (id) => removed.push(id),
  });

  // before the drop: a and b are drawn
  view.add({ id: "a", name: "A" });
  view.add({ id: "b", name: "B" });
  assert.deepEqual(added, ["a", "b"]);

  // after the reconnect: b is still there, a left while we were away, c is new
  view.sync([{ id: "b", name: "B", x: 5 }, { id: "c", name: "C" }]);
  assert.deepEqual(removed, ["a"], "the ghost is dropped");
  assert.deepEqual(added, ["a", "b", "c"], "nobody is created twice");
  assert.equal(view.players.get("b").x, 5, "existing entries are refreshed");
});

test("room view: the same player twice stays one character", () => {
  let adds = 0;
  const view = createRoomView({ onAdd: () => adds++, onRemove: () => {} });
  const p = { id: "x", name: "one" };
  view.add(p);
  view.add({ ...p, name: "two" });
  view.sync([{ ...p, name: "three" }]);
  assert.equal(adds, 1);
  assert.equal(view.players.size, 1);
  assert.equal(view.players.get("x").name, "three");
});

test("room view: clear() empties the roster (every socket close)", () => {
  const removed = [];
  const view = createRoomView({ onAdd: () => {}, onRemove: (id) => removed.push(id) });
  view.sync([{ id: "a" }, { id: "b" }]);
  view.clear();
  assert.deepEqual(removed.sort(), ["a", "b"]);
  assert.equal(view.players.size, 0);
});
