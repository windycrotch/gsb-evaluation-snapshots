import { assert, assertEquals, assertLess } from "@std/assert";
import {
  calculateRenderingSize,
  CanvasManager,
  type CanvasRenderingSize,
  type CanvasState,
  MAX_RENDERING_DIMENSION,
} from "../../src/js/canvas-manager.ts";
import { type DomShimHandles, type FakeCanvasElement, type FakeElement, installDomShim } from "./dom-shim.ts";

const EPSILON = 1e-9;
// _constrainTransform rounds the centered translation to whole pixels.
const CENTERING_TOLERANCE = 1.5;
const BOUND_TOLERANCE = 1.5;
const SCREEN_SAMPLE_POINTS: Array<[number, number]> = [
  [0, 0],
  [137, 89],
  [500, 350],
  [999, 699],
  [-42, 17],
  [250.5, 420.25],
];

interface Internals {
  _minScale: number;
  _maxScale: number;
  _containerWidth: number;
  _containerHeight: number;
  _panTranslateX: number;
  _panTranslateY: number;
  _zoomTranslateX: number;
  _zoomTranslateY: number;
  _scale: number;
}

const internals = (manager: CanvasManager): Internals => manager as unknown as Internals;

const attachManager = (shim: DomShimHandles, manager: CanvasManager) => {
  const root = shim.document.createElement("div") as FakeElement;
  const { canvas, container } = manager.attachToDOM(root as unknown as HTMLElement);
  return {
    root,
    canvas: canvas as unknown as FakeCanvasElement,
    container: container as unknown as FakeElement,
  };
};

/**
 * Invariant shared by every state-change test: the transform stays inside the
 * scale limits and the container bounds (centered when the canvas fits, no
 * outer gap when it overflows), the applied CSS mirrors the tracked transform,
 * and screenToCanvas/canvasToScreen remain exact inverses at every sampled
 * screen position. The actual canvas CSS size is read from the manager so the
 * auto-size floor (minWidth/minHeight) is accounted for.
 */
const assertConstrainedAndInvertible = (
  manager: CanvasManager,
  containerWidth: number,
  containerHeight: number,
  canvas?: FakeCanvasElement,
) => {
  const style = manager.getStyleSize();
  const styleWidth = style.width;
  const styleHeight = style.height;
  const state = internals(manager);
  assert(state._scale >= state._minScale - EPSILON, "scale below minimum");
  assert(state._scale <= state._maxScale + EPSILON, "scale above maximum");

  const scaledWidth = styleWidth * state._scale;
  const scaledHeight = styleHeight * state._scale;
  const transform = manager.transform;

  if (scaledWidth <= containerWidth) {
    // Canvas narrower than the container: horizontally centered (px-rounded).
    assertLess(
      Math.abs(transform.translateX - (containerWidth - scaledWidth) / 2),
      CENTERING_TOLERANCE,
      "fitting canvas must be horizontally centered",
    );
  } else {
    // Canvas wider than the container: neither edge may reveal outer space,
    // i.e. (containerWidth - scaledWidth) <= translateX <= 0.
    assert(
      transform.translateX <= BOUND_TOLERANCE,
      "overflowing canvas must not leave a gap on the left",
    );
    assert(
      transform.translateX >= containerWidth - scaledWidth - BOUND_TOLERANCE,
      "overflowing canvas must not leave a gap on the right",
    );
  }

  if (scaledHeight <= containerHeight) {
    assertLess(
      Math.abs(transform.translateY - (containerHeight - scaledHeight) / 2),
      CENTERING_TOLERANCE,
      "fitting canvas must be vertically centered",
    );
  } else {
    assert(
      transform.translateY <= BOUND_TOLERANCE,
      "overflowing canvas must not leave a gap on the top",
    );
    assert(
      transform.translateY >= containerHeight - scaledHeight - BOUND_TOLERANCE,
      "overflowing canvas must not leave a gap on the bottom",
    );
  }

  // Both the pan and zoom translation parts participate in the round trip.
  for (const [screenX, screenY] of SCREEN_SAMPLE_POINTS) {
    const canvasPoint = manager.screenToCanvas(screenX, screenY);
    const backToScreen = manager.canvasToScreen(canvasPoint.x, canvasPoint.y);
    assertLess(Math.abs(backToScreen.x - screenX), EPSILON, "x round trip drifted");
    assertLess(Math.abs(backToScreen.y - screenY), EPSILON, "y round trip drifted");
  }

  if (canvas) {
    assertEquals(
      canvas.style.getPropertyValue("transform"),
      manager.generateTransformCSS(),
      "CSS transform must match the tracked transform",
    );
  }
};

