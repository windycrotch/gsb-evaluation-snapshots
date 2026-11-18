import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {loadProtocol} from '../src/proto.mjs';
import {getConfig} from '../src/config.mjs';
import {automationWireId,exactAutomationId} from '../src/automation-policy.mjs';
import {createUsageLedger,defaultSettings,validateSettings,importAutomationSettings,exportAutomationSettings} from '../src/automation-settings.mjs';
import {cleanupAfterClaim} from '../src/claim-cleanup.mjs';
import {fishOnce} from '../src/fishing.mjs';
import {runtimeProgress} from '../src/runtime-progress.mjs';
import { runEquipmentForge } from '../src/equipment-forge.mjs';
import { planBaseAutomation, runBaseAutomation } from '../src/base-automation.mjs';
import { warForgeFixture, warForgeSettings } from './fixtures/war-forge.mjs';
const protocol = loadProtocol(), config = getConfig(), folder = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-claim-'));
const uid = n => automationWireId((9007199254740992n + BigInt(n)).toString());
const id = n => exactAutomationId(uid(n));
let sequence = 0, passed = 0;

function fixture(kind) {
  const equipment = kind === 'forge';
  const settings = defaultSettings(), group = settings[kind];
  const toggle = equipment ? 'decompose' : 'release';
  const choice = equipment ? 'decomposeQualities' : 'releaseQualities';
  const prefix = equipment ? 'equip-dispose:' : 'pet-release:';
  const file = path.join(folder, 'cleanup-' + ++sequence + '.json');
  const account = 'fixture';
  const table = config.tables[equipment ? 'EquipCfg' : 'PetBreedCfg'].data;
  const item = (number, quality = 'BLUE', extra = {}) => ({
    uid: uid(number), [equipment ? 'equipId' : 'petId']: table.find(row => row.quality === quality)[equipment ? 'id' : 'petId'],
    level: 1, star: 0, grade: 0, refineLv: 0, ...extra,
  });
  group[toggle] = true; group[choice] = ['BLUE'];
  const f = { kind, settings, group, toggle, choice, prefix, file, item, rows: [item(1)], occupied: [],
    enabled: true, remove: true, writes: [], calls: [], ledger: createUsageLedger(account, { file }),
    beforeRead: null, writeError: null, afterWrite: null, mutateBeforeWrite: null };
  const writeName = equipment ? 'DecomposeEquipRequest' : 'FreePetRequest';
  const write = async (name, body) => {
    assert.equal(name, writeName);
    if (f.writeError) throw f.writeError;
    const wire = protocol[name].decode(protocol[name].encode(body).finish());
    const picked = (wire.uid ?? wire.petUid).map(exactAutomationId);
    await f.mutateBeforeWrite?.(picked);
    f.writes.push(picked);
    if (f.remove) f.rows = f.rows.filter(row => !picked.includes(exactAutomationId(row.uid)));
    await f.afterWrite?.();
    return {};
  };
  const newClient = () => ({
    connected: true, connectionEpoch: 1, socket: {}, login: {},
    async request(name, body, response) {
      if (name === writeName) return write(name, body);
      f.calls.push(name);
      await f.beforeRead?.(name);
      const replies = {
        AllHeroRequest: { heroes: [{ equips: f.occupied.map(number => item(number)) }] },
        EquipsRequest: { equip: f.rows }, AllPetRequest: { pets: f.rows },
        OnWaterRequest: { building: [{ buildingId: '1海兽值守', level: 1, petServe: { petUid: f.occupied.length ? uid(f.occupied[0]) : 0 } }] },
        GetFormationRequest: { formation: {} },
        LeagueInfoRequest: { dan: 1, settleTime: 0, bonusItemNum: 0, nextPointTime: 0, predictDan: 0, maxPage: 0, roomDan: 1, ownFormations: [] },
      };
      assert(name in replies, '夹具未声明读取 ' + name);
      return protocol[response].decode(protocol[response].encode(replies[name]).finish());
    },
    sendWatch: write,
  });
  f.client = newClient();
  f.newClient = newClient;
  f.run = (client = f.client, ledger = f.ledger) => cleanupAfterClaim(client, config, settings, ledger, kind, () => f.enabled);
  f.restart = () => { f.ledger = createUsageLedger(account, { file }); f.client = newClient(); };
  f.key = number => prefix + id(number);
  return f;
}

async function check(name, run) {
  await run(); passed++; console.log('通过：' + name);
}

