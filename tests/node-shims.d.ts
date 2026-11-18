/**
 * Minimal ambient declarations for Node's built-in test runner and assertion
 * module. The full @types/node package is not installed (the test suite runs
 * offline on Node's native TypeScript type-stripping), so only the surfaces the
 * tests actually use are declared here. Runtime behavior comes from Node
 * itself; these types exist solely for `tsc --noEmit`.
 */

declare module 'node:test' {
  export function describe(name: string, fn: () => void): void;
  export function it(name: string, fn: () => void | Promise<void>): void;
  export function test(name: string, fn: () => void | Promise<void>): void;
  export function before(fn: () => void | Promise<void>): void;
  export function after(fn: () => void | Promise<void>): void;
  export function beforeEach(fn: () => void | Promise<void>): void;
  export function afterEach(fn: () => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  interface StrictAssert {
    (value: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    equal(actual: unknown, expected: unknown, message?: string): void;
    notEqual(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    notDeepEqual(actual: unknown, expected: unknown, message?: string): void;
    throws(fn: () => unknown, error?: unknown, message?: string): void;
    fail(message?: string): never;
    match(actual: string, regexp: RegExp, message?: string): void;
  }
  const assert: StrictAssert;
  export default assert;
}
