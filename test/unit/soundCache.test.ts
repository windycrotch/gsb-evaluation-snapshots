import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';

vi.mock('howler', async () => {
  const { createMockHowl } = await import('./mocks');
  return {
    // A regular function so `new Howl(...)` works (arrow functions are not constructable).
    Howl: vi.fn(function (this: unknown) {
      return createMockHowl();
    }),
    Howler: { ctx: { state: 'running' }, noAudio: false },
  };
});

import { Howl } from 'howler';
import {
  claimSound,
  fetchSoundBlob,
  freeSound,
  getSoundCacheState,
  setCDNUrl,
  __resetForTesting,
} from '../../src/runtime';

function audioResponse(blob: Blob) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => 'audio/mpeg' },
    blob: () => Promise.resolve(blob),
  };
}

function notFoundResponse() {
  return {
    ok: false,
    status: 404,
    headers: { get: () => 'text/html' },
    blob: () => Promise.resolve(new Blob(['not found'], { type: 'text/html' })),
  };
}

let objectUrlCounter = 0;
const createObjectURLMock = vi.fn(() => `blob:mock-${++objectUrlCounter}`);
const revokeObjectURLMock = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  __resetForTesting();
  objectUrlCounter = 0;
  createObjectURLMock.mockImplementation(() => `blob:mock-${++objectUrlCounter}`);
  (URL as any).createObjectURL = createObjectURLMock;
  (URL as any).revokeObjectURL = revokeObjectURLMock;
  setCDNUrl('https://cdn.example.com/v1');
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('local-first probing', () => {
  it('does not request the CDN when the local probe succeeds', async () => {
    const blob = new Blob(['audio'], { type: 'audio/mpeg' });
    const mockFetch = vi
      .fn()
      // HEAD probe for the local file
      .mockResolvedValueOnce(audioResponse(blob))
      // GET of the local file
      .mockResolvedValueOnce(audioResponse(blob));
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchSoundBlob('ui/toggle_on');

    expect(result).toBe(blob);
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const urls = mockFetch.mock.calls.map((call) => call[0]);
    expect(urls).toEqual(['/sounds/ui/toggle_on.mp3', '/sounds/ui/toggle_on.mp3']);
    expect(urls.some((url) => String(url).includes('cdn.example.com'))).toBe(false);
  });

  it('falls back to the CDN when the local probe returns 404', async () => {
    const cdnBlob = new Blob(['cdn audio'], { type: 'audio/mpeg' });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(notFoundResponse())
      .mockResolvedValueOnce(audioResponse(cdnBlob));
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchSoundBlob('ui/toggle_on');

    expect(result).toBe(cdnBlob);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(String(mockFetch.mock.calls[0][0])).toBe('/sounds/ui/toggle_on.mp3');
    expect(String(mockFetch.mock.calls[1][0])).toContain('cdn.example.com');
    expect(String(mockFetch.mock.calls[1][0])).toContain('ui/toggle_on');
  });

  it('falls back to the CDN when the local probe has a non-audio content type', async () => {
    const cdnBlob = new Blob(['cdn audio'], { type: 'audio/mpeg' });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: { get: () => 'text/html' },
      })
      .mockResolvedValueOnce(audioResponse(cdnBlob));
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchSoundBlob('ui/toggle_on');

    expect(result).toBe(cdnBlob);
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(String(mockFetch.mock.calls[1][0])).toContain('cdn.example.com');
  });

  it('falls back to the CDN when the local probe times out', async () => {
    const cdnBlob = new Blob(['cdn audio'], { type: 'audio/mpeg' });
    const mockFetch = vi.fn((url: string, init?: { signal?: AbortSignal }) => {
      if (String(url).startsWith('/sounds/')) {
        // Never resolves on its own; only rejects when the probe times out.
        return new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
      return Promise.resolve(audioResponse(cdnBlob));
    });
    vi.stubGlobal('fetch', mockFetch);

    const result = await fetchSoundBlob('ui/toggle_on');

    expect(result).toBe(cdnBlob);
    expect(String(mockFetch.mock.calls[1][0])).toContain('cdn.example.com');
  });
});

describe('unknown sound errors', () => {
  it('reports both the sound name and the local/CDN unavailability', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal(
      'fetch',
      vi.fn().mockImplementation(() =>
        Promise.resolve({
          ok: false,
          status: 404,
          headers: { get: () => 'text/html' },
        })
      )
    );

    const error = await fetchSoundBlob('my-custom-sound-xyz').catch((err: Error) => err);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain('my-custom-sound-xyz');
    expect(message).toContain('本地/CDN 均不可用');
  });
});

describe('reference counting', () => {
  it('creates one Howl and one blob request for concurrent claims', async () => {
    const blob = new Blob(['audio'], { type: 'audio/mpeg' });
    const mockFetch = vi
      .fn()
      .mockResolvedValueOnce(audioResponse(blob))
      .mockResolvedValueOnce(audioResponse(blob));
    vi.stubGlobal('fetch', mockFetch);

    const [first, second] = await Promise.all([
      claimSound('ui/toggle_on'),
      claimSound('ui/toggle_on'),
    ]);

    expect(first).toBe(second);
    expect(Howl).toHaveBeenCalledTimes(1);
    // One HEAD probe + one blob GET, shared between both claims.
    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(createObjectURLMock).toHaveBeenCalledTimes(1);

    const state = getSoundCacheState('ui/toggle_on');
    expect(state.hasHowl).toBe(true);
    expect(state.subscriptions).toBe(2);
    expect(state.hasBlob).toBe(true);
    expect(state.isPlaying).toBe(false);
  });

  it('reaches zero subscriptions and unloads the instance after balanced frees', async () => {
    const blob = new Blob(['audio'], { type: 'audio/mpeg' });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(audioResponse(blob))
        .mockResolvedValueOnce(audioResponse(blob))
    );

    const howl = await claimSound('ui/toggle_on');
    await claimSound('ui/toggle_on');
    expect(getSoundCacheState('ui/toggle_on').subscriptions).toBe(2);

    freeSound('ui/toggle_on');
    expect(getSoundCacheState('ui/toggle_on').subscriptions).toBe(1);
    expect(getSoundCacheState('ui/toggle_on').hasHowl).toBe(true);
    expect(howl.unload).not.toHaveBeenCalled();

    freeSound('ui/toggle_on');
    const state = getSoundCacheState('ui/toggle_on');
    expect(state.subscriptions).toBe(0);
    expect(state.hasHowl).toBe(false);
    expect(howl.unload).toHaveBeenCalledTimes(1);
    expect(revokeObjectURLMock).toHaveBeenCalledTimes(1);
  });

  it('never lets subscriptions go negative when freeing more than claimed', async () => {
    const blob = new Blob(['audio'], { type: 'audio/mpeg' });
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(audioResponse(blob))
        .mockResolvedValueOnce(audioResponse(blob))
    );

    const howl = await claimSound('ui/toggle_on');
    expect(getSoundCacheState('ui/toggle_on').subscriptions).toBe(1);

    freeSound('ui/toggle_on');
    freeSound('ui/toggle_on');
    freeSound('ui/toggle_on');

    const state = getSoundCacheState('ui/toggle_on');
    expect(state.subscriptions).toBe(0);
    expect(state.hasHowl).toBe(false);
    expect(howl.unload).toHaveBeenCalledTimes(1);
  });
});
