import { TCompiled, blockProcessorSource, paramName } from "$library/blockCompiler";

import { STOP_MESSAGE } from "$library/expression";
import { SignalNode } from "../lib/signalNode";
import type { TPair } from "./routing";
import { ctx } from "../ctx";
import { defineRuntimeWorklet } from "../lib/runtimeWorklet";
import { dispose } from "$library/dispose";
import { pipe } from "../lib/pipe";

// Скомпилированный блок, который сейчас звучит
export type TProgram = {
  key: string;
  signals: unknown[];
  // Соединения «вход блока → выход блока» мимо процессора
  passthrough: TPair<AudioNode>[];
  stop(): void;
};

type TBuildOptions = {
  key: string;
  result: TCompiled;
  signals: unknown[];
  defaults: number[];
  outer(id: string): AudioNode;
  onError(): void;
  // Внедряется в тестах: регистрация процессора без настоящего AudioWorklet
  register?: (key: string, build: (name: string) => string) => Promise<string>;
  // Фабрика AudioWorkletNode; в проде путь не задаётся и берётся настоящий конструктор
  createNode?: (processor: string, result: TCompiled) => AudioWorkletNode;
};

// Один отключённый конец не должен мешать снять остальные: иначе сбойный disconnect
// оставил бы процессор подключённым к выходу после удаления блока.
const safe = (fn: () => void) => () => {
  try {
    fn();
  } catch (e) {
    console.error(e);
  }
};

// Один AudioWorkletNode на весь блок: вход процессора на каждый входной слот, выход — на выходной.
// Каждый вход и выход — один канал: внутри блока всё моно, как и у параметров нод.
export async function buildProgram({
  key,
  result,
  signals,
  defaults,
  outer,
  onError,
  register = (workletKey, build) => defineRuntimeWorklet(workletKey, build),
  createNode,
}: TBuildOptions): Promise<TProgram> {
  const passthrough = result.passthrough.map(([a, b]): TPair<AudioNode> => [outer(a), outer(b)]);

  if (!result.outputs.length)
    return { key, signals, passthrough, stop() { } };

  const processor = await register(`block:${result.source}`, name => blockProcessorSource(name, result));
  const node = createNode
    ? createNode(processor, result)
    : new AudioWorkletNode(ctx, processor, {
      numberOfInputs: result.inputs.length,
      numberOfOutputs: result.outputs.length,
      outputChannelCount: result.outputs.map(() => 1),
      channelCount: 1,
      channelCountMode: 'explicit',
      channelInterpretation: 'speakers',
    });

  node.onprocessorerror = onError;

  const unwire = dispose(
    ...result.inputs.map((id, k) => {
      const gain = outer(id);
      gain.connect(node, 0, k);
      return safe(() => gain.disconnect(node, 0, k));
    }),
    ...result.outputs.map((id, k) => {
      const gain = outer(id);
      node.connect(gain, k, 0);
      return safe(() => node.disconnect(gain, k, 0));
    }),
    ...result.params.map((_, k) => {
      const param = node.parameters.get(paramName(k))!;
      const signal = signals[k];

      // Значение без провода идёт из ConstantSourceNode самой ноды: ручки работают без перекомпиляции
      if (signal instanceof SignalNode) {
        param.value = 0;
        const unpipe = pipe(signal.node, param);
        return safe(unpipe);
      }

      param.value = defaults[k];
    }),
  );

  // Узел остаётся в живом графе только пока программа активна: stop снимает все провода,
  // параметрные соединения и гасит процессор, чтобы после удаления блока ничего не звучало.
  return {
    key,
    signals,
    passthrough,
    stop() {
      node.onprocessorerror = null;
      unwire();

      try {
        node.port.postMessage(STOP_MESSAGE);
      } catch (e) {
        console.error(e);
      }

      try {
        node.disconnect();
      } catch (e) {
        console.error(e);
      }
    },
  };
}
