import { describe, expect, it } from 'vitest';
import { MusicEngine } from '../../src/core/MusicEngine';
import { pulsePlugin } from '../../src/styles/pulse';
import { zenPlugin } from '../../src/styles/zen';
import type { InstrumentPlugin, MusicalEvent } from '../../src/core/types';
import { MockAudioContext } from '../helpers/MockAudioContext';

/**
 * Acceptance tests for transition consistency across play / pause / stop /
 * resume:
 *  1. a normal style switch lands smoothly at a bar line
 *  2. repeated requests during one transition collapse to the latest and
 *     land together when that transition ends
 *  3. a pause that interrupts a transition never loses the request, and a
 *     newer choice made while paused beats the stale queued one
 *  4. stop → replay leaves no half-finished transition or stale seed behind
 *  5. no old-style notes leak once the transition has landed
 *  6. replaying the same seed reproduces the exact same event sequence
 */

type Log = { id: string; event: MusicalEvent; at: number }[];

function recordingInstrument(id: string, log: Log): InstrumentPlugin {
  return {
    id,
    name: id,
    create: () => ({
      trigger(event, at) {
        log.push({ id: event.id, event, at });
      },
      stopAll() {},
      setParameter() {},
    }),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function makeEngine(mock: MockAudioContext, log: Log, seed: string | number = '777') {
  const engine = new MusicEngine({
    audioContextFactory: () => mock as unknown as AudioContext,
    style: 'pulse',
    seed,
    generationHorizon: 45,
  });
  engine.registerInstrument(recordingInstrument('pluck', log));
  for (const id of ['drone', 'bell', 'bowl', 'noise-texture']) {
    engine.registerInstrument(recordingInstrument(id, log));
  }
  engine.registerFX({
    id: 'reverb',
    name: 'Reverb (stub)',
    create: () => {
      const g = mock.createGain() as unknown as AudioNode;
      return { input: g, output: g, setParameter() {}, reset() {}, dispose() {} };
    },
  });
  engine.registerStyle(pulsePlugin);
  engine.registerStyle(zenPlugin);
  return engine;
}

/** Advance the mock clock in small steps, ticking like the real interval would. */
function play(engine: MusicEngine, mock: MockAudioContext, seconds: number, step = 0.1): void {
  for (let t = 0; t < seconds; t += step) {
    mock.advance(step);
    (engine as any).scheduler.tick();
  }
}

/** Let the (real-time) transition timer reach the bar-line boundary. */
async function waitForTransition(engine: MusicEngine, mock: MockAudioContext): Promise<void> {
  mock.advance(4.0); // boundary is clamped to ≤ 4 s of transport time
  for (let i = 0; i < 90 && (engine as any).transitioning; i++) await sleep(50);
  expect((engine as any).transitioning).toBe(false);
}

const sourceOf = (l: Log[number]) => l.event.metadata?.sourcePlugin;

describe('Transitions: normal switch lands smoothly at a bar line', () => {
  it('style switch while playing crossfades into the new style and keeps playing', async () => {
    const mock = new MockAudioContext();
    const log: Log = [];
    const engine = makeEngine(mock, log);
    const phases: string[] = [];
    engine.eventBus.on('transition', ({ phase }) => phases.push(phase));

    await engine.start();
    play(engine, mock, 0.5);
    const pulseBefore = log.filter((l) => sourceOf(l) === 'pulse').length;
    expect(pulseBefore).toBeGreaterThan(0);

    engine.useStyle('zen');
    expect((engine as any).transitioning).toBe(true);
    expect(phases).toEqual(['begin']);

    await waitForTransition(engine, mock);
    play(engine, mock, 1.0);

    expect(phases).toEqual(['begin', 'end']);
    expect(engine.getState().styleId).toBe('zen');
    expect(engine.getState().status).toBe('playing');
    expect(log.some((l) => sourceOf(l) === 'zen')).toBe(true);
    await engine.dispose();
  }, 15000);
});

describe('Transitions: repeated requests during one transition', () => {
  it('rapid style clicks + seed changes collapse to the latest and land together', async () => {
    const mock = new MockAudioContext();
    const log: Log = [];
    const engine = makeEngine(mock, log);
    const phases: string[] = [];
    engine.eventBus.on('transition', ({ phase }) => phases.push(phase));

    await engine.start();
    play(engine, mock, 0.5);

    engine.useStyle('zen'); // transition #1 begins
    engine.useStyle('pulse'); // superseded…
    engine.setSeed('111'); // superseded…
    engine.setSeed('4242'); // …by this
    engine.useStyle('zen'); // latest style request
    expect(phases).toEqual(['begin']); // still a single transition
    expect((engine as any).pendingTarget).toMatchObject({ styleId: 'zen', seed: '4242' });

    await waitForTransition(engine, mock);
    play(engine, mock, 1.0);

    // One transition, one landing — the latest requests, applied together.
    expect(phases).toEqual(['begin', 'end']);
    expect(engine.getState().styleId).toBe('zen');
    expect(engine.getState().seed).toBe('4242');
    expect(engine.getState().status).toBe('playing');
    expect((engine as any).pendingTarget).toBeNull();
    expect(log.some((l) => sourceOf(l) === 'zen')).toBe(true);
    await engine.dispose();
  }, 15000);
});

describe('Transitions: pause interrupts, resume delivers', () => {
  it('pause closes the transition (UI released) and resume lands the parked target', async () => {
    const mock = new MockAudioContext();
    const log: Log = [];
    const engine = makeEngine(mock, log);
    const phases: string[] = [];
    engine.eventBus.on('transition', ({ phase }) => phases.push(phase));

    await engine.start();
    play(engine, mock, 0.5);

    engine.useStyle('zen');
    engine.pause();
    // The transition is over for listeners — a 'begin' without 'end' is what
    // left the play button disabled forever.
    expect(phases).toEqual(['begin', 'end']);
    expect((engine as any).transitioning).toBe(false);
    expect((engine as any).pendingTarget).toMatchObject({ styleId: 'zen' });
    await sleep(180);

    await engine.resume();
    expect(engine.getState().styleId).toBe('zen');
    expect(engine.getState().status).toBe('playing');
    play(engine, mock, 0.6);
    expect(log.some((l) => sourceOf(l) === 'zen')).toBe(true);
    await engine.dispose();
  });

  it('a style/seed chosen while paused beats the target queued by the interrupted transition', async () => {
    const mock = new MockAudioContext();
    const log: Log = [];
    const engine = makeEngine(mock, log);

    await engine.start();
    play(engine, mock, 0.5);

    engine.useStyle('zen'); // transition begins…
    engine.setSeed('999'); // …both requests queued mid-flight
    engine.pause(); // interrupted — parked as pendingTarget
    expect((engine as any).pendingTarget).toMatchObject({ styleId: 'zen', seed: '999' });

    // The user changes their mind while paused: these are the NEWEST requests.
    engine.useStyle('pulse');
    engine.setSeed('555');
    expect(engine.getState().styleId).toBe('pulse');
    expect(engine.getState().seed).toBe('555');
    await sleep(180);

    await engine.resume();
    // The stale queued zen/999 must not come back and clobber the newer choice.
    expect(engine.getState().styleId).toBe('pulse');
    expect(engine.getState().seed).toBe('555');
    expect(engine.getState().status).toBe('playing');
    const before = log.length;
    play(engine, mock, 0.8);
    const fresh = log.slice(before);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((l) => sourceOf(l) === 'pulse')).toBe(true);
    await engine.dispose();
  });

  it('a transition timer that outlives an interruption parks its target instead of forcing "playing"', async () => {
    const mock = new MockAudioContext();
    const log: Log = [];
    const engine = makeEngine(mock, log);

    await engine.start();
    play(engine, mock, 0.5);
    engine.useStyle('zen');
    expect((engine as any).transitioning).toBe(true);

    // The system suspends playback without going through pause() (what the
    // watchdog does after an interruption it cannot recover from).
    (engine as any).scheduler.stop();
    (engine as any).state.set('paused');

    await waitForTransition(engine, mock); // timer fires while paused
    expect(engine.getState().status).toBe('paused'); // not resurrected
    expect((engine as any).pendingTarget).toMatchObject({ styleId: 'zen' });

    await engine.resume(); // the parked request still lands
    expect(engine.getState().styleId).toBe('zen');
    expect(engine.getState().status).toBe('playing');
    play(engine, mock, 0.5);
    expect(log.some((l) => sourceOf(l) === 'zen')).toBe(true);
    await engine.dispose();
  }, 15000);
});

describe('Transitions: stop then replay leaves nothing behind', () => {
  it('stop during a transition, then replay: last selection lands, no stale transition state', async () => {
    const mock = new MockAudioContext();
    const log: Log = [];
    const engine = makeEngine(mock, log);
    const phases: string[] = [];
    engine.eventBus.on('transition', ({ phase }) => phases.push(phase));

    await engine.start();
    play(engine, mock, 0.5);

    engine.useStyle('zen');
    engine.setSeed('4242');
    engine.stop();
    expect((engine as any).transitioning).toBe(false);
    expect(phases).toEqual(['begin', 'end']); // no dangling transition
    await sleep(300); // let the wind-down finish

    await engine.start();
    // The user's last choices survive the stop — nothing stale, nothing lost.
    expect(engine.getState().styleId).toBe('zen');
    expect(engine.getState().seed).toBe('4242');
    expect(engine.getState().status).toBe('playing');
    expect((engine as any).pendingTarget).toBeNull();
    expect((engine as any).transitionTimer).toBeNull();

    const before = log.length;
    play(engine, mock, 1.0);
    const fresh = log.slice(before);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((l) => sourceOf(l) === 'zen')).toBe(true);
    await engine.dispose();
  });

  it('stop → immediate replay during the wind-down has no silent hole', async () => {
    const mock = new MockAudioContext();
    const log: Log = [];
    const engine = makeEngine(mock, log);

    await engine.start();
    play(engine, mock, 0.5);

    engine.useStyle('zen'); // transition in flight…
    engine.stop(); // …interrupted by stop…
    await engine.start(); // …and an instant replay (wind-down cancelled)

    expect(engine.getState().status).toBe('playing');
    expect(engine.getState().styleId).toBe('zen'); // parked target landed
    // generatedUntil must have been rewound to the live position — otherwise
    // the cleared queue stays empty for many seconds (a audible hole).
    const before = log.length;
    play(engine, mock, 1.0);
    const fresh = log.slice(before);
    expect(fresh.length).toBeGreaterThan(0);
    expect(fresh.every((l) => sourceOf(l) === 'zen')).toBe(true);
    await engine.dispose();
  });

  it('a seed chosen while idle after the stop supersedes the interrupted transition seed', async () => {
    const mock = new MockAudioContext();
    const log: Log = [];
    const engine = makeEngine(mock, log, '100');

    await engine.start();
    play(engine, mock, 0.5);

    engine.setSeed('200'); // transition to seed 200 begins…
    engine.stop(); // …interrupted; 200 is parked
    await sleep(300);

    engine.setSeed('300'); // newest choice, made while idle
    expect(engine.getState().seed).toBe('300');

    await engine.start();
    expect(engine.getState().seed).toBe('300'); // not resurrected to 200
    expect(engine.getState().status).toBe('playing');
    play(engine, mock, 0.5);
    expect(log.length).toBeGreaterThan(0);
    await engine.dispose();
  });
});

