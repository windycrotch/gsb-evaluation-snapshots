import { afterEach, describe, expect, it, vi } from "vitest";
import { CompileController } from "./compileController";
import { Routing } from "./routing";
import { TGraph, compileBlock, templates } from "$library/blockCompiler";
import {
  FakeNode,
  FakeProjectNode,
  FakeRegistry,
  FakeSignal,
  FakeTimers,
  buildFakeProgram,
  makeEdgeSet,
} from "./testHarness";
import type { TProgram } from "./program";
import type { TSlot } from "./state";

// ── Самодельный маленький граф ──────────────────────────────────────────────
// in1 → Math(times, _b=2) → out1, плюс отдельный сквозной вход in2 → out2 (passthrough).
const makeGraph = (): TGraph => {
  const configs: Record<string, unknown>[] = [
    { slot: 'in1', label: 'in1' },
    { _p: 'times', _a: 1, _b: 2, _c: 0, _d: 0, _e: 0 },
    { slot: 'out1', label: 'out1' },
    { slot: 'in2', label: 'in2' },
    { slot: 'out2', label: 'out2' },
  ];

  return {
    nodes: ['GroupInput', 'Math', 'GroupOutput', 'GroupInput', 'GroupOutput'],
    configs,
    connect: [
      [[0, 0], [1, 0]],
      [[1, 2], [2, 0]],
      [[3, 0], [4, 0]],
    ],
  };
};

// Порт живой ноды в форме NodePort: { props: { output, value } } — как ждёт checkPorts
const port = (output: boolean, value?: unknown) => ({ props: { output, value } });

// Порты живых нод в порядке sortPorts: Math(times) имеет 2 входа (_a,_b) и 1 выход.
const makeLiveNodes = (graph: TGraph) => graph.nodes.map((type, i) => {
  const config = graph.configs[i] as Record<string, unknown>;

  if (type === 'Math')
    return new FakeProjectNode(type, [
      port(false, config._a),
      port(false, config._b),
      port(true),
    ], config);

  if (type === 'GroupInput')
    return new FakeProjectNode(type, [port(true)], config);

  return new FakeProjectNode(type, [port(false)], config);
});

const SLOTS: TSlot[] = [
  { id: 'in1', kind: 'in', label: 'in1' },
  { id: 'out1', kind: 'out', label: 'out1' },
  { id: 'in2', kind: 'in', label: 'in2' },
  { id: 'out2', kind: 'out', label: 'out2' },
];

// Хост, повторяющий проводку Group на фейковых узлах
class Host {
  slots: TSlot[];
  outers = new Map<string, FakeNode>();
  inners = new Map<string, FakeNode>();
  routing: Routing<FakeNode>;
  registry: FakeRegistry;
  timers = new FakeTimers();
  graph: TGraph;
  live: FakeProjectNode[];
  signals = new Map<string, FakeSignal>();
  broken = false;
  ready = true;
  programs: TProgram[] = [];
  lastError = '';
  currentProgram: TProgram | null = null;
  #controller: CompileController;