for (const kind of ['forge', 'pet']) {
  await check(kind + ' 开关、品质、大 UID、占用和养成保护', async () => {
    const f = fixture(kind);
    f.group[f.toggle] = false; assert.equal(await f.run(), null);
    f.group[f.toggle] = true; f.group[f.choice] = [];
    assert.throws(() => validateSettings(f.settings));
    f.group[f.choice] = ['BLUE']; f.enabled = false; assert.equal(await f.run(), null); f.enabled = true;
    f.rows = [f.item(1), f.item(2), f.item(3, 'BLUE', { level: 4 }), f.item(4, 'ORANGE'), f.item(5, 'BLUE', { star: 3 }), f.item(6)];
    f.occupied = [2];
    assert.equal((await f.run()).status, 'confirmed');
    assert.deepEqual(f.writes, [[1, 5, 6].map(id)]);
    await f.run(); assert.equal(f.writes.length, 1);
  });

  await check(kind + ' 玩家手动处理后重建账本自动核销旧 UID', async () => {
    const f = fixture(kind); f.remove = false;
    assert.equal((await f.run()).status, 'unknown');
    assert.equal(f.ledger.snapshot().uncertain, 1);
    f.rows = []; f.restart();
    const recovered = await f.run();
    assert.equal(recovered.status, 'confirmed'); assert.match(recovered.note, /核销 1 项旧记录/);
    assert.equal(f.ledger.snapshot().uncertain, 0); assert.equal(f.ledger.keyRecords()[f.key(1)].confirmed, true);
    assert.equal(f.writes.length, 1);
  });

  await check(kind + ' 未知结果存活 UID 重新完整复核后恢复重试', async () => {
    const f = fixture(kind); f.remove = false;
    await f.run(); f.restart(); f.remove = true;
    let attempts;
    f.mutateBeforeWrite = () => { attempts = f.ledger.keyRecords()[f.key(1)].details.attempts; };
    const recovered = await f.run();
    assert.equal(recovered.status, 'confirmed'); assert.match(recovered.note, /重试原 UID/);
    assert.deepEqual(f.writes, [[id(1)], [id(1)]]); assert.equal(attempts, 2);
    assert.equal(f.ledger.snapshot().uncertain, 0);
  });

  await check(kind + ' 无 details 的旧持久键也能核销或恢复', async () => {
    const f = fixture(kind);
    f.ledger.reserve({}, {}, {}, { uniqueKey: f.key(1) });
    f.ledger.reserve({}, {}, {}, { uniqueKey: f.key(2) });
    f.restart();
    assert.equal((await f.run()).status, 'confirmed');
    assert.deepEqual(f.writes, [[id(1)]]); assert(Object.values(f.ledger.keyRecords()).every(record => record.confirmed));
  });

  await check(kind + ' 玩家穿戴、上阵、养成或改品质后旧记录不触发处理', async () => {
    for (const change of ['occupied', 'level', 'quality']) {
      const f = fixture(kind); f.remove = false; await f.run(); f.restart();
      if (change === 'occupied') f.occupied = [1];
      if (change === 'level') f.rows[0].level = 2;
      if (change === 'quality') f.group[f.choice] = ['PURPLE'];
      const result = await f.run();
      assert.equal(f.writes.length, 1); assert.equal(f.rows.length, 1);
      assert.match(result.note, /当前占用、品质或养成/); assert.equal(f.ledger.snapshot().uncertain, 0);
    }
  });

  await check(kind + ' 第二次复核发生占用变化时保护原 UID', async () => {
    const f = fixture(kind); let reads = 0;
    const ownershipRead = kind === 'forge' ? 'AllHeroRequest' : 'OnWaterRequest';
    f.beforeRead = name => { if (name === ownershipRead && ++reads === 2) f.occupied = [1]; };
    await f.run(); assert.equal(f.writes.length, 0); assert.equal(f.ledger.snapshot().uncertain, 0);
  });

  await check(kind + ' 同连接及重建账本并发只发送一次', async () => {
    const f = fixture(kind);
    await Promise.all([f.run(), f.run()]); assert.equal(f.writes.length, 1);
    const g = fixture(kind); g.remove = false; await g.run();
    g.remove = true;
    await Promise.all([g.run(), g.run(g.newClient(), createUsageLedger('fixture', { file: g.file }))]);
    assert.equal(g.writes.length, 2); assert.equal(g.ledger.snapshot().uncertain, 0);
  });

  await check(kind + ' 已确认 UID 的旧库存回显不会再次发送', async () => {
    const f = fixture(kind); const old = structuredClone(f.rows);
    await f.run(); f.rows = old; f.restart();
    await f.run();
    assert.equal(f.writes.length, 1); assert.equal(f.ledger.keyRecords()[f.key(1)].confirmed, true);
  });

  await check(kind + ' 部分成功后只重试存活 UID', async () => {
    const f = fixture(kind); f.rows.push(f.item(2)); f.remove = false;
    f.afterWrite = () => { f.rows = f.rows.filter(row => exactAutomationId(row.uid) !== id(1)); };
    assert.equal((await f.run()).status, 'unknown'); assert.equal(f.ledger.snapshot().uncertain, 1);
    f.restart(); f.afterWrite = null; f.remove = true;
    assert.equal((await f.run()).status, 'confirmed'); assert.deepEqual(f.writes, [[id(1), id(2)], [id(2)]]);
    assert.equal(f.ledger.snapshot().uncertain, 0);
  });

  await check(kind + ' 不同账号的相同 UID 各自处理', async () => {
    const f = fixture(kind); f.remove = false;
    const otherLedger = createUsageLedger('other-fixture', { file: f.file });
    await Promise.all([f.run(), f.run(f.newClient(), otherLedger)]);
    assert.equal(f.writes.length, 2);
    assert.equal(f.ledger.snapshot().uncertain, 1); assert.equal(otherLedger.snapshot().uncertain, 1);
  });

  await check(kind + ' 暂停、改设置和换连接中断复核', async () => {
    for (const change of ['pause', 'toggle', 'qualities', 'epoch', 'socket', 'login']) {
      const f = fixture(kind);
      f.beforeRead = () => {
        if (change === 'pause') f.enabled = false;
        if (change === 'toggle') f.group[f.toggle] = false;
        if (change === 'qualities') f.group[f.choice] = ['PURPLE'];
        if (change === 'epoch') f.client.connectionEpoch++;
        if (change === 'socket') f.client.socket = {};
        if (change === 'login') f.client.login = {};
      };
      assert.equal((await f.run()).skipped, true);
      assert.equal(f.writes.length, 0); assert.equal(f.ledger.snapshot().uncertain, 0);
    }
  });

  await check(kind + ' 明确未发送和对应写请求拒绝释放新预留', async () => {
    for (const notSent of [true, false]) {
      const f = fixture(kind);
      f.writeError = Object.assign(new Error('fixture rejection'), notSent ? { notSent: true }
        : { prompt: {}, request: kind === 'forge' ? 'DecomposeEquipRequest' : 'FreePetRequest' });
      assert.equal((await f.run()).status, notSent ? 'not-sent' : 'rejected');
      assert.equal(f.ledger.snapshot().uncertain, 0); assert.equal(f.ledger.hasKey(f.key(1)), false);
    }
  });

  await check(kind + ' 预留后暂停会撤销尚未发送的新记录', async () => {
    const f = fixture(kind); const reserve = f.ledger.reserve;
    f.ledger.reserve = (...args) => { const ticket = reserve(...args); f.enabled = false; return ticket; };
    await f.run(); assert.equal(f.writes.length, 0); assert.equal(f.ledger.snapshot().uncertain, 0);
  });

  await check(kind + ' 重试明确未发送仍保留上次未知记录', async () => {
    const f = fixture(kind); f.remove = false; await f.run();
    f.writeError = Object.assign(new Error('not sent'), { notSent: true });
    assert.equal((await f.run()).status, 'not-sent');
    assert.equal(f.ledger.snapshot().uncertain, 1);
    assert.match(f.ledger.keyRecords()[f.key(1)].details.reason, /保留上次/);
  });

  await check(kind + ' 写入后的查询失败及其他请求拒绝保留未知记录', async () => {
    const f = fixture(kind); f.remove = false;
    f.afterWrite = () => { f.beforeRead = () => { throw Object.assign(new Error('read not sent'), { notSent: true }); }; };
    assert.equal((await f.run()).status, 'unknown'); assert.equal(f.ledger.snapshot().uncertain, 1);
    const g = fixture(kind);
    g.writeError = Object.assign(new Error('unrelated prompt'), { prompt: {}, request: 'OtherRequest' });
    assert.equal((await g.run()).status, 'unknown'); assert.equal(g.ledger.snapshot().uncertain, 1);
  });
}

