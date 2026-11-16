// 竞速修正端到端测试：覆盖三处曾不可信的行为
//  一、对手冲线即固定完赛时刻，名次表显示"完赛"，且永远排在玩家前面；玩家冲线名次 = 已完赛人数 + 1
//  二、掉线转 AI 托管沿用掉线前的推进节奏（不重置成固定系数），托管后仍参与名次与终点判定
//  三、对已完赛对手释放逆风/断电/锁跳：不改状态、不耗技能槽、给出提示
// 前置：python -m http.server 8123（项目根目录）；可用 SR_PORT / SR_CHROME 覆盖端口与浏览器
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const CHROME = process.env.SR_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const PORT = 9359;
const PAGE = `http://127.0.0.1:${process.env.SR_PORT || 8123}/?race`;

const chrome = spawn(
  CHROME,
  [
    `--remote-debugging-port=${PORT}`,
    '--headless=new',
    '--enable-unsafe-swiftshader',
    '--no-sandbox',
    '--hide-scrollbars',
    '--no-proxy-server',
    '--proxy-bypass-list=*',
    '--window-size=1600,900',
    `--user-data-dir=${path.join(ROOT, '.tmp-racefix')}`,
    'about:blank',
  ],
  { stdio: 'ignore' }
);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function attach() {
  for (let i = 0; i < 60; i++) {
    try {
      const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = tabs.find((t) => t.type === 'page');
      if (page) return page.webSocketDebuggerUrl;
    } catch {}
    await sleep(250);
  }
  throw new Error('无法连接 Chrome 调试端口');
}

const ws = new WebSocket(await attach());
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = rej;
});

let msgId = 0;
const pending = new Map();
const errors = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    pending.get(msg.id)(msg);
    pending.delete(msg.id);
  } else if (msg.method === 'Runtime.exceptionThrown') {
    errors.push(msg.params.exceptionDetails.text + ' ' + (msg.params.exceptionDetails.exception?.description || ''));
  } else if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') {
    errors.push(msg.params.args.map((a) => a.value ?? a.description).join(' ').slice(0, 200));
  }
};
const send = (method, params = {}) =>
  new Promise((res) => {
    const id = ++msgId;
    pending.set(id, res);
    ws.send(JSON.stringify({ id, method, params }));
  });
const evaluate = async (expr) =>
  (await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true })).result?.result?.value;

await send('Runtime.enable');
await send('Page.enable');
await send('Page.navigate', { url: PAGE });

let ready = false;
for (let i = 0; i < 40; i++) {
  await sleep(400);
  ready = (await evaluate(`typeof window.__game === 'object'`)) === true;
  if (ready) break;
}
if (!ready) {
  console.log('PAGE FAILED ❌');
  ws.close();
  chrome.kill();
  process.exit(1);
}
await sleep(4400); // 倒计时结束进入 go

// 重新开一局干净的比赛，返回后等倒计时跑完
async function restartRace() {
  await evaluate(`window.__game.startRace(12345)`);
  await sleep(4300);
}

const out = {};

