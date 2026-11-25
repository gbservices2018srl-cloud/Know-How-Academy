// Compenso medici (dentro «Gestione amministrativa», all'indirizzo appgestione.it/compensi/).
// L'amministrazione scrive, mese per mese, il compenso di ogni medico in ogni sede (tabella medici × sedi).
// Il medico lo vede nella sua sezione Compensi e lo approva o lo rifiuta scrivendo il motivo.
// Approvato → l'amministrazione lo segna «da pagare» → «pagato» con la data: il medico vede la data
// e l'importo va da solo nel Consuntivo della Gestione finanziaria (riga del medico in «Costi per dottori»,
// sede del compenso, mese del pagamento; più pagamenti si sommano). Niente si cancella: tutto resta nello storico.
const path = require('path');
const express = require('express');
const { Pool, types } = require('pg');
types.setTypeParser(1082, v => v);
const crypto = require('crypto');
const accessi = require('../accessi/server');
const finanza = require('../lib/finanza');
const store = accessi.store;

/* ---------- database (stesso database, schema «compensi») ---------- */
const url = process.env.DATABASE_URL || '';
const SCHEMA = (process.env.COMPENSI_DB_SCHEMA || 'compensi').replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'compensi';
const pool = new Pool({ connectionString: url, ssl: process.env.PGSSL === 'true' || /\.render\.com/.test(url) ? { rejectUnauthorized: false } : false, options: `-c search_path=${SCHEMA},public`, max: 3 });
const q = (t, p) => pool.query(t, p);
async function migrate() {
  await q(`create schema if not exists ${SCHEMA}`);
  await q(`
    create table if not exists compensi (
      id text primary key,
      medico_id text not null, medico_nome text not null default '',
      sede_id text not null, sede_nome text not null default '',
      anno smallint not null, mese smallint not null,
      importo numeric(12,2) not null check (importo > 0),
      origine text not null default 'manuale',
      stato text not null default 'attesa',           -- attesa | approvato | rifiutato | da_pagare | pagato
      motivo text,                                     -- motivo del rifiuto (dal medico)
      creato_da text, creato_il timestamptz not null default now(),
      aggiornato_da text, aggiornato_il timestamptz not null default now(),
      deciso_il timestamptz,
      da_pagare_il timestamptz, da_pagare_da text,
      pagato_il date, pagato_da text, pagato_segnato_il timestamptz,
      fin_inviato_il timestamptz, fin_errore text,
      unique (medico_id, sede_id, anno, mese)
    );
    create index if not exists compensi_mese_idx on compensi(anno, mese);
    -- calcolo da AlfaDocs: «bozza» = calcolato, non ancora mandato al medico (anche 0 €, per vedere chi non ha tariffe)
    alter table compensi add column if not exists dal date;
    alter table compensi add column if not exists al date;
    alter table compensi drop constraint if exists compensi_importo_check;
    alter table compensi add constraint compensi_importo_check check (importo >= 0) not valid;
    -- dettaglio delle prestazioni eseguite (dati dei pazienti: solo qui, li vedono l'amministrazione e quel medico)
    create table if not exists dettaglio (compenso_id text not null, n int not null, entry_id text not null default '', data date, paziente text not null default '',
      prestazione text not null default '', elemento text not null default '', prezzo numeric(12,2) not null default 0, lab numeric(12,2) not null default 0,
      tipo text not null default '', valore numeric(12,2) not null default 0, fonte text not null default '', compenso numeric(12,2) not null default 0, primary key (compenso_id, n));
    alter table dettaglio add column if not exists lab_mano boolean not null default false;
    alter table dettaglio add column if not exists tolta boolean not null default false;  -- tolta dal totale dall'amministrazione (es. già pagata)
    alter table dettaglio add column if not exists paziente_id text not null default '';
    -- condizioni dei medici (il tariffario base è il Listino & margini di Analisi finanziaria); medico_id '' + chiave '*' = % per le prestazioni fuori listino
    create table if not exists tariffe (medico_id text not null default '', chiave text not null, nome text not null, tipo text not null, valore numeric(12,2) not null,
      aggiornato_il timestamptz not null default now(), aggiornato_da text, primary key (medico_id, chiave));
    -- medici di AlfaDocs (uno per sede) ↔ medici dell'app
    create table if not exists operatori (sede text not null, operatore text not null, nome text not null default '', medico_id text, primary key (sede, operatore));
    create table if not exists storico (id bigserial primary key, il timestamptz not null default now(), cosa text, rif text, chi text, prima jsonb, dopo jsonb);
  `);
}
const log = (cosa, rif, chi, prima, dopo) => q('insert into storico (cosa, rif, chi, prima, dopo) values ($1,$2,$3,$4,$5)', [cosa, rif, chi, prima ? JSON.stringify(prima) : null, dopo ? JSON.stringify(dopo) : null]).catch(() => {});

