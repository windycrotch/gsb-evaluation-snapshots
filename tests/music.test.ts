import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';
import { RallyMusic, MUSIC_BPM, MUSIC_TITLE, type MusicMode } from '../src/music';
import { arpMidiAt, bassForBar, chordAtBar, leadForBar, menuForBar, midiFrequency, SCORE_BARS } from '../src/music-score';

class MockParam {
  value = 0;
  readonly events: { method: string; value: number; time: number }[] = [];
  setValueAtTime(value: number, time: number): void { this.record('set', value, time); }
  setTargetAtTime(value: number, time: number, constant: number): void {
    assert.ok(Number.isFinite(constant) && constant > 0);
    this.record('target', value, time);
  }
  exponentialRampToValueAtTime(value: number, time: number): void {
    assert.ok(value > 0, 'exponential envelopes never reach zero/negative values');
    this.record('exponential', value, time);
  }
  cancelAndHoldAtTime(time: number): void { assert.ok(Number.isFinite(time) && time >= 0); }
  cancelScheduledValues(time: number): void { assert.ok(Number.isFinite(time) && time >= 0); }
  private record(method: string, value: number, time: number): void {
    assert.ok(Number.isFinite(value), `${method}: finite audio parameter`);
    assert.ok(Number.isFinite(time) && time >= 0, `${method}: nonnegative finite time`);
    this.value = value;
    this.events.push({ method, value, time });
  }
}

class MockNode {
  readonly gain = new MockParam();
  readonly frequency = new MockParam();
  readonly detune = new MockParam();
  readonly Q = new MockParam();
  readonly pan = new MockParam();
  readonly delayTime = new MockParam();
  readonly threshold = new MockParam();
  readonly knee = new MockParam();
  readonly ratio = new MockParam();
  readonly attack = new MockParam();
  readonly release = new MockParam();
  readonly connections = new Set<unknown>();
  type = '';
  buffer: unknown = null;
  disconnected = false;
  constructor(readonly context: MockContext) { context.nodes.push(this); }
  connect(destination: unknown): unknown { this.connections.add(destination); return destination; }
  disconnect(): void { this.disconnected = true; this.connections.clear(); }
}

class MockSource extends MockNode {
  onended: (() => void) | null = null;
  startTime = Infinity;
  stopTime = Infinity;
  ended = false;
  start(time: number): void {
    assert.ok(Number.isFinite(time) && time >= this.context.currentTime, 'no scheduling in the past');
    this.startTime = time;
    this.context.sources.add(this);
    this.context.started.push(this);
  }
  stop(time: number): void {
    assert.ok(Number.isFinite(time) && time >= 0);
    if (!this.ended) this.stopTime = time;
  }
  flush(): void {
    if (!this.ended && this.stopTime <= this.context.currentTime) {
      this.ended = true;
      this.context.sources.delete(this);
      this.onended?.();
    }
  }
}

class MockContext {
  currentTime = 0;
  sampleRate = 12000;
  state: AudioContextState = 'running';
  readonly nodes: MockNode[] = [];
  readonly sources = new Set<MockSource>();
  readonly started: MockSource[] = [];
  readonly listeners = new Set<() => void>();
  createGain(): MockNode { return new MockNode(this); }
  createDynamicsCompressor(): MockNode { return new MockNode(this); }
  createDelay(): MockNode { return new MockNode(this); }
  createBiquadFilter(): MockNode { return new MockNode(this); }
  createStereoPanner(): MockNode { return new MockNode(this); }
  createConvolver(): MockNode { return new MockNode(this); }
  createOscillator(): MockSource { return new MockSource(this); }
  createBufferSource(): MockSource { return new MockSource(this); }
  createBuffer(channels: number, length: number): { getChannelData(channel: number): Float32Array } {
    assert.ok(Number.isInteger(length) && length > 0);
    const data = Array.from({ length: channels }, () => new Float32Array(length));
    return { getChannelData: (channel: number) => data[channel] };
  }
  addEventListener(type: string, callback: () => void): void { assert.equal(type, 'statechange'); this.listeners.add(callback); }
  removeEventListener(type: string, callback: () => void): void { assert.equal(type, 'statechange'); this.listeners.delete(callback); }
  setState(state: AudioContextState): void {
    this.state = state;
    for (const callback of this.listeners) callback();
  }
  flushSources(): void { for (const source of [...this.sources]) source.flush(); }
}

