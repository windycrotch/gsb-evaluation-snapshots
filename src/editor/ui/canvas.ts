/** Small helpers for the canvases that draw themselves (dopesheet, graph editor). */

/**
 * Calls `draw` once per frame while `dirty.current` is set. `stop` ends the loop. `now` draws at once when something is dirty: a canvas
 * whose size was just set is empty, and has to be painted in the same frame (from the resize callback) or it blinks for a frame.
 */
export function drawWhenDirty(dirty: { current: boolean }, draw: () => void): { stop: () => void; now: () => void } {
  let raf = 0;
  const now = () => {
    if (!dirty.current) return;
    dirty.current = false;
    try {
      draw();
    } catch (e) {
      console.error(e);
    }
  };
  const loop = () => {
    now();
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);
  return { stop: () => cancelAnimationFrame(raf), now };
}

/** The position of a pointer event inside an element, in CSS pixels. */
export function localPoint(e: { clientX: number; clientY: number }, el: Element): readonly [number, number] {
  const r = el.getBoundingClientRect();
  return [e.clientX - r.left, e.clientY - r.top];
}

/** A canvas as a picture file (`image/png` by default). */
export function canvasToBlob(canvas: HTMLCanvasElement, type = 'image/png', quality?: number): Promise<Blob> {
  return new Promise((resolve, reject) =>
    canvas.toBlob((b) => (b ? resolve(b) : reject(new Error(`Could not encode a ${type} picture`))), type, quality),
  );
}
