import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { getAllModules } from "./shared.js";

/**
 * This file handles building the Rust code into WASM and JS,
 * and copies the WASM to the root asset folder (`/public`)
 * so we can distribute them with library.
 *
 * It prefers `wasm-pack` (the normal workflow). When wasm-pack is not
 * installed - common on machines that only have a Rust toolchain - it falls
 * back to `cargo build --target wasm32-unknown-unknown` + `wasm-bindgen` and
 * writes a wasm-pack-compatible `pkg/` folder. That keeps the examples able to
 * use freshly built modules (with the live parameter setters) without needing
 * an extra binary.
 */

const log = (...props) => console.log("[CLAWDIO/BUILD]", ...props);

const WASM_BINDGEN_VERSION = "0.2.100";

const hasCommand = (command, args = ["--version"]) => {
  try {
    execFileSync(command, args, { stdio: "pipe", shell: process.platform === "win32" });
    return true;
  } catch {
    return false;
  }
};

const findWasmBindgen = () => {
  const candidates = [
    process.env.WASM_BINDGEN,
    "wasm-bindgen",
    process.env.USERPROFILE
      ? `${process.env.USERPROFILE}\\.cargo\\bin\\wasm-bindgen.exe`
      : null,
    process.env.HOME ? `${process.env.HOME}/.cargo/bin/wasm-bindgen` : null,
  ].filter(Boolean);

  return candidates.find((candidate) => hasCommand(candidate)) ?? null;
};

const cargoToolchainArgs = () => {
  const toolchain = process.env.CLAWDIO_RUST_TOOLCHAIN;
  return toolchain ? [`+${toolchain}`] : [];
};

/** Read `version = "..."` from a Cargo.toml without a TOML parser dependency. */
const readCrateVersion = (cargoTomlPath) => {
  const match = readFileSync(cargoTomlPath, "utf8").match(
    /^\s*version\s*=\s*"([^"]+)"/m
  );
  return match ? match[1] : "0.1.0";
};

const buildWithWasmPack = (moduleName) => {
  execFileSync(
    "wasm-pack",
    ["build", `./modules/${moduleName}/`, "--target", "web"],
    { stdio: "inherit", shell: process.platform === "win32" }
  );
};

const buildWithWasmBindgen = (moduleName, wasmBindgen) => {
  const crateName = `clawdio-${moduleName.replace(/^clawdio-/, "")}`;
  const outName = crateName.replace(/-/g, "_");
  const pkgDir = `./modules/${moduleName}/pkg`;
  // The modules folder is a Cargo workspace, so artifacts land in the shared
  // `modules/target` directory rather than a per-crate one.
  const wasmPath = `./modules/target/wasm32-unknown-unknown/release/${outName}.wasm`;

  execFileSync(
    "cargo",
    [
      ...cargoToolchainArgs(),
      "build",
      "--release",
      "--lib",
      "--target",
      "wasm32-unknown-unknown",
      "-p",
      crateName,
    ],
    { stdio: "inherit", cwd: "./modules" }
  );

  execFileSync(
    wasmBindgen,
    ["--target", "web", "--out-dir", pkgDir, "--out-name", outName, wasmPath],
    { stdio: "inherit" }
  );

  // wasm-bindgen does not create the npm manifest that wasm-pack generates.
  // The monorepo workspaces (`modules/*/pkg`) rely on it to link local builds
  // into `packages/clawdio`, so recreate the same shape here.
  const version = readCrateVersion(`./modules/${moduleName}/Cargo.toml`);
  writeFileSync(
    `${pkgDir}/package.json`,
    `${JSON.stringify(
      {
        name: crateName,
        type: "module",
        collaborators: ["Ryosuke Hana"],
        version,
        files: [
          `${outName}_bg.wasm`,
          `${outName}.js`,
          `${outName}.d.ts`,
        ],
        main: `${outName}.js`,
        types: `${outName}.d.ts`,
        sideEffects: ["./snippets/*"],
      },
      null,
      2
    )}\n`
  );

  log(
    `used wasm-bindgen fallback for ${moduleName} (wasm-bindgen ${WASM_BINDGEN_VERSION})`
  );
};

log("Starting build");

// 1️⃣ Build all WASM modules

// Get all modules directories
const modules = getAllModules();
log("Processing Rust modules: ", modules);

const useWasmPack = hasCommand("wasm-pack");
const wasmBindgen = useWasmPack ? null : findWasmBindgen();

if (!useWasmPack && !wasmBindgen) {
  throw new Error(
    "Neither `wasm-pack` nor `wasm-bindgen` is available. Install wasm-pack " +
      `(https://github.com/rustwasm/wasm-pack) or wasm-bindgen-cli ${WASM_BINDGEN_VERSION} ` +
      `(cargo install wasm-bindgen-cli --version ${WASM_BINDGEN_VERSION}).`
  );
}

modules.forEach((moduleName) => {
  if (useWasmPack) {
    buildWithWasmPack(moduleName);
  } else {
    buildWithWasmBindgen(moduleName, wasmBindgen);
  }
});

log("Build completed successfully 👏🎉");
