// Only temporary JSON files and child processes are used. No game connection.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { atomicJson, readJson, withFileLock } from '../src/json-store.mjs';
import { createUsageLedger } from '../src/usage-ledger.mjs';
import { defaultSettings, loadAutomationSettings, saveAutomationSettings } from '../src/automation-settings.mjs';

const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function worker(mode, file, id) {
  const ledger = createUsageLedger('shared', { file });
  if (mode === 'cancel-ticket') {
    ledger.cancel(JSON.parse(id));
    return;
  }
  const ready = () => {
    fs.writeFileSync(`${file}.ready.${process.pid}`, 'ready');
    for (;;) Atomics.wait(waitBuffer, 0, 0, 1000);
  };
  if (mode === 'hold') return withFileLock(file, ready);
  if (mode.startsWith('crash-')) {
    const rename = fs.renameSync;
    fs.renameSync = (source, destination) => {
      if (mode === 'crash-choosing' && path.dirname(String(destination)) === `${file}.lock`
        && JSON.parse(fs.readFileSync(source, 'utf8')).choosing) {
        rename(source, destination);
        ready();
      }
      if (String(destination) === file) {
        if (mode === 'crash-before') ready();
        rename(source, destination);
        if (mode === 'crash-after') ready();
        return;
      }
      return rename(source, destination);
    };
    ledger.reserve({ diamonds: 7 }, {}, {}, { uniqueKey: 'uncertain:1' });
    throw new Error('预期的中断点没有执行');
  }
  if (mode.startsWith('settings-')) {
    const settings = defaultSettings();
    settings.building.keepBlueprints = Number(id);
    try {
      saveAutomationSettings(mode === 'settings-shared' ? 'shared' : `account-${id}`, settings, { file, revision: 0 });
      console.log('saved');
    } catch (error) {
      if (mode !== 'settings-shared' || !error.fields?.revision) throw error;
      console.log('conflict');
    }
    return;
  }
  for (let index = 0; index < 20; index++) {
    try {
      const ticket = ledger.reserve({ diamonds: 1 }, mode === 'budget' ? { diamonds: 30 } : {}, {},
        mode === 'duplicate' ? { uniqueKey: 'one-operation' } : {});
      ledger.confirm(ticket);
      console.log('reserved');
    } catch (error) {
      if (!(mode === 'duplicate' && /重复发送/.test(error.message))
        && !(mode === 'budget' && /今日上限/.test(error.message))) throw error;
    }
  }
}

if (process.argv[2] === '--worker') {
  worker(process.argv[3], process.argv[4], process.argv[5]);
  process.exit(0);
}

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-storage-transactions-'));
const children = new Set();
let passed = 0;
function start(mode, file, id = '1') {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), '--worker', mode, file, id], {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, CW_DATA_DIR: directory },
  });
  children.add(child);
  let stdout = '', stderr = '';
  child.stdout.on('data', chunk => { stdout += chunk; });
  child.stderr.on('data', chunk => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => {
      children.delete(child);
      resolve({ code, signal, stdout, stderr });
    });
  });
  return { child, done };
}
async function parallel(mode, file) {
  const results = await Promise.all(Array.from({ length: 4 }, (_, index) => start(mode, file, String(index + 1)).done));
  for (const result of results) assert.equal(result.code, 0, result.stderr);
  return results.map(result => result.stdout).join('');
}
async function waitReady(job, file) {
  const marker = `${file}.ready.${job.child.pid}`;
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(marker) && Date.now() < deadline && job.child.exitCode === null) await sleep(10);
  assert(fs.existsSync(marker), '子进程必须进入预定的中断点');
}
async function kill(job) {
  job.child.kill('SIGKILL');
  await job.done;
}
async function test(name, work) {
  await work();
  passed++;
  console.log('通过：' + name);
}

