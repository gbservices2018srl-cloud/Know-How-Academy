// Caratteri tipografici serviti dai NOSTRI server (niente Google Fonts: l'indirizzo IP dei visitatori non va a Google).
// I file arrivano dai pacchetti npm @fontsource/* installati da Render durante il rilascio.
//   GET /fonts/tosmile.css?f=fira-sans:600,700,800|figtree:400,500,600,700
//       → un solo foglio con le @font-face richieste, che puntano a /fonts/<famiglia>/files/<file>.woff2
//   GET /fonts/<famiglia>/files/<file>  → il file del carattere
// Valgono per tutti i sottodomini (Gestione finanziaria e Ticket li caricano da appgestione.it): CORS aperto, sono file pubblici.
const fs = require('fs');
const path = require('path');

const BASE = path.join(__dirname, '..', 'node_modules', '@fontsource');
const FAMIGLIE = new Set(['fira-sans', 'figtree', 'bricolage-grotesque', 'fredoka', 'poppins', 'nunito-sans']);
const cache = new Map();

function foglio(richiesta) {
  if (cache.has(richiesta)) return cache.get(richiesta);
  let css = '';
  for (const parte of String(richiesta).split('|').slice(0, 8)) {
    const [fam, pesi] = parte.split(':');
    if (!FAMIGLIE.has(fam)) continue;
    for (const w of String(pesi || '400').split(',').slice(0, 9)) {
      if (!/^[1-9]00$/.test(w)) continue;
      const f = path.join(BASE, fam, `${w}.css`);
      if (!fs.existsSync(f)) continue;
      css += fs.readFileSync(f, 'utf8').replace(/url\(\s*['"]?\.\/files\//g, `url(/fonts/${fam}/files/`) + '\n';
    }
  }
  css = css.replace(/font-display:\s*\w+/g, 'font-display: swap');
  cache.set(richiesta, css);
  return css;
}

// Restituisce true se ha risposto (la richiesta era per /fonts/…)
function gestisci(req, res) {
  if (!req.url.startsWith('/fonts/')) return false;
  const u = new URL(req.url, 'http://x');
  const intestazioni = { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'public, max-age=2592000', 'X-Content-Type-Options': 'nosniff' };
  if (u.pathname === '/fonts/tosmile.css') {
    res.writeHead(200, { ...intestazioni, 'Content-Type': 'text/css; charset=utf-8' });
    res.end(foglio(u.searchParams.get('f') || ''));
    return true;
  }
  const m = u.pathname.match(/^\/fonts\/([a-z-]+)\/files\/([A-Za-z0-9._-]+\.(woff2|woff))$/);
  if (!m || !FAMIGLIE.has(m[1])) { res.writeHead(404); res.end(); return true; }
  const file = path.join(BASE, m[1], 'files', m[2]);
  fs.stat(file, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { ...intestazioni, 'Content-Type': m[3] === 'woff2' ? 'font/woff2' : 'font/woff', 'Content-Length': st.size });
    fs.createReadStream(file).pipe(res);
  });
  return true;
}

module.exports = { gestisci };
