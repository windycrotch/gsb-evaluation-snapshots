import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SETTINGS_FORMAT, SETTINGS_SCHEMA_VERSION, defaultSettings, migrateSettingsVersion,
  importAutomationSettings, exportAutomationSettings, loadAutomationSettings, saveAutomationSettings,
  validateSettings, nativeTaskValues, applyNativeTask } from '../src/automation-settings.mjs';

const oldKeys = ['museumCollect', 'museumExplore', 'petCollect', 'petBreed', 'radarAuto', 'radarRepair', 'museumRevenue', 'museumAchievements'];
const version7Fields = ['revenue', 'achievements', 'display', 'factorMode', 'fullRecommendedFactor', 'partialRecommendedFactor'];
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-unified-actions-'));
const file = path.join(directory, 'settings.json');
let passed = 0;
function test(name, work) { work(); passed++; console.log('通过：' + name); }
function legacySettings() {
  const settings = defaultSettings();
  for (const key of oldKeys) settings.schedule[key] = false;
  delete settings.museum.claim;
  delete settings.museum.explore;
  delete settings.museum.maxDispatches;
  for (const key of version7Fields) delete settings.museum[key];
  delete settings.radar.repairIdle;
  return settings;
}
function noOldKeys(settings) {
  for (const key of oldKeys) assert(!Object.hasOwn(settings.schedule, key), key + ' 不应留在当前配置中');
  for (const key of ['claim', 'explore']) assert(!Object.hasOwn(settings.museum, key), 'museum.' + key + ' 已合并到自动探宝');
}
function upgrade(settings, version = 4) {
  const before = structuredClone(settings);
  const result = importAutomationSettings({ format: SETTINGS_FORMAT, version, settings });
  noOldKeys(result);
  assert.deepEqual(settings, before, '读取迁移不得修改输入');
  assert.deepEqual(validateSettings(result), result, '新配置重复验证必须幂等');
  assert.deepEqual(migrateSettingsVersion(result, SETTINGS_SCHEMA_VERSION), result, '当前版本不重复迁移');
  return result;
}

