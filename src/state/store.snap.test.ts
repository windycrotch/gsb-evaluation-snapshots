import { describe, it, expect, beforeEach } from 'vitest';
import { useCanvasStore } from './store';
import type { CanvasStore } from './store';
import type { Node } from '../types';

/**
 * Full reset of every piece of snap/history state so tests cannot leak locks,
 * guides or history entries into each other.
 */
function resetSnapStore() {
  useCanvasStore.setState({
    camera: { zoom: 1, offsetX: 0, offsetY: 0 },
    nodes: {},
    selected: {},
    boxSelecting: false,
    isDraggingNode: false,
    visualGroups: {},
    selectedVisualGroupId: null,
    hoveredVisualGroupId: null,
    hoveredVisualGroupIdSecondary: null,
    innerEditNodeId: null,
    isTransforming: false,
    centerAddIndex: 0,
    clipboard: null,
    pasteIndex: 0,
    historyPast: [],
    historyFuture: [],
    historyBatch: null,
    showRulers: true,
    guides: [],
    activeGuideId: null,
    alignmentGuides: [],
    snapOffset: null,
    snapLockX: null,
    snapLockY: null,
    alignSnapEnabled: true,
    alignSnapTolerancePx: 8,
  } as Partial<CanvasStore>);
}

/** Two same-sized nodes whose left edges are 200 world units apart. */
function setupHorizontalPair() {
  const moving: Node = { id: 'a', x: 100, y: 100, width: 80, height: 40 };
  const staticNode: Node = { id: 'b', x: 300, y: 100, width: 80, height: 40 };
  useCanvasStore.setState((s) => ({
    ...s,
    nodes: { a: moving, b: staticNode },
    selected: { a: true },
  }));
  return { moving, staticNode };
}

describe('Alignment snap: lock hysteresis on X axis', () => {
  beforeEach(() => resetSnapStore());

  it('locks when approaching within tolerance and keeps the node pinned on a small reverse move', () => {
    setupHorizontalPair();
    const st = useCanvasStore.getState();
    // tolerance 8px at zoom 1 -> tolWorld = 8, deadband = 4
    st.beginHistory('drag');

    // Approach the static node's left edge (300) from the left: moved left edge
    // lands at 297, i.e. 3 world units short -> within tolerance, moving toward it.
    st.moveSelectedBy(197, 0);
    let s = useCanvasStore.getState();
    // The node is pulled exactly onto the guide coordinate.
    expect(s.nodes['a'].x).toBe(300);
    expect(s.snapLockX).toEqual({ at: 300, kind: 'edge' });
    expect(s.alignmentGuides.some((g) => g.axis === 'x' && g.at === 300)).toBe(true);

    // Reverse move smaller than the deadband (|-3| <= 4): lock must hold and the
    // node must continue to sit exactly on the locked coordinate.
    s.moveSelectedBy(-3, 0);
    s = useCanvasStore.getState();
    expect(s.nodes['a'].x).toBe(300);
    expect(s.snapLockX).toEqual({ at: 300, kind: 'edge' });
    const lockGuide = s.alignmentGuides.find((g) => g.axis === 'x' && g.at === 300);
    expect(lockGuide).toBeDefined();
    expect(lockGuide?.kind).toBe('edge');

    st.endHistory();
    expect(useCanvasStore.getState().snapLockX).toBeNull();
    expect(useCanvasStore.getState().alignmentGuides).toEqual([]);
  });

  it('unlocks once the reverse move exceeds half the tolerance and then follows the raw delta', () => {
    setupHorizontalPair();
    const st = useCanvasStore.getState();
    st.beginHistory('drag');
    // Lock at x = 300 (raw 197 + correction 3).
    st.moveSelectedBy(197, 0);
    expect(useCanvasStore.getState().nodes['a'].x).toBe(300);

    // Reverse move of 5 > deadband (4): lock releases, node follows raw delta.
    st.moveSelectedBy(-5, 0);
    const s = useCanvasStore.getState();
    expect(s.snapLockX).toBeNull();
    expect(s.nodes['a'].x).toBe(295); // exactly 5 world units back from the locked position
    st.endHistory();
  });

  it('converts the pixel tolerance to world units using the current zoom (deadband = 0.5 * px / zoom)', () => {
    // zoom 2: tolWorld = 8 / 2 = 4, deadband = 2
    useCanvasStore.setState({ camera: { zoom: 2, offsetX: 0, offsetY: 0 } });
    setupHorizontalPair();
    const st = useCanvasStore.getState();
    st.beginHistory('drag');

    st.moveSelectedBy(197, 0); // corr 3 <= tolWorld 4 -> lock at 300
    expect(useCanvasStore.getState().nodes['a'].x).toBe(300);

    // Reverse 1.5 world units (<= deadband 2) stays locked.
    st.moveSelectedBy(-1.5, 0);
    let s = useCanvasStore.getState();
    expect(s.nodes['a'].x).toBe(300);
    expect(s.snapLockX).not.toBeNull();

    // Reverse 2.5 world units (> deadband 2) unlocks; at zoom 1 the same 2.5
    // delta would still be inside the deadband of 4.
    st.moveSelectedBy(-2.5, 0);
    s = useCanvasStore.getState();
    expect(s.snapLockX).toBeNull();
    expect(s.nodes['a'].x).toBe(297.5);
    st.endHistory();
  });
});

