import { test } from 'node:test';
import assert from 'node:assert/strict';
import './harness';
import { createPortPair, flush, FakePort } from './harness';
import { EngineSync } from '../src/engine/EngineSync';
import { ModularProcessor } from '../src/worklet/ModularProcessor';
import type { Graph, ModuleDefinition, ModuleKind } from '../src/types/graph';
import type { LoadGraphMessage, SetParamMessage, WorkletMessage } from '../src/types/messages';

const mod = (id: string, kind: string, params?: ModuleDefinition['params']) =>
  ({ id, kind: kind as ModuleKind, params }) as ModuleDefinition;

const basicGraph = (freq = 2): Graph => ({
  modules: [mod('vco', 'VCO', { freq, vcoShape: 'sine' }), mod('out', 'OUTPUT', { drive: 0.2 })],
  connections: [{ from: { id: 'vco', port: 'out' }, to: { id: 'out', port: 'in' } }],
});

const brokenGraph = (): Graph => ({
  modules: [mod('vco', 'VCO'), mod('out', 'OUTPUT')],
  connections: [{ from: { id: 'ghost', port: 'out' }, to: { id: 'out', port: 'in' } }],
});

/**
 * Wires a real ModularProcessor to an EngineSync over paired fake ports,
 * delivering messages asynchronously in FIFO order just like the browser.
 */
function createHarness() {
  const { main, worklet } = createPortPair();
  const processor = new ModularProcessor();

  // The processor creates its own FakePort in its constructor; move its
  // message handling onto the shared worklet end of the pair.
  processor.port.onmessage = null;
  worklet.onmessage = (e: MessageEvent) => processor.handleMsg(e.data as WorkletMessage);
  // Processor replies go out its own port; bridge them back to the main end.
  processor.port.onmessage = (e: MessageEvent) =>
    main.onmessage?.({ data: e.data } as MessageEvent);

  const statuses: { message: string; type: string }[] = [];
  const scopeFrames: unknown[] = [];
  const latest = { current: basicGraph() };
  const sync = new EngineSync(main, {
    onStatus: (s) => statuses.push(s),
    onScopeData: (frames) => scopeFrames.push(frames),
  });
  main.onmessage = (e: MessageEvent) =>
    sync.handleMessage(e.data as WorkletMessage, latest.current);

  return { main, worklet, processor, sync, statuses, scopeFrames, latest };
}

/** Wraps a port to record every posted message. */
function record(port: FakePort): { messages: unknown[]; port: FakePort } {
  const messages: unknown[] = [];
  const original = port.postMessage.bind(port);
  port.postMessage = (message: unknown) => {
    messages.push(message);
    original(message);
  };
  return { messages, port };
}

test('first sync posts a full load carrying the current canvas snapshot', async () => {
  const h = createHarness();
  const rec = record(h.main);
  h.latest.current = basicGraph(3);

  h.sync.sync(h.latest.current);
  await flush();

  const loads = rec.messages.filter((m) => (m as { type: string }).type === 'loadGraph');
  assert.equal(loads.length, 1);
  const load = loads[0] as LoadGraphMessage;
  assert.equal(load.revision, 1);
  assert.equal((load.graph.modules[0].params as { freq: number }).freq, 3);

  assert.equal(h.statuses.at(-1)?.type, 'success');
});

test('parameter edits are diffed into setParam messages, not reloads', async () => {
  const h = createHarness();
  const rec = record(h.main);
  h.sync.sync(basicGraph(2));
  await flush();

  rec.messages.length = 0;
  const tweaked = basicGraph(4);
  h.latest.current = tweaked;
  h.sync.sync(tweaked);
  await flush();

  assert.equal(
    rec.messages.some((m) => (m as { type: string }).type === 'loadGraph'),
    false,
    'parameter change must not reload the graph'
  );
  const paramMsg = rec.messages.find(
    (m) => (m as { type: string }).type === 'setParam'
  ) as SetParamMessage;
  assert.ok(paramMsg);
  assert.equal(paramMsg.id, 'vco');
  assert.equal(paramMsg.param, 'freq');
  assert.equal(paramMsg.value, 4);

  const vco = (
    h.processor as unknown as { modules: Map<string, { params: Record<string, unknown> }> }
  ).modules.get('vco')!;
  assert.equal(vco.params.freq, 4);
});

