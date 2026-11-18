import { expect, test, vi } from "vitest";

import { defaultDevice, getBackend, init } from "../backend";
import { jit, makeJaxpr, numpy as np } from "../index";
import { jitCompile, type JitProgram } from "./jit";

await init("cpu");

/**
 * Run `fn` with the cpu backend's `maxArgs` temporarily lowered, restoring the
 * original property afterwards so later tests are unaffected.
 */
function withMaxArgs<T>(limit: number, fn: () => T): T {
  defaultDevice("cpu");
  const backend = getBackend("cpu");
  const spy = vi.spyOn(backend, "maxArgs", "get").mockReturnValue(limit);
  try {
    return fn();
  } finally {
    spy.mockRestore();
  }
}

/**
 * Trace `f` with example `np.array` arguments and compile it for the cpu
 * backend at the given `maxArgs` limit, without executing it.
 */
function compileAtLimit(
  f: (...args: any[]) => any,
  nargs: number,
  limit: number,
): JitProgram {
  return withMaxArgs(limit, () => {
    const backend = getBackend("cpu");
    const examples = Array.from({ length: nargs }, () => np.array([1, 2]));
    const { jaxpr } = makeJaxpr(f)(...examples);
    return jitCompile(backend, jaxpr.jaxpr);
  });
}

/**
 * Replay a `JitProgram`'s bookkeeping steps and return any refcount problems.
 *
 * Before the program runs, the caller owns one reference to each input slot and
 * nothing else. After the steps run (and before the caller releases those input
 * references), the accounting must be:
 *
 * - every buffer the program malloc'd and did not return is freed;
 * - an input slot that is not returned is still at the caller's single ref;
 * - each returned handle owns one reference, plus the caller's reference if the
 *   handle aliases an input slot.
 */
function auditRefcounts(jp: JitProgram, nargs: number): string[] {
  const problems: string[] = [];
  const refs = new Map<number, number>();

  // Inputs: the caller owns one reference to each of them.
  for (let i = 0; i < nargs; i++) refs.set(i, 1);

  jp.steps.forEach((step, index) => {
    switch (step.type) {
      case "malloc":
        refs.set(step.output, 1);
        break;
      case "incref":
        if (!refs.has(step.input)) {
          problems.push(`incref of freed slot %${step.input} at step ${index}`);
        } else {
          refs.set(step.input, refs.get(step.input)! + 1);
        }
        break;
      case "free":
        if (!refs.has(step.input)) {
          problems.push(`free of freed slot %${step.input} at step ${index}`);
        } else if (refs.get(step.input)! > 1) {
          problems.push(
            `free of still-referenced slot %${step.input} at step ${index}`,
          );
        } else {
          refs.delete(step.input);
        }
        break;
      case "execute":
        for (const id of [...step.inputs, ...step.outputs]) {
          if (!refs.has(id))
            problems.push(`use of freed slot %${id} at step ${index}`);
        }
        break;
    }
  });

  const outputCounts = new Map<number, number>();
  for (const id of jp.outputs) {
    outputCounts.set(id, (outputCounts.get(id) ?? 0) + 1);
  }

  for (const [id, held] of refs) {
    const handles = outputCounts.get(id) ?? 0;
    const isInput = id < nargs;
    const expected = handles + (isInput ? 1 : 0);
    if (held !== expected) {
      problems.push(
        `slot %${id} holds ${held} reference(s), expected ${expected}` +
          ` (${handles} output handle(s)${isInput ? ", caller-owned input" : ""})`,
      );
    }
  }
  // Any output slot with no live reference at all is a dangling output.
  for (const id of outputCounts.keys()) {
    if (!refs.has(id)) problems.push(`output %${id} has no live reference`);
  }
  return problems;
}

