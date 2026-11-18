let context;
export default function getContext() {
  if (context) return context;

  context = new (
    typeof AudioContext !== 'undefined' ? window.AudioContext : window.webkitAudioContext
  )();
  return context;
}

// Test-only hook: drop the memoized AudioContext so tests can install a
// controllable fake. Not exercised by production code paths.
export function __resetForTests() {
  context = undefined;
}
