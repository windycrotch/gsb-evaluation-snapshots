import assert from 'node:assert/strict';
import { matchesMuseumRecommendation, selectMuseumHeroes, availableMuseumFactors, museumExploreFactor } from '../src/museum-exploration.mjs';

const condition = { conditionId: 7, heroCount: 2, heroStar: 10, heroQualityIndex: 2, careerLimit: '战士', factionLimit: '阵营A' };
const heroConfig = { id: '推荐甲', quality: 'PURPLE', qualityIndex: 2, career: '战士', faction: '阵营A' };
const hero = { heroId: '推荐甲', star: 5, exclusive: { star: 5 }, power: 100 };
function fixture() {
  const config = { tables: {
    MuseumExpeditionConditionCfg: { data: [{ ...condition }] },
    HeroCfg: { data: [heroConfig, { ...heroConfig, id: '推荐乙' }, { ...heroConfig, id: '普通甲', career: '法师' }] },
    MuseumExploreTimeFactorCfg: { data: [{ factor: 1, playerLevel: 1 }, { factor: 2, playerLevel: 30 }, { factor: 3, playerLevel: 40 }] },
  } };
  const stage = { stageId: 1, expedition: { conditionId: 7, endTime: 0, cost: { asset: [{ id: '木材', num: 5 }] } } };
  const heroes = [structuredClone(hero), { ...structuredClone(hero), heroId: '推荐乙', power: 90 },
    { ...structuredClone(hero), heroId: '普通甲', power: 10000 }];
  const snapshot = { heroes, player: { level: 40 }, world: { have: () => 50 }, museum: { exploreStages: [stage] } };
  const settings = { museum: { factorMode: 'materials', factor: 3, materialFactor: true,
    factorMaterials: ['木材'], stockThreshold: 10, matchedFactor: 2,
    fullRecommendedFactor: 3, partialRecommendedFactor: 2, noRecommendedFallback: false, noRecommendedFactor: 1 } };
  return { config, stage, heroes, snapshot, settings };
}
let passed = 0;
function test(name, run) { run(); passed++; console.log('通过：' + name); }

test('推荐条件使用本体加专武星级，并分别核对品质、职业和阵营', () => {
  assert(matchesMuseumRecommendation(hero, heroConfig, condition));
  for (const [candidate, metadata] of [
    [{ ...hero, star: 4 }, heroConfig], [hero, { ...heroConfig, quality: 'BLUE' }],
    [hero, { ...heroConfig, career: '射手' }], [hero, { ...heroConfig, faction: '阵营B' }],
  ]) assert.equal(matchesMuseumRecommendation(candidate, metadata, condition), false);
  assert(matchesMuseumRecommendation({ ...hero, star: 10, exclusive: null }, heroConfig,
    { ...condition, careerLimit: '', factionLimit: '' }));
});

test('选队优先低战力推荐英雄，同类按战力排，并允许非推荐英雄补齐', () => {
  const f = fixture(), first = selectMuseumHeroes(f.stage, f.heroes, f.config);
  assert.deepEqual(first.heroIds, ['推荐甲', '推荐乙']); assert.equal(first.allRecommended, true);
  const busy = new Set(['推荐甲']), next = selectMuseumHeroes(f.stage, f.heroes, f.config, busy);
  assert.deepEqual(next.heroIds, ['推荐乙', '普通甲']); assert.equal(next.recommendedCount, 1);
  assert.equal(next.ready, true); assert.equal(next.allRecommended, false);
  assert.deepEqual([...busy], ['推荐甲'], '选队不得修改调用者的占用集合');
});

