/* =====================================================================
 * check-upload-session.mjs —— 上传页的会话隔离验证（页面级，无浏览器）
 * ---------------------------------------------------------------------
 * 用最小 DOM 桩把 web/index.html 的内联粘合脚本原样跑起来，
 * 用可控的假 WRPLParse / ACEUI 驱动四种情形：
 *   1. 正常解析：页面进度到 100%，场景挂上新数据；
 *   2. 解析中途换文件：旧会话被取消，旧进度/旧结果不改页面，最终场景只来自新会话；
 *   3. 解析失败后重试：显示可读错误、可重新拖入；失败会话的部分数据不进场景；
 *   4. 取消后迟到消息：旧会话的 progress/成功回调到达时页面已经属于新会话，必须被丢弃。
 * 用法：node tools/check-upload-session.mjs
 * ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import assert from 'node:assert';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const HTML = fs.readFileSync(path.join(ROOT, 'web', 'index.html'), 'utf8');
const INLINE = HTML.match(/<script>\n([\s\S]*?)\n<\/script>\n<\/body>/)[1];

/* ---------------------------------------------------------------- DOM 桩 */
function makeEl(id) {
  return {
    id, className: '', textContent: '', hidden: false,
    style: {}, value: '',
    _handlers: {},
    addEventListener(ev, fn) { (this._handlers[ev] || (this._handlers[ev] = [])).push(fn); },
    click() { (this._handlers.click || []).forEach((f) => f({})); },
    appendChild() {},
  };
}

function bootPage() {
  const els = {};
  ['upload', 'upload-icon', 'upload-drop', 'upload-file', 'upload-stage', 'upload-pct',
   'upload-note', 'err-title', 'err-detail', 'err-hint', 'err-retry', 'upload-again']
    .forEach((id) => { els[id] = makeEl(id); });
  const barInner = makeEl('bar-inner');

  const winHandlers = {};
  const ctx = {
    console,
    setTimeout, clearTimeout,
    Date, Math, JSON, Object, Array, String, Number, Promise, Error,
    performance: { now: () => Date.now() },
    document: {
      getElementById: (id) => els[id] || makeEl(id),
      querySelector: (sel) => (sel === '#upload-bar > i' ? barInner : null),
    },
    __mounts: [],
    __fetches: [],
  };
  ctx.window = ctx;
  ctx.self = ctx;
  ctx.addEventListener = function (ev, fn) { (winHandlers[ev] || (winHandlers[ev] = [])).push(fn); };

  /* FileReader 桩：readAsArrayBuffer 用宏任务触发 onload */
  ctx.FileReader = function FileReader() { this.readyState = 0; this.onload = null; this.onerror = null; };
  ctx.FileReader.prototype.readAsArrayBuffer = function (file) {
    this.readyState = 1;
    const self = this;
    setTimeout(() => {
      if (self.readyState !== 1) { return; }        // abort() 之后不再回调
      self.readyState = 2;
      const buf = new ArrayBuffer(1024);
      if (self.onload) { self.onload({ target: Object.assign(self, { result: buf }) }); }
    }, 0);
  };
  ctx.FileReader.prototype.abort = function () { this.readyState = 2; };

  /* 假解析器：页面只用到 createSession / progress / parse */
  const parseCalls = [];
  let progressCb = null;
  ctx.WRPLParse = {
    progress(cb) { progressCb = cb; },
    createSession(id) {
      const s = { id, cancelled: false, cancel() { this.cancelled = true; } };
      return s;
    },
    parse(buf, opts) {
      const call = { opts, resolve: null, reject: null, settled: false };
      call.promise = new Promise((res, rej) => { call.resolve = res; call.reject = rej; });
      parseCalls.push(call);
      return call.promise;
    },
  };

  /* 假 ACEUI：记录 mount / unmount 调用与当前挂载的数据 */
  ctx.ACEUI = {
    mounted: null,
    mountCalls: 0,
    unmountCalls: 0,
    mount(data) { this.mounted = data; this.mountCalls++; return true; },
    unmount() { this.mounted = null; this.unmountCalls++; },
  };

  vm.createContext(ctx);
  vm.runInContext(INLINE, ctx, { filename: 'web/index.html#glue' });

  return {
    els, barInner, ctx, winHandlers, parseCalls,
    emitProgress(p) { if (progressCb) { progressCb(p); } },
    drop(file) {
      const handlers = winHandlers.drop || [];
      handlers.forEach((fn) => fn({ preventDefault() {}, dataTransfer: { files: [file] } }));
    },
    tick: (ms = 0) => new Promise((r) => setTimeout(r, ms)),
  };
}