const originalInterval = globalThis.setInterval;
const originalClearInterval = globalThis.clearInterval;
let timers: Map<number, () => void>;
let timerSequence = 0;
let fixtures: { music: RallyMusic; context: MockContext }[];

beforeEach(() => {
  timers = new Map();
  fixtures = [];
  globalThis.setInterval = ((callback: () => void, delay: number) => {
    assert.equal(delay, 32, 'lookahead timer is independent from requestAnimationFrame');
    const id = ++timerSequence;
    timers.set(id, callback);
    return id;
  }) as typeof setInterval;
  globalThis.clearInterval = ((id: number) => { timers.delete(id); }) as typeof clearInterval;
});

afterEach(() => {
  for (const fixture of fixtures) {
    fixture.music.dispose();
    advance(fixture.context, 0.12, false);
  }
  assert.equal(timers.size, 0, 'no scheduler is left behind');
  globalThis.setInterval = originalInterval;
  globalThis.clearInterval = originalClearInterval;
});

function setup(state: AudioContextState = 'running'): { music: RallyMusic; context: MockContext } {
  const context = new MockContext();
  context.state = state;
  const output = new MockNode(context);
  const music = new RallyMusic(context as unknown as AudioContext, output as unknown as AudioNode);
  const fixture = { music, context };
  fixtures.push(fixture);
  return fixture;
}

function advance(context: MockContext, seconds: number, runTimers = true): void {
  const until = context.currentTime + seconds;
  while (context.currentTime < until - 1e-9) {
    context.currentTime = Math.min(until, context.currentTime + 0.032);
    context.flushSources();
    if (runTimers) for (const callback of [...timers.values()]) callback();
    context.flushSources();
  }
}

test('original score has a D-minor eight-bar harmony and four distinct sections', () => {
  assert.equal(MUSIC_BPM, 132);
  assert.equal(MUSIC_TITLE, 'Dustline · 荒原电台');
  assert.equal(SCORE_BARS, 32);
  assert.deepEqual(Array.from({ length: 8 }, (_, bar) => chordAtBar(bar).name), [
    'Dm9', 'Dm9', 'B♭maj9', 'B♭maj9', 'Fadd9', 'Fadd9', 'Cadd9', 'Cadd9',
  ]);
  const minorScale = new Set([0, 2, 4, 5, 7, 9, 10]);
  for (let bar = 0; bar < SCORE_BARS; bar++) {
    assert.ok(menuForBar(bar).length < leadForBar(bar).length, 'menu deliberately leaves musical space');
    for (const note of [...leadForBar(bar), ...menuForBar(bar), ...bassForBar(bar)]) {
      assert.ok(Number.isInteger(note.step) && note.step >= 0 && note.step < 16);
      assert.ok(note.length > 0 && note.step + note.length <= 16);
      assert.ok(note.velocity > 0 && note.velocity <= 1);
      assert.ok(note.midi >= 30 && note.midi <= 84);
      assert.ok(minorScale.has(note.midi % 12));
      assert.ok(Number.isFinite(midiFrequency(note.midi)) && midiFrequency(note.midi) > 20);
    }
    for (let step = 0; step < 16; step++) assert.ok(minorScale.has(arpMidiAt(bar, step) % 12));
  }
  const sections = [0, 8, 16, 24].map(bar => JSON.stringify(leadForBar(bar)));
  assert.equal(new Set(sections).size, 4);
  assert.deepEqual(leadForBar(32), leadForBar(0), '32-bar score loops seamlessly');
  assert.deepEqual(chordAtBar(-1), chordAtBar(31));
});

