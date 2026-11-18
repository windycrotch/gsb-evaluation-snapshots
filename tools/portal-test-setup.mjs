// Entry point for the offline portal test suite. Registering the resolve
// hook here (rather than via --loader) works with Node's module.register API
// and keeps `node --test` invocation identical across platforms.
import { register } from 'node:module';

register('./portal-loader.mjs', import.meta.url);
