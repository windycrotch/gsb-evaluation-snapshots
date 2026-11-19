// test/fakeNet.mjs: a fake WebRTC hub + fake clock for driving the versus match rules without a browser.
//
// Every simulated player gets a MatchSession wired to a FakeLink. Messages travel through the hub the way the real
// game routes them (guest -> host -> everyone else), and each one is stamped on the 'safe' channel exactly like
// js/net.js does, so a duplicate send really is a duplicate reliable event as far as the rules are concerned.

import { MatchSession } from '../js/matchSession.js';
import { ReliableGuard } from '../js/reliable.js';

export class FakeClock {
  constructor(dt = 0.1) { this.t = 0; this.dt = dt; }
  step(n = 1) { this.t += this.dt * n; return this.dt * n; }
}

// One end of the connection. `peer` receives, `toHost` is true on a guest link.
class FakeLink {
  constructor(hub, from, to) { this.hub = hub; this.from = from; this.to = to; this.off = false; }
  send(_peer, msg, reliable = false) { return this.hub.route(this.from, this.to, msg, reliable); }
  broadcast(msg, reliable = false, except = null) { return this.hub.broadcast(this.from, msg, reliable, except); }
}

export class FakeHub {
  constructor(clock, { dropDuplicates = true } = {}) {
    this.clock = clock;
    this.dropDuplicates = dropDuplicates;
    this.guards = new Map();        // sender -> ReliableGuard
    this.guardAtReceiver = new Map(); // receiver peer -> ReliableGuard (the real net.js guard)
    this.sessions = new Map();      // peer -> MatchSession
    this.log = [];
    this.cut = new Set();           // peers whose link is dead
  }

  link(peer) { return new FakeLink(this, peer, null); }

  add(peer, { isHost = false, players, info = {}, killsToWin = 5 } = {}) {
    const link = this.link(peer);
    const s = new MatchSession(link, { isHost: () => isHost, peer: () => peer, killsToWin });
    s._hubPeer = peer;
    s._hubHost = isHost;
    this.sessions.set(peer, s);
    this.guards.set(peer, new ReliableGuard(`${peer}:`));
    this.guardAtReceiver.set(peer, new ReliableGuard());
    if (players) s.begin(players, info);
    return s;
  }

  _stamp(from, msg, reliable) {
    if (!reliable) return { ...msg };
    const out = { ...msg };
    this.guards.get(from).stamp(out);
    out.r = 1;
    return out;
  }

  // a link's send(): a guest's traffic goes to the host, the host's goes to every guest.
  route(from, _to, msg, reliable) {
    if (from === 'h') return this.broadcast(from, msg, reliable);
    const out = this._stamp(from, msg, reliable);
    this._deliver('h', out, from);
    return true;
  }

  broadcast(from, msg, reliable, except = null) {
    const out = this._stamp(from, msg, reliable);
    for (const peer of this.sessions.keys()) {
      if (peer === from || peer === except) continue;
      this._deliver(peer, { ...out }, from);
    }
    return true;
  }

  _deliver(peer, msg, from) {
    if (this.cut.has(peer)) return;
    const s = this.sessions.get(peer);
    if (!s) return;
    this.log.push({ to: peer, from, t: msg.t, msg });
    if (msg && msg.r === 1 && this.dropDuplicates) {
      const g = this.guardAtReceiver.get(peer);
      if (!g.accept(msg, from)) { this.log.push({ to: peer, from, t: msg.t, dropped: true }); return; }
    }
    if (s.handle(from, msg)) return;
  }

  // resend a reliable message verbatim (same id) straight into one receiver, to prove duplicates score once
  duplicateTo(peer, from, msg) {
    const out = { ...msg };
    this._deliver(peer, out, from);
  }

  // drop a guest's connection: the host sees that peer's link fail, and must free the resources
  disconnectGuest(guest, host = 'h') {
    this.cut.add(guest);
    const h = this.sessions.get(host);
    if (h) h.onPeerClosed(guest, 'failed');
  }
}
