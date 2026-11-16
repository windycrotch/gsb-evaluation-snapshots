/**
 * Golden-baseline capture for the style seed-derivation refactor.
 *
 * Run ONCE against the pre-refactor implementation and commit the JSON it
 * writes under tests/fixtures/seed-baseline/. The refactor must reproduce
 * these event arrays field-for-field (see tests/core/StyleSeeding.test.ts).
 *
 *   npx vite-node scripts/capture-seed-baseline.ts
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { lofiPlugin } from '../src/styles/lofi';
import { zenPlugin } from '../src/styles/zen';
import type { MusicalEvent, ParamValue, StylePlugin } from '../src/core/types';

const here = dirname(fileURLToPath(import.meta.url));
const outDir = resolve(here, '..', 'tests', 'fixtures', 'seed-baseline');

function defaults(plugin: StylePlugin): Record<string, ParamValue> {
  const out: Record<string, ParamValue> = {};
  for (const def of plugin.parameters) out[def.id] = def.default;
  return out;
}

function headlessContext() {
  return {
    audioContext: null as any,
    random: null as any,
    instruments: { get: () => undefined },
    fx: { get: () => undefined, has: () => false },
    spatial: { setStereoWidth: () => {}, setMovement: () => {}, getMovement: () => 0 },
    eventBus: { emit: () => {} },
  };
}

/** Single [0, horizon] window — the canonical, window-independent ordering. */
function capture(plugin: StylePlugin, seed: string, horizon: number): MusicalEvent[] {
  const instance = plugin.create({ seed, parameters: defaults(plugin) });
  instance.start(headlessContext());
  return instance.generateEvents({ random: null as any, from: 0, to: horizon });
}

const TARGETS: { plugin: StylePlugin; horizon: number; seeds: string[] }[] = [
  { plugin: lofiPlugin, horizon: 60, seeds: ['12345', '777', 'lofi-zen-2026'] },
  { plugin: zenPlugin, horizon: 240, seeds: ['42', '9001', 'lofi-zen-2026'] },
];

mkdirSync(outDir, { recursive: true });
for (const { plugin, horizon, seeds } of TARGETS) {
  for (const seed of seeds) {
    const events = capture(plugin, seed, horizon);
    const file = resolve(outDir, `${plugin.id}-${seed}.json`);
    writeFileSync(file, JSON.stringify(events, null, 1) + '\n', 'utf8');
    console.log(`${file.replace(here, '.')}  ${events.length} events`);
  }
}