// ============ 情形一：冲线固定 + "完赛"显示 + 恒在玩家之前 + 玩家名次=已完赛人数+1 ============
{
  await restartRace();
  out.s1 = await evaluate(`(()=>{
    const g = window.__game, r = g.race, p = g.player;
    const o0 = r.opponents[0], o1 = r.opponents[1];
    const tBefore = r.time;
    // 把第一名对手直接放到终点线，等真实主循环这一帧把它判为完赛
    o0.z = r.len;
    return JSON.stringify({ before: { finished: o0.finished, finishT: o0.finishT, time: +tBefore.toFixed(2) }, name: o0.name });
  })()`);
  await sleep(300);
  out.s1Finish = await evaluate(`(()=>{
    const g = window.__game, r = g.race;
    const o0 = r.opponents[0];
    return JSON.stringify({ finished: o0.finished, finishT: +o0.finishT.toFixed(2), z: +o0.z.toFixed(1), len: r.len, time: +r.time.toFixed(2) });
  })()`);

  // 玩家跑到赛道很靠后的位置（仍未冲线），完赛对手必须仍排在前面、gap 为"完赛"
  await evaluate(`(()=>{ const g=window.__game; g.player.pos.z = g.RACE_LEN - 30; g.player.prevY = g.player.pos.y; return 1; })()`);
  await sleep(300);
  out.s1Board = await evaluate(`(()=>{
    const g = window.__game, r = g.race;
    const o0 = r.opponents[0];
    const rows = r.rows(g.player.pos.z);
    const mine = rows.find(x => x.me);
    const his = rows.find(x => x.name === o0.name);
    // 直接用更靠后的玩家坐标再算一次，证明与玩家跑到哪无关
    r.update(0.016, g.RACE_LEN - 1);
    const placeNearLine = r.place;
    const rowsNear = r.rows(g.RACE_LEN - 1);
    return JSON.stringify({
      hisPlace: his.place, hisGap: his.gap, hisDone: his.done,
      myPlace: mine.place, myDone: mine.done,
      stillAheadNearLine: rowsNear.find(x => x.name === o0.name).place < rowsNear.find(x => x.me).place,
      placeNearLine,
      finishedCount: r.opponents.filter(x => x.finished).length,
    });
  })()`);

  // 完赛时刻冻结：再跑若干帧，finishT / z 不得变化
  const snap = await evaluate(`(()=>{ const o=window.__game.race.opponents[0]; return JSON.stringify({finishT:o.finishT,z:o.z}); })()`);
  await sleep(700);
  out.s1Frozen = await evaluate(`(()=>{
    const o = window.__game.race.opponents[0];
    const s = JSON.parse(${JSON.stringify(snap)});
    return JSON.stringify({ finishT: o.finishT, z: +o.z.toFixed(1), unchanged: o.finishT === s.finishT && Math.abs(o.z - s.z) < 1e-6 });
  })()`);

  // 玩家自己冲线：恰好 1 名对手已完赛 → 玩家必须第 2 名（结算屏 2/3）
  await evaluate(`(()=>{ const g=window.__game; g.player.pos.z = g.RACE_LEN; g.player.prevY = g.player.pos.y; return 1; })()`);
  await sleep(400);
  out.s1Result = await evaluate(
    `JSON.stringify({mode:window.__game.mode, state:window.__game.raceState, place:window.__game.race.place,
      finishedBefore:window.__game.race.opponents.filter(x=>x.finished).length,
      cell:document.querySelector('.final-cell b').textContent.trim(),
      label:document.getElementById('deathLabel').textContent})`
  );

  // 纯排序口径：把两名对手都标为已完赛（不同冲线时刻），玩家也已在终点。
  // rows() 必须按 先完赛对手 → 后完赛对手 → 玩家 排序，且每个人 gap 都是"完赛"
  out.s1Order = await evaluate(`(()=>{
    const g = window.__game, r = g.race;
    r.opponents[0].finished = true; r.opponents[0].finishT = 12.3;
    r.opponents[1].finished = true; r.opponents[1].finishT = 14.7;
    const rows = r.rows(r.len);
    return JSON.stringify({
      names: rows.map(x => x.name),
      places: rows.map(x => x.place),
      allDone: rows.every(x => x.done === true && x.gap === '完赛'),
      myPlace: rows.find(x => x.me).place,
    });
  })()`);
}

// ============ 情形二：掉线托管沿用掉线前节奏，托管后仍参与名次与终点 ============
{
  await restartRace();
  out.s2 = await evaluate(`(()=>{
    const g = window.__game, r = g.race;
    const startZ = 500;
    const o = r.addHuman('drop-test-id', '掉线仔', 0x33dd77, startZ);
    // 模拟真人以 18.9 m/s 的稳定节奏推进：每个采样间隔 0.1s、净推进 1.89m
    const PACKET_DT = 0.1, SPEED = 18.9;
    let z = startZ;
    for (let i = 0; i < 12; i++) {
      r.update(PACKET_DT, g.player.pos.z);
      z += SPEED * PACKET_DT;
      r.setRemote({ id: o.id, z, x: 0, y: 10 });
    }
    const obs = o.obsSpeed;
    const baseAtDrop = Math.min(34, 12 + o.z * 0.018);
    const expectedPace = Math.max(0.85, Math.min(1.15, obs / baseAtDrop));
    const before = { ai: o.ai, remote: o.remote, pace: o.pace };
    r.takeover(o.id);
    const afterTakeover = { ai: o.ai, remote: o.remote, pace: +o.pace.toFixed(3) };
    const oldHardcodedPace = 1.02; // 旧实现 takeover 恒定写死的系数
    // 托管后继续推进：连跑若干帧，z 必须增长且仍在名次表里
    const z0 = o.z;
    for (let i = 0; i < 10; i++) r.update(0.1, g.player.pos.z);
    const z1 = o.z;
    const rowsWhileRunning = r.rows(g.player.pos.z).some(x => x.name === '掉线仔');
    // 托管对手也能正常冲线、参与终点判定
    o.z = r.len - 1;
    r.update(0.2, g.player.pos.z);
    const finishOk = { finished: o.finished, finishT: +o.finishT.toFixed(2), inRows: r.rows(g.player.pos.z).some(x => x.name === '掉线仔') };
    // 对已完赛者再调一次 takeover 不得改变其冻结状态
    const ft = o.finishT;
    r.takeover(o.id);
    const stillFrozen = o.finished && o.finishT === ft;
    return JSON.stringify({
      obsSpeed: +obs.toFixed(2), expectedPace: +expectedPace.toFixed(3),
      before, afterTakeover,
      paceMatchesRhythm: Math.abs(afterTakeover.pace - expectedPace) < 0.07,
      notResetToHardcoded: Math.abs(afterTakeover.pace - oldHardcodedPace) > 0.05,
      keptAdvancing: z1 > z0, rowsWhileRunning, finishOk, stillFrozen,
    });
  })()`);
}

