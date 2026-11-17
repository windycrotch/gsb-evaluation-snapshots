# Suggerimenti per migliorare l'analisi audio — AutoDJ AI

## 1. Segmentazione strutturale
Le soglie fisse in `classify_section` (energy/onset/centroid) sono fragili.
Alternativa: `essentia.standard.SBic` (structural change detection) o `librosa.segment.agglomerative` con MFCC + tempogram.

## 2. Downbeat più robusto (senza madmom)
L'euristica "pick the strongest 4/4 phase" sbaglia su brani con sincope.
Alternative:
- `essentia.standard.BeatTrackerMultiFeatures` stima anche il downbeat
- Autocorrelazione dell'onset envelope a 2/4/8 battute, scegli il phase che massimizza la coerenza su tutta la traccia

## 3. Phrase detection multi-risoluzione
Invece di fissare 16 beat, prova 16/32/64 e scegli la risoluzione con novelty MFCC media più alta ai boundary.
Pop → 16 beat, house/techno → spesso 32-64.

## 4. Crest factor / dynamic range
`peak / rms` è semplicissimo: EDM compresso ~3-4 dB, brani dinamici ~8-12 dB.
Usalo per scegliere la durata del crossfade (più lungo per brani dinamici).

## 5. Chroma similarity per lo scoring
Oltre a Camelot, calcola la correlazione tra chromagram (`librosa.feature.chroma_cqt`) dei due brani nella zona di mix.
Due brani in chiavi compatibili ma con armonie dissonanti suonano male insieme.

## 6. Cache SQLite
Ripetere l'analisi a ogni refresh è frustrante.
Tabella `hash → analysis_json` lato backend, controllata all'avvio.

## 7. Equal-loudness contour
Prima di calcolare RMS/loudness, applicare filtro A-weighting o ISO 226.
L'orecchio umano non percepisce bassi e altissimi alla stessa intensità.

## 8. Tension profile
Combina novelty MFCC (cambi di timbro) + energia + densità di onset.
I punti di mix ideali sono dove la tensione cala (fine build, inizio break).
