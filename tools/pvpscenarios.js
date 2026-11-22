// Link battle end-of-battle scenarios: two headless copies of the game battle over a fake wire (the way
// tools/pvpfuzz.js sets it up), then something goes wrong - a forfeit, a dropped connection mid-replacement,
// both sides fainting at once. Every scenario must end with both games reaching a clear, consistent result in a
// bounded number of frames: nobody may wait forever, and a replacement the other side completed before dropping
// must still take effect.
//   node tools/pvpscenarios.js            run all scripted scenarios
//   node tools/pvpscenarios.js fuzz [n]   random battles with random forfeit/disconnect injection
'use strict';
const H = require('./headless.js');

const load = () => {
  const G = H.loadGame({ search: '?map=Route1&x=10&y=20' }).G;
  G.boot(); G.noEncounters = true; G.autoBattleText = true; G.state.options.battleAnim = false;
  return G;
};
const errs = [];
const origErr = console.error;
console.error = (...a) => errs.push(a.join(' ').slice(0, 300));

// ---------- two linked games ----------
function mon(G, sp, moves, lv) {
  const m = new G.Mon(sp, lv || 50);
  m.moves = []; for (const id of moves) m.addMove(id);
  return G.socialInternals.monOut(m, false);
}
function pair() {
  const A = load(), B = load();
  const a = { G: A, name: 'HOST' }, b = { G: B, name: 'GUEST' };
  a.other = b; b.other = a;
  for (const s of [a, b]) {
    s.dead = false;      // network dead: sends go nowhere
    s.pressedA = false;
    s.action = { type: 'fight', slot: 0 }; // what to do at the action menu
  }
  return [a, b];
}
function start(s, m) {
  const G = s.G, SI = G.socialInternals, lk = new G.lounge.Link(m);
  s.link = lk;
  lk.send = (b, k, act, extra) => {
    if (s.dead) return; // the wire is cut: nothing leaves this game
    s.other.link.inbox.push(JSON.parse(JSON.stringify(Object.assign({ t: 'bt', mid: m.mid, turn: b.turn, k, a: act }, extra || {}))));
  };
  const mine = m.teams[m.host ? 0 : 1].map(o => SI.monIn(Object.assign({}, o, { l: 50 }), 'ME', 0));
  const foes = m.teams[m.host ? 1 : 0].map(o => SI.monIn(Object.assign({}, o, { l: 50 }), 'FOE', 0));
  G.state.party = mine;
  s.mine = mine; s.foes = foes;
  s.task = G.spawnScript(G.runBattle({ type: 'trainer', enemyParty: foes, trainer: { cls: 'COOLTRAINER_M', displayName: 'FOE', money: 0 }, trainerItems: [],
    transition: 'boss', noBlackout: true, noExp: true, noItems: true, noBadgeBoost: true, p2Action: lk.p2Action, pvp: lk }), 'pvp');
  return s;
}
function battle(s) { const sc = s.G.engine.scenes.find(x => x.constructor.name === 'BattleScene'); return sc && sc.b; }
function bscene(s) { return s.G.engine.scenes.find(x => x.constructor.name === 'BattleScene'); }
function topOf(s) { const sc = s.G.engine.scenes; return sc[sc.length - 1]; }

