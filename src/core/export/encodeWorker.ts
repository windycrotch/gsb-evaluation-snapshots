/** The Web Worker that runs the slow encoders (see encodeTask.ts). One task per message; the answer is progress, then done or error. */
import { runEncodeTask } from './encodeTask';
import type { EncodeReply, EncodeTask } from './encodeTask';

const scope = self as unknown as {
  onmessage: ((e: MessageEvent<EncodeTask>) => void) | null;
  postMessage(message: EncodeReply, transfer?: Transferable[]): void;
};

scope.onmessage = (e) => {
  try {
    const bytes = runEncodeTask(e.data, (value) => scope.postMessage({ type: 'progress', value }));
    scope.postMessage({ type: 'done', bytes }, bytes.buffer instanceof ArrayBuffer ? [bytes.buffer] : []);
  } catch (err) {
    scope.postMessage({ type: 'error', message: err instanceof Error ? err.message : String(err) });
  }
};
