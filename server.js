// Mappa dei Protocolli — server
// Avvio: npm start. Impostazioni (variabili d'ambiente su Render): vedi README.md e .env.example
const path = require('path');
const express = require('express');
const session = require('express-session');
const PgStore = require('connect-pg-simple')(session);
const bcrypt = require('bcryptjs');
const multer = require('multer');
const db = require('./lib/db');
const ai = require('./lib/ai');
const { pdfText, wordText } = require('./lib/extract');

const PORT = process.env.PORT || 3000;
const PROD = process.env.NODE_ENV === 'production';
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use((req, res, next) => {
  res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
  next();
});
app.use(express.json({ limit: '2mb' }));
app.use(session({
  store: new PgStore({ pool: db.pool, createTableIfMissing: true }),
  name: 'mp.sid',
  secret: process.env.SESSION_SECRET || 'cambia-questa-chiave',
  resave: false,
  saveUninitialized: false,
  rolling: true,
  cookie: { httpOnly: true, sameSite: 'lax', secure: PROD, maxAge: 12 * 60 * 60 * 1000 },
}));

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, code, msg) => res.status(code).json({ error: msg });

/* ---------- autenticazione ---------- */
async function loadUser(req, res, next) {
  if (!req.session.uid) return next();
  const { rows } = await db.q('select id, username, name, title, role from users where id = $1', [req.session.uid]);
  if (rows[0]) req.user = rows[0]; else req.session.destroy(() => {});
  next();
}
app.use(wrap(loadUser));
const needUser = (req, res, next) => req.user ? next() : bad(res, 401, 'Accesso richiesto');
const needAdmin = (req, res, next) => req.user?.role === 'admin' ? next() : bad(res, 403, 'Solo amministratori');

// limite ai tentativi di accesso: 10 ogni 15 minuti per indirizzo e nome utente
const attempts = new Map();
function tooMany(key) {
  const now = Date.now(), a = (attempts.get(key) || []).filter(t => now - t < 15 * 60 * 1000);
  attempts.set(key, a); return a.length >= 10;
}

app.post('/api/login', wrap(async (req, res) => {
  const username = String(req.body.username || '').trim().toLowerCase(), password = String(req.body.password || '');
  const key = req.ip + '|' + username;
  if (tooMany(key)) return bad(res, 429, 'Troppi tentativi. Riprova tra 15 minuti.');
  const { rows } = await db.q('select * from users where username = $1', [username]);
  const u = rows[0];
  if (!u || !(await bcrypt.compare(password, u.password_hash))) {
    attempts.get(key).push(Date.now());
    return bad(res, 401, 'Nome utente o password non corretti.');
  }
  attempts.delete(key);
  req.session.regenerate(err => {
    if (err) return bad(res, 500, 'Errore di sessione');
    req.session.uid = u.id;
    res.json({ ok: true, role: u.role });
  });
}));
app.post('/api/logout', (req, res) => req.session.destroy(() => { res.clearCookie('mp.sid'); res.json({ ok: true }); }));
app.post('/api/me/password', needUser, wrap(async (req, res) => {
  const { current, next: nw } = req.body;
  if (!nw || String(nw).length < 8) return bad(res, 400, 'La nuova password deve avere almeno 8 caratteri.');
  const { rows } = await db.q('select password_hash, from_env from users where id = $1', [req.user.id]);
  if (rows[0].from_env) return bad(res, 400, 'La password di questo amministratore si cambia dalle impostazioni di Render (ADMIN_PASSWORD).');
  if (!(await bcrypt.compare(String(current || ''), rows[0].password_hash))) return bad(res, 400, 'La password attuale non è corretta.');
  await db.q('update users set password_hash = $2 where id = $1', [req.user.id, await bcrypt.hash(String(nw), 12)]);
  res.json({ ok: true });
}));

