import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_PARAMETERS,
  PARAMETER_SPECS,
  parameterMessageType,
  resolveInitialParameter,
  validateParameter,
} from "../src/shared/parameters.ts";

test("validateParameter accepts legal values", () => {
  assert.deepEqual(validateParameter("bits", 8), { ok: true, value: 8 });
  assert.deepEqual(validateParameter("normfreq", 0), { ok: true, value: 0 });
  assert.deepEqual(validateParameter("cutoff", 1), { ok: true, value: 1 });
  assert.deepEqual(validateParameter("resonance", 0), { ok: true, value: 0 });
});

test("validateParameter rejects bits that would break quantisation", () => {
  for (const bad of [0, -1, 33, 1.5, Number.NaN, Infinity, -Infinity]) {
    const result = validateParameter("bits", bad);
    assert.equal(result.ok, false, `bits=${String(bad)} should be rejected`);
  }
});

test("validateParameter rejects out-of-range cutoff and non-finite resonance", () => {
  for (const bad of [-0.001, 1.001, Number.NaN, Infinity]) {
    assert.equal(validateParameter("cutoff", bad).ok, false);
  }
  for (const bad of [-0.001, 20.001, Number.NaN, Infinity]) {
    assert.equal(validateParameter("resonance", bad).ok, false);
  }
});

test("validateParameter rejects non-numeric input", () => {
  for (const bad of [undefined, null, "4", {}, [], true]) {
    assert.equal(validateParameter("bits", bad).ok, false);
  }
});

test("error messages name the parameter and the offending value", () => {
  const result = validateParameter("cutoff", Number.NaN);
  assert.equal(result.ok, false);
  if (!result.ok) {
    assert.match(result.message, /Invalid cutoff/);
    assert.match(result.message, /NaN/);
  }

  const bits = validateParameter("bits", 0);
  assert.equal(bits.ok, false);
  if (!bits.ok) {
    assert.match(bits.message, /between 1 and 32/);
  }
});

test("resolveInitialParameter falls back to documented defaults", () => {
  assert.equal(resolveInitialParameter("bits", 0), DEFAULT_PARAMETERS.bits);
  assert.equal(resolveInitialParameter("bits", 8), 8);
  assert.equal(resolveInitialParameter("cutoff", "nope"), DEFAULT_PARAMETERS.cutoff);
});

test("parameterMessageType matches the protocol used by the nodes", () => {
  assert.equal(parameterMessageType("bits"), "set-bits");
  assert.equal(parameterMessageType("normfreq"), "set-normfreq");
  assert.equal(parameterMessageType("cutoff"), "set-cutoff");
  assert.equal(parameterMessageType("resonance"), "set-resonance");
});

test("every parameter spec is a sane range", () => {
  for (const [name, spec] of Object.entries(PARAMETER_SPECS)) {
    assert.ok(spec.min < spec.max, `${name} min must be below max`);
    assert.ok(
      DEFAULT_PARAMETERS[name as keyof typeof DEFAULT_PARAMETERS] >= spec.min &&
        DEFAULT_PARAMETERS[name as keyof typeof DEFAULT_PARAMETERS] <= spec.max,
      `${name} default must be inside its range`
    );
  }
});