test("splits kernels that exceed maxArgs when an input is already black", () => {
  // WebGPU and WebGL allow 7-8 buffers per kernel. Lower the limit on the cpu
  // backend so a small program has to be split.
  withMaxArgs(3, () => {
    // The where() sees 4 buffers: w through its condition, and a, b, c through
    // y and sin(y). The condition is marked black first, which is not enough,
    // so y must be marked black next instead of the condition again.
    const f = jit((w: np.Array, a: np.Array, b: np.Array, c: np.Array) => {
      const y = a.add(b).add(c);
      return np.where(w.ref.greater(0), y.ref, np.sin(y));
    });
    const out = f(
      np.array([1, -1]),
      np.array([1, 2]),
      np.array([3, 4]),
      np.array([5, 6]),
    );
    const [x0, x1] = out.js() as number[];
    expect(x0).toBeCloseTo(9);
    expect(x1).toBeCloseTo(Math.sin(12));
  });

  // The split must be complete: no dispatched kernel may reference more input
  // buffers than the backend allows.
  const jp = compileAtLimit(
    (w: np.Array, a: np.Array, b: np.Array, c: np.Array) => {
      const y = a.add(b).add(c);
      return np.where(w.ref.greater(0), y.ref, np.sin(y));
    },
    4,
    3,
  );
  for (const step of jp.steps) {
    if (step.type === "execute")
      expect(step.inputs.length).toBeLessThanOrEqual(3);
  }
});

test("splits a kernel twice when the intermediate is reused", () => {
  withMaxArgs(3, () => {
    // A longer chain forces two rounds of splitting: the first pass materializes
    // `s` (a+b+c) as a black node, but the fused result still references the
    // four inputs w, a, b, c (through s and d), so `y` (s+d) must be
    // materialized in a second pass.
    const f = jit(
      (w: np.Array, a: np.Array, b: np.Array, c: np.Array, d: np.Array) => {
        const s = a.add(b).add(c);
        const y = s.add(d);
        return np.where(w.ref.greater(0), y.ref, np.sin(y));
      },
    );
    const out = f(
      np.array([1, -1]),
      np.array([1, 2]),
      np.array([3, 4]),
      np.array([5, 6]),
      np.array([7, 8]),
    );
    const [x0, x1] = out.js() as number[];
    expect(x0).toBeCloseTo(16);
    expect(x1).toBeCloseTo(Math.sin(20));
  });
});

test("materialized intermediates are freed after their last use", () => {
  // The where() program below is split into three dispatched kernels: the
  // intermediate `y`, the condition, and the final select. `y` and the
  // condition are therefore materialized into their own buffers, and each one
  // must be released right after the kernel that consumes it.
  const jp = compileAtLimit(
    (w: np.Array, a: np.Array, b: np.Array, c: np.Array) => {
      const y = a.add(b).add(c);
      return np.where(w.ref.greater(0), y.ref, np.sin(y));
    },
    4,
    3,
  );

  // Sanity check: this really is the split case, not a single fused kernel.
  const kernels = jp.steps.filter((step) => step.type === "execute");
  expect(kernels.length).toBeGreaterThan(1);

  expect(auditRefcounts(jp, 4)).toEqual([]);

  // Each materialized intermediate has a `free` step after its last `execute`.
  const mallocs = jp.steps.flatMap((step, index) =>
    step.type === "malloc" && !jp.outputs.includes(step.output)
      ? [{ id: step.output, index }]
      : [],
  );
  expect(mallocs.length).toBeGreaterThan(0);
  for (const { id } of mallocs) {
    const free = jp.steps.findIndex(
      (step) => step.type === "free" && step.input === id,
    );
    const lastExecute = jp.steps.findLastIndex(
      (step) =>
        step.type === "execute" &&
        (step.inputs.includes(id) || step.outputs.includes(id)),
    );
    expect(free).toBeGreaterThan(lastExecute);
  }
});

test("gives each output its own reference when slots are shared", () => {
  // The same computed slot is returned twice. The program must emit an extra
  // `incref` so that each output handle owns a reference instead of the two
  // handles sharing one owner (which would free the slot after the first
  // handle is consumed).
  const jp = compileAtLimit(
    (a: np.Array, b: np.Array) => {
      const r = a.add(b);
      return [r.ref, r];
    },
    2,
    8,
  );

  expect(jp.outputs).toHaveLength(2);
  expect(jp.outputs[0]).toBe(jp.outputs[1]); // same slot, aliased output
  expect(jp.steps.some((step) => step.type === "incref")).toBe(true);
  expect(auditRefcounts(jp, 2)).toEqual([]);
});

