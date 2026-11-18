import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const workerMode = process.argv[2];
const worker = workerMode === '--hold-owner' || workerMode === '--probe-owner';
const directory = worker ? process.argv[3] : fs.mkdtempSync(path.join(os.tmpdir(), 'cw-lineup-runtime-'));
process.env.CW_DATA_DIR = directory;
const { withTemporaryLineup, recoverLineup, readLineupRuntime } = await import('../src/lineup-runtime.mjs');
const { normalizeFormation, formationSignature } = await import('../src/saved-lineups.mjs');
const { createLineupExecutor } = await import('../src/lineup-execution.mjs');
const role = { playerId: '9007199254740993', worldId: '31' };
const original = { presetId: 1, heroPositions: [{ heroId: 'a', pos: { x: 4, y: 4 } }], petUid: '0' };
const target = { presetId: 7, heroPositions: [{ heroId: 'b', pos: { x: 5, y: 1 } }], petUid: '9007199254740993' };
const foreign = { ...original, heroPositions: [{ heroId: 'c', pos: { x: 1, y: 3 } }] };
let sequence = 0;

function fixture(accountId = 'account-' + ++sequence) {
  return {
    accountId, current: structuredClone(original), writes: [], reads: 0, connected: true, onWrite: null,
    async request(name, body, response) {
      assert.equal(response, name.replace('Request', 'Response'));
      if (!this.connected) throw new Error('连接中断');
      if (name === 'GetFormationRequest') { this.reads++; return { formation: structuredClone(this.current) }; }
      assert.equal(name, 'SaveFormationRequest');
      assert.equal(body.module, 1);
      assert(readLineupRuntime(this.accountId).pending, '发送前必须已经保存恢复记录');
      this.writes.push(structuredClone(body.formation));
      const next = normalizeFormation(body.formation, { allowEmpty: true });
      if (this.onWrite) await this.onWrite(next, this.writes.length);
      this.current = next;
      return { formation: structuredClone(next) };
    },
    options(extra = {}) { return { accountId, role, formation: target, ...extra }; },
    run(work, extra) { return withTemporaryLineup(this, this.options(extra), work); },
    recover(extra = {}) { return recoverLineup(this, { accountId, role, ...extra }); },
  };
}

if (worker) {
  const client = fixture(process.argv[4]);
  if (workerMode === '--probe-owner') {
    await assert.rejects(client.recover(), /正在使用共享阵容/);
    await assert.rejects(client.run(async () => assert.fail('活跃所有者不得被接管')), /正在使用共享阵容/);
    assert.equal(client.reads, 0);
    assert.equal(client.writes.length, 0);
    assert.equal(readLineupRuntime(client.accountId).phase, 'battling', '读取状态不等待运行锁');
  } else {
    await client.run(async () => {
      process.send({ ready: true });
      await new Promise(resolve => process.once('message', resolve));
    });
  }
  process.exit(0);
}

const children = new Set();
function startWorker(mode, accountId) {
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), mode, directory, accountId], {
    windowsHide: true, env: { ...process.env, CW_DATA_DIR: directory }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  children.add(child);
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  child.stdout.resume();
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code, signal) => { children.delete(child); resolve({ code, signal, stderr }); });
  });
  return { child, done };
}

function waitForOwner(job) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('等待子进程阵容锁超时')), 10_000);
    job.child.once('message', message => { clearTimeout(timeout); assert.equal(message.ready, true); resolve(); });
    job.done.then(result => { clearTimeout(timeout); reject(new Error('阵容锁子进程提前退出 ' + result.stderr)); }, reject);
  });
}

