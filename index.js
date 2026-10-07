// Un solo servizio per quattro app: Accesso unico, Protocolli, Calendario eventi e Magazzino centrale.
// Ogni richiesta va all'app giusta in base all'indirizzo (sottodominio) da cui arriva.
//   appgestione.it, www.appgestione.it      → Accesso unico (login, registrazione, le tue app, /admin)
//   calendario.appgestione.it               → Calendario eventi
//   magazzino.appgestione.it                → Magazzino centrale
//   tutto il resto (protocolli.…, onrender) → Protocolli
// Altri indirizzi si possono aggiungere con ACCESSI_HOSTS e CALENDARIO_HOSTS (separati da virgola).
const http = require('http');
const accessi = require('./accessi/server');
const protocolli = require('./server');
const calendario = require('./calendario/server');
const magazzino = require('./magazzino/server');

const PORT = process.env.PORT || 3000;
const hosts = (list, extra) => new Set([...list, ...(process.env[extra] || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean)]);
const accHosts = hosts(['appgestione.it', 'www.appgestione.it'], 'ACCESSI_HOSTS');
const calHosts = hosts(['calendario.appgestione.it'], 'CALENDARIO_HOSTS');
const magHosts = hosts(['magazzino.appgestione.it'], 'MAGAZZINO_HOSTS');
const hostOf = req => String(req.headers.host || '').split(':')[0].toLowerCase();

function route(req) {
  const h = hostOf(req);
  if (accHosts.has(h)) return accessi.app;
  if (calHosts.has(h) || h.startsWith('calendario.')) return calendario.app;
  if (magHosts.has(h) || h.startsWith('magazzino.')) return magazzino.app;
  return protocolli.app;
}

(async () => {
  await accessi.start();
  await protocolli.start();
  await calendario.start();
  await magazzino.start();
  http.createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
    // www.appgestione.it → appgestione.it (un solo indirizzo, così il cookie dell'accesso è sempre lo stesso)
    if (hostOf(req) === 'www.appgestione.it') { res.writeHead(301, { Location: 'https://appgestione.it' + req.url }); return res.end(); }
    route(req)(req, res);
  }).listen(PORT, () => console.log(`Accesso unico, Protocolli, Calendario e Magazzino attivi sulla porta ${PORT}` +
    (process.env.SSO_ATTIVO === 'true' ? ' (accesso unico acceso)' : ' (accesso unico spento: SSO_ATTIVO non è true)')));
})().catch(e => { console.error('Avvio non riuscito:', e); process.exit(1); });