  constructor(graph = makeGraph(), slots: TSlot[] = SLOTS) {
    this.graph = graph;
    this.live = makeLiveNodes(graph);
    this.slots = slots;
    this.registry = new FakeRegistry();
    this.routing = new Routing<FakeNode>({
      connect: (a, b) => a.connect(b),
      disconnect: (a, b) => a.disconnect(b),
    });

    this.#controller = new CompileController({
      outerGain: id => this.outer(id) as unknown as AudioNode,
      innerGain: id => this.inner(id) as unknown as AudioNode,
      routing: this.routing as unknown as Routing<AudioNode>,
      getSlots: () => this.slots,
      getNodes: () => this.live as never,
      serialize: () => ({ data: this.graph }),
      isReady: () => ({ ok: this.ready, broken: this.broken }),
      buildProgram: options => buildFakeProgram(options as never, this.registry) as Promise<TProgram>,
      onProgram: program => {
        this.currentProgram = program;
        if (program)
          this.programs.push(program);
        // Как routing-effect в Group: смена программы немедленно пересобирает маршруты слотов
        this.#controller.syncRouting();
      },
      onError: () => {
        this.lastError = this.#controller.error;
        // Ошибка снимает программу — маршруты тоже надо вернуть на мосты
        this.#controller.syncRouting();
      },
      schedule: this.timers.schedule,
      clear: this.timers.clear,
    });
  }

  get controller() {
    return this.#controller;
  }

  outer(id: string) {
    var node = this.outers.get(id);
    if (!node)
      this.outers.set(id, node = new FakeNode(`outer:${id}`));
    return node;
  }

  inner(id: string) {
    var node = this.inners.get(id);
    if (!node)
      this.inners.set(id, node = new FakeNode(`inner:${id}`));
    return node;
  }

  // Все gain-узлы, чтобы проверять отсутствие висящих рёбер
  allGains() {
    return [...this.outers.values(), ...this.inners.values()];
  }

  edgeSnapshot() {
    return makeEdgeSet(this.allGains());
  }

  // Сигнал для параметра ноды (живой провод вместо константы).
  // Поле и соответствующий входной порт ссылаются на один сигнал, как в проде SignalNode,
  // поэтому checkPorts принимает граф, а сигнал уходит живым параметром в процессор.
  // Порт выбирается по карте входов шаблона: ключ k — k-й входной порт.
  attachSignal(nodeIndex: number, key: string) {
    const signal = new FakeSignal();
    this.signals.set(`${nodeIndex}.${key}`, signal);
    this.live[nodeIndex].fields[key] = signal;
    (this.live[nodeIndex] as unknown as Record<string, unknown>)[key] = signal;

    const type = this.graph.nodes[nodeIndex];
    const portInfo = templates[type].ports(this.graph.configs[nodeIndex]);

    if (typeof portInfo !== 'string') {
      const inputIndex = portInfo.inputs.indexOf(key);
      const inputs = this.live[nodeIndex].sortPorts.filter(p => !p.props.output);

      if (inputIndex >= 0 && inputs[inputIndex])
        inputs[inputIndex].props.value = signal;
    }

    return signal;
  }

  async turnOn() {
    this.#controller.scheduleCompile(0);
    await this.timers.advance(0);
  }

  async turnOff() {
    this.#controller.stop();
  }

  async flush() {
    await this.timers.advance(1000);
  }
}

// Мост входного слота: outer → inner
const hasInBridge = (host: Host, id: string) =>
  [...host.outer(id).edgesFrom].some(edge => edge.to === host.inner(id));

afterEach(() => vi.restoreAllMocks());

