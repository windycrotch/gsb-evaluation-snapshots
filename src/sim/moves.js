// Move data. All times are seconds from the start of the move.
//
//  lunge: [{t0, t1, v}]            forward speed window
//  hits:  [{t0, t1, fwd, up, r,    hit sphere (relative to the fighter, along its facing)
//           dmg, kb, stun, stop,   kb = grounded slide speed; stop = hitstop seconds
//           launch: [fwd, up],     sends the target airborne
//           guard, kind, wall}]    guard = extra stamina damage on block
//  chain: {at, L, H}               earliest cancel time and what LIGHT / HEAVY cancel into
//  ev:    [{t, type, ...}]         timed events handled by the world (projectiles, zones, beam)
//
// Both fighters share the same move list (so the control scheme is identical) with their own
// timings, numbers and elemental flavour.

export const CHARS = {
  clawd: {
    name: 'Clawd',
    element: 'fire',
    speed: 7.4,
    jump: 15.5,
    dash: 25,
    dmg: 1.08,
    def: 0.94, // damage taken multiplier
    reach: 0.25,
    poise: 0.8, // hitstun multiplier: the heavy body shrugs hits off sooner
    tempo: 1.0, // time scale of normals (lower = faster)
    blurb: 'Heavy hitter. Armoured smashes, magma eruptions.',
    moves: { s1: 'Ember Volley', s2: 'Eruption', ult: 'Solar Flare' },
  },
  codex: {
    name: 'Codex',
    element: 'volt',
    speed: 9.0,
    jump: 16.5,
    dash: 28,
    dmg: 0.96,
    def: 1.0,
    reach: 0,
    poise: 1.0,
    tempo: 0.92,
    blurb: 'Fast and evasive. Lances, storm strikes.',
    moves: { s1: 'Prompt Lance', s2: 'Storm Call', ult: 'Overclock' },
  },
};

export const ULT = { charge: 0.95, beam: 1.8, recover: 0.42, radius: 1.3, tick: 0.085, dmg: 1.95 };
ULT.dur = ULT.charge + ULT.beam + ULT.recover;

function normals(k) {
  // k: tempo multiplier
  const t = (x) => +(x * k).toFixed(4);
  return {
    L1: {
      dur: t(0.34), track: t(0.1), lunge: [{ t0: t(0.03), t1: t(0.14), v: 8.5 }],
      hits: [{ t0: t(0.09), t1: t(0.18), fwd: 1.45, up: 1.05, r: 1.2, dmg: 3.5, kb: 5.5, stun: 0.34, stop: 0.05, kind: 'light' }],
      chain: { at: t(0.19), L: 'L2', H: 'H' }, hand: 1,
    },
    L2: {
      dur: t(0.36), track: t(0.1), lunge: [{ t0: t(0.03), t1: t(0.15), v: 8.5 }],
      hits: [{ t0: t(0.1), t1: t(0.19), fwd: 1.45, up: 1.05, r: 1.2, dmg: 3.5, kb: 5.5, stun: 0.36, stop: 0.05, kind: 'light' }],
      chain: { at: t(0.2), L: 'L3', H: 'H' }, hand: -1,
    },
    L3: {
      dur: t(0.48), track: t(0.12), lunge: [{ t0: t(0.05), t1: t(0.22), v: 9.5 }],
      hits: [{ t0: t(0.14), t1: t(0.27), fwd: 1.1, up: 1.05, r: 1.7, dmg: 4.6, kb: 7, stun: 0.42, stop: 0.07, kind: 'light' }],
      chain: { at: t(0.29), L: 'L4', H: 'H' }, hand: 0,
    },
    L4: {
      dur: t(0.62), track: t(0.16), lunge: [{ t0: t(0.08), t1: t(0.22), v: 7.5 }],
      hits: [{ t0: t(0.2), t1: t(0.31), fwd: 1.4, up: 1.3, r: 1.45, dmg: 5.6, launch: [3.2, 17], stun: 0.5, stop: 0.1, kind: 'heavy' }],
      jumpCancel: t(0.33), hand: 0,
    },
    H: {
      dur: t(0.78), track: t(0.24), armor: [t(0.08), t(0.44)], lunge: [{ t0: t(0.26), t1: t(0.43), v: 21 }],
      hits: [{ t0: t(0.28), t1: t(0.45), fwd: 1.4, up: 1.1, r: 1.55, dmg: 10.5, launch: [17, 8.5], stun: 0.6, stop: 0.13, guard: 42, kind: 'heavy', wall: true }],
      hand: 0,
    },
    DA: {
      dur: t(0.44), track: 0, lunge: [{ t0: 0, t1: t(0.2), v: 22 }],
      hits: [{ t0: t(0.05), t1: t(0.22), fwd: 1.3, up: 1.05, r: 1.4, dmg: 5, launch: [9, 6.5], stun: 0.4, stop: 0.07, kind: 'heavy' }],
      hand: 1,
    },
    AL: {
      dur: t(0.3), air: true, track: t(0.08), lunge: [{ t0: 0, t1: t(0.1), v: 7 }],
      hits: [{ t0: t(0.07), t1: t(0.17), fwd: 1.3, up: 1.0, r: 1.45, dmg: 3.8, launch: [3.2, 8], stun: 0.4, stop: 0.05, kind: 'light' }],
      chain: { at: t(0.18), L: 'AL', H: 'AH' }, hand: 1,
    },
    AH: {
      dur: 1.2, air: true, track: t(0.14), dive: t(0.16), landRecover: 0.36,
      hits: [{ t0: t(0.16), t1: 1.2, fwd: 0.7, up: 0.5, r: 1.5, dmg: 5, launch: [4, -32], stun: 0.5, stop: 0.08, kind: 'heavy', bounce: true }],
      slam: { r: 3.5, dmg: 7, launch: [6, 13.5], stop: 0.12 },
      hand: 0,
    },
  };
}

