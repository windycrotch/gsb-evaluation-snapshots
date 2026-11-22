import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

interface MockHowlInstance {
  play: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
  volume: ReturnType<typeof vi.fn>;
  rate: ReturnType<typeof vi.fn>;
  loop: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  off: ReturnType<typeof vi.fn>;
  once: ReturnType<typeof vi.fn>;
  state: ReturnType<typeof vi.fn>;
  playing: ReturnType<typeof vi.fn>;
  unload: ReturnType<typeof vi.fn>;
}

function makeHowlInstance(): MockHowlInstance {
  const instance: MockHowlInstance = {
    play: vi.fn().mockReturnValue(1),
    stop: vi.fn(),
    pause: vi.fn(),
    volume: vi.fn(),
    rate: vi.fn(),
    loop: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    once: vi.fn(),
    state: vi.fn().mockReturnValue('loaded'),
    playing: vi.fn().mockReturnValue(false),
    unload: vi.fn(),
  };
  // Simulate the browser load outcome when the runtime registers its listener: a failed Howl
  // fires "loaderror", a healthy one fires "load", each on the next microtask like real Howler.
  instance.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
    if (event === 'loaderror' && failNextLoad) {
      queueMicrotask(() => cb(null, 'load failed'));
    } else if (event === 'load' && !failNextLoad) {
      queueMicrotask(() => cb());
    }
    return instance;
  });
  return instance;
}

const instances: MockHowlInstance[] = [];
let failNextLoad = false;

vi.mock('howler', () => {
  function Howl(this: MockHowlInstance) {
    const instance = makeHowlInstance();
    instances.push(instance);
    return instance;
  }
  return { Howl: vi.fn(Howl), Howler: { ctx: { state: 'running' }, noAudio: false } };
});

import {
  claimPlayer,
  playSound,
  registerSounds,
  resolveSoundUrl,
  __resetForTesting,
} from '../../src/runtime';
import { Howl } from 'howler';
import type { SoundPack } from '../../src/packs';

const blob = new Blob(['audio'], { type: 'audio/mpeg' });

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({ ok: true, status: 200, blob: () => Promise.resolve(blob), headers: new Headers() })
  );
}

const packV1: SoundPack = {
  name: 'ui-pack',
  baseUrl: 'https://cdn.example.com/v1',
  sounds: { click: { src: 'click.mp3' } },
};
const packV2: SoundPack = {
  name: 'ui-pack',
  baseUrl: 'https://cdn.example.com/v2',
  sounds: { click: { src: 'click.mp3' } },
};