try {
  for (const won of [true, false]) {
    const client = fixture(), phases = [];
    const result = await client.run(async () => {
      assert.deepEqual(client.current, target);
      return { won };
    }, { onPhase: state => phases.push(state.phase) });
    assert.deepEqual(result, { won });
    assert.deepEqual(client.current, original);
    assert.equal(client.writes.length, 2);
    assert.deepEqual(phases, ['switching', 'battling', 'restoring', 'idle']);
    assert.equal(readLineupRuntime(client.accountId).pending, false);
  }

  {
    const client = fixture(), battleError = new Error('战斗出错');
    await assert.rejects(client.run(async () => { throw battleError; }), error => error === battleError);
    assert.deepEqual(client.current, original);
    assert.equal(readLineupRuntime(client.accountId).pending, false);
    await assert.rejects(client.run(async () => { throw undefined; }), /undefined/);
    assert.deepEqual(client.current, original);
  }

  {
    const client = fixture();
    client.onWrite = async (next, count) => { if (count === 1) throw Object.assign(new Error('切阵被拒绝'), { prompt: true, request: 'SaveFormationRequest' }); };
    await assert.rejects(client.run(async () => assert.fail('被拒绝后不能挑战')), /切阵被拒绝/);
    assert.deepEqual(client.current, original);
    assert.equal(client.writes.length, 1);
    assert.equal(readLineupRuntime(client.accountId).pending, false);
  }

  {
    const client = fixture();
    client.onWrite = async (next, count) => {
      if (count === 1) { client.current = next; throw new Error('切阵回包超时'); }
    };
    await assert.rejects(client.run(async () => assert.fail('未知切阵结果不能进入战斗')), /切阵回包超时/);
    assert.deepEqual(client.current, original);
    assert.equal(client.writes.length, 2);
    assert.equal(readLineupRuntime(client.accountId).pending, false);
  }

  {
    const client = fixture();
    client.onWrite = async (next, count) => {
      if (count === 1) {
        client.current = next;
        client.connected = false;
        throw new Error('切阵后断线');
      }
    };
    await assert.rejects(client.run(async () => assert.fail('切阵断线后不进入战斗')), error => {
      assert.equal(error.message, '切阵后断线');
      assert.equal(error.lineupRestorePending, true);
      return true;
    });
    assert.equal(readLineupRuntime(client.accountId).phase, 'pending');
    client.connected = true;
    await client.recover();
    assert.deepEqual(client.current, original);
  }

  {
    const client = fixture();
    client.onWrite = async (next, count) => {
      if (count === 2) { client.current = next; throw new Error('恢复回包超时'); }
    };
    assert.equal(await client.run(async () => '完成'), '完成');
    assert.deepEqual(client.current, original);
    assert.equal(readLineupRuntime(client.accountId).pending, false);
  }

  {
    const client = fixture(), battleError = new Error('战斗回包断线');
    await assert.rejects(client.run(async () => { client.connected = false; throw battleError; }), error => {
      assert.equal(error, battleError);
      assert.equal(error.lineupRestorePending, true);
      assert.match(error.lineupRestoreError.message, /连接中断/);
      return true;
    });
    assert.equal(readLineupRuntime(client.accountId).phase, 'pending');
    assert.deepEqual(client.current, target);
    client.connected = true;
    const restarted = await import('../src/lineup-runtime.mjs?restart-test');
    await restarted.recoverLineup(client, { accountId: client.accountId, role });
    assert.deepEqual(client.current, original);
    assert.equal(readLineupRuntime(client.accountId).pending, false);
  }

  {
    const client = fixture();
    await assert.rejects(client.run(async () => { client.connected = false; return '战斗已完成'; }), error => {
      assert.equal(error.lineupRestorePending, true);
      assert.match(error.message, /阵容尚待恢复/);
      return true;
    });
    client.connected = true;
    await client.recover();
    assert.deepEqual(client.current, original);
  }

  {
    const client = fixture();
    await assert.rejects(client.run(async () => { client.current = structuredClone(foreign); }), error => error.lineupRestorePending);
    const pending = readLineupRuntime(client.accountId);
    assert.equal(pending.phase, 'conflict');
    assert.deepEqual(client.current, foreign);
    await assert.rejects(client.run(async () => assert.fail('冲突期间不得沿用当前阵容挑战'), { formation: null }), /其他操作修改/);
    await assert.rejects(client.recover({ resolution: 'restore', expectedTransactionId: 'stale' }), /记录已变化/);
    assert.equal(client.writes.length, 1);
    await client.recover({ resolution: 'keep', expectedTransactionId: pending.transactionId });
    assert.deepEqual(client.current, foreign);
    assert.equal(readLineupRuntime(client.accountId).pending, false);
  }

  {
    const client = fixture();
    await assert.rejects(client.run(async () => { client.current = structuredClone(foreign); }), error => error.lineupRestorePending);
    const pending = readLineupRuntime(client.accountId);
    await assert.rejects(client.recover({ role: { ...role, worldId: '99' } }), /其他角色或区服/);
    await assert.rejects(client.recover({ role: { ...role, playerId: '1' }, resolution: 'keep' }), /其他角色或区服/);
    assert.equal(client.writes.length, 1);
    await client.recover({ resolution: 'restore', expectedTransactionId: pending.transactionId });
    assert.deepEqual(client.current, original);
  }

  {
    const first = fixture(), second = fixture();
    let release, entered;
    const holding = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const running = first.run(async () => { entered(); await holding; });
    await started;
    await assert.rejects(first.run(async () => {}), /正在使用共享阵容/);
    await assert.rejects(first.recover(), /正在使用共享阵容/);
    const separateModule = await import('../src/lineup-runtime.mjs?separate-lock-test');
    await assert.rejects(separateModule.recoverLineup(first, { accountId: first.accountId, role }), /正在使用共享阵容/);
    await assert.rejects(separateModule.withTemporaryLineup(first, first.options({ formation: null }), async () => {}), /正在使用共享阵容/);
    assert.equal(separateModule.readLineupRuntime(first.accountId).phase, 'battling');
    await second.run(async () => assert.deepEqual(second.current, target));
    release();
    await running;
    assert.deepEqual(first.current, original);
  }

  {
    const accountId = 'cross-process-owner';
    const job = startWorker('--hold-owner', accountId);
    await waitForOwner(job);
    const client = fixture(accountId);
    client.current = structuredClone(target);
    assert.equal(readLineupRuntime(accountId).phase, 'battling', '持有者运行时仍可读取恢复状态');
    await assert.rejects(client.recover(), /正在使用共享阵容/);
    await assert.rejects(client.run(async () => {}), /正在使用共享阵容/);
    assert.equal(client.reads, 0, '另一进程的自动恢复不能查询或修改活跃阵容');
    const probe = await startWorker('--probe-owner', accountId).done;
    assert.equal(probe.code, 0, probe.stderr);
    await fixture().run(async () => {}, { formation: null });
    job.child.kill('SIGKILL');
    await job.done;
    await client.recover();
    assert.deepEqual(client.current, original, '所有者退出后接管并恢复原阵容');
    assert.equal(readLineupRuntime(accountId).pending, false);
    await client.run(async () => {}, { formation: null });
  }

  {
    const client = fixture();
    let release, entered;
    const holding = new Promise(resolve => { release = resolve; });
    const started = new Promise(resolve => { entered = resolve; });
    const running = client.run(async () => { entered(); await holding; }, { formation: null });
    await started;
    const separateModule = await import('../src/lineup-runtime.mjs?current-formation-lock-test');
    assert.equal(separateModule.readLineupRuntime(client.accountId).pending, false);
    await assert.rejects(separateModule.recoverLineup(client, { accountId: client.accountId, role }), /正在使用共享阵容/);
    await assert.rejects(separateModule.withTemporaryLineup(client, client.options(), async () => {}), /正在使用共享阵容/);
    release();
    await running;
    assert.equal(client.writes.length, 0, '沿用当前阵容时也保护整个挑战期间');
  }

  {
    const client = fixture();
    const execute = createLineupExecutor(client, {
      accountId: client.accountId, getPlayer: () => ({}), getSettings: () => ({}),
      getConfig: () => assert.fail('沿用当前阵容无需读取编辑器配置'),
    });
    assert.equal(await execute(async () => '旧调用可用'), '旧调用可用', '无绑定且无待恢复记录时允许旧调用缺少角色身份');
    let snapshotRead, releaseSnapshot;
    const started = new Promise(resolve => { snapshotRead = resolve; });
    const waiting = new Promise(resolve => { releaseSnapshot = resolve; });
    const request = client.request.bind(client);
    let holdSnapshot = true;
    client.request = async (name, ...args) => {
      if (name === 'GetFormationRequest' && holdSnapshot) {
        holdSnapshot = false;
        snapshotRead();
        await waiting;
      }
      return request(name, ...args);
    };
    const separateModule = await import('../src/lineup-runtime.mjs?snapshot-window-test');
    const running = separateModule.withTemporaryLineup(client, client.options(), async () => {});
    await started;
    assert.equal(readLineupRuntime(client.accountId).pending, false, '此时运行锁已领取，阵容快照尚未落盘');
    await assert.rejects(execute(async () => assert.fail('默认阵容挑战不能穿过快照窗口')), /正在使用共享阵容/);
    releaseSnapshot();
    await running;
    assert.deepEqual(client.current, original);
    await assert.rejects(client.run(async () => { client.current = structuredClone(foreign); }), error => error.lineupRestorePending);
    const writes = client.writes.length;
    await assert.rejects(execute(async () => assert.fail('待恢复时必须确认角色身份')), /无法确认阵容所属角色与区服/);
    assert.equal(client.writes.length, writes);
    assert.equal(readLineupRuntime(client.accountId).pending, true);
    await client.recover({ resolution: 'restore' });
  }

  {
    const client = fixture();
    let enabled = true;
    client.onWrite = async (next, count) => { if (count === 1) enabled = false; };
    await assert.rejects(client.run(async () => assert.fail('暂停后不进入战斗'), { enabled: () => enabled }), /账号状态已变化/);
    assert.deepEqual(client.current, original, '暂停不阻止恢复');
    assert.equal(readLineupRuntime(client.accountId).pending, false);
    client.onWrite = null;
    await client.run(async () => {}, { onPhase: () => { throw new Error('页面回调错误'); } });
    assert.deepEqual(client.current, original, '页面回调不影响恢复');
  }

  {
    const client = fixture();
    await client.run(async () => {}, { formation: null });
    await client.run(async () => {}, { formation: original });
    assert.equal(client.writes.length, 0);
    assert.equal(readLineupRuntime(client.accountId).pending, false);
    client.current = { ...original, heroPositions: [] };
    await client.run(async () => {});
    assert.deepEqual(client.current.heroPositions, [], '允许恢复开始前的空阵容');
    const petOnly = { ...original, petUid: target.petUid };
    client.current = structuredClone(original);
    await client.run(async () => assert.equal(formationSignature(client.current), formationSignature(petOnly)), { formation: petOnly });
    assert.deepEqual(client.current, original, '仅海兽不同也完整切换并恢复');
  }

  {
    for (const missing of [null, {}, { presetId: 0, heroPositions: [], petUid: '0' }]) {
      const client = fixture();
      client.current = missing;
      await assert.rejects(client.run(async () => assert.fail('无法确认原阵容时不进入战斗')), /阵容数据无效/);
      assert.equal(client.writes.length, 0, '缺少可恢复快照时不猜测基础阵型');
      assert.equal(readLineupRuntime(client.accountId).pending, false);
    }
  }

  console.log('lineup runtime ok: durable recovery, exact role, cross-process ownership, conflict, cancellation and observer isolation');
} finally {
  for (const child of children) child.kill('SIGKILL');
  await Promise.all([...children].map(child => new Promise(resolve => child.once('close', resolve))));
  assert(path.resolve(directory).startsWith(path.resolve(os.tmpdir()) + path.sep));
  fs.rmSync(directory, { recursive: true, force: true });
}