function build(char) {
  const k = CHARS[char].tempo;
  const m = normals(k);
  if (char === 'clawd') {
    m.S1 = {
      dur: 0.8, track: 0.5, cd: 3.2,
      ev: [0.22, 0.34, 0.46].map((t, i) => ({ t, type: 'proj', kind: 'ember', spread: [0, 0.13, -0.13][i], speed: 31, r: 0.5, dmg: 4.6, launch: null, kb: 6, stun: 0.34, life: 1.5, homing: 0.5 })),
      hand: 0,
    };
    m.S2 = {
      dur: 0.98, track: 0.3, cd: 7.5, armor: [0.1, 0.5],
      hits: [{ t0: 0.36, t1: 0.46, fwd: 0.6, up: 0.6, r: 2.5, dmg: 5, launch: [5, 12], stun: 0.5, stop: 0.09, kind: 'special' }],
      ev: [{ t: 0.36, type: 'erupt', count: 5, first: 3.4, gap: 2.9, delay: 0.1, step: 0.105, r: 1.8, dmg: 6.5, launch: [3, 16] }],
      hand: 0,
    };
  } else {
    m.S1 = {
      dur: 0.62, track: 0.4, cd: 2.8,
      ev: [0.18, 0.36].map((t, i) => ({ t, type: 'proj', kind: 'lance', spread: [0.03, -0.03][i], speed: 54, r: 0.42, dmg: 5.4, kb: 7, stun: 0.36, life: 1.1, homing: 1.3 })),
      hand: 1,
    };
    m.S2 = {
      dur: 0.74, track: 0.3, cd: 7.0,
      ev: [{ t: 0.3, type: 'storm', count: 3, delay: 0.55, step: 0.3, r: 2.1, dmg: 7, lead: 0.32, launch: [2, 12] }],
      hand: 0,
    };
  }
  m.ULT = {
    dur: ULT.dur, track: ULT.charge, ult: true,
    ev: [{ t: 0, type: 'ult_start' }, { t: ULT.charge, type: 'beam_start' }, { t: ULT.charge + ULT.beam, type: 'beam_end' }],
    hand: 0,
  };
  for (const id in m) m[id].id = id;
  return m;
}

export const MOVES = { clawd: build('clawd'), codex: build('codex') };