test('constructor builds only silent nodes; enabling is idempotent', () => {
  const { music, context } = setup();
  assert.deepEqual(music.snapshot, {
    mode: 'menu', enabled: false, volume: 0.4, intensity: 0, bar: 1,
    activeSources: 0, timerActive: false, scheduledNotes: 0,
  });
  assert.equal(context.started.length, 0);
  music.setMode('menu');
  assert.equal(timers.size, 0);
  music.setEnabled(true);
  const notes = music.snapshot.scheduledNotes;
  assert.ok(notes >= 5, 'warm chord voices are scheduled on first enable');
  assert.equal(timers.size, 1);
  for (let i = 0; i < 10; i++) music.setEnabled(true);
  assert.equal(timers.size, 1);
  assert.equal(music.snapshot.scheduledNotes, notes, 'repeated enable does not stack songs');
});

test('pause and hidden stop scheduling and release every source after a short fade', () => {
  const { music, context } = setup();
  music.setMode('racing');
  music.setEnabled(true);
  advance(context, 2);
  music.setMode('paused');
  const notes = music.snapshot.scheduledNotes;
  assert.equal(music.snapshot.timerActive, false);
  advance(context, 20);
  assert.equal(music.snapshot.activeSources, 0);
  assert.equal(music.snapshot.scheduledNotes, notes);
  music.setMode('racing');
  assert.equal(timers.size, 1);
  advance(context, 0.2);
  assert.ok(music.snapshot.scheduledNotes > notes);
  music.setMode('hidden');
  advance(context, 0.15);
  assert.equal(music.snapshot.activeSources, 0);
  assert.equal(timers.size, 0);
});

test('repeated races, disable/enable and mode changes never accumulate schedulers', () => {
  const { music, context } = setup();
  for (let i = 0; i < 20; i++) {
    music.setMode('menu'); music.setEnabled(true); advance(context, 0.13);
    music.setMode('countdown'); music.setMode('racing'); advance(context, 0.6);
    assert.equal(timers.size, 1);
    assert.ok(music.snapshot.activeSources < 70);
    music.setEnabled(false); advance(context, 0.1);
    assert.equal(timers.size, 0);
    assert.equal(music.snapshot.activeSources, 0);
  }
});

test('mode requests are quantized and a superseded request cannot turn drums on later', () => {
  const { music, context } = setup();
  music.setEnabled(true);
  music.setMode('racing');
  music.setMode('menu');
  advance(context, 1);
  const internals = music as unknown as { effectiveMode: string };
  assert.equal(internals.effectiveMode, 'menu');
  music.setMode('racing');
  assert.equal(internals.effectiveMode, 'menu', 'layer switch waits for a beat boundary');
  advance(context, 0.6);
  assert.equal(internals.effectiveMode, 'racing');
});

test('boost adds arp/hat notes without modifying the user volume', () => {
  const { music, context } = setup();
  music.setMode('racing'); music.setEnabled(true);
  advance(context, 1.9);
  const before = music.snapshot.scheduledNotes;
  advance(context, 1.82);
  const normalDensity = music.snapshot.scheduledNotes - before;
  music.setIntensity(1);
  const boostedStart = music.snapshot.scheduledNotes;
  advance(context, 1.82);
  assert.ok(music.snapshot.scheduledNotes - boostedStart > normalDensity + 8);
  assert.equal(music.snapshot.intensity, 1);
  assert.equal(music.snapshot.volume, 0.4);
});

test('a throttled scheduler restarts cleanly instead of firing a backlog', () => {
  const { music, context } = setup();
  music.setMode('racing'); music.setEnabled(true); advance(context, 0.3);
  const notes = music.snapshot.scheduledNotes;
  context.currentTime += 45;
  context.flushSources();
  for (const callback of [...timers.values()]) callback();
  assert.equal(timers.size, 1);
  assert.ok(music.snapshot.scheduledNotes - notes < 16, 'only the next musical instant is scheduled');
  assert.ok(music.snapshot.activeSources < 30);
  for (const source of context.started.slice(-music.snapshot.activeSources)) {
    assert.ok(source.startTime >= context.currentTime);
  }
});

