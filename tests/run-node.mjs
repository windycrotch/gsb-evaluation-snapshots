// Node entry point. Run with:
//   npm test
// or:
//   node --import ./tests/three-stub/register.mjs tests/run-node.mjs
//
// The --import hook (package.json) maps bare "three" imports to the local
// offline stub, so this needs no GPU, no browser and no network access.

import { runSuites } from "./harness.js";
import reelFightSuite from "./reelFight.test.js";

const ok = await runSuites([reelFightSuite]);
process.exitCode = ok ? 0 : 1;
