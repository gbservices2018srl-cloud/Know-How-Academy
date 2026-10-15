// Comunicazioni aziendali — server (gira insieme alle altre app: vedi index.js nella cartella principale).
// Indirizzo: comunicazioni.appgestione.it. Si entra solo con l'accesso unico di appgestione.it.
//  - Amministratori (ruolo "Amministratore" nell'app, dal pannello Gestione accessi): scrivono comunicazioni
//    e scelgono a chi mandarle (tutti, per figura, per sede, singole persone); vedono chi le ha lette e confermate,
//    sollecitano chi non ha confermato e rispondono alle domande.
//  - Tutti gli altri: ricevono le comunicazioni (con notifica sul telefono), confermano la lettura e possono
//    aprire una chat privata con chi le ha mandate.
const path = require('path');
const express = require('express');
const db = require('./lib/db');
const notifiche = require('../accessi/lib/notifiche');
const ACC = require('../accessi/lib/store').SCHEMA;
const FIGURE = require('../accessi/figure');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
  next();
});
app.use(express.json({ limit: '300kb' }));

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, code, msg) => res.status(code).json({ error: msg });
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const arr = (v, max = 500) => (Array.isArray(v) ? v : []).slice(0, max).map(x => String(x).slice(0, 120));

/* ---------- chi sta usando l'app (accesso unico) ---------- */
const nomeDi = c => `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.email;
const sso = require('../accessi/collega')({
  app: 'comunicazioni',
  toLocal: async (c, role) => ({ id: c.id, name: nomeDi(c), email: c.email, figura: c.figura || '', admin: role === 'admin' }),
});
app.use(wrap(async (req, res, next) => {
  if (!sso.enabled()) return next();
  const r = await sso.identify(req);
  if (r?.user) req.user = r.user; else if (r?.denied) req.ssoDenied = true;
  next();
}));
const needUser = (req, res, next) => req.user ? next() : bad(res, 401, 'Accesso richiesto');
const needAdmin = (req, res, next) => req.user?.admin ? next() : bad(res, 403, 'Solo per gli amministratori delle comunicazioni.');

/* ---------- persone e gruppi ---------- */
// Le sedi di ogni persona vengono dai Turni (sedi in cui lavora): chi non è nei Turni non ha sede.
async function sediPerPersona() {
  const m = new Map();
  try {
    const turni = require('../turni/lib/db');
    const { rows } = await turni.q('select data from config where id = 1');
    const c = rows[0]?.data || {};
    const sedi = (c.sedi || []);
    for (const e of c.staff || []) {
      if (!e.ssoId) continue;
      const nomi = sedi.filter(s => (e.ore?.[s.id] || 0) > 0).map(s => s.nome).filter(Boolean);
      if (nomi.length) m.set(e.ssoId, nomi);
    }
  } catch (e) { console.warn('Comunicazioni, sedi dai Turni non lette:', e.message); }
  return m;
}
const FIG = Object.fromEntries(FIGURE.map(f => [f.id, f]));
async function persone() {
  const [lista, sedi] = await Promise.all([sso.usersWithApp(), sediPerPersona()]);
  return lista.map(c => ({ id: c.id, nome: nomeDi(c), figura: c.figura || '', figuraNome: FIG[c.figura]?.gruppo || '',
    sedi: sedi.get(c.id) || [], admin: c.role === 'admin' }))
    .sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
}
function gruppiDi(people) {
  const g = [{ id: 'tutti', label: 'Tutti', n: people.length }];
  for (const f of FIGURE) {
    const n = people.filter(p => p.figura === f.id).length;
    if (n) g.push({ id: 'figura:' + f.id, label: f.gruppo, n, tipo: 'figura' });
  }
  const sedi = [...new Set(people.flatMap(p => p.sedi))].sort((a, b) => a.localeCompare(b, 'it'));
  for (const s of sedi) g.push({ id: 'sede:' + s, label: 'Sede ' + s, n: people.filter(p => p.sedi.includes(s)).length, tipo: 'sede' });
  return g;
}
function risolvi(people, gruppi, singoli) {
  const ok = new Set();
  for (const p of people) {
    if (gruppi.some(g => g === 'tutti' || (g.startsWith('figura:') && p.figura === g.slice(7)) || (g.startsWith('sede:') && p.sedi.includes(g.slice(5))))) ok.add(p.id);
    if (singoli.includes(p.id)) ok.add(p.id);
  }
  return people.filter(p => ok.has(p.id));
}

// Chi ha le notifiche attive per Comunicazioni (centro notifiche di appgestione.it)
async function conNotifiche(ids) {
  if (!ids.length) return new Set();
  const { rows } = await db.q(`select distinct s.user_id from ${ACC}.notif_subs s
    left join ${ACC}.notif_prefs p on p.user_id = s.user_id and p.app = 'comunicazioni'
    where s.user_id = any($1) and coalesce(p.attiva, true)`, [ids]);
  return new Set(rows.map(r => r.user_id));
}
async function invia(ids, payload) {
  try { return (await notifiche.notifica(ids, 'comunicazioni', payload)).raggiunti; }
  catch (e) { console.warn('Comunicazioni, notifica non inviata:', e.message); return new Set(); }
}
const corto = (s, n = 110) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };

/* ---------- stato ---------- */
app.get('/api/stato', needUser, wrap(async (req, res) => {
  const { rows: dev } = await db.q(`select count(*)::int n from ${ACC}.notif_subs where user_id = $1`, [req.user.id]);
  const { rows: pr } = await db.q(`select attiva from ${ACC}.notif_prefs where user_id = $1 and app = 'comunicazioni'`, [req.user.id]);
  let eventi = null; // il pulsante Eventi apre il Calendario, se la persona ce l'ha
  try { const store = require('../accessi/lib/store'); const u = await store.getUser(req.user.id); if (u && (await store.appsOf(u)).calendario) eventi = store.APPS.find(a => a.key === 'calendario').url; } catch {}
  res.json({ me: { id: req.user.id, name: req.user.name, admin: !!req.user.admin }, eventi,
    notifiche: { dispositivi: dev[0].n, attiva: pr[0]?.attiva !== false }, links: sso.links() });
}));

app.get('/api/destinatari', needAdmin, wrap(async (req, res) => {
  const people = await persone();
  const push = await conNotifiche(people.map(p => p.id));
  res.json({ persone: people.map(p => ({ ...p, notifiche: push.has(p.id) })), gruppi: gruppiDi(people) });
}));

/* ---------- elenchi (con ricerca per parola o frase in oggetto e testo) ---------- */
function filtroRicerca(qs, params, alias = 'm') {
  const t = str(qs, 120).replace(/[\\%_]/g, c => '\\' + c);
  if (!t) return 'true';
  params.push('%' + t + '%');
  return `(${alias}.titolo ilike $${params.length} or ${alias}.testo ilike $${params.length})`;
}
// Ricevute: le comunicazioni in cui la persona è tra i destinatari
app.get('/api/ricevute', needUser, wrap(async (req, res) => {
  const params = [req.user.id];
  const f = filtroRicerca(req.query.q, params);
  const { rows } = await db.q(`select m.id, m.titolo, left(m.testo, 240) as anteprima, m.importante, m.conferma, m.autore_nome, m.creato_il,
      d.letto_il, d.confermato_il,
      (select count(*)::int from chat c where c.messaggio_id = m.id and c.persona_id = $1 and c.da_admin and not c.letto) as risposte_nuove,
      (select count(*)::int from chat c where c.messaggio_id = m.id and c.persona_id = $1) as messaggi_chat
    from messaggi m join destinatari d on d.messaggio_id = m.id and d.user_id = $1
    where ${f} order by m.creato_il desc limit 300`, params);
  res.json({ messaggi: rows });
}));
// Inviate: tutte le comunicazioni (gli amministratori le vedono tutte), con i conteggi
app.get('/api/inviate', needAdmin, wrap(async (req, res) => {
  const params = [];
  const f = filtroRicerca(req.query.q, params);
  const { rows } = await db.q(`select m.id, m.titolo, left(m.testo, 240) as anteprima, m.importante, m.conferma, m.autore_nome, m.autore_id, m.a_chi, m.creato_il,
      (select count(*)::int from destinatari d where d.messaggio_id = m.id) as totale,
      (select count(*)::int from destinatari d where d.messaggio_id = m.id and d.letto_il is not null) as lette,
      (select count(*)::int from destinatari d where d.messaggio_id = m.id and d.confermato_il is not null) as confermate,
      (select count(distinct c.persona_id)::int from chat c where c.messaggio_id = m.id) as conversazioni,
      (select count(*)::int from chat c where c.messaggio_id = m.id and not c.da_admin and not c.letto) as domande_nuove
    from messaggi m where ${f} order by m.creato_il desc limit 300`, params);
  res.json({ messaggi: rows });
}));

/* ---------- una comunicazione ---------- */
async function carica(id) {
  const { rows } = await db.q('select * from messaggi where id = $1', [id]);
  return rows[0] || null;
}
async function chatDi(id, personaId) {
  const { rows } = await db.q(`select id, da_admin, autore_nome, testo, creato_il from chat where messaggio_id = $1 and persona_id = $2 order by creato_il`, [id, personaId]);
  return rows;
}
app.get('/api/messaggi/:id', needUser, wrap(async (req, res) => {
  const m = await carica(req.params.id);
  if (!m) return bad(res, 404, 'Comunicazione non trovata.');
  const { rows: mine } = await db.q('select * from destinatari where messaggio_id = $1 and user_id = $2', [m.id, req.user.id]);
  const vista = req.query.vista === 'admin' && req.user.admin ? 'admin' : 'persona';
  const base = { id: m.id, titolo: m.titolo, testo: m.testo, importante: m.importante, conferma: m.conferma,
    autore: m.autore_nome, autoreId: m.autore_id, aChi: m.a_chi, creatoIl: m.creato_il };
  if (vista === 'persona') {
    const d = mine[0];
    if (!d) return bad(res, 404, 'Comunicazione non trovata.');
    if (!d.letto_il) { await db.q('update destinatari set letto_il = now() where messaggio_id = $1 and user_id = $2 and letto_il is null', [m.id, req.user.id]); d.letto_il = new Date(); }
    await db.q('update chat set letto = true where messaggio_id = $1 and persona_id = $2 and da_admin and not letto', [m.id, req.user.id]);
    return res.json({ ...base, lettoIl: d.letto_il, confermatoIl: d.confermato_il, chat: await chatDi(m.id, req.user.id) });
  }
  const { rows: dest } = await db.q(`select user_id, nome, figura, sedi, letto_il, confermato_il from destinatari where messaggio_id = $1 order by nome`, [m.id]);
  const push = await conNotifiche(dest.map(d => d.user_id));
  const { rows: ch } = await db.q(`select id, persona_id, da_admin, autore_nome, testo, creato_il, letto from chat where messaggio_id = $1 order by creato_il`, [m.id]);
  const conv = new Map();
  for (const c of ch) {
    if (!conv.has(c.persona_id)) conv.set(c.persona_id, { personaId: c.persona_id, nome: dest.find(d => d.user_id === c.persona_id)?.nome || 'Persona', messaggi: [], nuove: 0 });
    const t = conv.get(c.persona_id);
    t.messaggi.push({ id: c.id, daAdmin: c.da_admin, autore: c.autore_nome, testo: c.testo, creatoIl: c.creato_il });
    if (!c.da_admin && !c.letto) t.nuove++;
  }
  const { rows: sol } = await db.q('select inviato_il, persone, raggiunte, da from solleciti where messaggio_id = $1 order by inviato_il desc limit 5', [m.id]);
  res.json({ ...base, sonoDestinatario: !!mine[0],
    destinatari: dest.map(d => ({ id: d.user_id, nome: d.nome, figura: FIG[d.figura]?.gruppo || '', sedi: d.sedi, lettoIl: d.letto_il, confermatoIl: d.confermato_il, notifiche: push.has(d.user_id) })),
    conversazioni: [...conv.values()].sort((a, b) => b.nuove - a.nuove), solleciti: sol });
}));
// L'amministratore ha aperto le conversazioni: le domande risultano lette
app.post('/api/messaggi/:id/chat-lette', needAdmin, wrap(async (req, res) => {
  await db.q('update chat set letto = true where messaggio_id = $1 and persona_id = $2 and not da_admin and not letto', [req.params.id, str(req.body.persona, 80)]);
  res.json({ ok: true });
}));

/* ---------- nuova comunicazione ---------- */
app.post('/api/messaggi', needAdmin, wrap(async (req, res) => {
  const titolo = str(req.body.titolo, 160), testo = str(req.body.testo, 10000);
  const gruppi = arr(req.body.gruppi, 50), singoli = arr(req.body.persone, 500);
  if (!titolo) return bad(res, 400, 'Scrivi l\'oggetto della comunicazione.');
  if (!testo) return bad(res, 400, 'Scrivi il testo della comunicazione.');
  const people = await persone();
  const dest = risolvi(people, gruppi, singoli).filter(p => p.id !== req.user.id);
  if (!dest.length) return bad(res, 400, 'Scegli almeno un gruppo o una persona (oltre a te).');
  const gl = gruppiDi(people);
  const aChi = [...gruppi.map(g => gl.find(x => x.id === g)?.label).filter(Boolean),
    ...singoli.map(id => people.find(p => p.id === id)?.nome).filter(Boolean)].join(', ');
  const id = db.newId();
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    await client.query(`insert into messaggi (id, titolo, testo, importante, conferma, autore_id, autore_nome, a_chi, gruppi)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`, [id, titolo, testo, !!req.body.importante, req.body.conferma !== false, req.user.id, req.user.name, aChi, JSON.stringify(gruppi)]);
    for (const p of dest) await client.query(`insert into destinatari (messaggio_id, user_id, nome, figura, sedi) values ($1,$2,$3,$4,$5)`,
      [id, p.id, p.nome, p.figura, p.sedi.join(', ')]);
    await client.query('commit');
  } catch (e) { await client.query('rollback').catch(() => {}); throw e; } finally { client.release(); }
  const raggiunti = await invia(dest.map(p => p.id), {
    title: `${req.body.importante ? '❗ ' : ''}Nuova comunicazione: ${titolo}`,
    body: `${corto(testo)}${req.body.conferma !== false ? ' — Conferma la lettura.' : ''}`,
    url: `/?m=${id}`, tag: 'com-' + id,
  });
  console.log(`Comunicazioni: «${titolo}» inviata a ${dest.length} persone, notifica arrivata a ${raggiunti.size}`);
  res.json({ id, destinatari: dest.length, raggiunti: raggiunti.size, senzaNotifiche: dest.filter(p => !raggiunti.has(p.id)).map(p => p.nome) });
}));

app.delete('/api/messaggi/:id', needAdmin, wrap(async (req, res) => {
  await db.q('delete from messaggi where id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/* ---------- conferma di lettura ---------- */
app.post('/api/messaggi/:id/conferma', needUser, wrap(async (req, res) => {
  const r = await db.q(`update destinatari set confermato_il = coalesce(confermato_il, now()), letto_il = coalesce(letto_il, now())
    where messaggio_id = $1 and user_id = $2 returning confermato_il`, [req.params.id, req.user.id]);
  if (!r.rowCount) return bad(res, 404, 'Comunicazione non trovata.');
  res.json({ ok: true, confermatoIl: r.rows[0].confermato_il });
}));

/* ---------- chat privata tra la persona e chi ha mandato la comunicazione ---------- */
app.post('/api/messaggi/:id/chat', needUser, wrap(async (req, res) => {
  const m = await carica(req.params.id);
  if (!m) return bad(res, 404, 'Comunicazione non trovata.');
  const testo = str(req.body.testo, 4000);
  if (!testo) return bad(res, 400, 'Scrivi il messaggio.');
  const daAdmin = !!req.body.persona;
  let personaId = req.user.id;
  if (daAdmin) {
    if (!req.user.admin) return bad(res, 403, 'Solo per gli amministratori delle comunicazioni.');
    personaId = str(req.body.persona, 80);
  }
  const { rows: d } = await db.q('select nome from destinatari where messaggio_id = $1 and user_id = $2', [m.id, personaId]);
  if (!d[0]) return bad(res, 404, daAdmin ? 'Questa persona non è tra i destinatari.' : 'Comunicazione non trovata.');
  await db.q(`insert into chat (id, messaggio_id, persona_id, da_admin, autore_id, autore_nome, testo) values ($1,$2,$3,$4,$5,$6,$7)`,
    [db.newId(), m.id, personaId, daAdmin, req.user.id, req.user.name, testo]);
  if (daAdmin) await db.q('update chat set letto = true where messaggio_id = $1 and persona_id = $2 and not da_admin and not letto', [m.id, personaId]);
  res.json({ ok: true });
  // avviso all'altra parte: alla persona se risponde l'amministratore, a chi ha mandato la comunicazione se scrive la persona
  const a = daAdmin ? [personaId] : [m.autore_id];
  invia(a, daAdmin
    ? { title: `Risposta su: ${m.titolo}`, body: `${req.user.name}: ${corto(testo)}`, url: `/?m=${m.id}#chat`, tag: `com-chat-${m.id}` }
    : { title: `Domanda da ${req.user.name}`, body: `Su «${corto(m.titolo, 60)}»: ${corto(testo)}`, url: `/?m=${m.id}&persona=${encodeURIComponent(personaId)}`, tag: `com-chat-${m.id}-${personaId}` });
}));

