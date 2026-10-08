// Le app del gruppo che si aprono con l'accesso unico.
// key: nome usato nei permessi; url: indirizzo dell'app; color: colore del riquadro.
// "accessi" è il pannello per gestire gli utenti (solo il ruolo amministratore ha senso).
// sso: indirizzo della funzione "sso" su Supabase, per le app che usano Supabase per l'accesso (Nuovalab, Ticket):
// il riquadro passa da /sso/<app>, che crea un biglietto monouso e lo consegna a quella funzione.
module.exports = [
  { key: 'finanza', name: 'Gestione finanziaria', url: 'https://finanza.appgestione.it', color: 'teal',
    desc: 'Andamento economico e dati finanziari del gruppo.' },
  { key: 'laboratorio', name: 'Nuovalab', url: 'https://laboratorio.appgestione.it', color: 'purple',
    sso: 'https://ncfsugpmqimukynuvzba.supabase.co/functions/v1/sso',
    desc: "L'app del laboratorio." },
  { key: 'ticket', name: 'Ticket assistenza', url: 'https://ticket.appgestione.it', color: 'yellow',
    sso: 'https://pswocuqnwltwjembncnq.supabase.co/functions/v1/sso',
    desc: "Richieste di supporto tra gli studi e l'amministrazione." },
  { key: 'protocolli', name: 'Protocolli', url: 'https://protocolli.appgestione.it', color: 'teal',
    desc: 'Il flusso di lavoro dello studio con protocolli, procedure e assistente.' },
  { key: 'calendario', name: 'Calendario eventi', url: 'https://calendario.appgestione.it', color: 'purple',
    desc: 'Formazione, riunioni ed eventi aziendali per lo staff.' },
  { key: 'magazzino', name: 'Magazzino centrale', url: 'https://magazzino.appgestione.it', color: 'yellow',
    desc: 'Disponibilità degli articoli, prenotazioni e riordino ai fornitori.' },
  { key: 'turni', name: 'Turni', url: 'https://turni.appgestione.it', color: 'teal',
    desc: 'Planning delle sedi, ferie e permessi, sostituzioni e buste paga.' },
  { key: 'accessi', name: 'Gestione accessi', url: '/admin', color: 'grey', adminOnly: true,
    desc: 'Approva le registrazioni e decide chi entra in quali app.' },
];
