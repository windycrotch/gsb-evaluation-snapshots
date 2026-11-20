import { describe, expect, it, beforeEach } from 'vitest';
import { EngineSync, structureKeyOf } from './engineSync';
import type { Graph } from '../types/graph';
import { ModuleKind } from '../types/graph';
import type { LoadGraphMessage, SetParamMessage } from '../types/messages';

class RecordingSink {
  readonly messages: unknown[] = [];
  postMessage(message: unknown): void {
    this.messages.push(message);
  }
}

let sink: RecordingSink;
let sync: EngineSync;

function vco(id: string, freq: number): Graph['modules'][number] {
  return { id, kind: ModuleKind.VCO, params: { freq, vcoShape: 'sine' } };
}
function output(id: string, drive = 0.2): Graph['modules'][number] {
  return { id, kind: ModuleKind.OUTPUT, params: { drive } };
}
function graph(freq: number): Graph {
  return {
    modules: [vco('v1', freq), output('out1')],
    connections: [{ from: { id: 'v1', port: 'out' }, to: { id: 'out1', port: 'in' } }],
  };
}
function graphWithDelay(freq: number, delayTime: number): Graph {
  return {
    modules: [
      vco('v1', freq),
      { id: 'd1', kind: ModuleKind.DELAY, params: { delayTime, feedback: 0.35, mix: 0.4 } },
      output('out1'),
    ],
    connections: [
      { from: { id: 'v1', port: 'out' }, to: { id: 'd1', port: 'in' } },
      { from: { id: 'd1', port: 'out' }, to: { id: 'out1', port: 'in' } },
    ],
  };
}
function loadMessages(): LoadGraphMessage[] {
  return sink.messages.filter(
    (m): m is LoadGraphMessage => (m as { type: string }).type === 'loadGraph'
  );
}
function paramMessages(): SetParamMessage[] {
  return sink.messages.filter(
    (m): m is SetParamMessage => (m as { type: string }).type === 'setParam'
  );
}

beforeEach(() => {
  sink = new RecordingSink();
  sync = new EngineSync();
  sync.attach(sink);
});

describe('EngineSync normal rebuild path', () => {
  it('posts a versioned loadGraph for the first graph and every structural change', () => {
    sync.sync(graph(1));
    expect(loadMessages()).toHaveLength(1);
    expect(loadMessages()[0].version).toBe(1);

    sync.sync(graphWithDelay(1, 0.3));
    expect(loadMessages()).toHaveLength(2);
    expect(loadMessages()[1].version).toBe(2);
  });

  it('streams parameter-only edits as setParam carrying the acknowledged version', () => {
    sync.sync(graph(1));
    sync.handleGraphLoaded(1);

    sync.sync(graph(2.5));
    const params = paramMessages();
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({
      type: 'setParam',
      id: 'v1',
      param: 'freq',
      value: 2.5,
      version: 1,
    });
  });

  it('rebuilds the baseline from the committed graph so no stale param can roll back', () => {
    sync.sync(graph(1));
    // Canvas value changes while the load is in flight.
    sync.sync(graph(4));
    expect(paramMessages()).toHaveLength(0); // nothing committed yet
    // The pending snapshot carries the freshest value...
    sync.handleGraphLoaded(1);
    const replayed = paramMessages();
    expect(replayed).toHaveLength(1);
    expect(replayed[0]).toMatchObject({ id: 'v1', value: 4, version: 1 });

    // And a subsequent identical graph produces no duplicate traffic.
    sync.sync(graph(4));
    expect(paramMessages()).toHaveLength(1);
  });

  it('embeds current canvas parameters in the rebuilt graph directly', () => {
    sync.sync(graph(3.25));
    expect(loadMessages()[0].graph.modules[0].params?.freq).toBe(3.25);
  });
});

