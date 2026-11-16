import { ExpressionRuntime, MAX_LENGTH, PROCESSOR_INPUTS, STOP_MESSAGE, processorSource } from ".";
import { describe, expect, it } from "vitest";
import type { KernelMessage } from "./runtime";

// Офлайн-проверка поведения ноды Expression: без Web Audio и без DOM.
// Процессор собран из processorSource и работает в обычном JS, порт — массив сообщений.

type Processor = {
  port: { onmessage: ((event: { data: unknown; }) => void) | null; postMessage(data: unknown): void; };
  process(inputs: unknown[], outputs: Float32Array[][], parameters: Record<string, Float32Array>): boolean;
};

const hidden = ['globalThis', 'window', 'self', 'global', 'process', 'eval', 'Function', 'require', 'fetch'];

const run = <T,>(source: string, names: string[], values: unknown[]): T => (
  new Function(...hidden, ...names, `return ${source};`)(
    ...hidden.map(() => undefined), ...values
  )
);

// Процессор как в браузере: registerProcessor + AudioWorkletProcessor + часы
const createProcessor = (currentFrame = 0, sampleRate = 48000) => {
  const registered: Record<string, new (options?: unknown) => Processor> = {};

  class AudioWorkletProcessor {
    port = { onmessage: null as Processor['port']['onmessage'], postMessage: () => { } };
  }

  run(
    `(() => { ${processorSource('ExpressionBehavior')} })()`,
    ['registerProcessor', 'AudioWorkletProcessor', 'sampleRate', 'currentFrame', 'Function'],
    [(name: string, ctor: never) => registered[name] = ctor, AudioWorkletProcessor, sampleRate, currentFrame, Function]
  );

  expect(Object.keys(registered)).toEqual(['ExpressionBehavior']);
  return new registered.ExpressionBehavior();
};

// Транспорт, который сразу доставляет сообщения процессору, а ответы возвращает в рантайм
const createTransport = (processor: Processor) => {
  const sent: KernelMessage[] = [];

  const runtime = new ExpressionRuntime();

  runtime.attach(message => {
    sent.push(message);
    processor.port.onmessage!({ data: message });
  });

  processor.port.postMessage = (data: unknown) => runtime.receive(data);

  return { runtime, sent };
};

const params = (values: Partial<Record<typeof PROCESSOR_INPUTS[number], Float32Array>> = {}) => (
  Object.fromEntries(PROCESSOR_INPUTS.map(key => [key, values[key] ?? new Float32Array([0])]))
);

const block = (frames = 2) => [new Float32Array(frames)];

const output = (processor: Processor, frames = 2) => {
  const out = block(frames);
  processor.process([], [out], params());
  return [...out[0]];
};

