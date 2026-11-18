'use strict';
// Local verification for the import-validation and round-reset behavior.
// Zero dependencies: loads the real src/*.js into a single vm script with
// minimal browser stubs (the browser shares one global lexical scope across
// <script> tags, so the test evaluates everything in one runInContext too).
// Run: node test/run-tests.js   (samples live here under test/, never in dist/)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const root = path.join(__dirname, '..');
const src = f => fs.readFileSync(path.join(root, 'src', f), 'utf8');
const readFixture = f => fs.readFileSync(path.join(__dirname, 'fixtures', f), 'utf8');

function makeCtx() { return new Proxy({}, { get: () => () => {} }); }
function makeEl(id) {
  return {
    id, style: {}, dataset: {}, children: [],
    classList: { toggle() {}, add() {}, remove() {} },
    title: '', innerHTML: '', textContent: '', value: '',
    addEventListener() {}, removeEventListener() {},
    appendChild(c) { this.children.push(c); return c; },
    setPointerCapture() {}, getContext() { return makeCtx(); },
    closest() { return null; },
  };
}

const storage = {};
const els = {};
let lastReader = null;
class FakeFileReader {
  constructor() { lastReader = this; }
  readAsText() {} // tests drive onload / onerror manually
}
// handle to the most recent FileReader, reachable from inside the vm
const readerBridge = { get last() { return lastReader; }, reset() { lastReader = null; } };

const sandbox = {
  console, Math, JSON, Date, Number, Object, Array, Set, Map, Proxy, Error,
  setTimeout, clearTimeout,
  performance: { now: () => 0 },
  localStorage: {
    getItem: k => (k in storage ? storage[k] : null),
    setItem: (k, v) => { storage[k] = String(v); },
    removeItem: k => { delete storage[k]; },
  },
  document: {
    readyState: 'loading', // game.js then waits for DOMContentLoaded; the test calls G.init() itself
    getElementById: id => (els[id] || (els[id] = makeEl(id))),
    querySelectorAll: () => [],
    createElement: () => makeEl('created'),
    addEventListener() {},
  },
  window: { addEventListener() {}, innerWidth: 1280, innerHeight: 720 },
  navigator: { getGamepads: () => [] },
  requestAnimationFrame: () => 0,
  FileReader: FakeFileReader,
  __reader: readerBridge,
  Blob: class {},
  Image: class {},
  URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
  __fixtures: {
    valid: readFixture('valid-arena.json'),
    oneBad: readFixture('one-bad-spawn.json'),
    allBad: readFixture('all-bad-spawns.json'),
    shapesNotArray: readFixture('shapes-not-array.json'),
    spawnsNotArray: readFixture('spawns-not-array.json'),
    malformed: readFixture('malformed-json.json'),
    emptySpawns: readFixture('empty-spawns.json'),
  },
};
sandbox.window.AudioContext = undefined;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

const sourceFiles = [
  'util.js', 'sound.js', 'arena.js', 'input.js', 'physics.js', 'particles.js',
  'heads.js', 'player.js', 'weapons.js', 'calibrate.js', 'editor.js', 'game.js',
];
const bundle = sourceFiles.map(src).join('\n;\n');

