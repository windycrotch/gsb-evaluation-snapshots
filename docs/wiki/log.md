# Log

Registro append-only in stile LLM Wiki (Karpathy). Una riga di intestazione per
evento, prefisso coerente `## [AAAA-MM-GG] tipo | titolo`, così è filtrabile con
strumenti unix. Non riscrivere le voci passate: si aggiunge in fondo.

## [2026-11-18] sessione | Finestra vocale euristica mai nulla + penalità mixPoint

Chiude il buco della catena degradata: senza Demucs `/analyze` restituiva
`firstVocalAt`/`lastVocalAt` nulli, quindi il frontend non aveva alcun confine
vocale per `entryPoint`/`mixPoint` e i tagli finivano su battute cantate.
Vedi [[analysis-mix-engine]], [[current-status]].

- `heuristic_vocal_bounds` deriva la finestra da `timeline.vocalRisk`: secondo
  con rischio > 0.5 **e** quota di banda vocale sopra il baseline quieto
  (25° percentile, +15% relativo e +2 punti). Il secondo criterio serve perché
  `vocalRisk` è normalizzato per brano e su rumore/strumentale piatto coprirebbe
  comunque 0..1.
- Nessuna evidenza → `(0, duration)`; valori clampati in `[0, duration]`,
  ordinati, mai `null`. Con Demucs riuscito i suoi estremi restano autoritativi
  (`vocalSource="demucs"`) e l'euristica interviene solo se mancano del tutto.
- `build_candidates` accetta `last_vocal_at` + `vocal_bounds_heuristic`: le
  battute cantate dentro la finestra vengono capped sotto la peggiore battuta
  pulita (`min(score, peggiore_pulita - 0.25, 0.2)`) con `reasons` leggibili.
  `cueIn`/`entryPoint` invariati; `introEnd` continua a snappare solo per
  `firstVocalAt` Demucs.
- `ANALYSIS_VERSION` 2→3 (`par8dj-mixengine-v3`); la cache scarta le voci con
  estremi nulli o `vocalSource` sconosciuto.
- Nuova suite `backend/tests/test_vocal_fallback.py` (14 test): audio sintetico
  3s silenzio + sezione vocale via `/analyze?stems=false`, brano di solo rumore,
  precedenza Demucs con stubs, contratto dei candidati e cache stantia.
  Verifica manuale: cueIn/entryPoint/entryPointField/introEnd identici a
  `version=2` sullo stesso file sintetico.

## [2026-06-06] sessione | Precisione intro/outro + voce Demucs

Lavoro guidato da feedback reale dell'utente ("parte a metà / esce a 2/3 / cantato
su cantato / override non risponde"). Vedi [[current-status]], [[analysis-mix-engine]].

- Cue-in = primo suono reale (RMS grezzo vs picco ~8%, non energia a percentili).
- Griglia a battute (4 beat) per entry/introEnd/mixPoint.
- mixPoint tardivo + senza voce; durata transizione limitata a intro entrante e a
  coda uscente → la canzone suona fino in fondo (niente taglio a 2/3).
- Segmentazione strutturale DSP (`structural_boundaries`: chroma+MFCC beat-sync,
  agglomerative) per snap di introEnd/outroStart.
- Voce autoritativa: Demucs sull'INTERO brano → `timeline.vocalRisk`
  (`vocalSource="demucs"`), stems ON di default, cache analisi versionata.
- Override manuale marker ripristinato (`bestCandidate`).
- Decisione: baseline DSP → Demucs → allin1 come step 2. Vedi [[decisions]],
  [[roadmap]].
- DA VALIDARE: l'utente non ha ancora provato il fix Demucs su brani reali.

## [2026-06-05] sessione | Pipeline di mix spiegabile (analysis v2)

Introdotta la pipeline v2 (`par8dj-mixengine-v2`): timeline 1s, candidati con
punteggio+motivazioni, phrase grid 16/32/64, loudness truePeak/lra/crest,
`plannedTransition` condivisa, pannello debug. Vedi [[analysis-mix-engine]].
