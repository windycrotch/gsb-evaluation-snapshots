import { TCompiled, TGraph, compileBlock, paramDefaults, templates } from "$library/blockCompiler";
import { checkPorts, programSignals } from "./ports";
import type { TProgram } from "./program";
import type { NodeItem } from "$components/node-editor";
import { Routing, TPair, bridgePairs } from "./routing";
import type { TSlot } from "./state";

// Хост — всё, что контроллеру нужно от ноды Group, но без React/DOM.
// Так вся машина переключения Compiled проверяется на самодельных узлах и заглушках.
export type TCompileHost = {
  // Внешний GainNode слота (порт блока): к нему подключается процессор и внешние провода
  outerGain(id: string): AudioNode;
  // Внутренний GainNode слота (порт Group Input/Output)
  innerGain(id: string): AudioNode;
  // Маршрутизатор мостов/обходов, общий с хостом
  routing: Routing<AudioNode>;
  // Слоты блока
  getSlots(): TSlot[];
  // Внутренний проект: живые ноды
  getNodes(): NodeItem[];
  serialize(nodes: NodeItem[]): { data: TGraph; };
  // Готов ли граф к сборке: грузится/сломан/не все ноды смонтированы
  isReady(): { ok: boolean; broken: boolean; };
  // Собрать звучащую программу (внедряется, чтобы тест подставил заглушку регистрации)
  buildProgram(options: TBuildProgramArgs): Promise<TProgram>;
  // Колбэки состояния для UI ноды
  onProgram(program: TProgram | null): void;
  onError(reason: string): void;
  // Таймеры, чтобы тест мог гонять их детерминированно
  schedule(fn: () => void, ms: number): Handle;
  clear(handle: Handle): void;
};

export type TBuildProgramArgs = {
  key: string;
  result: TCompiled;
  signals: unknown[];
  defaults: number[];
  outer: (id: string) => AudioNode;
  onError: () => void;
};

type Handle = ReturnType<typeof setTimeout> | number | undefined;

export const COMPILE_DEBOUNCE_MS = 250;
export const COMPILE_RETRY_MS = 500;
const MAX_PORT_RETRIES = 3;

// Конечный автомат переключателя Compiled.
// Инварианты:
//  - пока сборки нет/она упала, блок звучит обычными нодами через мосты (тишина невозможна);
//  - успех подменяет программу только если это ещё актуальный запрос (версия защищает от
//    опоздавших асинхронных регистраций при быстрых кликах);
//  - выключение и удаление гасят таймеры, версию и текущую программу;
//  - мосты при выключении восстанавливаются тем же набором пар, что был до компиляции.
export class CompileController {
  #host: TCompileHost;
  #timer: Handle = undefined;
  #version = 0;
  #portRetries = 0;

  // Живёт, только когда блок реально скомпилирован и звучит процессором
  program: TProgram | null = null;
  // '' — ошибки нет; иначе причина, показываемая на лице блока
  error = '';

  constructor(host: TCompileHost) {
    this.#host = host;
  }

