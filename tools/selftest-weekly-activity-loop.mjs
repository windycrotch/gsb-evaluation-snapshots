// Exercise the real loop: the native task callback deliberately retains the
// user's old selections while weekly activity owns their execution.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createDeclaredProtocol } from './fixtures/declared-protocol.mjs';

const temporaryRoot = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(temporaryRoot, 'cw-weekly-loop-'));
const previousDataDir = process.env.CW_DATA_DIR;
process.env.CW_DATA_DIR = directory;
const { runLoop } = await import('../src/loop.mjs');
const { defaultSettings, createUsageLedger, hasExtraWork } = await import('../src/automation-settings.mjs');

const protocol = createDeclaredProtocol([
  'CrossRankInfoRequest', 'CrossRankInfoResponse',
  'DailyTaskInfoRequest', 'DailyTaskInfoResponse',
  'AllItemRequest', 'AllItemResponse', 'OnWaterRequest', 'OnWaterResponse',
  'RecruitInfoRequest', 'RecruitInfoResponse', 'RecruitStartRequest', 'RecruitStartResponse',
  'GuildInfoRequest', 'GuildInfoResponse', 'GuildOrderRequest', 'GuildOrderResponse',
  'GuildCityInfoRequest', 'GuildCityInfoResponse', 'CounterInfoRequest', 'CounterInfoResponse',
]);
const nativeTasks = ['guildOrders', 'petCollect', 'petBreed', 'ticketRecruit'];
let serial = 0, passed = 0;
async function test(name, work) {
  await work(); passed++; console.log('通过：' + name);
}

function fixture({ master = true, selected = nativeTasks, state = {}, time = '2026-11-16T04:00:00Z' } = {}) {
  const id = ++serial;
  const settings = defaultSettings();
  for (const key of Object.keys(settings.schedule)) settings.schedule[key] = false;
  Object.assign(settings.loop, { tasks: false, world: false, heroes: false, dailies: true });
  settings.dailies.enabled = true;
  Object.assign(settings.weeklyActivity, { enabled: master, farmEnabled: true, petEnabled: true, heroEnabled: true });
  for (const key of nativeTasks) settings.schedule[key] = true;
  const before = structuredClone(settings);
  const player = { playerId: String(9900000 + id), worldId: 2000001, guildId: '7', level: 40 };
  const now = Date.parse(time) / 1000;
  const client = new EventEmitter();
  client.setMaxListeners(50);
  client.connected = true;
  client.serverClockOffsetMs = Date.parse(time) - Date.now();
  client.promptNames = {};
  const calls = [], writes = [], unexpected = [], reports = [], queriedTasks = [];
  let recruited = false;
  const handlers = {
    CrossRankInfoRequest: () => ({ grouping: true, subjectId: 6, roomLevel: 40, settleTime: now + 3600,
      rankList: [{ playerId: player.playerId, score: 0 }], ...state }),
    DailyTaskInfoRequest: () => ({ dailyTask: [{ id: 1002, progress: recruited ? 1 : 0, targetProgress: 1 }], dailyResetTime: now + 3600 }),
    AllItemRequest: () => ({ items: [{ itemId: '抽卡券', num: recruited ? 0 : 1 }] }),
    OnWaterRequest: () => ({ building: [{ buildingId: '1广播站', level: 1 }], workerOrder: [] }),
    RecruitInfoRequest: () => ({ hero: { freeEndTimeSeconds: now + 3600 } }),
    RecruitStartRequest: body => {
      assert.equal(body.way, 2, '只恢复原来的用券单抽，免费次数尚未到期');
      recruited = true; writes.push(['RecruitStartRequest', body]);
      return { recruitData: { freeEndTimeSeconds: now + 3600 } };
    },
    GuildInfoRequest: () => ({ guild: { guildId: player.guildId } }),
    GuildOrderRequest: () => ({ order: { requirements: [], nextRefreshTime: now + 3600 } }),
    GuildCityInfoRequest: () => ({ cities: [] }),
    CounterInfoRequest: () => ({ counters: [] }),
  };
  client.request = async (name, body = {}, response) => {
    calls.push(name);
    if (!handlers[name]) { unexpected.push(name); throw Error('未预期请求 ' + name); }
    assert(protocol[name], name);
    for (const reply of [response].flat().filter(Boolean)) assert(protocol[reply], reply);
    return handlers[name](body);
  };
  client.sendWatch = async name => { unexpected.push(name); throw Error('未预期写请求 ' + name); };
  const config = { materialName: value => value, tables: {
    ModuleOpenCfg: { data: [{ moduleId: '每日跨服比拼', playerLevel: 20 }, { moduleId: '联盟', playerLevel: 1 }] },
    GuildOrderNumCfg: { data: [{ season: 2, playerLevel: 1, maxNum: 10 }] },
    BuildingUnlockCfg: { data: [{ buildingType: '宠物培育室', buildingId: '1宠物培育室', playerLevel: 1 }] },
  } };
  const ledger = createUsageLedger('weekly-loop-' + id, { file: path.join(directory, id + '.json') });
  return { settings, before, player, calls, writes, reports, queriedTasks,
    async run() {
      const selectedTasks = new Set(selected);
      const history = await runLoop(client, protocol, { config, player, rounds: 1, allowMutate: true,
        isEnabled: key => { queriedTasks.push(key); return selectedTasks.has(key); },
        getSettings: () => settings, usageLedger: ledger, onStep: entry => reports.push(entry) });
      assert.equal(history.history.length, 1);
      assert.deepEqual(unexpected, [], '不能因吞掉未知请求的错误而伪装成没有执行');
      assert.deepEqual(reports.filter(entry => entry.ok === false && !entry.skipped), [], '假客户端的合法等待状态不应报错');
      assert.deepEqual(settings, before, '周活动的运行期接管不能改写用户保存的设置');
    },
  };
}

