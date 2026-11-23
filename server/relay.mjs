/**
 * The relay behind playing online. Node with no dependencies, one file, and no idea what a race is.
 *
 *   GET /api/relay   with an Upgrade: websocket header
 *
 * A client's first message is `{"join":"BCDF"}` to enter a room, or `{"join":null}` to make one. The reply
 * is `{"room":"BCDF","slot":0,"peers":[1],"key":"…"}`. After that every message is passed to the other
 * members of the room with the sender's slot on the front, and almost nothing is ever inspected.
 *
 * Keeping it ignorant is deliberate. A relay that understood the game would need to be kept in step with
 * the game, would have opinions about who is allowed to be where, and would be a third machine able to
 * disagree with the two that matter. This one forwards bytes, and the only thing it can get wrong is who
 * it forwards them to. Two small exceptions, both about time rather than about the game:
 *
 *   - the key in the join reply is how a dropped connection gets its own seat back: `{"join":"BCDF",
 *     "key":"…"}` rejoins the same slot instead of taking a new one, and the room hears `left` and then
 *     `joined` as it happens. A seat is held for REJOIN_MS after its connection drops, not for ever.
 *   - input and hash packets carry the race's generation in their second byte, and a packet from a race
 *     that is over is dropped rather than delivered into the one that has started. The clients check
 *     the same byte themselves; the relay doing it too keeps stale traffic off everybody else's wire.
 *
 * Configuration, all optional:
 *   SM_RELAY_PORT    port to listen on                     (default 8788)
 *   SM_RELAY_PROXY   set to 1 behind a reverse proxy, to read X-Forwarded-For
 *   SM_RELAY_ROOMS   how many rooms may exist at once      (default 500)
 */
import { createServer } from 'node:http';
import { randomInt } from 'node:crypto';
import { decode, encode, close, handshake, OP } from './ws.mjs';

/** No vowels, so a code is never a word, and no letters that read as each other out loud. */
export const ALPHABET = 'BCDFGHJKLMNPRSTVWXZ';
export const CODE_LENGTH = 4;
/** Room slots: four cars, four people. */
export const MAX_PLAYERS = 4;
/** A room nobody has spoken in for this long is gone. */
export const IDLE_MS = 20 * 60 * 1000;
/**
 * How long a disconnected member's slot is kept for them. A phone that lost the lift's wifi for ten
 * seconds should come back to the same car in the same race; a tab that was closed should not hold a
 * seat for ever. Two minutes is far longer than any honest gap and far shorter than the room's own
 * idle timeout, so a room whose people have all gone is reclaimed well before the sweep would take it.
 */
export const REJOIN_MS = 2 * 60 * 1000;
/** The rejoin key is a room code's worth of letters, four times over. */
export const KEY_LENGTH = 16;
/**
 * How often to ping a quiet connection. Two people sitting in a lobby say nothing to each other, and
 * Cloudflare drops a WebSocket that has been silent for about a hundred seconds, so without this the room
 * dies while they are still reading the code out loud. Browsers answer a ping by themselves.
 */
export const KEEPALIVE_MS = 25 * 1000;
const MAX_FRAME = 4096;
const MAX_ROOMS_DEFAULT = 500;

export function makeCode(rand = (n) => randomInt(n)) {
  let s = '';
  for (let i = 0; i < CODE_LENGTH; i++) s += ALPHABET[rand(ALPHABET.length)];
  return s;
}

/**
 * The secret a reconnecting client proves itself with. Made by the server, kept by the client, and
 * never said out loud: anybody who has it is allowed to sit in that seat, which is the whole mechanism.
 */
export function makeKey(rand = (n) => randomInt(n)) {
  let s = '';
  for (let i = 0; i < KEY_LENGTH; i++) s += ALPHABET[rand(ALPHABET.length)];
  return s;
}

