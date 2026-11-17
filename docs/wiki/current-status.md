# Stato Corrente

## Sintesi

Par8DJ AI è un prototipo locale browser + backend Python per automazione radio/DJ.
La UI funziona, il player a due deck funziona, la waveform è stata resa più robusta,
e il pulsante Start è stato ripristinato con stati visivi chiari. È stata
implementata la pipeline di mix spiegabile (analysis v2): timeline musicale,
candidati di mix con punteggio e motivazioni, phrase grid multi-risoluzione,
vocal risk sempre attivo e `plannedTransition` condivisa tra scoring, UI e player.

## Funziona

- Import file locali.
- Persistenza IndexedDB di libreria, file e analisi.
- Backend Essentia/librosa con Demucs opzionale.
- Player Web Audio a due deck.
- Crossfade con curve selezionabili.
- Beatmatch browser a pitch costante.
- Waveform alta con sezioni colorate.
- Cue marker editabili.
- Start anche con analisi non pronta.
- Platter/scratch browser grezzo ma funzionante.
- Toggle `Radio edit` presente nella UI.
- Backend produce `analysis.version=2` (analyzer `par8dj-mixengine-v2`).
- Timeline musicale a passi di 1s: `rms`, `onset`, `beatStrength`, `low/mid/high`,
  `brightness`, `vocalRisk` (VAD euristico sempre attivo, senza Demucs) e `tension`.
- Candidati di mix espliciti (`candidates.cueIn/entryPoint/mixPoint/cueOut`) con
  `score` e `reasons` in italiano, ordinati best-first; i campi singoli back-compat
  restano popolati dal candidato migliore.
- Phrase grid multi-risoluzione (`phraseGrid`): valuta 16/32/64 beat e sceglie la
  griglia più coerente per il brano.
- Loudness/dinamica: `truePeak`, `lra`, `crest` oltre a `loudnessLufs`/`gain`.
- `plannedTransition` assemblata nel frontend (`scoreTransition`/`planTransition`):
  entry/mix, durata in beat, curva, beatmatch, EQ strategy e motivazioni.
- Player consuma `plannedTransition` quando disponibile (entry/mix/durata/curva/
  EQ/beatmatch), con fallback al comportamento precedente.
- Pannello debug nella UI che elenca candidati con punteggio+motivazioni e le
  motivazioni della `plannedTransition`.
- La coda live ora viene aggiornata solo dopo che il deck entrante e partito:
  le transizioni fallite non rimuovono piu brani dalla playlist.
- Il player gestisce `ended`/`error` sui deck e non lascia la UI in stato live
  quando non c'e piu audio.

## Problemi noti

- `truePeak` può restare `null` quando Essentia non espone il descrittore (proxy
  da momentary loudness); non blocca nulla.
- Vocal risk è euristico: Demucs lo raffina solo nelle zone intro/outro.
- Phrase/downbeat detection ancora senza modello dedicato (no madmom su Py3.13).
- UI platter esteticamente grezza.
- Time-stretch browser non è qualità Rubber Band.
- Manca ancora la cache analisi versionata lato backend (SQLite).

## Prossima priorità

- Testare la pipeline su 10-20 radio edit reali e annotare le correzioni manuali.
- Cache analisi versionata (`analysis.version`) lato backend per non rianalizzare.
- Chroma locale e crest/LRA nello scoring delle transizioni.
