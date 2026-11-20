import { describe, expect, it, beforeEach } from 'vitest';
import type { Graph, ModuleDefinition, Connection } from '../../types/graph';
import { ModuleKind } from '../../types/graph';
import { ModularProcessor } from '../ModularProcessor';
import { getPort } from './workletSetup';
import type { OutboundMessage } from './workletSetup';

let processor: ModularProcessor;

beforeEach(() => {
  processor = new ModularProcessor();
});

function port(): ReturnType<typeof getPort> {
  return getPort(processor);
}

function load(version: number, graph: Graph): void {
  port().receive({ type: 'loadGraph', graph, version });
}

function setParam(version: number, id: string, param: string, value: number | string): void {
  port().receive({ type: 'setParam', id, param, value, version });
}

function outbound(): OutboundMessage[] {
  return port().outbound as OutboundMessage[];
}

function lastMessage(): OutboundMessage {
  const messages = outbound();
  if (messages.length === 0) throw new Error('no messages posted');
  return messages[messages.length - 1];
}

function moduleById(id: string) {
  return (
    processor as unknown as { modules: Map<string, { params: Record<string, unknown> }> }
  ).modules.get(id);
}

function vco(id: string, params: ModuleDefinition['params'] = { freq: 1, vcoShape: 'sine' }) {
  return { id, kind: ModuleKind.VCO, params };
}
function output(id: string, params: ModuleDefinition['params'] = { drive: 0.2 }) {
  return { id, kind: ModuleKind.OUTPUT, params };
}
function conn(from: string, to: string, fp = 'out', tp = 'in'): Connection {
  return { from: { id: from, port: fp }, to: { id: to, port: tp } };
}

function baseGraph(): Graph {
  return {
    modules: [vco('v1'), output('out1')],
    connections: [conn('v1', 'out1')],
  };
}