/* ---------- app ---------- */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => { res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' }); next(); });
app.use(express.json({ limit: '200kb' }));
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, code, msg) => res.status(code).json({ error: msg });
const str = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const euro = v => { let s = String(v ?? '').trim().replace(/[€\s]/g, ''); if (s === '') return 0; s = s.includes(',') || /^\d{1,3}(\.\d{3})+$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s; const n = Number(s); return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null; };
const num = v => Number(v) || 0;
const oggi = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const KEY = 'compensi';
const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const euroTxt = n => (Math.round(n * 100) / 100).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' }) + ' €';
const nomeU = u => `${u.first_name || ''} ${u.last_name || ''}`.replace(/\s+/g, ' ').trim() || u.email;
const avvisa = (ids, payload) => require('../accessi/lib/notifiche').notifica(ids, KEY, payload).catch(e => console.warn('Compensi notifica:', e.message));

// chi sta usando l'app: amministrazione (tutto) oppure medico (solo i suoi compensi)
app.use(wrap(async (req, res, next) => {
  const c = await store.check(accessi.readCookie(req));
  if (!c) return next();
  const u = c.user, role = u.owner ? 'admin' : c.apps[KEY];
  const spenta = !u.owner && (await store.appSpente()).has(KEY);
  req.me = { id: u.id, nome: nomeU(u), admin: role === 'admin' && !spenta, medico: !!role && !spenta && u.figura === 'Medico' };
  next();
}));
const needAny = (req, res, next) => req.me?.admin || req.me?.medico ? next() : bad(res, req.me ? 403 : 401, req.me ? 'Non sei abilitato a Compenso medici.' : 'Accesso richiesto');
const needAdmin = (req, res, next) => req.me?.admin ? next() : bad(res, 403, 'Solo per l\'amministrazione.');
const needMedico = (req, res, next) => req.me?.medico ? next() : bad(res, 403, 'Questa sezione è per i medici.');
app.use('/api', (req, res, next) => (['GET', 'HEAD'].includes(req.method) || req.is('application/json')) ? next() : bad(res, 415, 'Formato non valido'));

const forma = r => ({ id: r.id, medico: r.medico_id, medicoNome: r.medico_nome, sede: r.sede_id, sedeNome: r.sede_nome, anno: r.anno, mese: r.mese,
  importo: num(r.importo), origine: r.origine, stato: r.stato, motivo: r.motivo || '', decisoIl: r.deciso_il, daPagareIl: r.da_pagare_il,
  pagatoIl: r.pagato_il, finOk: !!r.fin_inviato_il, finErrore: r.fin_errore || '', dal: r.dal, al: r.al });

// medici della tabella: le persone attive con figura Medico (più chi ha già un compenso, anche se poi è stato disattivato)
async function medici() {
  const { rows } = await store.q(`select id, first_name, last_name, email, status, sedi from users where figura = 'Medico' and not owner and status <> 'pending'`);
  return rows.map(u => ({ id: u.id, nome: nomeU(u), attivo: u.status === 'active', sedi: Array.isArray(u.sedi) ? u.sedi : [] }));
}
async function sedi() { return (await store.listSedi()).filter(s => s.attiva !== false).map(s => ({ id: s.id, nome: s.nome })); }

app.get('/api/stato', needAny, (req, res) => res.json({ nome: req.me.nome, admin: req.me.admin, medico: req.me.medico, oggi: oggi() }));

