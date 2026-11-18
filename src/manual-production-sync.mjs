import { normalize } from './worlds.mjs';
import { goldAccountKey, pendingGoldSpend } from './gold-reservations.mjs';
import { farmInventory } from './farm-planting.mjs';
import { factoryProductionSnapshot } from './spend-evidence.mjs';
import { captureManualProductionMaterialState, assertManualProductionMaterialState,
  retireManualProductionMaterialState } from './order-reservations.mjs';
import { captureManualFactoryProductionState, assertManualFactoryProductionState,
  retireManualFactoryProductionState } from './factory-production.mjs';
import { emitDiagnostic } from './trace-log.mjs';

const integer = value => Number.isSafeInteger(value) && value >= 0;

// The caller must confirm a manual handoff (pause or another game login), drain
// the old jobs and establish a NEW login. Ordinary network reconnect must never
// call this operation; historical requests remain unknown after rebasing.
export async function reconcileManualProduction(client, protocol, { player, enabled = () => true } = {}) {
  const account = goldAccountKey(player), epoch = client.connectionEpoch;
  const check = () => {
    if (!enabled() || client.connected !== true || goldAccountKey(player) !== account
      || client.connectionEpoch !== epoch) throw new Error('同步期间账号或连接已变化，原记录保持不变');
  };
  check();
  for (const name of ['OnWaterRequest', 'OnWaterResponse', 'AllItemRequest', 'AllItemResponse']) {
    if (!protocol[name]) throw new Error('当前协议无法同步手动生产：缺少 ' + name);
  }
  const materialState = captureManualProductionMaterialState(player);
  const factoryState = captureManualFactoryProductionState(player);
  const factories = [...new Set([...factoryState.batches.map(row => row.buildingId),
    ...materialState.handles.map(handle => handle.operation?.factoryBuildingId).filter(Boolean)])];
  const farms = [...new Set(materialState.handles.flatMap(handle => handle.farm?.args.map(arg => arg.buildingId) ?? []))];
  try {
    const water = normalize(await client.request('OnWaterRequest', {}, 'OnWaterResponse'));
    check();
    if (!Array.isArray(water?.building) || water.building.some(row => typeof row?.buildingId !== 'string'
      || !row.buildingId || !integer(row.level ?? 0))
      || new Set(water.building.map(row => row.buildingId)).size !== water.building.length) throw new Error('未取得完整且唯一的建筑状态');
    for (const id of factories) {
      const factory = factoryProductionSnapshot(water, id);
      if (!factory || factory.queue.some(job => job.finishTime != null && !integer(job.finishTime))) throw new Error('无法完整读取工厂 ' + id + ' 的队列和待收成品');
    }
    for (const id of farms) {
      const building = water.building.find(row => row.buildingId === id), farm = building?.farm;
      if (!(building?.level > 0) || farm != null && (typeof farm !== 'object' || Array.isArray(farm)
        || typeof (farm.productId ?? '') !== 'string'
        || farm.productId && (!integer(farm.plantTime) || farm.plantTime <= 0 || !integer(farm.ripeTime) || farm.ripeTime < farm.plantTime)
        || !farm.productId && ((farm.plantTime ?? 0) !== 0 || (farm.ripeTime ?? 0) !== 0))) throw new Error('无法完整读取农田 ' + id + ' 的当前作物');
    }
    const stock = farmInventory(normalize(await client.request('AllItemRequest', {}, 'AllItemResponse')));
    check();
    assertManualProductionMaterialState(player, materialState);
    assertManualFactoryProductionState(player, factoryState);
    // No awaits or callbacks between validation and both removals: either all
    // captured barriers retire, or any failed read leaves every record intact.
    retireManualFactoryProductionState(player, factoryState);
    retireManualProductionMaterialState(player, materialState);
    const result = { factories, farms,
      released: { factoryBatches: factoryState.batches.length, materialReservations: materialState.handles.length },
      preserved: { materialReservations: materialState.all.length - materialState.handles.length,
        goldReservations: pendingGoldSpend(player) ? 1 : 0 },
      message: '已按当前服务器状态同步手动生产；旧生产结果保留为未知，后续按新状态重新规划。其他玩法及金币、钻石、次数预算记录保持不变。' };
    emitDiagnostic(client, 'manual-production-resync', { account, status: 'unknown', disposition: 'manual-handoff-sync',
      ...result, archivedMaterials: materialState.handles.map(handle => ({ label: handle.label, costs: handle.costs,
        farm: handle.farm, factoryBuildingId: handle.operation?.factoryBuildingId })),
      archivedBatches: factoryState.batches.map(({ buildingId, batch }) => ({ buildingId, attempted: batch.attempted })),
      currentBuildings: water.building.filter(row => factories.includes(row.buildingId) || farms.includes(row.buildingId)),
      currentStock: Object.fromEntries(stock) });
    return result;
  } catch (error) {
    emitDiagnostic(client, 'manual-production-resync-blocked', { account, reason: error.message });
    throw error;
  }
}
