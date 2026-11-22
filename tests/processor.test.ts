import { test } from 'node:test';
import assert from 'node:assert/strict';
import './harness';
import { ModularProcessor } from '../src/worklet/ModularProcessor';
import { Delay } from '../src/worklet/modules/Delay';
import { VCO } from '../src/worklet/modules/VCO';
import type { Graph, ModuleDefinition, Connection, ModuleKind } from '../src/types/graph';
import { allFinite, flush, isSilent, runBlock } from './harness';

const mod = (id: string, kind: string, params?: ModuleDefinition['params']) =>
  ({ id, kind: kind as ModuleKind, params }) as ModuleDefinition;

const conn = (from: string, fromPort: string, to: string, toPort: string): Connection => ({
  from: { id: from, port: fromPort },
  to: { id: to, port: toPort },
});

/** A minimal sounding patch: VCO -> OUTPUT. */
function basicGraph(freq = 2): Graph {
  return {
    modules: [mod('vco', 'VCO', { freq, vcoShape: 'sine' }), mod('out', 'OUTPUT', { drive: 0.2 })],
    connections: [conn('vco', 'out', 'out', 'in')],
  };
}

function replies(processor: ModularProcessor) {
  const got: unknown[] = [];
  processor.port.onmessage = (e: { data: unknown }) => {
    got.push(e.data);
  };
  return got;
}

test('loadGraph succeeds and emits graphLoaded with the revision', async () => {
  const processor = new ModularProcessor();
  const got = replies(processor);

  processor.handleMsg({ type: 'loadGraph', graph: basicGraph(), revision: 7 });
  await flush();

  assert.equal(got.length, 1);
  assert.deepEqual(got[0], { type: 'graphLoaded', success: true, revision: 7 });
});

test('a valid graph produces finite, non-silent output', () => {
  const processor = new ModularProcessor();
  processor.handleMsg({ type: 'loadGraph', graph: basicGraph(), revision: 1 });

  const { left, right } = runBlock(processor);
  assert.ok(allFinite(left), 'left output must be finite');
  assert.ok(allFinite(right), 'right output must be finite');
  assert.ok(!isSilent(left), 'the patch should be sounding');
});

test('failed load (dangling connection) keeps the previous good graph playing', async () => {
  const processor = new ModularProcessor();
  const got = replies(processor);
  processor.handleMsg({ type: 'loadGraph', graph: basicGraph(), revision: 1 });

  const before = runBlock(processor);
  assert.ok(!isSilent(before.left));

  // Reference to a module that does not exist.
  const broken: Graph = {
    modules: [mod('vco', 'VCO'), mod('out', 'OUTPUT')],
    connections: [conn('ghost', 'out', 'out', 'in')],
  };
  processor.handleMsg({ type: 'loadGraph', graph: broken, revision: 2 });
  await flush();

  const errorReply = got.find((m) => (m as { type: string }).type === 'error') as
    { type: string; message: string; revision: number } | undefined;
  assert.ok(errorReply, 'an error reply must be posted');
  assert.equal(errorReply!.revision, 2);
  assert.match(errorReply!.message, /ghost/);

  // The old graph is still wired and still sounds — no permanent silence.
  const after = runBlock(processor);
  assert.ok(allFinite(after.left));
  assert.ok(!isSilent(after.left), 'previous graph must keep playing after a failed load');
});

test('unknown ports are rejected without mutating the running graph', async () => {
  const processor = new ModularProcessor();
  const got = replies(processor);
  processor.handleMsg({ type: 'loadGraph', graph: basicGraph(), revision: 1 });

  const broken: Graph = {
    modules: [mod('vco', 'VCO'), mod('out', 'OUTPUT')],
    connections: [conn('vco', 'nonsense', 'out', 'in')],
  };
  processor.handleMsg({ type: 'loadGraph', graph: broken, revision: 2 });
  await flush();

  assert.ok(got.some((m) => (m as { type: string }).type === 'error'));
  const { left } = runBlock(processor);
  assert.ok(!isSilent(left));
});