/* ---------- permessi ---------- */
async function accessMap(userId) {
  const { rows } = await db.q('select flow_id, mode, hide, nodes from access where user_id = $1', [userId]);
  return Object.fromEntries(rows.map(r => [r.flow_id, { mode: r.mode, hide: r.hide, nodes: r.nodes || [] }]));
}
// Restituisce i flussi come li vede l'utente: fasi bloccate o nascoste secondo i permessi.
async function visibleState(user) {
  const { rows: flows } = await db.q('select id, name, data from flows order by sort, name');
  const isAdmin = user.role === 'admin';
  const acc = isAdmin ? {} : await accessMap(user.id);
  const out = [], allowed = {};
  for (const f of flows) {
    const nodes = f.data.nodes || [], edges = f.data.edges || [];
    if (isAdmin) { out.push({ id: f.id, name: f.name, nodes, edges, manual: !!f.data.manual }); allowed[f.id] = new Set(nodes.map(n => n.id)); continue; }
    const a = acc[f.id];
    if (!a || a.mode === 'none') continue;
    const ok = new Set(a.mode === 'all' ? nodes.map(n => n.id) : a.nodes.filter(id => nodes.some(n => n.id === id)));
    allowed[f.id] = ok;
    let vn = nodes.map(n => ({ ...n, locked: !ok.has(n.id) }));
    let ve = edges;
    if (a.mode === 'some' && a.hide) { vn = vn.filter(n => !n.locked); ve = edges.filter(e => ok.has(e[0]) && ok.has(e[1])); }
    out.push({ id: f.id, name: f.name, nodes: vn, edges: ve, manual: !!f.data.manual });
  }
  return { flows: out, allowed };
}
async function visibleDocs(user, allowed, withBody = true) {
  const { rows } = await db.q(`select id, flow_id, node_id, title, type, ${withBody ? 'body,' : ''} example, file_name, file_mime,
    (file is not null) as has_file, to_char(updated_at, 'YYYY-MM-DD') as updated from docs order by title`);
  return rows.filter(d => user.role === 'admin' || allowed[d.flow_id]?.has(d.node_id)).map(d => ({
    id: d.id, flowId: d.flow_id, nodeId: d.node_id, title: d.title, type: d.type, body: d.body, example: d.example,
    updated: d.updated, hasFile: d.has_file, fileName: d.file_name, fileMime: d.file_mime,
    orphan: !allowed[d.flow_id]?.has(d.node_id),
  }));
}
async function canReadDoc(user, docId) {
  const { rows } = await db.q('select id, flow_id, node_id from docs where id = $1', [docId]);
  if (!rows[0]) return null;
  if (user.role === 'admin') return rows[0];
  const { allowed } = await visibleState(user);
  return allowed[rows[0].flow_id]?.has(rows[0].node_id) ? rows[0] : null;
}

/* ---------- stato dell'app ---------- */
app.get('/api/state', needUser, wrap(async (req, res) => {
  const { flows, allowed } = await visibleState(req.user);
  const docs = await visibleDocs(req.user, allowed);
  const out = { me: req.user, flows, docs, ai: ai.providerInfo().ok };
  if (req.user.role === 'admin') {
    const { rows: users } = await db.q('select id, username, name, title, role, from_env from users order by role, name');
    const { rows: acc } = await db.q('select * from access');
    out.users = users.map(u => ({
      id: u.id, username: u.username, name: u.name, title: u.title, role: u.role, fromEnv: u.from_env,
      access: Object.fromEntries(acc.filter(a => a.user_id === u.id).map(a => [a.flow_id, { mode: a.mode, hide: a.hide, nodes: a.nodes }])),
    }));
  }
  res.json(out);
}));

