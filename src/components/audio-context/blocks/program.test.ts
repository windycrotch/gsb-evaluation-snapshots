import { afterEach, describe, expect, it, vi } from "vitest";

// ctx.ts создаёт new AudioContext() при импорте, а SignalNode — цепочку декораторов.
// vi.hoisted гарантирует, что глобальные заглушки Web Audio установлены до импорта модулей.
const { addModule } = vi.hoisted(() => ({ addModule: vi.fn(async () => {}) }));

vi.hoisted(() => {
  class StubAudioNode {
    connect() {}
    disconnect() {}
    start() {}
    getFloatTimeDomainData() {}
    get offset() { return new StubAudioParam(); }
    get gain() { return new StubAudioParam(); }
  }
  class StubAudioParam {
    value = 0;
    defaultValue = 0;
    minValue = -Infinity;
    maxValue = Infinity;
    connect() {}
    disconnect() {}
  }
  class StubAudioContext {
    sampleRate = 48000;
    destination = new StubAudioNode();
    state = 'running';
    audioWorklet = { addModule };
    createGain() { return new StubAudioNode(); }
    createConstantSource() { return new StubAudioNode(); }
    createAnalyser() { return new StubAudioNode(); }
    resume() { return Promise.resolve(); }
  }

  vi.stubGlobal('AudioContext', StubAudioContext);
  vi.stubGlobal('AudioParam', StubAudioParam);
  vi.stubGlobal('AudioNode', StubAudioNode);
});

import { buildProgram } from "./program";
import { TCompiled } from "$library/blockCompiler";
import { STOP_MESSAGE } from "$library/expression";

// SignalNode тянет цепочку декораторов и реальный AudioContext; в этом тесте нужны только
// instanceof и его .node, поэтому подменяем класс самодостаточным стабом.
vi.mock("../lib/signalNode", () => ({
  SignalNode: class FakeSignalNode {
    node: { connect(...a: unknown[]): void; disconnect(...a: unknown[]): void; addInput?(): void; };
    constructor() {
      this.node = { connect() {}, disconnect() {} };
    }
  },
}));

// Модель Web Audio, достаточная для buildProgram: узлы помнят рёбра и параметры
class FakeParam {
  value = 0;
  constructor(public name: string, public node: FakeWorklet) {}
}

class FakeNode {
  edges = new Set<string>();
  connect(to: FakeNode | FakeParam) {
    this.edges.add(to instanceof FakeParam ? `param:${to.name}` : to.id);
  }
  disconnect(to?: FakeNode | FakeParam) {
    if (!to)
      return this.edges.clear();
    this.edges.delete(to instanceof FakeParam ? `param:${to.name}` : to.id);
  }
  constructor(public id: string) {}
}

class FakeWorklet extends FakeNode {
  parameters = new Map<string, FakeParam>();
  port = { messages: [] as unknown[], postMessage: (m: unknown) => this.port.messages.push(m) };
  onprocessorerror: (() => void) | null = null;
  constructor(public processor: string, paramNames: string[]) {
    super(`worklet:${processor}`);
    paramNames.forEach(name => this.parameters.set(name, new FakeParam(name, this)));
  }
}

// Граф: один вход in, один выход out, два живых параметра k0/k1
const result: TCompiled = {
  ok: true,
  source: 'SRC',
  inputs: ['in'],
  outputs: ['out'],
  params: [{ node: 0, key: 'k0' }, { node: 1, key: 'k1' }],
  passthrough: [['pin', 'pout']],
  delayed: [],
};

const makeOuter = () => {
  const gains = new Map<string, FakeNode>([
    ['in', new FakeNode('gain:in')],
    ['out', new FakeNode('gain:out')],
    ['pin', new FakeNode('gain:pin')],
    ['pout', new FakeNode('gain:pout')],
  ]);
  return (id: string) => gains.get(id)!;
};

afterEach(() => {
  addModule.mockClear();
  vi.restoreAllMocks();
});