// ============ 情形三：攻击已完赛对手——状态不变、技能槽不消耗、有提示 ============
{
  await restartRace(); // 情形一结束时比赛已结算，必须新开一局才能释放技能
  out.s3 = await evaluate(`(()=>{
    const g = window.__game, r = g.race;
    const done = r.opponents[0];
    const alive = r.opponents[1];
    done.z = r.len;
    return JSON.stringify({ doneName: done.name, aliveName: alive.name });
  })()`);
  await sleep(250); // 让主循环把 done 判为完赛

  const attempts = {};
  for (const skill of ['headwind', 'blackout', 'lockjump']) {
    attempts[skill] = await evaluate(`(()=>{
      const g = window.__game, r = g.race;
      const done = r.opponents[0];
      const targetPlace = r.rows(g.player.pos.z).find(x => x.name === done.name).place;
      const before = { slowT: done.slowT, lockT: done.lockT, darkT: done.darkT };
      g.debug.giveSkill('${skill}');
      const slotBefore = g.atkSkill;
      g.debug.cast(targetPlace);
      const toast = document.getElementById('toast').textContent;
      const slotOn = document.getElementById('skillBar').classList.contains('on');
      return JSON.stringify({
        slotBefore, slotAfter: g.atkSkill, slotKept: g.atkSkill === '${skill}', slotOn,
        stateUnchanged: done.slowT === before.slowT && done.lockT === before.lockT && done.darkT === before.darkT,
        directApplyRejected: r.applySkill(done, '${skill}') === false,
        toastMentionsFinished: toast.includes('完赛'),
      });
    })()`);
  }
  out.s3Blocked = attempts;

  // 正向对照：对未完赛对手释放仍然正常生效并消耗技能槽（防止拦截被写宽）
  out.s3Control = await evaluate(`(()=>{
    const g = window.__game, r = g.race;
    // 直接挑一个确实未完赛的对手（不依赖 opponents 下标与名次的对应关系），拉回赛道中段
    const alive = r.opponents.find(x => !x.finished);
    alive.finishT = 0;
    alive.z = 600;
    alive.netZ = 600;
    // 用稳定 uid 在名次表里定位它当前真正的名次（前位可能已被完赛者占走，不能写死名次）
    const row = r.rows(g.player.pos.z).find(x => x.uid === alive.uid);
    g.debug.giveSkill('lockjump');
    g.debug.cast(row.place);
    return JSON.stringify({ target: alive.name, targetFinished: alive.finished, castPlace: row.place, consumed: g.atkSkill === null, slotOn: document.getElementById('skillBar').classList.contains('on'), lockT: +alive.lockT.toFixed(1) });
  })()`);
}

out.errors = errors.slice(0, 6);
console.log(JSON.stringify(out, null, 1));

function J(v) {
  return typeof v === 'string' ? JSON.parse(v) : v || {};
}
const s1f = J(out.s1Finish);
const s1b = J(out.s1Board);
const s1fz = J(out.s1Frozen);
const s1r = J(out.s1Result);
const s1o = J(out.s1Order);
const s2 = J(out.s2);
const s3b = J(out.s3Blocked);
const s3c = J(out.s3Control);

const checks = {
  // 情形一
  s1_finishFixed: s1f.finished === true && s1f.finishT > 0 && Math.abs(s1f.z - s1f.len) < 1e-6,
  s1_boardDoneAhead: s1b.hisDone === true && s1b.hisGap === '完赛' && s1b.hisPlace < s1b.myPlace,
  s1_aheadAnywhere: s1b.stillAheadNearLine === true && s1b.placeNearLine === 2,
  s1_frozen: s1fz.unchanged === true,
  s1_playerPlace: s1r.mode === 'over' && s1r.state === 'done' && s1r.finishedBefore === 1 && s1r.place === 2 && s1r.cell === '2/3',
  s1_boardOrder: s1o.allDone === true && s1o.myPlace === 3 && s1o.places.join(',') === '1,2,3' && s1o.names[2] === '你',
  // 情形二
  s2_rhythmKept: s2.obsSpeed > 15 && s2.paceMatchesRhythm === true && s2.notResetToHardcoded === true,
  s2_takeoverState: s2.afterTakeover.ai === true && s2.afterTakeover.remote === false && s2.before.ai === false,
  s2_stillRacing: s2.keptAdvancing === true && s2.rowsWhileRunning === true && s2.finishOk.finished === true && s2.finishOk.inRows === true && s2.stillFrozen === true,
  // 情形三
  s3_allBlocked: ['headwind', 'blackout', 'lockjump'].every((k) => {
    const x = J(s3b[k]);
    return x.slotKept === true && x.slotOn === true && x.stateUnchanged === true && x.directApplyRejected === true && x.toastMentionsFinished === true;
  }),
  s3_controlStillWorks: s3c.consumed === true && s3c.slotOn === false && s3c.lockT > 0,
  noErrors: errors.length === 0,
};

const pass = Object.values(checks).every(Boolean);
console.log('CHECKS:', JSON.stringify(checks, null, 1));
console.log(pass ? 'RACE-FIX PASS ✅' : 'RACE-FIX FAILED ❌');

ws.close();
chrome.kill();
process.exit(pass ? 0 : 1);