test('a corrected graph loads after a failure and restores sound', () => {
  const processor = new ModularProcessor();
  replies(processor);
  processor.handleMsg({ type: 'loadGraph', graph: basicGraph(2), revision: 1 });

  const broken: Graph = {
    modules: [mod('vco', 'VCO'), mod('out', 'OUTPUT')],
    connections: [conn('ghost', 'out', 'out', 'in')],
  };
  processor.handleMsg({ type: 'loadGraph', graph: broken, revision: 2 });

  // User fixes the patch: same ids, valid connection, new parameter value.
  const fixed = basicGraph(5);
  processor.handleMsg({ type: 'loadGraph', graph: fixed, revision: 3 });

  const { left } = runBlock(processor);
  assert.ok(!isSilent(left), 'sound must recover after the corrected reload');

  const vco = (processor as unknown as { modules: Map<string, VCO> }).modules.get('vco')!;
  assert.equal((vco.params as { freq?: number }).freq, 5);
});

test('setParam updates a live module without any rebuild', () => {
  const processor = new ModularProcessor();
  processor.handleMsg({ type: 'loadGraph', graph: basicGraph(2), revision: 1 });

  processor.handleMsg({ type: 'setParam', id: 'vco', param: 'freq', value: 4 });

  const vco = (processor as unknown as { modules: Map<string, VCO> }).modules.get('vco')!;
  assert.equal((vco.params as { freq: number }).freq, 4);
});

test('setParam for a module absent from the running graph is ignored, not fatal', () => {
  const processor = new ModularProcessor();
  processor.handleMsg({ type: 'loadGraph', graph: basicGraph(), revision: 1 });

  assert.doesNotThrow(() =>
    processor.handleMsg({ type: 'setParam', id: 'deleted', param: 'freq', value: 1 })
  );
  assert.ok(!isSilent(runBlock(processor).left));
});

test('feedback loop: cyclic graph loads and stays finite over many blocks', () => {
  // VCO fm -> itself through an Atten, plus VCO -> OUTPUT.
  const graph: Graph = {
    modules: [
      mod('vco', 'VCO', { freq: 2, fmSensitivity: 20, vcoShape: 'saw' }),
      mod('att', 'ATTEN', { gain: -0.2, offset: 0 }),
      mod('out', 'OUTPUT', { drive: 0.2 }),
    ],
    connections: [
      conn('vco', 'out', 'att', 'in'),
      conn('att', 'out', 'vco', 'fm'),
      conn('vco', 'out', 'out', 'in'),
    ],
  };
  const processor = new ModularProcessor();
  replies(processor);
  processor.handleMsg({ type: 'loadGraph', graph, revision: 1 });

  for (let block = 0; block < 200; block++) {
    const { left, right } = runBlock(processor);
    assert.ok(allFinite(left), `NaN/Infinity on left at block ${block}`);
    assert.ok(allFinite(right), `NaN/Infinity on right at block ${block}`);
  }
});

test('delay feedback loop stays finite across a structural reload', () => {
  const graph: Graph = {
    modules: [
      mod('vco', 'VCO', { freq: 1, vcoShape: 'square' }),
      mod('dly', 'DELAY', { delayTime: 0.1, feedback: 0.9, mix: 0.5 }),
      mod('out', 'OUTPUT', { drive: 0.2 }),
    ],
    connections: [
      conn('vco', 'out', 'dly', 'in'),
      conn('dly', 'out', 'dly', 'feedback'),
      conn('dly', 'out', 'out', 'in'),
    ],
  };
  const processor = new ModularProcessor();
  processor.handleMsg({ type: 'loadGraph', graph, revision: 1 });
  for (let i = 0; i < 50; i++) runBlock(processor);

  // Structural change: add an attenuator on the dry path.
  const reloaded: Graph = {
    modules: [
      mod('vco', 'VCO', { freq: 1, vcoShape: 'square' }),
      mod('att', 'ATTEN', { gain: 0.8, offset: 0 }),
      mod('dly', 'DELAY', { delayTime: 0.1, feedback: 0.9, mix: 0.5 }),
      mod('out', 'OUTPUT', { drive: 0.2 }),
    ],
    connections: [
      conn('vco', 'out', 'att', 'in'),
      conn('att', 'out', 'dly', 'in'),
      conn('dly', 'out', 'dly', 'feedback'),
      conn('dly', 'out', 'out', 'in'),
    ],
  };
  processor.handleMsg({ type: 'loadGraph', graph: reloaded, revision: 2 });

  for (let block = 0; block < 200; block++) {
    const { left } = runBlock(processor);
    assert.ok(allFinite(left), `non-finite output after reload at block ${block}`);
  }
});

