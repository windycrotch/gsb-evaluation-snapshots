# Contributing to Bone 2D

Thank you for looking. Bug reports with a project file are the most useful contribution; code, documentation and translations are welcome too.

## Reporting a bug

Open an issue and, if you can, attach the `.bone2d` project (File → Save). Say what you did, what you expected and what happened. For an export problem, name the runtime and version that read the file.

## Setting up

```bash
git clone https://github.com/iamgatz/Bone-2D.git
cd Bone-2D
npm install
npm run dev        # http://localhost:5273
```

Node 22 is what CI uses.

## Before you send a change

```bash
npm run typecheck
npm run lint        # ESLint: types, React hooks, layers, import cycles
npm run format      # Prettier (CI runs `format:check`)
npm run knip        # unused files, exports and dependencies
npm run e2e         # a few smoke tests in a real browser (Playwright; needs Chrome, or `npx playwright install chromium`)
npm test           # unit tests, differential tests against the official spine-core, short random sessions
npm run build
```

A new editor feature counts as done when it goes through the whole chain (see [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)): model → validator → solver / runtime → export → import → a test against the official runtime → UI → an operation in the random-session kit (`tests/fuzzkit.ts`). If that sounds like a lot, send the part you have and say what is missing: we will help with the rest.

To stress a change with longer random sessions:

```bash
FUZZ_FROM=1 FUZZ_SEEDS=100 FUZZ_STEPS=80 npx vitest run tests/fuzz.test.ts
```

```powershell
$env:FUZZ_SEEDS='100'; $env:FUZZ_STEPS='80'; npx vitest run tests/fuzz.test.ts
```

## Interface texts

Texts stay English in the components and are translated while rendering. Add the Russian text of every new string to `src/i18n/ru.ts` (`{}` in a key matches any text, `{#}` a number); `npm test` fails when a static string has no translation. To add another language, add a dictionary like `ru.ts` and extend `Lang`.

## Pull requests

- One topic per pull request; a short description of what changed and why.
- Tests for what you changed. A bug fix comes with a test that fails without it.
- Add a line to `src/editor/changelog.ts` (English and Russian) when the change is visible to a user.

## Where to start

Look for issues labelled `good first issue`. The list of known gaps is in the README ("Not done yet"), the comparison with Spine's feature list in [docs/SPINE_PARITY.md](docs/SPINE_PARITY.md).

## License

By contributing you agree that your work is released under the [MIT License](LICENSE).
