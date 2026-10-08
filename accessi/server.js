// Accesso unico alle app del gruppo (appgestione.it).
// Un solo nome utente (email) e una sola password per tutte le app che l'amministratore autorizza.
// Il cookie "ag_sso" vale per tutti i sottodomini di appgestione.it: le app lo controllano qui.
const path = require('path');
const express = require('express');
const store = require('./lib/store');
const mail = require('./lib/mail');

const PROD = process.env.NODE_ENV === 'production';
const COOKIE = 'ag_sso';
const BASE_DOMAIN = (process.env.ACCESSI_DOMAIN || 'appgestione.it').toLowerCase();
const PUBLIC_URL = () => (process.env.ACCESSI_URL || `https://${BASE_DOMAIN}`).replace(/\/$/, '');
const NOTIFY = () => (process.env.NOTIFY_EMAIL || 'consultingsardegna@gmail.com').split(',').map(s => s.trim()).filter(Boolean);
const APPS = store.APPS;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'strict-origin-when-cross-origin' });
  next();
});
app.use(express.json({ limit: '100kb' }));

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, code, msg) => res.status(code).json({ error: msg });

/* ---------- cookie ---------- */
function readCookie(req, name = COOKIE) {
  const h = req.headers.cookie || '';
  for (const part of h.split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) {
      try { return decodeURIComponent(part.slice(i + 1).trim()); } catch { return null; }
    }
  }
  return null;
}
// Il cookie vale per *.appgestione.it solo se la richiesta arriva da lì (in prova su altri indirizzi resta locale).
function cookieDomain(req) {
  const h = String(req.hostname || '').toLowerCase();
  return h === BASE_DOMAIN || h.endsWith('.' + BASE_DOMAIN) ? '.' + BASE_DOMAIN : undefined;
}
function setSessionCookie(req, res, token) {
  res.cookie(COOKIE, token, { domain: cookieDomain(req), httpOnly: true, secure: PROD, sameSite: 'lax', path: '/',
    maxAge: store.SESSION_DAYS * 24 * 60 * 60 * 1000 });
}
function clearSessionCookie(req, res) {
  res.clearCookie(COOKIE, { domain: cookieDomain(req), path: '/', httpOnly: true, secure: PROD, sameSite: 'lax' });
}

// Indirizzo di ritorno dopo l'accesso: solo pagine di appgestione.it (niente rimandi verso siti esterni).
function safeNext(raw) {
  const s = String(raw || '');
  if (!s) return '/';
  if (s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\')) return s;
  try {
    const u = new URL(s);
    const h = u.hostname.toLowerCase();
    if ((u.protocol === 'https:' || (!PROD && u.protocol === 'http:')) && (h === BASE_DOMAIN || h.endsWith('.' + BASE_DOMAIN))) return u.toString();
  } catch {}
  return '/';
}

/* ---------- chi è collegato ---------- */
app.use(wrap(async (req, res, next) => {
  const token = readCookie(req);
  if (!token) return next();
  const c = await store.check(token);
  if (!c) { clearSessionCookie(req, res); return next(); }
  req.token = token; req.user = c.user; req.apps = c.apps;
  if (c.renewed) setSessionCookie(req, res, token);
  next();
}));
const isAdmin = req => !!req.user && (req.user.owner || req.apps?.accessi === 'admin');
const needUser = (req, res, next) => req.user ? next() : bad(res, 401, 'Accesso richiesto');
const needAdmin = (req, res, next) => isAdmin(req) ? next() : bad(res, 403, 'Solo amministratori');
// Le richieste che cambiano dati devono essere JSON: un modulo di un altro sito non può inviarle.
const needJson = (req, res, next) => (['GET', 'HEAD', 'OPTIONS', 'DELETE'].includes(req.method) || req.is('application/json')) ? next() : bad(res, 415, 'Formato non valido');
app.use('/api', needJson);

// Le app dei sottodomini possono chiedere "chi sono" dal browser (con il cookie).
app.use('/api/me', (req, res, next) => {
  const o = req.headers.origin;
  if (o) {
    try {
      const h = new URL(o).hostname.toLowerCase();
      if (h.endsWith('.' + BASE_DOMAIN) || h === BASE_DOMAIN) {
        res.set({ 'Access-Control-Allow-Origin': o, 'Access-Control-Allow-Credentials': 'true', Vary: 'Origin',
          'Access-Control-Allow-Methods': 'GET', 'Access-Control-Allow-Headers': 'Content-Type' });
      }
    } catch {}
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

/* ---------- limite ai tentativi ---------- */
const hits = new Map();
function limited(key, max, minutes) {
  const now = Date.now(), win = minutes * 60 * 1000;
  const a = (hits.get(key) || []).filter(t => now - t < win);
  if (a.length >= max) { hits.set(key, a); return true; }
  a.push(now); hits.set(key, a); return false;
}
setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.some(t => now - t < 3600e3)) hits.delete(k); }, 600e3).unref();

const appsForUser = apps => APPS.filter(a => apps[a.key]).map(a => ({ key: a.key, name: a.name, url: a.url, link: a.sso ? `/sso/${a.key}` : a.url,
  color: a.color, desc: a.desc, role: apps[a.key] }));

// App su Supabase (Nuovalab, Ticket): quando qualcuno viene disattivato, eliminato o perde l'accesso,
// la funzione "sso" di quell'app blocca il suo accesso anche lì.
async function revokeIn(u, keys) {
  for (const a of APPS.filter(x => x.sso && keys.includes(x.key))) {
    try {
      const ticket = await store.createTicket(u, a.key, 'revoke');
      const r = await fetch(a.sso, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ticket }), signal: AbortSignal.timeout(15000) });
      if (!r.ok) console.warn(`Blocco accesso in ${a.key} non riuscito:`, r.status);
    } catch (e) { console.warn(`Blocco accesso in ${a.key} non riuscito:`, e.message); }
  }
}
const SSO_KEYS = APPS.filter(a => a.sso).map(a => a.key);

