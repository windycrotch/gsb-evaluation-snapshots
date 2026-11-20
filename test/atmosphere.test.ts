import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Atmosphere } from '../src/atmosphere.js';

// The Atmosphere's bookkeeping round a renderer that does nothing: what gets
// drawn when there is no loop to draw it. A canvas here is only its numbers.

const { made, FakeRenderer, atStart } = vi.hoisted(() => {
  const made: InstanceType<typeof FakeRenderer>[] = [];
  // whether a renderer is made with its variant already linked (compile on the spot)
  const atStart = { linked: false };
  class FakeRenderer {
    available = true;
    ready = false;
    colorSpace = 'srgb';
    cloudScale = 1;
    rays = 0;
    cumulonimbus = 'auto';
    render = vi.fn();
    prepare = vi.fn();
    dispose = vi.fn();
    // what isSettled answers: flipped by the tests as variants start and land
    linked = atStart.linked;
    isSettled = vi.fn(() => this.available && this.linked);
    // a variant the target needs that the driver refused (see variantRefused)
    refused = false;
    variantRefused = vi.fn(() => this.refused);
    takeGpuTimes = (): { ms: number; pixels: number }[] => [];
    readonly canvas: HTMLCanvasElement;
    readonly opts: { onReady?: (available: boolean) => void; onLinked?: () => void };
    constructor(canvas: HTMLCanvasElement, opts: FakeRenderer['opts']) {
      this.canvas = canvas;
      this.opts = opts;
      made.push(this);
    }
    resize(w: number, h: number) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
  }
  return { made, FakeRenderer, atStart };
});

vi.mock('../src/renderer.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/renderer.js')>(),
  AtmosphereRenderer: FakeRenderer,
}));

const sized = (w: number, h: number) =>
  ({ width: 0, height: 0, clientWidth: w, clientHeight: h }) as HTMLCanvasElement;

function mount(options: ConstructorParameters<typeof Atmosphere>[1], canvas = sized(640, 360)) {
  const sky = new Atmosphere(canvas, { resolutionScale: 1, ...options });
  return { sky, canvas, renderer: made[made.length - 1] };
}

function reduceMotion(matches: boolean) {
  vi.stubGlobal('matchMedia', () => ({ matches, addEventListener() {}, removeEventListener() {} }));
}

beforeEach(() => {
  made.length = 0;
  atStart.linked = false;
  vi.stubGlobal('requestAnimationFrame', () => 1);
  vi.stubGlobal('cancelAnimationFrame', () => {});
  reduceMotion(false);
});

afterEach(() => vi.unstubAllGlobals());

it('paints the sunset into the new buffer on the frame that changes resolution', () => {
  const { sky, canvas, renderer } = mount({ adaptiveResolution: true });
  const pixels = canvas.width * canvas.height;
  renderer.takeGpuTimes = () => Array.from({ length: 12 }, () => ({ ms: 100, pixels }));
  let paintedPixels = 0;
  renderer.render.mockImplementation(() => { paintedPixels = canvas.width * canvas.height; });
  sky.jump({ time: 17.8, weather: 'fair', ground: 'sea' });
  expect(canvas.width * canvas.height).toBeLessThan(pixels);
  expect(paintedPixels).toBe(canvas.width * canvas.height);
});

describe('a still frame under reduced motion', () => {
  beforeEach(() => reduceMotion(true));

  it('is drawn again after a resize, which clears the canvas', () => {
    const { sky, canvas, renderer } = mount({});
    expect(renderer.render).toHaveBeenCalledTimes(1);
    (canvas as { clientWidth: number }).clientWidth = 800;
    sky.resize();
    expect(canvas.width).toBe(800);
    expect(renderer.render).toHaveBeenCalledTimes(2);
  });

  it('is not drawn again when the size has not changed', () => {
    const { sky, renderer } = mount({});
    sky.resize();
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });

  it('is the same moment each time, so a redraw moves nothing', () => {
    const { sky, canvas, renderer } = mount({});
    const wind = sky.state.timeOfDay;
    const first = renderer.render.mock.calls[0];
    const windOff = first[3], evo = first[4], time = first[0];
    (canvas as { clientWidth: number }).clientWidth = 800;
    sky.resize();
    const again = renderer.render.mock.calls[1];
    expect(again[0]).toBe(time);
    expect(again[3]).toBe(windOff);
    expect(again[4]).toBe(evo);
    expect(sky.state.timeOfDay).toBe(wind);
  });

  it('is drawn again when the variant it needed has linked', () => {
    const { renderer } = mount({});
    renderer.opts.onLinked?.();
    expect(renderer.render).toHaveBeenCalledTimes(2);
  });
});

