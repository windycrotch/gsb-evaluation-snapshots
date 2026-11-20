// Room server: one Durable Object per room, everyone connected over WebSocket.
// Protocol (JSON):
//   client -> server: { t: "hello", name, gender } | { t: "pos", x, z, dir, step }
//                     { t: "chat", text } | { t: "name", name } | { t: "gender", gender }
//                     { t: "radio", idx, password }   (admin)
//   server -> client: { t: "you", id } | { t: "state", players: [...] }
//                     { t: "joined", player } | { t: "left", id } | { t: "pos", ... }
//                     { t: "chat", id, name, text, at } | { t: "name", id, name }
//                     { t: "gender", id, gender } | { t: "radio", command } | { t: "error", msg }
//   the WebSocket URL may carry ?client=<per-tab id>, so a reconnect can be told apart
//   from a second tab of the same person.
//
// Security (the client is public, so nothing coming from it is trusted):
//  - max message size, per-connection rate limit, max players per room
//  - admin password only on the server (ADMIN_PASSWORD secret), constant-time compare,
//    failures counted per IP in storage (one transaction per try) and locked after a few
//  - allowed origins (ALLOWED_ORIGINS) so other sites can't use this server
//  - per IP: few connections, shared chat budget, admin lockout, progressive mute for spam
//  - all text is stripped of control characters and truncated; numbers finite and clamped
//
// A connection from an IP already at its limit replaces the oldest one on that IP
// (closed with 4001 and announced as `left`) instead of being refused, so a reconnect
// always gets in even while the connection it replaces still looks open to the server.
// A connection that presents the client id of an older one (the same tab reconnecting)
// replaces that older connection first, so a player never sees a ghost of itself.
//
// Per-IP state that has to outlive a connection (mute strikes, admin failures) lives in
// storage; per-connection state (player, position, rate buckets) lives in memory or on
// the socket and is dropped when the connection goes away.

const MAX_PLAYERS = 100;
// v1 has a single room; any other name is refused so nobody can spin up extra rooms (and extra cost)
const ROOMS = ["lobby"];
const MAX_BYTES = 1024;
const COORD_LIMIT = 500;
const ADMIN_ATTEMPTS = 5; // per IP, then locked for ADMIN_LOCK_MS
const ADMIN_LOCK_MS = 15 * 60_000;
const MAX_PER_IP = 3; // tabs/devices behind one IP
const REPLACED_CLOSE_CODE = 4001;
// progressive mute: each spam strike mutes for longer; strikes are forgotten after STRIKE_RESET_MS quiet
const MUTE_STEPS_MS = [0, 15_000, 60_000, 5 * 60_000, 30 * 60_000]; // first strike is only a warning
const STRIKE_RESET_MS = 30 * 60_000;
const REPEAT_LIMIT = 3; // the same text more than this many times in a row...
const REPEAT_WINDOW_MS = 30_000; // ...inside this window counts as spam
// rate buckets: capacity, refill per second
const RATES = { pos: [30, 20], chat: [8, 1], other: [10, 1] };

