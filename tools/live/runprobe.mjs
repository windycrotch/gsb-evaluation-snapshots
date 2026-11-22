import { connect, sleep } from './cdp.mjs';
const c = await connect();
try {
  await c.goto('http://127.0.0.1:5188/');
  let ready = false;
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const st = await c.evaluate('({ready:!!window.__EXILIUM_READY, err:window.__EXILIUM_ERROR||null, eng:!!window.__ENGINE})');
    if (st.err) { console.log('BOOT ERR', st.err); break; }
    if (st.ready) { ready = true; console.log('ready in', (i+1)*0.5, 's'); break; }
  }
  console.log('ready', ready);
  console.log(JSON.stringify(await c.evaluate(`(() => {
    const E=window.__ENGINE,W=E.ctx.World;
    return { hasClock:!!W.clock, hasCombat:!!W.combat, hitstop: W.clock&&W.clock.hitstopInfo(),
      bar: W.combat&&W.combat.bar.map(b=>b.id+':'+b.cost), mana: W.player&&Math.round(W.player.mana),
      fps: Math.round(E.clock.fps), level: W.level&&W.level.seed };
  })()`), null, 2));
} finally { c.close(); }