  // Мосты для нескомпилированного блока: внешний ↔ внутренний GainNode каждого слота
  bridges(): TPair<AudioNode>[] {
    return bridgePairs(this.#host.getSlots(), id => this.#host.outerGain(id), id => this.#host.innerGain(id));
  }

  // Пересчитывает маршруты слотов под текущую программу.
  // С программой — только обходы «вход → выход» мимо процессора; без неё — полные мосты.
  syncRouting() {
    this.#host.routing.set(this.program ? this.program.passthrough : this.bridges());
  }

  // Перекомпиляция после изменения структуры (ноды, провода, слоты, структурные поля).
  // Свежая структурная перезапускает отсчёт попыток дождаться перемонтирования портов.
  scheduleCompile(ms: number = COMPILE_DEBOUNCE_MS, resetRetries = false) {
    if (resetRetries)
      this.#portRetries = 0;

    this.#host.clear(this.#timer);
    this.#timer = this.#host.schedule(() => {
      this.#timer = undefined;
      void this.recompile();
    }, ms);
  }

  // Один цикл сборки. Повторный вызов делает прошлый результат неактуальным (#version).
  async recompile() {
    const version = ++this.#version;
    const host = this.#host;
    const { ok, broken } = host.isReady();

    if (broken)
      return this.#fail(version, 'Block graph failed to load');

    if (!ok) {
      // Граф ещё грузится или ноды не домонтированы: пробуем позже, не трогая звук
      if (version === this.#version)
        this.scheduleCompile(COMPILE_RETRY_MS);
      return;
    }

    const nodes = host.getNodes();
    const { data } = host.serialize(nodes);
    const result = compileBlock(data);

    if (!result.ok)
      return this.#fail(version, result.reason);

    const mismatch = checkPorts(nodes, data);

    // Порты могли ещё не перемонтироваться (например, после смены операции Math): ждём немного
    if (mismatch && this.#portRetries++ < MAX_PORT_RETRIES) {
      if (version === this.#version)
        this.scheduleCompile(COMPILE_RETRY_MS);
      return;
    }

    if (mismatch)
      return this.#fail(version, mismatch);

    this.#portRetries = 0;

    const key = JSON.stringify([result.source, result.inputs, result.outputs, result.passthrough]);
    const signals = programSignals(nodes, result);
    const current = this.program;

    // Поменялись только значения или позиции — программа та же, процессор не перерегистрируем
    if (current && current.key === key && current.signals.every((signal, i) => signal === signals[i])) {
      this.error = '';
      host.onError('');
      return;
    }

    let program: TProgram;

    try {
      program = await host.buildProgram({
        key,
        result,
        signals,
        defaults: paramDefaults(data, result.params),
        outer: id => host.outerGain(id),
        onError: () => {
          // Процессор упал уже после запуска: возвращаем блок на обычные ноды и показываем причину
          if (this.program === program)
            this.failRuntime('Compiled block stopped with an error');
        },
      });
    } catch (e) {
      console.error(e);
      return this.#fail(version, 'Cannot load the compiled block');
    }

    // Опоздавший результат прошлой регистрации не должен перекрыть текущее состояние
    if (version !== this.#version) {
      program.stop();
      return;
    }

    this.error = '';
    host.onError('');
    this.#setProgram(program);
  }

  // Процессор упал во время работы: блок остаётся в положении ON, но звучит нодами
  failRuntime(reason: string) {
    this.error = reason;
    this.#host.onError(reason);
    this.#setProgram(null);
  }

  #fail(version: number, reason: string) {
    if (version !== this.#version)
      return;

    this.error = reason;
    this.#host.onError(reason);
    this.#setProgram(null);
  }

  // Новая программа уже подключена внутри buildProgram: переключаем маршруты, потом гасим старую
  #setProgram(program: TProgram | null) {
    const old = this.program;

    if (old === program)
      return;

    this.program = program;
    this.#host.onProgram(program);
    old?.stop();
  }

  // Выключение Compiled: немедленно гасим таймеры/версию и возвращаем мосты
  stop() {
    this.#version++;
    this.#host.clear(this.#timer);
    this.#timer = undefined;
    this.#portRetries = 0;
    this.error = '';
    this.#host.onError('');
    this.#setProgram(null);
  }

  // Полный teardown при удалении блока/закрытии проекта
  dispose() {
    this.stop();
    this.#host.routing.clear();
  }

  get isCompiled() {
    return this.program !== null;
  }
}

// Значения структурных полей, от которых зависит сгенерированный код.
// Хост вызывает это внутри signal-effect, чтобы любое изменение планировало перекомпиляцию.
export const trackStructure = (
  nodes: NodeItem[],
  typeOf: (node: NodeItem) => string | undefined,
  read: (node: NodeItem, key: string) => unknown,
) => {
  for (const node of nodes) {
    const type = typeOf(node);

    if (!type || !Object.hasOwn(templates, type))
      continue;

    for (const key of templates[type].structural) {
      const value = read(node, key);

      if (value && typeof value === 'object' && 'value' in value)
        (value as { value: unknown }).value;
    }
  }
};
