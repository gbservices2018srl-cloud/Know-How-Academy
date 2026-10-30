// Le app del gruppo che si aprono con l'accesso unico.
// key: nome usato nei permessi; url: indirizzo dell'app; color: colore del riquadro.
// "accessi" è il pannello per gestire gli utenti (solo il ruolo amministratore ha senso).
// sso: indirizzo della funzione "sso" su Supabase, per le app che usano Supabase per l'accesso (Nuovalab, Ticket):
// il riquadro passa da /sso/<app>, che crea un biglietto monouso e lo consegna a quella funzione.
// livelli: i ruoli interni dell'app; il pannello accessi li assegna (con laboratorio/studio/medico/azienda)
// multi: la persona può lavorare in più studi (il primo è quello principale; nell'app sceglie lo studio in alto)
// e la funzione "sso" crea o aggiorna il profilo nell'app, così la persona non deve avere un'altra password.
module.exports = [
  // Controllo di gestione: riquadro unico con Gestione finanziaria e l'App di bilancio (budget, consuntivo, scostamenti)
  { key: 'controllo', name: 'Controllo di gestione', url: 'https://appgestione.it/c/controllo', color: 'teal', virtuale: true,
    gruppo: ['finanza', 'bilancio'],
    desc: 'Gestione finanziaria e bilancio: budget, consuntivo, scostamenti e indicatori.' },
  { key: 'finanza', name: 'Gestione finanziaria', url: 'https://finanza.appgestione.it', color: 'teal', dentro: 'controllo',
    desc: 'Andamento economico e dati finanziari del gruppo.' },
  { key: 'bilancio', name: 'Controllo di gestione · Bilancio', url: 'https://finanza.appgestione.it/bilancio', color: 'purple', dentro: 'controllo',
    desc: 'Dal bilancio a 4 sezioni: budget, consuntivo, scostamenti, costi fissi e variabili, break even, EBITDA e utile.' },
  // HR: riquadro unico per gli strumenti delle risorse umane (per ora il Lettore I-Profile)
  { key: 'hr', name: 'HR', url: 'https://appgestione.it/c/hr', color: 'purple', virtuale: true,
    gruppo: ['iprofile'],
    desc: 'Strumenti per le risorse umane: lettura dei profili I-Profile.' },
  { key: 'iprofile', name: 'Lettore I-Profile', url: 'https://appgestione.it/hr/iprofile', color: 'purple', dentro: 'hr',
    desc: 'Carica il grafico I-Profile (foto o PDF) o scrivi i valori: il report mostra sindromi e scala dell\'ISP. Non si salva nulla.' },
  { key: 'laboratorio', name: 'Nuovalab', url: 'https://laboratorio.appgestione.it', color: 'purple',
    sso: 'https://ncfsugpmqimukynuvzba.supabase.co/functions/v1/sso',
    autoFigura: 'Medico', // il medico appena attivato la trova già (come Utente: il medico di Nuovalab lo scegli poi tu)
    livelli: [
      { key: 'ADMIN', label: 'Amministratore', role: 'admin' },
      { key: 'LABORATORIO', label: 'Laboratorio', ente: 'laboratori', enteLabel: 'Quale laboratorio' },
      { key: 'STUDIO', label: 'Studio', ente: 'studi', enteLabel: 'Quale studio', multi: true },
      { key: 'MEDICO', label: 'Medico', ente: 'medici', enteLabel: 'Quale medico', nuovo: 'studi', multi: true },
    ],
    desc: "L'app del laboratorio." },
  { key: 'ticket', name: 'Ticket assistenza', url: 'https://ticket.appgestione.it', color: 'yellow',
    sso: 'https://pswocuqnwltwjembncnq.supabase.co/functions/v1/sso',
    livelli: [
      { key: 'super_admin', label: 'Amministratore', role: 'admin' },
      { key: 'admin_azienda', label: 'Responsabile azienda', ente: 'aziende', enteLabel: 'Quale azienda' },
      { key: 'utente_studio', label: 'Utente studio', ente: 'studi', enteLabel: 'Quale studio', multi: true },
    ],
    desc: "Richieste di supporto tra gli studi e l'amministrazione." },
  { key: 'protocolli', name: 'Protocolli', url: 'https://protocolli.appgestione.it', color: 'teal',
    desc: 'Il flusso di lavoro dello studio con protocolli, procedure e assistente.' },
  // Comunicazioni: riquadro unico con Comunicazioni aziendali, Calendario eventi e (per i medici) Comunicazioni cliniche con ASO.
  // È "virtuale": compare a chi ha almeno una delle tre.
  { key: 'area_comunicazioni', name: 'Comunicazioni ed eventi', url: 'https://appgestione.it/c/area_comunicazioni', color: 'purple', virtuale: true,
    gruppo: ['comunicazioni', 'clinica', 'calendario'],
    desc: 'Comunicazioni aziendali, calendario eventi e, per i medici, le comunicazioni cliniche con le ASO.' },
  { key: 'calendario', name: 'Calendario eventi', url: 'https://calendario.appgestione.it', color: 'purple',
    dentro: 'area_comunicazioni', // si apre dal riquadro Comunicazioni (e dal pulsante "Eventi" di Comunicazioni aziendali)
    segue: 'comunicazioni',  // non è più un'app a sé: permesso, ruolo, sospensione, interruttore e notifiche sono quelli di Comunicazioni ed eventi
    desc: 'Formazione, riunioni ed eventi aziendali, con iscrizione.' },
  // Gestione ASO: riquadro unico che raccoglie Magazzino, Compliance sterilizzazione e Registro impianti.
  // È "virtuale": non si assegna, compare a chi ha almeno una delle tre app (che non hanno più un riquadro proprio).
  { key: 'aso', name: 'Gestione ASO', url: 'https://appgestione.it/aso/', color: 'teal', virtuale: true,
    gruppo: ['magazzino', 'sterilizzazione', 'registro_udi', 'manutenzione', 'misure'],
    desc: 'Magazzino, sterilizzazione, registro impianti (UDI) e manutenzione delle attrezzature.' },
  // autoFigura 'ASO' + autoLivello: l'ASO appena attivata trova già Gestione ASO come Operatore (con le sue sedi, se già note)
  { key: 'sterilizzazione', name: 'Compliance sterilizzazione', url: 'https://appgestione.it/aso/?v=steri', color: 'teal', dentro: 'aso',
    enti: 'sedi', autoFigura: 'ASO', autoLivello: 'operatore', // le sedi del gruppo (scheda Sedi del pannello)
    livelli: [
      { key: 'admin', label: 'Amministratore (tutte le sedi)', role: 'admin' },
      { key: 'operatore', label: 'Operatore (ASO)', ente: 'sedi', enteLabel: 'Quale sede', multi: true },
    ],
    desc: 'Sterilizzatrici, test Bowie-Dick, Helix e spore, cicli con vapor line.' },
  { key: 'registro_udi', name: 'Registro impianti (UDI)', url: 'https://appgestione.it/aso/?v=udi', color: 'teal', dentro: 'aso',
    enti: 'sedi', autoFigura: 'ASO', autoLivello: 'operatore',
    livelli: [
      { key: 'admin', label: 'Amministratore (tutte le sedi)', role: 'admin' },
      { key: 'operatore', label: 'Operatore', ente: 'sedi', enteLabel: 'Quale sede', multi: true },
    ],
    desc: 'Registro degli impianti e dei materiali impiantabili con lotto, scadenza e codice UDI.' },
  { key: 'manutenzione', name: 'Manutenzione attrezzature', url: 'https://appgestione.it/aso/?v=man', color: 'teal', dentro: 'aso',
    enti: 'sedi', autoFigura: 'ASO', autoLivello: 'operatore',
    livelli: [
      { key: 'admin', label: 'Amministratore (tutte le sedi, crea i riuniti e corregge il registro)', role: 'admin' },
      { key: 'operatore', label: 'Operatore', ente: 'sedi', enteLabel: 'Quale sede', multi: true },
    ],
    desc: 'Riuniti e aspiratori per sede: pulizia filtri, tubi e cordoni con registro.' },
  { key: 'misure', name: 'Misure implantari', url: 'https://appgestione.it/aso/?v=misure', color: 'teal', dentro: 'aso',
    enti: 'sedi', autoFigura: 'ASO', autoLivello: 'operatore',
    livelli: [
      { key: 'admin', label: 'Amministratore (tutte le sedi)', role: 'admin' },
      { key: 'operatore', label: 'Operatore (ASO)', ente: 'sedi', enteLabel: 'Quale sede', multi: true },
    ],
    desc: 'Richieste di misure implantari al medico della sede: standard o emergenza, con documentazione su DTX.' },
  // Comunicazioni cliniche: l'app dei medici con le richieste delle ASO. Si attiva da sola a ogni profilo "Medico odontoiatra";
  // le sedi del medico arrivano dai Turni (sedi con ore), oppure si scelgono qui con il livello Medico.
  { key: 'clinica', name: 'Comunicazioni cliniche con ASO', url: 'https://appgestione.it/clinica/', color: 'purple', dentro: 'area_comunicazioni',
    autoFigura: 'Medico', autoLivello: 'medico',
    enti: 'sedi',
    livelli: [
      { key: 'admin', label: 'Amministratore (vede tutte le richieste)', role: 'admin' },
      { key: 'medico', label: 'Medico', ente: 'sedi', enteLabel: 'Sedi in cui lavora', multi: true },
    ],
    desc: 'Le richieste cliniche delle ASO: misure implantari da prendere in carico e pianificare su DTX.' },
  { key: 'magazzino', name: 'Magazzino centrale', url: 'https://magazzino.appgestione.it', color: 'yellow', dentro: 'aso', autoFigura: 'ASO',
    desc: 'Disponibilità degli articoli, prenotazioni e riordino ai fornitori.' },
  { key: 'turni', name: 'Turni', url: 'https://turni.appgestione.it', color: 'teal',
    // La figura è quella della persona (Gestione accessi): con Dipendente o "Amministratore, anche in turno"
    // compare da sola nel Personale dei Turni
    livelli: [
      { key: 'dipendente', label: 'Dipendente' },
      { key: 'admin', label: 'Amministratore, anche in turno', role: 'admin' },
      { key: 'admin_no', label: 'Amministratore, non in turno', role: 'admin' },
    ],
    desc: 'Planning delle sedi, ferie e permessi, sostituzioni e buste paga.' },
  { key: 'comunicazioni', name: 'Comunicazioni aziendali', url: 'https://comunicazioni.appgestione.it', color: 'purple', dentro: 'area_comunicazioni',
    // ogni persona attiva riceve da sola l'accesso come Utente, una volta sola (anche chi viene approvato dopo):
    // dal pannello si può poi togliere o cambiare in Amministratore (chi scrive le comunicazioni)
    auto: 'tutti',
    desc: 'Comunicazioni con conferma di lettura da parte del personale.' },
  { key: 'documenti', name: 'Documenti di studio', url: 'https://documenti.appgestione.it', color: 'teal',
    auto: ['turni', 'calendario'],
    desc: 'Procedure, moduli e regolamenti dello studio, sempre aggiornati.' },
  { key: 'accessi', name: 'Gestione accessi', url: '/admin', color: 'grey', adminOnly: true,
    desc: 'Approva le registrazioni e decide chi entra in quali app.' },
];
