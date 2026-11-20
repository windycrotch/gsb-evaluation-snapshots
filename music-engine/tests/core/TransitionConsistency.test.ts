import { describe, expect, it, vi } from 'vitest';
import { MusicEngine } from '../../src/core/MusicEngine';
import { pulsePlugin } from '../../src/styles/pulse';
import { zenPlugin } from '../../src/styles/zen';
import type { InstrumentPlugin, MusicalEvent } from '../../src/core/types';
import { MockAudioContext } from '../helpers/MockAudioContext';

/**
 * Consistency of one playback session across
 *   playing → transition → pause/stop → resume/start.
 *
 * The observable contract (page state + events):
 *  - mid-transition requests keep the newest value per field and are applied
 *    exactly once;
 *  - pause/stop interrupting a crossfade never loses the request, and the next
 *    resume/start lands on the user's last choice;
 *  - after stop, no late timer may flip the state back to playing or
 *    re-instantiate a style.
 */

function recordingInstrument(id: string, log: { id: string; event: MusicalEvent; at: number }[]): InstrumentPlugin {
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

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Mock the test can flip between "resume works" and "resume is refused". */
class FlakyResumeContext extends MockAudioContext {
  allowResume = true;
  async resume(): Promise<void> {
    if (this.allowResume) this.state = 'running';
  }
}

function makeEngine(mock: MockAudioContext, log: { id: string; event: MusicalEvent; at: number }[]) {
  const engine = new MusicEngine({
    audioContextFactory: () => mock as unknown as AudioContext,
    style: 'pulse',
    seed: '777',
    lookAhead: 0.16,
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

/** Tick the scheduler while advancing the audio clock. */
function play(engine: MusicEngine, mock: MockAudioContext, seconds: number, step = 0.1): void {
  for (let t = 0; t < seconds; t += step) {
    mock.advance(step);
    (engine as any).scheduler.tick();
  }
}

/**
 * Park the transport close to Pulse's bar line so the crossfade boundary is
 * the minimum 0.6 s away — keeps the timer-driven paths fast to test.
 */
async function startNearBoundary(mock: MockAudioContext, engine: MusicEngine, log: { id: string; event: MusicalEvent; at: number }[]) {
  await engine.start();
  // Pulse's bar is 2.4 s at 100 BPM; stopping just before it keeps the
  // crossfade boundary at the engine's minimum 0.6 s (fast timer paths).
  play(engine, mock, 2.0);
  expect(engine.getState().status).toBe('playing');
  expect(log.length).toBeGreaterThan(0);
}

/** Record every event that tells the page what the engine intends to apply. */
function recordIntents(engine: MusicEngine) {
  const styles: string[] = [];
  const seeds: { seed: string; pending?: boolean }[] = [];
  const transitions: string[] = [];
  engine.eventBus.on('style', ({ styleId }) => styles.push(styleId));
  engine.eventBus.on('seed', ({ seed, pending }) => seeds.push({ seed, pending }));
  engine.eventBus.on('transition', ({ phase }) => transitions.push(phase));
  return { styles, seeds, transitions };
}

describe('Playback session consistency across transitions', () => {
  it('merges concurrent style/seed requests per field and applies each exactly once', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await startNearBoundary(mock, engine, log);
    const seen = recordIntents(engine);

    engine.useStyle('zen'); // transition in flight
    expect((engine as any).transitioning).toBe(true);
    // A burst while the crossfade runs: newest value per field must win.
    engine.useStyle('pulse');
    engine.setSeed('111');
    engine.setSeed('222');

    expect((engine as any).pendingTarget).toEqual({ styleId: 'pulse', seed: '222' });
    // The page already shows the newest choice for the seed box / toasts,
    // while getState() still describes what is actually sounding.
    expect(seen.styles).toEqual([]);
    expect(seen.seeds).toEqual([
      { seed: '111', pending: true },
      { seed: '222', pending: true },
    ]);

    await sleep(900);
    play(engine, mock, 0.4);

    expect(engine.getState().status).toBe('playing');
    expect(engine.getState().styleId).toBe('pulse');
    expect(engine.getState().seed).toBe('222');
    expect((engine as any).transitioning).toBe(false);
    expect((engine as any).pendingTarget).toBeNull();
    // Applied once: exactly one style event (the style itself never actually
    // changed, but the request did land) and one final seed event.
    expect(seen.styles).toEqual(['pulse']);
    expect(seen.seeds.slice(2)).toEqual([{ seed: '222' }]);
    expect(seen.transitions).toEqual(['begin', 'end']);

    // A later pause/resume must not re-apply the same request.
    engine.pause();
    await sleep(180);
    await engine.resume();
    await sleep(50);
    expect(engine.getState().styleId).toBe('pulse');
    expect(engine.getState().seed).toBe('222');
    expect(seen.styles).toEqual(['pulse']);
    expect(seen.seeds.slice(2)).toEqual([{ seed: '222' }]);
    expect(seen.transitions).toEqual(['begin', 'end']);

    await engine.dispose();
  }, 15000);

  it('pause interrupting the crossfade keeps the target and lands on it after resume', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await startNearBoundary(mock, engine, log);
    const seen = recordIntents(engine);

    engine.useStyle('zen');
    engine.pause();
    expect((engine as any).transitioning).toBe(false);
    expect((engine as any).transitionTimer).toBeNull();
    expect((engine as any).pendingTarget).toEqual({ styleId: 'zen' });
    // The UI must be able to press ▶ again — the crossfade is over, not stuck.
    expect(seen.transitions).toEqual(['begin', 'end']);

    // Sleeping past the old boundary window must not apply anything by itself.
    mock.advance(5);
    await sleep(800);
    expect(engine.getState().status).toBe('paused');
    expect(engine.getState().styleId).toBe('pulse');
    expect(seen.styles).toEqual([]);

    await engine.resume();
    expect(engine.getState().status).toBe('playing');
    expect(engine.getState().styleId).toBe('zen');
    expect(seen.styles).toEqual(['zen']);
    expect((engine as any).pendingTarget).toBeNull();
    play(engine, mock, 0.6);
    expect(log.length).toBeGreaterThan(0);
    await engine.dispose();
  }, 15000);

  it('a choice made while paused supersedes the interrupted target (newest wins)', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await startNearBoundary(mock, engine, log);

    engine.useStyle('zen'); // crossfade heading for zen
    engine.pause();
    engine.useStyle('pulse'); // user changes their mind while paused
    expect(engine.getState().styleId).toBe('pulse');
    expect((engine as any).pendingTarget).toBeNull();

    await sleep(180);
    await engine.resume();
    expect(engine.getState().styleId).toBe('pulse');
    expect(engine.getState().status).toBe('playing');
    await sleep(800); // older zen target must not resurface
    expect(engine.getState().styleId).toBe('pulse');
    await engine.dispose();
  }, 15000);

  it('stop during a crossfade leaves no late timer that plays, re-instantiates or changes state', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await startNearBoundary(mock, engine, log);
    const seen = recordIntents(engine);

    engine.useStyle('zen');
    engine.stop();
    expect(engine.getState().status).toBe('idle');
    const notesAtStop = log.length;

    // Wait out both the transition window and stop()'s 200 ms wind-down.
    mock.advance(5);
    await sleep(1100);

    expect(engine.getState().status).toBe('idle');
    expect(engine.getState().styleId).toBe('pulse'); // zen never instanced
    expect((engine as any).transitioning).toBe(false);
    expect((engine as any).transitionTimer).toBeNull();
    expect((engine as any).instance).toBeNull();
    expect(seen.styles).toEqual([]); // no style event fired while idle
    play(engine, mock, 1.0);
    expect(log.length).toBe(notesAtStop); // no notes produced
    await engine.dispose();
  }, 15000);

  it('a transition callback that is already queued when stop() lands cannot revive playback', async () => {
    // Deterministic version of "late timer after stop": capture the callback
    // at scheduling time, run stop(), then invoke it exactly as the event loop
    // would if it had been dequeued just before the cancellation. Nothing may
    // reach the page, the state machine or the audio graph.
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await engine.start();
    play(engine, mock, 2.0);
    const seen = recordIntents(engine);

    const realSetTimeout = globalThis.setTimeout;
    let captured: (() => void) | null = null;
    const spy = vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: () => void, ms?: number) => {
      // The crossfade timer is the only ~hundreds-of-ms timer armed here.
      if (captured === null && typeof ms === 'number' && ms > 100) captured = fn;
      return realSetTimeout(fn, ms);
    }) as typeof setTimeout);
    try {
      engine.useStyle('zen');
    } finally {
      spy.mockRestore();
    }
    expect(captured).not.toBeNull();

    engine.stop();
    expect(engine.getState().status).toBe('idle');
    const notesAtStop = log.length;

    (captured as unknown as () => void)(); // the "late" timer fires

    expect(engine.getState().status).toBe('idle');
    expect(engine.getState().styleId).toBe('pulse');
    expect((engine as any).transitioning).toBe(false);
    expect((engine as any).instance).toBeNull();
    expect(seen.styles).toEqual([]);
    expect(seen.transitions).toEqual(['begin', 'end']);
    play(engine, mock, 1.0);
    expect(log.length).toBe(notesAtStop);
    await engine.dispose();
  }, 15000);

  it('watchdog interruption during a crossfade falls back to paused without a late revival', async () => {
    const mock = new FlakyResumeContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await engine.start();
    play(engine, mock, 2.0);
    const seen = recordIntents(engine);

    // Keep the crossfade in flight long enough for the interruption to land
    // mid-transition (4 s boundary), then let the watchdog give up quickly.
    (engine as any).instance.nextBoundary = (pos: number) => pos + 4;
    engine.useStyle('zen');
    expect((engine as any).transitioning).toBe(true);

    mock.allowResume = false;
    mock.state = 'suspended';
    await (engine as any).watchdogTick();
    await (engine as any).watchdogTick(); // two misses ⇒ honest pause

    expect(engine.getState().status).toBe('paused');
    expect((engine as any).transitioning).toBe(false);
    expect((engine as any).transitionTimer).toBeNull();
    // Interruption keeps the intent for the next ▶.
    expect((engine as any).pendingTarget).toEqual({ styleId: 'zen' });

    // Past the old crossfade window: still paused, style not applied.
    mock.advance(5);
    await sleep(800);
    expect(engine.getState().status).toBe('paused');
    expect(engine.getState().styleId).toBe('pulse');
    expect(seen.styles).toEqual([]);

    mock.allowResume = true;
    mock.state = 'suspended';
    await engine.resume();
    expect(engine.getState().status).toBe('playing');
    expect(engine.getState().styleId).toBe('zen');
    expect(seen.styles).toEqual(['zen']);
    await engine.dispose();
  }, 15000);

  it('stop-interrupted request is not lost: pressing play lands on the last choice', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await startNearBoundary(mock, engine, log);

    engine.useStyle('zen');
    engine.setSeed('4242');
    engine.stop();
    await sleep(300); // let the stop wind-down finish

    expect(engine.getState().status).toBe('idle');
    expect(engine.getState().styleId).toBe('pulse');
    expect(engine.getState().seed).toBe('777');

    await engine.start();
    expect(engine.getState().status).toBe('playing');
    expect(engine.getState().styleId).toBe('zen');
    expect(engine.getState().seed).toBe('4242');
    expect((engine as any).pendingTarget).toBeNull();
    play(engine, mock, 1.0);
    expect(log.length).toBeGreaterThan(0);
    await engine.dispose();
  }, 15000);
});
