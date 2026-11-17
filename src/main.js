const params = new URLSearchParams(location.search);
const mode = params.get('mode') || 'game';

window.__errors = [];
window.addEventListener('error', (e) => window.__errors.push(String(e.message) + (e.error?.stack ? '\n' + e.error.stack : '')));
window.addEventListener('unhandledrejection', (e) => window.__errors.push(String(e.reason?.stack || e.reason)));

const boot = {
  capture: () => import('./capture/session.js'),
  game: () => import('./game.js'),
};
(boot[mode] || boot.game)().then((m) => m.run(params));