describe('Alignment snap: Y axis lock', () => {
  beforeEach(() => resetSnapStore());

  it('pins on Y while locked and releases past the deadband', () => {
    const moving: Node = { id: 'a', x: 100, y: 100, width: 80, height: 40 };
    const staticNode: Node = { id: 'b', x: 100, y: 300, width: 80, height: 40 };
    useCanvasStore.setState({ nodes: { a: moving, b: staticNode }, selected: { a: true } });
    const st = useCanvasStore.getState();
    st.beginHistory('drag');

    st.moveSelectedBy(0, 197); // top edge 297 vs target 300 -> lock at 300
    expect(useCanvasStore.getState().nodes['a'].y).toBe(300);
    expect(useCanvasStore.getState().snapLockY).toEqual({ at: 300, kind: 'edge' });

    st.moveSelectedBy(0, -3); // within deadband 4 -> stays pinned
    expect(useCanvasStore.getState().nodes['a'].y).toBe(300);
    expect(useCanvasStore.getState().snapLockY).not.toBeNull();

    st.moveSelectedBy(0, -5); // beyond deadband -> unlock, raw delta
    const s = useCanvasStore.getState();
    expect(s.snapLockY).toBeNull();
    expect(s.nodes['a'].y).toBe(295);
    st.endHistory();
  });
});

describe('Alignment snap: disabled or zero tolerance', () => {
  beforeEach(() => resetSnapStore());

  it('applies the raw delta and emits no guides/locks/offset when snapping is disabled', () => {
    setupHorizontalPair();
    const st = useCanvasStore.getState();
    st.setAlignSnapEnabled(false);
    st.beginHistory('drag');
    // Same raw delta that would lock with snapping enabled.
    st.moveSelectedBy(197, 0);
    const s = useCanvasStore.getState();
    expect(s.nodes['a'].x).toBe(297); // exactly 100 + 197, no correction
    expect(s.alignmentGuides).toEqual([]);
    expect(s.snapOffset).toBeNull();
    expect(s.snapLockX).toBeNull();
    expect(s.snapLockY).toBeNull();
    st.endHistory();
  });

  it('applies the raw delta and emits no guides when tolerance is 0, and drops any stale lock', () => {
    setupHorizontalPair();
    const st = useCanvasStore.getState();
    st.setAlignSnapTolerancePx(0);
    // A lock left over from a previous gesture must not survive a zero-tolerance move.
    useCanvasStore.setState({ snapLockX: { at: 300, kind: 'edge' } } as Partial<CanvasStore>);
    st.beginHistory('drag');

    st.moveSelectedBy(197, 0);
    const s = useCanvasStore.getState();
    expect(s.nodes['a'].x).toBe(297);
    expect(s.alignmentGuides).toEqual([]);
    expect(s.snapOffset).toBeNull();
    expect(s.snapLockX).toBeNull();
    expect(s.snapLockY).toBeNull();
    st.endHistory();
  });
});

