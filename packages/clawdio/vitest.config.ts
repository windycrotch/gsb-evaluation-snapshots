import { defineConfig, type Plugin } from "vitest/config";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const rootDir = dirname(fileURLToPath(import.meta.url));

const emptyStub = resolve(
  rootDir,
  "src/workers/__tests__/mocks/empty-stub.ts"
);
const urlStub = resolve(
  rootDir,
  "src/workers/__tests__/mocks/url-stub.ts"
);

/**
 * Asset/WASM URL imports carry query suffixes (?no-inline, ?worker&url, ...)
 * and some are bare package subpaths, which Node's package resolver rejects
 * before Vite's alias stage. Intercept them in `resolveId` instead.
 */
function assetImportStubPlugin(): Plugin {
  return {
    name: "clawdio-test-asset-stubs",
    enforce: "pre",
    resolveId(source) {
      if (/\?worker&url$/.test(source) || /\?url&no-inline$/.test(source)) {
        return urlStub;
      }
      if (/\?no-inline$/.test(source)) {
        return emptyStub;
      }
      return null;
    },
  };
}

// Asset/URL imports only matter for bundling (worker script URLs, .wasm
// URLs). In tests the worklets are imported directly as modules, so these
// specifiers resolve to inert string stubs.
export default defineConfig({
  plugins: [assetImportStubPlugin()],
  resolve: {
    alias: [
      // Always exercise the locally built wasm-pack output in modules/*/pkg
      // rather than whatever version npm happened to place in node_modules.
      {
        find: /^clawdio-bitcrusher$/,
        replacement: resolve(
          rootDir,
          "../../modules/bitcrusher/pkg/clawdio_bitcrusher.js"
        ),
      },
      {
        find: /^clawdio-moog$/,
        replacement: resolve(
          rootDir,
          "../../modules/moog/pkg/clawdio_moog.js"
        ),
      },
      {
        find: /^clawdio-pink-noise$/,
        replacement: resolve(
          rootDir,
          "../../modules/pink-noise/pkg/clawdio_pink_noise.js"
        ),
      },
      {
        find: /^@\/(.*)$/,
        replacement: resolve(rootDir, "src", "$1"),
      },
    ],
  },
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/__tests__/**/*.test.ts"],
    setupFiles: ["src/workers/__tests__/setup.ts"],
    // WASM glue + worklet code must be transformed by Vite, not externalized.
    server: {
      deps: {
        inline: [/clawdio-(bitcrusher|moog|pink-noise)/],
      },
    },
  },
});