test('suspended contexts stay silent and resume safely without changing the preference', () => {
  const { music, context } = setup('suspended');
  music.setEnabled(true);
  assert.equal(timers.size, 0);
  assert.equal(music.snapshot.activeSources, 0);
  context.setState('running');
  assert.equal(timers.size, 1);
  advance(context, 0.2);
  context.setState('suspended');
  assert.equal(timers.size, 0);
  assert.equal(music.snapshot.activeSources, 0);
  assert.equal(music.snapshot.enabled, true);
  music.setEnabled(false);
  context.setState('running');
  assert.equal(timers.size, 0, 'context resume cannot override a disabled preference');
});

test('the full arrangement stays finite and bounded; dispose releases nodes and listeners', () => {
  const { music, context } = setup();
  music.setMode('racing'); music.setIntensity(1); music.setEnabled(true);
  let maximumSources = 0;
  for (let i = 0; i < 64; i++) {
    advance(context, 1);
    maximumSources = Math.max(maximumSources, music.snapshot.activeSources);
  }
  assert.ok(maximumSources < 75, `bounded polyphony, observed ${maximumSources}`);
  assert.ok(music.snapshot.scheduledNotes > 900, 'test traversed all musical sections');
  music.setVolume(-3); assert.equal(music.snapshot.volume, 0);
  music.setVolume(3); assert.equal(music.snapshot.volume, 1);
  music.setVolume(NaN); assert.equal(music.snapshot.volume, 1);
  music.setIntensity(Infinity); assert.equal(music.snapshot.intensity, 0);
  music.dispose(); advance(context, 0.12, false);
  assert.equal(music.snapshot.activeSources, 0);
  assert.equal(music.snapshot.timerActive, false);
  assert.equal(context.listeners.size, 0);
  assert.ok(context.nodes.slice(1).every(node => node.disconnected), 'only the caller-owned output is retained');
  const notes = music.snapshot.scheduledNotes;
  music.setEnabled(true); music.setMode('racing'); music.dispose();
  assert.equal(music.snapshot.scheduledNotes, notes);
});

function tick(context: MockContext, seconds = CLOCK_TICK): void {
  context.currentTime += seconds;
  context.flushSources();
  for (const callback of [...timers.values()]) callback();
  context.flushSources();
}

const CLOCK_TICK = 0.032;
const mod = (value: number, divisor: number): number => ((value % divisor) + divisor) % divisor;
const internalsOf = (music: RallyMusic): {
  effectiveMode: MusicMode;
  pendingMode: MusicMode | null;
  transportStep: number;
} => music as unknown as { effectiveMode: MusicMode; pendingMode: MusicMode | null; transportStep: number };

test('the latest mode request wins and every layer switch lands on a four-step beat', () => {
  const { music, context } = setup();
  music.setEnabled(true);
  const internals = internalsOf(music);
  // Three rapid requests: only the last one may ever become audible.
  music.setMode('racing');
  music.setMode('countdown');
  music.setMode('menu');
  assert.equal(internals.pendingMode, null, 'menu already matches the audible layer');
  assert.equal(internals.effectiveMode, 'menu');

  music.setMode('racing');
  music.setMode('countdown');
  assert.equal(internals.effectiveMode, 'menu', 'a switch waits for the next beat boundary');
  assert.equal(internals.pendingMode, 'countdown', 'an earlier racing request is superseded');
  const previous = internals.effectiveMode;
  while (internals.pendingMode !== null) {
    const stepBefore = internals.transportStep;
    tick(context);
    if (internals.effectiveMode !== previous) {
      assert.equal(mod(stepBefore, 4), 0, 'layer switches are quantized to quarter-note beats');
      assert.equal(internals.effectiveMode, 'countdown');
      assert.equal(internals.pendingMode, null);
      break;
    }
  }
  assert.equal(internals.effectiveMode, 'countdown', 'the superseded racing layer never played');
});

