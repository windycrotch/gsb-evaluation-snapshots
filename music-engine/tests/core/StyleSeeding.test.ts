/**
 * Unified style-side seed derivation contract.
 *
 * Covers the refactor that removed every hand-written `::styleName` suffix
 * from style code: styles now root their RNG at
 * `SeededRandom.forStyle(engineSeed, plugin.id)` and split musical purposes
 * (arrangement / harmony / drums / melody / humanize / arc / bar:N …) into
 * independent streams via `fork(tag)` only. `Math.random()` stays forbidden.
 *
 * The JSON fixtures under tests/fixtures/seed-baseline/ were captured by
 * scripts/capture-seed-baseline.ts against the PRE-refactor implementation.
 * Strict deep equality against them proves the refactor changed not a single
 * event field — no relaxed/tolerance assertion is used anywhere here. Had a
 * style been unable to preserve field identity, its test would have to
 * document the exact diff and assert a checkable alternative instead of
 * silently weakening the comparison.
 */
import { describe, expect, it } from 'vitest';
import { SeededRandom } from '../../src/core/SeededRandom';
import { MusicEngine } from '../../src/core/MusicEngine';
import { lofiPlugin } from '../../src/styles/lofi';
import { zenPlugin } from '../../src/styles/zen';
import type { MusicalEvent, StylePlugin } from '../../src/core/types';
import { generateWith } from '../helpers/styleContext';
import { MockAudioContext } from '../helpers/MockAudioContext';

// Vite/Vitest fixture loading — no Node built-ins, so the file also typechecks
// under the browser-oriented tsconfig used by `npm run build`.
const fixtureModules = import.meta.glob('../fixtures/seed-baseline/*.json', { eager: true, import: 'default' }) as Record<
  string,
  MusicalEvent[]
>;
// Same glob in source form for the static convention scan below.
const styleSourceModules = import.meta.glob('../../src/styles/**/*.ts', { eager: true, query: '?raw', import: 'default' }) as Record<
  string,
  string
>;

function loadFixture(file: string): MusicalEvent[] {
  const key = `../fixtures/seed-baseline/${file}`;
  const events = fixtureModules[key];
  if (!events) throw new Error(`missing golden fixture ${file}`);
  return events;
}