test('interleaved param edit and reload: engine ends at the canvas value', async () => {
  const h = createHarness();
  const rec = record(h.main);
  h.sync.sync(basicGraph(2));
  await flush();
  rec.messages.length = 0;

  // Structural change starts a reload...
  const withExtraModule: Graph = {
    modules: [
      mod('vco', 'VCO', { freq: 2, vcoShape: 'sine' }),
      mod('lfo', 'LFO', { freq: -5, shape: 'sine' }),
      mod('out', 'OUTPUT', { drive: 0.2 }),
    ],
    connections: [{ from: { id: 'vco', port: 'out' }, to: { id: 'out', port: 'in' } }],
  };
  h.latest.current = withExtraModule;
  h.sync.sync(withExtraModule);
  const load = rec.messages.find(
    (m) => (m as { type: string }).type === 'loadGraph'
  ) as LoadGraphMessage;
  assert.equal(load.revision, 2);

  // ...and before the worklet ack is delivered, the user drags the VCO slider.
  const withExtraAndTweak: Graph = {
    ...withExtraModule,
    modules: withExtraModule.modules.map((m) =>
      m.id === 'vco' ? { ...m, params: { ...m.params, freq: 6 } } : m
    ),
  };
  h.latest.current = withExtraAndTweak;
  h.sync.sync(withExtraAndTweak);

  // While in flight, no bare setParam should escape: the edit is queued.
  const inFlightParams = rec.messages.filter((m) => (m as { type: string }).type === 'setParam');
  assert.equal(inFlightParams.length, 0);

  await flush();

  // After the ack, reconciliation must push the queued edit through.
  const paramMsgs = rec.messages.filter(
    (m) => (m as { type: string }).type === 'setParam'
  ) as SetParamMessage[];
  assert.ok(paramMsgs.some((m) => m.id === 'vco' && m.param === 'freq' && m.value === 6));

  const vco = (
    h.processor as unknown as { modules: Map<string, { params: Record<string, unknown> }> }
  ).modules.get('vco')!;
  assert.equal(vco.params.freq, 6, 'engine parameter must equal the canvas value after reload');
});

test('repeated rapid param edits while loading are reconciled once at the latest value', async () => {
  const h = createHarness();
  const rec = record(h.main);
  h.sync.sync(basicGraph(2));
  await flush();
  rec.messages.length = 0;

  const structured: Graph = {
    modules: [
      mod('vco', 'VCO', { freq: 2, vcoShape: 'sine' }),
      mod('att', 'ATTEN', { gain: 0.5 }),
      mod('out', 'OUTPUT', { drive: 0.2 }),
    ],
    connections: [
      { from: { id: 'vco', port: 'out' }, to: { id: 'att', port: 'in' } },
      { from: { id: 'att', port: 'out' }, to: { id: 'out', port: 'in' } },
    ],
  };
  h.latest.current = structured;
  h.sync.sync(structured);

  for (const freq of [3, 4, 5]) {
    const g: Graph = {
      ...structured,
      modules: structured.modules.map((m) =>
        m.id === 'vco' ? { ...m, params: { ...m.params, freq } } : m
      ),
    };
    h.latest.current = g;
    h.sync.sync(g);
  }
  await flush();

  const vco = (
    h.processor as unknown as { modules: Map<string, { params: Record<string, unknown> }> }
  ).modules.get('vco')!;
  assert.equal(vco.params.freq, 5, 'last slider value wins, no old snapshot overwrites it');
});