/** What a client may have typed. Case and stray spaces are the user's business, not theirs to get right. */
export function normaliseCode(input) {
  if (typeof input !== 'string') return undefined;
  const s = input.trim().toUpperCase();
  if (s.length !== CODE_LENGTH) return undefined;
  for (const c of s) if (!ALPHABET.includes(c)) return undefined;
  return s;
}

/**
 * The rooms, with no sockets in sight. A member is any object at all; the server puts its connection in
 * there, a test puts a plain array. That is what makes the joining and leaving rules testable.
 *
 * A member who joined with a key is not deleted when their connection drops: the slot is kept, marked
 * gone, for REJOIN_MS, so the same key can come back and sit in it again. The rest of the room hears
 * about the going and the coming back as they happen, and a slot that is only reserved still counts
 * towards the room being full — four cars is four cars, whether or not one of them is briefly quiet.
 */
export class Rooms {
  constructor(max = MAX_ROOMS_DEFAULT, now = () => Date.now()) {
    this.rooms = new Map();
    this.max = max;
    this.now = now;
  }

  /** Makes a room and returns its code, or undefined when there is no room for another one. */
  create(rand) {
    this.sweep();
    if (this.rooms.size >= this.max) return undefined;
    let code;
    do { code = makeCode(rand); } while (this.rooms.has(code));
    this.rooms.set(code, { members: new Map(), at: this.now() });
    return code;
  }

  /** The slots of everybody actually connected, except one: what a join reply calls `peers`. */
  present(room, except) {
    return [...room.members.entries()].filter(([s, m]) => s !== except && !m.gone).map(([s]) => s);
  }

  /**
   * Puts a member in a room. Returns `{ slot, peers }`, or `{ error }` saying which of the three things
   * went wrong, because "could not join" on its own sends people to look in the wrong place.
   *
   * Given a `key` the room already knows, this is a rejoin instead: the member gets their old slot back
   * (`back: true`), still on the race generation their packets were at when they left, and — when the
   * old connection is somehow still standing, as a half-open socket likes to be — `replaced` holds it
   * so the caller can put it down. An unknown key is simply somebody new, who keeps the key they
   * arrived with.
   */
  join(code, member, key) {
    this.sweep();
    const room = this.rooms.get(code);
    if (!room) return { error: 'no such room' };
    if (key !== undefined) {
      for (const [slot, m] of room.members) {
        if (m.key !== key) continue;
        const replaced = m.gone ? undefined : m.conn;
        m.conn = member;
        m.gone = false;
        m.goneAt = undefined;
        room.at = this.now();
        return { slot, peers: this.present(room, slot), back: true, replaced };
      }
    }
    if (room.members.size >= MAX_PLAYERS) return { error: 'that room is full' };
    let slot = 0;
    while (room.members.has(slot)) slot++;
    room.members.set(slot, { key, conn: member, gone: false, gen: 0 });
    room.at = this.now();
    return { slot, peers: this.present(room, slot) };
  }

  /**
   * A connection went away. A keyed member leaves their seat reserved rather than empty: the room says
   * they left, and if they are back inside the grace nobody ever has to know why. An unkeyed one is
   * simply forgotten, and the room with nobody in it at all is gone. When nobody connected is left at
   * all, the evening's race counter is forgotten too: whatever happens next starts from race 0 again,
   * so a room full of reloaded pages is not still filtering packets by a race that ended yesterday.
   */
  leave(code, slot) {
    const room = this.rooms.get(code);
    if (!room) return;
    const m = room.members.get(slot);
    if (!m) return;
    if (m.key !== undefined) {
      m.conn = undefined;
      m.gone = true;
      m.goneAt = this.now();
    } else {
      room.members.delete(slot);
    }
    if (room.members.size === 0) { this.rooms.delete(code); return; }
    if ([...room.members.values()].every(x => x.gone)) {
      for (const x of room.members.values()) x.gen = 0;
    }
  }

