// Local WebSocket tests for the Room Durable Object.
//
// Each case starts `wrangler dev` on a free port with the test config
// (test/wrangler.toml) and shortened limits, then drives real WebSocket clients.
// No YouTube, no Cloudflare account, no production credentials: only workerd on
// this machine.
//
//   npm test
//
// The limits used here are the env vars documented in wrangler.toml. The admin
// password is the fake "test-password" that startServer injects with --var.
//
// Each case gets a fresh server (and therefore an empty room): local `wrangler
// dev` finishes a server-initiated close handshake slowly, so a socket closed by
// one case would otherwise still be counted as a player by the next.

import test from "node:test";
import assert from "node:assert/strict";
import { startServer, client, join, sleep } from "./helpers.mjs";

const PASSWORD = "test-password";
const LIMITS = {
  MAX_PER_IP: 3,
  ADMIN_ATTEMPTS: 5,
  ADMIN_LOCK_MS: 1500,
  MUTE_STEPS_MS: "0,4000,8000", // warning, 4 s, 8 s
};

// a fresh server for one case; always stopped afterwards
async function withServer(t, limits, fn) {
  const server = await startServer(limits);
  try {
    await fn(server);
  } finally {
    server.stop();
  }
}

const ids = (list) => list.map((p) => p.id).sort();

// the server closed this socket: the client sees CLOSING at once (the close
// handshake itself can take seconds under local `wrangler dev`)
async function expectServerClosed(c, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (c.closed?.code === 4001) return c.closed;
    if (c.ws.readyState === 2 || c.ws.readyState === 3) return { code: c.closed?.code ?? null };
    await sleep(25);
  }
  throw new Error(`socket was not closed by the server (state ${c.ws.readyState})`);
}

test("join gets you, state and the current radio command", async (t) => {
  await withServer(t, LIMITS, async (server) => {
    const a = await join(server.port, { ip: "10.0.0.1" });
    assert.ok(a.id);
    assert.deepEqual(a.state, []);

    // a second connection is told about the first one
    const b = await join(server.port, { ip: "10.0.0.1" });
    assert.deepEqual(ids(b.state), [a.id]);
    assert.equal((await a.c.next("joined")).player.id, b.id);

    // admin sets the radio command; a later connection gets it while joining
    a.c.send({ t: "radio", idx: 3, password: PASSWORD });
    await a.c.next("radio");
    const c = await join(server.port, { ip: "10.0.0.15" });
    assert.equal((await c.c.next("radio")).command.idx, 3);

    // and a player who leaves is dropped from the next snapshot
    b.c.close();
    await a.c.next((m) => m.t === "left" && m.id === b.id);
    const d = await join(server.port, { ip: "10.0.0.16" });
    assert.ok(!ids(d.state).includes(b.id));
    assert.deepEqual(ids(d.state), ids([a, c]));

    for (const x of [a, c, d]) x.c.close();
  });
});

test("a reconnect always gets in, even with the old socket still open", async (t) => {
  await withServer(t, LIMITS, async (server) => {
    const ip = "10.0.0.2";
    // three tabs of one person, each with its own connection
    const a = await join(server.port, { ip, clientId: "tab-a" });
    const b = await join(server.port, { ip, clientId: "tab-b" });
    const c = await join(server.port, { ip, clientId: "tab-c" });
    const watcher = await join(server.port, { ip: "10.0.0.3" });

    // the network dropped for tab-a but the server hasn't noticed: its socket is
    // still open, so without replacement a fourth connection would be refused
    const reconnect = await join(server.port, { ip, clientId: "tab-a" });

    assert.notEqual(reconnect.id, a.id, "a reconnect is a fresh connection");
    assert.deepEqual(ids(reconnect.state), ids([b, c, watcher]));
    assert.ok(!reconnect.state.some((p) => p.id === a.id), "the replaced self is not in the room");

    // everyone else is told the old connection left, exactly once
    assert.equal((await watcher.c.next("left")).id, a.id);
    await watcher.c.none((m) => m.t === "left" && m.id === a.id, 400);

    // the server closed the replaced socket...
    assert.equal((await expectServerClosed(a.c)).code ?? 4001, 4001);
    // ...and it can no longer act on the room
    a.c.send({ t: "chat", text: "ghost" });
    await watcher.c.none((m) => m.t === "chat" && m.text === "ghost", 500);

    for (const x of [b, c, watcher, reconnect]) x.c.close();
  });
});

