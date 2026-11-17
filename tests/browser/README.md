# Browser tests

These tests run real WebGL inside a Playwright-driven Chromium instance
(`vitest --project browser`, see `vitest.config.ts`). They cover the shared
worker/shared WebGL context presentation logic:

- `shared-context.test.ts` — many canvases of different sizes (4×4, 16×2, 2×16)
  mixing single-pass and two-pass (ping-pong FBO) shader groups on one worker
  and one WebGL context; per-canvas pixel correctness, output-canvas resizing,
  invalid-shader rejection, and destroying one canvas without disturbing the
  others.
- `worker-release.test.ts` — drives a dedicated worker with raw
  `INIT` / `CALL_METHOD` / `RELEASE` messages to verify that releasing one
  canvas leaves the surviving canvases (and newly initialised ones) drawing
  correctly.
- `gl-manager.test.ts`, `proxy.test.ts`, `component.test.ts`,
  `frame-scheduler.test.ts` — manager, proxy, React component and scheduler
  behaviour.

## Setup

```sh
npm install
npx playwright install chromium
```

## Run

```sh
npm run test:browser          # headless Chromium (WebGL via ANGLE)
npm run test:browser:headed   # visible browser window (HEADED=true)
```

Headless runs use Chromium's new headless mode with `--enable-webgl
--use-gl=angle`, so hardware/swiftshader WebGL is available. Individual files
can be run with e.g.:

```sh
npx vitest run --project browser tests/browser/shared-context.test.ts
```