test('pausing discards a queued switch, so an old request cannot activate after resume', () => {
  const { music, context } = setup();
  music.setEnabled(true);
  const internals = internalsOf(music);
  music.setMode('racing');
  assert.equal(internals.pendingMode, 'racing');
  music.setMode('paused');
  assert.equal(music.snapshot.timerActive, false);
  assert.equal(internals.pendingMode, null, 'silent modes cancel every pending layer request');
  advance(context, 0.2);
  assert.equal(internals.effectiveMode, 'menu', 'the queued racing layer never took effect');
  music.setMode('racing');
  tick(context);
  assert.equal(internals.effectiveMode, 'racing', 'resume starts the requested layer fresh');
});

test('pause and hidden drain active sources, freeze the queue and resume on the beat', () => {
  const { music, context } = setup();
  music.setMode('racing');
  music.setEnabled(true);
  advance(context, 1.5);
  assert.ok(music.snapshot.activeSources > 0);

  for (const mode of ['paused', 'hidden'] as const) {
    music.setMode('racing');
    advance(context, 0.4);
    assert.ok(music.snapshot.activeSources > 0);
    music.setMode(mode);
    const frozen = music.snapshot.scheduledNotes;
    assert.equal(music.snapshot.timerActive, false);
    advance(context, 5);
    assert.equal(music.snapshot.activeSources, 0, `${mode}: every source fades out and ends`);
    assert.equal(music.snapshot.scheduledNotes, frozen, `${mode}: no notes are scheduled while asleep`);

    // Resuming schedules fresh notes from the next beat; the count stays at the
    // frozen value right up until the restart, proving nothing was replayed.
    music.setMode('racing');
    assert.equal(music.snapshot.timerActive, true);
    assert.ok(music.snapshot.scheduledNotes > frozen, `${mode}: music continues after the sleep`);
    const internals = internalsOf(music);
    // startTransport quantizes to the next beat and its warm-up pump schedules
    // exactly that one beat step, so the pointer lands one step past a boundary.
    assert.equal(mod(internals.transportStep - 1, 4), 0, `${mode}: resume is quantized to a beat boundary`);
  }

  // A final hidden spell leaves the transport fully drained for the test teardown.
  music.setMode('hidden');
  advance(context, 1);
  assert.equal(music.snapshot.activeSources, 0);
  assert.equal(music.snapshot.timerActive, false);
});

test('a stalled scheduler realigns to the beat and schedules one bounded window, not the backlog', () => {
  const { music, context } = setup();
  music.setMode('racing');
  music.setEnabled(true);
  advance(context, 0.4);
  const internals = internalsOf(music);
  const queuedBefore = music.snapshot.scheduledNotes;

  // The tab is throttled for far longer than the 35 ms drift allowance.
  context.currentTime += 45;
  context.flushSources();
  for (const callback of [...timers.values()]) callback();

  assert.equal(timers.size, 1, 'a single scheduler survives the restart');
  const burst = music.snapshot.scheduledNotes - queuedBefore;
  assert.ok(burst <= 16 && burst > 0, `one look-ahead window is scheduled, got ${burst} notes`);
  assert.ok(music.snapshot.activeSources < 30);
  for (const source of context.started.slice(-music.snapshot.activeSources)) {
    assert.ok(source.startTime >= context.currentTime, 'recovered notes are never placed in the past');
  }
  // The recovery pump schedules exactly one step: the quantized beat itself,
  // leaving the pointer one step past a four-step boundary.
  assert.equal(mod(internals.transportStep - 1, 4), 0, 'restart quantizes the transport to the next beat');

  const after = music.snapshot.scheduledNotes;
  advance(context, 0.2);
  assert.ok(music.snapshot.scheduledNotes - after < 16, 'normal scheduling stays bounded after recovery');
});

