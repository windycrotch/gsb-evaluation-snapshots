/**
 * Minimal ambient declarations for the Node built-in test runner used by the
 * local verification suite. The project deliberately has no @types/node
 * dependency; esbuild strips these types at bundle time anyway.
 */

declare module 'node:test' {
  export function test(name: string, fn: (t?: unknown) => void | Promise<void>): void;
}

declare module 'node:assert/strict' {
  const assert: {
    equal(actual: unknown, expected: unknown, message?: string): void;
    deepEqual(actual: unknown, expected: unknown, message?: string): void;
    ok(value: unknown, message?: string): void;
    match(actual: string, regexp: RegExp, message?: string): void;
    doesNotThrow(fn: () => unknown, message?: string): void;
  };
  export default assert;
}

declare module 'node:child_process' {
  export function spawn(
    command: string,
    args: string[],
    options: { stdio?: string; cwd?: string }
  ): { on(event: 'exit', listener: (code: number | null) => void): void };
}

declare module 'node:fs' {
  export function rmSync(path: string, options?: { recursive?: boolean; force?: boolean }): void;
}

declare module 'node:url' {
  export function fileURLToPath(url: string | URL): string;
}

declare module 'node:path' {
  export function dirname(path: string): string;
  export function join(...paths: string[]): string;
}

declare const process: {
  execPath: string;
  exit(code?: number): void;
};

declare const queueMicrotask: (callback: () => void) => void;
