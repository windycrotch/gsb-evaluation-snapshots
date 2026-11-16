# Background image loading — local verification sample

Offline, deterministic checks for the `backgroundImageUrl` / `backgroundImageStatus` behavior.
No browser and no network access are required: the sample never requests a real image.

## Run

```bash
npm test
```

or directly:

```bash
node --import ./test/register-hooks.mjs ./test/background-image.test.mjs
```

## How it works

* `register-hooks.mjs` registers the ESM loader hooks in `hooks.mjs`, which redirect the
  `three`, `three/webgpu`, `three/addons/*`, `three/examples/jsm/postprocessing/*` and
  `float-tooltip` module specifiers to the in-memory mocks under `mocks/`.
* `mocks/three.mjs` exposes a controllable `TextureLoader`. Every `load()` call is recorded
  in `pendingTextureLoads` instead of fetching anything. Each entry can be completed on
  demand, in any order, with:
  * `resolveTextureLoad(entry)` — fires the success callback with a mock texture;
  * `rejectTextureLoad(entry)` — fires the error callback.
* The remaining globals needed by the component (`window`, `document`,
  `requestAnimationFrame`) are minimal stubs defined at the top of the test file.

## Covered scenarios

1. Default status is `idle` and the skysphere is hidden.
2. The `backgroundImageStatus` setter only accepts `idle`, `loading`, `loaded`, `error`.
3. Successful load: `idle -> loading -> loaded`, skysphere shown with the texture,
   `waitForLoadComplete` released, `onBackgroundImageLoaded` fired once.
4. Failed load: `idle -> loading -> error`, skysphere stays hidden, the material does not
   reference the failed texture, the first-render wait is released, and the success callback
   never fires.
5. Out-of-order completion: when URLs are switched, late success/error responses from older
   requests are ignored — only the latest URL can change the status and the skysphere.
6. Setting the URL to `null` / `''` returns to `idle` and hides the skysphere.
7. Clearing the URL while a load is in flight releases a pending first-render wait, and the
   superseded request's late success/failure has no effect.
8. With `waitForLoadComplete: false` the scene stays visible throughout, including after an
   error.