test('failed load reports an error and keeps the last good graph; recovery works', async () => {
  const h = createHarness();
  h.sync.sync(basicGraph(2));
  await flush();

  h.latest.current = brokenGraph();
  h.sync.sync(brokenGraph());
  await flush();

  assert.equal(h.statuses.at(-1)?.type, 'error');
  assert.match(h.statuses.at(-1)!.message, /previous patch kept playing/);

  // The worklet still runs the old graph.
  const modules = h.processor as unknown as {
    modules: Map<string, unknown>;
    sortedModules: unknown[];
  };
  assert.ok(modules.modules.has('vco'));
  assert.ok(modules.sortedModules.length > 0);

  // The user fixes the cable on the canvas (same structure as the good graph)
  // and then drags a slider: the edit must diff through to the live module.
  const rec = record(h.main);
  const fixedStructure = basicGraph(2);
  h.latest.current = fixedStructure;
  h.sync.sync(fixedStructure);
  await flush();
  rec.messages.length = 0;

  const tweaked = basicGraph(7);
  h.latest.current = tweaked;
  h.sync.sync(tweaked);
  await flush();
  const paramMsg = rec.messages.find(
    (m) => (m as { type: string }).type === 'setParam'
  ) as SetParamMessage;
  assert.ok(paramMsg, 'edits after a failed load must still reach the engine');
  assert.equal(paramMsg.value, 7);

  const vco = (
    h.processor as unknown as { modules: Map<string, { params: Record<string, unknown> }> }
  ).modules.get('vco')!;
  assert.equal(vco.params.freq, 7);

  // Then a structural fix loads cleanly and clears the error.
  const fixed: Graph = {
    modules: [
      mod('vco', 'VCO', { freq: 7, vcoShape: 'sine' }),
      mod('att', 'ATTEN', { gain: 0.9 }),
      mod('out', 'OUTPUT', { drive: 0.2 }),
    ],
    connections: [
      { from: { id: 'vco', port: 'out' }, to: { id: 'att', port: 'in' } },
      { from: { id: 'att', port: 'out' }, to: { id: 'out', port: 'in' } },
    ],
  };
  h.latest.current = fixed;
  h.sync.sync(fixed);
  await flush();
  assert.equal(h.statuses.at(-1)?.type, 'success');
});

test('stale acks from superseded loads are ignored', async () => {
  const h = createHarness();
  const rec = record(h.main);
  h.sync.sync(basicGraph(1));
  await flush();
  rec.messages.length = 0;

  // Two structural loads before any ack can be processed.
  const g2: Graph = {
    modules: [
      mod('vco', 'VCO', { freq: 1, vcoShape: 'sine' }),
      mod('a', 'ATTEN', { gain: 0.5 }),
      mod('out', 'OUTPUT', { drive: 0.2 }),
    ],
    connections: [
      { from: { id: 'vco', port: 'out' }, to: { id: 'a', port: 'in' } },
      { from: { id: 'a', port: 'out' }, to: { id: 'out', port: 'in' } },
    ],
  };
  const g3: Graph = {
    modules: [
      mod('vco', 'VCO', { freq: 1, vcoShape: 'sine' }),
      mod('a', 'ATTEN', { gain: 0.5 }),
      mod('b', 'RECTIFIER'),
      mod('out', 'OUTPUT', { drive: 0.2 }),
    ],
    connections: [
      { from: { id: 'vco', port: 'out' }, to: { id: 'a', port: 'in' } },
      { from: { id: 'a', port: 'out' }, to: { id: 'b', port: 'in' } },
      { from: { id: 'b', port: 'out' }, to: { id: 'out', port: 'in' } },
    ],
  };
  h.latest.current = g2;
  h.sync.sync(g2);
  h.latest.current = g3;
  h.sync.sync(g3);
  await flush();

  const loads = rec.messages.filter(
    (m) => (m as { type: string }).type === 'loadGraph'
  ) as LoadGraphMessage[];
  assert.deepEqual(
    loads.map((l) => l.revision),
    [2, 3]
  );
  assert.equal(h.statuses.filter((s) => s.type === 'success').length >= 1, true);

  // Final worklet state matches the newest graph.
  assert.ok(
    (h.processor as unknown as { modules: Map<string, unknown> }).modules.has('b'),
    'newest revision must be the running graph'
  );
});

