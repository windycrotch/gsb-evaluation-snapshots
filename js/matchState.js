// js/matchState.js: the one state machine for how an online versus match starts, pauses, loses players and ends.
//
// Before this file, the rules were spread over coop.js (detecting a quiet game, counting pause time, dropping a
// player, the host's own disappearance) and versus.js (rows, clock, leaving, final table). Every path that could
// end or freeze a match was written in a different place. Now every one of them goes through MatchState:
//
//   live --(a pilot's game goes quiet)--> paused --(they come back)--> live
//                                          |--(awayLimit / pauseBudget)--> that pilot left (last place)
//   live/paused --(host gone, kills, time, all but one left)--> over
//
// The class has no browser dependencies (no THREE, no DOM, no timers). The game drives it with the real clock and
// the real net; test/matchState.test.mjs drives the same code with a fake clock and fake links.
//
// "Quiet" means: no state update from that pilot's game loop for N seconds. A background tab stops its loop, so the
// host measures each guest's quiet, and every guest measures the host's. Only the host decides a guest's pause; only
// the guest decides that the host is gone.
//
// All transitions return plain event objects ({ type: 'pause' | 'resume' | 'leave' | 'over', ... }) so the caller
// (versus.js) decides what to send and what to show. That keeps "what happened" separate from "how it travels".

export const Phase = Object.freeze({ LIVE: 'live', PAUSED: 'paused', OVER: 'over' });
export const EndReason = Object.freeze({
  KILLS: 'kills',          // someone reached the kill count
  TIME: 'time',            // the clock ran out
  LEFT: 'left',            // all but one pilot left
  HOST_LEFT: 'hostLeft',   // the host's game is gone: the match is over for everyone still there
});
export const LeaveReason = Object.freeze({
  LEFT: 'left',            // closed the tab / pressed leave
  AWAY: 'away',            // backgrounded longer than awayLimit
  BUDGET: 'budget',        // used up pauseBudget across the match
});

const clamp0 = v => (v > 0 ? v : 0);

// a random id for one match (the rating server needs two players to report the same id)
export function newMatchId() {
  const b = new Uint8Array(8);
  const c = globalThis.crypto;
  if (c && c.getRandomValues) c.getRandomValues(b);
  else for (let i = 0; i < 8; i++) b[i] = Math.floor(Math.random() * 256);
  return [...b].map(x => x.toString(16).padStart(2, '0')).join('');
}

// Final order: anyone who left is last; then most kills, then fewest deaths; equal rows share a place.
// (The rating server ranks the same way.) Mutates `place` on the rows and returns them in order.
export function rankRows(rows) {
  const L = r => (r.left ? 1 : 0);
  const order = [...rows].sort((a, b) => L(a) - L(b) || b.kills - a.kills || a.deaths - b.deaths);
  order.forEach((r, i) => {
    const prev = order[i - 1];
    r.place = prev && L(prev) === L(r) && prev.kills === r.kills && prev.deaths === r.deaths ? prev.place : i + 1;
  });
  return order;
}

export class MatchState {
  // opts = { quietAfter, awayLimit, pauseBudget, timeLimit, killsToWin, hostPeer }
  constructor(opts = {}) {
    this.cfg = {
      quietAfter: 2, awayLimit: 30, pauseBudget: 60,
      timeLimit: 300, killsToWin: 5, hostPeer: 'h',
      ...opts,
    };
    this.reset();
  }

  reset() {
    this.players = [];
    this.paused = null;              // { peer, name, left } | null
    this.pauseUsed = new Map();      // peer -> seconds of pause they caused this match
    this.timeLeft = this.cfg.timeLimit;
    this.match = null;
    this.ranked = false;
    this.why = '';
    this.over = null;                // { reason, rows, match, ranked, why } | null
    this._scored = new Set();        // event ids of kills already counted (reliable resends must not score twice)
    return this;
  }

  begin(players = [], info = {}) {
    this.reset();
    this.players = players.map(p => ({
      peer: p.peer, name: p.name || 'Pilot',
      lbId: Number.isInteger(p.lbId) ? p.lbId : null,
      kills: 0, deaths: 0, left: false, leftWhy: null, place: 0,
    }));
    this.match = info.match || newMatchId();
    this.ranked = !!info.ranked;
    this.why = info.why || '';
    return this;
  }

  /* ---------------- roster ---------------- */
  // the phase is derived, never stored: a match is over if it has an end, paused if a pilot froze it, live otherwise.
  // (One source of truth means no path can leave the clock running while paused, or a pause labelled live.)
  get phase() { return this.over ? Phase.OVER : this.paused ? Phase.PAUSED : Phase.LIVE; }
  row(peer) { return this.players.find(r => r.peer === peer); }
  activePlayers() { return this.players.filter(r => !r.left); }
  present(peer) { const r = this.row(peer); return !!r && !r.left; }
  get isOver() { return this.phase === Phase.OVER; }
  get pausedBy() { return this.paused ? this.paused.peer : null; }

