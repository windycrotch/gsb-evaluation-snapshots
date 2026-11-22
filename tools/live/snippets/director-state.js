(() => {
  // Reach the AI system via the engine's system list to read director queues.
  const E = window.__ENGINE;
  const ai = E.systems.find(s => s && s.name === 'ai');
  const d = ai && ai.director;
  if (!d) return { found: false };
  return { found: true, delayed: d.delayed.length, pendingAdds: d.pendingAdds.length,
    enemies: d.enemies.length, wave: d.wave, bossSpawned: d.bossSpawned,
    telegraphActive: ai.telegraph && ai.telegraph.active.length };
})();