// Elenco di laboratori, studi, medici, aziende… di un'app su Supabase (per scegliere il livello nel pannello).
// Lo fornisce la funzione "sso" dell'app, dopo aver verificato un biglietto monouso "catalog".
const catalogCache = new Map();
async function catalogo(a, u, fresh) {
  if (!a.sso) return a.enti || {}; // elenchi fissi (es. le figure dei Turni)
  const c = catalogCache.get(a.key);
  if (!fresh && c && Date.now() - c.at < 60000) return c.enti;
  const ticket = await store.createTicket(u, a.key, 'catalog');
  const r = await fetch(a.sso, { method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ticket }), signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.enti) throw Object.assign(new Error(`Non riesco a leggere gli elenchi da ${a.name}. Riprova tra poco.`), { status: 502 });
  catalogCache.set(a.key, { at: Date.now(), enti: j.enti });
  return j.enti;
}
// Profilo nelle app: appena la persona è approvata (o cambiano permessi o dati) l'app riceve nome, email,
// codice fiscale… e crea o aggiorna il suo profilo, così l'amministratore non deve ricrearlo in ogni app.
//  - Nuovalab e Ticket (Supabase): la funzione "sso" con un biglietto "sync" crea utente e profilo;
//    per "Nuovo medico" crea anche il medico in Nuovalab con i dati dell'albo e ne restituisce l'id.
//  - App in questo servizio (Turni): evento "provision" (il collaboratore compare nel Personale).
//  - Protocolli, Calendario, Magazzino: il profilo nasce al primo ingresso, non serve altro.
// Restituisce gli avvisi da mostrare all'amministratore (vuoto se tutto bene).
async function syncIn(u, key, oldEmail) {
  const a = APPS.find(x => x.key === key && x.sso);
  if (!a) return null;
  try {
    const ticket = await store.createTicket(u, a.key, 'sync', null, oldEmail ? { oldEmail } : {});
    const r = await fetch(a.sso, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }), signal: AbortSignal.timeout(20000) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) return `${a.name}: profilo non creato${j.motivo ? ' (' + j.motivo + ')' : ''}. Riprova o controlla i dati.`;
    if (j.ente) { // ente appena creato (es. il nuovo medico): da ora il permesso punta a quello
      await store.q(`update user_apps set ente = $3, ente_nome = coalesce($4, ente_nome) where user_id = $1 and app = $2 and ente like 'nuovo:%'`,
        [u.id, a.key, String(j.ente), j.enteNome ? String(j.enteNome) : null]);
      catalogCache.delete(a.key);
    }
    return null;
  } catch (e) {
    console.warn(`Profilo in ${a.key} non aggiornato:`, e.message);
    return `${a.name}: non risponde, il profilo verrà creato al primo ingresso della persona.`;
  }
}
async function provisiona(u, keys, opts = {}) {
  if (!u || u.status !== 'active' || u.owner) return [];
  const apps = await store.appsOf(u), lv = await store.livelliOf(u.id);
  const avvisi = [];
  for (const k of keys || Object.keys(apps)) {
    if (!apps[k]) continue;
    const a = APPS.find(x => x.key === k);
    if (a.sso) { const w = await syncIn(u, k, opts.oldEmail); if (w) avvisi.push(w); }
    else {
      for (const fn of store.events.listeners('provision:' + k)) {
        try { const w = await fn({ user: store.publicUser(u), role: apps[k], livello: lv[k] || null, oldEmail: opts.oldEmail || null }); if (w) avvisi.push(w); }
        catch (e) { console.warn(`Profilo in ${k}:`, e.message); avvisi.push(`${a.name}: profilo non aggiornato (${e.message}).`); }
      }
    }
  }
  return avvisi;
}
// Dal pannello: { role } per le app semplici, { livello, ente } per quelle con livelli. Restituisce [role, livello|null].
async function leggiPermesso(a, v, u, persona) {
  if (v == null || v === '' || v === 'none') return [null, null];
  if (typeof v === 'string') v = { role: v };
  if (!a.livelli) return [v.role === 'user' || v.role === 'admin' ? v.role : null, null];
  if (!v.livello) { // vecchio modo (Utente/Amministratore) ancora accettato
    if (v.role === 'admin') v = { livello: a.livelli.find(l => l.role === 'admin').key };
    else if (v.role === 'user') return ['user', null];
    else return [null, null];
  }
  const L = a.livelli.find(l => l.key === v.livello);
  if (!L) throw Object.assign(new Error('Livello non valido'), { status: 400 });
  let lv = { livello: L.key, ente: null, enteNome: null };
  if (L.ente) {
    const cerca = async fresh => {
      const cat = await catalogo(a, u, fresh);
      if (L.nuovo && String(v.ente || '').startsWith('nuovo:')) { // nuovo medico in uno studio, con i dati dell'albo della persona
        const st = (cat[L.nuovo] || []).find(x => 'nuovo:' + x.id === v.ente);
        return st && { id: v.ente, nome: `Nuovo medico · ${st.nome}` };
      }
      return (cat[L.ente] || []).find(x => x.id === v.ente);
    };
    const e = await cerca(false) || await cerca(true);
    if (!e) throw Object.assign(new Error(`${L.enteLabel}: scegli dall'elenco.`), { status: 400 });
    if (e.id.startsWith('nuovo:') && persona && !(persona.albo_provincia && persona.albo_numero))
      throw Object.assign(new Error("Per creare il medico servono provincia e numero d'albo: aggiungili con «Modifica»."), { status: 400 });
    lv = { ...lv, ente: e.id, enteNome: e.nome };
  }
  return [L.role || 'user', lv];
}
const fullName = u => `${u.first_name} ${u.last_name}`.trim() || u.email;

