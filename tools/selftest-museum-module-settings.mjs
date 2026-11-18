import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultSettings, validateSettings, hasBaseWork, hasExtraWork, SETTINGS_FORMAT,
  SETTINGS_SCHEMA_VERSION, migrateSettingsVersion, loadAutomationSettings, saveAutomationSettings,
  importAutomationSettings, exportAutomationSettings, settingsFromLegacyNative } from '../src/automation-settings.mjs';
import { automationControlView, setAutomationControl } from '../src/automation-controls.mjs';

let passed = 0;
function test(name, work) { work(); passed++; console.log('通过：' + name); }
const independent = ['revenue', 'achievements', 'display'];
function legacy(version, overrides = {}) {
  const settings = defaultSettings();
  for (const key of ['revenue', 'achievements', 'display', 'factorMode', 'fullRecommendedFactor', 'partialRecommendedFactor', 'noRecommendedFallback', 'noRecommendedFactor']) delete settings.museum[key];
  Object.assign(settings.museum, overrides);
  return { format: SETTINGS_FORMAT, version, settings };
}
function version7(overrides = {}) {
  const settings = defaultSettings();
  delete settings.museum.noRecommendedFallback;
  delete settings.museum.noRecommendedFactor;
  Object.assign(settings.museum, overrides);
  return { format: SETTINGS_FORMAT, version: 7, settings };
}

test('博物馆新增功能默认关闭，材料模式及推荐倍率有明确默认值和边界', () => {
  const defaults = defaultSettings();
  for (const key of independent) assert.equal(defaults.museum[key], false);
  assert.equal(defaults.museum.factorMode, 'materials');
  assert.equal(defaults.museum.fullRecommendedFactor, 3); assert.equal(defaults.museum.partialRecommendedFactor, 2);
  for (const key of ['fullRecommendedFactor', 'partialRecommendedFactor']) for (const value of [0, 4, 1.5, '2']) {
    const input = defaultSettings(); input.museum[key] = value;
    assert.throws(() => validateSettings(input), undefined, key + '=' + value);
  }
});

test('营收、人气奖励和上架可单独启动，仍受基地和博物馆总控限制', () => {
  for (const key of independent) {
    const settings = defaultSettings(); settings.loop.world = settings.museum.runEnabled = true;
    const enabled = setAutomationControl(settings, 'museum.' + key, true);
    assert.equal(enabled.museum.enabled, false); assert.equal(enabled.museum.upgrade, false);
    assert.equal(hasBaseWork(enabled), true, key); assert.equal(hasExtraWork(enabled), true, key);
    assert.equal(automationControlView(enabled).find(row => row.key === 'museum.runEnabled').configurationNote, '');
    const paused = setAutomationControl(enabled, 'museum.runEnabled', false);
    assert.equal(hasBaseWork(paused), false); assert.equal(hasExtraWork(paused), false);
    assert.equal(paused.museum[key], true, '暂停保留动作选择');
    enabled.loop.world = false;
    assert.equal(hasBaseWork(enabled), false); assert.equal(hasExtraWork(enabled), false);
  }
});

test('各历史版本的旧营收与成就任务迁移到本组，不遗失旧字段或重新开放总控', () => {
  for (const version of [1, 4, 5, 6]) for (const [oldKey, newKey] of [['museumRevenue', 'revenue'], ['museumAchievements', 'achievements']]) {
    const input = legacy(version); input.settings.schedule[oldKey] = true;
    const migrated = importAutomationSettings(input);
    assert.equal(migrated.museum[newKey], true, version + ':' + oldKey);
    assert.equal(migrated.museum.runEnabled, false); assert.equal(migrated.loop.world, false);
    assert.equal(migrated.museum.display, false); assert.equal(migrated.museum.factorMode, 'materials');
    for (const key of ['museumRevenue', 'museumAchievements']) assert(!Object.hasOwn(migrated.schedule, key));
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(migrated)), migrated);
  }
  for (const [oldKey, newKey] of [['museumRevenue', 'revenue'], ['museumAchievements', 'achievements']]) {
    const migrated = validateSettings({ schedule: { [oldKey]: true } }, { partial: true });
    assert.equal(migrated.museum[newKey], true, '早期存储缺少museum分组也要保留 ' + oldKey);
    assert(!Object.hasOwn(migrated.schedule, oldKey));
  }
});

