import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Atmosphere } from '../src/atmosphere.js';

// The Atmosphere's bookkeeping round a renderer that does nothing: what gets
// drawn when there is no loop to draw it. A canvas here is only its numbers.

const { made, FakeRenderer, atStart } = vi.hoisted(() => {
  const made: InstanceType<typeof FakeRenderer>[] = [];
  // whether a renderer is made with its variant already linked (compile on the spot)
  const atStart = { linked: false };
  type Pic = { cloudScale: number; cumulonimbus: string };
  class FakeRenderer {
    available = true;
    ready = false;
    colorSpace = 'srgb';
    rays = 0;
    render = vi.fn();
    prepare = vi.fn();
    dispose = vi.fn();
    // what isSettled answers: flipped by the tests as variants start and land
    linked = atStart.linked;
    isSettled = vi.fn(() => this.available && this.linked && this.pendingPic === null);
    takeGpuTimes = (): { ms: number; pixels: number }[] => [];
    // The picture actually being drawn, and one asked for whose variant is
    // still linking — the same two states the real renderer keeps
    private activePic: Pic;
    private pendingPic: Pic | null = null;
    // test knob: pictures a switch to which needs a variant link, and whether
    // the driver refuses that variant
    needsLinkFor: (p: Pic) => boolean = () => false;
    failsLink = false;
    get cloudScale() { return this.activePic.cloudScale; }
    get cumulonimbus() { return this.activePic.cumulonimbus; }
    requestPicture(p: { cloudScale?: number; cumulonimbus?: string }): 'ready' | 'pending' {
      const want: Pic = {
        cloudScale: p.cloudScale ?? this.pendingPic?.cloudScale ?? this.activePic.cloudScale,
        cumulonimbus: p.cumulonimbus ?? this.pendingPic?.cumulonimbus ?? this.activePic.cumulonimbus,
      };
      if (want.cloudScale === this.activePic.cloudScale && want.cumulonimbus === this.activePic.cumulonimbus) {
        this.pendingPic = null;
        return 'ready';
      }
      this.pendingPic = want;
      if (this.failsLink || !this.needsLinkFor(want)) {
        // refused variants commit too (the feature then draws without), and a
        // picture needing no new variant commits on the spot
        this.activePic = want;
        this.pendingPic = null;
        return 'ready';
      }
      return 'pending';
    }
    /** the test driving a variant link to completion */
    linkPending(): boolean {
      if (!this.pendingPic) return false;
      this.activePic = this.pendingPic;
      this.pendingPic = null;
      this.linked = true;
      this.opts.onPictureCommitted?.();
      return true;
    }
    get pending(): boolean { return this.pendingPic !== null; }
    readonly canvas: HTMLCanvasElement;
    readonly opts: {
      onReady?: (available: boolean) => void;
      onLinked?: () => void;
      onPictureCommitted?: () => void;
    };
    constructor(canvas: HTMLCanvasElement, opts: FakeRenderer['opts'] & {
      cloudScale?: number; cumulonimbus?: string;
    }) {
      this.canvas = canvas;
      this.opts = opts;
      this.activePic = { cloudScale: opts.cloudScale ?? 1, cumulonimbus: opts.cumulonimbus ?? 'auto' };
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
});

describe('an atomic quality switch', () => {
  let tick: (t: number) => void;
  let now = 0;
  const frame = () => tick((now += 100));

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => { tick = f; return 1; });
  });
  /** a picture the renderer must link a variant before it can draw */
  const linkNeededFor = (renderer: InstanceType<typeof FakeRenderer>, pic: { cloudScale: number; cumulonimbus: string }) => {
    const prev = renderer.needsLinkFor;
    renderer.needsLinkFor = (p) => prev(p) || (p.cloudScale === pic.cloudScale && p.cumulonimbus === pic.cumulonimbus);
  };

  it('sets cloudScale and cumulonimbus as one picture, never half-applied', () => {
    const { sky, renderer } = mount({ fps: 60, quality: 'high' });
    linkNeededFor(renderer, { cloudScale: 0.5, cumulonimbus: '2d' });
    sky.quality = 'low';
    // the renderer holds the request pending: the drawn picture is still 'high'
    expect(renderer.pending).toBe(true);
    expect(renderer.cloudScale).toBe(1);
    expect(renderer.cumulonimbus).toBe('auto');
    expect(sky.cloudScale).toBe(1);
    expect(sky.cumulonimbus).toBe('auto');
    expect(sky.quality).toBe('high');
    renderer.linkPending();
    // both flip together, in the same commit
    expect(renderer.cloudScale).toBe(0.5);
    expect(renderer.cumulonimbus).toBe('2d');
    expect(sky.quality).toBe('low');
  });

  it('stays unsettled while the new variant links, then settles and says so', async () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, quality: 'high', onSettled });
    renderer.linked = true;
    renderer.ready = true;
    renderer.opts.onReady?.(true);
    frame();
    expect(onSettled).toHaveBeenLastCalledWith(true);

    linkNeededFor(renderer, { cloudScale: 0.5, cumulonimbus: '2d' });
    sky.quality = 'low';
    expect(sky.settled).toBe(false);
    const waiting = sky.whenSettled();
    // no settled event while the link is in flight
    frame();
    expect(onSettled).toHaveBeenCalledTimes(1);

    renderer.linkPending();
    // with a loop running the new picture is only on the canvas from a frame
    expect(sky.settled).toBe(false);
    frame();
    expect(sky.settled).toBe(true);
    expect(onSettled).toHaveBeenCalledTimes(2);
    expect(onSettled).toHaveBeenLastCalledWith(true);
    await expect(waiting).resolves.toBe(true);
  });

  it('draws the old variant throughout the link and the new one only after', () => {
    const { sky, renderer } = mount({ fps: 60, quality: 'high' });
    linkNeededFor(renderer, { cloudScale: 0.5, cumulonimbus: '2d' });
    renderer.linked = true;
    renderer.ready = true;
    renderer.opts.onReady?.(true);
    frame();
    sky.quality = 'low';
    const before = renderer.render.mock.calls.length;
    frame();
    frame();
    // frames keep being drawn, with the old picture still the active one
    expect(renderer.render.mock.calls.length).toBeGreaterThan(before);
    expect(renderer.cloudScale).toBe(1);
    expect(renderer.cumulonimbus).toBe('auto');
    renderer.linkPending();
    frame();
    expect(renderer.cloudScale).toBe(0.5);
    expect(renderer.cumulonimbus).toBe('2d');
  });

  it('commits a switch that needs no new variant at once, with no settled event', () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, quality: 'high', onSettled });
    renderer.linked = true;
    renderer.ready = true;
    renderer.opts.onReady?.(true);
    frame();
    expect(onSettled).toHaveBeenCalledTimes(1);
    // balanced stays on the one-pass variant and the auto tower: nothing to link
    sky.quality = 'balanced';
    expect(renderer.pending).toBe(false);
    expect(renderer.cloudScale).toBe(0.75);
    expect(renderer.cumulonimbus).toBe('auto');
    expect(sky.quality).toBe('balanced');
    expect(sky.settled).toBe(true);
    frame();
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('reads the individual setters back through the same atomic path', () => {
    const { sky, renderer } = mount({ fps: 60, quality: 'high' });
    linkNeededFor(renderer, { cloudScale: 0.5, cumulonimbus: 'auto' });
    sky.cloudScale = 0.5;
    expect(renderer.pending).toBe(true);
    expect(sky.cloudScale).toBe(1);
    renderer.linkPending();
    expect(sky.cloudScale).toBe(0.5);
    // the pair in effect names no preset: quality must report undefined
    expect(sky.quality).toBeUndefined();

    linkNeededFor(renderer, { cloudScale: 0.5, cumulonimbus: '2d' });
    sky.cumulonimbus = '2d';
    expect(renderer.pending).toBe(true);
    expect(sky.cumulonimbus).toBe('auto');
    renderer.linkPending();
    expect(sky.cumulonimbus).toBe('2d');
    expect(sky.quality).toBe('low');
  });

  it('replaces a pending request rather than waiting on an abandoned variant', () => {
    const { sky, renderer } = mount({ fps: 60, quality: 'high' });
    linkNeededFor(renderer, { cloudScale: 0.5, cumulonimbus: '2d' });
    linkNeededFor(renderer, { cloudScale: 0.75, cumulonimbus: 'auto' });
    sky.quality = 'low';
    expect(renderer.pending).toBe(true);
    // chain straight to balanced before the low variant ever lands
    sky.quality = 'balanced';
    renderer.linkPending();
    expect(sky.quality).toBe('balanced');
    expect(renderer.cloudScale).toBe(0.75);
    expect(renderer.cumulonimbus).toBe('auto');
  });

  it('a request back to the picture in effect cancels the pending one', () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, quality: 'high', onSettled });
    renderer.linked = true;
    renderer.ready = true;
    renderer.opts.onReady?.(true);
    frame();
    linkNeededFor(renderer, { cloudScale: 0.5, cumulonimbus: '2d' });
    sky.quality = 'low';
    expect(renderer.pending).toBe(true);
    expect(sky.settled).toBe(false);
    // back to high before the low variant lands: nothing left to wait for
    sky.quality = 'high';
    expect(renderer.pending).toBe(false);
    expect(sky.quality).toBe('high');
    // with a loop scheduled the announcement lands on the next frame
    expect(sky.settled).toBe(false);
    frame();
    expect(sky.settled).toBe(true);
    expect(onSettled).toHaveBeenLastCalledWith(true);
  });

  it('an individual setter carries the other setting of the active picture', () => {
    const { sky, renderer } = mount({ fps: 60, quality: 'low' });
    expect(renderer.cloudScale).toBe(0.5);
    expect(renderer.cumulonimbus).toBe('2d');
    linkNeededFor(renderer, { cloudScale: 0.5, cumulonimbus: 'volumetric' });
    sky.cumulonimbus = 'volumetric';
    // the pending picture keeps low's cloud scale rather than resetting it
    expect(renderer.pending).toBe(true);
    expect(renderer.cloudScale).toBe(0.5);
    renderer.linkPending();
    expect(renderer.cloudScale).toBe(0.5);
    expect(renderer.cumulonimbus).toBe('volumetric');
    expect(sky.quality).toBeUndefined();
  });

  it('commits even when the variant the driver refused never links', async () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, quality: 'high', onSettled });
    renderer.linked = true;
    renderer.ready = true;
    renderer.opts.onReady?.(true);
    frame();
    // the variant the new picture needs is refused by the driver
    renderer.failsLink = true;
    linkNeededFor(renderer, { cloudScale: 0.5, cumulonimbus: '2d' });
    sky.quality = 'low';
    // a refused variant commits: the feature draws without, the sky stays usable
    expect(renderer.pending).toBe(false);
    expect(renderer.cloudScale).toBe(0.5);
    expect(sky.quality).toBe('low');
    expect(sky.settled).toBe(true);
    frame();
    expect(onSettled).toHaveBeenLastCalledWith(true);
    await expect(sky.whenSettled()).resolves.toBe(true);
  });
});

