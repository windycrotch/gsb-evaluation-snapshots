// Pause / blur / death / respawn regression suite (dev builds only).
//
// Loaded by index.html when the URL contains `?pausetest` (main.js calls runPauseTests() at boot).
// Every case is deterministic: frames advance only through window.__step / window.__bot (the rAF
// loop is bypassed via ?manual), Math.random is seeded, and focus loss is reproduced with the same
// DOM events the real browser fires (window 'blur' and document 'visibilitychange').
//
// The runner embeds a machine-readable report in <pre id="pausetest" data-json=...> and also logs
// `PAUSETEST_JSON <json>` to the console; tools/run-pause-tests.mjs drives headless Chrome over it.

const DT = 1 / 60;
const results = [];

function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail: String(detail) });
  const tag = cond ? 'PASS' : 'FAIL';
  console.log(`[${tag}] ${name}${detail ? ' — ' + detail : ''}`);
}
const approx = (a, b, eps = 1e-6) => Math.abs(a - b) <= eps;
const sleepFrame = (n = 1) => window.__step(n, DT);

// Drive the player's ship through the death animation until G.state becomes 'dead'.
// die() starts a 2.2s dying animation; the final explosion emits playerDead at ~133 frames.
function dieNow() {
  window.__kill();
  let guard = 0;
  while (G.state !== 'dead' && guard++ < 300) sleepFrame();
  return guard;
}

function setupPlay(seed = 11) {
  window.__seed(seed);
  window.__jump(0);                 // straight into a playable stage (no intro cinematic)
  if (G.paused) window.__resume();
  sleepFrame(2);
}