test("gives a direct input output its own reference", () => {
  // An output that is also an input must not be freed by the program; the
  // returned handle needs its own reference.
  const jp = compileAtLimit((a: np.Array, b: np.Array) => [a.add(b), a], 2, 8);

  expect(jp.outputs).toContain(0); // input 0 is returned directly
  expect(jp.steps.some((step) => step.type === "incref")).toBe(true);
  expect(auditRefcounts(jp, 2)).toEqual([]);
});

test("releases all split intermediates at runtime", () => {
  withMaxArgs(3, () => {
    const backend = getBackend("cpu");

    // Track live buffer slots so that a leaked intermediate shows up as a
    // leftover allocation after the JIT program runs to completion.
    const live = new Set<number>();
    const originalMalloc = backend.malloc.bind(backend);
    const originalDecRef = backend.decRef.bind(backend);
    const malloc = vi
      .spyOn(backend, "malloc")
      .mockImplementation((size: number, initial?: Uint8Array) => {
        const slot = originalMalloc(size, initial);
        live.add(slot);
        return slot;
      });
    const decRef = vi
      .spyOn(backend, "decRef")
      .mockImplementation((slot: number) => {
        originalDecRef(slot);
        live.delete(slot);
      });

    try {
      const f = jit((w: np.Array, a: np.Array, b: np.Array, c: np.Array) => {
        const y = a.add(b).add(c);
        return np.where(w.ref.greater(0), y.ref, np.sin(y));
      });
      // Note: `jit()` consumes its input arguments, so they are not disposed
      // here; their backend buffers are released along with them.
      const out = f(
        np.array([1, -1]),
        np.array([1, 2]),
        np.array([3, 4]),
        np.array([5, 6]),
      );
      // Only the single output buffer may still be alive: every materialized
      // intermediate was freed after its last use.
      expect(live.size).toBe(1);

      const values = out.js() as number[];
      expect(values[0]).toBeCloseTo(9);
      expect(values[1]).toBeCloseTo(Math.sin(12));
      expect(live.size).toBe(0);
    } finally {
      malloc.mockRestore();
      decRef.mockRestore();
    }
  });
});

test("does not resplit an already materialized input", () => {
  withMaxArgs(2, () => {
    // With three distinct inputs feeding a single kernel there is nothing left
    // to materialize, so the compiler must report an explicit internal error
    // rather than looping or emitting an over-limit kernel.
    const f = jit((a: np.Array, b: np.Array, c: np.Array) =>
      np.where(a.greater(0), b, c),
    );
    expect(() =>
      f(np.array([1, -1]), np.array([1, 2]), np.array([3, 4])),
    ).toThrowError(/maxArgs, no input found to mark as black/);
  });
});

test("restores maxArgs after a lowered-limit compile", () => {
  defaultDevice("cpu");
  const backend = getBackend("cpu");
  const original = backend.maxArgs;

  withMaxArgs(3, () => {
    const f = jit((w: np.Array, a: np.Array, b: np.Array, c: np.Array) => {
      const y = a.add(b).add(c);
      return np.where(w.ref.greater(0), y.ref, np.sin(y));
    });
    f(np.array([1, -1]), np.array([1, 2]), np.array([3, 4]), np.array([5, 6]));
  });

  expect(backend.maxArgs).toBe(original);

  // Compiling a different program after restoring the limit must work normally.
  const g = jit((w: np.Array, a: np.Array, b: np.Array, c: np.Array) => {
    const y = a.add(b).add(c).add(w.ref);
    return np.where(w.greater(0), y.ref, np.sin(y));
  });
  const out = g(
    np.array([1, -1]),
    np.array([1, 2]),
    np.array([3, 4]),
    np.array([5, 6]),
  );
  const [x0, x1] = out.js() as number[];
  expect(x0).toBeCloseTo(10);
  expect(x1).toBeCloseTo(Math.sin(11));
});
