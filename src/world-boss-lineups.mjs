import { exactAutomationId } from './automation-policy.mjs';
import { normalizeFormation, formationSignature, readLineupEditor, validateEditorFormation } from './saved-lineups.mjs';

const busy = new WeakSet();
const prefix = 'world-boss-lineup:';
const clone = value => structuredClone(value);
const isFleetId = value => typeof value === 'string' && /^[1-9]\d*远征船$/.test(value);
const zero = value => value == null || value === 0 || value === '0' || value.low === 0 && value.high === 0;
const home = fleet => fleet?.state === 1 && fleet.curGridIdx === 0 && zero(fleet.treasureLootUid)
  && !fleet.chipWar?.rewardTs && !fleet.autoFight?.isOn;

function roleOf(player) {
  const playerId = exactAutomationId(player?.playerId ?? player?.id), worldId = exactAutomationId(player?.worldId);
  if (!playerId || !worldId) throw new Error('无法确认世界Boss阵容所属角色与区服');
  return { playerId, worldId };
}

// FleetFormation does not contain a pet field. Saved lineup pets belong to
// other game modes and must never be serialized into the fleet protocol.
function fleetFormation(value, allowEmpty = false) {
  const normalized = normalizeFormation({ ...value, petUid: '0' }, { allowEmpty });
  return { presetId: normalized.presetId, heroPositions: normalized.heroPositions };
}

const signature = value => formationSignature({ ...value, petUid: '0' });
const journalKey = (role, buildingId) => prefix + role.worldId + ':' + role.playerId + ':' + buildingId.replace('远征船', '');
const sameRole = (left, right) => left?.playerId === right.playerId && left?.worldId === right.worldId;
const active = (client, enabled) => client.connected !== false && enabled();

function emit(report, entry) {
  try { Promise.resolve(report({ label: '世界Boss临时阵容', ...entry })).catch(() => {}); }
  catch { /* A log observer cannot interrupt restoration. */ }
}

function journalEntries(ledger) {
  return Object.entries(ledger.keyRecords()).filter(([key, record]) =>
    key.startsWith(prefix) || record.details?.kind === 'worldBossLineup');
}

function validateJournal(key, record) {
  const details = record.details;
  if (details?.kind !== 'worldBossLineup' || !isFleetId(details.buildingId)
    || !['prepared', 'dispatched'].includes(details.phase)) throw new Error('世界Boss阵容恢复记录损坏');
  const role = roleOf(details.role);
  if (key !== journalKey(role, details.buildingId)) throw new Error('世界Boss阵容恢复记录身份不一致');
  return { ...details, role, original: fleetFormation(details.original, true), target: fleetFormation(details.target) };
}

async function snapshot(client) {
  const water = await client.request('OnWaterRequest', {}, 'OnWaterResponse');
  const own = await client.request('MyFleetsRequest', {}, 'MyFleetsResponse');
  if (!Array.isArray(water?.building) || !Array.isArray(own?.fleets)) throw new Error('舰队阵容或返航状态未同步');
  const docks = water.building.filter(row => isFleetId(row.buildingId) && row.level > 0);
  if (new Set(docks.map(row => row.buildingId)).size !== docks.length
    || new Set(own.fleets.map(row => row.buildingId)).size !== own.fleets.length) throw new Error('舰队状态重复，未换阵');
  return { docks, fleets: own.fleets };
}

function dockFor(state, buildingId) {
  const dock = state.docks.find(row => row.buildingId === buildingId);
  if (!dock) throw new Error(buildingId + '尚未建成或阵容未同步');
  return dock;
}

function assertHeroesFree(formation, buildingId, docks) {
  const wanted = new Set(formation.heroPositions.map(row => row.heroId));
  for (const dock of docks) {
    if (dock.buildingId === buildingId) continue;
    const occupied = dock.fleet?.formation?.heroPositions ?? [];
    if (!Array.isArray(occupied)) throw new Error(dock.buildingId + '的英雄占用未同步');
    const conflict = occupied.find(row => wanted.has(row.heroId));
    if (conflict) throw new Error(conflict.heroId + '已编入' + dock.buildingId + '，不能同时编入' + buildingId);
  }
}

function currentRecord(ledger, key, expected) {
  const current = ledger.keyRecords()[key];
  if (!current || current.id !== expected.id) throw new Error('世界Boss阵容恢复记录已变化');
  return current;
}

