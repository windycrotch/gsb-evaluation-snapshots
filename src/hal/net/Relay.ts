/**
 * The browser end of `server/relay.mjs`: a WebSocket, a four letter room, and bytes in both directions.
 *
 * The protocol is deliberately tiny, because the relay is deliberately ignorant. The first message says
 * which room ({"join":"BCDF"}, or {"join":null} to make one) and the reply says who we turned out to be
 * and hands over a key. After that, text from the socket is the relay talking about the room and binary
 * is another player talking about the race, with their slot on the front. Nothing here looks inside a
 * player's bytes.
 *
 * The key is what makes a dropped connection a pause rather than an ending. When the socket goes without
 * being asked to, the room is rejoined with the same key, which puts this machine back in the same slot
 * of the same room — the race's generation never changed, so the packets that start flowing again belong
 * to the race that is still running. The room keeps the seat for a couple of minutes; longer than that
 * and the relay has quite rightly given it away, which is reported rather than retried for ever.
 */
import type { NetTransport, Slot } from '../../net/transport';

/** Where the relay is, given where the page came from. Caddy puts it on /api/relay next to the poll. */
export function relayUrl(): string {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${scheme}//${location.host}/api/relay`;
}

interface Hello { room: string; slot: number; peers: number[]; key: string; back?: boolean | undefined }

export class Relay implements NetTransport {
  readonly room: string;
  readonly slot: Slot;
  /** The secret that gets this machine its own seat back after a reconnection. */
  readonly key: string;
  readonly peers: Slot[];
  onPacket: ((from: Slot, data: Uint8Array) => void) | undefined;
  onJoin: ((slot: Slot) => void) | undefined;
  onLeave: ((slot: Slot) => void) | undefined;
  onError: ((why: string) => void) | undefined;
  /** The line came back after a drop. The race itself never noticed: it was stalled, and now it can go on. */
  onReconnect: (() => void) | undefined;

  /**
   * How long to wait before reconnection attempt `n`. A replaceable field rather than a constant so a
   * test does not have to wait out real backoff.
   */
  reconnectDelay: (retry: number) => number = n => Math.min(4000, 250 * 2 ** n);
  /** How many times to try before declaring the room lost. */
  maxRetries = 10;

  private ws: WebSocket;
  /** Set by close(): a goodbye we asked for is not something to recover from. */
  private closed = false;
  private retrying = false;

  private constructor(private readonly url: string, hello: Hello, ws: WebSocket) {
    this.room = hello.room;
    this.slot = hello.slot;
    this.key = hello.key;
    this.peers = [...hello.peers];
    this.ws = ws;
    this.attach(ws);
  }

  get open(): boolean { return this.ws.readyState === WebSocket.OPEN; }

  /**
   * Joins `room`, or makes one when it is undefined. Rejects with what the relay said rather than a generic
   * failure: "no such room" and "that room is full" send somebody to look in completely different places.
   * Given a `key` from an earlier visit, asks for the seat that key belongs to.
   */
  static async join(room?: string, url = relayUrl(), key?: string): Promise<Relay> {
    const { ws, hello } = await Relay.dial(url, room, key);
    return new Relay(url, hello, ws);
  }

