(() => new Promise((resolve) => {
  const E = window.__ENGINE, W = E.ctx.World, bus = E.ctx.bus, EV = E.ctx.EV;
  W.clock.reset();
  const t0 = performance.now();
  const DUR = 3000;
  // Burst of 8 hitstops (an AoE on 8 targets) every ~120ms -> well over the 7% cap.
  const burst = setInterval(() => {
    for (let i = 0; i < 8; i++) bus.emit(EV.HITSTOP, 40 + Math.random() * 30);
  }, 120);
  // Sample the CLOCK directly (frames may be throttled headless): record frozen state each 16ms.
  let frozenTicks = 0, totalTicks = 0;
  const sampler = setInterval(() => {
    totalTicks++;
    if (W.clock.frozen) frozenTicks++;
  }, 16);
  setTimeout(() => {
    clearInterval(burst); clearInterval(sampler);
    const info = W.clock.hitstopInfo();
    const log = W.clock._log;
    let worst1s = 0;
    for (const g of log) { let s = 0;
      for (const h of log) { const lo = Math.max(h.s, g.s), hi = Math.min(h.e, g.s + 1); if (hi > lo) s += hi - lo; }
      if (s > worst1s) worst1s = s; }
    resolve({
      sampledFrozenShare: totalTicks > 0 ? frozenTicks / totalTicks : 0,
      worst1sMs: worst1s * 1000,
      realisedLifetimeDuty: info.lifetimeDuty,
      requestedMs: info.requestedMs, grantedMs: info.grantedMs, clippedMs: info.clippedMs,
      requests: info.requests, grants: info.grants, elapsedMs: performance.now() - t0,
    });
  }, DUR);
}))();
