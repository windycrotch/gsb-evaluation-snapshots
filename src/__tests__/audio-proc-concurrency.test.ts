/**
 * Audio processing concurrency (issue #527 follow-up): two sets for the same
 * channel that interleave — including a second set arriving while the previous
 * Strom call is still in flight — must reach Strom and the database IN ORDER,
 * so the final persisted state and the connect replay reflect the LAST
 * successfully applied value, never a stale overwrite. A set whose Strom write
 * fails must not be persisted at all. Covers both the WS (AUDIO_PROC_SET) and
 * REST (PATCH .../processing) paths, which share the serialized apply pipeline
 * (services/audio-proc-apply.ts).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import Fastify from 'fastify';

// In-memory production doc store shared by the WS handler and the REST route.
let storedDoc: Record<string, unknown>;
const mockInsert = vi.fn().mockImplementation(async (doc: Record<string, unknown>) => {
  storedDoc = { ...doc };
  return { ok: true };
});

// Controllable Strom: every block-properties PATCH is recorded; the test
// decides when (and whether) each one resolves.
const patchCalls: Array<{ flowId: string; blockId: string; properties: Record<string, unknown> }> = [];
let patchImpl: (properties: Record<string, unknown>) => Promise<unknown>;

vi.mock('../db/index.js', () => ({
  getDb: () => ({
    get: vi.fn(async () => ({ ...storedDoc })),
    insert: mockInsert,
    find: vi.fn().mockResolvedValue({ docs: [] }),
  }),
  getSourcesDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')), find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getGuestSessionsDb: () => ({ find: vi.fn().mockResolvedValue({ docs: [] }) }),
  getGuestInvitesDb: () => ({ find: vi.fn().mockResolvedValue({ docs: [] }) }),
}));

vi.mock('../routes/productions.js', () => ({
  updateProductionDoc: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class StromClient {
    flows = {
      get: vi.fn().mockResolvedValue({
        flow: { id: FLOW, blocks: [{ id: AUDIO_BLOCK, block_definition_id: 'builtin.mixer', properties: { num_channels: 2 } }] },
      }),
      updateBlockProperties: vi.fn(async (flowId: string, blockId: string, body: { properties: Record<string, unknown> }) => {
        patchCalls.push({ flowId, blockId, properties: body.properties });
        return patchImpl(body.properties);
      }),
    };
  }
  return { ...actual, StromClient };
});

vi.mock('../services/tally.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tally.service.js')>();
  return { ...actual, broadcast: vi.fn() };
});

const { handleMessage } = await import('../ws/controller.js');
const { default: audioRoutes } = await import('../routes/audio.js');
const { allStoredStages } = await import('../lib/audio-processing.js');

const PROD = 'prod-proc-race';
const FLOW = 'flow-proc-race';
const AUDIO_BLOCK = 'audio-block-race';

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'Proc Race',
    status: 'active',
    stromFlowId: FLOW,
    sources: [],
    values: {},
    pipeline: { stromConfig: null, status: 'running' },
    graphics: [],
    macros: [],
    tally: { pgm: null, pvw: null },
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function makeWs() {
  const sent: Array<Record<string, unknown>> = [];
  const ws = { send: (data: string) => { sent.push(JSON.parse(data)); } } as unknown as import('@fastify/websocket').WebSocket;
  return { ws, sent };
}

function deferred<T = unknown>() {
  let resolve!: (value: T) => void;
  let reject!: (err: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function storedAudioProcessing(): Record<string, unknown> | undefined {
  return storedDoc['audioProcessing'] as Record<string, unknown> | undefined;
}

beforeEach(() => {
  storedDoc = makeDoc();
  patchCalls.length = 0;
  patchImpl = () => Promise.resolve({});
  mockInsert.mockClear();
});

describe('audio processing concurrency — interleaved sets on one channel', () => {
  it('a second set arriving while the first Strom call is in flight still lands LAST', async () => {
    const { ws } = makeWs();
    const ctx = { audioBlockId: AUDIO_BLOCK };
    // Hold the first Strom PATCH open; the second set arrives mid-flight.
    const gate = deferred();
    const first = patchImpl;
    let calls = 0;
    patchImpl = () => (++calls === 1 ? gate.promise : first({}));

    const p1 = handleMessage(PROD, ws, JSON.stringify({ type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'gain', params: { gain: 4 } }), ctx);
    await vi.waitFor(() => expect(patchCalls).toHaveLength(1));
    const p2 = handleMessage(PROD, ws, JSON.stringify({ type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'gain', params: { gain: 9 } }), ctx);
    // The second set must wait for the first Strom call — no parallel PATCH yet.
    await new Promise((r) => setTimeout(r, 50));
    expect(patchCalls).toHaveLength(1);
    gate.resolve({});
    await Promise.all([p1, p2]);

    // Strom saw the values in arrival order …
    expect(patchCalls.map((c) => c.properties)).toEqual([{ ch1_gain: 4 }, { ch1_gain: 9 }]);
    // … and the persisted store + connect replay carry only the final value.
    expect(storedAudioProcessing()).toEqual({ ch1: { gain: { gain: 9 } } });
    const replay = allStoredStages(storedAudioProcessing() as never);
    expect(replay).toHaveLength(1);
    expect(replay[0]).toMatchObject({ elementId: 'ch1', stage: 'gain', params: { gain: 9 } });
  });

  it('when the in-flight Strom call FAILS, its value is never persisted; the later successful set wins', async () => {
    const { ws, sent } = makeWs();
    const ctx = { audioBlockId: AUDIO_BLOCK };
    const gate = deferred();
    let calls = 0;
    patchImpl = () => (++calls === 1 ? gate.promise : Promise.resolve({}));

    const p1 = handleMessage(PROD, ws, JSON.stringify({ type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'gain', params: { gain: 4 }, cmdId: 'first' }), ctx);
    await vi.waitFor(() => expect(patchCalls).toHaveLength(1));
    const p2 = handleMessage(PROD, ws, JSON.stringify({ type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'gain', params: { gain: 9 } }), ctx);
    gate.reject(new Error('Strom unreachable'));
    await Promise.all([p1, p2]);

    // Only the successful second value was persisted — the failed 4 must not
    // appear in the store, and the replay shows the true effective value.
    expect(storedAudioProcessing()).toEqual({ ch1: { gain: { gain: 9 } } });
    const replay = allStoredStages(storedAudioProcessing() as never);
    expect(replay.map((v) => v.params)).toEqual([{ gain: 9 }]);
    expect(sent.some((m) => m.type === 'NACK' && m.cmdId === 'first')).toBe(true);
  });

  it('a WS set and a REST PATCH interleaved both land, in order, without losing either stage', async () => {
    const { ws } = makeWs();
    const ctx = { audioBlockId: AUDIO_BLOCK };
    const gate = deferred();
    let calls = 0;
    patchImpl = () => (++calls === 1 ? gate.promise : Promise.resolve({}));

    const app = Fastify();
    await app.register(audioRoutes);
    // REST comp write goes first and stalls inside Strom …
    const restPromise = app.inject({
      method: 'PATCH',
      url: `/api/v1/productions/${PROD}/audio/ch1/processing`,
      payload: { stage: 'comp', params: { threshold: -24 } },
    });
    await vi.waitFor(() => expect(patchCalls).toHaveLength(1));
    // … then a WS gain write for the same channel arrives mid-flight.
    const wsPromise = handleMessage(PROD, ws, JSON.stringify({ type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'gain', params: { gain: 5 } }), ctx);
    gate.resolve({});
    const [restRes] = await Promise.all([restPromise, wsPromise]);
    await app.close();

    expect(restRes.statusCode).toBe(200);
    expect(restRes.json()).toMatchObject({ applied: true });
    // Both Strom writes landed in order …
    expect(patchCalls.map((c) => c.properties)).toEqual([{ ch1_comp_threshold: -24 }, { ch1_gain: 5 }]);
    // … and BOTH stages survived on the doc — the REST write's read-modify-write
    // did not erase the WS write's stage and vice versa.
    expect(storedAudioProcessing()).toEqual({
      ch1: { comp: { threshold: -24 }, gain: { gain: 5 } },
    });
  });
});
