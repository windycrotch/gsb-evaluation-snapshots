# Par8DJ AI — stato del lavoro (handoff)

Documento per riprendere il lavoro più avanti. Aggiornato durante la sessione di
sviluppo con Claude.

## Come avviare

Due server (uno per la UI, uno per l'analisi):

```bash
cd /root/auto-dj-ai
npm run backend     # FastAPI su 127.0.0.1:8765  (analisi Essentia/librosa/Demucs)
# in un secondo terminale:
npm start           # UI statica su 127.0.0.1:5173
```

Apri `http://127.0.0.1:5173`. Per l'analisi vocale Demucs (lenta su CPU):
`AUTODJ_STEMS=1 npm run backend` oppure `POST /analyze?stems=true`.

Web MIDI e analisi avanzata richiedono `localhost`/`127.0.0.1` (contesto sicuro).

> NB: durante lo sviluppo i server giravano in background. Se la porta 8765/5173
> risulta occupata, killa il vecchio processo (`pkill -f "uvicorn backend.app"`,
> `pkill -f "http.server 5173"`) e riavvia.

## File principali

- `src/index.html` — markup UI (titolo **Par8DJ AI**)
- `src/styles.css` — skin "2026" (aurora animata, vetro lucido, neon, riflessi)
- `src/main.js` — stato app, libreria/coda, scrubber due deck, scoring, MIDI, persistenza
- `src/player.js` — motore audio Web Audio (2 deck, transizioni, EQ, beatmatch, limiter)
- `src/analyzer.js` — fallback analisi via Web Audio (quando il backend non c'è)
- `src/db.js` — persistenza IndexedDB (libreria + coda)
- `src/midi.js` — Web MIDI (input + describe message)
- `backend/app.py` — analisi: BPM, key/Camelot, energia, loudness EBU R128, beat grid, frasi, sezioni musicali, bande spettrali
- `backend/stems.py` — Demucs: voce in intro/outro (vocalIntro/vocalOutro/density)
- `backend/selfcheck.py` — check dipendenze

## Funzioni già implementate e verificate

### Analisi (backend, `analyzer "essentia-musicextractor-v2"`)
- BPM + confidenza, normalizzazione ottave
- Tonalità con **voto di maggioranza** 3 profili Essentia → **Camelot**
- **Energia** mappata in dBFS (−28→0, −6→1) — FIX: prima saturava a 100%
- **Loudness EBU R128** (LUFS) → campo `loudnessLufs` + `gain`
- **Beat grid**: `firstBeat`, `beatInterval`
- **Downbeat + frasi** (16 beat): `downbeat`, `barInterval`, `phraseAnchor`, `phraseInterval`, `beatsPerPhrase` (euristica onset + novelty MFCC; niente madmom su Py3.13)
- **Bande spettrali** low/mid/high normalizzate (`bandEnergy`)
- **Voce intro/outro** via Demucs (opzionale): `vocals.vocalIntro/vocalOutro/density`
- **Sezioni musicali** (`sections`): intro/build/drop/break/body/outro stimate da energia, onset, brightness spettrale, cue e frase.
- **Pipeline mix spiegabile (analysis `version=3`, analyzer `par8dj-mixengine-v3`)**:
  - `analysis.timeline` (passi 1s): `rms`, `onset`, `beatStrength`, `low/mid/high`, `brightness`, `vocalRisk` (VAD euristico sempre attivo), `tension`.
  - `firstVocalAt`/`lastVocalAt` sempre non-null: da Demucs se disponibile (`vocalSource="demucs"`, autoritativo), altrimenti euristici (`vocalSource="heuristic"`); nessuna evidenza vocale → `[0, duration]`.
  - `mixPoint`: le battute cantate dentro la finestra vocale vengono portate sotto ogni battuta pulita vicina, con `reasons` esplicite.
  - `analysis.phraseGrid`: phrase grid multi-risoluzione 16/32/64 beat con punteggio.
  - `analysis.candidates` (`cueIn/entryPoint/mixPoint/cueOut`): candidati con `score` e `reasons` in italiano; i campi singoli back-compat restano popolati.
  - `truePeak`, `lra`, `crest` oltre a `loudnessLufs`/`gain`.

### Player (`src/player.js`)
- 2 deck, catena: `source → EQ(low/mid/high) → trim → fader → analyser → masterGain → limiter → output`
- **Curve crossfader selezionabili**: `Power` (default equal-power, evita il buco al centro), `Smooth` (constant-sum morbida), `Cut` (taglio rapido stile scratch).
- **Crossfade automatico più lento** per tipo di brano (16/32/48 beat per energia), cap = valore campo Crossfade.
- **Guardia anti-mix precoce**: l'automix non parte prima di circa il 78% del brano, salvo `mixPoint` manuale.
- **Beatmatch simmetrico** a pitch costante: i due brani si incontrano al tempo medio (media geometrica), poi l'entrante torna al nativo (glide). Tolleranza regolabile (slider).
- **EQ 3 bande swap** durante la transizione, in base all'overlap spettrale (bass swap sempre)
- **Partenza allineata alla frase**; **entry point** del brano entrante auto-scelto e modificabile (campo `entryPoint`, vedi sotto)
- **Normalizzazione loudness per-traccia** a runtime dal LUFS (target −14, boost fino a +12 dB; il limiter protegge dal clipping)
- **Limiter master** (`leveler`, toggle "livella volume") per volume costante
- **Override manuale al tocco** (per controller MIDI): crossfader manuale (`setManualCrossfade`, si auto-orienta), EQ manuali (`setManualEq`), jog nudge (`nudge`). L'auto-DJ riprende al termine.
- Seek (`seek`), report progresso (`onProgress`)

### UI (`src/main.js` + index.html)
- Import file, **libreria + playlist** editabili, drag riordino, elimina (🗑)
- **Persistenza IndexedDB**: file audio + analisi + coda sopravvivono al refresh; ripristino all'avvio (`restoreLibrary`)
- **Analisi sequenziale**: la UI analizza un brano alla volta perché Essentia è CPU-heavy e il backend locale ha un solo worker; timeout backend 45s con fallback Web Audio.
- **Start non bloccato dall'analisi**: il primo brano può partire anche se non è ancora `ready`; l'analisi serve per automix/smart, non per il play base. `audio.play()` ha timeout diagnostico.
- **Scelta smart** del prossimo brano: `scoreTransition` (BPM ottave, Camelot pesata per confidenza, curva energia, finestre mixabili, anti-clash vocale)
- Toggle **Radio edit**: prima passata UI/backend per preferire punti `entryPoint`/`mixPoint` piu adatti a radio edit/non extended.
- **"Ordina set"**: nearest-neighbor sullo score, con **arco di energia** opzionale (apertura calma → picco → chiusura). Picco e peso regolabili (slider).
- **Due deck A/B** con waveform alta stile DJ: A = in onda/seekabile; B = prossimo brano, cue editabili. L'onda è continua/interpolata ad alta risoluzione, colorata per sezioni musicali e mantiene beat/battute/frasi sovrapposte per leggere il BPM.
- **Cue editabili sulla griglia BPM** (snap al beat): cue-in, cue-out, mix point. Marker trascinabili.
- **Deck B entry point automatico** (marker verde): la prima frase pulita dopo la cue-in; trascinabile per override; **doppio clic = torna automatico** (campo `analysis.entryPoint`)
- **VU meter** in dBFS con peak-hold; **scrubber** con waveform, marker e griglia
- **MIDI** con **MIDI Learn** (pannello in fondo): Start/Stop/Skip/Ordina, Crossfade/Tolleranza, Crossfader manuale, EQ Bassi/Medi/Alti, Jog. Bindings salvati in `localStorage`.
- **Deck B fedele alla scelta smart**: anteprima Deck B, highlight in playlist, transizione automatica e crossfader manuale usano lo stesso selettore del prossimo brano.
- **Transizioni piu sicure per live**: il player fa `peek` del prossimo brano e
  aggiorna la coda solo dopo che il deck entrante e partito; se `play()` fallisce,
  il mix viene annullato senza corrompere la playlist.
- **Gestione fine/errori deck**: `ended` e `error` non lasciano la UI bloccata in
  stato "in onda" quando non c'e piu audio.

### Skin
- Tema **Chrome Edition satinato**: acciaio spazzolato realistico ma non abbagliante, cornici hardware, display neon/LCD, pulsanti fisici glossy attenuati, deck panel più da mixer, waveform incassata, meter luminosi e playlist con finiture metalliche. Rispetta `prefers-reduced-motion`.

## Hardware utente
- Controller: **Hercules DJControl Inpulse 200** (USB class-compliant → Web MIDI lo vede).
- Setup: collega via USB, chiudi DJUCED, dai permesso MIDI al browser, poi MIDI Learn.
- Mappare: pad → comandi; fader/crossfader (assoluti) → knob; jog (relativo) → voce Jog.

## Punti aperti / prossimi passi possibili

### Ripartenza prossima sessione: consolidare Radio Edit Mix Mode

Priorità concordata: migliorare analisi e motore mix per brani **non extended**.
Con radio edit/versioni corte non basta aspettare l'outro: bisogna beccare il
punto giusto su battuta/frase, perché la finestra utile è piccola.

Stato al 2026-06-06 (fine sessione serale): implementata la pipeline di mix
spiegabile (analysis v2) + due iterazioni su feedback reale.

Fatto in questa sessione:
- Pipeline spiegabile: timeline musicale 1s, candidati con punteggio+motivazioni,
  phrase grid 16/32/64, metriche loudness (truePeak/lra/crest), `plannedTransition`
  (entry/mix/durata/curva/beatmatch/EQ/motivazioni) consumata dal player, pannello
  debug UI.
- Precisione INIZIO brano: cue-in = primo suono reale (RMS grezzo vs picco ~8%,
  non energia a percentili che faceva partire a metà); griglia a BATTUTE (4 beat)
  per entry/introEnd; entry resta nell'intro; durata transizione limitata alla
  finestra d'intro entrante (brano non perso).
- Precisione FINE brano: mixPoint tardivo (vicino a cueOut) e su zona senza voce;
  durata limitata anche alla coda del brano uscente → il crossfade finisce con la
  canzone (niente taglio a 2/3).
- Segmentazione strutturale DSP (`structural_boundaries`: chroma+MFCC beat-sync,
  agglomerative) per snap di introEnd/outroStart su cambi di sezione reali.
- VOCE affidabile: Demucs gira sull'INTERO brano → `timeline.vocalRisk`
  autoritativo (`vocalSource="demucs"`), `firstVocalAt`/`lastVocalAt`. mixPoint con
  penalità forte se voce>0.5 → contro il cantato-su-cantato. Stems ON di default
  (`AUTODJ_STEMS=0` per disattivare). CACHE analisi versionata su file
  (`~/.cache/par8dj-ai/analysis/`): Demucs una sola volta per brano.
- Override manuale marker ripristinato (`bestCandidate` preferisce il campo singolo).

DA VALIDARE alla ripartenza: l'utente ha segnalato (prima del fix Demucs) ancora
"cantato su cantato" e "in/out sbagliate". Il fix Demucs full-track è stato
implementato e verificato in-process ma NON ancora provato dall'utente su brani
reali. PRIMO PASSO prossima sessione: riavviare backend, ri-analizzare 2-3 brani
reali (la 1ª analisi è lenta: Demucs su CPU ~1-2× durata, poi cache istantanea) e
giudicare voce + punti intro/outro.

STEP 2 concordato se la STRUTTURA intro/outro è ancora imprecisa dopo Demucs:
integrare **allin1** (analizzatore di struttura neurale: intro/verse/chorus/outro
+ downbeat) in un **servizio Python 3.11 separato** (non si installa su 3.13).
L'utente ha esplicitamente accettato la manutenzione pesante per più qualità.
Nota: allin1 NON dà attività vocale → la voce resta su Demucs.

Obiettivo della modalità:

- cue-in non uguale al primo suono, ma al primo punto musicalmente utile;
- entry point del brano entrante su frase pulita, meglio 8/16/32 beat prima del punto forte;
- mix point del brano uscente su fine frase/pre-break/outro naturale, non su drop o voce piena;
- transizioni più corte ma precise, allineate a beat/frase;
- evitare sovrapposizione vocale quando possibile;
- visualizzare sulla waveform i candidati scelti e la motivazione.

Todo fattibile nello stack attuale:

1. correggere e verificare i fallback della prima passata `Radio edit`;
2. creare una timeline interna a passi di 1-2 secondi con energia, onset/novelty, low/mid/high, presenza voce, beat strength;
3. derivare phrase grid più robusta (16/32/64 beat) e candidate boundaries;
4. scegliere cue/entry/mix solo tra boundary musicali, con punteggio leggibile;
5. visualizzare sulla waveform candidati scelti/scartati e motivazione;
6. testare su 10-20 radio edit reali e annotare le correzioni manuali.

Nota: non partire da IA generativa da zero. Strategia pragmatica: DSP + Essentia
+ Demucs/stems + euristiche musicali ispezionabili; eventuali modelli ML per
segmentazione/embeddings solo dopo.

Altri task realistici:

1. **Regolabili da UI**: target loudness (−14) e aggressività del limiter; eventuale **VU master**.
2. **Phrase detection** più robusta (16/32/64 beat) senza cambiare ambiente Python.
3. Persistenza/cache dell'analisi anche lato backend (SQLite) per non rianalizzare.
4. Chroma similarity, crest factor e tension profile nello scoring.
5. Preset MIDI per Hercules DJControl Inpulse 200.

Rimandati perché richiedono cambio architetturale o dipendenze dedicate:

1. **Modalità batch da cartella**: meglio con backend file-picker o Electron/Tauri.
2. **Export set in un unico file (ffmpeg)**: serve timeline render offline separata.
3. **Time-stretch** di qualità con Rubber Band: serve pipeline offline/pre-render.
4. **Downbeat** con modello dedicato madmom: richiede venv Python ≤3.11.

## Note tecniche / gotcha

- L'energia dei brani **già analizzati prima del fix** resta salvata; la normalizzazione loudness invece si ricalcola a runtime dal `loudnessLufs` salvato (quindi i brani già analizzati col backend vengono livellati senza reimport).
- madmom NON installato (no wheel per Python 3.13). Downbeat/frasi via euristica librosa.
- `torchaudio.load` richiede TorchCodec in questa versione → in `stems.py` si usa `demucs.audio.AudioFile` (ffmpeg).
- Demucs `4.0.1`: API `get_model`/`apply_model` (non `demucs.api`).
- `vocals.vocalOutro` / `outroVocalFreeSeconds` sono durate relative della coda
  libera da voce, non timestamp assoluti.
