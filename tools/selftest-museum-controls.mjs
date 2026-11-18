// Automatic museum exploration owns dispatch, settlement, and collection.
import assert from 'node:assert/strict';
import { defaultSettings } from '../src/automation-settings.mjs';
import { baseDemands, observeBaseAutomationPlan, planBaseAutomation, runBaseAutomation, surveyBaseAutomation } from '../src/base-automation.mjs';

let passed = 0;
const test = async (name, work) => { await work(); passed++; console.log('通过：' + name); };
function fixture() {
  const settings = defaultSettings();
  settings.loop.world = true;
  Object.assign(settings.museum, { runEnabled: true, enabled: true, useGuide: true, dailyGuideLimit: 1 });
  settings.factory.keepStock = 0;
  const config = { tables: Object.fromEntries(Object.entries({
    MuseumAchievementCfg: [{ score: 10 }],
    MuseumExpeditionStageCfg: [1, 2, 3].map(stageId => ({ stageId })),
    MuseumExpeditionTeamCfg: [{ playerLevel: 1, teamCount: 3 }],
    MuseumExploreTimeFactorCfg: [{ playerLevel: 1, factor: 1 }],
    MuseumExpeditionConditionCfg: [{ conditionId: 1, heroCount: 1 }],
  }).map(([name, data]) => [name, { data }])) };
  const stock = new Map([['木板', 20], ['博物馆加速', 5]]);
  const snapshot = { now: 1000, player: { level: 30, worldId: 1000001 }, notes: [],
    world: { stock, have: id => stock.get(id) ?? 0, buildings: [], factories: [], serverNow: 1000 },
    museum: { popularity: 10, claimedAchievements: [], exhibitions: [], exploreStages: [
      { stageId: 1, expedition: { endTime: 900, heroIds: ['busy-1'] } },
      { stageId: 2, expedition: { endTime: 4000, heroIds: ['busy-2'] } },
      { stageId: 3, expedition: { endTime: 0, conditionId: 1, cost: { asset: [{ id: '木板', num: 2 }] } } },
    ] }, heroes: [{ heroId: 'available', power: 10 }], choices: [], pets: [] };
  return { settings, config, snapshot };
}

await test('开启自动探宝同时计划探险领奖、派遣及已配置指南', async () => {
  const f = fixture();
  const plan = planBaseAutomation(f.snapshot, f.config, f.settings);
  assert.deepEqual(plan.actions.map(step => step.kind), ['museumComplete', 'museumGuide', 'museumStart']);
  assert(plan.actions.filter(step => step.kind !== 'museumGuide').every(step => step.setting === 'museum.enabled'));
  assert.deepEqual(baseDemands(f.snapshot, f.config, f.settings), [{ source: 'museum', requirements: [{ id: '木板', num: 2 }] }]);
  const reads = [];
  await surveyBaseAutomation({ async request(name) { reads.push(name); return f.snapshot.museum; } },
    { MuseumInfoRequest: {}, MuseumInfoResponse: {}, AllHeroRequest: {}, AllHeroResponse: {} },
    f.config, f.snapshot.player, f.settings, f.snapshot.world);
  assert.deepEqual(reads, ['MuseumInfoRequest', 'AllHeroRequest']);
});

await test('关闭自动探宝后领奖、派遣和指南全部停止且不产生材料需求', async () => {
  const f = fixture(); f.settings.museum.enabled = false;
  assert.deepEqual(planBaseAutomation(f.snapshot, f.config, f.settings).actions, []);
  assert.deepEqual(baseDemands(f.snapshot, f.config, f.settings), []);
  const reads = [];
  await surveyBaseAutomation({ async request(name) { reads.push(name); return {}; } },
    { MuseumInfoRequest: {}, MuseumInfoResponse: {}, AllHeroRequest: {}, AllHeroResponse: {} },
    f.config, f.snapshot.player, f.settings, f.snapshot.world);
  assert.deepEqual(reads, []);
});

