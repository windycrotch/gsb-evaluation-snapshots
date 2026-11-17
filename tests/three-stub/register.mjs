// Registers the offline three.js stub loader for Node test runs.
import { register } from "node:module";

register(new URL("./loader.mjs", import.meta.url));
