import { ExpressionRuntime, KERNEL_LOAD_ERROR, PROCESSOR_LOAD_ERROR, TExpressionProcessor, TKernelReply } from "./runtime";
import { describe, expect, it, vi } from "vitest";

import { compile } from ".";

// Ядро из настоящего компилятора, как его шлёт нода
const kernelOf = (src: string) => {
  const result = compile(src);
  if (!result.ok) throw new Error(`${src}: ${result.error}`);
  return result;
};

// Процессор-заглушка: помнит присланные ядра, отвечает по команде теста
const fakeProcessor = () => {
  const posted: { kernel: string; id: number; }[] = [];
  let handler: ((reply: TKernelReply) => void) | null = null;

  const processor: TExpressionProcessor = {
    post: message => { posted.push(message); },
    listen: next => { handler = next; },
    stop: vi.fn(),
  };

  return {
    posted,
    processor,
    isListening: () => handler !== null,
    reply: (data: TKernelReply) => handler?.(data),
  };
};

// Макротаск: промисы рантайма успевают завершиться
const tick = () => new Promise<void>(resolve => setTimeout(resolve, 0));

const setup = (connect: () => Promise<TExpressionProcessor>) => {
  const errors: string[] = [];
  const runtime = new ExpressionRuntime(connect, message => errors.push(message));
  return { runtime, errors, lastError: () => errors.at(-1) };
};

describe('ExpressionRuntime', () => {
  it('applies the formula once the processor is ready', async () => {
    const fake = fakeProcessor();
    let started = 0;
    const { runtime, errors } = setup(async () => (started++, fake.processor));

    runtime.submit(kernelOf('a * 2'));
    // Процессор ещё не готов — ядро ждёт, ничего не ушло
    expect(fake.posted).toEqual([]);

    await tick();
    expect(started).toBe(1);
    expect(fake.posted.map(m => m.kernel)).toEqual([kernelOf('a * 2').kernel]);
    expect(errors).toEqual(['']);
  });

  it('sends a new formula to the running processor right away', async () => {
    const fake = fakeProcessor();
    const { runtime } = setup(async () => fake.processor);

    runtime.submit(kernelOf('a'));
    await tick();
    runtime.submit(kernelOf('b'));

    expect(fake.posted.map(m => m.kernel)).toEqual([kernelOf('a').kernel, kernelOf('b').kernel]);
    expect(fake.posted[1].id).toBe(fake.posted[0].id + 1);
  });

  it('keeps the last valid formula playing when the new one is broken', async () => {
    const fake = fakeProcessor();
    const { runtime } = setup(async () => fake.processor);

    runtime.submit(kernelOf('a'));
    await tick();

    const broken = compile('sin(');
    expect(broken.ok).toBe(false);
    runtime.submit(broken);

    // Сломанная формула ничего не отправила и не заглушила процессор
    expect(fake.posted).toHaveLength(1);
    expect(fake.processor.stop).not.toHaveBeenCalled();

    runtime.submit(kernelOf('b'));
    expect(fake.posted.map(m => m.kernel)).toEqual([kernelOf('a').kernel, kernelOf('b').kernel]);
  });

  it('reports a recoverable error when the processor fails to load and recovers on the next valid formula', async () => {
    const fake = fakeProcessor();
    let attempts = 0;
    const { runtime, lastError } = setup(async () => {
      attempts++;
      if (attempts === 1) throw new Error('no worklet');
      return fake.processor;
    });

    runtime.submit(kernelOf('a'));
    await tick();

    expect(attempts).toBe(1);
    expect(lastError()).toBe(PROCESSOR_LOAD_ERROR);
    expect(fake.posted).toEqual([]);

    // Пользователь снова применил рабочую формулу — процессор поднялся, звук вернулся
    runtime.submit(kernelOf('b'));
    await tick();

    expect(attempts).toBe(2);
    expect(lastError()).toBe('');
    expect(fake.posted.map(m => m.kernel)).toEqual([kernelOf('b').kernel]);
  });

  it('does not start two processors while one is loading', async () => {
    const fake = fakeProcessor();
    let started = 0;
    const { runtime } = setup(async () => (started++, await tick(), fake.processor));

    runtime.submit(kernelOf('a'));
    runtime.submit(kernelOf('a + 1'));
    await tick();
    await tick();

    expect(started).toBe(1);
    // Ушло только последнее ядро
    expect(fake.posted.map(m => m.kernel)).toEqual([kernelOf('a + 1').kernel]);
  });

  it('reports a kernel the processor rejected and clears the error on the next good one', async () => {
    const fake = fakeProcessor();
    const { runtime, lastError } = setup(async () => fake.processor);

    runtime.submit(kernelOf('a'));
    await tick();

    fake.reply({ ok: false, id: fake.posted[0].id, error: 'boom' });
    expect(lastError()).toBe(KERNEL_LOAD_ERROR);

    runtime.submit(kernelOf('b'));
    fake.reply({ ok: true, id: fake.posted[1].id });
    expect(lastError()).toBe('');
  });

  it('ignores replies to stale kernels', async () => {
    const fake = fakeProcessor();
    const { runtime, errors } = setup(async () => fake.processor);

    runtime.submit(kernelOf('a'));
    await tick();
    runtime.submit(kernelOf('b'));

    // Ответ на первое, уже заменённое ядро
    fake.reply({ ok: false, id: fake.posted[0].id, error: 'too late' });
    expect(errors).toEqual(['']);
  });

  it('stops the processor on dispose and ignores late replies', async () => {
    const fake = fakeProcessor();
    const { runtime, errors } = setup(async () => fake.processor);

    runtime.submit(kernelOf('a'));
    await tick();

    runtime.dispose();
    expect(fake.processor.stop).toHaveBeenCalledTimes(1);
    expect(fake.isListening()).toBe(false);

    // Опоздавший ответ старого процессора никуда не доходит
    fake.reply({ ok: false, id: fake.posted[0].id, error: 'ghost' });
    expect(errors).toEqual(['']);
  });

  it('stops a processor that finished loading after dispose', async () => {
    const fake = fakeProcessor();
    let ready!: (processor: TExpressionProcessor) => void;
    const { runtime } = setup(() => new Promise(resolve => ready = resolve));

    runtime.submit(kernelOf('a'));
    runtime.dispose();
    ready(fake.processor);
    await tick();

    expect(fake.processor.stop).toHaveBeenCalledTimes(1);
    expect(fake.isListening()).toBe(false);
    expect(fake.posted).toEqual([]);
  });
});