async function saveAndConfirm(client, buildingId, formation) {
  let error;
  try { await client.sendWatch('FleetSaveFormationRequest', { buildingId, formation: clone(formation) }); }
  catch (failure) { error = failure; }
  // A lost response can follow a successful write. Always read before deciding.
  const water = await client.request('OnWaterRequest', {}, 'OnWaterResponse');
  const matches = water?.building?.filter(row => row.buildingId === buildingId);
  if (matches?.length !== 1 || signature(fleetFormation(matches[0].fleet?.formation, true)) !== signature(formation)) {
    throw error ?? new Error('服务端尚未确认' + buildingId + '的阵容');
  }
}

async function recover(client, player, ledger, { enabled, report, onlyKeys }) {
  const entries = journalEntries(ledger).filter(([key]) => !onlyKeys || onlyKeys.has(key));
  const result = { restored: [], pending: [] };
  if (!entries.length) return result;
  const role = roleOf(player);
  for (const [key, record] of entries) {
    let details;
    try {
      details = validateJournal(key, record);
      if (!sameRole(details.role, role)) throw new Error('待恢复舰队阵容属于其他角色或区服');
      if (!active(client, enabled)) throw new Error('连接或账号已停止，原阵容等待下次连接恢复');
      if (details.phase === 'dispatched') {
        const dispatch = ledger.keyRecords()[details.dispatchKey];
        if (!dispatch || dispatch.details?.kind !== 'worldBoss' || dispatch.details.buildingId !== details.buildingId
          || dispatch.details.active !== false) throw new Error('世界Boss派遣尚未确认结束，返航后恢复阵容');
      }
      const state = await snapshot(client);
      if (!home(state.fleets.find(row => row.buildingId === details.buildingId))) throw new Error('舰队尚未空闲返航，暂不恢复阵容');
      const current = fleetFormation(dockFor(state, details.buildingId).fleet?.formation, true);
      const currentSignature = signature(current);
      if (currentSignature !== signature(details.original)) {
        if (currentSignature !== signature(details.target)) throw new Error('舰队阵容已被其他操作修改，未覆盖当前阵容');
        assertHeroesFree(details.original, details.buildingId, state.docks);
        currentRecord(ledger, key, record);
        if (!active(client, enabled) || !sameRole(roleOf(player), role)) throw new Error('恢复前账号状态已变化');
        await saveAndConfirm(client, details.buildingId, details.original);
      }
      currentRecord(ledger, key, record);
      if (!active(client, enabled) || !sameRole(roleOf(player), role)) {
        throw new Error('核对后账号状态已变化，原阵容恢复记录已保留');
      }
      // A crash between reserve() and confirm() leaves a valid no-cost snapshot.
      // Re-confirm only after observing/restoring the exact original formation.
      if (!ledger.keyRecords()[key].confirmed) ledger.resolveKey(key, true);
      ledger.releaseCompletedKey(key);
      result.restored.push(key);
      emit(report, { ok: true, buildingId: details.buildingId, reason: details.buildingId + '已恢复出战前阵容' });
    } catch (error) {
      result.pending.push(key);
      const current = ledger.keyRecords()[key], unchanged = current?.details?.reason === error.message;
      if (current?.id === record.id && details && !unchanged) ledger.updateKeyDetails(key, { ...current.details, reason: error.message });
      if (!unchanged) emit(report, { skipped: true, status: 'pending', buildingId: details?.buildingId, reason: error.message });
    }
  }
  return result;
}

export async function recoverWorldBossLineups(client, player, ledger, { enabled = () => true, report = () => {} } = {}) {
  if (busy.has(client)) throw new Error('世界Boss舰队阵容正在核对');
  busy.add(client);
  try { return await recover(client, player, ledger, { enabled, report }); }
  finally { busy.delete(client); }
}

