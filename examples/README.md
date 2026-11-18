# Examples

- `site/` — playable browser page. `index.html` loads `game.bundle.js`, which is
  generated from the ESM modules in `src/` by `node scripts/build-site.mjs`.
  Serve locally with `node scripts/serve.mjs` and open
  `http://localhost:8123/examples/site/`.
- `output/` — JSON traces written by `node scripts/sample.mjs`
  (git-ignored; regenerate on demand).
