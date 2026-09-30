# Mappa dei Protocolli

Il flusso di lavoro dello studio come mappa interattiva. Ogni fase apre i suoi protocolli e le sue procedure. I collaboratori vedono solo le fasi autorizzate e leggono i documenti in sola lettura, con filigrana nominativa. Un assistente AI risponde alle domande usando solo i documenti.

- **/**: area di lettura per i collaboratori
- **/admin**: area amministratore (flussi, documenti, collaboratori e permessi)
- **/login**: accesso con nome utente e password

## Messa online su Render

1. Su [render.com](https://render.com) entra con il tuo account GitHub.
2. Scegli **New → Blueprint** e seleziona questo repository. Render legge `render.yaml` e crea il sito e il database.
3. Render ti chiede i valori da inserire:
   | Impostazione | Cosa mettere |
   |---|---|
   | `ADMIN_USERNAME` | il nome utente dell'amministratore, per esempio `giancarlo` |
   | `ADMIN_PASSWORD` | una password lunga, almeno 12 caratteri |
   | `AI_PROVIDER` | `gemini`, `openai` oppure `anthropic` |
   | `GEMINI_API_KEY` / `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` | la chiave del fornitore scelto; le altre due restano vuote |
4. Premi **Apply**. Dopo qualche minuto il sito è online all'indirizzo che Render ti mostra (`https://mappa-protocolli-xxxx.onrender.com`).
5. Apri `/admin`, entra con le credenziali del punto 3 e crea gli accessi dei collaboratori da **Collaboratori**.

Al primo avvio l'app carica il flusso "Percorso paziente" e alcuni documenti di esempio, segnati come "Esempio". Puoi modificarli o eliminarli.

### Cambiare le credenziali dell'amministratore
Su Render apri il servizio, poi **Environment**. Modifica `ADMIN_USERNAME` o `ADMIN_PASSWORD` e salva: il servizio si riavvia e le nuove credenziali valgono subito. Le credenziali non stanno mai nel codice su GitHub.

### Cambiare l'assistente AI
Sempre in **Environment**: cambia `AI_PROVIDER` e inserisci la chiave del nuovo fornitore. Con `AI_MODEL` scegli un modello diverso da quello predefinito:

| Fornitore | Dove si prende la chiave | Modello predefinito |
|---|---|---|
| gemini | aistudio.google.com | `gemini-2.5-flash` |
| openai | platform.openai.com | `gpt-4.1-mini` |
| anthropic | console.anthropic.com | `claude-sonnet-5-5` |

I nomi dei modelli cambiano nel tempo: se l'assistente risponde con un errore, controlla sul sito del fornitore il nome di un modello attuale e mettilo in `AI_MODEL`.

### Come l'assistente trova le risposte
- **Pochi documenti** (fino a 20, modificabile con `RAG_THRESHOLD`): l'assistente li legge tutti a ogni domanda.
- **Più documenti**: ogni documento viene diviso in brani e indicizzato quando lo salvi. A ogni domanda l'app cerca i brani più pertinenti in due modi insieme, **per parole** (con il database, gratis) e **per significato** (con le "impronte" calcolate da Gemini o OpenAI), e manda all'assistente solo i 10 migliori. Così costa circa 10 volte meno ed è più veloce.
- Se nella chat scegli a mano da 1 a 3 fonti, l'assistente le legge per intero.
- La ricerca per significato usa la chiave Gemini o OpenAI. Se usi Claude per la chat, aggiungi anche una chiave Gemini o OpenAI per le impronte; senza, la ricerca resta solo per parole. Si può forzare con `EMBED_PROVIDER` (`gemini` o `openai`) e `EMBED_MODEL`.
- Se cambi fornitore, al riavvio le impronte vengono ricalcolate da sole.

### Costi
Render fa pagare a parte il sito e il database. Il blueprint usa i piani più piccoli a pagamento, perché il database gratuito di Render ha una durata limitata e rischieresti di perdere i dati. I prezzi aggiornati sono su render.com/pricing. L'assistente AI si paga a consumo al fornitore scelto.

## Documenti
- **PDF**: si vede così com'è, pagina per pagina, con la filigrana. Il testo viene estratto per la ricerca e per l'assistente. I PDF scansionati (solo immagine) non hanno testo: per la ricerca e per l'assistente incolla il testo nel campo "Testo".
- **Word (.docx)**: viene convertito in testo modificabile.
- **Testo**: si scrive direttamente nell'app (`##` titolo, `-` elenco, `1.` passaggi, `>` nota, `**grassetto**`).

Se elimini una fase, i suoi documenti non vengono cancellati: l'amministratore li trova con la ricerca, segnati "fase eliminata", e può ricollegarli a un'altra fase.

## Sicurezza
- Password salvate cifrate (bcrypt); massimo 10 tentativi di accesso ogni 15 minuti.
- Ogni richiesta viene controllata sul server: un collaboratore non riceve mai documenti di fasi non autorizzate, nemmeno dall'assistente.
- I documenti non hanno pulsante di download, copia e tasto destro sono disattivati e ogni pagina mostra la filigrana con nome e data. Uno screenshot o una foto dello schermo restano comunque possibili: la filigrana serve a rendere riconoscibile chi ha diffuso un documento.
- Non inserire dati dei pazienti nei protocolli: il testo viene inviato al fornitore AI per rispondere alle domande.

## Provare sul computer (facoltativo)
Servono Node.js 20+ e PostgreSQL.
```bash
cp .env.example .env   # compila i valori
npm install
node --env-file=.env server.js
```
Poi apri http://localhost:3000
