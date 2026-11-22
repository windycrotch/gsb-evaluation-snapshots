/**
 * Local unit tests for per-transform shader chunk tracking.
 *
 * These tests exercise `loadShader` directly: they only touch the local
 * file system and Node's built-in test runner, so they need neither a real
 * network connection nor an external shader compiler.
 *
 * Run with:  node --test "test/node/*.test.js"
 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { before, after, describe, it } from 'node:test';

import loadShader, { minifyShader } from '../../src/loadShader.js';

const ROOT = process.cwd();
const POSIX = path => path.split(sep).join('/');

/**
 * @typedef {import('../../src/types').LoadingOptions} LoadingOptions
 * @returns {LoadingOptions} Independent default options for each transform
 */
const defaultOptions = overrides => ({
  removeDuplicatedImports: false,
  warnDuplicatedImports: true,
  defaultExtension: 'glsl',
  importKeywords: ['#include'],
  onComplete: undefined,
  minify: false,
  root: '/',
  ...overrides
});

/**
 * Creates an isolated temporary directory populated with shader fixtures.
 * @param {Record<string, string>} files Map of relative paths to source code
 * @returns {{ dir: string, path: (name: string) => string, write: (name: string, content: string) => void, cleanup: () => void }}
 */
function fixture (files) {
  const dir = mkdtempSync(join(tmpdir(), 'vite-plugin-glsl-'));

  const write = (name, content) => {
    const path = join(dir, name);
    writeFileSync(path, content);
    return path;
  };

  for (const [name, content] of Object.entries(files)) write(name, content);

  return {
    dir,
    path: name => join(dir, name),
    write,
    cleanup: () => rmSync(dir, { recursive: true, force: true })
  };
}

/**
 * Runs a full transform exactly like the plugin's `transform.handler` does.
 * @param {string} path Absolute shader path
 * @param {Partial<ReturnType<typeof defaultOptions>>} [overrides]
 */
async function transform (path, overrides) {
  const options = defaultOptions(overrides);
  return loadShader(readFileSync(path, 'utf8'), path, options);
}

/**
 * The module emits every plugin warning through `process.emitWarning`
 * (preserving the public behavior) and synchronously forwards the same data
 * to an internal hook. The hook is installed once for the whole suite and
 * tags each warning with the marker of the test active at emission time, so
 * attribution is exact even when several transforms run concurrently or when
 * Node dispatches the underlying `warning` events on a later event-loop tick.
 *
 * @type {{ warning: { message: string, code: string, detail: string }, marker: symbol }[]}
 */
const emittedWarnings = [];
let activeMarker = null;

before(() => {
  globalThis.__VITE_PLUGIN_GLSL_WARNING__ = warning => {
    if (activeMarker !== null) emittedWarnings.push({ warning, marker: activeMarker });
  };
});

after(() => {
  delete globalThis.__VITE_PLUGIN_GLSL_WARNING__;
});

/**
 * Captures the plugin warnings synchronously emitted while `callback` runs
 * and returns only those belonging to that callback.
 */
async function captureWarnings (callback) {
  const marker = Symbol('warnings');
  activeMarker = marker;

  try {
    await callback();
    return emittedWarnings
      .filter(entry => entry.marker === marker)
      .map(entry => entry.warning);
  } finally {
    activeMarker = null;
  }
}

