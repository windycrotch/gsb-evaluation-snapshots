(() => {
  if (window.__errsInstalled) return window.__errs;
  window.__errs = [];
  window.addEventListener('error', e => window.__errs.push('ERR ' + (e.message||'').slice(0,200)));
  window.addEventListener('unhandledrejection', e => window.__errs.push('REJ ' + String(e.reason).slice(0,200)));
  const oe = console.error;
  console.error = function(...a){ window.__errs.push('CE ' + a.map(String).join(' ').slice(0,200)); oe.apply(console,a); };
  window.__errsInstalled = true;
  return window.__errs;
})();
