// Runs the baseline flow against the pre-change worktree and the fixed tree,
// then diffs the two JSON summaries. Normal playback behavior must be identical.

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TESTS = path.resolve(HERE, '..')
const BASELINE_REPO = process.env.BASELINE_REPO || path.resolve(TESTS, '..', '..', 'repo-baseline')
const CURRENT_REPO = path.resolve(TESTS, '..')

const run = (repoRoot, outFile) => {
  console.log(`\n=== running flow against ${repoRoot} ===`)
  const result = spawnSync(
    process.execPath,
    ['--import', './runtime/register.mjs', 'baseline/flow.mjs'],
    {
      cwd: TESTS,
      env: { ...process.env, REPO_ROOT: repoRoot, BASELINE_OUT: path.join(TESTS, 'baseline', 'out', outFile) },
      stdio: ['ignore', 'inherit', 'inherit'],
      timeout: 180000,
    }
  )
  if (result.status !== 0) {
    console.error(`flow failed for ${repoRoot} (exit ${result.status})`)
    process.exit(1)
  }
  return JSON.parse(readFileSync(path.join(TESTS, 'baseline', 'out', outFile), 'utf8'))
}

const base = run(BASELINE_REPO, 'summary-base.json')
const current = run(CURRENT_REPO, 'summary-current.json')

console.log('\n=== comparison (baseline vs fixed) ===')
const keys = [...new Set([...Object.keys(base), ...Object.keys(current)])]
let mismatches = 0
for (const key of keys) {
  const b = JSON.stringify(base[key])
  const c = JSON.stringify(current[key])
  const ok = b === c
  if (!ok) mismatches++
  console.log(`  ${ok ? 'SAME' : 'DIFF'}  ${key}: baseline=${b} fixed=${c}`)
}

if (mismatches) {
  console.error(`\n${mismatches} observable(s) differ from the pre-change baseline`)
  process.exit(1)
}
console.log('\nnormal playback behavior is identical to the pre-change baseline')
