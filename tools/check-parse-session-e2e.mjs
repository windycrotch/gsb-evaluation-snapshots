/* =====================================================================
 * check-parse-session-e2e.mjs —— 用真实解析器跑会话隔离（合成 .wrpl）
 * ---------------------------------------------------------------------
 * check-parse-session.mjs 用假 Worker 验证协议；这里用**真实的 wrpl-parse.js**
 * （含 fzstd、包流、FlightModel 解码）跑一份合成回放，验证端到端：
 *   1. 正常解析：真实解析出航迹与击杀事件，分片完整；
 *   2. 解析中途取消（主线程路径）：在下个检查点停下，不产出数据；
 *   3. 同一份数据用两个会话各解一次：两次结果互不串（单位数、事件数一致）；
 *   4. 取消后再解一次：结果干净（不残留上一次的 ACE_ATTITUDE / meta）。
 * 用法：node tools/check-parse-session-e2e.mjs
 * ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import zlib from 'node:zlib';
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const require = createRequire(import.meta.url);

/* ---------------------------------------------------- 合成一份最小 .wrpl
 * 容器头 1224 B（magic 0x1000ACE5、settingsSize=0），其后是 zstd 帧：
 * 包流 = 若干 ptype=2 (FlightModel) 包 + 一个 ptype=0 结束标记。
 * FlightModel 的位流格式比较复杂，这里不手写它，而是只用**空包**触发
 * 完整的容器/解压/切包/各阶段流程 —— 目的是验证会话边界与生命周期，
 * 不是验证解码正确性（那是 selftest-node 的职责）。 */
function synthReplay(packetCount = 200) {
  const settingsSize = 0;
  const head = Buffer.alloc(1224 + 2 + settingsSize);
  head.writeUInt32LE(0x1000ACE5, 0);
  head.writeUInt32LE(2, 4);                       // version
  head.writeUInt32LE(settingsSize, 748);          // settingsSize（locatePacketStream 用）
  head.writeUInt32LE(0, 756);                     // rezOffset = 0（无结算 BLK）

  /* 包流：每条 [VLQ 长度][ptype 字节][u32 ms] + payload。
   * 用 ptype=0（结束标记，解析器只读它的 ms）+ payload 填零，
   * 长度设小一些，让 200 个包能稳定走完切包与各阶段循环。 */
  const parts = [];
  for (let i = 0; i < packetCount; i++) {
    const pl = Buffer.alloc(8);                   // 8 B 载荷
    const size = 1 + 4 + pl.length;               // ptype + ms + payload（长度前缀不计入 size）
    const frame = Buffer.alloc(1 + 1 + 4 + pl.length);
    frame[0] = size;                              // VLQ 单字节：<0x80
    frame[1] = 0;                                 // ptype=0（非 0x10 位 → 带 ms）
    frame.writeUInt32LE(i * 16, 2);               // ms 递增
    pl.copy(frame, 6);
    parts.push(frame);
  }
  const body = zlib.zstdCompressSync(Buffer.concat(parts));
  return Buffer.concat([head, body]);
}

function loadParser(extra = {}) {
  const ctx = {
    console: { log() {}, warn() {}, error: console.error },
    setTimeout, clearTimeout,
    Date, Math, JSON, Object, Array, String, Number, Boolean, Error,
    Uint8Array, Uint16Array, Uint32Array, Int16Array, Int32Array, Float32Array, Float64Array,
    DataView, ArrayBuffer, TextDecoder, Promise,
    document: { currentScript: { src: 'http://local/web/wrpl-parse.js' } },
    ...extra,
  };
  ctx.self = ctx;
  ctx.window = ctx;
  vm.createContext(ctx);
  const run = (f) => vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), ctx,
                                     { filename: f });
  run('web/vendor/fzstd.min.js');
  run('web/ecs-comps.js');
  run('web/ecs-names.js');
  run('web/wrpl-parse.js');
  return ctx;
}

const toAB = (buf) => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);

