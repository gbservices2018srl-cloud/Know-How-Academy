// To Smile — riceve le notifiche di tutte le app (Calendario, Turni, Magazzino, Nuovalab, Ticket)
// e, quando si tocca, apre l'app giusta sulla pagina giusta.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));

self.addEventListener('push', e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch { d = { body: e.data && e.data.text() }; }
  // le EMERGENZE restano sullo schermo finché non si toccano, con icona rossa e vibrazione lunga
  const urg = !!d.urgente;
  e.waitUntil(self.registration.showNotification(d.title || 'To Smile', {
    body: d.body || '', icon: urg ? '/static/urgente-192.png' : '/static/icon-192.png', badge: '/static/badge-72.png', tag: d.tag, renotify: !!d.tag,
    requireInteraction: urg, vibrate: urg ? [400, 150, 400, 150, 800] : undefined, data: { url: d.url || '/' },
  }));
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // una finestra di To Smile già aperta: la porta in primo piano sull'indirizzo dell'avviso
    for (const c of all) {
      if ('focus' in c) { await c.focus(); try { return await c.navigate(url); } catch { break; } }
    }
    return self.clients.openWindow(url);
  })());
});
