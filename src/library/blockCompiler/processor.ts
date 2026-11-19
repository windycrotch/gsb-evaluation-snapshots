import { STOP_MESSAGE } from "$library/expression";
import type { TCompiled } from "./compile";

export const paramName = (index: number) => `k${index}`;

// Исходник модуля AudioWorklet для скомпилированного блока. Только доверенный код:
// фабрика из compileBlock, имя процессора из счётчика.
// Каждый слот — отдельный вход/выход процессора с одним каналом.
//
// Контракт замены версии («换版—失败—回滚—停止»):
//  1. новая фабрика приходит сообщением { source }, сначала собирается и прогоняется на
//     блоке тишины; только при успехе подменяет текущую — иначе старая версия продолжает играть;
//  2. по умолчанию состояние версии (Memory, фазы LFO, счётчики, y1) продолжается: фабрике
//     передаётся прежний объект состояния; { reset: true } явно сбрасывает его в исходное;
//  3. результат каждой замены с пояснением о судьбе состояния уходит обратно через port;
//  4. [STOP] необратим: состояние освобождается, process возвращает false, замены не принимаются.
export const blockProcessorSource = (name: string, { source, inputs, outputs, params }: TCompiled) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new Error(`Invalid processor name '${name}'`);

  const descriptors = params.map((_, k) => ({ name: paramName(k), defaultValue: 0, automationRate: 'a-rate' }));
  const inCount = inputs.length;
  const outCount = outputs.length;
  const paramCount = params.length;

  return `
const initialFactory = ${source};

registerProcessor(${JSON.stringify(name)}, class extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return ${JSON.stringify(descriptors)};
  }

  running = true;
  // Текущая рабочая версия: функция обработки и её состояние (s внутри фабрики).
  run = null;
  state = null;
  ins = new Array(${inCount}).fill(undefined);
  outs = new Array(${outCount}).fill(undefined);
  ps = new Array(${paramCount}).fill(undefined);

  constructor(options) {
    super(options);

    try {
      const built = this.#build(initialFactory, sampleRate, null);
      this.run = built.run;
      this.state = built.state;
    } catch (error) {
      // Заводская сборка из доверенного компилятора не должна падать, но если упала —
      // процессор остаётся живым и тихим, причина уходит в port для наблюдаемости.
      this.port.postMessage({ ok: false, phase: 'initial', error: String(error) });
    }

    this.port.onmessage = (event) => {
      const data = event.data;

      if (data === ${JSON.stringify(STOP_MESSAGE)}) {
        // Остановка необратима: освобождаем состояние, process дальше вернёт false.
        this.running = false;
        this.run = null;
        this.state = null;
        this.port.postMessage({ ok: true, stopped: true });
        return;
      }

      if (!this.running) {
        this.port.postMessage({ ok: false, id: data && typeof data === 'object' ? data.id : undefined, stopped: true, error: 'Processor is stopped' });
        return;
      }

      if (data && typeof data === 'object' && typeof data.source === 'string')
        this.#replace(data);
    };
  }

  // Собирает фабрику из исходника и прогоняет её на блоке тишины, прежде чем
  // версия сможет попасть в process. previousState — состояние прежней версии или null.
  #build(factory, sr, previousState) {
    if (typeof factory !== 'function')
      throw new Error('Compiled block is not a factory function');

    // Фабрика сама пересаживает ключи прежнего состояния в свежее (см. compileBlock).
    const run = factory(sr, previousState);

    if (typeof run !== 'function')
      throw new Error('Compiled block factory did not return a run function');

    const state = run.state ?? null;

    // Дымовая проверка: версия, которая падает или пишет нечисловые значения,
    // до process не допускается — текущая версия остаётся звучать.
    const probeIns = new Array(${inCount});
    const probeOuts = new Array(${outCount});

    for (let k = 0; k < ${outCount}; k++)
      probeOuts[k] = new Float32Array(128);

    const probePs = new Array(${paramCount}).fill(new Float32Array(128));
    run(probeIns, probeOuts, probePs, 128, currentFrame);

    for (let k = 0; k < ${outCount}; k++)
      for (let i = 0; i < probeOuts[k].length; i++)
        if (typeof probeOuts[k][i] !== 'number')
          throw new Error('Compiled block produced a non-number output');

    return { run, state };
  }

  #replace(data) {
    const previous = this.run;
    const previousState = this.state;
    const reset = data.reset === true;

    let nextFactory;
    try {
      nextFactory = new Function('return ' + data.source)();
    } catch (error) {
      // Исходник не собрался — старая версия и её состояние остаются в работе.
      this.port.postMessage({ ok: false, id: data.id, error: String(error), kept: 'previous' });
      return;
    }

    let built;
    try {
      built = this.#build(nextFactory, sampleRate, reset ? null : previousState);
    } catch (error) {
      // Проверка не удалась — никаких замен: продолжает звучать предыдущая версия.
      this.port.postMessage({ ok: false, id: data.id, error: String(error), kept: 'previous' });
      return;
    }

    this.run = built.run;
    this.state = built.state;
    this.port.postMessage({
      ok: true,
      id: data.id,
      // Судьба состояния (Memory, фазы LFO, Counter, y1): продолжено или явно сброшено.
      state: reset || !previous ? 'reset' : 'continued',
    });
  }

  process(inputs, outputs, parameters) {
    if (!this.running)
      return false;

    const first = outputs[0] && outputs[0][0];

    if (!first)
      return true;

    // Рабочей версии нет (или она не собралась) — честная тишина, процессор жив и ждёт замену.
    if (!this.run) {
      for (let k = 0; k < ${outCount}; k++)
        if (outputs[k])
          for (let ch = 0; ch < outputs[k].length; ch++)
            outputs[k][ch].fill(0);
      return true;
    }

    for (let k = 0; k < ${inCount}; k++) {
      const input = inputs[k];
      this.ins[k] = input && input[0];
    }

    for (let k = 0; k < ${outCount}; k++)
      this.outs[k] = outputs[k][0];

    for (let k = 0; k < ${paramCount}; k++)
      this.ps[k] = parameters["k" + k];

    this.run(this.ins, this.outs, this.ps, first.length, currentFrame);

    for (let k = 0; k < ${outCount}; k++)
      for (let ch = 1; ch < outputs[k].length; ch++)
        outputs[k][ch].set(outputs[k][0]);

    return true;
  }
});
`;
};
