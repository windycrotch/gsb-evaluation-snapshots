import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLoopScheduler } from '../src/loop-scheduler.mjs';

let passed = 0;
async function test(name, work) {
  await work();
  passed++;
  console.log('通过：' + name);
}
function fixture() {
  const client = new EventEmitter();
  client.connected = true;
  const control = new AbortController();
  const jobs = [], sleeps = [];
  const scheduler = createLoopScheduler({
    client, stop: control.signal, now: () => 1000,
    schedule: work => new Promise((resolve, reject) => jobs.push(async () => {
      try { resolve(await work()); } catch (error) { reject(error); }
    })),
    sleep: (ms, signal) => new Promise((resolve, reject) => {
      sleeps.push({ ms, signal, resolve });
      signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }),
  });
  return { client, control, scheduler, jobs, sleeps };
}

await test('到期任务经现有队列执行，重复投递合并', async () => {
  const f = fixture();
  let executed = 0;
  const first = f.scheduler.runDue('factory', () => 900, () => executed++);
  const duplicate = f.scheduler.runDue('factory', () => 900, () => executed++);
  assert.equal(first, duplicate);
  await Promise.resolve();
  assert.equal(f.jobs.length, 1);
  assert.equal(executed, 0);
  await f.jobs.shift()();
  await first;
  assert.equal(executed, 1);
  f.scheduler.dispose();
});

await test('排队期间期限或开关变化，在执行点复查', async () => {
  const f = fixture();
  let deadline = 900, executed = 0;
  const job = f.scheduler.runDue('factory', () => deadline, () => executed++);
  await Promise.resolve();
  deadline = Infinity;
  await f.jobs.shift()();
  await job;
  assert.equal(executed, 0);
  await f.scheduler.runDue('factory', () => 2000, () => executed++);
  assert.equal(f.jobs.length, 0);
  f.scheduler.dispose();
});

await test('推送风暴只唤醒等待，取消旧计时器且不投递协议', async () => {
  const f = fixture();
  const wait = f.scheduler.waitUntil(6000);
  assert.equal(f.sleeps[0].ms, 5000);
  for (let i = 0; i < 100; i++) f.scheduler.wake();
  assert.equal(await wait, true);
  assert.equal(f.sleeps[0].signal.aborted, true);
  assert.equal(f.jobs.length, 0);
  const next = f.scheduler.waitUntil(7000);
  assert.equal(f.sleeps.length, 2);
  f.sleeps[1].resolve();
  assert.equal(await next, false);
  f.scheduler.dispose();
});

await test('等待开始前的推送合并为一次即时复查', async () => {
  const f = fixture();
  f.scheduler.wake();
  f.scheduler.wake();
  assert.equal(await f.scheduler.waitUntil(2000), true);
  assert.equal(f.sleeps.length, 0);
  const wait = f.scheduler.waitUntil(2000);
  f.sleeps[0].resolve();
  assert.equal(await wait, false);
  f.scheduler.dispose();
});

for (const reason of ['pause', 'disconnect', 'finite-round']) {
  await test(reason + '退出清理等待、监听和队列中的接续工作', async () => {
    const f = fixture();
    let executed = 0, cleaned = 0;
    f.scheduler.listen(f.client, 'message', () => f.scheduler.wake());
    f.scheduler.addCleanup(() => cleaned++);
    const job = f.scheduler.runDue('factory', () => 0, () => executed++);
    await Promise.resolve();
    const wait = f.scheduler.waitUntil(6000);
    if (reason === 'pause') f.control.abort();
    else if (reason === 'disconnect') { f.client.connected = false; f.client.emit('close'); }
    else f.scheduler.dispose();
    assert.equal(await wait, true);
    assert.equal(f.sleeps[0].signal.aborted, true);
    assert.equal(f.scheduler.active(), false);
    assert.deepEqual(f.client.eventNames(), []);
    await f.jobs.shift()();
    await job;
    f.client.emit('message');
    f.scheduler.wake();
    await f.scheduler.runDue('factory', () => 0, () => executed++);
    assert.equal(executed, 0);
    assert.equal(f.jobs.length, 0);
    f.scheduler.dispose();
    assert.equal(cleaned, 1);
  });
}

await test('同账号恢复时新调度器清空旧运行的唤醒与任务', async () => {
  const f = fixture();
  f.scheduler.wake();
  f.scheduler.dispose();
  const next = createLoopScheduler({ client: f.client, now: () => 1000, sleep: async () => {} });
  assert.equal(await next.waitUntil(2000), false);
  let executed = 0;
  await next.runDue('factory', () => 0, () => executed++);
  assert.equal(executed, 1);
  next.dispose();
});

await test('运行中修改间隔按原等待起点重算下一轮，缩短、延长与已到期均及时生效', async () => {
  const temporaryRoot = fs.realpathSync(os.tmpdir());
  const directory = fs.mkdtempSync(path.join(temporaryRoot, 'cw-loop-interval-'));
  const previousDataDir = process.env.CW_DATA_DIR, originalNow = Date.now;
  process.env.CW_DATA_DIR = directory;
  try {
    const { runLoop } = await import('../src/loop.mjs');
    const { defaultSettings } = await import('../src/automation-settings.mjs');
    const settings = defaultSettings();
    function disable(value) {
      for (const [key, item] of Object.entries(value)) {
        if (typeof item === 'boolean') value[key] = false;
        else if (item && typeof item === 'object') disable(item);
      }
    }
    disable(settings);
    for (const scenario of [
      { initial: 60000, next: 1000, elapsed: 500, waits: [60000, 500], finish: 1000 },
      { initial: 1000, next: 60000, elapsed: 500, waits: [1000, 59500], finish: 60000 },
      { initial: 60000, next: 1000, elapsed: 5000, waits: [60000], finish: 5000 },
    ]) {
      const base = Date.UTC(2026, 10, 17, 4);
      let now = base, interval = scenario.initial;
      Date.now = () => now;
      const client = new EventEmitter();
      client.setMaxListeners(50);
      client.connected = true;
      client.request = async name => assert.fail('关闭业务任务时不应请求 ' + name);
      const waits = [], rounds = [];
      await runLoop(client, {}, {
        rounds: 2, allowMutate: true, isEnabled: () => false,
        getSettings: () => settings, getEveryMs: () => interval,
        sleep: async ms => {
          assert(waits.length < 3, '更新间隔后应在新截止时间完成等待');
          waits.push(ms);
          if (waits.length === 1) {
            now += scenario.elapsed;
            interval = scenario.next;
            client.emit('automationSettingsChanged');
          } else now += ms;
        },
        onRound: () => rounds.push(now - base),
      });
      assert.deepEqual(waits, scenario.waits);
      assert.deepEqual(rounds, [0, scenario.finish]);
      assert.equal(client.listenerCount('automationSettingsChanged'), 0);
    }
  } finally {
    Date.now = originalNow;
    if (previousDataDir === undefined) delete process.env.CW_DATA_DIR;
    else process.env.CW_DATA_DIR = previousDataDir;
    assert.equal(path.dirname(fs.realpathSync(directory)), temporaryRoot);
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

console.log('循环调度离线专项 ' + passed + '/' + passed + ' 通过');
