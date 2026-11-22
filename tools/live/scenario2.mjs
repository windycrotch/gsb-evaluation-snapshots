import { connect, sleep } from './cdp.mjs';
import fs from 'node:fs'; import path from 'node:path'; import { fileURLToPath } from 'node:url';
const HERE = path.dirname(fileURLToPath(import.meta.url));
const snip = (n) => fs.readFileSync(path.join(HERE, 'snippets', n), 'utf8');
const c = await connect();
try {
  await c.goto('http://127.0.0.1:5188/');
  let ready=false; for (let i=0;i<160;i++){ await sleep(500);
    const st=await c.evaluate('({r:!!window.__EXILIUM_READY,e:window.__EXILIUM_ERROR||null})');
    if(st.e) throw new Error(st.e); if(st.r){ready=true;break;} }
  if(!ready) throw new Error('not ready');
  await c.evaluate(snip('install.js'));
  // Trigger a boss so there is a delayed eruption queued, then dirty + rebuild.
  const boss = await c.evaluate(`(() => {
    const W = window.__ENGINE.ctx.World;
    const d = window.__ENGINE.systems.find(s=>s&&s.name==='ai').director;
    // Ensure the boss spawns by moving the player into the arena.
    if (d.arena) W.teleportPlayer(d.arena.pos.x, d.arena.pos.z);
    return { arena: d.arena && {x:d.arena.pos.x,z:d.arena.pos.z} };
  })()`);
  await sleep(1500);
  const state = await c.evaluate(snip('director-state.js'));
  const rebuilt = await c.evaluate(snip('dirty-then-rebuild.js'));
  const post = await c.evaluate(snip('director-state.js'));
  console.log(JSON.stringify({ boss, state, rebuilt, post }, null, 2));
} finally { c.close(); }