describe('Alignment snap: programmatic moves outside a drag batch', () => {
  beforeEach(() => resetSnapStore());

  it('never snaps and never produces guides/locks when moveSelectedBy is called without beginHistory', () => {
    setupHorizontalPair();
    const st = useCanvasStore.getState();
    const historyBefore = st.historyPast.length;

    // No beginHistory(): this is a programmatic call.
    st.moveSelectedBy(197, 0);

    const s = useCanvasStore.getState();
    expect(s.nodes['a'].x).toBe(297); // raw delta only
    expect(s.alignmentGuides).toEqual([]);
    expect(s.snapOffset).toBeNull();
    expect(s.snapLockX).toBeNull();
    expect(s.snapLockY).toBeNull();
    expect(s.historyBatch).toBeNull();
    // A non-batch move is still recorded as its own ordinary history entry.
    expect(s.historyPast.length).toBe(historyBefore + 1);
  });
});

describe('Alignment snap: history coalescing, undo/redo and camera', () => {
  beforeEach(() => {
    resetSnapStore();
    ((globalThis as unknown) as { window?: { innerWidth: number; innerHeight: number } }).window = {
      innerWidth: 1024,
      innerHeight: 768,
    };
  });

  it('records exactly one history entry per drag; undo restores the gesture start and redo the end; camera is untouched', () => {
    const moving: Node = { id: 'a', x: 100, y: 100, width: 80, height: 40 };
    const staticNode: Node = { id: 'b', x: 300, y: 100, width: 80, height: 40 };
    // Pre-populate nodes directly so the drag itself is the only history entry.
    useCanvasStore.setState({ nodes: { a: moving, b: staticNode }, selected: { a: true } });
    const st = useCanvasStore.getState();

    st.beginHistory('drag');
    st.moveSelectedBy(197, 0); // lock at 300
    st.moveSelectedBy(-3, 0); // small reverse: stays locked at 300
    st.moveSelectedBy(-5, 0); // past deadband: unlock -> 295
    st.endHistory();

    let s = useCanvasStore.getState();
    expect(s.historyPast.length).toBe(1);
    const entry = s.historyPast[0];
    expect(entry.changes.length).toBe(1);
    const change = entry.changes[0];
    expect(change.kind).toBe('update');
    if (change.kind !== 'update') throw new Error('expected update change');
    expect(change.before).toMatchObject({ id: 'a', x: 100 });
    expect(change.after).toMatchObject({ id: 'a', x: 295 });
    expect(s.nodes['a'].x).toBe(295);

    // Undo -> gesture start coordinates.
    s.undo();
    s = useCanvasStore.getState();
    expect(s.nodes['a'].x).toBe(100);
    expect(s.historyFuture.length).toBe(1);
    // Camera rule unchanged: the node stays on screen, so the camera does not move.
    expect(s.camera).toEqual({ zoom: 1, offsetX: 0, offsetY: 0 });

    // Redo -> gesture end coordinates.
    s.redo();
    s = useCanvasStore.getState();
    expect(s.nodes['a'].x).toBe(295);
    expect(s.historyFuture.length).toBe(0);
    expect(s.camera).toEqual({ zoom: 1, offsetX: 0, offsetY: 0 });
  });

  it('clearing the lock and guides at drag end leaves nothing that influences the next drag', () => {
    setupHorizontalPair();
    let st = useCanvasStore.getState();

    // First drag: acquire a lock at 300 and finish the gesture.
    st.beginHistory('drag');
    st.moveSelectedBy(197, 0);
    expect(useCanvasStore.getState().nodes['a'].x).toBe(300);
    expect(useCanvasStore.getState().snapLockX).not.toBeNull();
    st.endHistory();

    let s = useCanvasStore.getState();
    // All ephemeral snap state is gone after the gesture.
    expect(s.snapLockX).toBeNull();
    expect(s.snapLockY).toBeNull();
    expect(s.snapOffset).toBeNull();
    expect(s.alignmentGuides).toEqual([]);

    // Second drag starting from the locked position (300). A small reverse move
    // must follow the raw delta instead of being held by the previous lock.
    st = useCanvasStore.getState();
    st.beginHistory('drag');
    st.moveSelectedBy(-2, 0);
    s = useCanvasStore.getState();
    // With a stale lock this would have stayed at 300 (|-2| <= deadband 4).
    expect(s.nodes['a'].x).toBe(298);
    expect(s.snapLockX).toBeNull();
    st.endHistory();
    expect(useCanvasStore.getState().snapLockX).toBeNull();
  });
});
