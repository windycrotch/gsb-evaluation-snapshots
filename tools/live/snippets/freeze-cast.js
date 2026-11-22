(() => {
  const E = window.__ENGINE, W = E.ctx.World, bus = E.ctx.bus, EV = E.ctx.EV;
  W.clock.reset();
  bus.emit(EV.LEVEL_READY, { level: W.level });   // clears combat cooldowns
  W.player.mana = 420;
  const before = W.player.mana;
  const castOk = W.combat.cast('groundSlam');
  const frozen = W.clock.frozen;
  const cdAfterCast = W.combat.cooldown('groundSlam').remain;
  let rejects = 0, manaSpent = 0, accepted = 0;
  for (let i = 0; i < 40; i++) {
    const m0 = W.player.mana;
    const ok = W.combat.cast('groundSlam');
    if (!ok) rejects++; else { accepted++; manaSpent += (m0 - W.player.mana); }
  }
  const cdAfterSpam = W.combat.cooldown('groundSlam').remain;
  return { castOk, frozen, before, after: W.player.mana, rejects, accepted, manaSpent,
    cdAfterCast, cdAfterSpam, cdNonNeg: cdAfterSpam >= 0,
    manaOk: (before - 30) === W.player.mana || (accepted > 0 && manaSpent === 30 * accepted) };
})();