const assertTransformParts = (manager: CanvasManager) => {
  const state = internals(manager);
  const totalX = state._panTranslateX + state._zoomTranslateX;
  const totalY = state._panTranslateY + state._zoomTranslateY;
  assertEquals(manager.transform.translateX, totalX);
  assertEquals(manager.transform.translateY, totalY);
};

Deno.test("ResizeObserver resize re-centers, re-clamps and keeps coordinates invertible", () => {
  const shim = installDomShim({ width: 1000, height: 700 });
  try {
    const manager = new CanvasManager({ minWidth: 800, minHeight: 600, toolbarSize: 60 });
    const { container, canvas } = attachManager(shim, manager);

    const stateChanges: CanvasState[] = [];
    const renderingChanges: CanvasRenderingSize[] = [];
    manager.setCallbacks({
      onStateChange: (state) => stateChanges.push(state),
      onRenderingSizeChange: (size) => renderingChanges.push(size),
    });

    manager.zoom(1.4, 500, 350);
    manager.pan(-120, 80);
    assertConstrainedAndInvertible(manager, 1000, 700, canvas);

    // Container shrinks below the minimum; auto-size keeps the 800x600 floor,
    // so the (scaled) canvas overflows the container on both axes and is clamped.
    shim.triggerResize(container, 600, 400);
    assertEquals(internals(manager)._containerWidth, 600);
    assertEquals(internals(manager)._containerHeight, 400);
    assertEquals(manager.getStyleSize(), { width: 800, height: 600 });
    assertConstrainedAndInvertible(manager, 600, 400, canvas);
    assertEquals(stateChanges.at(-1)?.containerSize, { width: 600, height: 400 });

    // Growing again restores a centered, fitting canvas.
    shim.triggerResize(container, 1200, 900);
    assertEquals(manager.getStyleSize(), { width: 1200, height: 900 });
    assertConstrainedAndInvertible(manager, 1200, 900, canvas);
    assertEquals(renderingChanges.length > 0, true);
    assertEquals(manager.getCurrentState().containerSize, { width: 1200, height: 900 });
  } finally {
    shim.restore();
  }
});

Deno.test("window resize without a ResizeObserver delivery re-constrains the transform", () => {
  const shim = installDomShim({ width: 1000, height: 700 });
  try {
    const manager = new CanvasManager({ minWidth: 800, minHeight: 600, toolbarSize: 60 });
    const { canvas, container } = attachManager(shim, manager);

    manager.zoom(1.5, 500, 350);
    assertConstrainedAndInvertible(manager, 1000, 700, canvas);

    // Simulate a browser where the observer does not fire for this resize.
    shim.setViewport(640, 420);
    shim.window.dispatchEvent({ type: "resize" });

    assertEquals(internals(manager)._containerWidth, 640);
    assertEquals(internals(manager)._containerHeight, 420);
    assertConstrainedAndInvertible(manager, 640, 420, canvas);
    assertEquals(container.getBoundingClientRect().width, 640);
  } finally {
    shim.restore();
  }
});

Deno.test("adjustForToolbar measures the real inset container instead of accumulating offsets", () => {
  const shim = installDomShim({ width: 1000, height: 700 });
  try {
    const manager = new CanvasManager({ minWidth: 800, minHeight: 600, toolbarSize: 60 });
    const { canvas, container } = attachManager(shim, manager);

    // Landscape: a 60px vertical strip is reserved on the right.
    manager.adjustForToolbar(false);
    assertEquals(internals(manager)._containerWidth, 940);
    assertEquals(internals(manager)._containerHeight, 700);
    assertEquals(container.style.getPropertyValue("right"), "60px");
    assertConstrainedAndInvertible(manager, 940, 700, canvas);

    // Repeated calls must not keep subtracting the toolbar size.
    manager.adjustForToolbar(false);
    manager.adjustForToolbar(false);
    assertEquals(internals(manager)._containerWidth, 940);
    assertEquals(internals(manager)._containerHeight, 700);

    // Portrait: a 60px horizontal strip is reserved at the bottom.
    manager.adjustForToolbar(true);
    assertEquals(internals(manager)._containerWidth, 1000);
    assertEquals(internals(manager)._containerHeight, 640);
    assertEquals(container.style.getPropertyValue("bottom"), "60px");
    assertEquals(container.style.getPropertyValue("right"), "0");
    assertConstrainedAndInvertible(manager, 1000, 640, canvas);

    // Back to landscape: width is measured from the inset rect, not memory.
    manager.adjustForToolbar(false);
    assertEquals(internals(manager)._containerWidth, 940);
    assertEquals(internals(manager)._containerHeight, 700);
    assertConstrainedAndInvertible(manager, 940, 700, canvas);
  } finally {
    shim.restore();
  }
});