test('过去自动探宝内含的成就迁移为独立选择，当前明确关闭成就不被重开', () => {
  const input = legacy(6, { enabled: true, runEnabled: true }); input.settings.loop.world = true;
  const migrated = importAutomationSettings(input);
  assert.equal(migrated.museum.achievements, true); assert.equal(migrated.museum.revenue, false);
  migrated.museum.achievements = false;
  assert.equal(validateSettings(migrated).museum.achievements, false);
  assert.equal(importAutomationSettings(exportAutomationSettings(migrated)).museum.achievements, false);
});

test('无详细配置的原生营收和成就迁移补齐本组总控，不连带探宝或上架', () => {
  for (const [oldKey, newKey] of [['museumRevenue', 'revenue'], ['museumAchievements', 'achievements']]) {
    const migrated = settingsFromLegacyNative({ [oldKey]: true });
    assert.equal(migrated.loop.world, true); assert.equal(migrated.museum.runEnabled, true);
    assert.equal(migrated.museum[newKey], true); assert.equal(migrated.museum.enabled, false);
    assert.equal(migrated.museum.display, false); assert.equal(migrated.museum.upgrade, false);
    assert.equal(hasBaseWork(migrated), true);
  }
});

test('新账号默认不启用零推荐兜底，兜底倍数默认1', () => {
  const fresh = defaultSettings();
  assert.equal(fresh.museum.noRecommendedFallback, false);
  assert.equal(fresh.museum.noRecommendedFactor, 1);
  assert.equal(fresh.museum.partialRecommendedFactor, 2);
  fresh.museum.factorMode = 'recommended';
  assert.equal(validateSettings(fresh).museum.noRecommendedFallback, false, '手动切换推荐模式不能被当作旧配置而重新开启兜底');
  assert.deepEqual(importAutomationSettings(exportAutomationSettings(fresh)), fresh);
});

test('旧推荐模式迁移保留零推荐时执行行为和原不足满队倍数', () => {
  for (const factor of [1, 2, 3, undefined]) {
    const input = version7({ factorMode: 'recommended', partialRecommendedFactor: factor });
    if (factor === undefined) delete input.settings.museum.partialRecommendedFactor;
    const before = structuredClone(input);
    const migrated = importAutomationSettings(input);
    assert.equal(migrated.museum.noRecommendedFallback, true);
    assert.equal(migrated.museum.noRecommendedFactor, factor ?? 2);
    assert.equal(migrated.museum.partialRecommendedFactor, factor ?? 2);
    assert.equal(migrated.museum.enabled, false);
    assert.equal(migrated.museum.runEnabled, false);
    assert.equal(migrated.loop.world, false);
    assert.deepEqual(input, before, '迁移不能修改原文档');
    assert.deepEqual(validateSettings(input.settings), migrated, '已打开的版本7设置页面保存也迁移零推荐行为');
    assert.deepEqual(validateSettings(migrated), migrated);
  }
});

test('旧材料模式迁移保持兜底关闭和1倍，不继承未使用的推荐倍数', () => {
  for (const factor of [1, 2, 3]) {
    const input = version7({ factorMode: 'materials', partialRecommendedFactor: factor });
    const migrated = importAutomationSettings(input);
    assert.equal(migrated.museum.noRecommendedFallback, false);
    assert.equal(migrated.museum.noRecommendedFactor, 1);
    assert.equal(migrated.museum.partialRecommendedFactor, factor);
  }
  for (const version of [1, 4, 5, 6]) {
    const migrated = importAutomationSettings(legacy(version));
    assert.equal(migrated.museum.factorMode, 'materials');
    assert.equal(migrated.museum.noRecommendedFallback, false);
    assert.equal(migrated.museum.noRecommendedFactor, 1);
  }
});

