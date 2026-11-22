import { connect, sleep } from './cdp.mjs';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const snip = (n) => fs.readFileSync(path.join(HERE, 'snippets', n), 'utf8');
const c = await connect();
const out = {};
try {
  await c.goto('http://127.0.0.1:5188/');
  await c.evaluate(snip('console-collect.js'));
  let ready=false; for (let i=0;i<160;i++){ await sleep(500);
    const st=await c.evaluate('({r:!!window.__EXILIUM_READY,e:window.__EXILIUM_ERROR||null})');
    if(st.e){out.bootError=st.e;break;} if(st.r){ready=true;break;} }
  out.ready = ready;
  await c.evaluate(snip('install.js'));
  await c.evaluate(snip('console-collect.js'));

  // 1. group AoE cap
  await c.evaluate('window.__probe.spawnPack(12, 2.4)');
  const t0=Date.now(); let casts=0;
  while(Date.now()-t0<3500){ casts += await c.evaluate(snip('group-cast.js')); await sleep(55); }
  out.group = { casts, worstWindowMs: (await c.evaluate('window.__probe.worstWindow()'))*1000,
    info: await c.evaluate('window.__probe.hitstop()') };

  // 2. skill bar mirror + freeze-window casts
  out.barMirror = await c.evaluate(snip('bar-mirror.js'));
  out.freezeCast = await c.evaluate(snip('freeze-cast.js'));

  // 3. rebuild
  out.rebuild = await c.evaluate(snip('dirty-then-rebuild.js'));

  out.errors = await c.evaluate('window.__errs.slice(0,20)');
  console.log(JSON.stringify(out, null, 2));
} finally { c.close(); }