describe('a quality switch on a still frame', () => {
  beforeEach(() => reduceMotion(true));

  it('redraws the still frame once the pending picture commits', () => {
    const { sky, renderer } = mount({ quality: 'high' });
    expect(renderer.render).toHaveBeenCalledTimes(1);
    renderer.needsLinkFor = (p) => p.cloudScale === 0.5 && p.cumulonimbus === '2d';
    sky.quality = 'low';
    // the request still draws the old picture once (its moment, unchanged);
    // the new one cannot appear until the link lands
    expect(sky.quality).toBe('high');
    expect(renderer.cloudScale).toBe(1);
    expect(sky.settled).toBe(false);
    const atSwitch = renderer.render.mock.calls.length;
    renderer.linkPending();
    // the commit redraws the still frame with the new picture, then settles
    expect(renderer.render.mock.calls.length).toBe(atSwitch + 1);
    expect(sky.quality).toBe('low');
    expect(sky.settled).toBe(true);
  });

  it('settles from the commit with no loop to draw the next frame', () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ autoStart: false, quality: 'high', onSettled });
    renderer.needsLinkFor = (p) => p.cloudScale === 0.5 && p.cumulonimbus === '2d';
    sky.quality = 'low';
    renderer.linkPending();
    expect(onSettled).toHaveBeenLastCalledWith(true);
    expect(sky.settled).toBe(true);
  });
});

