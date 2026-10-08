// Magazzino centrale — server (gira insieme ad Accesso unico, Protocolli e Calendario: vedi index.js).
// Si entra solo con l'accesso unico di appgestione.it. Ruoli dal pannello accessi:
//   Amministratore → gestisce categorie, articoli, fornitori, prenotazioni, riordino;
//   Utente         → vede le disponibilità e prenota.
const path = require('path');
const express = require('express');
const db = require('./lib/db');
const push = require('./lib/push');
const mail = require('../accessi/lib/mail');

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
const int = (v, min = 0, max = 1e9) => { const n = Math.round(Number(v)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : null; };
const fail = (status, msg) => Object.assign(new Error(msg), { status });

/* ---------- accesso unico ---------- */
const sso = require('../accessi/collega')({ app: 'magazzino', toLocal: localProfile });
async function localProfile(c, role) {
  const r = role === 'admin' ? 'admin' : 'client';
  const name = `${c.firstName} ${c.lastName}`.trim() || c.email;
  const { rows } = await db.q(`insert into users (id, sso_id, email, name, role, last_seen, figura) values ($1,$2,$3,$4,$5, now(), $6)
    on conflict (sso_id) do update set email = excluded.email, name = excluded.name, role = excluded.role, figura = excluded.figura,
      last_seen = case when users.last_seen is null or users.last_seen < now() - interval '10 minutes' then now() else users.last_seen end
    returning id, email, name, role, figura`, [db.newId(), c.id, c.email, name, r, c.figura || null]);
  return rows[0];
}
sso.onProvision(({ user, role }) => localProfile(user, role).then(() => null));

app.use(wrap(async (req, res, next) => {
  const r = await sso.identify(req);
  if (r?.user) req.user = r.user; else if (r?.denied) req.ssoDenied = true;
  next();
}));
const needUser = (req, res, next) => req.user ? next() : bad(res, 401, 'Accesso richiesto');
const needAdmin = (req, res, next) => req.user?.role === 'admin' ? next() : bad(res, 403, 'Solo amministratori');
// Le richieste che cambiano dati devono essere JSON (un modulo di un altro sito non può inviarle).
app.use('/api', (req, res, next) => (['GET', 'HEAD', 'DELETE'].includes(req.method) || req.is('application/json')) ? next() : bad(res, 415, 'Formato non valido'));

/* ---------- calcoli comuni ---------- */
// Disponibile = giacenza − quantità già prenotate (in attesa di conferma).
const ARTICOLI_SQL = `
  select a.*, coalesce(imp.q, 0)::int as impegnato, coalesce(arr.q, 0)::int as in_arrivo,
         (a.giacenza - coalesce(imp.q, 0))::int as disponibile, f.nome as fornitore_nome
  from articoli a
  left join fornitori f on f.id = a.fornitore_id
  left join (select r.articolo_id, sum(r.quantita) q from prenotazione_righe r join prenotazioni p on p.id = r.prenotazione_id
             where p.stato = 'in_attesa' group by r.articolo_id) imp on imp.articolo_id = a.id
  left join (select r.articolo_id, sum(r.quantita) q from ordine_righe r join ordini_fornitore o on o.id = r.ordine_id
             where o.stato in ('da_inviare','inviato') group by r.articolo_id) arr on arr.articolo_id = a.id`;

const shapeArticolo = (a, admin) => ({
  id: a.id, categoriaId: a.categoria_id, nome: a.nome, codice: a.codice, unita: a.unita, note: a.note,
  disponibile: Math.max(0, a.disponibile),
  ...(admin ? { giacenza: a.giacenza, impegnato: a.impegnato, inArrivo: a.in_arrivo, scortaMinima: a.scorta_minima,
    livelloCarico: a.livello_carico, fornitoreId: a.fornitore_id, fornitoreNome: a.fornitore_nome, attivo: a.attivo } : {}),
});

async function registraMovimento(qq, articoloId, delta, causale, riferimento, utenteId) {
  const { rows } = await qq('update articoli set giacenza = giacenza + $2, aggiornato_il = now() where id = $1 returning giacenza', [articoloId, delta]);
  if (!rows[0]) throw fail(404, 'Articolo non trovato');
  await qq(`insert into movimenti (id, articolo_id, delta, giacenza_dopo, causale, riferimento, utente_id) values ($1,$2,$3,$4,$5,$6,$7)`,
    [db.newId(), articoloId, delta, rows[0].giacenza, causale, riferimento, utenteId]);
  return rows[0].giacenza;
}

async function prenotazioni(where, params) {
  const { rows } = await db.q(`select p.*, u.name as utente_nome, u.email as utente_email, u.figura as utente_figura, g.name as gestita_nome,
      coalesce((select json_agg(json_build_object('id', r.id, 'articoloId', r.articolo_id, 'nome', r.nome, 'unita', r.unita, 'quantita', r.quantita) order by r.nome)
        from prenotazione_righe r where r.prenotazione_id = p.id), '[]') as righe
    from prenotazioni p join users u on u.id = p.utente_id left join users g on g.id = p.gestita_da
    ${where} order by p.creata_il desc limit 200`, params);
  return rows.map(p => ({ id: p.id, numero: p.numero, stato: p.stato, note: p.note, motivo: p.motivo, creataIl: p.creata_il,
    gestitaIl: p.gestita_il, gestitaDa: p.gestita_nome, utente: p.utente_nome, utenteEmail: p.utente_email, utenteFigura: p.utente_figura || '', righe: p.righe }));
}

/* ---------- stato dell'app ---------- */
app.get('/api/state', needUser, wrap(async (req, res) => {
  const admin = req.user.role === 'admin';
  const [cat, art] = await Promise.all([
    db.q('select id, nome, ordine from categorie order by ordine, nome'),
    db.q(`${ARTICOLI_SQL} ${admin ? '' : 'where a.attivo'} order by a.nome`),
  ]);
  const out = {
    me: req.user, links: sso.links(),
    categorie: cat.rows, articoli: art.rows.map(a => shapeArticolo(a, admin)),
    prenotazioni: await prenotazioni(admin ? `where p.stato = 'in_attesa' or p.creata_il > now() - interval '60 days'` : 'where p.utente_id = $1',
      admin ? [] : [req.user.id]),
  };
  if (admin) {
    out.fornitori = (await db.q('select * from fornitori order by nome')).rows;
    out.carrello = await carrello();
    out.ordini = await ordini();
  }
  res.json(out);
}));

/* ---------- prenotazioni (clienti) ---------- */
app.post('/api/prenotazioni', needUser, wrap(async (req, res) => {
  const righe = (Array.isArray(req.body.righe) ? req.body.righe : [])
    .map(r => ({ articoloId: str(r.articoloId, 64), quantita: int(r.quantita, 0, 100000) }))
    .filter(r => r.articoloId && r.quantita > 0);
  if (!righe.length) return bad(res, 400, 'Il carrello è vuoto.');
  const ids = [...new Set(righe.map(r => r.articoloId))];
  if (ids.length !== righe.length) return bad(res, 400, 'Articolo ripetuto nella prenotazione.');
  const id = db.newId();
  const numero = await db.tx(async qq => {
    // blocca le righe degli articoli: due prenotazioni contemporanee non possono superare la giacenza
    const { rows: arts } = await qq('select id, nome, unita, giacenza, attivo from articoli where id = any($1) order by id for update', [ids]);
    const { rows: imp } = await qq(`select r.articolo_id, sum(r.quantita)::int q from prenotazione_righe r join prenotazioni p on p.id = r.prenotazione_id
      where p.stato = 'in_attesa' and r.articolo_id = any($1) group by r.articolo_id`, [ids]);
    const impegnato = Object.fromEntries(imp.map(r => [r.articolo_id, r.q]));
    for (const r of righe) {
      const a = arts.find(x => x.id === r.articoloId);
      if (!a || !a.attivo) throw fail(400, 'Un articolo non è più disponibile: aggiorna la pagina.');
      const disp = a.giacenza - (impegnato[a.id] || 0);
      if (r.quantita > disp) throw fail(409, `«${a.nome}»: ne restano solo ${Math.max(0, disp)} ${a.unita}: correggi la quantità.`);
      r.nome = a.nome; r.unita = a.unita;
    }
    const { rows } = await qq('insert into prenotazioni (id, utente_id, note) values ($1,$2,$3) returning numero', [id, req.user.id, str(req.body.note, 500)]);
    for (const r of righe) {
      await qq('insert into prenotazione_righe (id, prenotazione_id, articolo_id, nome, unita, quantita) values ($1,$2,$3,$4,$5,$6)',
        [db.newId(), id, r.articoloId, r.nome, r.unita, r.quantita]);
    }
    return rows[0].numero;
  });
  avvisaAdmin({ title: `Nuova prenotazione n. ${numero}`,
    body: `${req.user.name}: ${righe.length} ${righe.length === 1 ? 'articolo' : 'articoli'}. Tocca per confermare o rifiutare.`,
    url: '/?vista=richieste', tag: 'prenotazione-' + id });
  res.json({ ok: true, id, numero });
}));

app.post('/api/prenotazioni/:id/annulla', needUser, wrap(async (req, res) => {
  const { rowCount } = await db.q(`update prenotazioni set stato = 'annullata', gestita_il = now(), gestita_da = $2
    where id = $1 and utente_id = $2 and stato = 'in_attesa'`, [req.params.id, req.user.id]);
  if (!rowCount) return bad(res, 400, 'La prenotazione non è più in attesa.');
  res.json({ ok: true });
}));

/* ---------- prenotazioni (amministratore) ---------- */
app.post('/api/prenotazioni/:id/conferma', needAdmin, wrap(async (req, res) => {
  const p = await db.tx(async qq => {
    const { rows } = await qq(`select p.*, u.id as uid from prenotazioni p join users u on u.id = p.utente_id where p.id = $1 for update`, [req.params.id]);
    const p = rows[0];
    if (!p) throw fail(404, 'Prenotazione non trovata');
    if (p.stato !== 'in_attesa') throw fail(400, 'La prenotazione è già stata gestita.');
    const { rows: righe } = await qq('select * from prenotazione_righe where prenotazione_id = $1', [p.id]);
    const { rows: arts } = await qq('select id, nome, unita, giacenza from articoli where id = any($1) order by id for update', [righe.map(r => r.articolo_id)]);
    for (const r of righe) {
      const a = arts.find(x => x.id === r.articolo_id);
      if (!a || a.giacenza < r.quantita) throw fail(409, `Giacenza insufficiente per «${r.nome}» (${a ? a.giacenza : 0} ${r.unita}). Correggi la giacenza o rifiuta.`);
    }
    for (const r of righe) await registraMovimento(qq, r.articolo_id, -r.quantita, 'Prenotazione confermata', `Prenotazione n. ${p.numero}`, req.user.id);
    await qq(`update prenotazioni set stato = 'confermata', gestita_il = now(), gestita_da = $2 where id = $1`, [p.id, req.user.id]);
    return p;
  });
  push.sendToUsers([p.uid], { title: `Prenotazione n. ${p.numero} confermata`, body: 'Il magazzino ha confermato la tua richiesta.', url: '/', tag: 'esito-' + p.id }).catch(() => {});
  res.json({ ok: true });
}));

app.post('/api/prenotazioni/:id/rifiuta', needAdmin, wrap(async (req, res) => {
  const motivo = str(req.body.motivo, 300);
  const { rows } = await db.q(`update prenotazioni set stato = 'rifiutata', motivo = $3, gestita_il = now(), gestita_da = $2
    where id = $1 and stato = 'in_attesa' returning numero, utente_id`, [req.params.id, req.user.id, motivo]);
  if (!rows[0]) return bad(res, 400, 'La prenotazione è già stata gestita.');
  push.sendToUsers([rows[0].utente_id], { title: `Prenotazione n. ${rows[0].numero} rifiutata`,
    body: motivo || 'Apri il magazzino per i dettagli.', url: '/', tag: 'esito-' + req.params.id }).catch(() => {});
  res.json({ ok: true });
}));

async function avvisaAdmin(payload) {
  try {
    const { rows } = await db.q(`select id from users where role = 'admin'`);
    await push.sendToUsers(rows.map(r => r.id), payload);
  } catch (e) { console.warn('Magazzino, notifica non inviata:', e.message); }
}

/* ---------- categorie ---------- */
app.post('/api/categorie', needAdmin, wrap(async (req, res) => {
  const nome = str(req.body.nome, 80);
  if (!nome) return bad(res, 400, 'Scrivi il nome della categoria.');
  const id = db.newId();
  await db.q(`insert into categorie (id, nome, ordine) values ($1, $2, coalesce((select max(ordine) + 1 from categorie), 0))`, [id, nome]);
  res.json({ id });
}));
app.put('/api/categorie/:id', needAdmin, wrap(async (req, res) => {
  const nome = str(req.body.nome, 80);
  if (!nome) return bad(res, 400, 'Il nome non può essere vuoto.');
  await db.q('update categorie set nome = $2 where id = $1', [req.params.id, nome]);
  res.json({ ok: true });
}));
app.post('/api/categorie/ordine', needAdmin, wrap(async (req, res) => {
  const ids = (Array.isArray(req.body.ids) ? req.body.ids : []).map(x => str(x, 64));
  for (let i = 0; i < ids.length; i++) await db.q('update categorie set ordine = $2 where id = $1', [ids[i], i]);
  res.json({ ok: true });
}));
app.delete('/api/categorie/:id', needAdmin, wrap(async (req, res) => {
  const { rows } = await db.q('select count(*)::int n from articoli where categoria_id = $1', [req.params.id]);
  if (rows[0].n) return bad(res, 400, `La categoria contiene ${rows[0].n} articoli: spostali o eliminali prima.`);
  await db.q('delete from categorie where id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/* ---------- articoli ---------- */
function datiArticolo(b, parziale) {
  const o = {};
  if (!parziale || b.nome !== undefined) { o.nome = str(b.nome, 120); if (!o.nome) throw fail(400, "Scrivi il nome dell'articolo."); }
  if (!parziale || b.categoriaId !== undefined) { o.categoria_id = str(b.categoriaId, 64); if (!o.categoria_id) throw fail(400, 'Scegli la categoria.'); }
  if (!parziale || b.codice !== undefined) o.codice = str(b.codice, 60);
  if (!parziale || b.unita !== undefined) o.unita = str(b.unita, 20) || 'pz';
  if (!parziale || b.note !== undefined) o.note = str(b.note, 500);
  if (!parziale || b.scortaMinima !== undefined) o.scorta_minima = int(b.scortaMinima) ?? 0;
  if (!parziale || b.livelloCarico !== undefined) o.livello_carico = int(b.livelloCarico) ?? 0;
  if (!parziale || b.fornitoreId !== undefined) o.fornitore_id = str(b.fornitoreId, 64) || null;
  if (b.attivo !== undefined) o.attivo = !!b.attivo;
  return o;
}
app.post('/api/articoli', needAdmin, wrap(async (req, res) => {
  const o = datiArticolo(req.body, false);
  const giacenza = int(req.body.giacenza) ?? 0;
  const id = db.newId();
  await db.tx(async qq => {
    await qq(`insert into articoli (id, categoria_id, nome, codice, unita, note, scorta_minima, livello_carico, fornitore_id, giacenza)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,0)`, [id, o.categoria_id, o.nome, o.codice, o.unita, o.note, o.scorta_minima, o.livello_carico, o.fornitore_id]);
    if (giacenza > 0) await registraMovimento(qq, id, giacenza, 'Giacenza iniziale', '', req.user.id);
  });
  res.json({ id });
}));
app.put('/api/articoli/:id', needAdmin, wrap(async (req, res) => {
  const o = datiArticolo(req.body, true);
  const keys = Object.keys(o);
  if (keys.length) {
    await db.q(`update articoli set ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, aggiornato_il = now() where id = $1`,
      [req.params.id, ...keys.map(k => o[k])]);
  }
  res.json({ ok: true });
}));
// Rettifica della giacenza (inventario, merce rotta, carico manuale…): resta traccia nei movimenti.
app.post('/api/articoli/:id/giacenza', needAdmin, wrap(async (req, res) => {
  const nuova = int(req.body.giacenza);
  if (nuova === null) return bad(res, 400, 'Quantità non valida.');
  const causale = str(req.body.causale, 120) || 'Rettifica inventario';
  const g = await db.tx(async qq => {
    const { rows } = await qq('select giacenza from articoli where id = $1 for update', [req.params.id]);
    if (!rows[0]) throw fail(404, 'Articolo non trovato');
    const delta = nuova - rows[0].giacenza;
    return delta ? registraMovimento(qq, req.params.id, delta, causale, '', req.user.id) : rows[0].giacenza;
  });
  res.json({ giacenza: g });
}));
app.get('/api/articoli/:id/movimenti', needAdmin, wrap(async (req, res) => {
  const { rows } = await db.q(`select m.delta, m.giacenza_dopo, m.causale, m.riferimento, m.creato_il, u.name as utente
    from movimenti m left join users u on u.id = m.utente_id where m.articolo_id = $1 order by m.creato_il desc limit 100`, [req.params.id]);
  res.json({ movimenti: rows });
}));
app.delete('/api/articoli/:id', needAdmin, wrap(async (req, res) => {
  const { rows } = await db.q(`select (select count(*) from prenotazione_righe where articolo_id = $1)::int p,
    (select count(*) from ordine_righe where articolo_id = $1)::int o`, [req.params.id]);
  if (rows[0].p || rows[0].o) return bad(res, 400, "L'articolo compare in prenotazioni o ordini: per non perdere lo storico disattivalo invece di eliminarlo.");
  await db.q('delete from articoli where id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/* ---------- fornitori ---------- */
function datiFornitore(b) {
  const o = { nome: str(b.nome, 120), email: str(b.email, 160).toLowerCase(), telefono: str(b.telefono, 40), note: str(b.note, 500) };
  if (!o.nome) throw fail(400, 'Scrivi il nome del fornitore.');
  if (o.email && !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(o.email)) throw fail(400, "L'email del fornitore non è valida.");
  return o;
}
app.post('/api/fornitori', needAdmin, wrap(async (req, res) => {
  const o = datiFornitore(req.body), id = db.newId();
  await db.q('insert into fornitori (id, nome, email, telefono, note) values ($1,$2,$3,$4,$5)', [id, o.nome, o.email, o.telefono, o.note]);
  res.json({ id });
}));
app.put('/api/fornitori/:id', needAdmin, wrap(async (req, res) => {
  const o = datiFornitore(req.body);
  await db.q('update fornitori set nome=$2, email=$3, telefono=$4, note=$5 where id=$1', [req.params.id, o.nome, o.email, o.telefono, o.note]);
  res.json({ ok: true });
}));
app.delete('/api/fornitori/:id', needAdmin, wrap(async (req, res) => {
  await db.q('delete from fornitori where id = $1', [req.params.id]); // gli articoli restano, senza fornitore
  res.json({ ok: true });
}));

/* ---------- carrello di riordino ---------- */
// Un articolo entra nel carrello quando (giacenza + merce già ordinata) scende alla scorta minima.
// Quantità proposta = livello di carico − giacenza − merce già ordinata. L'amministratore può cambiarla,
// toglierla dal carrello o aggiungere a mano altri articoli.
async function carrello() {
  const { rows } = await db.q(`${ARTICOLI_SQL.replace('select a.*', 'select a.*, c.quantita as c_quantita, c.escluso as c_escluso')
    .replace('from articoli a', 'from articoli a left join carrello c on c.articolo_id = a.id')}
    where a.attivo order by f.nome nulls last, a.nome`);
  const out = [], pulisci = [];
  for (const a of rows) {
    const disponibileReale = a.giacenza + a.in_arrivo;
    const serve = a.scorta_minima > 0 && disponibileReale <= a.scorta_minima;
    const proposta = Math.max(0, a.livello_carico - disponibileReale);
    const manuale = a.c_quantita !== null && a.c_quantita !== undefined;
    if (a.c_escluso && !serve) { pulisci.push(a.id); continue; } // non serve più: dimentica l'esclusione
    if (a.c_escluso) continue;
    if (!serve && !manuale) continue;
    const quantita = manuale ? a.c_quantita : proposta;
    out.push({ articoloId: a.id, nome: a.nome, codice: a.codice, unita: a.unita, giacenza: a.giacenza, inArrivo: a.in_arrivo,
      scortaMinima: a.scorta_minima, livelloCarico: a.livello_carico, proposta, quantita, manuale, sottoScorta: serve,
      fornitoreId: a.fornitore_id, fornitoreNome: a.fornitore_nome });
  }
  if (pulisci.length) await db.q('delete from carrello where articolo_id = any($1)', [pulisci]);
  return out;
}
app.put('/api/carrello/:articoloId', needAdmin, wrap(async (req, res) => {
  const quantita = int(req.body.quantita, 0, 1e6);
  if (quantita === null) return bad(res, 400, 'Quantità non valida.');
  await db.q(`insert into carrello (articolo_id, quantita, escluso) values ($1,$2,false)
    on conflict (articolo_id) do update set quantita = excluded.quantita, escluso = false`, [req.params.articoloId, quantita]);
  res.json({ carrello: await carrello() });
}));
app.delete('/api/carrello/:articoloId', needAdmin, wrap(async (req, res) => {
  await db.q(`insert into carrello (articolo_id, quantita, escluso) values ($1, null, true)
    on conflict (articolo_id) do update set quantita = null, escluso = true`, [req.params.articoloId]);
  res.json({ carrello: await carrello() });
}));

/* ---------- ordini ai fornitori ---------- */
async function ordini() {
  const { rows } = await db.q(`select o.*, u.name as creato_nome,
      coalesce((select json_agg(json_build_object('id', r.id, 'articoloId', r.articolo_id, 'nome', r.nome, 'codice', r.codice,
        'unita', r.unita, 'quantita', r.quantita, 'ricevuta', r.quantita_ricevuta) order by r.nome)
        from ordine_righe r where r.ordine_id = o.id), '[]') as righe
    from ordini_fornitore o left join users u on u.id = o.creato_da
    where o.stato in ('da_inviare','inviato') or o.creato_il > now() - interval '120 days'
    order by o.creato_il desc limit 100`);
  return rows.map(o => ({ id: o.id, numero: o.numero, stato: o.stato, fornitoreId: o.fornitore_id, fornitore: o.fornitore_nome,
    email: o.fornitore_email, note: o.note, creatoIl: o.creato_il, creatoDa: o.creato_nome, inviatoIl: o.inviato_il,
    ricevutoIl: o.ricevuto_il, righe: o.righe }));
}

function testoOrdine(o, righe, mittente) {
  const elenco = righe.map(r => `- ${r.nome}${r.codice ? ` (cod. ${r.codice})` : ''}: ${r.quantita} ${r.unita}`).join('\n');
  const html = mail.layout(`Ordine n. ${o.numero}`, [
    `Buongiorno${o.fornitore_nome ? ' ' + mail.esc(o.fornitore_nome) : ''},`,
    'vi chiediamo di fornirci i seguenti articoli:',
    `<table style="border-collapse:collapse;width:100%;font-size:14px">${righe.map(r => `<tr>
      <td style="padding:7px 8px;border-bottom:1px solid #E6E6DF">${mail.esc(r.nome)}${r.codice ? `<br><span style="color:#6B7276;font-size:12px">cod. ${mail.esc(r.codice)}</span>` : ''}</td>
      <td style="padding:7px 8px;border-bottom:1px solid #E6E6DF;text-align:right;white-space:nowrap"><b>${r.quantita}</b> ${mail.esc(r.unita)}</td></tr>`).join('')}</table>`,
    o.note ? `Note: ${mail.esc(o.note)}` : '',
    `Per qualsiasi chiarimento rispondete pure a questa email.<br>Grazie,<br>${mail.esc(mittente)} · Magazzino centrale To Smile`,
  ].filter(Boolean));
  const text = `Ordine n. ${o.numero}\n\nVi chiediamo di fornirci:\n${elenco}\n${o.note ? `\nNote: ${o.note}\n` : ''}\nGrazie,\n${mittente} - Magazzino centrale To Smile`;
  return { html, text };
}

async function inviaOrdine(ordineId, user) {
  const { rows } = await db.q('select * from ordini_fornitore where id = $1', [ordineId]);
  const o = rows[0];
  if (!o) throw fail(404, 'Ordine non trovato');
  if (!o.fornitore_email) throw fail(400, 'Il fornitore non ha un indirizzo email: aggiungilo oppure stampa l\'ordine.');
  if (!mail.enabled()) throw fail(400, "L'invio delle email non è attivo (manca RESEND_API_KEY): stampa l'ordine e mandalo tu.");
  const { rows: righe } = await db.q('select * from ordine_righe where ordine_id = $1 order by nome', [ordineId]);
  const { html, text } = testoOrdine(o, righe, user.name);
  const ok = await mail.send({ to: o.fornitore_email, replyTo: user.email, subject: `Ordine n. ${o.numero} — To Smile`, html, text });
  if (!ok) throw fail(502, "L'email non è partita. Riprova tra poco o stampa l'ordine.");
  await db.q(`update ordini_fornitore set stato = 'inviato', inviato_il = now() where id = $1 and stato in ('da_inviare','inviato')`, [ordineId]);
}

// Dal carrello crea un ordine per ogni fornitore (gli articoli senza fornitore finiscono in un ordine a parte, da stampare).
app.post('/api/carrello/ordina', needAdmin, wrap(async (req, res) => {
  const scelti = new Set((Array.isArray(req.body.articoli) ? req.body.articoli : []).map(x => str(x, 64)));
  const righe = (await carrello()).filter(r => r.quantita > 0 && (!scelti.size || scelti.has(r.articoloId)));
  if (!righe.length) return bad(res, 400, 'Il carrello di riordino è vuoto.');
  const gruppi = {};
  for (const r of righe) (gruppi[r.fornitoreId || ''] ||= []).push(r);
  const creati = await db.tx(async qq => {
    const ids = [];
    for (const [fid, rr] of Object.entries(gruppi)) {
      let f = { nome: 'Senza fornitore', email: '' };
      if (fid) f = (await qq('select nome, email from fornitori where id = $1', [fid])).rows[0] || f;
      const id = db.newId();
      await qq(`insert into ordini_fornitore (id, fornitore_id, fornitore_nome, fornitore_email, note, creato_da) values ($1,$2,$3,$4,$5,$6)`,
        [id, fid || null, f.nome, f.email, str(req.body.note, 500), req.user.id]);
      for (const r of rr) {
        await qq('insert into ordine_righe (id, ordine_id, articolo_id, nome, codice, unita, quantita) values ($1,$2,$3,$4,$5,$6,$7)',
          [db.newId(), id, r.articoloId, r.nome, r.codice, r.unita, r.quantita]);
      }
      await qq('delete from carrello where articolo_id = any($1)', [rr.map(r => r.articoloId)]);
      ids.push(id);
    }
    return ids;
  });
  const esito = [];
  if (req.body.invia) {
    for (const id of creati) {
      try { await inviaOrdine(id, req.user); esito.push({ id, inviato: true }); }
      catch (e) { esito.push({ id, inviato: false, errore: e.message }); }
    }
  }
  res.json({ ordini: creati, esito });
}));
app.post('/api/ordini/:id/invia', needAdmin, wrap(async (req, res) => {
  await inviaOrdine(req.params.id, req.user);
  res.json({ ok: true });
}));
app.post('/api/ordini/:id/segna-inviato', needAdmin, wrap(async (req, res) => {
  await db.q(`update ordini_fornitore set stato = 'inviato', inviato_il = coalesce(inviato_il, now()) where id = $1 and stato = 'da_inviare'`, [req.params.id]);
  res.json({ ok: true });
}));
// Merce arrivata: la giacenza sale delle quantità ricevute (anche diverse da quelle ordinate).
app.post('/api/ordini/:id/ricevuto', needAdmin, wrap(async (req, res) => {
  const ricevute = Object.fromEntries((Array.isArray(req.body.righe) ? req.body.righe : []).map(r => [str(r.id, 64), int(r.ricevuta, 0, 1e6)]));
  await db.tx(async qq => {
    const { rows } = await qq('select * from ordini_fornitore where id = $1 for update', [req.params.id]);
    const o = rows[0];
    if (!o) throw fail(404, 'Ordine non trovato');
    if (!['da_inviare', 'inviato'].includes(o.stato)) throw fail(400, "L'ordine è già chiuso.");
    const { rows: righe } = await qq('select * from ordine_righe where ordine_id = $1', [o.id]);
    for (const r of righe) {
      const q = ricevute[r.id] ?? r.quantita;
      await qq('update ordine_righe set quantita_ricevuta = $2 where id = $1', [r.id, q]);
      if (q > 0 && r.articolo_id) await registraMovimento(qq, r.articolo_id, q, 'Merce ricevuta', `Ordine n. ${o.numero} — ${o.fornitore_nome}`, req.user.id);
    }
    await qq(`update ordini_fornitore set stato = 'ricevuto', ricevuto_il = now() where id = $1`, [o.id]);
  });
  res.json({ ok: true });
}));
app.post('/api/ordini/:id/annulla', needAdmin, wrap(async (req, res) => {
  const { rowCount } = await db.q(`update ordini_fornitore set stato = 'annullato' where id = $1 and stato in ('da_inviare','inviato')`, [req.params.id]);
  if (!rowCount) return bad(res, 400, "L'ordine è già chiuso.");
  res.json({ ok: true });
}));

/* ---------- notifiche sul dispositivo ---------- */
app.get('/api/push/key', needUser, wrap(async (req, res) => res.json({ key: await push.publicKey() })));
app.post('/api/push/subscribe', needUser, wrap(async (req, res) => {
  const s = req.body.subscription || {};
  if (!s.endpoint || !s.keys?.p256dh || !s.keys?.auth || !/^https:\/\//.test(s.endpoint)) return bad(res, 400, 'Iscrizione non valida');
  await db.q(`insert into push_subs (endpoint, user_id, p256dh, auth) values ($1,$2,$3,$4)
    on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    [String(s.endpoint).slice(0, 1000), req.user.id, String(s.keys.p256dh).slice(0, 300), String(s.keys.auth).slice(0, 300)]);
  res.json({ ok: true });
}));
app.post('/api/push/unsubscribe', needUser, wrap(async (req, res) => {
  await db.q('delete from push_subs where endpoint = $1 and user_id = $2', [str(req.body.endpoint, 1000), req.user.id]);
  res.json({ ok: true });
}));
app.post('/api/push/test', needUser, wrap(async (req, res) => {
  const reached = await push.sendToUsers([req.user.id], { title: 'Notifiche attive', body: 'Da ora ricevi qui gli avvisi del Magazzino centrale.', url: '/' });
  res.json({ ok: reached.size > 0 });
}));

app.post('/api/logout', wrap(async (req, res) => { await sso.logout(req, res); res.json({ ok: true, home: sso.links().home }); }));

/* ---------- pagine ---------- */
const PUB = path.join(__dirname, 'public');
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return req.ssoDenied ? sso.toDenied(res) : sso.toLogin(req, res);
  res.sendFile(path.join(PUB, 'app.html'));
});
app.get(['/admin', '/login'], (req, res) => res.redirect('/'));
app.get('/sw.js', (req, res) => { res.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }); res.sendFile(path.join(PUB, 'sw.js')); });
for (const f of ['manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png']) {
  app.get('/' + f, (req, res) => res.sendFile(path.join(PUB, f), { maxAge: '7d' }));
}
app.get('/healthz', (req, res) => res.send('ok'));
app.use((req, res) => res.status(404).send('Pagina non trovata'));

app.use((err, req, res, next) => {
  if (err.status && err.status < 500) return bad(res, err.status, err.message);
  if (err.type === 'entity.parse.failed') return bad(res, 400, 'Richiesta non valida');
  if (err.code === '23503') return bad(res, 400, 'Dato collegato non valido (categoria o fornitore inesistente).');
  console.error('Magazzino:', err);
  bad(res, 500, 'Errore del server. Riprova.');
});

async function start() {
  await db.migrate();
}

module.exports = { app, start };