describe('a jump() with no loop', () => {
  it('is drawn when the shader comes ready, though start() was never called', () => {
    const { sky, renderer } = mount({ autoStart: false });
    sky.jump();
    expect(renderer.render).toHaveBeenCalledTimes(1);   // too early: this one draws nothing
    renderer.opts.onReady?.(true);
    expect(renderer.render).toHaveBeenCalledTimes(2);
  });

  it('stays up through a resize', () => {
    const { sky, canvas, renderer } = mount({ autoStart: false });
    sky.jump();
    (canvas as { clientHeight: number }).clientHeight = 500;
    sky.resize();
    expect(renderer.render).toHaveBeenCalledTimes(2);
  });

  it('is forgotten by stop()', () => {
    const { sky, canvas, renderer } = mount({ autoStart: false });
    sky.jump();
    sky.stop();
    renderer.opts.onReady?.(true);
    (canvas as { clientWidth: number }).clientWidth = 800;
    sky.resize();
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });
});

describe('with nothing asked for', () => {
  it('draws nothing when the shader comes ready or the canvas resizes', () => {
    const { sky, canvas, renderer } = mount({ autoStart: false });
    renderer.opts.onReady?.(true);
    renderer.opts.onLinked?.();
    (canvas as { clientWidth: number }).clientWidth = 800;
    sky.resize();
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('still tells the caller the shader is ready', () => {
    const onReady = vi.fn();
    const { renderer } = mount({ autoStart: false, onReady });
    renderer.opts.onReady?.(true);
    expect(onReady).toHaveBeenCalledWith(true);
  });
});

describe('a running loop', () => {
  it('is left to its next tick', () => {
    const { sky, canvas, renderer } = mount({});
    sky.jump();
    expect(renderer.render).toHaveBeenCalledTimes(1);
    renderer.opts.onReady?.(true);
    renderer.opts.onLinked?.();
    (canvas as { clientWidth: number }).clientWidth = 800;
    sky.resize();
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });
});

describe('out of view', () => {
  let tick: (t: number) => void;
  let seen: ((entries: { isIntersecting: boolean }[]) => void) | null;
  let watching: boolean;
  const inDocument = () => ({ ...sized(640, 360), isConnected: true }) as HTMLCanvasElement;
  const view = (isIntersecting: boolean) => seen?.([{ isIntersecting }]);

  beforeEach(() => {
    seen = null;
    watching = false;
    vi.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => { tick = f; return 1; });
    vi.stubGlobal('IntersectionObserver', class {
      constructor(f: typeof seen) { seen = f; }
      observe() { watching = true; }
      disconnect() { watching = false; }
    });
  });

  it('draws nothing, and draws again on the way back without waiting for a tick', () => {
    const { renderer } = mount({ fps: 60 }, inDocument());
    tick(100);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    view(false);
    tick(200);
    tick(300);
    expect(renderer.render).toHaveBeenCalledTimes(1);
    view(true);
    expect(renderer.render).toHaveBeenCalledTimes(2);
    tick(400);
    expect(renderer.render).toHaveBeenCalledTimes(3);
  });

  it('goes on with the clocks, so the sky comes back where it would have been', () => {
    const { sky, renderer } = mount({ fps: 60 }, inDocument());
    const before = sky.state;
    tick(1000);
    const evo = renderer.render.mock.calls[0][4];
    view(false);
    for (let t = 1100; t < 3000; t += 100) tick(t);
    view(true);
    expect(renderer.render.mock.calls[1][4]).toBeGreaterThan(evo + 0.05);
    expect(sky.state.timeOfDay).toBeCloseTo(before.timeOfDay);
  });

  it('still draws what it is asked to with no loop running', () => {
    const { sky, renderer } = mount({ autoStart: false }, inDocument());
    view(false);
    sky.jump();
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });

  it('does not draw on the way back with the loop stopped', () => {
    const { sky, renderer } = mount({ autoStart: false }, inDocument());
    sky.start();
    sky.stop();
    view(false);
    view(true);
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('draws on a canvas outside the document, which never intersects anything', () => {
    const { renderer } = mount({ fps: 60 });
    view(false);
    tick(100);
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });

  it('draws on under pauseOffscreen: false, watching nothing', () => {
    const { renderer } = mount({ fps: 60, pauseOffscreen: false }, inDocument());
    expect(watching).toBe(false);
    tick(100);
    expect(renderer.render).toHaveBeenCalledTimes(1);
  });

  it('stops watching when disposed', () => {
    const { sky } = mount({}, inDocument());
    expect(watching).toBe(true);
    sky.dispose();
    expect(watching).toBe(false);
  });
});

describe('settling', () => {
  let tick: (t: number) => void;
  let now = 0;
  const frame = () => tick((now += 100));

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => { tick = f; return 1; });
  });

  /** a set() that needs a variant the renderer has not got */
  const needsNew = (renderer: InstanceType<typeof FakeRenderer>) =>
    renderer.prepare.mockImplementation(() => { renderer.linked = false; });
  /** the variant landing */
  const link = (renderer: InstanceType<typeof FakeRenderer>) => { renderer.linked = true; renderer.opts.onLinked?.(); };

  it('says so once the first variant is in and has been drawn', async () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, onSettled });
    expect(sky.settled).toBe(false);
    renderer.linked = true;
    renderer.ready = true;
    renderer.opts.onReady?.(true);
    // (the loop draws it on its next tick, and says so then)
    expect(onSettled).not.toHaveBeenCalled();
    frame();
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(true);
    expect(sky.settled).toBe(true);
    await expect(sky.whenSettled()).resolves.toBe(true);
    frame();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('goes unsettled on a set() that needs a new variant, and settles again once it is in', async () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, onSettled });
    link(renderer);
    frame();
    expect(onSettled).toHaveBeenCalledTimes(1);

    needsNew(renderer);
    sky.set({ weather: 'rain' });
    expect(sky.settled).toBe(false);
    const waiting = sky.whenSettled();
    frame();
    frame();
    expect(onSettled).toHaveBeenCalledTimes(1);
    link(renderer);
    frame();
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenLastCalledWith(true);
    await expect(waiting).resolves.toBe(true);
  });

  it('says nothing for a set() that needs no new variant', () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, onSettled });
    link(renderer);
    frame();
    sky.set({ time: 15 });
    frame();
    expect(sky.settled).toBe(true);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('settles as soon as the variant lands with no loop to draw it', () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ autoStart: false, onSettled });
    needsNew(renderer);
    sky.set({ weather: 'rain' });
    link(renderer);
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(true);
    expect(renderer.render).not.toHaveBeenCalled();
  });

  it('draws a still frame again before it says so, under reduced motion', () => {
    reduceMotion(true);
    const onSettled = vi.fn(() => expect(renderer.render).toHaveBeenCalledTimes(2));
    const { sky, renderer } = mount({ onSettled });
    expect(renderer.render).toHaveBeenCalledTimes(1);
    link(renderer);
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(sky.settled).toBe(true);
  });

  it('is settled from the start where the shader compiles on the spot', async () => {
    const onSettled = vi.fn();
    atStart.linked = true;
    const { sky } = mount({ autoStart: false, onSettled });
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(true);
    await expect(sky.whenSettled()).resolves.toBe(true);
  });

  it('says false, and lets the waiters go, when the sky will never draw', async () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, onSettled });
    const waiting = sky.whenSettled();
    renderer.available = false;
    renderer.opts.onReady?.(false);
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(false);
    await expect(waiting).resolves.toBe(false);
    await expect(sky.whenSettled()).resolves.toBe(false);
    expect(sky.settled).toBe(false);
  });

  it('lets the waiters go when disposed first', async () => {
    const { sky } = mount({ fps: 60 });
    const waiting = sky.whenSettled();
    sky.dispose();
    await expect(waiting).resolves.toBe(false);
  });

  it('answers false at once to a whenSettled() asked after a dispose', async () => {
    const { sky, renderer } = mount({ fps: 60 });
    sky.dispose();
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
    await expect(sky.whenSettled()).resolves.toBe(false);
    expect(sky.settled).toBe(false);
    // and nothing is drawn for a waiter a dispose() took away
    const before = renderer.render.mock.calls.length;
    renderer.opts.onReady?.(true);
    renderer.opts.onLinked?.();
    expect(renderer.render).toHaveBeenCalledTimes(before);
  });

  it('says false, once, when a variant the target needs is refused by the driver', async () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, onSettled });
    link(renderer);
    frame();
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(true);

    // a set() whose variant the driver cannot link: no frame will ever carry it
    needsNew(renderer);
    renderer.refused = true;
    sky.set({ weather: 'rain' });
    const waiting = sky.whenSettled();
    expect(sky.settled).toBe(false);
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenLastCalledWith(false);
    await expect(waiting).resolves.toBe(false);
    // every later frame is settled-and-refused still, and says nothing more
    frame();
    frame();
    expect(onSettled).toHaveBeenCalledTimes(2);
    await expect(sky.whenSettled()).resolves.toBe(false);

    // a later set() that needs only variants in hand settles again
    renderer.prepare.mockImplementation(() => {});
    renderer.refused = false;
    renderer.linked = true;
    sky.set({ time: 15 });
    frame();
    expect(onSettled).toHaveBeenCalledTimes(3);
    expect(onSettled).toHaveBeenLastCalledWith(true);
    expect(sky.settled).toBe(true);
  });

  it('says nothing more after a settle when the loop is stopped', async () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, onSettled });
    link(renderer);
    renderer.opts.onReady?.(true);
    frame();
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(true);
    // stopping draws nothing for a sky already settled, and says nothing
    const drawn = renderer.render.mock.calls.length;
    sky.stop();
    expect(renderer.render).toHaveBeenCalledTimes(drawn);
    expect(onSettled).toHaveBeenCalledTimes(1);
    // a link landing afterwards draws nothing either
    renderer.opts.onLinked?.();
    expect(renderer.render).toHaveBeenCalledTimes(drawn);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('is not left hanging when the loop is stopped with the link just in', async () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, onSettled });
    link(renderer);
    frame();
    expect(onSettled).toHaveBeenCalledTimes(1);

    needsNew(renderer);
    sky.set({ weather: 'rain' });
    const waiting = sky.whenSettled();
    frame();                          // still linking: the loop draws a stand-in
    renderer.linked = true;           // the link lands between frames
    renderer.opts.onLinked?.();
    // (the tick that was to draw it will not come: stop() draws the one frame
    // that owes the waiter its settle, and says it from that)
    sky.stop();
    await expect(waiting).resolves.toBe(true);
    expect(onSettled).toHaveBeenLastCalledWith(true);
  });
});