describe('a quality switch while offscreen', () => {
  let tick: (t: number) => void;
  let seen: ((entries: { isIntersecting: boolean }[]) => void) | null;
  const inDocument = () => ({ ...sized(640, 360), isConnected: true }) as HTMLCanvasElement;
  const view = (isIntersecting: boolean) => seen?.([{ isIntersecting }]);

  beforeEach(() => {
    seen = null;
    vi.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => { tick = f; return 1; });
    vi.stubGlobal('IntersectionObserver', class {
      constructor(f: typeof seen) { seen = f; }
      observe() {}
      disconnect() {}
    });
  });

  it('commits and redraws the new picture on the way back into view', () => {
    const { sky, renderer } = mount({ fps: 60, quality: 'high' }, inDocument());
    renderer.linked = true;
    renderer.ready = true;
    renderer.opts.onReady?.(true);
    tick(100);
    view(false);
    tick(200);
    const drawsWhileOff = renderer.render.mock.calls.length;

    renderer.needsLinkFor = (p) => p.cloudScale === 0.5 && p.cumulonimbus === '2d';
    sky.quality = 'low';
    // the link lands while the canvas is still out of view
    renderer.linkPending();
    expect(sky.quality).toBe('low');
    tick(300);
    expect(renderer.render.mock.calls.length).toBe(drawsWhileOff);   // nothing drawn offscreen

    view(true);
    expect(renderer.render.mock.calls.length).toBe(drawsWhileOff + 1);
    expect(renderer.cloudScale).toBe(0.5);
    expect(renderer.cumulonimbus).toBe('2d');
  });
});

