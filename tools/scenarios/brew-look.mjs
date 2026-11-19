// A look at the cauldron overlay in three states, for the eyes only (the assertions live in
// tools/brew-check.mjs and tools/scenarios/brew-chain.mjs).
//   node tools/play.mjs tools/scenarios/brew-look.mjs --q high
export default async function ({ ev, step, log, page, shot }) {
  await step(20);
  await page.waitForTimeout(2500);
  await ev(() => TP.play());
  await step(10);
  await ev(() => {
    const g = TP.game;
    g.state.inv.ingredients = { cinderbloom: 5, saltwort: 3, mirrorlily: 2, halite: 2, corpselight: 2 };
    g.state.known.charted = { ember: true };
    const c = g.world.named.cauldron;
    g.player.teleport(c.x, c.y + 0.1, c.z + 2.2, 0, -0.3);
  });
  await step(30);
  await page.waitForTimeout(500);
  await ev(() => TP.game.input.press('KeyE'));
  await step(2);
  await ev(() => TP.game.input.release('KeyE'));
  await step(40);
  await page.waitForTimeout(900);
  // a hit, in band, part-bound
  await ev(() => {
    const g = TP.game;
    for (let i = 0; i < 3; i++) g.actions.brewAdd('cinderbloom');
    g.brew.fire = 0.86;
    g.brew.heat = 0.84;
    g.brew.stir = 0.8;
    g.brew.progress = 0.62;
    g.brew.hint = '';
  });
  await step(20);
  await page.waitForTimeout(600);
  await shot('brew_look_hit');

  // a mixture in no region, and a failed pour
  await ev(() => {
    const g = TP.game;
    g.actions.brewEmpty();
    g.actions.brewAdd('saltwort');
    g.actions.brewAdd('corpselight');
    g.brew.heat = 0.2;
  });
  await step(20);
  await ev(() => TP.game.actions.brewBottle());
  await step(6);
  await page.waitForTimeout(500);
  await shot('brew_look_miss');
  log('miss hint', await ev(() => TP.game.brew.hint));
  log(
    'readout',
    await ev(() => ({
      name: document.querySelector('.tp-brew-name')?.textContent,
      mark: document.querySelector('.tp-rd-name')?.textContent,
      heat: document.querySelectorAll('.tp-rd-num')[1]?.textContent,
      bind: document.querySelectorAll('.tp-rd-num')[2]?.textContent,
    }))
  );

  // the pot after an empty
  await ev(() => TP.game.actions.brewEmpty());
  await step(20);
  await page.waitForTimeout(500);
  await shot('brew_look_empty');
}