test('人数由条件配置决定，缺条件、空闲不足或重复英雄不能组成可派队伍', () => {
  const f = fixture(); f.config.tables.MuseumExpeditionConditionCfg.data[0].heroCount = 1;
  assert.equal(selectMuseumHeroes(f.stage, f.heroes, f.config).heroIds.length, 1);
  assert.equal(selectMuseumHeroes(f.stage, f.heroes, f.config, f.heroes.map(h => h.heroId)).ready, false);
  assert.equal(selectMuseumHeroes(f.stage, [hero, hero], f.config).ready, false);
  f.config.tables.MuseumExpeditionConditionCfg.data = [];
  assert.equal(selectMuseumHeroes(f.stage, f.heroes, f.config).conditionKnown, false);
});

test('材料模式保留指定材料和库存阈值规则，未选新模式时行为相同', () => {
  const f = fixture();
  assert.equal(museumExploreFactor(f.stage, f.snapshot, f.config, f.settings).factor, 2);
  f.settings.museum.factorMaterials = []; f.snapshot.world.have = () => 5;
  assert.equal(museumExploreFactor(f.stage, f.snapshot, f.config, f.settings).matched, true);
  f.settings.museum.materialFactor = false;
  assert.equal(museumExploreFactor(f.stage, f.snapshot, f.config, f.settings).factor, 3);
  delete f.settings.museum.factorMode;
  assert.equal(museumExploreFactor(f.stage, f.snapshot, f.config, f.settings).factor, 3);
  f.settings.museum.noRecommendedFallback = true; f.settings.museum.noRecommendedFactor = 1;
  assert.equal(museumExploreFactor(f.stage, f.snapshot, f.config, f.settings).factor, 3, '材料模式不读取无推荐兜底设置');
});

test('推荐模式分别使用满队和不足满队的独立倍率，不套用材料筛选规则', () => {
  const f = fixture(); f.settings.museum.factorMode = 'recommended';
  const all = selectMuseumHeroes(f.stage, f.heroes, f.config);
  const full = museumExploreFactor(f.stage, f.snapshot, f.config, f.settings, all);
  assert.equal(full.factor, 3); assert.equal(full.matched, false);
  const partial = selectMuseumHeroes(f.stage, f.heroes, f.config, new Set(['推荐甲']));
  assert.equal(museumExploreFactor(f.stage, f.snapshot, f.config, f.settings, partial).factor, 2);
  f.snapshot.museum.exploreStages.push({ stageId: 2, expedition: { endTime: 100, heroIds: ['推荐甲'] } });
  assert.equal(museumExploreFactor(f.stage, f.snapshot, f.config, f.settings).factor, 2, '隐式选队也排除探险中及待领奖英雄');
  f.settings.museum.fullRecommendedFactor = 1; f.settings.museum.partialRecommendedFactor = 3;
  assert.equal(museumExploreFactor(f.stage, f.snapshot, f.config, f.settings, all).factor, 1);
  assert.equal(museumExploreFactor(f.stage, f.snapshot, f.config, f.settings, partial).factor, 3);
  f.snapshot.player.level = 30;
  assert.equal(museumExploreFactor(f.stage, f.snapshot, f.config, f.settings, partial).factor, 2, '推荐模式也按等级解锁降档');
});

test('推荐条件或英雄资料未知时等待，不能当作已确认零推荐使用兜底', () => {
  const f = fixture(); delete f.config.tables.MuseumExpeditionConditionCfg.data[0].careerLimit;
  const team = selectMuseumHeroes(f.stage, f.heroes, f.config);
  assert.equal(team.ready, true); assert.equal(team.recommendationKnown, false); assert.equal(team.allRecommended, false);
  f.settings.museum.factorMode = 'recommended';
  f.settings.museum.noRecommendedFallback = true;
  const factor = museumExploreFactor(f.stage, f.snapshot, f.config, f.settings, team);
  assert.equal(factor.factor, 0); assert.match(factor.reason, /未确认推荐英雄/);
  const g = fixture(); g.settings.museum.factorMode = 'recommended'; g.settings.museum.noRecommendedFallback = true;
  g.config.tables.HeroCfg.data = [];
  assert.equal(museumExploreFactor(g.stage, g.snapshot, g.config, g.settings).factor, 0);
  f.settings.museum.factorMode = 'materials';
  assert.equal(museumExploreFactor(f.stage, f.snapshot, f.config, f.settings).factor, 2, '材料模式仍可按已知人数使用普通英雄');
});