/* ---------- amministrazione: la tabella del mese ---------- */
app.get('/api/mese', needAdmin, wrap(async (req, res) => {
  const anno = parseInt(req.query.anno, 10), mese = parseInt(req.query.mese, 10);
  if (!(anno > 2000 && mese >= 1 && mese <= 12)) return bad(res, 400, 'Mese non valido.');
  const { rows } = await q('select * from compensi where anno = $1 and mese = $2', [anno, mese]);
  const md = await medici(), ids = new Set(rows.map(r => r.medico_id));
  res.json({ anno, mese, sedi: await sedi(), medici: md.filter(m => m.attivo || ids.has(m.id)).sort((a, b) => a.nome.localeCompare(b.nome, 'it')), compensi: rows.map(forma) });
}));
// scrivere o correggere a mano un compenso (cella): diventa una bozza (rossa) che l'amministrazione manda al medico con un clic
app.put('/api/compenso', needAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  const anno = parseInt(b.anno, 10), mese = parseInt(b.mese, 10);
  if (!(anno > 2000 && mese >= 1 && mese <= 12)) return bad(res, 400, 'Mese non valido.');
  const m = (await medici()).find(x => x.id === str(b.medico, 60)); if (!m) return bad(res, 400, 'Medico non trovato.');
  const s = (await sedi()).find(x => x.id === str(b.sede, 60)); if (!s) return bad(res, 400, 'Sede non trovata.');
  const imp = euro(b.importo); if (imp == null || !imp) return bad(res, 400, 'Importo non valido.');
  if (imp > 1000000) return bad(res, 400, 'Importo troppo alto: controlla le cifre.');
  const { rows: [p] } = await q('select * from compensi where medico_id = $1 and sede_id = $2 and anno = $3 and mese = $4', [m.id, s.id, anno, mese]);
  if (p && !['bozza', 'rifiutato'].includes(p.stato)) return bad(res, 409, 'Questo compenso è già dal medico: non si cambia più.');
  if (!p && !m.sedi.includes(s.id)) return bad(res, 403, `${s.nome} non è tra le sedi di ${m.nome} (anagrafica in Gestione accessi).`);
  const { rows: [r] } = p
    ? await q(`update compensi set importo = $2, medico_nome = $3, sede_nome = $4, origine = 'manuale', stato = 'bozza', aggiornato_da = $5, aggiornato_il = now() where id = $1 returning *`, [p.id, imp, m.nome, s.nome, req.me.id])
    : await q(`insert into compensi (id, medico_id, medico_nome, sede_id, sede_nome, anno, mese, importo, origine, stato, creato_da, aggiornato_da) values ($1,$2,$3,$4,$5,$6,$7,$8,'manuale','bozza',$9,$9) returning *`,
      [crypto.randomUUID(), m.id, m.nome, s.id, s.nome, anno, mese, imp, req.me.id]);
  log(p ? 'compenso corretto a mano' : 'compenso inserito a mano', r.id, req.me.nome, p ? forma(p) : null, forma(r));
  res.json({ ok: true, compenso: forma(r) });
}));
// manda al medico (bozza o rifiutato → da approvare)
app.post('/api/manda', needAdmin, wrap(async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(x => str(x, 60)).slice(0, 500);
  const { rows } = await q(`update compensi set stato = 'attesa', motivo = null, deciso_il = null, aggiornato_da = $2, aggiornato_il = now()
    where id = any($1) and stato in ('bozza','rifiutato') and importo > 0 returning *`, [ids, req.me.id]);
  rows.forEach(r => { log('mandato al medico', r.id, req.me.nome, null, { importo: num(r.importo) }); avvisaPiuTardi(r.medico_id, r.anno, r.mese); });
  res.json({ ok: true, n: rows.length });
}));
const avvisiInAttesa = new Map();
function avvisaPiuTardi(medicoId, anno, mese) {
  clearTimeout(avvisiInAttesa.get(medicoId));
  avvisiInAttesa.set(medicoId, setTimeout(() => { avvisiInAttesa.delete(medicoId);
    avvisa([medicoId], { title: 'Compenso da approvare', body: `Il tuo compenso di ${MESI[mese - 1]} ${anno} è pronto: controllalo e approvalo.`, url: 'https://appgestione.it/compensi/' }); }, 60e3));
}
// approvati → da pagare
app.post('/api/da-pagare', needAdmin, wrap(async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(x => str(x, 60)).slice(0, 500);
  const { rows } = await q(`update compensi set stato = 'da_pagare', da_pagare_il = now(), da_pagare_da = $2 where id = any($1) and stato = 'approvato' returning *`, [ids, req.me.id]);
  rows.forEach(r => log('da pagare', r.id, req.me.nome, null, { importo: num(r.importo) }));
  res.json({ ok: true, n: rows.length });
}));
// da pagare → pagato (con la data) → Consuntivo della Gestione finanziaria
app.post('/api/pagato', needAdmin, wrap(async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(x => str(x, 60)).slice(0, 500);
  const data = str(req.body?.data, 10);
  if (!isDate(data) || data > oggi()) return bad(res, 400, 'Scegli la data del pagamento (non nel futuro).');
  const { rows } = await q(`update compensi set stato = 'pagato', pagato_il = $2, pagato_da = $3, pagato_segnato_il = now() where id = any($1) and stato in ('approvato','da_pagare') returning *`, [ids, data, req.me.id]);
  rows.forEach(r => log('pagato', r.id, req.me.nome, null, { importo: num(r.importo), data }));
  const fin = await inviaFinanza(rows.map(r => r.id));
  const perMedico = new Map(); rows.forEach(r => perMedico.set(r.medico_id, (perMedico.get(r.medico_id) || 0) + num(r.importo)));
  for (const [mid, tot] of perMedico) avvisa([mid], { title: 'Compenso pagato', body: `Pagato il ${data.split('-').reverse().join('/')}: ${euroTxt(tot)}.`, url: 'https://appgestione.it/compensi/' });
  res.json({ ok: true, n: rows.length, fin });
}));
app.post('/api/riprova-finanza', needAdmin, wrap(async (req, res) => {
  const { rows } = await q(`select id from compensi where stato = 'pagato' and fin_inviato_il is null`);
  res.json({ ok: true, fin: await inviaFinanza(rows.map(r => r.id)) });
}));
async function inviaFinanza(ids) {
  if (!ids.length) return { ok: true, n: 0 };
  const { rows } = await q(`select * from compensi where id = any($1) and stato = 'pagato' and fin_inviato_il is null`, [ids]);
  if (!rows.length) return { ok: true, n: 0 };
  try {
    const az = await finanza.aziendaToSmile();
    if (!az) throw new Error('In Gestione finanziaria non trovo l\'azienda To Smile.');
    // il medico dev'esserci tra i dottori, nelle sedi dei compensi (si aggiunge o si collega per nome, come per la registrazione)
    const per = new Map();
    for (const r of rows) { const p = per.get(r.medico_id) || { ref: r.medico_id, nome: r.medico_nome, tipo: 'medico', sedi: [] }; if (!p.sedi.includes(r.sede_nome)) p.sedi.push(r.sede_nome); per.set(r.medico_id, p); }
    await finanza.scrivi('/api/_appgestione/persone', { azienda: az, prova: false, persone: [...per.values()] });
    await finanza.scrivi('/api/_appgestione/compensi-medici', { azienda: az, pagamenti: rows.map(r => ({
      ref: 'compenso:' + r.id, medicoRef: r.medico_id, nome: r.medico_nome, sede: r.sede_nome,
      anno: +r.pagato_il.slice(0, 4), mese: +r.pagato_il.slice(5, 7), importo: num(r.importo) })) });
    await q(`update compensi set fin_inviato_il = now(), fin_errore = null where id = any($1)`, [rows.map(r => r.id)]);
    return { ok: true, n: rows.length };
  } catch (e) {
    const msg = finanza.messaggio(e);
    await q(`update compensi set fin_errore = $2 where id = any($1)`, [rows.map(r => r.id), msg]);
    console.warn('Compensi → Gestione finanziaria:', msg);
    return { ok: false, errore: msg };
  }
}

