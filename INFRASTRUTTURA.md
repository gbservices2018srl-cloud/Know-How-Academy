# App del gruppo To Smile — come sono collegate

Promemoria unico per chi lavora sulle app del gruppo (aggiornato il 7 ottobre 2026).
Tutte le app sono su **Render** (workspace "Giancarlo's workspace"), il codice è su **GitHub** nell'organizzazione `gbservices2018srl-cloud`, il dominio `appgestione.it` è su **Aruba**.

## Indirizzi

| App | Indirizzo | Area admin | Servizio Render | Repository |
|---|---|---|---|---|
| Accesso unico (login, registrazione, riquadri delle app) | appgestione.it (www → appgestione.it) | `/admin` → "Gestione accessi" | `appgestione-eu` (lo stesso di Protocolli e Calendario) | `Know-How-Academy`, cartella `accessi/` (la cartella `portale/` è la vecchia pagina statica) |
| Gestione finanziaria | finanza.appgestione.it (si apre su `/finanziario`) | `/admin` → "Pannello Master" | `APP-Gestione-Finanziaria` (Python, piano Starter, disco 1 GB) | `APP-Gestione-Finanziaria` (codice in `server/`) |
| Nuovalab (laboratorio) | laboratorio.appgestione.it | `/admin` → accesso, l'area admin si apre col ruolo ADMIN | `App-Nuova-lab` (sito statico, dati su Supabase) | `App-Nuova-lab` |
| Ticket assistenza | ticket.appgestione.it (si apre su `/ticketassistenza`) | `/admin` → accesso, poi pannello in base al ruolo (super_admin / admin_azienda) | `app-ticket-assistenza` (Next.js, Frankfurt, dati su Supabase) | `app-ticket-assistenza` |
| Protocolli | protocolli.appgestione.it | `/admin` | `appgestione-eu` (Node, Francoforte) — **lo stesso servizio fa girare anche il Calendario** | `Know-How-Academy` |
| Calendario eventi | calendario.appgestione.it | `/admin` → accesso | `appgestione-eu` (lo stesso dei Protocolli); il vecchio servizio `calendario-eventi` va eliminato dopo il collegamento | `Know-How-Academy`, cartella `calendario/` (il repository `app-calendario-eventi` non si usa più) |
| Magazzino centrale | magazzino.appgestione.it | stessa app: chi è Amministratore nel pannello accessi vede Richieste, Articoli, Riordino, Fornitori | `appgestione-eu` (lo stesso di Protocolli e Calendario) | `Know-How-Academy`, cartella `magazzino/` |
| Turni | turni.appgestione.it | stessa app: Amministratore = planning, richieste, personale, regole, sedi, buste paga; Utente = il dipendente (riconosciuto dall'email scritta nella sua scheda) | `appgestione-eu` | `Know-How-Academy`, cartella `turni/` |
| Radiografia studio | radiografia-studio.onrender.com | — | `radiografia-studio` (Python) | `app-radiografia-studi-dentalia` |

I vecchi indirizzi `www.appgestione.it/finanziario`, `/ticketassistenza` e `/laboratorio` portano da soli ai nuovi sottodomini.

## DNS su Aruba (appgestione.it)

| Nome | Tipo | Valore |
|---|---|---|
| `@` | A | `216.24.57.1` (Render) |
| `www` | CNAME | `appgestione-eu.onrender.com` |
| `finanza` | CNAME | `app-gestione-finanziaria.onrender.com` |
| `laboratorio` | CNAME | `app-nuova-lab.onrender.com` |
| `ticket` | CNAME | `app-ticket-assistenza.onrender.com` |
| `protocolli` | CNAME | `appgestione-eu.onrender.com` |
| `calendario` | CNAME | `appgestione-eu.onrender.com` |
| `magazzino` | CNAME | `appgestione-eu.onrender.com` |
| `turni` | CNAME | `appgestione-eu.onrender.com` |

Per ogni nuovo sottodominio: record CNAME su Aruba **e** "Custom Domains" nel servizio su Render. Il piano Hobby di Render include 2 domini personalizzati; ogni dominio in più costa 0,25 $ al mese.

## Database

**Trasloco in Europa (9 ottobre 2026, sera):** tutto è passato dal vecchio servizio `mappa-protocolli` + database `mappa-protocolli-db` (Oregon, USA) al nuovo servizio `appgestione-eu` + database `appgestione-db-eu` (Francoforte). Copia fatta con `lib/trasloco.js` (variabile `COPIA_DA`, ora vuota), verificata tabella per tabella: 56 tabelle, 830 righe, identiche. Il vecchio servizio è in manutenzione (`MANUTENZIONE=true`) e il vecchio database è intatto: si tengono come copia di sicurezza per almeno 1–2 settimane e si eliminano solo con l'OK del proprietario. La gestione finanziaria non è stata toccata.

**Trasloco Gestione finanziaria (14 ottobre 2026, 08:34–08:41):** dal vecchio `APP-Gestione-Finanziaria` (srv-d9tjv4v40ujc73eh59t0, Oregon, ora `MANUTENZIONE=true`, disco intatto, copia di sicurezza) al nuovo `gestione-finanziaria-eu` (srv-db7h9q2j9qps73cfer40, Francoforte, disco 1 GB su `/var/data`). Copia verificata (impronta, integrità, righe per tabella): 5 tabelle, 9 righe (4 aziende con tutti i loro dati contabili nella colonna `data`). Copia automatica spenta (`COPIA_FORZA=false`, `COPIA_DA=-`, marcatore `.trasloco_ok` sul disco). Dominio `finanza.appgestione.it` spostato sul nuovo servizio (CNAME Aruba → gestione-finanziaria-eu.onrender.com). Il vecchio servizio si elimina solo con l'OK del proprietario. **Stripe in modalità TEST dal 14/10/2026:** sul nuovo servizio `STRIPE_SECRET_KEY` (sk_test della "Sandbox di New business"), `STRIPE_PRICE_ID` = prezzo test 29 €/mese, `STRIPE_WEBHOOK_SECRET` = webhook test verso finanza.appgestione.it/api/stripe/webhook. I valori LIVE sono ancora nelle variabili del vecchio servizio APP-Gestione-Finanziaria: per tornare live ricopiarli da lì (prima di eliminarlo!) e verificare che il webhook live punti a finanza.appgestione.it.

- **`appgestione-db-eu`** (PostgreSQL a pagamento, Francoforte, 1 GB, circa 6,30 $/mese, nessuna scadenza): usato da Protocolli (schema `mappa`), Calendario eventi (`calendario`), Accesso unico (`accessi`), Magazzino (`magazzino`) e Turni (`turni`).
- **`radiografia-db`** (PostgreSQL gratuito): **scade il 29 ottobre 2026** e viene cancellato con i dati circa 14 giorni dopo, se non si passa a un piano a pagamento.
- Ticket assistenza e Nuovalab usano **Supabase**.
- Gestione finanziaria salva i dati sul disco del suo servizio (`/var/data`).

## Credenziali degli amministratori

Protocolli e Calendario: `ADMIN_USERNAME` / `ADMIN_PASSWORD` nelle impostazioni **Environment** del servizio su Render (mai nel codice).

## Da fare
- Accesso unico acceso il 7 ottobre 2026 (`SSO_ATTIVO=true`; Finanza con `SSO_API_KEY` e `SSO_URL`). Il sito statico `portale-appgestione` non ha più domini e si può eliminare.
- Resend: dominio appgestione.it verificato e `RESEND_API_KEY` su Render.

- Eliminare il vecchio servizio `calendario-eventi` su Render.
- Chiave AI per la chat dei Protocolli (`AI_PROVIDER` + chiave Gemini o OpenAI su Render) e nome del modello in `AI_MODEL`.
- Decidere su `radiografia-db` prima del 29 ottobre.

## Accesso unico (appgestione.it)
- Una sola email e password per tutte le app. Chi si registra resta "in attesa"; l'amministratore lo approva da `appgestione.it/admin` e sceglie per ogni app: nessun accesso, Utente o Amministratore.
- L'amministratore può anche creare utenti (con password o con link per sceglierla), disattivarli (escono subito da tutte le app) ed eliminarli.
- Il proprietario è `ADMIN_USERNAME` / `ADMIN_PASSWORD` del servizio `appgestione-eu`: è sempre amministratore di tutto.
- Dati nello schema `accessi` del database. Il cookie `ag_sso` vale per tutti i sottodomini di appgestione.it.
- Protocolli e Calendario (stesso servizio) lo usano direttamente quando `SSO_ATTIVO=true`. Le app su altri servizi chiedono `POST https://appgestione.it/api/sso/verify` con `Authorization: Bearer <SSO_API_KEY>` e `{ token: <cookie ag_sso>, app: "finanza" }`.
- Email (notifiche registrazioni a `NOTIFY_EMAIL`, recupero password) con Resend: `RESEND_API_KEY`. Senza chiave il pannello mostra i link da copiare.
- Nuovalab e Ticket (Supabase): il riquadro passa da `appgestione.it/sso/<app>`, che crea un biglietto monouso (2 minuti) e manda il browser alla funzione Supabase `sso` dell'app. La funzione lo fa verificare (`POST /api/sso/ticket`), poi rimanda all'app con `#sso=<codice>` che l'app scambia con la sessione (`verifyOtp`). Gli utenti si collegano per email: chi è "Amministratore" nell'accesso unico riceve da solo il profilo ADMIN (Nuovalab) o super_admin (Ticket) se non ne ha uno; gli altri devono avere un profilo creato dentro l'app. Disattivare, eliminare o togliere l'app a qualcuno blocca il suo utente Supabase. Sorgenti: `sso.ts` (Nuovalab) e `supabase/functions/sso` (Ticket). L'accesso con email e password delle due app resta.
- Livelli dentro Nuovalab e Ticket: nel pannello accessi, per queste due app, si sceglie il livello (Nuovalab: Amministratore, Laboratorio, Studio, Medico; Ticket: Amministratore, Responsabile azienda, Utente studio) e, quando serve, quale laboratorio/studio/medico/azienda. Gli elenchi arrivano dalla funzione `sso` dell'app (biglietto "catalog"); al primo ingresso la funzione crea l'utente e il profilo, e a ogni cambio di livello lo aggiorna (biglietto "sync"). Così nessuno ha bisogno di una password di Nuovalab o di Ticket. Gestione finanziaria resta a parte (clienti Stripe).
- Registrazione: nome, cognome, data di nascita, **codice fiscale** (controllato, unico) e, solo per "Medico odontoiatra", provincia e numero d'albo. L'amministratore li vede e li corregge nel pannello.
- Profili automatici: quando una persona è approvata (o le cambiano permessi o dati) ogni app riceve i dati e crea o aggiorna il profilo: Nuovalab e Ticket con il biglietto "sync" della funzione `sso` (crea anche l'utente Supabase; "Nuovo medico" crea il medico nello studio con i dati dell'albo; se cambia l'email aggiorna lo stesso utente); Turni con l'evento `provision:turni` (il collaboratore compare nel Personale con figura, email e codice fiscale: restano da impostare sedi e orario). Protocolli, Calendario e Magazzino creano il profilo al primo ingresso.
- Figura professionale (lista in `accessi/figure.js`: Medico, Igienista, ASO, REC, RAP, RUL, Extrambulatoriale, Altro): la persona la sceglie in registrazione, l'amministratore la corregge. Turni la usa come figura nel Personale; Calendario mette la persona nella categoria della sua figura; Protocolli dà i permessi per figura (con eccezioni personali); Magazzino e Ticket la mostrano accanto al nome.
- Più studi: per Nuovalab (Studio, Medico) e Ticket (Utente studio) si possono assegnare più studi (il primo è il principale; «+ Aggiungi un altro studio»). Si salvano in `user_apps.enti` e, nelle app, in `profili_studi` (Nuovalab) / `profile_studi` (Ticket). Il profilo tiene lo studio attuale: la persona lo cambia dal menu «Studio» in alto (funzioni `miei_studi` e `cambia_studio`), così le regole di accesso delle app restano le stesse.
- Pannello: elenco compatto (solo nome e cognome), la scheda si apre toccando la riga.
- Sedi del gruppo: si gestiscono solo nel pannello (Persone/Sedi → Sedi): nome, sigla (2-3 lettere), indirizzo, società, riuniti, email. "Aggiorna le app" (e ogni salvataggio) le manda a Turni e Calendario (evento `sedi`) e a Nuovalab e Ticket (biglietto "sedi" della funzione `sso`). Ogni app le collega con `central_id`/`centrale` e le blocca in modifica. Nuovalab crea una sede nuova solo se ha l'email; Ticket usa la società come azienda. Le sedi disattivate escono dai Turni futuri, nelle altre app restano per lo storico.
- Gestione finanziaria: i clienti esterni che pagano con Stripe continuano a registrarsi ed entrare direttamente su finanza.appgestione.it, senza passare dall'accesso unico.

- Calendario, notifiche: avviso automatico a chi vede l'evento quando viene creato, quando cambiano data/ora/luogo, e ai soli nuovi invitati quando si aggiungono persone o categorie (mai per eventi passati); più il «Promemoria» manuale dell'amministratore. Nei log: «Calendario: avviso … a N persone, raggiunte M».
- Calendario, chi vede un evento: tutto lo staff, oppure categorie e/o persone singole scelte cercando per nome o cognome (tabella `event_users`); le persone invitate così vedono l'evento, ricevono i promemoria e contano nelle presenze come quelle delle categorie.

## Magazzino centrale
- Solo con l'accesso unico (nessuna password propria). Utente = vede le disponibilità e prenota; Amministratore = conferma/rifiuta, gestisce articoli, fornitori e riordino.
- Scheda «Magazzino» (utente) / «Ordina» (amministratore): tutti gli articoli attivi per categoria, con la prima categoria già aperta; gli esauriti si vedono ma non si possono mettere nel carrello. All'invio la persona sceglie obbligatoriamente «Passo io a ritirare» o «Voglio la spedizione» (con studio o indirizzo, ricordato sul dispositivo): la scelta compare nelle Richieste, nella notifica all'amministratore e nell'esito al cliente (colonne `consegna`, `indirizzo` di `prenotazioni`). Con la spedizione è obbligatoria anche la data «Serve entro il» (`serve_entro`), almeno 72 ore dopo l'invio dell'ordine (ora italiana), controllata dall'app e dal server.
- Disponibile = giacenza − prenotazioni in attesa: nessuno può prenotare più di quello che c'è. Confermare scala la giacenza, rifiutare la libera.
- Riordino: quando (giacenza + merce già ordinata) scende alla scorta minima, l'articolo entra nel carrello con la quantità per tornare al livello di carico. Dal carrello nasce un ordine per fornitore, inviato via email (Resend) o stampato. "Merce ricevuta" ricarica la giacenza. Ogni variazione resta nei Movimenti.
- Notifiche sul telefono (Web Push) agli amministratori per ogni nuova prenotazione e al cliente per l'esito. Dati nello schema `magazzino`.
- Articoli divisi in macro categorie a fisarmonica (se ne apre una alla volta). «Elimina tutto» elimina la categoria con i suoi articoli e movimenti, dopo aver scritto ELIMINA; non si può se un articolo è in una prenotazione in attesa o in un ordine aperto. Prenotazioni e ordini passati restano con nome e quantità.
- Scansiona (Articoli, amministratore): la fotocamera legge dal vivo il codice a barre o DataMatrix della confezione (BarcodeDetector del telefono se c'è, altrimenti la libreria `@zxing/library` servita da `/vendor/zxing.js`). Il codice GS1/UDI dà GTIN, lotto (10), scadenza (17), seriale; HIBC ed EAN sono riconosciuti in modo semplice (`magazzino/lib/etichetta.js`). L'articolo si ritrova per GTIN o codice/REF; se è nuovo, il fotogramma va all'API di Claude che legge nome, produttore, REF, lotto e scadenza dall'etichetta. Si carica la quantità: movimento «Carico da scansione» con `lotto` e `scadenza` (colonne di `movimenti`); in Articoli compare la scadenza più vicina (rossa se entro 60 giorni). In alternativa: «Foto dell'etichetta» o codice scritto a mano. Lo scarico per lotto (quale lotto esce con una prenotazione) non è ancora gestito.
- Importa bolla (Articoli): foto o PDF del DDT letti con l'API di Claude (`ANTHROPIC_API_KEY`, modello `MAG_AI_MODEL` o `TURNI_AI_MODEL`). Riconosce il fornitore (P.IVA o nome) e lo crea se manca; per ogni riga propone l'articolo già esistente (memoria delle bolle precedenti in `bolla_memo`, poi codice, poi nome) o chiede la categoria la prima volta. Registrando crea gli articoli nuovi, carica le quantità (movimento «Merce ricevuta (bolla)») e ricorda le scelte. Avvisa se la stessa bolla dello stesso fornitore è già stata registrata.

## Turni
- Solo con l'accesso unico. Il dipendente è riconosciuto dall'email della sua scheda in Personale; al primo accesso accetta l'informativa privacy (registrata con data e dispositivo).
- Il motore che calcola i turni è `turni/public/motore.js`, lo stesso file usato dalla pagina e dal server (`turni/lib/motore.js`). "Genera turni" ricalcola da oggi in avanti; i giorni passati restano.
- Il dipendente riceve dal server solo i suoi turni, con chi lavora, le sue richieste e le sue buste: non vede la configurazione né i dati degli altri.
- Ferie e ROL: serve il sostituto, che conferma; poi approva l'amministratore e i turni passano al sostituto. La malattia (con protocollo del certificato) vale subito.
- Regole scritte a parole: interpretate con l'API di Claude (`ANTHROPIC_API_KEY`, modello in `TURNI_AI_MODEL`, predefinito `claude-sonnet-5-5`), applicate solo dopo conferma.
- Richieste di assenza: Ferie, ROL, Malattia, Congedo parentale (preavviso 5 giorni), Altro motivo (motivazione obbligatoria). L'amministratore le filtra per tipo, stato e persona.
- Sostituto: si sceglie fra tutti i colleghi registrati (ricerca per nome o cognome; in alto chi ha la stessa figura e una sede in comune). Prende i turni in automatico solo se ha la stessa figura. Il sostituto può cambiare risposta finché l'amministrazione non decide; invio, risposte (anche i cambi), approvazione e annullamento restano nello storico della richiesta (`richieste_eventi`) con data, ora e dispositivo.
- Personale: i collaboratori arrivano dalla registrazione su appgestione.it (approvazione in Gestione accessi). Aggiungerli a mano in Turni può solo l'amministratore del pannello accessi (anche il server lo controlla).
- Saldi ferie/ROL/ex festività: al caricamento delle buste l'app legge dal testo del cedolino i residui con l'unità scritta lì (ore o giorni), con l'API di Claude (`turni/lib/saldi.js`). Il dipendente vede i residui dell'ultimo cedolino pubblicato, meno ferie (giorni) e ROL (ore) approvati dopo quel mese quando l'unità coincide. L'amministrazione li vede nel registro delle buste e può correggerli o rileggerli. Senza cedolino valgono i saldi calcolati dalla scheda.
- CUD: scheda a parte come le buste paga (periodo = anno del CUD, redditi dell'anno prima; visibili 5 anni). Buste e CUD si firmano per ricevuta col dito o col mouse dopo averli aperti: firma cifrata, avviso e email agli amministratori con la ricevuta in PDF; "Copia firmata" = documento + pagina con firma, data, dispositivo e impronta.
- Buste paga: il PDF della consulente si divide per codice fiscale (le pagine senza codice restano da assegnare). I file sono salvati cifrati (AES-256-GCM) con la chiave `BUSTE_KEY` su Render: **se si perde la chiave, le buste salvate non si possono più aprire**. Il dipendente le apre con la password di appgestione.it; apertura e presa visione sono registrate con data, ora, dispositivo e impronta SHA-256 del file. Visibili al dipendente 18 mesi, poi solo nell'archivio dell'amministrazione.

## Protocolli: protezione dei contenuti
- Per chi non è amministratore: filigrana con nome, email e data su tutto lo schermo, niente selezione/copia/tasto destro/stampa/salva; il tasto Stamp svuota gli appunti. Gli screenshot non si possono bloccare del tutto da una pagina web: la filigrana rende riconoscibile chi li ha fatti. I file allegati aperti a parte non hanno la filigrana.

## Protocolli + Calendario in un solo servizio
`index.js` avvia le due app e smista ogni richiesta in base all'indirizzo: `calendario.appgestione.it` va al Calendario, tutto il resto ai Protocolli.
Le impostazioni del Calendario possono avere il prefisso `CAL_` (`CAL_ADMIN_USERNAME`, `CAL_ADMIN_PASSWORD`, `CAL_SESSION_SECRET`); se mancano usa quelle dei Protocolli, quindi l'amministratore è lo stesso.

## Come lavoriamo con Claude
- Una conversazione per app, ognuna solo sul proprio repository: Gestione finanziaria, Nuovalab, Ticket.
- La conversazione "principale" gestisce **Protocolli, Calendario eventi**, la pagina con i riquadri, i DNS su Aruba, le impostazioni Render condivise e il database.
- Gli indirizzi restano sottodomini (non percorsi tipo `appgestione.it/nomeapp`); l'area amministratori di ogni app resta su `/admin`.
- Prima di ogni modifica: `git pull`.

## Nuovalab: rifiuto di un lavoro
- Dashboard del laboratorio → «✕ Rifiuta lavoro» con motivo obbligatorio: `stato_lab = 'rifiutato'`, `motivo_rifiuto`, `rifiutato_il`, `rifiuto_visto = false` (tabella `lavorazioni` su Supabase). Il lavoro sparisce dalla dashboard del laboratorio e non entra nel consuntivo.
- Lo studio lo vede in «I miei lavori» in rosso con motivo e «OK, ho visto»; finché non lo segna visto ha il banner rosso, il numero accanto a «I miei lavori», il suono e la notifica del browser (controllo ogni 15 secondi mentre l'app è aperta). Il medico lo vede come «Rifiutato dal laboratorio».
- Le notifiche push a app chiusa in Nuovalab non sono attive: il pulsante «Attiva notifiche» c'è ma mancano la tabella `push_subscriptions`, la funzione `send-push` e la chiave VAPID.

## Centro notifiche unico (appgestione.it)
- La pagina con i riquadri è anche l'app installabile «To Smile» (`/manifest.webmanifest`, `/sw.js`). La persona attiva le notifiche una sola volta e sceglie con gli interruttori da quali app riceverle (valgono per tutti i suoi dispositivi). Codice: `accessi/lib/notifiche.js`; tabelle `notif_subs`, `notif_prefs`, `notif_settings` (chiavi VAPID) nello schema `accessi`.
- Calendario, Turni e Magazzino: `lib/push.js` di ciascuna passa prima dal centro (`ponte`); chi ha un dispositivo iscritto al centro non riceve più dalle iscrizioni vecchie dell'app (niente doppioni); chi non l'ha ancora fatto continua a riceverle come prima.
- Nuovalab e Ticket: trigger nei database Supabase (`tosmile_trg_*`) chiamano `POST https://appgestione.it/api/notifiche/invia` con pg_net; la chiave è `NOTIFY_KEY` su Render e `tosmile_notify_key` nel Vault di Supabase (stesso valore). Mai nomi dei pazienti nelle notifiche.
  - Nuovalab: nuovo lavoro (al laboratorio, o allo studio se lo inserisce il laboratorio), rifiutato, in consegna, in ritardo, consegna confermata/riprogrammata (allo studio), segnalazione problematico (al laboratorio), nuovi messaggi (alla controparte).
  - Ticket: nuovo ticket (super_admin e responsabili dell'azienda), preso in carico e risolto (a chi l'ha aperto e agli utenti dello studio).
- iPhone: servono iOS 16.4+ e To Smile aggiunta alla schermata Home e aperta da lì.

## Documenti legali e caratteri
- Privacy Policy, Cookie Policy, Termini e condizioni (revisionati dal DPO): `appgestione.it/privacy`, `/cookie`, `/termini`, pubblici. Testi in `accessi/legal/*.frag.html` (convertiti dai .docx ufficiali, da NON modificare a mano); le pagine si rigenerano con `python3 accessi/legal/genera.py`. Collegati da accesso/registrazione, pagina app, Protocolli (menu profilo), Calendario, Magazzino, Turni, Nuovalab, Ticket, Gestione finanziaria.
- Caratteri tipografici: niente Google Fonts. `lib/caratteri.js` serve `/fonts/tosmile.css?f=famiglia:pesi|…` e i file dai pacchetti `@fontsource/*` (installati da Render), con CORS aperto: Ticket e Gestione finanziaria li caricano da `https://appgestione.it/fonts/…`.
- Fornitori extra UE da indicare al DPO: Anthropic (lettura AI di bolle, etichette, buste paga, regole turni) e Google Gemini (assistente «Chiedi ai protocolli», `lib/ai.js`).


## Comunicazioni aziendali (15 ottobre 2026)
App nuova nello stesso servizio `appgestione-eu`: indirizzo **comunicazioni.appgestione.it** (serve il dominio personalizzato su Render e il CNAME su Aruba, come per le altre app). Codice in `comunicazioni/` (server.js, lib/db.js, public/app.html), dati nello schema `comunicazioni` del database `appgestione-db-eu` (tabelle messaggi, destinatari, chat, solleciti).
- Si entra solo con l'accesso unico. **Amministratore** (dal pannello Gestione accessi) = scrive le comunicazioni, vede letture/conferme, sollecita, risponde; **Utente** = riceve, conferma la lettura, chiede chiarimenti in una chat privata con chi ha inviato.
- Destinatari: Tutti, per figura (figura dell'accesso unico), per sede (sedi in cui la persona lavora nei Turni), singole persone. L'elenco dei destinatari viene "fotografato" all'invio.
- Ricerca per parola o frase su oggetto e testo (ricevute e inviate).
- Notifiche dal centro notifiche unico (`APP_NOTIFICHE.comunicazioni`, interruttore "Comunicazioni" su appgestione.it): nuova comunicazione, sollecito, domanda (va a chi ha inviato), risposta (va alla persona).
- Accesso automatico (`apps.js → auto`): chi ha Turni o Calendario riceve una volta sola anche Comunicazioni come Utente (tabella `accessi.app_auto`); se l'amministratore lo toglie non ritorna.
