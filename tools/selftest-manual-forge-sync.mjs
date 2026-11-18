import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadProtocol } from '../src/proto.mjs';
import { createUsageLedger } from '../src/usage-ledger.mjs';
import { reconcileManualForge } from '../src/manual-forge-sync.mjs';
import { reserveGold, pendingGoldSpend, cancelUnsentGold, refreshGoldSpend } from '../src/gold-reservations.mjs';
import { beginOrderMaterialSpend, pendingOrderMaterialSpends, refreshOrderMaterialSpends } from '../src/order-reservations.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-manual-forge-sync-'));
const protocol = loadProtocol();
const now = Math.floor(Date.now() / 1000);
let serial = 78000000, passed = 0;
const test = async (name, run) => { await run(); passed++; console.log('通过：' + name); };

function fixture({ confirmed = false, legacy = false } = {}) {
  const player = { playerId: ++serial, worldId: 2001001, level: 25 };
  const file = path.join(directory, player.playerId + '.json');
  const ledger = createUsageLedger(String(player.playerId), { file });
  const key = 'forge:' + player.worldId + ':1';
  const details = { kind: 'forgeStart', buildingId: '1装备厂', makeId: 1001, beforeFinishTime: 0,
    beforeUids: [], sentAt: now - 100, finishTime: now + 100, costs: [{ id: 'GOLD', num: 2000 }, { id: '蓝武器材料', num: 40 }] };
  if (!legacy) details.playerId = String(player.playerId);
  const ticket = ledger.reserve({ forgeStarts: 1, forgeGold: 2000 }, {}, {}, { uniqueKey: key, details });
  if (confirmed) ledger.confirm(ticket);
  const operation = { confirmed: false, verify: async () => false };
  if (!legacy) operation.forgeBuildingId = '1装备厂';
  const gold = reserveGold(player, 10000, 2000, 'MakeEquipRequest', { operation });
  const material = beginOrderMaterialSpend(player, [{ id: '蓝武器材料', have: 80, need: 40 }], '1装备厂锻造武器（稀有枪械材料）', { operation });
  const state = { active: true, reads: [], diagnostics: [], building: [{ buildingId: '1装备厂', level: 1 }],
    equip: [], items: [{ itemId: '蓝武器材料', num: 40 }], resources: [{ res: 3, amount: 8000 }] };
  const codec = (name, value) => protocol[name].decode(protocol[name].encode(value).finish());
  const client = { connected: true, connectionEpoch: 2,
    emit(event, data) { assert.equal(event, 'diagnostic'); state.diagnostics.push(data); },
    async request(name, body, response) {
      assert(['OnWaterRequest', 'EquipsRequest', 'AllItemRequest', 'AllResourceRequest'].includes(name), name);
      codec(name, body);
      state.reads.push(name);
      await state.beforeRead?.(name);
      const values = { OnWaterRequest: { building: state.building }, EquipsRequest: { equip: state.equip },
        AllItemRequest: { items: state.items }, AllResourceRequest: { list: state.resources } };
      const value = codec(response, values[name]);
      const transformed = await state.transform?.(name, value);
      await state.afterRead?.(name);
      return transformed ?? value;
    },
  };
  const sync = () => reconcileManualForge(client, protocol, {}, { player, ledger, enabled: () => state.active });
  return { player, file, ledger, key, ticket, gold, material, operation, state, client, sync };
}