/* ---------- calcolo da AlfaDocs ---------- */
const AD = require('../lib/alfadocs');
const chiaveP = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9%+]+/g, ' ').trim();
const normS = x => String(x || '').toLowerCase().replace(/to\s*smile|studio|sede|ambulatorio/g, '').replace(/[^a-z0-9]/g, '');
const TITOLI = new Set(['dott', 'dottssa', 'dottoressa', 'dottore', 'dr', 'dssa', 'drssa', 'prof', 'odt', 'rap']);
const parole = t => String(t || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\([^)]*\)/g, ' ').replace(/[^a-z ]/g, '').split(/\s+/).filter(w => w.length > 1 && !TITOLI.has(w));
// il medico dell'app con lo stesso nome e cognome (in qualsiasi ordine); se ce n'è più di uno non si sceglie
function stessoMedico(nomeOp, md) {
  const p = new Set(parole(nomeOp)); if (!p.size) return null;
  const c = md.filter(m => { const w = parole(m.nome); return w.length >= 2 && w.every(x => p.has(x)); });
  return c.length === 1 ? c[0] : null;
}
async function tariffe() {
  const { rows } = await q('select medico_id, chiave, nome, tipo, valore from tariffe');
  const T = {}; for (const r of rows) (T[r.medico_id] = T[r.medico_id] || {})[r.chiave] = { nome: r.nome, tipo: r.tipo, valore: num(r.valore) };
  return T;
}
// Listino & margini di Analisi finanziaria: Map(chiave → { nome, lab, tipo, valore }). percProf → % di (prezzo - lab), altrimenti costoProf in euro
async function listino() {
  const az = await finanza.aziendaToSmile(); if (!az) throw new Error('In Gestione finanziaria non trovo l\'azienda To Smile.');
  const r = await finanza.chiama(`/api/_appgestione/listino?azienda=${encodeURIComponent(az)}`), L = new Map();
  for (const x of r.listino || []) L.set(chiaveP(x.label), { nome: x.label, lab: num(x.lab), ...(num(x.percProf) > 0 ? { tipo: 'perc', valore: Math.round(num(x.percProf) * 10000) / 100 } : { tipo: 'euro', valore: num(x.costoProf) }) });
  return L;
}
// regola per una prestazione: condizione del medico → Listino & margini → % fuori listino del medico → % fuori listino base
function regola(T, L, medico, prestazione) {
  const k = chiaveP(prestazione), M = T[medico] || {}, B = T[''] || {}, l = L.get(k);
  const lab = l ? l.lab : 0;
  if (M[k]) return { tipo: M[k].tipo, valore: M[k].valore, fonte: 'medico', lab };
  if (l) return { tipo: l.tipo, valore: l.valore, fonte: 'listino', lab };
  if (M['*']) return { tipo: 'perc', valore: M['*'].valore, fonte: 'perc-medico', lab };
  if (B['*']) return { tipo: 'perc', valore: B['*'].valore, fonte: 'perc-base', lab };
  return { tipo: '', valore: 0, fonte: '', lab };
}
const compensoDi = (tipo, valore, prezzo, lab) => Math.round((tipo === 'euro' ? valore : tipo === 'perc' ? valore / 100 * Math.max(0, prezzo - lab) : 0) * 100) / 100;

