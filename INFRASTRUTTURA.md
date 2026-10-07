# App del gruppo To Smile — come sono collegate

Promemoria unico per chi lavora sulle app del gruppo (aggiornato il 6 ottobre 2026).
Tutte le app sono su **Render** (workspace "Giancarlo's workspace"), il codice è su **GitHub** nell'organizzazione `gbservices2018srl-cloud`, il dominio `appgestione.it` è su **Aruba**.

## Indirizzi

| App | Indirizzo | Area admin | Servizio Render | Repository |
|---|---|---|---|---|
| Pagina con i riquadri | appgestione.it · www.appgestione.it | — | `portale-appgestione` (sito statico) | `Know-How-Academy`, cartella `portale/` |
| Gestione finanziaria | finanza.appgestione.it (si apre su `/finanziario`) | `/admin` → "Pannello Master" | `APP-Gestione-Finanziaria` (Python, piano Starter, disco 1 GB) | `APP-Gestione-Finanziaria` (codice in `server/`) |
| Nuovalab (laboratorio) | laboratorio.appgestione.it | `/admin` → accesso, l'area admin si apre col ruolo ADMIN | `App-Nuova-lab` (sito statico, dati su Supabase) | `App-Nuova-lab` |
| Ticket assistenza | ticket.appgestione.it (si apre su `/ticketassistenza`) | `/admin` → accesso, poi pannello in base al ruolo (super_admin / admin_azienda) | `app-ticket-assistenza` (Next.js, Frankfurt, dati su Supabase) | `app-ticket-assistenza` |
| Protocolli | protocolli.appgestione.it | `/admin` | `mappa-protocolli` (Node, piano gratuito) — **lo stesso servizio fa girare anche il Calendario** | `Know-How-Academy` |
| Calendario eventi | calendario.appgestione.it (**da collegare**: CNAME su Aruba verso `mappa-protocolli.onrender.com` e dominio aggiunto al servizio `mappa-protocolli`) | `/admin` → accesso | `mappa-protocolli` (lo stesso dei Protocolli); il vecchio servizio `calendario-eventi` va eliminato dopo il collegamento | `Know-How-Academy`, cartella `calendario/` (il repository `app-calendario-eventi` non si usa più) |
| Radiografia studio | radiografia-studio.onrender.com | — | `radiografia-studio` (Python) | `app-radiografia-studi-dentalia` |

I vecchi indirizzi `www.appgestione.it/finanziario`, `/ticketassistenza` e `/laboratorio` portano da soli ai nuovi sottodomini.

## DNS su Aruba (appgestione.it)

| Nome | Tipo | Valore |
|---|---|---|
| `@` | A | `216.24.57.1` (Render) |
| `www` | CNAME | `portale-appgestione.onrender.com` |
| `finanza` | CNAME | `app-gestione-finanziaria.onrender.com` |
| `laboratorio` | CNAME | `app-nuova-lab.onrender.com` |
| `ticket` | CNAME | `app-ticket-assistenza.onrender.com` |
| `protocolli` | CNAME | `mappa-protocolli.onrender.com` |
| `calendario` | CNAME | `mappa-protocolli.onrender.com` (da aggiungere) |

Per ogni nuovo sottodominio: record CNAME su Aruba **e** "Custom Domains" nel servizio su Render. Il piano Hobby di Render include 2 domini personalizzati; ogni dominio in più costa 0,25 $ al mese.

## Database

- **`mappa-protocolli-db`** (PostgreSQL a pagamento, 1 GB, circa 6,30 $/mese, nessuna scadenza): usato da Protocolli (schema `mappa`) e Calendario eventi (schema `calendario`).
- **`radiografia-db`** (PostgreSQL gratuito): **scade il 29 ottobre 2026** e viene cancellato con i dati circa 14 giorni dopo, se non si passa a un piano a pagamento.
- Ticket assistenza e Nuovalab usano **Supabase**.
- Gestione finanziaria salva i dati sul disco del suo servizio (`/var/data`).

## Credenziali degli amministratori

Protocolli e Calendario: `ADMIN_USERNAME` / `ADMIN_PASSWORD` nelle impostazioni **Environment** del servizio su Render (mai nel codice).

## Da fare

- Collegare `calendario.appgestione.it`: CNAME su Aruba verso `mappa-protocolli.onrender.com` e dominio nel servizio `mappa-protocolli`; poi eliminare il servizio `calendario-eventi`.
- Chiave AI per la chat dei Protocolli (`AI_PROVIDER` + chiave Gemini o OpenAI su Render) e nome del modello in `AI_MODEL`.
- Decidere su `radiografia-db` prima del 29 ottobre.

## Protocolli + Calendario in un solo servizio
`index.js` avvia le due app e smista ogni richiesta in base all'indirizzo: `calendario.appgestione.it` va al Calendario, tutto il resto ai Protocolli.
Le impostazioni del Calendario possono avere il prefisso `CAL_` (`CAL_ADMIN_USERNAME`, `CAL_ADMIN_PASSWORD`, `CAL_SESSION_SECRET`); se mancano usa quelle dei Protocolli, quindi l'amministratore è lo stesso.

## Come lavoriamo con Claude
- Una conversazione per app, ognuna solo sul proprio repository: Gestione finanziaria, Nuovalab, Ticket.
- La conversazione "principale" gestisce **Protocolli, Calendario eventi**, la pagina con i riquadri, i DNS su Aruba, le impostazioni Render condivise e il database.
- Gli indirizzi restano sottodomini (non percorsi tipo `appgestione.it/nomeapp`); l'area amministratori di ogni app resta su `/admin`.
- Prima di ogni modifica: `git pull`.
