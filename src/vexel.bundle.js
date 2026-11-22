// src/vexel.bundle.js
//
// Classic-script bundle for the playground page.
//
// The browser has no module loader here, so every source file is listed here
// in dependency order and loaded synchronously with document.write inside a
// same-origin script. `index.html` therefore runs the repaired engine source
// directly instead of a remote dist build, and there is exactly one Vexel /
// canvas pipeline on the page.

(function () {
  if (typeof window === 'undefined' || typeof document === 'undefined') return;
  if (window.__VEXEL_BUNDLE_LOADED__) return;

  var sources = [
    'src/core/viewport-snapshot.js',
    'src/core/overlay.js',
    'src/core/shapes.js',
    'src/core/renderer.js',
    'src/core/engine.js',
    'src/core/canvas.js',
    'src/core/viewport.js',
    'src/core/events.js',
    'src/core/vexel.js'
  ];

  var base = (function () {
    var script = document.currentScript;
    if (script && script.src) {
      return script.src.substring(0, script.src.lastIndexOf('/') + 1);
    }
    return '';
  })();

  // Resolve the base directory of this bundle (src/) then step up to the
  // repository root, because the source list is repo-relative.
  var root = base.replace(/src\/$/, '');

  window.__VEXEL_BUNDLE_LOADED__ = true;

  for (var i = 0; i < sources.length; i++) {
    document.write('<script src="' + root + sources[i] + '"><\/script>');
  }
})();