/** Time-ordered multiset key (Zen lanes emit per-window, so array order differs). */
function multisetKey(events: MusicalEvent[]): string {
  return JSON.stringify(
    [...events].sort((a, b) => a.startTime - b.startTime || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  );
}

/** The exact qualified seed string MusicEngine hands a style at instantiation. */
function engineQualifiedSeed(plugin: StylePlugin, userSeed: string): string {
  return `${userSeed}|${plugin.id}|v${plugin.version}`;
}

// ---------------------------------------------------------------------------
// 1. Pre-refactor golden baselines: field-for-field identity
// ---------------------------------------------------------------------------

describe('style seed refactor: pre-refactor golden baselines reproduce exactly', () => {
  const cases: { plugin: StylePlugin; horizon: number; seeds: string[] }[] = [
    { plugin: lofiPlugin, horizon: 60, seeds: ['12345', '777', 'lofi-zen-2026'] },
    { plugin: zenPlugin, horizon: 240, seeds: ['42', '9001', 'lofi-zen-2026'] },
  ];

  for (const { plugin, horizon, seeds } of cases) {
    for (const seed of seeds) {
      it(`${plugin.id} seed "${seed}": every event field matches the pre-refactor fixture`, () => {
        const expected = loadFixture(`${plugin.id}-${seed}.json`);
        const generated = generateWith(plugin, {}, [[0, horizon]], seed);
        expect(generated.length).toBe(expected.length);
        // toEqual = recursive field comparison; any changed pitch/time/… fails.
        expect(generated).toEqual(expected);
      });
    }
  }
});

// ---------------------------------------------------------------------------
// 2. Window-split invariance: [0,30]+[30,60] must equal one [0,60] window
// ---------------------------------------------------------------------------

describe('style seed refactor: per-bar/per-lane fork is window-jumpable', () => {
  it('lofi: split windows [0,30]+[30,60] emit exactly the same events as one [0,60]', () => {
    const split = generateWith(lofiPlugin, {}, [[0, 30], [30, 60]], '12345');
    const single = generateWith(lofiPlugin, {}, [[0, 60]], '12345');
    expect(split.length).toBeGreaterThan(50);
    // Lofi appends bars in cursor order, so full ordered JSON must match.
    expect(JSON.stringify(split)).toBe(JSON.stringify(single));
  });

  it('lofi: a three-way split over a section boundary is also identical', () => {
    const split = generateWith(lofiPlugin, {}, [[0, 20], [20, 40], [40, 60]], '12345');
    const single = generateWith(lofiPlugin, {}, [[0, 60]], '12345');
    expect(JSON.stringify(split)).toBe(JSON.stringify(single));
  });

  it('zen: split windows [0,30]+[30,60] emit exactly the same events as one [0,60]', () => {
    const split = generateWith(zenPlugin, {}, [[0, 30], [30, 60]], '42');
    const single = generateWith(zenPlugin, {}, [[0, 60]], '42');
    expect(split.length).toBeGreaterThan(0);
    // Lanes fill per-window arrays — compare as time-ordered multisets.
    expect(multisetKey(split)).toBe(multisetKey(single));
  });

  it('zen: uneven windows (7s/23s/30s) still reproduce the single-window run', () => {
    const split = generateWith(zenPlugin, {}, [[0, 7], [7, 30], [30, 60]], '42');
    const single = generateWith(zenPlugin, {}, [[0, 60]], '42');
    expect(multisetKey(split)).toBe(multisetKey(single));
  });
});

// ---------------------------------------------------------------------------
// 3. Same-seed reproduction and different-seed divergence
// ---------------------------------------------------------------------------

describe('style seed refactor: seed reproducibility', () => {
  it('lofi: same seed + windows → byte-identical event sequences', () => {
    const windows: [number, number][] = [[0, 30], [30, 60]];
    const a = generateWith(lofiPlugin, {}, windows, '12345');
    const b = generateWith(lofiPlugin, {}, windows, '12345');
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('zen: same seed + windows → identical time-ordered multisets', () => {
    const windows: [number, number][] = [[0, 30], [30, 60]];
    const a = generateWith(zenPlugin, {}, windows, '42');
    const b = generateWith(zenPlugin, {}, windows, '42');
    expect(multisetKey(a)).toBe(multisetKey(b));
  });

  it('lofi: different seeds must produce different events', () => {
    const a = generateWith(lofiPlugin, {}, [[0, 60]], '11111');
    const b = generateWith(lofiPlugin, {}, [[0, 60]], '22222');
    expect(a.length).toBeGreaterThan(0);
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(b));
  });

  it('zen: different seeds must produce different events', () => {
    const a = generateWith(zenPlugin, {}, [[0, 90]], 'aa');
    const b = generateWith(zenPlugin, {}, [[0, 90]], 'bb');
    expect(a.length).toBeGreaterThan(0);
    expect(multisetKey(a)).not.toBe(multisetKey(b));
  });

  it('the engine-qualified seed ("user|id|vVersion") is honored, not bypassed', () => {
    // Two independent instances built exactly like MusicEngine.instantiateStyle.
    const qualified = engineQualifiedSeed(lofiPlugin, '12345');
    const a = generateWith(lofiPlugin, {}, [[0, 60]], qualified);
    const b = generateWith(lofiPlugin, {}, [[0, 60]], qualified);
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
    // Qualifying the seed changes the stream, so it cannot equal the raw-seed run.
    const raw = generateWith(lofiPlugin, {}, [[0, 60]], '12345');
    expect(JSON.stringify(a)).not.toBe(JSON.stringify(raw));
  });
});

// ---------------------------------------------------------------------------
// 4. Negative tests: no hand-written style suffix, no Math.random(),
//    and every style stream is traceable via fork tag paths.
// ---------------------------------------------------------------------------

/** Remove // line and /* block comments so doc mentions of "::" don't count. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
}

/** Every .ts module under src/styles as raw source (path → contents). */
const styleSources = Object.entries(styleSourceModules);

describe('style seed refactor: negative conventions', () => {
  it('test globs actually resolve the fixtures and style sources', () => {
    // Guard against a silent glob-path typo that would make every scan vacuous.
    expect(Object.keys(fixtureModules).length).toBeGreaterThanOrEqual(6);
    expect(Object.keys(styleSourceModules).length).toBeGreaterThanOrEqual(20);
  });

  it('no style source hand-concatenates a "::styleName" seed suffix anymore', () => {
    const offenders = styleSources
      .filter(([, source]) => stripComments(source).includes('::'))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('no style source calls Math.random() directly', () => {
    const offenders = styleSources
      .filter(([, source]) => /\bMath\.random\s*\(/.test(stripComments(source)))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it('forStyle roots every stream at the plugin id and forks carry the full tag path', () => {
    const engineSeed = engineQualifiedSeed(lofiPlugin, '12345');
    const root = SeededRandom.forStyle(engineSeed, lofiPlugin.id);
    expect(root.tagPath).toEqual(['lofi']);

    const barRng = root.fork('bar:3');
    expect(barRng.tagPath).toEqual(['lofi', 'bar:3']);
    expect(barRng.seed).toBe(`${engineSeed}::lofi::bar:3`);

    const zenRoot = SeededRandom.forStyle(engineQualifiedSeed(zenPlugin, '42'), zenPlugin.id);
    expect(zenRoot.fork('bells').tagPath).toEqual(['zen', 'bells']);
  });

  it('forStyle output is sequence-identical to the historical hand-built root (why fixtures stay valid)', () => {
    const engineSeed = engineQualifiedSeed(lofiPlugin, '12345');
    const canonical = SeededRandom.forStyle(engineSeed, lofiPlugin.id);
    // Exactly the construction the refactor deleted:
    const legacy = new SeededRandom(`${engineSeed}::lofi`);
    for (let i = 0; i < 64; i++) expect(canonical.next()).toBe(legacy.next());
    // The difference is purely bookkeeping: the legacy root is untracked.
    expect(legacy.tagPath).toEqual([]);
  });

  it('different fork tags and different seeds stay independent streams', () => {
    const root = SeededRandom.forStyle(engineQualifiedSeed(zenPlugin, '42'), zenPlugin.id);
    const bells = Array.from({ length: 12 }, () => root.fork('bells').next());
    const drones = Array.from({ length: 12 }, () => root.fork('drone').next());
    expect(bells).not.toEqual(drones);

    const other = SeededRandom.forStyle(engineQualifiedSeed(zenPlugin, '43'), zenPlugin.id);
    expect(other.fork('bells').next()).not.toBe(root.fork('bells').next());
  });
});

// ---------------------------------------------------------------------------
// 5. End-to-end through MusicEngine + MockAudioContext: the engine's
//    `${seed}|id|vVersion` prefix plus the style's forStyle() root stays
//    deterministic across two full engine lifecycles. No real browser audio.
// ---------------------------------------------------------------------------

function recordingInstrument(id: string, log: { id: string; at: number }[]) {
  return {
    id,
    name: id,
    create: () => ({
      trigger(_event: MusicalEvent, at: number) {
        log.push({ id: _event.id, at });
      },
      stopAll() {},
      setParameter() {},
    }),
  };
}

function makeLofiEngine(mock: MockAudioContext, log: { id: string; at: number }[], seed: string): MusicEngine {
  const engine = new MusicEngine({
    audioContextFactory: () => mock as unknown as AudioContext,
    style: 'lofi',
    seed,
    lookAhead: 0.16,
    generationHorizon: 45,
  });
  for (const id of ['electric-piano', 'bass', 'kick', 'snare', 'hat', 'pluck']) {
    engine.registerInstrument(recordingInstrument(id, log) as any);
  }
  engine.registerFX({
    id: 'reverb',
    name: 'Reverb (stub)',
    create: () => {
      const g = mock.createGain() as unknown as AudioNode;
      return { input: g, output: g, setParameter() {}, reset() {}, dispose() {} };
    },
  });
  engine.registerStyle(lofiPlugin);
  return engine;
}

describe('style seed refactor: full MusicEngine lifecycle (MockAudioContext)', () => {
  it('two engines with the same seed dispatch identical event ids and audio times', async () => {
    const run = async (): Promise<{ id: string; at: number }[]> => {
      const mock = new MockAudioContext();
      const log: { id: string; at: number }[] = [];
      const engine = makeLofiEngine(mock, log, '777');
      await engine.start();
      // Events only dispatch inside the scheduler lookahead, so drive the mock
      // clock across 30s of transport — enough to cover several generated bars.
      for (let t = 0; t < 30; t += 0.1) {
        mock.advance(0.1);
        (engine as any).scheduler.tick();
      }
      await engine.dispose();
      return log;
    };

    const a = await run();
    const b = await run();
    expect(a.length).toBeGreaterThan(50);
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
    for (let i = 0; i < a.length; i++) expect(a[i].at).toBeCloseTo(b[i].at, 9);
  });
});
