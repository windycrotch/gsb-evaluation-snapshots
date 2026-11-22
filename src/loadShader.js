import { dirname, resolve, extname, posix, sep } from 'path';
import { emitWarning, cwd } from 'process';
import { readFileSync } from 'fs';
import { platform } from 'os';

/**
 * @function
 * @name warn
 * @description Emits a plugin warning via `process.emitWarning` and, when
 * installed, forwards the same data to the internal test hook. The hook is an
 * injection point used by the local unit tests to attribute warnings to the
 * exact transform that emits them, since `process` `warning` events are
 * dispatched asynchronously and cannot reliably be tied to a call site.
 *
 * @param {string} message Warning message
 * @param {Record<string, string>} options Warning options (`code`, `detail`)
 */
function warn (message, options) {
  emitWarning(message, options);
  globalThis.__VITE_PLUGIN_GLSL_WARNING__?.({ message, ...options });
}

/**
 * @typedef {Object} ChunkState
 * @description Per-transform tracking state. Every `loadShader` invocation
 * creates its own instance so that concurrent transforms (e.g. several shader
 * files saved at once during a dev-server hot update) can never overwrite
 * each other's recursion markers, imported sets or warning attributions.
 *
 * @property {string}               recursiveChunk    Shader chunk path that caused a recursion error
 * @property {Set<string>}          allChunks         List of all shader chunks, used to track included files
 * @property {Map<string, string[]>} dependentChunks  Map of shaders that import other chunks:
 *  - Key: shader path that uses other chunks as dependencies
 *  - Value: list of chunk paths included within the shader
 * @property {Map<string, string[]>} duplicatedChunks Map of duplicated shader imports, used by warning messages
 */

/**
 * @function
 * @name createChunkState
 * @description Creates an independent set of tracking collections
 * for a single `loadShader` transform invocation
 *
 * @returns {ChunkState} Fresh, empty per-transform tracking state
 */
function createChunkState () {
  return {
    recursiveChunk: '',
    allChunks: new Set(),
    dependentChunks: new Map(),
    duplicatedChunks: new Map()
  };
}

/**
 * @function
 * @name resetChunkState
 * @description Clears all lists of saved chunks
 * and resets "recursiveChunk" path to empty
 *
 * @param {ChunkState} state Per-transform tracking state
 *
 * @returns {string} Copy of "recursiveChunk" path
 */
function resetChunkState (state) {
  const chunk = state.recursiveChunk;
  state.duplicatedChunks.clear();
  state.dependentChunks.clear();

  state.recursiveChunk = '';
  state.allChunks.clear();
  return chunk;
}

/**
 * @function
 * @name getRecursionCaller
 * @description Gets last chunk that caused a
 * recursion error from the "dependentChunks" list
 *
 * @param {ChunkState} state Per-transform tracking state
 *
 * @returns {string} Chunk path that started a recursion
 */
function getRecursionCaller (state) {
  const dependencies = [...state.dependentChunks.keys()];
  return dependencies[dependencies.length - 1];
}

/**
 * @function
 * @name checkDuplicatedImports
 * @description Checks if shader chunk was already included
 * and adds it to the "duplicatedChunks" list if yes
 *
 * @param {string}     path  Shader's absolute path
 * @param {ChunkState} state Per-transform tracking state
 *
 * @throws {Warning} If shader chunk was already included
 */