/* ---------- accesso ---------- */
app.get('/api/me', needUser, (req, res) => {
  res.json({ user: store.publicUser(req.user), apps: appsForUser(req.apps), admin: isAdmin(req), mail: mail.enabled() });
});

app.post('/api/login', wrap(async (req, res) => {
  const email = store.cleanEmail(req.body.email), password = String(req.body.password || '').trim();
  if (limited('login|' + req.ip + '|' + email, 10, 15)) return bad(res, 429, 'Troppi tentativi. Riprova tra 15 minuti.');
  const u = await store.findByEmail(email);
  const bcrypt = require('bcryptjs');
  const ok = u && u.password_hash && await bcrypt.compare(password, u.password_hash);
  if (!ok) return bad(res, 401, 'Email o password non corretti.');
  if (u.status === 'pending') return bad(res, 403, "La tua registrazione è in attesa di approvazione. Riceverai un'email quando l'accesso sarà attivo.");
  if (u.status === 'disabled') return bad(res, 403, "Il tuo accesso è stato disattivato. Contatta l'amministratore.");
  hits.delete('login|' + req.ip + '|' + email);
  const token = await store.createSession(u.id, req.get('user-agent'));
  setSessionCookie(req, res, token);
  res.json({ ok: true, next: safeNext(req.body.next) });
}));

app.post('/api/logout', wrap(async (req, res) => {
  await store.endSession(req.token);
  clearSessionCookie(req, res);
  res.json({ ok: true });
}));
// Le app collegate mandano qui il pulsante "Esci".
app.get('/esci', wrap(async (req, res) => {
  await store.endSession(req.token);
  clearSessionCookie(req, res);
  res.redirect('/accedi');
}));

