# AutoDJ AI Prototype

Prototipo locale per automazione musicale senza streaming.

L'app gira nel browser (Web Audio) con un backend Python opzionale per l'analisi:

- importa file audio locali;
- analizza durata, cue in/out, energia, BPM, **tonalità (Camelot)**, **loudness EBU R128**, **beat grid** e **presenza vocale** in intro/outro;
- gestisce una playlist modificabile durante la riproduzione;
- riproduce con due deck e mixaggio professionale: curve crossfader selezionabili, **beatmatch** a pitch costante, **EQ a 3 bande** con swap basato sull'overlap spettrale, **partenza allineata alla frase**, **normalizzazione loudness**;
- VU meter numerici in dBFS con peak-hold;
- sceglie il prossimo brano con uno score armonico (compatibilità BPM con ottave, ruota di Camelot, curva di energia, finestre mixabili e anti-clash vocale).
- include una prima modalità **Radio edit** per brani non extended, con stima di `entryPoint` e `mixPoint` su frase.

## Analisi per un mix professionale

| Dato | Sorgente | Uso nel mix |
|------|----------|-------------|
| BPM + confidenza | Essentia `MusicExtractor` | beatmatch e scelta del brano (gestisce rapporti 2×/½×) |
| Tonalità → Camelot | Essentia (voto a maggioranza di 3 profili) | mixaggio armonico (stessa key / ±1 / relativa) |
| Energia | RMS (mean + p90) | costruzione della curva del set (preferisce salite) |
| Loudness (LUFS) | Essentia EBU R128 | trim per-traccia verso −16 LUFS, nessun salto di volume |
| Beat grid (firstBeat + interval) | Essentia `beats_position` | allineamento di fase del crossfade |
| Downbeat + phrase grid (16 beat) | beat grid + novelty MFCC (librosa) | transizioni che partono sull'inizio di frase |
| Split spettrale low/mid/high | Essentia `spectral_energyband_*` | EQ a 3 bande che riduce solo le bande in conflitto |
| Voce intro/outro | Demucs (stem separation) | evita di sfumare una voce sopra un'altra |

## Avvio

Dipendenze già installate in questo ambiente:

- `ffmpeg`
- `rubberband-cli`
- `aubio-tools`
- virtualenv Python `.venv` con Essentia, librosa, FastAPI, PyTorch CPU e Demucs

Terminale 1, backend opzionale ma consigliato:

```bash
cd /root/auto-dj-ai
npm run backend
```

L'analisi vocale con Demucs è disattivata di default perché lenta su CPU.
Per attivarla globalmente:

```bash
AUTODJ_STEMS=1 npm run backend
```

oppure per singola richiesta con `POST /analyze?stems=true`. Senza Demucs il
mix funziona comunque usando le finestre mixabili stimate spettralmente.

Terminale 2, interfaccia:

```bash
cd /root/auto-dj-ai
npm start
```

Poi apri:

```text
http://localhost:5173
```

## Controllo MIDI (es. Hercules DJControl Inpulse 200)

Il pannello **MIDI** usa la Web MIDI API (contesto sicuro: `localhost`/`127.0.0.1`).
Collega il controller via USB, chiudi eventuali software che lo occupano (es. DJUCED),
e dai il permesso MIDI al browser.

Ogni controllo ha **MIDI Learn**: premi *Learn*, poi muovi/premi il controllo fisico.
Le associazioni si salvano in `localStorage`.

Controlli mappabili:

- comandi: Start, Stop, Skip mix, Ordina set (pad/pulsanti);
- knob durata Crossfade e Tolleranza beatmatch (fader assoluti);
- **override manuale in tempo reale** (l'auto-DJ continua finché non tocchi nulla):
  - Crossfader manuale (il crossfader fisico guida il blend; si auto-orienta);
  - EQ Bassi/Medi/Alti del deck attivo (centro knob = 0 dB);
  - Jog (nudge): spinta temporanea del tempo per allineare le battute.

Nota: mappa **fader/crossfader** (assoluti) sui knob e **pad** sui comandi; i jog
inviano valori relativi e vanno solo sulla voce *Jog*.

## Stato del prototipo

Implementato:

- UI libreria e playlist modificabile mentre suona;
- analisi completa: BPM, key/Camelot, energia, loudness LUFS, beat grid, voce intro/outro;
- backend Essentia/librosa + Demucs opzionale;
- player a due deck con curve crossfader selezionabili, beatmatch a pitch costante, bass-swap EQ, normalizzazione loudness;
- scelta smart armonica con guardia anti-clash vocale.
- prima passata Radio edit: toggle UI, `entryPoint` e `mixPoint` in analisi.

Non ancora implementato:

- candidati radio edit multipli con motivazioni/debug waveform;
- downbeat detection con modello dedicato (madmom): ora si usa un'euristica onset+novelty su Python 3.13;
- phrase detection a 32/64 battute (ora fissa a 16);
- time-stretch di alta qualità con Rubber Band (ora si usa il time-stretch del browser);
- modalità batch "punta una cartella e parte" e persistenza/cache SQLite dell'analisi.

## Evoluzione consigliata

- caching/persistenza dell'analisi (SQLite) per non ri-analizzare ad ogni sessione;
- consolidamento Radio edit con timeline feature, candidati, punteggi e debug visivo;
- modelli TensorFlow di Essentia per mood/genre/embeddings e transizioni per "vibe";
- phrase detection per partire le transizioni sull'inizio di frase;
- Rubber Band per time-stretch offline di qualità superiore.

L'app browser attuale può restare come UI e player, oppure diventare una shell Electron/Tauri.

## A Note from the Creator

AutoDJ AI started from a love of DJing and a simple curiosity: how far could an
automatic mix go before it stopped sounding like a machine and started sounding
*musical*? I've built it one step at a time, learning as I went — but the project
has now reached areas (DSP, the mix engine, audio analysis, machine learning)
that go beyond my current technical skills.

I say this with a clear conscience: I've put my head and my heart into it, and I'm
proud of how far it's come. I also know when an idea deserves more experienced
hands to really grow.

So if you're an audio / DSP / ML developer — or the idea simply intrigues you —
**help is genuinely welcome**: issues, suggestions, code reviews, pull requests,
all of it counts. It doesn't take a huge commitment; even a pointer in the right
direction means a lot. There's only one goal here: **make the music sound good.** 🎧

### Where a hand would matter most

- **Intro/outro & structure detection** — finding the right cut points, especially for non-extended / radio edits.
- **Reliable vocal detection** — so the mix never fades one vocal over another.
- **Beat/phrase alignment & high-quality time-stretch** — tighter, more musical transitions.
- **Honest feedback** on the mix engine's musical decisions.

If any of this speaks to you, open an issue or a PR — or just say hi. Thanks for
taking a look. 🙏
