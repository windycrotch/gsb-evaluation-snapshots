// Исходник единственного процессора Expression. Ядро из buildKernel приходит сообщением
// { kernel } и собирается внутри worklet — новая формула не регистрирует новый процессор.
// Только доверенный код: ядро из генератора, имя процессора из счётчика.
//
// Контракт замены ядра («换版—失败—回滚—停止»):
//  1. новое ядро сначала собирается и проверяется, и только при успехе подменяет старое;
//  2. при неудаче старое ядро остаётся в работе, звук не прерывается, ошибка уходит в port;
//  3. y1 и звуковой часы (currentFrame/sampleRate) живут на уровне процессора и переживают замену;
//  4. после [STOP] процессор возвращает false из process и больше не принимает никаких замен.

export const PROCESSOR_INPUTS = ['a', 'b', 'c', 'd'] as const;
export const STOP_MESSAGE = '[STOP]';

export const processorSource = (name: string) => {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new Error(`Invalid processor name '${name}'`);

  const descriptors = PROCESSOR_INPUTS.map(name => ({ name, defaultValue: 0, automationRate: 'a-rate' }));
  const reads = PROCESSOR_INPUTS
    .map(key => `p_${key}.length > 1 ? p_${key}[i] : p_${key}[0]`)
    .join(',\n        ');

  return `
registerProcessor(${JSON.stringify(name)}, class extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return ${JSON.stringify(descriptors)};
  }

  running = true;
  // Текущее рабочее ядро. null — формулы ещё не было, выход тихий, но процессор жив.
  kernel = null;
  // Прошлый выходной сэмпл: состояние обратной связи, переживает замену ядра.
  y1 = 0;

  constructor(options) {
    super(options);
    this.port.onmessage = (event) => {
      const data = event.data;

      if (data === ${JSON.stringify(STOP_MESSAGE)}) {
        // Остановка необратима: освобождаем рабочее состояние; обработчик остаётся,
        // но через this.running отклоняет любые последующие замены.
        this.running = false;
        this.kernel = null;
        this.y1 = 0;
        this.port.postMessage({ ok: true, stopped: true });
        return;
      }

      if (!this.running) {
        // Процессор уже остановлен — замена невозможна, сообщаем явно, а не молча игнорируем.
        this.port.postMessage({ ok: false, id: data && typeof data === 'object' ? data.id : undefined, stopped: true, error: 'Processor is stopped' });
        return;
      }

      if (data && typeof data.kernel === 'string') {
        // 1. Сначала пробуем собрать кандидата, старое ядро всё это время продолжает играть.
        let next;
        try {
          next = new Function('return ' + data.kernel)();
        } catch (error) {
          this.port.postMessage({ ok: false, id: data.id, error: String(error) });
          return;
        }

        if (typeof next !== 'function') {
          this.port.postMessage({ ok: false, id: data.id, error: 'Compiled expression is not a function' });
          return;
        }

        // 2. Дымовая проверка: ядро должно отрабатывать на реальных аргументах и давать число.
        //    Упавшее здесь ядро не подменяет текущее — старое продолжает звучать.
        try {
          const probe = next(0, 0, 0, 0, currentFrame / sampleRate, sampleRate, this.y1);
          if (typeof probe !== 'number')
            throw new Error('Expression returned ' + typeof probe);
        } catch (error) {
          this.port.postMessage({ ok: false, id: data.id, error: String(error) });
          return;
        }

        // 3. Только теперь замена. y1 и часы (currentFrame/sampleRate) продолжаются без разрыва.
        this.kernel = next;
        this.port.postMessage({ ok: true, id: data.id });
      }
    };
  }

  process(inputs, outputs, parameters) {
    if (!this.running)
      return false;

    const output = outputs[0];
    const out = output && output[0];

    if (!out)
      return true;

    const kernel = this.kernel;

    if (!kernel) {
      for (let ch = 0; ch < output.length; ch++)
        output[ch].fill(0);
      return true;
    }

    ${PROCESSOR_INPUTS.map(key => `const p_${key} = parameters[${JSON.stringify(key)}];`).join('\n    ')}
    const sr = sampleRate;
    const frame = currentFrame;
    let y1 = this.y1;

    for (let i = 0; i < out.length; i++) {
      let y = kernel(
        ${reads},
        (frame + i) / sr,
        sr,
        y1
      );

      // NaN и бесконечность ломают фильтры дальше по цепочке
      if (!Number.isFinite(y))
        y = 0;

      out[i] = y;
      y1 = y;
    }

    this.y1 = y1;

    for (let ch = 1; ch < output.length; ch++)
      output[ch].set(out);

    return true;
  }
});
`;
};