// All assertions run inside the context so they share the scripts' lexical scope.
const testProgram = `
(() => {
  const results = [];
  const check = (name, cond, detail) => results.push({ name, ok: !!cond, detail: detail === undefined ? '' : String(detail) });
  const eq = (name, actual, expected) =>
    check(name, JSON.stringify(actual) === JSON.stringify(expected),
      'got ' + JSON.stringify(actual) + ' want ' + JSON.stringify(expected));
  const throwsBadSchema = (name, fn) => {
    let t = null; try { fn(); } catch (e) { t = e; }
    check(name, t !== null && t.message === 'bad schema', t ? t.message : 'no throw');
  };
  const blank = JSON.parse(JSON.stringify(ArenaStore.blank()));

  // ---- 1. parseArenaJSON ----------------------------------------------------
  const parse = txt => parseArenaJSON(JSON.parse(txt));

  {
    const { arena, spawnsRepaired } = parse(__fixtures.valid);
    check('valid: zero spawns repaired', spawnsRepaired === 0, 'repaired=' + spawnsRepaired);
    eq('valid: custom spawns kept', arena.spawns, [[200, 250], [1080, 250]]);
    check('valid: shapes kept', arena.shapes.length === 1 && arena.shapes[0].x === 640);
    eq('valid: playerScale kept', arena.playerScale, 1.25);
    eq('valid: showGeo kept', arena.showGeo, false);
    eq('valid: version default merged', arena.version, 1);
  }
  {
    const { arena, spawnsRepaired } = parse(__fixtures.oneBad);
    check('one-bad: exactly 1 repaired', spawnsRepaired === 1, 'repaired=' + spawnsRepaired);
    eq('one-bad: bad slot -> blank default', arena.spawns[0], blank.spawns[0]);
    eq('one-bad: good second spawn kept', arena.spawns[1], [1080, 250]);
    check('one-bad: legal shape retained', arena.shapes.length === 1);
    check('one-bad: output still has 2 spawns', arena.spawns.length === 2);
  }
  {
    const { arena, spawnsRepaired } = parse(__fixtures.allBad);
    eq('all-bad: spawns reset to both blank defaults', arena.spawns, blank.spawns);
    check('all-bad: repaired count = 2 slots (not 6 inputs)', spawnsRepaired === 2, 'repaired=' + spawnsRepaired);
    check('all-bad: output always has 2 spawns', arena.spawns.length === 2);
  }
  {
    const { arena, spawnsRepaired } = parse(__fixtures.emptySpawns);
    eq('empty-spawns: both defaults', arena.spawns, blank.spawns);
    check('empty-spawns: 2 repaired', spawnsRepaired === 2);
    eq('empty-spawns: other field kept', arena.playerScale, 0.8);
  }
  const throwsAny = (name, fn) => {
    let t = null; try { fn(); } catch (e) { t = e; }
    check(name, t !== null, t ? t.message : 'no throw');
  };
  {
    const keeper = { marker: 'KEEP' };
    ArenaStore.current = keeper;
    throwsBadSchema('reject: shapes non-array', () => parse(__fixtures.shapesNotArray));
    throwsBadSchema('reject: spawns non-array', () => parse(__fixtures.spawnsNotArray));
    throwsAny('reject: malformed JSON text', () => parseArenaJSON(JSON.parse(__fixtures.malformed)));
    throwsBadSchema('reject: top-level null', () => parseArenaJSON(null));
    throwsBadSchema('reject: top-level primitive', () => parseArenaJSON(42));
    throwsBadSchema('reject: top-level array', () => parseArenaJSON([]));
    check('rejection leaves ArenaStore.current untouched', ArenaStore.current === keeper);
  }
  {
    check('isValidSpawn [1,2]', isValidSpawn([1, 2]) === true);
    check('isValidSpawn rejects length 3', isValidSpawn([1, 2, 3]) === false);
    check('isValidSpawn rejects length 1', isValidSpawn([1]) === false);
    check('isValidSpawn rejects string coord', isValidSpawn(['1', 2]) === false);
    check('isValidSpawn rejects null coord', isValidSpawn([null, 2]) === false);
    check('isValidSpawn rejects bool coord', isValidSpawn([1, true]) === false);
    check('isValidSpawn rejects array-like object', isValidSpawn({ 0: 1, 1: 2, length: 2 }) === false);
    check('isValidSpawn rejects bare number', isValidSpawn(42) === false);
    check('isValidSpawn rejects null', isValidSpawn(null) === false);
  }

  // ---- 2. ArenaStore.import full path --------------------------------------
  {
    const hint = document.getElementById('hint');
    const keeper = { shapes: [{ t: 'b' }], spawns: [[1, 1], [2, 2]], marker: 'KEEP' };
    const STORE_KEY = ArenaStore.KEY;
    localStorage.removeItem(STORE_KEY);

    ArenaStore.current = keeper;
    let done = 0, lastArg = null;
    const onDone = n => { done++; lastArg = n; };

    ArenaStore.import({}, onDone);
    __reader.last.result = __fixtures.shapesNotArray;
    __reader.last.onload();
    check('import bad schema: onDone not called', done === 0);
    check('import bad schema: current arena untouched', ArenaStore.current === keeper);
    check('import bad schema: hint explains failure + kept',
      /could not import/i.test(hint.textContent) && /kept/i.test(hint.textContent));
    check('import bad schema: nothing persisted', localStorage.getItem(STORE_KEY) === null);

    __reader.reset();
    ArenaStore.import({}, onDone);
    __reader.last.result = __fixtures.malformed;
    __reader.last.onload();
    check('import malformed JSON: arena untouched', ArenaStore.current === keeper);

    __reader.reset();
    ArenaStore.import({}, onDone);
    __reader.last.onerror();
    check('import read error: arena untouched', ArenaStore.current === keeper);
    check('import read error: hint mentions read', /could not read/i.test(hint.textContent));

    __reader.reset();
    ArenaStore.import({}, onDone);
    __reader.last.result = __fixtures.oneBad;
    __reader.last.onload();
    check('import valid: onDone called once', done === 1);
    check('import valid: reports 1 repaired', lastArg === 1);
    check('import valid: arena replaced', ArenaStore.current !== keeper);
    const saved = JSON.parse(localStorage.getItem(STORE_KEY));
    eq('import valid: repaired spawn persisted as default', saved.spawns[0], blank.spawns[0]);
    eq('import valid: good spawn persisted', saved.spawns[1], [1080, 250]);
  }

  // ---- 3. startMatch / startRound ------------------------------------------
  // Fresh persistence state so Calib/ArenaStore init behave like a first run.
  localStorage.removeItem(ArenaStore.KEY);
  localStorage.removeItem(Calib.KEY);
  G.init();

  {
    ArenaStore.current = ArenaStore.blank(); // shapes: []
    G.setState('edit');
    const hint = document.getElementById('hint');
    G.startMatch();
    check('empty shapes: stays in edit state', G.state === 'edit', G.state);
    check('empty shapes: hint asks for at least one platform', /at least one platform/i.test(hint.textContent));
  }
  {
    const a = ArenaStore.blank();
    a.shapes = [{ t: 'b', x: 640, y: 700, w: 1000, h: 30, a: 0 }];
    a.spawns = [[111, 222], [333, 444]];
    ArenaStore.current = a;
    G.startMatch();
    check('with shapes: enters play', G.state === 'play', G.state);
    check('with shapes: round 1 countdown', G.round.num === 1 && G.round.phase === 'countdown');
  }
  {
    const [p0, p1] = G.players;
    p0.x = 999; p0.y = 888; p0.hp = 7; p0.weapon = 'uzi'; p0.ammo = 13; p0.alive = false; p0.vx = 120;
    p1.x = 50; p1.y = 60; p1.hp = 40; p1.weapon = 'shotgun'; p1.ammo = 2; p1.vy = -300;
    Weapons.bullets.push({ x: 1 }, { x: 2 });
    Weapons.crates.push({ x: 7 }, { x: 8 });
    G.particles.arr.push({ x: 1 }, { x: 2 }, { x: 3 });
    const numBefore = G.round.num;

    G.startRound();

    check('startRound: round number advanced', G.round.num === numBefore + 1);
    check('startRound: phase countdown', G.round.phase === 'countdown');
    eq('startRound: P0 back at current spawn', [p0.x, p0.y], [111, 222]);
    eq('startRound: P1 back at current spawn', [p1.x, p1.y], [333, 444]);
    check('startRound: both full hp', p0.hp === 100 && p1.hp === 100);
    check('startRound: both alive', p0.alive === true && p1.alive === true);
    check('startRound: weapons cleared', p0.weapon === null && p1.weapon === null);
    check('startRound: ammo cleared', p0.ammo === 0 && p1.ammo === 0);
    check('startRound: velocity zeroed', p0.vx === 0 && p0.vy === 0 && p1.vx === 0 && p1.vy === 0);
    check('startRound: bullets cleared', Weapons.bullets.length === 0);
    check('startRound: crates cleared', Weapons.crates.length === 0);
    check('startRound: particles cleared', G.particles.arr.length === 0);
  }
  {
    ArenaStore.current.spawns = [{ bad: true }, [333, 444]];
    G.startRound();
    const [p0, p1] = G.players;
    eq('bad stored spawn: P0 falls back to blank default', [p0.x, p0.y], blank.spawns[0]);
    eq('bad stored spawn: good P1 spawn kept', [p1.x, p1.y], [333, 444]);
    check('bad stored spawn: positions finite',
      [p0.x, p0.y, p1.x, p1.y].every(Number.isFinite));
  }
  {
    ArenaStore.current.spawns = [[10, 20], [30, 40]];
    G.startRound();
    eq('later round uses edited spawn P0', [G.players[0].x, G.players[0].y], [10, 20]);
    eq('later round uses edited spawn P1', [G.players[1].x, G.players[1].y], [30, 40]);
    check('later round again full hp', G.players.every(p => p.hp === 100));
  }

  return results;
})();
`;

let results;
try {
  results = vm.runInContext(bundle + '\n;\n' + testProgram, sandbox, { filename: 'wallbrawl-bundle.js' });
} catch (e) {
  console.error('Test harness crashed while loading game code:\n');
  console.error(e.stack || e);
  process.exit(2);
}

let passed = 0, failed = 0;
for (const r of results) {
  if (r.ok) { passed++; console.log('  ok  - ' + r.name); }
  else { failed++; console.log('  FAIL- ' + r.name + (r.detail ? '  -> ' + r.detail : '')); }
}
console.log('\n' + passed + ' passed, ' + failed + ' failed\n');
process.exit(failed ? 1 : 0);
