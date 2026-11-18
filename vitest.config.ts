import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const fromSrc = (path: string) => fileURLToPath(new URL(`./src/${path}`, import.meta.url));

// The library uses `baseUrl: "src"` imports (e.g. `helpers/common`, `audio`).
// Vite does not read tsconfig baseUrl, so mirror the src layout here.
const srcAliases = [
  'adapters',
  'audio',
  'constants',
  'events',
  'helpers',
  'mediasession',
  'states',
  'types',
];

// Uses the Playwright-managed "Chrome for Testing" build. Run
// `npx playwright install chromium` once; set AUDIO_X_TEST_CHANNEL=chrome or
// msedge to reuse a locally installed browser instead.
const channel = process.env.AUDIO_X_TEST_CHANNEL || 'chromium';

export default defineConfig({
  resolve: {
    // String keys also match sub-paths, e.g. `helpers/common` ->
    // `<root>/src/helpers/common`.
    alias: Object.fromEntries(srcAliases.map((folder) => [folder, fromSrc(folder)])),
  },
  define: {
    // `AudioX` checks process.env.NODE_ENV in the constructor; browsers have no
    // process object, so replace the expression at build time.
    'process.env.NODE_ENV': JSON.stringify('test'),
  },
  test: {
    include: ['test/**/*.test.ts'],
    browser: {
      enabled: true,
      headless: true,
      provider: 'playwright',
      screenshotFailures: false,
      instances: [
        {
          browser: 'chromium',
          launch: {
            channel,
            // Headless browsers otherwise block play() without a user gesture,
            // which makes real playback (and queue end) impossible to test.
            args: ['--autoplay-policy=no-user-gesture-required'],
          },
        },
      ],
    },
  },
});
