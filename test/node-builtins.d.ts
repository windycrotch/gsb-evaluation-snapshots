/**
 * Minimal ambient declarations for the Node.js built-ins used by the tests.
 *
 * The project intentionally does not depend on `@types/node` (it targets the
 * browser), and these tests only need a tiny slice of the Node API. If
 * `@types/node` is ever added, this file can be deleted.
 */

declare module 'node:test' {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  interface AssertStrict {
    (value: unknown, message?: string | Error): void;
    equal(actual: unknown, expected: unknown, message?: string | Error): void;
    deepEqual(actual: unknown, expected: unknown, message?: string | Error): void;
    ok(value: unknown, message?: string | Error): void;
    throws(fn: () => unknown, error?: RegExp | Error | ((err: unknown) => boolean)): void;
  }
  const assert: AssertStrict;
  export default assert;
}
