'use strict';
// Arena = the level you draw over your real wall.
// Shapes: {t:'b', x,y,w,h,a} rotated box (center, size, angle) | {t:'c', x,y,r} circle.
// Persisted to localStorage, exportable as JSON.

const W = 1280, H = 720; // logical game resolution; corner-pin maps it onto the wall

// A usable spawn point is exactly a length-2 array of finite numbers.
function isValidSpawn(s) {
  return Array.isArray(s) && s.length === 2 &&
    typeof s[0] === 'number' && Number.isFinite(s[0]) &&
    typeof s[1] === 'number' && Number.isFinite(s[1]);
}

// Pure schema check for imported JSON. Merges onto blank() like every other
// path, but rejects files whose shapes/spawns aren't arrays, and repairs any
// malformed individual spawn by falling back to blank()'s default for that slot.
// Returns { arena, spawnsRepaired }. Throws Error('bad schema') on a bad shape/spawn field.
function parseArenaJSON(data) {
  if (!data || typeof data !== 'object' ||
      !Array.isArray(data.shapes) || !Array.isArray(data.spawns)) {
    throw new Error('bad schema');
  }
  const base = ArenaStore.blank();
  // Capture the default spawns before the merge: Object.assign would otherwise
  // alias base.spawns onto data.spawns, hiding the fallbacks we repair against.
  const defaultSpawns = base.spawns;
  const importedSpawns = data.spawns;
  const arena = Object.assign(base, data);
  let spawnsRepaired = 0;
  arena.spawns = defaultSpawns.map((fallback, i) => {
    if (isValidSpawn(importedSpawns[i])) return [importedSpawns[i][0], importedSpawns[i][1]];
    spawnsRepaired++;
    return fallback;
  });
  return { arena, spawnsRepaired };
}

const ArenaStore = {
  KEY: 'wallbrawl_arena',
  current: null,
  blank() {
    return {
      version: 1,
      playerScale: 1,
      showGeo: true,
      shapes: [],
      spawns: [[W * 0.3, H * 0.35], [W * 0.7, H * 0.35]],
    };
  },
  demo() {
    const a = this.blank();
    a.shapes = [
      { t: 'b', x: W / 2, y: H - 30, w: W - 120, h: 36, a: 0 },
      { t: 'b', x: W * 0.25, y: H * 0.62, w: 260, h: 20, a: 0 },
      { t: 'b', x: W * 0.75, y: H * 0.62, w: 260, h: 20, a: 0 },
      { t: 'b', x: W * 0.5, y: H * 0.38, w: 220, h: 20, a: 0 },
      { t: 'c', x: W * 0.09, y: H * 0.45, r: 36, k: 'bouncy' },
      { t: 'c', x: W * 0.91, y: H * 0.45, r: 36, k: 'bouncy' },
      { t: 'b', x: W * 0.5, y: H - 55, w: 150, h: 14, a: 0, k: 'deadly' },
    ];
    return a;
  },
  load() {
    try {
      const raw = localStorage.getItem(this.KEY);
      if (raw) { this.current = JSON.parse(raw); return; }
    } catch (e) {}
    this.current = this.demo();
  },
  save() {
    try { localStorage.setItem(this.KEY, JSON.stringify(this.current)); } catch (e) {}
  },
  export() {
    const blob = new Blob([JSON.stringify(this.current, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'arena.json';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  },
  // Imports never mutate the current arena until the whole file has parsed and
  // passed the schema check; any failure just reports in #hint and leaves
  // ArenaStore.current untouched so the editor keeps showing the existing arena.
  import(file, onDone) {
    const hint = document.getElementById('hint');
    const r = new FileReader();
    r.onload = () => {
      let parsed;
      try {
        parsed = parseArenaJSON(JSON.parse(r.result));
      } catch (e) {
        hint.textContent = 'Could not import: arena needs "shapes" and "spawns" arrays — current arena kept';
        return;
      }
      this.current = parsed.arena;
      this.save();
      if (onDone) onDone(parsed.spawnsRepaired);
    };
    r.onerror = () => {
      hint.textContent = 'Could not read that arena file — current arena kept';
    };
    r.readAsText(file);
  },
};
