# Par8DJ AI — LLM Wiki (indice)

Indice operativo in stile LLM Wiki (Karpathy): le fonti grezze restano separate,
la wiki Markdown contiene lo stato **compilato** e aggiornato dall'LLM. Questa
pagina si legge **per prima**: una riga per pagina. Va aggiornata a ogni modifica.

## Wiki compilata (`docs/wiki/`)

- [current-status](./wiki/current-status.md) — cosa funziona, problemi noti, prossima priorità.
- [analysis-mix-engine](./wiki/analysis-mix-engine.md) — cuore del progetto: analisi e scelta dei punti di mix (intro/outro), stato implementazione.
- [decisions](./wiki/decisions.md) — decisioni tecniche e perché (radio edit, IA pragmatica, DSP→Demucs→allin1).
- [roadmap](./wiki/roadmap.md) — focus tecnico e onde successive.
- [todo](./wiki/todo.md) — mappa delle idee tecniche per la qualità del mix.
- [log](./wiki/log.md) — registro append-only delle sessioni (`## [data] tipo | titolo`).

## Schema / protocollo

- [llm-wiki-protocol](./llm-wiki-protocol.md) — regole operative del wiki (leggere prima di lavorare, dove finiscono decisioni/stato).
- [AI-DSP-REVOLUTION](./AI-DSP-REVOLUTION.md) — visione AI/DSP di lungo periodo.
- [SUGGERIMENTI-ANALISI](./SUGGERIMENTI-ANALISI.md) — idee/appunti sull'analisi.

## Fonti grezze (`docs/raw/`, immutabili)

- [raw/sources.md](./raw/sources.md) — fonti/link di riferimento.
- [raw/session-notes-2026-06-04.md](./raw/session-notes-2026-06-04.md) — note grezze di sessione.

## Struttura

- `docs/raw/`: materiale grezzo, fonti, transcript, appunti non rifiniti (verità, non si riscrive).
- `docs/wiki/`: conoscenza compilata, deduplicata, aggiornata.
- `STATO.md`: handoff rapido della sessione corrente.
- `README.md`: panoramica pubblica e avvio.

Regola: ogni decisione tecnica importante finisce in `docs/wiki/decisions.md` (o
nella pagina pertinente) e una riga in `docs/wiki/log.md`, non solo nella chat.
