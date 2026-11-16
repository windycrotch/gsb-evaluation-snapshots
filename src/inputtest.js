// Dev-build regression checks for the input layer (pause / focus loss / resume boundaries,
// double-tap and menu auto-repeat semantics).
//
// Run from the browser console in a dev build:  __inputTest()
// It drives the real main loop through frame() and dispatches real KeyboardEvent / blur events,
// so it exercises the same code paths as play. The result is a list of named checks.
//
// main.js passes in a small api object (see the __inputTest wiring in boot()).

const key = (type, code) => window.dispatchEvent(new KeyboardEvent(type, { code }));
const down = (code) => key('keydown', code);
const up = (code) => key('keyup', code);
const blur = () => window.dispatchEvent(new Event('blur'));

export function runInputTests(api) {
  const results = [];
  const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); };
  const inp = () => api.input();
  const near = (a, b, eps) => Math.abs(a - b) <= eps;
  const step = (n = 1) => api.step(n, 1 / 60);

  const prevManual = window.__manual;
  const prevPad = window.__testPad;
  window.__manual = true;                 // hand every frame to step() while the checks run
  try {
    const pad = {
      connected: true,
      axes: [0, 0],
      buttons: Array.from({ length: 17 }, () => ({ pressed: false, value: 0 })),
    };

    // ---------------------------------------------------------------- 1. focus loss mid-hold
    api.setup();
    const u0 = api.ship().u, shots0 = api.shots();
    down('KeyD'); down('KeyJ');
    step(10);
    check('hold: steering and firing register before the break', api.ship().u > u0 + 0.5 && api.shots() > shots0,
      `u ${u0.toFixed(2)}→${api.ship().u.toFixed(2)}, shots ${shots0}→${api.shots()}`);

    blur();                                  // real window blur: the input layer resets every source
    check('blur: all physical input is released', inp().held.length === 0, JSON.stringify(inp().held));
    check('blur: axes read as neutral', inp().x === 0 && inp().y === 0, `x=${inp().x} y=${inp().y}`);

    const uBlur = api.ship().u, shotsBlur = api.shots();
    api.focusLost();                         // the game's own focus-loss handler (forced for the test)
    step(60);
    check('blur: game pauses', api.state().paused && api.state().state === 'play', JSON.stringify(api.state()));
    check('blur: ship does not drift while paused', near(api.ship().u, uBlur, 0.001),
      `u ${uBlur.toFixed(3)}→${api.ship().u.toFixed(3)}`);
    check('blur: no shot is fired after the break', api.shots() === shotsBlur, `shots ${shotsBlur}→${api.shots()}`);

    up('KeyD'); up('KeyJ');                  // release the keys that never saw a keyup
    down('Escape'); step(1); up('Escape');   // resume through the pause key
    check('blur: pause key resumes', !api.state().paused, JSON.stringify(api.state()));
    const shotsResume = api.shots();
    step(60);
    check('resume: no stray shot from pre-break input', api.shots() === shotsResume, `shots ${shotsResume}→${api.shots()}`);
    check('resume: no phantom hold survives', inp().held.length === 0, JSON.stringify(inp().held));

    down('KeyJ'); step(3); up('KeyJ');       // a real new press must still work
    check('resume: fresh fire press works again', api.shots() > shotsResume, `shots ${shotsResume}→${api.shots()}`);

    // ---------------------------------------------------------------- 2. pause via Escape / back
    api.setup();
    step(2);
    down('KeyK');                            // bomb and back, held through the pause
    step(1);
    down('Escape'); step(1);
    check('pause: Escape pauses exactly once', api.state().paused && api.state().pauseCount === 1,
      JSON.stringify(api.state()));
    up('Escape');
    const shotsPaused = api.shots(), uPaused = api.ship().u;
    step(90);
    check('pause: simulation is frozen', api.ship().u === uPaused && api.shots() === shotsPaused,
      `u ${uPaused.toFixed(3)}→${api.ship().u.toFixed(3)}, shots ${shotsPaused}→${api.shots()}`);
    check('pause: held keys are dropped', inp().held.length === 0, JSON.stringify(inp().held));
    down('Escape'); step(1); up('Escape');
    step(60);
    check('pause: one key cannot pause and resume in one frame',
      !api.state().paused && api.state().pauseCount === 1 && api.state().resumeCount === 1, JSON.stringify(api.state()));
    check('pause: no bomb/shot leaks into the first frames', api.shots() === shotsPaused, `shots ${shotsPaused}→${api.shots()}`);
    up('KeyK');

    down('Escape'); step(1); up('Escape');
    check('pause: re-pauses for the back-key check', api.state().paused && api.state().pauseCount === 2, JSON.stringify(api.state()));
    down('KeyX'); step(1); up('KeyX');
    check('pause: back key resumes outside sub-menus', !api.state().paused && api.state().resumeCount === 2, JSON.stringify(api.state()));

    // ---------------------------------------------------------------- 3. double tap semantics
    api.setup();
    step(2);
    down('KeyQ'); step(1); const q1 = inp(); up('KeyQ');
    check('double: first press is not a double', !q1.actions.rollL.double, JSON.stringify(q1.actions.rollL));
    step(4);
    down('KeyQ'); step(1); const q2 = inp(); up('KeyQ');
    check('double: second press within 0.3 s is a double', q2.actions.rollL.double, JSON.stringify(q2.actions.rollL));
    step(4);
    down('KeyQ'); step(1); const q3 = inp(); up('KeyQ');
    check('double: a third press restarts the timer (not a second double)', !q3.actions.rollL.double,
      JSON.stringify(q3.actions.rollL));
    step(4);
    down('KeyQ'); step(1); const q4 = inp(); up('KeyQ');
    check('double: the follow-up press pairs with the third', q4.actions.rollL.double, JSON.stringify(q4.actions.rollL));
    step(30);                                // > 0.3 s
    down('KeyQ'); step(1); const q5 = inp(); up('KeyQ');
    check('double: a late press does not form a double', !q5.actions.rollL.double, JSON.stringify(q5.actions.rollL));

    // A pending single tap must not pair across a pause.
    down('KeyQ'); step(1); up('KeyQ');
    down('Escape'); step(1); up('Escape');   // pause
    down('Escape'); step(1); up('Escape');   // resume
    step(1);
    down('KeyQ'); step(1); const qp = inp(); up('KeyQ');
    check('double: pause clears the double-tap timer', !qp.actions.rollL.double, JSON.stringify(qp.actions.rollL));

    // ---------------------------------------------------------------- 4. menu auto-repeat
    api.setup();
    down('Escape'); step(1); up('Escape');
    const menu0 = api.menu();
    check('menu: pause menu is focused', api.state().paused && !!menu0, JSON.stringify(menu0));
    const count = menu0.count;
    down('ArrowDown'); step(1);
    const m1 = api.menu();
    check('menu: first press moves immediately', m1.i === (menu0.i + 1) % count, `${menu0.i}→${m1.i}`);
    let prev = m1.i, early = 0;
    for (let k = 0; k < 12; k++) { step(1); const m = api.menu(); if (m.i !== prev) { early++; prev = m.i; } }
    check('menu: no repeat during the initial delay', early === 0, `${early} move(s) in ~0.2 s`);
    prev = api.menu().i; let repeats = 0;
    for (let k = 0; k < 60; k++) { step(1); const m = api.menu(); if (m.i !== prev) { repeats++; prev = m.i; } }
    check('menu: holding repeats at a steady rate', repeats >= 3, `${repeats} move(s) in ~1 s`);
    up('ArrowDown');
    const afterRelease = api.menu().i;
    step(30);
    check('menu: release stops the repeat', api.menu().i === afterRelease, `${afterRelease}→${api.menu().i}`);
    down('Escape'); step(1); up('Escape');
    check('menu: Escape closes the pause menu', !api.state().paused, JSON.stringify(api.state()));

    // ---------------------------------------------------------------- 5. gamepad
    api.setup();
    window.__testPad = pad;
    step(2);
    pad.axes = [0.9, -0.7];
    step(3);
    check('pad: analog stick steers', inp().x > 0.5, `x=${inp().x}`);
    const padShots0 = api.shots();
    pad.buttons[0].pressed = true; pad.buttons[0].value = 1;
    step(3);
    check('pad: button press fires', api.shots() > padShots0, `shots ${padShots0}→${api.shots()}`);
    const padShots1 = api.shots();
    api.focusLost();
    step(1);
    check('pad: focus loss drops held buttons and stick', !inp().actions.fire.held && inp().x === 0,
      JSON.stringify({ fire: inp().actions.fire.held, x: inp().x }));
    down('Escape'); step(1); up('Escape');   // resume while the button and stick are still held
    step(30);
    check('pad: deflected stick cannot drift the resumed ship', inp().x === 0 && inp().axisStale,
      `x=${inp().x} stale=${inp().axisStale}`);
    check('pad: held button does not fire on resume', api.shots() === padShots1, `shots ${padShots1}→${api.shots()}`);
    pad.axes = [0, 0];
    pad.buttons[0].pressed = false; pad.buttons[0].value = 0;
    step(2);
    check('pad: stick re-arms after returning to centre', !inp().axisStale && inp().x === 0, `stale=${inp().axisStale}`);
    pad.buttons[0].pressed = true; pad.buttons[0].value = 1;
    step(3);
    check('pad: a fresh press works after release', api.shots() > padShots1, `shots ${padShots1}→${api.shots()}`);
    pad.buttons[0].pressed = false; pad.buttons[0].value = 0;
    step(1);
    delete window.__testPad;

    // ---------------------------------------------------------------- 6. touch
    api.setup();
    step(2);
    api.Input.setTouchStick(0, 0);           // a fresh gesture re-arms the (reset) stick
    api.Input.touchButton('TouchFire', true);
    api.Input.setTouchStick(0.8, 0.2);
    step(3);
    check('touch: button fires and stick steers', inp().x > 0.3 && api.shots() > 0,
      `x=${inp().x}, shots=${api.shots()}`);
    blur();
    step(2);
    check('touch: blur zeroes the stick and drops buttons',
      inp().x === 0 && inp().touch.x === 0 && inp().held.length === 0,
      JSON.stringify({ x: inp().x, touch: inp().touch, held: inp().held }));
    const touchShots1 = api.shots();
    api.Input.setTouchStick(0.8, 0.2);       // the same still-down drag keeps reporting its position
    step(5);
    check('touch: a still-down stick stays inert until it re-centres',
      inp().x === 0 && inp().touch.x === 0, JSON.stringify(inp().touch));
    api.Input.setTouchStick(0, 0);
    step(1);
    api.Input.setTouchStick(0.8, 0.2);
    step(2);
    check('touch: a new gesture steers again', inp().x > 0.3, `x=${inp().x}`);
    api.Input.touchButton('TouchFire', true);
    step(3);
    check('touch: a fresh button press fires again', api.shots() > touchShots1, `shots ${touchShots1}→${api.shots()}`);
    api.Input.touchButton('TouchFire', false);
    api.Input.setTouchStick(0, 0);
    step(1);

    // ---------------------------------------------------------------- 7. no residue at rest
    api.setup();
    step(5);
    const rest = inp();
    const anyHeld = Object.values(rest.actions).some(a => a.held || a.pressed || a.released || a.double);
    check('rest: every action is idle when nothing is pressed', !anyHeld, JSON.stringify(rest.actions));
  } catch (e) {
    results.push({ name: 'input test crashed', ok: false, detail: String((e && e.stack) || e) });
  } finally {
    window.__manual = prevManual;
    if (prevPad === undefined) delete window.__testPad; else window.__testPad = prevPad;
    try { api.setup(); } catch (e) { /* leave a clean, un-paused game behind */ }
  }

  const failed = results.filter(r => !r.ok);
  for (const r of results) {
    console.log(`[input-test] ${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.detail ? '   (' + r.detail + ')' : ''}`);
  }
  console.log(`[input-test] ${results.length - failed.length}/${results.length} checks passed`);
  return { pass: failed.length === 0, results, failed };
}