test('确认零推荐时默认跳过，开启兜底才使用独立倍率并按解锁降档', () => {
  const f = fixture(); f.settings.museum.factorMode = 'recommended';
  f.heroes.forEach(hero => { hero.star = 0; hero.exclusive = null; });
  const team = selectMuseumHeroes(f.stage, f.heroes, f.config);
  assert.equal(team.ready, true); assert.equal(team.recommendationKnown, true); assert.equal(team.recommendedCount, 0);
  const skipped = museumExploreFactor(f.stage, f.snapshot, f.config, f.settings, team);
  assert.equal(skipped.factor, 0); assert.match(skipped.reason, /没有可用的推荐英雄/);
  f.settings.museum.noRecommendedFallback = true;
  assert.equal(museumExploreFactor(f.stage, f.snapshot, f.config, f.settings, team).factor, 1);
  f.settings.museum.noRecommendedFactor = 3; f.snapshot.player.level = 30;
  assert.equal(museumExploreFactor(f.stage, f.snapshot, f.config, f.settings, team).factor, 2);
  f.heroes.length = 1;
  const insufficient = museumExploreFactor(f.stage, f.snapshot, f.config, f.settings);
  assert.equal(insufficient.factor, 0); assert.match(insufficient.reason, /足够的空闲英雄/);
});

test('全部推荐英雄仍在探险时，零推荐兜底不能占用这些英雄', () => {
  const f = fixture(); f.settings.museum.factorMode = 'recommended'; f.settings.museum.noRecommendedFallback = true;
  f.heroes.push({ ...structuredClone(hero), heroId: '普通乙' });
  f.config.tables.HeroCfg.data.push({ ...heroConfig, id: '普通乙', career: '法师' });
  const busy = new Set(['推荐甲', '推荐乙']), team = selectMuseumHeroes(f.stage, f.heroes, f.config, busy);
  assert.deepEqual(team.heroIds, ['普通甲', '普通乙']); assert.equal(team.recommendedCount, 0);
  assert.equal(museumExploreFactor(f.stage, f.snapshot, f.config, f.settings, team).factor, 1);
});

test('倍数按真实解锁表离散选择，不创造中间档位或缺失的一倍', () => {
  const f = fixture();
  assert.deepEqual(availableMuseumFactors(f.config, 29), [1]);
  assert.deepEqual(availableMuseumFactors(f.config, 30), [1, 2]);
  assert.deepEqual(availableMuseumFactors(f.config, 40), [1, 2, 3]);
  f.config.tables.MuseumExploreTimeFactorCfg.data = [{ factor: 3, playerLevel: 1 }, { factor: 1, playerLevel: 1 }];
  assert.equal(museumExploreFactor(f.stage, f.snapshot, f.config, f.settings).factor, 1, '请求两倍但配置只有一、三倍时选一倍');
  f.config.tables.MuseumExploreTimeFactorCfg.data = [{ factor: 3, playerLevel: 41 }];
  assert.equal(museumExploreFactor(f.stage, f.snapshot, f.config, f.settings).factor, 0);
  f.settings.museum.factorMode = 'unrecognized';
  assert.equal(museumExploreFactor(f.stage, f.snapshot, f.config, f.settings).factor, 0);
});

test('选队与倍数计算均不修改英雄、条件和设置', () => {
  const f = fixture(), before = JSON.stringify(f);
  const team = selectMuseumHeroes(f.stage, f.heroes, f.config);
  museumExploreFactor(f.stage, f.snapshot, f.config, f.settings, team);
  assert.equal(JSON.stringify(f), before);
});

console.log(`博物馆推荐选队与倍数专项 ${passed}/${passed} 通过`);
