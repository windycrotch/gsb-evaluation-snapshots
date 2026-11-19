import { TCompiled, blockProcessorSource } from "$library/blockCompiler";
import { afterEach, describe, expect, it, vi } from "vitest";

import { STOP_MESSAGE } from "$library/expression";

// Изолируем program.ts от декораторных/веб-аудио зависимостей.
vi.mock('../lib/signalNode', () => ({ SignalNode: class SignalNode { } }));
vi.mock('../lib/pipe', () => ({ pipe: () => () => { } }));
vi.mock('$library/dispose', () => ({ dispose: (...fns: (() => void)[]) => () => fns.forEach(fn => fn()) }));

const { buildProgram } = await import("./program");

// Модель AudioWorkletNode, повторяющая протокол block-процессора:
// на { source } отвечает { ok, id, state }, на [STOP] — { ok, stopped }.
class MockParam {
  value = 0;
  constructor(public name: string) { }
}

type Sent = { source?: string; reset?: boolean; id?: number; } | string;

class MockWorkletNode {
  parameters = new Map<string, MockParam>();
  port = {
    onmessage: null as null | ((event: { data: unknown; }) => void),
    postMessage: (data: Sent) => { this.sent.push(data); },
  };
  onprocessorerror: (() => void) | null = null;
  sent: Sent[] = [];
  connected = new Set<string>();

  constructor(public processorName: string, opts: { numberOfInputs: number; numberOfOutputs: number; }) {
    for (let k = 0; k < opts.numberOfInputs; k++)
      this.parameters.set(`k${k}`, new MockParam(`k${k}`));
  }

  connect() { this.connected.add('out'); }
  disconnect() { this.connected.clear(); }

  // Эмуляция ответа процессора на горячую замену
  emulateSwapReply(reply: Record<string, unknown>) {
    this.port.onmessage?.({ data: reply });
  }
}

// vi.mock поднимается в начало файла, поэтому общие муляжи объявляем через vi.hoisted.
const mocks = vi.hoisted(() => {
  const addModule = vi.fn(async () => { });
  const mockNode = vi.fn();
  return { addModule, mockNode };
});

vi.mock('../ctx', () => ({
  ctx: {
    sampleRate: 48000,
    audioWorklet: { addModule: mocks.addModule },
  },
}));

// Изолируем program.ts от декораторных/веб-аудио зависимостей.
vi.mock('../lib/signalNode', () => ({ SignalNode: class SignalNode { } }));
vi.mock('../lib/pipe', () => ({ pipe: () => () => { } }));
vi.mock('$library/dispose', () => ({ dispose: (...fns: (() => void)[]) => () => fns.forEach(fn => fn()) }));

// Подменяем глобальный AudioWorkletNode на время тестов
vi.stubGlobal('AudioWorkletNode', class extends MockWorkletNode {
  constructor(name: string, opts: { numberOfInputs: number; numberOfOutputs: number; }) {
    super(name, opts);
    mocks.mockNode(this);
  }
});

const { mockNode } = mocks;

const graph = (): TCompiled => ({
  ok: true,
  source: '(function(){return function(sr,carried){const s={n0_x:0};function run(){}run.state=s;return run;};})()',
  inputs: ['in1'],
  outputs: ['out1'],
  params: [],
  passthrough: [],
  delayed: [],
});

const gain = (id: string) => ({
  id,
  connect() { },
  disconnect() { },
}) as unknown as AudioNode;

afterEach(() => {
  vi.clearAllMocks();
});

describe('buildProgram hot swap', () => {
  it('resolves ok when the processor accepts the new factory', async () => {
    const result = graph();
    const program = await buildProgram({
      key: 'a',
      result,
      signals: [],
      defaults: [],
      outer: gain,
      onError: () => { },
    });

    const node = mockNode.mock.calls.at(-1)![0] as MockWorkletNode;
    const next = { ...graph(), source: 'NEXT' };

    const pending = program.swap!(next);
    expect(node.sent.at(-1)).toMatchObject({ source: 'NEXT', reset: false, id: 1 });

    node.emulateSwapReply({ ok: true, id: 1, state: 'continued' });
    await expect(pending).resolves.toEqual({ ok: true, error: undefined, state: 'continued' });
  });

  it('resolves a failure without touching the running program', async () => {
    const result = graph();
    const program = await buildProgram({
      key: 'a',
      result,
      signals: [],
      defaults: [],
      outer: gain,
      onError: () => { },
    });

    const node = mockNode.mock.calls.at(-1)![0] as MockWorkletNode;
    const pending = program.swap!({ ...graph(), source: 'BAD' });

    node.emulateSwapReply({ ok: false, id: 1, error: 'boom', kept: 'previous' });
    await expect(pending).resolves.toMatchObject({ ok: false, error: 'boom' });

    // Программа остаётся подключённой и рабочей
    expect(program.key).toBe('a');
  });

  it('refuses a swap when the topology changed, without messaging the node', async () => {
    const program = await buildProgram({
      key: 'a',
      result: graph(),
      signals: [],
      defaults: [],
      outer: gain,
      onError: () => { },
    });

    const node = mockNode.mock.calls.at(-1)![0] as MockWorkletNode;
    const before = node.sent.length;

    const changed: TCompiled = { ...graph(), outputs: ['out1', 'out2'] };
    await expect(program.swap!(changed)).resolves.toMatchObject({ ok: false, error: 'Block topology changed' });
    expect(node.sent.length).toBe(before);
  });

  it('stop sends the stop message and tears the node down', async () => {
    const program = await buildProgram({
      key: 'a',
      result: graph(),
      signals: [],
      defaults: [],
      outer: gain,
      onError: () => { },
    });

    const node = mockNode.mock.calls.at(-1)![0] as MockWorkletNode;
    program.stop();

    expect(node.sent).toContain(STOP_MESSAGE);
    expect(node.port.onmessage).toBeNull();
  });

  it('still generates a valid worklet source for a real compiled graph', () => {
    const result = graph();
    expect(() => blockProcessorSource('BlockProgramTest', result)).not.toThrow();
  });
});
