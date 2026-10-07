// Le app del gruppo che si aprono con l'accesso unico.
// key: nome usato nei permessi; url: indirizzo dell'app; color: colore del riquadro.
// "accessi" è il pannello per gestire gli utenti (solo il ruolo amministratore ha senso).
module.exports = [
  { key: 'finanza', name: 'Gestione finanziaria', url: 'https://finanza.appgestione.it', color: 'teal',
    desc: 'Andamento economico e dati finanziari del gruppo.' },
  { key: 'laboratorio', name: 'Nuovalab', url: 'https://laboratorio.appgestione.it', color: 'purple',
    desc: "L'app del laboratorio." },
  { key: 'ticket', name: 'Ticket assistenza', url: 'https://ticket.appgestione.it', color: 'yellow',
    desc: "Richieste di supporto tra gli studi e l'amministrazione." },
  { key: 'protocolli', name: 'Protocolli', url: 'https://protocolli.appgestione.it', color: 'teal',
    desc: 'Il flusso di lavoro dello studio con protocolli, procedure e assistente.' },
  { key: 'calendario', name: 'Calendario eventi', url: 'https://calendario.appgestione.it', color: 'purple',
    desc: 'Formazione, riunioni ed eventi aziendali per lo staff.' },
  { key: 'accessi', name: 'Gestione accessi', url: '/admin', color: 'grey', adminOnly: true,
    desc: 'Approva le registrazioni e decide chi entra in quali app.' },
];