test("a full room still lets a reconnect in, but refuses a new player", async (t) => {
  await withServer(t, { ...LIMITS, MAX_PLAYERS: 2 }, async (server) => {
    const a = await join(server.port, { ip: "10.0.2.1", clientId: "tab-a" });
    const b = await join(server.port, { ip: "10.0.2.2" }); // the room is now full
    // a whole browser session lost for a while: both tabs come back
    const again = await join(server.port, { ip: "10.0.2.1", clientId: "tab-a" });
    assert.deepEqual(ids(again.state), [b.id]);

    // a genuinely new player is refused: nothing to replace, and no seat left
    const refused = client(server.port, { ip: "10.0.2.3" });
    await assert.rejects(refused.opened, (err) => /503/.test(err.message));
    assert.equal(refused.ws.readyState, 3);

    for (const x of [b, again]) x.c.close();
  });
});

test("a connection over the per-IP limit replaces the oldest", async (t) => {
  await withServer(t, LIMITS, async (server) => {
    const ip = "10.0.0.4";
    const a = await join(server.port, { ip });
    const b = await join(server.port, { ip });
    const c = await join(server.port, { ip });
    const watcher = await join(server.port, { ip: "10.0.0.5" });

    const d = await join(server.port, { ip });
    assert.equal((await watcher.c.next("left")).id, a.id, "the oldest one went");
    assert.deepEqual(ids(d.state), ids([b, c, watcher]));
    await expectServerClosed(a.c);
    // the two newer ones kept their seats
    const after = await join(server.port, { ip: "10.0.0.6" });
    assert.ok(ids(after.state).includes(b.id) && ids(after.state).includes(c.id));

    // repeated replacements never grow the room: a fifth and sixth connection on
    // the same IP each push one out, leaving exactly MAX_PER_IP players
    const e = await join(server.port, { ip });
    const f = await join(server.port, { ip });
    assert.equal((await watcher.c.next("left")).id, b.id);
    assert.equal((await watcher.c.next("left")).id, c.id);
    const final = await join(server.port, { ip: "10.0.0.17" });
    assert.deepEqual(ids(final.state), ids([d, e, f, watcher, after]), "3 seats per IP, no ghosts");

    for (const x of [d, e, f, watcher, after, final]) x.c.close();
  });
});

test("the chat budget is shared by every tab on one IP", async (t) => {
  await withServer(t, LIMITS, async (server) => {
    const ip = "10.0.0.12";
    const a = await join(server.port, { ip });
    const b = await join(server.port, { ip });
    const watcher = await join(server.port, { ip: "10.0.0.13" });
    // the bucket holds 8 messages; send all of them through one connection...
    for (let i = 0; i < 8; i++) a.c.send({ t: "chat", text: `a${i}` });
    for (let i = 0; i < 8; i++) await a.c.next((m) => m.t === "chat" && m.text === `a${i}`);
    // ...then one through the other tab of the same IP: over budget, dropped
    b.c.send({ t: "chat", text: "from-b" });
    await watcher.c.none((m) => m.t === "chat" && m.text === "from-b", 600);
    // a different IP is unaffected
    watcher.c.send({ t: "chat", text: "other-ip" });
    await watcher.c.next((m) => m.t === "chat" && m.text === "other-ip");

    for (const x of [a, b, watcher]) x.c.close();
  });
});

test("a mute follows the IP onto a new connection, and ends by itself", async (t) => {
  await withServer(t, LIMITS, async (server) => {
    const ip = "10.0.0.7";
    const a = await join(server.port, { ip });
    const watcher = await join(server.port, { ip: "10.0.0.14" });
    // the same text 4 times in a row is spam: first strike is only a warning
    for (let i = 0; i < 4; i++) a.c.send({ t: "chat", text: "same" });
    assert.match((await a.c.next((m) => m.t === "error")).msg, /slow down/);
    // the next repeat mutes the IP
    a.c.send({ t: "chat", text: "same" });
    assert.match((await a.c.next((m) => m.t === "error")).msg, /muted for spam/);

    // drop it and come back: the mute is still there on the new connection
    a.c.close();
    await a.c.waitClosed();
    const again = await join(server.port, { ip });
    again.c.send({ t: "chat", text: "hello?" });
    assert.match((await again.c.next((m) => m.t === "error")).msg, /muted for spam/);
    await watcher.c.none((m) => m.t === "chat" && m.text === "hello?", 500);

    // it ends on its own (4 s), and the same IP can talk again
    await sleep(4200);
    again.c.send({ t: "chat", text: "back" });
    const echoed = await again.c.next((m) => m.t === "chat" && m.text === "back", 3000);
    assert.equal(echoed.id, again.id);

    again.c.close();
    watcher.c.close();
  });
});

