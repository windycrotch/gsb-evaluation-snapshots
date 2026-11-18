import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { atomicJson, readJson, withFileLock } from './json-store.mjs';
import { accountKey, dataDirectory } from './usage-ledger.mjs';
import { normalizeFormation, formationSignature } from './saved-lineups.mjs';

const runtimeFile = () => path.join(dataDirectory(), 'lineup-runtime.json');
const phases = new Set(['switching', 'battling', 'restoring', 'pending', 'conflict']);

function ownerFile(accountId) {
  const key = createHash('sha256').update(accountId).digest('hex');
  return path.join(dataDirectory(), 'lineup-locks', key + '.json');
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { return error.code !== 'ESRCH'; }
}

function readOwner(file) {
  const owner = readJson(file, null);
  if (owner === null) return null;
  if (owner?.version !== 1 || !Number.isSafeInteger(owner.pid) || owner.pid < 1
    || typeof owner.token !== 'string' || !owner.token) throw new Error('阵容运行锁记录损坏，已停止换阵');
  return owner;
}

function claimOwner(file) {
  return withFileLock(file, () => {
    const previous = readOwner(file);
    if (previous && processAlive(previous.pid)) throw new Error('该账号正在使用共享阵容，请等待当前任务完成');
    const owner = { version: 1, pid: process.pid, token: randomUUID(), startedAt: Date.now() };
    atomicJson(file, owner);
    return owner;
  });
}

function releaseOwner(file, owner) {
  withFileLock(file, () => {
    const current = readOwner(file);
    if (current?.pid !== owner.pid || current?.token !== owner.token) throw new Error('阵容运行锁已变化，请停止当前任务');
    atomicJson(file, null);
  });
}

function identity(role) {
  if (!role || typeof role.playerId !== 'string' || !/^[1-9]\d*$/.test(role.playerId)
    || typeof role.worldId !== 'string' || !/^[1-9]\d*$/.test(role.worldId)) throw new Error('无法确认阵容所属角色与区服');
  return { playerId: role.playerId, worldId: role.worldId };
}

function readStore() {
  const store = readJson(runtimeFile(), { version: 1, accounts: {} });
  if (store?.version !== 1 || !store.accounts || typeof store.accounts !== 'object' || Array.isArray(store.accounts)) {
    throw new Error('阵容恢复记录格式异常，已停止换阵');
  }
  return store;
}

function recordFor(store, accountId) {
  const record = Object.hasOwn(store.accounts, accountId) ? store.accounts[accountId] : null;
  if (!record) return null;
  if (typeof record.transactionId !== 'string' || !record.transactionId || !phases.has(record.phase)) {
    throw new Error('阵容恢复记录损坏，已停止换阵');
  }
  return { ...record, role: identity(record.role),
    original: normalizeFormation(record.original, { allowEmpty: true }), target: normalizeFormation(record.target) };
}

export function readLineupRuntime(accountId) {
  accountKey(accountId);
  const record = recordFor(readStore(), accountId);
  if (!record) return { phase: 'idle', pending: false, transactionId: null };
  return { ...record, pending: true };
}

function updateRecord(accountId, transactionId, change) {
  return withFileLock(runtimeFile(), () => {
    const store = readStore();
    const current = recordFor(store, accountId);
    if ((current?.transactionId ?? null) !== transactionId) throw new Error('阵容恢复记录已变化，请刷新后重试');
    const next = change(current);
    if (next) store.accounts[accountId] = next;
    else delete store.accounts[accountId];
    atomicJson(runtimeFile(), store);
    return next;
  });
}

function report(onPhase, state) {
  // UI/log observers must never replace a battle error or interrupt restoration.
  try { Promise.resolve(onPhase?.(structuredClone(state))).catch(() => {}); }
  catch { /* The persisted recovery record remains the source of truth. */ }
}

function pendingError(message, record, cause) {
  const error = new Error(message, cause ? { cause } : undefined);
  error.lineupRestorePending = true;
  error.lineupRecovery = { phase: record.phase, transactionId: record.transactionId, reason: message };
  return error;
}

function setPhase(accountId, record, phase, onPhase, reason = '') {
  const next = updateRecord(accountId, record.transactionId, current => ({ ...current, phase, reason, updatedAt: Date.now() }));
  report(onPhase, { phase, transactionId: next.transactionId, reason });
  return next;
}

function clearRecord(accountId, record, onPhase) {
  updateRecord(accountId, record.transactionId, () => null);
  report(onPhase, { phase: 'idle', transactionId: record.transactionId });
  return { phase: 'idle', pending: false, transactionId: null };
}

async function readFormation(client) {
  const reply = await client.request('GetFormationRequest', { module: 1 }, 'GetFormationResponse');
  return normalizeFormation(reply?.formation, { allowEmpty: true });
}

function wireFormation(formation) {
  const uid = BigInt(formation.petUid);
  return { ...formation, petUid: { low: Number(BigInt.asIntN(32, uid)), high: Number(uid >> 32n), unsigned: false } };
}

