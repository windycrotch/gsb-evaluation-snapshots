import * as ConsoleState from '../../src/ui/console-store.mjs';

// Each evaluated DOM fixture gets its own real Zustand store, just like a tab.
export function newStateFunction(...args) {
  const body = args.pop();
  const prelude = body.includes('CWConsoleState.createConsoleRuntime()') ? '' : `
    const { consoleStore, stateActions, bindConsoleSlice, patchConsoleSlice, setConsoleValue, mutateConsoleValue, bindConsoleObject } = CWConsoleState.createConsoleRuntime();
  `;
  const execute = new Function('CWConsoleState', ...args, prelude + body);
  return (...values) => execute(ConsoleState, ...values);
}
