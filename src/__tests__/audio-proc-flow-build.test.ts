/**
 * Audio processing placement under multi-digit / gapped pad numbering
 * (issues #527 + #487): channels are numbered by the NUMERIC `video_in_N` pad
 * order — with pads like video_in_10 (or gaps in the numbering) this differs
 * from the old lexical sort ("video_in_10" < "video_in_2"). Persisted
 * processing state is keyed `ch{N}`; on (re)activation the flow generator must
 * seed each stored `ch{N}` stage onto the SAME channel the numbering assigns
 * to that pad, so a setting follows its source and never lands on a neighbour.
 *
 * Generates a real flow through a throwaway Strom, like
 * `audio-channel-numbering.test.ts`.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

const SOURCES: Record<string, Record<string, unknown>> = {
  'cam-srt': { _id: 'cam-srt', name: 'Camera SRT', streamType: 'srt', address: 'srt://10.0.0.1:9000?mode=caller' },
};

const mockProductionGet = vi.fn();

vi.mock('../db/index.js', () => ({
  getDb: () => ({ get: mockProductionGet, insert: vi.fn().mockResolvedValue({ ok: true }) }),
  getSourcesDb: () => ({
    get: (id: string) =>
      SOURCES[id] ? Promise.resolve({ ...SOURCES[id] }) : Promise.reject(Object.assign(new Error('not found'), { statusCode: 404 })),
  }),
  getGraphicsDb: () => ({ get: vi.fn().mockRejectedValue(new Error('not found')) }),
}));

vi.mock('../lib/strom-token.js', () => ({
  getStromToken: vi.fn().mockResolvedValue(undefined),
}));

const FLOW_ID = 'flow-proc-placement';
let createdFlow: Record<string, unknown> | null = null;

const stromServer: Server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (c: Buffer) => chunks.push(c));
  req.on('end', () => {
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : undefined;
    res.writeHead(200, { 'content-type': 'application/json' });
    if (req.method === 'POST' && req.url === '/api/flows') {
      createdFlow = { ...body, id: FLOW_ID };
      res.end(JSON.stringify({ flow: createdFlow }));
    } else if (req.method === 'GET' && req.url === `/api/flows/${FLOW_ID}`) {
      res.end(JSON.stringify({ flow: createdFlow }));
    } else {
      res.end(JSON.stringify({ success: true }));
    }
  });
});

await new Promise<void>((resolve) => stromServer.listen(0, '127.0.0.1', () => resolve()));
const STROM_URL = `http://127.0.0.1:${(stromServer.address() as AddressInfo).port}`;
process.env['STROM_URL'] = STROM_URL;

afterAll(() => stromServer.close());

const { activateStromFlow } = await import('../lib/flow-generator.js');
const { StromClient } = await import('../lib/strom.js');

const PROD = 'prod-proc-placement';

beforeEach(() => {
  createdFlow = null;
  mockProductionGet.mockReset();
});

describe('audio processing placement with multi-digit pads (#527 + #487)', () => {
  it('seeds persisted ch{N} processing onto the channel the NUMERIC pad order assigns', async () => {
    // Pads 1, 2, 10 — a multi-digit pad AND a gap. Numeric order gives
    // video_in_1→ch1, video_in_2→ch2, video_in_10→ch3; the old lexical sort
    // would have put video_in_10 on ch2 and video_in_2 on ch3.
    const production = {
      _id: PROD,
      _rev: '1-abc',
      type: 'production',
      name: 'Proc Placement',
      status: 'active',
      sources: [
        { sourceId: '__test1__', mixerInput: 'video_in_1' },
        { sourceId: '__test2__', mixerInput: 'video_in_2' },
        { sourceId: 'cam-srt', mixerInput: 'video_in_10' },
      ],
      graphicAssignments: [],
      values: {},
      // The operator's settings for the camera on video_in_10 — stored under
      // ch3, its numeric-order channel. Includes a construction-time key
      // (hpf on/off) that only the flow BUILD may seed.
      audioProcessing: {
        ch3: { gain: { gain: 6 }, hpf: { enabled: true, freq: 150 } },
      },
      pipeline: { stromConfig: null, status: 'running' },
      graphics: [],
      macros: [],
      tally: { pgm: null, pvw: null },
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
    mockProductionGet.mockResolvedValue(production);

    const result = await activateStromFlow(production as never, new StromClient({ baseUrl: STROM_URL }));
    const audioMixerId = result.audioMixerBlockId!;
    const blocks = createdFlow!['blocks'] as Array<Record<string, unknown>>;
    const audioMixer = blocks.find((b) => b['id'] === audioMixerId)!;
    const props = audioMixer['properties'] as Record<string, unknown>;

    // The camera's processing lands on ch3 — the channel numeric pad order
    // assigns to video_in_10 — live AND construction-time keys alike.
    expect(props['ch3_gain']).toBe(6);
    expect(props['ch3_hpf_enabled']).toBe(true);
    expect(props['ch3_hpf_freq']).toBe(150);
    // … and NOT on ch2, where the old lexical ordering would have put pad 10.
    expect(props['ch2_gain']).toBeUndefined();
    expect(props['ch2_hpf_enabled']).toBeUndefined();

    // Sanity: ch3 really is video_in_10's channel in the generated wiring.
    const links = createdFlow!['links'] as Array<{ from: string; to: string }>;
    const padOfCh3 = links.find((l) => l.to === `${audioMixerId}:input_3`);
    expect(padOfCh3?.from).toMatch(/^b-audio-offset-10-/);
  });
});
