/* =====================================================================
 * wrpl-worker.js —— 把 .wrpl 解析放到 Web Worker 里，主线程只收结果
 * ---------------------------------------------------------------------
 * 主线程（wrpl-parse.js 的 parseInWorker）发来的消息：
 *   { cmd: 'ready' }                              → 回 { type: 'ready' }
 *   { cmd: 'parse', sessionId, buf, fileName }    → 回若干 { type: 'progress' | 'part' | 'debug' }
 *                                                   最后 { type: 'done', parts } 或 { type: 'error' }
 *   { cmd: 'cancel', sessionId }                  → 立刻停止该会话：不再发分片/进度/完成
 * `buf` 是 **Transferable**（主线程 postMessage 时转交所有权）：
 * 主线程那边这个 ArrayBuffer 立刻 detached，主线程堆不背这份数据。
 *
 * 会话：每条 progress / part / done / error 都带 `sessionId` 与（分片、完成消息的）
 * 单调 `seq`。主线程按会话标识丢弃迟到消息，按 seq 去重、按 seq 排序拼接。
 * 收到 cancel 后本文件**不再 post 任何该会话的消息**（包括已经在跑的解析结果）。
 * 会话结束（完成/失败/取消）后清掉引用，主线程随后 terminate()，整个 isolate 一起回收。
 *
 * 本文件与本目录的 fzstd / wrpl-parse.js 用 importScripts 加载（本机文件，不联网）。
 * ===================================================================== */
'use strict';

importScripts('vendor/fzstd.min.js', 'ecs-comps.js', 'ecs-names.js', 'wrpl-parse.js');

var peakHeap = 0;
function heapNow() {
  // Chromium 的 Worker 里同样有 performance.memory（拿不到就返回 0）
  try {
    return (self.performance && self.performance.memory) ? self.performance.memory.usedJSHeapSize : 0;
  } catch (e) { return 0; }
}

/* 会话表：sessionId -> { cancelled, seq }
 * 只有**当前**会话会往主线程发消息；它被取消或结束后表项删除。 */
var jobs = Object.create(null);
var activeId = null;
var sessionSeq = 0;

function job(id) { return jobs[id] || null; }
function isCancelled(id) { var j = jobs[id]; return !!(j && j.cancelled); }

/** 统一的发消息入口：已取消的会话一条都不发（含完成消息）。 */
function post(id, msg) {
  if (!id || isCancelled(id)) { return false; }
  msg.sessionId = String(id);
  var j = jobs[id];
  if (j && (msg.type === 'part' || msg.type === 'done')) { msg.seq = ++j.seq; }
  self.postMessage(msg);
  return true;
}

WRPLParse.progress(function (p) {
  var id = p && p.sessionId;
  if (!id || isCancelled(id)) { return; }      // 旧会话/已取消会话的进度一律不发
  var h = heapNow();
  if (h > peakHeap) peakHeap = h;
  post(id, { type: 'progress', phase: p.phase, pct: p.pct, note: p.note || '',
             workerHeapMB: h ? +(h / 1048576).toFixed(0) : null });
});

/** 按「数值个数」估算体积，切成若干条消息，避免单条 structured clone 太长。 */
function chunkUnits(units, maxVals) {
  var out = [], cur = [], curVals = 0;
  function vals(u) {
    var n = 0;
    for (var i = 0; i < u.x.length; i++) n++;               // 每个数组 n 个元素
    return n * 5;                                           // x/y/z/hdg + 元信息，粗略按 5 列算
  }
  units.forEach(function (u) {
    var v = vals(u);
    if (cur.length && curVals + v > maxVals) { out.push(cur); cur = []; curVals = 0; }
    cur.push(u); curVals += v;
  });
  if (cur.length) out.push(cur);
  return out;
}

function sendOwn(id, own) {
  // 本机 17 个通道 × 5589 → 拆 4 条，单条 clone 不至于太长
  var groups = [['t0', 'hz', 'n'], ['x', 'y', 'z'], ['ias', 'tas', 'mach', 'hdg'],
                ['roll', 'pitch', 'g', 'aoa', 'ammo', 'fuel', 'vy', 'throttle']];
  for (var i = 0; i < groups.length; i++) {
    if (isCancelled(id)) { return 0; }          // 每个分片发送前都看一眼：取消后不再继续
    var keys = groups[i], part = {};
    keys.forEach(function (k) { part[k] = own[k]; });
    post(id, { type: 'part', key: 'own', data: part });
  }
  return groups.length;
}