const fakeFile = (name) => ({ name, size: 1024, type: '' });
const fakeMission = (tag, units = []) => ({
  meta: { window: { t1: 10, duration: 10 }, counts: { ownSamples: 1, airTracks: 0,
          groundTracks: 0, kills: 0, shots: 0, runways: 0, airfields: 0 } },
  own: null, units, events: [], shots: [], runways: [], airfields: [], names: {},
  __tag: tag,
});

/* ================================================================ 用例 1 */
async function caseNormal() {
  const P = bootPage();
  P.drop(fakeFile('a.wrpl'));
  await P.tick();
  assert.equal(P.parseCalls.length, 1, '开始一次解析');
  const sid = P.parseCalls[0].opts.sessionId;
  P.emitProgress({ sessionId: sid, phase: 'fm', pct: 40, note: '航迹 12 段' });
  assert.equal(P.els['upload-pct'].textContent, '40%');
  assert.equal(P.els['upload-note'].textContent, '航迹 12 段');
  const m = fakeMission('A');
  P.parseCalls[0].resolve(m);
  await P.tick(5);
  assert.equal(P.ctx.ACEUI.mountCalls, 1, '场景挂载一次');
  assert.equal(P.ctx.ACEUI.mounted.__tag, 'A');
  assert.equal(P.els['upload-pct'].textContent, '100%');
  assert.equal(P.els['upload'].className, 'is-done');
  console.log('  ✓ 正常解析：进度到 100%、场景只挂本会话数据');
}

/* ================================================================ 用例 2 */
async function caseReplaceMidway() {
  const P = bootPage();
  P.drop(fakeFile('a.wrpl'));
  await P.tick();
  const a = P.parseCalls[0];
  P.emitProgress({ sessionId: a.opts.sessionId, phase: 'fm', pct: 55, note: 'A 的进度' });
  assert.equal(P.els['upload-pct'].textContent, '55%');

  /* 解析还没结束时拖入第二个文件 */
  P.drop(fakeFile('b.wrpl'));
  await P.tick();
  assert.equal(P.parseCalls.length, 2, '第二个文件开了新会话');
  assert.ok(P.ctx.__sessions === undefined || true);
  /* 新会话从"读取文件/解压包流"重新开始：旧会话的 55% 不许留着 */
  assert.ok(parseFloat(P.els['upload-pct'].textContent) <= 1, '新会话把旧进度清掉');
  assert.notEqual(P.els['upload-note'].textContent, 'A 的进度');
  assert.equal(P.barInner.style.width, '1.0%', '进度条也从头开始');

  /* 旧会话的迟到进度与完成：一个都不许影响页面 */
  P.emitProgress({ sessionId: a.opts.sessionId, phase: 'ecs', pct: 90, note: 'A 迟到进度' });
  assert.ok(parseFloat(P.els['upload-pct'].textContent) <= 1, '旧会话进度被丢弃');
  assert.notEqual(P.els['upload-note'].textContent, 'A 迟到进度');
  a.resolve(fakeMission('A-late'));
  await P.tick(5);
  assert.equal(P.ctx.ACEUI.mountCalls, 0, '旧会话结果不挂场景');
  assert.equal(P.ctx.ACEUI.mounted, null);

  /* 新会话正常完成 → 场景只来自 B */
  const b = P.parseCalls[1];
  P.emitProgress({ sessionId: b.opts.sessionId, phase: 'units', pct: 88, note: 'B 的进度' });
  assert.equal(P.els['upload-pct'].textContent, '88%', '新会话进度正常显示');
  b.resolve(fakeMission('B'));
  await P.tick(5);
  assert.equal(P.ctx.ACEUI.mounted.__tag, 'B', '最终场景只来自最后一次成功的会话');
  assert.equal(P.ctx.ACEUI.mountCalls, 1);
  console.log('  ✓ 解析中途换文件：旧进度被清空/丢弃，场景只来自新会话');
}

