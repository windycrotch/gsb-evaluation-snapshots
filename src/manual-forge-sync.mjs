import { exactAutomationId } from './automation-policy.mjs';
import { goldAccountKey, captureManualForgeGoldState, assertManualForgeGoldState,
  retireManualForgeGoldState } from './gold-reservations.mjs';
import { captureManualForgeMaterialState, assertManualForgeMaterialState,
  retireManualForgeMaterialState } from './order-reservations.mjs';
import { emitDiagnostic } from './trace-log.mjs';

const integer = (value, minimum = 0) => Number.isSafeInteger(value) && value >= minimum;
const factoryId = value => typeof value === 'string' && /^[1-9]\d*装备厂$/.test(value);

function quantity(value) {
  if (integer(value)) return value;
  let amount;
  if (typeof value === 'string' && /^\d+$/.test(value)) amount = BigInt(value);
  else if (Number.isInteger(value?.low) && Number.isInteger(value.high)) {
    amount = (BigInt(value.high) << 32n) + BigInt(value.low >>> 0);
  }
  if (amount == null || amount < 0n || amount > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('库存数量无法精确确认');
  return Number(amount);
}

function uniqueRows(rows, identify, label) {
  if (!Array.isArray(rows)) throw new Error('未取得完整的' + label);
  const seen = new Set();
  for (const row of rows) {
    const id = identify(row);
    if (id == null || id === '' || seen.has(id)) throw new Error(label + '标识缺失或重复');
    seen.add(id);
  }
  return rows;
}

// Called only after an explicit manual handoff, drained old jobs and a NEW
// login. Network reconnects keep historical uncertainty and never call here.
export async function reconcileManualForge(client, protocol, config, { player, ledger, enabled = () => true } = {}) {
  const account = goldAccountKey(player), epoch = client.connectionEpoch;
  const world = exactAutomationId(player?.worldId), playerId = exactAutomationId(player?.playerId);
  const check = () => {
    if (!enabled() || client.connected !== true || goldAccountKey(player) !== account
      || client.connectionEpoch !== epoch) throw new Error('同步期间账号或连接已变化，原锻造记录保持不变');
  };
  check();
  const records = Object.fromEntries(Object.entries(ledger?.keyRecords() ?? {}).filter(([key, record]) => {
    if (!key.startsWith('forge:' + world + ':') && !key.startsWith('forgeClaim:' + world + ':')) return false;
    const role = key.split(':')[3];
    return (role == null || role === playerId)
      && (record.details?.playerId == null || exactAutomationId(record.details.playerId) === playerId);
  }));
  const gold = captureManualForgeGoldState(player);
  const materials = captureManualForgeMaterialState(player, { goldOperation: gold.ticket?.operation });
  const result = { factories: [], released: { forgeRecords: 0, goldReservations: 0, materialReservations: 0 }, archived: [] };
  if (!Object.keys(records).length && !gold.ticket && !materials.handles.length) return result;
  if (Object.keys(records).length && typeof ledger?.archiveManualForge !== 'function') throw new Error('当前账本无法同步手动锻造');
  const factories = new Set();
  for (const [key, record] of Object.entries(records)) {
    const buildingId = record.details?.buildingId;
    const kind = key.startsWith('forgeClaim:') ? 'forgeClaim' : 'forgeStart';
    const parts = key.split(':');
    if (!factoryId(buildingId) || record.details?.kind !== kind
      || parts.length < 3 || parts.length > 4 || parts[2] !== buildingId.slice(0, -3)
      || parts[3] != null && parts[3] !== playerId
      || record.details?.playerId != null && exactAutomationId(record.details.playerId) !== playerId
      || record.details?.worldId != null && exactAutomationId(record.details.worldId) !== world) {
      throw new Error('锻造记录归属无法确认，保留原记录');
    }
    factories.add(buildingId);
  }
  for (const handle of materials.handles) {
    const id = handle.operation?.forgeBuildingId ?? /^([1-9]\d*装备厂)锻造/.exec(handle.label ?? '')?.[1];
    if (factoryId(id)) factories.add(id);
  }
  if (factoryId(gold.ticket?.operation?.forgeBuildingId)) factories.add(gold.ticket.operation.forgeBuildingId);
  try {
    const read = async name => {
      const response = name.replace(/Request$/, 'Response');
      if (!protocol?.[name] || !protocol?.[response]) throw new Error('当前协议无法同步手动锻造：缺少 ' + name);
      const value = await client.request(name, {}, response, 8000);
      check();
      return value;
    };
    const water = await read('OnWaterRequest');
    const buildings = uniqueRows(water?.building, row => typeof row?.buildingId === 'string' ? row.buildingId : null, '建筑状态');
    if (buildings.some(row => !integer(row.level))) throw new Error('建筑等级未完整同步');
    if (!factories.size && gold.ticket) {
      for (const building of buildings) if (factoryId(building.buildingId) && building.level > 0) factories.add(building.buildingId);
      if (!factories.size) throw new Error('未找到旧锻造金币操作对应的装备厂');
    }
    for (const id of factories) {
      const building = buildings.find(row => row.buildingId === id), making = building?.equipMaking;
      if (!(building?.level > 0)) throw new Error('未取得装备厂 ' + id + ' 的完整状态');
      if (making != null && (!integer(making.makeId, 1) || !integer(making.finishTime, 1)
        || making.equipId != null && typeof making.equipId !== 'string'
        || making.star != null && !integer(making.star))) throw new Error('装备厂 ' + id + ' 的制作批次未完整同步');
    }
    const equips = await read('EquipsRequest');
    const equipment = uniqueRows(equips?.equip, row => exactAutomationId(row?.uid), '装备库存');
    if (equipment.some(row => typeof row.equipId !== 'string' || !row.equipId || !integer(row.star))) throw new Error('装备库存内容未完整同步');
    const items = await read('AllItemRequest');
    const inventory = uniqueRows(items?.items, row => typeof row?.itemId === 'string' ? row.itemId : null, '材料库存');
    const stock = Object.fromEntries(inventory.map(row => [row.itemId, quantity(row.num)]));
    const resources = await read('AllResourceRequest');
    const balances = uniqueRows(resources?.list, row => integer(row?.res) ? row.res : null, '资源库存');
    for (const row of balances) quantity(row.amount);
    const goldBalance = balances.find(row => row.res === 3);
    if (!goldBalance) throw new Error('金币余额未完整同步');
    check();
    assertManualForgeGoldState(player, gold);
    assertManualForgeMaterialState(player, materials);
    // Commit the durable archive first. Every following removal is synchronous
    // and checked against the captured handles, so a failed read removes none.
    const archived = Object.keys(records).length ? ledger.archiveManualForge(records) : { released: 0, archived: [] };
    retireManualForgeGoldState(player, gold);
    retireManualForgeMaterialState(player, materials);
    result.factories = [...factories];
    result.released = { forgeRecords: archived.released, goldReservations: gold.ticket ? 1 : 0, materialReservations: materials.handles.length };
    result.archived = archived.archived;
    emitDiagnostic(client, 'manual-forge-resync', { account, status: 'unknown', disposition: 'manual-handoff-sync',
      ...result, previousRecords: records, currentBuildings: buildings.filter(row => factories.has(row.buildingId)),
      equipmentCount: equipment.length, currentStock: stock, gold: quantity(goldBalance.amount) });
    return result;
  } catch (error) {
    emitDiagnostic(client, 'manual-forge-resync-blocked', { account, reason: error.message });
    throw error;
  }
}