describe('the governor and a quality switch together', () => {
  let tick: (t: number) => void;
  let now = 0;
  const frame = () => tick((now += 100));

  beforeEach(() => {
    vi.stubGlobal('requestAnimationFrame', (f: (t: number) => void) => { tick = f; return 1; });
  });

  it('does not read the picture change as a canvas resize', () => {
    const { sky, canvas, renderer } = mount({ adaptiveResolution: { budget: 12.5 }, quality: 'high' });
    renderer.linked = true;
    renderer.ready = true;
    renderer.opts.onReady?.(true);
    const timesOf = (ms: number) => () => [{ ms, pixels: canvas.width * canvas.height }];
    frame();
    renderer.takeGpuTimes = timesOf(5);
    for (let i = 0; i < 9; i++) frame();
    const sizeBefore = [canvas.width, canvas.height];
    const resolutionBefore = sky.resolution;

    // a switch that commits at once: cheaper picture, but the canvas is untouched
    sky.quality = 'balanced';
    for (let i = 0; i < 9; i++) frame();
    expect([canvas.width, canvas.height]).toEqual(sizeBefore);
    expect(sky.resolution).toBe(resolutionBefore);
  });

  it('restarts its measurements when the pending picture commits, without moving the canvas', () => {
    const { sky, canvas, renderer } = mount({ adaptiveResolution: { budget: 12.5 }, quality: 'high' });
    renderer.linked = true;
    renderer.ready = true;
    renderer.opts.onReady?.(true);
    // report the pixels each frame actually drew, read at harvest time as the
    // real renderer's timer queries do
    const timesOf = (ms: number) => () => [{ ms, pixels: canvas.width * canvas.height }];
    frame();
    renderer.takeGpuTimes = timesOf(5);
    for (let i = 0; i < 9; i++) frame();
    const sizeAtSwitch = [canvas.width, canvas.height];

    renderer.needsLinkFor = (p) => p.cloudScale === 0.5 && p.cumulonimbus === '2d';
    sky.quality = 'low';
    // the old picture's hot frames land while the new one is still linking;
    // held through the switch, they must not resize the canvas under it
    renderer.takeGpuTimes = timesOf(100);
    for (let i = 0; i < 6; i++) frame();
    expect([canvas.width, canvas.height]).toEqual(sizeAtSwitch);

    // the new, lighter picture commits: the history restarts and the held
    // hot measurements of the old picture cannot drag the new size about
    renderer.linkPending();
    frame();
    expect([canvas.width, canvas.height]).toEqual(sizeAtSwitch);
    renderer.takeGpuTimes = timesOf(5);
    for (let i = 0; i < 9; i++) frame();
    expect([canvas.width, canvas.height]).toEqual(sizeAtSwitch);
    expect(sky.resolution).toBe(1);
  });

  it('can never scale the canvas past the configured resolutionScale', () => {
    const { sky, renderer } = mount({ adaptiveResolution: { budget: 1000 }, resolutionScale: 1 });
    renderer.linked = true;
    frame();
    // whatever headroom the budget gives, the factor stays at its ceiling of 1
    expect(sky.resolution).toBeLessThanOrEqual(1);
  });
});

describe('after dispose', () => {
  it('resolves waiting whenSettled with false and never settles again', async () => {
    const onSettled = vi.fn();
    const { sky, renderer } = mount({ fps: 60, onSettled });
    renderer.linked = true;
    renderer.ready = true;
    renderer.opts.onReady?.(true);
    const waiting = sky.whenSettled();
    sky.dispose();
    await expect(waiting).resolves.toBe(false);
    expect(onSettled).not.toHaveBeenCalledWith(true);
    // renderer callbacks arriving after dispose are swallowed
    renderer.opts.onReady?.(true);
    renderer.opts.onLinked?.();
    renderer.opts.onPictureCommitted?.();
    expect(onSettled).toHaveBeenCalledTimes(0);
  });

  it('ignores picture switches and draws nothing more', () => {
    const { sky, renderer } = mount({ fps: 60, quality: 'high' });
    const draws = renderer.render.mock.calls.length;
    sky.dispose();
    sky.quality = 'low';
    sky.cloudScale = 0.5;
    sky.cumulonimbus = '2d';
    sky.jump();
    expect(renderer.render.mock.calls.length).toBe(draws);
    expect(renderer.dispose).toHaveBeenCalledTimes(1);
  });
});

