import { runEncodeTask, transferablesOf } from '@/core/export/encodeTask';
import type { EncodeReply, EncodeTask } from '@/core/export/encodeTask';

export interface EncodeJob {
  /** The encoded file. Rejects with the message of the encoder when it fails, and with "Cancelled" after `cancel`. */
  result: Promise<Uint8Array>;
  /** Stops the work at once (the worker is ended, nothing is left running). */
  cancel(): void;
}

export const CANCELLED = 'Cancelled';

/**
 * Runs a slow encoder (GIF, APNG, ZIP) in a Web Worker, so the editor stays alive while it works, and gives a way to stop it. The frames
 * and files of the task are handed over, not copied: do not use them afterwards. Without Worker support the work is done here, in a
 * timer, as before (such a run cannot be interrupted, only its result thrown away).
 */
export function encodeInWorker(task: EncodeTask, onProgress?: (fraction: number) => void): EncodeJob {
  let stop = () => {};
  const result = new Promise<Uint8Array>((resolve, reject) => {
    let worker: Worker | null = null;
    try {
      if (typeof Worker !== 'undefined')
        worker = new Worker(new URL('../core/export/encodeWorker.ts', import.meta.url), { type: 'module' });
    } catch {
      worker = null;
    }
    if (!worker) {
      let cancelled = false;
      stop = () => {
        cancelled = true;
        reject(new Error(CANCELLED));
      };
      setTimeout(() => {
        if (cancelled) return;
        try {
          resolve(runEncodeTask(task, onProgress));
        } catch (e) {
          reject(e instanceof Error ? e : new Error(String(e)));
        }
      }, 0);
      return;
    }
    const w = worker;
    stop = () => {
      w.terminate();
      reject(new Error(CANCELLED));
    };
    w.onmessage = (e: MessageEvent<EncodeReply>) => {
      const m = e.data;
      if (m.type === 'progress') return onProgress?.(m.value);
      w.terminate();
      if (m.type === 'done') resolve(m.bytes);
      else reject(new Error(m.message));
    };
    w.onerror = (e) => {
      w.terminate();
      reject(new Error(e.message || 'The encoder stopped unexpectedly'));
    };
    w.postMessage(task, transferablesOf(task));
  });
  return { result, cancel: () => stop() };
}