Deno.test("toolbar adjustment re-constrains after the container itself resizes", () => {
  const shim = installDomShim({ width: 1000, height: 700 });
  try {
    const manager = new CanvasManager({ minWidth: 800, minHeight: 600, toolbarSize: 60 });
    const { canvas, container } = attachManager(shim, manager);

    shim.setViewport(800, 600);
    shim.triggerResize(container, 800, 600);

    manager.adjustForToolbar(true);
    assertEquals(internals(manager)._containerWidth, 800);
    assertEquals(internals(manager)._containerHeight, 540);
    assertConstrainedAndInvertible(manager, 800, 540, canvas);
  } finally {
    shim.restore();
  }
});

Deno.test("setCanvasStyleSize enters fixed size and constrains against the measured container", () => {
  const shim = installDomShim({ width: 1000, height: 700 });
  try {
    const manager = new CanvasManager({ minWidth: 800, minHeight: 600, toolbarSize: 60 });
    const { canvas, container } = attachManager(shim, manager);

    // A smaller fixed canvas is centered and no longer follows the container.
    manager.setCanvasStyleSize(400, 300);
    assertEquals(manager.getCurrentState().isFixedSize, true);
    assertEquals(manager.getStyleSize(), { width: 400, height: 300 });
    assertEquals(canvas.style.getPropertyValue("width"), "400px");
    assertEquals(canvas.style.getPropertyValue("height"), "300px");
    assertConstrainedAndInvertible(manager, 1000, 700, canvas);

    // Resizing the container keeps the fixed CSS size but re-centers it.
    shim.triggerResize(container, 700, 500);
    assertEquals(manager.getStyleSize(), { width: 400, height: 300 });
    assertEquals(manager.getCurrentState().isFixedSize, true);
    assertConstrainedAndInvertible(manager, 700, 500, canvas);

    // A fixed canvas larger than the container cannot be panned into blank space.
    manager.setCanvasStyleSize(2000, 1500);
    manager.zoom(1.2, 350, 250);
    assertConstrainedAndInvertible(manager, 700, 500, canvas);

    manager.pan(10_000, 10_000);
    assertConstrainedAndInvertible(manager, 700, 500, canvas);
    assertEquals(manager.transform.translateX, 0);
    assertEquals(manager.transform.translateY, 0);

    manager.pan(-10_000, -10_000);
    assertConstrainedAndInvertible(manager, 700, 500, canvas);
    const state = internals(manager);
    assertEquals(state._panTranslateX + state._zoomTranslateX, 700 - 2000 * 1.2);
    assertEquals(state._panTranslateY + state._zoomTranslateY, 500 - 1500 * 1.2);
  } finally {
    shim.restore();
  }
});

Deno.test("resetToAutoSize returns to container-driven sizing and re-constrains", () => {
  const shim = installDomShim({ width: 1000, height: 700 });
  try {
    const manager = new CanvasManager({ minWidth: 800, minHeight: 600, toolbarSize: 60 });
    const { canvas, container } = attachManager(shim, manager);

    manager.setCanvasStyleSize(400, 300);
    assertEquals(manager.getCurrentState().isFixedSize, true);

    // A sub-minimum container falls back to the configured minimum style size.
    shim.triggerResize(container, 720, 540);
    manager.resetToAutoSize();

    assertEquals(manager.getCurrentState().isFixedSize, false);
    assertEquals(manager.getStyleSize(), { width: 800, height: 600 });
    assertConstrainedAndInvertible(manager, 720, 540, canvas);

    // Growing past the minimum makes the style size track the container again.
    shim.triggerResize(container, 1080, 810);
    assertEquals(manager.getStyleSize(), { width: 1080, height: 810 });
    assertConstrainedAndInvertible(manager, 1080, 810, canvas);
  } finally {
    shim.restore();
  }
});