describe('buildProgram (production wiring)', () => {
  it('connects inputs/outputs to processor channels and keeps the bypass pair', async () => {
    const outer = makeOuter();
    const worklets: FakeWorklet[] = [];
    vi.stubGlobal('AudioWorkletNode', class extends FakeWorklet {
      constructor(processor: string) {
        super(processor, ['k0', 'k1']);
        worklets.push(this);
      }
    });

    const program = await buildProgram({
      key: 'k',
      result,
      signals: [42, 7],
      defaults: [42, 7],
      outer: id => outer(id) as unknown as AudioNode,
      onError: () => {},
    });

    const node = worklets[0];
    // Входной gain → процессор, процессор → выходной gain
    expect(outer('in').edges.has(node.id)).toBe(true);
    expect(node.edges.has(outer('out').id)).toBe(true);
    // Обход мимо процессора выдан наружу как пара passthrough
    expect(program.passthrough.map(([a, b]) => [(a as unknown as FakeNode).id, (b as unknown as FakeNode).id])).toEqual([
      ['gain:pin', 'gain:pout'],
    ]);
    // Константные параметры получили значения
    expect(node.parameters.get('k0')!.value).toBe(42);
  });

  it('stop() tears down every edge, parameter connection and stops the processor', async () => {
    const outer = makeOuter();
    const worklets: FakeWorklet[] = [];
    vi.stubGlobal('AudioWorkletNode', class extends FakeWorklet {
      constructor(processor: string) {
        super(processor, ['k0', 'k1']);
        worklets.push(this);
      }
    });

    const program = await buildProgram({
      key: 'k2',
      result,
      signals: [1, 2],
      defaults: [1, 2],
      outer: id => outer(id) as unknown as AudioNode,
      onError: () => {},
    });

    const node = worklets[0];
    expect(outer('in').edges.size).toBeGreaterThan(0);

    program.stop();

    expect(node.port.messages).toContain(STOP_MESSAGE);
    expect(node.edges.size).toBe(0);
    expect(outer('in').edges.size).toBe(0);
    expect(outer('out').edges.size).toBe(0);
    expect(node.onprocessorerror).toBeNull();
  });

  it('does not build a node for a block with no outputs (only passthrough)', async () => {
    const outer = makeOuter();
    const ctor = vi.fn();
    vi.stubGlobal('AudioWorkletNode', ctor);

    const noOutputs: TCompiled = { ...result, outputs: [], passthrough: [['pin', 'pout']] };
    const program = await buildProgram({
      key: 'k3',
      result: noOutputs,
      signals: [],
      defaults: [],
      outer: id => outer(id) as unknown as AudioNode,
      onError: () => {},
    });

    expect(ctor).not.toHaveBeenCalled();
    expect(program.passthrough).toHaveLength(1);
    // stop не падает, даже когда узла нет
    expect(() => program.stop()).not.toThrow();
  });

  it('survives a throwing disconnect on one edge without stranding the others', async () => {
    const outer = makeOuter();
    const worklets: FakeWorklet[] = [];
    vi.stubGlobal('AudioWorkletNode', class extends FakeWorklet {
      constructor(processor: string) {
        super(processor, ['k0', 'k1']);
        worklets.push(this);
      }
    });

    const program = await buildProgram({
      key: 'k4',
      result,
      signals: [1, 2],
      defaults: [1, 2],
      outer: id => outer(id) as unknown as AudioNode,
      onError: () => {},
    });

    // Первый disconnect бросает, как бывает у уже отключённого узла; остальные teardown-функции
    // всё равно обязаны отработать, иначе процессор остался бы в графе.
    const node = worklets[0];
    const original = outer('in').disconnect.bind(outer('in'));
    outer('in').disconnect = vi.fn(() => {
      throw new Error('already disconnected');
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    expect(() => program.stop()).not.toThrow();
    expect(errorSpy).toHaveBeenCalled();
    // Выходной провод всё равно снят
    expect(node.edges.size).toBe(0);
    original; // ссылка, чтобы типы не ругались на неиспользуемую привязку
  });
});
