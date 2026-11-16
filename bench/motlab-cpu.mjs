// motlab with Chrome drawing in software (SwiftShader through ANGLE), the flags HyperFrames' --no-browser-gpu passes.
// motlab itself has no CPU option; this swaps its GPU flags for the run.mjs CPU=1 benchmark. Same arguments as motlab.
import { GPU_FLAGS } from '../src/chrome.js';
import { main } from '../src/cli.js';

GPU_FLAGS.splice(0, GPU_FLAGS.length, '--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader');
main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(`FAILED: ${e.message}`); process.exit(1); });