await test('人气币和人气奖励各自独立开启，不依赖自动探宝也不派遣英雄', async () => {
  const f = fixture(); f.settings.museum.enabled = false;
  f.snapshot.museum.uncollectedRevenue = 30;
  for (const [field, kind] of [['revenue', 'museumRevenue'], ['achievements', 'museumAchievement']]) {
    f.settings.museum.revenue = f.settings.museum.achievements = false;
    f.settings.museum[field] = true;
    const plan = planBaseAutomation(f.snapshot, f.config, f.settings);
    assert.deepEqual(plan.actions.map(step => step.kind), [kind]);
    assert.equal(plan.actions[0].setting, 'museum.' + field);
    const reads = [];
    await surveyBaseAutomation({ async request(name) { reads.push(name); return f.snapshot.museum; } },
      { MuseumInfoRequest: {}, MuseumInfoResponse: {}, AllHeroRequest: {}, AllHeroResponse: {} },
      f.config, f.snapshot.player, f.settings, f.snapshot.world);
    assert.deepEqual(reads, ['MuseumInfoRequest']);
    f.settings.museum.runEnabled = false;
    assert.deepEqual(planBaseAutomation(f.snapshot, f.config, f.settings).actions, []);
    assert.deepEqual(await runBaseAutomation({ request() { assert.fail('总开关关闭不得写入'); } }, {}, f.config, plan,
      { getSettings: () => f.settings }), []);
    f.settings.museum.runEnabled = true;
  }
});

await test('人气币使用真实回执确认，零库存不计划且错误回执不报成功', async () => {
  for (const collected of [30, undefined, -1, Number.MAX_SAFE_INTEGER + 1]) {
    const f = fixture(); f.settings.museum.enabled = false; f.settings.museum.revenue = true;
    f.snapshot.museum.uncollectedRevenue = 30;
    const plan = planBaseAutomation(f.snapshot, f.config, f.settings);
    const requests = [];
    const result = await runBaseAutomation({ async request(name) { requests.push(name); return { collected }; } },
      { MuseumCollectRevenueRequest: {}, MuseumCollectRevenueResponse: {} }, f.config, plan, { getSettings: () => f.settings });
    assert.deepEqual(requests, ['MuseumCollectRevenueRequest']);
    assert.equal(result[0].ok, collected === 30);
    f.snapshot.museum.uncollectedRevenue = 0;
    assert.deepEqual(planBaseAutomation(f.snapshot, f.config, f.settings).actions, []);
  }
});

await test('推荐模式派遣计划使用独立的满队和不足满队倍数', () => {
  const f = fixture(); f.settings.museum.factorMode = 'recommended';
  f.settings.museum.useGuide = false; f.settings.museum.fullRecommendedFactor = 3; f.settings.museum.partialRecommendedFactor = 2;
  f.snapshot.player.level = 40;
  f.config.tables.MuseumExploreTimeFactorCfg.data = [1, 2, 3].map(factor => ({ factor, playerLevel: 1 }));
  Object.assign(f.config.tables.MuseumExpeditionConditionCfg.data[0], { heroCount: 2, heroStar: 2, heroQualityIndex: 3, careerLimit: '战士', factionLimit: '' });
  f.config.tables.HeroCfg = { data: ['available', 'second'].map(id => ({ id, quality: 'ORANGE', career: '战士', faction: '甲' })) };
  f.snapshot.heroes[0].star = 2;
  f.snapshot.heroes.push({ heroId: 'second', star: 2, power: 1 });
  let start = planBaseAutomation(f.snapshot, f.config, f.settings).actions.find(step => step.kind === 'museumStart');
  assert.equal(start.body.factor, 3); assert.equal(start.costs[0].num, 6);
  f.snapshot.heroes[0].star = 1;
  start = planBaseAutomation(f.snapshot, f.config, f.settings).actions.find(step => step.kind === 'museumStart');
  assert.equal(start.body.factor, 2); assert.equal(start.costs[0].num, 4);
  f.settings.museum.partialRecommendedFactor = 1;
  start = planBaseAutomation(f.snapshot, f.config, f.settings).actions.find(step => step.kind === 'museumStart');
  assert.equal(start.body.factor, 1);
});

