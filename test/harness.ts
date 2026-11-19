import '../src/simple-player';
import type { SimplePlayer } from '../src/simple-player';

export type PlayerParts = {
  player: SimplePlayer;
  host: HTMLElement;
  video: HTMLVideoElement;
  track: HTMLElement;
  trayTimeText: HTMLElement;
  scrubTimeText: HTMLElement;
};

export async function createPlayer(attributes: Record<string, string> = {}): Promise<PlayerParts> {
  document.body.innerHTML = '';
  const player = document.createElement('simple-player') as SimplePlayer;
  for (const [name, value] of Object.entries(attributes)) {
    player.setAttribute(name, value);
  }
  document.body.append(player);
  await Promise.resolve();

  const root = player.shadowRoot!;
  const host = root.querySelector<HTMLElement>('[data-sp-player]')!;
  const video = root.querySelector<HTMLVideoElement>('[data-sp-video]')!;
  const track = root.querySelector<HTMLElement>('[data-sp-progress-track]')!;
  const trayTimeText = root.querySelector<HTMLElement>('[data-sp-tray-time-text]')!;
  const scrubTimeText = root.querySelector<HTMLElement>('[data-sp-time-text]')!;

  // Deterministic 200px-wide progress track for geometry math.
  track.dataset.testWidth = '200';

  return { player, host, video, track, trayTimeText, scrubTimeText };
}

export function emit(target: EventTarget, type: string): void {
  target.dispatchEvent(new Event(type, { bubbles: false, cancelable: true }));
}

/** Drive a fake media element through a successful first-frame lifecycle. */
export async function makeReady(parts: PlayerParts, duration = 10): Promise<void> {
  const { video, host, player } = parts;
  Object.defineProperty(video, 'duration', { configurable: true, value: duration });
  Object.defineProperty(video, 'videoWidth', { configurable: true, value: 1280 });
  Object.defineProperty(video, 'videoHeight', { configurable: true, value: 720 });
  Object.defineProperty(video, 'readyState', {
    configurable: true,
    writable: true,
    value: HTMLMediaElement.HAVE_FUTURE_DATA,
  });
  Object.defineProperty(video, 'paused', { configurable: true, writable: true, value: false });
  Object.defineProperty(video, 'ended', { configurable: true, writable: true, value: false });
  Object.defineProperty(video, 'error', { configurable: true, get: () => null });

  emit(video, 'loadstart');
  emit(video, 'loadedmetadata');
  emit(video, 'loadeddata');
  emit(video, 'canplay');
  emit(video, 'playing');
  host.classList.add('is-pointer-active');

  // The initial progress settle runs on a 380ms timer in real browsers;
  // wait it out deterministically so normal progress estimation takes over.
  await new Promise((resolve) => window.setTimeout(resolve, 450));
}

export function flushFrames(frames = 2): Promise<void> {
  return new Promise((resolve) => {
    let remaining = frames;
    const step = () => {
      remaining -= 1;
      if (remaining <= 0) resolve();
      else window.requestAnimationFrame(step);
    };
    window.requestAnimationFrame(step);
  });
}

export function progressInsetPercent(host: HTMLElement): number {
  const raw = host.style.getPropertyValue('--sp-progress-inset');
  const inset = Number.parseFloat(raw);
  if (!Number.isFinite(inset)) return Number.NaN;
  return 1 - (inset / 100);
}

export function pointer(
  type: 'pointerdown' | 'pointermove' | 'pointerup' | 'pointercancel',
  clientX: number,
  pointerId = 1,
): PointerEvent {
  return new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId,
    pointerType: 'mouse',
    clientX,
    clientY: 0,
    button: 0,
    isPrimary: true,
  });
}

/**
 * Mirror what a real browser does when video.load() runs for a new source:
 * media state drops to "nothing loaded" until the new metadata arrives.
 * jsdom leaves the previous values in place, which would leak old-source
 * duration/currentTime/readyState into the new source's initial render.
 */
export function simulateMediaLoadReset(video: HTMLVideoElement): void {
  Object.defineProperty(video, 'duration', { configurable: true, value: Number.NaN });
  Object.defineProperty(video, 'currentTime', { configurable: true, writable: true, value: 0 });
  Object.defineProperty(video, 'readyState', {
    configurable: true,
    writable: true,
    value: HTMLMediaElement.HAVE_NOTHING,
  });
  Object.defineProperty(video, 'videoWidth', { configurable: true, value: 0 });
  Object.defineProperty(video, 'videoHeight', { configurable: true, value: 0 });
}
