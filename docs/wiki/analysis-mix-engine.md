# Analisi e Mix Engine

## Problema principale

L'utente usa spesso brani non extended/radio edit. In questo caso l'automix non
può basarsi su outro lunghi: deve trovare punti musicali corretti e allineati a
beat/frase.

## Obiettivo

Creare una modalità `Radio Edit Mix Mode` che scelga automaticamente:

- `cueIn`: primo punto utile, non solo primo suono;
- `entryPoint`: ingresso del brano entrante su frase pulita;
- `mixPoint`: punto di uscita del brano corrente su fine frase/pre-break/outro naturale;
- `cueOut`: uscita prima di fade-out morto, cambio brusco o sezione non mixabile.

## Regole musicali desiderate

- Preferire boundary di frase a 8/16/32 beat.
- Evitare di entrare sopra una voce se anche l'uscente ha voce piena.
- Evitare mix durante drop/ritornello pieno se l'entrante parte carico.
- Per radio edit, meglio transizione breve ma precisa che crossfade lungo.
- Se la finestra è piccola, usare taglio musicale deciso ma sempre a tempo.

## Pipeline proposta

1. Calcolare una timeline a passi di 1-2 secondi:
   - RMS/energia;
   - onset/novelty;
   - beat strength;
   - low/mid/high;
   - presenza voce/stem density;
   - brightness/spettralità;
   - tension profile.
2. Allineare la timeline a beatgrid e phrase grid.
3. Generare candidati cue/entry/mix solo su boundary musicali.
4. Dare un punteggio a ogni candidato:
   - frase corretta;
   - energia coerente;
   - bassa densità vocale;
   - compatibilità BPM/key;
   - finestra intro/outro sufficiente.
5. Salvare nel JSON analisi sia il punto scelto sia i candidati scartati.
6. Produrre una `plannedTransition` con durata, curva, beatmatch, EQ strategy e
   motivazioni.
7. Visualizzare sulla waveform i punti scelti e, in debug, le motivazioni.

## Stato Implementazione

Pipeline spiegabile implementata (analysis `version=2`, analyzer
`par8dj-mixengine-v2`):

- `analysis.version` e fallback frontend per analisi vecchie (nessun crash).
- Timeline musicale a passi di 1s (`analysis.timeline`): `step`, `t` e array
  allineati `rms`, `onset`, `beatStrength`, `low/mid/high`, `brightness`,
  `vocalRisk`, `tension`. Il `vocalRisk` è ora autorevole: Demucs gira
  sull'INTERO brano (htdemucs, auto-split su CPU) e produce una timeline di
  presenza vocale per-secondo (RMS dello stem `vocals`, gate soft 0.06..0.40)
  allineata a `timeline.t`; `timeline.vocalSource` vale `"demucs"` quando
  disponibile, altrimenti `"heuristic"` (VAD flatness/centroid + banda
  200-4000Hz + energia come fallback, mai crash). Esposti a top-level
  `firstVocalAt`/`lastVocalAt`/`vocalSource`.
- Stem vocali ON di default (`AUTODJ_STEMS=0` per disattivare): la mappa vocale è
  sempre calcolata. `intro_end` preferisce la battuta prima di `firstVocalAt`
  quando il cantato apre il brano; il `mixPoint` rafforza l'evitamento voce (peso
  `(1-voce)` più alto + forte penalità se voce>0.5) così l'uscita non cade mai su
  una frase cantata (niente cantato su cantato) e l'ingresso resta su zona pulita.
- Cache analisi su file versionata (`~/.cache/par8dj-ai/analysis/<key>.json`,
  key = md5 dei byte del file + `ANALYSIS_VERSION` + stems/nostems): Demucs gira
  una sola volta per brano, scrittura/lettura best-effort (mai fatale).
- Phrase grid multi-risoluzione (`analysis.phraseGrid`): valuta 16/32/64 beat e
  sceglie la più coerente; restano `firstBeat`/`beatInterval`/`phraseAnchor` per
  retro-compatibilità.
- Candidati espliciti (`analysis.candidates`) per `cueIn`, `entryPoint`,
  `mixPoint`, `cueOut`, ognuno con `score` (0..1) e `reasons` in italiano,
  ordinati best-first; i campi singoli back-compat puntano al candidato migliore.
