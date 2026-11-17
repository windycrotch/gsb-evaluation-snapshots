# Todo Tecnica

Aggiornata il 2026-06-05. Questa pagina non e una lista di patch immediate:
e una mappa delle idee tecniche che possono rendere Par8DJ AI credibile per uso
pubblico.

## Principio

Prima rendere il mix spiegabile, correggibile e misurabile. Solo dopo aggiungere
AI pesante, export offline o shell desktop.

Il sistema deve poter rispondere a tre domande per ogni transizione:

- perche questo prossimo brano;
- perche questo punto di ingresso/uscita;
- perche questa durata/curva/EQ.

## Priorita Alta - Qualita Del Mix

- [x] Timeline musicale interna: finestre da 1 secondo con energia, onset,
  novelty, brightness, low/mid/high, rischio voce e tensione (`analysis.timeline`).
- [x] Candidati di mix espliciti: `analysis.candidates` con piu `entryPoint`/
  `mixPoint`/`cueIn`/`cueOut`, ognuno con punteggio e motivazioni.
- [x] Radio Edit Mix Mode serio: `plannedTransition` con durata radio-edit corta
  e indipendente, curva e EQ scelti su frase; player la consuma.
- [x] Vocal risk su tutto il brano: VAD euristico sempre attivo nel timeline,
  Demucs lo raffina solo nelle zone intro/outro.
- [x] Phrase detection multi-risoluzione: `analysis.phraseGrid` valuta 16/32/64
  beat e sceglie la griglia piu coerente.
- [x] Cue-in professionale: candidato `cueIn` che fonde RMS, onset strength e
  spectral flux.
- [x] Planned transition: oggetto decisionale (entry, mix, durata, curva,
  beatmatch, EQ strategy, motivazioni) condiviso da scoring, UI e player.

## Priorita Media - Decisioni Musicali Migliori

- [x] Tension profile: `timeline.tension` combina energia, novelty e densita
  onset; usato dai candidati `mixPoint` per evitare mix in pieno drop.
- [ ] Chroma locale: confrontare armonicamente la zona uscente e la zona entrante,
  non solo la tonalita globale del brano.
- [ ] Crest factor e dynamic range: usare compressione/dinamica per scegliere
  durata fade, aggressivita limiter e tipo di transizione.
- [ ] True peak, LRA e short-term loudness: ridurre salti percepiti e rischio
  clipping nei passaggi sovrapposti.
- [x] Fade curve adattiva: `plannedTransition.curve` sceglie cut (rischio voce/
  finestra corta), power (default) o smooth (mix armonici lunghi).
- [ ] Metadata tag scanning: leggere BPM/key/genre/artist/title/replaygain come
  indizi ausiliari, mai come fonte autoritaria.
- [ ] Test set musicale reale: radio edit pop, house extended, ambient senza beat,
  acapella, intro rumorosa, brano brevissimo, tempo variabile.

## Fondamenta Necessarie

- [x] Schema `analysis.version`: ogni analisi dichiara versione (2) e analyzer
  (`par8dj-mixengine-v2`).
- [x] Compatibilita con analisi vecchie: il frontend fa fallback quando mancano
  i campi nuovi (candidati/timeline/phraseGrid), nessun crash.
- [ ] Cache analysis versionata: indispensabile per iterare su librerie reali
  senza rianalizzare tutto.
- [ ] Vista debug analisi: BPM confidence, phrase grid, sezioni, cue, candidati,
  motivazioni e rischio voce.
- [ ] Test minimi su funzioni critiche: cue clamp, vocalOutro relativo, radio edit
  points, peek/commit della coda, validazione mixPoint.

## Backlog Strategico

- [ ] Embedding musicale per vibe/timbro/mood oltre BPM/key.
- [ ] Scorer ML/XGBoost solo dopo aver raccolto feedback umano su transizioni.
- [ ] ONNX per sezioni/key/embedding solo dopo baseline DSP misurabile.
- [ ] Rubber Band/time-stretch offline per export o pipeline pre-render.
- [ ] Export set con ffmpeg.
- [ ] Electron/Tauri o backend file-picker per batch da cartella.
- [ ] EQ dinamico 24 bande Bark dopo aver stabilizzato il motore 3 bande.

## Gia Stabilizzato

- [x] Fallback `Radio edit` senza ricorsione.
- [x] Toggle `Radio edit` rispettato dal player.
- [x] `vocalOutro` trattato come durata relativa, non timestamp assoluto.
- [x] Transizioni live transazionali: peek del prossimo brano e commit solo dopo
  `play()` riuscito.
- [x] Fine brano/errori media non lasciano la UI in stato live incoerente.
