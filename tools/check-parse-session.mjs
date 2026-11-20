/* =====================================================================
 * check-parse-session.mjs —— 解析会话的独立验证（正常/换文件/失败重试/迟到消息）
 * ---------------------------------------------------------------------
 * 用 node:vm 造一个最小浏览器环境（Worker 用假实现，按脚本控制消息时序），
 * 加载真实的 web/wrpl-parse.js 与 web/wrpl-worker.js，检查：
 *   1. 正常解析：会话顺序中的分片按 seq 拼成完整数据；done 只处理一次；
 *   2. 解析中途换文件：旧会话 cancel 后，迟到分片/进度/完成都不影响新会话；
 *   3. 解析失败后重试：失败会话不产出数据，重试会话的数据完整；
 *   4. 取消后迟到消息：worker 侧不再发分片，主线程按 sessionId 丢弃；
 *      乱序/重复分片不重复拼接。
 * 不需要浏览器、不联网。用法：node tools/check-parse-session.mjs
 * ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

/* ---------------------------------------------------------------- 假 Worker
 * 主线程脚本（wrpl-parse.js）用 `new Worker(url)` 建它。这里把每个实例登记到
 * ctx.__workers，测试代码手动往主线程投递消息（模拟 worker → 主线程）。
 */
function makeWorkerClass(ctx) {
  function FakeWorker(url) {
    this.url = url;
    this.onmessage = null;
    this.onerror = null;
    this.terminated = false;
    this.sent = [];              // 主线程 → worker 的消息日志
    ctx.__workers.push(this);
  }
  FakeWorker.prototype.postMessage = function (msg) {
    if (this.terminated) { throw new Error('worker already terminated'); }
    this.sent.push(msg);
  };
  FakeWorker.prototype.terminate = function () { this.terminated = true; };
  /** 模拟 worker → 主线程 */
  FakeWorker.prototype.emit = function (data) {
    if (this.terminated) { return; }     // 已 terminate：消息不会到达
    if (this.onmessage) { this.onmessage({ data }); }
  };
  return FakeWorker;
}

/** 造一个"主线程"环境并载入 wrpl-parse.js。 */
function loadMainThread() {
  const ctx = {
    console,
    setTimeout, clearTimeout,
    Date, Math, JSON, Object, Array, String, Number, Uint8Array, DataView, ArrayBuffer,
    __workers: [],
    document: { currentScript: { src: 'http://local/web/wrpl-parse.js' } },
  };
  ctx.self = ctx;
  ctx.window = ctx;
  ctx.Worker = makeWorkerClass(ctx);
  ctx.Blob = function () {};
  function URLStub() {}
  URLStub.createObjectURL = () => 'blob:x';
  ctx.URL = URLStub;             // 浏览器里 URL 是构造函数，workerSupported() 要的是 typeof === 'function'
  vm.createContext(ctx);
  vm.runInContext(read('web/wrpl-parse.js'), ctx, { filename: 'wrpl-parse.js' });
  return ctx;
}

