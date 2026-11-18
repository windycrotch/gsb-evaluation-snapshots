import { randomUUID } from 'node:crypto';
import { emitDiagnostic } from './trace-log.mjs';

const pending = new WeakMap();

// 每客户端共用一个发送观察者，按预留顺序关联已提交到 socket 的写请求。
export function createOperationLog(client, { operationId = randomUUID(), dedupeKey = null, module = 'automation', request, label } = {}) {
  const fields = { operationId, dedupeKey, module, request, label };
  let sent = false;
  let lastPhase;
  let settled = false;
  const operation = {
    operationId,
    request,
    get sent() { return sent; },
    phase(phase, result, extra = {}) {
      if (settled) return;
      const signature = phase + ':' + result;
      if (signature === lastPhase) return;
      lastPhase = signature;
      if (phase === 'sent') sent = true;
      settled = phase === 'confirmed' || phase === 'cancelled';
      emitDiagnostic(client, 'operation', { ...extra, ...fields, phase, result });
    },
    close() {
      const observer = pending.get(client);
      if (!observer) return;
      observer.operations.delete(operation);
      if (observer.operations.size) return;
      client.off?.('sent', observer.frame);
      client.off?.('close', observer.close);
      client.off?.('state', observer.state);
      pending.delete(client);
    },
  };
  if (typeof client?.on === 'function') {
    if (!pending.has(client)) {
      const operations = new Set();
      const frame = ({ dir, name, seq }) => {
        if (dir !== 'out') return;
        const next = [...operations].find(item => !item.sent && item.request === name);
        next?.phase('sent', 'pending', { seq });
      };
      const close = () => {
        for (const item of [...operations]) {
          item.phase('unknown', 'pending', { reason: '连接已断开，等待业务核对' });
          item.close();
        }
      };
      const state = ({ state }) => {
        if (['STOPPED', 'CLOSED', 'FAILED', 'REJECTED'].includes(state)) close();
      };
      pending.set(client, { operations, frame, close, state });
      client.on('sent', frame);
      client.on('close', close);
      client.on('state', state);
    }
    pending.get(client).operations.add(operation);
  }
  operation.phase('reserved', 'pending');
  return operation;
}