/* ---------- registrazione ---------- */
app.get('/api/figure', (req, res) => res.json({ figure: store.FIGURE }));
// Medico: provincia e numero di iscrizione all'albo (servono a Nuovalab). Vuoti = non è medico.
function leggiAlbo(b) {
  const alboProvincia = store.cleanProv(b.alboProvincia), alboNumero = store.cleanAlbo(b.alboNumero);
  if (!alboProvincia && !alboNumero) return { dati: { alboProvincia: null, alboNumero: null } };
  if (alboProvincia.length !== 2) return { errore: "Scrivi la provincia dell'albo con 2 lettere (es. MI)." };
  if (!alboNumero) return { errore: "Scrivi il numero di iscrizione all'albo." };
  return { dati: { alboProvincia, alboNumero } };
}
async function cfUsato(cf, tranneId) {
  const { rows } = await store.q('select id from users where cf = $1 and id <> coalesce($2, \'\')', [cf, tranneId || null]);
  return rows.length > 0;
}
app.post('/api/register', wrap(async (req, res) => {
  if (limited('reg|' + req.ip, 5, 60)) return bad(res, 429, 'Troppe registrazioni da questa connessione. Riprova più tardi.');
  const b = req.body;
  const firstName = store.cleanName(b.firstName), lastName = store.cleanName(b.lastName);
  const email = store.cleanEmail(b.email), birthDate = store.cleanDate(b.birthDate), password = String(b.password || '');
  if (!firstName || !lastName) return bad(res, 400, 'Inserisci nome e cognome.');
  if (!birthDate) return bad(res, 400, 'Inserisci una data di nascita valida.');
  const cf = store.cleanCf(b.cf);
  if (!store.validCf(cf)) return bad(res, 400, 'Il codice fiscale non è corretto: controlla le 16 lettere e cifre.');
  const figura = store.cleanFigura(b.figura);
  if (!figura) return bad(res, 400, 'Scegli la tua figura professionale.');
  const albo = leggiAlbo(b);
  if (albo.errore) return bad(res, 400, albo.errore);
  if (figura === 'Medico' && !albo.dati.alboNumero) return bad(res, 400, "Per i medici servono provincia e numero di iscrizione all'albo.");
  if (!store.validEmail(email)) return bad(res, 400, "Inserisci un'email valida.");
  if (password.length < 8) return bad(res, 400, 'La password deve avere almeno 8 caratteri.');
  if (!b.privacy) return bad(res, 400, "Per registrarti devi accettare l'informativa privacy.");
  if (await store.findByEmail(email)) return bad(res, 400, 'Esiste già un account con questa email. Se non ricordi la password usa «Password dimenticata».');
  if (await cfUsato(cf)) return bad(res, 400, 'Esiste già un account con questo codice fiscale. Se non ricordi la password usa «Password dimenticata».');
  const u = await store.createUser({ firstName, lastName, birthDate, email, password, status: 'pending', cf, figura, ...albo.dati });
  const adminUrl = PUBLIC_URL() + '/admin';
  mail.send({
    to: NOTIFY(), replyTo: email,
    subject: `Nuova registrazione: ${fullName(u)}`,
    text: `${fullName(u)} (nato/a il ${birthDate}, ${email}) chiede l'accesso alle app del gruppo.\nApprova e scegli le app da: ${adminUrl}`,
    html: mail.layout('Nuova richiesta di accesso', [
      `<b>${mail.esc(fullName(u))}</b> chiede l'accesso alle app del gruppo.`,
      `Figura: <b>${mail.esc(store.FIGURE.find(f => f.id === figura).nome)}</b><br>Data di nascita: ${mail.esc(birthDate.split('-').reverse().join('/'))}<br>Codice fiscale: ${mail.esc(cf)}<br>Email: ${mail.esc(email)}` +
        (albo.dati.alboNumero ? `<br>Medico, iscritto all'albo di ${mail.esc(albo.dati.alboProvincia)} n. ${mail.esc(albo.dati.alboNumero)}` : ''),
      'Apri il pannello per approvarla e scegliere a quali app può accedere.',
    ], { url: adminUrl, label: 'Apri il pannello accessi' }),
  });
  mail.send({
    to: email, subject: 'Abbiamo ricevuto la tua registrazione',
    text: `Ciao ${firstName}, la tua richiesta di accesso alle app To Smile è arrivata. Riceverai un'email quando l'amministratore l'avrà approvata.`,
    html: mail.layout(`Ciao ${firstName}`, [
      'la tua richiesta di accesso alle app del gruppo To Smile è arrivata.',
      "Riceverai un'altra email quando l'amministratore l'avrà approvata: da quel momento entrerai con la tua email e la password che hai scelto.",
    ]),
  });
  res.json({ ok: true });
}));