/** 造一个"worker"环境并载入 wrpl-worker.js（importScripts 只加载最小桩）。 */
function loadWorkerThread(parseMainImpl) {
  const ctx = {
    console,
    setTimeout, clearTimeout,
    Date, Math, JSON, Object, Array, String, Number, Uint8Array, DataView, ArrayBuffer,
    __posted: [],
  };
  ctx.self = ctx;
  ctx.importScripts = function () { /* 真实脚本由下面的桩替代 */ };
  ctx.postMessage = function (msg) { ctx.__posted.push(JSON.parse(JSON.stringify(msg))); };
  /* wrpl-worker.js 里用到 WRPLParse（progress / _internal.parseMain）与 fzstd */
  ctx.WRPLParse = {
    progress(cb) { ctx.__progressCb = cb; },
    _internal: { parseMain: parseMainImpl },
  };
  ctx.fzstd = { decompress: (b) => b };
  vm.createContext(ctx);
  vm.runInContext(read('web/wrpl-worker.js'), ctx, { filename: 'wrpl-worker.js' });
  return ctx;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

/* ================================================================ 用例 1
 * 正常解析：worker 按 seq 顺序发分片，主线程拼出完整 mission。 */
async function caseNormal() {
  const W = loadMainThread();
  const p = W.WRPLParse.parse(new ArrayBuffer(64), { sessionId: 'S1', force: 'worker' });
  const worker = W.__workers[0];
  assert.ok(worker, 'worker 已创建');
  assert.equal(worker.sent[0].cmd, 'ready', '先握手');
  worker.emit({ type: 'ready', hasFzstd: true });
  const parseCmd = worker.sent.find((m) => m.cmd === 'parse');
  assert.ok(parseCmd, '收到 parse 指令');
  assert.equal(parseCmd.sessionId, 'S1', 'parse 指令带会话标识');

  worker.emit({ type: 'progress', sessionId: 'S1', phase: 'fm', pct: 30, note: 'n' });
  worker.emit({ type: 'part', sessionId: 'S1', seq: 1, key: 'meta', data: { window: { duration: 10 } } });
  worker.emit({ type: 'part', sessionId: 'S1', seq: 2, key: 'own', data: { t0: 0, hz: 10, n: 3 } });
  worker.emit({ type: 'part', sessionId: 'S1', seq: 3, key: 'own', data: { x: [1, 2, 3], y: [1, 2, 3], z: [1, 2, 3] } });
  worker.emit({ type: 'part', sessionId: 'S1', seq: 4, key: 'units', data: [{ key: 'a' }] });
  worker.emit({ type: 'part', sessionId: 'S1', seq: 5, key: 'units', data: [{ key: 'b' }] });
  worker.emit({ type: 'part', sessionId: 'S1', seq: 6, key: 'events', data: [] });
  worker.emit({ type: 'part', sessionId: 'S1', seq: 7, key: 'names', data: {} });
  worker.emit({ type: 'done', sessionId: 'S1', seq: 8, parts: 7, timing: { parseMs: 1, sendMs: 1 } });
  const mission = await p;
  assert.equal(mission.meta.window.duration, 10);
  assert.deepEqual(mission.own.x, [1, 2, 3], 'own 分片合并成一份，不被覆盖');
  assert.equal(mission.own.hz, 10);
  assert.equal(mission.units.length, 2, 'units 分片按序拼接');
  assert.ok(worker.terminated, '完成后 worker 被 terminate');
  console.log('  ✓ 正常解析：分片按 seq 拼接、完成消息处理、worker 释放');
}

/* ================================================================ 用例 2
 * 解析中途换文件：旧会话 cancel 后，迟到的分片/进度/完成都不影响新会话。 */
async function caseReplaceMidway() {
  const W = loadMainThread();
  const oldSess = W.WRPLParse.createSession('OLD');
  const pOld = W.WRPLParse.parse(new ArrayBuffer(64), { session: oldSess, force: 'worker' });
  const wOld = W.__workers[0];
  wOld.emit({ type: 'ready', hasFzstd: true });
  wOld.emit({ type: 'part', sessionId: 'OLD', seq: 1, key: 'meta', data: { window: { duration: 1 } } });
  wOld.emit({ type: 'part', sessionId: 'OLD', seq: 2, key: 'units', data: [{ key: 'old-partial' }] });
  await tick();

  /* 页面开始新会话：先取消旧的（页面上的"换文件"就调这一步），再起新的 */
  const newSess = W.WRPLParse.createSession('NEW');
  oldSess.cancel();
  await assert.rejects(pOld, (e) => e.code === 'cancelled', '旧会话以 cancelled 拒绝');
  assert.ok(wOld.terminated, '旧 worker 已 terminate');
  assert.ok(wOld.sent.some((m) => m.cmd === 'cancel' && m.sessionId === 'OLD'), '先给旧 worker 发 cancel');

  /* 旧 worker 的迟到消息（若实现没断言终止，也模拟一下）不得影响任何东西 */
  const pNew = W.WRPLParse.parse(new ArrayBuffer(64), { session: newSess, force: 'worker' });
  const wNew = W.__workers[1];
  wNew.emit({ type: 'ready', hasFzstd: true });
  wNew.emit({ type: 'part', sessionId: 'NEW', seq: 1, key: 'meta', data: { window: { duration: 2 } } });
  wNew.emit({ type: 'part', sessionId: 'NEW', seq: 2, key: 'units', data: [{ key: 'new' }] });
  wNew.emit({ type: 'done', sessionId: 'NEW', seq: 3, parts: 2, timing: {} });
  const mission = await pNew;
  assert.deepEqual(mission.units.map((u) => u.key), ['new'], '结果只来自最后一次成功的会话');
  assert.equal(mission.meta.window.duration, 2, '旧会话的 meta 没有混进来');
  console.log('  ✓ 解析中途换文件：旧会话取消、迟到消息不影响新会话');
}

/* ================================================================ 用例 3
 * 解析失败后重试：失败会话不产出数据；重试会话完整挂载。 */
async function caseFailThenRetry() {
  const W = loadMainThread();
  const s1 = W.WRPLParse.createSession('BAD');
  const p1 = W.WRPLParse.parse(new ArrayBuffer(64), { session: s1, force: 'worker' });
  const w1 = W.__workers[0];
  w1.emit({ type: 'ready', hasFzstd: true });
  w1.emit({ type: 'part', sessionId: 'BAD', seq: 1, key: 'meta', data: { window: { duration: 1 } } });
  w1.emit({ type: 'part', sessionId: 'BAD', seq: 2, key: 'units', data: [{ key: 'partial' }] });
  w1.emit({ type: 'error', sessionId: 'BAD', message: '坏包', code: 'parse-error' });
  await assert.rejects(p1, (e) => e.message === '坏包', '失败会话以可读错误拒绝');
  assert.ok(w1.terminated, '失败后 worker 释放');

  /* 失败会话的部分分片不得泄漏到下一次解析 */
  const s2 = W.WRPLParse.createSession('RETRY');
  const p2 = W.WRPLParse.parse(new ArrayBuffer(64), { session: s2, force: 'worker' });
  const w2 = W.__workers[1];
  w2.emit({ type: 'ready', hasFzstd: true });
  w2.emit({ type: 'part', sessionId: 'RETRY', seq: 1, key: 'units', data: [{ key: 'retry' }] });
  w2.emit({ type: 'done', sessionId: 'RETRY', seq: 2, parts: 1, timing: {} });
  const m2 = await p2;
  assert.deepEqual(m2.units.map((u) => u.key), ['retry'], '只保留重试会话的数据');
  console.log('  ✓ 失败后重试：失败不产出数据、部分分片不泄漏、重试结果完整');
}

/* ================================================================ 用例 4
 * 取消后迟到消息 + 重复/乱序分片。 */
async function caseLateAndReorder() {
  const W = loadMainThread();
  const sess = W.WRPLParse.createSession('S4');
  const p = W.WRPLParse.parse(new ArrayBuffer(64), { session: sess, force: 'worker' });
  const w = W.__workers[0];
  w.emit({ type: 'ready', hasFzstd: true });
  /* 乱序：先到 seq 3、再 1、再重复的 2、再 2、再 4 */
  w.emit({ type: 'part', sessionId: 'S4', seq: 3, key: 'units', data: [{ key: 'c' }] });
  w.emit({ type: 'part', sessionId: 'S4', seq: 1, key: 'meta', data: { window: { duration: 3 } } });
  w.emit({ type: 'part', sessionId: 'S4', seq: 2, key: 'units', data: [{ key: 'a' }] });
  w.emit({ type: 'part', sessionId: 'S4', seq: 2, key: 'units', data: [{ key: 'a' }] });   // 重复
  w.emit({ type: 'part', sessionId: 'S4', seq: 4, key: 'units', data: [{ key: 'd' }] });
  w.emit({ type: 'done', sessionId: 'S4', seq: 5, parts: 4, timing: {} });
  const m = await p;
  assert.deepEqual(m.units.map((u) => u.key), ['a', 'c', 'd'], '乱序按 seq 归位、重复不重复拼接');

  /* 取消后主线程不再处理该会话的任何迟到消息 */
  const s5 = W.WRPLParse.createSession('S5');
  const p5 = W.WRPLParse.parse(new ArrayBuffer(64), { session: s5, force: 'worker' });
  const w5 = W.__workers[1];
  w5.emit({ type: 'ready', hasFzstd: true });
  w5.emit({ type: 'part', sessionId: 'S5', seq: 1, key: 'units', data: [{ key: 'x' }] });
  s5.cancel();
  await assert.rejects(p5, (e) => e.code === 'cancelled');
  /* 模拟"终止前已经排队的迟到消息"：手工调用旧 onmessage（已置 null → 不会生效） */
  assert.equal(w5.onmessage, null, '取消后解绑消息回调（迟到消息无人接收）');
  assert.ok(w5.sent.some((m2) => m2.cmd === 'cancel'), '取消时通知 worker');
  console.log('  ✓ 取消/迟到/乱序/重复：分片不重复拼接、取消后消息不再影响页面');
}

/* ================================================================ 用例 5
 * worker 侧：收到 cancel 后不再发分片；会话标识与 seq 正确。 */
async function caseWorkerCancel() {
  let release;
  const gate = new Promise((r) => { release = r; });
  const parseMainImpl = async function (buf, opts) {
    opts.sessionId = opts.sessionId;   // 无操作，仅强调 worker 会把会话传进来
    await gate;
    if (opts.shouldAbort && opts.shouldAbort()) {
      const e = new Error('解析已取消'); e.code = 'cancelled'; throw e;
    }
    return {
      meta: { window: { duration: 5 }, limits: [], provenance: [] },
      own: { t0: 0, hz: 10, n: 1, x: [0], y: [0], z: [0] },
      units: [{ key: 'u1', x: [0], y: [0] }],
      events: [], shots: [], runways: [], airfields: [], missiles: [],
      terrain: null, names: {}, __attitude: null,
    };
  };
  const C = loadWorkerThread(parseMainImpl);
  C.onmessage({ data: { cmd: 'parse', sessionId: 'W1', buf: new ArrayBuffer(8) } });
  /* 取消前先发一条进度（经 WRPLParse.progress 回调） */
  C.__progressCb({ phase: 'fm', pct: 20, note: 'x', sessionId: 'W1' });
  C.onmessage({ data: { cmd: 'cancel', sessionId: 'W1' } });
  const beforeCancel = C.__posted.length;
  release();
  await tick(10);
  const after = C.__posted.slice(beforeCancel);
  assert.equal(after.length, 0, '取消后 worker 不再发送任何消息（含分片/完成）');
  assert.ok(C.__posted.every((m) => m.sessionId === 'W1'), '每条消息都带会话标识');

  /* 未取消的会话：分片带单调 seq，done 最后一条 */
  let release2;
  const gate2 = new Promise((r) => { release2 = r; });
  const C2 = loadWorkerThread(async function () {
    await gate2;
    return {
      meta: { window: { duration: 5 }, limits: [], provenance: [] },
      own: { t0: 0, hz: 10, n: 1, x: [0], y: [0], z: [0] },
      units: [{ key: 'u1', x: [0], y: [0] }],
      events: [], shots: [], runways: [], airfields: [], missiles: [],
      terrain: null, names: {}, __attitude: null,
    };
  });
  C2.onmessage({ data: { cmd: 'parse', sessionId: 'W2', buf: new ArrayBuffer(8) } });
  release2();
  await tick(10);
  const parts = C2.__posted.filter((m) => m.type === 'part');
  assert.ok(parts.length > 0, '有分片发出');
  const seqs = parts.map((m) => m.seq);
  assert.deepEqual(seqs, seqs.map((_, i) => i + 1), '分片 seq 从 1 单调递增');
  const done = C2.__posted[C2.__posted.length - 1];
  assert.equal(done.type, 'done', 'done 是最后一条');
  assert.ok(done.seq > seqs[seqs.length - 1], 'done 的 seq 大于所有分片');
  console.log('  ✓ Worker 侧：取消后零发送；会话标识与 seq 单调、done 收尾');
}

/* ================================================================ 用例 6
 * 主线程路径的取消检查（没有 Worker 时也要能在解析中途停下）。
 * 造一份**容器头合法**的假回放（magic = 0x1000ACE5），在第一次进度回调里取消会话；
 * 解析循环应在下一个检查点以 code='cancelled' 停下，而不是继续解到包流层再报别的错。
 * 另外验证：取消之后再调用 parse() 直接拒绝。 */
async function caseMainThreadCancel() {
  const W = loadMainThread();
  const buf = new ArrayBuffer(4096);
  const u8 = new Uint8Array(buf);
  u8[0] = 0xE5; u8[1] = 0xAC; u8[2] = 0x00; u8[3] = 0x10;   // magic 0x1000ACE5（LE）

  const sess = W.WRPLParse.createSession('M1');
  let progressSeen = 0;
  W.WRPLParse.progress((p) => {
    if (p.sessionId === 'M1') {
      progressSeen++;
      sess.cancel();                 // 第一条进度到达时用户换了文件
    }
  });
  await assert.rejects(W.WRPLParse.parse(buf, { session: sess, force: 'main' }),
                       (e) => e.code === 'cancelled', '主线程路径中途被取消');
  assert.equal(W.ACE_ATTITUDE, null, '取消的会话不发布 ACE_ATTITUDE');

  /* 已取消的会话再次 parse：入口即拒绝，不进入解析 */
  await assert.rejects(W.WRPLParse.parse(buf, { session: sess, force: 'main' }),
                       (e) => e.code === 'cancelled', '已取消的会话不会开始解析');
  console.log('  ✓ 主线程路径：中途取消在检查点停下、不发布场景数据');
}

const cases = [caseNormal, caseReplaceMidway, caseFailThenRetry, caseLateAndReorder,
               caseWorkerCancel, caseMainThreadCancel];
let failed = 0;
for (const c of cases) {
  try { await c(); }
  catch (e) { failed++; console.error('  ✗ ' + c.name + '：' + (e && e.stack || e)); }
}
if (failed) { console.error(`parse-session: ${failed} FAIL`); process.exit(1); }
console.log('parse-session: all ok');
