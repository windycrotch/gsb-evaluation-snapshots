import { dirname, resolve, extname, posix, sep } from 'path';
import { emitWarning, cwd } from 'process';
import { readFileSync } from 'fs';
import { platform } from 'os';

const isWindows = platform() === 'win32';

/**
 * @function
 * @name createLoadState
 * @description Creates the state used by a single shader load:
 * already included chunks, the current import stack and the
 * dependency diagnostics, so separate loads cannot leak into
 * each other (not even a failed or an interleaved one)
 *
 * @returns {LoadState} Fresh shader loading state
 */
function createLoadState () {
  return {
    /**
     * @type {readonly Map<string, string[]>}
     * @description Map of shaders that import other chunks
     * - Key: shader path that uses other chunks as dependencies
     * - Value: list of chunk paths included within the shader
     */
    dependentChunks: new Map(),

    includedChunks: new Set(),
    warnedImports: new Set(),
    records: new Map(),
    importStack: [],

    diagnostics: {
      chunks: [],
      byPath: {}
    }
  };
}

/**
 * @function
 * @name normalizeChunkPath
 * @description Normalizes a shader path so it can be
 * used as a key (Windows paths are case insensitive)
 *
 * @param {string} path Shader's absolute path
 *
 * @returns {string} Normalized shader path
 */
function normalizeChunkPath (path) {
  return isWindows ? path.toLowerCase() : path;
}

/**
 * @function
 * @name recordChunkImport
 * @description Records that a chunk was imported by a
 * parent shader, increasing its import counter and
 * keeping an ordered list of distinct importers
 *
 * @param {LoadState} state    Shader loading state
 * @param {string}    path     Imported chunk absolute path
 * @param {string}    importer Parent shader absolute path
 *
 * @returns {ChunkImportDiagnostic} Updated chunk diagnostic
 */
function recordChunkImport (state, path, importer) {
  const key = normalizeChunkPath(path);
  let chunk = state.records.get(key);

  if (!chunk) {
    chunk = {
      path,
      importers: [],
      importCount: 0,
      skippedCount: 0
    };

    state.records.set(key, chunk);
    state.diagnostics.chunks.push(chunk);
  }

  // Index every spelling of the chunk path, so lookups
  // keep working on case insensitive file systems:
  state.diagnostics.byPath[path] = chunk;

  chunk.importCount++;

  const importerKey = normalizeChunkPath(importer);
  const knownImporter = chunk.importers.find(
    parent => normalizeChunkPath(parent) === importerKey
  );

  if (!knownImporter) chunk.importers.push(importer);

  return chunk;
}

/**
 * @function
 * @name warnDuplicatedImport
 * @description Emits a warning for a chunk imported more
 * than once, at most once per importer/chunk pair
 *
 * @param {LoadState} state    Shader loading state
 * @param {string}    path     Imported chunk absolute path
 * @param {string}    importer Parent shader absolute path
 *
 * @throws {Warning} If shader chunk was already included
 */
function warnDuplicatedImport (state, path, importer) {
  const key = `${normalizeChunkPath(importer ?? '')}\0${normalizeChunkPath(path)}`;
  if (state.warnedImports.has(key)) return;

  state.warnedImports.add(key);

  emitWarning(`'${path}' was included multiple times.`, {
    code: 'vite-plugin-glsl',
    detail: 'Please avoid multiple imports of the same chunk in order to avoid' +
    ` recursions and optimize your shader length.\nDuplicated import found in file '${importer}'.`
  });
}

/**
 * @function
 * @name createCycleError
 * @description Builds the error thrown when a chunk imports
 * itself, including the complete chain of chunk paths that
 * starts and ends with the repeated chunk
 *
 * @param {LoadState} state Shader loading state
 * @param {string}    path  Chunk path that closed the cycle
 *
 * @returns {Error} Recursion error with the full import chain
 */
function createCycleError (state, path) {
  const key = normalizeChunkPath(path);

  const start = state.importStack.findIndex(
    chunk => normalizeChunkPath(chunk) === key
  );

  const chain = [...state.importStack, path];

  const cycle = [...state.importStack.slice(
    Math.max(start, 0)
  ), path];

  const quoted = chunks => chunks.map(chunk => `"${chunk}"`).join(' -> ');

  const error = new Error(
    `Recursion detected when importing "${path}".\n` +
    `Import chain: ${quoted(chain)}\n` +
    `Import cycle: ${quoted(cycle)}`
  );

  error.code = 'vite-plugin-glsl';
  error.chain = chain;
  error.cycle = cycle;

  return error;
}