  /** One connection attempt: open the socket, say the first message, wait for the reply. */
  private static dial(url: string, room: string | undefined, key?: string): Promise<{ ws: WebSocket; hello: Hello }> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try { ws = new WebSocket(url); } catch (e) { reject(new Error(String(e))); return; }
      ws.binaryType = 'arraybuffer';
      const fail = (why: string): void => { ws.onmessage = null; ws.onclose = null; ws.close(); reject(new Error(why)); };
      ws.onopen = () => { ws.send(JSON.stringify(key ? { join: room ?? null, key } : { join: room ?? null })); };
      ws.onerror = () => { fail('cannot reach the relay'); };
      ws.onclose = () => { reject(new Error('the relay closed the connection')); };
      ws.onmessage = e => {
        if (typeof e.data !== 'string') return fail('the relay said something unexpected');
        let body: Partial<Hello> & { error?: string };
        try { body = JSON.parse(e.data) as Partial<Hello> & { error?: string }; }
        catch { return fail('the relay said something unexpected'); }
        if (typeof body.error === 'string') return fail(body.error);
        if (typeof body.room !== 'string' || typeof body.slot !== 'number' || typeof body.key !== 'string') {
          return fail('the relay said something unexpected');
        }
        resolve({ ws, hello: { room: body.room, slot: body.slot, peers: body.peers ?? [], key: body.key, back: body.back } });
      };
    });
  }

  private attach(ws: WebSocket): void {
    ws.onmessage = e => this.take(e.data);
    // An error is always followed by the close, and the close is where the decision lives.
    ws.onclose = () => { if (this.closed) this.shut(); else void this.rejoin(); };
  }

  /**
   * The socket went without being asked. Try to come back: same room, same key, same seat. The handlers
   * stay exactly where the page put them, because as far as the race is concerned nothing happened —
   * the inputs it was waiting for simply arrive late, which rollback already knows how to absorb.
   */
  private async rejoin(): Promise<void> {
    if (this.retrying) return;
    this.retrying = true;
    try {
      for (let attempt = 0; ; attempt++) {
        if (this.closed) return;
        if (attempt >= this.maxRetries) {
          this.shut();
          this.onError?.('the connection to the relay was lost and could not be remade.');
          return;
        }
        await new Promise(r => setTimeout(r, this.reconnectDelay(attempt)));
        if (this.closed) return;
        let hello: Hello;
        try {
          const got = await Relay.dial(this.url, this.room, this.key);
          if (this.closed) { got.ws.close(); return; }
          this.ws = got.ws;
          hello = got.hello;
        } catch (e) {
          // A room that is not there any more is not coming back, however many times it is asked.
          if (e instanceof Error && /no such room/.test(e.message)) {
            this.shut();
            this.onError?.('the room is gone.');
            return;
          }
          continue;
        }
        if (hello.slot !== this.slot) {
          // The seat was kept for the key, so a different slot means the room moved on without us.
          this.ws.close();
          this.shut();
          this.onError?.('your place in the room was gone by the time you got back.');
          return;
        }
        this.attach(this.ws);
        // Who is here now, against who was here when the line went quiet. The join and leave messages
        // for that gap went to a socket that no longer existed, so the hello's list is the truth.
        for (const p of hello.peers) if (!this.peers.includes(p)) { this.peers.push(p); this.onJoin?.(p); }
        for (const p of [...this.peers]) {
          if (!hello.peers.includes(p)) { this.peers.splice(this.peers.indexOf(p), 1); this.onLeave?.(p); }
        }
        this.onReconnect?.();
        return;
      }
    } finally {
      this.retrying = false;
    }
  }

  send(data: Uint8Array): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  close(): void { this.closed = true; this.ws.close(); }

  private take(data: unknown): void {
    if (typeof data === 'string') return this.news(data);
    if (!(data instanceof ArrayBuffer) || data.byteLength < 1) return;
    const all = new Uint8Array(data);
    this.onPacket?.(all[0]!, all.subarray(1));
  }

  /** Text is the relay itself, talking about who is in the room. */
  private news(text: string): void {
    let body: { joined?: number; left?: number; error?: string };
    try { body = JSON.parse(text) as typeof body; } catch { return; }
    if (typeof body.error === 'string') { this.onError?.(body.error); return; }
    if (typeof body.joined === 'number') {
      if (!this.peers.includes(body.joined)) this.peers.push(body.joined);
      this.onJoin?.(body.joined);
    }
    if (typeof body.left === 'number') {
      const i = this.peers.indexOf(body.left);
      if (i >= 0) this.peers.splice(i, 1);
      this.onLeave?.(body.left);
    }
  }

  /** The socket went for good: everybody in the room is gone as far as this machine is concerned. */
  private shut(): void {
    for (const p of this.peers.splice(0)) this.onLeave?.(p);
  }
}