try {
  await test('同进程嵌套复用互斥，异常后释放锁', () => {
    const file = path.join(directory, 'nested.json');
    withFileLock(file, () => withFileLock(file, () => atomicJson(file, { value: 1 })));
    assert.throws(() => withFileLock(file, () => { throw new Error('injected'); }), /injected/);
    withFileLock(file, () => atomicJson(file, { value: 2 }));
    assert.equal(readJson(file, {}).value, 2);
    assert.deepEqual(fs.readdirSync(`${file}.lock`), []);
  });
  await test('四个进程同时预留和确认时不丢预算更新', async () => {
    const file = path.join(directory, 'concurrent.json');
    await parallel('increment', file);
    const ledger = createUsageLedger('shared', { file });
    assert.equal(ledger.snapshot().counters.diamonds, 80);
    assert.equal(ledger.confirmedCounters().diamonds, 80);
    assert.equal(ledger.snapshot().uncertain, 0);
  });
  await test('跨进程预算上限和防重键均只在事务内判定', async () => {
    const budget = path.join(directory, 'budget.json');
    await parallel('budget', budget);
    assert.equal(createUsageLedger('shared', { file: budget }).snapshot().counters.diamonds, 30);
    const duplicate = path.join(directory, 'duplicate.json');
    const output = await parallel('duplicate', duplicate);
    assert.equal(output.match(/reserved/g)?.length, 1);
    assert.equal(createUsageLedger('shared', { file: duplicate }).snapshot().counters.diamonds, 1);
  });
  await test('跨进程保存不同账号不覆盖，过期版本只能有一个成功', async () => {
    const file = path.join(directory, 'settings.json');
    await parallel('settings-separate', file);
    for (let index = 1; index <= 4; index++) {
      assert.equal(loadAutomationSettings(`account-${index}`, { file }).settings.building.keepBlueprints, index);
    }
    const output = await parallel('settings-shared', file);
    assert.equal(output.match(/saved/g)?.length, 1);
    assert.equal(output.match(/conflict/g)?.length, 3);
    assert.equal(loadAutomationSettings('shared', { file }).revision, 1);
  });
  await test('活进程持锁时超时停止，强杀后自动恢复', async () => {
    const file = path.join(directory, 'held.json');
    const job = start('hold', file);
    await waitReady(job, file);
    assert.throws(() => withFileLock(file, () => assert.fail('不得进入事务'), { timeoutMs: 30 }), /超时/);
    await kill(job);
    withFileLock(file, () => atomicJson(file, { recovered: true }));
    assert.equal(readJson(file, {}).recovered, true);
    assert.deepEqual(fs.readdirSync(`${file}.lock`), []);
  });
  await test('选择锁序号时被强杀也能恢复', async () => {
    const file = path.join(directory, 'choosing.json');
    const job = start('crash-choosing', file);
    await waitReady(job, file);
    await kill(job);
    createUsageLedger('shared', { file }).reserve({ diamonds: 1 });
    assert.equal(createUsageLedger('shared', { file }).snapshot().counters.diamonds, 1);
  });
  await test('原子替换前强杀保留旧文件，替换后强杀保留未知记录', async () => {
    for (const mode of ['crash-before', 'crash-after']) {
      const file = path.join(directory, `${mode}.json`);
      const ledger = createUsageLedger('shared', { file });
      ledger.confirm(ledger.reserve({ diamonds: 2 }));
      const job = start(mode, file);
      await waitReady(job, file);
      await kill(job);
      const restarted = createUsageLedger('shared', { file });
      assert.equal(restarted.snapshot().counters.diamonds, mode === 'crash-before' ? 2 : 9);
      if (mode === 'crash-after') {
        assert.equal(restarted.snapshot().uncertain, 1);
        assert.throws(() => restarted.reserve({}, {}, {}, { uniqueKey: 'uncertain:1' }), /重复发送/);
      }
      restarted.reserve({ diamonds: 1 });
    }
  });
  await test('写入失败保留原文件并清理本次临时文件', () => {
    const file = path.join(directory, 'write-failure.json');
    atomicJson(file, { value: 'old' });
    const rename = fs.renameSync;
    fs.renameSync = (source, target) => {
      if (String(target) === file) throw new Error('injected-rename');
      return rename(source, target);
    };
    try { assert.throws(() => atomicJson(file, { value: 'new' }), /injected-rename/); }
    finally { fs.renameSync = rename; }
    assert.equal(readJson(file, {}).value, 'old');
    assert.equal(fs.readdirSync(directory).filter(name => name.startsWith('write-failure.json.')).length, 0);
  });
  await test('未知键跨日重启保留，重复确认与取消保持计数一致', () => {
    const file = path.join(directory, 'rollover.json');
    const beforeMidnight = Date.UTC(2026, 10, 15, 15, 59, 0);
    const first = createUsageLedger('shared', { file, now: () => beforeMidnight });
    const pending = first.reserve({ petrol: 4 }, {}, {}, { uniqueKey: 'dispatch:1' });
    first.confirm(first.reserve({ diamonds: 2 }));
    const next = createUsageLedger('shared', { file, now: () => beforeMidnight + 120000 });
    assert.deepEqual(next.snapshot().counters, {});
    assert.deepEqual(next.pendingCounters(), { petrol: 4 });
    assert.throws(() => next.reserve({}, {}, {}, { uniqueKey: 'dispatch:1' }), /重复发送/);
    next.confirm(pending);
    next.confirm(pending);
    assert.deepEqual(next.confirmedCounters(), {});
    assert.equal(next.snapshot().uncertain, 0);
    const cancelled = next.reserve({ diamonds: 3 });
    next.cancel(cancelled);
    next.cancel(cancelled);
    assert.equal(next.snapshot().counters.diamonds, 0);
  });
  await test('确认后的迟到取消跨实例和进程均保留防重键，显式释放后才能重用', async () => {
    const file = path.join(directory, 'confirmed-cancel.json');
    const first = createUsageLedger('shared', { file });
    const second = createUsageLedger('shared', { file });
    const uniqueKey = 'fixture:operation';
    const ticket = first.reserve({ diamonds: 10 }, {}, {}, { uniqueKey });
    second.confirm(ticket);
    const confirmedBytes = fs.readFileSync(file);
    first.cancel(ticket);
    const cancelled = await start('cancel-ticket', file, JSON.stringify(ticket)).done;
    assert.equal(cancelled.code, 0, cancelled.stderr);
    assert.deepEqual(fs.readFileSync(file), confirmedBytes);
    assert.equal(first.keyRecords()[uniqueKey].confirmed, true);
    assert.equal(first.snapshot().counters.diamonds, 10);
    assert.equal(first.confirmedCounters().diamonds, 10);
    assert.throws(() => first.reserve({ diamonds: 10 }, {}, {}, { uniqueKey }), /重复发送/);
    second.releaseCompletedKey(uniqueKey);
    const replacement = first.reserve({ diamonds: 10 }, {}, {}, { uniqueKey });
    second.cancel(ticket);
    assert.equal(first.keyRecords()[uniqueKey].id, replacement.id);
    assert.equal(first.snapshot().counters.diamonds, 20);
    assert.equal(first.pendingCounters().diamonds, 10);
    assert.throws(() => second.releaseCompletedKey(uniqueKey), /待确认任务不可释放/);
  });
  console.log(`存储事务验证通过 ${passed} 项。`);
} finally {
  await Promise.all([...children].map(async child => {
    child.kill('SIGKILL');
    await new Promise(resolve => child.once('close', resolve));
  }));
  fs.rmSync(directory, { recursive: true, force: true });
}
