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
    // enti appena creati (es. il nuovo medico in uno o più studi): da ora il permesso punta a quelli
    const creati = Array.isArray(j.creati) ? j.creati : j.ente ? [{ da: null, id: j.ente, nome: j.enteNome }] : [];
    if (creati.length) {
      const { rows } = await store.q('select ente, ente_nome, enti from user_apps where user_id = $1 and app = $2', [u.id, a.key]);
      if (rows[0]) {
        const r = rows[0], sost = x => creati.find(c => c.da ? c.da === x.id : String(x.id).startsWith('nuovo:'));
        let enti = Array.isArray(r.enti) && r.enti.length ? r.enti : [{ id: r.ente, nome: r.ente_nome }];
        enti = enti.map(x => { const c = sost(x); return c ? { id: String(c.id), nome: c.nome ? String(c.nome) : x.nome } : x; });
        await store.q('update user_apps set ente = $3, ente_nome = $4, enti = $5 where user_id = $1 and app = $2',
          [u.id, a.key, enti[0].id, enti[0].nome, JSON.stringify(enti)]);
      }
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
  let lv = { livello: L.key, ente: null, enteNome: null, enti: [] };
  if (L.ente) {
    // un solo ente, oppure (livelli "multi") più studi: il primo è il principale
    const ids = [...new Set((L.multi && Array.isArray(v.enti) && v.enti.length ? v.enti : [v.ente]).map(x => String(x || '')).filter(Boolean))].slice(0, 20);
    if (!ids.length) throw Object.assign(new Error(`${L.enteLabel}: scegli dall'elenco.`), { status: 400 });
    const cerca = async (id, fresh) => {
      const cat = await catalogo(a, u, fresh);
      if (L.nuovo && id.startsWith('nuovo:')) { // nuovo medico in uno studio, con i dati dell'albo della persona
        const st = (cat[L.nuovo] || []).find(x => 'nuovo:' + x.id === id);
        return st && { id, nome: `Nuovo medico · ${st.nome}` };
      }
      const x = (cat[L.ente] || []).find(y => y.id === id);
      return x && { id: x.id, nome: x.nome + (x.info ? ' · ' + x.info : '') };
    };
    for (const id of ids) {
      const e = await cerca(id, false) || await cerca(id, true);
      if (!e) throw Object.assign(new Error(`${L.enteLabel}: scegli dall'elenco.`), { status: 400 });
      if (e.id.startsWith('nuovo:') && persona && !(persona.albo_provincia && persona.albo_numero))
        throw Object.assign(new Error("Per creare il medico servono provincia e numero d'albo: aggiungili con «Modifica»."), { status: 400 });
      lv.enti.push(e);
    }
    lv = { ...lv, ente: lv.enti[0].id, enteNome: lv.enti[0].nome };
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
  // freno contro gli abusi: i tentativi con errori (es. codice fiscale sbagliato) contano poco; le registrazioni riuscite
  // sono al massimo 100 all'ora dalla stessa connessione (es. tutto lo studio sullo stesso Wi-Fi)
  if (limited('regtry|' + req.ip, 200, 15)) return bad(res, 429, 'Troppi tentativi da questa connessione. Riprova tra un quarto d\'ora.');
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
  if (limited('reg|' + req.ip, 100, 60)) return bad(res, 429, 'Troppe registrazioni da questa connessione nell\'ultima ora. Riprova più tardi oppure usa i dati mobili del telefono.');
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
  const verifyLink = `${PUBLIC_URL()}/conferma-email?t=${await store.createPasswordLink(u.id, 'verify', 24 * 7)}`;
  mail.send({
    to: email, subject: 'Conferma la tua email · To Smile',
    text: `Ciao ${firstName}, la tua richiesta di accesso alle app To Smile è arrivata. Conferma la tua email aprendo questo link (vale 7 giorni): ${verifyLink}\nRiceverai un'altra email quando l'amministratore l'avrà approvata.`,
    html: mail.layout(`Ciao ${firstName}`, [
      'la tua richiesta di accesso alle app del gruppo To Smile è arrivata.',
      "Per prima cosa conferma che questa email è tua con il pulsante qui sotto (il link vale 7 giorni).",
      "Riceverai un'altra email quando l'amministratore l'avrà approvata: da quel momento entrerai con la tua email e la password che hai scelto.",
    ], { url: verifyLink, label: 'Conferma la mia email' }),
  });
  res.json({ ok: true });
}));