test('stop/restart: a fresh controller reloads the current graph, not the old one', async () => {
  // First session.
  const first = createHarness();
  first.sync.sync(basicGraph(2));
  await flush();
  assert.ok((first.processor as unknown as { modules: Map<string, unknown> }).modules.has('vco'));

  // "Stop": hook drops its controller and node; scope data is cleared at the
  // React layer (covered by useAudioEngine). Meanwhile the canvas changes.
  const nextCanvas: Graph = {
    modules: [
      mod('lfo', 'LFO', { freq: -3, shape: 'square' }),
      mod('out2', 'OUTPUT', { drive: 0.5 }),
    ],
    connections: [{ from: { id: 'lfo', port: 'out' }, to: { id: 'out2', port: 'in' } }],
  };

  // "Start": brand new harness/controller, as the hook constructs in start().
  const second = createHarness();
  const rec = record(second.main);
  second.latest.current = nextCanvas;
  second.sync.sync(nextCanvas);
  await flush();

  const load = rec.messages.find(
    (m) => (m as { type: string }).type === 'loadGraph'
  ) as LoadGraphMessage;
  assert.equal(load.revision, 1, 'a fresh controller restarts its revision sequence');
  assert.deepEqual(
    load.graph.modules.map((m) => m.id),
    ['lfo', 'out2'],
    'restart must load the current canvas graph'
  );
  assert.ok((second.processor as unknown as { modules: Map<string, unknown> }).modules.has('lfo'));
  assert.ok(
    !(second.processor as unknown as { modules: Map<string, unknown> }).modules.has('vco'),
    'no stale module from the previous session'
  );
  assert.equal(second.statuses.at(-1)?.type, 'success');
});

test('superseded loads plus an in-flight edit still reconcile to canvas values', async () => {
  const h = createHarness();
  const rec = record(h.main);
  h.sync.sync(basicGraph(1));
  await flush();
  rec.messages.length = 0;

  // Two structural loads posted back to back, then a param edit on the canvas
  // before either ack arrives. The final engine params must equal the canvas.
  const g2: Graph = {
    modules: [
      mod('vco', 'VCO', { freq: 1, vcoShape: 'sine' }),
      mod('a', 'ATTEN', { gain: 0.5 }),
      mod('out', 'OUTPUT', { drive: 0.2 }),
    ],
    connections: [
      { from: { id: 'vco', port: 'out' }, to: { id: 'a', port: 'in' } },
      { from: { id: 'a', port: 'out' }, to: { id: 'out', port: 'in' } },
    ],
  };
  const g3: Graph = {
    modules: [
      mod('vco', 'VCO', { freq: 1, vcoShape: 'sine' }),
      mod('a', 'ATTEN', { gain: 0.5 }),
      mod('b', 'RECTIFIER'),
      mod('out', 'OUTPUT', { drive: 0.2 }),
    ],
    connections: [
      { from: { id: 'vco', port: 'out' }, to: { id: 'a', port: 'in' } },
      { from: { id: 'a', port: 'out' }, to: { id: 'b', port: 'in' } },
      { from: { id: 'b', port: 'out' }, to: { id: 'out', port: 'in' } },
    ],
  };
  h.latest.current = g2;
  h.sync.sync(g2);
  h.latest.current = g3;
  h.sync.sync(g3);

  const g3Tweaked: Graph = {
    ...g3,
    modules: g3.modules.map((m) =>
      m.id === 'vco' ? { ...m, params: { ...m.params, freq: 8 } } : m
    ),
  };
  h.latest.current = g3Tweaked;
  h.sync.sync(g3Tweaked);

  await flush();

  const vco = (
    h.processor as unknown as { modules: Map<string, { params: Record<string, unknown> }> }
  ).modules.get('vco')!;
  assert.equal(vco.params.freq, 8, 'canvas value must win over every superseded snapshot');
});

test('manual reload forces a load even when the structure is unchanged', async () => {
  const h = createHarness();
  const rec = record(h.main);
  const g = basicGraph(2);
  h.latest.current = g;
  h.sync.sync(g);
  await flush();
  rec.messages.length = 0;

  h.sync.load(g);
  await flush();

  const loads = rec.messages.filter(
    (m) => (m as { type: string }).type === 'loadGraph'
  ) as LoadGraphMessage[];
  assert.equal(loads.length, 1);
  assert.equal(loads[0].revision, 2);
});
