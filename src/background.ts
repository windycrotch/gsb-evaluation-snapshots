import { createRng } from './timeline/prng';

/**
 * Background: voice messages with absurd durations float up from the bottom — "you're buried in them".
 * Deterministic (fixed seed), CSS transform animations only — cheap on phones.
 */
const DURATIONS = ['0:47', '1:12', '2:13', '0:58', '3:41', '7:58', '1:36', '4:20', '0:39', '12:07', '2:49', '5:05'];

export function renderVoiceRain(container: HTMLElement): void {
  const rng = createRng(7);
  const count = window.innerWidth < 600 ? 9 : 14;
  const frag = document.createDocumentFragment();

  for (let i = 0; i < count; i++) {
    const el = document.createElement('div');
    el.className = 'voice';
    const dur = 26 + rng() * 22;
    el.style.setProperty('--x', `${((i + rng() * 0.8) / count) * 100 - 8}%`);
    el.style.setProperty('--y', `${rng() * 90}%`);
    el.style.setProperty('--s', (0.75 + rng() * 0.5).toFixed(2));
    el.style.setProperty('--dur', `${dur.toFixed(1)}s`);
    el.style.setProperty('--delay', `${(-rng() * dur).toFixed(1)}s`); // already mid-flight on load

    const play = document.createElement('span');
    play.className = 'play';
    const wave = document.createElement('span');
    wave.className = 'wave';
    const bars = 14 + Math.floor(rng() * 10);
    for (let b = 0; b < bars; b++) {
      const bar = document.createElement('i');
      bar.style.height = `${4 + Math.round(rng() * 14)}px`;
      wave.appendChild(bar);
    }
    const time = document.createElement('span');
    time.textContent = DURATIONS[i % DURATIONS.length]!;
    el.append(play, wave, time);
    frag.appendChild(el);
  }
  container.appendChild(frag);
}