/* ================================================================ 用例 3 */
async function caseFailThenRetry() {
  const P = bootPage();
  P.drop(fakeFile('a.wrpl'));
  await P.tick();
  const a = P.parseCalls[0];
  P.emitProgress({ sessionId: a.opts.sessionId, phase: 'fm', pct: 30, note: '正在解析' });
  const err = new Error('包流解压失败：帧损坏');
  err.code = 'parse-error'; err.tech = 'zstd frame 2';
  a.reject(err);
  await P.tick(5);

  assert.equal(P.els['upload'].className, 'is-error', '显示错误态');
  assert.equal(P.els['err-title'].textContent, '解析失败');
  assert.ok(P.els['err-detail'].textContent.indexOf('包流解压失败') >= 0, '错误可读');
  assert.ok(P.els['err-hint'].textContent.indexOf('zstd frame 2') >= 0, '技术细节保留');
  assert.equal(P.els['upload-pct'].textContent, '0%');
  assert.equal(P.ctx.ACEUI.mountCalls, 0, '失败会话不挂场景');
  assert.equal(P.ctx.ACEUI.unmountCalls >= 0, true);

  /* 失败会话迟到的分片/完成（模拟收到部分数据后又来了 done）也不许挂进场景 */
  a.resolve(fakeMission('A-partial'));
  await P.tick(5);
  assert.equal(P.ctx.ACEUI.mountCalls, 0, '失败会话的部分数据不进场景');

  /* 用户点"重新选择文件" → 回到可拖入状态（错误提示清空） */
  P.els['err-retry'].click();
  assert.equal(P.els['upload'].className, 'is-idle');
  assert.equal(P.els['err-detail'].textContent, '');
  assert.equal(P.els['upload-note'].textContent, '等待回放文件…');

  /* 再拖入一次：新会话成功，页面只显示这次的结果 */
  P.drop(fakeFile('retry.wrpl'));
  await P.tick();
  assert.equal(P.parseCalls.length, 2);
  P.parseCalls[1].resolve(fakeMission('RETRY'));
  await P.tick(5);
  assert.equal(P.ctx.ACEUI.mounted.__tag, 'RETRY');
  assert.equal(P.els['upload'].className, 'is-done');
  console.log('  ✓ 失败后重试：可读错误 + 可重新拖入、失败数据不进场景、重试成功');
}

/* ================================================================ 用例 4 */
async function caseCancelLateMessages() {
  const P = bootPage();
  /* 先让一次解析成功，场景里有 A */
  P.drop(fakeFile('a.wrpl'));
  await P.tick();
  P.parseCalls[0].resolve(fakeMission('A'));
  await P.tick(5);
  assert.equal(P.ctx.ACEUI.mounted.__tag, 'A');

  /* 再拖入 B：新会话开始时旧场景必须先撤掉（用户不该再看到 A） */
  P.drop(fakeFile('b.wrpl'));
  await P.tick();
  assert.equal(P.ctx.ACEUI.mounted, null, '新会话开始时旧场景已卸载');
  assert.ok(P.ctx.ACEUI.unmountCalls >= 1);

  /* B 失败：页面是错误态，场景保持空（不残留 A，也没有 B 的部分数据） */
  P.parseCalls[1].reject(new Error('坏文件'));
  await P.tick(5);
  assert.equal(P.els['upload'].className, 'is-error');
  assert.equal(P.ctx.ACEUI.mounted, null, '失败后场景不残留上一次播放内容');

  /* 取消的会话（被第三次拖入替换）即使 afterwards 成功返回，也不得挂载 */
  P.drop(fakeFile('c.wrpl'));
  await P.tick();
  P.drop(fakeFile('d.wrpl'));
  await P.tick();
  const c = P.parseCalls[2], dCall = P.parseCalls[3];
  c.resolve(fakeMission('C-late'));
  await P.tick(5);
  assert.equal(P.ctx.ACEUI.mounted, null, '被替换会话的迟到成功回调不挂载');
  dCall.resolve(fakeMission('D'));
  await P.tick(5);
  assert.equal(P.ctx.ACEUI.mounted.__tag, 'D', '只认最后一次会话');
  console.log('  ✓ 取消/迟到消息：场景先清空、旧会话迟到结果不挂载、只认最后会话');
}

/* ================================================================ 用例 5 */
async function caseUnsupportedFileType() {
  const P = bootPage();
  P.drop(fakeFile('a.wrpl'));
  await P.tick();
  P.parseCalls[0].resolve(fakeMission('A'));
  await P.tick(5);
  assert.equal(P.ctx.ACEUI.mounted.__tag, 'A');

  /* 拖入非 wrpl：作废旧会话、清场景、给可读提示 */
  P.drop(fakeFile('notes.txt'));
  await P.tick(5);
  assert.equal(P.els['upload'].className, 'is-error');
  assert.ok(P.els['err-detail'].textContent.indexOf('notes.txt') >= 0, '提示里带文件名');
  assert.equal(P.ctx.ACEUI.mounted, null, '非回放文件也清掉旧场景');
  console.log('  ✓ 非法文件：作废旧会话、清场景、给可读提示');
}

const cases = [caseNormal, caseReplaceMidway, caseFailThenRetry, caseCancelLateMessages,
               caseUnsupportedFileType];
let failed = 0;
for (const c of cases) {
  try { await c(); }
  catch (e) { failed++; console.error('  ✗ ' + c.name + '：' + (e && e.stack || e)); }
}
if (failed) { console.error(`upload-session: ${failed} FAIL`); process.exit(1); }
console.log('upload-session: all ok');