function run() {
  // ?manual keeps the rAF loop out of the way; this flag lets synthetic blur/hide events still
  // drive the same autoPause() path a real focus loss takes.
  window.__allowAutoPause = true;
  // The assertions cover game state, not pixels — skip the GPU draw so thousands of synchronous
  // frames finish quickly even on a software renderer.
  window.__noRender = true;

  // ---------------------------------------------------------------- 1. manual pause keeps the timeline frozen and resumes continuously
  {
    setupPlay();
    const t0 = G.time, d0 = G.rail.d, shield0 = G.run.shield;
    window.__pause();
    check('manual pause: enters paused state', G.paused && window.__pauseSource() === 'user',
      `paused=${G.paused} src=${window.__pauseSource()}`);
    sleepFrame(120);                 // two real seconds of frames while paused
    check('manual pause: G.time frozen', approx(G.time, t0), `Δtime=${G.time - t0}`);
    check('manual pause: rail d frozen', approx(G.rail.d, d0), `Δd=${G.rail.d - d0}`);
    check('manual pause: shield frozen', approx(G.run.shield, shield0), `Δshield=${G.run.shield - shield0}`);
    window.__resume();
    check('manual pause: resume clears state', !G.paused && window.__pauseSource() === null);
    sleepFrame(60);
    check('manual pause: time advances again after resume', G.time > t0, `time ${t0} → ${G.time}`);
    check('manual pause: rail advances again after resume', G.rail.d > d0, `d ${d0} → ${G.rail.d}`);
    // continuity: exactly the frames stepped before and after are accounted for, no jump
    check('manual pause: timeline continuous (60 frames ≈ 1s)', approx(G.time - t0, 60 * DT, 1e-9),
      `Δtime=${G.time - t0}`);
  }

  // ---------------------------------------------------------------- 2. two focus losses in a row settle only ONE system pause, and focus clears it
  {
    setupPlay();
    window.__blur();
    check('blur: system pause', G.paused && window.__pauseSource() === 'system');
    window.__blur();                 // second blur while already paused
    window.__hide();                 // and a tab-hide on top of it
    check('double blur + hide: still exactly one system pause', G.paused && window.__pauseSource() === 'system',
      `src=${window.__pauseSource()}`);
    const t0 = G.time;
    sleepFrame(60);
    check('double blur: game time frozen', approx(G.time, t0));
    window.__show();
    window.__focus();
    check('focus: system pause cleared', !G.paused && window.__pauseSource() === null);
    sleepFrame(10);
    check('focus: time advances again', G.time > t0);
  }

  // ---------------------------------------------------------------- 3. a manual pause is not undone by focus events
  {
    setupPlay();
    window.__pause();
    window.__blur();
    window.__hide();
    check('manual pause survives blur/hide', G.paused && window.__pauseSource() === 'user');
    window.__show();
    window.__focus();
    check('manual pause NOT auto-resumed by focus', G.paused && window.__pauseSource() === 'user');
    window.__resume();
    check('manual pause: player can still resume', !G.paused);
  }

  // ---------------------------------------------------------------- 4. death + blur: death timer freezes and resumes from where it stopped
  {
    setupPlay(23);
    const lives0 = G.run.lives;
    dieNow();
    check('death: state is dead', G.state === 'dead');
    const base = window.__deadT();          // the frame that emitted playerDead already counted one step
    sleepFrame(30);                         // 0.5s more of the 2.0s death countdown
    const tBefore = window.__deadT();
    check('death: timer accumulates while focused', approx(tBefore - base, 30 * DT, 1e-9),
      `deadT ${base} → ${tBefore}`);
    window.__blur();
    check('death: blur pauses during death anim', G.paused && window.__pauseSource() === 'system');
    sleepFrame(300);                        // five seconds paused — timer must not move
    check('death: deadT frozen while blurred', approx(window.__deadT(), tBefore, 1e-9),
      `deadT ${tBefore} → ${window.__deadT()}`);
    check('death: no life lost while blurred', G.run.lives === lives0, `lives=${G.run.lives}`);
    window.__focus();
    check('death: blur cleared on focus', !G.paused);
    // remaining countdown measured from the frozen value; the life loss must happen at that many
    // frames, never immediately (jump) and never from zero (restart).
    const framesLeft = Math.ceil((2.0 - tBefore) / DT);
    let frame = 0, lossAt = -1, respawnAt = -1;
    while (frame++ < 240) {
      sleepFrame();
      if (lossAt < 0 && G.run.lives < lives0) lossAt = frame;
      if (G.state === 'play') { respawnAt = frame; break; }
    }
    check('death: life lost exactly once after resume', G.run.lives === lives0 - 1, `lives ${lives0} → ${G.run.lives}`);
    // the life loss itself lands after the frozen remainder; the fade that follows is a fixed
    // transition and is not part of the death countdown
    check('death: countdown continued (not restarted/jumped)',
      lossAt > 0 && Math.abs(lossAt - framesLeft) <= 2,
      `life lost ${lossAt} frames after focus, expected ~${framesLeft}`);
    check('death: respawn transition completed', respawnAt > 0, `respawnAt=${respawnAt}`);
    check('death: deaths counter incremented once', G.run.deaths === 1, `deaths=${G.run.deaths}`);
  }

  // ---------------------------------------------------------------- 5. retry from the pause menu during the death anim never double-charges a life
  {
    setupPlay(37);
    const lives0 = G.run.lives;
    dieNow();
    sleepFrame(40);                  // still inside the 2.0s window
    window.__pause();
    const deathsBefore = G.run.deaths;
    // activate the highlighted pause-menu item (RETRY is item index 1)
    const pauseMenu = document.querySelector('#pause .menu');
    const items = [...pauseMenu.querySelectorAll('.mi')];
    const retryBtn = items.find(b => b.dataset.act === 'retry');
    check('retry: pause menu offers RETRY', !!retryBtn);
    retryBtn.click();
    // the fade-to-black transition runs on real time; step enough frames for setupStage() to land
    let guard = 0;
    while (G.state !== 'play' && guard++ < 200) sleepFrame();
    check('retry: back in play', G.state === 'play', `state=${G.state}`);
    check('retry: exactly ONE life lost total', G.run.lives === lives0 - 1,
      `lives ${lives0} → ${G.run.lives}`);
    check('retry: deaths counted once', G.run.deaths === deathsBefore + 1, `deaths=${G.run.deaths}`);
    check('retry: pause released', !G.paused && window.__pauseSource() === null);
    // the pending death callback must never fire afterwards — one short second is enough to prove
    // it (stepping much longer would just start an unrelated second death in the new attempt).
    // deaths is cumulative across the whole page run; this case must add exactly one.
    const deathsAfterRetry = G.run.deaths;
    sleepFrame(60);
    check('retry: no second life loss within a second', G.run.lives === lives0 - 1,
      `lives=${G.run.lives}`);
    check('retry: no additional death recorded', G.run.deaths === deathsAfterRetry,
      `deaths stayed at ${G.run.deaths}`);
  }

  // ---------------------------------------------------------------- 6. stale after() timers from the old attempt never replay after respawn
  {
    setupPlay(41);
    const marker = { fired: 0 };
    // Both due well AFTER the death animation + respawn transition (~3.5s) has completed, so any
    // fire after the respawn proves an old-attempt timer leaked; neither can fire beforehand.
    window.__after(6, () => { marker.fired++; });
    window.__after(9, () => { marker.fired++; });
    const ownTimers = window.__timers();
    check('timers: scheduled', ownTimers >= 2, `count=${ownTimers}`);
    dieNow();
    sleepFrame(150);                 // run through the auto life-loss + respawn transition
    let guard = 0;
    while (G.state !== 'play' && guard++ < 100) sleepFrame();
    // setupStage schedules a fresh respawn radio of its own; the point is that none of OUR old
    // callbacks survived into the new attempt.
    check('timers: old batch cleared on respawn', window.__timers() <= 1, `count=${window.__timers()}`);
    sleepFrame(420);                 // well past both original fire times
    check('timers: old callbacks never replayed', marker.fired === 0, `fired=${marker.fired}`);
    // new-attempt timers work normally
    window.__after(0.2, () => { marker.fired++; });
    sleepFrame(30);
    check('timers: new-attempt timer fires', marker.fired === 1, `fired=${marker.fired}`);
  }

  // ---------------------------------------------------------------- 7. __snap is perfectly stable across paused frames (d and shield unchanged)
  {
    setupPlay(53);
    sleepFrame(60);
    const snap0 = window.__snap();
    window.__blur();
    for (let i = 0; i < 5; i++) {
      sleepFrame(30);
      check(`snap: identical after ${(i + 1) * 30} paused frames`, window.__snap() === snap0,
        window.__snap());
    }
    window.__focus();
    const parts0 = snap0.split('|');
    const parts1 = window.__snap().split('|');
    check('snap: d unchanged on the very first frame after focus', parts0[1] === parts1[1],
      `d ${parts0[1]} → ${parts1[1]}`);
    sleepFrame(30);
    const parts2 = window.__snap().split('|');
    check('snap: d moves again once resumed', Number(parts2[1]) > Number(parts1[1]),
      `d ${parts1[1]} → ${parts2[1]}`);
    check('snap: shield field unchanged across the whole pause', parts0[4] === parts1[4],
      `shield ${parts0[4]} → ${parts1[4]}`);
  }

  // ---------------------------------------------------------------- 8. seeded __bot run stays deterministic with a pause in the middle
  {
    setupPlay(67);
    window.__bot(120, { fire: true });
    const mid = window.__snap();
    window.__pause();
    sleepFrame(120);
    check('bot: snap frozen mid-run while paused', window.__snap() === mid);
    window.__resume();
    window.__bot(120, { fire: true });
    const runA = window.__snap();
    // second independent seeded run, same inputs, no pause — endpoint must match
    setupPlay(67);
    window.__bot(240, { fire: true });
    const runB = window.__snap();
    check('bot: paused run matches uninterrupted seeded run', runA === runB,
      `\n  paused: ${runA}\n  straight: ${runB}`);
  }

  // ---------------------------------------------------------------- 9. Esc while a system pause owns the screen claims it for the player
  {
    setupPlay(71);
    window.__blur();
    check('esc claim: starts as system pause', window.__pauseSource() === 'system');
    // Esc toggles the pause off; dispatch it through the real keyboard path and step one frame so
    // updatePlay() consumes the edge.
    window.__key('Escape', true);
    sleepFrame(1);
    check('esc claim: Esc dismisses the system pause', !G.paused && window.__pauseSource() === null);
    // now the reverse: blur, then dismiss via the RESUME menu item — ownership must clear cleanly
    window.__blur();
    check('esc claim: re-blurred into system pause', window.__pauseSource() === 'system');
    document.querySelector('#pause .mi[data-act="resume"]').click();
    check('esc claim: RESUME menu clears system pause', !G.paused && window.__pauseSource() === null);
  }
}