test('显式零推荐设置在导入、重复迁移和导出时保持原值', () => {
  for (const fallback of [false, true]) for (const factor of [1, 2, 3]) for (const version of [7, 8]) {
    const settings = defaultSettings();
    Object.assign(settings.museum, { factorMode: 'recommended', partialRecommendedFactor: 3,
      noRecommendedFallback: fallback, noRecommendedFactor: factor });
    const imported = importAutomationSettings({ format: SETTINGS_FORMAT, version, settings });
    assert.equal(imported.museum.noRecommendedFallback, fallback);
    assert.equal(imported.museum.noRecommendedFactor, factor);
    assert.deepEqual(validateSettings(imported), imported);
    assert.deepEqual(migrateSettingsVersion(imported, SETTINGS_SCHEMA_VERSION), imported);
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(imported)), imported);
  }
  for (const fallback of [false, true]) {
    const input = version7({ factorMode: 'recommended', partialRecommendedFactor: 3, noRecommendedFallback: fallback });
    const imported = importAutomationSettings(input);
    assert.equal(imported.museum.noRecommendedFallback, fallback);
    assert.equal(imported.museum.noRecommendedFactor, 1, '显式兜底开关说明是新配置，缺少倍数应补新默认1倍');
  }
  const explicitFactor = version7({ factorMode: 'recommended', partialRecommendedFactor: 3, noRecommendedFactor: 1 });
  assert.equal(importAutomationSettings(explicitFactor).museum.noRecommendedFactor, 1, '迁移不能覆盖显式兜底倍数');
});

test('零推荐倍数限制1至3，原不足满队倍数非法不能被迁移默认值掩盖', () => {
  for (const value of [0, 4, -1, 1.5, '2', null, true]) {
    const current = defaultSettings(); current.museum.noRecommendedFactor = value;
    assert.throws(() => validateSettings(current), error => !!error.fields?.['museum.noRecommendedFactor'], '兜底倍数=' + value);
    const old = version7({ factorMode: 'recommended', partialRecommendedFactor: value });
    assert.throws(() => importAutomationSettings(old), error => !!error.fields?.['museum.partialRecommendedFactor'], '旧不足满队倍数=' + value);
  }
  for (const value of [0, 'false', null]) {
    const current = defaultSettings(); current.museum.noRecommendedFallback = value;
    assert.throws(() => validateSettings(current), error => !!error.fields?.['museum.noRecommendedFallback']);
  }
  for (const factor of [1, 2, 3]) {
    const current = defaultSettings(); current.museum.noRecommendedFactor = factor;
    assert.equal(validateSettings(current).museum.noRecommendedFactor, factor);
  }
});

test('旧模式读取、保存、重载、导入导出幂等，并保持模块和基地暂停状态', () => {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'cw-museum-fallback-'));
  const file = path.join(directory, 'settings.json');
  try {
    for (const mode of ['materials', 'recommended']) for (const runEnabled of [false, true]) for (const worldEnabled of [false, true]) {
      const old = version7({ factorMode: mode, partialRecommendedFactor: 3, enabled: true, runEnabled });
      old.settings.loop.world = worldEnabled;
      const expected = importAutomationSettings(old);
      fs.writeFileSync(file, JSON.stringify({ version: 7, accounts: { account: { settingsVersion: 7, revision: 4, settings: old.settings } } }));
      const before = fs.readFileSync(file);
      const loaded = loadAutomationSettings('account', { file });
      assert.deepEqual(loaded.settings, expected);
      assert.deepEqual(fs.readFileSync(file), before, '只读加载不得改写旧文件');
      assert.equal(loaded.settings.museum.enabled, true, '保留已选择的自动探宝');
      assert.equal(loaded.settings.museum.runEnabled, runEnabled);
      assert.equal(loaded.settings.loop.world, worldEnabled);
      assert.equal(hasBaseWork(loaded.settings), runEnabled && worldEnabled);
      const saved = saveAutomationSettings('account', loaded.settings, { file, revision: 4 });
      assert.equal(saved.revision, 5);
      assert.deepEqual(saved.settings, expected);
      assert.deepEqual(loadAutomationSettings('account', { file }).settings, expected);
      const stored = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.equal(stored.version, SETTINGS_SCHEMA_VERSION); assert.equal(stored.accounts.account.settingsVersion, SETTINGS_SCHEMA_VERSION);
      const exported = exportAutomationSettings(saved.settings);
      assert.equal(exported.version, SETTINGS_SCHEMA_VERSION);
      assert.deepEqual(importAutomationSettings(exported), expected);
    }
  } finally {
    const resolved = fs.realpathSync(directory);
    assert(resolved.startsWith(temporaryRoot + path.sep) && path.basename(resolved).startsWith('cw-museum-fallback-'));
    fs.rmSync(resolved, { recursive: true, force: true });
  }
});

console.log(`博物馆功能配置专项 ${passed}/${passed} 通过`);
