# Tonalux Audio Analyzer

Professional grade audio analysis that runs entirely in your browser. No uploads, no accounts, no server. Your audio never leaves your device.

**[Try it live on tonalux.org](https://tonalux.org/analyzer.html)**

![Tonalux Audio Analyzer](screenshots/analyzer.png)

## What it does

Drop any audio file and get instant measurements:

- **LUFS Metering** — Integrated, short-term, momentary loudness and LRA (EBU R128 / ITU-R BS.1770)
- **True Peak** — Intersample peak detection via 4x Catmull-Rom interpolation (dBTP)
- **BPM Detection** — Onset envelope analysis with autocorrelation
- **Key Detection** — Chromagram + Krumhansl-Kessler profiling (major and minor)
- **Stereo Analysis** — Width, phase correlation, and real-time goniometer
- **Frequency Spectrum** — 256-band log-spaced FFT with real-time overlay during playback
- **Streaming Targets** — Loudness comparison for Spotify, Apple Music, YouTube, Tidal, Amazon, Deezer
- **Audio Playback** — Click-to-seek waveform, spacebar play/pause

All DSP runs in a Web Worker off the main thread. Optional enhanced BPM/key detection via [Essentia.js](https://mtg.github.io/essentia.js/) (loaded from CDN, graceful fallback).

## Quickstart

```bash
git clone https://github.com/Exenye/tonalux-analyzer.git
cd tonalux-analyzer
python3 -m http.server 8080
```

Open [http://localhost:8080](http://localhost:8080). Any static HTTP server works (Python, Node, VS Code Live Server, etc.).

Supports MP3, WAV, FLAC, AAC, and OGG.

## How the DSP works

The signal processing pipeline implements broadcast standard loudness measurement:

1. **K-Weighting** — Two-stage biquad filter (high-shelf at 1681 Hz + high-pass at 38 Hz) per ITU-R BS.1770
2. **Gated LUFS** — 400ms blocks with absolute gate (-70 LKFS) and relative gate (-10 LU below ungated mean)
3. **FFT** — Cooley-Tukey radix-2 in-place, 8192-point for 5.9 Hz/bin resolution at 48kHz
4. **True Peak** — 4x oversampled Catmull-Rom interpolation to catch intersample peaks
5. **Key Detection** — Chromagram extracted from FFT bins mapped to pitch classes, correlated against Krumhansl-Kessler major/minor profiles via Pearson correlation

## Project structure

```
index.html          — HTML markup (121 lines)
css/analyzer.css    — Styles, dark theme, responsive (250 lines)
js/analyzer.js      — App logic, playback, canvas rendering (776 lines)
js/worker.js        — DSP Web Worker: FFT, LUFS, peaks, BPM, key (443 lines)
```

No build step. No bundler. No dependencies.

## Verifying result ownership

Every `processFile()` run is assigned an incrementing request id. The worker echoes that id in every `progress` / `result` / `error` message, and the app only updates `analysisData`, the progress text and the results area when the id matches the current request — stale results are discarded without terminating the worker that is currently running. Realtime playback drawing (spectrum overlay, goniometer) is bound to the current `audioBuffer`/`analysisData` and to the current source node; callbacks from an old source node return without touching the UI.

The page exposes a small console hook, `window.azAnalyzer`, with `loadFile(file)` (same code path as drag & drop) and `getState()` (what the UI currently reflects). No build step or extra dependencies needed.

### Test 1 — rapid consecutive files (automated, paste into the browser console)

```js
// Synthesize two local WAV files of different durations/frequencies
function makeWavFile(name, seconds, freq) {
  const sr = 44100, n = Math.round(seconds * sr), ch = 2;
  const dv = new DataView(new ArrayBuffer(44 + n * ch * 2));
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  ws(0,'RIFF'); dv.setUint32(4, 36 + n*ch*2, true); ws(8,'WAVE'); ws(12,'fmt ');
  dv.setUint32(16,16,true); dv.setUint16(20,1,true); dv.setUint16(22,ch,true);
  dv.setUint32(24,sr,true); dv.setUint32(28,sr*ch*2,true); dv.setUint16(32,ch*2,true);
  dv.setUint16(34,16,true); ws(36,'data'); dv.setUint32(40,n*ch*2,true);
  for (let i = 0; i < n; i++) {
    const v = Math.round(Math.sin(2*Math.PI*freq*i/sr) * 0.5 * 32767);
    dv.setInt16(44 + i*4, v, true); dv.setInt16(44 + i*4 + 2, Math.round(v*0.8), true);
  }
  return new File([dv.buffer], name, { type: 'audio/wav' });
}
const waitAnalysis = () => new Promise(r => {
  const t = setInterval(() => { if (azAnalyzer.getState().analysis) { clearInterval(t); r(); } }, 200);
});

const f1 = makeWavFile('test-A-2s-440Hz.wav', 2, 440);
const f2 = makeWavFile('test-B-5s-880Hz.wav', 5, 880);

await azAnalyzer.loadFile(f1);   // start A...
await azAnalyzer.loadFile(f2);   // ...immediately switch to B (A's result must be discarded)
await waitAnalysis();
const s = azAnalyzer.getState();
console.assert(s.fileName === 'test-B-5s-880Hz.wav', 'FAIL: wrong file name', s);
console.assert(Math.abs(s.duration - 5) < 0.01, 'FAIL: wrong duration', s);
console.assert(s.analysis && s.analysis.lufs !== null, 'FAIL: no metrics for B', s);
console.table(s); // file name, duration and all metrics must belong to file B
```

Expected: no assertion failures — the final file name, duration and metrics all belong to the **second** file, even though the first analysis was still in flight (or its result arrived late).

### Test 2 — switching files during playback (automated + visual)

```js
await azAnalyzer.loadFile(f1);
await waitAnalysis();
document.getElementById('azPlayBtn').click();        // start playing file A
await new Promise(r => setTimeout(r, 500));          // let realtime curves draw
await azAnalyzer.loadFile(f2);                       // switch files mid-playback
const t = azAnalyzer.getState();
console.assert(t.isPlaying === false && t.playButton === 'Play' && t.pauseOffset === 0,
  'FAIL: transport was not reset on file switch', t);
await waitAnalysis();
console.table(azAnalyzer.getState());                // everything belongs to file B
```

Expected: playback stops, position and button reset to `0:00` / `Play`, and while file B analyzes, the spectrum and goniometer show **no** realtime overlay from file A — after B's results land, only B's static curves are drawn. (Visually: no moving curve from the first file is overlaid on the second file's spectrum/goniometer.)

### Test 3 — undecodable file (manual)

Drop a non-audio file renamed to `.mp3`. Expected: an alert is shown, the drop zone stays available for a retry, and no metrics from the previous file remain on screen.

You can also run tests 1–2 manually with any two local audio files of different lengths: drag in file A, then file B while A is still analyzing — the final UI must match B; then drag in A, press Play, and drop B mid-playback — A's realtime curves must never appear on B's results.

## Browser support

Chrome/Edge 66+ · Firefox 76+ · Safari 14.1+

## Part of Tonalux

This analyzer is part of [Tonalux](https://tonalux.org), a platform for audio professionals. Check out the other tools at [tonalux.org](https://tonalux.org).

## License

MIT — see [LICENSE](LICENSE).
