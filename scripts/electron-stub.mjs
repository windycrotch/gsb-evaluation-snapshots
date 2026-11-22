// Stub for the 'electron' module, aliased in when stems.ts is bundled for
// its Node-based acceptance test (see the `test` script in package.json).
// Each run gets a fresh userData dir so cache tests start clean.
import { mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import path from 'path'

const userData = mkdtempSync(path.join(tmpdir(), 'stemdeck-stems-test-'))

export const app = {
  isPackaged: true,
  getPath: () => userData,
  on: () => {}
}
