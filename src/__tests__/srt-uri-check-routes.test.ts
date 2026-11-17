/**
 * Route tests for the save-time SRT address check
 * (`checkSrtUriAsGStreamerReads`, wired into the write paths via
 * `srtUrl(..., { newValue: true })`).
 *
 * Covered here, through POST/PATCH of sources and outputs:
 * - a compliant address saves;
 * - a non-compliant one (wrong-case key, duplicate key, key without a value,
 *   raw `#`, malformed escape, `%00`, bad `mode`, passphrase too short/long,
 *   bad `pbkeylen`) is refused with a 4xx and a message that says what to
 *   change — never a 500, and never echoing the passphrase;
 * - a document stored BEFORE this check existed is not re-validated: it can
 *   still be renamed, and a production using it still activates.
 *
 * CouchDB, Strom client, flow-generator and the WS controller are mocked.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { OutputDoc, ProductionDoc, SourceDoc } from '../db/types.js';

const mockSourcesGet = vi.fn();
const mockSourcesInsert = vi.fn();
const mockSourcesFind = vi.fn();
const mockSourcesDestroy = vi.fn();
const mockOutputsGet = vi.fn();
const mockOutputsInsert = vi.fn();
const mockOutputsFind = vi.fn();
const mockOutputsDestroy = vi.fn();
const mockMainGet = vi.fn();
const mockMainInsert = vi.fn();
const mockMainFind = vi.fn();
const mockMainFindTrusted = vi.fn();
const mockCapabilities = vi.fn();
const mockActivateStromFlow = vi.fn();
const mockStromFlowsGet = vi.fn();
const mockBroadcast = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockMainGet, insert: mockMainInsert, find: mockMainFind, findTrusted: mockMainFindTrusted }),
  getSourcesDb: () => ({ get: mockSourcesGet, insert: mockSourcesInsert, find: mockSourcesFind, destroy: mockSourcesDestroy }),
  getOutputsDb: () => ({ get: mockOutputsGet, insert: mockOutputsInsert, find: mockOutputsFind, destroy: mockOutputsDestroy }),
  connectDb: vi.fn().mockResolvedValue(undefined),
  isDbReady: vi.fn().mockResolvedValue(true),
  isDbConnected: vi.fn().mockReturnValue(true),
}));

vi.mock('../ws/controller.js', () => ({
  default: async () => {},
  clearAudioState: vi.fn(),
  clearPipState: vi.fn(),
  clearFxState: vi.fn(),
  clearClipStateForProduction: vi.fn(),
  reinitConnectedControllers: vi.fn(),
}));

vi.mock('../lib/flow-generator.js', () => ({
  activateStromFlow: (...args: unknown[]) => mockActivateStromFlow(...args),
  deactivateStromFlow: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../lib/strom.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/strom.js')>();
  class MockStromClient {
    system = { version: vi.fn(), iceServers: vi.fn(), capabilities: mockCapabilities };
    flows = { get: mockStromFlowsGet, start: vi.fn(), stop: vi.fn(), delete: vi.fn() };
    mixer = { multiviewEndpoint: vi.fn() };
    ports = { pool: vi.fn(), reservations: { create: vi.fn(), renew: vi.fn(), release: vi.fn(), list: vi.fn(), get: vi.fn(), assign: vi.fn(), unassign: vi.fn() } };
  }
  return { ...actual, StromClient: MockStromClient };
});

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue('test-token'),
}));

vi.mock('../services/tally.service.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/tally.service.js')>();
  return { ...actual, broadcast: (...args: unknown[]) => mockBroadcast(...args) };
});

const KEY_B64 = Buffer.from(Array.from({ length: 32 }, (_, i) => i + 1)).toString('base64');
const CAPS = {
  network: { inbound_reachable: true, ports: null },
  protocols: { srt: { modes: { listener: true, caller: true, rendezvous: true }, relays: [] }, webrtc: { ice_servers: false, ice_transport_policy: 'all' } },
};
const originalEnv = { ...process.env };

let app: FastifyInstance;
let resetStromCapabilitiesCache: () => void;
let resetKeyCache: () => void;
let _resetPortReservationState: typeof import('../services/port-reservation.js')._resetPortReservationState;

beforeAll(async () => {
  process.env['SRT_PASSPHRASE_KEY'] = KEY_B64;
  delete process.env['NODE_ENV'];
  ({ resetKeyCache } = await import('../lib/srt-passphrase-crypto.js'));
  resetKeyCache();
  ({ resetStromCapabilitiesCache } = await import('../services/strom-capabilities.js'));
  ({ _resetPortReservationState } = await import('../services/port-reservation.js'));
  const { buildServer } = await import('../server.js');
  app = await buildServer();
});

afterAll(async () => {
  await app.close();
  process.env = { ...originalEnv };
  resetKeyCache();
});

beforeEach(() => {
  resetStromCapabilitiesCache();
  // Pending reservation: a listener-port address would be refused with 503, so
  // a 201 for a caller address proves the check, not the port logic, decided.
  _resetPortReservationState({ status: 'pending' });
  mockCapabilities.mockReset();
  mockCapabilities.mockResolvedValue(CAPS);
  for (const m of [
    mockSourcesGet, mockSourcesInsert, mockSourcesFind, mockSourcesDestroy,
    mockOutputsGet, mockOutputsInsert, mockOutputsFind, mockOutputsDestroy,
    mockMainGet, mockMainInsert, mockMainFind, mockMainFindTrusted,
    mockActivateStromFlow, mockStromFlowsGet, mockBroadcast,
  ]) m.mockReset();
  mockSourcesInsert.mockResolvedValue({ ok: true, rev: '1-new' });
  mockOutputsInsert.mockResolvedValue({ ok: true, rev: '1-new' });
  mockMainInsert.mockResolvedValue({ ok: true, rev: '2-new' });
  mockSourcesFind.mockResolvedValue({ docs: [] });
  mockOutputsFind.mockResolvedValue({ docs: [] });
  mockMainFind.mockResolvedValue({ docs: [] });
  mockMainFindTrusted.mockResolvedValue({ docs: [] });
});

function source(address: string, streamType: SourceDoc['streamType'] = 'srt'): SourceDoc {
  return {
    _id: 'src-1', _rev: '1-abc', type: 'source', name: 'Cam', address, streamType, status: 'inactive',
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

function output(url: string): OutputDoc {
  return {
    _id: 'output-1', _rev: '1-abc', type: 'output', name: 'Program', outputType: 'mpegtssrt', url,
    createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  };
}

const postSource = (address: string) =>
  app.inject({ method: 'POST', url: '/api/v1/sources', payload: { name: 'Cam', streamType: 'srt', address } });
const postOutput = (url: string) =>
  app.inject({ method: 'POST', url: '/api/v1/outputs', payload: { name: 'Program', outputType: 'mpegtssrt', url } });
const patchSource = (payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: '/api/v1/sources/src-1', payload });
const patchOutput = (payload: Record<string, unknown>) =>
  app.inject({ method: 'PATCH', url: '/api/v1/outputs/output-1', payload });

describe('a compliant address saves through the write path', () => {
  it('POST source: 201, passphrase encrypted at rest, masked in the response', async () => {
    const res = await postSource('srt://cdn.example.com:9000?mode=caller&latency=200&passphrase=correct-horse-1&pbkeylen=32');
    expect(res.statusCode).toBe(201);
    const stored = mockSourcesInsert.mock.calls[0]![0] as SourceDoc;
    expect(stored.address).toMatch(/passphrase=encv1:/);
    expect(stored.address).not.toContain('correct-horse-1');
    expect(res.json().address).toBe('srt://cdn.example.com:9000?mode=caller&latency=200&passphrase=***&pbkeylen=32');
    expect(res.body).not.toContain('correct-horse-1');
  });

  it('POST source: an empty passphrase (no encryption) and an empty pbkeylen are fine', async () => {
    const res = await postSource('srt://cdn.example.com:9000?mode=caller&passphrase=&pbkeylen=');
    expect(res.statusCode).toBe(201);
  });

  it('POST output: 201 for a caller and a listener address', async () => {
    const caller = await postOutput('srt://cdn.example.com:9010?mode=caller&passphrase=correct-horse-2');
    expect(caller.statusCode).toBe(201);
    expect(caller.body).not.toContain('correct-horse-2');
    _resetPortReservationState({ status: 'disabled' });
    const listener = await postOutput('srt://:47110?mode=listener');
    expect(listener.statusCode).toBe(201);
    expect(listener.json().connect).toMatchObject({ port: 47110 });
  });

  it('PATCH source and output with a new compliant address: 200', async () => {
    mockSourcesGet.mockResolvedValue(source('srt://cdn.example.com:9000'));
    mockOutputsGet.mockResolvedValue(output('srt://cdn.example.com:9010'));
    const src = await patchSource({ address: 'srt://cdn.example.com:9000?mode=caller&latency=300' });
    expect(src.statusCode).toBe(200);
    expect((mockSourcesInsert.mock.calls[0]![0] as SourceDoc).address).toBe('srt://cdn.example.com:9000?mode=caller&latency=300');
    const out = await patchOutput({ url: 'srt://cdn.example.com:9010?mode=caller&pbkeylen=16' });
    expect(out.statusCode).toBe(200);
    expect((mockOutputsInsert.mock.calls[0]![0] as OutputDoc).url).toBe('srt://cdn.example.com:9010?mode=caller&pbkeylen=16');
  });
});

describe('a non-compliant address is refused with 4xx and an actionable message', () => {
  // Each address is refused by checkSrtUriAsGStreamerReads with a message that
  // names what to change. All go through the real write path (POST source).
  const BAD: Array<[string, RegExp]> = [
    ['srt://cdn.example.com:9000?Mode=caller', /'Mode' is not read by GStreamer: use 'mode'/],
    ['srt://cdn.example.com:9000?PassPhrase=abcdefghij', /use 'passphrase'/],
    ['srt://cdn.example.com:9000?mode=caller&mode=listener', /'mode' is given more than once/],
    ['srt://cdn.example.com:9000?latency', /'latency' has no value, which crashes GStreamer/],
    ['srt://cdn.example.com:9000?streamid=#!::r=abc', /'#' ends the SRT address for GStreamer.*write it as %23/],
    ['srt://cdn.example.com:9000?streamid=abc%2g', /'streamid' has a malformed %-escape/],
    ['srt://cdn.example.com:9000?streamid=abc%00def', /'streamid' has a malformed %-escape or %00/],
    ['srt://cdn.example.com:9000?mode=push', /mode 'push' is not one of caller, listener, rendezvous/],
    ['srt://cdn.example.com:9000?mode=Caller', /mode 'Caller' behaves differently.*use 'caller'/],
    ['srt://cdn.example.com:9000?passphrase=short', /passphrase must be 10–80 bytes \(got 5\)/],
    [`srt://cdn.example.com:9000?passphrase=${'p'.repeat(81)}`, /got 81/],
    ['srt://cdn.example.com:9000?pbkeylen=20', /pbkeylen '20' is not one of 0, 16, 24, 32/],
  ];

  it.each(BAD)('POST source %s → 400', async (address, msg) => {
    const res = await postSource(address);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(msg);
    expect(mockSourcesInsert).not.toHaveBeenCalled();
  });

  it.each(BAD)('POST output %s → 400', async (url, msg) => {
    const res = await postOutput(url);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(msg);
    expect(mockOutputsInsert).not.toHaveBeenCalled();
  });

  it.each(BAD)('PATCH source %s → 400', async (address, msg) => {
    mockSourcesGet.mockResolvedValue(source('srt://cdn.example.com:9000?mode=caller'));
    const res = await patchSource({ address });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(msg);
    expect(mockSourcesInsert).not.toHaveBeenCalled();
  });

  it.each(BAD)('PATCH output %s → 400', async (url, msg) => {
    mockOutputsGet.mockResolvedValue(output('srt://cdn.example.com:9010?mode=caller'));
    const res = await patchOutput({ url });
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatch(msg);
    expect(mockOutputsInsert).not.toHaveBeenCalled();
  });

  it('the refusal never echoes the passphrase value, on any route', async () => {
    const secret = 's3cr3t'; // 6 bytes: too short, so every attempt is refused
    mockSourcesGet.mockResolvedValue(source('srt://cdn.example.com:9000'));
    mockOutputsGet.mockResolvedValue(output('srt://cdn.example.com:9010'));
    const attempts = [
      // Too short: the message may only say so, not quote the value.
      await postSource(`srt://cdn.example.com:9000?passphrase=${secret}`),
      await postOutput(`srt://cdn.example.com:9010?passphrase=${secret}`),
      await patchSource({ address: `srt://cdn.example.com:9000?passphrase=${secret}` }),
      await patchOutput({ url: `srt://cdn.example.com:9010?passphrase=${secret}` }),
      // Wrong-case key: the message names the KEY (allowed) but not the value.
      await postSource(`srt://cdn.example.com:9000?PassPhrase=${secret}`),
      await postOutput(`srt://cdn.example.com:9010?PassPhrase=${secret}`),
    ];
    for (const res of attempts) {
      expect(res.statusCode).toBe(400);
      expect(res.body).not.toContain(secret);
    }
  });
});

describe('a document stored before this check is not re-validated', () => {
  // `Mode=Caller` passes the older, lenient rules (so it could be stored
  // before this change) but not the GStreamer-exact ones.
  const LEGACY = 'srt://cdn.example.com:9000?Mode=Caller';

  it('a legacy source can still be renamed, keeping its address as stored', async () => {
    mockSourcesGet.mockResolvedValue(source(LEGACY));
    const res = await patchSource({ name: 'Renamed' });
    expect(res.statusCode).toBe(200);
    const stored = mockSourcesInsert.mock.calls[0]![0] as SourceDoc;
    expect(stored.name).toBe('Renamed');
    expect(stored.address).toBe(LEGACY);
  });

  it('a legacy output can still be renamed, keeping its url as stored', async () => {
    mockOutputsGet.mockResolvedValue(output(LEGACY));
    const res = await patchOutput({ name: 'Renamed' });
    expect(res.statusCode).toBe(200);
    const stored = mockOutputsInsert.mock.calls[0]![0] as OutputDoc;
    expect(stored.name).toBe('Renamed');
    expect(stored.url).toBe(LEGACY);
  });

  it('a production whose source holds a legacy address still activates', async () => {
    const production: ProductionDoc = {
      _id: 'prod-legacy', _rev: '1-abc', type: 'production', name: 'Legacy Show', status: 'inactive',
      sources: [{ sourceId: 'src-1', mixerInput: 'video_in_1' }],
      pipeline: { stromConfig: null, status: 'stopped' },
      graphics: [], macros: [], tally: { pgm: null, pvw: null },
      createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
    } as ProductionDoc;
    mockMainGet.mockResolvedValue(production);
    mockSourcesGet.mockResolvedValue(source(LEGACY));
    mockActivateStromFlow.mockResolvedValue({
      flowId: 'flow-legacy',
      mixerBlockId: '',
      audioMixerBlockId: undefined,
      loudnessMainBlockId: undefined,
      recorderBlockId: undefined,
      whepOutputEntries: [],
      pgmWhepEndpointId: undefined,
      warnings: [],
      sourceOffsetBlockIds: {},
      sourceAudioOffsetBlockIds: {},
      clipPlayerBlockIds: {},
      returnBuses: [],
      returnWhepEntries: [],
      previewWhepEntries: [],
      mixerInputMap: {},
    });
    mockStromFlowsGet.mockResolvedValue({ flow: { id: 'flow-legacy', state: 'idle' } });

    const res = await app.inject({ method: 'POST', url: '/api/v1/productions/prod-legacy/activate' });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe('activating');
    // The activation flow runs without re-validating the stored address.
    await vi.waitFor(() => expect(mockActivateStromFlow).toHaveBeenCalled());
  });
});