test('suspended contexts stay silent and resume cannot re-enable music the user switched off', () => {
  const { music, context } = setup('suspended');
  music.setMode('racing');
  music.setEnabled(true);
  assert.equal(timers.size, 0);
  assert.equal(music.snapshot.activeSources, 0);
  assert.equal(music.snapshot.scheduledNotes, 0);

  context.setState('running');
  assert.equal(timers.size, 1, 'a running context reconnects the scheduler automatically');
  advance(context, 0.2);
  assert.ok(music.snapshot.scheduledNotes > 0);

  context.setState('suspended');
  assert.equal(timers.size, 0);
  assert.equal(music.snapshot.activeSources, 0, 'suspension fades out and releases every voice');
  const suspendedNotes = music.snapshot.scheduledNotes;

  music.setEnabled(false);
  context.setState('running');
  assert.equal(timers.size, 0, 'resume must not override the disabled preference');
  assert.equal(music.snapshot.scheduledNotes, suspendedNotes);

  // Re-enabling while suspended still stays silent until the context runs.
  context.setState('suspended');
  music.setEnabled(true);
  assert.equal(timers.size, 0, 'a suspended context cannot start the scheduler');
  context.setState('running');
  assert.equal(timers.size, 1, 'the scheduler reconnects once the context is running again');
});

test('volume keeps the last finite value and intensity never touches the user volume', () => {
  const { music, context } = setup();
  assert.equal(music.snapshot.volume, 0.4, 'the default music level stays at 40%');
  music.setVolume(0.7);
  for (const invalid of [NaN, Infinity, -Infinity]) {
    music.setVolume(invalid);
    assert.equal(music.snapshot.volume, 0.7, `non-finite volume ${invalid} is ignored`);
  }
  music.setVolume(-2); assert.equal(music.snapshot.volume, 0);
  music.setVolume(4); assert.equal(music.snapshot.volume, 1);
  music.setVolume(0.25); assert.equal(music.snapshot.volume, 0.25);

  music.setMode('racing');
  music.setEnabled(true);
  advance(context, 1);
  for (const value of [NaN, Infinity, -Infinity, -1, 2]) {
    music.setIntensity(value);
    const expected = Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : 0;
    assert.equal(music.snapshot.intensity, expected);
    assert.equal(music.snapshot.volume, 0.25, 'intensity changes never rewrite the volume preference');
  }
  music.setIntensity(1);
  const busy = music.snapshot.scheduledNotes;
  advance(context, 1.82);
  const racingNotes = music.snapshot.scheduledNotes - busy;

  music.setMode('menu');
  music.setIntensity(1);
  advance(context, 0.6);
  const quiet = music.snapshot.scheduledNotes;
  advance(context, 1.82);
  const menuNotes = music.snapshot.scheduledNotes - quiet;
  assert.ok(menuNotes < racingNotes, 'intensity only thickens the racing arpeggio, not the menu layer');
  assert.equal(music.snapshot.volume, 0.25);
});

test('dispose tears down listeners and timers; later calls schedule nothing', () => {
  const { music, context } = setup();
  music.setMode('racing');
  music.setEnabled(true);
  advance(context, 0.5);
  music.dispose();
  advance(context, 0.2, false);
  assert.equal(context.listeners.size, 0, 'the statechange listener is released');
  assert.equal(music.snapshot.timerActive, false);
  assert.equal(music.snapshot.activeSources, 0);
  const frozen = music.snapshot.scheduledNotes;
  music.setEnabled(true);
  music.setMode('racing');
  music.setVolume(0.9);
  music.setIntensity(1);
  context.setState('suspended');
  context.setState('running');
  advance(context, 0.3);
  assert.equal(music.snapshot.scheduledNotes, frozen, 'no notes are scheduled after disposal');
  assert.equal(music.snapshot.timerActive, false);
});
