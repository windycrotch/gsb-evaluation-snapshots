(() => {
  const E = window.__ENGINE, W = E.ctx.World, bus = E.ctx.bus, EV = E.ctx.EV;
  const hud = E.systems.find(s => s && s.name === 'hud');
  // Find the SkillBar instance: it lives in hud's module state; instead read DOM classes +
  // authoritative combat state, which is what a player sees.
  bus.emit(EV.LEVEL_READY, { level: W.level });      // clear cooldowns
  W.player.mana = 420;
  const beforeMana = W.player.mana;
  const cast = W.combat.cast('frostNova');            // cost 26, cd 3.0
  const afterMana = W.player.mana;
  const cd = W.combat.cooldown('frostNova');
  return { cast, beforeMana, afterMana, spent: beforeMana - afterMana, cdRemain: cd.remain, cdFrac: cd.frac,
    readyNow: W.combat.ready('frostNova'), blocked: W.combat.blocked('frostNova') };
})();
