(() => {
  const E = window.__ENGINE, W = E.ctx.World;
  const ai = E.systems.find(s => s && s.name === 'ai');
  const counts = [];
  const sceneChildren = [];
  const c = () => ({
    world: W.entities.length,
    alive: W.entities.filter(e => e.alive).length,
    controllers: ai.director.enemies.length,
    scene: W.scene.children.length,
  });
  counts.push(c());
  window.__rebuildLevel(W.level.seed);
  counts.push(c());
  window.__rebuildLevel(W.level.seed);
  counts.push(c());
  window.__rebuildLevel(W.level.seed);
  counts.push(c());
  return counts;
})();
