(() => {
  const E = window.__ENGINE, W = E.ctx.World, bus = E.ctx.bus, EV = E.ctx.EV;
  // toggle F3
  window.dispatchEvent(new KeyboardEvent('keydown', { key: 'F3' }));
  // emit a freeze so the rows have values
  W.clock.reset(); W.clock.request(70);
  // read the rendered debug rows after a tick
  return new Promise(res => setTimeout(() => {
    const box = document.querySelector('#debug');
    const rows = box ? [...box.querySelectorAll('.d-row')].map(r => r.textContent) : null;
    res({ visible: box && box.classList.contains('show'), rows });
  }, 400));
})();
