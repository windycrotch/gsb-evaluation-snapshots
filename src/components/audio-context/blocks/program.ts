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
  // Топология (число входов/выходов/параметров и их слоты). Совпала — возможна горячая замена.
  topology: TTopology;
  // Горячая замена фабрики внутри того же AudioWorkletNode.
  // Резолвится результатом процессора: { ok: true } или { ok: false, error } —
  // в обоих случаях прежняя версия остаётся рабочей, если замена не принята.
  swap?(next: TCompiled): Promise<TSwapResult>;
};

type TTopology = {
  inputs: string[];
  outputs: string[];
  paramCount: number;
};

export type TSwapResult = { ok: boolean; error?: string; state?: 'reset' | 'continued'; };

type TBuildOptions = {
  key: string;
  result: TCompiled;
  signals: unknown[];
  defaults: number[];
  outer(id: string): AudioNode;
  onError(): void;
};

const topologyOf = (result: TCompiled): TTopology => ({
  inputs: result.inputs,
  outputs: result.outputs,
  paramCount: result.params.length,
});

const sameTopology = (a: TTopology, b: TTopology) => (
  a.paramCount === b.paramCount &&
  a.inputs.length === b.inputs.length &&
  a.outputs.length === b.outputs.length &&
  a.inputs.every((id, k) => id === b.inputs[k]) &&
  a.outputs.every((id, k) => id === b.outputs[k])
);

// Один AudioWorkletNode на весь блок: вход процессора на каждый входной слот, выход — на выходной.
// Каждый вход и выход — один канал: внутри блока всё моно, как и у параметров нод.
export async function buildProgram({ key, result, signals, defaults, outer, onError }: TBuildOptions): Promise<TProgram> {
  const passthrough = result.passthrough.map(([a, b]): TPair<AudioNode> => [outer(a), outer(b)]);

  if (!result.outputs.length)
    return { key, signals, passthrough, topology: topologyOf(result), stop() { } };

  const processor = await defineRuntimeWorklet(`block:${result.source}`, name => blockProcessorSource(name, result));
  const node = new AudioWorkletNode(ctx, processor, {
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
      return () => gain.disconnect(node, 0, k);
    }),
    ...result.outputs.map((id, k) => {
      const gain = outer(id);
      node.connect(gain, k, 0);
      return () => node.disconnect(gain, k, 0);
    }),
    ...result.params.map((_, k) => {
      const param = node.parameters.get(paramName(k))!;
      const signal = signals[k];

      // Значение без провода идёт из ConstantSourceNode самой ноды: ручки работают без перекомпиляции
      if (signal instanceof SignalNode) {
        param.value = 0;
        return pipe(signal.node, param);
      }

      param.value = defaults[k];
    }),
  );

  const topology = topologyOf(result);

  return {
    key,
    signals,
    passthrough,
    topology,

    // Горячая замена: только при неизменной топологии и параметрах. Процессор сначала
    // собирает и проверяет новую фабрику и лишь потом подменяет текущую; при неудаче
    // возвращается { ok: false, error }, а звук продолжает идти из прежней версии.
    swap(next: TCompiled) {
      if (!sameTopology(topology, topologyOf(next)))
        return Promise.resolve<TSwapResult>({ ok: false, error: 'Block topology changed' });

      return new Promise<TSwapResult>(resolve => {
        const { port } = node;

        const onReply = ({ data }: MessageEvent) => {
          if (!data || typeof data !== 'object' || data.id !== 1)
            return;

          port.onmessage = null;
          resolve({ ok: data.ok === true, error: data.error, state: data.state });
        };

        port.onmessage = onReply;
        // Состояние (Memory, фазы LFO, Counter, y1) переносится в новую фабрику.
        port.postMessage({ source: next.source, reset: false, id: 1 });
      });
    },

    stop() {
      node.onprocessorerror = null;
      node.port.onmessage = null;
      unwire();
      node.port.postMessage(STOP_MESSAGE);
    },
  };
}