const calcolo = { inCorso: false, sede: '', fase: '', errore: '', esito: null, iniziato: null };
async function calcolaCompensi({ anno, mese, dal, al, medico }, chi) {
  const [S, md, T, L] = await Promise.all([sedi(), medici(), tariffe(), listino().catch(e => { const x = new Error('LISTINO: ' + e.message); x.listino = true; throw x; })]);
  const esito = { fatti: 0, saltati: [], senzaSede: [], errori: [], daCollegare: 0 };
  for (const sedeAD of AD.chiavi()) {
    calcolo.sede = sedeAD; calcolo.fase = '';
    const sede = S.find(x => normS(x.nome) === normS(sedeAD));
    if (!sede) { esito.senzaSede.push(sedeAD); continue; }
    let r;
    try { r = await AD.eseguite(AD.chiaveDi(sedeAD), dal, al, f => { calcolo.fase = f; }); }
    catch (e) { esito.errori.push(`${sede.nome}: ${e.message}`); console.warn(`Compensi · AlfaDocs ${sede.nome}: ${e.message}`); continue; }
    // medici di AlfaDocs ↔ medici dell'app (per nome, oppure scelti a mano una volta)
    const { rows: ops } = await q('select operatore, medico_id from operatori where sede = $1', [sede.id]);
    const giaScelto = new Map(ops.map(o => [o.operatore, o.medico_id]));
    for (const [op, nome] of Object.entries(r.operatori)) {
      if (!giaScelto.has(op)) { const m = stessoMedico(nome, md); giaScelto.set(op, m ? m.id : null); }
      await q(`insert into operatori (sede, operatore, nome, medico_id) values ($1,$2,$3,$4) on conflict (sede, operatore) do update set nome = excluded.nome`, [sede.id, op, nome, giaScelto.get(op)]);
    }
    const perMedico = new Map();
    for (const x of r.righe) {
      const mid = giaScelto.get(x.operatore);
      if (!mid || mid === '-') { if (!mid && x.operatore) esito.daCollegare++; continue; }
      if (medico && mid !== medico) continue;
      (perMedico.get(mid) || perMedico.set(mid, []).get(mid)).push(x);
    }
    for (const [mid, righe] of perMedico) {
      const m = md.find(x => x.id === mid); if (!m) continue;
      const { rows: [p] } = await q('select * from compensi where medico_id = $1 and sede_id = $2 and anno = $3 and mese = $4', [mid, sede.id, anno, mese]);
      if (p && !['bozza', 'rifiutato'].includes(p.stato)) { esito.saltati.push(`${m.nome} · ${sede.nome}`); continue; }
      // il costo di laboratorio corretto a mano resta, se si ricalcola (gli altri vengono dal Listino)
      // e anche le prestazioni tolte dal totale restano tolte
      const lab = new Map(), tolte = new Set();
      if (p) (await q('select entry_id, lab, lab_mano, tolta from dettaglio where compenso_id = $1 and entry_id <> $2 and (lab_mano or tolta)', [p.id, ''])).rows.forEach(d => { if (d.lab_mano) lab.set(d.entry_id, num(d.lab)); if (d.tolta) tolte.add(d.entry_id); });
      righe.sort((a, b) => a.data.localeCompare(b.data) || a.paziente.localeCompare(b.paziente, 'it'));
      const det = righe.map((x, i) => { const g = regola(T, L, mid, x.prestazione), mano = lab.has(x.id), l = mano ? lab.get(x.id) : g.lab;
        return { ...x, n: i + 1, lab: l, mano, tolta: tolte.has(x.id), tipo: g.tipo, valore: g.valore, fonte: g.fonte, compenso: tolte.has(x.id) ? 0 : compensoDi(g.tipo, g.valore, x.prezzo, l) }; });
      const tot = Math.round(det.reduce((s, x) => s + x.compenso, 0) * 100) / 100;
      const cl = await pool.connect();
      try {
        await cl.query('begin');
        const { rows: [c] } = p
          ? await cl.query(`update compensi set importo = $2, medico_nome = $3, sede_nome = $4, origine = 'alfadocs', stato = 'bozza', dal = $5, al = $6, aggiornato_da = $7, aggiornato_il = now() where id = $1 returning *`, [p.id, tot, m.nome, sede.nome, dal, al, chi])
          : await cl.query(`insert into compensi (id, medico_id, medico_nome, sede_id, sede_nome, anno, mese, importo, origine, stato, dal, al, creato_da, aggiornato_da) values ($1,$2,$3,$4,$5,$6,$7,$8,'alfadocs','bozza',$9,$10,$11,$11) returning *`,
            [crypto.randomUUID(), mid, m.nome, sede.id, sede.nome, anno, mese, tot, dal, al, chi]);
        await cl.query('delete from dettaglio where compenso_id = $1', [c.id]); // il dettaglio si rifà dal calcolo nuovo
        for (const x of det) await cl.query(`insert into dettaglio (compenso_id, n, entry_id, data, paziente, paziente_id, prestazione, elemento, prezzo, lab, lab_mano, tolta, tipo, valore, fonte, compenso) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
          [c.id, x.n, x.id, x.data, x.paziente, x.pazienteId || '', x.prestazione, x.elemento, x.prezzo, x.lab, x.mano, x.tolta, x.tipo, x.valore, x.fonte, x.compenso]);
        await cl.query('commit');
        log(p ? 'ricalcolato da AlfaDocs' : 'calcolato da AlfaDocs', c.id, chi, p ? { importo: num(p.importo) } : null, { importo: tot, dal, al, prestazioni: det.length });
        esito.fatti++;
      } catch (e) { await cl.query('rollback').catch(() => {}); throw e; } finally { cl.release(); }
    }
  }
  return esito;
}
app.get('/api/calcola', needAdmin, (req, res) => res.set('Cache-Control', 'no-store').json({ ...calcolo, alfadocs: AD.configurato() }));
app.post('/api/calcola', needAdmin, wrap(async (req, res) => {
  const b = req.body || {}, anno = parseInt(b.anno, 10), mese = parseInt(b.mese, 10), dal = str(b.dal, 10), al = str(b.al, 10), medico = str(b.medico, 60);
  if (!(anno > 2000 && mese >= 1 && mese <= 12)) return bad(res, 400, 'Mese non valido.');
  const mm = `${anno}-${String(mese).padStart(2, '0')}`;
  if (!isDate(dal) || !isDate(al) || dal > al || dal.slice(0, 7) !== mm || al.slice(0, 7) !== mm) return bad(res, 400, 'Scegli dal e al dentro il mese.');
  if (!AD.configurato()) return bad(res, 400, 'AlfaDocs non è collegato: aggiungi le chiavi in Collegamenti.');
  if (calcolo.inCorso) return bad(res, 409, 'C\'è già un calcolo in corso.');
  Object.assign(calcolo, { inCorso: true, sede: '', fase: '', errore: '', esito: null, iniziato: new Date().toISOString(), mese: mm });
  calcolaCompensi({ anno, mese, dal, al, medico }, req.me.nome)
    .then(e => { calcolo.esito = e; console.log(`Compensi: calcolo ${mm} (${dal} → ${al}) fatto: ${e.fatti} compensi`); })
    .catch(e => { calcolo.errore = e.listino ? 'Non riesco a leggere il Listino & margini di Analisi finanziaria: riprova tra poco.' : 'Calcolo non riuscito: riprova.'; console.error('Compensi calcolo:', e.message); })
    .finally(() => { calcolo.inCorso = false; calcolo.sede = ''; calcolo.fase = ''; });
  res.json({ ok: true });
}));
// medici di AlfaDocs da collegare
app.get('/api/operatori', needAdmin, wrap(async (req, res) => {
  const [{ rows }, S, md] = await Promise.all([q('select * from operatori order by sede, nome'), sedi(), medici()]);
  res.json({ operatori: rows.map(o => ({ sede: o.sede, sedeNome: (S.find(s => s.id === o.sede) || {}).nome || '', operatore: o.operatore, nome: o.nome, medico: o.medico_id || '' })),
    medici: md.filter(m => m.attivo).map(m => ({ id: m.id, nome: m.nome })).sort((a, b) => a.nome.localeCompare(b.nome, 'it')) });
}));
app.put('/api/operatore', needAdmin, wrap(async (req, res) => {
  const sede = str(req.body?.sede, 60), op = str(req.body?.operatore, 60), mid = str(req.body?.medico, 60) || null;
  if (mid && mid !== '-' && !(await medici()).some(m => m.id === mid)) return bad(res, 400, 'Medico non trovato.');   // «-» = non è un medico
  const { rowCount } = await q('update operatori set medico_id = $3 where sede = $1 and operatore = $2', [sede, op, mid]);
  if (!rowCount) return bad(res, 404, 'Medico di AlfaDocs non trovato.');
  res.json({ ok: true });
}));

/* ---------- dettaglio delle prestazioni (amministrazione, oppure il medico per i suoi compensi già mandati) ---------- */
async function compensoVisibile(req, id) {
  const { rows: [c] } = await q('select * from compensi where id = $1', [str(id, 60)]);
  if (!c) return null;
  if (req.me?.admin) return c;
  if (req.me?.medico && c.medico_id === req.me.id && c.stato !== 'bozza') return c;
  return null;
}
app.get('/api/dettaglio/:id', needAny, wrap(async (req, res) => {
  const c = await compensoVisibile(req, req.params.id); if (!c) return bad(res, 404, 'Compenso non trovato.');
  // stessa prestazione, stesso paziente e stesso dente già in un altro compenso del medico (accettato o pagato): si segna in rosso con il mese
  const { rows } = await q(`select d.*, (select (c2.anno * 100 + c2.mese)::text || ':' || c2.stato from dettaglio d2 join compensi c2 on c2.id = d2.compenso_id
      where c2.medico_id = $2 and c2.id <> $1 and c2.stato in ('approvato','da_pagare','pagato') and d2.elemento <> '' and d2.elemento = d.elemento
        and lower(d2.prestazione) = lower(d.prestazione)
        and (case when d.paziente_id <> '' and d2.paziente_id <> '' then d2.paziente_id = d.paziente_id else lower(d2.paziente) = lower(d.paziente) and d.paziente <> '' end)
      order by c2.anno, c2.mese limit 1) gia
    from dettaglio d where d.compenso_id = $1 order by d.n`, [c.id, c.medico_id]);
  const admin = !!req.me.admin;
  res.set('Cache-Control', 'no-store').json({ compenso: forma(c), righe: rows.map(d => ({ n: d.n, data: d.data, paziente: d.paziente, prestazione: d.prestazione, elemento: d.elemento,
    compenso: num(d.compenso), tolta: d.tolta, gia: d.gia ? (() => { const [am, st] = d.gia.split(':'), n = +am; return `${st === 'pagato' ? 'già pagato' : 'già accettato'} · ${MESI[n % 100 - 1]} ${Math.floor(n / 100)}`; })() : '', ...(admin ? { prezzo: num(d.prezzo), lab: num(d.lab), tipo: d.tipo, valore: num(d.valore), fonte: d.fonte } : {}) })) });
}));
// costo di laboratorio (a mano) oppure «togli dal totale / rimetti» su una prestazione: si ricalcola il compenso della riga e il totale
app.put('/api/dettaglio/:id/:n', needAdmin, wrap(async (req, res) => {
  const { rows: [c] } = await q('select * from compensi where id = $1', [str(req.params.id, 60)]);
  if (!c) return bad(res, 404, 'Compenso non trovato.');
  if (!['bozza', 'rifiutato'].includes(c.stato)) return bad(res, 409, 'Il compenso è già dal medico: non si cambia più.');
  const { rows: [d] } = await q('select * from dettaglio where compenso_id = $1 and n = $2', [c.id, parseInt(req.params.n, 10) || 0]);
  if (!d) return bad(res, 404, 'Prestazione non trovata.');
  const togli = typeof req.body?.tolta === 'boolean' ? req.body.tolta : d.tolta;
  const lab = req.body?.lab == null ? num(d.lab) : euro(req.body.lab); if (lab == null) return bad(res, 400, 'Importo non valido.');
  const comp = togli ? 0 : compensoDi(d.tipo, num(d.valore), num(d.prezzo), lab);
  await q('update dettaglio set lab = $3, compenso = $4, lab_mano = lab_mano or $5, tolta = $6 where compenso_id = $1 and n = $2', [c.id, d.n, lab, comp, req.body?.lab != null, togli]);
  const { rows: [t] } = await q(`update compensi set importo = (select coalesce(sum(compenso), 0) from dettaglio where compenso_id = $1), origine = 'alfadocs', stato = 'bozza', aggiornato_da = $2, aggiornato_il = now() where id = $1 returning *`, [c.id, req.me.id]);
  log(togli !== d.tolta ? (togli ? 'prestazione tolta dal totale' : 'prestazione rimessa nel totale') : 'costo laboratorio', c.id, req.me.nome, { lab: num(d.lab), tolta: d.tolta }, { lab, tolta: togli, riga: d.n });
  res.json({ ok: true, compenso: comp, totale: num(t.importo) });
}));

/* ---------- tariffari ---------- */
app.get('/api/tariffe', needAdmin, wrap(async (req, res) => {
  let L = null, errore = '';
  try { L = await listino(); } catch (e) { errore = 'Non riesco a leggere il Listino & margini di Analisi finanziaria: riprova tra poco.'; }
  const [{ rows }, md, { rows: viste }] = await Promise.all([q(`select medico_id, chiave, nome, tipo, valore from tariffe where medico_id <> '' or chiave = '*' order by nome`), medici(),
    q(`select prestazione, count(*)::int n from dettaglio where prestazione <> '' group by prestazione order by n desc limit 500`)]);
  const senza = L ? [...new Set(viste.map(v => v.prestazione))].filter(p => !L.has(chiaveP(p))).sort((a, b) => a.localeCompare(b, 'it')) : [];
  const fr = r => ({ nome: r.nome, chiave: r.chiave, tipo: r.tipo, valore: num(r.valore) });
  res.set('Cache-Control', 'no-store').json({ errore, listino: L ? [...L.entries()].map(([chiave, x]) => ({ chiave, ...x })).sort((a, b) => a.nome.localeCompare(b.nome, 'it')) : [], senza,
    perc: Object.fromEntries(rows.filter(r => r.chiave === '*').map(r => [r.medico_id, num(r.valore)])),
    medici: md.filter(m => m.attivo).map(m => ({ id: m.id, nome: m.nome, righe: rows.filter(r => r.medico_id === m.id && r.chiave !== '*').map(fr) })).sort((a, b) => a.nome.localeCompare(b.nome, 'it')) });
}));
// valore: «350» (euro) oppure «30%» (percentuale del prezzo scontato meno il laboratorio); vuoto = togli la riga
const leggiValore = v => { const t = String(v ?? '').trim(); if (!t) return { vuoto: true };
  const perc = /%\s*$/.test(t), n = euro(t.replace(/%\s*$/, '')); if (n == null || (perc && n > 100)) return null; return { tipo: perc ? 'perc' : 'euro', valore: n }; };
app.put('/api/tariffa', needAdmin, wrap(async (req, res) => {
  const mid = str(req.body?.medico, 60), nome = str(req.body?.nome, 200), k = chiaveP(nome);
  if (!mid) return bad(res, 400, 'Il tariffario base si cambia in Listino & margini di Analisi finanziaria.');
  if (!(await medici()).some(m => m.id === mid)) return bad(res, 400, 'Medico non trovato.');
  if (!k) return bad(res, 400, 'Scrivi il nome della prestazione.');
  const v = leggiValore(req.body?.valore); if (!v) return bad(res, 400, 'Scrivi un importo (es. 350) o una percentuale (es. 30%).');
  if (v.vuoto) await q('delete from tariffe where medico_id = $1 and chiave = $2', [mid, k]);
  else await q(`insert into tariffe (medico_id, chiave, nome, tipo, valore, aggiornato_da) values ($1,$2,$3,$4,$5,$6)
    on conflict (medico_id, chiave) do update set nome = excluded.nome, tipo = excluded.tipo, valore = excluded.valore, aggiornato_il = now(), aggiornato_da = excluded.aggiornato_da`, [mid, k, nome, v.tipo, v.valore, req.me.id]);
  log('tariffa', `${mid || 'base'}:${k}`, req.me.nome, null, v.vuoto ? { tolta: nome } : { nome, ...v });
  res.json({ ok: true });
}));
app.put('/api/percentuale', needAdmin, wrap(async (req, res) => {
  const mid = str(req.body?.medico, 60), t = String(req.body?.valore ?? '').trim();
  if (mid && !(await medici()).some(m => m.id === mid)) return bad(res, 400, 'Medico non trovato.');
  if (!t) await q(`delete from tariffe where medico_id = $1 and chiave = '*'`, [mid]);
  else { const n = euro(t.replace('%', '')); if (n == null || n > 100) return bad(res, 400, 'Percentuale non valida.');
    await q(`insert into tariffe (medico_id, chiave, nome, tipo, valore, aggiornato_da) values ($1,'*','Fuori tariffario','perc',$2,$3)
      on conflict (medico_id, chiave) do update set valore = excluded.valore, aggiornato_il = now(), aggiornato_da = excluded.aggiornato_da`, [mid, n, req.me.id]); }
  log('percentuale', mid || 'base', req.me.nome, null, { valore: t });
  res.json({ ok: true });
}));

/* ---------- medico: i suoi compensi ---------- */
app.get('/api/miei', needMedico, wrap(async (req, res) => {
  const { rows } = await q(`select * from compensi where medico_id = $1 and stato <> 'bozza' order by anno desc, mese desc, sede_nome`, [req.me.id]);
  res.json({ compensi: rows.map(forma) });
}));
app.post('/api/decidi', needMedico, wrap(async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(x => str(x, 60)).slice(0, 200);
  const ok = !!req.body?.ok, motivo = str(req.body?.motivo, 500);
  if (!ok && motivo.length < 3) return bad(res, 400, 'Scrivi il motivo del rifiuto.');
  const { rows } = await q(`update compensi set stato = $3, motivo = $4, deciso_il = now() where id = any($1) and medico_id = $2 and stato = 'attesa' returning *`,
    [ids, req.me.id, ok ? 'approvato' : 'rifiutato', ok ? null : motivo]);
  rows.forEach(r => log(ok ? 'approvato dal medico' : 'rifiutato dal medico', r.id, req.me.nome, null, { importo: num(r.importo), motivo }));
  if (rows.length) {
    const { rows: ad } = await store.q(`select u.id from users u where u.status = 'active' and (u.owner or exists (select 1 from user_apps a where a.user_id = u.id and a.app = $1 and a.role = 'admin' and not a.sospesa))`, [KEY]);
    const r0 = rows[0];
    avvisa(ad.map(x => x.id), ok ? { title: 'Compenso approvato', body: `${req.me.nome} ha approvato il compenso di ${MESI[r0.mese - 1]} ${r0.anno}.`, url: `https://appgestione.it/compensi/?anno=${r0.anno}&mese=${r0.mese}` }
      : { title: 'Compenso rifiutato', body: `${req.me.nome}, ${MESI[r0.mese - 1]} ${r0.anno}: ${motivo}`, url: `https://appgestione.it/compensi/?anno=${r0.anno}&mese=${r0.mese}` });
  }
  res.json({ ok: true, n: rows.length });
}));

/* ---------- pagina ---------- */
const PUB = path.join(__dirname, 'public');
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.me) return res.redirect(accessi.loginUrl(`${req.protocol}://${req.get('host')}${req.originalUrl}`));
  if (!req.me.admin && !req.me.medico) return res.redirect(`${accessi.publicUrl()}/?noaccess=compensi`);
  res.sendFile(path.join(PUB, 'app.html'));
});
app.use(express.static(PUB, { index: false, maxAge: '1h' }));
app.use((err, req, res, next) => {
  if (err.status && err.status < 500) return bad(res, err.status, err.message);
  console.error('Compensi:', err.message);
  bad(res, 500, 'Errore del server. Riprova.');
});
module.exports = { app, start: migrate };
