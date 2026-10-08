// Collega un'app Express che gira nello stesso servizio (Protocolli, Calendario) all'accesso unico.
// Si accende con SSO_ATTIVO=true su Render, dopo che appgestione.it punta a questo servizio.
// Finché è spento, l'app usa il suo vecchio accesso con nome utente e password.
const accessi = require('./server');

const enabled = () => process.env.SSO_ATTIVO === 'true';

function collega({ app, toLocal }) {
  return {
    enabled,
    // Chi sta usando l'app: { user } (profilo locale), { denied: true } (nessun permesso) oppure null (non collegato)
    async identify(req) {
      const token = accessi.readCookie(req);
      if (!token) return null;
      const r = await accessi.store.verify(token, app);
      if (!r) return null;
      if (r.denied) return { denied: true };
      return { user: await toLocal(r.user, r.role) };
    },
    // Pagina di accesso unico, poi ritorno all'indirizzo richiesto
    toLogin(req, res, path) {
      res.redirect(accessi.loginUrl(`${req.protocol}://${req.get('host')}${path || req.originalUrl}`));
    },
    toDenied(res) { res.redirect(`${accessi.publicUrl()}/?noaccess=${app}`); },
    logout: accessi.logoutFromApp,
    usersWithApp: () => accessi.store.usersWithApp(app),
    // Persona approvata o con permessi/dati cambiati: fn({ user, role, livello, oldEmail }) crea o aggiorna il profilo nell'app
    onProvision: fn => accessi.store.events.on('provision:' + app, fn),
    onDeleted: fn => accessi.store.events.on('deleted', id => Promise.resolve(fn(id)).catch(e => console.warn('Pulizia profilo:', e.message))),
    links: () => ({ home: accessi.publicUrl(), admin: accessi.publicUrl() + '/admin', logout: accessi.publicUrl() + '/esci' }),
  };
}

module.exports = collega;
