// test/register.mjs: loaded via `node --import` so every test worker gets the three.js stub mapping.
import { register } from 'node:module';
register('./loader.mjs', import.meta.url);
