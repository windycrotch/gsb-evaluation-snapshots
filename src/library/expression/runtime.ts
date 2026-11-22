// Жизненный цикл процессора Expression: какая формула должна звучать и что делать,
// пока процессор не готов, не загрузился или его убрали. Про Web Audio ничего не знает —
// процессор создаёт фабрика `connect`, ядра уходят в него сообщениями.

// Ответ процессора на присланное ядро
export type TKernelReply = { ok: boolean; id?: number; error?: unknown; };

// Живой процессор глазами рантайма
export type TExpressionProcessor = {
  // Отправить ядро; ответ придёт в обработчик с тем же id
  post(message: { kernel: string; id: number; }): void;
  // Слушать ответы процессора; null — больше не слушать
  listen(handler: ((reply: TKernelReply) => void) | null): void;
  // Остановить процессор и отсоединить его от графа
  stop(): void;
};

// Результат разбора формулы: ядро готово или формула сломана
export type TKernelResult = { ok: true; kernel: string; } | { ok: false; };

export const PROCESSOR_LOAD_ERROR = 'Failed to load the expression processor';
export const KERNEL_LOAD_ERROR = 'Failed to load the compiled expression';

export class ExpressionRuntime {
  // Ядро, которое должно играть
  #kernel: string | null = null;
  #processor: TExpressionProcessor | null = null;
  #sent = 0;
  #version = 0;
  #starting = false;

  constructor(
    // Поднять процессор; отказ промиса — загрузка не удалась, можно пробовать снова
    private connect: () => Promise<TExpressionProcessor>,
    // Показать ошибку пользователю; пустая строка — ошибки нет
    private showError: (message: string) => void,
  ) { }

  // Формула из поля после разбора. Сломанная ядро не меняет:
  // продолжает играть последняя рабочая, процессор не глушится.
  submit(result: TKernelResult) {
    if (!result.ok)
      return;

    this.#kernel = result.kernel;
    this.#send();

    // Процессора нет: ещё не стартовал или прошлая загрузка не удалась — поднимаем заново
    if (!this.#processor)
      this.#start();
  }

  // Ноду убрали или переподключили: процессор молчит и никому не отвечает
  dispose() {
    this.#version++;
    const processor = this.#processor;
    this.#processor = null;

    if (processor) {
      processor.listen(null);
      processor.stop();
    }
  }

  #send() {
    if (!this.#processor || this.#kernel === null)
      return;

    this.#processor.post({ kernel: this.#kernel, id: ++this.#sent });
  }

  #start() {
    if (this.#starting)
      return;

    this.#starting = true;
    const version = this.#version;

    this.connect().then(
      processor => {
        this.#starting = false;

        // Пока грузились, ноду отключили: свежий процессор сразу глушим
        if (version !== this.#version) {
          processor.stop();
          return;
        }

        this.#processor = processor;
        processor.listen(reply => this.#reply(reply));
        this.showError('');
        this.#send();
      },
      error => {
        this.#starting = false;
        console.error(error);

        // Ошибка восстановимая: следующая рабочая формула поднимет процессор снова
        if (version === this.#version)
          this.showError(PROCESSOR_LOAD_ERROR);
      },
    );
  }

  #reply(reply: TKernelReply | null) {
    // Ответ на устаревшее ядро не интересен
    if (!reply || reply.id !== this.#sent)
      return;

    if (!reply.ok)
      console.error(reply.error);

    this.showError(reply.ok ? '' : KERNEL_LOAD_ERROR);
  }
}
