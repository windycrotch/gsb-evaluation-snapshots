(() => {
  const W = window.__ENGINE.ctx.World;
  // Wait out any cooldown/GCD, then cast once with a large pack and count HITSTOP emits.
  W.clock.reset();
  let emits = 0;
  const orig = W.clock.request.bind(W.clock);
  W.clock.request = (ms) => { emits++; return orig(ms); };
  W.player.mana = 420;
  // fresh cooldowns
  const bus = window.__ENGINE.ctx.bus, EV = window.__ENGINE.ctx.EV;
  bus.emit(EV.LEVEL_READY, { level: W.level });
  W.player.mana = 420;
  const ok = W.combat.cast('groundSlam');   // circle AoE over the pack
  const info = W.clock.hitstopInfo();
  W.clock.request = orig;
  return { ok, hitstopEmits: emits, grantedMs: info.grantedMs, targets: 10 };
})();
