// Synchronous JSON transactions shared by settings and the usage ledger.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const heldLocks = new Set();
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

/** @param {unknown} error @param {string} code */
function hasCode(error, code) {
  return error instanceof Error && 'code' in error && error.code === code;
}

/** @template T @param {() => T} work @returns {T} */
function windowsFileRetry(work) {
  const deadline = performance.now() + 1000;
  for (;;) {
    try { return work(); }
    catch (error) {
      if (process.platform !== 'win32' || performance.now() >= deadline
        || !['EPERM', 'EACCES', 'EBUSY'].some(code => hasCode(error, code))) throw error;
      // A short-lived reader or antivirus handle can prevent replacement.
      Atomics.wait(waitBuffer, 0, 0, 5);
    }
  }
}

/** @template T @param {string} file @param {T} fallback @returns {T} */
export function readJson(file, fallback) {
  try { return JSON.parse(windowsFileRetry(() => fs.readFileSync(file, 'utf8'))); }
  catch (error) {
    if (hasCode(error, 'ENOENT')) return fallback;
    throw new Error(`无法读取${path.basename(file)}，为保护已保存设置与额度，已停止本次操作`);
  }
}

/** @param {string} file @param {unknown} value */
export function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.${crypto.randomUUID()}.tmp`;
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2), 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    windowsFileRetry(() => fs.renameSync(temporary, file));
    // Windows does not expose directory fsync through Node's file API.
    if (process.platform !== 'win32') {
      const directory = fs.openSync(path.dirname(file), 'r');
      try { fs.fsyncSync(directory); }
      finally { fs.closeSync(directory); }
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    try { windowsFileRetry(() => fs.unlinkSync(temporary)); }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  }
}

/** @param {number} pid */
function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return !hasCode(error, 'ESRCH'); }
}

/** @typedef {{name: string, ticket: number, choosing: boolean}} LockCandidate */

/** @param {string} directory @returns {LockCandidate[]} */
function candidates(directory) {
  const entries = [];
  for (const name of fs.readdirSync(directory)) {
    const match = /^(\d+)\.[0-9a-f-]+\.json$/.exec(name);
    if (!match) continue;
    const file = path.join(directory, name);
    // Each contender owns a UUID path. Removing a dead owner's record cannot
    // remove a replacement lock published by another process.
    if (!processAlive(Number(match[1]))) {
      try { windowsFileRetry(() => fs.unlinkSync(file)); }
      catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
      continue;
    }
    let value;
    try { value = JSON.parse(windowsFileRetry(() => fs.readFileSync(file, 'utf8'))); }
    catch (error) {
      if (hasCode(error, 'ENOENT')) continue;
      throw new Error('存储锁记录损坏，已停止写入');
    }
    if (!value || typeof value.choosing !== 'boolean' || !Number.isSafeInteger(value.ticket)
      || value.ticket < 0 || (!value.choosing && value.ticket === 0)) {
      throw new Error('存储锁记录损坏，已停止写入');
    }
    entries.push({ name, choosing: value.choosing, ticket: value.ticket });
  }
  return entries;
}

/**
 * Lamport bakery locking keeps synchronous callers serialized across processes.
 * Contenders publish choosing before assigning their ticket. Later arrivals see
 * existing tickets, and simultaneous arrivals break ties by their unique name.
 * PID reuse is handled conservatively by waiting instead of stealing a live lock.
 * @template T
 * @param {string} file
 * @param {() => T} work
 * @param {{timeoutMs?: number}} [options]
 * @returns {T}
 */
export function withFileLock(file, work, { timeoutMs = 10000 } = {}) {
  fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const resolved = path.join(fs.realpathSync(path.dirname(path.resolve(file))), path.basename(file));
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  if (heldLocks.has(key)) return work();
  const directory = `${resolved}.lock`;
  fs.mkdirSync(directory, { recursive: true });
  const name = `${process.pid}.${crypto.randomUUID()}.json`;
  const candidate = path.join(directory, name);
  const deadline = performance.now() + timeoutMs;
  try {
    atomicJson(candidate, { choosing: true, ticket: 0 });
    const ticket = Math.max(0, ...candidates(directory).map(entry => entry.ticket)) + 1;
    if (!Number.isSafeInteger(ticket)) throw new Error('存储锁序号超出范围，已停止写入');
    atomicJson(candidate, { choosing: false, ticket });
    while (candidates(directory).some(entry => entry.name !== name && (entry.choosing
      || entry.ticket < ticket || (entry.ticket === ticket && entry.name < name)))) {
      if (performance.now() >= deadline) throw new Error('等待其他进程保存数据超时，请稍后重试');
      Atomics.wait(waitBuffer, 0, 0, 10);
    }
    heldLocks.add(key);
    const result = work();
    if (result && typeof result === 'object' && 'then' in result) {
      throw new TypeError('文件事务必须同步完成');
    }
    return result;
  } finally {
    heldLocks.delete(key);
    try { windowsFileRetry(() => fs.unlinkSync(candidate)); }
    catch (error) { if (!hasCode(error, 'ENOENT')) throw error; }
  }
}