test("concurrent wrong passwords are all counted and lock the IP", async (t) => {
  await withServer(t, LIMITS, async (server) => {
    const ip = "10.0.0.8";
    const attacker = await join(server.port, { ip });
    // five wrong tries fired at once: every one must be counted
    for (let i = 0; i < LIMITS.ADMIN_ATTEMPTS; i++) attacker.c.send({ t: "radio", idx: 1, password: "wrong" });
    for (let i = 0; i < LIMITS.ADMIN_ATTEMPTS; i++) await attacker.c.next((m) => m.t === "error");

    // a new connection from that IP is locked, even with the right password
    attacker.c.close();
    const back = await join(server.port, { ip });
    back.c.send({ t: "radio", idx: 1, password: "wrong" });
    assert.match((await back.c.next((m) => m.t === "error")).msg, /locked/);
    back.c.send({ t: "radio", idx: 1, password: PASSWORD });
    assert.match((await back.c.next((m) => m.t === "error")).msg, /locked/);
    back.c.close();
  });
});

test("once the lock ends, a retry is allowed and the count starts at zero", async (t) => {
  await withServer(t, LIMITS, async (server) => {
    const ip = "10.0.0.9";
    const admin = await join(server.port, { ip });
    const watcher = await join(server.port, { ip: "10.0.0.10" });
    for (let i = 0; i < LIMITS.ADMIN_ATTEMPTS; i++) admin.c.send({ t: "radio", idx: 2, password: "wrong" });
    for (let i = 0; i < LIMITS.ADMIN_ATTEMPTS; i++) await admin.c.next((m) => m.t === "error");

    await sleep(LIMITS.ADMIN_LOCK_MS + 600);
    // one more wrong try is accepted for counting (not a lock message)
    admin.c.send({ t: "radio", idx: 2, password: "wrong" });
    assert.match((await admin.c.next((m) => m.t === "error")).msg, /invalid admin password/);
    // the count restarted at zero, so the right password still works now
    admin.c.send({ t: "radio", idx: 2, password: PASSWORD });
    assert.equal((await admin.c.next("radio")).command.idx, 2);
    assert.equal((await watcher.c.next("radio")).command.idx, 2);

    // a fresh connection is told the current command on join
    const fresh = await join(server.port, { ip: "10.0.0.11" });
    assert.equal((await fresh.c.next("radio")).command.idx, 2);

    for (const x of [admin, watcher, fresh]) x.c.close();
  });
});

test("mute and admin lock survive a server restart (they live in storage)", async (t) => {
  const limits = { MAX_PER_IP: 3, MUTE_STEPS_MS: "0,60000", ADMIN_ATTEMPTS: 2, ADMIN_LOCK_MS: 60000 };
  const first = await startServer(limits);
  let second = null;
  try {
    const ip = "10.0.1.1";
    const a = await join(first.port, { ip });
    // warning, then the 1 min mute
    for (let i = 0; i < 4; i++) a.c.send({ t: "chat", text: "spam" });
    assert.match((await a.c.next((m) => m.t === "error")).msg, /slow down/);
    a.c.send({ t: "chat", text: "spam" });
    assert.match((await a.c.next((m) => m.t === "error")).msg, /muted/);

    // two wrong passwords lock the admin for this IP
    a.c.send({ t: "radio", idx: 0, password: "nope" });
    a.c.send({ t: "radio", idx: 0, password: "nope" });
    for (let i = 0; i < 2; i++) await a.c.next((m) => m.t === "error");
    a.c.close();

    first.stop();
    await sleep(1200);
    second = await startServer(limits, { persist: first.persist });

    // a brand-new connection to a brand-new process still sees both
    const b = await join(second.port, { ip });
    b.c.send({ t: "chat", text: "anyone?" });
    assert.match((await b.c.next((m) => m.t === "error")).msg, /muted for spam/);
    b.c.send({ t: "radio", idx: 0, password: PASSWORD });
    assert.match((await b.c.next((m) => m.t === "error")).msg, /locked/);
    b.c.close();
  } finally {
    first.stop();
    second?.stop();
  }
});