function checkDuplicatedImports (path, state) {
  const caller = getRecursionCaller(state);

  const chunks = state.duplicatedChunks.get(caller) ?? [];
  if (chunks.includes(path)) return;

  chunks.push(path);
  state.duplicatedChunks.set(caller, chunks);

  warn(`'${path}' was included multiple times.`, {
    code: 'vite-plugin-glsl',
    detail: 'Please avoid multiple imports of the same chunk in order to avoid' +
    ` recursions and optimize your shader length.\nDuplicated import found in file '${caller}'.`
  });
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

      warn(`Block comment was not ${missing}ed.`, {
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
 * @name checkRecursiveImports
 * @description Checks if shader dependencies
 * have caused a recursion error or warning
 * ignoring duplicate chunks if required
 *
 * @param {string}     path    Shader's absolute path
 * @param {string}     lowPath Shader's lowercase path
 * @param {boolean}    warn    Check already included chunks
 * @param {boolean}    ignore  Ignore already included chunks
 * @param {ChunkState} state   Per-transform tracking state
 *
 * @returns {boolean | null} Import recursion has occurred
 * or chunk was ignored because of `ignore` argument
 */
function checkRecursiveImports (path, lowPath, warn, ignore, state) {
  if (state.allChunks.has(lowPath)) {
    if (ignore) return null;
    warn && checkDuplicatedImports(path, state);
  }

  return checkIncludedDependencies(path, path, state);
}

/**
 * @function
 * @name checkIncludedDependencies
 * @description Checks if included
 * chunks caused a recursion error
 *
 * @param {string}     path  Current chunk absolute path
 * @param {string}     root  Main shader path that imports chunks
 * @param {ChunkState} state Per-transform tracking state
 *
 * @returns {boolean} Included chunk started a recursion
 */
function checkIncludedDependencies (path, root, state) {
  const dependencies = state.dependentChunks.get(path);
  let recursiveDependency = false;

  if (dependencies?.includes(root)) {
    state.recursiveChunk = root;
    return true;
  }

  dependencies?.forEach(dependency => recursiveDependency ||=
    checkIncludedDependencies(dependency, root, state)
  );

  return recursiveDependency;
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

        line = line.replace(/([+-])\s+(?=\1)|(\/)\s+(?=\*)/g, '$1$2\0')
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
 * @name loadChunks
 * @description Includes shader's dependencies
 * and removes comments from the source code
 *
 * @param {string}     source  Shader's source code
 * @param {string}     path    Shader's absolute path
 * @param {RegExp}     pattern RegExp to import chunks
 * @param {Options}    options Shader loading config object
 * @param {ChunkState} state   Per-transform tracking state
 *
 * @throws {Error} If shader chunks started a recursion loop
 *
 * @returns {string} Shader's source code without external chunks
 */
function loadChunks (source, path, pattern, options, state) {
  const unixPath = path.split(sep).join(posix.sep);

  const chunkPath = platform() === 'win32' &&
    unixPath.toLowerCase() || unixPath;

  const recursion = checkRecursiveImports(
    unixPath, chunkPath,
    options.warnDuplicatedImports,
    options.removeDuplicatedImports,
    state
  );

  if (recursion) return state.recursiveChunk;
  else if (recursion === null) return '';

  source = removeSourceComments(source, pattern);
  let directory = dirname(unixPath);
  state.allChunks.add(chunkPath);

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

      return loadChunks(
        readFileSync(shader, 'utf8'),
        shader, pattern, options, state
      );
    });
  }

  if (state.recursiveChunk) {
    const caller = getRecursionCaller(state);
    const recursiveChunk = resetChunkState(state);

    throw new Error(
      `Recursion detected when importing "${recursiveChunk}" in "${caller}".`
    );
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
 * @returns {Promise<Output>} Loaded, parsed (and minified)
 * shader output and Map of shaders that import other chunks
 */
export default async function (source, shader, options) {
  const pattern = new RegExp(String.raw`(${
    options.importKeywords.join('|')
  })(\s+([^\s<>]+));?`, 'gi');

  // Tracking state is created per invocation instead of being shared at the
  // module level, so concurrent transforms never see each other's chunks and
  // a failed transform can't leave residue for the next one.
  const state = createChunkState();

  let outputShader = loadChunks(source, shader, pattern, options, state);

  options.minify && (outputShader = minifyShader(
    removeSourceComments(outputShader, pattern, true))
  );

  outputShader = await options.onComplete?.(outputShader, shader) ?? outputShader;

  return { dependentChunks: state.dependentChunks, outputShader };
}
