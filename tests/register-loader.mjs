/** Registers the test-only resolver hook (see ts-resolve.mjs). */
import { register } from 'node:module'

register('./ts-resolve.mjs', import.meta.url)
