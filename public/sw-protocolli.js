// Protocolli senza internet: pagina, caratteri e ultima copia di protocolli e flussi restano sul dispositivo.
// Con internet si usa sempre la versione nuova (e si aggiorna la copia); senza, si usa la copia.
const COPIA = 'protocolli-v1';
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
self.addEventListener('fetch', e => {
  const r = e.request; if (r.method !== 'GET') return;
  const u = new URL(r.url), qui = u.origin === self.location.origin;
  const pagina = r.mode === 'navigate' && qui && (u.pathname === '/' || u.pathname === '/admin');
  const dati = qui && (u.pathname === '/api/p/state' || u.pathname === '/api/state');
  const fisso = (qui && (u.pathname.startsWith('/fonts/') || u.pathname.startsWith('/static/'))) || /\/static\/resta-qui\.js/.test(u.href);
  if (!pagina && !dati && !fisso) return;
  const chiave = pagina ? u.origin + u.pathname : r.url;
  e.respondWith(fetch(r).then(res => {
    if (res.ok && !res.redirected) { const cp = res.clone(); caches.open(COPIA).then(c => c.put(chiave, cp)); }
    return res;
  }).catch(() => caches.open(COPIA).then(c => c.match(chiave)).then(m => {
    if (!m) return Response.error();
    if (!dati) return m;
    const h = new Headers(m.headers); h.set('X-Copia-Offline', '1');   // la pagina sa che sta usando la copia
    return m.blob().then(b => new Response(b, { status: m.status, headers: h }));
  })));
});
