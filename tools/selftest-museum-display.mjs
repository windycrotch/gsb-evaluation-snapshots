// Offline protocol fixtures: never connect to a game account.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { loadProtocol } from '../src/proto.mjs';
import { loadConfig } from '../src/config.mjs';
import { createUsageLedger } from '../src/usage-ledger.mjs';
import { planMuseumDisplay, runMuseumDisplay } from '../src/museum-display.mjs';
import { defaultSettings, hasBaseWork, hasExtraWork } from '../src/automation-settings.mjs';
import { runLoop } from '../src/loop.mjs';
import { rewardSchedule } from '../src/reward-schedule.mjs';

const protocol = loadProtocol();
const tempRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(tempRoot, 'cw-museum-display-'));
const previousDataDir = process.env.CW_DATA_DIR;
process.env.CW_DATA_DIR = directory;
let passed = 0, serial = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
const codec = (name, body) => protocol[name].decode(protocol[name].encode(body).finish());
const booth = (caseIndex, antiqueId = '', overrides = {}) => ({ caseIndex, level: 1, unlocked: true, antiqueId, popularity: 0, upgradeFinishTime: 0, ...overrides });
function fixture() {
  const id = ++serial;
  const settings = { loop: { world: true }, museum: { runEnabled: true, display: true } };
  const player = { playerId: String(770000 + id), worldId: '1000001', level: 30 };
  const config = { tables: Object.fromEntries(Object.entries({
    BuildingUnlockCfg: [{ buildingType: '博物馆', buildingId: '1博物馆', playerLevel: 28 }],
    MuseumDisplayCaseCfg: [101, 102, 103, 104].map(displayCaseId => ({ areaId: 1, displayCaseId, level: 1, areaLevelReq: 1, popularityBonus: 0 })),
    AntiqueBaseCfg: [
      { antiqueId: 'ordinary', isAntique: false, color: 'RED', showName: '普通藏品' },
      { antiqueId: 'orange', isAntique: true, color: 'ORANGE', showName: '橙色展品' },
      { antiqueId: 'red', isAntique: true, color: 'RED', showName: '红色展品' },
      { antiqueId: 'unowned', isAntique: true, color: 'RED', showName: '未激活展品' },
    ],
    AntiquePopularityCfg: [{ star: 0, orangePopularity: 100, redPopularity: 200 }, { star: 1, orangePopularity: 105, redPopularity: 210 }],
  }).map(([key, data]) => [key, { data }])) };
  const state = { museum: { exhibitions: [{ exhibitionId: 1, level: 1, keywordLevels: [], cases: [booth(101), booth(102)] }],
    popularity: 0, topPopularity: 0, uncollectedRevenue: 0, revenueLastSettleTime: 0, claimedAchievements: [], exploreStages: [] },
    antiques: [{ id: 'orange', star: 1 }, { id: 'ordinary', star: 1 }, { id: 'red', star: 0 }],
    reads: [], writes: [], afterWrite: () => {}, beforeRead: () => {}, noApply: false, lost: false, invalidReply: false, failure: null };
  const client = { connected: true, connectionEpoch: 1,
    async request(name, body = {}, response = name.replace(/Request$/, 'Response')) {
      assert(protocol[name] && protocol[response], '请求和回执必须存在于真实协议');
      codec(name, body);
      if (name === 'MuseumExhibitRequest') {
        state.writes.push(structuredClone(body));
        if (state.failure) throw state.failure;
        const exhibition = state.museum.exhibitions.find(row => row.exhibitionId === body.exhibitionId);
        const target = exhibition.cases.find(row => row.caseIndex === body.caseIndex);
        assert.equal(target.antiqueId, '', '不能覆盖已有展品');
        assert(!state.museum.exhibitions.flatMap(row => row.cases).some(row => row.antiqueId === body.antiqueId), '不能把已上架藏品挪到另一展柜');
        if (!state.noApply) target.antiqueId = body.antiqueId;
        state.afterWrite(body);
        if (state.lost) throw new Error('上架回包丢失');
        return codec(response, { cases: state.invalidReply ? [] : [{ ...target, antiqueId: body.antiqueId }] });
      }
      state.reads.push(name); state.beforeRead(name);
      if (name === 'OnWaterRequest') return { building: [{ buildingId: '1博物馆', level: 1, buildFinishTime: 0 }] };
      if (name === 'AllAntiqueRequest') return codec(response, { antiques: state.antiques, suits: [], masterLv: 0 });
      if (name === 'MuseumInfoRequest') return codec(response, state.museum);
      assert.fail('意外请求：' + name);
    },
  };
  let timestamp = Date.parse('2026-11-18T04:00:00Z');
  const file = path.join(directory, id + '.json');
  const f = { state, player, config, settings, client,
    ledger: createUsageLedger('test-' + id, { file, now: () => timestamp }),
    run() { return runMuseumDisplay(this.client, protocol, config, { player, getSettings: () => settings, ledger: this.ledger }); },
    restart() { timestamp += 86400000; this.ledger = createUsageLedger('test-' + id, { file, now: () => timestamp }); this.client = { ...client, connectionEpoch: 2 }; },
  };
  return f;
}