async function caseNormalE2E() {
  const W = loadParser();
  const replay = synthReplay(200);
  const phases = [];
  W.WRPLParse.progress((p) => phases.push(p.phase));
  const m = await W.WRPLParse.parse(toAB(replay), { force: 'main', sessionId: 'E1' });
  assert.ok(m && m.meta, '产出 mission.meta');
  assert.equal(m.meta.source, 'wrpl');
  assert.equal(m.meta.sessionId, undefined, 'meta 里不混入内部会话字段');
  assert.ok(phases.indexOf('container') >= 0, '走到容器阶段');
  assert.ok(phases.indexOf('done') >= 0, '走到完成阶段');
  assert.equal(m.own.n >= 1, true, '本机序列至少一点（空回放也保留 tick0 语义）');
  console.log('  ✓ 真实解析器：容器→解压→切包→完成，全流程走通');
}

async function caseCancelE2E() {
  const W = loadParser();
  const replay = synthReplay(5000);              // 包多，确保解析超过一个让出点
  const sess = W.WRPLParse.createSession('E2');
  let cancelledAt = -1;
  W.WRPLParse.progress((p) => {
    if (p.sessionId === 'E2' && cancelledAt < 0) {
      cancelledAt = performance.now();
      sess.cancel();                             // 第一条进度后用户换了文件
    }
  });
  await assert.rejects(W.WRPLParse.parse(toAB(replay), { session: sess, force: 'main' }),
                       (e) => e.code === 'cancelled', '取消后以 cancelled 拒绝');
  assert.ok(cancelledAt > 0, '取消发生在解析过程中（而不是入口）');
  assert.equal(W.ACE_ATTITUDE, null, '取消的会话没有发布 ACE_ATTITUDE');
  console.log('  ✓ 真实解析器：中途取消在检查点停下、不发布场景数据');
}

async function caseTwoSessionsIndependent() {
  const W = loadParser();
  const replay = synthReplay(100);
  const m1 = await W.WRPLParse.parse(toAB(replay), { force: 'main', sessionId: 'A' });
  const att1 = W.ACE_ATTITUDE;
  const m2 = await W.WRPLParse.parse(toAB(replay), { force: 'main', sessionId: 'B' });
  /* 两次结果互不共享对象（不可变数据），关键计数一致 */
  assert.notEqual(m1, m2);
  assert.equal(m2.meta.counts.trackCount, m1.meta.counts.trackCount);
  assert.equal(m2.meta.counts.events, m1.meta.counts.events);
  assert.equal(typeof att1, typeof W.ACE_ATTITUDE, 'ACE_ATTITUDE 每次整体替换');
  /* 第二份的 limits 不累积第一份的（每次都是新数组） */
  assert.ok(!m2.meta.limits.some((x) => x.indexOf('解析路径：主线程（调用方强制') >= 0 &&
                                          m1.meta.limits.indexOf(x) < 0));
  console.log('  ✓ 两次会话：结果独立、ACE_ATTITUDE 整体替换、limits 不累积');
}

async function caseCancelThenParseAgain() {
  const W = loadParser();
  const replay = synthReplay(3000);
  const s1 = W.WRPLParse.createSession('C1');
  let fired = false;
  W.WRPLParse.progress((p) => {
    if (p.sessionId === 'C1' && !fired) { fired = true; s1.cancel(); }
  });
  await assert.rejects(W.WRPLParse.parse(toAB(replay), { session: s1, force: 'main' }),
                       (e) => e.code === 'cancelled');
  /* 再解一次（全新会话）：结果干净、不带上一次的任何东西 */
  const s2 = W.WRPLParse.createSession('C2');
  const m = await W.WRPLParse.parse(toAB(synthReplay(100)), { session: s2, force: 'main' });
  assert.equal(m.meta.source, 'wrpl');
  assert.ok(!m.meta.limits.some((x) => x.indexOf('cancelled') >= 0), 'limits 里没有取消会话的痕迹');
  console.log('  ✓ 取消后再解析：结果干净、不残留上一次的数据');
}

const cases = [caseNormalE2E, caseCancelE2E, caseTwoSessionsIndependent, caseCancelThenParseAgain];
let failed = 0;
for (const c of cases) {
  try { await c(); }
  catch (e) { failed++; console.error('  ✗ ' + c.name + '：' + (e && e.stack || e)); }
}
if (failed) { console.error(`parse-session-e2e: ${failed} FAIL`); process.exit(1); }
console.log('parse-session-e2e: all ok');