/**
 * @function
 * @name removeSourceComments
 * @description Removes comments from shader source
 * code in order to avoid including commented chunks
 * Triple-slash comments are meant to be preserved,
 * but to avoid errors, they will be removed anyway
 * when containing import keywords or block comments
 *
 * @param {string}  source  Shader's source code
 * @param {RegExp}  pattern RegExp to import chunks
 * @param {boolean} triple  Remove triple slash comments
 *
 * @returns {string} Shader's source code without comments
 */
function removeSourceComments (source, pattern, triple = false) {
  const lines = source.split('\n');
  const comments = /\/\*|\*\//;

  for (let l = lines.length; l--; ) {
    const index = lines[l].indexOf('//');

    if (index > -1) {
      if (
        lines[l][index + 2] === '/' &&
        !comments.test(lines[l]) &&
        !pattern.test(lines[l]) &&
        !triple
      )
        continue;

      lines[l] = lines[l].slice(0, index);
    }
  }

  source = lines.join('\n');

  while (true) {
    const startBlock = source.indexOf('/*');
    const endBlock = source.indexOf('*/', startBlock);

    if (startBlock < 0 && endBlock < 0) break;

    else if (startBlock > -1 && endBlock > -1)
      source = source.slice(0, startBlock) +
        source.slice(endBlock + 2);

    else {
      const chunk = source.slice(
        startBlock * +(endBlock === -1),
        (startBlock === -1 && endBlock + 2) || void 0
      );

      const comment = startBlock === -1 && '/*' || '*/';
      const missing = startBlock === -1 && 'open' || 'clos';

      emitWarning(`Block comment was not ${missing}ed.`, {
        code: 'vite-plugin-glsl',
        detail: `Cannot find the corresponding ${missing}ing comment (${comment}) to the one in the` +
        ` chunk below.\nMake sure it's present and not commented out by a line comment:\n\n${chunk}`
      });

      break;
    }
  }

  return source;
}

/**
 * @function
 * @name minifyShader
 * @description Minifies shader source code by
 * removing unnecessary whitespace and empty lines
 *
 * @param {string}  shader  Shader code with included chunks
 * @param {boolean} newLine Flag to require a new line for the code
 *
 * @returns {string} Minified shader's source code
 */
export function minifyShader (shader, newLine = false) {
  return shader.replace(/\\(?:\r\n|\n\r|\n|\r)|\/\*.*?\*\/|\/\/(?:\\(?:\r\n|\n\r|\n|\r)|[^\n\r])*/g, '')
    .split(/\n+/).reduce((result, line) => {
      line = line.trim().replace(/\s{2,}|\t/g, ' ');

      if (/@(vertex|fragment|compute)/.test(line) || line.endsWith('return')) line += ' ';

      if (line[0] === '#') {
        newLine && result.push('\n');
        result.push(line, '\n');
        newLine = false;
      }

      else {
        const prev = result.at(-1) ?? '';
        !line.startsWith('{') && prev.endsWith('else') && result.push(' ');
        /\w$/.test(prev) && /^\w/.test(line) && !prev.endsWith('else') && result.push(' ');

        line = line.replace(/([+-])\s+(?=\1)/g, '$1\0')
          .replace(/\s*({|}|=|,|\+|\-|\*|\/|<|>|&|\||\[|\]|\(|\)|!|;)\s*/g, '$1')
          .replace(/\0/g, ' ');

        result.push(line);
        newLine = true;
      }

      return result;
    }, []).join('').replace(/\n+/g, '\n');
}

/**
 * @function
 * @name snapshotDependencies
 * @description Copies the dependency map built during a load,
 * so later loads cannot mutate an already returned result
 *
 * @param {LoadState} state Shader loading state
 *
 * @returns {Map<string, string[]>} Shaders that import other chunks
 */
function snapshotDependencies (state) {
  return new Map(
    [...state.dependentChunks].map(([path, chunks]) => [path, [...chunks]])
  );
}

/**
 * @function
 * @name snapshotDiagnostics
 * @description Copies the chunk diagnostics collected during a load
 *
 * @param {LoadState} state Shader loading state
 *
 * @returns {DependencyDiagnostics} Per-chunk dependency report
 */
function snapshotDiagnostics (state) {
  const byPath = {};
  const chunks = new Map();

  const entry = chunk => {
    if (!chunks.has(chunk)) chunks.set(chunk, {
      importers: [...chunk.importers],
      importCount: chunk.importCount,
      skippedCount: chunk.skippedCount,
      path: chunk.path
    });

    return chunks.get(chunk);
  };

  for (const [path, chunk] of Object.entries(state.diagnostics.byPath))
    byPath[path] = entry(chunk);

  return {
    chunks: state.diagnostics.chunks.map(entry),
    byPath
  };
}

