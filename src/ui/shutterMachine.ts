// The shutter state machine, free of DOM, WebGL and timers: the DOM layer (shutters.ts) plugs in
// real requestAnimationFrame/performance.now and the painting/camera work, while the local
// verification (tests/shutters.test.ts) plugs in a fake clock and minimal hooks. Everything that
// can desynchronise under interleaved input lives here, in one place:
//
//   state: 'open' | 'closing' | 'closed' | 'opening'
//   p:      0 shut .. 1 open, the single source of truth for the hinge angle every frame
//
// Requests that arrive while a swing (or its async preparation) is in flight are ignored, never
// stacked, so repeated button presses cannot leave the wings half open. Stroke-view repaints are
// funnelled through repaint() and serialised, so they can never clobber a swing's painting.
// A failed or missing exterior ('unavailable') degrades to plain backs instead of jamming the work.
export const SWING_MS = 2600; // preserved: the original hinge swing duration
export const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

export type ShutterState = 'open' | 'closing' | 'closed' | 'opening';
export type ExteriorStatus = 'idle' | 'loading' | 'ready' | 'unavailable';

// Pluggable frame clock. The DOM layer passes rAF + performance.now; tests pass a fake one.
export interface FrameClock {
  now(): number;
  raf(cb: (now: number) => void): number;
  // prefers-reduced-motion: the swing then lands on its end pose on the first frame
  reducedMotion(): boolean;
}

export interface ShutterHooks {
  // Everything needed before the wings may start moving. prepareClose is expected to swallow its
  // own painting failures and mark the exterior unavailable; a throw is a last resort and is
  // still treated as degradation, never as a stuck 'closing'.
  prepareClose(): Promise<void>;
  // Paint (or repaint, e.g. after a stroke-view switch) the exterior faces. The machine never
  // calls this while a swing is in flight and never runs two at once.
  paintExterior(): Promise<void>;
  prepareOpen(): Promise<void>;
  // Place the wings for the current p; called on every swing frame and after each repaint.
  place(p: number): void;
  onClosed(): void; // centre panel is covered: stories and the audio focus get blocked
  onOpened(): void; // centre panel visible again: the block is released
}

export class ShutterMachine {
  state: ShutterState = 'open';
  p = 1; // 0 closed .. 1 open
  exterior: ExteriorStatus = 'idle';
  private clock: FrameClock;
  private hooks: ShutterHooks;
  private painting = false; // a paintExterior job is currently running
  private paintWanted = false; // a repaint has been requested and not fully serviced yet
  private swingToken = 0; // a new swing invalidates any stale frame chain
  constructor(clock: FrameClock, hooks: ShutterHooks) {
    this.clock = clock;
    this.hooks = hooks;
  }

  get busy(): boolean { return this.state === 'closing' || this.state === 'opening'; }
  get closed(): boolean { return this.state === 'closed'; }
  // The wings are on the board whenever they are not fully open (a closed triptych, or mid-swing).
  get covering(): boolean { return this.state !== 'open'; }

  // Ignore requests while busy; from 'closed' open, otherwise close. Mirrors the old toggle().
  toggle(): Promise<void> {
    if (this.busy) return Promise.resolve();
    return this.state === 'open' ? this.close() : this.open();
  }

  // Explicit requests carry the same guard: overlapping swings must never be superimposed.
  close(): Promise<void> {
    if (this.busy || this.state === 'closed') return Promise.resolve();
    return this.runClose();
  }

  open(): Promise<void> {
    if (this.busy || this.state === 'open') return Promise.resolve();
    return this.runOpen();
  }

  private async runClose(): Promise<void> {
    this.state = 'closing';
    try {
      await this.hooks.prepareClose();
    } catch (err) {
      // Exterior data missing or failed: degrade to plain backs but still finish the close,
      // so the triptych never jams with the wings half swung.
      this.exterior = 'unavailable';
      this.reportFailure(err);
    }
    await this.swing(1, 0);
    this.state = 'closed'; // leave busy before servicing a repaint queued by a mid-swing switch
    this.hooks.onClosed();
    this.drainRepaint();
  }

  private async runOpen(): Promise<void> {
    this.state = 'opening';
    try {
      await this.hooks.prepareOpen();
      await this.swing(0, 1);
    } catch (err) {
      this.reportFailure(err);
    } finally {
      // Whatever happens, release the swing lock and end in a consistent resting state.
      if (this.state === 'opening') {
        this.p = 1;
        this.state = 'open'; // leave busy before servicing a repaint queued mid-swing
        this.hooks.place(this.p);
        this.hooks.onOpened();
        this.drainRepaint();
      }
    }
  }

  // Stroke-view switch (or any other exterior repaint). While a swing runs or another paint is in
  // flight the request is recorded and serviced at rest, so repainting can never reset a canvas
  // mid-frame, race the wing captures, or move p. At rest it paints straight away.
  repaint(): Promise<void> {
    this.paintWanted = true;
    if (this.busy || this.painting) return Promise.resolve();
    return this.drainRepaint();
  }

  // Service the outstanding repaint. The "wanted" mark is captured and cleared up front; if a new
  // repaint() arrives while the paint is awaited, it sets the mark again and we loop, so an
  // in-flight request can never be lost. Rapid toggles coalesce into one extra fresh paint.
  private async drainRepaint(): Promise<void> {
    if (this.painting || this.busy || !this.paintWanted) return;
    this.paintWanted = false;
    this.painting = true;
    try {
      await this.hooks.paintExterior();
      if (this.exterior !== 'unavailable') this.exterior = 'ready';
      this.hooks.place(this.p); // same p: the angle cannot jump, only the face pixels change
    } catch (err) {
      this.exterior = 'unavailable';
      this.reportFailure(err);
    } finally {
      this.painting = false;
    }
    // A switch that landed during the await (or while this continuation was queued) is served now.
    if (this.paintWanted && !this.busy) void this.drainRepaint();
  }

  // One hinge swing from -> to over SWING_MS, with the preserved cubic ease. Resolves at p === to.
  private swing(from: number, to: number): Promise<void> {
    const token = ++this.swingToken;
    this.p = from;
    return new Promise<void>((resolve) => {
      const t0 = this.clock.now();
      const tick = (now: number) => {
        if (token !== this.swingToken) { resolve(); return; } // superseded: do not touch p
        const u = this.clock.reducedMotion() ? 1 : Math.min(1, (now - t0) / SWING_MS);
        this.p = from + (to - from) * u;
        this.hooks.place(this.p);
        if (u < 1) this.clock.raf(tick);
        else { this.p = to; resolve(); }
      };
      this.clock.raf(tick);
    });
  }

  private reportFailure(err: unknown): void {
    // Observable in the console and in tests; the app keeps running on plain backs.
    console.warn('[shutters] exterior unavailable, showing plain backs:', err);
  }
}
