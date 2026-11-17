# Protocollo LLM Wiki

Ispirato al pattern LLM Wiki di Karpathy: non usare l'LLM solo per rispondere in
chat, ma per compilare conoscenza persistente in Markdown.

## Principio

- Le fonti grezze sono la verità.
- La wiki è la sintesi aggiornata.
- Il codice è un artefatto eseguibile che deve restare coerente con la wiki.

## Cartelle

- `docs/raw/`: materiale grezzo e note non curate.
- `docs/wiki/`: pagine compilate, decisioni e stato corrente.
- `docs/WIKI.md`: indice.

## Regole operative

1. Prima di lavorare su una parte già progettata, leggere la pagina wiki relativa.
2. Quando cambia una decisione, aggiornare `docs/wiki/decisions.md`.
3. Quando cambia lo stato del progetto, aggiornare `docs/wiki/current-status.md`.
4. Quando si aggiungono fonti o note grezze, metterle in `docs/raw/` e poi compilarle nella wiki.
5. Non fidarsi della chat come memoria stabile.

## Quando aggiornare

- Fine sessione.
- Cambio architetturale.
- Nuova ipotesi tecnica importante.
- Bug grosso risolto.
- Decisione su engine analisi/mix.

## Fonti

Il concetto pubblico viene descritto come pipeline `raw sources -> wiki Markdown
compilata -> codice/risposte`, con writeback obbligatorio delle decisioni.
