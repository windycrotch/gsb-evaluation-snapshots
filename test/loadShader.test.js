import { readFileSync } from 'fs';
import { posix, resolve, sep } from 'path';
import { fileURLToPath } from 'url';

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import loadShader from '../src/loadShader.js';

/**
 * Repository root, derived from this file so the tests work
 * regardless of the directory they are run from. Root-style
 * includes (`/test/...`) resolve against `process.cwd()`, so
 * the suite chdirs there for the duration of every test.
 */
const root = resolve(fileURLToPath(import.meta.url), '..', '..');

// Root-style includes (`/test/...`) are resolved against the cwd by
// the loader, so make sure we always run from the repository root:
process.chdir(root);

/** Converts a repository-relative path to an absolute POSIX path */
const absolute = path => resolve(root, path).split(sep).join(posix.sep);

/** Builds the options object used by every test */
const options = (overrides = {}) => ({
  defaultExtension: 'glsl',
  warnDuplicatedImports: false,
  removeDuplicatedImports: false,
  importKeywords: ['#include'],
  onComplete: undefined,
  minify: false,
  root: '/',
  ...overrides
});

/** Loads a shader fixture from the repository */
const load = (path, overrides) => loadShader(
  readFileSync(resolve(root, path), 'utf8'),
  absolute(path),
  options(overrides)
);

/** Returns the diagnostic of a chunk by its repository-relative path */
const diagnose = (diagnostics, path) => diagnostics.byPath[absolute(path)];

/** Counts how many times `chunkGreen` is defined in a shader */
const greenDefinitions = shader =>
  (shader.match(/(?:float|fn)\s+chunkGreen/g) ?? []).length;

/** Captures `process` warnings emitted while `callback` runs */
const captureWarnings = async callback => {
  const warnings = [];
  const listener = warning => warnings.push(warning);

  process.on('warning', listener);

  try {
    await callback();
    await new Promise(done => setImmediate(done));
  } finally {
    process.off('warning', listener);
  }

  return warnings;
};

const duplicateWarnings = warnings => warnings.filter(
  warning => /included multiple times/.test(warning.message)
);

const fixtures = [
  {
    language: 'GLSL',
    defaultExtension: 'glsl',
    main: 'test/glsl/main.frag',
    chunk0: 'test/glsl/chunk0.frag',
    duplicated: 'test/glsl/diagnostics/duplicate.frag',
    cycleMain: 'test/glsl/diagnostics/cycle-main.frag',
    cycleA: 'test/glsl/diagnostics/cycle-a.frag',
    cycleB: 'test/glsl/diagnostics/cycle-b.frag',
    shared: 'test/glsl/chunk3.frag',
    chunk1: 'test/glsl/utils/chunk1.glsl',
    chunk2: 'test/glsl/utils/chunk2.frag',
    sibling: 'test/glsl/diagnostics/sibling.frag'
  },
  {
    language: 'WGSL',
    defaultExtension: 'wgsl',
    main: 'test/wgsl/main.wgsl',
    chunk0: 'test/wgsl/chunk0.wgsl',
    duplicated: 'test/wgsl/diagnostics/duplicate.wgsl',
    cycleMain: 'test/wgsl/diagnostics/cycle-main.wgsl',
    cycleA: 'test/wgsl/diagnostics/cycle-a.wgsl',
    cycleB: 'test/wgsl/diagnostics/cycle-b.wgsl',
    shared: 'test/wgsl/chunk3.wgsl',
    chunk1: 'test/wgsl/utils/chunk1.wgsl',
    chunk2: 'test/wgsl/utils/chunk2.wgsl',
    sibling: 'test/wgsl/diagnostics/sibling.wgsl'
  }
];