/* ---------- password ---------- */
app.post('/api/password/forgot', wrap(async (req, res) => {
  const email = store.cleanEmail(req.body.email);
  if (limited('forgot|' + req.ip, 5, 60) || limited('forgot|' + email, 3, 60)) return bad(res, 429, 'Troppe richieste. Riprova tra un\'ora.');
  const u = await store.findByEmail(email);
  if (u && u.status !== 'disabled' && !u.owner) {
    const link = `${PUBLIC_URL()}/reimposta?t=${await store.createPasswordLink(u.id, 'reset', 2)}`;
    mail.send({
      to: u.email, subject: 'Reimposta la password',
      text: `Ciao ${u.first_name}, per scegliere una nuova password apri questo link entro 2 ore: ${link}\nSe non l'hai chiesto tu, ignora questa email.`,
      html: mail.layout(`Ciao ${u.first_name}`, [
        'hai chiesto di reimpostare la password delle app To Smile. Il link vale 2 ore.',
        "Se non l'hai chiesto tu, ignora questa email: la password resta quella di prima.",
      ], { url: link, label: 'Scegli una nuova password' }),
    });
  }
  res.json({ ok: true, mail: mail.enabled() }); // stessa risposta anche se l'email non esiste
}));
app.get('/api/password/link', wrap(async (req, res) => {
  const l = await store.peekPasswordLink(String(req.query.t || ''));
  if (!l) return bad(res, 404, 'Il link non è più valido. Chiedine uno nuovo con «Password dimenticata».');
  res.json({ firstName: l.first_name, email: l.email, purpose: l.purpose });
}));
app.post('/api/password/reset', wrap(async (req, res) => {
  if (limited('reset|' + req.ip, 10, 15)) return bad(res, 429, 'Troppi tentativi. Riprova tra 15 minuti.');
  const password = String(req.body.password || '');
  if (password.length < 8) return bad(res, 400, 'La password deve avere almeno 8 caratteri.');
  const u = await store.usePasswordLink(String(req.body.token || ''), password);
  if (!u) return bad(res, 400, 'Il link non è più valido. Chiedine uno nuovo con «Password dimenticata».');
  res.json({ ok: true, email: u.email });
}));
app.post('/api/me/password', needUser, wrap(async (req, res) => {
  const bcrypt = require('bcryptjs');
  if (req.user.owner) return bad(res, 400, 'La password del proprietario si cambia dalle impostazioni di Render (ADMIN_PASSWORD).');
  const nw = String(req.body.next || '');
  if (nw.length < 8) return bad(res, 400, 'La nuova password deve avere almeno 8 caratteri.');
  if (!(await bcrypt.compare(String(req.body.current || ''), req.user.password_hash || ''))) return bad(res, 400, 'La password attuale non è corretta.');
  await store.setPassword(req.user.id, nw);
  await store.q('delete from sessions where user_id = $1 and token_hash <> $2', [req.user.id, store.sha(req.token)]);
  res.json({ ok: true });
}));

/* ---------- pannello amministratore ---------- */
app.get('/api/admin/users', needAdmin, wrap(async (req, res) => {
  const { rows: users } = await store.q('select * from users order by (status = \'pending\') desc, owner desc, last_name, first_name');
  const { rows: ua } = await store.q('select user_id, app, role, livello, ente, ente_nome from user_apps');
  const by = {}, lv = {};
  for (const r of ua) {
    (by[r.user_id] ||= {})[r.app] = r.role;
    if (r.livello) (lv[r.user_id] ||= {})[r.app] = { livello: r.livello, ente: r.ente, enteNome: r.ente_nome };
  }
  res.json({
    me: req.user.id,
    apps: APPS.map(a => ({ key: a.key, name: a.name, adminOnly: !!a.adminOnly, livelli: a.livelli || null })),
    figure: store.FIGURE,
    livelli: lv,
    mail: mail.enabled(),
    users: users.map(u => store.publicUser(u, u.owner ? Object.fromEntries(store.APP_KEYS.map(k => [k, 'admin'])) : (by[u.id] || {}))),
  });
}));

async function sendActivation(u, link) {
  const apps = appsForUser(await store.appsOf(u)).filter(a => a.key !== 'accessi');
  const list = apps.length ? apps.map(a => mail.esc(a.name)).join(', ') : 'nessuna per ora';
  return mail.send({
    to: u.email, subject: 'Il tuo accesso alle app To Smile è attivo',
    text: `Ciao ${u.first_name}, il tuo accesso è attivo. App disponibili: ${apps.map(a => a.name).join(', ') || 'nessuna per ora'}.\n` +
      (link ? `Scegli la tua password qui (vale 7 giorni): ${link}` : `Entra da ${PUBLIC_URL()} con la tua email e la tua password.`),
    html: mail.layout(`Ciao ${u.first_name}`, [
      'il tuo accesso alle app del gruppo To Smile è attivo.',
      `App a cui puoi accedere: <b>${list}</b>.`,
      link ? 'Per iniziare scegli la tua password (il link vale 7 giorni). Poi entrerai sempre con la tua email e quella password.'
        : 'Entra con la tua email e la password che hai scelto.',
    ], link ? { url: link, label: 'Scegli la password' } : { url: PUBLIC_URL(), label: 'Entra' }),
  });
}

