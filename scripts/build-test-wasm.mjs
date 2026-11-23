/**
 * Builds the real Rust/WASM bindings into `packages/clawdio/tests/fixtures/wasm/`
 * so the worklet integration tests can exercise actual `setBits` / `setCutoff`
 * / `setResonance` behaviour (state continuity, validation, audible change)
 * instead of hand-written fakes.
 *
 * Usage: `node scripts/build-test-wasm.mjs` (or `yarn test:wasm`)
 *
 * Requirements: a Rust toolchain with the `wasm32-unknown-unknown` target and
 * the `wasm-bindgen` CLI version matching the `wasm-bindgen` crate version used
 * by the modules (0.2.100). Set `CLAWDIO_RUST_TOOLCHAIN` / `WASM_BINDGEN` to
 * override the auto-detected binaries.
 *
 * The generated fixtures are gitignored; when they are missing the
 * integration tests skip themselves so `yarn test` still passes on a machine
 * without Rust.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const modulesDir = path.join(repoRoot, "modules");
const outDir = path.join(
  repoRoot,
  "packages",
  "clawdio",
  "tests",
  "fixtures",
  "wasm"
);

const MODULES = [
  { crate: "clawdio-bitcrusher", out: "clawdio_bitcrusher" },
  { crate: "clawdio-moog", out: "clawdio_moog" },
];

const WASM_BINDGEN_VERSION = "0.2.100";

const log = (...args) => console.log("[clawdio/test-wasm]", ...args);

const run = (command, args, options = {}) => {
  log(`${command} ${args.join(" ")}`);
  execFileSync(command, args, {
    stdio: "inherit",
    cwd: options.cwd ?? repoRoot,
  });
};

const cargoArgs = (args) => {
  const toolchain = process.env.CLAWDIO_RUST_TOOLCHAIN;
  return toolchain ? [`+${toolchain}`, ...args] : args;
};

const findWasmBindgen = () => {
  const candidates = [
    process.env.WASM_BINDGEN,
    "wasm-bindgen",
    path.join(process.env.USERPROFILE ?? "", ".cargo", "bin", "wasm-bindgen.exe"),
    path.join(process.env.HOME ?? "", ".cargo", "bin", "wasm-bindgen"),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ["--version"], { stdio: "pipe" });
      return candidate;
    } catch {
      // try next
    }
  }

  throw new Error(
    `wasm-bindgen CLI ${WASM_BINDGEN_VERSION} not found. Install it with:\n` +
      `  cargo install wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION}`
  );
};

const main = () => {
  const wasmBindgen = findWasmBindgen();

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  for (const module of MODULES) {
    run(
      "cargo",
      cargoArgs([
        "build",
        "--release",
        "--lib",
        "--target",
        "wasm32-unknown-unknown",
        "-p",
        module.crate,
      ]),
      { cwd: modulesDir }
    );

    const wasmPath = path.join(
      modulesDir,
      "target",
      "wasm32-unknown-unknown",
      "release",
      `${module.out}.wasm`
    );

    // `web` target: an ES module with the same `init(module_or_path)` export
    // the real worklet imports, so the tests exercise the production init path.
    run(wasmBindgen, [
      "--target",
      "web",
      "--out-dir",
      path.join(outDir, module.out),
      "--out-name",
      module.out,
      wasmPath,
    ]);
  }

  const built = readdirSync(outDir);
  if (!built.length) throw new Error("No bindings were generated");
  log(`wrote ${built.join(", ")} to ${outDir}`);
};

main();