Deno.test("fixed and auto size can be toggled repeatedly while constraints hold", () => {
  const shim = installDomShim({ width: 1000, height: 700 });
  try {
    const manager = new CanvasManager({ minWidth: 800, minHeight: 600, toolbarSize: 60 });
    const { canvas, container } = attachManager(shim, manager);

    manager.setCanvasStyleSize(1600, 1200);
    manager.zoom(1.3, 400, 300);
    assertConstrainedAndInvertible(manager, 1000, 700, canvas);

    manager.resetToAutoSize();
    assertConstrainedAndInvertible(manager, 1000, 700, canvas);

    // Re-entering fixed size at the current style dimensions keeps it valid.
    const current = manager.getStyleSize();
    manager.setCanvasStyleSize(current.width, current.height);
    assertEquals(manager.getCurrentState().isFixedSize, true);
    assertConstrainedAndInvertible(manager, 1000, 700, canvas);

    shim.triggerResize(container, 1100, 820);
    assertEquals(manager.getStyleSize(), { width: 1000, height: 700 });
    assertConstrainedAndInvertible(manager, 1100, 820, canvas);

    manager.resetToAutoSize();
    assertEquals(manager.getStyleSize(), { width: 1100, height: 820 });
    assertConstrainedAndInvertible(manager, 1100, 820, canvas);
  } finally {
    shim.restore();
  }
});

Deno.test("recalculateInitialScale fits an oversized canvas and stays within scale limits", () => {
  const shim = installDomShim({ width: 1000, height: 700 });
  try {
    const manager = new CanvasManager({ minWidth: 800, minHeight: 600, toolbarSize: 60 });
    const { canvas } = attachManager(shim, manager);

    manager.setCanvasStyleSize(3000, 2000);
    manager.zoom(2, 500, 350);
    assertEquals(manager.transform.scale, 2);

    manager.recalculateInitialScale();
    const state = internals(manager);
    // 700 / 2000 = 0.35 is the limiting fit factor for an oversized canvas.
    assertEquals(state._scale, 0.35);
    assertEquals(state._zoomTranslateX, 0);
    assertEquals(state._zoomTranslateY, 0);
    assertConstrainedAndInvertible(manager, 1000, 700, canvas);

    // A fitting canvas recalculates back to scale 1 and centered placement.
    manager.setCanvasStyleSize(500, 400);
    manager.recalculateInitialScale();
    assertEquals(manager.transform.scale, 1);
    assertConstrainedAndInvertible(manager, 1000, 700, canvas);
  } finally {
    shim.restore();
  }
});

Deno.test("recalculateInitialScale clamps the fit scale to the supported range", () => {
  const shim = installDomShim({ width: 1000, height: 700 });
  try {
    const manager = new CanvasManager({ minWidth: 800, minHeight: 600, toolbarSize: 60 });
    const { canvas } = attachManager(shim, manager);

    // A tiny container against a large canvas would want a scale below 0.1.
    manager.setCanvasStyleSize(10_000, 8_000);
    manager.recalculateInitialScale();
    assertEquals(manager.transform.scale, 0.1);
    assertConstrainedAndInvertible(manager, 1000, 700, canvas);
  } finally {
    shim.restore();
  }
});

Deno.test("a visible canvas point keeps round-tripping through every state change", () => {
  const shim = installDomShim({ width: 1000, height: 700 });
  try {
    const manager = new CanvasManager({ minWidth: 800, minHeight: 600, toolbarSize: 60 });
    const { canvas, container } = attachManager(shim, manager);

    // Apply a transform that has both a zoom-anchor part and a pan part.
    manager.zoom(1.6, 500, 350);
    manager.pan(-50, 25);
    assertTransformParts(manager);

    const canvasPoint = { x: 240, y: 170 };
    const assertSamePoint = () => {
      const screen = manager.canvasToScreen(canvasPoint.x, canvasPoint.y);
      const roundTripped = manager.screenToCanvas(screen.x, screen.y);
      assertLess(Math.abs(roundTripped.x - canvasPoint.x), EPSILON);
      assertLess(Math.abs(roundTripped.y - canvasPoint.y), EPSILON);
    };

    assertSamePoint();
    shim.triggerResize(container, 640, 480);
    assertSamePoint();
    assertTransformParts(manager);

    manager.adjustForToolbar(true);
    assertSamePoint();

    manager.setCanvasStyleSize(1400, 900);
    assertSamePoint();
    assertTransformParts(manager);

    manager.resetToAutoSize();
    assertSamePoint();

    manager.recalculateInitialScale();
    assertSamePoint();
    assertTransformParts(manager);

    // The CSS transform always reflects both translation components.
    const state = internals(manager);
    const expectedCss = `translate(${state._panTranslateX + state._zoomTranslateX}px, ` +
      `${state._panTranslateY + state._zoomTranslateY}px) scale(${state._scale})`;
    assertEquals(canvas.style.getPropertyValue("transform"), expectedCss);
  } finally {
    shim.restore();
  }
});

