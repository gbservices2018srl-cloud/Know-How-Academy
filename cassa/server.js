// Gestione Cassa UL — server (stesso servizio delle altre app, all'indirizzo appgestione.it/cassa/).
// Micro app dentro «Gestione amministrativa». Permessi dal pannello Gestione accessi:
//   Amministratore = tutte le sedi + pannello di riepilogo; Operatore = le sedi scelte in Gestione accessi.
// Uscite di cassa: importo e nota, la data si mette da sola (oggi). Chiusura di cassa: contanti, POS e assegni per giorno.
const path = require('path');
const express = require('express');
const db = require('./lib/db');
const accessi = require('../accessi/server');
const store = accessi.store;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => { res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' }); next(); });
app.use(express.json({ limit: '200kb' }));

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, code, msg) => res.status(code).json({ error: msg });
const str = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const oggi = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
const addG = (g, n) => { const d = new Date(g + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
// importi: "1.234,56", "1234,56" o "1234.56"
const euro = v => { let s = String(v ?? '').trim().replace(/[€\s]/g, ''); if (s === '') return 0; s = s.includes(',') ? s.replace(/\./g, '').replace(',', '.') : s; const n = Number(s); return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null; };
const num = v => Number(v) || 0;
const PUB = path.join(__dirname, 'public');
const KEY = 'cassa';
// quanti giorni indietro l'operatore può fare o correggere una chiusura (l'amministratore sempre)
const GIORNI_CHIUSURA = 7;

/* ---------- chi sta usando l'app ---------- */
let sediCache = null, sediT = 0;
async function tutteLeSedi() {
  if (!sediCache || Date.now() - sediT > 60000) {
    sediCache = (await store.listSedi()).filter(s => s.attiva !== false).map(s => ({ id: s.id, nome: s.nome }));
    sediT = Date.now();
  }
  return sediCache;
}
// una sede nuova in Gestione accessi compare subito
store.events.on('sedi', () => { sediCache = null; });
app.use(wrap(async (req, res, next) => {
  const c = await store.check(accessi.readCookie(req));
  if (!c) return next();
  const u = c.user, owner = !!u.owner;
  const role = owner ? 'admin' : c.apps[KEY];
  const tutte = await tutteLeSedi();
  let perm = null;
  if (role === 'admin') perm = { admin: true, sedi: tutte };
  else if (role && !(await store.appSpente()).has(KEY)) {
    const lv = await store.livelliOf(u.id);
    const mie = (lv[KEY]?.enti || []).map(e => e.id);
    perm = { admin: false, sedi: tutte.filter(s => mie.includes(s.id)) };
  }
  req.me = { id: u.id, nome: `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email, perm };
  next();
}));
const needUser = (req, res, next) => req.me?.perm ? next() : bad(res, req.me ? 403 : 401, req.me ? 'Non sei abilitato a Gestione Cassa UL.' : 'Accesso richiesto');
const needAdmin = (req, res, next) => req.me?.perm?.admin ? next() : bad(res, 403, 'Solo per l\'amministrazione.');
const sedeOk = (req, id) => req.me.perm.sedi.find(s => s.id === id) || null;
app.use('/api', (req, res, next) => (['GET', 'HEAD', 'DELETE'].includes(req.method) || req.is('application/json')) ? next() : bad(res, 415, 'Formato non valido'));
const log = (cosa, rif, chi, prima, dopo) => db.q('insert into storico (cosa, rif, chi, prima, dopo) values ($1,$2,$3,$4,$5)', [cosa, rif, chi, prima ? JSON.stringify(prima) : null, dopo ? JSON.stringify(dopo) : null]).catch(() => {});

// periodo: "2026-11" (un mese) oppure "2026" (tutto l'anno)
function periodo(p) {
  const s = str(p, 7);
  if (/^\d{4}-\d{2}$/.test(s)) { const [y, m] = s.split('-').map(Number); return { dal: s + '-01', al: new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10), chiave: s }; }
  if (/^\d{4}$/.test(s)) return { dal: s + '-01-01', al: s + '-12-31', chiave: s };
  const o = oggi().slice(0, 7); return periodo(o);
}
// quali sedi guardare: una sola, oppure tutte quelle della persona
function sediRichieste(req) {
  const s = str(req.query.sede, 60);
  if (s && s !== 'tutte') { const x = sedeOk(req, s); return x ? [x] : null; }
  return req.me.perm.sedi;
}

/* ---------- stato ---------- */
app.get('/api/stato', needUser, (req, res) => {
  res.json({ me: { id: req.me.id, nome: req.me.nome }, admin: req.me.perm.admin, sedi: req.me.perm.sedi, oggi: oggi(), giorniChiusura: GIORNI_CHIUSURA, home: accessi.publicUrl() });
});

/* ============ USCITE DI CASSA ============ */
const formaU = r => ({ id: r.id, sede: r.sede_id, sedeNome: r.sede_nome, data: r.data, importo: num(r.importo), nota: r.nota, chi: r.creato_nome, il: r.creato_il,
  annullata: r.annullata, annullataMotivo: r.annullata_motivo || '', mia: false });
app.get('/api/uscite', needUser, wrap(async (req, res) => {
  const sedi = sediRichieste(req); if (!sedi) return bad(res, 403, 'Sede non tua.');
  const p = periodo(req.query.periodo);
  const { rows } = await db.q(`select * from uscite where sede_id = any($1) and data between $2 and $3 order by data desc, creato_il desc`, [sedi.map(s => s.id), p.dal, p.al]);
  const g = oggi();
  const lista = rows.map(r => ({ ...formaU(r), puoiAnnullare: !r.annullata && (req.me.perm.admin || (r.creato_da === req.me.id && r.data === g)) }));
  const valide = rows.filter(r => !r.annullata);
  res.json({ periodo: p.chiave, uscite: lista, totale: valide.reduce((s, r) => s + num(r.importo), 0),
    totaleOggi: valide.filter(r => r.data === g).reduce((s, r) => s + num(r.importo), 0) });
}));
app.post('/api/uscite', needUser, wrap(async (req, res) => {
  const b = req.body || {};
  const sede = sedeOk(req, str(b.sede, 60)); if (!sede) return bad(res, 400, 'Scegli la sede.');
  const importo = euro(b.importo); if (!importo) return bad(res, 400, 'Scrivi l\'importo dell\'uscita (più di 0 €).');
  if (importo > 100000) return bad(res, 400, 'Importo troppo alto: controlla le cifre.');
  const nota = String(b.nota ?? '').trim().slice(0, 1000); if (nota.length < 3) return bad(res, 400, 'Scrivi a cosa si riferisce l\'uscita.');
  const id = db.newId();
  // la data è sempre quella di oggi: si compila da sola
  await db.q(`insert into uscite (id, sede_id, sede_nome, data, importo, nota, creato_da, creato_nome) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, sede.id, sede.nome, oggi(), importo, nota, req.me.id, req.me.nome]);
  log('uscita', id, req.me.nome, null, { sede: sede.nome, importo, nota });
  res.json({ ok: true, id });
}));
app.post('/api/uscite/:id/annulla', needUser, wrap(async (req, res) => {
  const { rows: [r] } = await db.q('select * from uscite where id = $1', [req.params.id]);
  if (!r || !sedeOk(req, r.sede_id)) return bad(res, 404, 'Uscita non trovata.');
  if (r.annullata) return bad(res, 400, 'È già annullata.');
  if (!req.me.perm.admin && !(r.creato_da === req.me.id && r.data === oggi())) return bad(res, 403, 'Puoi annullare solo le uscite che hai registrato tu oggi. Per le altre chiedi all\'amministrazione.');
  const motivo = str(req.body?.motivo, 300);
  await db.q(`update uscite set annullata = true, annullata_da = $2, annullata_il = now(), annullata_motivo = $3 where id = $1`, [r.id, req.me.nome, motivo]);
  log('uscita annullata', r.id, req.me.nome, { importo: num(r.importo), nota: r.nota }, { motivo });
  res.json({ ok: true });
}));

/* ============ CHIUSURA DI CASSA ============ */
const formaC = r => ({ sede: r.sede_id, sedeNome: r.sede_nome, data: r.data, contanti: num(r.contanti), pos: num(r.pos), assegni: num(r.assegni),
  totale: num(r.contanti) + num(r.pos) + num(r.assegni), note: r.note, chi: r.aggiornato_nome || r.creato_nome, il: r.aggiornato_il });
app.get('/api/chiusure', needUser, wrap(async (req, res) => {
  const sedi = sediRichieste(req); if (!sedi) return bad(res, 403, 'Sede non tua.');
  const p = periodo(req.query.periodo), ids = sedi.map(s => s.id);
  const [{ rows }, { rows: us }] = await Promise.all([
    db.q(`select * from chiusure where sede_id = any($1) and data between $2 and $3 order by data desc, sede_nome`, [ids, p.dal, p.al]),
    db.q(`select sede_id, data, sum(importo) as t from uscite where sede_id = any($1) and data between $2 and $3 and not annullata group by sede_id, data`, [ids, p.dal, p.al]),
  ]);
  const uscDi = new Map(us.map(u => [u.sede_id + '|' + u.data, num(u.t)]));
  const lista = rows.map(r => ({ ...formaC(r), uscite: uscDi.get(r.sede_id + '|' + r.data) || 0 }));
  const tot = k => lista.reduce((s, r) => s + r[k], 0);
  res.json({ periodo: p.chiave, chiusure: lista, totali: { contanti: tot('contanti'), pos: tot('pos'), assegni: tot('assegni'), totale: tot('totale'),
    uscite: us.reduce((s, u) => s + num(u.t), 0), giorni: lista.length } });
}));
app.get('/api/chiusura', needUser, wrap(async (req, res) => {
  const sede = sedeOk(req, str(req.query.sede, 60)); if (!sede) return bad(res, 400, 'Scegli la sede.');
  const data = str(req.query.data, 10); if (!isDate(data)) return bad(res, 400, 'Data non valida.');
  const [{ rows: [r] }, { rows: [u] }] = await Promise.all([
    db.q('select * from chiusure where sede_id = $1 and data = $2', [sede.id, data]),
    db.q('select coalesce(sum(importo),0) as t, count(*)::int as n from uscite where sede_id = $1 and data = $2 and not annullata', [sede.id, data]),
  ]);
  res.json({ chiusura: r ? formaC(r) : null, uscite: num(u.t), usciteN: u.n });
}));
app.put('/api/chiusura', needUser, wrap(async (req, res) => {
  const b = req.body || {};
  const sede = sedeOk(req, str(b.sede, 60)); if (!sede) return bad(res, 400, 'Scegli la sede.');
  const data = str(b.data, 10) || oggi(); if (!isDate(data)) return bad(res, 400, 'Data non valida.');
  if (data > oggi()) return bad(res, 400, 'Non si chiude la cassa di un giorno che deve ancora venire.');
  if (!req.me.perm.admin && data < addG(oggi(), -GIORNI_CHIUSURA)) return bad(res, 403, `Puoi chiudere o correggere solo gli ultimi ${GIORNI_CHIUSURA} giorni. Per le date più vecchie chiedi all'amministrazione.`);
  const contanti = euro(b.contanti), pos = euro(b.pos), assegni = euro(b.assegni);
  if (contanti == null || pos == null || assegni == null) return bad(res, 400, 'Controlla gli importi: solo numeri, anche 0.');
  if (contanti + pos + assegni > 1000000) return bad(res, 400, 'Importo troppo alto: controlla le cifre.');
  const note = String(b.note ?? '').trim().slice(0, 1000);
  const { rows: [prima] } = await db.q('select * from chiusure where sede_id = $1 and data = $2', [sede.id, data]);
  await db.q(`insert into chiusure (sede_id, data, sede_nome, contanti, pos, assegni, note, creato_da, creato_nome, aggiornato_da, aggiornato_nome)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$8,$9)
    on conflict (sede_id, data) do update set contanti = excluded.contanti, pos = excluded.pos, assegni = excluded.assegni, note = excluded.note,
      sede_nome = excluded.sede_nome, aggiornato_da = excluded.aggiornato_da, aggiornato_nome = excluded.aggiornato_nome, aggiornato_il = now()`,
    [sede.id, data, sede.nome, contanti, pos, assegni, note, req.me.id, req.me.nome]);
  log(prima ? 'chiusura corretta' : 'chiusura', sede.id + '|' + data, req.me.nome, prima ? formaC(prima) : null, { contanti, pos, assegni, note });
  res.json({ ok: true, corretta: !!prima });
}));

/* ============ PANNELLO (amministrazione) ============ */
app.get('/api/pannello', needUser, needAdmin, wrap(async (req, res) => {
  const p = periodo(req.query.periodo), sedi = req.me.perm.sedi, ids = sedi.map(s => s.id);
  const [{ rows: us }, { rows: ch }] = await Promise.all([
    db.q(`select sede_id, sum(importo) as t, count(*)::int as n from uscite where sede_id = any($1) and data between $2 and $3 and not annullata group by sede_id`, [ids, p.dal, p.al]),
    db.q(`select sede_id, sum(contanti) as c, sum(pos) as p, sum(assegni) as a, count(*)::int as g, max(data) as ultima from chiusure where sede_id = any($1) and data between $2 and $3 group by sede_id`, [ids, p.dal, p.al]),
  ]);
  const U = new Map(us.map(r => [r.sede_id, r])), C = new Map(ch.map(r => [r.sede_id, r]));
  const righe = sedi.map(s => {
    const u = U.get(s.id) || {}, c = C.get(s.id) || {};
    const r = { sede: s.id, nome: s.nome, uscite: num(u.t), usciteN: u.n || 0, contanti: num(c.c), pos: num(c.p), assegni: num(c.a), giorni: c.g || 0, ultima: c.ultima || null };
    r.incassi = r.contanti + r.pos + r.assegni;
    return r;
  });
  const tot = k => righe.reduce((s, r) => s + r[k], 0);
  // chiusure mancanti di ieri (solo guardando il mese in corso)
  const ieri = addG(oggi(), -1);
  const { rows: fatteIeri } = await db.q('select sede_id from chiusure where data = $1', [ieri]);
  res.json({ periodo: p.chiave, righe, totali: { uscite: tot('uscite'), usciteN: tot('usciteN'), contanti: tot('contanti'), pos: tot('pos'), assegni: tot('assegni'), incassi: tot('incassi'), giorni: tot('giorni') },
    ieri, senzaChiusuraIeri: sedi.filter(s => !fatteIeri.some(f => f.sede_id === s.id)).map(s => s.nome) });
}));

/* ---------- pagine ---------- */
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.me) return res.redirect(accessi.loginUrl(`${req.protocol}://${req.get('host')}${req.originalUrl}`));
  if (!req.me.perm) return res.redirect(`${accessi.publicUrl()}/?noaccess=cassa`);
  res.sendFile(path.join(PUB, 'app.html'));
});
app.use(express.static(PUB, { index: false, maxAge: '1h' }));
app.use((err, req, res, next) => {
  if (err.status && err.status < 500) return bad(res, err.status, err.message);
  console.error('Gestione Cassa UL:', err.message);
  bad(res, err.status || 500, 'Errore del server. Riprova.');
});

async function start() { await db.migrate(); }
module.exports = { app, start };
