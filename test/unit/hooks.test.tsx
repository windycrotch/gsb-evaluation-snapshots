import { vi, describe, it, expect, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { createMockHowl, createMockPlayer } from './mocks';

vi.mock('../../src/runtime', async () => {
  const { createRuntimeMock } = await import('./mocks');
  return createRuntimeMock();
});

import { useSound, useSoundEnabled, useSoundOnChange } from '../../src/hooks';
import { claimPlayer, isSoundEnabled } from '../../src/runtime';

let mockHowl: ReturnType<typeof createMockHowl>;
let mockPlayer: ReturnType<typeof createMockPlayer>;

beforeEach(() => {
  vi.clearAllMocks();
  mockHowl = createMockHowl();
  mockPlayer = createMockPlayer(mockHowl);
  vi.mocked(isSoundEnabled).mockReturnValue(true);
  vi.mocked(claimPlayer).mockResolvedValue(mockPlayer);
});

/** Helper: render useSound and flush the preloadSounds effect */
async function renderUseSound(soundName = 'ui/toggle_on') {
  const hook = renderHook(() => useSound(soundName));
  await act(async () => {});
  return hook;
}

/** Helper: trigger play and flush its async state updates */
async function triggerPlay(result: { current: ReturnType<typeof useSound> }) {
  act(() => {
    void result.current.play();
  });
  // Flush the async chain (unlockAudioContext → claimPlayer → ready → setIsPlaying)
  await act(async () => {});
}

describe('useSound', () => {
  it('returns the correct shape', async () => {
    const { result } = await renderUseSound();
    expect(result.current).toHaveProperty('play');
    expect(result.current).toHaveProperty('stop');
    expect(result.current).toHaveProperty('pause');
    expect(result.current).toHaveProperty('resume');
    expect(result.current).toHaveProperty('isPlaying');
    expect(result.current).toHaveProperty('isLoaded');
    expect(result.current).toHaveProperty('checkPermission');
    expect(typeof result.current.play).toBe('function');
    expect(typeof result.current.stop).toBe('function');
    expect(result.current.isPlaying).toBe(false);
    expect(typeof result.current.isLoaded).toBe('boolean');
  });

  it('plays loops on a separate player and stops both', async () => {
    const loopHowl = createMockHowl();
    const loopPlayer = createMockPlayer(loopHowl);
    vi.mocked(claimPlayer).mockImplementation(async (_name, options) =>
      options?.loop ? loopPlayer : mockPlayer
    );
    const { result } = await renderUseSound();

    act(() => {
      void result.current.play({ loop: true });
    });
    await act(async () => {});
    expect(claimPlayer).toHaveBeenCalledWith('ui/toggle_on', { loop: true });
    expect(loopHowl.loop).toHaveBeenCalledWith(true);
    expect(loopHowl.play).toHaveBeenCalled();
    expect(result.current.isPlaying).toBe(true);

    await triggerPlay(result);
    expect(mockHowl.play).toHaveBeenCalled();

    act(() => result.current.stop());
    expect(loopHowl.stop).toHaveBeenCalled();
    expect(mockHowl.stop).toHaveBeenCalled();
    expect(loopPlayer.release).toHaveBeenCalledTimes(1);
    expect(mockPlayer.release).toHaveBeenCalledTimes(1);
    expect(result.current.isPlaying).toBe(false);
  });

  it('play() calls claimPlayer then plays', async () => {
    const { result } = await renderUseSound();
    await triggerPlay(result);

    expect(claimPlayer).toHaveBeenCalledWith('ui/toggle_on', undefined);
    expect(mockHowl.play).toHaveBeenCalled();
  });

  it('play() does nothing when sounds are disabled', async () => {
    vi.mocked(isSoundEnabled).mockReturnValue(false);
    const { result } = renderHook(() => useSound('ui/toggle_on'));
    await act(async () => {});

    await act(async () => {
      await result.current.play();
    });

    expect(claimPlayer).not.toHaveBeenCalled();
  });

  it('stop() calls howl.stop() and releases this hook\'s reference', async () => {
    const { result } = await renderUseSound();
    await triggerPlay(result);

    act(() => {
      result.current.stop();
    });

    expect(mockHowl.stop).toHaveBeenCalledWith(1);
    expect(mockPlayer.release).toHaveBeenCalledTimes(1);
  });

  it('stop() only stops this hook\'s sound ids on a shared player', async () => {
    const { result } = await renderUseSound();
    await triggerPlay(result);
    // A second play gets its own sound id from the shared Howl
    mockHowl.play.mockReturnValueOnce(2);
    await triggerPlay(result);

    act(() => {
      result.current.stop();
    });

    const stoppedIds = mockHowl.stop.mock.calls.map(([id]) => id);
    expect(stoppedIds).toEqual(expect.arrayContaining([1, 2]));
    // The shared player is released once for this hook, not once per play
    expect(mockPlayer.release).toHaveBeenCalledTimes(1);
  });

  it('pause() calls howl.pause()', async () => {
    const { result } = await renderUseSound();
    await triggerPlay(result);

    act(() => {
      result.current.pause();
    });

    expect(mockHowl.pause).toHaveBeenCalled();
    expect(result.current.isPlaying).toBe(false);
  });

  it('resume() replays active sounds', async () => {
    const { result } = await renderUseSound();
    await triggerPlay(result);

    act(() => {
      result.current.pause();
    });
    act(() => {
      result.current.resume();
    });
    // resume calls unlockAudioContext().then(...) — flush its microtasks
    await act(async () => {});

    expect(mockHowl.play).toHaveBeenCalledTimes(2);
    expect(mockHowl.play).toHaveBeenLastCalledWith(1);
  });

  it('cleanup on unmount stops and releases sound', async () => {
    const { result, unmount } = await renderUseSound();
    await triggerPlay(result);

    unmount();

    expect(mockHowl.stop).toHaveBeenCalled();
    expect(mockPlayer.release).toHaveBeenCalledTimes(1);
  });

  it('releases a reference even when unmounted while the sound is still loading', async () => {
    let resolveClaim: (player: ReturnType<typeof createMockPlayer>) => void = () => {};
    const pending = new Promise((resolve) => {
      resolveClaim = resolve;
    });
    vi.mocked(claimPlayer).mockReturnValue(pending as ReturnType<typeof claimPlayer>);

    const { result, unmount } = await renderUseSound();
    act(() => {
      void result.current.play();
    });
    await act(async () => {});
    expect(claimPlayer).toHaveBeenCalledTimes(1);

    unmount();

    const latePlayer = createMockPlayer(createMockHowl());
    await act(async () => {
      resolveClaim(latePlayer);
    });

    // The late-arriving player must be released immediately, never cached on the dead hook
    expect(latePlayer.release).toHaveBeenCalledTimes(1);
  });

  it('concurrent plays share one player and each stop/unmount releases only its own reference', async () => {
    // The hook registers one "end" listener per shared player; real Howler invokes it once per
    // sound id, so capture the single listener and fire it for every play.
    let endListener: ((id: number) => void) | undefined;
    mockHowl.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'end') endListener = cb as (id: number) => void;
    });
    mockHowl.play
      .mockReturnValueOnce(1)
      .mockReturnValueOnce(2)
      .mockReturnValueOnce(3);
    const { result } = await renderUseSound();

    const plays: Array<Promise<void>> = [];
    act(() => {
      plays.push(result.current.play(), result.current.play(), result.current.play());
    });
    await act(async () => {});

    expect(claimPlayer).toHaveBeenCalledTimes(1);
    expect(mockHowl.play).toHaveBeenCalledTimes(3);

    // All three plays end naturally; the shared player is released once
    await act(async () => {
      [1, 2, 3].forEach((id) => endListener?.(id));
    });
    await Promise.all(plays);
    expect(mockPlayer.release).toHaveBeenCalledTimes(1);
  });

  it('unmount releases the held reference exactly once', async () => {
    const { result, unmount } = await renderUseSound();
    await triggerPlay(result);

    unmount();
    expect(mockPlayer.release).toHaveBeenCalledTimes(1);

    // A second unmount cycle (e.g. strict-mode remount cleanup) cannot double-release
    act(() => result.current.stop());
    expect(mockPlayer.release).toHaveBeenCalledTimes(1);
  });

  it('two components sharing a sound each hold an independent reference to the same player', async () => {
    // Every hook claims its own handle; the runtime underneath dedupes to a single Howl, so both
    // handles wrap the same mock Howl while carrying separate references.
    const componentA = renderHook(() => useSound('ui/toggle_on'));
    const componentB = renderHook(() => useSound('ui/toggle_on'));
    await act(async () => {});

    await triggerPlay(componentA.result);
    await triggerPlay(componentB.result);
    expect(claimPlayer).toHaveBeenCalledTimes(2);
    expect(mockPlayer.release).not.toHaveBeenCalled();

    // Unmounting A releases only A's reference; B's reference keeps the shared Howl from unloading
    componentA.unmount();
    expect(mockPlayer.release).toHaveBeenCalledTimes(1);
    expect(mockHowl.unload).not.toHaveBeenCalled();

    // B keeps playing until it releases its own reference
    await act(async () => componentB.result.current.stop());
    expect(mockPlayer.release).toHaveBeenCalledTimes(2);
    componentB.unmount();
  });

  it('the play promise resolves on natural end, stop and unmount', async () => {
    const endCallbacks: Array<(id: number) => void> = [];
    mockHowl.on.mockImplementation((event: string, cb: (...args: unknown[]) => void) => {
      if (event === 'end') endCallbacks.push(cb as (id: number) => void);
    });
    const { result, unmount } = await renderUseSound();

    // 1) natural end
    let settled = false;
    act(() => {
      void result.current.play().then(() => {
        settled = true;
      });
    });
    await act(async () => {});
    await act(async () => {
      endCallbacks.forEach((cb) => cb(1));
    });
    expect(settled).toBe(true);

    // The natural end released the player; hand out a fresh one for the remaining scenarios
    const secondHowl = createMockHowl();
    const secondPlayer = createMockPlayer(secondHowl);
    vi.mocked(claimPlayer).mockResolvedValue(secondPlayer);

    // 2) stop
    let stopSettled = false;
    act(() => {
      void result.current.play().then(() => {
        stopSettled = true;
      });
    });
    await act(async () => {});
    await act(async () => {
      result.current.stop();
    });
    expect(stopSettled).toBe(true);

    // 3) unmount
    let unmountSettled = false;
    act(() => {
      void result.current.play().then(() => {
        unmountSettled = true;
      });
    });
    await act(async () => {});
    await act(async () => {
      unmount();
    });
    expect(unmountSettled).toBe(true);
  });

  it('a play still loading when stop is called settles instead of hanging', async () => {
    let resolveClaim: (player: ReturnType<typeof createMockPlayer>) => void = () => {};
    vi.mocked(claimPlayer).mockReturnValue(
      new Promise((resolve) => {
        resolveClaim = resolve;
      }) as ReturnType<typeof claimPlayer>
    );

    const { result } = await renderUseSound();
    let settled = false;
    let rejected: unknown;
    act(() => {
      void result.current.play().then(
        () => {
          settled = true;
        },
        (error) => {
          rejected = error;
        }
      );
    });
    await act(async () => {});

    act(() => result.current.stop());

    const latePlayer = createMockPlayer(createMockHowl());
    await act(async () => {
      resolveClaim(latePlayer);
    });

    expect(settled || rejected).toBeTruthy();
    expect(latePlayer.release).toHaveBeenCalled();
  });

  it('rejects and releases the reference when the player fails to load, then retries', async () => {
    const loadError = new Error('Failed to load sound "ui/toggle_on": 404');
    const failedHowl = createMockHowl();
    const failedPlayer = createMockPlayer(failedHowl);
    failedPlayer.ready = Promise.reject(loadError);
    failedPlayer.ready.catch(() => { /* mock: failure is observed through play() below */ });
    const failingClaim = vi.fn().mockResolvedValue(failedPlayer);
    const retryingClaim = vi.fn().mockResolvedValue(mockPlayer);
    vi.mocked(claimPlayer).mockImplementation((...args) =>
      failingClaim.mock.calls.length === 0 ? failingClaim(...args) : retryingClaim(...args)
    );

    const { result } = await renderUseSound();

    await act(async () => {
      await expect(result.current.play()).rejects.toThrow(/Failed to load/);
    });
    expect(failingClaim).toHaveBeenCalledTimes(1);
    expect(failedPlayer.release).toHaveBeenCalledTimes(1);

    // Retry claims a fresh player and plays successfully
    await triggerPlay(result);
    expect(retryingClaim).toHaveBeenCalledTimes(1);
    expect(mockHowl.play).toHaveBeenCalled();
  });

  it('re-claims a fresh player after a pack update makes the held player stale', async () => {
    const oldHowl = createMockHowl();
    const oldPlayer = createMockPlayer(oldHowl);
    oldPlayer.isCurrent.mockReturnValue(false);
    const newHowl = createMockHowl();
    const newPlayer = createMockPlayer(newHowl);
    const firstClaim = vi.fn().mockResolvedValue(oldPlayer);
    const nextClaim = vi.fn().mockResolvedValue(newPlayer);
    vi.mocked(claimPlayer).mockImplementation((...args) =>
      firstClaim.mock.calls.length === 0 ? firstClaim(...args) : nextClaim(...args)
    );

    const { result } = await renderUseSound();
    await triggerPlay(result);
    expect(firstClaim).toHaveBeenCalledTimes(1);

    // Pack update lands; the old player keeps playing and is only released on stop
    act(() => result.current.stop());
    expect(oldPlayer.release).toHaveBeenCalledTimes(1);

    await triggerPlay(result);
    expect(nextClaim).toHaveBeenCalledTimes(1);
    expect(newHowl.play).toHaveBeenCalled();
  });

  it('can play again after being stopped', async () => {
    const { result } = await renderUseSound();
    await triggerPlay(result);
    act(() => result.current.stop());
    expect(result.current.isPlaying).toBe(false);

    await triggerPlay(result);
    expect(mockHowl.play).toHaveBeenCalledTimes(2);
    expect(result.current.isPlaying).toBe(true);
  });
});

describe('useSoundOnChange', () => {
  it('plays sound when value changes', async () => {
    const { rerender } = renderHook(
      ({ value }) => useSoundOnChange('ui/toggle_on', value),
      { initialProps: { value: 'a' } }
    );
    await act(async () => {});

    rerender({ value: 'b' });

    await vi.waitFor(() => {
      expect(claimPlayer).toHaveBeenCalled();
    });
  });

  it('skips initial render when initial: false', async () => {
    renderHook(() =>
      useSoundOnChange('ui/toggle_on', 'a', { initial: false })
    );
    await act(async () => {});

    expect(mockHowl.play).not.toHaveBeenCalled();
  });

  it('plays on initial render by default', async () => {
    renderHook(() => useSoundOnChange('ui/toggle_on', 'a'));
    await act(async () => {});

    await vi.waitFor(() => {
      expect(claimPlayer).toHaveBeenCalled();
    });
  });
});

describe('useSoundEnabled', () => {
  it('throws without SoundProvider', () => {
    expect(() => {
      renderHook(() => useSoundEnabled());
    }).toThrow();
  });
});