describe('EngineSync rejected-graph path', () => {
  it('reports the failed version and keeps the acknowledged graph as the baseline', () => {
    sync.sync(graph(1));
    sync.handleGraphLoaded(1);

    sync.sync(graphWithDelay(1, 0.5)); // version 2, will be rejected by engine
    expect(loadMessages()[1].version).toBe(2);
    sync.handleGraphError(2);

    // An edit to a module shared by the still-sounding old graph goes out
    // stamped with the OLD acknowledged version.
    sync.sync(graph(1.75));
    const params = paramMessages();
    expect(params).toHaveLength(1);
    expect(params[0]).toMatchObject({ id: 'v1', value: 1.75, version: 1 });
  });

  it('does not stream setParams for modules that only existed in the failed graph', () => {
    sync.sync(graph(1));
    sync.handleGraphLoaded(1);

    sync.sync(graphWithDelay(1, 0.5)); // adds d1
    sync.handleGraphError(2);

    // Structure still differs from the sounding graph: user keeps editing.
    // Any new structural attempt must be a fresh loadGraph, never a
    // setParam aimed at the dead d1.
    sync.sync(graphWithDelay(2, 0.75));
    expect(paramMessages().some((m) => m.id === 'd1')).toBe(false);
    expect(loadMessages()).toHaveLength(3);
  });

  it('re-syncs cleanly once a corrected graph is accepted after an error', () => {
    sync.sync(graph(1));
    sync.handleGraphLoaded(1);
    sync.sync(graphWithDelay(1, 0.5));
    sync.handleGraphError(2);

    // User fixes the graph; next valid attempt acks and re-baselines.
    const fixed = graphWithDelay(1, 0.6);
    sync.sync(fixed);
    const retryVersion = loadMessages()[loadMessages().length - 1].version;
    expect(retryVersion).toBe(3);
    sync.handleGraphLoaded(retryVersion);
    expect(sync.acknowledgedVersion).toBe(3);

    sync.sync(graphWithDelay(1, 0.9));
    expect(paramMessages()).toHaveLength(1);
    expect(paramMessages()[0]).toMatchObject({ id: 'd1', param: 'delayTime', version: 3 });
  });

  it('holds edits made while a doomed load is in flight and replays them on the old version after the error', () => {
    sync.sync(graph(1));
    sync.handleGraphLoaded(1);

    // A doomed structural load (the engine will reject it, e.g. bad cable).
    sync.sync(graphWithDelay(1, 0.5)); // v2 load, engine has not answered
    // Meanwhile the user keeps tweaking the VCO, which exists in both
    // structures. Those edits must be held, never sent under a stale version.
    sync.sync(graphWithDelay(2, 0.5));
    sync.sync(graphWithDelay(2.5, 0.5));
    expect(paramMessages()).toHaveLength(0);

    sync.handleGraphError(2); // engine rejects, old graph keeps sounding
    expect(sync.acknowledgedVersion).toBe(1);

    // Back on the sounding structure: the held VCO edits now flush against
    // the live v1 module table, stamped with the acknowledged version.
    sync.sync(graph(2.5));
    const flushed = paramMessages();
    expect(flushed).toEqual([
      expect.objectContaining({ id: 'v1', param: 'freq', value: 2.5, version: 1 }),
    ]);
  });

  it('flushes same-structure held edits immediately from the error handler', () => {
    sync.sync(graph(1));
    sync.handleGraphLoaded(1);

    // Manual reload of the same structure is rejected by the engine.
    sync.reload(graph(1));
    sync.sync(graph(3)); // held while the reload is in flight
    expect(paramMessages()).toHaveLength(0);

    const flushed = sync.handleGraphError(2);
    expect(flushed).toEqual([
      expect.objectContaining({ id: 'v1', param: 'freq', value: 3, version: 1 }),
    ]);
  });

  it('handles two structural loads where only the latest gets accepted', () => {
    sync.sync(graph(1));
    sync.handleGraphLoaded(1);

    sync.sync(graphWithDelay(1, 0.2)); // v2: adds a delay module
    const richer = graphWithDelay(1, 0.3);
    richer.modules.push({ id: 'a1', kind: ModuleKind.ATTEN, params: { gain: 0.5 } }); // v3: structure changes again
    sync.sync(richer);
    expect(loadMessages().map((m) => m.version)).toEqual([1, 2, 3]);

    // The engine rejects v2 but accepts v3.
    sync.handleGraphError(2);
    expect(sync.acknowledgedVersion).toBe(1); // nothing committed yet
    sync.handleGraphLoaded(3);
    expect(sync.acknowledgedVersion).toBe(3);
  });
});