  // the final order, as copies (places filled in)
  standings() { return rankRows(this.players.map(r => ({ ...r }))); }

  /* ---------------- the match clock ---------------- */
  // advances only while the match is live: a pause freezes the clock for everyone
  advance(dt) {
    if (this.phase === Phase.OVER) return this.timeLeft;
    if (this.phase === Phase.LIVE) this.timeLeft = clamp0(this.timeLeft - dt);
    return this.timeLeft;
  }

  /* ---------------- pause / away / budget (host for guests, guest for the host) ---------------- */
  // quiet: Map peer -> seconds since that pilot's game last reported in. Only watched peers may be paused.
  // Returns events; the caller turns them into reliable messages.
  observe(dt, quiet = new Map()) {
    const out = [];
    if (this.phase === Phase.OVER) return out;

    if (this.paused) {
      const p = this.paused;
      // the pilot who caused the pause is no longer on the table (their link closed): lift the freeze
      const pr = this.row(p.peer);
      if (!pr || pr.left) {
        this.paused = null;
        out.push({ type: 'resume' });
        return out;
      }
      // a paused pilot's own countdown is only the watcher's to run; but a *different* watched pilot going silent
      // for awayLimit (the host, from a guest's point of view) still ends the match: without them nothing continues
      for (const [peer, q] of quiet) {
        if (peer === p.peer || q <= this.cfg.awayLimit) continue;
        this.paused = null;
        out.push({ type: 'resume' });
        out.push(...this._giveUp(peer, LeaveReason.AWAY));
        return out;
      }
      // a pause we did not cause is not ours to lift (the host announces a guest's pause to everyone)
      if (!quiet.has(p.peer)) return out;
      const q = quiet.get(p.peer) || 0;
      if (q <= this.cfg.quietAfter) {
        this.paused = null;
        out.push({ type: 'resume' });
        return out;
      }
      const before = Math.ceil(p.left);
      const used = (this.pauseUsed.get(p.peer) || 0) + dt;
      this.pauseUsed.set(p.peer, used);
      const left = clamp0(Math.min(this.cfg.awayLimit - q, this.cfg.pauseBudget - used));
      p.left = left;
      if (Math.ceil(left) !== before) out.push({ type: 'pause', peer: p.peer, name: p.name, left });
      if (left <= 0) {
        const why = this.cfg.pauseBudget - used <= this.cfg.awayLimit - q ? LeaveReason.BUDGET : LeaveReason.AWAY;
        this.paused = null;
        out.push({ type: 'resume' });
        out.push(...this._giveUp(p.peer, why));
      }
      return out;
    }

    // nobody paused: the quietest watched pilot, if anyone is past the grace period, pauses the match
    let who = null, quietest = 0;
    for (const pl of this.players) {
      if (pl.left) continue;
      const q = quiet.get(pl.peer);
      if (q === undefined || q <= this.cfg.quietAfter) continue;
      if (q > quietest) { who = pl; quietest = q; }
    }
    if (!who) return out;

    const used = this.pauseUsed.get(who.peer) || 0;
    const left = clamp0(Math.min(this.cfg.awayLimit - quietest, this.cfg.pauseBudget - used));
    this.paused = { peer: who.peer, name: who.name, left };
    out.push({ type: 'pause', peer: who.peer, name: who.name, left });
    if (left <= 0) {
      this.paused = null;
      out.push({ type: 'resume' });
      out.push(...this._giveUp(who.peer, this.cfg.pauseBudget - used <= this.cfg.awayLimit - quietest ? LeaveReason.BUDGET : LeaveReason.AWAY));
    }
    return out;
  }

  // apply a pause the host announced (guests) or lift it
  setPaused(p) { this.paused = p ? { ...p } : null; }

  // a pilot left or was given up on: marked as left (placed last), never silently removed from the table.
  // The host leaving ends the whole match instead.
  playerLeft(peer, why = LeaveReason.LEFT) {
    if (this.phase === Phase.OVER) return [];
    return this._giveUp(peer, why);
  }

  _giveUp(peer, why) {
    const out = [];
    const r = this.row(peer);
    if (!r || r.left) return out;
    // the pilot who froze the match is gone: the freeze goes with them, for everyone
    if (this.paused && this.paused.peer === peer) {
      this.paused = null;
      out.push({ type: 'resume' });
    }
    r.left = true;
    r.leftWhy = why;
    out.push({ type: 'leave', peer, name: r.name, why });
    // the host leaving ends the whole match (marked as last: the pilot who abandoned it cannot win it)
    if (peer === this.cfg.hostPeer) { out.push(this._finish(EndReason.HOST_LEFT, { peer })); return out; }
    if (this.activePlayers().length <= 1) out.push(this._finish(EndReason.LEFT));
    return out;
  }

