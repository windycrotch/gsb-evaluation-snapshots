import { CompileResult, compile } from "./compile";

// Сообщение с ядром: id растёт с каждым отправленным ядром
export type KernelMessage = { kernel: string; id: number; };

// Ответ процессора на конкретное сообщение
export type KernelAck = { ok: boolean; id?: number; error?: string; };

export const LOAD_ERROR = 'Failed to load the compiled expression';

const asText = (value: unknown) => typeof value === 'string' ? value : '';

const errorText = (result: CompileResult) => result.ok ? '' : `${result.error}`;

/**
 * Состояние одного узла Expression.
 *
 * - Хранит последнее удачно скомпилированное ядро и отправляет его в процессор.
 * - Черновик (`draft`) живёт отдельно от сохранённой формулы: его ошибки видны
 *   в редакторе, но на звук не влияют, пока черновик не применён.
 * - Применение ошибочного текста не заменяет играющее ядро: остаётся прошлая
 *   удачная формула. Если удачной формулы ещё не было, ядра нет — процессор молчит.
 * - Ответ процессора на устаревшее ядро (id не совпадает с последним отправленным)
 *   не меняет состояние.
 *
 * Рантайм ничего не регистрирует: процессор один на узел, меняются только ядра.
 */
export class ExpressionRuntime {
  #source = '';
  #draft: string | null = null;
  #saved: CompileResult;
  #kernel: string | null = null;
  #send: ((message: KernelMessage) => void) | null = null;
  #sent = 0;
  #loadError = '';
  #onLoadError?: (message: string) => void;

  constructor(source = '', options: { onLoadError?: (message: string) => void; } = {}) {
    this.#onLoadError = options.onLoadError;
    this.#source = asText(source);
    this.#saved = compile(this.#source);

    if (this.#saved.ok)
      this.#kernel = this.#saved.kernel;
  }

  // Формула, сохранённая в проекте
  get source() {
    return this.#source;
  }

  // Черновик редактора; null — поле не редактируется
  get draft() {
    return this.#draft;
  }

  // Результат разбора сохранённой формулы (нужен и после ошибки)
  get saved() {
    return this.#saved;
  }

  // Ядро, которое должно играть; null — удачных формул ещё не было
  get kernel() {
    return this.#kernel;
  }

  // Ошибка загрузки ядра в процессоре (пустая строка — ошибки нет)
  get loadError() {
    return this.#loadError;
  }

  // Ошибка, которую видит нода: пока идёт ввод — ошибка черновика, иначе сохранённой формулы
  get error() {
    if (this.#draft !== null)
      return this.draftError(this.#draft);

    return errorText(this.#saved) || this.#loadError;
  }

  get invalid() {
    return this.error ? true : undefined;
  }

  // Ошибка произвольного черновика; пустая строка, если он корректен
  draftError(draft: string | null) {
    if (draft === null)
      return '';

    return errorText(compile(draft));
  }

  // Начало редактирования: черновик — текущий текст поля
  beginDraft(text: string) {
    this.setDraft(text);
  }

  setDraft(text: string) {
    this.#draft = asText(text);
  }

  // Esc: черновик отбрасывается, редактор показывает сохранённую формулу
  cancelDraft() {
    this.#draft = null;
  }

  /**
   * Enter или потеря фокуса: черновик становится сохранённой формулой.
   * Удачная формула становится играющим ядром, ошибочная — только показывается.
   * Возвращает результат разбора или null, если черновика не было.
   */
  commitDraft() {
    if (this.#draft === null)
      return null;

    const draft = this.#draft;
    this.#draft = null;

    // Тот же текст — нечего пересобирать и нечего отправлять заново
    if (draft === this.#source && this.#saved.ok)
      return this.#saved;

    return this.setSource(draft);
  }

  /**
   * Записывает новую сохранённую формулу.
   * Возвращает результат разбора. Играющее ядро меняется только при успехе.
   */
  setSource(source: string) {
    this.#source = asText(source);
    this.#saved = compile(this.#source);

    if (!this.#saved.ok)
      return this.#saved;

    this.#kernel = this.#saved.kernel;
    this.#setLoadError('');
    this.#emit();
    return this.#saved;
  }

  // Подключает транспорт к процессору и сразу отправляет текущее ядро, если оно есть
  attach(send: (message: KernelMessage) => void) {
    this.#send = send;
    this.#emit();
  }

  detach() {
    // id не сбрасываем: новый процессор начинает с kernelId = 0 и примет любой наш id,
    // а прежние ответы всё равно приходят только через отвязанный порт
    this.#send = null;
  }

  // Ответ процессора на отправленное ядро
  receive(data: unknown) {
    if (!data || typeof data !== 'object')
      return;

    const ack = data as KernelAck;

    // Ответ на устаревшее или неизвестное ядро не должен менять новое состояние
    if (ack.id !== this.#sent)
      return;

    this.#setLoadError(ack.ok ? '' : asText(ack.error) || LOAD_ERROR);
  }

  #emit() {
    if (!this.#send || this.#kernel === null)
      return;

    const id = ++this.#sent;
    this.#send({ kernel: this.#kernel, id });
  }

  #setLoadError(message: string) {
    if (message === this.#loadError)
      return;

    this.#loadError = message;
    this.#onLoadError?.(message);
  }
}