await check('蓝紫橙自然高星可放生，红色已升星保持保护', async () => {
  const f = fixture('pet'); f.group.releaseQualities = ['BLUE', 'PURPLE', 'ORANGE', 'RED'];
  f.rows = []; const expected = []; let number = 1;
  for (const quality of f.group.releaseQualities) for (const star of [0, 1, 2, 5]) {
    f.rows.push(f.item(number, quality, { star }));
    if (quality !== 'RED' || star === 0) expected.push(id(number));
    number++;
  }
  assert.equal((await f.run()).status, 'confirmed'); assert.deepEqual(f.writes, [expected]);
  assert.deepEqual(f.rows.map(row => row.star), [1, 2, 5]);
});

await check('锻造正常入口无新领取时也处理闲置库存', async () => {
  const f = warForgeFixture(), settings = warForgeSettings();
  Object.assign(settings.forge, { decompose: true, decomposeQualities: ['BLUE'], dailyLimit: 0 });
  f.config.tables.EquipCfg = { data: [{ id: '旧装备', quality: 'BLUE' }] };
  f.state.equipment[0].refineLv = 0;
  const request = f.client.request;
  f.client.request = async (name, body, response) => {
    if (name === 'AllHeroRequest') return protocol.AllHeroResponse.decode(protocol.AllHeroResponse.encode({ heroes: [{ equips: [] }] }).finish());
    if (name === 'DecomposeEquipRequest') {
      f.client.writes.push({ name, body }); f.state.equipment = []; return {};
    }
    return request(name, body, response);
  };
  const result = await runEquipmentForge(f.client, f.protocol, f.config, f.player, {
    getSettings: () => settings, ledger: createUsageLedger('forge-entry', { file: path.join(folder, 'entry.json') }),
  });
  assert.deepEqual(f.client.writes.map(row => row.name), ['DecomposeEquipRequest']);
  assert(result.results.some(row => row.step.kind === 'forgeDecompose' && row.status === 'confirmed'));
});