try {
  await test('手动领取并分解后归档未知锻造，保留预算并释放工厂和资源屏障', async () => {
    const f = fixture(), before = f.ledger.snapshot();
    await refreshGoldSpend(f.client, f.player);
    await refreshOrderMaterialSpends(f.client, f.player);
    assert.equal(pendingGoldSpend(f.player), f.gold);
    assert(pendingOrderMaterialSpends(f.player).includes(f.material));
    const result = await f.sync(), archiveKey = 'forgeHistory:' + f.ticket.id;
    assert.deepEqual(result.factories, ['1装备厂']);
    assert.deepEqual(result.released, { forgeRecords: 0, goldReservations: 1, materialReservations: 1 });
    assert.deepEqual(result.archived, [archiveKey]);
    assert.equal(f.ledger.hasKey(f.key), false);
    assert.equal(f.ledger.keyRecords()[archiveKey].confirmed, false);
    assert.equal(f.ledger.keyRecords()[archiveKey].details.disposition, 'manual-handoff-sync');
    assert.deepEqual(f.ledger.snapshot(), before);
    assert.deepEqual(f.ledger.confirmedCounters(), {});
    assert.deepEqual(f.ledger.pendingCounters(), { forgeStarts: 1, forgeGold: 2000 });
    assert.equal(pendingGoldSpend(f.player), null);
    assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
    assert.equal(f.operation.confirmed, false);
    const stored = JSON.parse(fs.readFileSync(f.file, 'utf8')).accounts[String(f.player.playerId)];
    assert.equal(stored.pending[f.ticket.id].uniqueKey, archiveKey);
    const next = f.ledger.reserve({ forgeStarts: 1, forgeGold: 2000 }, {}, {}, { uniqueKey: f.key, details: { kind: 'forgeStart' } });
    f.ledger.confirm(f.ticket); f.ledger.cancel(f.ticket);
    assert.equal(f.ledger.keyRecords()[f.key].id, next.id);
    assert.equal(f.ledger.keyRecords()[archiveKey].confirmed, false);
    assert.equal(f.ledger.snapshot().counters.forgeGold, 4000);
  });

  await test('已确认批次手动换配方后只释放旧锁，已花预算保持原数', async () => {
    const f = fixture({ confirmed: true }), before = f.ledger.snapshot();
    f.state.building[0].equipMaking = { makeId: 2001, finishTime: now + 300 };
    const result = await f.sync();
    assert.equal(result.released.forgeRecords, 1);
    assert.deepEqual(result.archived, []);
    assert.deepEqual(f.ledger.snapshot(), before);
    assert.equal(f.ledger.hasKey(f.key), false);
    assert.deepEqual(f.ledger.confirmedCounters(), { forgeStarts: 1, forgeGold: 2000 });
  });

  await test('旧版本无角色和operation标记仍按账号区服及锻造标签同步', async () => {
    const f = fixture({ legacy: true });
    assert.equal((await f.sync()).released.materialReservations, 1);
    assert.equal(f.operation.confirmed, false);
  });

  await test('未知领取与开工一起归档，归档后的迟到拒绝保留历史预算', async () => {
    const f = fixture();
    const claimKey = 'forgeClaim:' + f.player.worldId + ':1';
    const claim = f.ledger.reserve({}, {}, {}, { uniqueKey: claimKey, details: { kind: 'forgeClaim', buildingId: '1装备厂' } });
    assert.equal((await f.sync()).archived.length, 2);
    f.ledger.cancel(claim); f.ledger.confirm(claim);
    assert.equal(f.ledger.keyRecords()['forgeHistory:' + claim.id].confirmed, false);
    assert.equal(f.ledger.snapshot().uncertain, 2);
  });

  for (const failure of ['water-read', 'equip-read', 'item-read', 'resource-read', 'buildings-missing', 'building-duplicate',
    'factory-missing', 'making-invalid', 'equips-missing', 'equip-duplicate', 'items-missing', 'item-duplicate',
    'item-unsafe', 'resources-missing', 'resource-duplicate', 'gold-missing', 'gold-unsafe', 'identity', 'world', 'epoch', 'pause',
    'new-material', 'ledger-details', 'archive-failure']) {
    await test('同步失败保留旧记录与资源屏障：' + failure, async () => {
      const f = fixture(), identity = { ...f.player }, original = f.ledger.keyRecords();
      f.state.beforeRead = name => {
        if (failure === 'water-read' && name === 'OnWaterRequest' || failure === 'equip-read' && name === 'EquipsRequest'
          || failure === 'item-read' && name === 'AllItemRequest' || failure === 'resource-read' && name === 'AllResourceRequest') throw new Error('模拟读取失败');
      };
      f.state.transform = (name, value) => {
        if (name === 'OnWaterRequest') {
          if (failure === 'buildings-missing') return {};
          if (failure === 'building-duplicate') value.building.push(value.building[0]);
          if (failure === 'factory-missing') value.building = [];
          if (failure === 'making-invalid') value.building[0].equipMaking = { makeId: 1001, finishTime: -1 };
        }
        if (name === 'EquipsRequest') {
          if (failure === 'equips-missing') return {};
          if (failure === 'equip-duplicate') value.equip = [{ uid: '1', equipId: '蓝武器1', star: 0 }, { uid: '1', equipId: '蓝武器1', star: 0 }];
        }
        if (name === 'AllItemRequest') {
          if (failure === 'items-missing') return {};
          if (failure === 'item-duplicate') value.items.push(value.items[0]);
          if (failure === 'item-unsafe') value.items[0].num = '9007199254740993';
        }
        if (name === 'AllResourceRequest') {
          if (failure === 'resources-missing') return {};
          if (failure === 'resource-duplicate') value.list.push(value.list[0]);
          if (failure === 'gold-missing') value.list = [];
          if (failure === 'gold-unsafe') value.list[0].amount = { low: -1, high: 2097152 };
        }
        return value;
      };
      f.state.afterRead = name => {
        if (name !== 'AllResourceRequest') return;
        if (failure === 'identity') f.player.playerId++;
        if (failure === 'world') f.player.worldId++;
        if (failure === 'epoch') f.client.connectionEpoch++;
        if (failure === 'pause') f.state.active = false;
        if (failure === 'new-material') beginOrderMaterialSpend(f.player, [{ id: '其他材料', have: 20, need: 1 }], '新任务', { operation: {} });
        if (failure === 'ledger-details') f.ledger.updateKeyDetails(f.key, { ...original[f.key].details, finishTime: now + 200 });
      };
      if (failure === 'archive-failure') f.ledger.archiveManualForge = () => { throw new Error('模拟持久化失败'); };
      await assert.rejects(f.sync());
      assert.equal(pendingGoldSpend(identity), f.gold);
      assert(pendingOrderMaterialSpends(identity).includes(f.material));
      assert.equal(f.ledger.keyRecords()[f.key].id, f.ticket.id);
      assert.equal(Object.keys(f.ledger.keyRecords()).some(key => key.startsWith('forgeHistory:')), false);
      assert.equal(f.operation.confirmed, false);
    });
  }

  await test('金币被新任务替换时不删除新金币屏障', async () => {
    const f = fixture();
    let fresh;
    f.state.afterRead = name => {
      if (name === 'AllResourceRequest') {
        cancelUnsentGold(f.gold);
        fresh = reserveGold(f.player, 8000, 100, 'PetBreedRequest', { operation: {} });
      }
    };
    await assert.rejects(f.sync(), /金币记录已变化/);
    assert.equal(pendingGoldSpend(f.player), fresh);
    assert.equal(f.ledger.keyRecords()[f.key].id, f.ticket.id);
  });

  await test('归档提交后异常可重试完成内存清理，未知历史保留一份', async () => {
    const f = fixture(), archive = f.ledger.archiveManualForge;
    f.ledger.archiveManualForge = records => { archive(records); throw new Error('模拟提交后中断'); };
    await assert.rejects(f.sync());
    assert.equal(pendingGoldSpend(f.player), f.gold);
    f.ledger.archiveManualForge = archive;
    await f.sync();
    assert.equal(pendingGoldSpend(f.player), null);
    assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
    assert.equal(Object.keys(f.ledger.keyRecords()).length, 1);
    assert.equal(f.ledger.snapshot().uncertain, 1);
  });

  await test('其他账号区服和其他玩法记录均保留', async () => {
    const f = fixture(), other = fixture();
    const otherWorld = f.ledger.reserve({ forgeStarts: 1 }, {}, {}, { uniqueKey: 'forge:2002001:1', details: { kind: 'forgeStart', buildingId: '1装备厂' } });
    const unrelated = beginOrderMaterialSpend(f.player, [{ id: '其他材料', have: 20, need: 1 }], '海兽投喂', { operation: {} });
    const diamonds = f.ledger.reserve({ diamonds: 20 }, {}, {}, { uniqueKey: 'other:paid' });
    await f.sync();
    assert.equal(f.ledger.keyRecords()['forge:2002001:1'].id, otherWorld.id);
    assert.equal(f.ledger.keyRecords()['other:paid'].id, diamonds.id);
    assert(pendingOrderMaterialSpends(f.player).includes(unrelated));
    assert.equal(pendingGoldSpend(other.player), other.gold);
    assert(other.ledger.hasKey(other.key));
  });

  await test('归档跨账本重建与换日继续保持未知，用量不会退款或冒认成功', async () => {
    const f = fixture();
    await f.sync();
    const tomorrow = createUsageLedger(String(f.player.playerId), { file: f.file, now: () => Date.now() + 86400000 });
    assert.equal(tomorrow.keyRecords()['forgeHistory:' + f.ticket.id].confirmed, false);
    assert.deepEqual(tomorrow.pendingCounters(), { forgeStarts: 1, forgeGold: 2000 });
    assert.deepEqual(tomorrow.snapshot().counters, {});
    assert.deepEqual(tomorrow.confirmedCounters(), {});
  });

  await test('普通Long对象和零数量按精确整数读取', async () => {
    const f = fixture();
    f.state.transform = (name, value) => {
      if (name === 'AllItemRequest') value.items[0].num = { low: 0, high: 0, unsigned: false };
      if (name === 'AllResourceRequest') value.list[0].amount = { low: 8000, high: 0, unsigned: false };
      return value;
    };
    assert.equal((await f.sync()).archived.length, 1);
  });

  await test('同区服另一角色的记录保持原样，当前角色金币和材料正常同步', async () => {
    const f = fixture(), record = f.ledger.keyRecords()[f.key];
    f.ledger.updateKeyDetails(f.key, { ...record.details, playerId: String(f.player.playerId + 1) });
    const foreign = f.ledger.keyRecords()[f.key];
    const result = await f.sync();
    assert.deepEqual(f.ledger.keyRecords()[f.key], foreign);
    assert.deepEqual(result.archived, []);
    assert.equal(result.released.goldReservations, 1);
    assert.equal(result.released.materialReservations, 1);
    assert.equal(pendingGoldSpend(f.player), null);
    assert.equal(pendingOrderMaterialSpends(f.player).length, 0);
  });

  await test('带角色后缀的当前角色开工和领取可归档，其他角色旧键保持原样', async () => {
    const f = fixture(), record = f.ledger.keyRecords()[f.key];
    f.ledger.updateKeyDetails(f.key, { ...record.details, playerId: String(f.player.playerId + 1) });
    const foreign = f.ledger.keyRecords()[f.key];
    const ownKey = f.key + ':' + f.player.playerId;
    const claimKey = 'forgeClaim:' + f.player.worldId + ':1:' + f.player.playerId;
    const own = f.ledger.reserve({ forgeStarts: 1, forgeGold: 2000 }, {}, {}, { uniqueKey: ownKey, details: record.details });
    const claim = f.ledger.reserve({}, {}, {}, { uniqueKey: claimKey,
      details: { kind: 'forgeClaim', buildingId: '1装备厂', playerId: String(f.player.playerId), worldId: String(f.player.worldId) } });
    const result = await f.sync();
    assert.deepEqual(result.archived, ['forgeHistory:' + own.id, 'forgeHistory:' + claim.id]);
    assert.equal(f.ledger.hasKey(ownKey), false);
    assert.equal(f.ledger.hasKey(claimKey), false);
    assert.deepEqual(f.ledger.keyRecords()[f.key], foreign);
    assert.equal(f.ledger.snapshot().counters.forgeGold, 4000);
    assert.equal(f.ledger.keyRecords()['forgeHistory:' + own.id].details.archivedFrom, ownKey);
  });

  await test('其他角色后缀且无playerId的旧记录同样保持原样', async () => {
    const f = fixture(), foreignKey = 'forgeClaim:' + f.player.worldId + ':1:' + (f.player.playerId + 1);
    f.ledger.reserve({}, {}, {}, { uniqueKey: foreignKey, details: { kind: 'forgeClaim', buildingId: '1装备厂' } });
    const foreign = f.ledger.keyRecords()[foreignKey];
    await f.sync();
    assert.deepEqual(f.ledger.keyRecords()[foreignKey], foreign);
  });

  console.log('手动锻造同步专项 ' + passed + '/' + passed + ' 通过');
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}