// The three ways a sky is driven — a running loop's set(), a still frame's
// jump() with no loop (autoStart: false), and reduced motion's single frame —
// must agree on one readiness lifecycle: unsettled the moment a new variant
// is needed, settled only once it has linked and been drawn, said once per
// settle, and never a waiter left hanging. No fixed delays: every step is
// driven by the fake renderer's link, or by a frame tick.
describe('the readiness lifecycle at its three entry points', () => {
  let tick: (t: number) => void;
  let now = 0;
  const frame = () => tick((now += 100));
  beforeEach(() => {
    now = 0;
    vi.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => { tick = f; return 1; });
  });

  /** the renderer starts needing a variant on every set(), and the next link lands it */
  const needsVariant = (r: InstanceType<typeof FakeRenderer>) => {
    r.linked = false;
  };
  const lands = (r: InstanceType<typeof FakeRenderer>) => {
    r.linked = true;
    r.opts.onLinked?.();
  };

  it('a running loop: unsettled on the set(), settled on the frame after the link, once', async () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, onSettled });
    lands(renderer);
    renderer.ready = true;
    renderer.opts.onReady?.(true);
    frame();
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(true);
    expect(sky.settled).toBe(true);

    needsVariant(renderer);
    sky.set({ weather: 'rain' });
    // not merely "still said": the moment the new variant is needed it is false
    expect(sky.settled).toBe(false);
    const waiting = sky.whenSettled();
    frame();                                   // stand-in draws; still false
    expect(onSettled).toHaveBeenCalledTimes(1);
    lands(renderer);                           // link between frames
    expect(onSettled).toHaveBeenCalledTimes(1); // not said until a frame draws it
    frame();                                   // the frame with it in
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenLastCalledWith(true);
    expect(sky.settled).toBe(true);
    await expect(waiting).resolves.toBe(true);
    // and no more frames say it again
    frame();
    frame();
    expect(onSettled).toHaveBeenCalledTimes(2);
  });

  it('a running loop: a set() needing nothing new draws but says nothing', () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, onSettled });
    lands(renderer);
    renderer.ready = true;
    renderer.opts.onReady?.(true);
    frame();
    expect(onSettled).toHaveBeenCalledTimes(1);
    const drawn = renderer.render.mock.calls.length;
    sky.set({ time: 15 });                     // renderer.linked stays true
    frame();
    frame();
    expect(renderer.render.mock.calls.length).toBe(drawn + 2);  // still drawing
    expect(sky.settled).toBe(true);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('a still frame (jump(), autoStart: false): unsettled at once, settled after a redraw with the variant', () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ autoStart: false, onSettled });
    needsVariant(renderer);
    sky.jump({ weather: 'rain' });
    // drawn once (a stand-in: the variant was linking), and not settled
    expect(renderer.render).toHaveBeenCalledTimes(1);
    expect(sky.settled).toBe(false);
    expect(onSettled).not.toHaveBeenCalled();
    const drawn = renderer.render.mock.calls.length;
    lands(renderer);
    // one redraw with the variant, at the same moment, and only then is it said
    expect(renderer.render).toHaveBeenCalledTimes(drawn + 1);
    const before = renderer.render.mock.calls[drawn - 1];
    const after = renderer.render.mock.calls[drawn];
    expect(after[0]).toBe(before[0]);         // same clock: a redraw, not a step
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(true);
    expect(sky.settled).toBe(true);
    // and asking again draws nothing
    renderer.opts.onLinked?.();
    expect(renderer.render).toHaveBeenCalledTimes(drawn + 1);
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('a still frame: a set() that needs a new variant cuts, then settles when it links', () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ autoStart: false, onSettled });
    lands(renderer);
    renderer.opts.onReady?.(true);
    sky.jump({ time: 14, weather: 'fair' });
    expect(sky.settled).toBe(true);
    expect(onSettled).toHaveBeenCalledTimes(1);

    needsVariant(renderer);
    sky.set({ weather: 'rain' });
    // the still frame took the cut (a stand-in for the linking variant), and
    // is now unsettled until that links
    expect(sky.settled).toBe(false);
    const drawn = renderer.render.mock.calls.length;
    lands(renderer);
    expect(renderer.render).toHaveBeenCalledTimes(drawn + 1);
    expect(sky.settled).toBe(true);
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenLastCalledWith(true);
  });

  it('reduced motion single frame: unsettled on a set(), settled once the variant links and is drawn', () => {
    reduceMotion(true);
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ onSettled });
    // start() under reduced motion draws exactly one frame, as a still
    expect(renderer.render).toHaveBeenCalledTimes(1);
    needsVariant(renderer);
    sky.set({ weather: 'rain' });
    expect(sky.settled).toBe(false);
    expect(renderer.render).toHaveBeenCalledTimes(2);   // the cut, a stand-in
    lands(renderer);
    // the frame it went without is drawn again with it, and it is said
    expect(renderer.render).toHaveBeenCalledTimes(3);
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(true);
    expect(sky.settled).toBe(true);
  });
});

