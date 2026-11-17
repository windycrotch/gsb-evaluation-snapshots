# Log

Registro append-only in stile LLM Wiki (Karpathy). Una riga di intestazione per
evento, prefisso coerente `## [AAAA-MM-GG] tipo | titolo`, così è filtrabile con
strumenti unix. Non riscrivere le voci passate: si aggiunge in fondo.

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
