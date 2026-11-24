// Un solo servizio per cinque app: Accesso unico, Protocolli, Calendario eventi, Magazzino centrale e Turni.
// Ogni richiesta va all'app giusta in base all'indirizzo (sottodominio) da cui arriva.
//   appgestione.it, www.appgestione.it      → Accesso unico (login, registrazione, le tue app, /admin)
//   calendario.appgestione.it               → Calendario eventi
//   magazzino.appgestione.it                → Magazzino centrale
//   turni.appgestione.it                    → Turni (planning, assenze, buste paga)
//   comunicazioni.appgestione.it            → Comunicazioni ed eventi aziendali
//   documenti.appgestione.it                → Documenti di studio
//   appgestione.it/aso/                     → Gestione ASO (Compliance sterilizzazione, Registro impianti UDI)
//   tutto il resto (protocolli.…, onrender) → Protocolli
// Altri indirizzi si possono aggiungere con ACCESSI_HOSTS e CALENDARIO_HOSTS (separati da virgola).
const http = require('http');
const path = require('path');
const fs = require('fs');
const accessi = require('./accessi/server');
// suite leggera (cliente con la sola Gestione finanziaria): si caricano solo l'accesso e la pagina «Le mie app»
const LEGGERA = process.env.SUITE_LEGGERA === 'true' && !!process.env.TENANT_SLUG;
const spenta = { start: async () => {}, app: (req, res) => { res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' }); res.end('<!doctype html><meta charset="utf-8"><title>App non attiva</title><p style="font-family:system-ui;padding:24px">App non compresa. <a href="/">Le mie app</a></p>'); } };
const carica = p => LEGGERA ? spenta : require(p);
const protocolli = carica('./server');
const calendario = carica('./calendario/server');
const magazzino = carica('./magazzino/server');
const turni = carica('./turni/server');
const comunicazioni = carica('./comunicazioni/server');
const documenti = carica('./documenti/server');
const aso = carica('./aso/server');
const crm = carica('./crm/server');
const cassa = carica('./cassa/server');
const compensi = carica('./compensi/server');
const classifiche = carica('./classifiche/server');
// suite per più clienti: To Smile è il cliente zero (questo processo); ogni altro cliente gira in un motore suo
const SUITE = require('./lib/suite');
const suite = require('./suite/manager');
const suitePrivacy = SUITE.TENANT ? require('./suite/privacy') : null;
// Gestione ASO vive su appgestione.it/aso/ (stesso dominio dell'accesso unico: niente nuovi domini da collegare)
const asoMontata = require('express')();
asoMontata.use((req, res, next) => req.url === '/aso' || req.url.startsWith('/aso?') ? res.redirect(301, '/aso/' + req.url.slice(4)) : next());
// Comunicazioni cliniche (app dei medici) usa lo stesso server di Gestione ASO, su appgestione.it/clinica/
asoMontata.use((req, res, next) => req.url === '/clinica' || req.url.startsWith('/clinica?') ? res.redirect(301, '/clinica/' + req.url.slice(8)) : next());
asoMontata.use('/clinica', aso.app);
asoMontata.use('/aso', aso.app);
// CRM Commerciale su appgestione.it/crm/
asoMontata.use((req, res, next) => req.url === '/crm' || req.url.startsWith('/crm?') ? res.redirect(301, '/crm/' + req.url.slice(4)) : next());
asoMontata.use('/crm', crm.app);
// Gestione Cassa UL su appgestione.it/cassa/
asoMontata.use((req, res, next) => req.url === '/cassa' || req.url.startsWith('/cassa?') ? res.redirect(301, '/cassa/' + req.url.slice(6)) : next());
asoMontata.use('/cassa', cassa.app);
// Compenso medici su appgestione.it/compensi/
asoMontata.use((req, res, next) => req.url === '/compensi' || req.url.startsWith('/compensi?') ? res.redirect(301, '/compensi/' + req.url.slice(9)) : next());
asoMontata.use('/compensi', compensi.app);
// Classifiche e medaglie su appgestione.it/classifiche/
asoMontata.use((req, res, next) => req.url === '/classifiche' || req.url.startsWith('/classifiche?') ? res.redirect(301, '/classifiche/' + req.url.slice(12)) : next());
asoMontata.use('/classifiche', classifiche.app);

const PORT = process.env.PORT || 3000;
const hosts = (list, extra) => new Set([...list, ...(process.env[extra] || '').split(',').map(h => h.trim().toLowerCase()).filter(Boolean)]);
const accHosts = hosts(['appgestione.it', 'www.appgestione.it'], 'ACCESSI_HOSTS');
const calHosts = hosts(['calendario.appgestione.it'], 'CALENDARIO_HOSTS');
const magHosts = hosts(['magazzino.appgestione.it'], 'MAGAZZINO_HOSTS');
const turHosts = hosts(['turni.appgestione.it'], 'TURNI_HOSTS');
const comHosts = hosts(['comunicazioni.appgestione.it'], 'COMUNICAZIONI_HOSTS');
const docHosts = hosts(['documenti.appgestione.it'], 'DOCUMENTI_HOSTS');
const hostOf = req => String(req.headers.host || '').split(':')[0].toLowerCase();

function route(req) {
  const h = hostOf(req);
  if (accHosts.has(h)) return /^\/(aso|clinica|crm|cassa|compensi|classifiche)(\/|\?|$)/.test(req.url) ? asoMontata : accessi.app;
  if (calHosts.has(h) || h.startsWith('calendario.')) return calendario.app;
  if (magHosts.has(h) || h.startsWith('magazzino.')) return magazzino.app;
  if (turHosts.has(h) || h.startsWith('turni.')) return turni.app;
  if (comHosts.has(h) || h.startsWith('comunicazioni.')) return comunicazioni.app;
  if (docHosts.has(h) || h.startsWith('documenti.')) return documenti.app;
  return protocolli.app;
}

// pagine del cliente: il suo nome nel titolo e, sempre visibile, «powered by» con il logo To Smile
let ultimoMarchio = null;
if (process.env.TENANT_SLUG) { const leggiMarchio = () => suite.marchioCliente().then(m => { ultimoMarchio = m; }).catch(() => {}); setTimeout(leggiMarchio, 3000); setInterval(leggiMarchio, 60000).unref(); }
const BADGE = '<a href="https://appgestione.it" target="_blank" rel="noopener" aria-label="powered by To Smile" style="position:fixed;right:max(10px,env(safe-area-inset-right,0px));bottom:max(8px,env(safe-area-inset-bottom,0px));z-index:2147483000;display:flex;align-items:center;gap:6px;padding:3px 8px;border-radius:999px;background:rgba(255,255,255,.92);box-shadow:0 1px 4px rgba(0,0,0,.12);font:600 10px/1 system-ui,sans-serif;color:#6b7276;text-decoration:none">powered by <img src="/_suite/tosmile.png" alt="To Smile" style="height:14px;width:auto;display:block"></a>';
// abbonamento in scadenza (ultimi 15 giorni): avviso fisso in cima a tutte le pagine del cliente
function conScadenza(html) {
  const g = ultimoMarchio?.giorni;
  if (g == null || g > 15 || g < 0) return html;
  const d = String(ultimoMarchio.scadenza || '').split('-').reverse().join('/');
  const quando = g === 0 ? 'scade oggi' : g === 1 ? 'scade domani' : `scade il ${d} (tra ${g} giorni)`;
  const b = `<div role="status" style="position:sticky;top:0;z-index:2147483002;background:#fde4e1;color:#8f1d14;border-bottom:2px solid #b42318;padding:10px max(16px,env(safe-area-inset-left,0px));font:700 14px/1.35 system-ui,sans-serif;text-align:center">⏰ L'abbonamento alla suite ${quando}. Rinnova per non perdere l'accesso: alla scadenza gli utenti non potranno più entrare (i dati restano conservati). Contatta To Smile.</div>`;
  return /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, m => m + b) : b + html;
}
function marchiaPagina(html) {
  const nome = String(ultimoMarchio?.nome || process.env.SUITE_NOME || '').replace(/[<>&"]/g, '');
  if (nome) html = html.replace(/(<title>[^<]*?)To Smile([^<]*<\/title>)/i, `$1${nome}$2`);
  if (suitePrivacy) html = suitePrivacy.conAvviso(html);
  html = conScadenza(html);
  return /<\/body>/i.test(html) ? html.replace(/<\/body>(?![\s\S]*<\/body>)/i, BADGE + '</body>') : html + BADGE;
}
// motore di un cliente: entrata dall'accesso centrale, app non comprese spente, indirizzi di To Smile → indirizzi del cliente
function motoreCliente(req, res) {
  const h = hostOf(req), u = req.url || '/';
  if (u.startsWith('/_suite/entra')) {
    const c = new URL(u, 'https://x').searchParams.get('c');
    suite.ritiraEntrata(c).then(token => {
      if (!token) { res.writeHead(302, { Location: '/accedi' }); return res.end(); }
      res.writeHead(302, { Location: '/', 'Set-Cookie': `${process.env.ACCESSI_COOKIE}=${token}; Domain=.${SUITE.BASE}; Path=/; Max-Age=${30 * 86400}; HttpOnly;${process.env.NODE_ENV === 'production' ? ' Secure;' : ''} SameSite=Lax`, 'Cache-Control': 'no-store' });
      res.end();
    }, () => { res.writeHead(302, { Location: '/accedi' }); res.end(); });
    return false;
  }
  // marchio del cliente: il suo logo al posto di quello di To Smile; il logo To Smile resta per «powered by»
  suite.marchioCliente().then(m => { ultimoMarchio = m; }).catch(() => {});
  const percorso = u.split('?')[0];
  // documenti privacy del cliente: i testi di To Smile non valgono per lui
  suitePrivacy.mancanti().catch(() => {});
  const paginaPrivacy = percorso.startsWith('/_suite/privacy');
  if (/^\/(privacy|privacy-policy|cookie|cookie-policy|termini|termini-condizioni|termini-e-condizioni)\/?$/.test(percorso)) {
    res.writeHead(302, { Location: '/_suite/privacy' }); res.end(); return false;
  }
  if (percorso === '/_suite/tosmile.png') {
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=86400' });
    return fs.createReadStream(path.join(__dirname, 'accessi', 'public', 'static', 'logo-tosmile.png')).pipe(res), false;
  }
  if (/(^|\/)(logo|logo-tosmile)\.png$/.test(percorso)) {
    suite.marchioCliente().then(m => {
      const l = /^data:(image\/[a-z+]+);base64,(.+)$/.exec(m?.logo || '');
      if (l) { res.writeHead(200, { 'Content-Type': l[1], 'Cache-Control': 'no-cache' }); return res.end(Buffer.from(l[2], 'base64')); }
      const nome = String(m?.nome || process.env.SUITE_NOME || '').replace(/[&<>"]/g, '');
      res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
      res.end(`<svg xmlns="http://www.w3.org/2000/svg" width="543" height="162" viewBox="0 0 543 162"><text x="0" y="104" font-family="Figtree,Arial,sans-serif" font-size="64" font-weight="800" fill="#2b8a83">${nome}</text></svg>`);
    }, () => { res.writeHead(404); res.end(); });
    return false;
  }
  const off = SUITE.spenta(h, u);
  if (off) {
    res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(`<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>App non attiva</title><body style="margin:0;font-family:system-ui,sans-serif;display:grid;place-items:center;min-height:100vh;padding:24px;text-align:center"><div><h1 style="font-size:20px">${off.nome}: app non attiva</h1><p style="color:#6B7276">Non è compresa nella tua suite. Chiedi al tuo amministratore.</p><p><a href="https://${SUITE.host('')}/">Torna alle tue app</a></p></div></body></html>`);
    return false;
  }
  // indirizzi nelle risposte: https://turni.appgestione.it → https://turni-<cliente>.appgestione.it (pagine, script, dati, rinvii)
  const sh = res.setHeader.bind(res), wh = res.writeHead.bind(res);
  res.setHeader = (k, v) => sh(k, /^location$/i.test(k) ? SUITE.riscrivi(v) : v);
  res.writeHead = (code, ...a) => { const hd = a.find(x => x && typeof x === 'object'); if (hd) for (const k of Object.keys(hd)) if (/^location$/i.test(k)) hd[k] = SUITE.riscrivi(hd[k]); return wh(code, ...a); };
  const testo = () => /text\/html|javascript|json|text\/css|manifest/i.test(String(res.getHeader('content-type') || ''));
  const parti = []; let buf = null;
  const w = res.write.bind(res), e = res.end.bind(res);
  res.write = (ch, enc, cb) => { if (buf === null) buf = testo(); if (!buf) return w(ch, enc, cb); if (ch) parti.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch, typeof enc === 'string' ? enc : 'utf8')); if (typeof cb === 'function') cb(); else if (typeof enc === 'function') enc(); return true; };
  res.end = (ch, enc, cb) => {
    if (buf === null) buf = testo();
    if (!buf) return e(ch, enc, cb);
    if (ch && typeof ch !== 'function') parti.push(Buffer.isBuffer(ch) ? ch : Buffer.from(ch, typeof enc === 'string' ? enc : 'utf8'));
    let txt = SUITE.riscrivi(Buffer.concat(parti).toString('utf8'));
    if (/text\/html/i.test(String(res.getHeader('content-type') || ''))) txt = marchiaPagina(txt);
    const out = Buffer.from(txt, 'utf8');
    if (!res.headersSent) { res.removeHeader('content-length'); res.removeHeader('etag'); res.setHeader('content-length', out.length); }
    return e(out, typeof ch === 'function' ? ch : typeof enc === 'function' ? enc : cb);
  };
  if (paginaPrivacy) { suitePrivacy.app(req, res); return false; }
  return true;
}

(async () => {
  await accessi.start();
  await protocolli.start();
  await calendario.start();
  await magazzino.start();
  await turni.start();
  await comunicazioni.start();
  await documenti.start();
  await aso.start();
  await crm.start();
  await cassa.start();
  await compensi.start();
  await classifiche.start();
  await suite.start();
  { // quali fornitori esterni sono attivi (solo i nomi, mai le chiavi): serve per l'elenco dei fornitori nella privacy
    const ai = require('./lib/ai'), p = ai.providerInfo(), e = ai.embedInfo();
    console.log(`Fornitori esterni attivi: assistente Protocolli = ${p.ok ? p.provider + ' (' + p.model + ')' : 'nessuno'}, ricerca per significato = ${e.ok ? e.provider : 'nessuna'}, `
      + `Claude = ${process.env.ANTHROPIC_API_KEY ? 'sì' : 'no'}, Gemini = ${process.env.GEMINI_API_KEY ? 'sì' : 'no'}, email Resend = ${process.env.RESEND_API_KEY ? 'sì' : 'no'}`);
  }
  // Trasloco del database (solo sul servizio nuovo, con COPIA_DA): copia tutto e poi riparte con i dati copiati
  if (await require('./lib/trasloco').eseguiSeServe()) { console.log('Trasloco completato: riavvio per caricare i dati copiati.'); process.exit(1); }
  http.createServer(async (req, res) => {
    if (req.url === '/healthz') { res.writeHead(200); return res.end('ok'); }
    // richieste per un cliente della suite (rossi.appgestione.it…): vanno al suo motore
    if (await suite.inoltra(req, res).catch(e => { console.error('Suite:', e.message); return false; })) return;
    if (SUITE.TENANT && !motoreCliente(req, res)) return;
    // caratteri tipografici dai nostri server (niente Google Fonts), per tutte le app e i sottodomini
    if (require('./lib/caratteri').gestisci(req, res)) return;
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
    // dati obbligatori dell'anagrafica mancanti: prima di aprire qualsiasi app si completa il profilo (sull'accesso unico lo controlla lui)
    const dest = route(req);
    if (dest === accessi.app) return dest(req, res);
    accessi.cancello(req, res, false).then(fatto => { if (!fatto) dest(req, res); }, () => dest(req, res));
  }).listen(PORT, () => console.log(`Accesso unico, Protocolli, Calendario, Magazzino, Turni, Comunicazioni e Documenti attivi sulla porta ${PORT}` +
    (process.env.SSO_ATTIVO === 'true' ? ' (accesso unico acceso)' : ' (accesso unico spento: SSO_ATTIVO non è true)')));
})().catch(e => { console.error('Avvio non riuscito:', e); process.exit(1); });