try {
  await test('接口字段与本地客户端过滤、排序、上架行为一致', () => {
    assert.deepEqual(codec('MuseumExhibitRequest', { exhibitionId: 1, caseIndex: 101, antiqueId: '藏品橙20' }).toJSON?.() ??
      JSON.parse(JSON.stringify(codec('MuseumExhibitRequest', { exhibitionId: 1, caseIndex: 101, antiqueId: '藏品橙20' }))),
    { exhibitionId: 1, caseIndex: 101, antiqueId: '藏品橙20' });
    const tables = loadConfig().tables;
    assert(tables.AntiqueBaseCfg.data.some(row => row.isAntique === true));
    assert(tables.AntiquePopularityCfg.data.some(row => row.star === 0 && row.orangePopularity > 0));
    const sourcePath = new URL('../work/extracted/_subpackages_main_/subpackages/main/game.js', import.meta.url);
    if (fs.existsSync(sourcePath)) {
      const source = fs.readFileSync(sourcePath, 'utf8');
      assert.match(source, /MuseumExhibitRequest",\{exhibitionId:[^,]+,caseIndex:[^,]+,antiqueId:/);
      assert.match(source, /getAntiquesList=function[\s\S]{0,300}1==a.isAntique/);
      assert.match(source, /MusuemAntiqueSelectPop[\s\S]{0,3500}getPopularityValue/);
    }
  });
  await test('仅上架已激活博物馆藏品，人气高者优先且每件只放一柜', async () => {
    const f = fixture();
    const entries = await f.run();
    assert.deepEqual(f.state.writes, [
      { exhibitionId: 1, caseIndex: 101, antiqueId: 'red' }, { exhibitionId: 1, caseIndex: 102, antiqueId: 'orange' },
    ]);
    assert.equal(entries.filter(row => row.ok).length, 2);
    assert(entries.every(row => row.key === 'museum.display'));
    assert.equal(f.ledger.snapshot().uncertain, 0);
    await f.run(); assert.equal(f.state.writes.length, 2, '下轮不重复上架');
  });
  await test('已放展品、锁定柜和升级中展柜不被修改', async () => {
    const f = fixture();
    f.state.museum.exhibitions[0].cases = [booth(101, 'orange'), booth(102, '', { unlocked: false }), booth(103, '', { upgradeFinishTime: 1 }), booth(104)];
    await f.run();
    assert.deepEqual(f.state.writes, [{ exhibitionId: 1, caseIndex: 104, antiqueId: 'red' }]);
  });
  await test('其它展区已有展品也不被挪动，剩余展品优先放入高加成空柜', () => {
    const f = fixture();
    f.state.museum.exhibitions.push({ exhibitionId: 2, level: 1, cases: [booth(201, 'red')] });
    f.config.tables.MuseumDisplayCaseCfg.data.find(row => row.displayCaseId === 102).popularityBonus = 1000;
    assert.deepEqual(planMuseumDisplay(f.state.museum, f.state.antiques, f.config).actions.map(row => row.body),
      [{ exhibitionId: 1, caseIndex: 102, antiqueId: 'orange' }]);
  });
  await test('默认缺省与任何总控关闭均不读状态、不上架', async () => {
    for (const change of [f => { delete f.settings.museum.display; }, f => { f.settings.museum.display = false; },
      f => { f.settings.museum.runEnabled = false; }, f => { f.settings.loop.world = false; }]) {
      const f = fixture(); change(f); assert.deepEqual(await f.run(), []); assert.deepEqual(f.state.reads, []); assert.deepEqual(f.state.writes, []);
    }
  });
  await test('发送前重新读取空柜，手动放入的展品不能被覆盖', async () => {
    const f = fixture();
    f.state.beforeRead = name => {
      if (name === 'MuseumInfoRequest' && f.state.reads.filter(row => row === name).length === 2) f.state.museum.exhibitions[0].cases[0].antiqueId = 'orange';
    };
    await f.run();
    assert.deepEqual(f.state.writes, [{ exhibitionId: 1, caseIndex: 102, antiqueId: 'red' }]);
  });
  await test('读取期间关停、切号或连接代次变化均不发上架请求', async () => {
    for (const change of [f => { f.settings.museum.display = false; }, f => { f.player.playerId = '999999'; }, f => { f.client.connectionEpoch++; }]) {
      const f = fixture(); f.state.beforeRead = name => { if (name === 'AllAntiqueRequest') change(f); };
      await f.run(); assert.deepEqual(f.state.writes, []); assert.equal(f.ledger.snapshot().uncertain, 0);
    }
  });
  await test('预留后关闭开关释放本次未发送记录', async () => {
    const f = fixture(), reserve = f.ledger.reserve.bind(f.ledger);
    f.ledger.reserve = (...args) => { const ticket = reserve(...args); f.settings.museum.display = false; return ticket; };
    await f.run(); assert.deepEqual(f.state.writes, []); assert.equal(f.ledger.snapshot().uncertain, 0);
  });
  await test('写入后关闭开关保留未决记录，不继续上架下一件', async () => {
    const f = fixture(); f.state.afterWrite = () => { f.settings.museum.display = false; };
    const entries = await f.run(); assert.equal(f.state.writes.length, 1); assert(entries.some(row => row.status === 'pending'));
    assert.equal(f.ledger.snapshot().uncertain, 1);
    f.state.afterWrite = () => {}; f.settings.museum.display = true;
    await f.run(); assert.equal(f.state.writes.length, 2); assert.equal(f.ledger.snapshot().uncertain, 0);
  });
  await test('未知结果跨重启与换日不重发，目标展柜确认后才解除', async () => {
    const f = fixture(); f.state.noApply = f.state.lost = true;
    await f.run(); assert.equal(f.state.writes.length, 1); assert.equal(f.ledger.snapshot().uncertain, 1);
    f.restart(); f.state.lost = false;
    await f.run(); assert.equal(f.state.writes.length, 1);
    f.state.museum.exhibitions[0].cases[0].antiqueId = 'red'; f.state.noApply = false;
    await f.run(); assert.equal(f.state.writes.length, 2); assert.equal(f.ledger.snapshot().uncertain, 0);
  });
  await test('回执缺少目标或回读未同步不能报告成功', async () => {
    for (const change of [f => { f.state.invalidReply = true; }, f => { f.state.noApply = true; }]) {
      const f = fixture(); change(f); const entries = await f.run();
      assert(!entries.some(row => row.ok)); assert.equal(f.state.writes.length, 1); assert.equal(f.ledger.snapshot().uncertain, 1);
    }
  });
  await test('同请求明确拒绝或未发送释放记录，普通错误不释放', async () => {
    for (const [failure, expected] of [
      [Object.assign(new Error('拒绝上架'), { prompt: {}, request: 'MuseumExhibitRequest' }), 0],
      [Object.assign(new Error('未发送'), { notSent: true }), 0],
      [Object.assign(new Error('其它请求拒绝'), { prompt: {}, request: 'AllAntiqueRequest' }), 1],
    ]) {
      const f = fixture(); f.state.failure = failure; await f.run(); assert.equal(f.ledger.snapshot().uncertain, expected);
    }
  });
  await test('重复展柜、重复藏品与不完整列表不能生成上架计划', () => {
    const f = fixture();
    assert.throws(() => planMuseumDisplay({}, f.state.antiques, f.config), /未完整读取/);
    f.state.museum.exhibitions[0].cases.push(booth(101));
    assert.throws(() => planMuseumDisplay(f.state.museum, f.state.antiques, f.config), /重复/);
    const g = fixture(); g.state.antiques.push(g.state.antiques[0]);
    assert.throws(() => planMuseumDisplay(g.state.museum, g.state.antiques, g.config), /异常/);
  });
  await test('未解锁博物馆不读游戏，无持久账本不发上架请求', async () => {
    const f = fixture(); f.player.level = 20; await f.run(); assert.deepEqual(f.state.reads, []);
    const g = fixture(); g.ledger = null; await g.run(); assert.deepEqual(g.state.writes, []);
  });
  await test('同账号重叠检查不能同时给空柜上架', async () => {
    const f = fixture(), request = f.client.request;
    let release, observed;
    const paused = new Promise(resolve => { release = resolve; });
    const reached = new Promise(resolve => { observed = resolve; });
    let held = false;
    f.client.request = async (...args) => {
      if (args[0] === 'MuseumInfoRequest' && !held) { held = true; observed(); await paused; }
      return request(...args);
    };
    const first = f.run(); await reached;
    const second = await f.run();
    assert(second.some(row => /正在核对/.test(row.reason ?? '')));
    assert.deepEqual(f.state.writes, []);
    release(); await first;
    assert.equal(f.state.writes.length, 2);
  });
  await test('真实挂机只开上架即可执行并保留未知状态，关闭任一总控后不执行', async () => {
    for (const gate of [null, 'world', 'runEnabled', 'display', 'pending']) {
      const f = fixture(), settings = defaultSettings();
      settings.loop.world = settings.museum.runEnabled = settings.museum.display = true;
      if (gate === 'world') settings.loop.world = false;
      else if (gate === 'pending') f.state.lost = f.state.noApply = true;
      else if (gate) settings.museum[gate] = false;
      assert.equal(hasExtraWork(settings), gate === null || gate === 'pending');
      assert.equal(hasBaseWork(settings), gate === null || gate === 'pending');
      assert.equal(settings.museum.enabled, false, '上架不依赖自动探宝');
      const request = f.client.request, unexpected = [], reports = [];
      let queued = false;
      const client = Object.assign(new EventEmitter(), f.client);
      client.setMaxListeners(100);
      client.request = async (name, ...args) => {
        assert(queued, '读写必须位于账号串行队列内');
        if (name === 'AllItemRequest') return { items: [] };
        if (name === 'AllResourceRequest') return { list: [] };
        if (!['OnWaterRequest', 'AllAntiqueRequest', 'MuseumInfoRequest', 'MuseumExhibitRequest'].includes(name)) unexpected.push(name);
        return request(name, ...args);
      };
      client.sendWatch = async name => assert.fail('上架不应发送sendWatch写操作：' + name);
      const names = ['OnWater', 'AllItem', 'AllResource', 'MuseumInfo', 'AllAntique', 'MuseumExhibit'];
      const loopProtocol = Object.fromEntries(names.flatMap(name => [name + 'Request', name === 'MuseumExhibit' ? 'MuseumCaseUpdateResponse' : name + 'Response']).map(name => [name, protocol[name]]));
      f.config.tables.BuildingCfg = { data: [{ buildingType: '博物馆' }] };
      const history = await runLoop(client, loopProtocol, { config: f.config, player: f.player, rounds: 1, allowMutate: true,
        usageLedger: f.ledger, getSettings: () => settings, isEnabled: () => false,
        async schedule(work) { assert.equal(queued, false); queued = true; try { return await work(); } finally { queued = false; } },
        onStep(entry) { reports.push(entry); } });
      assert.equal(history.history.length, 1);
      assert.deepEqual(unexpected, []);
      assert.equal(f.state.writes.length, gate === null ? 2 : gate === 'pending' ? 1 : 0);
      if (!gate) {
        assert.equal(reports.filter(row => row.taskKey === 'museum.display' && row.ok).length, 2);
        assert.equal(rewardSchedule(client).status('museum.display')?.state, 'ok');
        assert.equal(rewardSchedule(client).status('museum.runEnabled')?.state, 'ok');
      }
      if (gate === 'pending') {
        assert.equal(rewardSchedule(client).status('museum.display')?.state, 'pending');
        assert.equal(rewardSchedule(client).status('museum.runEnabled')?.state, 'pending');
      } else assert.deepEqual(reports.filter(row => row.ok === false && !row.skipped), []);
    }
  });
  await test('真实挂机只开人气币或人气奖励各自发正确协议，不开启探宝派遣', async () => {
    for (const kind of ['revenue', 'achievements']) {
      const f = fixture(), settings = defaultSettings();
      settings.loop.world = settings.museum.runEnabled = settings.museum[kind] = true;
      assert.equal(settings.museum.enabled, false);
      assert.equal(settings.museum.display, false);
      assert.equal(hasExtraWork(settings), true); assert.equal(hasBaseWork(settings), true);
      f.state.museum.uncollectedRevenue = 12;
      f.state.museum.topPopularity = 100;
      f.config.tables.MuseumAchievementCfg = { data: [{ score: 100 }] };
      f.config.tables.BuildingCfg = { data: [{ buildingType: '博物馆' }] };
      const client = Object.assign(new EventEmitter(), f.client), request = f.client.request;
      client.setMaxListeners(100);
      const writes = [], unexpected = [], reports = [];
      client.request = async (name, body = {}, response) => {
        if (name === 'AllItemRequest') return { items: [] };
        if (name === 'AllResourceRequest') return { list: [] };
        if (name === 'MuseumCollectRevenueRequest') {
          assert.equal(kind, 'revenue'); writes.push(name);
          const collected = f.state.museum.uncollectedRevenue; f.state.museum.uncollectedRevenue = 0;
          return codec('MuseumCollectRevenueResponse', { collected });
        }
        if (!['OnWaterRequest', 'MuseumInfoRequest'].includes(name)) unexpected.push(name);
        return request(name, body, response);
      };
      client.sendWatch = async (name, body) => {
        assert.equal(kind, 'achievements'); assert.equal(name, 'MuseumClaimAchievementRequest');
        assert.equal(Number(body.popularityThreshold), 100);
        writes.push(name); f.state.museum.claimedAchievements.push(body.popularityThreshold);
        return { sent: 1 };
      };
      const names = ['OnWater', 'AllItem', 'AllResource', 'MuseumInfo', 'MuseumCollectRevenue'];
      const loopProtocol = { ...Object.fromEntries(names.flatMap(name => [name + 'Request', name + 'Response']).map(name => [name, protocol[name]])),
        MuseumClaimAchievementRequest: protocol.MuseumClaimAchievementRequest };
      const result = await runLoop(client, loopProtocol, { config: f.config, player: f.player, rounds: 1, allowMutate: true,
        usageLedger: f.ledger, getSettings: () => settings, isEnabled: () => false, onStep: entry => reports.push(entry) });
      assert.equal(result.history.length, 1);
      assert.deepEqual(unexpected, []);
      assert.deepEqual(writes, [kind === 'revenue' ? 'MuseumCollectRevenueRequest' : 'MuseumClaimAchievementRequest']);
      assert.deepEqual(f.state.writes, [], '不得派遣或上架');
      assert(reports.some(row => row.taskKey === 'museum.' + kind && row.ok));
      assert.deepEqual(reports.filter(row => row.ok === false && !row.skipped), []);
    }
  });
} finally {
  if (previousDataDir === undefined) delete process.env.CW_DATA_DIR;
  else process.env.CW_DATA_DIR = previousDataDir;
  const resolved = fs.realpathSync(directory);
  assert(resolved.startsWith(tempRoot + path.sep) && path.basename(resolved).startsWith('cw-museum-display-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
console.log(`博物馆自动上架专项 ${passed}/${passed} 通过`);