  /* ---------------- scoring ---------------- */
  // victim went down on the host's screen; killer may be null. eid makes the call idempotent, so a reliable
  // message that arrives twice (a resend, a relay) can never add a second death or kill.
  score(victim, killer, cause = '', eid = null) {
    if (this.phase === Phase.OVER) return { applied: false, reason: 'over' };
    if (eid != null) {
      const key = `score:${eid}`;
      if (this._scored.has(key)) return { applied: false, duplicate: true };
      this._scored.add(key);
    }
    const v = this.row(victim);
    if (!v) return { applied: false, unknown: true };
    v.deaths++;
    const k = killer && killer !== victim ? this.row(killer) : null;
    if (k) k.kills++;
    const feed = k ? `${k.name} shot down ${v.name}`
      : `${v.name} ${cause === 'TERRAIN' || cause === 'TREE' ? 'crashed' : 'went down'}`;
    return { applied: true, feed, killer: k ? k.peer : null };
  }

  // the whole table as the host sent it: idempotent (it replaces, never adds)
  applyTable(rows, timeLeft) {
    if (Array.isArray(rows)) this.players = rows.map(r => ({ ...r }));
    if (typeof timeLeft === 'number') this.timeLeft = timeLeft;
  }

  /* ---------------- ending ---------------- */
  // reason: EndReason. Returns the over object, or the existing one if the match already ended.
  finish(reason) {
    if (this.phase === Phase.OVER) return this.over;
    return this._finish(reason);
  }

  _finish(reason, extra = {}) {
    const over = {
      reason,
      rows: this.standings(),
      match: this.match,
      ranked: this.ranked,
      why: this.why,
      ...extra,
    };
    return this.applyOver(over);
  }

  applyOver(m) {
    this.paused = null;
    if (Array.isArray(m.rows)) this.players = m.rows.map(r => ({ ...r }));
    this.over = {
      reason: m.reason,
      rows: this.players.map(r => ({ ...r })),
      match: m.match ?? this.match,
      ranked: m.ranked ?? this.ranked,
      why: m.why ?? this.why,
    };
    return this.over;
  }

  // what the HUD can always show: the phase, who has the match paused and how long they have
  status() {
    return {
      phase: this.phase,
      paused: this.paused ? { ...this.paused } : null,
      timeLeft: this.timeLeft,
      active: this.activePlayers().length,
      rows: this.standings(),
      over: this.over,
    };
  }
}

/* ================= Settlement: a result counts only when two pilots agree =================
   A finished match is not a win until two of the pilots who report it send the same final table. If reports
   disagree the result stays pending; nothing is decided on one pilot's word. This mirrors the rating server
   (which only applies a result when two pilots agree) and is what the final screen shows. */
export class ResultConsensus {
  constructor(minAgree = 2) {
    this.minAgree = minAgree;
    this.reset();
  }
  reset() {
    this.reports = new Map();        // peer -> canonical key
    this.tables = new Map();         // canonical key -> rows
    this.status = 'pending';         // 'pending' | 'agreed' | 'disputed'
    this.result = null;
    return this;
  }

  static key(rows) {
    return JSON.stringify(rows
      .map(r => ({ p: String(r.peer), k: r.kills | 0, d: r.deaths | 0, l: r.left ? 1 : 0 }))
      .sort((a, b) => (a.p < b.p ? -1 : a.p > b.p ? 1 : 0)));
  }

  // one pilot's final table. Returns { status, agree, reports, changed }.
  report(peer, rows) {
    if (!Array.isArray(rows)) return this.snapshot();
    const key = ResultConsensus.key(rows);
    this.reports.set(peer, key);
    this.tables.set(key, rows.map(r => ({ ...r })));
    const counts = new Map();
    for (const k of this.reports.values()) counts.set(k, (counts.get(k) || 0) + 1);
    let best = null, agree = 0;
    for (const [k, n] of counts) if (n > agree) { agree = n; best = k; }
    const prev = this.status;
    this.disputed = counts.size > 1;
    if (agree >= this.minAgree) {
      this.status = 'agreed';
      this.result = (this.tables.get(best) || []).map(r => ({ ...r }));
    } else {
      this.status = this.disputed ? 'disputed' : 'pending';
      this.result = null;
    }
    return { ...this.snapshot(), changed: prev !== this.status };
  }

  snapshot() { return { status: this.status, agree: this._agree(), reports: this.reports.size, need: this.minAgree, disputed: !!this.disputed }; }
  _agree() {
    const counts = new Map();
    for (const k of this.reports.values()) counts.set(k, (counts.get(k) || 0) + 1);
    return counts.size ? Math.max(...counts.values()) : 0;
  }
}
