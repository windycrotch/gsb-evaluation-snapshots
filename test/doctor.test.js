import assert from 'node:assert/strict';
import { test } from 'node:test';
import { earshotCheck } from '../src/doctor.js';

// earshot doctor prints lines of "key: value"; models_cached is JSON (from earshot 0.4.1 on the test laptop)
const out = cached => ({ status: 0, stdout: `precision: bf16\nmodels_cached: ${JSON.stringify(cached)}\nproblems: []\n` });

test('earshot is an optional check: missing, installed without models, or ready', () => {
  const missing = earshotCheck(() => ({ error: new Error('spawnSync earshot ENOENT'), status: null }));
  assert.deepEqual([missing.ok, missing.optional, missing.detail], [false, true, 'not installed']);
  assert.match(missing.fix, /github\.com\/Leonxlnx\/earshot/);
  const noModels = earshotCheck(() => out({ 'laion/larger_clap_general': true, 'MIT/ast-finetuned-audioset-10-10-0.4593': false }));
  assert.deepEqual([noModels.ok, noModels.detail], [false, 'installed, models not downloaded']);
  assert.match(noModels.fix, /earshot doctor --fetch/);
  const ready = earshotCheck(() => out({ 'laion/larger_clap_general': true, 'MIT/ast-finetuned-audioset-10-10-0.4593': true }));
  assert.deepEqual([ready.ok, ready.optional, ready.detail], [true, true, 'models downloaded']);
  assert.equal(earshotCheck(() => ({ status: 0, stdout: 'something else' })).detail, 'installed, its doctor output was not understood');
});
