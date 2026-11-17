# Decisioni

## LLM Wiki

Decisione: usare un wiki in stile Karpathy/LLM Wiki, non solo documentazione
manuale classica.

Motivo: il progetto evolve per iterazioni lunghe; le decisioni non devono restare
nella chat. La wiki deve accumulare conoscenza compilata.

## Radio Edit Come Caso Principale

Decisione: ottimizzare il mix engine per brani non extended/radio edit.

Motivo: l'utente usa raramente versioni extended. Le finestre di mix sono corte,
quindi cue, entry e mix point devono essere scelti su frase/battuta corretta.

Aggiornamento 2026-06-05: la modalita `Radio edit` va sviluppata in modo
incrementale nello stack attuale. Prima si consolidano euristiche, candidati e
debug visivo; solo dopo si valutano modelli ML o rendering offline.

## Scope Realistico

Decisione: la todo primaria contiene solo task realizzabili con browser, Web Audio
e backend FastAPI locale.

Rimandati: batch da cartella, export ffmpeg completo, Rubber Band offline e madmom,
perche richiedono shell desktop, pipeline render dedicata o ambiente Python diverso.

## Transizioni Live Transazionali

Decisione: il player deve poter chiedere il prossimo brano senza modificare la
playlist. La coda viene aggiornata solo dopo che il deck entrante ha superato
`play()`.

Motivo: in uso pubblico un file non riproducibile, un timeout o un errore media
non devono bloccare il player in `isTransitioning` ne rimuovere il brano dalla
playlist prima che il mix sia realmente iniziato.

## IA Pragmatica, Non Black Box

Decisione: non partire da IA generativa da zero per scegliere i punti.

Approccio:

- DSP/Essentia/librosa per beat, energia, onset, sezioni;
- Demucs opzionale per voce/stems;
- euristiche musicali ispezionabili;
- modelli ML solo se servono per downbeat/segmentation/embeddings.

## Idee Prima Del Codice

Decisione: per la fase di professionalizzazione, la wiki deve guidare prima le
idee tecniche e solo dopo l'implementazione.

Motivo: aggiungere funzioni senza una teoria chiara del mix produce complessita
non misurabile. Il sistema deve diventare spiegabile: per ogni transizione deve
essere chiaro perche ha scelto quel brano, quel punto e quella curva.

Principio operativo:

- timeline musicale interna;
- candidati multipli con motivazioni;
- `plannedTransition` unica condivisa da scoring, UI e player;
- test set reale per verificare miglioramenti.

## Platter/Scratch

Decisione: implementare uno scratch browser base.

Limite: HTML audio non riproduce davvero reverse audio continuo; lo scratch sposta
`currentTime` mentre il deck è in hold.
