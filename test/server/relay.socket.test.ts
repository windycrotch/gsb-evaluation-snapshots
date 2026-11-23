/**
 * The relay with real sockets on it.
 *
 * The rest of the server is tested without binding anything, on the grounds that the HTTP shell is thin
 * enough to read. This one is not: the handshake and the frame codec are written out here rather than
 * depended on, so the thing worth proving is that a real browser-grade client can talk to it. Node's own
 * WebSocket is that client.
 */
import { describe, it, expect, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { start } from '../../server/relay.mjs';

const server: Server = start(0);
const port = await new Promise<number>(res => {
  server.on('listening', () => res((server.address() as { port: number }).port));
});
afterAll(() => { server.close(); });

interface Client { ws: WebSocket; text: string[]; binary: number[][]; }

function open(): Promise<Client> {
  return new Promise((res, rej) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/api/relay`);
    ws.binaryType = 'arraybuffer';
    const c: Client = { ws, text: [], binary: [] };
    ws.onmessage = e => {
      if (typeof e.data === 'string') c.text.push(e.data);
      else c.binary.push([...new Uint8Array(e.data as ArrayBuffer)]);
    };
    ws.onopen = () => res(c);
    ws.onerror = rej;
  });
}

const settle = (): Promise<void> => new Promise(r => setTimeout(r, 120));

describe('two clients and a relay', () => {
  it('makes a room, lets the other one in, and passes bytes between them', async () => {
    const a = await open();
    a.ws.send(JSON.stringify({ join: null }));
    await settle();
    const hello = JSON.parse(a.text[0]!) as { room: string; slot: number; peers: number[] };
    expect(hello.slot).toBe(0);
    expect(hello.peers).toEqual([]);
    expect(hello.room).toHaveLength(4);

    const b = await open();
    b.ws.send(JSON.stringify({ join: hello.room.toLowerCase() }));   // typed in lower case, as people do
    await settle();
    expect(JSON.parse(b.text[0]!)).toMatchObject({ room: hello.room, slot: 1, peers: [0], back: false });
    expect(JSON.parse(b.text[0]!).key).toMatch(/^[BCDFGHJKLMNPRSTVWXZ]{16}$/);
    expect(JSON.parse(a.text[1]!)).toEqual({ joined: 1 });

    b.ws.send(new Uint8Array([1, 2, 3]));
    a.ws.send(new Uint8Array([9, 9]));
    await settle();
    expect(a.binary).toEqual([[1, 1, 2, 3]]);              // slot 1 said 1,2,3
    expect(b.binary).toEqual([[0, 9, 9]]);                 // slot 0 said 9,9

    b.ws.close();
    await settle();
    expect(JSON.parse(a.text[2]!)).toEqual({ left: 1 });
    a.ws.close();
  });

  it('says so when the room is not there', async () => {
    const c = await open();
    c.ws.send(JSON.stringify({ join: 'ZZZZ' }));
    await settle();
    expect(JSON.parse(c.text[0]!)).toEqual({ error: 'no such room' });
    c.ws.close();
  });

  it('answers a plain GET, so a deploy can check it is alive', async () => {
    const r = await fetch(`http://127.0.0.1:${port}/api/relay`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true });
  });
});

