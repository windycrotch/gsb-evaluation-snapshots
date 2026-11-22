(() => {
  const E = window.__ENGINE, W = E.ctx.World;
  const ai = E.systems.find(s => s && s.name === 'ai');
  const d = ai.director;
  const before = { delayed: d.delayed.length, pendingAdds: d.pendingAdds.length, enemies: d.enemies.length, wave: d.wave };
  // force dirty combat + freeze state
  W.clock.reset(); W.clock.request(70);
  W.combat.cast('groundSlam');
  const dirtyFreeze = W.clock.hitstopInfo().grantedMs;
  const dirtyCd = W.combat.cooldown('groundSlam').remain;
  window.__rebuildLevel(W.level.seed);
  const after = { delayed: d.delayed.length, pendingAdds: d.pendingAdds.length, enemies: d.enemies.length, wave: d.wave };
  const info = W.clock.hitstopInfo();
  return { before, after, dirtyFreeze, dirtyCd,
    afterGranted: info.grantedMs, afterFrozen: info.frozen,
    afterCd: W.combat.cooldown('groundSlam').remain,
    leftoverNonPlayer: W.entities.filter(e => e.alive && e.kind !== 'player').length };
})();
