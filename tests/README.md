# Document tests

Two Playwright suites run against a local Vite server, in one Chromium worker.
All browser requests to other origins are blocked. No media uploads or external
services are used. CI installs Playwright's pinned Chromium; a local installed
Chrome can be used instead with `PLAYWRIGHT_CHANNEL=chrome`.

```sh
npm ci
npx playwright install chromium
npm run test:security   # sanitizer + parseDOCX boundary
npm run test:docx       # Word comparison behaviour
```

The security suite covers the sanitizer's HTML-only policy, preservation of
ordinary DOCX formatting, and the full `parseDOCX` boundary with a synthetic
OOXML file containing an unsafe hyperlink. The CI workflow also runs the
production TypeScript/Vite build.

The `test:docx` suite drives the Word comparison view with local DOCX fixtures
(`tests/fixtures/`, generated from plain OOXML): synced scrolling across panes of
very different heights (no NaN, relative position preserved), change-counter
visibility and wrap-around navigation, change-highlight/counter consistency, and
the changes-only view's word-boundary context and empty state.