describe('reconnecting', () => {
  it('gives a client its seat back, and tells the room about the going and the coming', async () => {
    const a = await open();
    a.ws.send(JSON.stringify({ join: null }));
    await settle();
    const hello = JSON.parse(a.text[0]!) as { room: string; key: string };
    expect(hello.key).toMatch(/^[BCDFGHJKLMNPRSTVWXZ]{16}$/);

    const b = await open();
    b.ws.send(JSON.stringify({ join: hello.room }));
    await settle();
    const bHello = JSON.parse(b.text[0]!) as { slot: number; key: string };
    expect(bHello.slot).toBe(1);

    b.ws.close();
    await settle();
    expect(JSON.parse(a.text[1]!)).toEqual({ joined: 1 });   // b arrived, earlier
    expect(JSON.parse(a.text[2]!)).toEqual({ left: 1 });     // and then its connection dropped

    const b2 = await open();
    b2.ws.send(JSON.stringify({ join: hello.room, key: bHello.key }));
    await settle();
    const back = JSON.parse(b2.text[0]!) as { slot: number; key: string; back: boolean };
    expect(back.slot).toBe(1);                            // the same seat, not whichever was free
    expect(back.key).toBe(bHello.key);
    expect(back.back).toBe(true);
    expect(JSON.parse(a.text[3]!)).toEqual({ joined: 1, back: true });

    b2.ws.send(new Uint8Array([7, 7]));
    await settle();
    expect(a.binary).toEqual([[1, 7, 7]]);                // and the wire works, tagged with the same slot
    a.ws.close();
    b2.ws.close();
  });

  it('lets a duplicate connection take the seat over without the room hearing a goodbye', async () => {
    const a = await open();
    a.ws.send(JSON.stringify({ join: null }));
    await settle();
    const room = (JSON.parse(a.text[0]!) as { room: string }).room;

    const b = await open();
    b.ws.send(JSON.stringify({ join: room }));
    await settle();
    const key = (JSON.parse(b.text[0]!) as { key: string }).key;

    // b's socket is still standing — as a half-open one would be — when its replacement arrives.
    const b2 = await open();
    b2.ws.send(JSON.stringify({ join: room, key }));
    await settle();
    const back = JSON.parse(b2.text[0]!) as { slot: number; back: boolean };
    expect(back.slot).toBe(1);
    expect(back.back).toBe(true);
    // The room hears only that 1 is (still) here: the seat never went empty.
    expect(JSON.parse(a.text[1]!)).toEqual({ joined: 1 });
    expect(JSON.parse(a.text[2]!)).toEqual({ joined: 1, back: true });
    expect(a.text).toHaveLength(3);

    b2.ws.send(new Uint8Array([5]));
    await settle();
    expect(b.binary).toEqual([]);                         // the ghost is deaf
    expect(a.binary).toEqual([[1, 5]]);
    a.ws.close();
    b2.ws.close();
  });

  it('hands out distinct seats when two clients arrive at once', async () => {
    const a = await open();
    a.ws.send(JSON.stringify({ join: null }));
    await settle();
    const room = (JSON.parse(a.text[0]!) as { room: string }).room;

    const [b, c] = await Promise.all([open(), open()]);
    b.ws.send(JSON.stringify({ join: room }));
    c.ws.send(JSON.stringify({ join: room }));
    await settle();
    const slots = [JSON.parse(b.text[0]!).slot as number, JSON.parse(c.text[0]!).slot as number];
    expect([...slots].sort()).toEqual([1, 2]);
    // The room heard about each of them exactly once, whoever got there first.
    const joined = a.text.slice(1).map(t => (JSON.parse(t) as { joined: number }).joined).sort();
    expect(joined).toEqual([1, 2]);
    a.ws.close();
    b.ws.close();
    c.ws.close();
  });
});

describe('race generations on the wire', () => {
  const INPUT = 1, SAY = 3;
  const input = (gen: number, step: number): Uint8Array => {
    const u = new Uint8Array(8);
    u[0] = INPUT;
    u[1] = gen;
    new DataView(u.buffer).setUint32(2, step, true);
    u[6] = 1;
    u[7] = 0x20;
    return u;
  };

  it('stops sending a member packets from races they have moved on from', async () => {
    const a = await open();
    a.ws.send(JSON.stringify({ join: null }));
    await settle();
    const room = (JSON.parse(a.text[0]!) as { room: string }).room;
    const b = await open();
    b.ws.send(JSON.stringify({ join: room }));
    await settle();

    const say = new Uint8Array([SAY, ...new TextEncoder().encode('{"hi":1}')]);
    b.ws.send(input(0, 10));
    b.ws.send(input(1, 0));                               // b is in the next race; a still hears it all
    await settle();
    a.ws.send(input(1, 0));                               // now a has moved on too
    await settle();
    b.ws.send(input(0, 20));                              // a straggler from race 0: not for a any more
    b.ws.send(say);                                       // the lobby is not a race: always forwarded
    await settle();
    expect(a.binary).toEqual([[1, ...input(0, 10)], [1, ...input(1, 0)], [1, ...say]]);
    expect(b.binary).toEqual([[0, ...input(1, 0)]]);
    a.ws.close();
    b.ws.close();
  });
});
