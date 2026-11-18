import { installGlobals } from "./fakes.js";

// The source modules reference HTMLCanvasElement/HTMLImageElement at module
// scope, so the fakes must be installed before any test file imports them.
installGlobals();
