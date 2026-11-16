import { ExpressionRuntime, PROCESSOR_INPUTS, STOP_MESSAGE, processorSource } from "$library/expression";
import { ReadonlySignal, computed, effect, signal, useSignalEffect } from "@preact/signals-react";
import { group, icon } from "../_groups";
import { prop, reactive } from "@vicimpa/decorators";

import { AudioPort } from "../ports/AudioPort";
import { BaseNode } from "../lib/BaseNode";
import { Number } from "../lib/Number";
import { SignalNode } from "../lib/signalNode";
import { SquareFunction } from "lucide-react";
import { ctx } from "../ctx";
import { defineRuntimeWorklet } from "../lib/runtimeWorklet";
import { dispose } from "$library/dispose";
import { name } from "$library/function";
import { pipe } from "../lib/pipe";
import rsp from "@vicimpa/rsp";
import s from "../styles.module.sass";
import { store } from "$components/node-editor";
import { useRef } from "react";

// Один процессор на все ноды Expression: формулы приходят ему сообщением
const processor = () => defineRuntimeWorklet('expression', name => processorSource(name));

type TExpressionFieldProps = {
  text: ReadonlySignal<string>;
  invalid: ReadonlySignal<true | undefined>;
  onBegin: (value: string) => void;
  onDraft: (value: string) => void;
  onCommit: (value: string) => void;
  onCancel: () => void;
};

// Поле формулы: Enter или потеря фокуса — применить, Shift+Enter — перенос строки, Esc — отменить
const ExpressionField = ({ text, invalid, onBegin, onDraft, onCommit, onCancel }: TExpressionFieldProps) => {
  const ref = useRef<HTMLTextAreaElement>(null);
  const cancelled = useRef(false);

  useSignalEffect(() => {
    const value = text.value;

    if (ref.current && document.activeElement !== ref.current)
      ref.current.value = value;
  });

  return (
    <rsp.textarea
      ref={ref}
      className={s.expression}
      data-invalid={invalid}
      defaultValue={text.peek()}
      rows={2}
      spellCheck={false}
      placeholder="sin(TAU * a * t) * b"
      onFocus={e => {
        cancelled.current = false;
        onBegin(e.currentTarget.value);
      }}
      onInput={e => onDraft(e.currentTarget.value)}
      onKeyDown={e => {
        e.stopPropagation();

        if (e.key === 'Escape') {
          // Возврат к сохранённой формуле: на blur уже ничего не применяем
          cancelled.current = true;
          e.currentTarget.value = text.peek();
          e.currentTarget.blur();
        }

        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          e.currentTarget.blur();
        }
      }}
      onBlur={e => {
        if (cancelled.current) {
          cancelled.current = false;
          onCancel();
          return;
        }

        onCommit(e.currentTarget.value);
      }} />
  );
};

@name('Expression')
@group('math')
@icon(SquareFunction)
@reactive()
export default class extends BaseNode {
  #out = new GainNode(ctx);
  #version = 0;

  @store _a = new SignalNode(220, { default: 220 });
  @store _b = new SignalNode(0.5, { default: 0.5 });
  @store _c = new SignalNode(0, { default: 0 });
  @store _d = new SignalNode(0, { default: 0 });

  @prop @store expression = 'sin(TAU * a * t) * b';

  // Зеркало состояния рантайма для реактивности: черновик и счётчик изменений
  _draft = signal<string | null>(null);
  _revision = signal(0);

  // Ошибка загрузки самого процессора; формулы и ядра ведёт рантайм
  _fatal = signal('');

  // Рантайм создаётся лениво: в конструкторе реактивные поля ещё не готовы
  #runtime: ExpressionRuntime | null = null;

  get _runtime() {
    if (!this.#runtime) {
      const source = typeof this.expression === 'string' ? this.expression : '';
      this.#runtime = new ExpressionRuntime(source, {
        onLoadError: () => this._revision.value++,
      });
    }

    return this.#runtime;
  }

  // Проект может прийти по ссылке с чем угодно в этом поле
  _text = computed(() => typeof this.expression === 'string' ? this.expression : '');

  // Пока поле редактируется — ошибка черновика, иначе — сохранённой формулы или загрузки
  _error = computed(() => {
    this._draft.value;
    this._revision.value;

    return this._runtime.error || this._fatal.value;
  });

  _invalid = computed(() => !!this._error.value || undefined);

  _errorView = computed(() => (
    this._error.value && <div className={s.expressionError}>{this._error.value}</div>
  ));

  #setDraft(value: string | null) {
    // Сначала состояние рантайма, потом сигнал: computed не должен увидеть прошлый черновик
    if (value === null)
      this._runtime.cancelDraft();
    else
      this._runtime.setDraft(value);

    this._draft.value = value;
  }

  // Применение черновика: ошибка не меняет играющее ядро, удачная формула — меняет
  #commit(value: string) {
    this._runtime.setDraft(value);
    this._runtime.commitDraft();
    this._draft.value = null;
    this._revision.value++;

    // Сохранённая формула живёт в проекте; если текст изменился — обновляем поле
    if (this.expression !== this._runtime.source)
      this.expression = this._runtime.source;
  }

  #stopNode: (() => void) | null = null;

  async #start(version: number) {
    try {
      const name = await processor();

      if (version !== this.#version)
        return;

      const node = new AudioWorkletNode(ctx, name, {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });

      const unwire = dispose(
        ...PROCESSOR_INPUTS.map(key => pipe(this[`_${key}`], node.parameters.get(key)!)),
        pipe(node, this.#out),
      );

      this.#stopNode = () => {
        node.port.onmessage = null;
        unwire();
        node.port.postMessage(STOP_MESSAGE);
      };

      // Порт процессора — транспорт рантайма: ответы на устаревшие ядра он отбросит сам
      node.port.onmessage = ({ data }) => this._runtime.receive(data);
      this._runtime.attach(message => node.port.postMessage(message));
    } catch (error) {
      if (version !== this.#version)
        return;

      console.error(error);
      this._fatal.value = 'Failed to load the expression processor';
    }
  }

  _connect = () => {
    const version = ++this.#version;
    this.#start(version);

    return dispose(
      effect(() => {
        // Внешняя смена формулы (проект, отмена) тоже доходит до процессора
        const text = this._text.value;

        if (text === this._runtime.source)
          return;

        this._runtime.setSource(text);
        this._revision.value++;
      }),
      () => {
        this.#version++;
        this._fatal.value = '';
        this._runtime.detach();
        this.#stopNode?.();
        this.#stopNode = null;
      },
    );
  };

  output = (
    <AudioPort value={this.#out} output />
  );

  _view = () => (
    <>
      {PROCESSOR_INPUTS.map(key => (
        <Number key={key} label={key} value={this[`_${key}`]} />
      ))}

      <ExpressionField
        text={this._text}
        invalid={this._invalid}
        onBegin={value => this.#setDraft(value)}
        onDraft={value => this.#setDraft(value)}
        onCommit={value => this.#commit(value)}
        onCancel={() => this.#setDraft(null)} />

      {this._errorView}
    </>
  );
}