// one frame of input for a side, following its `action` script
function drive(s) {
  const G = s.G, I = G.input.injected;
  I.a = false; I.b = false; I.down = false;
  let want = false;
  const top = topOf(s);
  if (top && top.constructor.name === 'Menu') { // YES/NO (forfeit), SHIFT/SUMMARY/CANCEL: take the first row
    top.sel = 0; want = true;
  } else if (top && top.constructor.name === 'PartyScreen' && !top.busy) {
    const ps = top, n = ps.party.length;
    let pick = -1;
    for (let i = 0; i < n; i++) if (ps.party[i].hp > 0 && i !== ps.o.activeIdx) { pick = i; break; }
    if (pick < 0 && !ps.o.forced) { I.b = true; s.pressedA = false; s.G.engine.step(); return; } // voluntary switch with nowhere to go: cancel
    if (pick < 0) pick = 0;
    ps.sel = s.replacement !== undefined && ps.party[s.replacement] && ps.party[s.replacement].hp > 0 ? s.replacement : pick;
    want = true;
  } else {
    const bs = bscene(s);
    if (bs && bs.menu) {
      if (bs.menu.kind === 'action') {
        bs.menu.sel = { fight: 0, switch: 1, run: 3 }[s.action.type] || 0;
        want = true;
      } else if (bs.menu.kind === 'moves') {
        const b = bs.b, ml = b.moveList(b.p), v = b.p.v;
        const ok = ml.map((x, i) => i).filter(i => ml[i].pp > 0 && !(v.disabled && v.disabled.move === ml[i].id));
        const want0 = Math.min(s.action.slot || 0, ml.length - 1);
        bs.menu.sel = ok.includes(want0) ? want0 : ok[0];
        want = true;
      }
    }
  }
  if (want && !s.pressedA) I.a = true;
  s.pressedA = I.a;
  G.engine.step();
}
// cut a side's connection: its sends vanish, its own game learns the link is lost, the server tells the other game it's gone
function kill(s) {
  s.dead = true;
  s.action = { type: 'fight', slot: 0 }; // its player stops fiddling: plain attacks from here
  s.link.lost = true;
  s.other.link.gone = true;
}
function runFrames(sides, maxF, hook) {
  let f = 0;
  for (; f < maxF; f++) {
    if (hook && hook(f)) return { frames: f, hooked: true };
    let all = true;
    for (const s of sides) {
      if (s.task.done) continue;
      all = false;
      if (s.frozen) s.G.engine.step(); else drive(s);
    }
    // the server relays a finished game's result to the other side as 'ended' (tools/lounge.py end_match)
    for (const s of sides) if (s.task.done && !s.relayed) { s.relayed = true; if (!s.other.task.done) s.other.link.ended = s.task.value; }
    if (all) return { frames: f, done: true };
  }
  return { frames: maxF, timeout: true };
}
function hp(s, list) { return list.map(m => m.hp).join(','); }

const results = [];
function report(name, ok, detail) {
  results.push({ name, ok });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (detail ? '  -- ' + detail : ''));
}

// ---------- scenarios ----------
// 1. a clean battle to the end: results must be opposite and HP identical in both games
function scenNormal() {
  const [a, b] = pair();
  const teams = [
    [mon(a.G, 'TAUROS', ['BODY_SLAM']), mon(a.G, 'STARMIE', ['SURF']), mon(a.G, 'ALAKAZAM', ['PSYCHIC_M'])],
    [mon(a.G, 'SNORLAX', ['BODY_SLAM']), mon(a.G, 'RHYDON', ['EARTHQUAKE']), mon(a.G, 'ZAPDOS', ['THUNDERBOLT'])],
  ];
  const seed = 1234567;
  start(a, { mid: 's1', seed, host: true, teams, foe: { id: 2, name: 'GUEST' } });
  start(b, { mid: 's1', seed, host: false, teams, foe: { id: 1, name: 'HOST' } });
  const r = runFrames([a, b], 60000);
  const opp = (a.task.value === 'win' && b.task.value === 'lose') || (a.task.value === 'lose' && b.task.value === 'win') || (a.task.value === 'draw' && b.task.value === 'draw');
  const same = hp(a, a.mine) === hp(b, b.foes) && hp(a, a.foes) === hp(b, b.mine);
  report('normal battle finishes consistent', !!(r.done && opp && same),
    'frames=' + r.frames + ' results=' + a.task.value + '/' + b.task.value + ' hp ' + hp(a, a.mine) + '|' + hp(a, a.foes) + ' vs ' + hp(b, b.foes) + '|' + hp(b, b.mine));
}

// 2. the host forfeits from the action menu: host loses, guest wins, both finish promptly
function scenForfeit() {
  const [a, b] = pair();
  const teams = [
    [mon(a.G, 'TAUROS', ['BODY_SLAM']), mon(a.G, 'STARMIE', ['SURF'])],
    [mon(a.G, 'SNORLAX', ['BODY_SLAM']), mon(a.G, 'RHYDON', ['EARTHQUAKE'])],
  ];
  start(a, { mid: 's2', seed: 99, host: true, teams, foe: { id: 2, name: 'GUEST' } });
  start(b, { mid: 's2', seed: 99, host: false, teams, foe: { id: 1, name: 'HOST' } });
  a.action = { type: 'run' }; // RUN, then YES at the forfeit prompt
  const r = runFrames([a, b], 20000);
  report('forfeit ends both sides', !!(r.done && a.task.value === 'lose' && b.task.value === 'win'),
    'frames=' + r.frames + ' results=' + a.task.value + '/' + b.task.value);
}

