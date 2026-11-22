// Node module customization hooks for the harness.
//
// - meteor/* specifiers resolve to the test runtime (tests/runtime/meteor/*)
// - /imports/* resolves into the app source tree (REPO_ROOT, default: repo root)
// - bare package imports made from app files resolve against tests/node_modules
// - app .js/.jsx files are served as ES modules (JSX transpiled with esbuild)
// - asset imports (sass/css/images/...) resolve to an empty module
//
// When REPO_ROOT points at the pre-change baseline worktree, three purely
// mechanical compatibility rewrites are applied to the legacy source so it
// can load as strict ES modules (Meteor's own compiler accepts them):
//   1. top-level `if (!Meteor.isServer) return false` (illegal in ESM) is
//      dropped — the harness always runs with Meteor.isServer === true
//   2. implicit globals (`tones = []`, `result = ...`) get a declaration
// Neither rewrite changes any runtime behavior under the harness.

import { readFile } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import esbuild from 'esbuild'

const RUNTIME = path.dirname(fileURLToPath(import.meta.url))
const TESTS = path.resolve(RUNTIME, '..')
export const REPO = process.env.REPO_ROOT
  ? path.resolve(process.env.REPO_ROOT)
  : path.resolve(TESTS, '..')

const HOOKS_URL = pathToFileURL(path.join(RUNTIME, 'hooks.mjs')).href

const METEOR_MAP = {
  'meteor/meteor': 'meteor/meteor.js',
  'meteor/mongo': 'meteor/mongo.js',
  'meteor/check': 'meteor/check.js',
  'meteor/tracker': 'meteor/tracker.js',
  'meteor/react-meteor-data': 'meteor/react-meteor-data.js',
}

const ASSET_RE = /\.(sass|scss|css|png|jpe?g|gif|svg|woff2?|ttf|eot|otf|mp3|wav)$/

// CJS packages whose __esModule flag Node ignores: serve an explicit ESM wrapper
const VENDOR_WRAPPERS = {
  'styled-components': 'vendor/styled-components.js',
  'react-hammerjs': 'vendor/react-hammerjs.js',
}

const fileUrl = p => pathToFileURL(p).href

const resolveAsFile = p => {
  for (const candidate of [p, `${p}.js`, `${p}.jsx`, `${p}.json`, path.join(p, 'index.js'), path.join(p, 'index.jsx')]) {
    try { if (existsSync(candidate) && statSync(candidate).isFile()) return candidate } catch (e) { /* keep looking */ }
  }
  return null
}

export async function resolve(specifier, context, nextResolve) {
  if (METEOR_MAP[specifier]) {
    return { url: fileUrl(path.join(RUNTIME, METEOR_MAP[specifier])), shortCircuit: true }
  }

  if (VENDOR_WRAPPERS[specifier] && context.parentURL && fileURLToPath(context.parentURL).startsWith(path.join(REPO, 'imports'))) {
    return { url: fileUrl(path.join(RUNTIME, VENDOR_WRAPPERS[specifier])), shortCircuit: true }
  }

  if (specifier.startsWith('/imports/')) {
    const found = resolveAsFile(path.join(REPO, specifier))
    if (found) return { url: fileUrl(found), shortCircuit: true }
    throw new Error(`cannot resolve app module ${specifier} under ${REPO}`)
  }

  if (ASSET_RE.test(specifier)) {
    return { url: fileUrl(path.join(RUNTIME, 'empty.js')), shortCircuit: true }
  }

  if ((specifier.startsWith('./') || specifier.startsWith('../')) && context.parentURL) {
    const parent = fileURLToPath(context.parentURL)
    if (parent.startsWith(REPO)) {
      const found = resolveAsFile(path.resolve(path.dirname(parent), specifier))
      if (found) return { url: fileUrl(found), shortCircuit: true }
    }
  }

  // bare package imports coming from app files: resolve them against the
  // harness node_modules (the app repo has none of its own here)
  if (!specifier.startsWith('.') && !specifier.startsWith('/') && !specifier.match(/^\w+:/)) {
    try {
      // Node's CJS lexer cannot detect lodash's named exports; the official
      // ESM build of the same library is used for app files instead
      const mapped = specifier === 'lodash' ? 'lodash-es' : specifier
      return await nextResolve(mapped, { ...context, parentURL: HOOKS_URL })
    } catch (e) { /* fall through to default */ }
  }

  return nextResolve(specifier, context)
}

const compatRewrites = source => source
  .replace(/^[ \t]*if \(!Meteor\.isServer\) return false[ \t]*$/gm, '')
  .replace(/^tones = \[\]$/gm, 'var tones = []')
  .replace(/(?<!let )result = esprima\.parseModule/g, 'let result = esprima.parseModule')

export async function load(url, context, nextLoad) {
  if (url.startsWith('file:')) {
    const filePath = fileURLToPath(url)
    if (filePath.startsWith(path.join(REPO, 'imports')) && /\.(js|jsx)$/.test(filePath)) {
      let source = await readFile(filePath, 'utf8')
      source = compatRewrites(source)
      // asset requires inside components (require('./x.sass')) become no-ops
      source = source.replace(/require\(['"][^'"]+\.(sass|scss|css|png|jpe?g|gif|svg|woff2?|ttf|eot|otf|mp3|wav)['"]\)/g, 'void 0')
      const out = esbuild.transformSync(source, {
        loader: filePath.endsWith('.jsx') ? 'jsx' : 'js',
        format: 'esm',
      })
      return { format: 'module', source: out.code, shortCircuit: true }
    }
  }
  return nextLoad(url, context)
}