/* ---------- sollecito a chi non ha confermato (o non ha letto, se la conferma non è richiesta) ---------- */
app.post('/api/messaggi/:id/sollecita', needAdmin, wrap(async (req, res) => {
  const m = await carica(req.params.id);
  if (!m) return bad(res, 404, 'Comunicazione non trovata.');
  const { rows } = await db.q(`select user_id, nome from destinatari where messaggio_id = $1 and ${m.conferma ? 'confermato_il is null' : 'letto_il is null'}`, [m.id]);
  if (!rows.length) return res.json({ persone: 0, raggiunte: 0, senzaNotifiche: [] });
  const r = await invia(rows.map(x => x.user_id), {
    title: `Promemoria: ${m.titolo}`,
    body: m.conferma ? 'Non hai ancora confermato la lettura di questa comunicazione. Aprila e conferma.' : 'Hai una comunicazione da leggere.',
    url: `/?m=${m.id}`, tag: 'com-' + m.id,
  });
  await db.q('insert into solleciti (id, messaggio_id, persone, raggiunte, da) values ($1,$2,$3,$4,$5)', [db.newId(), m.id, rows.length, r.size, req.user.name]);
  res.json({ persone: rows.length, raggiunte: r.size, senzaNotifiche: rows.filter(x => !r.has(x.user_id)).map(x => x.nome) });
}));

/* ---------- pagine ---------- */
const PUB = path.join(__dirname, 'public');
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!sso.enabled()) return res.status(503).send('Comunicazioni: serve l\'accesso unico di appgestione.it (SSO_ATTIVO=true).');
  if (!req.user) return req.ssoDenied ? sso.toDenied(res) : sso.toLogin(req, res);
  res.sendFile(path.join(PUB, 'app.html'));
});
app.get('/healthz', (req, res) => res.send('ok'));
app.get('/manifest.webmanifest', (req, res) => res.sendFile(path.join(PUB, 'manifest.webmanifest')));
for (const f of ['logo.png', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'icon.svg']) app.get('/' + f, (req, res) => res.sendFile(path.join(PUB, f), { maxAge: '7d' }));
app.post('/api/esci', wrap(async (req, res) => { await sso.logout(req, res); res.json({ ok: true, url: sso.links().home }); }));

app.use((err, req, res, next) => {
  console.error(err);
  bad(res, 500, 'Errore del server. Riprova.');
});

async function start() {
  await db.migrate();
}
module.exports = { app, start };