app.post('/api/admin/users', needAdmin, wrap(async (req, res) => {
  const b = req.body;
  const firstName = store.cleanName(b.firstName), lastName = store.cleanName(b.lastName);
  const email = store.cleanEmail(b.email), birthDate = b.birthDate ? store.cleanDate(b.birthDate) : null;
  const password = String(b.password || '');
  if (!firstName || !lastName) return bad(res, 400, 'Inserisci nome e cognome.');
  if (b.birthDate && !birthDate) return bad(res, 400, 'La data di nascita non è valida.');
  if (!store.validEmail(email)) return bad(res, 400, "Inserisci un'email valida.");
  if (password && password.length < 8) return bad(res, 400, 'La password deve avere almeno 8 caratteri.');
  if (await store.findByEmail(email)) return bad(res, 400, 'Esiste già un utente con questa email.');
  const cf = b.cf ? store.cleanCf(b.cf) : null;
  if (cf && !store.validCf(cf)) return bad(res, 400, 'Il codice fiscale non è corretto.');
  if (cf && await cfUsato(cf)) return bad(res, 400, 'Esiste già un utente con questo codice fiscale.');
  const albo = leggiAlbo(b);
  if (albo.errore) return bad(res, 400, albo.errore);
  const figura = b.figura ? store.cleanFigura(b.figura) : null;
  if (b.figura && !figura) return bad(res, 400, 'Figura non valida.');
  const u = await store.createUser({ firstName, lastName, birthDate, email, password: password || null, status: 'active', createdBy: req.user.id, cf, figura, ...albo.dati });
  for (const [k, v] of Object.entries(b.apps || {})) {
    const a = APPS.find(x => x.key === k); if (!a) continue;
    const [role, lv] = await leggiPermesso(a, v, req.user, u).catch(() => [null, null]);
    if (role) await store.setAppRole(u.id, k, role, lv);
  }
  const avvisi = await provisiona(u);
  let link = null;
  if (!password) link = `${PUBLIC_URL()}/reimposta?t=${await store.createPasswordLink(u.id, 'invite', 24 * 7)}`;
  const sent = b.notify !== false ? await sendActivation(u, link) : false;
  res.json({ user: store.publicUser(u, await store.appsOf(u)), livelli: await store.livelliOf(u.id), sent, link: sent ? null : link, avvisi });
}));

app.patch('/api/admin/users/:id', needAdmin, wrap(async (req, res) => {
  const u = await store.getUser(req.params.id);
  if (!u) return bad(res, 404, 'Utente non trovato');
  const b = req.body;
  if (b.firstName !== undefined) { const v = store.cleanName(b.firstName); if (!v) return bad(res, 400, 'Il nome non può essere vuoto.'); await store.q('update users set first_name = $2 where id = $1', [u.id, v]); }
  if (b.lastName !== undefined) { const v = store.cleanName(b.lastName); if (!v) return bad(res, 400, 'Il cognome non può essere vuoto.'); await store.q('update users set last_name = $2 where id = $1', [u.id, v]); }
  if (b.birthDate !== undefined) {
    const v = b.birthDate ? store.cleanDate(b.birthDate) : null;
    if (b.birthDate && !v) return bad(res, 400, 'La data di nascita non è valida.');
    await store.q('update users set birth_date = $2 where id = $1', [u.id, v]);
  }
  if (b.email !== undefined) {
    if (u.owner) return bad(res, 400, "L'email del proprietario si cambia da Render (ADMIN_USERNAME).");
    const v = store.cleanEmail(b.email);
    if (!store.validEmail(v)) return bad(res, 400, "Email non valida.");
    const ex = await store.findByEmail(v);
    if (ex && ex.id !== u.id) return bad(res, 400, 'Esiste già un utente con questa email.');
    await store.q('update users set email = $2 where id = $1', [u.id, v]);
  }
  if (b.cf !== undefined) {
    const v = b.cf ? store.cleanCf(b.cf) : null;
    if (v && !store.validCf(v)) return bad(res, 400, 'Il codice fiscale non è corretto.');
    if (v && await cfUsato(v, u.id)) return bad(res, 400, 'Esiste già un utente con questo codice fiscale.');
    await store.q('update users set cf = $2 where id = $1', [u.id, v]);
  }
  if (b.figura !== undefined) {
    const v = b.figura ? store.cleanFigura(b.figura) : null;
    if (b.figura && !v) return bad(res, 400, 'Figura non valida.');
    await store.q('update users set figura = $2 where id = $1', [u.id, v]);
  }
  if (b.alboProvincia !== undefined || b.alboNumero !== undefined) {
    const albo = leggiAlbo(b);
    if (albo.errore) return bad(res, 400, albo.errore);
    await store.q('update users set albo_provincia = $2, albo_numero = $3 where id = $1', [u.id, albo.dati.alboProvincia, albo.dati.alboNumero]);
  }
  let sent, avvisi = [];
  if (b.status !== undefined) {
    if (!['active', 'disabled'].includes(b.status)) return bad(res, 400, 'Stato non valido');
    if (u.owner || u.id === req.user.id) return bad(res, 400, 'Non puoi disattivare questo account.');
    const wasPending = u.status === 'pending';
    await store.q(`update users set status = $2, approved_at = coalesce(approved_at, case when $2 = 'active' then now() end) where id = $1`, [u.id, b.status]);
    if (b.status === 'disabled') { await store.logoutEverywhere(u.id); revokeIn(u, SSO_KEYS); }
    if (b.status === 'active' && wasPending) sent = await sendActivation(await store.getUser(u.id), null);
  }
  const fresh = await store.getUser(u.id);
  // persona attiva: le app ricevono subito i dati aggiornati (o il nuovo profilo, appena approvata)
  if (fresh.status === 'active' && b.status !== 'disabled') avvisi = await provisiona(fresh, null, { oldEmail: u.email });
  res.json({ user: store.publicUser(fresh, await store.appsOf(fresh)), livelli: await store.livelliOf(u.id), sent, avvisi });
}));

