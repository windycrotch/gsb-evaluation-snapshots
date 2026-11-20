import type { TCompiled } from "$library/blockCompiler";
import { paramName } from "$library/blockCompiler";
import type { TProgram } from "./program";

// Минимальная модель Web Audio-графа для тестов машины компиляции блоков — без реальных устройств.
// Узел помнит рёбра connect/disconnect и параметры; AudioWorkletNode ведёт себя как настоящий
// (port, parameters, onprocessorerror, disconnect), а регистрация процессора — управляемая заглушка.

export type Edge = { from: FakeNode; to: FakeNode | FakeParam; out: number; input: number; };

let nodeSeq = 0;

export class FakeNode {
  id = `n${nodeSeq++}`;
  edgesFrom = new Set<Edge>();
  edgesTo = new Set<Edge>();
  name: string;

  constructor(name = 'GainNode') {
    this.name = name;
  }

  connect(to: FakeNode | FakeParam, out = 0, input = 0) {
    const edge: Edge = { from: this, to, out, input };

    // Повторный connect той же пары в Web Audio ничего не добавляет
    for (const existing of this.edgesFrom)
      if (existing.to === edge.to && existing.out === out && existing.input === input)
        return to;

    this.edgesFrom.add(edge);
    (to instanceof FakeParam ? to.node : to).edgesTo.add(edge);
    return to;
  }

  disconnect(to?: FakeNode | FakeParam, out?: number, input?: number) {
    for (const edge of [...this.edgesFrom]) {
      if (to !== undefined) {
        const matchesNode = edge.to instanceof FakeNode && edge.to === to;
        const matchesParam = edge.to instanceof FakeParam && edge.to === to;

        if (!matchesNode && !matchesParam)
          continue;
        if (out !== undefined && edge.out !== out)
          continue;
        if (input !== undefined && edge.input !== input)
          continue;
      }

      this.edgesFrom.delete(edge);
      (edge.to instanceof FakeParam ? edge.to.node : edge.to).edgesTo.delete(edge);
    }
  }
}

export class FakeParam {
  node: FakeWorkletNode;
  name: string;
  value = 0;
  defaultValue = 0;
  minValue = -Infinity;
  maxValue = Infinity;
  connectedFrom = new Set<FakeNode>();

  constructor(node: FakeWorkletNode, name: string, defaultValue = 0) {
    this.node = node;
    this.name = name;
    this.value = defaultValue;
    this.defaultValue = defaultValue;
  }
}

export type Registrar = (key: string, build: (name: string) => string) => Promise<string>;

export class FakeWorkletNode extends FakeNode {
  parameters = new Map<string, FakeParam>();
  port = {
    messages: [] as unknown[],
    postMessage: (data: unknown) => { this.port.messages.push(data); },
  };
  onprocessorerror: ((...args: unknown[]) => void) | null = null;
  processor: string;
  stopped = false;

  constructor(processor: string, paramNames: string[]) {
    super('AudioWorkletNode');
    this.processor = processor;

    for (const name of paramNames)
      this.parameters.set(name, new FakeParam(this, name));
  }
}

// Реестр процессоров: по умолчанию регистрирует мгновенно, но умеет падать и зависать.
// Один ключ — одна регистрация, как defineRuntimeWorklet;失败之后 ключ можно зарегистрировать заново.
export class FakeRegistry {
  names = new Map<string, string>();
  calls: { key: string; source: string; }[] = [];
  #seq = 0;
  failOnce: string | null = null;
  failEvery: string | null = null;
  // Незавершённые регистрации: ключ → функция, которую дёргает тест, чтобы отдать результат
  pending = new Map<string, { resolve(name: string): void; reject(error: Error): void; }>();
  hang = new Set<string>();
  workletNodes: FakeWorkletNode[] = [];
  paramNamesOf: (result: { params: unknown[]; }) => string[] = result => result.params.map((_, k) => `k${k}`);

  register: Registrar = (key, build) => {
    const existing = this.names.get(key);

    if (existing)
      return Promise.resolve(existing);

    if (this.hang.has(key) || this.pending.has(key)) {
      return new Promise<string>((resolve, reject) => {
        this.pending.set(key, { resolve, reject });
      });
    }

    if (this.failOnce === key || this.failEvery === key) {
      this.failOnce = null;
      return Promise.reject(new Error(`register failed: ${key}`));
    }

    this.calls.push({ key, source: build('RuntimeWorklet') });
    const name = `RuntimeWorklet${this.#seq++}`;
    this.names.set(key, name);
    return Promise.resolve(name);
  };

  // Отпустить зависшую регистрацию успехом
  resolvePending(key: string) {
    const name = `RuntimeWorklet${this.#seq++}`;
    this.names.set(key, name);
    this.pending.get(key)!.resolve(name);
    this.pending.delete(key);
    return name;
  }

  rejectPending(key: string, error = new Error('late failure')) {
    this.pending.get(key)!.reject(error);
    this.pending.delete(key);
  }