// 3. the guest drops while the host is waiting for the guest's faint replacement: the host must see a result
function scenDropDuringReplace() {
  const [a, b] = pair();
  const teams = [
    [mon(a.G, 'TAUROS', ['BODY_SLAM']), mon(a.G, 'STARMIE', ['SURF'])],
    [mon(a.G, 'MAGIKARP', ['SPLASH']), mon(a.G, 'SNORLAX', ['BODY_SLAM'])],
  ];
  start(a, { mid: 's3', seed: 7, host: true, teams, foe: { id: 2, name: 'GUEST' } });
  start(b, { mid: 's3', seed: 7, host: false, teams, foe: { id: 1, name: 'HOST' } });
  b.mine[0].hp = 1; a.foes[0].hp = 1; // the guest's lead faints to any hit
  let killed = false;
  const r = runFrames([a, b], 30000, () => {
    const t = topOf(b);
    if (!killed && t && t.constructor.name === 'PartyScreen' && t.o.forced) { kill(b); killed = true; }
    return false;
  });
  const aDone = a.task.done, bDone = b.task.done;
  report('drop during replacement pick ends both sides', !!(killed && aDone && bDone && a.task.value === 'win'),
    'killed=' + killed + ' frames=' + r.frames + ' results=' + a.task.value + '/' + b.task.value);
}

// 4. a replacement the guest completed before dropping must take effect in the host's game; then the host wins by abandonment
function scenReplaceThenDrop() {
  const [a, b] = pair();
  const teams = [
    [mon(a.G, 'TAUROS', ['BODY_SLAM']), mon(a.G, 'STARMIE', ['SURF'])],
    [mon(a.G, 'MAGIKARP', ['SPLASH']), mon(a.G, 'SNORLAX', ['BODY_SLAM']), mon(a.G, 'RHYDON', ['EARTHQUAKE'])],
  ];
  start(a, { mid: 's4', seed: 7, host: true, teams, foe: { id: 2, name: 'GUEST' } });
  start(b, { mid: 's4', seed: 7, host: false, teams, foe: { id: 1, name: 'HOST' } });
  b.mine[0].hp = 1; a.foes[0].hp = 1;
  b.replacement = 2; // the guest sends out its third POKéMON
  let killed = false, applied = false, idxAtKill = -1;
  const r = runFrames([a, b], 30000, () => {
    const bb = battle(a);
    if (!killed && bb && bb.e.idx === 2) { applied = true; idxAtKill = bb.e.idx; kill(b); killed = true; }
    return false;
  });
  report('completed replacement applies before drop, then host wins', !!(killed && applied && a.task.done && a.task.value === 'win' && idxAtKill === 2),
    'killed=' + killed + ' applied=' + applied + ' frames=' + r.frames + ' results=' + a.task.value + '/' + b.task.value + ' e.idx@kill=' + idxAtKill);
}

// 5. both actives faint on the same turn (EXPLOSION): both replace, the battle continues in lockstep
function scenDoubleFaint() {
  const [a, b] = pair();
  const teams = [
    [mon(a.G, 'GOLEM', ['EXPLOSION']), mon(a.G, 'TAUROS', ['BODY_SLAM'])],
    [mon(a.G, 'WEEZING', ['EXPLOSION']), mon(a.G, 'SNORLAX', ['BODY_SLAM'])],
  ];
  start(a, { mid: 's5', seed: 4242, host: true, teams, foe: { id: 2, name: 'GUEST' } });
  start(b, { mid: 's5', seed: 4242, host: false, teams, foe: { id: 1, name: 'HOST' } });
  const r = runFrames([a, b], 60000);
  const opp = (a.task.value === 'win' && b.task.value === 'lose') || (a.task.value === 'lose' && b.task.value === 'win') || (a.task.value === 'draw' && b.task.value === 'draw');
  const same = hp(a, a.mine) === hp(b, b.foes) && hp(a, a.foes) === hp(b, b.mine);
  report('simultaneous faint, replacements stay in step', !!(r.done && opp && same),
    'frames=' + r.frames + ' results=' + a.task.value + '/' + b.task.value + ' hp ' + hp(a, a.mine) + '|' + hp(a, a.foes) + ' vs ' + hp(b, b.foes) + '|' + hp(b, b.mine));
}

