# Acceptance tests

Automated, local verification for the music visualizer. The tests run the
**real** `js/main.js` application inside an iframe against an in-memory
Firebase stub (`firebase-stub.js`) and short WAV files generated in the
browser — no real Firebase credentials and no network access are required.

## What is covered

1. After three consecutive track switches the analyser keeps exactly one
   active source and the player contains exactly one `<audio>` element.
2. Repeated uploads of the same file, library round-trips, and a library pick
   immediately after an upload never leave multiple sources or stale audio.
3. The play/pause marker only appears on the current track's button; old
   buttons lose it after a switch.
4. After resizing, the canvas pixel size, renderer size and camera aspect
   ratio all match the viewport.
5. Across the 700px narrow/desktop breakpoint the library and settings panels
   follow the existing rules — never two modal panels at once.
6. Library search, the clear-search button and the "no matching songs"
   message keep their original behavior.

## Run the tests

### Headless (recommended for automation)

From the repository root:

```sh
npm test
# or directly:
node tests/run-acceptance.js
# or point it at a specific browser:
node tests/run-acceptance.js "C:/Program Files/Google/Chrome/Application/chrome.exe"
```

The runner launches the installed Chrome/Edge over the Chrome DevTools
Protocol using `--remote-debugging-pipe`, so it needs no npm dependencies.
It prints every check as `PASS`/`FAIL` and exits non-zero if anything fails.

### In a browser

Open `tests/acceptance.html` directly (a `file://` URL works). The readable
PASS/FAIL report is rendered on the page.

## Files

- `acceptance.html` — report page hosting the app iframe and result output.
- `acceptance-runner.js` — test scenarios, assertions and synthetic WAV data.
- `app-frame.html` — production DOM/script chain with the stub in place of
  the real Firebase SDK.
- `app-frame-bridge.js` — `postMessage` bridge that drives the app iframe.
- `firebase-stub.js` — in-memory stand-in for the Firebase storage/database
  surface used by `main.js`.
- `run-acceptance.js` — dependency-free headless Chrome/Edge runner.
