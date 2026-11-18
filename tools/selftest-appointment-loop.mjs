import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-appointment-loop-'));
const originalDataDir = process.env.CW_DATA_DIR;
const originalNow = Date.now;
process.env.CW_DATA_DIR = directory;
let now = Date.UTC(2026, 10, 17, 4);
Date.now = () => now;

try {
  const { runLoop } = await import('../src/loop.mjs');
  const { defaultSettings } = await import('../src/automation-settings.mjs');
  const { automationControlView, setAutomationControl, idleAutomationControls } = await import('../src/automation-controls.mjs');
  const { rewardSchedule } = await import('../src/reward-schedule.mjs');
  const { DEFAULT_APPOINTMENT_PRIORITIES } = await import('../src/appointment-priorities.mjs');
  let passed = 0;
  const test = async (name, work) => {
    await work();
    passed++;
    console.log('通过：' + name);
  };

  function fixture({ enabled = true, rounds = 1, everyMs = 60000 } = {}) {
    let settings = defaultSettings();
    for (const key of Object.keys(settings.schedule)) settings.schedule[key] = false;
    Object.assign(settings.loop, { tasks: false, world: false, dailies: false, heroes: false });
    settings.heroes.enabled = false;
    settings.dailies.enabled = false;
    settings.resident.rewards = false;
    settings.progression.enabled = false;
    settings.appointments = { enabled, priorities: [...DEFAULT_APPOINTMENT_PRIORITIES] };
    const positions = settings.appointments.priorities.flatMap((effectId, index) =>
      [1, 2, 3].map(offset => ({ effectId, posId: index * 3 + offset, playerLevel: 13 })));
    const config = { tables: { AppointPosCfg: { data: positions } } };
    const client = new EventEmitter();
    client.connected = true;
    const stop = { aborted: false }, calls = [], reports = [], sleeps = [];
    let inQueue = false, assigned = false, readHook, sleepHook, reportHook, failReadback = false;
    client.request = async (name, body) => {
      assert(inQueue, '委任协议必须使用账号串行队列');
      calls.push({ name, body: structuredClone(body) });
      if (name === 'AppointInfoRequest') {
        if (assigned && failReadback) throw new Error('委任回读失败');
        readHook?.();
        return { heroes: assigned ? [{ posId: 1, heroId: '英雄甲' }] : [], priorPosIds: [] };
      }
      if (name === 'AutoAppointRequest') {
        assigned = true;
        return { heroes: [{ posId: 1, heroId: '英雄甲' }] };
      }
      assert.fail('关闭其他模块时不应发送 ' + name);
    };
    const run = () => runLoop(client, {}, {
      config, player: { level: 13 }, allowMutate: true, rounds, everyMs, stop,
      isEnabled: () => false, getSettings: () => settings,
      schedule: async work => {
        assert.equal(inQueue, false, '不得重入账号队列');
        inQueue = true;
        try { return await work(); } finally { inQueue = false; }
      },
      sleep: async ms => {
        assert(!inQueue, '轮间等待不得占用账号队列');
        assert(ms > 0, '不得忙轮询');
        assert(sleeps.length < 10, '测试等待应有界');
        sleeps.push(ms);
        if (sleepHook) sleepHook(ms); else now += ms;
      },
      onStep: entry => { reports.push(entry); reportHook?.(entry); },
    });
    return { client, stop, calls, reports, sleeps, positions, run,
      settings: () => settings,
      setSettings: value => { settings = value; client.emit('automationSettingsChanged'); },
      onRead: callback => { readHook = callback; }, onSleep: callback => { sleepHook = callback; },
      onReport: callback => { reportHook = callback; }, failReadback: () => { failReadback = true; },
      writes: () => calls.filter(call => call.name === 'AutoAppointRequest'),
    };
  }

  await test('关闭自动委任时完整挂机循环不读取或修改委任', async () => {
    const f = fixture({ enabled: false });
    await f.run();
    assert.deepEqual(f.calls, []);
  });

  await test('只开启自动委任即可按保存顺序执行，并回读报告真实结果', async () => {
    const f = fixture();
    f.settings().appointments.priorities.reverse();
    await f.run();
    assert.deepEqual(f.calls.map(call => call.name), ['AppointInfoRequest', 'AutoAppointRequest', 'AppointInfoRequest']);
    const expected = [...f.positions].sort((a, b) =>
      f.settings().appointments.priorities.indexOf(a.effectId) - f.settings().appointments.priorities.indexOf(b.effectId));
    assert.deepEqual(f.writes()[0].body.posId, expected.map(position => position.posId));
    assert.equal(f.reports.length, 1);
    assert.equal(f.reports[0].taskKey, 'appointments.enabled');
    assert.equal(f.reports[0].ok, true);
    assert.match(f.reports[0].note, /1\/21.*1 个职位有变化/);
    assert.equal(rewardSchedule(f.client).status('appointments.enabled').state, 'ok');
    assert.equal(f.client.listenerCount('automationSettingsChanged'), 0);
  });

  for (const change of ['关闭', '停止', '顺序变化']) {
    await test('读取期间' + change + '会阻止旧计划写入', async () => {
      const f = fixture();
      f.onRead(() => {
        if (change === '停止') f.stop.aborted = true;
        else {
          const settings = structuredClone(f.settings());
          if (change === '关闭') settings.appointments.enabled = false;
          else settings.appointments.priorities.reverse();
          f.setSettings(settings);
        }
      });
      await f.run();
      assert.deepEqual(f.writes(), []);
      assert(f.reports.some(entry => entry.skipped));
    });
  }

  await test('挂机等待期间开启委任会唤醒串行执行，使用最新保存顺序', async () => {
    const f = fixture({ enabled: false, rounds: 2, everyMs: 3600000 });
    f.onSleep(() => {
      now += 1000;
      const settings = structuredClone(f.settings());
      settings.appointments.enabled = true;
      settings.appointments.priorities.reverse();
      f.setSettings(settings);
      assert.deepEqual(f.calls, [], '设置事件只唤醒调度');
    });
    f.onReport(() => { f.stop.aborted = true; });
    await f.run();
    assert.deepEqual(f.sleeps, [3600000]);
    assert.equal(f.writes().length, 1);
    assert.deepEqual(f.writes()[0].body.posId.slice(0, 3), [19, 20, 21]);
  });

  await test('每轮按挂机间隔重新核对，自动委任无重复并发写入', async () => {
    const f = fixture({ rounds: 2 });
    await f.run();
    assert.equal(f.writes().length, 2);
    assert.deepEqual(f.sleeps, [60000]);
    assert.match(f.reports.at(-1).note, /0 个职位有变化/);
  });

  await test('回读失败报告失败，单轮不重发或记为完成', async () => {
    const f = fixture();
    f.failReadback();
    await f.run();
    assert.equal(f.writes().length, 1);
    assert.equal(f.reports[0].ok, false);
    assert.match(f.reports[0].error, /回读失败/);
    assert.equal(rewardSchedule(f.client).status('appointments.enabled').state, 'error');
  });

  await test('统一控制状态独立于养成总控，切换保留委任顺序', () => {
    const f = fixture();
    const before = structuredClone(f.settings());
    const off = setAutomationControl(before, 'appointments.enabled', false);
    assert.deepEqual(off.appointments.priorities, before.appointments.priorities);
    assert.equal(off.heroes.enabled, false);
    const on = setAutomationControl(off, 'appointments.enabled', true);
    const view = automationControlView(on).find(control => control.key === 'appointments.enabled');
    assert.equal(view.enabled, true);
    assert.deepEqual(view.blockedBy, []);
    assert(!idleAutomationControls.some(control => control.key === 'appointments.enabled'));
  });

  console.log(`英雄委任挂机测试 ${passed}/${passed} 通过`);
} finally {
  Date.now = originalNow;
  if (originalDataDir === undefined) delete process.env.CW_DATA_DIR;
  else process.env.CW_DATA_DIR = originalDataDir;
  fs.rmSync(directory, { recursive: true, force: true });
}