  createNode = (processor: string, result: { params: unknown[]; }): FakeWorkletNode => {
    const node = new FakeWorkletNode(processor, this.paramNamesOf(result));
    this.workletNodes.push(node);
    return node;
  };
}

// Простые фейковые ноды проекта: у каждой тип и порты в порядке sortPorts (входы, потом выход).
// Форма порта повторяет NodePort: { props: { output, value } }, как читает checkPorts.
export type FakePort = { props: { output: boolean; value?: unknown; } };

export class FakeProjectNode {
  type: string;
  sortPorts: FakePort[];
  fields: Record<string, unknown>;

  constructor(type: string, ports: FakePort[], fields: Record<string, unknown> = {}) {
    this.type = type;
    this.sortPorts = ports;
    this.fields = fields;

    // checkPorts читает поля ноды напрямую (node._a), как у настоящей NodeItem с @store
    for (const [key, value] of Object.entries(fields))
      (this as unknown as Record<string, unknown>)[key] = value;
  }
}

// Детерминированные таймеры: тест сам продвигает время
export class FakeTimers {
  #id = 0;
  #queue = new Map<number, { fn: () => void; ms: number; at: number; }>();
  now = 0;

  schedule = (fn: () => void, ms: number) => {
    const id = ++this.#id;
    this.#queue.set(id, { fn, ms, at: this.now + ms });
    return id;
  };

  clear = (handle: number | undefined) => {
    if (handle !== undefined)
      this.#queue.delete(handle);
  };

  // Выполнить всё, что созрело к текущему моменту (в порядке времени)
  async advance(ms: number) {
    this.now += ms;

    while (true) {
      const due = [...this.#queue.values()].filter(item => item.at <= this.now).sort((a, b) => a.at - b.at);

      if (!due.length)
        break;

      for (const item of due) {
        for (const [id, entry] of this.#queue)
          if (entry === item)
            this.#queue.delete(id);

        await item.fn();
      }
    }
  }

  get pendingCount() {
    return this.#queue.size;
  }
}

export const makeEdgeSet = (nodes: FakeNode[]) => {
  const edges = new Set<string>();

  for (const node of nodes)
    for (const edge of node.edgesFrom)
      edges.add(describe(edge));

  return edges;
};

export const describe = (edge: Edge) => (
  edge.to instanceof FakeNode
    ? `${edge.from.id}[${edge.out}]>${edge.to.id}[${edge.input}]`
    : `${edge.from.id}[${edge.out}]>param:${edge.to.node.id}.${edge.to.name}`
);
export class FakeSignal {
  node: FakeNode;

  constructor() {
    this.node = new FakeNode('ConstantSourceNode');
  }
}

const isSignal = (value: unknown): value is FakeSignal => value instanceof FakeSignal;

// Точная копия семантики buildProgram (program.ts) на фейковых узлах:
// входы/выходы процессора к outer-gain, параметры — из сигнала или значения, passthrough мимо.
// Тесты проверяют те же инварианты, что гарантирует прод-сборка.
export const buildFakeProgram = async (
  args: {
    key: string;
    result: TCompiled;
    signals: unknown[];
    defaults: number[];
    outer: (id: string) => FakeNode;
    onError: () => void;
  },
  registry: FakeRegistry,
): Promise<TProgram & { node: FakeWorkletNode; }> => {
  const { key, result, signals, defaults, outer, onError } = args;
  const passthrough = result.passthrough.map(([a, b]) => [outer(a), outer(b)] as [FakeNode, FakeNode]);

  if (!result.outputs.length)
    return { key, signals: signals as unknown[], passthrough: passthrough as never, stop() { }, node: null as never };

  const processor = await registry.register(`block:${result.source}`, name => `// ${name}`);
  const node = registry.createNode(processor, result) as FakeWorkletNode;
  node.onprocessorerror = onError;

  const teardowns: (() => void)[] = [];

  result.inputs.forEach((id, k) => {
    const gain = outer(id);
    gain.connect(node, 0, k);
    teardowns.push(() => gain.disconnect(node, 0, k));
  });

  result.outputs.forEach((id, k) => {
    const gain = outer(id);
    node.connect(gain, k, 0);
    teardowns.push(() => node.disconnect(gain, k, 0));
  });

  result.params.forEach((_, k) => {
    const param = node.parameters.get(paramName(k))!;
    const signal = signals[k];

    if (isSignal(signal)) {
      param.value = 0;
      signal.node.connect(param as never);
      param.connectedFrom.add(signal.node);
      teardowns.push(() => {
        signal.node.disconnect(param as never);
        param.connectedFrom.delete(signal.node);
      });
      return;
    }

    param.value = defaults[k];
  });

  return {
    key,
    signals: signals as unknown[],
    passthrough: passthrough as never,
    node,
    stop() {
      node.onprocessorerror = null;
      for (const fn of teardowns)
        fn();
      node.stopped = true;
      node.disconnect();
    },
  };
};
