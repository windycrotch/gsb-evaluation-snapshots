import type { SimplePlayer } from '../src/simple-player';
import '../src/simple-player';
import { createMediaDriver, type MediaDriver } from './media-driver';

export const PROGRESS_WIDTH = 200;
export const PROGRESS_LEFT = 10;

export type PlayerHarness = {
  host: SimplePlayer;
  player: HTMLElement;
  video: HTMLVideoElement;
  button: HTMLButtonElement;
  progressTrack: HTMLElement;
  volumeTrack: HTMLElement;
  speedTrack: HTMLElement;
  driver: MediaDriver;
  /** Pause until queued microtasks/rAF callbacks (IntersectionObserver, rAF) settle. */
  settleFrames: (count?: number) => Promise<void>;
  pointerEvent: (type: string, init?: PointerEventInit) => PointerEvent;
  revealControls: () => void;
  pointerDownOnProgress: (clientX: number, pointerId?: number) => PointerEvent;
  pointerMoveOnProgress: (clientX: number, pointerId?: number) => PointerEvent;
  pointerUpOnProgress: (clientX: number, pointerId?: number) => PointerEvent;
  pointerCancelOnProgress: (pointerId?: number) => PointerEvent;
  progressPercent: () => number;
  isLoading: () => boolean;
  isPlaying: () => boolean;
};

export async function mountPlayer(attributes: Record<string, string | boolean> = {}): Promise<PlayerHarness> {
  document.body.innerHTML = '';
  const host = document.createElement('simple-player') as SimplePlayer;
  for (const [name, value] of Object.entries(attributes)) {
    if (value === false) continue;
    host.setAttribute(name, value === true ? '' : value);
  }
  document.body.append(host);

  const root = host.shadowRoot!;
  const player = root.querySelector<HTMLElement>('[data-sp-player]')!;
  const video = root.querySelector<HTMLVideoElement>('[data-sp-video]')!;
  const button = root.querySelector<HTMLButtonElement>('[data-sp-button]')!;
  const progressTrack = root.querySelector<HTMLElement>('[data-sp-progress-track]')!;
  const volumeTrack = root.querySelector<HTMLElement>('[data-sp-volume-track]')!;
  const speedTrack = root.querySelector<HTMLElement>('[data-sp-speed-track]')!;

  // happy-dom always returns a zeroed rect; give the progress track geometry so
  // pointer-to-percent math exercises the real implementation.
  progressTrack.getBoundingClientRect = () =>
    new DOMRect(PROGRESS_LEFT, 0, PROGRESS_WIDTH, 4) as DOMRect;

  const driver = createMediaDriver(video);

  // IntersectionObserver hydration is queued as a microtask.
  await Promise.resolve();
  await Promise.resolve();

  const nextFrame = () => new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  const settleFrames = async (count = 3) => {
    for (let i = 0; i < count; i += 1) {
      await nextFrame();
    }
  };

  const pointerEvent = (type: string, init: PointerEventInit = {}) =>
    new PointerEvent(type, { bubbles: true, composed: true, pointerId: 1, pointerType: 'mouse', button: 0, ...init });

  // Progress interactions require visible controls; emulate the pointer-active
  // state that real mouse movement would establish.
  const revealControls = () => player.classList.add('is-pointer-active');

  const pointerDownOnProgress = (clientX: number, pointerId = 1) => {
    const event = pointerEvent('pointerdown', { clientX, clientY: 2, pointerId });
    progressTrack.dispatchEvent(event);
    return event;
  };
  const pointerMoveOnProgress = (clientX: number, pointerId = 1) => {
    const event = pointerEvent('pointermove', { clientX, clientY: 2, pointerId });
    progressTrack.dispatchEvent(event);
    return event;
  };
  const pointerUpOnProgress = (clientX: number, pointerId = 1) => {
    const event = pointerEvent('pointerup', { clientX, clientY: 2, pointerId });
    progressTrack.dispatchEvent(event);
    return event;
  };
  const pointerCancelOnProgress = (pointerId = 1) => {
    const event = pointerEvent('pointercancel', { clientX: 10, clientY: 2, pointerId });
    progressTrack.dispatchEvent(event);
    return event;
  };

  const progressPercent = () => {
    const inset = Number.parseFloat(player.style.getPropertyValue('--sp-progress-inset'));
    if (!Number.isFinite(inset)) return 0;
    return Math.round((1 - inset / 100) * 1000) / 1000;
  };

  return {
    host,
    player,
    video,
    button,
    progressTrack,
    volumeTrack,
    speedTrack,
    driver,
    settleFrames,
    pointerEvent,
    revealControls,
    pointerDownOnProgress,
    pointerMoveOnProgress,
    pointerUpOnProgress,
    pointerCancelOnProgress,
    progressPercent,
    isLoading: () => player.classList.contains('is-loading'),
    isPlaying: () => player.classList.contains('is-playing'),
  };
}

/** Wait for the player's real retry delay (2s) plus event settling. */
export function realDelay(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms + 30));
}

export const RETRY_DELAY = 2000;
export const MAX_LOAD_ATTEMPTS = 3;