  /**
   * Everybody connected in the room except one slot: the list a message gets forwarded to.
   *
   * Given a `gen` — the race number an input or hash packet carries — the list is also how the relay
   * learns who has moved on: the sender's race is noted, and the packet goes only to members whose own
   * race is no newer. A straggler from a finished race is never delivered into the next one, while a
   * player still finishing the previous race keeps getting its packets for exactly as long as anyone
   * else is still there too. The clients check the same byte themselves; this keeps stale traffic off
   * the wires of everybody who has already moved on.
   */
  others(code, slot, gen) {
    const room = this.rooms.get(code);
    if (!room) return [];
    room.at = this.now();
    if (gen !== undefined) {
      const from = room.members.get(slot);
      if (from && gen > from.gen) from.gen = gen;
    }
    return [...room.members.entries()]
      .filter(([s, m]) => s !== slot && !m.gone && (gen === undefined || m.gen <= gen))
      .map(([, m]) => m.conn);
  }

  size(code) { return this.rooms.get(code)?.members.size ?? 0; }

  /**
   * Drops rooms nobody has used for a while, so a forgotten tab does not hold a code for ever, and
   * drops the reserved seats whose grace has run out — which is also how a room whose members all
   * disconnected is reclaimed: once the last placeholder goes, there is nobody left to keep it for.
   */
  sweep() {
    const cutoff = this.now() - IDLE_MS;
    const keep = this.now() - REJOIN_MS;
    for (const [code, room] of this.rooms) {
      if (room.at < cutoff) { this.rooms.delete(code); continue; }
      let dropped = false;
      for (const [slot, m] of room.members) {
        if (m.gone && m.goneAt !== undefined && m.goneAt < keep) { room.members.delete(slot); dropped = true; }
      }
      // A room the sweep itself just emptied is reclaimed; a room that simply has not been joined yet
      // is left for the idle timeout, as it always was.
      if (dropped && room.members.size === 0) this.rooms.delete(code);
    }
  }
}

/**
 * The first message. Returns `{ create: true }`, `{ code }`, or `{ error }`. Anything else a client sends
 * before it has joined is refused rather than guessed at. A `key` alongside the code asks for the seat
 * that key was given last time, instead of whichever happens to be free.
 */
export function parseJoin(text) {
  let body;
  try { body = JSON.parse(text); } catch { return { error: 'that is not JSON' }; }
  // Arrays are objects, and `'join' in []` is true, because Array.prototype has a join. Without this an
  // array slips past the guard and comes back complaining about the room code instead.
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return { error: 'expected a join' };
  if (!('join' in body)) return { error: 'expected a join' };
  const key = 'key' in body ? body.key : undefined;
  if (key !== undefined && (typeof key !== 'string' || key.length === 0 || key.length > 64)) {
    return { error: 'a rejoin key is a short string' };
  }
  if (body.join === null || body.join === undefined) return { create: true };
  const code = normaliseCode(body.join);
  return code ? { code, key } : { error: 'a room code is four letters' };
}

/** A forwarded message: the sender's slot, then whatever they sent, untouched. */
export function tag(slot, payload) {
  const out = Buffer.allocUnsafe(payload.length + 1);
  out[0] = slot;
  payload.copy ? payload.copy(out, 1) : Buffer.from(payload).copy(out, 1);
  return out;
}

// ---------------------------------------------------------------- the server

const PORT = Number(process.env.SM_RELAY_PORT ?? 8788);
const TRUST_PROXY = process.env.SM_RELAY_PROXY === '1';
const MAX_ROOMS = Number(process.env.SM_RELAY_ROOMS ?? MAX_ROOMS_DEFAULT);

