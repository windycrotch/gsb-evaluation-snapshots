import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-manual-production-sync-'));
process.env.CW_DATA_DIR = directory;
const { loadProtocol } = await import('../src/proto.mjs');
const { defaultSettings, createUsageLedger } = await import('../src/automation-settings.mjs');
const { reconcileManualProduction } = await import('../src/manual-production-sync.mjs');
const { runFactoryProductionBatch, captureManualFactoryProductionState } = await import('../src/factory-production.mjs');
const { beginOrderMaterialSpend, pendingOrderMaterialSpends, pendingFarmMaterialSpends,
  refreshOrderMaterialSpends, captureManualProductionMaterialState } = await import('../src/order-reservations.mjs');
const { reserveGold, pendingGoldSpend } = await import('../src/gold-reservations.mjs');
const { assertFarmPlantingReady } = await import('../src/farm-planting.mjs');
const protocol = loadProtocol(), now = Math.floor(Date.now() / 1000);
let serial = 41000000, passed = 0;
const test = async (name, run) => { await run(); passed++; console.log('通过：' + name); };

async function fixture() {
  const player = { playerId: ++serial, worldId: 1, level: 40 }, settings = defaultSettings();
  settings.loop.world = true;
  Object.assign(settings.factory, { enabled: true, produce: true });
  const config = { tables: {
    BuildingCfg: { data: [{ buildingType: '材料厂' }] },
    BuildingProduceCfg: { data: ['旧产品', '新产品'].map(itemId => ({ buildType: '材料厂', itemId, unlockLevel: 1, costItem: [['木材', 1]] })) },
    BuildingProduceParamCfg: { data: [{ paramName: '制造位上限', paramValue: 6 }] },
    GameParamCfg: { data: [{ paramName: '产品存量初始上限', paramValue: 100 }] },
  } };
  const factory = { buildingId: '1材料厂', level: 1, factory: { factoryQ: [], finishedProducts: [] } };
  const farm = { buildingId: '1农田', level: 1, farm: { productId: '玉米', plantTime: now, ripeTime: now + 60 } };
  const state = { unknown: true, active: true, writes: [], reads: [], diagnostics: [], building: [factory, farm],
    stock: new Map([['木材', 100], ['小麦种子', 10], ['其他材料', 20]]) };
  const codec = (name, value) => protocol[name].decode(protocol[name].encode(value).finish());
  const client = { connected: true, connectionEpoch: 1, festivals: [],
    emit(event, data) { assert.equal(event, 'diagnostic'); state.diagnostics.push(data); },
    async request(name, body, response) {
      assert(protocol[name] && protocol[response]); codec(name, body); state.reads.push(name);
      await state.beforeRead?.(name);
      let value;
      if (name === 'OnWaterRequest') value = { building: state.building };
      else if (name === 'AllItemRequest') value = { items: [...state.stock].map(([itemId, num]) => ({ itemId, num })) };
      else throw new Error('同步不应读取或发送 ' + name);
      value = codec(response, value);
      const changed = await state.transform?.(name, value);
      await state.afterRead?.(name);
      return changed ?? value;
    },
    async sendWatch(name, body) {
      assert.equal(name, 'StartFactoryProduceRequest'); state.writes.push(structuredClone(body));
      if (state.unknown) throw new Error('模拟生产结果未知');
      factory.factory.factoryQ.push({ idx: 1, productId: body.productId, finishTime: now + 600 });
      state.stock.set('木材', state.stock.get('木材') - 1);
      return { seq: state.writes.length };
    },
  };
  const step = productId => ({ kind: 'startProduce', request: 'StartFactoryProduceRequest', response: null,
    body: { buildingId: factory.buildingId, productId }, costs: [{ id: '木材', num: 1 }], label: '排产' });
  const batch = productId => runFactoryProductionBatch(client, protocol, [step(productId)], { config, player,
    getSettings: () => settings, enabled: () => state.active, window: 0 });
  await batch('旧产品');
  const farmHandle = beginOrderMaterialSpend(player, [{ id: '小麦种子', have: 10, need: 1 }], '旧小麦播种',
    { farm: { args: [{ buildingId: farm.buildingId, productId: '小麦' }] } });
  const factoryHandle = pendingOrderMaterialSpends(player)[0];
  assert.equal(captureManualFactoryProductionState(player).batches.length, 1);
  const reconnect = { ...client, connectionEpoch: 2 };
  const sync = () => reconcileManualProduction(reconnect, protocol, { player, enabled: () => state.active });
  const intact = (identity = player) => {
    assert(pendingOrderMaterialSpends(identity).includes(factoryHandle));
    assert(pendingFarmMaterialSpends(identity).includes(farmHandle));
    assert.equal(captureManualFactoryProductionState(identity).batches.length, 1);
  };
  return { player, state, factory, farm, client, reconnect, factoryHandle, farmHandle, batch, sync, intact };
}

