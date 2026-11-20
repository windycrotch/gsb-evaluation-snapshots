/**
 * Issue #527 (OL-25): the controller WS `AUDIO_PROC_SET` handler — per-channel
 * gain/HPF/gate/comp/EQ and main-bus comp/EQ/limiter control.
 *
 * Asserts: range validation (reject out-of-range, nothing reaches Strom and the
 * stored state is untouched), stage/element compatibility, apply-to-Strom-FIRST
 * then persist (a Strom failure saves nothing and the replay keeps reflecting
 * the true effective value), ordered application of interleaved sets (the last
 * successfully applied value wins), the applied:true AUDIO_PROC_STATE
 * broadcast, persistence on the production doc, and cmdId ACK/NACK.
 *
 * Drives `handleMessage` directly, like `ws-audio-applied-broadcast.test.ts`.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// In-memory production doc store: the apply pipeline persists via
// getDb().get → merge → getDb().insert (read-modify-write), so the test can
// observe exactly what landed on the doc.
let storedDoc: Record<string, unknown>;
const mockInsert = vi.fn().mockImplementation(async (doc: Record<string, unknown>) => {
  storedDoc = { ...doc };
  return { ok: true };
});
const updateBlockPropertiesMock = vi.fn().mockResolvedValue({});
const broadcastMock = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({
    get: vi.fn(async () => ({ ...storedDoc })),
    insert: mockInsert,
    find: vi.fn().mockResolvedValue({ docs: [] }),
  }),
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
    flows = { updateBlockProperties: updateBlockPropertiesMock, get: vi.fn() };
  }
  return { ...actual, StromClient };
});

vi.mock('../services/tally.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tally.service.js')>();
  return { ...actual, broadcast: broadcastMock };
});

const { handleMessage } = await import('../ws/controller.js');

const PROD = 'prod-proc-1';
const FLOW = 'flow-proc-1';
const AUDIO_BLOCK = 'audio-block-proc-1';

function makeDoc(overrides: Record<string, unknown> = {}) {
  return {
    _id: PROD,
    _rev: '1-abc',
    type: 'production',
    name: 'Proc Test',
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

function broadcastsOf(type: string): Array<Record<string, unknown>> {
  return broadcastMock.mock.calls.map((c) => c[1] as Record<string, unknown>).filter((m) => m && m.type === type);
}

function storedAudioProcessing(): Record<string, unknown> | undefined {
  return storedDoc['audioProcessing'] as Record<string, unknown> | undefined;
}

async function send(ws: import('@fastify/websocket').WebSocket, ctx: { audioBlockId?: string }, msg: Record<string, unknown>) {
  // handleMessage now awaits the full apply → persist pipeline, so one await
  // is enough — there is no debounce window to sleep through anymore.
  await handleMessage(PROD, ws, JSON.stringify(msg), ctx);
}

describe('AUDIO_PROC_SET (#527)', () => {
  beforeEach(() => {
    storedDoc = makeDoc();
    mockInsert.mockClear();
    updateBlockPropertiesMock.mockReset();
    updateBlockPropertiesMock.mockResolvedValue({});
    broadcastMock.mockClear();
  });

  it('accepts ch1 comp, writes one PATCH and broadcasts applied AUDIO_PROC_STATE (acceptance #2)', async () => {
    const { ws } = makeWs();
    await send(ws, { audioBlockId: AUDIO_BLOCK }, {
      type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'comp', params: { enabled: true, threshold: -24, ratio: 4 },
    });

    expect(updateBlockPropertiesMock).toHaveBeenCalledTimes(1);
    expect(updateBlockPropertiesMock).toHaveBeenCalledWith(FLOW, AUDIO_BLOCK, {
      properties: { ch1_comp_enabled: true, ch1_comp_threshold: -24, ch1_comp_ratio: 4 },
    });

    const applied = broadcastsOf('AUDIO_PROC_STATE').filter((m) => m.applied === true);
    expect(applied).toContainEqual({
      type: 'AUDIO_PROC_STATE', elementId: 'ch1', stage: 'comp', params: { enabled: true, threshold: -24, ratio: 4 }, applied: true,
    });
  });

  it('persists the change on the production doc', async () => {
    const { ws } = makeWs();
    await send(ws, { audioBlockId: AUDIO_BLOCK }, {
      type: 'AUDIO_PROC_SET', elementId: 'main', stage: 'limiter', params: { enabled: true, threshold: -6 },
    });
    expect(mockInsert).toHaveBeenCalled();
    expect(storedAudioProcessing()).toEqual({ main: { limiter: { enabled: true, threshold: -6 } } });
  });

  it('rejects an out-of-range value and nothing reaches Strom or the doc (acceptance #4)', async () => {
    const { ws, sent } = makeWs();
    await send(ws, { audioBlockId: AUDIO_BLOCK }, {
      type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'comp', params: { ratio: 50 },
    });
    expect(updateBlockPropertiesMock).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(storedAudioProcessing()).toBeUndefined();
    expect(broadcastsOf('AUDIO_PROC_STATE')).toHaveLength(0);
    expect(sent.some((m) => m.type === 'ERROR' && /ratio/.test(String(m.error)))).toBe(true);
  });

  it('rejects a stage not valid on the element (limiter on ch1) — nothing reaches Strom or the doc', async () => {
    const { ws, sent } = makeWs();
    await send(ws, { audioBlockId: AUDIO_BLOCK }, {
      type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'limiter', params: { enabled: true, threshold: -6 },
    });
    expect(updateBlockPropertiesMock).not.toHaveBeenCalled();
    expect(mockInsert).not.toHaveBeenCalled();
    expect(storedAudioProcessing()).toBeUndefined();
    expect(sent.some((m) => m.type === 'ERROR' && /not valid/.test(String(m.error)))).toBe(true);
  });

  it('applies an interleaved burst in order — the LAST value wins on Strom and in the store', async () => {
    const { ws } = makeWs();
    const ctx = { audioBlockId: AUDIO_BLOCK };
    // Three nudges for the same element:stage, dispatched without awaiting so
    // they interleave; the per-production chain serialises them in order.
    const p1 = handleMessage(PROD, ws, JSON.stringify({ type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'eq', params: { bands: [{ band: 3, gain: 4 }] } }), ctx);
    const p2 = handleMessage(PROD, ws, JSON.stringify({ type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'eq', params: { bands: [{ band: 3, gain: 8 }] } }), ctx);
    const p3 = handleMessage(PROD, ws, JSON.stringify({ type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'eq', params: { bands: [{ band: 3, gain: 12 }] } }), ctx);
    await Promise.all([p1, p2, p3]);

    // Every value reached Strom, in arrival order — the last write is the last value.
    expect(updateBlockPropertiesMock.mock.calls.map((c) => c[2])).toEqual([
      { properties: { ch1_eq3_gain: 4 } },
      { properties: { ch1_eq3_gain: 8 } },
      { properties: { ch1_eq3_gain: 12 } },
    ]);
    // The persisted store matches the last applied value — no stale overwrite.
    expect(storedAudioProcessing()).toEqual({ ch1: { eq: { bands: [{ band: 3, gain: 12 }] } } });
  });

  it('emits ACK accepted then executed for a cmdId, and NACK on a bad value', async () => {
    // Success path: accepted + executed
    const ok = makeWs();
    await send(ok.ws, { audioBlockId: AUDIO_BLOCK }, {
      type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'gate', params: { enabled: true }, cmdId: 'c-1',
    });
    const acks = ok.sent.filter((m) => m.type === 'ACK' && m.cmdId === 'c-1').map((m) => m.phase);
    expect(acks).toEqual(['accepted', 'executed']);

    // Rejected path: accepted then NACK, no Strom write
    updateBlockPropertiesMock.mockClear();
    const bad = makeWs();
    await send(bad.ws, { audioBlockId: AUDIO_BLOCK }, {
      type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'gate', params: { threshold: 10 }, cmdId: 'c-2',
    });
    expect(bad.sent.some((m) => m.type === 'NACK' && m.cmdId === 'c-2')).toBe(true);
    expect(updateBlockPropertiesMock).not.toHaveBeenCalled();
  });

  it('HPF on/off only (construction-time) persists but writes nothing live', async () => {
    const { ws } = makeWs();
    await send(ws, { audioBlockId: AUDIO_BLOCK }, {
      type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'hpf', params: { enabled: true },
    });
    // enabled is construction-time → no live PATCH, but it is persisted.
    expect(updateBlockPropertiesMock).not.toHaveBeenCalled();
    expect(storedAudioProcessing()).toEqual({ ch1: { hpf: { enabled: true } } });
  });

  it('Strom failure: nothing is persisted, no state is broadcast, the sender is told', async () => {
    updateBlockPropertiesMock.mockRejectedValue(new Error('Strom unreachable'));
    const { ws, sent } = makeWs();
    await send(ws, { audioBlockId: AUDIO_BLOCK }, {
      type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'gain', params: { gain: 6 }, cmdId: 'c-fail',
    });

    // The unapplied value must NOT be saved …
    expect(mockInsert).not.toHaveBeenCalled();
    expect(storedAudioProcessing()).toBeUndefined();
    // … nor broadcast as if it took effect …
    expect(broadcastsOf('AUDIO_PROC_STATE')).toHaveLength(0);
    // … and the sender gets a NACK, not an executed ACK.
    expect(sent.some((m) => m.type === 'NACK' && m.cmdId === 'c-fail')).toBe(true);
    expect(sent.some((m) => m.type === 'ACK' && m.cmdId === 'c-fail' && m.phase === 'executed')).toBe(false);
  });

  it('after a Strom failure the next successful set is what the store (and replay) reflects', async () => {
    const { ws } = makeWs();
    const ctx = { audioBlockId: AUDIO_BLOCK };
    // First set fails at Strom — not persisted.
    updateBlockPropertiesMock.mockRejectedValueOnce(new Error('Strom unreachable'));
    await send(ws, ctx, { type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'gain', params: { gain: 6 } });
    expect(storedAudioProcessing()).toBeUndefined();

    // Strom recovers; the operator's next set applies and is the only value stored.
    await send(ws, ctx, { type: 'AUDIO_PROC_SET', elementId: 'ch1', stage: 'gain', params: { gain: -3 } });
    expect(storedAudioProcessing()).toEqual({ ch1: { gain: { gain: -3 } } });
    const applied = broadcastsOf('AUDIO_PROC_STATE').filter((m) => m.applied === true);
    expect(applied).toHaveLength(1);
    expect(applied[0]).toMatchObject({ elementId: 'ch1', stage: 'gain', params: { gain: -3 } });
  });

  it('interleaved sets to DIFFERENT stages of one channel both persist (no lost update)', async () => {
    const { ws } = makeWs();
    const ctx = { audioBlockId: AUDIO_BLOCK };
    // gain and hpf/freq for the same channel, dispatched together: each used to
    // merge into a stale copy of the doc and the second insert wiped the first.
    const p1 = handleMessage(PROD, ws, JSON.stringify({ type: 'AUDIO_PROC_SET', elementId: 'ch2', stage: 'gain', params: { gain: 5 } }), ctx);
    const p2 = handleMessage(PROD, ws, JSON.stringify({ type: 'AUDIO_PROC_SET', elementId: 'ch2', stage: 'hpf', params: { freq: 120 } }), ctx);
    await Promise.all([p1, p2]);

    expect(storedAudioProcessing()).toEqual({ ch2: { gain: { gain: 5 }, hpf: { freq: 120 } } });
  });
});
