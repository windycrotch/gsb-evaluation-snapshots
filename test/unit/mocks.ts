import { vi } from 'vitest';

export function createMockHowl() {
  return {
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
}

/**
 * Build a SoundPlayer-shaped mock around a mock Howl.
 * `release` is a fresh vi.fn per player so reference counting can be asserted.
 */
export function createMockPlayer(howl = createMockHowl()) {
  return {
    howl,
    ready: Promise.resolve(),
    release: vi.fn(),
    isCurrent: vi.fn().mockReturnValue(true),
  };
}

export function createRuntimeMock(overrides?: Record<string, unknown>) {
  return {
    claimSound: vi.fn().mockResolvedValue(createMockHowl()),
    claimPlayer: vi.fn().mockImplementation(async () => createMockPlayer()),
    freeSound: vi.fn().mockReturnValue(null),
    isSoundEnabled: vi.fn().mockReturnValue(true),
    preloadSounds: vi.fn().mockResolvedValue([]),
    unlockAudioContext: vi.fn().mockResolvedValue(undefined),
    checkAudioPermission: vi.fn().mockResolvedValue('granted'),
    subscribeSoundState: vi.fn().mockReturnValue(() => {}),
    setSoundEnabled: vi.fn(),
    initSoundEnabledState: vi.fn(),
    playSound: vi.fn(),
    initAudioContextUnlock: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  };
}