// A new size clears the drawing buffer. A still frame has no next tick to
// fill it, so it is redrawn at the moment it held — and if a variant was
// still linking then, the redraw that lands with it must be the last thing
// on the canvas, with the new feature in it.
describe('a resize that clears the canvas', () => {
  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', () => 1);
  });

  it('redraws a still frame at the same moment, not a step on', () => {
    reduceMotion(true);
    const { sky, canvas, renderer } = mount({});
    const time = renderer.render.mock.calls[0][0];
    const windOff = renderer.render.mock.calls[0][3];
    const tod = sky.state.timeOfDay;
    (canvas as { clientWidth: number }).clientWidth = 800;
    sky.resize();
    const again = renderer.render.mock.calls[1];
    expect(again[0]).toBe(time);       // the same clock: no animation stepped
    expect(again[3]).toBe(windOff);    // and the clouds have not drifted
    expect(sky.state.timeOfDay).toBe(tod);
  });

  it('redraws after the variant links, so the final frame has the new variant', () => {
    const { sky, canvas, renderer } = mount({ autoStart: false });
    renderer.linked = false;           // the jump() needed a variant still linking
    sky.jump({ weather: 'rain' });
    renderer.opts.onReady?.(true);
    const afterJump = renderer.render.mock.calls.length;
    // the size changes while the variant is still linking: the redraw stands
    // in, and the canvas is cleared of it and filled again
    (canvas as { clientHeight: number }).clientHeight = 500;
    sky.resize();
    expect(renderer.render).toHaveBeenCalledTimes(afterJump + 1);
    expect(sky.settled).toBe(false);
    // and when it links, one more redraw — the last, with the variant in it
    renderer.linked = true;
    renderer.opts.onLinked?.();
    expect(renderer.render).toHaveBeenCalledTimes(afterJump + 2);
    expect(sky.settled).toBe(true);
  });

  it('under adaptive resolution, the frame that changes size is filled at the new size', () => {
    // the governor's timing needs a frame's worth of samples before it acts
    const { sky, canvas, renderer } = mount({ adaptiveResolution: true });
    const pixels = canvas.width * canvas.height;
    renderer.takeGpuTimes = () => Array.from({ length: 12 }, () => ({ ms: 100, pixels }));
    let painted = 0;
    renderer.render.mockImplementation(() => { painted = canvas.width * canvas.height; });
    sky.jump({ time: 17.8, weather: 'fair', ground: 'sea' });
    expect(canvas.width * canvas.height).toBeLessThan(pixels);
    // the buffer was not left holding the old size's picture
    expect(painted).toBe(canvas.width * canvas.height);
  });
});