try {
  await test('人工收走成品并改种后新会话同步，旧结果未知而新计划可按当前材料生产', async () => {
    const f = await fixture();
    assert.equal(f.factoryHandle.operation.onConfirmed, undefined, '日志观察者保持原预算回调语义');
    assert.equal(typeof f.factoryHandle.onReconciled, 'function');
    let reconciled = 0; f.farmHandle.onReconciled = () => { reconciled++; };
    const oldOperationId = f.state.diagnostics.find(row => row.event === 'operation').operationId;
    assert.equal(await f.factoryHandle.operation.verify(f.reconnect), false);
    await refreshOrderMaterialSpends(f.reconnect, f.player);
    f.intact(); // Ordinary reconnect does not silently retire historical requests.
    const writes = f.state.writes.length, result = await f.sync();
    assert.equal(f.state.writes.length, writes, '同步本身只读游戏');
    assert.deepEqual(result.factories, ['1材料厂']); assert.deepEqual(result.farms, ['1农田']);
    assert.deepEqual(result.released, { factoryBatches: 1, materialReservations: 2 });
    assert.equal(reconciled, 0, '人工交接保持历史操作结果未知');
    assert.equal(f.state.diagnostics.filter(row => row.operationId === oldOperationId && row.phase === 'confirmed').length, 0);
    assert.equal(f.factoryHandle.operation.confirmed, false, '交接不能宣称旧操作成功');
    assert.equal(captureManualFactoryProductionState(f.player).batches.length, 0);
    assert.equal(pendingFarmMaterialSpends(f.player).length, 0);
    assert.throws(() => assertFarmPlantingReady(f.player, { body: { args: f.farmHandle.farm.args } },
      { water: { building: f.state.building } }), /已有作物/, '新规划不能盲目重播旧小麦覆盖玉米');
    const archived = f.state.diagnostics.find(row => row.event === 'manual-production-resync');
    assert.equal(archived.status, 'unknown'); assert.equal(archived.disposition, 'manual-handoff-sync');
    assert.equal(archived.archivedBatches[0].attempted[0].body.productId, '旧产品');
    f.state.unknown = false;
    assert.equal((await f.batch('新产品')).results[0].status, 'confirmed');
    assert.deepEqual(f.state.writes.map(row => row.productId), ['旧产品', '新产品']);
  });

  await test('人工收割后空地和空工厂也允许同步，不依赖旧产品仍存在', async () => {
    const f = await fixture(); f.farm.farm = {};
    assert.equal((await f.sync()).released.materialReservations, 2);
  });

  for (const failure of ['water-read', 'item-read', 'water-empty', 'duplicate-building', 'missing-factory',
    'invalid-factory', 'missing-farm', 'invalid-farm', 'items-missing', 'items-duplicate', 'identity', 'epoch', 'pause', 'new-handle']) {
    await test('同步失败保持所有旧记录：' + failure, async () => {
      const f = await fixture(), identity = { ...f.player };
      f.state.beforeRead = name => {
        if (failure === 'water-read' && name === 'OnWaterRequest' || failure === 'item-read' && name === 'AllItemRequest') throw new Error('模拟读取失败');
      };
      f.state.transform = (name, value) => {
        if (name === 'OnWaterRequest') {
          if (failure === 'water-empty') return {};
          if (failure === 'duplicate-building') value.building.push(value.building[0]);
          if (failure === 'missing-factory') value.building.shift();
          if (failure === 'invalid-factory') value.building[0].factory.factoryQ.push({ idx: 0 });
          if (failure === 'missing-farm') value.building.pop();
          if (failure === 'invalid-farm') value.building[1].farm.ripeTime = -1;
        } else {
          if (failure === 'items-missing') return {};
          if (failure === 'items-duplicate') value.items.push(value.items[0]);
        }
        return value;
      };
      f.state.afterRead = name => {
        if (name !== 'AllItemRequest') return;
        if (failure === 'identity') f.player.playerId++;
        if (failure === 'epoch') f.reconnect.connectionEpoch++;
        if (failure === 'pause') f.state.active = false;
        if (failure === 'new-handle') beginOrderMaterialSpend(f.player, [{ id: '其他材料', have: 20, need: 1 }], '并发新记录', { operation: {} });
      };
      await assert.rejects(f.sync());
      f.intact(identity);
      assert.equal(f.state.writes.length, 1);
      assert.equal(f.factoryHandle.operation.confirmed, false);
    });
  }

  await test('其他玩法、金币和钻石次数预算及另一账号的未知记录不受同步影响', async () => {
    const f = await fixture(), other = await fixture();
    const handle = beginOrderMaterialSpend(f.player, [{ id: '其他材料', have: 20, need: 1 }], '海兽投喂未知',
      { operation: { confirmed: false, onConfirmed() { assert.fail('不得确认其他玩法'); } } });
    const gold = reserveGold(f.player, 100, 10, 'PetBreedRequest', { operation: { confirmed: false } });
    const ledger = createUsageLedger('manual-sync-test', { file: path.join(directory, 'usage.json') });
    ledger.reserve({ diamonds: 5, museumGuides: 1 }, {}, {}, { uniqueKey: 'unknown:paid' });
    const budget = { snapshot: ledger.snapshot(), pending: ledger.pendingCounters(), keys: ledger.keyRecords() };
    const result = await f.sync();
    assert(pendingOrderMaterialSpends(f.player).includes(handle));
    assert.equal(pendingGoldSpend(f.player), gold);
    assert.deepEqual(result.preserved, { materialReservations: 1, goldReservations: 1 });
    assert.deepEqual({ snapshot: ledger.snapshot(), pending: ledger.pendingCounters(), keys: ledger.keyRecords() }, budget);
    other.intact();
  });

  await test('带预算约束的生产材料记录不在普通生产同步范围', async () => {
    const f = await fixture(); f.farmHandle.manualSyncBlocked = true;
    const result = await f.sync();
    assert.deepEqual(result.farms, []);
    assert(pendingFarmMaterialSpends(f.player).includes(f.farmHandle));
    assert.equal(captureManualProductionMaterialState(f.player).handles.length, 0);
  });
  console.log('手动生产同步专项 ' + passed + '/' + passed + ' 通过');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