// 6. both sides faint with nobody left: a draw in both games
function scenDoubleFaintDraw() {
  const [a, b] = pair();
  const teams = [
    [mon(a.G, 'GOLEM', ['EXPLOSION'])],
    [mon(a.G, 'WEEZING', ['EXPLOSION'])],
  ];
  start(a, { mid: 's6', seed: 5, host: true, teams, foe: { id: 2, name: 'GUEST' } });
  start(b, { mid: 's6', seed: 5, host: false, teams, foe: { id: 1, name: 'HOST' } });
  a.mine[0].hp = 1; b.foes[0].hp = 1; // WEEZING is faster: it explodes first and takes both actives down
  const r = runFrames([a, b], 30000);
  report('simultaneous faint with no replacements is a draw', !!(r.done && a.task.value === 'draw' && b.task.value === 'draw'),
    'frames=' + r.frames + ' results=' + a.task.value + '/' + b.task.value);
}

// 7. the guest goes silently offline (no 'gone' from the server yet): the host's wait must still time out with a result
function scenSilentDrop() {
  const [a, b] = pair();
  const teams = [
    [mon(a.G, 'TAUROS', ['BODY_SLAM']), mon(a.G, 'STARMIE', ['SURF'])],
    [mon(a.G, 'SNORLAX', ['BODY_SLAM']), mon(a.G, 'RHYDON', ['EARTHQUAKE'])],
  ];
  start(a, { mid: 's7', seed: 11, host: true, teams, foe: { id: 2, name: 'GUEST' } });
  start(b, { mid: 's7', seed: 11, host: false, teams, foe: { id: 1, name: 'HOST' } });
  let killed = false;
  const r = runFrames([a, b], 30000, f => {
    if (f === 200) { b.dead = true; b.frozen = true; killed = true; } // no gone/lost flags: the server hasn't noticed
    return killed && a.task.done; // stop as soon as the host gets its result
  });
  report('silent drop still ends for the waiting side', !!(killed && a.task.done && (a.task.value === 'win' || a.task.value === 'draw')),
    'frames=' + r.frames + ' host result=' + a.task.value + (r.timeout ? ' (frame cap hit)' : ''));
}

// 8. the guest forfeits: guest loses, host wins
function scenGuestForfeit() {
  const [a, b] = pair();
  const teams = [
    [mon(a.G, 'TAUROS', ['BODY_SLAM']), mon(a.G, 'STARMIE', ['SURF'])],
    [mon(a.G, 'SNORLAX', ['BODY_SLAM']), mon(a.G, 'RHYDON', ['EARTHQUAKE'])],
  ];
  start(a, { mid: 's8', seed: 21, host: true, teams, foe: { id: 2, name: 'GUEST' } });
  start(b, { mid: 's8', seed: 21, host: false, teams, foe: { id: 1, name: 'HOST' } });
  b.action = { type: 'run' };
  const r = runFrames([a, b], 20000);
  report('guest forfeit ends both sides', !!(r.done && a.task.value === 'win' && b.task.value === 'lose'),
    'frames=' + r.frames + ' results=' + a.task.value + '/' + b.task.value);
}

// 9. the host drops while the guest waits for the host's replacement
function scenHostDropDuringReplace() {
  const [a, b] = pair();
  const teams = [
    [mon(a.G, 'MAGIKARP', ['SPLASH']), mon(a.G, 'TAUROS', ['BODY_SLAM'])],
    [mon(a.G, 'SNORLAX', ['BODY_SLAM']), mon(a.G, 'RHYDON', ['EARTHQUAKE'])],
  ];
  start(a, { mid: 's9', seed: 33, host: true, teams, foe: { id: 2, name: 'GUEST' } });
  start(b, { mid: 's9', seed: 33, host: false, teams, foe: { id: 1, name: 'HOST' } });
  a.mine[0].hp = 1; b.foes[0].hp = 1; // the host's lead faints to any hit
  let killed = false;
  const r = runFrames([a, b], 30000, () => {
    const t = topOf(a);
    if (!killed && t && t.constructor.name === 'PartyScreen' && t.o.forced) { kill(a); killed = true; }
    return false;
  });
  report('host drop during replacement pick ends both sides', !!(killed && a.task.done && b.task.done && b.task.value === 'win'),
    'killed=' + killed + ' frames=' + r.frames + ' results=' + a.task.value + '/' + b.task.value);
}

