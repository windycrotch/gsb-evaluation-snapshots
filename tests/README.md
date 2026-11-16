# Offline tests

These tests cover the two real player chains: **sound code evaluation** and
**mute/unmute toggling**. They run with plain Node.js (>= 22) — no Meteor
server, no `npm install`, and **no real audio device**: the Tone.js objects
are fakes (`tests/helpers.mjs`) that only record `start`/`stop`/`dispose` calls.

Run from the repo root:

```sh
npm test
# or directly:
node --import ./tests/register-shims.mjs --test "tests/*.test.mjs"
```

## What is covered

`tests/evalCode.test.mjs` — code evaluation (`imports/client/components/code/evalCode.js`):

- normal generation: result is `{status: 'ok'}` with `c`, `e`, `o`
- syntax errors → `{status: 'err', errorType: 'syntax'}` (`EDITOR SYNTAX ERROR => ...`)
- structure errors → `{status: 'err', errorType: 'structure'}` (`EDITOR RESULT ERROR => ...`):
  missing `c`, missing `e`, non-object result, `o.vars` entries that are not arrays

`tests/soundEngine.test.mjs` — the player chain (`imports/client/components/player/soundEngine.js`)
wired to the real `evalCode`:

- normal generation starts exactly one tone
- on evaluation error the previous live tone is **kept** (not stopped/disposed)
  and the error is exposed per sound
- fixing the code clears the error and replaces the tone
- a muted sound produces no tone object; muting stops and removes the tone
- unmuting regenerates the tone from the current code
- mute/unmute with broken code shows the error and leaves **no** old tone behind

## How it works without node_modules

`tests/register-shims.mjs` registers `tests/loader-hooks.mjs`, which:

- redirects the `esprima` import (used by `prepareCode.js`) to
  `tests/esprima-shim.mjs`, a minimal `parseModule` implementation — real
  syntax errors are still caught by `eval()` inside `evalCode`, as in production;
- appends `.js` to Meteor-style extensionless relative imports.

`evalCode` receives its `Tone` dependency via an injected scope, and
`soundEngine` receives all side effects (`startTone`, `stopTone`, `dispose`,
persistence, `onChange`) as injected deps, so the whole chain is tested
against in-memory fakes.
