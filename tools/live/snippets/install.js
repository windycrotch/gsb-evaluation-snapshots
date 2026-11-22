(() => {
  const E = window.__ENGINE, W = E.ctx.World, bus = E.ctx.bus, EV = E.ctx.EV;
  const THREE = E.ctx.THREE;
  window.__probe = {
    spawnPack(n = 10, radius = 2.5) {
      for (let i = 0; i < n; i++) {
        const a = (i / n) * Math.PI * 2;
        const p = new THREE.Vector3(
          W.player.pos.x + Math.cos(a) * radius,
          W.player.pos.y,
          W.player.pos.z + Math.sin(a) * radius);
        const e = { id: W.id(), kind: 'enemy', faction: 'monster', archetype: 'dummy',
          pos: p, vel: new THREE.Vector3(), radius: 0.5, height: 1.7,
          hp: 1e9, maxHp: 1e9, alive: true, facing: 0, stagger: 0, armour: 0,
          hurt(a2){ this.hp -= a2; } };
        W.add(e);
      }
      W.rebuildHash();
      return n;
    },
    clearPack() {
      for (let i = W.entities.length - 1; i >= 0; i--) {
        const e = W.entities[i];
        if (e.archetype === 'dummy') W.remove(e);
      }
      W.rebuildHash();
    },
    cast(id) { return W.combat.cast(id); },
    hitstop() { return W.clock.hitstopInfo(); },
    cooldown(id) { return W.combat.cooldown(id).remain; },
    mana() { return W.player.mana; },
    levelSeed() { return W.level && W.level.seed; },
    aliveCount() { return W.entities.filter(e => e.alive).length; },
    worstWindow() {
      const log = W.clock._log; let maxWin = 0;
      for (const g of log) {
        let load = 0;
        for (const h of log) {
          const lo = Math.max(h.s, g.s), hi = Math.min(h.e, g.s + 1.0);
          if (hi > lo) load += hi - lo;
        }
        if (load > maxWin) maxWin = load;
      }
      return maxWin;
    }
  };
})();