describe('Expression node behavior', () => {
  it('keeps the previous kernel when a draft is invalid', () => {
    const processor = createProcessor();
    const { runtime, sent } = createTransport(processor);

    runtime.setSource('1');
    expect(sent).toHaveLength(1);
    expect(output(processor)).toEqual([1, 1]);

    const before = sent.length;
    runtime.beginDraft('sin(');
    expect(runtime.draftError('sin(')).toMatch(/Unexpected end of expression \(at 5\)/);
    runtime.commitDraft();

    // Применение ошибочного текста ничего не отправило и не тронуло играющее ядро
    expect(sent).toHaveLength(before);
    expect(runtime.kernel).not.toBeNull();
    expect(runtime.source).toBe('sin(');
    expect(output(processor)).toEqual([1, 1]);
  });

  it('is silent before the first successful formula and after a failed one', () => {
    const processor = createProcessor();
    const { runtime, sent } = createTransport(processor);

    // Первой же формулой пришла ошибка: ядра нет — процессор заполняет блок нулями
    runtime.setSource('sin(');
    expect(runtime.kernel).toBeNull();
    expect(output(processor)).toEqual([0, 0]);

    // Успешная формула начинает звучать, следующая ошибка не глушит её
    runtime.setSource('0.5');
    expect(sent).toHaveLength(1);
    expect(output(processor)).toEqual([0.5, 0.5]);

    runtime.setSource('a.');
    expect(runtime.kernel).not.toBeNull();
    expect(output(processor)).toEqual([0.5, 0.5]);
  });

  it('continues y1 feedback after swapping the kernel', () => {
    const processor = createProcessor();
    const { runtime } = createTransport(processor);

    runtime.setSource('y1 + 1');
    expect(output(processor)).toEqual([1, 2]);
    expect(output(processor)).toEqual([3, 4]);

    // Новое ядро видит y1 = 4 из прошлого блока того же процессора
    runtime.setSource('y1 * 10');
    expect(output(processor)).toEqual([40, 400]);
    expect(output(processor)).toEqual([4000, 40000]);
  });

  it('reports error messages with positions', () => {
    const runtime = new ExpressionRuntime('a.constructor');

    expect(runtime.error).toMatch(/Member access \('\.'\) is not allowed/);
    expect(runtime.error).toMatch(/\(at 2\)$/);

    const cases: [string, RegExp][] = [
      ['sin()', /sin\(\) expects 1 argument, got 0/],
      ['clamp(1, 2)', /clamp\(\) expects 3 arguments, got 2/],
      ['unknown + 1', /Unknown identifier 'unknown'/],
      [`${'('.repeat(200)}1${')'.repeat(200)}`, /too deeply nested/],
      ['1'.repeat(MAX_LENGTH + 1), /too long/],
      ['a +', /Unexpected end of expression/],
    ];

    for (const [source, message] of cases) {
      runtime.setSource(source);
      expect(runtime.error).toMatch(message);
      expect(runtime.error).toMatch(/\(at \d+\)$/);
    }
  });

  it('shows the draft error while typing without touching the saved formula', () => {
    const runtime = new ExpressionRuntime('sin(a)');

    runtime.beginDraft('sin(');
    expect(runtime.error).toMatch(/Unexpected end of expression \(at 5\)/);

    // Esc: черновик отброшен, снова видна сохранённая формула
    runtime.cancelDraft();
    expect(runtime.error).toBe('');
    expect(runtime.source).toBe('sin(a)');
  });

  it('ignores replies for stale kernels', () => {
    const processor = createProcessor();
    const { runtime, sent } = createTransport(processor);

    runtime.setSource('1');
    runtime.setSource('2');

    const first = sent[0].id;

    // Запоздалый отказ от старого ядра не должен испортить новое состояние
    runtime.receive({ ok: false, id: first, error: 'stale failure' });
    expect(runtime.loadError).toBe('');

    runtime.receive({ ok: false, id: sent[1].id, error: 'unknown token' });
    expect(runtime.loadError).toBe('unknown token');
  });

  it('writes NaN and Infinity as 0', () => {
    const processor = createProcessor();
    const { runtime } = createTransport(processor);

    runtime.setSource('a / 0 + sqrt(-1)');
    expect(output(processor)).toEqual([0, 0]);
  });

  it('uses one processor and only swaps kernels', () => {
    const processor = createProcessor();
    const { runtime, sent } = createTransport(processor);

    runtime.setSource('1');
    runtime.setSource('2');
    runtime.setSource('a.');

    // Ошибочная формула не отправила ничего: два ядра, один и тот же процессор
    expect(sent).toHaveLength(2);
    expect(sent.every(message => typeof message.kernel === 'string')).toBe(true);
    runtime.setSource('1');
    expect(sent).toHaveLength(3);
  });

  it('surfaces a failed load for the current kernel', () => {
    const processor = createProcessor();
    const { runtime, sent } = createTransport(processor);

    runtime.setSource('y1 + 1');
    expect(output(processor)).toEqual([1, 2]);

    // Процессор отказался собирать текущее ядро: ошибка видна, а звук идёт по-старому
    runtime.receive({ ok: false, id: sent.at(-1)!.id, error: 'boom' });

    expect(runtime.loadError).toBe('boom');
    expect(output(processor)).toEqual([3, 4]);
    expect(runtime.kernel).not.toBeNull();
  });

  it('ignores a kernel message that arrives out of order', () => {
    const processor = createProcessor();
    const { runtime, sent } = createTransport(processor);

    runtime.setSource('1');
    const stale = sent[0];

    runtime.setSource('2');
    expect(output(processor)).toEqual([2, 2]);

    // Старое сообщение с меньшим id не должно вернуть процессору прошлое ядро
    processor.port.onmessage!({ data: stale });
    expect(output(processor)).toEqual([2, 2]);
  });

  it('stops on the stop message', () => {
    const processor = createProcessor();
    processor.port.onmessage!({ data: STOP_MESSAGE });
    expect(processor.process([], [block()], params())).toBe(false);
  });
});
