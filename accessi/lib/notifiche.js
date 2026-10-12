// Centro notifiche unico di appgestione.it.
// La persona attiva le notifiche UNA volta sola dalla pagina con i riquadri (installata nella schermata Home su iPhone)
// e sceglie con gli interruttori da quali app riceverle. Tutte le app mandano qui i loro avvisi:
//  - Calendario, Magazzino, Turni (stesso servizio) chiamano notifica() direttamente;
//  - Nuovalab e Ticket (Supabase) chiamano POST /api/notifiche/invia con la chiave NOTIFY_KEY.
// Le notifiche arrivano anche ad app chiusa (Web Push). Toccandole si apre l'app giusta.
const webpush = require('web-push');
const store = require('./store');
const q = (t, p) => store.q(t, p);

// App che possono mandare notifiche (chiave = quella dei permessi)
const APP_NOTIFICHE = {
  calendario: 'Calendario eventi', turni: 'Turni', magazzino: 'Magazzino centrale',
  laboratorio: 'Nuovalab', ticket: 'Ticket assistenza',
};

async function migrate() {
  await q(`
    create table if not exists notif_subs (
      endpoint text primary key,
      user_id text not null references users(id) on delete cascade,
      p256dh text not null,
      auth text not null,
      device text not null default '',
      creata_il timestamptz not null default now(),
      ultimo_ok timestamptz
    );
    create index if not exists notif_subs_user_idx on notif_subs(user_id);
    create table if not exists notif_prefs (
      user_id text not null references users(id) on delete cascade,
      app text not null,
      attiva boolean not null default true,
      primary key (user_id, app)
    );
    create table if not exists notif_settings (key text primary key, value text not null);
  `);
}

let keys = null;
async function chiavi() {
  if (keys) return keys;
  const r = async () => Object.fromEntries((await q(`select key, value from notif_settings where key in ('vapid_public','vapid_private')`)).rows.map(x => [x.key, x.value]));
  let m = await r();
  if (!m.vapid_public || !m.vapid_private) {
    const k = webpush.generateVAPIDKeys();
    await q(`insert into notif_settings (key, value) values ('vapid_public',$1),('vapid_private',$2) on conflict (key) do nothing`, [k.publicKey, k.privateKey]);
    m = await r();
  }
  keys = { publicKey: m.vapid_public, privateKey: m.vapid_private };
  return keys;
}

// Persone (id dell'accesso unico) che hanno almeno un dispositivo iscritto qui: per loro le app non usano più le iscrizioni vecchie.
async function conIscrizione(userIds) {
  if (!userIds.length) return new Set();
  const { rows } = await q('select distinct user_id from notif_subs where user_id = any($1)', [userIds]);
  return new Set(rows.map(r => r.user_id));
}

// Invia a chi ha l'app attiva negli interruttori (e il permesso per quell'app). Restituisce chi è stato raggiunto
// su almeno un dispositivo e chi è "gestito" qui (ha almeno un dispositivo iscritto, anche se ha spento quell'app).
async function notifica(userIds, app, payload) {
  const raggiunti = new Set();
  const ids = [...new Set((userIds || []).filter(Boolean))];
  if (!ids.length || !APP_NOTIFICHE[app]) return { raggiunti, gestiti: new Set() };
  const k = await chiavi();
  const gestiti = await conIscrizione(ids);
  const { rows } = await q(`select s.endpoint, s.user_id, s.p256dh, s.auth from notif_subs s
    join users u on u.id = s.user_id and u.status = 'active'
    left join notif_prefs p on p.user_id = s.user_id and p.app = $2
    where s.user_id = any($1) and coalesce(p.attiva, true)
      and (u.owner or exists (select 1 from user_apps a where a.user_id = s.user_id and a.app = $2))`, [ids, app]);
  const base = APP_URL(app);
  const url = payload.url && /^https?:\/\//.test(payload.url) ? payload.url : base + (payload.url || '/');
  const body = JSON.stringify({ title: payload.title || APP_NOTIFICHE[app], body: payload.body || '', url, tag: payload.tag ? `${app}-${payload.tag}` : undefined, app });
  await Promise.all(rows.map(async s => {
    try {
      await webpush.sendNotification({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, body, {
        TTL: 60 * 60 * 24, urgency: 'high',
        vapidDetails: { subject: 'https://appgestione.it', publicKey: k.publicKey, privateKey: k.privateKey },
      });
      raggiunti.add(s.user_id);
      q('update notif_subs set ultimo_ok = now() where endpoint = $1', [s.endpoint]).catch(() => {});
    } catch (e) {
      if (e.statusCode === 404 || e.statusCode === 410) await q('delete from notif_subs where endpoint = $1', [s.endpoint]).catch(() => {});
      else console.warn('Notifica (centro) non inviata:', e.statusCode || e.message);
    }
  }));
  return { raggiunti, gestiti };
}

const APP_URL = app => (store.APPS.find(a => a.key === app)?.url || 'https://appgestione.it').replace(/\/$/, '');

// Ponte per le app dello stesso servizio: ricevono i loro id locali + sso_id e decidono se usare le iscrizioni vecchie.
// mappa: [{ id: idLocale, sso: idAccessoUnico }] → { raggiuntiLocali: Set(idLocale), restanti: [idLocale da servire col vecchio sistema] }
async function ponte(app, mappa, payload) {
  const sso = mappa.map(m => m.sso).filter(Boolean);
  const r = await notifica(sso, app, payload);
  const raggiuntiLocali = new Set(mappa.filter(m => m.sso && r.raggiunti.has(m.sso)).map(m => m.id));
  const restanti = mappa.filter(m => !(m.sso && r.gestiti.has(m.sso))).map(m => m.id);
  return { raggiuntiLocali, restanti };
}

module.exports = { APP_NOTIFICHE, migrate, chiavi, notifica, ponte, conIscrizione };
