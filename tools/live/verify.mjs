import { connect, sleep } from './cdp.mjs';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const snip = (n) => fs.readFileSync(path.join(HERE, 'snippets', n), 'utf8');
const c = await connect();
const out = {};
try {
  await c.goto('http://127.0.0.1:5188/');
  // Install error collector as early as possible
  await c.evaluate(snip('console-collect.js'));
  let ready=false; for (let i=0;i<160;i++){ await sleep(500);
    const st=await c.evaluate('({r:!!window.__EXILIUM_READY,e:window.__EXILIUM_ERROR||null})');
    if(st.e){ out.bootError=st.e; break; } if(st.r){ready=true;break;} }
  out.ready = ready;
  await c.evaluate(snip('install.js'));
  await c.evaluate(snip('console-collect.js'));
  out.inputCast = await c.evaluate(snip('input-cast.js'));
  // hitstop via real bus from a real AoE hit: spawn pack, cast groundSlam through combat
  await c.evaluate('window.__probe.spawnPack(10, 2.2)');
  out.aoeHitstop = await c.evaluate(`(() => {
    const W = window.__ENGINE.ctx.World;
    W.clock.reset();
    const before = W.clock.hitstopInfo().grantedMs;
    const ok = W.combat.cast('groundSlam');
    const after = W.clock.hitstopInfo();
    return { ok, grantedMs: after.grantedMs, requests: after.requests, frozen: after.frozen,
      remainingMs: after.remainingMs };
  })()`);
  await sleep(300);
  out.errors = await c.evaluate('window.__errs.slice(0,20)');
  console.log(JSON.stringify(out, null, 2));
} finally { c.close(); }
