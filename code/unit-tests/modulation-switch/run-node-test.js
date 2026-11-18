// Microtonal Fabric
//
// Headless runner for modulation-switch-tests.js.
//
// It loads the REAL sound sources (sound/...), unchanged, into one shared VM
// context together with the fake Web Audio globals from fake-audio.js, then
// runs the same test function used by the browser page and prints a report.
//
// Run from anywhere:
//   node code/unit-tests/modulation-switch/run-node-test.js
// Exit code is non-zero if any check fails.

"use strict";

const fs = require("fs");
const path = require("path");
const vm = require("vm");

const thisDirectory = __dirname;
const codeRoot = path.resolve(thisDirectory, "..", "..");

const sourceFiles = [
    // dependencies of the sound layer, in index.html load order:
    "agnostic/enumeration.js",
    "SoundBuilder/main/default-instrument.js",
    "sound/definition-set.js",
    "sound/chain-node.js",
    "sound/envelope.js",
    "sound/modulator.js",
    "sound/modulator-set.js",
    "sound/tone.js",
    "sound/instrument.js",
    // fakes and the tests themselves:
    "unit-tests/modulation-switch/fake-audio.js",
    "unit-tests/modulation-switch/modulation-switch-tests.js",
];

const context = vm.createContext({ console: console });
for (const relativePath of sourceFiles) {
    const fullPath = path.join(codeRoot, relativePath);
    const source = fs.readFileSync(fullPath, "utf8");
    vm.runInContext(`${source}\n//# sourceURL=${relativePath}`, context, { filename: relativePath });
} //loop

// Install fake AudioContext/GainNode/... as globals inside the VM context.
vm.runInContext("fakeAudio.installGlobals();", context);

const results = vm.runInContext("runModulationSwitchTests();", context);

let failed = 0;
for (const result of results) {
    const marker = result.pass ? "PASS" : "FAIL";
    const detail = result.detail ? `  (${result.detail})` : "";
    console.log(`${marker}  ${result.name}${detail}`);
    if (!result.pass) ++failed;
} //loop

console.log("");
console.log(`${results.length - failed}/${results.length} checks passed`);
if (failed > 0) {
    console.error(`${failed} check(s) failed`);
    process.exitCode = 1;
} //if