app.put('/api/admin/users/:id/apps/:app', needAdmin, wrap(async (req, res) => {
  const u = await store.getUser(req.params.id);
  if (!u) return bad(res, 404, 'Utente non trovato');
  if (u.owner) return bad(res, 400, 'Il proprietario è amministratore di tutte le app.');
  if (!store.APP_KEYS.includes(req.params.app)) return bad(res, 400, 'App sconosciuta');
  if (u.id === req.user.id && req.params.app === 'accessi') return bad(res, 400, 'Non puoi togliere a te stesso la gestione accessi.');
  const a = APPS.find(x => x.key === req.params.app);
  const [role, lv] = await leggiPermesso(a, req.body.livello ? req.body : req.body.role, req.user, u);
  await store.setAppRole(u.id, a.key, role || 'none', lv);
  let avvisi = [];
  if (!role) revokeIn(u, [a.key]); else if (u.status === 'active') avvisi = await provisiona(u, [a.key]);
  res.json({ apps: await store.appsOf(u), livelli: await store.livelliOf(u.id), avvisi });
}));
app.get('/api/admin/apps/:app/enti', needAdmin, wrap(async (req, res) => {
  const a = APPS.find(x => x.key === req.params.app && x.livelli);
  if (!a) return bad(res, 404, 'App sconosciuta');
  res.json({ enti: await catalogo(a, req.user, req.query.fresh === '1') });
}));

app.post('/api/admin/users/:id/password-link', needAdmin, wrap(async (req, res) => {
  const u = await store.getUser(req.params.id);
  if (!u) return bad(res, 404, 'Utente non trovato');
  if (u.owner) return bad(res, 400, 'La password del proprietario si cambia da Render (ADMIN_PASSWORD).');
  const link = `${PUBLIC_URL()}/reimposta?t=${await store.createPasswordLink(u.id, 'reset', 24 * 3)}`;
  const sent = await mail.send({
    to: u.email, subject: 'Scegli una nuova password',
    text: `Ciao ${u.first_name}, l'amministratore ti ha mandato un link per scegliere una nuova password (vale 3 giorni): ${link}`,
    html: mail.layout(`Ciao ${u.first_name}`, ["l'amministratore ti ha mandato un link per scegliere una nuova password delle app To Smile. Il link vale 3 giorni."],
      { url: link, label: 'Scegli la password' }),
  });
  res.json({ sent, link: sent ? null : link });
}));

app.post('/api/admin/users/:id/password', needAdmin, wrap(async (req, res) => {
  const u = await store.getUser(req.params.id);
  if (!u) return bad(res, 404, 'Utente non trovato');
  if (u.owner) return bad(res, 400, 'La password del proprietario si cambia da Render (ADMIN_PASSWORD).');
  const p = String(req.body.password || '');
  if (p.length < 8) return bad(res, 400, 'La password deve avere almeno 8 caratteri.');
  await store.setPassword(u.id, p);
  await store.logoutEverywhere(u.id);
  res.json({ ok: true });
}));

app.delete('/api/admin/users/:id', needAdmin, wrap(async (req, res) => {
  const u = await store.getUser(req.params.id);
  if (!u) return bad(res, 404, 'Utente non trovato');
  if (u.owner || u.id === req.user.id) return bad(res, 400, 'Questo account non si può eliminare.');
  await store.deleteUser(u.id);
  revokeIn(u, SSO_KEYS);
  res.json({ ok: true });
}));