await test('无推荐英雄默认不派遣也不补产，独立兜底开启后按指定倍率派遣', () => {
  const f = fixture();
  Object.assign(f.settings.museum, { factorMode: 'recommended', noRecommendedFallback: false, noRecommendedFactor: 1, useGuide: false });
  f.config.tables.MuseumExploreTimeFactorCfg.data = [1, 2, 3].map(factor => ({ factor, playerLevel: 1 }));
  Object.assign(f.config.tables.MuseumExpeditionConditionCfg.data[0], { heroStar: 2, heroQualityIndex: 3, careerLimit: '战士', factionLimit: '' });
  f.config.tables.HeroCfg = { data: [{ id: 'available', quality: 'ORANGE', career: '战士', faction: '甲' }] };
  f.snapshot.heroes[0].star = 1;
  let plan = planBaseAutomation(f.snapshot, f.config, f.settings);
  assert(!plan.actions.some(step => step.kind === 'museumStart'));
  assert.match(plan.notesBySetting['museum.enabled'].join('；'), /没有可用的推荐英雄/);
  assert.deepEqual(baseDemands(f.snapshot, f.config, f.settings), []);
  f.settings.museum.noRecommendedFallback = true; f.settings.museum.noRecommendedFactor = 3;
  let start = planBaseAutomation(f.snapshot, f.config, f.settings).actions.find(step => step.kind === 'museumStart');
  assert.equal(start.body.factor, 3); assert.equal(start.costs[0].num, 6);
  assert.deepEqual(baseDemands(f.snapshot, f.config, f.settings), [{ source: 'museum', requirements: [{ id: '木板', num: 6 }] }]);
  f.snapshot.heroes = [];
  plan = planBaseAutomation(f.snapshot, f.config, f.settings);
  assert(!plan.actions.some(step => step.kind === 'museumStart'));
  assert.deepEqual(baseDemands(f.snapshot, f.config, f.settings), [], '没有足够英雄不能按兜底倍率备料');
});

await test('推荐条件未知时既不派遣也不补产，切回材料模式不受兜底开关影响', () => {
  const f = fixture(); f.settings.museum.factorMode = 'recommended'; f.settings.museum.noRecommendedFallback = true;
  let plan = planBaseAutomation(f.snapshot, f.config, f.settings);
  assert(!plan.actions.some(step => step.kind === 'museumStart'));
  assert.match(plan.notesBySetting['museum.enabled'].join('；'), /未确认推荐英雄/);
  assert.deepEqual(baseDemands(f.snapshot, f.config, f.settings), []);
  f.settings.museum.factorMode = 'materials'; f.settings.museum.noRecommendedFallback = false;
  plan = planBaseAutomation(f.snapshot, f.config, f.settings);
  assert(plan.actions.some(step => step.kind === 'museumStart'));
  assert.deepEqual(baseDemands(f.snapshot, f.config, f.settings), [{ source: 'museum', requirements: [{ id: '木板', num: 2 }] }]);
});

await test('关闭兜底或修改兜底倍率会使已生成的派遣计划失效', async () => {
  for (const change of [settings => { settings.museum.noRecommendedFallback = false; }, settings => { settings.museum.noRecommendedFactor = 2; }]) {
    const f = fixture();
    Object.assign(f.settings.museum, { factorMode: 'recommended', noRecommendedFallback: true, noRecommendedFactor: 1, useGuide: false });
    Object.assign(f.config.tables.MuseumExpeditionConditionCfg.data[0], { heroStar: 2, heroQualityIndex: 3, careerLimit: '战士', factionLimit: '' });
    f.config.tables.HeroCfg = { data: [{ id: 'available', quality: 'ORANGE', career: '战士', faction: '甲' }] };
    f.snapshot.heroes[0].star = 1;
    const actions = planBaseAutomation(f.snapshot, f.config, f.settings).actions.filter(step => step.kind === 'museumStart');
    assert.equal(actions.length, 1);
    change(f.settings);
    const result = await runBaseAutomation({ request() { assert.fail('派遣设置变化后不能执行旧计划'); } }, {}, f.config, { actions }, { getSettings: () => f.settings });
    assert.equal(result[0].skipped, true);
    assert.match(result[0].error, /设置已变化/);
  }
});

