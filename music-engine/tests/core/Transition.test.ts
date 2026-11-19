import { describe, expect, it, vi } from 'vitest';
import { MusicEngine } from '../../src/core/MusicEngine';
import { pulsePlugin } from '../../src/styles/pulse';
import { zenPlugin } from '../../src/styles/zen';
import { EngineError } from '../../src/core/types';
import type {
  GenerationContext,
  InstrumentPlugin,
  MusicalEvent,
  StyleInstance,
  StylePlugin,
} from '../../src/core/types';
import { MockAudioContext } from '../helpers/MockAudioContext';

function recordingInstrument(
  id: string,
  log: { id: string; event: MusicalEvent; at: number }[],
): InstrumentPlugin {
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

function makeEngine(
  mock: MockAudioContext,
  log: { id: string; event: MusicalEvent; at: number }[],
  initialStyle = 'pulse',
) {
  const engine = new MusicEngine({
    audioContextFactory: () => mock as unknown as AudioContext,
    style: initialStyle,
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

/** Advance the mock clock in small steps, ticking like the real interval would. */
function play(engine: MusicEngine, mock: MockAudioContext, seconds: number, step = 0.1): void {
  for (let t = 0; t < seconds; t += step) {
    mock.advance(step);
    (engine as any).scheduler.tick();
  }
}

/** Style whose nextBoundary always lands `delay` seconds ahead. */
function boundaryStyle(id: string, delay: number, requiredInstruments: string[] = []): StylePlugin {
  class BoundaryInstance implements StyleInstance {
    start(): void {}
    stop(): void {}
    generateEvents(): MusicalEvent[] {
      return [];
    }
    setParameter(): void {}
    nextBoundary(currentPosition: number): number | null {
      return currentPosition + delay;
    }
  }
  return {
    id,
    name: id,
    version: '1.0.0',
    description: 'test style with a controllable boundary',
    timeMode: 'beat',
    tags: ['test'],
    color: '#000000',
    parameters: [],
    presets: [],
    requiredInstruments,
    create: (): StyleInstance => new BoundaryInstance(),
  };
}

/** Style whose instance throws when generateEvents is first called. */
function throwingStyle(id: string): StylePlugin {
  class ThrowingInstance implements StyleInstance {
    start(): void {}
    stop(): void {}
    generateEvents(_ctx: GenerationContext): MusicalEvent[] {
      throw new Error('plugin exploded');
    }
    setParameter(): void {}
  }
  return {
    id,
    name: id,
    version: '1.0.0',
    description: 'test style that fails generation',
    timeMode: 'beat',
    tags: ['test'],
    color: '#000000',
    parameters: [],
    presets: [],
    create: (): StyleInstance => new ThrowingInstance(),
  };
}

/**
 * A clone of pulse whose instance reports `currentPosition + delay` as the
 * next boundary. Since beginTransition() asks the *current* style for its
 * boundary, this lets a test pin the boundary precisely regardless of bars.
 */
function pulseWithBoundary(id: string, delay: number): StylePlugin {
  return {
    ...pulsePlugin,
    id,
    name: id,
    create: (config): StyleInstance => {
      const inner = pulsePlugin.create(config);
      return {
        start: (ctx) => inner.start(ctx),
        stop: () => inner.stop(),
        generateEvents: (ctx) => inner.generateEvents(ctx),
        setParameter: (n, v) => inner.setParameter(n, v),
        nextBoundary: (p) => p + delay,
      };
    },
  };
}

/** A target style that emits one pluck every 0.25 s, deterministically. */
function gridStyle(id: string): StylePlugin {
  class GridInstance implements StyleInstance {
    start(): void {}
    stop(): void {}
    generateEvents({ from, to }: GenerationContext): MusicalEvent[] {
      const events: MusicalEvent[] = [];
      for (let t = Math.ceil(from * 4) / 4; t < to; t += 0.25) {
        events.push({
          id: `${id}:${Math.round(t * 4)}`,
          type: 'note',
          startTime: t,
          duration: 0.12,
          instrument: 'pluck',
          pitch: 60,
          velocity: 0.5,
          metadata: { sourcePlugin: id },
        });
      }
      return events;
    }
    setParameter(): void {}
  }
  return {
    id,
    name: id,
    version: '1.0.0',
    description: 'deterministic grid style for transition tests',
    timeMode: 'beat',
    tags: ['test'],
    color: '#000000',
    parameters: [],
    presets: [],
    create: (): StyleInstance => new GridInstance(),
  };
}

describe('Transition lifecycle', () => {
  it('completes at the musical boundary, keeps playing and emits new-style events', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);

    await engine.start();
    play(engine, mock, 0.3);
    engine.useStyle('zen');
    expect((engine as any).transitioning).toBe(true);

    // Boundary window is at most 4 s of audio clock; the timer is wall-clock.
    mock.advance(4.0);
    await sleep(4200);
    play(engine, mock, 2.0);

    expect(engine.getState().styleId).toBe('zen');
    expect(engine.getState().status).toBe('playing');
    expect((engine as any).transitioning).toBe(false);
    expect(log.some((l) => l.event.metadata?.sourcePlugin === 'zen')).toBe(true);

    // A begin is always paired with an end (the UI re-enables ▶ on 'end').
    await engine.dispose();
  });

  it('clamps the boundary to 0.6–4 s after the current position', async () => {
    // The current style asks for a boundary 60 s away → clamped to ≤ ~4 s.
    {
      const mock = new MockAudioContext();
      const log: { id: string; event: MusicalEvent; at: number }[] = [];
      const engine = makeEngine(mock, log);
      engine.registerStyle(pulseWithBoundary('far-pulse', 60));
      await engine.start();
      play(engine, mock, 0.3);
      engine.useStyle('far-pulse');
      const farTimer = (engine as any).transitionTimer as { _idleTimeout: number };
      expect(farTimer._idleTimeout).toBeLessThanOrEqual(4000);
      mock.advance(4.0);
      await sleep(4200);
      expect(engine.getState().styleId).toBe('far-pulse');
      await engine.dispose();
    }
    // The current style asks for a boundary 0.05 s away → pushed to ≥ ~0.6 s.
    {
      const mock = new MockAudioContext();
      const log: { id: string; event: MusicalEvent; at: number }[] = [];
      const engine = makeEngine(mock, log, 'near-pulse');
      engine.registerStyle(pulseWithBoundary('near-pulse', 0.05));
      await engine.start();
      play(engine, mock, 0.3);
      engine.useStyle('zen');
      const nearTimer = (engine as any).transitionTimer as { _idleTimeout: number };
      expect(nearTimer._idleTimeout).toBeGreaterThanOrEqual(570);
      mock.advance(0.7);
      await sleep(900);
      expect(engine.getState().styleId).toBe('zen');
      expect(engine.getState().status).toBe('playing');
      await engine.dispose();
    }
  }, 15000);

  it('merges requests made mid-transition and lands on the latest target per field', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await engine.start();
    play(engine, mock, 0.5);

    engine.useStyle('zen'); // first target
    engine.setSeed('111');
    engine.setSeed('222'); // later seed overrides the earlier one
    engine.useStyle('pulse'); // later style overrides zen

    expect((engine as any).pendingTarget).toMatchObject({ styleId: 'pulse', seed: '222' });
    expect(engine.getState().styleId).toBe('pulse'); // current style untouched until the boundary

    mock.advance(4.0);
    await sleep(4200);
    play(engine, mock, 1.0);

    expect(engine.getState().styleId).toBe('pulse');
    expect(engine.getState().seed).toBe('222');
    expect((engine as any).pendingTarget).toBeNull();
    expect(engine.getState().status).toBe('playing');
    await engine.dispose();
  });

  it('rejects a mid-transition target with missing dependencies at request time', () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    // A style whose required instrument was never registered.
    engine.registerStyle(boundaryStyle('broken', 1, ['never-registered-instrument']));

    let err: unknown;
    try {
      engine.useStyle('broken');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(EngineError);
    expect((err as EngineError).code).toBe('styleUnavailable');
    expect((engine as any).transitioning).toBe(false);
    expect(engine.getState().styleId).toBe('pulse');
  });

  it('keeps playing the old style when a queued target turns out unplayable (no stuck transition)', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    engine.registerStyle(boundaryStyle('broken', 1, ['never-registered-instrument']));
    await engine.start();
    play(engine, mock, 0.5);

    // White-box: inject a bad target the same way queueTarget() would store one,
    // bypassing request-time validation, to exercise the commit-time safety net.
    engine.useStyle('zen');
    expect((engine as any).transitioning).toBe(true);
    (engine as any).pendingTarget = { styleId: 'broken' };

    const errors: string[] = [];
    engine.eventBus.on('error', ({ message }) => errors.push(message));

    mock.advance(4.0);
    await sleep(4200);

    expect((engine as any).transitioning).toBe(false);
    expect(engine.getState().status).toBe('playing');
    // The merged intent is rejected atomically: the engine stays on the style
    // that was actually playing (pulse), rather than half-applying the switch.
    expect(engine.getState().styleId).toBe('pulse');
    expect(errors.length).toBeGreaterThan(0);
    expect((engine as any).pendingTarget).toBeNull();

    const before = log.length;
    play(engine, mock, 0.6);
    expect(log.length).toBeGreaterThan(before); // audio kept flowing
    await engine.dispose();
  });

  it('rolls back to the previous style if the swap itself throws (never stuck)', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    engine.registerStyle(throwingStyle('exploding'));
    await engine.start();
    play(engine, mock, 0.5);

    // Force the commit path to throw after teardown (defensive branch).
    const original = (engine as any).instantiateStyle.bind(engine);
    const spy = vi.spyOn(engine as any, 'instantiateStyle').mockImplementation(function (
      this: MusicEngine,
    ) {
      if ((this as any).stylePlugin?.id === 'exploding') {
        throw new Error('instantiation failure');
      }
      return original();
    });

    engine.useStyle('exploding');
    mock.advance(4.0);
    await sleep(4200);

    expect((engine as any).transitioning).toBe(false);
    expect(engine.getState().status).toBe('playing');
    expect(engine.getState().styleId).toBe('pulse');
    const before = log.length;
    play(engine, mock, 0.6);
    expect(log.length).toBeGreaterThan(before);

    spy.mockRestore();
    await engine.dispose();
  });

  it('applies the target on resume after pause interrupts the transition, with a continuous timeline', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await engine.start();
    play(engine, mock, 0.5);
    const before = log.length;
    expect(before).toBeGreaterThan(0);

    engine.useStyle('zen');
    expect((engine as any).transitioning).toBe(true);
    engine.pause();
    expect((engine as any).pendingTarget).toMatchObject({ styleId: 'zen' });
    await sleep(180);

    await engine.resume();
    expect(engine.getState().styleId).toBe('zen');
    expect((engine as any).pendingTarget).toBeNull();
    expect(engine.getState().status).toBe('playing');

    play(engine, mock, 0.6);
    const after = log.slice(before);
    expect(after.length).toBeGreaterThan(0);
    // No duplicated dispatch: every (id, at) pair stays unique.
    const keys = new Set(log.map((l) => `${l.id}@${l.at}`));
    expect(keys.size).toBe(log.length);
    // Ordering preserved across the pause boundary.
    for (let i = 1; i < log.length; i++) {
      expect(log[i].at).toBeGreaterThanOrEqual(log[i - 1].at - 1e-9);
    }
    await engine.dispose();
  });

  it('a direct change while paused converges with the interrupted transition target', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await engine.start();
    play(engine, mock, 0.5);

    engine.useStyle('zen'); // interrupted by pause …
    engine.pause();
    expect((engine as any).pendingTarget).toMatchObject({ styleId: 'zen' });

    // … then the user changes their mind while paused.
    engine.useStyle('pulse');
    engine.setSeed('9090');
    expect((engine as any).pendingTarget).toMatchObject({ styleId: 'pulse', seed: '9090' });

    await engine.resume();
    expect(engine.getState().styleId).toBe('pulse');
    expect(engine.getState().seed).toBe('9090');
    expect(engine.getState().status).toBe('playing');
    expect((engine as any).pendingTarget).toBeNull();
    await engine.dispose();
  });

  it('an unplayable pending intent on resume is reported but playback still starts', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    engine.registerStyle(boundaryStyle('broken', 1, ['never-registered-instrument']));
    await engine.start();
    play(engine, mock, 0.5);

    engine.pause();
    await sleep(180);
    // Simulate an intent that became unplayable while playback was paused.
    (engine as any).pendingTarget = { styleId: 'broken', seed: '31337' };

    const errors: string[] = [];
    engine.eventBus.on('error', ({ message }) => errors.push(message));

    await expect(engine.resume()).resolves.toBeUndefined();
    expect(engine.getState().status).toBe('playing');
    expect(engine.getState().styleId).toBe('pulse'); // working style retained
    expect(errors.length).toBeGreaterThan(0);
    // The valid seed half of the intent is preserved for a later retry.
    expect((engine as any).pendingTarget).toMatchObject({ seed: '31337' });

    const before = log.length;
    play(engine, mock, 0.6);
    expect(log.length).toBeGreaterThan(before);
    await engine.dispose();
  });

  it('stop() interrupting a transition still applies the target on the next start()', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await engine.start();
    play(engine, mock, 0.5);

    engine.useStyle('zen');
    engine.stop();
    await sleep(240);
    expect((engine as any).pendingTarget).toMatchObject({ styleId: 'zen' });
    expect(engine.getState().status).toBe('idle');

    await engine.start();
    expect(engine.getState().styleId).toBe('zen');
    expect(engine.getState().status).toBe('playing');
    const before = log.length;
    play(engine, mock, 0.6);
    expect(log.length).toBeGreaterThan(before);
    await engine.dispose();
  });

  it('an explicit idle choice converges over the target interrupted by stop()', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await engine.start();
    play(engine, mock, 0.5);

    engine.useStyle('zen');
    engine.stop(); // zen becomes the saved intent …
    await sleep(240);
    expect((engine as any).pendingTarget).toMatchObject({ styleId: 'zen' });

    // … but while stopped the user explicitly picks pulse and a new seed.
    engine.useStyle('pulse');
    engine.setSeed('5555');
    expect((engine as any).pendingTarget).toMatchObject({ styleId: 'pulse', seed: '5555' });

    await engine.start();
    expect(engine.getState().styleId).toBe('pulse');
    expect(engine.getState().seed).toBe('5555');
    expect(engine.getState().status).toBe('playing');
    expect((engine as any).pendingTarget).toBeNull();
    const before = log.length;
    play(engine, mock, 0.6);
    expect(log.length).toBeGreaterThan(before);
    await engine.dispose();
  });

  it('produces no new events while a transition window is open', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    // The current style reports a boundary exactly 2 s away.
    const engine = makeEngine(mock, log, 'pulse-2s');
    engine.registerStyle(pulseWithBoundary('pulse-2s', 2));
    engine.registerStyle(gridStyle('grid'));
    await engine.start();
    play(engine, mock, 0.5);

    engine.useStyle('grid');
    expect((engine as any).transitioning).toBe(true);

    // Drive the scheduler hard through part of the window: generate() must
    // stay silent and the queue must not be refilled.
    const queuedAtStart = (engine as any).scheduler.queue.size as number;
    play(engine, mock, 0.8, 0.05);
    expect((engine as any).scheduler.queue.size).toBeLessThanOrEqual(queuedAtStart);
    expect((engine as any).transitioning).toBe(true);

    // Let the boundary land; generation resumes afterwards.
    mock.advance(1.4);
    await sleep(2200);
    expect((engine as any).transitioning).toBe(false);
    const before = log.length;
    play(engine, mock, 1.0);
    expect(log.length).toBeGreaterThan(before);
    await engine.dispose();
  });

  it('fires no callbacks and schedules no events after dispose, even past the transition window', async () => {
    const mock = new MockAudioContext();
    const log: { id: string; event: MusicalEvent; at: number }[] = [];
    const engine = makeEngine(mock, log);
    await engine.start();
    play(engine, mock, 0.3);

    engine.useStyle('zen');
    await engine.dispose();

    // Every internal timer must be cleared.
    expect((engine as any).transitionTimer).toBeNull();
    expect((engine as any).stopTimer).toBeNull();
    expect((engine as any).suspendTimer).toBeNull();
    expect((engine as any).watchdog).toBeNull();
    expect((engine as any).scheduler.timer).toBeNull();

    const noteCount = log.length;
    // Wait well beyond the 4 s transition window and the 200 ms stop wind-down.
    mock.advance(6.0);
    await sleep(5200);
    expect(log.length).toBe(noteCount); // no late dispatch
  }, 15000);
});
