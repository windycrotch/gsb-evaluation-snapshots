(() => {
  const E = window.__ENGINE, W = E.ctx.World, bus = E.ctx.bus, EV = E.ctx.EV;
  bus.emit(EV.LEVEL_READY, { level: W.level });   // fresh cooldowns
  W.player.mana = 420;
  const m0 = W.player.mana;
  // Emulate the real player pipeline: emit PLAYER_CAST with a skill key; combat validates.
  const before = W.combat.cooldown('fireball').remain;
  bus.emit(EV.PLAYER_CAST, { skill: 'q', origin: W.player.pos.clone(), dir: { x: 0, y: 0, z: 1 } });
  const afterMana = W.player.mana;
  const afterCd = W.combat.cooldown('fireball').remain;
  // Immediately emit again (GCD + own cooldown? fireball cd 0) -> GCD blocks the 2nd
  const m1 = W.player.mana;
  bus.emit(EV.PLAYER_CAST, { skill: 'q', origin: W.player.pos.clone(), dir: { x: 0, y: 0, z: 1 } });
  return { m0, afterMana, charged: m0 - afterMana, afterCd, before,
    secondCharged: m1 - W.player.mana, // must be 0 (GCD reject, no mana)
    gcdBlocked: W.combat.blocked('fireball') === 'gcd' || W.combat.blocked('fireball') === null };
})();
