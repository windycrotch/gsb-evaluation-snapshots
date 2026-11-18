// 独立城战策略仅验证合成配置与临时文件，不访问真实账号或游戏。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultSettings, validateSettings, settingsCatalog, SETTINGS_FORMAT,
  migrateSettingsVersion, importAutomationSettings, exportAutomationSettings,
  loadAutomationSettings, saveAutomationSettings } from '../src/automation-settings.mjs';
import { cityWarFleetStrategy, cityWarUsesGlobalStrategy } from '../src/city-war-settings.mjs';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-city-war-strategy-settings-'));
const file = path.join(directory, 'settings.json');
let passed = 0;
const test = (name, run) => { run(); passed++; console.log('通过：' + name); };
const settings = () => {
  const value = defaultSettings();
  Object.assign(value.cityWar, { enabled: true, fleetIds: ['1远征船', '2远征船'] });
  return value;
};
const strategy = changes => ({ ...cityWarFleetStrategy({}, '1远征船'), ...changes });
const errorAt = (input, key, options) => assert.throws(() => validateSettings(input, options), error => !!error.fields?.[key]);

try {
  test('旧攻守策略加载与导入保持行为，迁移只在内存进行且不共享可变城市列表', () => {
    const old = settings(); delete old.cityWar.fleetStrategies;
    Object.assign(old.cityWar, { targetMode: 'selected', targetPriority: 'original', cityRefs: ['1:2'],
      defenceTargetMode: 'selected', defenceTargetPriority: 'fewestAllied', defenceCityRefs: ['1:3'] });
    const before = structuredClone(old);
    fs.writeFileSync(file, JSON.stringify({ version: 1, accounts: { legacy: { settings: old, revision: 7 } } }));
    const bytes = fs.readFileSync(file);
    const loaded = loadAutomationSettings('legacy', { file });
    const imported = importAutomationSettings({ format: SETTINGS_FORMAT, version: 1, settings: old });
    assert.deepEqual(loaded.settings, imported); assert.equal(loaded.revision, 7);
    assert.deepEqual(loaded.settings.cityWar.fleetStrategies, {});
    const first = cityWarFleetStrategy(imported.cityWar, '1远征船');
    const second = cityWarFleetStrategy(imported.cityWar, '2远征船');
    assert.deepEqual(first.cityRefs, ['1:2']); assert.deepEqual(first.defenceCityRefs, ['1:3']);
    first.cityRefs.push('1:4'); assert.deepEqual(second.cityRefs, ['1:2']);
    assert.deepEqual(old, before); assert.deepEqual(fs.readFileSync(file), bytes);
    assert.deepEqual(migrateSettingsVersion(imported, 1), imported);
    delete old.cityWar.defenceTargetMode; delete old.cityWar.defenceTargetPriority; delete old.cityWar.defenceCityRefs;
    const shared = importAutomationSettings({ format: SETTINGS_FORMAT, version: 1, settings: old });
    assert.deepEqual(cityWarFleetStrategy(shared.cityWar, '2远征船').defenceCityRefs, ['1:2']);
  });

  test('两支同职责舰队独立保存、刷新与导入导出，角色切换保留各自攻守目标', () => {
    const input = settings();
    input.cityWar.fleetStrategies = {
      '1远征船': strategy({ targetMode: 'selected', cityRefs: ['1:2'], targetPriority: 'original', defenceTargetMode: 'selected', defenceCityRefs: ['1:3'] }),
      '2远征船': strategy({ targetMode: 'selected', cityRefs: ['1:4'], defenceTargetMode: 'selected', defenceCityRefs: ['1:5'] }),
    };
    const saved = saveAutomationSettings('independent', input, { file, revision: 0 });
    assert.deepEqual(loadAutomationSettings('independent', { file }).settings, saved.settings);
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(saved.settings)), saved.settings);
    assert.deepEqual(loadAutomationSettings('another', { file }).settings.cityWar.fleetStrategies, {});
    input.cityWar.defenceFleetIds = ['1远征船'];
    input.cityWar.fleetStrategies['1远征船'].cityRefs = ['1:6'];
    const next = saveAutomationSettings('independent', input, { file, revision: saved.revision });
    assert.deepEqual(next.settings.cityWar.fleetStrategies['2远征船'], saved.settings.cityWar.fleetStrategies['2远征船']);
    assert.deepEqual(next.settings.cityWar.fleetStrategies['1远征船'].defenceCityRefs, ['1:3']);
    const effective = cityWarFleetStrategy(next.settings.cityWar, '1远征船');
    effective.cityRefs.push('1:7');
    assert.deepEqual(next.settings.cityWar.fleetStrategies['1远征船'].cityRefs, ['1:6']);
    assert.throws(() => saveAutomationSettings('independent', input, { file, revision: saved.revision }), error => !!error.fields?.revision);
  });

  test('必选城市按参与舰队当前职责校验，暂停及移出参与名单保留策略', () => {
    const input = settings();
    input.cityWar.fleetStrategies['1远征船'] = strategy({ targetMode: 'selected', defenceTargetMode: 'selected' });
    errorAt(input, 'cityWar.fleetStrategies.1远征船.cityRefs');
    input.cityWar.fleetStrategies['1远征船'].cityRefs = ['1:2'];
    assert.doesNotThrow(() => validateSettings(input));
    input.cityWar.defenceFleetIds = ['1远征船'];
    errorAt(input, 'cityWar.fleetStrategies.1远征船.defenceCityRefs');
    input.cityWar.enabled = false; assert.doesNotThrow(() => validateSettings(input));
    input.cityWar.enabled = true; input.cityWar.fleetIds = ['2远征船']; input.cityWar.defenceFleetIds = [];
    assert.deepEqual(validateSettings(input).cityWar.fleetStrategies['1远征船'], input.cityWar.fleetStrategies['1远征船']);
    input.cityWar.targetMode = 'selected'; input.cityWar.cityRefs = [];
    errorAt(input, 'cityWar.cityRefs', {});
    input.cityWar.fleetStrategies['2远征船'] = strategy();
    assert.doesNotThrow(() => validateSettings(input));
  });

  test('逐队策略拒绝无效编号、缺失字段、未知字段及城市列表，错误定位到独立字段', () => {
    const cases = [
      [[], 'cityWar.fleetStrategies'], [null, 'cityWar.fleetStrategies'],
      [{ '任意船': strategy() }, 'cityWar.fleetStrategies.任意船'],
      [{ '1远征船': [] }, 'cityWar.fleetStrategies.1远征船'],
      [{ '1远征船': { ...strategy(), role: 'attack' } }, 'cityWar.fleetStrategies.1远征船.role'],
      [{ '1远征船': { ...strategy(), targetMode: 'unknown' } }, 'cityWar.fleetStrategies.1远征船.targetMode'],
      [{ '1远征船': { ...strategy(), strategyMode: 'unknown' } }, 'cityWar.fleetStrategies.1远征船.strategyMode'],
      [{ '1远征船': { ...strategy(), targetPriority: false } }, 'cityWar.fleetStrategies.1远征船.targetPriority'],
      [{ '1远征船': { ...strategy(), cityRefs: ['1:2', '1:2'] } }, 'cityWar.fleetStrategies.1远征船.cityRefs'],
      [{ '1远征船': { ...strategy(), defenceCityRefs: ['无效城市'] } }, 'cityWar.fleetStrategies.1远征船.defenceCityRefs'],
      [{ '1远征船': { targetMode: 'alliance' } }, 'cityWar.fleetStrategies.1远征船.targetPriority'],
      [Object.fromEntries(Array.from({ length: 11 }, (_, i) => [(i + 1) + '远征船', strategy()])), 'cityWar.fleetStrategies'],
      [JSON.parse('{"__proto__":{}}'), 'cityWar.fleetStrategies.__proto__'],
    ];
    for (const [map, key] of cases) {
      const input = settings(); input.cityWar.fleetStrategies = map; errorAt(input, key);
    }
    assert.equal({}.targetMode, undefined);
  });

  test('城市目录检查定位独立策略，已被独立配置替代的旧目标不阻止保存', () => {
    const input = settings();
    const catalog = settingsCatalog({ tables: {} });
    catalog.expeditionFleets = ['1远征船', '2远征船'].map(value => ({ value }));
    catalog.cityTargets = ['1:2', '1:3'].map(value => ({ value }));
    input.cityWar.cityRefs = ['9:99']; input.cityWar.defenceCityRefs = ['9:98'];
    input.cityWar.fleetStrategies = {
      '1远征船': strategy({ targetMode: 'selected', cityRefs: ['1:2'] }),
      '2远征船': strategy({ targetMode: 'selected', cityRefs: ['1:3'] }),
      '3远征船': strategy({ targetMode: 'selected', cityRefs: ['1:3'] }),
    };
    assert.deepEqual(validateSettings(input, { catalog }).cityWar.fleetStrategies, input.cityWar.fleetStrategies);
    input.cityWar.fleetStrategies['2远征船'].cityRefs = ['1:4'];
    errorAt(input, 'cityWar.fleetStrategies.2远征船.cityRefs', { catalog });
    delete input.cityWar.fleetStrategies['2远征船'];
    errorAt(input, 'cityWar.cityRefs', { catalog });
  });

  test('跟随全局实时读取共同策略，独立与旧版条目保持自己的攻守目标', () => {
    const input = settings();
    Object.assign(input.cityWar, { targetMode: 'selected', cityRefs: ['1:2'],
      defenceTargetMode: 'selected', defenceCityRefs: ['1:3'] });
    input.cityWar.fleetStrategies = {
      '1远征船': strategy({ strategyMode: 'global', targetMode: 'selected', cityRefs: ['1:4'], defenceCityRefs: ['1:5'] }),
      '2远征船': strategy({ strategyMode: 'custom', targetMode: 'selected', cityRefs: ['1:6'], defenceCityRefs: ['1:7'] }),
      '3远征船': strategy({ targetMode: 'selected', cityRefs: ['1:8'], defenceCityRefs: ['1:9'] }),
    };
    assert.equal(cityWarUsesGlobalStrategy(input.cityWar, '1远征船'), true);
    assert.equal(cityWarUsesGlobalStrategy(input.cityWar, '2远征船'), false);
    assert.equal(cityWarUsesGlobalStrategy(input.cityWar, '3远征船'), false);
    assert.equal(cityWarUsesGlobalStrategy(input.cityWar, '4远征船'), true);
    input.cityWar.cityRefs = ['1:10']; input.cityWar.defenceCityRefs = ['1:11'];
    assert.deepEqual(cityWarFleetStrategy(input.cityWar, '1远征船').cityRefs, ['1:10']);
    assert.deepEqual(cityWarFleetStrategy(input.cityWar, '1远征船').defenceCityRefs, ['1:11']);
    assert.deepEqual(cityWarFleetStrategy(input.cityWar, '2远征船').cityRefs, ['1:6']);
    assert.deepEqual(cityWarFleetStrategy(input.cityWar, '3远征船').cityRefs, ['1:8']);
    const saved = saveAutomationSettings('modes', input, { file, revision: 0 });
    assert.deepEqual(loadAutomationSettings('modes', { file }).settings, saved.settings);
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(saved.settings)), saved.settings);
    assert.equal(Object.hasOwn(saved.settings.cityWar.fleetStrategies['3远征船'], 'strategyMode'), false);
    input.cityWar.fleetStrategies['1远征船'].strategyMode = 'custom';
    assert.deepEqual(cityWarFleetStrategy(input.cityWar, '1远征船').cityRefs, ['1:4']);
    assert.deepEqual(cityWarFleetStrategy(input.cityWar, '1远征船').defenceCityRefs, ['1:5']);
    input.cityWar.fleetStrategies['1远征船'].strategyMode = 'global';
    assert.deepEqual(cityWarFleetStrategy(input.cityWar, '1远征船').cityRefs, ['1:10']);
    assert.deepEqual(input.cityWar.fleetStrategies['1远征船'].cityRefs, ['1:4']);
  });

  test('跟随全局时只校验实际目标，缓存过期城市可保留但恢复独立后需修正', () => {
    const input = settings(), catalog = settingsCatalog({ tables: {} });
    catalog.expeditionFleets = ['1远征船', '2远征船'].map(value => ({ value }));
    catalog.cityTargets = [{ value: '1:2' }];
    Object.assign(input.cityWar, { targetMode: 'selected', cityRefs: ['1:2'] });
    input.cityWar.fleetStrategies['1远征船'] = strategy({ strategyMode: 'global', targetMode: 'selected', cityRefs: ['9:99'], defenceCityRefs: ['9:98'] });
    assert.deepEqual(validateSettings(input, { catalog }).cityWar.fleetStrategies, input.cityWar.fleetStrategies);
    input.cityWar.cityRefs = [];
    errorAt(input, 'cityWar.cityRefs', { catalog });
    input.cityWar.cityRefs = ['1:2']; input.cityWar.fleetStrategies['1远征船'].strategyMode = 'custom';
    errorAt(input, 'cityWar.fleetStrategies.1远征船.cityRefs', { catalog });
    input.cityWar.fleetStrategies['1远征船'].strategyMode = 'global';
    input.cityWar.fleetStrategies['1远征船'].cityRefs = ['非法城市'];
    errorAt(input, 'cityWar.fleetStrategies.1远征船.cityRefs', { catalog });
    input.cityWar.fleetStrategies['1远征船'].cityRefs = [];
    assert.doesNotThrow(() => validateSettings(input, { catalog }));
  });
  console.log(`城战独立策略配置专项：${passed}/${passed} 组通过`);
} finally {
  const resolved = fs.realpathSync(directory);
  if (path.dirname(resolved) !== fs.realpathSync(os.tmpdir()) || !path.basename(resolved).startsWith('cw-city-war-strategy-settings-')) throw Error('拒绝清理意外目录');
  fs.rmSync(resolved, { recursive: true, force: true });
}