describe('ModularProcessor graph lifecycle', () => {
  it('commits a valid rebuild and reports graphLoaded with the version', () => {
    load(1, baseGraph());
    expect(lastMessage()).toMatchObject({ type: 'graphLoaded', version: 1 });
    expect(processor.loadedVersion).toBe(1);
    expect(processor.moduleCount).toBe(2);
  });

  it('instantiates every new module with the canvas parameters (no rebuild rollback)', () => {
    const graph = baseGraph();
    graph.modules[0].params = { freq: 3.5, vcoShape: 'square' };
    load(1, graph);

    const module = moduleById('v1');
    expect(module?.params.freq).toBe(3.5);
    expect(module?.params.vcoShape).toBe('square');
  });

  it('keeps the previous graph sounding when the new graph has an unknown module', () => {
    load(1, baseGraph());
    const before = processor.moduleCount;

    const bad: Graph = {
      modules: [
        vco('v1'),
        { id: 'ghost', kind: 'MYSTERY' as ModuleKind, params: {} },
        output('out1'),
      ],
      connections: [conn('v1', 'out1')],
    };
    load(2, bad);

    expect(lastMessage()).toMatchObject({ type: 'error', version: 2 });
    // The old graph must remain live and still be the sounding version.
    expect(processor.moduleCount).toBe(before);
    expect(processor.loadedVersion).toBe(1);
    expect(moduleById('v1')).toBeDefined();
    expect(moduleById('ghost')).toBeUndefined();
  });

  it('keeps the previous graph sounding when a connection references a missing module', () => {
    load(1, baseGraph());

    const bad: Graph = {
      modules: [vco('v1'), output('out1')],
      connections: [conn('v1', 'out1'), conn('v1', 'gone')],
    };
    load(2, bad);

    expect(lastMessage()).toMatchObject({ type: 'error', version: 2 });
    expect(processor.loadedVersion).toBe(1);
    expect(processor.moduleCount).toBe(2);
  });

  it('rejects connections to ports that do not exist instead of silently zeroing', () => {
    load(1, baseGraph());
    const bad: Graph = {
      modules: [vco('v1'), output('out1')],
      connections: [{ from: { id: 'v1', port: 'out' }, to: { id: 'out1', port: 'nope' } }],
    };
    load(2, bad);
    expect(lastMessage()).toMatchObject({ type: 'error', version: 2 });
    expect(processor.loadedVersion).toBe(1);
  });

  it('recovers with a valid graph after a rejected one', () => {
    load(1, baseGraph());
    const bad: Graph = { modules: [{ id: 'x', kind: 'BOGUS' as ModuleKind }], connections: [] };
    load(2, bad);
    expect(lastMessage().type).toBe('error');

    const next: Graph = {
      modules: [vco('v2', { freq: 2, vcoShape: 'tri' }), output('out2')],
      connections: [conn('v2', 'out2')],
    };
    load(3, next);
    expect(lastMessage()).toMatchObject({ type: 'graphLoaded', version: 3 });
    expect(processor.loadedVersion).toBe(3);
    expect(moduleById('v2')?.params.freq).toBe(2);
  });

  it('applies setParam only on the version it belongs to', () => {
    load(1, baseGraph());
    setParam(1, 'v1', 'freq', 4.25);
    expect(moduleById('v1')?.params.freq).toBe(4.25);

    // Stale: from a graph the engine never committed.
    setParam(99, 'v1', 'freq', 7);
    expect(moduleById('v1')?.params.freq).toBe(4.25);
  });

  it('drops parameter edits racing ahead of an in-flight rebuild without losing later ones', () => {
    // User drags a slider while the loadGraph for version 2 is queued but
    // not yet processed. The edit stamped with the old version must not
    // survive into the new graph via id coincidence.
    load(1, baseGraph());
    setParam(1, 'v1', 'freq', 1.5); // applied to v1
    expect(moduleById('v1')?.params.freq).toBe(1.5);

    // Rebuild arrives carrying the canvas value (2.25).
    const rebuilt: Graph = {
      modules: [vco('v1', { freq: 2.25, vcoShape: 'sine' }), output('out1')],
      connections: [conn('v1', 'out1')],
    };
    // A stale edit (still stamped version 1) is delivered first, then the load.
    setParam(1, 'v1', 'freq', 9);
    load(2, rebuilt);

    expect(lastMessage()).toMatchObject({ type: 'graphLoaded', version: 2 });
    expect(moduleById('v1')?.params.freq).toBe(2.25);

    // Post-rebuild edit on the new version lands correctly.
    setParam(2, 'v1', 'freq', 3);
    expect(moduleById('v1')?.params.freq).toBe(3);
  });

  it('never applies an edit meant for a deleted same-named module onto the rebuilt one', () => {
    load(1, {
      modules: [vco('v1', { freq: 1, vcoShape: 'sine' }), output('out1')],
      connections: [conn('v1', 'out1')],
    });

    // New graph reuses the id 'v1' for a different module instance with a
    // fresh canvas value. An in-flight edit from the old graph is stale.
    const rebuilt: Graph = {
      modules: [vco('v1', { freq: 0.5, vcoShape: 'saw' }), output('out1')],
      connections: [conn('v1', 'out1')],
    };
    setParam(1, 'v1', 'freq', 8); // stale, old graph version
    load(2, rebuilt);

    expect(moduleById('v1')?.params.freq).toBe(0.5);
    expect(moduleById('v1')?.params.vcoShape).toBe('saw');
  });

  it('silently ignores edits to modules that no longer exist', () => {
    load(1, baseGraph());
    expect(() => setParam(1, 'deleted-id', 'freq', 1)).not.toThrow();
    expect(processor.loadedVersion).toBe(1);
  });

  it('accepts feedback loops (cycle modules are still scheduled and sounding)', () => {
    const graph: Graph = {
      modules: [
        vco('v1'),
        { id: 'a1', kind: ModuleKind.ATTEN, params: { gain: -0.5, offset: 0 } },
        output('out1'),
      ],
      connections: [conn('v1', 'a1'), conn('a1', 'v1', 'out', 'fm'), conn('v1', 'out1')],
    };
    load(1, graph);
    expect(lastMessage()).toMatchObject({ type: 'graphLoaded', version: 1 });
    expect(processor.moduleCount).toBe(3);
  });

  it('keeps producing output from the old graph after a rejected rebuild', () => {
    load(1, baseGraph());
    const out: Float32Array[][] = [[new Float32Array(128), new Float32Array(128)]];
    processor.process([], out, {});
    const firstBlock = Array.from(out[0][0]);
    expect(firstBlock.some((v) => v !== 0)).toBe(true);

    load(2, { modules: [{ id: 'x', kind: 'BOGUS' as ModuleKind }], connections: [] });

    const out2: Float32Array[][] = [[new Float32Array(128), new Float32Array(128)]];
    processor.process([], out2, {});
    // Still sounding, not the silence of an empty module table.
    expect(Array.from(out2[0][0]).some((v) => v !== 0)).toBe(true);
  });
});