Deno.test("out-of-bounds pan is clamped after each size and toolbar change", () => {
  const shim = installDomShim({ width: 1000, height: 700 });
  try {
    const manager = new CanvasManager({ minWidth: 800, minHeight: 600, toolbarSize: 60 });
    const { canvas, container } = attachManager(shim, manager);

    manager.setCanvasStyleSize(1800, 1400);
    manager.zoom(1.5, 200, 150);
    manager.pan(-5000, -5000);
    assertConstrainedAndInvertible(manager, 1000, 700, canvas);

    shim.triggerResize(container, 1200, 800);
    assertConstrainedAndInvertible(manager, 1200, 800, canvas);

    manager.adjustForToolbar(false);
    assertConstrainedAndInvertible(manager, 1140, 800, canvas);

    manager.resetToAutoSize();
    assertConstrainedAndInvertible(manager, 1140, 800, canvas);
  } finally {
    shim.restore();
  }
});

Deno.test("backing-store rendering size stays separated from CSS size across fixed-size changes", () => {
  const shim = installDomShim({ width: 1000, height: 700, devicePixelRatio: 2 });
  try {
    const manager = new CanvasManager({ minWidth: 800, minHeight: 600, toolbarSize: 60 });
    const { canvas } = attachManager(shim, manager);

    const notified: CanvasRenderingSize[] = [];
    manager.setCallbacks({
      onRenderingSizeChange: (size) => notified.push(size),
    });

    manager.setCanvasStyleSize(500, 400);
    const halfDpr = manager.getRenderingSize();
    assertEquals(halfDpr, {
      styleWidth: 500,
      styleHeight: 400,
      renderingWidth: 1000,
      renderingHeight: 800,
      pixelRatio: 2,
    });

    // CSS size and the backing buffer are distinct attributes.
    assertEquals(canvas.style.getPropertyValue("width"), "500px");
    assertEquals(canvas.width, 1600); // initial 800x600 at dpr 2 from attach
    canvas.width = halfDpr.renderingWidth;
    assertEquals(canvas.width, 1000);

    // Raising the pixel ratio scales the buffer without touching CSS size.
    shim.window.devicePixelRatio = 3;
    const highDpr = manager.getRenderingSize();
    assertEquals(highDpr.styleWidth, 500);
    assertEquals(highDpr.pixelRatio, 3);
    assertEquals(highDpr.renderingWidth, 1500);

    // The dimension cap shrinks the effective pixel ratio in lockstep.
    const capped = calculateRenderingSize(3000, 2000, 3);
    assertEquals(capped.renderingWidth, MAX_RENDERING_DIMENSION);
    assertEquals(capped.pixelRatio, MAX_RENDERING_DIMENSION / 3000);
    assertEquals(capped.renderingHeight, 2731);

    // The callback reports buffer changes, and the last one matches the state.
    assertEquals(notified.at(-1)?.styleWidth, 500);
  } finally {
    shim.restore();
  }
});

Deno.test("constraint helpers still hold for an unattached manager", () => {
  const manager = new CanvasManager({ minWidth: 800, minHeight: 600, toolbarSize: 60 });

  manager.zoom(1.5, 400, 300);
  manager.pan(999, 999);

  // No DOM container yet: the constructor's min size is used as the viewport.
  assertConstrainedAndInvertible(manager, 800, 600);
  assertTransformParts(manager);

  manager.recalculateInitialScale();
  assertEquals(manager.transform.scale, 1);
  assertConstrainedAndInvertible(manager, 800, 600);
});
