// Current game catalogs must be checked at execution time, including queued work.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.realpathSync(os.tmpdir());
const directory = fs.mkdtempSync(path.join(root, 'cw-settings-runtime-'));
const previous = Object.fromEntries(['CW_DATA_DIR', 'CW_RESOURCE_DIR', 'CW_CONFIG_PACK', 'CW_RESOURCE_AUTO_UPDATE', 'CW_RESOURCE_APP_VERSION']
  .map(name => [name, process.env[name]]));
process.env.CW_DATA_DIR = directory;
process.env.CW_RESOURCE_DIR = path.join(directory, 'resources');
delete process.env.CW_CONFIG_PACK;
process.env.CW_RESOURCE_AUTO_UPDATE = '1';
process.env.CW_RESOURCE_APP_VERSION = '1.14.5';
let passed = 0;
async function test(label, work) { await work(); passed++; console.log('通过：' + label); }
const config = tables => ({ tables: Object.fromEntries(Object.entries(tables).map(([name, data]) => [name, { data }])) });
try {
  const { defaultSettings, SettingsError, createUsageLedger } = await import('../src/automation-settings.mjs');
  const { validateRuntimeSettings, guardRuntimeActions } = await import('../src/settings-runtime.mjs');
  const { createActionGuard } = await import('../src/automation-policy.mjs');
  const { ResourceStaleError, activeResources, writeResourceCheck } = await import('../src/resource-store.mjs');
  const { runLoop } = await import('../src/loop.mjs');
  await test('已保存选项在新表中删除后拒绝执行，原配置保持不变', () => {
    const settings = defaultSettings();
    settings.heroes.heroIds = ['old-hero'];
    const before = structuredClone(settings);
    validateRuntimeSettings(settings, config({ HeroCfg: [{ id: 'old-hero', quality: 'ORANGE' }] }));
    assert.throws(() => validateRuntimeSettings(settings, config({ HeroCfg: [{ id: 'new-hero', quality: 'ORANGE' }] })),
      error => error instanceof SettingsError && error.code === 'SETTINGS_STALE' && error.fields['heroes.heroIds'] && /heroes.heroIds/.test(error.message));
    assert.deepEqual(settings, before);
  });
  await test('缺表和缺资源不误判，权威空表拒绝旧选项', () => {
    const settings = { heroes: { heroIds: ['old-hero'] }, resident: { blockedMaterials: ['GOLD'] } };
    validateRuntimeSettings(settings, null);
    validateRuntimeSettings(settings, config({}));
    validateRuntimeSettings(settings, config({ ItemCfg: [] }));
    assert.throws(() => validateRuntimeSettings(settings, config({ HeroCfg: [] })), error => !!error.fields['heroes.heroIds']);
    assert.throws(() => validateRuntimeSettings(settings, config({ ItemCfg: [], ResourceCfg: [] })), error => !!error.fields['resident.blockedMaterials']);
    validateRuntimeSettings(settings, config({ ItemCfg: [], ResourceCfg: [{ id: 'GOLD' }] }));
  });
  await test('同一配置对象内的用户编辑也重新检查，不沿用之前校验结果', () => {
    const current = config({ HeroCfg: [{ id: 'current', quality: 'BLUE' }] });
    const settings = { heroes: { heroIds: ['current'] } };
    validateRuntimeSettings(settings, current);
    settings.heroes.heroIds = ['removed'];
    assert.throws(() => validateRuntimeSettings(settings, current), error => !!error.fields['heroes.heroIds']);
    settings.heroes.heroIds = [];
    validateRuntimeSettings(settings, current);
  });
  await test('作物、材料、配方与嵌套舰队配置按当前表检查', () => {
    const settings = { farm: { crops: [{ id: 'removed', target: 2 }] }, forge: { recipeIds: ['99'] },
      silicon: { fleets: [{ id: '1远征船', enabled: true }] },
      cityWar: { fleetStrategies: { '1远征船': { cityRefs: ['1:3'], defenceCityRefs: ['2:1'] } } } };
    assert.throws(() => validateRuntimeSettings(settings, config({ FarmlandPlantCfg: [], BuildingEquipMakeCfg: [],
      BuildingUnlockCfg: [], WorldScenarioCfg: [{ id: 1 }], '1_CityCfg': [{ id: 1 }] })), error => {
      assert.deepEqual(Object.keys(error.fields).sort(), ['farm.crops', 'forge.recipeIds', 'silicon.fleets.0.id',
        'cityWar.fleetStrategies.1远征船.cityRefs', 'cityWar.fleetStrategies.1远征船.defenceCityRefs'].sort());
      return true;
    });
    validateRuntimeSettings(settings, config({ '3_CityCfg': [] }));
  });
  await test('城战仅检查仍被舰队继承的旧目标，独立策略优先生效', () => {
    const current = config({ '1_CityCfg': [{ id: 1 }] });
    const settings = { cityWar: { fleetIds: ['1远征船'], cityRefs: ['1:99'],
      fleetStrategies: { '1远征船': { cityRefs: ['1:1'], defenceCityRefs: [] } } } };
    validateRuntimeSettings(settings, current);
    settings.cityWar.fleetStrategies = {};
    assert.throws(() => validateRuntimeSettings(settings, current), error => !!error.fields['cityWar.cityRefs']);
  });
  await test('跟随全局时忽略缓存独立城市，恢复独立后检查缓存的真实城市', () => {
    const current = config({ '1_CityCfg': [{ id: 1 }] });
    const settings = { cityWar: { fleetIds: ['1远征船'], cityRefs: ['1:1'], defenceCityRefs: [],
      fleetStrategies: { '1远征船': { strategyMode: 'global', cityRefs: ['1:99'], defenceCityRefs: [] } } } };
    validateRuntimeSettings(settings, current);
    settings.cityWar.cityRefs = ['1:98'];
    assert.throws(() => validateRuntimeSettings(settings, current), error => Object.keys(error.fields).join() === 'cityWar.cityRefs');
    settings.cityWar.cityRefs = ['1:1'];
    settings.cityWar.fleetStrategies['1远征船'].strategyMode = 'custom';
    assert.throws(() => validateRuntimeSettings(settings, current), error => Object.keys(error.fields).join() === 'cityWar.fleetStrategies.1远征船.cityRefs');
    delete settings.cityWar.fleetStrategies['1远征船'].strategyMode;
    assert.throws(() => validateRuntimeSettings(settings, current), error => !!error.fields['cityWar.fleetStrategies.1远征船.cityRefs']);
  });
  function clientFixture() {
    const client = new EventEmitter();
    client.setMaxListeners(100);
    client.connected = true;
    client.request = async name => assert.fail('关闭所有动作后不应发送：' + name);
    return client;
  }
  for (const reason of ['settings', 'resources']) {
    await test('异步库存核对期间' + (reason === 'settings' ? '设置失效' : '资源切换') + '，取消未发送预留并阻止写入', async () => {
      const settings = defaultSettings();
      settings.resources.allowDiamonds = true;
      settings.heroes.heroIds = ['current'];
      let current = config({ HeroCfg: [{ id: 'current', quality: 'BLUE' }] }), switched = false;
      const client = clientFixture();
      const ledger = createUsageLedger('runtime-' + reason, { file: path.join(directory, reason + '.json') });
      let release, started;
      const reading = new Promise(resolve => { started = resolve; });
      const pendingRead = new Promise(resolve => { release = resolve; });
      client.request = async name => {
        assert.equal(name, 'AllResourceRequest');
        started();
        await pendingRead;
        return { list: [{ res: 4, amount: 1000 }] };
      };
      const original = createActionGuard(client, () => settings, ledger);
      let cancelled = 0, cancellation;
      const guard = guardRuntimeActions({ ...original, async cancel(step, ticket, outcome) {
        cancelled++;
        assert(ticket, '核对结束后应先有真实预留票据');
        assert.equal(ledger.snapshot().counters.runtimeActions, 1, '后置校验失败前已占用预算');
        cancellation = outcome;
        await original.cancel(step, ticket, outcome);
      } }, () => {
        if (switched) throw new ResourceStaleError({ reason: '游戏资源已切换，原任务需要重新规划' });
        validateRuntimeSettings(settings, current);
      });
      let writes = 0;
      const step = { request: 'TestPaidRequest', costs: [{ id: 'RUBY', num: 5 }], counters: { runtimeActions: 1 } };
      const operation = (async () => { await guard.before(step); writes++; })();
      await reading;
      if (reason === 'settings') current = config({ HeroCfg: [] }); else switched = true;
      release();
      await assert.rejects(operation, error => error.code === (reason === 'settings' ? 'SETTINGS_STALE' : 'RESOURCE_STALE'));
      assert.equal(writes, 0);
      assert.equal(cancelled, 1);
      assert.equal(cancellation.notSent, true);
      assert.equal(cancellation.error.code, reason === 'settings' ? 'SETTINGS_STALE' : 'RESOURCE_STALE');
      assert.equal(ledger.snapshot().counters.runtimeActions, 0);
      assert.equal(ledger.snapshot().counters.diamonds, 0);
      assert.equal(client.listenerCount('sent'), 0, '取消后释放操作监听');
    });
  }
  await test('挂机首次执行前阻止失效配置，并清理监听器', async () => {
    const settings = defaultSettings();
    settings.heroes.heroIds = ['removed'];
    const client = clientFixture();
    let scheduled = 0;
    await assert.rejects(runLoop(client, {}, { config: config({ HeroCfg: [] }), getSettings: () => settings,
      allowMutate: true, isEnabled: () => false, schedule: work => { scheduled++; return work(); } }),
      error => error.code === 'SETTINGS_STALE');
    assert.equal(scheduled, 0);
    assert.equal(client.listenerCount('automationSettingsChanged'), 0);
  });
  await test('等待账号队列期间设置变更，实际执行点再次检查', async () => {
    const settings = defaultSettings();
    const client = clientFixture();
    let scheduled = 0;
    await assert.rejects(runLoop(client, {}, { config: config({ HeroCfg: [] }), getSettings: () => settings,
      allowMutate: true, isEnabled: () => false, schedule: work => {
        scheduled++;
        settings.heroes.heroIds = ['removed'];
        client.emit('automationSettingsChanged'); // The event getter itself must not throw.
        return work();
      } }), error => error.code === 'SETTINGS_STALE');
    assert.equal(scheduled, 1);
    assert.equal(client.listenerCount('automationSettingsChanged'), 0);
  });
  await test('下一轮采用新资源并发现已删除选项', async () => {
    const settings = defaultSettings();
    settings.heroes.heroIds = ['current'];
    const client = clientFixture();
    const old = config({ HeroCfg: [{ id: 'current', quality: 'BLUE' }] }), updated = config({ HeroCfg: [] });
    let completed = 0;
    await assert.rejects(runLoop(client, {}, { config: old, refreshConfig: () => completed ? updated : old,
      rounds: 2, everyMs: 0, getSettings: () => settings, allowMutate: true, isEnabled: () => false,
      onRound: () => { completed++; } }), error => error.code === 'SETTINGS_STALE');
    assert.equal(completed, 1);
  });
  for (const mode of ['pending', 'activated']) {
    await test('免费扫荡回读期间' + (mode === 'pending' ? '发现未下载新版本' : '切换资源快照') + '，不按旧价格发送', async () => {
      const resourceRoot = process.env.CW_RESOURCE_DIR;
      function publish(version, activate = true) {
        const generation = '1234567890abcdef-00000000-0000-0000-0000-00000000000' + version;
        const metadata = { generation, scenarios: [1], appVersion: '1.14.5', version: '1.14.5.' + version,
          configVersion: 'config' + version, mapVersion: 'map' + version };
        if (activate) {
          const folder = path.join(resourceRoot, generation);
          fs.mkdirSync(folder, { recursive: true });
          fs.writeFileSync(path.join(folder, 'config.json'), '[]');
          fs.writeFileSync(path.join(folder, 'world_map1.json'), '[]');
          fs.writeFileSync(path.join(resourceRoot, 'active.json'), JSON.stringify(metadata));
        }
        writeResourceCheck(resourceRoot, { appVersion: '1.14.5', required: metadata,
          verifiedAt: new Date().toISOString(), verifiedGeneration: activeResources().generation });
      }
      publish(1);
      const current = { ...config({ TrialRaidCfg: [{ raidId: 1, title: '虚构试炼' }],
        TrialRaidStageCfg: [{ raidId: 1, stageId: 1, openLevel: 1 }], TrialRaidBuySweepCfg: [{ buyTimes: 1, costRuby: 0 }] }),
        resources: activeResources() };
      const client = clientFixture(), writes = [];
      let reads = 0;
      client.request = async name => {
        assert.equal(name, 'TrialRaidInfoRequest');
        reads++;
        if (reads === 1) publish(2, mode === 'activated');
        return { raid: { raidId: 1, passedStage: 1, buySweepTimes: reads - 1 } };
      };
      client.sendWatch = async (name, body) => { writes.push({ name, body }); };
      await assert.rejects(runLoop(client, {}, { config: current, player: { level: 10 }, rounds: 1,
        allowMutate: true, getSettings: () => null, isEnabled: key => key === 'trialSweep' }),
        error => error.code === 'RESOURCE_STALE');
      assert.equal(reads, 1);
      assert.deepEqual(writes, []);
      assert.equal(client.listenerCount('automationSettingsChanged'), 0);
    });
  }
  console.log('运行前配置校验通过 ' + passed + ' 项。');
} finally {
  for (const [name, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
  const resolved = fs.realpathSync(directory);
  assert.equal(path.dirname(resolved), root);
  assert(path.basename(resolved).startsWith('cw-settings-runtime-'));
  fs.rmSync(resolved, { recursive: true, force: true });
}
