/**
 * Property test: random editor sessions (see fuzzkit.ts for the invariants).
 * FUZZ_SEEDS / FUZZ_STEPS scale the run; the defaults keep `npm test` fast.
 */
import { describe, it } from 'vitest';
import { playSession } from './fuzzkit';

const SEEDS = Number(process.env.FUZZ_SEEDS ?? 12);
const STEPS = Number(process.env.FUZZ_STEPS ?? 70);
const FROM = Number(process.env.FUZZ_FROM ?? 1);

describe('fuzz: random editor sessions', () => {
  for (let seed = FROM; seed < FROM + SEEDS; seed++) {
    it(`seed ${seed} (${STEPS} actions)`, () => void playSession(seed, STEPS), 60_000);
  }
});
