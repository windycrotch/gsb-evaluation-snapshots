# Architecture

A short map for someone who wants to change the code. The development log (what each release did and why, in Russian) is [IDEAS.md](IDEAS.md).

## The idea

Bone 2D is a skeletal animation editor whose **document is plain data** and whose **solver is our own code that is checked against the official Spine 4.3 runtime**.
Everything that decides how a skeleton looks lives in `src/core` and has no DOM, so it runs in the browser, in the tests and in the command line the same way.

```
 UI (React, Canvas2D overlay)  ──►  actions (src/store)  ──►  document (immer patches)  ──►  core (pure logic)
                                                                    │
                                                                    └──►  export (Spine JSON / binary / atlas)  ──►  official spine-core (tests)
```

## Folders

| Folder | What is in it |
|---|---|
| `src/core` | The model (`model.ts`), animation sampling (`animate.ts`), curves, meshes, weights, clipping, the document check and repair (`validate.ts`), and the editing helpers (key tools, checkpoints, merge, time shift, ...). It imports nothing from the other folders. |
| `src/core/rig` | The runtime skeleton, one file per responsibility: `data.ts` (compiled data types), `compile.ts`, `bone.ts`, `ik.ts`, `transform.ts`, `slider.ts`, `pathConstraint.ts`, `physics.ts`, `skeleton.ts` (the instance that poses everything), `geometry.ts`. `core/skeleton.ts` re-exports them. |
| `src/core/export`, `src/core/import` | Spine JSON and binary writer / reader, the atlas packer, the GIF / APNG / ZIP encoders (run in a Web Worker: `encodeTask.ts` is the task, `encodeWorker.ts` the worker, `store/encodeInWorker.ts` the client with progress and cancel), the review player page. |
| `src/store` | The document store (`doc.ts`: immer patches, one undo step per gesture), the UI store, the settings, the solved scene (`scene.ts`), and the actions the UI calls, one file per area (`boneActions`, `slotActions`, `animationActions`, `keyframeActions`, `skinActions`, ...; `actions.ts` lists them). Reads that need no action live in `accessors.ts`. |
| `src/render` | The WebGL2 renderer: batches, blend modes, two-color tint, stencil clipping. |
| `src/editor` | The React panels, the viewport (tools and the overlay), the dopesheet and the graph editor, the hotkey table, the command palette. |
| `src/i18n` | English / Russian. UI texts stay English in the components and are translated while rendering. |
| `src/player` | The standalone page a reviewer opens to look at an animation and leave comments. |
| `cli` | `npm run cli`: export and check a project without the editor. |
| `tests` | Vitest: unit tests, differential tests against the official runtime, and the random editor sessions (fuzzer). |

## Layers

`core` does not import `store`, `editor`, `render` or `player`; `store` does not import `editor` or `player`; nothing imports in a circle. ESLint (`import-x/no-restricted-paths`, `import-x/no-cycle`) fails when that is broken.

## Three rules that keep it correct

1. **The document is immutable data.** Every change goes through `docStore.update(label, recipe)`; the result is one undo step. A drag is grouped with `beginGesture` / `endGesture`.
2. **A feature is done when it goes through the whole chain:** model → validator → solver → export → import → differential test against the official runtime → UI → an operation in the fuzzer kit (`tests/fuzzkit.ts`).
3. **Nothing is shown that the export cannot carry**, or it is marked as editor-only.

## How the export is verified

- `tests/spine-parity.test.ts` and friends export a deliberately difficult rig, load it with `@esotericsoftware/spine-core` 4.3 and compare the world matrices of every bone, mesh vertices, colors, attachments and the draw order with our solver at many moments.
- `tests/fuzz.test.ts` plays random sequences of real editor actions. After every step the document must need no repair and the export must load in the official runtime; at the end the two solvers are compared, "undo everything" returns the first document and "redo everything" the last.
- Mutant tests make sure the comparison is not vacuous.

Run the long fuzzer with `FUZZ_FROM=1 FUZZ_SEEDS=300 FUZZ_STEPS=100 npx vitest run tests/fuzz.test.ts`.

## Adding a UI string

Write the English text in the component and add its Russian translation to `src/i18n/ru.ts` (`{}` in a key matches any text, `{#}` a number). `npm test` fails when a static string has no translation.

## Adding a hotkey

Add it to the table in `src/editor/hotkeys.ts` and its action to `src/editor/keyActions.ts`; the tooltips, the shortcuts window and the handler all read the same table. The handler reads letters by the position of the key, so shortcuts work on non-Latin layouts too.

## Tooling decisions

- **TypeScript 6.0, strict, `noUnusedLocals`.** TypeScript 7 has no JavaScript API, which `typescript-eslint` needs, so the project stays on 6.0 until the linter supports 7.
- **ESLint 9** (`typescript-eslint` with type-aware rules, `react-hooks`, `import-x` for the layers and cycles) is the one linter; `eslint.config.js` says where untyped Spine JSON is allowed to be dynamic. The React Compiler rules of the hooks plugin are off: the compiler is not used.
- **Prettier** formats everything (`.prettierrc.json`); the one formatting commit is listed in `.git-blame-ignore-revs`.
- **knip** finds unused files, exports and dependencies (`npm run knip`).
- **Playwright** runs a handful of smoke tests of the real editor in a browser (`e2e/`, `npm run e2e`): the demo loads, Ctrl+Z works on a Russian layout, icons sit in the middle of their buttons, nothing spills sideways at 1100, 1440 and 1920 px, the Export window is grouped. They cover what unit tests cannot see (layout, keyboard layouts); everything else stays in Vitest.
- **No state library**: the stores are about forty lines on top of immer, and the document needs patches for undo, which a general store would not give.
- **No validation library**: `validate.ts` repairs a document rather than rejecting it, which a schema library does not do.
- **`.editorconfig` and `.gitattributes`** keep line endings and whitespace the same for editors that do not run Prettier.
- **Dependencies stay few**: React, immer, delaunator (meshes), ag-psd (Photoshop import), lucide icons and the Inter font. Anything else needs a reason in the pull request.

## Spine quirks we reproduce on purpose

- Angles go through float32 π (`180 / 3.1415927`), as in the official runtime.
- Reading a world rotation at the 0 / 360° boundary (the source of a transform constraint or the driver of a slider) gives 0 or 360 depending on ~1e-6° noise, so different runtimes can disagree on such an edge.
- The 4.3 constraint model computes `world` and `local` lazily; an update-order mistake here was one of the first things the random-session tests found.
