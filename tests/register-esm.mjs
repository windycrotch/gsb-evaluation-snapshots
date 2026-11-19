// Registers the ESM loader so the CommonJS package can import the
// ES-module-authored debugger sources in Node's built-in test runner.
import { register } from "node:module";

register(new URL("./esm-loader.mjs", import.meta.url));
