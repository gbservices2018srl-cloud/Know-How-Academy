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
  pagatoIl: r.pagato_il, finOk: !!r.fin_inviato_il, finErrore: r.fin_errore || '' });

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
// scrivere o correggere un compenso (cella): si può finché non è «da pagare»; se cambia torna da approvare
const avvisiInAttesa = new Map();
function avvisaPiuTardi(medicoId, anno, mese) {
  clearTimeout(avvisiInAttesa.get(medicoId));
  avvisiInAttesa.set(medicoId, setTimeout(() => { avvisiInAttesa.delete(medicoId);
    avvisa([medicoId], { title: 'Compenso da approvare', body: `Il tuo compenso di ${MESI[mese - 1]} ${anno} è pronto: controllalo e approvalo.`, url: 'https://appgestione.it/compensi/' }); }, 3 * 60e3));
}
app.put('/api/compenso', needAdmin, wrap(async (req, res) => {
  const b = req.body || {};
  const anno = parseInt(b.anno, 10), mese = parseInt(b.mese, 10);
  if (!(anno > 2000 && mese >= 1 && mese <= 12)) return bad(res, 400, 'Mese non valido.');
  const m = (await medici()).find(x => x.id === str(b.medico, 60)); if (!m) return bad(res, 400, 'Medico non trovato.');
  const s = (await sedi()).find(x => x.id === str(b.sede, 60)); if (!s) return bad(res, 400, 'Sede non trovata.');
  if (!m.sedi.includes(s.id)) return bad(res, 403, `${s.nome} non è tra le sedi di ${m.nome} (anagrafica in Gestione accessi).`);
  const imp = euro(b.importo); if (imp == null) return bad(res, 400, 'Importo non valido.');
  if (imp > 1000000) return bad(res, 400, 'Importo troppo alto: controlla le cifre.');
  const { rows: [p] } = await q('select * from compensi where medico_id = $1 and sede_id = $2 and anno = $3 and mese = $4', [m.id, s.id, anno, mese]);
  if (p && ['da_pagare', 'pagato'].includes(p.stato)) return bad(res, 409, 'Questo compenso è già da pagare o pagato: non si cambia più.');
  if (!imp) {   // cella svuotata: si toglie solo se il medico non l'aveva ancora approvato (resta nello storico)
    if (!p) return res.json({ ok: true });
    if (p.stato === 'approvato') return bad(res, 409, 'Il medico l\'ha già approvato: correggi l\'importo invece di toglierlo.');
    await q('delete from compensi where id = $1', [p.id]);
    log('compenso tolto', p.id, req.me.nome, forma(p), null);
    return res.json({ ok: true, tolto: true });
  }
  if (p && num(p.importo) === imp && p.stato !== 'rifiutato') return res.json({ ok: true, compenso: forma(p) });
  const { rows: [r] } = p
    ? await q(`update compensi set importo = $2, medico_nome = $3, sede_nome = $4, stato = 'attesa', motivo = null, deciso_il = null, aggiornato_da = $5, aggiornato_il = now() where id = $1 returning *`, [p.id, imp, m.nome, s.nome, req.me.id])
    : await q(`insert into compensi (id, medico_id, medico_nome, sede_id, sede_nome, anno, mese, importo, origine, creato_da, aggiornato_da) values ($1,$2,$3,$4,$5,$6,$7,$8,'manuale',$9,$9) returning *`,
      [crypto.randomUUID(), m.id, m.nome, s.id, s.nome, anno, mese, imp, req.me.id]);
  log(p ? 'compenso corretto' : 'compenso inserito', r.id, req.me.nome, p ? forma(p) : null, forma(r));
  avvisaPiuTardi(m.id, anno, mese);
  res.json({ ok: true, compenso: forma(r) });
}));
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
  const { rows } = await q(`update compensi set stato = 'pagato', pagato_il = $2, pagato_da = $3, pagato_segnato_il = now() where id = any($1) and stato = 'da_pagare' returning *`, [ids, data, req.me.id]);
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

/* ---------- medico: i suoi compensi ---------- */
app.get('/api/miei', needMedico, wrap(async (req, res) => {
  const { rows } = await q(`select * from compensi where medico_id = $1 order by anno desc, mese desc, sede_nome`, [req.me.id]);
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
