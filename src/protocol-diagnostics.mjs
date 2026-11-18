import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inspectGameFrame } from './frame-header.mjs';
import { redactLog } from './trace-log.mjs';

const MAX_FRAME_BYTES = 256 * 1024;
const MAX_FILES = 100;
const FILE_PATTERN = /^decode-\d{4}-\d{2}-\d{2}T[\d-]+Z-[\da-f-]{36}\.json$/;

// 原始二进制只写本机独立快照，不进 SSE、终端或普通轮转日志。
export function createProtocolDiagnostics(directory) {
  const root = path.resolve(directory);
  return {
    save(event, context = {}) {
      try {
        const frame = event.frame instanceof Uint8Array ? event.frame : null;
        const { version, name, seq, flag, payloadOffset } = event.header ?? {};
        const loginHeader = event.phase === 'login' && version === 2 && typeof name === 'string'
          && /^[A-Za-z_][A-Za-z0-9_]{0,126}$/.test(name) && Number.isInteger(seq)
          ? { version, name, seq, flag, payloadOffset } : null;
        const header = frame ? inspectGameFrame(frame) : loginHeader;
        const omitted = event.phase === 'login' ? '登录阶段不保存原始报文'
          : !header ? '报文头无效，无法排除认证内容'
          : /login|auth|token|credential|sessionkey/i.test(header.name) ? '认证消息不保存原始报文' : null;
        const captured = omitted ? null : frame.subarray(0, MAX_FRAME_BYTES);
        const createdAt = new Date().toISOString();
        const snapshot = redactLog({
          schemaVersion: 1, createdAt, ...context,
          phase: event.phase, error: event.error, header,
          frameBytes: frame?.byteLength ?? event.frameBytes ?? 0,
          capturedBytes: captured?.byteLength ?? 0,
          truncated: !!captured && captured.byteLength < frame.byteLength,
          rawOmitted: omitted,
          sendSeqNo: event.sendSeqNo, recvSeqNo: event.recvSeqNo,
          pending: event.pending, watchers: event.watchers, recentFrames: event.recentFrames,
        });
        // Hex 内容不可做文本替换，否则原始协议无法重放。认证内容在上面整体省略。
        if (captured) snapshot.frameHex = Buffer.from(captured).toString('hex');
        fs.mkdirSync(root, { recursive: true });
        const filename = `decode-${createdAt.replace(/[:.]/g, '-')}-${randomUUID()}.json`;
        const file = path.join(root, filename);
        fs.writeFileSync(file, JSON.stringify(snapshot, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
        // 只清理由本模块生成的快照，普通日志的高频轮转不会覆盖错误现场。
        try {
          const files = fs.readdirSync(root).filter(name => name !== filename && FILE_PATTERN.test(name)).sort();
          for (const name of files.slice(0, Math.max(0, files.length + 1 - MAX_FILES))) {
            try { fs.unlinkSync(path.join(root, name)); } catch { /* 清理失败不抹去新快照。 */ }
          }
        } catch { /* 已保存快照仍然有效。 */ }
        return { file, header, frameBytes: snapshot.frameBytes, capturedBytes: snapshot.capturedBytes,
          truncated: snapshot.truncated, rawOmitted: omitted };
      } catch (error) {
        return { error: redactLog(String(error?.message ?? error)) };
      }
    },
  };
}