// 10. both faint the same turn, then one side drops while both are picking replacements
function scenDoubleFaintDrop() {
  const [a, b] = pair();
  const teams = [
    [mon(a.G, 'GOLEM', ['EXPLOSION']), mon(a.G, 'TAUROS', ['BODY_SLAM'])],
    [mon(a.G, 'WEEZING', ['EXPLOSION']), mon(a.G, 'SNORLAX', ['BODY_SLAM'])],
  ];
  start(a, { mid: 's10', seed: 64, host: true, teams, foe: { id: 2, name: 'GUEST' } });
  start(b, { mid: 's10', seed: 64, host: false, teams, foe: { id: 1, name: 'HOST' } });
  a.mine[0].hp = 1; b.foes[0].hp = 1; // WEEZING explodes first (faster), taking both leads down
  let killed = false;
  const r = runFrames([a, b], 30000, () => {
    const t = topOf(b);
    if (!killed && t && t.constructor.name === 'PartyScreen' && t.o.forced) { kill(b); killed = true; }
    return false;
  });
  report('drop during double replacement ends both sides', !!(killed && a.task.done && b.task.done && a.task.value === 'win'),
    'killed=' + killed + ' frames=' + r.frames + ' results=' + a.task.value + '/' + b.task.value);
}

// 11. a side drops mid-turn while the other is already waiting for its move
function scenDropMidTurn() {
  const [a, b] = pair();
  const teams = [
    [mon(a.G, 'TAUROS', ['BODY_SLAM']), mon(a.G, 'STARMIE', ['SURF'])],
    [mon(a.G, 'SNORLAX', ['BODY_SLAM']), mon(a.G, 'RHYDON', ['EARTHQUAKE'])],
  ];
  start(a, { mid: 's11', seed: 77, host: true, teams, foe: { id: 2, name: 'GUEST' } });
  start(b, { mid: 's11', seed: 77, host: false, teams, foe: { id: 1, name: 'HOST' } });
  b.action = { type: 'switch' }; // the guest faffs about; the host attacks
  let killed = false;
  const r = runFrames([a, b], 30000, f => {
    if (f === 400) { kill(b); killed = true; } // drop the guest whenever the host is mid-wait
    return killed && a.task.done;
  });
  report('drop mid-turn ends for the waiting side', !!(killed && a.task.done && a.task.value === 'win'),
    'frames=' + r.frames + ' host result=' + a.task.value);
}


// 12. an engine exception mid-battle must settle both games the same way (they run identical code, so both hit it)
function scenCrashConsistency() {
  const [a, b] = pair();
  const teams = [
    [mon(a.G, 'TAUROS', ['BODY_SLAM']), mon(a.G, 'STARMIE', ['SURF'])],
    [mon(a.G, 'SNORLAX', ['BODY_SLAM']), mon(a.G, 'RHYDON', ['EARTHQUAKE'])],
  ];
  start(a, { mid: 's12', seed: 88, host: true, teams, foe: { id: 2, name: 'GUEST' } });
  start(b, { mid: 's12', seed: 88, host: false, teams, foe: { id: 1, name: 'HOST' } });
  const r = runFrames([a, b], 20000, f => {
    if (f === 300) for (const s of [a, b]) { const bb = battle(s); if (bb) bb.e.party = []; } // corrupt both games identically
    return false;
  });
  report('engine exception settles both sides the same way', !!(r.done && a.task.value === 'draw' && b.task.value === 'draw'),
    'frames=' + r.frames + ' results=' + a.task.value + '/' + b.task.value);
  errs.length = 0; // the injected exception is the point of this scenario, not a failure
}