/* ---------- flussi (admin) ---------- */
function cleanFlow(b) {
  const nodes = (Array.isArray(b.nodes) ? b.nodes : []).map(n => ({
    id: String(n.id).slice(0, 64), label: String(n.label ?? '').slice(0, 200), sub: (Array.isArray(n.sub) ? n.sub : []).map(s => String(s).slice(0, 300)).slice(0, 20),
    c: String(n.c || 'op').slice(0, 10), x: Math.round(+n.x || 0), y: Math.round(+n.y || 0), ...(n.z && +n.z !== 1 ? { z: +(+n.z).toFixed(3) } : {}),
  }));
  const ids = new Set(nodes.map(n => n.id));
  const edges = (Array.isArray(b.edges) ? b.edges : []).filter(e => Array.isArray(e) && ids.has(e[0]) && ids.has(e[1])).map(e => e.slice(0, 3));
  return { nodes, edges, manual: !!b.manual };
}
app.post('/api/flows', needAdmin, wrap(async (req, res) => {
  const id = db.newId(), name = String(req.body.name || 'Nuovo flusso').slice(0, 120);
  const { rows } = await db.q('select coalesce(max(sort),0)+1 as s from flows');
  await db.q('insert into flows (id, name, data, sort) values ($1,$2,$3,$4)', [id, name, JSON.stringify(cleanFlow(req.body)), rows[0].s]);
  res.json({ id });
}));
app.put('/api/flows/:id', needAdmin, wrap(async (req, res) => {
  const r = await db.q('update flows set name = $2, data = $3, updated_at = now() where id = $1',
    [req.params.id, String(req.body.name || 'Senza nome').slice(0, 120), JSON.stringify(cleanFlow(req.body))]);
  if (!r.rowCount) return bad(res, 404, 'Flusso non trovato');
  res.json({ ok: true });
}));
app.delete('/api/flows/:id', needAdmin, wrap(async (req, res) => {
  await db.q('delete from flows where id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/* ---------- documenti ---------- */
async function docFields(req) {
  const b = req.body, f = req.file;
  const out = {
    title: String(b.title || '').trim().slice(0, 200), type: String(b.type || 'Protocollo').slice(0, 40),
    flowId: String(b.flowId || ''), nodeId: String(b.nodeId || ''), body: String(b.body || ''),
  };
  if (f) {
    const name = f.originalname || 'file';
    if (/pdf$/i.test(f.mimetype) || /\.pdf$/i.test(name)) {
      out.file = { buf: f.buffer, name, mime: 'application/pdf' };
      if (!out.body.trim()) { try { out.body = await pdfText(f.buffer); } catch (e) { out.body = ''; } }
    } else if (/\.docx$/i.test(name)) {
      out.body = await wordText(f.buffer);
    } else if (/\.(txt|md)$/i.test(name) || /^text\//.test(f.mimetype)) {
      out.body = f.buffer.toString('utf8');
    } else {
      const e = new Error('Formato non supportato: carica un PDF, un Word (.docx) o un file di testo.'); e.status = 400; throw e;
    }
    if (!out.title) out.title = name.replace(/\.[^.]+$/, '');
  }
  return out;
}
app.post('/api/docs', needAdmin, upload.single('file'), wrap(async (req, res) => {
  const d = await docFields(req);
  if (!d.title) return bad(res, 400, 'Manca il titolo.');
  if (!d.body.trim() && !d.file) return bad(res, 400, 'Il documento è vuoto.');
  const id = db.newId();
  await db.q(`insert into docs (id, flow_id, node_id, title, type, body, file, file_name, file_mime, updated_by)
              values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, d.flowId, d.nodeId, d.title, d.type, d.body, d.file?.buf || null, d.file?.name || null, d.file?.mime || null, req.user.id]);
  res.json({ id });
}));
app.put('/api/docs/:id', needAdmin, upload.single('file'), wrap(async (req, res) => {
  const d = await docFields(req);
  if (!d.title) return bad(res, 400, 'Manca il titolo.');
  const removeFile = req.body.removeFile === '1';
  const sets = ['flow_id=$2', 'node_id=$3', 'title=$4', 'type=$5', 'body=$6', 'example=false', 'updated_at=now()', 'updated_by=$7'];
  const params = [req.params.id, d.flowId, d.nodeId, d.title, d.type, d.body, req.user.id];
  if (d.file) { params.push(d.file.buf, d.file.name, d.file.mime); sets.push(`file=$8`, `file_name=$9`, `file_mime=$10`); }
  else if (removeFile) sets.push('file=null', 'file_name=null', 'file_mime=null');
  const r = await db.q(`update docs set ${sets.join(', ')} where id = $1`, params);
  if (!r.rowCount) return bad(res, 404, 'Documento non trovato');
  res.json({ ok: true });
}));
app.delete('/api/docs/:id', needAdmin, wrap(async (req, res) => {
  await db.q('delete from docs where id = $1', [req.params.id]);
  res.json({ ok: true });
}));
// Il PDF si apre solo dentro il lettore dell'app (con filigrana); nessun pulsante di download.
app.get('/api/docs/:id/file', needUser, wrap(async (req, res) => {
  if (!(await canReadDoc(req.user, req.params.id))) return bad(res, 404, 'Documento non disponibile');
  const { rows } = await db.q('select file, file_mime from docs where id = $1', [req.params.id]);
  if (!rows[0]?.file) return bad(res, 404, 'Nessun file');
  res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'inline', 'Cache-Control': 'no-store, private' });
  res.send(rows[0].file);
}));

/* ---------- collaboratori (admin) ---------- */
const cleanUsername = s => String(s || '').trim().toLowerCase().replace(/\s+/g, '.').replace(/[^a-z0-9._@-]/g, '').slice(0, 60);
app.post('/api/users', needAdmin, wrap(async (req, res) => {
  const username = cleanUsername(req.body.username), password = String(req.body.password || '');
  if (username.length < 3) return bad(res, 400, 'Il nome utente deve avere almeno 3 caratteri.');
  if (password.length < 8) return bad(res, 400, 'La password deve avere almeno 8 caratteri.');
  const exists = await db.q('select 1 from users where username = $1', [username]);
  if (exists.rowCount) return bad(res, 400, 'Questo nome utente esiste già.');
  const id = db.newId();
  await db.q('insert into users (id, username, name, title, role, password_hash) values ($1,$2,$3,$4,$5,$6)',
    [id, username, String(req.body.name || '').slice(0, 120), String(req.body.title || '').slice(0, 120), req.body.role === 'admin' ? 'admin' : 'collab', await bcrypt.hash(password, 12)]);
  res.json({ id, username });
}));
app.patch('/api/users/:id', needAdmin, wrap(async (req, res) => {
  const { rows } = await db.q('select * from users where id = $1', [req.params.id]);
  const u = rows[0]; if (!u) return bad(res, 404, 'Utente non trovato');
  const b = req.body;
  if (b.username !== undefined) {
    if (u.from_env) return bad(res, 400, 'Il nome utente di questo amministratore si cambia da Render (ADMIN_USERNAME).');
    const un = cleanUsername(b.username);
    if (un.length < 3) return bad(res, 400, 'Il nome utente deve avere almeno 3 caratteri.');
    const ex = await db.q('select 1 from users where username = $1 and id <> $2', [un, u.id]);
    if (ex.rowCount) return bad(res, 400, 'Questo nome utente esiste già.');
    await db.q('update users set username = $2 where id = $1', [u.id, un]);
  }
  if (b.name !== undefined) await db.q('update users set name = $2 where id = $1', [u.id, String(b.name).slice(0, 120)]);
  if (b.title !== undefined) await db.q('update users set title = $2 where id = $1', [u.id, String(b.title).slice(0, 120)]);
  if (b.role !== undefined) {
    if (u.id === req.user.id || u.from_env) return bad(res, 400, 'Non puoi cambiare il ruolo di questo account.');
    await db.q('update users set role = $2 where id = $1', [u.id, b.role === 'admin' ? 'admin' : 'collab']);
  }
  if (b.password !== undefined) {
    if (u.from_env) return bad(res, 400, 'La password di questo amministratore si cambia da Render (ADMIN_PASSWORD).');
    if (String(b.password).length < 8) return bad(res, 400, 'La password deve avere almeno 8 caratteri.');
    await db.q('update users set password_hash = $2 where id = $1', [u.id, await bcrypt.hash(String(b.password), 12)]);
    await db.q(`delete from session where sess->>'uid' = $1`, [u.id]).catch(() => {});
  }
  res.json({ ok: true });
}));
app.delete('/api/users/:id', needAdmin, wrap(async (req, res) => {
  const { rows } = await db.q('select from_env from users where id = $1', [req.params.id]);
  if (req.params.id === req.user.id || rows[0]?.from_env) return bad(res, 400, 'Questo account non si può eliminare.');
  await db.q('delete from users where id = $1', [req.params.id]);
  await db.q(`delete from session where sess->>'uid' = $1`, [req.params.id]).catch(() => {});
  res.json({ ok: true });
}));
app.put('/api/users/:id/access/:flowId', needAdmin, wrap(async (req, res) => {
  const mode = ['none', 'all', 'some'].includes(req.body.mode) ? req.body.mode : 'none';
  const nodes = Array.isArray(req.body.nodes) ? req.body.nodes.map(String).slice(0, 2000) : [];
  await db.q(`insert into access (user_id, flow_id, mode, hide, nodes) values ($1,$2,$3,$4,$5)
              on conflict (user_id, flow_id) do update set mode = excluded.mode, hide = excluded.hide, nodes = excluded.nodes`,
    [req.params.id, req.params.flowId, mode, !!req.body.hide, JSON.stringify(nodes)]);
  res.json({ ok: true });
}));

/* ---------- assistente AI ---------- */
const chatHits = new Map();
app.post('/api/chat', needUser, wrap(async (req, res) => {
  const now = Date.now(), h = (chatHits.get(req.user.id) || []).filter(t => now - t < 60000);
  if (h.length >= 15) return bad(res, 429, 'Troppe domande ravvicinate. Riprova tra un minuto.');
  h.push(now); chatHits.set(req.user.id, h);
  const info = ai.providerInfo();
  if (!info.ok) return bad(res, 503, 'L\'assistente non è ancora configurato. ' + info.reason);

  const { flows, allowed } = await visibleState(req.user);
  let docs = (await visibleDocs(req.user, allowed)).filter(d => !d.orphan);
  const wanted = new Set(Array.isArray(req.body.sourceIds) ? req.body.sourceIds : []);
  if (wanted.size) docs = docs.filter(d => wanted.has(d.id));
  if (!docs.length) return bad(res, 400, 'Nessuna fonte selezionata.');

  const label = d => { const f = flows.find(x => x.id === d.flowId); const n = f?.nodes.find(x => x.id === d.nodeId); return `fase "${n?.label || '?'}" del flusso "${f?.name || '?'}"`; };
  let budget = 180000;
  const sources = docs.map((d, i) => { const t = (d.body || '').slice(0, Math.max(0, Math.min(12000, budget))); budget -= t.length; return `[${i + 1}] ${d.title} (${d.type}) — ${label(d)}\n${t}`; });
  const system = `Sei l'assistente interno di uno studio odontoiatrico. Rispondi a ${req.user.name || req.user.username}${req.user.title ? ` (${req.user.title})` : ''}, in italiano, in modo chiaro e pratico.
Regole:
- Usa SOLO le informazioni contenute nelle FONTI qui sotto. Non aggiungere conoscenze esterne né inventare procedure.
- Dopo ogni frase o punto che prende un'informazione da una fonte, cita la fonte con il suo numero tra parentesi quadre, ad esempio [2]. Più fonti: [1, 3].
- Se la risposta non è nelle fonti, dillo chiaramente e suggerisci di chiedere all'amministratore dello studio.
- Per le procedure usa passaggi numerati. Risposte brevi: circa 200 parole al massimo, salvo richiesta.
- Formattazione ammessa: paragrafi, elenchi con "-" o "1.", **grassetto**. Niente tabelle.

FONTI:
${sources.join('\n\n---\n\n')}`;
  const msgs = (Array.isArray(req.body.messages) ? req.body.messages : []).slice(-10)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 4000) })).filter(m => m.content);
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return bad(res, 400, 'Domanda mancante.');
  try {
    const text = await ai.complete(system, msgs);
    res.json({ text: text || 'Non è arrivata una risposta. Prova a riformulare la domanda.', sourceIds: docs.map(d => d.id) });
  } catch (e) {
    console.error('Errore AI:', e.message);
    bad(res, 502, 'L\'assistente non ha risposto. Riprova tra poco; se l\'errore continua controlla chiave e modello su Render.');
  }
}));

/* ---------- pagine ---------- */
const page = (file, mode) => (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!file.startsWith('login') && !req.user) return res.redirect('/login' + (mode === 'admin' ? '?next=/admin' : ''));
  if (mode === 'admin' && req.user.role !== 'admin') return res.redirect('/');
  res.sendFile(path.join(__dirname, 'public', file));
};
app.get('/login', page('login.html'));
app.get('/admin/login', (req, res) => res.redirect('/login?next=/admin'));
app.get('/', page('app.html', 'view'));
app.get('/admin', page('app.html', 'admin'));
app.get('/healthz', (req, res) => res.send('ok'));
app.use('/static', express.static(path.join(__dirname, 'public', 'static'), { maxAge: '1h' }));

app.use((err, req, res, next) => {
  if (err.status === 400) return bad(res, 400, err.message);
  if (err.code === 'LIMIT_FILE_SIZE') return bad(res, 400, 'Il file supera 25 MB.');
  console.error(err);
  bad(res, 500, 'Errore del server. Riprova.');
});

(async () => {
  await db.migrate();
  await db.ensureEnvAdmin();
  await db.seedIfEmpty();
  app.listen(PORT, () => console.log(`Mappa dei Protocolli attiva sulla porta ${PORT}`));
})().catch(e => { console.error('Avvio non riuscito:', e); process.exit(1); });
