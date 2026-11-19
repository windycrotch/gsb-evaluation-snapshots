// React 19 requires this flag whenever state updates are wrapped in act()
// outside of a test renderer that sets it itself.
(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