await check('基地正常入口关闭领取仅开放生仍处理库存', async () => {
  const f = fixture('pet');
  f.settings.loop.world = true; f.settings.pet.enabled = true; f.settings.pet.claim = false;
  f.settings.pet.breed = f.settings.pet.feed = f.settings.pet.advance = false;
  const snapshot = {
    now: Math.floor(Date.now() / 1000), player: { playerId: 1, worldId: 1001001, level: 30 },
    world: { buildings: [], stock: new Map(), factories: [], stockCap: 1000000 },
    notes: [], choices: [], pets: [], raids: [],
  };
  const plan = planBaseAutomation(snapshot, config, f.settings);
  assert.equal(plan.actions.length, 0);
  const results = await runBaseAutomation(f.client, protocol, config, plan, {
    getSettings: () => f.settings, ledger: f.ledger, enabled: () => true,
  });
  assert.deepEqual(f.writes, [[id(1)]]);
  assert(results.some(row => row.step.kind === 'petRelease' && row.status === 'confirmed'));
});

console.log(`清理恢复专项 ${passed}/${passed} 通过`);
const now=Date.UTC(2026,10,5,8);
for(const key of ['schedule.freeRecruit','schedule.freeAntiqueRecruit']){
 const value=Math.floor(Date.UTC(2026,10,5,10,53,28)/1000);
 assert.equal(runtimeProgress({key,enabled:true},{text:'2/2 · 今日目标已完成'},{counters:{}},{connected:true,running:true,now,freeTimes:{hero:value,antique:value}}).progress,'下次 18:53:28');
}
const catalog=config.tables.FishBaseCfg.data.map(x=>x.fishId);let fishIds=catalog.slice(1),casts=0,closed=0;
const c={async request(n){switch(n){case 'OnWaterRequest':return {building:[{buildingId:'1钓鱼椅',level:1}],fishingLevel:{level:10}};case 'GameEffectRequest':return {effects:[{id:16,value:100}]};case 'AllItemRequest':return {items:[{itemId:'鱼',num:100}]};case 'FishEncyclopediaRequest':return {fishList:fishIds,rewardId:0};case 'StartFishingRequest':casts++;return {fishId:catalog[0]};case 'GainBigFishRequest':fishIds=catalog;return {isNew:true};default:throw Error(n);}}};
await fishOnce(c,config,()=>true);assert.equal(casts,0);
await fishOnce(c,config,()=>true,{fishBook:true,dryRun:true});assert.equal(casts,0);
await fishOnce(c,config,()=>true,{fishBook:true,onBookComplete:()=>closed++});assert.equal(casts,1);assert.equal(closed,1);
await fishOnce(c,config,()=>true,{fishBook:true,dryRun:true,onBookComplete:()=>closed++});assert.equal(casts,1);assert.equal(closed,1);
const old={...exportAutomationSettings(defaultSettings()),version:1};delete old.settings.pet.release;delete old.settings.pet.releaseQualities;delete old.settings.forge.decompose;delete old.settings.forge.decomposeQualities;delete old.settings.gather.fishBook;
assert.equal(importAutomationSettings(old).forge.decompose,false);
console.log('通过：双招募时间、旧配置、满仓开拓及集齐停用、预览只读、精确品质/UID、占用和养成保护、未知结果复核恢复。');
