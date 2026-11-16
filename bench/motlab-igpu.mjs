// motlab with Chrome left on its default GPU: without --force_high_performance_gpu, headless Chrome on a dual-GPU
// laptop draws on the integrated GPU, as it does for Remotion and HyperFrames. For the run.mjs IGPU=1 benchmark.
import { GPU_FLAGS } from '../src/chrome.js';
import { main } from '../src/cli.js';

GPU_FLAGS.splice(0, GPU_FLAGS.length, ...GPU_FLAGS.filter(f => f !== '--force_high_performance_gpu'));
main(process.argv.slice(2)).then(code => process.exit(code), e => { console.error(`FAILED: ${e.message}`); process.exit(1); });
