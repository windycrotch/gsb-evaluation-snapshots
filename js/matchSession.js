// js/matchSession.js: the versus match protocol, on top of MatchState.
//
// This is the half of versus.js that talks to the network: it turns what the state machine reports into reliable
// messages, and it turns incoming reliable messages back into state changes. It deliberately has no THREE or DOM
// dependency, so test/ drives it with a fake clock and fake WebRTC connections (see test/fakeNet.mjs).
//
// Messages (all on the 'safe' reliable channel; net.js stamps each with an event id so a resend is handled once):
//   guest -> host  vdead  (I went down, killer, eid)      vresult (my final table)
//   host -> all    vpause / vresume, vscore, vover        vresult (relayed)
// The host decides a guest's pause, leave and the match end; a guest decides the host's pause/gone (it is the one
// that can see the host's snapshots stop arriving).

import { MatchState, ResultConsensus, EndReason, LeaveReason } from './matchState.js';

export class MatchSession {
  // net: a Net (js/net.js) or anything with send(peer, msg, reliable) / broadcast(msg, reliable, except)
  // opts: { isHost: () => boolean, peer: () => string }   (functions, so a reconnect or a rematch reads fresh)
  constructor(net, { isHost = () => false, peer = () => 'g', killsToWin = 5, stateOptions = null } = {}) {
    this.net = net;
    this._isHost = isHost;
    this._peer = peer;
    this.killsToWin = killsToWin;
    this.stateOptions = stateOptions;
    this.state = null;
    this.consensus = new ResultConsensus(2);
    this.onPause = null;          // (paused|null)
    this.onScore = null;          // (message)
    this.onOver = null;           // (over|message)
    this.onConsensus = null;      // (snapshot, result|null)
    this.onLeave = null;          // (peer, why, name)  — every leave/walk-out; the host frees the connection here
    this.onBegin = null;
    this.reset();
  }

  get isHost() { return !!this._isHost(); }
  get me() { return this.isHost ? 'h' : this._peer(); }

  reset() {
    this.state = new MatchState({ killsToWin: this.killsToWin, ...(this.stateOptions || {}) });
    this.consensus.reset();
    this._consensusStarted = false;
    this.match = null; this.ranked = false; this.why = '';
  }

  begin(players, info = {}) {
    this.reset();
    this.state.begin(players, info);
    this.match = this.state.match;
    this.ranked = this.state.ranked;
    this.why = this.state.why;
    if (this.onBegin) this.onBegin();
  }

  /* ---------------- views used by the game/HUD ---------------- */
  get over() { return this.state.isOver; }
  get overInfo() { return this.state.over; }
  get paused() { return this.state.paused; }
  get rows() { return this.state.players; }
  get phase() { return this.state.phase; }
  get timeLeft() { return this.state.timeLeft; }
  set timeLeft(v) { this.state.timeLeft = v; }
  row(peer) { return this.state.row(peer); }
  name(peer) { const r = this.row(peer); return r ? r.name : 'Someone'; }
  present(peer) { return this.state.present(peer); }
  standings() { return this.state.standings(); }

  // the connection to a peer failed or closed (net.js reports this for 'closed' too). For the host it is the same
  // rule as a pilot leaving: they are marked as having left on the table (last place), and the leave event reaches
  // versus.js's onLeave, which queues them for coop.releaseDropped — freeing their plane, lobby row and link, so no
  // ghost stays "in the room". For a guest, losing the host ends the match (the host is marked as having left).
  onPeerClosed(peer, state = 'closed') {
    if (this.over) return;
    if (this.present(peer)) this.leave(peer, LeaveReason.LEFT);   // idempotent: a second close event is a no-op
    // the guest's other guest links are the host's to manage
  }

  /* ---------------- outbound ---------------- */
  send(m) {
    if (this.isHost) this.net.broadcast(m, true);
    else this.net.send('h', m, true);
  }
  relay(m, except) { if (this.isHost) this.net.broadcast(m, true, except); }

  /* ---------------- the match clock and the pause rules ---------------- */
  advance(dt) { return this.state.advance(dt); }

  // quiet: Map peer -> seconds since their game last reported in. Applies the pause rules and sends what changed.
  observe(dt, quiet) {
    if (this.over) return false;
    for (const e of this.state.observe(dt, quiet)) this._event(e);
    return !!this.state.paused;
  }

  _event(e) {
    switch (e.type) {
      case 'pause':
        if (this.isHost) this.send({ t: 'vpause', peer: e.peer, name: e.name, left: Math.ceil(e.left) });
        if (this.onPause) this.onPause(this.state.paused);
        return;
      case 'resume':
        if (this.isHost) this.send({ t: 'vresume' });
        if (this.onPause) this.onPause(null);
        return;
      case 'leave':
        if (this.onLeave) this.onLeave(e.peer, e.why, e.name);
        if (this.isHost) this.send({ t: 'vscore', rows: this.state.players.map(x => ({ ...x })), tl: round1(this.state.timeLeft), f: leaveText(e), v: null, k: null });
        if (this.onScore) this.onScore({ t: 'vscore', rows: this.state.players.map(x => ({ ...x })), f: leaveText(e), v: null, k: null });
        return;
      case 'over':
        if (this.isHost) this.send({ t: 'vover', rows: e.rows, match: e.match, ranked: e.ranked, why: e.why, reason: e.reason });
        if (this.onOver) this.onOver(this.state.over);
        this._startConsensus();
        return;
    }
  }

