// Un solo servizio per due app: Protocolli e Calendario eventi.
// Ogni richiesta va all'app giusta in base all'indirizzo (sottodominio) da cui arriva.
//   calendario.appgestione.it            → Calendario eventi
//   tutto il resto (protocolli.…, onrender) → Protocolli
// Altri indirizzi del calendario si possono aggiungere con CALENDARIO_HOSTS (separati da virgola).
const http = require('http');
const protocolli = require('./server');
const calendario = require('./calendario/server');

const PORT = process.env.PORT || 3000;
const calHosts = new Set(['calendario.appgestione.it',
  ...(process.env.CALENDARIO_HOSTS || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean)]);
const isCalendario = host => {
  const h = String(host || '').split(':')[0].toLowerCase();
  return calHosts.has(h) || h.startsWith('calendario.');
};

(async () => {
  await protocolli.start();
  await calendario.start();
  http.createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
    (isCalendario(req.headers.host) ? calendario.app : protocolli.app)(req, res);
  }).listen(PORT, () => console.log(`Protocolli e Calendario attivi sulla porta ${PORT}`));
})().catch(e => { console.error('Avvio non riuscito:', e); process.exit(1); });