- Metriche loudness/dinamica: `truePeak`, `lra`, `crest`.
- `plannedTransition` assemblata nel frontend (`scoreTransition`/`planTransition`):
  `fromMixPoint`, `toEntryPoint`, `durationBeats`, `durationSeconds`, `curve`
  (power/smooth/cut), `beatmatch`, `eqStrategy`, `reasons`. La durata radio-edit è
  indipendente dal crossfade club.
- Player consuma la `plannedTransition` (entry/mix, durata, curva, EQ, beatmatch)
  con fallback al comportamento precedente; coda transazionale e gestione
  ended/error invariate.
- Pannello debug UI con candidati (punteggio+motivazioni) e motivazioni del piano.

### Precisione inizio/fine brano (priorità primaria)

Iterazione su feedback reale "parte a metà / esce a 2/3 / cantato su cantato":

- **Cue-in = primo suono reale**: rilevamento su RMS grezzo vs picco (~8%), non su
  energia normalizzata a percentili (che saltava gli intro più calmi del ritornello
  facendo partire il brano a metà). Punteggio dominato dall'anzianità.
- **Griglia a battute (4 beat)** per `entryPoint`, `introEnd` e `mixPoint`: le frasi
  16/32 beat erano troppo grosse per intro/outro corti e spingevano i punti dentro
  il corpo.
- **`introEnd`**: prima battuta dove entra voce/energia; l'entry resta nell'intro e
  la durata transizione è limitata a questa finestra (brano entrante non perso).
- **`mixPoint` tardivo e senza voce**: punteggio `0.45·(1-voce) + 0.4·lateness +
  0.15·(1-tensione)`, ancorato vicino a `cueOut` (lascia ~4 battute per l'overlap).
  In `planTransition` la durata è limitata anche alla coda del brano uscente, così
  il crossfade finisce con la canzone (niente taglio a 2/3).
- **Niente cantato su cantato**: uscita scelta su zona a bassa voce + ingresso
  nell'intro strumentale; su clash residuo, power breve con mid-duck (mai taglio).
- **Sezioni colorate**: l'intro colorato usa l'`introEnd` reale; guard anti-falso
  `break` su corpi a energia piatta.
- **Override manuale ripristinato**: `bestCandidate` ora preferisce il campo singolo
  (`analysis.entryPoint/mixPoint/...`) aggiornato dal trascinamento marker, con
  fallback al candidato del backend.

Da consolidare:

- testare su radio edit reali e annotare le correzioni manuali;
- segmentazione strutturale (intro/build/drop/outro) più robusta su brani veri;
- cache analisi versionata lato backend;
- usare chroma locale + crest/LRA nello scoring.

## Idee Valide Da AI-DSP-REVOLUTION

Da considerare centrali:

- `analysis.version`: serve prima di cache, migrazioni e campi nuovi.
- Cue-in professionale: fondere RMS, onset strength e spectral flux.
- Timeline compatta: base comune per candidati, debug e tension profile.
- VAD leggero: rischio vocale su tutto il brano senza pagare Demucs completo.
- True peak, LRA e crest factor: non decidono il brano, ma aiutano durata fade,
  limiter e percezione di volume.
- Metadata tag scanning: utile come indizio per BPM/key/genre, non come fonte
  autorevole.
- Test suite di brani problematici: ambient senza beat, acapella, tempo variabile,
  radio edit corto, intro rumorosa.
- Planned transition: una decisione unica condivisa tra scoring, UI e player.

Da tenere in backlog:

- ONNX/embedding/key neurale: prima serve baseline DSP misurabile.
- XGBoost scorer: prima servono dati di feedback umano.
- Rubber Band/ffmpeg export/batch cartella: richiedono pipeline offline o app desktop.

## IA / ML

Non iniziare da IA generativa o black box. Prima usare pipeline ibrida:

- DSP classico per beat, energia, onset;
- Essentia/librosa per feature musicali;
- Demucs opzionale per voce/stems;
- euristiche leggibili e modificabili.

Modelli ML utili più avanti:

- embeddings Essentia/TensorFlow per vibe/mood;
- modello di downbeat dedicato;
- modello di segmentation strutturale se le euristiche non bastano.

## Prossime Idee Da Raffinare

1. Quali feature minime deve avere la timeline per scegliere bene i punti.
2. Come punteggiare i candidati senza creare una black box.
3. Come rappresentare `plannedTransition` in modo leggibile.
4. Quale test set musicale usare per giudicare se il mix migliora davvero.
5. Dove finisce la modalita radio edit e dove inizia la modalita club/extended.
