import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultSettings as rawDefaultSettings, validateSettings, exportAutomationSettings, importAutomationSettings,
  saveAutomationSettings, loadAutomationSettings, settingsUiRules } from '../src/automation-settings.mjs';
import { WEEKLY_ACTIVITY_KINDS } from '../src/weekly-activity-settings.mjs';

let passed = 0;
const defaultSettings = () => validateSettings(rawDefaultSettings());
const test = (name, run) => { run(); passed++; console.log('通过：' + name); };
const invalid = (patch, field) => {
  const settings = defaultSettings(); Object.assign(settings.weeklyActivity, patch);
  assert.throws(() => validateSettings(settings), error => Boolean(error.fields?.['weeklyActivity.' + field]));
};

test('旧账号及旧导入补齐关闭的周活动，原配置不变', () => {
  const old = defaultSettings(); delete old.weeklyActivity;
  old.pet.enabled = true; old.forge.enabled = true;
  old.forge.buildingIds = ['1装备工厂']; old.forge.recipeIds = ['1'];
  const original = structuredClone(old);
  const document = { format: 'crazywaterworld-automation', version: 1, settings: old };
  for (const migrated of [validateSettings(old, { partial: true }), importAutomationSettings(document)]) {
    assert.equal(migrated.weeklyActivity.enabled, false);
    for (const kind of WEEKLY_ACTIVITY_KINDS) assert.equal(migrated.weeklyActivity[kind + 'Enabled'], false);
    delete migrated.weeklyActivity; assert.deepEqual(migrated, original);
  }
  assert.deepEqual(old, original);
});

test('移除参与时间并迁移旧窗口为全天，保留开关、积分和预算', () => {
  const settings = defaultSettings();
  for (const kind of WEEKLY_ACTIVITY_KINDS) {
    assert.equal(settings.weeklyActivity[kind + 'Stop'], 'allDay');
    assert(!Object.hasOwn(settings.weeklyActivity, kind + 'Start'));
    assert(!Object.hasOwn(settings.weeklyActivity, kind + 'End'));
    Object.assign(settings.weeklyActivity, { [kind + 'Start']: '23:15', [kind + 'End']: '23:20', [kind + 'Stop']: 'time' });
  }
  Object.assign(settings.weeklyActivity, { enabled: true, petEnabled: true, petStop: 'score', petScore: 12000 });
  const original = structuredClone(settings);
  for (const migrated of [validateSettings(settings), validateSettings(settings, { partial: true }),
    importAutomationSettings({ format: 'crazywaterworld-automation', version: 1, settings })]) {
    for (const kind of WEEKLY_ACTIVITY_KINDS) {
      assert(!Object.hasOwn(migrated.weeklyActivity, kind + 'Start'));
      assert(!Object.hasOwn(migrated.weeklyActivity, kind + 'End'));
      assert.equal(migrated.weeklyActivity[kind + 'Stop'], kind === 'pet' ? 'score' : 'allDay');
    }
    assert.equal(migrated.weeklyActivity.petScore, 12000);
    assert.equal(migrated.weeklyActivity.petEnabled, true);
    assert.deepEqual(migrated.resources, original.resources);
  }
  assert.deepEqual(settings, original, '迁移不修改传入的草稿');
});

test('启用积分停止必须填写正数，关闭保留未完成参数', () => {
  for (const kind of WEEKLY_ACTIVITY_KINDS) {
    invalid({ enabled: true, [kind + 'Enabled']: true, [kind + 'Stop']: 'score', [kind + 'Score']: 0 }, kind + 'Score');
    const settings = defaultSettings();
    Object.assign(settings.weeklyActivity, { enabled: true, [kind + 'Enabled']: true, [kind + 'Stop']: 'score', [kind + 'Score']: 12000 });
    assert.deepEqual(validateSettings(settings), settings);
    settings.weeklyActivity.enabled = false; settings.weeklyActivity[kind + 'Score'] = 0;
    assert.deepEqual(validateSettings(settings), settings);
    invalid({ [kind + 'Stop']: 'never' }, kind + 'Stop');
  }
  invalid({ petQualityOrder: 'random' }, 'petQualityOrder');
  invalid({ farmRecruitTimes: -1 }, 'farmRecruitTimes');
  invalid({ farmRecruitTimes: 0.5 }, 'farmRecruitTimes');
  invalid({ farmSpeedUp: 'true' }, 'farmSpeedUp');
  assert.equal(settingsUiRules().numbers['weeklyActivity.farmRecruitTimes'].min, 0);
});

test('活动参数按账号持久保存，关闭和导入导出保留各目标', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-weekly-settings-'));
  const file = path.join(directory, 'settings.json');
  try {
    const settings = defaultSettings();
    Object.assign(settings.weeklyActivity, { enabled: true, farmEnabled: true, farmSpeedUp: true, farmRecruitTimes: 5,
      petEnabled: true, petStop: 'score', petScore: 10000, petQualityOrder: 'desc', forgeQualityOrder: 'desc' });
    saveAutomationSettings('one', settings, { file, revision: 0 });
    assert.deepEqual(loadAutomationSettings('one', { file }).settings.weeklyActivity, settings.weeklyActivity);
    assert.equal(loadAutomationSettings('two', { file }).settings.weeklyActivity.enabled, false);
    assert.deepEqual(importAutomationSettings(exportAutomationSettings(settings)), settings);
    settings.weeklyActivity.enabled = false;
    saveAutomationSettings('one', settings, { file, revision: 1 });
    assert.equal(loadAutomationSettings('one', { file }).settings.weeklyActivity.petScore, 10000);
  } finally {
    fs.unlinkSync(file); fs.rmdirSync(file + '.lock'); fs.rmdirSync(directory);
  }
});

console.log(`周活动配置专项：${passed}/${passed} 组通过`);
