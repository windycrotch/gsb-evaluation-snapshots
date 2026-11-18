import os from 'node:os';

// Preserve the terminal capability rules used by the console renderer.
export function supportsPinnedHeader(stream, { env = process.env, platform = process.platform, release = os.release() } = {}) {
  if (!stream?.isTTY || env.CW_PIN_HEADER === '0' || env.TERM === 'dumb') return false;
  if (platform === 'win32') {
    if (env.WT_SESSION || env.TERM_PROGRAM || /^(xterm|screen|tmux|cygwin)/.test(env.TERM ?? '')) return true;
    const [major, , build] = release.split('.').map(Number);
    return major > 10 || major === 10 && build >= 10586;
  }
  return /^(xterm|screen|tmux|rxvt|vt100|ansi|linux)/.test(env.TERM ?? '') || !!env.TERM_PROGRAM;
}

export function shutdownSignals(platform = process.platform) {
  return platform === 'win32' ? ['SIGINT', 'SIGTERM', 'SIGBREAK'] : ['SIGINT', 'SIGTERM'];
}