describe('Transitions: no old-style notes leak past the boundary', () => {
  it('after the transition lands, only new-style events are dispatched', async () => {
    const mock = new MockAudioContext();
    const log: Log = [];
    const engine = makeEngine(mock, log);

    let boundaryPos: number | null = null;
    engine.eventBus.on('transition', ({ phase }) => {
      if (phase === 'end') {
        boundaryPos = (engine as any).transport.positionAt(mock.currentTime);
      }
    });

    await engine.start();
    play(engine, mock, 0.5);
    engine.useStyle('zen');

    await waitForTransition(engine, mock);
    expect(boundaryPos).not.toBeNull();
    play(engine, mock, 2.0);

    const firstZen = log.findIndex((l) => sourceOf(l) === 'zen');
    expect(firstZen).toBeGreaterThan(-1);
    // Not a single old-style event is dispatched after the new style starts.
    const pulseAfter = log.slice(firstZen).filter((l) => sourceOf(l) === 'pulse');
    expect(pulseAfter).toEqual([]);
    // The new style continues from the live position, not from t=0 or a gap.
    expect(log[firstZen].event.startTime).toBeGreaterThanOrEqual(boundaryPos! - 0.2);
    await engine.dispose();
  }, 15000);
});

describe('Seed replay reproducibility', () => {
  const signature = (log: Log) =>
    log.map((l) => `${l.event.id}@${l.event.startTime.toFixed(6)}:${l.event.instrument ?? ''}`);

  it('two engines with the same seed produce the identical event sequence', async () => {
    const mockA = new MockAudioContext();
    const mockB = new MockAudioContext();
    const logA: Log = [];
    const logB: Log = [];
    const a = makeEngine(mockA, logA, '999');
    const b = makeEngine(mockB, logB, '999');

    await a.start();
    await b.start();
    play(a, mockA, 3.0);
    play(b, mockB, 3.0);

    expect(logA.length).toBeGreaterThan(0);
    expect(signature(logA)).toEqual(signature(logB));
    await a.dispose();
    await b.dispose();
  });

  it('stop → replay with the same seed reproduces the first run exactly', async () => {
    const mock = new MockAudioContext();
    const log: Log = [];
    const engine = makeEngine(mock, log, '999');

    await engine.start();
    play(engine, mock, 2.0);
    const run1 = signature(log);
    const cut = log.length;
    expect(run1.length).toBeGreaterThan(0);

    engine.stop();
    await sleep(300); // wind-down: transport reset, instance torn down

    await engine.start();
    play(engine, mock, 2.0);
    const run2 = signature(log.slice(cut));

    expect(run2).toEqual(run1); // no leftover position, seed, or random state
    await engine.dispose();
  });
});