try {
  for (const scenario of [
    { label: '活动正在分组', state: {}, reason: /分组/ },
    { label: '今日为未接管的城战主题', state: { grouping: false, subjectId: 7 }, reason: /城战/ },
    { label: '服务器已结算', state: { grouping: false, settleTime: Date.parse('2026-11-16T03:59:59Z') / 1000 }, reason: /结算/ },
    { label: '本人积分已达目标', state: { grouping: false, rankList: [{ playerId: 'replace', score: 500 }] }, score: 500, reason: /已达目标积分/ },
  ]) {
    await test(scenario.label + '时，原始旧任务仍为 true 也不能执行募兵、培育或招募', async () => {
      const f = fixture({ state: scenario.state });
      if (scenario.score) {
        Object.assign(f.settings.weeklyActivity, { farmStop: 'score', farmScore: scenario.score });
        scenario.state.rankList[0].playerId = f.player.playerId;
      }
      Object.assign(f.before.weeklyActivity, f.settings.weeklyActivity);
      await f.run();
      assert.deepEqual(f.calls, ['CrossRankInfoRequest']);
      assert.deepEqual(f.writes, []);
      assert(f.reports.some(entry => entry.taskKey === 'weeklyActivity' && scenario.reason.test(entry.reason ?? '')));
      for (const key of nativeTasks) assert.equal(f.settings.schedule[key], true, key + ' 原配置仍为 true');
    });
  }

  await test('旧窄窗口不阻止全天参与，真实 runner 在窗口外仍读取农田和活动募兵状态', async () => {
    const f = fixture({ state: { grouping: false } });
    Object.assign(f.settings.weeklyActivity, { farmStart: '13:00', farmEnd: '13:01', farmStop: 'allDay' });
    Object.assign(f.before.weeklyActivity, f.settings.weeklyActivity);
    await f.run();
    assert(f.calls.includes('CrossRankInfoRequest'));
    assert(f.calls.includes('OnWaterRequest'), '北京时间12点仍应进入农田计划');
    assert(f.calls.includes('GuildOrderRequest'), '北京时间12点仍应进入活动募兵检查');
    assert(!f.calls.includes('DailyTaskInfoRequest'), '接管期间旧用券招募仍然关闭');
    assert.deepEqual(f.writes, []);
    assert(f.reports.some(entry => entry.taskKey === 'weeklyActivity' && /没有联盟订单/.test(entry.reason ?? '')));
  });

  await test('只启用周活动即可进入真实 runner，即使所有原生任务 callback 均返回 false', async () => {
    const f = fixture({ selected: [] });
    f.settings.loop.dailies = f.before.loop.dailies = false;
    assert.equal(hasExtraWork(f.settings), true);
    await f.run();
    assert.deepEqual(f.calls, ['CrossRankInfoRequest']);
    assert(f.reports.some(entry => entry.taskKey === 'weeklyActivity' && /分组/.test(entry.reason ?? '')));
    assert.deepEqual(f.writes, []);
  });

  await test('关闭周活动总开关后恢复有效原生任务，已退役联盟订单和海兽入口保持移除', async () => {
    const f = fixture({ master: false });
    await f.run();
    assert(!f.calls.includes('CrossRankInfoRequest'));
    for (const request of ['DailyTaskInfoRequest', 'RecruitInfoRequest', 'OnWaterRequest']) {
      assert(f.calls.includes(request), '关闭活动后恢复原入口 ' + request);
    }
    assert.deepEqual(f.writes, [['RecruitStartRequest', { way: 2 }]]);
    assert(!f.reports.some(entry => ['guildOrders', 'petCollect', 'petBreed'].includes(entry.key ?? entry.taskKey)), '残留旧开关不能恢复已退役入口');
    assert(!f.calls.includes('GuildInfoRequest') && !f.calls.includes('GuildOrderRequest'), '关闭活动后不恢复旧联盟订单入口');
  });
} finally {
  if (previousDataDir === undefined) delete process.env.CW_DATA_DIR;
  else process.env.CW_DATA_DIR = previousDataDir;
  assert(path.resolve(directory).startsWith(temporaryRoot + path.sep));
  fs.rmSync(directory, { recursive: true, force: true });
}

console.log('周活动真实挂机接线测试 ' + passed + '/' + passed + ' 通过');
