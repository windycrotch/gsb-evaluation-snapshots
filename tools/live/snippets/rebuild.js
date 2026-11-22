(() => {
  const W = window.__ENGINE.ctx.World;
  W.clock.reset(); W.clock.request(70);
  W.combat.cast('groundSlam');
  const beforeGranted = W.clock.hitstopInfo().grantedMs;
  const beforeFrozen = W.clock.frozen;
  const beforeCd = W.combat.cooldown('groundSlam').remain;
  const seed0 = W.level.seed;
  window.__rebuildLevel(seed0);
  const afterInfo = W.clock.hitstopInfo();
  return { beforeGranted, beforeFrozen, beforeCd, seed0,
    afterSeed: W.level.seed, afterGranted: afterInfo.grantedMs, afterFrozen: afterInfo.frozen,
    afterCd: W.combat.cooldown('groundSlam').remain,
    leftoverNonPlayer: W.entities.filter(e => e.alive && e.kind !== 'player').length };
})();
