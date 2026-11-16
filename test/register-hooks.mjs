// Registers the offline mock loader hooks.
// Usage: node --import ./test/register-hooks.mjs ./test/background-image.test.mjs
import { register } from 'node:module';

register('./hooks.mjs', import.meta.url);