async function saveFormation(client, formation) {
  await client.request('SaveFormationRequest', { module: 1, formation: wireFormation(formation) }, 'SaveFormationResponse');
  const current = await readFormation(client);
  if (formationSignature(current) !== formationSignature(formation)) throw new Error('服务端尚未确认目标阵容');
}

async function recover(client, { accountId, role, resolution = 'auto', expectedTransactionId, onPhase }) {
  let record = recordFor(readStore(), accountId);
  if (expectedTransactionId !== undefined && expectedTransactionId !== (record?.transactionId ?? null)) {
    throw new Error('阵容恢复记录已变化，请刷新后重试');
  }
  if (!record) return { phase: 'idle', pending: false, transactionId: null };
  if (record.role.playerId !== role.playerId || record.role.worldId !== role.worldId) {
    const reason = '待恢复阵容属于其他角色或区服，请切回对应角色后处理';
    report(onPhase, { phase: 'pending', transactionId: record.transactionId, reason });
    throw pendingError(reason, record);
  }
  if (!['auto', 'restore', 'keep'].includes(resolution)) throw new Error('未知阵容恢复方式');
  try {
    const current = await readFormation(client);
    const currentSignature = formationSignature(current);
    if (resolution === 'keep' || currentSignature === formationSignature(record.original)) {
      return clearRecord(accountId, record, onPhase);
    }
    if (resolution !== 'restore' && currentSignature !== formationSignature(record.target)) {
      record = setPhase(accountId, record, 'conflict', onPhase, '游戏阵容已被其他操作修改，请选择恢复原阵容或保留当前阵容');
      throw pendingError(record.reason, record);
    }
    record = setPhase(accountId, record, 'restoring', onPhase);
    let writeError;
    try { await saveFormation(client, record.original); }
    catch (error) { writeError = error; }
    if (writeError) {
      // A lost response may follow a successful write. Read before deciding.
      const after = await readFormation(client);
      if (formationSignature(after) !== formationSignature(record.original)) throw writeError;
    }
    return clearRecord(accountId, record, onPhase);
  } catch (error) {
    if (error.lineupRestorePending) throw error;
    record = setPhase(accountId, record, 'pending', onPhase, error.message);
    throw pendingError('阵容尚待恢复，' + error.message, record, error);
  }
}

async function exclusive(accountId, work) {
  accountKey(accountId);
  const file = ownerFile(accountId);
  // The short file transaction protects the claim. The persisted owner keeps
  // exclusivity across every await, including restoration and separate modules.
  // Only a dead process can be replaced. PID reuse is handled conservatively.
  const owner = claimOwner(file);
  let result, failure;
  try { result = await work(); }
  catch (error) { failure = error instanceof Error ? error : new Error(String(error), { cause: error }); }
  finally {
    try { releaseOwner(file, owner); }
    catch (error) {
      if (failure) failure.lineupLockError = error;
      else failure = error;
    }
  }
  if (failure) throw failure;
  return result;
}

export async function recoverLineup(client, options) {
  const role = identity(options.role);
  return exclusive(options.accountId, () => recover(client, { ...options, role }));
}

export async function withTemporaryLineup(client, { accountId, role, formation, enabled = () => true, onPhase }, work) {
  const target = formation == null ? null : normalizeFormation(formation);
  return exclusive(accountId, async () => {
    const pending = recordFor(readStore(), accountId);
    if (target || pending) role = identity(role);
    if (pending) await recover(client, { accountId, role, onPhase });
    if (!enabled()) throw new Error('账号状态已变化，取消阵容挑战');
    let record = null, result, failure;
    try {
      if (target) {
        const original = await readFormation(client);
        if (!enabled()) throw new Error('账号状态已变化，取消阵容挑战');
        if (formationSignature(original) !== formationSignature(target)) {
          const prepared = { transactionId: randomUUID(), role, original, target, phase: 'switching', startedAt: Date.now(), updatedAt: Date.now(), reason: '' };
          record = updateRecord(accountId, null, () => prepared);
          report(onPhase, { phase: 'switching', transactionId: record.transactionId });
          if (!enabled()) throw new Error('账号状态已变化，取消阵容切换');
          await saveFormation(client, target);
        }
      }
      if (!enabled()) throw new Error('账号状态已变化，取消阵容挑战');
      if (record) record = setPhase(accountId, record, 'battling', onPhase);
      else report(onPhase, { phase: 'battling', transactionId: null });
      result = await work();
    } catch (error) { failure = error instanceof Error ? error : new Error(String(error), { cause: error }); }
    finally {
      if (record) {
        try { await recover(client, { accountId, role, onPhase }); }
        catch (restoreError) {
          restoreError.lineupRestorePending = true;
          restoreError.lineupRecovery ??= { phase: 'pending', transactionId: record.transactionId, reason: restoreError.message };
          if (failure instanceof Error) {
            failure.lineupRestorePending = true;
            failure.lineupRecovery = restoreError.lineupRecovery;
            failure.lineupRestoreError = restoreError;
          } else failure = restoreError;
        }
      } else report(onPhase, { phase: 'idle', transactionId: null });
    }
    if (failure) throw failure;
    return result;
  });
}