describe('EngineSync rebuild/edit interleaving', () => {
  it('queues edits made while a rebuild is in flight and replays them on ack', () => {
    sync.sync(graph(1)); // v1 load
    sync.handleGraphLoaded(1);

    sync.sync(graphWithDelay(1, 0.2)); // v2 structural load, no ack yet
    // Slider moves before the engine processes the rebuild.
    sync.sync(graphWithDelay(1, 0.45));
    sync.sync(graphWithDelay(1, 0.8));
    expect(paramMessages()).toHaveLength(0); // engine still on v1 modules

    sync.handleGraphLoaded(2);
    const replayed = paramMessages();
    expect(replayed).toEqual([
      expect.objectContaining({ id: 'd1', param: 'delayTime', value: 0.8, version: 2 }),
    ]);
  });

  it('never stamps an in-flight edit with the old version (no same-name collision)', () => {
    sync.sync(graph(1));
    sync.handleGraphLoaded(1);

    // Structure changes: v1 graph gets a new module. Any params emitted
    // before the v2 ack would carry version 1 and hit the engine guard.
    sync.sync(graphWithDelay(1, 0.2));
    sync.sync(graphWithDelay(3, 0.2));
    expect(paramMessages()).toHaveLength(0);

    sync.handleGraphLoaded(2);
    // After ack, the delayed v1 freq edit lands under version 2.
    expect(paramMessages()).toContainEqual(
      expect.objectContaining({ id: 'v1', param: 'freq', value: 3, version: 2 })
    );
  });

  it('sends nothing while detached and replays nothing from a dropped sink', () => {
    sync.detach();
    expect(sync.sync(graph(1))).toEqual([]);
    expect(sink.messages).toHaveLength(0);
  });

  it('skips params whose value did not change', () => {
    sync.sync(graph(1));
    sync.handleGraphLoaded(1);
    sync.sync(graph(1));
    expect(paramMessages()).toHaveLength(0);
  });
});

describe('EngineSync stop/restart', () => {
  it('reset() clears versions, pending loads and the parameter cache', () => {
    sync.sync(graph(1));
    sync.handleGraphLoaded(1);
    sync.sync(graph(2));
    expect(sync.acknowledgedVersion).toBe(1);
    expect(sync.pendingVersions).toEqual([]);

    sync.reset();
    expect(sync.acknowledgedVersion).toBeNull();
    expect(sync.pendingVersions).toEqual([]);
  });

  it('restarts version numbering and re-establishes sync without stale cache', () => {
    // Session 1
    sync.sync(graph(1));
    sync.handleGraphLoaded(1);
    sync.sync(graph(2));
    expect(paramMessages()[0]).toMatchObject({ value: 2, version: 1 });

    // Stop: processor destroyed, all bookkeeping dropped.
    sync.reset();
    const sink2 = new RecordingSink();
    sync.attach(sink2);

    // Session 2: same canvas graph must be re-sent as a fresh v1 load,
    // and a subsequent edit must stamp the new version, never session-1's.
    sync.sync(graph(2));
    const loads = (sink2.messages as LoadGraphMessage[]).filter((m) => m.type === 'loadGraph');
    expect(loads).toEqual([expect.objectContaining({ version: 1 })]);
    sync.handleGraphLoaded(1);
    sync.sync(graph(5));
    const params = sink2.messages.filter(
      (m): m is SetParamMessage => (m as { type: string }).type === 'setParam'
    );
    expect(params).toEqual([expect.objectContaining({ id: 'v1', value: 5, version: 1 })]);
  });

  it('does not reconcile acks that arrive after a reset', () => {
    sync.sync(graph(1));
    sync.reset();
    expect(sync.handleGraphLoaded(1)).toEqual([]);
    expect(sync.acknowledgedVersion).toBeNull();
  });
});

describe('structureKeyOf', () => {
  it('ignores parameters and positions but distinguishes modules and cables', () => {
    expect(structureKeyOf(graph(1))).toBe(structureKeyOf(graph(2)));
    expect(structureKeyOf(graph(1))).not.toBe(structureKeyOf(graphWithDelay(1, 0.2)));
  });
});
