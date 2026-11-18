/**
 * The audio clock → cue → picture pulse chain, end to end in headless Chrome
 * on the built single file:
 *
 * - paused, the bar text and the scene name stand still and the pulses hold;
 *   play picks the song up where it stopped;
 * - quick skips leave nothing of the old songs: the title is the new song's,
 *   no chord of an old song shows, and the engine's queue holds no unread cue
 *   of a song that was skipped away from;
 * - synthetic cues injected in one frame: the kick pulse is the strongest of
 *   them, the chord shown is the last in time, and calm motion makes no flash;
 * - a long frame decays the pulses by the real time it took.
 *
 * WebGL runs on SwiftShader, so no graphics card is needed. Needs
 * `npm run build` first and a local Chrome (or `CHROME=/path/to/chrome`).
 */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { build } from 'esbuild';
import { launch, sleep } from '../tools/chrome.mjs';
import { checker, load, root } from '../tools/load.mjs';

const { check, done } = checker();
const { makeSong } = await load('core/music');

const html = await readFile(join(root, 'build', 'color-music.html'));
const server = createServer((req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(html);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;

const browser = await launch({
  width: 720,
  height: 480,
  flags: ['--autoplay-policy=no-user-gesture-required', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
if (!browser) {
  console.log('No Chrome found — set CHROME=/path/to/chrome. Skipping the cue test.');
  server.close();
  process.exit(0);
}
const { send, evaluate, until, click, errors } = browser;

/** The engine's cue queue around a skip, measured in the page with an offline context. */
const engineBundle = await build({
  stdin: {
    contents: `
      import { Engine } from './src/app/audio';
      import { makeSong } from './src/core/music';
      export function cueReset() {
        const ctx = new OfflineAudioContext(2, 8000, 8000);
        const engine = new Engine(ctx);
        engine.play(makeSong('first song', null), 0);
        engine.scheduleUntil(5);
        engine.play(makeSong('second song', null), 2);
        engine.scheduleUntil(6);
        const cues = engine.takeCues(Infinity);
        return {
          total: cues.length,
          beforeSwitch: cues.filter((cue) => cue.time < 2).length,
          firstBar: cues.find((cue) => cue.kind === 'bar') ?? null,
        };
      }
    `,
    resolveDir: root,
    loader: 'ts',
  },
  bundle: true,
  format: 'iife',
  globalName: 'CueEngine',
  target: 'es2022',
  loader: { '.glsl': 'text' },
  write: false,
  logLevel: 'silent',
});

const text = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)})?.textContent ?? null`);
/** Every chord name a song can show. */
const chordNames = (song) => [...new Set(song.sections.flatMap((s) => s.chords.map((c) => c.name)))];

try {
  await send('Page.navigate', { url });
  await until(`document.readyState === 'complete'`);
  await click('#start');
  check('playing', await until(`document.body.dataset.state === 'playing'`, 5000), true);
  check('the song is under way', await until(`document.querySelector('#f-part').textContent.includes('bar 1 of')`, 8000), true);

  // Pause: the bar text, the scene name and the pulses stand still
  await click('#play');
  check('paused', await until(`document.body.dataset.state === 'paused'`, 3000), true);
  const frozenPart = await text('#f-part');
  const frozenScene = await text('#f-scene');
  await evaluate(`window.__colorMusic.pulse.beat = 1`);
  await sleep(1500);
  check('paused: the bar text stands still', await text('#f-part'), frozenPart);
  check('paused: the scene name stands still', await text('#f-scene'), frozenScene);
  check('paused: the pulses do not decay', await evaluate(`window.__colorMusic.pulse.beat >= 0.999`), true);
  await click('#play');
  check('playing again', await until(`document.body.dataset.state === 'playing'`, 3000), true);
  check('resumed: the song goes on', await until(`document.querySelector('#f-part').textContent !== ${JSON.stringify(frozenPart)}`, 12000), true);

  // Quick skips: nothing of the old songs shows
  await click('#next');
  await sleep(150);
  await click('#next');
  await sleep(150);
  await click('#next');
  const seed = await evaluate(`document.querySelector('#seed').value`);
  const song = makeSong(seed, null);
  check('after skips: the new song’s title', await text('#now-title'), song.title);
  check('after skips: the new song starts at its bar 1', await until(`document.querySelector('#f-part').textContent.includes('bar 1 of')`, 8000), true);
  const own = chordNames(song);
  let stranger = null;
  for (let i = 0; i < 30 && stranger === null; i++) {
    const shown = await text('#f-chord');
    if (shown !== '—' && !own.includes(shown)) stranger = shown;
    await sleep(40);
  }
  check('after skips: no chord of an old song shows', stranger, null);

  // The engine's queue: a skip voids the old song's unread cues
  await evaluate(engineBundle.outputFiles[0].text);
  const reset = await evaluate('CueEngine.cueReset()');
  check('a skip leaves cues behind', reset.total > 0, true);
  check('a skip voids the old song’s unread cues', reset.beforeSwitch, 0);
  check('the new song’s first cue is its own bar 0', reset.firstBar, { kind: 'bar', time: 2, section: 0, bar: 0 });

  // Synthetic cues in one frame: strongest kick, last chord in time
  const folded = await evaluate(`(() => {
    const t = window.__colorMusic;
    t.pulse.beat = 0;
    t.handleCues([
      { kind: 'note', time: 3, voice: 'kick', midi: 36, velocity: 0.4 },
      { kind: 'note', time: 1, voice: 'kick', midi: 36, velocity: 0.9 },
      { kind: 'note', time: 2, voice: 'kick', midi: 36, velocity: 0.6 },
      { kind: 'chord', time: 1, name: 'Cmaj7', root: 48 },
      { kind: 'chord', time: 2, name: 'Gm', root: 43 },
    ]);
    return { beat: t.pulse.beat, chord: document.querySelector('#f-chord').textContent };
  })()`);
  check('one frame, three kicks: the strongest hits', folded.beat, 0.9);
  check('one frame, two chords: the last in time shows', folded.chord, 'Gm');

  // Calm motion: a crash makes no flash
  const flash = await evaluate(`(() => {
    const t = window.__colorMusic;
    t.pulse.flash = 0;
    t.handleCues([{ kind: 'note', time: 1, voice: 'crash', midi: 49, velocity: 1 }]);
    const lively = t.pulse.flash;
    document.querySelector('#opt-calm').click();
    t.pulse.flash = 0;
    t.handleCues([{ kind: 'note', time: 1, voice: 'crash', midi: 49, velocity: 1 }]);
    const calm = t.pulse.flash;
    document.querySelector('#opt-calm').click();
    return { lively, calm };
  })()`);
  check('a crash flashes', flash.lively, 1);
  check('calm motion: no flash', flash.calm, 0);

  // A long frame: the pulses decay by the real time it took
  const decayed = await evaluate(`(() => {
    const t = window.__colorMusic;
    t.pulse.beat = t.pulse.snare = t.pulse.note = t.pulse.flash = 1;
    t.decay(1.5);
    return { beat: t.pulse.beat, snare: t.pulse.snare, note: t.pulse.note, flash: t.pulse.flash };
  })()`);
  const round = (x) => +x.toFixed(6);
  check('a 1.5 s frame: the flash fades by 1.5 s', round(decayed.flash), round(Math.exp(-4 * 1.5)));
  check('a 1.5 s frame: the beat fades by 1.5 s', round(decayed.beat), round(Math.exp(-7 * 1.5)));
  check('a 1.5 s frame: the snare fades by 1.5 s', round(decayed.snare), round(Math.exp(-9 * 1.5)));
  check('a 1.5 s frame: the note fades by 1.5 s', round(decayed.note), round(Math.exp(-5 * 1.5)));

  check('no errors on the page', errors, []);
} finally {
  await browser.close();
  server.close();
}

done('cues');
