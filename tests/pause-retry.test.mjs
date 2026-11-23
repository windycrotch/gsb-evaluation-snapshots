// Regression tests for the unified "timeline freeze & restore" rules shared by manual pause (Esc), automatic
// pause (window blur / hidden tab) and retry/respawn.
//
// Runs against the dev build (index.html produced by `node tools/build.mjs --dev`) in headless Chrome over the
// DevTools Protocol. Drives the game only through the dev-build hooks (__step, __snap, __bot, __hidden, the
// pause helpers and the real menu callbacks) plus page-visible DOM/CSS state, so every assertion checks the
// same surface a player sees.
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Browser } from './cdp.mjs';
import { startServer } from './server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

let passed = 0, failed = 0;
const failures = [];
function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  ok   ${name}`); }
  else { failed++; failures.push(`${name} ${detail}`); console.log(`  FAIL ${name} ${detail}`); }
}
const eps = (a, b, e = 0.01) => Math.abs(a - b) <= e;

const browser = new Browser(true);
const pageErrors = [];
let page;
let server;   // the static file server, closed on exit so the Node event loop can drain

// ---- page helpers ---------------------------------------------------------------
const q = (expr) => page.eval(expr);
const step = (n = 1) => page.eval(`window.__step(${n})`);
const snap = () => q('window.__snap()');
const snapCore = (s) => s.split('|').slice(0, 9).join('|');        // state..boss (everything but text/ship xyz)
const snapXyz = (s) => s.split('|').slice(11).join('|');           // ship world position
const tapKey = async (code) => {
  await q(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'${code}'}))`);
  await q(`window.dispatchEvent(new KeyboardEvent('keyup',{code:'${code}'}))`);
};
const pauseScreens = () => q('document.querySelectorAll("#pause.on").length');
const showPauseScreen = () => q('window.__pauseScreenOn()');

// Pump frames until an in-page predicate holds. The loop runs inside the page in a single round-trip:
// headless software rendering makes each frame ~10 ms and each CDP round-trip ~200 ms, so doing the loop
// in-page is the difference between seconds and minutes.
async function pumpUntil(expr, frames = 1200, label = expr) {
  const ok = await q(`(() => { for (let i = 0; i < ${frames}; i++) {
    let hit = false; try { hit = !!(${expr}); } catch (e) { hit = false; }
    if (hit) return true;
    window.__step(1);
  } return false; })()`);
  if (!ok) throw new Error('Timed out pumping frames for: ' + label);
  return ok;
}

async function openGame(query = '?manual&seed=7') {
  const started = await startServer(root);
  server = started.server;
  await page.navigate(started.url + query);
  await page.waitFor('window.G && window.G.state && window.__step', { label: 'boot' });
  await q('window.__seed(7)');
}

async function startPlay(d = 3000) {
  await q(`window.__jump(${d})`);
  await q('window.G.state === "play" || (() => { throw new Error("not play"); })()');
  await step(5);
}

// Auto pause is suppressed in manual test mode; these helpers briefly lift that flag.
const autoOn = () => q('window.__manual = false');
const autoOff = () => q('window.__manual = true');

