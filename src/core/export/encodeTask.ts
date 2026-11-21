/**
 * The slow encoders of the exports as one message-shaped function, so they can run in a Web Worker (encodeWorker.ts) and be tested here
 * without one: a GIF of a long animation takes seconds, and on the main thread that freezes the whole editor.
 */
import { encodeApng } from './apng';
import type { ApngOptions } from './apng';
import { encodeGif } from './gif';
import type { GifOptions } from './gif';
import { createZip } from './zip';
import type { ZipEntry } from './zip';

export type EncodeTask =
  | { kind: 'gif'; frames: Uint8ClampedArray[]; options: Omit<GifOptions, 'onProgress'> }
  | { kind: 'apng'; frames: Uint8Array[]; options: ApngOptions }
  | { kind: 'zip'; files: ZipEntry[] };

/** What the worker sends back. */
export type EncodeReply = { type: 'progress'; value: number } | { type: 'done'; bytes: Uint8Array } | { type: 'error'; message: string };

/** Runs a task; `onProgress` gets a number from 0 to 1 when the encoder can tell how far it is (only the GIF encoder can). */
export function runEncodeTask(task: EncodeTask, onProgress?: (fraction: number) => void): Uint8Array {
  switch (task.kind) {
    case 'gif':
      return encodeGif(task.frames, { ...task.options, onProgress: (done, total) => onProgress?.(done / total) });
    case 'apng':
      return encodeApng(task.frames, task.options);
    case 'zip':
      return createZip(task.files);
  }
}

/** The buffers a task owns, to hand to the worker instead of copying (each one once: two views may share a buffer). */
export function transferablesOf(task: EncodeTask): ArrayBuffer[] {
  const views: ArrayBufferView[] = task.kind === 'zip' ? task.files.map((f) => f.data) : task.frames;
  const seen = new Set<ArrayBuffer>();
  for (const v of views) if (v.buffer instanceof ArrayBuffer) seen.add(v.buffer);
  return [...seen];
}