// Link di conferma dell'email (dalla registrazione)
app.get('/conferma-email', wrap(async (req, res) => {
  const u = await store.confirmEmail(String(req.query.t || ''));
  res.redirect('/accedi?email=' + (u ? 'ok' : 'scaduta'));
}));
// L'amministratore rimanda il link di conferma
app.post('/api/admin/users/:id/verify-link', needAdmin, wrap(async (req, res) => {
  const u = await store.getUser(req.params.id);
  if (!u) return bad(res, 404, 'Utente non trovato');
  const link = `${PUBLIC_URL()}/conferma-email?t=${await store.createPasswordLink(u.id, 'verify', 24 * 7)}`;
  const sent = await mail.send({ to: u.email, subject: 'Conferma la tua email · To Smile',
    text: `Ciao ${u.first_name}, conferma la tua email aprendo questo link (vale 7 giorni): ${link}`,
    html: mail.layout(`Ciao ${u.first_name}`, ['conferma che questa email è tua con il pulsante qui sotto (il link vale 7 giorni).'], { url: link, label: 'Conferma la mia email' }) });
  res.json({ sent, link: sent ? null : link });
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
  const { rows: ua } = await store.q('select user_id, app, role, livello, ente, ente_nome, enti from user_apps');
  const by = {}, lv = {};
  for (const r of ua) {
    (by[r.user_id] ||= {})[r.app] = r.role;
    if (r.livello) (lv[r.user_id] ||= {})[r.app] = { livello: r.livello, ente: r.ente, enteNome: r.ente_nome,
      enti: Array.isArray(r.enti) && r.enti.length ? r.enti : r.ente ? [{ id: r.ente, nome: r.ente_nome }] : [] };
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
  const avvisi = [];
  for (const [k, v] of Object.entries(b.apps || {})) {
    const a = APPS.find(x => x.key === k); if (!a) continue;
    const [role, lv] = await leggiPermesso(a, v, req.user, u).catch(e => { avvisi.push(`${a.name}: accesso non dato (${e.message})`); return [null, null]; });
    if (role) await store.setAppRole(u.id, k, role, lv);
  }
  avvisi.push(...await provisiona(u));
  let link = null;
  if (!password) link = `${PUBLIC_URL()}/reimposta?t=${await store.createPasswordLink(u.id, 'invite', 24 * 7)}`;
  const sent = b.notify !== false ? await sendActivation(u, link) : false;
  res.json({ user: store.publicUser(u, await store.appsOf(u)), livelli: await store.livelliOf(u.id), sent, link: sent ? null : link, avvisi });
}));

app.patch('/api/admin/users/:id', needAdmin, wrap(async (req, res) => {
  const u = await store.getUser(req.params.id);
  if (!u) return bad(res, 404, 'Utente non trovato');
  const b = req.body;
  // prima si controllano tutti i dati, poi si salvano insieme: o tutto o niente
  const set = {};
  if (b.firstName !== undefined) { const v = store.cleanName(b.firstName); if (!v) return bad(res, 400, 'Il nome non può essere vuoto.'); set.first_name = v; }
  if (b.lastName !== undefined) { const v = store.cleanName(b.lastName); if (!v) return bad(res, 400, 'Il cognome non può essere vuoto.'); set.last_name = v; }
  if (b.birthDate !== undefined) {
    const v = b.birthDate ? store.cleanDate(b.birthDate) : null;
    if (b.birthDate && !v) return bad(res, 400, 'La data di nascita non è valida.');
    set.birth_date = v;
  }
  if (b.email !== undefined && store.cleanEmail(b.email) !== u.email) {
    if (u.owner) return bad(res, 400, "L'email del proprietario si cambia da Render (ADMIN_USERNAME).");
    const v = store.cleanEmail(b.email);
    if (!store.validEmail(v)) return bad(res, 400, "Email non valida.");
    const ex = await store.findByEmail(v);
    if (ex && ex.id !== u.id) return bad(res, 400, 'Esiste già un utente con questa email.');
    set.email = v; set.email_verificata = true; // l'ha scritta l'amministratore
  }
  if (b.cf !== undefined) {
    const v = b.cf ? store.cleanCf(b.cf) : null;
    if (v && !store.validCf(v)) return bad(res, 400, 'Il codice fiscale non è corretto.');
    if (v && await cfUsato(v, u.id)) return bad(res, 400, 'Esiste già un utente con questo codice fiscale.');
    set.cf = v;
  }
  if (b.figura !== undefined) {
    const v = b.figura ? store.cleanFigura(b.figura) : null;
    if (b.figura && !v) return bad(res, 400, 'Figura non valida.');
    set.figura = v;
  }
  if (b.alboProvincia !== undefined || b.alboNumero !== undefined) {
    const albo = leggiAlbo(b);
    if (albo.errore) return bad(res, 400, albo.errore);
    set.albo_provincia = albo.dati.alboProvincia; set.albo_numero = albo.dati.alboNumero;
  }
  if (b.status !== undefined) {
    if (!['active', 'disabled'].includes(b.status)) return bad(res, 400, 'Stato non valido');
    if (u.owner || u.id === req.user.id) return bad(res, 400, 'Non puoi disattivare questo account.');
  }
  const keys = Object.keys(set);
  if (keys.length) await store.q(`update users set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')} where id = $1`, [u.id, ...keys.map(k => set[k])]);
  let sent, avvisi = [];
  if (b.status !== undefined) {
    const wasPending = u.status === 'pending';
    await store.q(`update users set status = $2, approved_at = coalesce(approved_at, case when $2 = 'active' then now() end) where id = $1`, [u.id, b.status]);
    if (b.status === 'disabled') { await store.logoutEverywhere(u.id); revokeIn(u, SSO_KEYS); }
    if (b.status === 'active' && wasPending) sent = await sendActivation(await store.getUser(u.id), null);
  }
  const fresh = await store.getUser(u.id);
  // persona attiva: le app ricevono subito i dati aggiornati (o il nuovo profilo, appena approvata)
  if (fresh.status === 'active' && b.status !== 'disabled') avvisi = await provisiona(fresh, null, { oldEmail: u.email !== fresh.email ? u.email : null });
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
/* ---------- sedi del gruppo ---------- */
// Si gestiscono qui e vengono copiate nelle app: Turni e Calendario (in questo servizio, evento "sedi"),
// Ticket e Nuovalab (funzione "sso" con un biglietto "sedi"). Le app non le modificano: le ricevono.
async function sincronizzaSedi(u) {
  const sedi = await store.listSedi();
  const avvisi = [];
  for (const fn of store.events.listeners('sedi')) {
    try { const w = await fn(sedi); if (w) avvisi.push(...[].concat(w)); } catch (e) { console.warn('Sedi:', e.message); avvisi.push('Sedi: ' + e.message); }
  }
  for (const a of APPS.filter(x => x.sso)) {
    try {
      const ticket = await store.createTicket(u, a.key, 'sedi', null, { sedi });
      const r = await fetch(a.sso, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ticket }), signal: AbortSignal.timeout(30000) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) avvisi.push(`${a.name}: sedi non aggiornate.`);
      for (const w of j.avvisi || []) avvisi.push(`${a.name}: ${w}`);
    } catch (e) { avvisi.push(`${a.name}: non risponde, sedi non aggiornate.`); }
    catalogCache.delete(a.key);
  }
  return avvisi;
}
function leggiSede(b) {
  const nome = store.cleanName(b.nome), sigla = String(b.sigla || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3);
  if (!nome) throw Object.assign(new Error('Scrivi il nome della sede.'), { status: 400 });
  if (sigla.length < 2) throw Object.assign(new Error('La sigla deve avere 2 o 3 lettere (es. CAB).'), { status: 400 });
  const email = store.cleanEmail(b.email || '');
  if (email && !store.validEmail(email)) throw Object.assign(new Error("L'email della sede non è valida."), { status: 400 });
  const riuniti = Math.max(0, Math.min(20, Math.round(+b.riuniti || 0)));
  return { nome, sigla, indirizzo: String(b.indirizzo || '').trim().slice(0, 200), societa: store.cleanName(b.societa || ''), email, riuniti };
}
async function salvaSede(id, d) {
  const { rows } = await store.q('select id from sedi where upper(sigla) = $1 and id <> $2', [d.sigla, id || '']);
  if (rows.length) throw Object.assign(new Error(`La sigla ${d.sigla} è già di un'altra sede.`), { status: 400 });
  if (id) await store.q(`update sedi set nome=$2, sigla=$3, indirizzo=$4, societa=$5, email=$6, riuniti=$7 where id=$1`, [id, d.nome, d.sigla, d.indirizzo, d.societa, d.email, d.riuniti]);
  else {
    id = require('crypto').randomUUID();
    await store.q(`insert into sedi (id, nome, sigla, indirizzo, societa, email, riuniti, sort) values ($1,$2,$3,$4,$5,$6,$7, (select coalesce(max(sort),0)+1 from sedi))`,
      [id, d.nome, d.sigla, d.indirizzo, d.societa, d.email, d.riuniti]);
  }
  return id;
}
app.get('/api/admin/sedi', needAdmin, wrap(async (req, res) => res.json({ sedi: await store.listSedi() })));
app.post('/api/admin/sedi', needAdmin, wrap(async (req, res) => {
  await salvaSede(null, leggiSede(req.body));
  res.json({ sedi: await store.listSedi(), avvisi: await sincronizzaSedi(req.user) });
}));
app.put('/api/admin/sedi/:id', needAdmin, wrap(async (req, res) => {
  const { rows } = await store.q('select id from sedi where id = $1', [req.params.id]);
  if (!rows[0]) return bad(res, 404, 'Sede non trovata');
  await salvaSede(req.params.id, leggiSede(req.body));
  res.json({ sedi: await store.listSedi(), avvisi: await sincronizzaSedi(req.user) });
}));
app.post('/api/admin/sedi/:id/stato', needAdmin, wrap(async (req, res) => {
  await store.q('update sedi set attiva = $2 where id = $1', [req.params.id, !!req.body.attiva]);
  res.json({ sedi: await store.listSedi(), avvisi: await sincronizzaSedi(req.user) });
}));
app.post('/api/admin/sedi/sincronizza', needAdmin, wrap(async (req, res) => {
  res.json({ sedi: await store.listSedi(), avvisi: await sincronizzaSedi(req.user) });
}));
// Prima volta: crea le sedi centrali partendo da quelle già presenti in Nuovalab e Ticket (senza doppioni)
const normNome = s => String(s || '').toLowerCase().replace(/to\s*smile|studio|sede|ambulatorio/g, '').replace(/[^a-z0-9]/g, '');
app.post('/api/admin/sedi/importa', needAdmin, wrap(async (req, res) => {
  const esistenti = await store.listSedi();
  const trova = (nome, sigla) => esistenti.find(x => (sigla && x.sigla.toUpperCase() === sigla) || (normNome(nome) && normNome(x.nome) === normNome(nome)));
  // sigla libera: quella proposta, altrimenti le prime lettere dell'ultima parola del nome, altrimenti con un numero
  const libera = (sigla, nome) => {
    const usate = new Set(esistenti.map(x => String(x.sigla).toUpperCase()));
    const parola = String(nome || '').replace(/to\s*smile/ig, '').trim().split(/\s+/).pop() || 'SED';
    const prove = [sigla, parola.slice(0, 3), parola.slice(0, 2)].map(x => String(x || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 3)).filter(x => x.length >= 2);
    for (const p of prove) if (!usate.has(p)) return p;
    for (let i = 1; i < 10; i++) { const p = (prove[0] || 'SE').slice(0, 2) + i; if (!usate.has(p)) return p; }
    return null;
  };
  let nuove = 0;
  const lab = APPS.find(a => a.key === 'laboratorio'), tk = APPS.find(a => a.key === 'ticket');
  const catLab = await catalogo(lab, req.user, true).catch(() => ({}));
  for (const st of catLab.studi || []) {
    const sigla = String(st.sigla || '').trim().toUpperCase();
    if (trova(st.nome, sigla)) continue;
    const sig = libera(sigla, st.nome); if (!sig) continue;
    const id = await salvaSede(null, leggiSede({ nome: st.nome, sigla: sig, email: st.email || '' }));
    esistenti.push({ id, nome: st.nome, sigla: sig });
    nuove++;
  }
  const catTk = await catalogo(tk, req.user, true).catch(() => ({}));
  for (const st of catTk.studi || []) {
    const e = esistenti.find(x => normNome(x.nome) === normNome(st.nome) || (normNome(st.nome).length >= 4 && normNome(x.nome).includes(normNome(st.nome))));
    if (e) { // completa indirizzo e società se mancano
      await store.q(`update sedi set indirizzo = case when indirizzo = '' then $2 else indirizzo end, societa = case when societa = '' then $3 else societa end where id = $1`, [e.id, st.indirizzo || '', st.info || '']);
      continue;
    }
    const sig = libera('', st.nome); if (!sig) continue;
    try { const id = await salvaSede(null, leggiSede({ nome: st.nome, sigla: sig, indirizzo: st.indirizzo, societa: st.info })); esistenti.push({ id, nome: st.nome, sigla: sig }); nuove++; } catch {}
  }
  res.json({ sedi: await store.listSedi(), nuove, avvisi: nuove ? await sincronizzaSedi(req.user) : [] });
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
  if (limited('ticket|' + req.ip, 1500, 15)) /* larga: tutto uno studio può essere sulla stessa connessione */ return bad(res, 429, 'Troppe richieste');
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