export async function prepareWorldBossLineups(client, config, player, {
  settings, ledger, fleetIds, enabled = () => true, report = () => {},
}) {
  if (busy.has(client)) throw new Error('世界Boss舰队阵容正在核对');
  busy.add(client);
  const keys = [];
  try {
    if (!Array.isArray(fleetIds) || fleetIds.some(id => !isFleetId(id)) || new Set(fleetIds).size !== fleetIds.length) {
      throw new Error('世界Boss出战舰队选择无效');
    }
    const bindings = settings?.worldBoss?.fleetPresets ?? [];
    const selected = bindings.filter(binding => fleetIds.includes(binding.buildingId));
    if (!selected.length) return keys;
    if (new Set(selected.map(binding => binding.buildingId)).size !== selected.length) throw new Error('舰队阵容配置重复');
    const role = roleOf(player);
    if (!active(client, enabled)) throw new Error('账号状态已变化，未切换舰队阵容');
    for (const [, record] of journalEntries(ledger)) {
      if (fleetIds.includes(record.details?.buildingId)) throw new Error('出战舰队的上次阵容尚待恢复');
    }
    const editor = await readLineupEditor(client, config, player);
    const state = await snapshot(client), assigned = new Map();
    // Validate the entire group before persisting or writing any formation.
    const changes = selected.map(binding => {
      const preset = settings.lineups?.presets?.find(row => row.id === binding.presetId);
      if (!preset) throw new Error(binding.buildingId + '选择的阵容已删除');
      const target = fleetFormation(validateEditorFormation({ ...preset.formation, petUid: '0' }, editor));
      if (!home(state.fleets.find(row => row.buildingId === binding.buildingId))) throw new Error(binding.buildingId + '不是空闲返航状态');
      assertHeroesFree(target, binding.buildingId, state.docks);
      for (const { heroId } of target.heroPositions) {
        if (assigned.has(heroId)) throw new Error(heroId + '不能同时编入两支出战舰队');
        assigned.set(heroId, binding.buildingId);
      }
      const saved = dockFor(state, binding.buildingId).fleet?.formation;
      if (!saved || !Number.isSafeInteger(saved.presetId) || saved.presetId < 1) {
        throw new Error(binding.buildingId + '的原阵容未同步，暂不切换');
      }
      const original = fleetFormation(saved, true);
      return { kind: 'worldBossLineup', role, buildingId: binding.buildingId, original, target,
        phase: 'prepared', active: true, startedAt: Date.now(), presetId: preset.id, reason: '' };
    }).filter(change => signature(change.original) !== signature(change.target));
    if (!active(client, enabled) || !sameRole(roleOf(player), role)) throw new Error('换阵前账号状态已变化');
    for (const details of changes) {
      const key = journalKey(role, details.buildingId);
      const ticket = ledger.reserve({}, {}, {}, { uniqueKey: key, details });
      keys.push(key);
      ledger.confirm(ticket);
    }
    for (const details of changes) {
      const fresh = await snapshot(client);
      if (!home(fresh.fleets.find(row => row.buildingId === details.buildingId))) throw new Error('换阵前舰队已离港');
      const current = fleetFormation(dockFor(fresh, details.buildingId).fleet?.formation, true);
      if (signature(current) !== signature(details.original)) throw new Error('换阵前游戏阵容已变化，未覆盖');
      assertHeroesFree(details.target, details.buildingId, fresh.docks);
      if (!active(client, enabled) || !sameRole(roleOf(player), role)) throw new Error('换阵前账号状态已变化');
      await saveAndConfirm(client, details.buildingId, details.target);
    }
    return keys;
  } catch (error) {
    if (keys.length) {
      const recovery = await recover(client, player, ledger, { enabled, report, onlyKeys: new Set(keys) });
      if (recovery.pending.length) error.worldBossLineupPending = recovery.pending;
    }
    throw error;
  } finally { busy.delete(client); }
}

// Call before sending the dispatch request. The journal must already describe
// an in-flight operation if the process dies after the server accepts it.
export function markWorldBossLineupsDispatched(ledger, keys, dispatchKeys) {
  const records = ledger.keyRecords();
  const updates = keys.map(key => {
    const record = records[key];
    if (!record) throw new Error('世界Boss阵容恢复记录已不存在');
    const details = validateJournal(key, record), dispatchKey = dispatchKeys[details.buildingId];
    const dispatch = records[dispatchKey];
    if (!dispatchKey?.startsWith('world-boss:' + details.role.worldId + ':')
      || dispatch?.details?.kind !== 'worldBoss' || dispatch.details.buildingId !== details.buildingId) {
      throw new Error('世界Boss派遣记录与待恢复舰队不一致');
    }
    return [key, { ...details, phase: 'dispatched', dispatchKey, reason: '' }];
  });
  for (const [key, details] of updates) ledger.updateKeyDetails(key, details);
}

// Only for a definitely unsent or explicitly rejected dispatch, never timeout.
export function markWorldBossLineupsCancelled(ledger, keys) {
  const records = ledger.keyRecords();
  for (const key of keys) {
    const record = records[key];
    if (!record) continue;
    const details = validateJournal(key, record);
    delete details.dispatchKey;
    ledger.updateKeyDetails(key, { ...details, phase: 'prepared', reason: '' });
  }
}
