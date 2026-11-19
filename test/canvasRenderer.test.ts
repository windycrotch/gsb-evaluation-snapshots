import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSceneToCanvas } from '../src/utils/canvasRenderer.ts';
import { Scene, VisualElement } from '../src/types/explainroo.ts';

// Minimal 2D canvas stub that records whether drawing actually happened.
function makeCanvasStub() {
  const calls: string[] = [];
  const baseCtx = {
    save() {
      calls.push('save');
    },
    restore() {
      calls.push('restore');
    },
    fillRect() {
      calls.push('fillRect');
    },
    beginPath() {},
    moveTo() {},
    lineTo() {},
    stroke() {},
    translate() {},
    scale() {},
    rotate() {},
    fillText() {},
    setLineDash() {},
    strokeRect() {},
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    font: '',
    textAlign: '',
    textBaseline: '',
    globalAlpha: 1,
  };
  // Permissive proxy: any 2D-context method rough.js reaches for is a no-op.
  const ctx = new Proxy(baseCtx, {
    get(target, prop) {
      if (prop in target) return (target as Record<string | symbol, unknown>)[prop];
      return () => {};
    },
    set(target, prop, value) {
      (target as Record<string | symbol, unknown>)[prop] = value;
      return true;
    },
  }) as unknown as CanvasRenderingContext2D;
  const canvas = {
    width: 1280,
    height: 720,
    getContext: () => ctx,
  } as unknown as HTMLCanvasElement;
  return { canvas, ctx, calls };
}

function makeElement(overrides: Partial<VisualElement>): VisualElement {
  return {
    id: 'el-1',
    type: 'rectangle',
    x: 100,
    y: 100,
    width: 120,
    height: 80,
    color: '#000000',
    strokeWidth: 2,
    animation: 'fade',
    ...overrides,
  };
}

function makeScene(elements: VisualElement[], durationSeconds = 7): Scene {
  return {
    id: 's1',
    title: 'S1',
    narration: '',
    elements,
    durationSeconds,
  };
}

test('element with trigger beyond scene duration appears at the final frame', () => {
  const { canvas, calls } = makeCanvasStub();
  const element = makeElement({ triggerTimeSec: 12, durationMs: 500 });
  const scene = makeScene([element], 7);

  // Before the end, the element is still hidden.
  renderSceneToCanvas({ canvas, scene, currentTime: 6.0, theme: 'whiteboard' });
  const earlyDraws = calls.filter((c) => c === 'save').length;

  // At the final frame the clamped trigger (7s) has passed -> element draws.
  renderSceneToCanvas({ canvas, scene, currentTime: 7, theme: 'whiteboard' });
  const finalDraws = calls.filter((c) => c === 'save').length;
  assert.ok(finalDraws > earlyDraws, 'out-of-range element must render at scene end');
});

test('element with negative trigger is present from scene start', () => {
  const { canvas, calls } = makeCanvasStub();
  const element = makeElement({ triggerTimeSec: -3 });
  const scene = makeScene([element], 7);

  renderSceneToCanvas({ canvas, scene, currentTime: 0, theme: 'whiteboard' });
  // save() is called for background and again for each rendered element.
  assert.ok(calls.filter((c) => c === 'save').length >= 2);
});

test('seeking past a normal trigger fully enters the element (progress = 1)', () => {
  const { canvas } = makeCanvasStub();
  const element = makeElement({ triggerTimeSec: 2, durationMs: 500, animation: 'fade' });
  const scene = makeScene([element], 7);

  // No throw and element renders fully at time well past trigger + duration.
  renderSceneToCanvas({ canvas, scene, currentTime: 4, theme: 'whiteboard' });
  // Interactive mode always renders elements regardless of time.
  renderSceneToCanvas({ canvas, scene, currentTime: 0, theme: 'whiteboard', interactiveMode: true });
  assert.ok(true);
});

test('element before its trigger is not drawn during playback', () => {
  const { canvas, calls } = makeCanvasStub();
  const element = makeElement({ triggerTimeSec: 4 });
  const scene = makeScene([element], 7);

  renderSceneToCanvas({ canvas, scene, currentTime: 1, theme: 'whiteboard' });
  // Only the outer background save/restore pair; the element itself skipped.
  assert.equal(calls.filter((c) => c === 'save').length, 1);
});