// main.js calls this right after registering its dev helpers (the title state is already settled).
// The whole suite runs synchronously so `chrome --dump-dom` captures the finished report in one go.
export function runPauseTests() {
  if (!new URLSearchParams(location.search).has('pausetest')) return;
  try {
    run();
    const passed = results.filter(r => r.pass).length;
    const summary = { passed, total: results.length, results };
    const pre = document.createElement('pre');
    pre.id = 'pausetest';
    pre.dataset.json = JSON.stringify(summary);   // dump-dom HTML-encodes the attribute for us
    pre.style.cssText = 'position:fixed;inset:0;z-index:99999;background:#04080f;color:#9fe;margin:0;padding:12px;font:12px/1.5 monospace;white-space:pre-wrap;overflow:auto';
    pre.textContent = results.map(r => `${r.pass ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '\n        ' + r.detail : ''}`).join('\n')
      + `\n\n${passed}/${results.length} passed`;
    document.body.appendChild(pre);
    console.log(`PAUSETEST_JSON ${JSON.stringify(summary)}`);
    window.__pausetest = summary;
    document.title = `PAUSETEST ${passed}/${results.length}`;
  } catch (e) {
    console.error('PAUSETEST ERROR', e);
    const pre = document.createElement('pre');
    pre.id = 'pausetest';
    pre.dataset.crash = String(e?.stack || e);
    pre.textContent = 'PAUSETEST CRASH\n' + (e?.stack || e);
    document.body.appendChild(pre);
    document.title = 'PAUSETEST CRASH';
  }
}