/**
 * @function
 * @name loadChunks
 * @description Includes shader's dependencies
 * and removes comments from the source code
 *
 * @param {string}  source  Shader's source code
 * @param {string}  path    Shader's absolute path
 * @param {RegExp}  pattern RegExp to import chunks
 * @param {Options} options Shader loading config object
 * @param {LoadState} state Shader loading state
 * @param {string}  importer Parent shader absolute path
 *
 * @throws {Error} If shader chunks started a recursion loop
 *
 * @returns {string} Shader's source code without external chunks
 */
function loadChunks (source, path, pattern, options, state, importer) {
  const unixPath = resolve(path).split(sep).join(posix.sep);

  const chunkPath = normalizeChunkPath(unixPath);

  if (state.importStack.some(chunk =>
    normalizeChunkPath(chunk) === chunkPath
  ))
    throw createCycleError(state, unixPath);

  if (state.includedChunks.has(chunkPath)) {
    options.warnDuplicatedImports &&
      warnDuplicatedImport(state, unixPath, importer);

    if (options.removeDuplicatedImports) {
      const chunk = state.records.get(chunkPath);
      chunk && chunk.skippedCount++;
      return '';
    }
  }

  source = removeSourceComments(source, pattern);
  let directory = dirname(unixPath);
  state.includedChunks.add(chunkPath);

  state.importStack.push(unixPath);

  try {
    if (pattern.test(source)) {
      state.dependentChunks.set(unixPath, []);
      const currentDirectory = directory;
      const ext = options.defaultExtension;

      source = source.replace(pattern, (_, ...[, chunkPath]) => {
        chunkPath = chunkPath.trim().replace(/^(?:"|')?|(?:"|')?;?$/gi, '');

        if (!chunkPath.indexOf('/')) {
          const base = cwd().split(sep).join(posix.sep);
          chunkPath = base + options.root + chunkPath;
        }

        const directoryIndex = chunkPath.lastIndexOf('/');
        directory = currentDirectory;

        if (directoryIndex !== -1) {
          directory = resolve(directory, chunkPath.slice(0, directoryIndex + 1));
          chunkPath = chunkPath.slice(directoryIndex + 1, chunkPath.length);
        }

        let shader = resolve(directory, chunkPath);
        if (!extname(shader)) shader = `${shader}.${ext}`;

        const shaderPath = shader.split(sep).join(posix.sep);
        state.dependentChunks.get(unixPath)?.push(shaderPath);
        recordChunkImport(state, shaderPath, unixPath);

        return loadChunks(
          readFileSync(shader, 'utf8'),
          shader, pattern, options, state, unixPath
        );
      });
    }
  } finally {
    state.importStack.pop();
  }

  return source.trim().replace(/(\r\n|\r|\n){3,}/g, '$1\n');
}

/**
 * @function
 * @name loadShader
 * @description Iterates through all external chunks, includes them
 * into the shader's source code and optionally minifies the output
 *
 * @typedef {import('./types').LoadingOptions} Options
 * @typedef {import('./types').LoadingOutput} Output
 * @typedef {import('./types').LoadState} LoadState
 * @typedef {import('./types').ChunkImportDiagnostic} ChunkImportDiagnostic
 *
 * @param {string}  source  Shader's source code
 * @param {string}  shader  Shader's absolute path
 * @param {Options} options Configuration object to define:
 *
 *  - Shader suffix to use when no extension is specified
 *  - Warn if the same chunk was imported multiple times
 *  - Automatically remove an already imported chunk
 *  - Optional function to call with output shader
 *  - Keywords used to import shader chunks
 *  - Directory for root imports
 *  - Minify output shader code
 *
 * @returns {Promise<Output>} Loaded, parsed (and minified) shader
 * output, Map of shaders that import other chunks and a per-chunk
 * dependency diagnostics report
 */
export default async function (source, shader, options) {
  const pattern = new RegExp(String.raw`(${
    options.importKeywords.join('|')
  })(\s+([^\s<>]+));?`, 'gi');

  const state = createLoadState();

  // A failed load throws without returning any shader: the diagnostics
  // are owned by `state`, so nothing is left behind for the next load.
  let outputShader = loadChunks(source, shader, pattern, options, state);

  // Diagnostics and dependencies are captured before minify/onComplete,
  // so they always describe the imported chunks, not the final output.
  const dependentChunks = snapshotDependencies(state);
  const diagnostics = snapshotDiagnostics(state);

  options.minify && (outputShader = minifyShader(
    removeSourceComments(outputShader, pattern, true))
  );

  outputShader = await options.onComplete?.(outputShader, shader) ?? outputShader;

  return { dependentChunks, diagnostics, outputShader };
}