function sendMission(id, mission, wantDebug, dbg, timings) {
  var parts = 0, i;
  post(id, { type: 'part', key: 'meta', data: mission.meta }); parts++;
  parts += sendOwn(id, mission.own);
  var chunks = chunkUnits(mission.units || [], 120000);
  for (i = 0; i < chunks.length; i++) {
    if (isCancelled(id)) { return parts; }
    post(id, { type: 'part', key: 'units', data: chunks[i] });
    parts++;
  }
  var keys = ['events', 'shots', 'runways', 'airfields', 'missiles'];
  for (i = 0; i < keys.length; i++) {
    if (isCancelled(id)) { return parts; }
    post(id, { type: 'part', key: keys[i], data: mission[keys[i]] }); parts++;
  }
  /* 飘带用的横滚序列（可能上百 KB）：按 uid 分片发，避免单条 structured clone 太长 */
  var att = mission.__attitude;
  if (att && att.units) {
    var uids = Object.keys(att.units), buf = {}, cnt = 0;
    var head = { note: att.note, secPerTick: att.secPerTick, tick0: att.tick0, dt: att.dt };
    for (i = 0; i < uids.length; i++) {
      var uid = uids[i];
      buf[uid] = att.units[uid];
      cnt++;
      if (cnt >= 8 || i === uids.length - 1) {
        if (isCancelled(id)) { return parts; }
        var data = {};
        Object.keys(head).forEach(function (k) { data[k] = head[k]; });
        data.units = buf;
        post(id, { type: 'part', key: '__attitude', data: data });
        parts++;
        buf = {}; cnt = 0;
      }
    }
  }
  if (isCancelled(id)) { return parts; }
  post(id, { type: 'part', key: 'terrain', data: mission.terrain }); parts++;
  post(id, { type: 'part', key: 'names', data: mission.names }); parts++;
  if (wantDebug && dbg) post(id, { type: 'debug', data: dbg });
  post(id, { type: 'done', parts: parts,
             timing: { parseMs: timings ? timings.parseMs : null,
                       sendMs: timings && timings.tParsed ? (Date.now() - timings.tParsed) : null },
             /* worker 里 performance.memory 常常取不到：拿不到就给 null，
                不要给 0（0 读起来像"堆占用 0 MB"这样的事实陈述） */
             workerHeapPeakMB: peakHeap ? +(peakHeap / 1048576).toFixed(1) : null });
  return parts;
}

function runParse(id, msg) {
  var dbg = msg.wantDebug ? {} : null;
  var opts = { fileName: msg.fileName, yieldEvery: msg.yieldEvery,
               sessionId: id,
               /* 取消检查点：解析循环在每个让出点问一次，取消后立刻停下，
                * 不再继续解、也不再发任何分片。 */
               shouldAbort: function () { return isCancelled(id); } };
  if (dbg) opts.debug = dbg;
  /* 调 parseMain（原始解析）而不是公开的 parse：
   * 公开 parse 会把 __attitude 摘下来挂到 window.ACE_ATTITUDE，而 worker 里没有 window，
   * 结果就再也发不回主线程了（主线程那边 ACE_ATTITUDE 会是 0 个 uid）。 */
  var runner = (WRPLParse._internal && WRPLParse._internal.parseMain) || WRPLParse.parse;
  var tStart = Date.now();
  runner(msg.buf, opts).then(function (mission) {
    var tParsed = Date.now();
    if (isCancelled(id)) { return; }           // 已取消：结果直接丢，一个分片都不发
    /* 计时随 done 一起回（done 一到主线程就 resolve，单独发的 timing 会晚到、读不到） */
    sendMission(id, mission, msg.wantDebug, dbg, { parseMs: tParsed - tStart, tParsed: tParsed });
    // 主动清引用：大数组不再被 worker 持有（随后主线程会 terminate 整个 isolate）
    mission = null;
    if (dbg) dbg = null;
  }).catch(function (e) {
    if (isCancelled(id) || (e && e.code === 'cancelled')) { return; }
    post(id, { type: 'error', message: String(e && e.message ? e.message : e),
               code: e && e.code ? e.code : null, tech: e && e.tech ? e.tech : null,
               fromWorkerParse: true });
  }).then(function () {
    /* 会话结束（完成/失败/取消）：释放本会话的登记与已收数据引用 */
    delete jobs[id];
    if (activeId === id) { activeId = null; }
  });
}

self.onmessage = function (ev) {
  var msg = ev.data || {};
  if (msg.cmd === 'ready') {
    self.postMessage({ type: 'ready', hasFzstd: !!(self.fzstd && self.fzstd.decompress) });
    return;
  }
  if (msg.cmd === 'cancel') {
    /* 主线程取消：标记后本会话的后续 post 全部静默；解析循环在下一个让出点停下。
     * 主线程通常还会 terminate()，两条路径都安全。 */
    var cj = job(msg.sessionId);
    if (!cj) {
      jobs[msg.sessionId] = { cancelled: true, seq: 0 };   // 取消先于 parse 到达也要记住
    } else {
      cj.cancelled = true;
    }
    return;
  }
  if (msg.cmd !== 'parse') { return; }
  /* 一个 Worker 只服务一个会话：主线程每次解析都会新建 Worker。
   * 若上一会话还没清干净，先把它标记为取消（它不会再发任何消息）。 */
  if (activeId && activeId !== msg.sessionId) {
    var prev = job(activeId);
    if (prev) { prev.cancelled = true; }
  }
  var id = msg.sessionId || ('w-' + (++sessionSeq));
  /* 若这条会话在 parse 之前就被取消过（cancel 先到），保留取消标记：
   * 解析照跑但一条消息都不发（主线程那边通常也已经 terminate）。 */
  var prior = job(id);
  jobs[id] = { cancelled: !!(prior && prior.cancelled), seq: 0 };
  activeId = id;
  runParse(id, msg);
};
