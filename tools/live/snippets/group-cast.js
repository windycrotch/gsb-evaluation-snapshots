(() => {
  const ids = ['groundSlam','frostNova','cleave','blink','fireball'];
  let n = 0;
  for (const id of ids) { if (window.__probe.cast(id)) n++; }
  return n;
})();