  /* ---------------- scoring ---------------- */
  // victim went down (host only). eid makes a resent reliable message count once.
  score(victim, killer, cause, eid = null) {
    if (this.over) return { applied: false };
    const r = this.state.score(victim, killer, cause, eid);
    if (!r.applied) return r;
    const msg = { t: 'vscore', rows: this.state.players.map(x => ({ ...x })), tl: round1(this.state.timeLeft), f: r.feed, v: victim, k: r.killer };
    this.send(msg);
    this._applyScore(msg);
    const k = r.killer ? this.row(r.killer) : null;
    if (k && k.kills >= this.killsToWin) this.finish(EndReason.KILLS);
    return r;
  }

  _applyScore(m) {
    this.state.applyTable(m.rows, m.tl);
    if (this.onScore) this.onScore(m);
    // the host took me out (my game was in the background too long): the match is over for me
    const mine = this.row(this.me);
    if (mine && mine.left && !this.over && !this.isHost) {
      this.state.finish(EndReason.LEFT, { peer: this.me });
      if (this.onOver) this.onOver(this.state.over);
      this._startConsensus();
    }
  }

  /* ---------------- leaving and ending ---------------- */
  leave(peer, why = LeaveReason.LEFT) {
    if (this.over) return;
    for (const e of this.state.playerLeft(peer, why)) this._event(e);
  }

  finish(reason) {
    if (this.over) return;
    this._resetConsensus();                 // before anyone can report: a report may arrive synchronously mid-send
    this.state.finish(reason);
    const o = this.state.over;
    if (this.isHost) this.send({ t: 'vover', rows: o.rows, match: o.match, ranked: o.ranked, why: o.why, reason: o.reason });
    if (this.onOver) this.onOver(o);
    this._startConsensus();
  }

  applyOver(m) {
    if (this.over) return;
    this._resetConsensus();
    this.state.applyOver(m);
    if (this.onOver) this.onOver(this.state.over);
    this._startConsensus();
  }

  _resetConsensus() {
    if (this._consensusStarted) return;
    this._consensusStarted = true;
    this.consensus.reset();
  }

  /* ---------------- result confirmation ----------------
     Only pilots still in the match confirm; the result counts once two send the same final table. A lone remaining
     pilot's report stays 'pending' (nobody to agree with), and a disagreement stays 'disputed'. */
  _startConsensus() {
    this._resetConsensus();
    const mine = this.row(this.me);
    if (!mine || mine.left) return;                 // a pilot who left does not get a say
    this.consensus.report(this.me, this.standings());
    this.send({ t: 'vresult', rows: this.standings() });
    this._notifyConsensus();
  }
  _notifyConsensus() {
    if (this.onConsensus) this.onConsensus(this.consensus.snapshot(), this.consensus.result);
  }
  onResult(from, rows) {
    if (!Array.isArray(rows)) return;
    if (!this.present(from)) return;                // someone who left cannot confirm the result
    if (!this.over) return;
    const r = this.consensus.report(from, rows);
    this.relay({ t: 'vresult', rows }, from);
    this._notifyConsensus();
    return r;
  }

  // the table the rating server needs: [{ id, kills, deaths, left }] (null if someone has no pilot id)
  result() {
    if (!this.over || this.state.over.rows.some(r => !r.lbId)) return null;
    return this.state.over.rows.map(r => ({ id: r.lbId, kills: r.kills, deaths: r.deaths, left: !!r.left }));
  }

  /* ---------------- inbound ---------------- */
  // returns true when the message belonged to the match protocol
  handle(from, m) {
    switch (m.t) {
      case 'vpause':
        if (this.isHost || this.over) return true;
        this.state.setPaused({ peer: m.peer, name: m.name, left: m.left });
        if (this.onPause) this.onPause(this.state.paused);
        return true;
      case 'vresume':
        if (this.isHost || this.over) return true;
        this.state.setPaused(null);
        if (this.onPause) this.onPause(null);
        return true;
      case 'vdead':
        if (this.isHost) this.score(from, m.k, m.c, m.eid ?? null);
        return true;
      case 'vscore':
        if (!this.isHost) this._applyScore(m);
        return true;
      case 'vover':
        if (!this.isHost) this.applyOver(m);
        return true;
      case 'vresult':
        this.onResult(from, m.rows);
        return true;
    }
    return false;
  }
}

const round1 = v => Math.round(v * 10) / 10;
function leaveText(e) {
  const n = e.name || 'A pilot';
  return e.why === LeaveReason.AWAY ? `${n} stopped responding (counts as a loss)`
    : e.why === LeaveReason.BUDGET ? `${n} paused too long in total (counts as a loss)`
    : `${n} left (counts as a loss)`;
}