// positive integer from an optional env var (local test knob), else the default
const limit = (env, name, fallback) => {
  const n = Number(env?.[name]);
  return Number.isInteger(n) && n > 0 ? n : fallback;
};
// comma-separated ladder from an optional env var (local test knob), else the default
const stepList = (env, name, fallback) => {
  const list = String(env?.[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n >= 0);
  return list.length ? list : fallback;
};

const DIRS = ["down", "up", "left", "right"];
const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;
const cleanText = (s, max) =>
  String(s ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
const number = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(-COORD_LIMIT, Math.min(COORD_LIMIT, n)) : 0;
};
const gender = (g) => (g === "female" ? "female" : "male");

// constant-time compare (timing doesn't leak how many characters match)
function equal(a, b) {
  const ea = new TextEncoder().encode(String(a));
  const eb = new TextEncoder().encode(String(b));
  let diff = ea.length ^ eb.length;
  for (let i = 0; i < Math.max(ea.length, eb.length); i++) diff |= (ea[i] ?? 0) ^ (eb[i] ?? 0);
  return diff === 0;
}

export class Room {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.buckets = new Map(); // "ip|type" or "id|pos" -> { tokens, at } (in memory)
    this.mute = new Map(); // ip -> Promise<{ strikes, mutedUntil, ... }> (cached from storage)
    this.muteQueues = new Map(); // ip -> promise chain, so strikes of one IP never race
    this.clock = 0; // keeps `since` strictly increasing, even within one millisecond
    this.limits = {
      maxPlayers: limit(env, "MAX_PLAYERS", MAX_PLAYERS),
      maxPerIp: limit(env, "MAX_PER_IP", MAX_PER_IP),
      adminAttempts: limit(env, "ADMIN_ATTEMPTS", ADMIN_ATTEMPTS),
      adminLockMs: limit(env, "ADMIN_LOCK_MS", ADMIN_LOCK_MS),
      muteSteps: stepList(env, "MUTE_STEPS_MS", MUTE_STEPS_MS),
    };
  }

  // --- connections -----------------------------------------------------------

  att(ws) {
    try {
      return ws.deserializeAttachment() || null;
    } catch {
      return null;
    }
  }
  // sockets that are still players: a replaced one is flagged before it is closed,
  // so it never shows up as a ghost while the close handshake is still in flight
  live() {
    return this.state.getWebSockets().filter((ws) => {
      const p = this.att(ws);
      return p && !p.left;
    });
  }
  // re-read after an await: the socket may have been replaced in the meantime
  stillHere(ws) {
    const p = this.att(ws);
    return !!p && !p.left;
  }
  nextSince() {
    this.clock = Math.max(Date.now(), this.clock + 1);
    return this.clock;
  }

  // a full snapshot of the room; the new player's socket is not a "server" socket
  // yet at that point, so it is filtered out by id
  async fetch(req) {
    if (req.headers.get("Upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const ip = req.headers.get("CF-Connecting-IP") || "local";
    const raw = new URL(req.url).searchParams.get("client") || "";
    const client = CLIENT_ID.test(raw) ? raw : "";

    // who has to go so this connection fits:
    //  - a connection carrying the same per-tab id (the same tab reconnecting), always
    //  - this IP's oldest connections while it is at its per-IP limit (the new one wins)
    const live = this.live();
    const stale = client ? live.filter((ws) => this.att(ws).client === client) : [];
    const mine = live
      .filter((ws) => !stale.includes(ws) && this.att(ws).ip === ip)
      .sort((a, b) => this.att(a).since - this.att(b).since);
    const excess = Math.max(0, mine.length - (this.limits.maxPerIp - 1));
    const victims = [...stale, ...mine.slice(0, excess)];

    // a room with no seat left refuses even a reconnect, unless replacing frees one
    if (live.length - victims.length >= this.limits.maxPlayers) return new Response("room is full", { status: 503 });
    for (const ws of victims) this.evict(ws);

    // hibernation: the DO can sleep with connections open; each player's
    // state lives on its own socket (serializeAttachment)
    const [browser, server] = Object.values(new WebSocketPair());
    const id = crypto.randomUUID().slice(0, 8);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({
      id,
      name: "trainer",
      gender: "male",
      x: 0,
      z: 0,
      dir: "down",
      step: 0,
      ip,
      client,
      since: this.nextSince(),
      left: false,
    });
    server.send(JSON.stringify({ t: "you", id }));
    const radio = await this.state.storage.get("radio");
    if (radio) server.send(JSON.stringify({ t: "radio", command: radio }));
    server.send(JSON.stringify({ t: "state", players: this.players().filter((p) => p.id !== id) }));
    return new Response(null, { status: 101, webSocket: browser });
  }

  // close a connection and tell the room it left; its per-connection state goes with it
  evict(ws) {
    const p = this.att(ws);
    if (!p || p.left) return false;
    p.left = true;
    try { ws.serializeAttachment(p); } catch {}
    this.forget(p);
    try { ws.close(REPLACED_CLOSE_CODE, "replaced"); } catch {}
    this.broadcast({ t: "left", id: p.id });
    return true;
  }
  // only each player's public fields (never the IP or the client id)
  public(p) {
    return { id: p.id, name: p.name, gender: p.gender, x: p.x, z: p.z, dir: p.dir, step: p.step };
  }
  players() {
    return this.live().map((ws) => this.public(this.att(ws)));
  }

  broadcast(msg, except) {
    const s = JSON.stringify(msg);
    for (const ws of this.live()) {
      if (ws === except) continue;
      try { ws.send(s); } catch {}
    }
  }

  // drop everything a connection kept in memory; its socket is already unusable
  forget(p) {
    this.buckets.delete(p.id + "|pos");
    if (this.live().some((ws) => this.att(ws).ip === p.ip)) return; // other tabs still here
    this.buckets.delete(p.ip + "|chat");
    this.buckets.delete(p.ip + "|other");
    // the persisted mute stays in storage (it belongs to the IP); only the cached
    // copy goes, and only when no strike for this IP is mid-flight
    if (!this.muteQueues.has(p.ip)) this.mute.delete(p.ip);
  }

  // --- rate limiting ---------------------------------------------------------

  // token bucket: movement per connection, chat and the rest shared by everyone on one IP
  allowed(p, type) {
    const [cap, refill] = RATES[type] || RATES.other;
    const key = (type === "pos" ? p.id : p.ip) + "|" + type;
    const now = Date.now() / 1000;
    let k = this.buckets.get(key);
    if (!k) this.buckets.set(key, (k = { tokens: cap, at: now }));
    k.tokens = Math.min(cap, k.tokens + (now - k.at) * refill);
    k.at = now;
    if (k.tokens < 1) return false;
    k.tokens -= 1;
    return true;
  }

  // --- messages --------------------------------------------------------------

  async webSocketMessage(ws, raw) {
    if (typeof raw !== "string" || raw.length > MAX_BYTES) return;
    let m;
    try { m = JSON.parse(raw); } catch { return; }
    if (!m || typeof m !== "object") return;
    const p = this.att(ws);
    if (!p || p.left) return; // a replaced connection can't act for the new one
    const type = m.t === "pos" ? "pos" : m.t === "chat" ? "chat" : "other";
    if (!this.allowed(p, type)) {
      if (type === "chat") await this.strike(ws, p);
      return;
    }

    if (m.t === "hello") {
      p.name = cleanText(m.name, 16) || "trainer";
      p.gender = gender(m.gender);
      ws.serializeAttachment(p);
      this.broadcast({ t: "joined", player: this.public(p) }, ws);
    } else if (m.t === "gender") {
      p.gender = gender(m.gender);
      ws.serializeAttachment(p);
      this.broadcast({ t: "gender", id: p.id, gender: p.gender }, ws);
    } else if (m.t === "name") {
      p.name = cleanText(m.name, 16) || "trainer";
      ws.serializeAttachment(p);
      this.broadcast({ t: "name", id: p.id, name: p.name }, ws);
    } else if (m.t === "pos") {
      p.x = number(m.x);
      p.z = number(m.z);
      p.dir = DIRS.includes(m.dir) ? m.dir : "down";
      p.step = Math.abs(m.step | 0) % 4;
      ws.serializeAttachment(p);
      this.broadcast({ t: "pos", id: p.id, x: p.x, z: p.z, dir: p.dir, step: p.step }, ws);
    } else if (m.t === "radio") {
      await this.radio(ws, p, m);
    } else if (m.t === "chat") {
      const text = cleanText(m.text, 140);
      if (!text) return;
      // everything that touches this IP's mute runs in order, so two messages
      // arriving together can't both pass the check or lose a strike
      await this.serialized(p.ip, async () => {
        if (!this.stillHere(ws)) return; // replaced while this message waited its turn
        const now = Date.now();
        const s = await this.muteOf(p.ip);
        await this.refreshMute(s, now);
        if (s.mutedUntil > now) return this.tellMuted(ws, s.mutedUntil);
        s.repeats = text === s.lastText && now - s.lastAt < REPEAT_WINDOW_MS ? s.repeats + 1 : 1;
        s.lastText = text;
        s.lastAt = now;
        if (s.repeats > REPEAT_LIMIT) return await this.applyStrike(ws, s, now);
        this.broadcast({ t: "chat", id: p.id, name: p.name, text, at: now });
      });
    }
  }

  // admin: the password and the failure count are checked and changed in one
  // storage transaction, so concurrent wrong tries can neither lose a count nor
  // slip past a lock. A lock that has ended starts again from zero failures.
  async radio(ws, p, m) {
    const key = "admin-fail:" + p.ip;
    const attempts = this.limits.adminAttempts;
    const outcome = await this.state.storage.transaction(async (txn) => {
      const now = Date.now();
      const rec = (await txn.get(key)) || { fails: 0, until: 0 };
      if (rec.until > now) return { ok: false, locked: true };
      const good = !!this.env.ADMIN_PASSWORD && typeof m.password === "string" && equal(m.password, this.env.ADMIN_PASSWORD);
      if (good) {
        await txn.delete(key);
        return { ok: true };
      }
      const fails = (rec.until && rec.until <= now ? 0 : rec.fails) + 1;
      if (fails >= attempts) {
        await txn.put(key, { fails: 0, until: now + this.limits.adminLockMs });
        return { ok: false, locked: true };
      }
      await txn.put(key, { fails, until: 0 });
      return { ok: false, locked: false };
    });
    if (outcome.ok) {
      // the connection may have been replaced while the transaction ran: only the
      // live connection broadcasts the result of its own admin command
      if (!this.stillHere(ws)) return;
      const command = { idx: Math.max(0, Math.min(999, m.idx | 0)), at: Date.now() };
      await this.state.storage.put("radio", command);
      this.broadcast({ t: "radio", command });
    } else {
      const msg = outcome.locked ? "admin locked, try later" : "invalid admin password";
      try { ws.send(JSON.stringify({ t: "error", msg })); } catch {}
    }
  }

  // --- per-IP mute (persisted, so a reconnect doesn't wash a mute away) -------

  muteOf(ip) {
    let cached = this.mute.get(ip);
    if (cached) return cached;
    cached = (async () => {
      const stored = (await this.state.storage.get("mute:" + ip)) || {};
      return {
        ip,
        strikes: stored.strikes || 0,
        mutedUntil: stored.mutedUntil || 0,
        lastStrike: stored.lastStrike || 0,
        lastText: "",
        lastAt: 0,
        repeats: 0,
      };
    })();
    // a failed read must not stay cached as a broken entry
    cached.catch(() => {
      if (this.mute.get(ip) === cached) this.mute.delete(ip);
    });
    this.mute.set(ip, cached);
    return cached;
  }
  saveMute(s) {
    if (!s.strikes && s.mutedUntil <= Date.now()) return this.state.storage.delete("mute:" + s.ip);
    return this.state.storage.put("mute:" + s.ip, {
      strikes: s.strikes,
      mutedUntil: s.mutedUntil,
      lastStrike: s.lastStrike,
    });
  }
  // strikes are forgotten after a long quiet spell (and the stored entry goes with them)
  async refreshMute(s, now) {
    if (!s.strikes || now - s.lastStrike <= STRIKE_RESET_MS) return;
    s.strikes = 0;
    s.lastStrike = 0;
    s.mutedUntil = 0;
    await this.saveMute(s);
  }
  // run one IP's operations in order: two strikes arriving together must both count
  serialized(ip, fn) {
    const prev = this.muteQueues.get(ip) || Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.catch(() => {});
    this.muteQueues.set(ip, tail);
    tail.then(() => {
      if (this.muteQueues.get(ip) === tail) this.muteQueues.delete(ip);
    });
    return run;
  }
  // a spam strike: mute this IP, longer each time
  strike(ws, p) {
    return this.serialized(p.ip, async () => {
      await this.applyStrike(ws, await this.muteOf(p.ip), Date.now());
    });
  }
  // the ladder step itself; callers hold the IP's queue (and have refreshed it)
  async applyStrike(ws, s, now) {
    if (s.mutedUntil > now) return; // already muted; don't stack while muted
    const steps = this.limits.muteSteps;
    const ms = steps[Math.min(s.strikes, steps.length - 1)];
    s.strikes++;
    s.lastStrike = now;
    s.mutedUntil = now + ms;
    await this.saveMute(s);
    if (!ms) {
      try { ws.send(JSON.stringify({ t: "error", msg: "slow down, next time you get muted" })); } catch {}
      return;
    }
    this.tellMuted(ws, s.mutedUntil);
  }
  tellMuted(ws, until) {
    const secs = Math.ceil((until - Date.now()) / 1000);
    const wait = secs >= 60 ? Math.ceil(secs / 60) + " min" : secs + " s";
    try { ws.send(JSON.stringify({ t: "error", msg: `muted for spam, ${wait} left` })); } catch {}
  }

  // --- disconnect ------------------------------------------------------------

  async webSocketClose(ws) { this.leave(ws); }
  async webSocketError(ws) { this.leave(ws); }
  leave(ws) {
    const p = this.att(ws);
    if (!p) return;
    if (p.left) return; // replaced: `left` was already broadcast by evict()
    p.left = true;
    try { ws.serializeAttachment(p); } catch {}
    this.forget(p);
    this.broadcast({ t: "left", id: p.id });
  }
}

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    // /ws/<room>  ->  that room's Durable Object. Everything else is the static site (assets).
    const m = url.pathname.match(/^\/ws\/([a-z0-9-]{1,32})$/i);
    if (!m) return env.ASSETS ? env.ASSETS.fetch(req) : new Response("lofi-lobby", { status: 404 });
    if (!ROOMS.includes(m[1].toLowerCase())) return new Response("unknown room", { status: 404 });

    // only accept connections from the site itself (or origins listed in ALLOWED_ORIGINS)
    const origin = req.headers.get("Origin");
    const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
    allowed.push(url.origin);
    if (!origin || !allowed.includes(origin)) return new Response("origin not allowed", { status: 403 });

    const stub = env.ROOM.get(env.ROOM.idFromName(m[1].toLowerCase()));
    return stub.fetch(req);
  },
};
