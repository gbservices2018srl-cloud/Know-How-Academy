// Un solo servizio per cinque app: Accesso unico, Protocolli, Calendario eventi, Magazzino centrale e Turni.
// Ogni richiesta va all'app giusta in base all'indirizzo (sottodominio) da cui arriva.
//   appgestione.it, www.appgestione.it      → Accesso unico (login, registrazione, le tue app, /admin)
//   calendario.appgestione.it               → Calendario eventi
//   magazzino.appgestione.it                → Magazzino centrale
//   turni.appgestione.it                    → Turni (planning, assenze, buste paga)
//   tutto il resto (protocolli.…, onrender) → Protocolli
// Altri indirizzi si possono aggiungere con ACCESSI_HOSTS e CALENDARIO_HOSTS (separati da virgola).
const http = require('http');
const accessi = require('./accessi/server');
const protocolli = require('./server');
const calendario = require('./calendario/server');
const magazzino = require('./magazzino/server');
const turni = require('./turni/server');

const PORT = process.env.PORT || 3000;
const hosts = (list, extra) => new Set([...list, ...(process.env[extra] || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean)]);
const accHosts = hosts(['appgestione.it', 'www.appgestione.it'], 'ACCESSI_HOSTS');
const calHosts = hosts(['calendario.appgestione.it'], 'CALENDARIO_HOSTS');
const magHosts = hosts(['magazzino.appgestione.it'], 'MAGAZZINO_HOSTS');
const turHosts = hosts(['turni.appgestione.it'], 'TURNI_HOSTS');
const hostOf = req => String(req.headers.host || '').split(':')[0].toLowerCase();

function route(req) {
  const h = hostOf(req);
  if (accHosts.has(h)) return accessi.app;
  if (calHosts.has(h) || h.startsWith('calendario.')) return calendario.app;
  if (magHosts.has(h) || h.startsWith('magazzino.')) return magazzino.app;
  if (turHosts.has(h) || h.startsWith('turni.')) return turni.app;
  return protocolli.app;
}

(async () => {
  await accessi.start();
  await protocolli.start();
  await calendario.start();
  await magazzino.start();
  await turni.start();
  // Trasloco del database (solo sul servizio nuovo, con COPIA_DA): copia tutto e poi riparte con i dati copiati
  if (await require('./lib/trasloco').eseguiSeServe()) { console.log('Trasloco completato: riavvio per caricare i dati copiati.'); process.exit(1); }
  http.createServer((req, res) => {
    if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
    // MANUTENZIONE=true: durante il trasloco nessuno può scrivere nel vecchio server (così non si perde niente)
    if (process.env.MANUTENZIONE === 'true') {
      res.writeHead(503, { 'Content-Type': 'text/html; charset=utf-8', 'Retry-After': '600', 'Cache-Control': 'no-store' });
      return res.end(`<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Aggiornamento in corso</title>
<body style="margin:0;font-family:system-ui,sans-serif;background:#FBFBF8;color:#2B3033;display:grid;place-items:center;min-height:100vh;padding:24px;text-align:center">
<div><div style="font-weight:800;font-size:22px;color:#2A7C7D">To Smile</div><h1 style="font-size:22px">Stiamo aggiornando le app</h1>
<p style="color:#6B7276;max-width:420px">Torniamo tra pochi minuti, con app più veloci. I tuoi dati sono al sicuro: riprova un po' più tardi.</p></div></body></html>`);
    }
    // www.appgestione.it → appgestione.it (un solo indirizzo, così il cookie dell'accesso è sempre lo stesso)
    if (hostOf(req) === 'www.appgestione.it') { res.writeHead(301, { Location: 'https://appgestione.it' + req.url }); return res.end(); }
    route(req)(req, res);
  }).listen(PORT, () => console.log(`Accesso unico, Protocolli, Calendario, Magazzino e Turni attivi sulla porta ${PORT}` +
    (process.env.SSO_ATTIVO === 'true' ? ' (accesso unico acceso)' : ' (accesso unico spento: SSO_ATTIVO non è true)')));
})().catch(e => { console.error('Avvio non riuscito:', e); process.exit(1); });