beforeEach(() => {
  instances.length = 0;
  failNextLoad = false;
  vi.mocked(Howl).mockClear();
  localStorage.clear();
  __resetForTesting();
  stubFetch();
  vi.stubGlobal('URL', { ...URL, createObjectURL: vi.fn(() => `blob:${instances.length}`), revokeObjectURL: vi.fn() });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('goal 1: concurrent sharing and reference counting', () => {
  it('concurrent claims create one Howl and share it, each caller holding its own reference', async () => {
    const [a, b, c] = await Promise.all([
      claimPlayer('ui/toggle_on'),
      claimPlayer('ui/toggle_on'),
      claimPlayer('ui/toggle_on'),
    ]);

    expect(Howl).toHaveBeenCalledTimes(1);
    expect(a.howl).toBe(b.howl);
    expect(b.howl).toBe(c.howl);

    // Releasing two references keeps the player alive
    a.release();
    b.release();
    expect(instances[0].unload).not.toHaveBeenCalled();
    expect(URL.revokeObjectURL).not.toHaveBeenCalled();

    // The last reference unloads the Howl and revokes the object URL
    c.release();
    expect(instances[0].unload).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('release is idempotent so a double stop/unmount cannot corrupt the count', async () => {
    const player = await claimPlayer('ui/toggle_on');
    player.release();
    player.release();

    expect(instances[0].unload).toHaveBeenCalledTimes(1);
  });

  it('keeps a playing player alive while a reference is held, then unloads it on natural end', async () => {
    const player = await claimPlayer('ui/toggle_on');
    instances[0].playing.mockReturnValue(true);

    // The hook keeps its reference for the whole duration of playback; releasing a *different*
    // caller's reference must not unload the still-playing shared Howl.
    const otherCaller = await claimPlayer('ui/toggle_on');
    otherCaller.release();
    expect(instances[0].unload).not.toHaveBeenCalled();

    // Playback finishes: the hook's end handler releases its reference, after which cleanup runs
    instances[0].playing.mockReturnValue(false);
    player.release();
    expect(instances[0].unload).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);
  });

  it('two components each stop independently; only the last unloads the shared player', async () => {
    const componentA = await claimPlayer('ui/toggle_on');
    const componentB = await claimPlayer('ui/toggle_on');

    componentA.release(); // component A stops/unmounts
    expect(instances[0].unload).not.toHaveBeenCalled();

    componentB.release(); // component B stops/unmounts
    expect(instances[0].unload).toHaveBeenCalledTimes(1);
  });
});

describe('goal 2: pack updates switch new plays to the new URL without killing old players', () => {
  it('keeps the old player playing while new claims load the updated URL', async () => {
    registerSounds(packV1);
    const oldPlayer = await claimPlayer('ui-pack/click');
    expect(resolveSoundUrl('ui-pack/click')).toBe('https://cdn.example.com/v1/click.mp3');
    const oldHowl = oldPlayer.howl;

    registerSounds(packV2);
    expect(resolveSoundUrl('ui-pack/click')).toBe('https://cdn.example.com/v2/click.mp3');

    // The old player is not current anymore but is still alive and was not unloaded
    expect(oldPlayer.isCurrent()).toBe(false);
    expect(oldHowl.unload).not.toHaveBeenCalled();

    const newPlayer = await claimPlayer('ui-pack/click');
    expect(Howl).toHaveBeenCalledTimes(2);
    expect(newPlayer.howl).not.toBe(oldHowl);
    expect(newPlayer.isCurrent()).toBe(true);

    // The new Howl is backed by a freshly fetched blob/object URL
    const newSrc = vi.mocked(Howl).mock.calls[1][0].src[0];
    expect(newSrc).toBe('blob:1');

    // Releasing the new player leaves the old one untouched, and vice versa
    newPlayer.release();
    expect(newPlayer.howl.unload).toHaveBeenCalledTimes(1);
    expect(oldHowl.unload).not.toHaveBeenCalled();

    oldPlayer.release();
    expect(oldHowl.unload).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(2);
  });

  it('an in-flight claim racing a pack update resolves to the new generation', async () => {
    registerSounds(packV1);
    const okResponse = { ok: true, status: 200, blob: () => Promise.resolve(blob), headers: new Headers() };
    let holdV1 = true;
    let resolveV1: (r: typeof okResponse) => void = () => {};
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      // Local HEAD probe fails instantly (the 300ms AbortController path is avoided)
      if (url.startsWith('/sounds/')) return Promise.reject(new TypeError('local missing'));
      // The v1 GET is held open; everything after the update (the v2 re-fetch) resolves at once
      if (!holdV1) return Promise.resolve(okResponse);
      return new Promise((resolve) => {
        resolveV1 = resolve;
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    const claim = claimPlayer('ui-pack/click');
    // Let the claim run past the local probe and park on the v1 pack GET
    await vi.waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('https://cdn.example.com/v1/click.mp3');
    });

    // The pack update lands while the v1 GET is still in flight
    registerSounds(packV2);
    holdV1 = false;
    resolveV1(okResponse); // release the stale GET; the build fences and re-fetches v2

    const player = await claim;
    expect(player.isCurrent()).toBe(true);
    // Only one Howl exists — the stale build was discarded before construction
    expect(Howl).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://cdn.example.com/v2/click.mp3');
    player.release();
  });

  it('refetches the blob after the URL changes instead of reusing the stale cache', async () => {
    const fetchMock = vi.fn().mockImplementation((url: string) => {
      // The local-path HEAD probe misses; pack GETs succeed
      if (url.startsWith('/sounds/')) {
        return Promise.resolve({ ok: false, status: 404, headers: new Headers() });
      }
      return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(blob), headers: new Headers() });
    });
    vi.stubGlobal('fetch', fetchMock);

    registerSounds(packV1);
    const first = await claimPlayer('ui-pack/click');
    first.release();

    registerSounds(packV2);
    await claimPlayer('ui-pack/click');

    const fetchedUrls = fetchMock.mock.calls.map(([url]) => url as string);
    expect(fetchedUrls).toContain('https://cdn.example.com/v1/click.mp3');
    expect(fetchedUrls).toContain('https://cdn.example.com/v2/click.mp3');
  });
});

describe('goal 3: promise settlement, replay and load-failure cleanup', () => {
  it('playSound resolves on natural end and again on stop, and can replay afterwards', async () => {
    const play = playSound('ui/toggle_on');
    await vi.waitFor(() => expect(instances[0].play).toHaveBeenCalled());

    const endListener = instances[0].on.mock.calls.find(([event]) => event === 'end')?.[1] as () => void;
    endListener();
    await expect(play).resolves.toBeUndefined();
    expect(instances[0].unload).toHaveBeenCalledTimes(1); // reference released after end

    // Replay builds a fresh player
    const replay = playSound('ui/toggle_on');
    await vi.waitFor(() => expect(instances[1].play).toHaveBeenCalled());
    const stopListener = instances[1].on.mock.calls.find(([event]) => event === 'stop')?.[1] as () => void;
    stopListener();
    await expect(replay).resolves.toBeUndefined();
  });

  it('rejects when the Howl fails to load and leaves no cached entry behind', async () => {
    failNextLoad = true;
    const player = await claimPlayer('ui/toggle_on');

    // The failure surfaces through ready (which play() awaits), not through the claim itself
    await expect(player.ready).rejects.toThrow(/Failed to load sound/);

    // The dead Howl was unloaded and its object URL revoked
    expect(instances[0].unload).toHaveBeenCalledTimes(1);
    expect(URL.revokeObjectURL).toHaveBeenCalledTimes(1);

    // The next claim retries and succeeds with a brand new Howl
    const retry = await claimPlayer('ui/toggle_on');
    expect(Howl).toHaveBeenCalledTimes(2);
    expect(retry.howl).toBe(instances[1]);
    retry.release();
  });

  it('a failed blob fetch removes its rejected cache entry so the next play retries', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new TypeError('network down')));
    vi.spyOn(console, 'warn').mockImplementation(() => {});

    await expect(playSound('https://other.example.com/a.mp3')).rejects.toThrow(/CORS/);

    // Retry with a working fetch: no half-initialized entry blocks it
    stubFetch();
    const retry = playSound('https://other.example.com/a.mp3');
    await vi.waitFor(() => expect(instances[0].play).toHaveBeenCalled());
    const endListener = instances[0].on.mock.calls.find(([event]) => event === 'end')?.[1] as () => void;
    endListener();
    await expect(retry).resolves.toBeUndefined();
  });

  it('looped plays share one Web Audio player and settle when stopped', async () => {
    const loopA = await claimPlayer('ui/toggle_on', { loop: true });
    const loopB = await claimPlayer('ui/toggle_on', { loop: true });
    expect(loopA.howl).toBe(loopB.howl);
    expect(vi.mocked(Howl).mock.calls[0][0].html5).toBe(false);
    const loopHowl = instances[0];

    loopA.release();
    expect(loopHowl.unload).not.toHaveBeenCalled();
    loopB.release();
    expect(loopHowl.unload).toHaveBeenCalledTimes(1);
  });
});