for (const fixture of fixtures) {
  const {
    language, defaultExtension, main, chunk0, duplicated,
    cycleMain, cycleA, cycleB, shared, chunk1, chunk2, sibling
  } = fixture;

  describe(`${language} dependency diagnostics`, () => {
    it('reports each imported chunk with its importers and count', async () => {
      const { dependentChunks, diagnostics, outputShader } = await load(main, {
        defaultExtension
      });

      // The output must stay identical to a plain inlined shader:
      assert.equal(typeof outputShader, 'string');
      assert.equal(outputShader.includes('#include'), false);
      assert.ok(outputShader.includes('chunkRGB'));

      // Only imported chunks are reported, in import order; the
      // entry shader itself is not one of them:
      assert.deepEqual(
        diagnostics.chunks.map(chunk => chunk.path),
        [chunk0, chunk1, chunk2, shared].map(absolute)
      );

      assert.deepEqual(diagnose(diagnostics, chunk0).importers, [absolute(main)]);
      assert.deepEqual(diagnose(diagnostics, chunk1).importers, [absolute(chunk0)]);
      assert.deepEqual(diagnose(diagnostics, chunk2).importers, [absolute(chunk1)]);
      assert.deepEqual(diagnose(diagnostics, shared).importers, [absolute(chunk1)]);

      for (const chunk of diagnostics.chunks) {
        assert.equal(chunk.importCount, 1);
        assert.equal(chunk.skippedCount, 0);
        assert.equal(diagnostics.byPath[chunk.path], chunk);
      }

      // The existing return structure is preserved:
      assert.ok(dependentChunks instanceof Map);
      assert.deepEqual([...dependentChunks.keys()], [
        absolute(main), absolute(chunk0), absolute(chunk1)
      ]);
    });

    it('counts a chunk imported by two different parents', async () => {
      const { diagnostics, outputShader } = await load(duplicated, {
        defaultExtension
      });

      const chunk = diagnose(diagnostics, shared);

      assert.equal(chunk.importCount, 2);
      assert.equal(chunk.skippedCount, 0);

      assert.deepEqual([...chunk.importers].sort(), [
        absolute(chunk1), absolute(sibling)
      ].sort());

      // Without dedup both copies are inlined:
      assert.equal(greenDefinitions(outputShader), 2);

      // Importers of a chunk are tracked independently of its content:
      assert.equal(diagnose(diagnostics, sibling).importCount, 1);
      assert.deepEqual(
        diagnose(diagnostics, sibling).importers,
        [absolute(duplicated)]
      );
    });

    it('keeps only the first copy with removeDuplicatedImports', async () => {
      const { diagnostics, outputShader } = await load(duplicated, {
        defaultExtension,
        removeDuplicatedImports: true
      });

      const chunk = diagnose(diagnostics, shared);

      // The diagnostics still record the real number of imports:
      assert.equal(chunk.importCount, 2);
      assert.equal(chunk.skippedCount, 1);

      // …but the skipped copy is not inlined again:
      assert.equal(greenDefinitions(outputShader), 1);
      assert.ok(outputShader.includes('chunkRGB'));
    });

    it('warns about duplicated imports only when asked to', async () => {
      const verbose = duplicateWarnings(await captureWarnings(() =>
        load(duplicated, { defaultExtension, warnDuplicatedImports: true })
      ));

      assert.equal(verbose.length, 1);
      assert.match(verbose[0].message, new RegExp(
        absolute(shared).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      ));

      const quiet = duplicateWarnings(await captureWarnings(() =>
        load(duplicated, { defaultExtension, warnDuplicatedImports: false })
      ));

      assert.equal(quiet.length, 0);
    });

    it('counts repeated imports coming from the same parent', async () => {
      const path = absolute(duplicated);

      const source = [
        `#include /${shared}`,
        `#include /${shared}`,
        `#include /${shared}`
      ].join('\n');

      const warnings = duplicateWarnings(await captureWarnings(() =>
        loadShader(source, path, options({ defaultExtension, warnDuplicatedImports: true }))
      ));

      // The same importer/chunk pair is only warned about once:
      assert.equal(warnings.length, 1);

      const { diagnostics, outputShader } = await loadShader(
        source, path, options({ defaultExtension, removeDuplicatedImports: true })
      );

      const chunk = diagnose(diagnostics, shared);

      assert.equal(chunk.importCount, 3);
      assert.equal(chunk.skippedCount, 2);
      assert.deepEqual(chunk.importers, [path]);
      assert.equal(greenDefinitions(outputShader), 1);
    });

    it('throws the complete cycle path chain without returning a shader', async () => {
      await assert.rejects(load(cycleMain, { defaultExtension }), error => {
        assert.match(error.message, /Recursion detected/);

        // Both chunks of the a -> b -> a loop appear with absolute paths:
        assert.ok(error.message.includes(`"${absolute(cycleA)}"`));
        assert.ok(error.message.includes(`"${absolute(cycleB)}"`));

        // The cycle starts and ends with the same chunk:
        assert.deepEqual(error.cycle, [
          absolute(cycleA), absolute(cycleB), absolute(cycleA)
        ]);

        // The chain also shows how the entry shader reached the cycle:
        assert.deepEqual(error.chain, [
          absolute(cycleMain), absolute(cycleA), absolute(cycleB), absolute(cycleA)
        ]);

        return true;
      });
    });

    it('detects the cycle even with removeDuplicatedImports enabled', async () => {
      await assert.rejects(load(cycleMain, {
        defaultExtension,
        removeDuplicatedImports: true
      }), error => {
        assert.deepEqual(error.cycle, [
          absolute(cycleA), absolute(cycleB), absolute(cycleA)
        ]);

        return true;
      });
    });

    it('does not leak state into the next load after a failure', async () => {
      await assert.rejects(load(cycleMain, { defaultExtension }));
      await assert.rejects(load(cycleMain, {
        defaultExtension,
        removeDuplicatedImports: true
      }));

      const { dependentChunks, diagnostics, outputShader } = await load(main, {
        defaultExtension
      });

      assert.equal(outputShader.includes('#include'), false);
      assert.ok(outputShader.includes('chunkRGB'));

      // Diagnostics only describe the successful load:
      const reported = diagnostics.chunks.map(chunk => chunk.path);
      assert.equal(reported.includes(absolute(cycleMain)), false);
      assert.equal(reported.includes(absolute(cycleA)), false);
      assert.equal(reported.includes(absolute(duplicated)), false);

      for (const chunk of diagnostics.chunks) {
        assert.equal(chunk.importCount, 1);
        assert.equal(chunk.skippedCount, 0);
      }

      assert.deepEqual([...dependentChunks.keys()], [
        absolute(main), absolute(chunk0), absolute(chunk1)
      ]);
    });

    it('collects diagnostics before minify and onComplete run', async () => {
      const calls = [];

      const { diagnostics, outputShader } = await load(main, {
        defaultExtension,
        minify: true,
        onComplete: (shader, path) => {
          calls.push([path, shader.length]);
          return `${shader}\n// onComplete`;
        }
      });

      assert.ok(diagnostics.chunks.length > 0);
      assert.deepEqual(calls.map(([path]) => path), [absolute(main)]);

      // minify ran before onComplete (the marker survives at the end):
      assert.match(outputShader, /\/\/ onComplete$/);
      assert.equal(outputShader.includes('#include'), false);
      assert.ok(calls[0][1] < outputShader.length);
    });

    it('splices the chunks exactly as the shader source dictates', async () => {
      const { outputShader } = await load(main, { defaultExtension });

      assert.equal(outputShader, golden[language]);
    });

    it('returns independent results for interleaved loads', async () => {
      const [first, second] = await Promise.all([
        load(duplicated, { defaultExtension, removeDuplicatedImports: true }),
        load(main, { defaultExtension })
      ]);

      // The second load never sees the duplicated chunk of the first one:
      assert.equal(
        diagnose(second.diagnostics, shared).importCount,
        1
      );

      assert.equal(diagnose(second.diagnostics, sibling), undefined);
      assert.equal(first.outputShader.includes('siblingGreen'), true);
      assert.equal(second.outputShader.includes('siblingGreen'), false);

      assert.equal(
        [...second.dependentChunks.keys()].includes(
          absolute(duplicated)
        ),
        false
      );
    });
  });
}