try {
  test('博物馆旧领奖和派遣均并入自动探宝，保留一倍每轮一队且不启用指南', () => {
    for (const [claim, explore] of [[true, false], [false, true], [true, true]]) {
      const old = legacySettings();
      old.schedule.museumCollect = claim; old.schedule.museumExplore = explore;
      Object.assign(old.museum, { factor: 3, materialFactor: true, maps: ['7'], useGuide: true, dailyGuideLimit: 10 });
      const result = upgrade(old);
      assert.equal(result.museum.enabled, true);
      assert.equal(result.museum.factor, 1);
      assert.equal(result.museum.maxDispatches, 1);
      assert.equal(result.museum.materialFactor, false);
      assert.equal(result.museum.useGuide, false);
      assert.equal(result.museum.dailyGuideLimit, 0);
      assert.deepEqual(result.museum.maps, []);
    }
  });

  test('没有拆分动作的旧统一探宝保持开启和原参数', () => {
    const old = legacySettings();
    Object.assign(old.museum, { enabled: true, factor: 3, maps: ['9'], useGuide: true, dailyGuideLimit: 5 });
    old.schedule.museumCollect = false; old.schedule.museumExplore = false;
    const result = upgrade(old);
    assert.equal(result.museum.enabled, true);
    assert.equal(result.museum.maxDispatches, 0); assert.equal(result.museum.factor, 3);
    assert.equal(result.museum.useGuide, true); assert.deepEqual(result.museum.maps, ['9']);
    assert.equal(upgrade(result, 5).museum.enabled, true, '无拆分字段时保持统一开关状态');
  });

  test('版本5领奖或派遣统一为探宝，两个动作都关闭或总动作暂停时保持关闭', () => {
    for (const enabled of [false, true]) for (const [claim, explore] of [[false, false], [true, false], [false, true], [true, true]]) {
      const old = defaultSettings();
      Object.assign(old.museum, { enabled, claim, explore, factor: 2, maps: ['9'], maxDispatches: 3,
        runEnabled: false, useGuide: true, dailyGuideLimit: 5 });
      old.loop.world = false;
      const result = upgrade(old, 5);
      assert.equal(result.museum.enabled, enabled && (claim || explore));
      assert.equal(result.museum.runEnabled, false); assert.equal(result.loop.world, false);
      assert.equal(result.museum.factor, 2); assert.equal(result.museum.maxDispatches, 3);
      assert.equal(result.museum.useGuide, true); assert.deepEqual(result.museum.maps, ['9']);
      assert.deepEqual(validateSettings(old), result, '已打开的旧页面保存也合并拆分动作');
      const exported = exportAutomationSettings(old);
      noOldKeys(exported.settings);
      assert.deepEqual(importAutomationSettings(exported), result);
    }
    const inactive = defaultSettings();
    assert.equal(upgrade(inactive, 5).museum.enabled, false, '缺少拆分字段时仍保留关闭');
  });

  test('迁移保留模块暂停和基地暂停，关闭的功能不会自动变为动作', () => {
    const old = legacySettings();
    for (const key of oldKeys) old.schedule[key] = true;
    old.loop.world = false; old.museum.runEnabled = false; old.radar.runEnabled = false;
    const result = upgrade(old);
    assert.equal(result.loop.world, false);
    assert.equal(result.museum.runEnabled, false);
    assert.equal(result.radar.runEnabled, false);
    const inactive = upgrade(legacySettings());
    assert.equal(inactive.museum.enabled, false); assert.equal(inactive.pet.enabled, false);
    assert.equal(inactive.radar.enabled, false); assert.equal(inactive.radar.repairIdle, false);
  });

  test('海兽旧培育迁移后等待明确品种，不激活喂养进阶或放生', () => {
    for (const breed of [false, true]) {
      const old = legacySettings();
      old.schedule.petCollect = !breed; old.schedule.petBreed = breed;
      Object.assign(old.pet, { species: ['7'], quality: 'RED', universal: true, feed: true,
        advance: true, release: true, releaseQualities: ['RED'] });
      const result = upgrade(old);
      assert.equal(result.pet.enabled, true); assert.equal(result.pet.claim, !breed); assert.equal(result.pet.breed, breed);
      assert.deepEqual(result.pet.species, []); assert.equal(result.pet.quality, 'ORANGE');
      assert.equal(result.pet.universal, false); assert.equal(result.pet.feed, false); assert.equal(result.pet.advance, false);
      assert.equal(result.pet.release, false); assert.deepEqual(result.pet.releaseQualities, []);
    }
    const modern = legacySettings(); modern.pet.enabled = true; modern.pet.claim = false; modern.pet.breed = false;
    modern.schedule.petCollect = modern.schedule.petBreed = true;
    assert.deepEqual(upgrade(modern).pet, modern.pet, '已运行的新海兽配置优先，不激活旧动作');
  });

  test('情报旧自动处理只迁移领奖并清空派遣舰队，维修作为独立动作迁移', () => {
    for (const [auto, repair] of [[true, false], [false, true], [true, true]]) {
      const old = legacySettings(); old.schedule.radarAuto = auto; old.schedule.radarRepair = repair;
      Object.assign(old.radar, { fleetIds: ['1远征船'], types: ['refugee'], allowMaterials: true, minDurabilityPercent: 10 });
      const result = upgrade(old);
      assert.equal(result.radar.enabled, auto); assert.equal(result.radar.repairIdle, repair);
      assert.deepEqual(result.radar.fleetIds, []);
      assert.deepEqual(result.radar.types, defaultSettings().radar.types);
      assert.equal(result.radar.allowMaterials, false); assert.equal(result.radar.minDurabilityPercent, 80);
    }
    const modern = legacySettings(); Object.assign(modern.radar, { enabled: true, fleetIds: ['2远征船'], types: ['pirate'], minDurabilityPercent: 70 });
    modern.schedule.radarAuto = modern.schedule.radarRepair = true;
    assert.deepEqual(upgrade(modern).radar, { ...modern.radar, repairIdle: false }, '被接管的旧维修不得额外开启');
  });

  test('v1、v4和v6的博物馆收益及成就旧键经读取导入保存后迁入模块', () => {
    for (const version of [1, 4, 6]) {
      const old = legacySettings();
      old.schedule.museumRevenue = true; old.schedule.museumAchievements = true;
      const converted = upgrade(old, version);
      assert.equal(converted.museum.revenue, true); assert.equal(converted.museum.achievements, true);
      assert.equal(converted.museum.enabled, false); assert.equal(converted.museum.display, false);
      assert.equal(converted.museum.runEnabled, false); assert.equal(converted.loop.world, false);
      assert.equal(converted.museum.factorMode, 'materials');
      assert.equal(converted.museum.fullRecommendedFactor, 3); assert.equal(converted.museum.partialRecommendedFactor, 2);
      fs.writeFileSync(file, JSON.stringify({ version, accounts: {
        account: { settingsVersion: version, revision: 3, settings: old },
      } }));
      const loaded = loadAutomationSettings('account', { file });
      assert.deepEqual(loaded.settings, converted);
      const saved = saveAutomationSettings('account', loaded.settings, { file, revision: 3 });
      noOldKeys(saved.settings);
      assert.deepEqual(loadAutomationSettings('account', { file }).settings, converted);
      assert.deepEqual(importAutomationSettings(exportAutomationSettings(saved.settings)), converted);
    }
  });

  test('旧自动探宝的隐式成就迁移一次，当前独立成就明确关闭不被覆盖', () => {
    for (const version of [1, 4, 6]) {
      const old = legacySettings(); old.museum.enabled = true;
      old.schedule.museumAchievements = false;
      const result = upgrade(old, version);
      assert.equal(result.museum.achievements, true, '旧自动探宝内置成就必须保留');
      assert.equal(result.museum.revenue, false); assert.equal(result.museum.display, false);
      result.museum.achievements = false; result.schedule.museumAchievements = true;
      result.museum.revenue = false; result.schedule.museumRevenue = true;
      const current = validateSettings(result);
      assert.equal(current.museum.achievements, false); assert.equal(current.museum.revenue, false);
      noOldKeys(current);
    }
  });

  test('没有博物馆分组的早期设置不会被新增默认关闭值吞掉旧动作', () => {
    const old = legacySettings(); delete old.museum;
    old.schedule.museumCollect = true; old.schedule.museumRevenue = true;
    const converted = upgrade(old, 1);
    assert.equal(converted.museum.enabled, true);
    assert.equal(converted.museum.revenue, true);
    assert.equal(converted.museum.achievements, true);
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: {
      partial: { settings: old, revision: 1 },
    } }));
    assert.deepEqual(loadAutomationSettings('partial', { file }).settings, converted);
  });

  test('推荐模式两档倍率各自限制1至3，新账号所有博物馆动作关闭', () => {
    const fresh = defaultSettings();
    for (const field of ['runEnabled', 'enabled', 'revenue', 'achievements', 'display', 'upgrade', 'useGuide'])
      assert.equal(fresh.museum[field], false, field + ' 新账号默认关闭');
    assert.equal(fresh.museum.factorMode, 'materials');
    assert.equal(fresh.museum.fullRecommendedFactor, 3); assert.equal(fresh.museum.partialRecommendedFactor, 2);
    for (const field of ['fullRecommendedFactor', 'partialRecommendedFactor']) {
      for (const value of [0, 4, 1.5]) {
        const invalid = defaultSettings(); invalid.museum[field] = value;
        assert.throws(() => validateSettings(invalid), field + ' 必须为1至3整数');
      }
      for (const value of [1, 2, 3]) {
        const valid = defaultSettings(); valid.museum[field] = value;
        assert.equal(validateSettings(valid).museum[field], value);
      }
    }
    const recommended = defaultSettings(); recommended.museum.factorMode = 'recommended';
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(recommended)), recommended);
    recommended.museum.factorMode = 'unknown'; assert.throws(() => validateSettings(recommended));
  });

  test('读取、保存、导出、重载均移除八个旧键且保持幂等', () => {
    const old = legacySettings(); for (const key of oldKeys) old.schedule[key] = true;
    fs.writeFileSync(file, JSON.stringify({ version: 4, accounts: {
      account: { settingsVersion: 4, revision: 3, settings: old },
    } }));
    const before = fs.readFileSync(file);
    const loaded = loadAutomationSettings('account', { file });
    noOldKeys(loaded.settings);
    assert.deepEqual(fs.readFileSync(file), before, '读取只在内存迁移，不意外覆盖存储');
    const saved = saveAutomationSettings('account', loaded.settings, { file, revision: loaded.revision });
    const stored = JSON.parse(fs.readFileSync(file));
    assert.equal(stored.version, SETTINGS_SCHEMA_VERSION);
    assert.equal(stored.accounts.account.settingsVersion, SETTINGS_SCHEMA_VERSION);
    noOldKeys(stored.accounts.account.settings);
    assert.deepEqual(loadAutomationSettings('account', { file }).settings, saved.settings);
    const exported = exportAutomationSettings(saved.settings);
    noOldKeys(exported.settings);
    assert.deepEqual(importAutomationSettings(exported), saved.settings);
    assert.deepEqual(validateSettings(old), saved.settings, '旧页面保存也执行相同迁移');
    const native = nativeTaskValues(saved.settings, Object.fromEntries(oldKeys.map(key => [key, true])));
    for (const key of oldKeys) {
      assert.equal(native[key] ?? false, false);
      assert.deepEqual(applyNativeTask(saved.settings, key, true), saved.settings, '旧快捷接口不能重新添加 ' + key);
    }
  });

  test('未来版本拒绝读取、导入和覆盖', () => {
    const future = SETTINGS_SCHEMA_VERSION + 1;
    const settings = defaultSettings();
    assert.throws(() => migrateSettingsVersion(settings, future), /版本/);
    assert.throws(() => importAutomationSettings({ format: SETTINGS_FORMAT, version: future, settings }), /版本/);
    fs.writeFileSync(file, JSON.stringify({ version: future, accounts: {} }));
    const before = fs.readFileSync(file);
    assert.throws(() => loadAutomationSettings('account', { file }), /版本/);
    assert.throws(() => saveAutomationSettings('account', settings, { file, revision: 0 }), /版本/);
    assert.deepEqual(fs.readFileSync(file), before);
  });

  console.log(`统一动作配置迁移专项 ${passed}/${passed} 通过`);
} finally { fs.rmSync(directory, { recursive: true, force: true }); }