function addressOf(req) {
  if (TRUST_PROXY) {
    const fwd = req.headers['x-forwarded-for'];
    const first = (Array.isArray(fwd) ? fwd[0] : fwd)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

export function start(port = PORT) {
  const rooms = new Rooms(MAX_ROOMS);
  const server = createServer((req, res) => {
    // The only plain request worth answering is a health check; everything else here is an upgrade.
    if ((req.url ?? '').split('?')[0] === '/api/relay') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      return res.end(JSON.stringify({ ok: true, rooms: rooms.rooms.size }));
    }
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end('{"error":"not found"}');
  });

  server.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key'];
    if ((req.url ?? '').split('?')[0] !== '/api/relay' || !key) {
      socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
      return;
    }
    socket.write(handshake(key));
    socket.setNoDelay(true);                 // every millisecond here is a millisecond of input delay

    const client = { socket, code: undefined, slot: -1, who: addressOf(req) };
    let buffer = Buffer.alloc(0);
    let carry = null;

    const send = (opcode, payload) => { if (!socket.destroyed) socket.write(encode(opcode, payload)); };
    const fail = (reason, code = 1008) => {
      if (!socket.destroyed) { socket.write(close(code, reason)); socket.end(); }
    };
    client.send = send;

    const beat = setInterval(() => send(OP.PING), KEEPALIVE_MS);
    beat.unref?.();

    const bye = () => {
      clearInterval(beat);
      if (client.code !== undefined) {
        for (const m of rooms.others(client.code, client.slot)) {
          m.send(OP.TEXT, JSON.stringify({ left: client.slot }));
        }
        rooms.leave(client.code, client.slot);
      }
      client.code = undefined;
    };

    socket.on('data', chunk => {
      buffer = buffer.length === 0 ? chunk : Buffer.concat([buffer, chunk]);
      const { messages, rest, error, carry: next } = decode(buffer, MAX_FRAME, carry);
      buffer = Buffer.from(rest);
      carry = next ?? null;
      if (error) return fail(error, 1002);

      for (const { opcode, payload } of messages) {
        if (opcode === OP.CLOSE) { bye(); return fail('bye', 1000); }
        if (opcode === OP.PING) { send(OP.PONG, payload); continue; }
        if (opcode === OP.PONG) continue;

        if (client.code === undefined) {                       // still on the doorstep
          const want = parseJoin(payload.toString('utf8'));
          if (want.error) { send(OP.TEXT, JSON.stringify({ error: want.error })); continue; }
          const code = want.create ? rooms.create() : want.code;
          if (!code) { send(OP.TEXT, JSON.stringify({ error: 'no room for another room' })); continue; }
          // A rejoining client arrives with the key it was given last time; a new one is given one now,
          // so that its next visit — after a tunnel, a lift, a laptop lid — can find its own seat again.
          const key = want.key ?? makeKey();
          const got = rooms.join(code, client, key);
          if (got.error) { send(OP.TEXT, JSON.stringify({ error: got.error })); continue; }
          client.code = code; client.slot = got.slot;
          if (got.replaced) {
            // The old connection was still standing when its replacement arrived. It must not get a
            // say in the room any more: forgetting its code means its own goodbye, when it comes,
            // touches nothing.
            got.replaced.code = undefined;
            got.replaced.socket.destroy();
          }
          send(OP.TEXT, JSON.stringify({ room: code, slot: got.slot, peers: got.peers, key, back: got.back === true }));
          const news = got.back ? { joined: got.slot, back: true } : { joined: got.slot };
          for (const m of rooms.others(code, got.slot)) m.send(OP.TEXT, JSON.stringify(news));
          continue;
        }

        // Joined: forward, and do not look inside — with one exception. The first two bytes of an
        // input or hash packet (src/net/packet.ts) are its kind and its race generation, and the
        // generation decides who the packet is still worth anything to. Everything else, including
        // the lobby's SAY, goes to everybody, untouched.
        const kind = payload[0];
        const gen = (kind === 1 || kind === 2) && payload.length >= 2 ? payload[1] : undefined;
        const out = tag(client.slot, payload);
        for (const m of rooms.others(client.code, client.slot, gen)) m.send(opcode, out);
      }
    });

    socket.on('close', bye);
    socket.on('error', bye);
  });

  server.listen(port);
  server.on('listening', () => console.log(`relay: listening on ${server.address()?.port ?? port}`));
  return server;
}

// Run only when this file is the program, so the tests can import the parts above without a socket.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) start();