await test('每轮派遣上限保留旧单队行为，0 允许填满空闲队伍', () => {
  const f = fixture();
  f.settings.museum.useGuide = false;
  f.snapshot.museum.exploreStages = [1, 2, 3].map(stageId => ({ stageId,
    expedition: { endTime: 0, conditionId: 1, cost: { asset: [{ id: '木板', num: 2 }] } } }));
  f.snapshot.heroes = [1, 2, 3].map(id => ({ heroId: 'hero-' + id, power: id }));
  f.settings.museum.maxDispatches = 1;
  assert.equal(planBaseAutomation(f.snapshot, f.config, f.settings).actions.filter(step => step.kind === 'museumStart').length, 1);
  f.settings.museum.maxDispatches = 0;
  assert.equal(planBaseAutomation(f.snapshot, f.config, f.settings).actions.filter(step => step.kind === 'museumStart').length, 3);
});

await test('已生成计划在关闭自动探宝后不继续执行任何动作', async () => {
  const f = fixture();
  const plan = planBaseAutomation(f.snapshot, f.config, f.settings);
  f.settings.museum.enabled = false;
  const client = { request() { assert.fail('关闭动作后不能发请求'); }, sendWatch() { assert.fail('关闭动作后不能写入'); } };
  assert.deepEqual(await runBaseAutomation(client, {}, f.config, plan, { getSettings: () => f.settings }), []);
});

await test('结算期间关闭自动探宝时不继续发送奖励领取', async () => {
  const f = fixture();
  const actions = planBaseAutomation(f.snapshot, f.config, f.settings).actions.filter(step => step.kind === 'museumComplete');
  const requests = [];
  const client = { connected: true, async request(name) {
    requests.push(name);
    assert.equal(name, 'MuseumCompleteExploreRequest');
    f.settings.museum.enabled = false;
    return { grade: 2, progressGain: 5 };
  } };
  const protocol = Object.fromEntries(['MuseumCompleteExploreRequest', 'MuseumCompleteExploreResponse', 'MuseumRewardRequest', 'MuseumRewardResponse'].map(name => [name, {}]));
  const result = await runBaseAutomation(client, protocol, f.config, { actions }, { getSettings: () => f.settings });
  assert.equal(result[0].ok, false);
  assert.deepEqual(requests, ['MuseumCompleteExploreRequest']);
});

await test('指南预检读取库存期间关闭自动探宝后不能继续消费指南', async () => {
  const f = fixture();
  const actions = planBaseAutomation(f.snapshot, f.config, f.settings).actions.filter(step => step.kind === 'museumGuide');
  const requests = [];
  const client = { connected: true, async request(name) {
    requests.push(name);
    assert.equal(name, 'AllItemRequest');
    f.settings.museum.enabled = false;
    return { items: [{ itemId: '博物馆加速', num: 5 }] };
  } };
  const protocol = { MuseumSpeedUpExploreRequest: {}, MuseumSpeedUpExploreResponse: {} };
  const result = await runBaseAutomation(client, protocol, f.config, { actions }, { getSettings: () => f.settings });
  assert.equal(result[0].ok, false);
  assert.deepEqual(requests, ['AllItemRequest']);
});

await test('自动探宝状态统一汇总领奖派遣与指南', () => {
  const f = fixture();
  const notes = new Map();
  observeBaseAutomationPlan({ now: () => 1000, observe: (key, text) => notes.set(key, text), expect() {} },
    planBaseAutomation(f.snapshot, f.config, f.settings), f.settings, 30000);
  assert.match(notes.get('museum.enabled'), /本次计划 3 项/);
  assert.match(notes.get('museum.useGuide'), /本次计划 1 项/);
  assert.deepEqual([...notes.keys()].sort(), ['museum.enabled', 'museum.runEnabled', 'museum.useGuide']);
});

await test('迁移后的海兽培育未选择品种时明确等待选择', () => {
  const f = fixture();
  f.settings.museum.enabled = false;
  f.settings.pet.enabled = f.settings.pet.breed = true;
  const plan = planBaseAutomation(f.snapshot, f.config, f.settings);
  assert(!plan.actions.some(step => step.kind === 'petBreed'));
  assert.match(plan.notesBySetting['pet.breed'].join('；'), /请先选择培育品种/);
});

console.log(`博物馆动作控制测试：${passed} 项通过`);
