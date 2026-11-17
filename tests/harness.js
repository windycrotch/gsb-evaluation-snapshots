// Zero-dependency micro test harness that runs the same suite under Node
// (`node tests/run-node.mjs`) and directly in a browser (`tests/index.html`).
// No test framework, npm install, GPU or network required.
//
// Tests are serialized through a promise queue: `it` callbacks may be async,
// and the shared game event bus is a module singleton, so concurrent tests
// would observe each other's events.

export const state = {
  passed: 0,
  failed: 0,
  failures: [],
  currentSuite: "",
  queue: Promise.resolve(),
};

export function describe(name, fn) {
  const parent = state.currentSuite;
  state.currentSuite = parent ? `${parent} > ${name}` : name;
  fn();
  state.currentSuite = parent;
}

export function it(name, fn) {
  const label = state.currentSuite ? `${state.currentSuite} > ${name}` : name;
  // Chain onto the queue so tests run one at a time, in declaration order.
  state.queue = state.queue.then(async () => {
    try {
      await fn();
      state.passed += 1;
      console.log(`  ok   ${label}`);
    } catch (err) {
      state.failed += 1;
      state.failures.push({ label, err });
      console.log(`  FAIL ${label}`);
      console.log(`       ${err && err.message ? err.message : err}`);
    }
  });
  return state.queue;
}

export function ok(cond, message) {
  if (!cond) throw new Error(message || "expected truthy value");
}

export function eq(actual, expected, message) {
  if (!Object.is(actual, expected)) {
    throw new Error(
      `${message || "equality"}: expected ${fmt(expected)}, got ${fmt(actual)}`
    );
  }
}

export function approxEq(actual, expected, eps = 1e-9, message) {
  if (typeof actual !== "number" || Math.abs(actual - expected) > eps) {
    throw new Error(
      `${message || "approx equality"}: expected ${fmt(expected)} ±${eps}, got ${fmt(actual)}`
    );
  }
}

export function throws(fn, message) {
  let threw = false;
  try {
    fn();
  } catch {
    threw = true;
  }
  if (!threw) throw new Error(message || "expected function to throw");
}

function fmt(v) {
  if (typeof v === "string") return JSON.stringify(v);
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

export function summary() {
  const total = state.passed + state.failed;
  return { total, passed: state.passed, failed: state.failed };
}

/** Run a list of suite modules; each default-exports an async function. */
export async function runSuites(suites) {
  for (const suite of suites) {
    await suite();
  }
  // Wait for every queued test to drain.
  await state.queue;
  const { total, passed, failed } = summary();
  console.log(`\n${passed}/${total} passed, ${failed} failed`);
  if (failed > 0) {
    for (const f of state.failures) {
      console.log(`\nFAILED: ${f.label}`);
      console.log(f.err && f.err.stack ? f.err.stack : String(f.err));
    }
  }
  return failed === 0;
}
