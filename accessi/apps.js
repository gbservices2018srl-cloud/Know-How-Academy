// Le app del gruppo che si aprono con l'accesso unico.
// key: nome usato nei permessi; url: indirizzo dell'app; color: colore del riquadro.
// "accessi" è il pannello per gestire gli utenti (solo il ruolo amministratore ha senso).
// sso: indirizzo della funzione "sso" su Supabase, per le app che usano Supabase per l'accesso (Nuovalab, Ticket):
// il riquadro passa da /sso/<app>, che crea un biglietto monouso e lo consegna a quella funzione.
// livelli: i ruoli interni dell'app; il pannello accessi li assegna (con laboratorio/studio/medico/azienda)
// multi: la persona può lavorare in più studi (il primo è quello principale; nell'app sceglie lo studio in alto)
// e la funzione "sso" crea o aggiorna il profilo nell'app, così la persona non deve avere un'altra password.
module.exports = [
  { key: 'finanza', name: 'Gestione finanziaria', url: 'https://finanza.appgestione.it', color: 'teal',
    desc: 'Andamento economico e dati finanziari del gruppo.' },
  { key: 'laboratorio', name: 'Nuovalab', url: 'https://laboratorio.appgestione.it', color: 'purple',
    sso: 'https://ncfsugpmqimukynuvzba.supabase.co/functions/v1/sso',
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
  { key: 'calendario', name: 'Calendario eventi', url: 'https://calendario.appgestione.it', color: 'purple',
    desc: 'Formazione, riunioni ed eventi aziendali per lo staff.' },
  { key: 'magazzino', name: 'Magazzino centrale', url: 'https://magazzino.appgestione.it', color: 'yellow',
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
  { key: 'accessi', name: 'Gestione accessi', url: '/admin', color: 'grey', adminOnly: true,
    desc: 'Approva le registrazioni e decide chi entra in quali app.' },
];