describe('Compiled block switch — acceptance', () => {
  it('1. compiles and sounds: outer wires land on processor channels, input→output bypass stays live', async () => {
    const host = new Host();
    host.controller.syncRouting();

    // До компиляции блок звучит мостами
    expect(host.edgeSnapshot().size).toBe(4);
    expect(hasInBridge(host, 'in1')).toBe(true);

    await host.turnOn();

    const program = host.currentProgram!;
    expect(program).toBeTruthy();
    expect(host.controller.isCompiled).toBe(true);
    expect(host.lastError).toBe('');

    // Процессор подключён ко входным и выходным outer-gain
    const worklet = host.registry.workletNodes.at(-1)!;
    const inputEdges = [...host.outer('in1').edgesFrom].map(e => e.to);
    expect(inputEdges).toContain(worklet);
    expect([...worklet.edgesFrom].some(e => e.to === host.outer('out1'))).toBe(true);

    // Сквозной in2→out2 идёт мимо процессора и остаётся звучащим
    const passthroughNames = program.passthrough.map(([a, b]) => [
      (a as unknown as FakeNode).name,
      (b as unknown as FakeNode).name,
    ]);
    expect(passthroughNames).toEqual([['outer:in2', 'outer:out2']]);
    expect([...host.outer('in2').edgesFrom].some(e => e.to === host.outer('out2'))).toBe(true);

    // Обычные мосты in1/out1 сняты — звук идёт через процессор, а не задвоенно
    expect([...host.outer('in1').edgesFrom].some(e => e.to === host.inner('in1'))).toBe(false);
    expect(worklet.stopped).toBe(false);
  });

  it('2. compile failure falls back to audible uncompiled state, shows the reason, keeps the original wiring', async () => {
    const host = new Host();
    host.controller.syncRouting();
    const before = host.edgeSnapshot();

    // Граф с некомпилируемой нодой
    host.graph = { nodes: ['Oscillator', 'GroupOutput'], configs: [{}, { slot: 'out1' }], connect: [] };
    host.live = [
      new FakeProjectNode('Oscillator', [port(true)]),
      new FakeProjectNode('GroupOutput', [port(false)], { slot: 'out1' }),
    ];

    await host.turnOn();

    expect(host.controller.isCompiled).toBe(false);
    expect(host.currentProgram).toBeNull();
    expect(host.lastError).toBe('Oscillator is not compilable');
    // Звук не потерян: мосты на месте, набор рёбер — ровно как до попытки
    expect(host.edgeSnapshot()).toEqual(before);
    expect(host.registry.workletNodes).toHaveLength(0);
  });

  it('3. rapid toggling: a late registration result never overrides the current state', async () => {
    const host = new Host();
    const result = compileBlock(makeGraph());
    if (!result.ok) throw new Error('fixture should compile');
    const key = `block:${result.source}`;
    host.registry.hang.add(key);

    // Включаем — регистрация зависает
    host.controller.scheduleCompile(0);
    await host.timers.advance(0);
    expect(host.registry.pending.has(key)).toBe(true);

    // Быстро выключаем, не дожидаясь регистрации
    await host.turnOff();
    expect(host.controller.isCompiled).toBe(false);

    // Теперь «опоздавший» результат первой регистрации приходит: узел может создаться,
    // но контроллер обязан его немедленно остановить и не сделать активной программой
    host.registry.resolvePending(key);
    await Promise.resolve();
    await Promise.resolve();

    expect(host.controller.isCompiled).toBe(false);
    expect(host.currentProgram).toBeNull();
    const lateNode = host.registry.workletNodes.at(-1);
    expect(lateNode?.stopped ?? true).toBe(true);

    // Мосты восстановлены и звучат
    expect(host.edgeSnapshot().size).toBe(4);

    // Включаем снова — переиспользуется процессор, зарегистрированный опоздавшим результатом:
    // нового модуля с тем же исходником не появляется
    await host.turnOn();
    expect(host.controller.isCompiled).toBe(true);
    const registeredForKey = host.registry.names.has(key);
    expect(registeredForKey).toBe(true);
    const sourceCount = host.registry.calls.filter(c => c.key === key).length;
    expect(sourceCount).toBeLessThanOrEqual(1);
  });

  it('4. failed registration can be retried successfully and leaves no silent block', async () => {
    const host = new Host();
    const result = compileBlock(makeGraph());
    if (!result.ok) throw new Error('fixture should compile');
    const key = `block:${result.source}`;

    host.registry.failOnce = key;
    // Ожидаемый отказ регистрации: контроллер логирует его через console.error
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await host.turnOn();

    // Первая попытка: отказ → блок остаётся звучащим нодами, видна причина
    expect(host.controller.isCompiled).toBe(false);
    expect(host.lastError).toBe('Cannot load the compiled block');
    expect(host.edgeSnapshot().size).toBe(4);

    // Повторное включение — успех
    await host.turnOn();
    expect(host.controller.isCompiled).toBe(true);
    expect(host.lastError).toBe('');
    expect(host.registry.workletNodes.length).toBe(1);
  });

  it('5. deleting the block releases the processor, parameter and bypass connections', async () => {
    const host = new Host();
    // Живой сигнал в неподключённый параметр _b, чтобы проверить снятие parameter-connection
    host.attachSignal(1, '_b');
    host.controller.syncRouting();
    await host.turnOn();

    const worklet = host.registry.workletNodes.at(-1)!;
    const signal = host.signals.get('1._b')!;
    expect(signal.node.edgesFrom.size).toBeGreaterThan(0);
    expect(worklet.edgesFrom.size + worklet.edgesTo.size).toBeGreaterThan(0);

    host.controller.dispose();

    // Процессор остановлен и полностью отключён
    expect(worklet.stopped).toBe(true);
    expect(worklet.edgesFrom.size).toBe(0);
    expect(worklet.edgesTo.size).toBe(0);
    // Параметрный провод снят
    expect(signal.node.edgesFrom.size).toBe(0);
    // Маршруты слотов очищены: ни один gain не соединён
    expect(host.edgeSnapshot().size).toBe(0);
    // Таймеров не осталось
    expect(host.timers.pendingCount).toBe(0);
  });

  it('6. uncompiled blocks are never marked compiled; failures never drop the original wiring', async () => {
    const host = new Host();
    host.controller.syncRouting();

    // Свежий блок не скомпилирован
    expect(host.controller.isCompiled).toBe(false);
    expect(host.currentProgram).toBeNull();
    const bridgesBefore = host.edgeSnapshot();
    expect(bridgesBefore.size).toBe(4);

    // Неудачная компиляция
    host.graph = { nodes: ['Group', 'GroupOutput'], configs: [{}, { slot: 'out1' }], connect: [] };
    host.live = [
      new FakeProjectNode('Group', []),
      new FakeProjectNode('GroupOutput', [port(false)], { slot: 'out1' }),
    ];
    await host.turnOn();

    expect(host.controller.isCompiled).toBe(false);
    expect(host.lastError).toMatch(/not compilable/);
    // Исходный набор соединений не изменился
    expect(host.edgeSnapshot()).toEqual(bridgesBefore);

    // Выключение после неудачи тоже ничего не ломает
    await host.turnOff();
    expect(host.edgeSnapshot()).toEqual(bridgesBefore);
  });

  it('turning Compiled off restores exactly the connection set from before compilation', async () => {
    const host = new Host();
    host.controller.syncRouting();
    const before = host.edgeSnapshot();

    await host.turnOn();
    expect(host.controller.isCompiled).toBe(true);
    expect(host.edgeSnapshot()).not.toEqual(before);

    await host.turnOff();
    expect(host.controller.isCompiled).toBe(false);
    expect(host.edgeSnapshot()).toEqual(before);
  });

  it('reuses the registered processor for the same graph across repeated toggles', async () => {
    const host = new Host();

    for (let i = 0; i < 3; i++) {
      await host.turnOn();
      expect(host.controller.isCompiled).toBe(true);
      await host.turnOff();
      expect(host.controller.isCompiled).toBe(false);
    }

    // Один исходник — одна регистрация, несмотря на три цикла включения
    const uniqueSources = new Set(host.registry.calls.map(c => c.key));
    expect(uniqueSources.size).toBe(1);
    // Каждая остановленная программа освободила свой узел
    expect(host.registry.workletNodes.every(node => node.stopped)).toBe(true);
  });

  it('keeps the block audible while a recompile is pending after a structural change', async () => {
    const host = new Host();
    host.controller.syncRouting();
    await host.turnOn();
    const first = host.registry.workletNodes.at(-1)!;

    // Меняем структурное поле (операцию Math: times → plus) и планируем перекомпиляцию.
    // Пока новая программа не готова, текущая продолжает звучать.
    const mathConfig = host.graph.configs[1] as Record<string, unknown>;
    mathConfig._p = 'plus';
    host.live[1].fields._p = 'plus';
    (host.live[1] as unknown as Record<string, unknown>)._p = 'plus';
    host.controller.scheduleCompile(100);
    expect(host.controller.isCompiled).toBe(true);
    expect(first.stopped).toBe(false);

    await host.flush();
    const second = host.registry.workletNodes.at(-1)!;
    expect(host.controller.isCompiled).toBe(true);
    // Старая программа погашена только после подключения новой
    expect(first.stopped).toBe(true);
    expect(second.stopped).toBe(false);
  });

  it('retries without going silent while the inner graph is still loading, then compiles', async () => {
    const host = new Host();
    host.controller.syncRouting();
    host.ready = false;

    host.controller.scheduleCompile(0);
    await host.timers.advance(0);

    // Граф грузится — программы нет, но мосты звучат и ошибки нет
    expect(host.controller.isCompiled).toBe(false);
    expect(host.lastError).toBe('');
    expect(host.edgeSnapshot().size).toBe(4);
    // Назначен повтор
    expect(host.timers.pendingCount).toBe(1);

    host.ready = true;
    await host.flush();

    expect(host.controller.isCompiled).toBe(true);
    expect(host.lastError).toBe('');
  });

  it('a broken graph stays audible and reports the load failure as the reason', async () => {
    const host = new Host();
    host.controller.syncRouting();
    const before = host.edgeSnapshot();
    host.broken = true;

    await host.turnOn();

    expect(host.controller.isCompiled).toBe(false);
    expect(host.lastError).toBe('Block graph failed to load');
    // Никакой процессор не создавался, проводка цела
    expect(host.registry.workletNodes).toHaveLength(0);
    expect(host.edgeSnapshot()).toEqual(before);
  });

  it('retries when live ports do not match the compiler map, then succeeds once they settle', async () => {
    const host = new Host();
    host.controller.syncRouting();

    // Рассогласование: у живой Math-ноды лишний порт, checkPorts вернёт причину
    host.live[1].sortPorts.push(port(false, 99));
    host.controller.scheduleCompile(0, true);
    await host.timers.advance(0);

    // Пока порты не устаканились — повтор по таймеру, блок не помечен скомпилированным и звучит
    expect(host.controller.isCompiled).toBe(false);
    expect(host.lastError).toBe('');
    expect(host.edgeSnapshot().size).toBe(4);
    expect(host.timers.pendingCount).toBe(1);

    // Порты перемонтировались в корректную карту
    host.live[1].sortPorts.pop();
    await host.flush();

    expect(host.controller.isCompiled).toBe(true);
    expect(host.lastError).toBe('');
    expect(host.registry.workletNodes.length).toBe(1);
  });
});
