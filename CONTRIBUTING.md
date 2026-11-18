# Contributing to AutoDJ AI

Thanks for taking a look! This is a solo, learning-driven project that has grown
into areas (DSP, audio analysis, ML) where experienced hands are very welcome.
Issues, ideas, code reviews and pull requests all count — even a pointer in the
right direction helps.

## Run it locally

Requirements: Python 3.x (a venv with Essentia, librosa, FastAPI, PyTorch CPU,
Demucs), Node/Python for the static UI, and `ffmpeg`.

```bash
# 1) backend (audio analysis) — http://127.0.0.1:8765
npm run backend
# 2) UI (static server) — http://127.0.0.1:5173
npm start
```

Backend tests (synthetic audio, no Demucs model needed):

```bash
npm run test:backend
```

Open `http://127.0.0.1:5173`, import a few tracks, let them analyze, and press play.
Full-track Demucs vocal analysis is on by default (slow on CPU the first time per
track, then cached). Disable with `AUTODJ_STEMS=0 npm run backend`.

Architecture and design decisions live in `docs/` (the project keeps an
"LLM wiki": `docs/WIKI.md` is the index, `docs/wiki/` the compiled knowledge).
`STATO.md` is the latest session handoff.

## Where help matters most

- **Intro/outro & structure detection** — the right cut points, especially for
  non-extended / radio edits.
- **Reliable vocal detection** — never fade one vocal over another.
- **Beat/phrase alignment & high-quality time-stretch** (e.g. Rubber Band).
- **Honest feedback** on the mix engine's musical choices.

Look for issues labelled `good first issue` and `help wanted`.

## How to contribute

1. Open an issue to discuss the idea first (avoids duplicate work).
2. Fork, create a branch, keep changes focused.
3. Keep the code style consistent with the surrounding code.
4. Describe *what* and *why* in the PR; a short demo clip helps for mix changes.

## Code of conduct

Be kind and constructive. The goal is simple: **make the music sound good.** 🎧