// Failures and interleavings: a compile that is refused, a link that lands
// between frames with the loop taken away, two sets racing, a dispose in the
// middle. Every waiter must end — true when it settles, false when it cannot.
describe('failures and interleavings do not hang a waiter', () => {
  let tick: (t: number) => void;
  let now = 0;
  const frame = () => tick((now += 100));
  beforeEach(() => {
    now = 0;
    vi.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => { tick = f; return 1; });
  });
  const lands = (r: InstanceType<typeof FakeRenderer>) => { r.linked = true; r.opts.onLinked?.(); };

  it('a compile that fails outright ends the waiter with false', async () => {
    const { sky, renderer } = mount({ fps: 60 });
    const waiting = sky.whenSettled();
    renderer.available = false;
    renderer.opts.onReady?.(false);
    await expect(waiting).resolves.toBe(false);
  });

  it('a variant refused mid-flight ends the waiter with false, not a hang', async () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, onSettled });
    lands(renderer);
    renderer.opts.onReady?.(true);
    frame();
    renderer.linked = false;
    renderer.refused = true;
    sky.set({ weather: 'rain' });
    const waiting = sky.whenSettled();
    frame();
    await expect(waiting).resolves.toBe(false);
    expect(onSettled).toHaveBeenLastCalledWith(false);
    expect(sky.settled).toBe(false);
  });

  it('two sets in a row: each links, no duplicate settle, one waiter answered once', async () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, onSettled });
    lands(renderer);
    renderer.opts.onReady?.(true);
    frame();
    expect(onSettled).toHaveBeenCalledTimes(1);
    renderer.linked = false;
    sky.set({ weather: 'rain' });
    const waiting = sky.whenSettled();
    sky.set({ weather: 'snow' });      // a second set while the first still links
    frame();
    expect(onSettled).toHaveBeenCalledTimes(1);
    lands(renderer);
    frame();
    expect(onSettled).toHaveBeenCalledTimes(2);
    await expect(waiting).resolves.toBe(true);
    frame();
    expect(onSettled).toHaveBeenCalledTimes(2);
  });

  it('a dispose while the variant links ends the waiter with false, and draws nothing', async () => {
    const { sky, renderer } = mount({ fps: 60 });
    lands(renderer);
    renderer.opts.onReady?.(true);
    frame();
    renderer.linked = false;
    sky.set({ weather: 'rain' });
    const waiting = sky.whenSettled();
    frame();
    const drawn = renderer.render.mock.calls.length;
    sky.dispose();
    await expect(waiting).resolves.toBe(false);
    // the link that lands afterwards neither draws nor resurrects the sky
    lands(renderer);
    expect(renderer.render).toHaveBeenCalledTimes(drawn);
    await expect(sky.whenSettled()).resolves.toBe(false);
  });

  it('a canvas left out of view when the link lands is drawn for the waiter, at once', async () => {
    let seen: ((entries: { isIntersecting: boolean }[]) => void) | null = null;
    vi.stubGlobal('IntersectionObserver', class {
      constructor(f: typeof seen) { seen = f; }
      observe() {}
      disconnect() {}
    });
    const doc = { ...sized(640, 360), isConnected: true } as HTMLCanvasElement;
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, onSettled }, doc);
    lands(renderer);
    renderer.opts.onReady?.(true);
    frame();
    seen!([{ isIntersecting: false }]);
    renderer.linked = false;
    sky.set({ weather: 'rain' });
    const waiting = sky.whenSettled();
    frame();                                    // out of view: not drawn
    expect(renderer.render).toHaveBeenCalledTimes(1);
    lands(renderer);                            // the link lands between frames
    frame();                                    // the loop leaves it undrawn again...
    // ...but a waiter was owed a frame, so one was drawn for it, and it settled
    await expect(waiting).resolves.toBe(true);
    expect(renderer.render).toHaveBeenCalledTimes(2);
  });

  it('a set() that lands a new variant between the link and the frame keeps the waiters honest', async () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, onSettled });
    lands(renderer);
    renderer.opts.onReady?.(true);
    frame();
    expect(onSettled).toHaveBeenCalledTimes(1);
    // rain needs a variant; before its frame is drawn, snow adds another
    renderer.linked = false;
    sky.set({ weather: 'rain' });
    const waiting = sky.whenSettled();
    renderer.linked = true;                    // the rain variant lands, no frame yet
    renderer.opts.onLinked?.();
    renderer.linked = false;                   // snow's own variant starts linking
    sky.set({ weather: 'snow' });
    frame();
    // the rain link was not the settle: snow still needs its variant
    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(sky.settled).toBe(false);
    lands(renderer);
    frame();
    expect(onSettled).toHaveBeenCalledTimes(2);
    await expect(waiting).resolves.toBe(true);
  });

  it('a link landing during a draw does not draw re-entrantly, and settles from the frame', () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, onSettled });
    // the first render (compile on the spot) links the variant within the draw
    renderer.render.mockImplementation(() => { if (!renderer.linked) lands(renderer); });
    renderer.ready = true;
    renderer.opts.onReady?.(true);
    frame();
    expect(renderer.render).toHaveBeenCalledTimes(1);   // no re-entrant redraw
    expect(onSettled).toHaveBeenCalledExactlyOnceWith(true);
    expect(sky.settled).toBe(true);
  });
});