// 13. random battles with random forfeit / disconnect injection
function fuzz(n, seed0) {
  // deterministic PRNG so a failing battle can be replayed: node tools/pvpscenarios.js fuzz 300 12345
  let rngState = (seed0 === undefined ? Math.random() * 2 ** 32 : seed0) >>> 0;
  const R = () => { rngState = (rngState + 0x6D2B79F5) >>> 0; let t = rngState; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  console.log('fuzz seed', rngState);
  const species = Object.keys(load().DATA.species).filter(s => true);
  let bad = 0;
  for (let k = 0; k < n; k++) {
    const [a, b] = pair();
    const G = a.G;
    const pickSp = () => species[Math.floor(R() * species.length)];
    const moves = G.DATA.moveList.filter(m => m !== 'STRUGGLE');
    const team = () => [0, 1, 2].map(() => mon(G, pickSp(), [0, 0, 0, 0].map(() => moves[Math.floor(R() * moves.length)])));
    const teams = [team(), team()];
    const seed = R() * 2 ** 32 >>> 0;
    start(a, { mid: 'f' + k, seed, host: true, teams, foe: { id: 2, name: 'GUEST' } });
    start(b, { mid: 'f' + k, seed, host: false, teams, foe: { id: 1, name: 'HOST' } });
    // random inputs like pvpfuzz, plus one random fault
    const faultAt = 50 + Math.floor(R() * 3000);
    const faultKind = ['kill-a', 'kill-b', 'forfeit-a', 'forfeit-b', 'none'][Math.floor(R() * 5)];
    const r = runFrames([a, b], 40000, f => {
      if (f === faultAt) {
        if (faultKind === 'kill-a') kill(a);
        else if (faultKind === 'kill-b') kill(b);
        else if (faultKind === 'forfeit-a') a.action = { type: 'run' };
        else if (faultKind === 'forfeit-b') b.action = { type: 'run' };
      }
      // randomise the next menu choice now and then (never override a pending forfeit)
      for (const s of [a, b]) if (R() < 0.1 && !s.dead && s.action.type !== 'run') s.action = R() < 0.15 ? { type: 'switch' } : { type: 'fight', slot: Math.floor(R() * 4) };
      return false;
    });
    const ra = a.task.value, rb = b.task.value;
    const valid = ['win', 'lose', 'draw'].includes(ra) && ['win', 'lose', 'draw'].includes(rb);
    // a drop mid-exchange partitions the games: the killed side's game may still settle the last fully-exchanged
    // turn for a real local result while the survivor wins by abandonment - both must simply reach a definite
    // result. Without a fault the results must be exact opposites (or both draw) and the HP must match.
    const consistent = faultKind.startsWith('kill') ? true :
      (ra === 'win' && rb === 'lose') || (ra === 'lose' && rb === 'win') || (ra === 'draw' && rb === 'draw') ||
      (faultKind.startsWith('forfeit') && ((ra === 'lose' && rb === 'win') || (ra === 'win' && rb === 'lose')));
    const same = hp(a, a.mine) === hp(b, b.foes) && hp(a, a.foes) === hp(b, b.mine);
    if (!r.done || !valid || !consistent || (!faultKind.startsWith('kill') && !same)) {
      bad++;
      const diag = s => {
        const scenes = s.G.engine.scenes.map(x => x.constructor.name).join('>');
        const bs = bscene(s), bb = battle(s);
        return s.name + ':[scenes ' + scenes + (bs && bs.menu ? ' menu=' + bs.menu.kind : '') + (bb ? ' turn=' + bb.turn + ' p.idx=' + bb.p.idx + ' e.idx=' + bb.e.idx : ' no-battle') +
          ' lost=' + !!s.link.lost + ' gone=' + !!s.link.gone + ' ended=' + JSON.stringify(s.link.ended) + ' inbox=' + s.link.inbox.length + ']';
      };
      console.log('fuzz battle', k, 'fault', faultKind, 'seed', seed, 'results', ra, rb, 'done', a.task.done, b.task.done, 'frames', r.frames, 'hp-match', same,
        '\n  ', diag(a), '\n  ', diag(b));
    }
  }
  report('fault-injection fuzz (' + n + ' battles)', bad === 0, bad + ' bad battles');
}

// ---------- main ----------
const which = process.argv[2];
if (which === 'fuzz') {
  fuzz(+(process.argv[3] || 30), process.argv[4] === undefined ? undefined : +process.argv[4]);
} else {
  scenNormal();
  scenForfeit();
  scenDropDuringReplace();
  scenReplaceThenDrop();
  scenDoubleFaint();
  scenDoubleFaintDraw();
  scenSilentDrop();
  scenGuestForfeit();
  scenHostDropDuringReplace();
  scenDoubleFaintDrop();
  scenDropMidTurn();
  scenCrashConsistency();
}
console.error = origErr;
if (errs.length) console.log('game errors during scenarios:\n' + [...new Set(errs)].slice(0, 10).join('\n'));
const failed = results.filter(r => !r.ok).length;
console.log(failed ? failed + ' scenario(s) FAILED' : 'all scenarios passed');
process.exit(failed || errs.length ? 1 : 0);
