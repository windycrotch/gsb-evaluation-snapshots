// The brewing chain on the real game, on the real GPU, without hands: normal hit and bottle, no
// progress outside the band, a failed pour with no region, and the pot reset by emptying. It reads
// only state and produce (game.brew, game.state.inv), never a screenshot.
//
//   node tools/play.mjs tools/scenarios/brew-chain.mjs --q low
//
// Exits non-zero if any expectation fails (see BREW CHAIN below in the page log).
export default async function ({ ev, step, log, page }) {
  await step(20);
  await page.waitForTimeout(2500);
  await ev(() => TP.play());
  await step(10);

  // a clean pot with the herbs a brew needs, and the chart already inked
  const setup = await ev(() => {
    const g = TP.game;
    g.state.inv.ingredients = { cinderbloom: 5, saltwort: 2, mirrorlily: 2, halite: 3, corpselight: 2 };
    g.state.known.charted = { ember: true };
    const c = g.world.named.cauldron;
    g.player.teleport(c.x, c.y + 0.1, c.z + 2.2, 0, -0.3);
    return { at: [c.x, c.y, c.z] };
  });
  await step(30);
  await page.waitForTimeout(500);
  await ev(() => TP.game.input.press('KeyE'));
  await step(2);
  await ev(() => TP.game.input.release('KeyE'));
  await step(40);
  await page.waitForTimeout(700);
  const mode = await ev(() => TP.game.state.mode);
  log('SETUP', JSON.stringify({ mode, at: setup.at }));

  const R = [];
  const check = (label, cond, detail) => {
    R.push({ label, ok: !!cond, detail: detail || '' });
    log((cond ? 'ok   ' : 'FAIL ') + label + (detail && !cond ? '   (' + detail + ')' : ''));
  };
  const state = () =>
    ev(() => {
      const b = TP.game.brew,
        st = TP.game.state;
      return {
        contents: b.contents.slice(),
        mix: b.mix ? b.mix.slice() : null,
        region: b.region ? b.region.id : null,
        band: b.band ? b.band.slice() : null,
        heat: +b.heat.toFixed(3),
        fire: +b.fire.toFixed(3),
        fit: b.fit,
        stir: +b.stir.toFixed(3),
        progress: +b.progress.toFixed(3),
        ready: b.ready ? { ...b.ready } : null,
        hint: b.hint,
        potions: { ...st.inv.potions },
        brewed: st.stats.brewed,
        ingredients: { ...st.inv.ingredients },
      };
    });
  const add = (id) => ev((x) => TP.game.actions.brewAdd(x), id);

  check('the cauldron is before the apprentice', mode === 'brew', 'mode=' + mode);
  if (mode !== 'brew') {
    log('BREW CHAIN\n' + JSON.stringify({ failed: R.filter((r) => !r.ok) }));
    return;
  }

  // ------------------------------------------------------------------------------ 1. hit and bottle
  const empty = await state();
  check('the pot starts empty', empty.contents.length === 0 && empty.mix === null);
  await add('cinderbloom');
  await add('cinderbloom');
  await add('cinderbloom');
  let s = await state();
  check('three Cinderblooms make Ember', s.region === 'ember', JSON.stringify(s.region));
  check('the band is Ember’s', s.band && s.band[0] === 0.7 && s.band[1] === 1.0, JSON.stringify(s.band));
  check('nothing binds while the hand is off the ladle', s.progress === 0, String(s.progress));

  // work the bellows until the pot is inside the band, then stir
  let guard = 0;
  while (guard++ < 400) {
    s = await state();
    if (s.ready) break;
    await ev(([lo, hi]) => {
      const b = TP.game.brew;
      TP.game.actions.brewPump(b.heat < (lo + hi) / 2);
      TP.game.actions.brewDamp(b.heat > hi);
      TP.game.brewing.autoStir = 0.9;
    }, [s.band[0], s.band[1]]);
    await step(6);
  }
  await ev(() => {
    TP.game.actions.brewPump(false);
    TP.game.actions.brewDamp(false);
  });
  s = await state();
  check('the pot binds inside its band', !!s.ready, JSON.stringify({ heat: s.heat, fit: s.fit, progress: s.progress }));
  check('what is bound is Ember', s.ready && s.ready.potion === 'ember', JSON.stringify(s.ready));
  const before = s.potions.ember || 0;
  const brewedBefore = s.brewed;
  await ev(() => TP.game.actions.brewBottle());
  await step(20);
  s = await state();
  check('the pour gives Ember', (s.potions.ember || 0) > before, JSON.stringify(s.potions));
  check('the brewed count rises by as many phials as were poured', s.brewed > brewedBefore);
  check('the pot is empty after the pour', s.contents.length === 0 && s.mix === null);
  check('the fire is out after the pour', s.heat === 0 && s.fire === 0, JSON.stringify({ heat: s.heat, fire: s.fire }));

  // ------------------------------------------------------------------------------ 2. outside the band
  await ev(() => {
    TP.game.actions.brewPump(false);
    TP.game.actions.brewDamp(false);
  });
  await add('halite');
  await add('halite');
  s = await state();
  check('two Halites make Saltspire', s.region === 'saltspire', JSON.stringify(s.region));
  // hold the fire far under the band and stir hard
  const coldStart = s.progress;
  await ev(() => {
    TP.game.brewing.autoStir = 1;
    TP.game.actions.brewPump(false);
    TP.game.actions.brewDamp(true);
  });
  await step(90);
  s = await state();
  check('stirring below the band adds nothing', s.progress === coldStart && s.progress === 0, JSON.stringify({ progress: s.progress, heat: s.heat, band: s.band, fit: s.fit }));
  check('and the readout still says it is outside', s.fit === -1, 'fit=' + s.fit);

  // bind a little in-band, then leave the band and watch it decay
  await ev(() => {
    TP.game.actions.brewDamp(false);
    TP.game.actions.brewPump(true);
    TP.game.brewing.autoStir = 0.9;
  });
  let peak = 0;
  for (let i = 0; i < 200; i++) {
    await step(4);
    const t = await state();
    peak = Math.max(peak, t.progress);
    if (t.heat > t.band[1]) {
      await ev(() => TP.game.actions.brewPump(false));
      break;
    }
  }
  await step(90);
  s = await state();
  check('in the band the binding grows', peak > 0.05, 'peak=' + peak);
  // now close the damper until the pot is right out of the band, and keep stirring: the binding
  // must fall, not hold
  const atPeak = s.progress;
  await ev(() => {
    TP.game.brewing.autoStir = 1;
    TP.game.actions.brewPump(false);
    TP.game.actions.brewDamp(true);
  });
  for (let i = 0; i < 200; i++) {
    await step(6);
    const t = await state();
    if (t.fit === -1) break;
  }
  const cooled = await state();
  await step(120);
  s = await state();
  check('the pot is below the band', cooled.fit === -1, JSON.stringify({ heat: cooled.heat, band: cooled.band }));
  check('leaving the band decays the binding', s.progress < atPeak, atPeak + ' -> ' + s.progress);
  check('and it is not bound', !s.ready, JSON.stringify(s.ready));

  // ------------------------------------------------------------------------------ 3. a failed pour
  await ev(() => {
    TP.game.actions.brewDamp(false);
    TP.game.actions.brewPump(false);
    TP.game.brewing.autoStir = 0;
    TP.game.actions.brewEmpty();
  });
  await step(10);
  await add('saltwort');
  await add('corpselight');
  s = await state();
  check('saltwort and corpselight fall in no region', s.region === null, JSON.stringify({ mix: s.mix, region: s.region }));
  check('and nothing is bound', !s.ready);
  const potionsBefore = JSON.stringify(s.potions);
  const brewedBefore2 = s.brewed;
  await ev(() => TP.game.actions.brewBottle());
  await step(6);
  s = await state();
  check('a pour in no region fails', JSON.stringify(s.potions) === potionsBefore && s.brewed === brewedBefore2, JSON.stringify({ potions: s.potions }));
  check('and says why', typeof s.hint === 'string' && s.hint.length > 0, s.hint);
  check('the pot keeps its contents', s.contents.length === 2, JSON.stringify(s.contents));

  // ------------------------------------------------------------------------------ 4. emptying resets
  await ev(() => {
    TP.game.brewing.autoStir = 1;
    TP.game.actions.brewPump(true);
  });
  await step(45);
  s = await state();
  check('the pot is hot and stirred before the empty', s.fire > 0 && s.heat > 0 && s.stir > 0, JSON.stringify({ fire: s.fire, heat: s.heat, stir: s.stir }));
  await ev(() => {
    TP.game.brewing.autoStir = 0;
    TP.game.actions.brewPump(false);
    TP.game.actions.brewEmpty();
  });
  await step(6);
  s = await state();
  check('the empty clears the contents', s.contents.length === 0);
  check('the empty clears the mixture', s.mix === null && s.region === null && s.band === null && s.fit === null);
  check('the empty stops the fire', s.fire === 0, 'fire=' + s.fire);
  check('the empty cools the pot', s.heat === 0, 'heat=' + s.heat);
  check('the empty stops the stirring', s.stir === 0, 'stir=' + s.stir);
  check('the empty clears the binding', s.progress === 0 && !s.ready);

  const failed = R.filter((r) => !r.ok);
  log('BREW CHAIN ' + (failed.length ? 'FAILED ' + JSON.stringify(failed) : 'PASSED') + ' (' + (R.length - failed.length) + '/' + R.length + ')');
}