/**
 * Expected inlined output of the main fixtures (captured from the
 * implementation before the diagnostics were introduced), proving
 * that chunk splicing itself did not change.
 */
const golden = {
  GLSL: '#version 300 es\n\n#ifndef GL_FRAGMENT_PRECISION_HIGH\n' +
    '  precision mediump float;\n#else\n  precision highp float;\n#endif\n\n' +
    'out vec4 fragColor;\n\nfloat chunkRed () {\n  return 0.0;\n}\n' +
    'float chunkGreen () {\n  return 0.8;\n}\n\nvec3 chunkRGB () {\n' +
    '  return vec3(chunkRed(), chunkGreen(), 0.0);\n}\n\nvec4 chunkFn () {\n' +
    '  return vec4(chunkRGB(), 1.0);\n}\n\nvoid main (void) {\n' +
    '  fragColor = chunkFn();\n}',

  WGSL: 'fn chunkRed() -> f32 {\n  return 0.0;\n}\nfn chunkGreen() -> f32 {\n' +
    '  return 0.8;\n}\n\nfn chunkRGB() -> vec3f {\n' +
    '  return vec3f(chunkRed(), chunkGreen(), 0.0);\n}\n\n' +
    'fn chunkFn() -> vec4f {\n  return vec4f(chunkRGB(), 1.0);\n}\n\n' +
    '@vertex\nfn mainVert(@builtin(vertex_index) index: u32) ->\n' +
    '  @builtin(position) position: vec4f\n{\n  let position = array(\n' +
    '    vec2f(0.0,  1.0),\n    vec2f(1.0,  1.0),\n    vec2f(0.0,  0.0),\n\n' +
    '    vec2f(0.0,  0.0),\n    vec2f(1.0,  0.0),\n    vec2f(1.0,  1.0)\n  );\n\n' +
    '  let coords = position[index];\n  return vec4f(coords * 2 - 1, 0, 1);\n}\n\n' +
    '@fragment\nfn mainFrag() -> @location(0) vec4f\n{\n  return chunkFn();\n}'
};
