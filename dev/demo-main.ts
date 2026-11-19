import '../src/simple-player';
import type { SimplePlayer } from '../src/simple-player';

const SOURCES = {
  a: 'https://samplelib.com/mp4/sample-10s.mp4',
  b: 'https://samplelib.com/mp4/sample-5s.mp4',
  broken: 'https://example.test/this-video-does-not-exist.mp4',
} as const;

const player = document.querySelector<SimplePlayer>('#player')!;
const log = document.querySelector<HTMLElement>('#log')!;
const video = player.shadowRoot?.querySelector<HTMLVideoElement>('[data-sp-video]') ?? null;

function writeLog(message: string): void {
  const stamp = new Date().toLocaleTimeString();
  log.textContent = `${stamp}  ${message}\n${log.textContent}`;
}

function readState(): string {
  const timeText =
    player.shadowRoot?.querySelector<HTMLElement>('[data-sp-tray-time-text]')?.textContent ?? '?';
  const inset = player.style.getPropertyValue('--sp-progress-inset');
  const percent = inset ? (100 - Number.parseFloat(inset)).toFixed(1) : '?';
  return `time=${timeText} fill=${percent}% attempts=${player.videoLoadAttempt} failed=${player.hasVideoLoadFailed}`;
}

document.querySelectorAll<HTMLButtonElement>('[data-action]').forEach((button) => {
  button.addEventListener('click', () => {
    const action = button.dataset.action;
    if (action === 'source-a') {
      player.setAttribute('src', SOURCES.a);
      writeLog(`switch to Source A -> ${readState()}`);
    } else if (action === 'source-b') {
      player.setAttribute('src', SOURCES.b);
      writeLog(`switch to Source B -> ${readState()}`);
    } else if (action === 'source-broken') {
      player.setAttribute('src', SOURCES.broken);
      writeLog(`switch to broken source -> ${readState()}`);
    } else if (action === 'source-recover') {
      player.setAttribute('src', SOURCES.a);
      writeLog(`recover with Source A -> ${readState()}`);
    }
  });
});

// Continuously surface the rendered state so the four scenarios can be
// observed without opening devtools.
window.setInterval(() => {
  writeLog(`tick ${readState()}`);
}, 1000);

video?.addEventListener('error', () => {
  writeLog(`media error (attempt ${player.videoLoadAttempt})`);
});
video?.addEventListener('loadedmetadata', () => {
  writeLog(`metadata loaded for new source`);
});
