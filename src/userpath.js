// Whether a folder is on the PATH of the user's terminal, seen from inside a Node process that npm or nvm started.
// That process's PATH can start with folders the terminal does not have: npx adds node_modules/.bin folders,
// node-gyp-bin and Node's own folder once, and on Windows nvm 2.0's shim also puts Node's folder first (under nvm that
// is npm's global folder), so there every leading copy is dropped. On macOS and Linux nvm puts Node's folder first in
// the terminal itself, so only the copy npx added is dropped. A Windows user who put Node's folder first themselves is
// told it is off PATH, and setup writes a launcher it did not need, which runs the same package.
import { posix, win32 } from 'node:path';

export function onUserPath(dir, { env = process.env, execPath = process.execPath, win = process.platform === 'win32' } = {}) {
  const P = win ? win32 : posix;
  const same = win ? (a, b) => P.resolve(a).toLowerCase() === P.resolve(b).toLowerCase() : (a, b) => P.resolve(a) === P.resolve(b);
  const path = (env.PATH || env.Path || '').split(P.delimiter).filter(Boolean), nodeDir = P.dirname(execPath);
  const npx = env.npm_command === 'exec';
  let lead = 0, nodeDirs = 0;
  for (; lead < path.length; lead++) {
    if (/node_modules[\\/]\.bin$|node-gyp-bin$/i.test(path[lead])) continue;
    if (same(path[lead], nodeDir) && (win || (npx && nodeDirs++ === 0))) continue;
    break;
  }
  return path.slice(lead).some(p => same(p, dir));
}
