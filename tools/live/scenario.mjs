// Acceptance scenario driven over CDP against the live dev server.
import { connect, sleep } from './cdp.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const snip = (name) => fs.readFileSync(path.join(HERE, 'snippets', name), 'utf8');

const c = await connect();
const out = {};
try {
  await c.goto('http://127.0.0.1:5188/');
  let ready = false;
  for (let i = 0; i < 160; i++) {
    await sleep(500);
    const st = await c.evaluate('({ready:!!window.__EXILIUM_READY, err:window.__EXILIUM_ERROR||null})');
    if (st.err) throw new Error('boot: ' + st.err);
    if (st.ready) { ready = true; break; }
  }
  if (!ready) throw new Error('not ready');

  await c.evaluate(snip('install.js'));
  out.pack = await c.evaluate('window.__probe.spawnPack(12, 2.5)');
  out.alive = await c.evaluate('window.__probe.aliveCount()');

  // A. continuous group AoE for ~4s
  const t0 = Date.now();
  let casts = 0;
  while (Date.now() - t0 < 4000) {
    casts += await c.evaluate(snip('group-cast.js'));
    await sleep(60);
  }
  out.casts = casts;
  out.groupWorstWindowMs = (await c.evaluate('window.__probe.worstWindow()')) * 1000;
  out.groupInfo = await c.evaluate('window.__probe.hitstop()');

  // B. spam inside a freeze window
  out.freezeCast = await c.evaluate(snip('freeze-cast.js'));

  // C. rebuild
  out.rebuild = await c.evaluate(snip('rebuild.js'));

  console.log(JSON.stringify(out, null, 2));
} finally { c.close(); }
