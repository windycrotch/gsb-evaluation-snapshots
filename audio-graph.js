import { normalizeDelay, MAX_DELAY } from "./shared.js";

// One output path only: source -> DelayNode -> GainNode -> destination.
// Never connect the source directly to the destination.
export class DelayGraph {
  constructor(context, source, initialDelay, destination = context.destination) {
    this.context = context;
    this.source = source;
    this.delay = context.createDelay(MAX_DELAY);
    this.gain = context.createGain();
    this.target = normalizeDelay(initialDelay);
    this.startedAt = context.currentTime;
    this.transition = { from: this.target, to: this.target, start: this.startedAt, end: this.startedAt };
    this.resumeAt = this.startedAt;
    this.settledAt = this.startedAt;
    // Set the initial delay BEFORE connecting live input, avoiding a dry burst.
    this.delay.delayTime.setValueAtTime(this.target, this.startedAt);
    this.gain.gain.setValueAtTime(1, this.startedAt);
    source.connect(this.delay);
    this.delay.connect(this.gain);
    this.gain.connect(destination);
  }

  tapAt(time) {
    const { from, to, start, end } = this.transition;
    if (time < start) return from;
    if (time >= end) return to;
    return from + (to - from) * ((time - start) / (end - start));
  }

  setDelay(value) {
    const next = normalizeDelay(value);
    if (next === this.target) return next;
    const now = this.context.currentTime;
    const previous = this.tapAt(now);
    const param = this.delay.delayTime;
    param.cancelScheduledValues(now);
    param.setValueAtTime(previous, now);
    const gain = this.gain.gain;
    gain.cancelAndHoldAtTime(now);
    const muteAt = now + 0.02;
    gain.linearRampToValueAtTime(0, muteAt);
    if (next > previous) {
      // Increase delay ONLY while output is silent. A slope of 1 holds the read
      // position still while incoming audio continues filling the buffer.
      const end = muteAt + next - previous;
      param.setValueAtTime(previous, muteAt);
      param.linearRampToValueAtTime(next, end);
      this.transition = { from: previous, to: next, start: muteAt, end };
      this.resumeAt = end + 0.02;
    } else {
      // Jump forward in the existing buffer while silent, at normal speed.
      // A new setting also cancels the scheduled pause/resume of an older one.
      const jumpAt = muteAt + 0.01;
      param.setValueAtTime(next, jumpAt);
      this.transition = { from: previous, to: next, start: jumpAt, end: jumpAt };
      this.resumeAt = muteAt + 0.03;
    }
    this.settledAt = this.resumeAt + 0.02;
    gain.setValueAtTime(0, this.resumeAt);
    gain.linearRampToValueAtTime(1, this.settledAt);
    this.target = next;
    return next;
  }

  timing() {
    const now = this.context.currentTime;
    return {
      // Audio-clock estimate only, NOT an end-to-end measured latency.
      bufferRemaining: Math.max(0, this.tapAt(now) - (now - this.startedAt)),
      pauseRemaining: this.transition.end > this.transition.start ? Math.max(0, this.resumeAt - now) : 0,
      transitionRemaining: Math.max(0, this.settledAt - now),
    };
  }

  disconnect() {
    // Silence delayed tail before releasing capture (which restores Chrome audio).
    this.gain.gain.cancelScheduledValues(this.context.currentTime);
    this.gain.gain.setValueAtTime(0, this.context.currentTime);
    this.gain.disconnect();
    this.source.disconnect();
    this.delay.disconnect();
  }
}