/* ---------- verifica per le app su altri servizi (es. Gestione finanziaria) ---------- */
// POST /api/sso/verify  Authorization: Bearer <SSO_API_KEY>  { token, app }
function needApiKey(req, res, next) {
  const key = process.env.SSO_API_KEY || '';
  const given = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');
  const crypto = require('crypto');
  const ok = key.length >= 24 && given.length === key.length && crypto.timingSafeEqual(Buffer.from(given), Buffer.from(key));
  return ok ? next() : bad(res, 401, 'Chiave non valida');
}
app.post('/api/sso/verify', needApiKey, wrap(async (req, res) => {
  const r = await store.verify(String(req.body.token || ''), String(req.body.app || ''));
  if (!r) return bad(res, 401, 'Sessione non valida');
  if (r.denied) return res.status(403).json({ error: 'Nessun accesso a questa app', user: r.user });
  res.json(r);
}));
// POST /api/sso/users { app }: chi è abilitato a un'app (per assegnare aziende, sedi… dentro l'app)
app.post('/api/sso/users', needApiKey, wrap(async (req, res) => {
  const a = String(req.body.app || '');
  if (!store.APP_KEYS.includes(a)) return bad(res, 400, 'App sconosciuta');
  res.json({ users: await store.usersWithApp(a) });
}));

/* ---------- app su Supabase: ingresso con biglietto monouso ---------- */
app.get('/sso/:app', wrap(async (req, res) => {
  const a = APPS.find(x => x.key === req.params.app && x.sso);
  if (!a) return res.redirect('/');
  if (!req.user) return res.redirect('/accedi?next=' + encodeURIComponent(req.originalUrl));
  const role = req.apps[a.key];
  if (!role) return res.redirect('/?noaccess=' + a.key);
  const ticket = await store.createTicket(req.user, a.key, 'login', role);
  res.set('Cache-Control', 'no-store');
  res.redirect(`${a.sso}?ticket=${encodeURIComponent(ticket)}`);
}));
// La funzione "sso" dell'app riscatta il biglietto: chi è, che ruolo ha (oppure: va bloccato).
app.post('/api/sso/ticket', wrap(async (req, res) => {
  if (limited('ticket|' + req.ip, 120, 15)) return bad(res, 429, 'Troppe richieste');
  const t = await store.redeemTicket(String(req.body.ticket || ''), String(req.body.app || ''));
  if (!t) return bad(res, 404, 'Biglietto non valido o scaduto');
  res.json(t);
}));

/* ---------- pagine ---------- */
const PUB = path.join(__dirname, 'public');
const sendPage = file => (req, res) => { res.set('Cache-Control', 'no-store'); res.sendFile(path.join(PUB, file)); };
app.get('/', (req, res) => req.user ? sendPage('home.html')(req, res) : res.redirect('/accedi'));
for (const p of ['/accedi', '/registrati', '/password-dimenticata', '/reimposta']) {
  app.get(p, (req, res) => (req.user && p !== '/reimposta')
    ? res.redirect(safeNext(req.query.next)) : sendPage('accesso.html')(req, res));
}
app.get('/admin', (req, res) => {
  if (!req.user) return res.redirect('/accedi?next=/admin');
  if (!isAdmin(req)) return res.redirect('/');
  sendPage('admin.html')(req, res);
});
app.get('/privacy', sendPage('privacy.html'));
app.use('/static', express.static(path.join(PUB, 'static'), { maxAge: '7d' }));
app.get('/favicon.ico', (req, res) => res.redirect('/static/icon.svg'));
// Vecchi indirizzi della pagina dei riquadri
app.get(['/finanziario', '/finanziario/*'], (req, res) => res.redirect(301, 'https://finanza.appgestione.it'));
app.get(['/ticketassistenza', '/ticketassistenza/*'], (req, res) => res.redirect(301, 'https://ticket.appgestione.it'));
app.get(['/laboratorio', '/laboratorio/*'], (req, res) => res.redirect(301, 'https://laboratorio.appgestione.it'));
app.get(['/protocolli', '/calendario'], (req, res) => res.redirect(301, `https://${req.path.slice(1)}.${BASE_DOMAIN}`));
app.use((req, res) => res.status(404).sendFile(path.join(PUB, '404.html')));

app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return bad(res, 400, 'Richiesta non valida');
  if (err.status && err.status < 600 && err.status !== 500) return bad(res, err.status, err.message);
  console.error('Accesso unico:', err);
  bad(res, 500, 'Errore del server. Riprova.');
});

async function start() {
  await store.migrate();
  await store.ensureOwner();
}

// Per le app che girano nello stesso servizio (Protocolli, Calendario)
async function logoutFromApp(req, res) {
  await store.endSession(readCookie(req));
  clearSessionCookie(req, res);
}
module.exports = {
  app, start, store, readCookie, COOKIE, logoutFromApp, publicUrl: PUBLIC_URL,
  loginUrl: next => `${PUBLIC_URL()}/accedi?next=${encodeURIComponent(next)}`,
};