test('structural reload preserves delay-line state for same-id modules', () => {
  const graph: Graph = {
    modules: [
      mod('vco', 'VCO', { freq: 3, vcoShape: 'sine' }),
      mod('dly', 'DELAY', { delayTime: 0.05, feedback: 0.5, mix: 0.5 }),
      mod('out', 'OUTPUT', { drive: 0.2 }),
    ],
    connections: [conn('vco', 'out', 'dly', 'in'), conn('dly', 'out', 'out', 'in')],
  };
  const processor = new ModularProcessor();
  processor.handleMsg({ type: 'loadGraph', graph, revision: 1 });
  for (let i = 0; i < 30; i++) runBlock(processor);

  const oldDelay = (processor as unknown as { modules: Map<string, Delay> }).modules.get('dly')!;
  const oldBuffer = Float32Array.from(oldDelay['buffer' as keyof Delay] as Float32Array);
  const hadSignal = oldBuffer.some((v) => v !== 0);
  assert.ok(hadSignal, 'delay line should contain signal before reload');

  // Same structure, reloaded (e.g. user pressed Cmd/Ctrl+Enter).
  processor.handleMsg({ type: 'loadGraph', graph, revision: 2 });

  const newDelay = (processor as unknown as { modules: Map<string, Delay> }).modules.get('dly')!;
  const newBuffer = newDelay['buffer' as keyof Delay] as Float32Array;
  assert.deepEqual(Array.from(newBuffer), Array.from(oldBuffer), 'delay tail must be carried over');
});

test('parameter-only edits never reset delay or slew state', async () => {
  const graph: Graph = {
    modules: [
      mod('vco', 'VCO', { freq: 2, vcoShape: 'sine' }),
      mod('dly', 'DELAY', { delayTime: 0.1, feedback: 0.6, mix: 0.5 }),
      mod('out', 'OUTPUT', { drive: 0.2 }),
    ],
    connections: [conn('vco', 'out', 'dly', 'in'), conn('dly', 'out', 'out', 'in')],
  };
  const processor = new ModularProcessor();
  processor.handleMsg({ type: 'loadGraph', graph, revision: 1 });
  for (let i = 0; i < 20; i++) runBlock(processor);

  const dly = (processor as unknown as { modules: Map<string, Delay> }).modules.get('dly')!;
  const writeIndexBefore = dly['writeIndex' as keyof Delay] as number;
  const bufferBefore = Float32Array.from(dly['buffer' as keyof Delay] as Float32Array);

  processor.handleMsg({ type: 'setParam', id: 'dly', param: 'feedback', value: 0.8 });
  processor.handleMsg({ type: 'setParam', id: 'dly', param: 'mix', value: 0.2 });
  await flush();

  assert.equal(dly['writeIndex' as keyof Delay] as number, writeIndexBefore);
  assert.deepEqual(
    Array.from(dly['buffer' as keyof Delay] as Float32Array),
    Array.from(bufferBefore),
    'setParam must not touch the delay line'
  );
  assert.equal((dly.params as { feedback: number }).feedback, 0.8);
});

test('NaN injected into a feedback loop is contained', () => {
  const graph: Graph = {
    modules: [
      mod('vco', 'VCO', { freq: 2, vcoShape: 'sine' }),
      mod('att', 'ATTEN', { gain: 1, offset: 0 }),
      mod('out', 'OUTPUT', { drive: 0.2 }),
    ],
    connections: [
      conn('vco', 'out', 'att', 'in'),
      conn('att', 'out', 'vco', 'fm'),
      conn('vco', 'out', 'out', 'in'),
    ],
  };
  const processor = new ModularProcessor();
  processor.handleMsg({ type: 'loadGraph', graph, revision: 1 });

  // Corrupt the attenuverter's output buffer, simulating a blown-up stage.
  const att = (
    processor as unknown as { modules: Map<string, { outputs: { out: Float32Array } }> }
  ).modules.get('att')!;
  att.outputs.out.fill(Number.NaN);

  const { left } = runBlock(processor);
  assert.ok(allFinite(left), 'a NaN in the loop must not reach the output');

  // And it must stay healed on subsequent blocks.
  for (let i = 0; i < 10; i++) {
    assert.ok(allFinite(runBlock(processor).left));
  }
});