async function main() {
  await browser.launch();
  page = await browser.newPage('about:blank');
  browser.onConsole = (msg) => {
    if (msg.method === 'Runtime.exceptionThrown') pageErrors.push(msg.params.exceptionDetails?.exception?.description || 'exception');
    else if (msg.params?.type === 'error') pageErrors.push(msg.params.args.map(a => a.value || a.description).join(' '));
  };

  await openGame();

  // ============================================================ 1. Manual pause freezes the whole timeline
  console.log('\n[1] Esc pause freezes rail, script, callbacks, enemies, boss and bullets; resume continues in place');
  await startPlay(3000);
  const beforeA = await snap();
  await step(60);
  const movingA = await snap();
  check('rail advances while playing', movingA.split('|')[1] !== beforeA.split('|')[1], `${beforeA} -> ${movingA}`);

  await tapKey('Escape');
  await step(2);
  check('pause engages on Esc', await q('window.G.paused === true'));
  check('pause owner is MANUAL', await q('window.__pauseReason() === window.__PAUSE_REASON.MANUAL'));
  check('exactly one pause screen is visible', (await pauseScreens()) === 1, `count=${await pauseScreens()}`);
  check('pause screen carries the .on class', await showPauseScreen());

  const frozenA = await snap();
  const tFrozenA = await q('window.G.time');
  const timersFrozenA = await q('window.__timerCount()');
  await step(150);   // 2.5 seconds of frozen frames
  const stillA = await snap();
  check('rail distance frozen', frozenA.split('|')[1] === stillA.split('|')[1], `${frozenA.split('|')[1]} vs ${stillA.split('|')[1]}`);
  check('gameplay clock frozen', tFrozenA === (await q('window.G.time')));
  check('enemy count frozen', snapCore(frozenA) === snapCore(stillA), `${snapCore(frozenA)} vs ${snapCore(stillA)}`);
  check('ship position frozen', snapXyz(frozenA) === snapXyz(stillA));
  check('scheduled callbacks do not drain', timersFrozenA === (await q('window.__timerCount()')));
  check('hit-stop/slow-mo state not consumed while frozen', await q('window.G.hitStop === 0'));

  await tapKey('Escape');
  await step(2);
  check('resume clears the pause flag', await q('window.G.paused === false'));
  check('resume clears the pause owner', await q('window.__pauseReason() === window.__PAUSE_REASON.NONE'));
  check('pause screen hidden after resume', !(await showPauseScreen()) && (await pauseScreens()) === 0);
  const resumedA = await snap();
  // The frame that processes the resume advances the rail again, so allow the couple of frames of travel
  // between the snapshot and the toggle — what matters is that there is no jump/rewind to a checkpoint.
  check('resume continues from the frozen distance (no jump)',
    Number(resumedA.split('|')[1]) >= Number(frozenA.split('|')[1]) &&
    Number(resumedA.split('|')[1]) - Number(frozenA.split('|')[1]) < 10,
    `${frozenA.split('|')[1]} -> ${resumedA.split('|')[1]}`);
  const dResumed = Number(resumedA.split('|')[1]);
  await step(60);
  check('rail advances again after resume', Number((await snap()).split('|')[1]) > dResumed);

  // ============================================================ 2. Held input cannot stick across a freeze
  console.log('\n[2] A key held when the timeline freezes is dropped and not reasserted on resume');
  await q(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'KeyJ'}))`);
  await step(2);
  check('fire reads held before pausing', await q('window.Input.held("fire")'));
  await q('window.__manualPause()');
  check('held action cleared at the moment of pausing', await q('!window.Input.held("fire")'));
  await step(20);
  check('no held/pressed state survives frozen frames',
    await q('!window.Input.held("fire") && !window.Input.pressed("fire") && window.Input.x === 0 && window.Input.y === 0'));
  await q('window.__manualResume()');
  await step(2);
  check('held input is not reasserted after resume', await q('!window.Input.held("fire")'));
  await q(`window.dispatchEvent(new KeyboardEvent('keyup',{code:'KeyJ'}))`);

  // A direction key held when the freeze starts must not auto-repeat through the pause menu.
  await startPlay(3100);
  await q(`window.dispatchEvent(new KeyboardEvent('keydown',{code:'ArrowDown'}))`);
  await q('window.__manualPause()');
  const selBefore = await q('[...document.querySelectorAll("#pause .mi")].findIndex(e => e.classList.contains("sel"))');
  await step(90);   // 1.5 s of frozen frames
  const selAfter = await q('[...document.querySelectorAll("#pause .mi")].findIndex(e => e.classList.contains("sel"))');
  check('a key held across the pause does not navigate the pause menu', selBefore === selAfter, `${selBefore} -> ${selAfter}`);
  await q(`window.dispatchEvent(new KeyboardEvent('keyup',{code:'ArrowDown'}))`);
  check('direction held across the pause is cleared', await q('!window.Input.held("down")'));
  await q('window.__manualResume()');
  await step(2);

  // ============================================================ 3. Auto pause only in play, never over manual
  console.log('\n[3] Blur/visibility auto pause: play only, never overrides a manual pause, no stacked menus');
  await autoOn();
  await startPlay(3200);
  await q(`window.dispatchEvent(new Event('blur'))`);
  await step(2);
  check('window blur auto-pauses during play', await q('window.G.paused === true'));
  check('auto pause owner is AUTO', await q('window.__pauseReason() === window.__PAUSE_REASON.AUTO'));
  check('auto pause shows one pause screen', (await pauseScreens()) === 1);
  const dAuto = await q('window.G.rail.d');
  await step(60);
  check('timeline frozen under auto pause', (await q('window.G.rail.d')) === dAuto);
  await autoOff();
  check('refocus does not silently resume', await q('window.G.paused === true'));
  await q('window.__manualResume()');
  await step(2);
  check('manual resume clears auto pause', await q('window.G.paused === false'));

  // hidden tab uses the same path (the test-mode flag suppresses auto pause, so lift it here too)
  await autoOn();
  await q('Object.defineProperty(document,"hidden",{configurable:true,get:()=>true});document.dispatchEvent(new Event("visibilitychange"))');
  await step(2);
  check('hidden tab auto-pauses', await q('window.G.paused === true && window.__pauseReason() === window.__PAUSE_REASON.AUTO'));
  await q('Object.defineProperty(document,"hidden",{configurable:true,get:()=>false});document.dispatchEvent(new Event("visibilitychange"))');
  await autoOff();
  await q('window.__manualResume()');
  await step(2);

  // manual pause then hide / blur: the existing pause must survive untouched
  await q('window.__manualPause()');
  const menusManual = await pauseScreens();
  const ownerManual = await q('window.__pauseReason()');
  await q(`window.dispatchEvent(new Event('blur'))`);
  await q('Object.defineProperty(document,"hidden",{configurable:true,get:()=>true});document.dispatchEvent(new Event("visibilitychange"))');
  await q('Object.defineProperty(document,"hidden",{configurable:true,get:()=>false});document.dispatchEvent(new Event("visibilitychange"))');
  await step(2);
  check('manual pause survives blur + hide', await q('window.G.paused === true'));
  check('manual pause keeps its owner', (await q('window.__pauseReason()')) === ownerManual && ownerManual === (await q('window.__PAUSE_REASON.MANUAL')));
  check('no second pause menu stacked', (await pauseScreens()) === menusManual && menusManual === 1);
  await q('window.__manualResume()');
  await step(2);

  // auto pause must not fire on the title screen
  await autoOn();
  await q('window.MENU_CB.quit()');
  await step(2);
  check('quit returns to the title state', await q('window.G.state === "title"'));
  await q(`window.dispatchEvent(new Event('blur'))`);
  await step(2);
  check('no auto pause on the title screen', await q('window.G.paused === false'));
  await q(`window.dispatchEvent(new Event('blur'))`);   // idempotent: still nothing to pause
  await step(2);

  // auto pause must not fire during the opening intro cutscene
  await q('window.__startIntro(0)');
  await step(2);
  check('intro cutscene reports play with the intro active', await q('window.G.state === "play" && !window.__canAutoPause()'));
  await q(`window.dispatchEvent(new Event('blur'))`);
  await step(2);
  check('no auto pause while the intro cutscene owns the screen', await q('window.G.paused === false'));
  await autoOff();
  await step(5);

  // ============================================================ 4. Retry freezes, then fully reclaims the attempt
  console.log('\n[4] Retry freezes immediately and reclaims enemies, bullets, FX, timers, boss and the siren loop');
  await startPlay(9000);
  await q('window.__bot(320, { fire: true })');
  const combat = await q('({e:window.enemies.length,b:window.ebullets.length,fx:window.__fxCount(),t:window.__timerCount()})');
  check('combat produced live state before retry', combat.e > 0 && combat.b > 0, JSON.stringify(combat));
  await q('window.__manualPause()');
  const dPaused = await q('window.G.rail.d');
  const enemiesPaused = await q('window.enemies.length');
  await q('window.MENU_CB.retry()');
  check('retry freezes the attempt before the fade', await q('window.G.paused === true'));
  check('retry closes the pause menu', (await pauseScreens()) === 0);
  await step(1);
  check('nothing advances during the retry fade', (await q('window.G.rail.d')) === dPaused);
  check('the stale attempt is not torn down mid-fade', (await q('window.enemies.length')) === enemiesPaused);
  await pumpUntil('window.G.state === "play" && !window.G.paused', 1200, 'retry restart');
  await step(10);
  const afterRetry = await q('({e:window.enemies.length,b:window.ebullets.length,fx:window.__fxCount(),t:window.__timerCount(),boss:window.__bossActive(),warn:window.__warnLoop(),paused:window.G.paused,reason:window.__pauseReason()})');
  check('no enemies survive the retry', afterRetry.e === 0, JSON.stringify(afterRetry));
  check('no enemy bullets survive the retry', afterRetry.b === 0, JSON.stringify(afterRetry));
  check('particle FX cleared on retry', afterRetry.fx.add === 0 && afterRetry.fx.smoke === 0 && afterRetry.fx.debris === 0, JSON.stringify(afterRetry.fx));
  check('scheduled callbacks cleared on retry', afterRetry.t === 0);
  check('boss instance stopped on retry', afterRetry.boss === false);
  check('warning siren reclaimed on retry', afterRetry.warn === false);
  check('retry leaves the game unpaused with no owner', afterRetry.paused === false && afterRetry.reason === (await q('window.__PAUSE_REASON.NONE')));
  check('player is alive and controllable after retry', await q('window.ship.alive === true && window.ship.controllable === true'));

  // ============================================================ 5. Boss-approach retry reclaims boss + siren
  console.log('\n[5] Retrying at the boss approach reclaims the boss instance and re-arms the siren exactly once');
  await q('window.__jump(10600)');
  await q('window.__bot(700, { fire: false })');
  const bossBefore = await q('({boss:window.__bossActive(),warn:window.__warnLoop()})');
  check('boss approach armed the boss or the siren', bossBefore.boss || bossBefore.warn, JSON.stringify(bossBefore));
  await q('window.__manualPause()');
  await q('document.querySelector("#pause .mi[data-act=retry]").click()');
  await pumpUntil('window.G.state === "play" && !window.G.paused', 1200, 'boss retry restart');
  await step(2);
  const bossAfter = await q('({boss:window.__bossActive(),warn:window.__warnLoop(),e:window.enemies.length,b:window.ebullets.length})');
  check('boss stopped after the boss-area retry', bossAfter.boss === false, JSON.stringify(bossAfter));
  check('no stray enemies/bullets after the boss-area retry', bossAfter.e === 0 && bossAfter.b === 0, JSON.stringify(bossAfter));
  // The restart distance replays the siren event, so a FRESH siren must arm — the only one — and the boss-start
  // event must reclaim it again. That proves the loop's lifecycle is fully owned, not leaked.
  const reachedBoss = await pumpUntil('window.__bossActive()', 1500, 'boss restart');
  const sirenState = await q('({warn:window.__warnLoop(),boss:window.__bossActive()})');
  check('replayed siren is reclaimed when the boss starts', reachedBoss && sirenState.warn === false && sirenState.boss === true, JSON.stringify(sirenState));

  // ============================================================ 6. Pausing the boss's death throes freezes them
  console.log('\n[6] Pausing while the boss is dying freezes the death sequence (no hidden real-time progress)');
  await q('window.__jump(10600)');
  await pumpUntil('window.__bossActive()', 900, 'boss active');
  // Call the boss's own death entry point instead of whittling its HP down (the headless software renderer
  // makes thousands of bot frames too slow; die() is the same path a real kill takes).
  await q('window.BOSS.inst.die()');
  await step(2);
  check('the boss is in its dying phase', await q('window.BOSS.inst.phase === "dying"'));
  await q('window.__manualPause()');
  const deathA = await q('({deadT:window.BOSS.inst.deadT, idx:window.BOSS.inst.deathIdx, hp:window.BOSS.inst.hp, state:window.G.state})');
  await step(180);
  const deathB = await q('({deadT:window.BOSS.inst.deadT, idx:window.BOSS.inst.deathIdx, hp:window.BOSS.inst.hp, state:window.G.state})');
  check('boss death timer frozen while paused', deathA.deadT === deathB.deadT, `${deathA.deadT} vs ${deathB.deadT}`);
  check('boss death step index frozen while paused', deathA.idx === deathB.idx, `${deathA.idx} vs ${deathB.idx}`);
  check('game state unchanged while paused', deathA.state === deathB.state && deathB.state === 'play');
  await q('window.__manualResume()');
  // and it does finish once unfrozen, proving the freeze did not wedge it
  await pumpUntil('window.G.state === "clear"', 900, 'boss defeat after resume');

  // ============================================================ 7. Death respawn reuses the same teardown
  console.log('\n[7] Death → auto-respawn reuses the shared teardown (no residue from the crashed attempt)');
  await startPlay(4000);
  await q('window.__bot(180, { fire: true })');
  // Respawn from the very start so the level script cannot legitimately re-arm the boss-area siren: any
  // boss/siren state seen afterwards can only be residue from the crashed attempt.
  await q('window.G.run.checkpoint = 0');
  const livesBefore = await q('window.G.run.lives');
  await q('window.G.run.shield = 1; window.G.player.invuln = 0; window.G.player.damage(9999)');
  await pumpUntil('window.G.state === "dead"', 240, 'death state');
  check('blur during the death throes auto-pauses the dying attempt', await (async () => {
    await autoOn();
    await q(`window.dispatchEvent(new Event('blur'))`);
    await step(2);
    const paused = await q('window.G.paused === true && window.__pauseReason() === window.__PAUSE_REASON.AUTO');
    await autoOff();
    await q('window.__manualResume()');
    return paused;
  })());
  const respawned = await pumpUntil('window.G.state === "play" && window.G.run.deaths === 1 && !window.G.paused', 1500, 'respawn');
  await step(30);
  const afterRespawn = await q('({e:window.enemies.length,b:window.ebullets.length,fx:window.__fxCount(),boss:window.__bossActive(),warn:window.__warnLoop(),lives:window.G.run.lives,alive:window.ship.alive,paused:window.G.paused})');
  check('respawn is reached', respawned);
  check('a life was consumed by the death', afterRespawn.lives === livesBefore - 1, `${livesBefore} -> ${afterRespawn.lives}`);
  check('respawn clears enemies', afterRespawn.e === 0, JSON.stringify(afterRespawn));
  check('respawn clears enemy bullets', afterRespawn.b === 0, JSON.stringify(afterRespawn));
  check('respawn stops boss and siren', afterRespawn.boss === false && afterRespawn.warn === false);
  check('respawn leaves the player alive and unpaused', afterRespawn.alive === true && afterRespawn.paused === false);

  // ============================================================ 8. Frozen bot run makes no progress
  console.log('\n[8] A bot run makes zero progress while the timeline is frozen');
  await startPlay(3500);
  await step(30);
  const dBefore = await q('window.G.rail.d');
  await q('window.__manualPause()');
  const frozenBotA = await snap();
  await q('window.__bot(240, { fire: false })');   // steering only: fire is also the menu's confirm key
  const frozenBotB = await snap();
  check('bot frames do not move the rail while paused', eps(dBefore, await q('window.G.rail.d')));
  check('game stays paused through the frozen bot run', await q('window.G.paused === true'));
  check('gameplay snapshot unchanged across the frozen bot run', snapCore(frozenBotA) === snapCore(frozenBotB), `${snapCore(frozenBotA)} vs ${snapCore(frozenBotB)}`);
  await q('window.__manualResume()');

  // ============================================================ 9. Esc toggles one menu, never stacks
  console.log('\n[9] Repeated Escape presses toggle a single pause layer and never stack a second menu');
  await startPlay(3600);
  for (let i = 0; i < 4; i++) {
    await tapKey('Escape');
    await step(3);
    const want = i % 2 === 0;
    check(`Escape toggle #${i + 1} leaves the pause screen ${want ? 'on' : 'off'}`, (await showPauseScreen()) === want);
    check(`Escape toggle #${i + 1} keeps at most one pause layer`, (await pauseScreens()) <= 1);
  }
  check('ending after an even number of toggles leaves the game running', await q('window.G.paused === false'));

  // ============================================================ 10. Console hygiene
  console.log('\n[10] No uncaught page errors during the whole session');
  check('zero console errors/exceptions', pageErrors.length === 0, pageErrors.join(' | '));

  await browser.close();
  if (server) server.close();
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) { for (const f of failures) console.log('  - ' + f); process.exit(1); }
}

main().catch(async (e) => {
  console.error(e);
  try { await browser.close(); } catch { /* ignore */ }
  try { server?.close(); } catch { /* ignore */ }
  process.exit(1);
});