// Sequential suite: process-wide "warning" events would otherwise be observed
// by tests running concurrently in the same process. The concurrency under
// test lives inside each individual test's `Promise.all`, not between tests.
describe('per-transform shader chunk tracking', { concurrency: false }, () => {
  it('GLSL fixture output matches the pre-refactor baseline', async () => {
    const shader = resolve(ROOT, 'test/glsl/main.frag');
    const { outputShader, dependentChunks } = await transform(shader, {
      warnDuplicatedImports: false
    });

    assert.equal(outputShader, [
      '#version 300 es',
      '',
      '#ifndef GL_FRAGMENT_PRECISION_HIGH',
      '  precision mediump float;',
      '#else',
      '  precision highp float;',
      '#endif',
      '',
      'out vec4 fragColor;',
      '',
      'float chunkRed () {',
      '  return 0.0;',
      '}',
      'float chunkGreen () {',
      '  return 0.8;',
      '}',
      '',
      'vec3 chunkRGB () {',
      '  return vec3(chunkRed(), chunkGreen(), 0.0);',
      '}',
      '',
      'vec4 chunkFn () {',
      '  return vec4(chunkRGB(), 1.0);',
      '}',
      '',
      'void main (void) {',
      '  fragColor = chunkFn();',
      '}'
    ].join('\n'));

    const keys = [...dependentChunks.keys()].map(POSIX);
    assert.deepEqual(keys, [
      POSIX(resolve(ROOT, 'test/glsl/main.frag')),
      POSIX(resolve(ROOT, 'test/glsl/chunk0.frag')),
      POSIX(resolve(ROOT, 'test/glsl/utils/chunk1.glsl'))
    ]);

    assert.deepEqual(
      dependentChunks.get(POSIX(resolve(ROOT, 'test/glsl/utils/chunk1.glsl')))?.map(POSIX),
      [
        POSIX(resolve(ROOT, 'test/glsl/utils/chunk2.frag')),
        POSIX(resolve(ROOT, 'test/glsl/chunk3.frag'))
      ]
    );
  });

  it('WGSL fixture output matches the pre-refactor baseline', async () => {
    const shader = resolve(ROOT, 'test/wgsl/main.wgsl');
    const { outputShader, dependentChunks } = await transform(shader, {
      warnDuplicatedImports: false
    });

    assert.ok(outputShader.startsWith([
      'fn chunkRed() -> f32 {',
      '  return 0.0;',
      '}',
      'fn chunkGreen() -> f32 {',
      '  return 0.8;',
      '}',
      '',
      'fn chunkRGB() -> vec3f {',
      '  return vec3f(chunkRed(), chunkGreen(), 0.0);',
      '}',
      '',
      'fn chunkFn() -> vec4f {',
      '  return vec4f(chunkRGB(), 1.0);',
      '}',
      '',
      '@vertex'
    ].join('\n')));

    assert.ok(outputShader.includes('@fragment\nfn mainFrag()'));

    assert.deepEqual(
      [...dependentChunks.keys()].map(POSIX),
      [
        POSIX(resolve(ROOT, 'test/wgsl/main.wgsl')),
        POSIX(resolve(ROOT, 'test/wgsl/chunk0.wgsl')),
        POSIX(resolve(ROOT, 'test/wgsl/utils/chunk1.wgsl'))
      ]
    );
  });

  it('minify and onComplete still apply to the loaded shader', async () => {
    const env = fixture({
      'main.glsl': '#include "chunk.glsl";\nvoid main () {\n  float  value = 1.0;\n}\n',
      'chunk.glsl': 'float helper () {\n  return 0.0;\n}\n'
    });

    try {
      const calls = [];
      const { outputShader } = await transform(env.path('main.glsl'), {
        minify: true,
        onComplete: (shader, path) => {
          calls.push([shader, POSIX(path)]);
          return `${shader}\n// completed`;
        }
      });

      assert.ok(calls.length === 1, 'onComplete should be invoked exactly once');
      assert.equal(calls[0][1], POSIX(env.path('main.glsl')));
      assert.ok(calls[0][0].includes('float helper(){return 0.0;}'));
      assert.equal(outputShader, `${minifyShader(calls[0][0])}\n// completed`);
      assert.ok(!outputShader.includes('  float  value'));
    } finally {
      env.cleanup();
    }
  });

  it('concurrent transforms keep independent outputs and dependency sets', async () => {
    // Two shader trees with intentionally distinct markers and chunk names,
    // both resolved asynchronously so their chunk loading interleaves.
    const first = fixture({
      'main.frag': '#include "alpha.frag";\nvoid firstMain () { alpha(); }\n',
      'alpha.frag': '#include "alpha-utils.frag";\nvoid alpha () { alphaUtils(); }\n',
      'alpha-utils.frag': 'float FIRST_MARKER = 1.0;\n'
    });

    const second = fixture({
      'main.frag': '#include "beta.frag";\nvoid secondMain () { beta(); }\n',
      'beta.frag': '#include "beta-utils.frag";\nvoid beta () { betaUtils(); }\n',
      'beta-utils.frag': 'float SECOND_MARKER = 2.0;\n'
    });

    try {
      // `onComplete` yields to the event loop on every transform, which is
      // exactly where shared module-level state used to get interleaved.
      const yieldOnComplete = async shader => {
        await new Promise(resolve => setImmediate(resolve));
        return shader;
      };

      for (let round = 0; round < 10; round++) {
        const [left, right] = await Promise.all([
          transform(first.path('main.frag'), { onComplete: yieldOnComplete }),
          transform(second.path('main.frag'), { onComplete: yieldOnComplete })
        ]);

        assert.ok(left.outputShader.includes('FIRST_MARKER'));
        assert.ok(!left.outputShader.includes('SECOND_MARKER'));
        assert.ok(left.outputShader.includes('void firstMain'));
        assert.ok(!left.outputShader.includes('void secondMain'));

        assert.ok(right.outputShader.includes('SECOND_MARKER'));
        assert.ok(!right.outputShader.includes('FIRST_MARKER'));
        assert.ok(right.outputShader.includes('void secondMain'));
        assert.ok(!right.outputShader.includes('void firstMain'));

        const leftChunks = [...left.dependentChunks.values()].flat().map(POSIX);
        const rightChunks = [...right.dependentChunks.values()].flat().map(POSIX);

        assert.ok(leftChunks.every(chunk => chunk.startsWith(POSIX(first.dir))));
        assert.ok(rightChunks.every(chunk => chunk.startsWith(POSIX(second.dir))));
        assert.ok(!leftChunks.some(chunk => chunk.includes('beta')));
        assert.ok(!rightChunks.some(chunk => chunk.includes('alpha')));

        assert.deepEqual(
          [...left.dependentChunks.keys()].map(POSIX),
          [POSIX(first.path('main.frag')), POSIX(first.path('alpha.frag'))]
        );
        assert.deepEqual(
          [...right.dependentChunks.keys()].map(POSIX),
          [POSIX(second.path('main.frag')), POSIX(second.path('beta.frag'))]
        );
      }
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });

  it('a failed recursion does not poison the next successful transform', async () => {
    const env = fixture({
      'a.frag': '#include "b.frag";\nvoid a () {}\n',
      'b.frag': '#include "c.frag";\nvoid b () {}\n',
      'c.frag': '#include "a.frag";\nvoid c () {}\n',
      'healthy.frag': '#include "healthy-chunk.frag";\nvoid healthyMain () {}\n',
      'healthy-chunk.frag': 'float HEALTHY_MARKER = 1.0;\n'
    });

    try {
      let error;

      try {
        await transform(env.path('a.frag'));
        assert.fail('recursive shader should have thrown an error');
      } catch (caught) {
        error = caught;
      }

      // The error must still name both the recursive chunk and its caller.
      assert.equal(error.name, 'Error');
      assert.ok(error.message.startsWith('Recursion detected when importing '));
      assert.ok(error.message.includes(POSIX(env.path('a.frag'))));
      assert.ok(error.message.includes(POSIX(env.path('c.frag'))));

      // A normal transform immediately after the failure must succeed, with no
      // recursion marker / imported-set residue from the failed shader.
      const result = await transform(env.path('healthy.frag'));

      assert.ok(result.outputShader.includes('HEALTHY_MARKER'));
      assert.ok(result.outputShader.includes('void healthyMain'));
      assert.ok(!result.outputShader.includes('void a'));

      assert.deepEqual(
        [...result.dependentChunks.keys()].map(POSIX),
        [POSIX(env.path('healthy.frag'))]
      );
      assert.deepEqual(
        result.dependentChunks.get(POSIX(env.path('healthy.frag')))?.map(POSIX),
        [POSIX(env.path('healthy-chunk.frag'))]
      );

      // Re-running the same healthy transform must not see stale state either.
      const again = await transform(env.path('healthy.frag'));
      assert.equal(again.outputShader, result.outputShader);

      // The dependency map returned to this transform is owned by the
      // transform itself: a later transform must not mutate it. On the old
      // shared-state implementation this was the module-level Map, which a
      // subsequent `loadShader` call reset, so this snapshot changed.
      const healthySnapshot = [...result.dependentChunks.entries()]
        .map(([key, chunks]) => [POSIX(key), chunks.map(POSIX)]);

      await transform(env.path('healthy-chunk.frag'));

      assert.deepEqual(
        [...result.dependentChunks.entries()]
          .map(([key, chunks]) => [POSIX(key), chunks.map(POSIX)]),
        healthySnapshot
      );
    } finally {
      env.cleanup();
    }
  });

  it('duplicate-import warnings are attributed to their real caller', async () => {
    const culprit = fixture({
      'main.frag':
        '#include "shared.frag";\n#include "shared.frag";\nvoid culpritMain () {}\n',
      'shared.frag': 'float CULPRIT_SHARED = 1.0;\n'
    });

    const innocent = fixture({
      'main.frag': '#include "shared.frag";\nvoid innocentMain () {}\n',
      'shared.frag': 'float INNOCENT_SHARED = 2.0;\n'
    });

    try {
      const warnings = await captureWarnings(async () => {
        const [withDuplicate, withoutDuplicate] = await Promise.all([
          transform(culprit.path('main.frag')),
          transform(innocent.path('main.frag'))
        ]);

        assert.ok(withDuplicate.outputShader.includes('CULPRIT_SHARED'));
        assert.ok(withoutDuplicate.outputShader.includes('INNOCENT_SHARED'));

        // Dependency sets must not leak across the concurrent transforms.
        const culpritChunks =
          [...withDuplicate.dependentChunks.values()].flat().map(POSIX);
        const innocentChunks =
          [...withoutDuplicate.dependentChunks.values()].flat().map(POSIX);

        assert.ok(culpritChunks.every(path => path.startsWith(POSIX(culprit.dir))));
        assert.ok(innocentChunks.every(path => path.startsWith(POSIX(innocent.dir))));
      });

      const duplicateWarnings = warnings.filter(warning =>
        warning.message.includes('was included multiple times')
      );

      assert.equal(
        duplicateWarnings.length,
        1,
        'only the shader that imports the chunk twice should warn'
      );

      const warning = duplicateWarnings[0];
      assert.ok(warning.message.includes(POSIX(culprit.path('shared.frag'))));
      assert.ok(warning.detail.includes(POSIX(culprit.path('main.frag'))));
      assert.ok(!warning.detail.includes(POSIX(innocent.path('main.frag'))));
      assert.ok(!warning.message.includes(POSIX(innocent.path('shared.frag'))));
    } finally {
      culprit.cleanup();
      innocent.cleanup();
    }
  });

  it('a warning-free transform carries no warning attribution from others', async () => {
    const env = fixture({
      'main.frag': '#include "once.frag";\nvoid main () {}\n',
      'once.frag': 'float ONLY_ONCE = 1.0;\n'
    });

    try {
      const warnings = await captureWarnings(() => transform(env.path('main.frag')));
      assert.deepEqual(warnings, []);
    } finally {
      env.cleanup();
    }
  });

  it('watch registration uses only the current transform’s dependency set', async () => {
    // Mirrors `transform.handler` in src/index.js: the watch list is built from
    // the `dependentChunks` Map returned by that same `loadShader` call.
    const first = fixture({
      'main.frag': '#include "alpha.frag";\nvoid firstMain () {}\n',
      'alpha.frag': 'float FIRST = 1.0;\n'
    });

    const second = fixture({
      'main.frag': '#include "beta.frag";\nvoid secondMain () {}\n',
      'beta.frag': 'float SECOND = 2.0;\n'
    });

    try {
      const runHandler = async path => {
        const { dependentChunks } = await transform(path);
        // Exact watch logic used by the plugin (src/index.js):
        return Array.from(dependentChunks.values()).flat();
      };

      const [firstWatched, secondWatched] = await Promise.all([
        runHandler(first.path('main.frag')),
        runHandler(second.path('main.frag'))
      ]);

      assert.deepEqual(firstWatched.map(POSIX), [POSIX(first.path('alpha.frag'))]);
      assert.deepEqual(secondWatched.map(POSIX), [POSIX(second.path('beta.frag'))]);

      // No chunk from one shader tree may be registered for the other.
      assert.ok(firstWatched.every(chunk => POSIX(chunk).startsWith(POSIX(first.dir))));
      assert.ok(secondWatched.every(chunk => POSIX(chunk).startsWith(POSIX(second.dir))));
    } finally {
      first.cleanup();
      second.cleanup();
    }
  });
});
