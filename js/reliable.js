// js/reliable.js: exactly-once delivery for reliable events.
//
// The 'safe' data channel is ordered and reliable, but a message can still reach the application twice:
// a sender may resend an event it is not sure about (a leave, a result, a pause), and a relay (host passing a
// guest's message on) can duplicate what a guest already got. Every reliable event therefore carries an id,
// and the receiver drops an id it has already handled. That is what keeps "one death = one death" even when
// the same 'vdead' arrives twice.
//
// This module has no browser dependencies, so the acceptance tests drive it with fake connections.

export class ReliableGuard {
  constructor(prefix = '') {
    this.prefix = prefix;
    this.seq = 0;
    this.seen = new Set();
    this.limit = 4096;
  }

  // unique for this connection session: <room>:<sender>:<counter>
  stamp(msg) {
    if (!msg || typeof msg !== 'object') return msg;
    if (msg.eid == null) msg.eid = `${this.prefix}${++this.seq}`;
    return msg;
  }

  // true = first time this sender's event id is seen (handle it); false = a duplicate (ignore it)
  accept(msg, from) {
    if (!msg || typeof msg !== 'object' || msg.eid == null) return true;
    const key = `${from}\u0000${msg.eid}`;
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    if (this.seen.size > this.limit) {
      // Set keeps insertion order: forget the oldest half, never the recent ids that may still be resent
      const drop = this.seen.size - (this.limit >> 1);
      let n = 0;
      for (const k of this.seen) { if (n++ >= drop) break; this.seen.delete(k); }
    }
    return true;
  }

  reset(prefix = this.prefix) {
    this.prefix = prefix;
    this.seq = 0;
    this.seen.clear();
  }
}
