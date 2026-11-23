/**
 * The browser client against the real relay.
 *
 * Both halves were tested apart already: the server's frame codec against hand-built frames, the packet
 * codec against its own bytes. What neither proves is that they meet. Node's WebSocket is the same client a
 * browser is, so this runs the two ends against each other over a real socket, which is the only way to find
 * out that (say) the slot byte is being stripped twice.
 */
import { describe, it, expect, afterAll } from 'vitest';
import type { Server } from 'node:http';
import { start } from '../../server/relay.mjs';
import { Relay } from '../../src/hal/net/Relay';
import { encodeInput, decodePacket, INPUT } from '../../src/net/packet';

const server: Server = start(0);
const port = await new Promise<number>(res => {
  server.on('listening', () => res((server.address() as { port: number }).port));
});
const url = `ws://127.0.0.1:${port}/api/relay`;
afterAll(() => { server.close(); });

const settle = (): Promise<void> => new Promise(r => setTimeout(r, 120));

describe('the relay client', () => {
  it('makes a room, lets somebody in, and carries packets between them', async () => {
    const a = await Relay.join(undefined, url);
    expect(a.slot).toBe(0);
    expect(a.room).toHaveLength(4);
    expect(a.peers).toEqual([]);

    const joined: number[] = [];
    a.onJoin = s => joined.push(s);
    const got: { from: number; step: number; bytes: number[] }[] = [];
    a.onPacket = (from, data) => {
      const p = decodePacket(data);
      if (p?.kind === INPUT) got.push({ from, step: p.from, bytes: [...p.bytes] });
    };

    const b = await Relay.join(a.room.toLowerCase(), url);   // typed in lower case, as people do
    await settle();
    expect(b.slot).toBe(1);
    expect(b.peers).toEqual([0]);
    expect(joined).toEqual([1]);
    expect(a.peers).toEqual([1]);

    b.send(encodeInput(0, 41, [0x20, 0x60]));
    await settle();
    expect(got).toEqual([{ from: 1, step: 41, bytes: [0x20, 0x60] }]);

    const left: number[] = [];
    a.onLeave = s => left.push(s);
    b.close();
    await settle();
    expect(left).toEqual([1]);
    expect(a.peers).toEqual([]);
    a.close();
  });

  it('says what was actually wrong with the room, not just that it failed', async () => {
    await expect(Relay.join('ZZZZ', url)).rejects.toThrow('no such room');
  });

  it('hears about somebody leaving without losing its own connection', async () => {
    const a = await Relay.join(undefined, url);
    const b = await Relay.join(a.room, url);
    await settle();
    const left: number[] = [];
    b.onLeave = s => left.push(s);
    a.close();                                   // their socket goes, not the room
    await settle();
    expect(left).toEqual([0]);
    expect(b.open).toBe(true);                   // b is still in its room, waiting for somebody else
    b.close();
  });

  it('gives the seat back to whoever brings the key', async () => {
    const a = await Relay.join(undefined, url);
    const b = await Relay.join(a.room, url);
    await settle();
    expect(b.key).toMatch(/^[BCDFGHJKLMNPRSTVWXZ]{16}$/);
    const left: number[] = [];
    const joined: number[] = [];
    a.onLeave = s => left.push(s);
    a.onJoin = s => joined.push(s);
    b.close();
    await settle();
    const b2 = await Relay.join(a.room, url, b.key);
    await settle();
    expect(b2.slot).toBe(b.slot);                // the same seat, not whichever was free
    expect(b2.key).toBe(b.key);
    expect(left).toEqual([1]);                   // a heard the going...
    expect(joined).toEqual([1]);                 // ...and the coming back
    a.close();
    b2.close();
  });

  it('remakes a dropped connection itself, in the same seat of the same room', async () => {
    const a = await Relay.join(undefined, url);
    const b = await Relay.join(a.room, url);
    await settle();
    a.reconnectDelay = () => 30;                 // no real backoff in a test
    let reconnected = 0;
    a.onReconnect = () => reconnected++;
    const left: number[] = [];
    const joined: number[] = [];
    b.onLeave = s => left.push(s);
    b.onJoin = s => joined.push(s);

    // The socket goes without close() being called: what a tunnel looks like.
    (a as unknown as { ws: WebSocket }).ws.close();
    const until = Date.now() + 5000;
    while (!a.open && Date.now() < until) await new Promise(r => setTimeout(r, 25));

    expect(a.open).toBe(true);
    expect(reconnected).toBe(1);
    expect(a.slot).toBe(0);                      // still the same car
    expect(left).toEqual([0]);                   // b heard a go...
    expect(joined).toEqual([0]);                 // ...and heard it come back
    expect(b.peers).toEqual([0]);

    const got: number[][] = [];
    b.onPacket = (from, data) => got.push([from, ...data]);
    a.send(encodeInput(0, 41, [0x20]));
    await settle();
    expect(got).toEqual([[0, 1, 0, 41, 0, 0, 0, 1, 0x20]]);
    a.close();
    b.close();
  });

  it('opens the room again for the key while the grace lasts, and not for a stranger', async () => {
    const a = await Relay.join(undefined, url);
    await settle();
    const room = a.room;
    a.close();                                   // the only member: a placeholder holds the seat for now
    await settle();
    const back = await Relay.join(room, url, a.key);
    expect(back.slot).toBe(0);                   // the key still opens the room
    back.close();
    await expect(Relay.join('ZZZZ', url, a.key)).rejects.toThrow('no such room');
  });

  it('gives up out loud when the relay itself is gone', async () => {
    const own = start(0);
    const p = await new Promise<number>(res => {
      own.on('listening', () => res((own.address() as { port: number }).port));
    });
    const a = await Relay.join(undefined, `ws://127.0.0.1:${p}/api/relay`);
    a.reconnectDelay = () => 20;
    a.maxRetries = 3;
    const errors: string[] = [];
    a.onError = why => errors.push(why);
    own.close();                                 // nothing to reconnect to any more
    (a as unknown as { ws: WebSocket }).ws.close();
    const until = Date.now() + 5000;
    while (errors.length === 0 && Date.now() < until) await new Promise(r => setTimeout(r, 25));
    expect(errors).toEqual(['the connection to the relay was lost and could not be remade.']);
    expect(a.open).toBe(false);
  });
});
