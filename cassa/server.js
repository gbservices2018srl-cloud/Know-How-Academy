// REC — server (stesso servizio delle altre app, all'indirizzo appgestione.it/cassa/): Gestione Cassa UL e Produzione di UL.
// Micro app dentro il riquadro «REC». Permessi dal pannello Gestione accessi (ognuna la sua: cassa, produzione):
//   Amministratore = tutte le sedi + pannello di riepilogo; Operatore = le sedi scelte in Gestione accessi.
// Uscite di cassa: importo e nota, la data si mette da sola (oggi). Chiusura di cassa: contanti, POS e assegni per giorno.
const path = require('path');
const express = require('express');
const db = require('./lib/db');
const accessi = require('../accessi/server');
const finanza = require('../lib/finanza');
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
// importi: "1.234,56", "1234,56", "7.000" (migliaia) o "1234.56"
const euro = v => { let s = String(v ?? '').trim().replace(/[€\s]/g, ''); if (s === '') return 0; s = s.includes(',') || /^\d{1,3}(\.\d{3})+$/.test(s) ? s.replace(/\./g, '').replace(',', '.') : s; const n = Number(s); return isFinite(n) && n >= 0 ? Math.round(n * 100) / 100 : null; };
const num = v => Number(v) || 0;
const PUB = path.join(__dirname, 'public');
const KEY = 'cassa', KEY_P = 'produzione';
const METODI = { contanti: 'Contanti', pos: 'POS', assegno: 'Assegno' };
// voci del Consuntivo (Gestione finanziaria, To Smile) a cui l'amministratore associa le spese di cassa
const VOCI = ['Spese per unità locali', 'Cancelleria', 'Farmacia', 'Marche da bollo', 'Sponsor territoriali'];
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
  const tutte = await tutteLeSedi();
  const spente = await store.appSpente();
  let lv = null;
  const permDi = async k => {
    const role = owner ? 'admin' : c.apps[k];
    if (role === 'admin') return { admin: true, sedi: tutte };
    if (!role || spente.has(k)) return null;
    lv = lv || await store.livelliOf(u.id);
    const mie = (lv[k]?.enti || []).map(e => e.id);
    return { admin: false, sedi: tutte.filter(s => mie.includes(s.id)) };
  };
  // Gestione Cassa: l'operatore inserisce per le sue sedi; l'amministratore guarda il pannello (tutte le sedi), non inserisce
  const pc = owner ? null : await permDi(KEY);
  const pan = owner || c.apps[KEY] === 'admin' ? { admin: true, sedi: tutte } : null;
  req.me = { id: u.id, nome: `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email, perm: pc && !pc.admin ? pc : null, pan, prod: await permDi(KEY_P) };
  next();
}));
const needUser = (req, res, next) => req.me?.perm ? next() : bad(res, req.me ? 403 : 401, req.me ? 'Non sei abilitato a Gestione Cassa UL.' : 'Accesso richiesto');
const needProd = (req, res, next) => req.me?.prod ? next() : bad(res, req.me ? 403 : 401, req.me ? 'Non sei abilitato a Produzione di UL.' : 'Accesso richiesto');
const needAny = (req, res, next) => req.me?.perm || req.me?.pan || req.me?.prod ? next() : bad(res, req.me ? 403 : 401, req.me ? 'Non sei abilitato a REC.' : 'Accesso richiesto');
const needAdmin = (req, res, next) => req.me?.pan ? next() : bad(res, 403, 'Solo per l\'amministrazione.');
// per guardare: le sedi di chi inserisce, oppure tutte per il Pannello cassa
const needVedere = (req, res, next) => req.me?.perm || req.me?.pan ? next() : bad(res, req.me ? 403 : 401, req.me ? 'Non sei abilitato alla cassa.' : 'Accesso richiesto');
const sediVedere = req => req.me.pan ? req.me.pan.sedi : req.me.perm.sedi;
const sedeOk = (req, id) => req.me.perm?.sedi.find(s => s.id === id) || null;
const sedeVedere = (req, id) => sediVedere(req).find(s => s.id === id) || null;
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
  if (s && s !== 'tutte') { const x = sedeVedere(req, s); return x ? [x] : null; }
  return sediVedere(req);
}

/* ---------- stato ---------- */
app.get('/api/stato', needAny, (req, res) => {
  res.json({ me: { id: req.me.id, nome: req.me.nome }, cassa: !!req.me.perm, pannello: !!req.me.pan, admin: false, sedi: req.me.perm?.sedi || [], tutteSedi: req.me.pan?.sedi || [],
    prod: req.me.prod ? { admin: req.me.prod.admin, sedi: req.me.prod.sedi } : null, oggi: oggi(), giorniChiusura: GIORNI_CHIUSURA, home: accessi.publicUrl() });
});

/* ============ USCITE DI CASSA ============ */
const formaU = r => ({ id: r.id, sede: r.sede_id, sedeNome: r.sede_nome, data: r.data, importo: num(r.importo), nota: r.nota, chi: r.creato_nome, il: r.creato_il,
  metodo: r.metodo || 'contanti', annullata: r.annullata, annullataMotivo: r.annullata_motivo || '', mia: false,
  voce: r.voce || '', inviata: r.inviata_voce ? { voce: r.inviata_voce, importo: num(r.inviata_importo), il: r.inviata_il } : null, statoInvio: statoInvio(r) });
// cosa deve esserci nel Consuntivo per questa spesa, e cosa c'è già (mandato prima)
const voluto = r => !r.annullata && r.voce ? { voce: r.voce, importo: num(r.importo), anno: Number(String(r.data).slice(0, 4)), mese: Number(String(r.data).slice(5, 7)) } : null;
const mandato = r => r.inviata_voce ? { voce: r.inviata_voce, importo: num(r.inviata_importo), anno: r.inviata_anno, mese: r.inviata_mese } : null;
const uguali = (a, b) => (!a && !b) || (a && b && a.voce === b.voce && a.importo === b.importo && a.anno === b.anno && a.mese === b.mese);
function statoInvio(r) {
  const v = voluto(r), m = mandato(r);
  if (uguali(v, m)) return m ? 'nel_consuntivo' : (r.annullata ? '' : 'senza_voce');
  return v ? 'da_mandare' : 'da_togliere';
}
app.get('/api/uscite', needVedere, wrap(async (req, res) => {
  const sedi = sediRichieste(req); if (!sedi) return bad(res, 403, 'Sede non tua.');
  const p = periodo(req.query.periodo);
  const { rows } = await db.q(`select * from uscite where sede_id = any($1) and data between $2 and $3 order by data desc, creato_il desc`, [sedi.map(s => s.id), p.dal, p.al]);
  const g = oggi();
  const lista = rows.map(r => ({ ...formaU(r), puoiAnnullare: !r.annullata && (!!req.me.pan || (r.creato_da === req.me.id && r.data === g)) }));
  const valide = rows.filter(r => !r.annullata);
  const perMetodo = {}; for (const k of Object.keys(METODI)) perMetodo[k] = valide.filter(r => (r.metodo || 'contanti') === k).reduce((s, r) => s + num(r.importo), 0);
  res.json({ periodo: p.chiave, uscite: lista, perMetodo, totale: valide.reduce((s, r) => s + num(r.importo), 0),
    totaleOggi: valide.filter(r => r.data === g).reduce((s, r) => s + num(r.importo), 0) });
}));
app.post('/api/uscite', needUser, wrap(async (req, res) => {
  const b = req.body || {};
  const sede = sedeOk(req, str(b.sede, 60)); if (!sede) return bad(res, 400, 'Scegli la sede.');
  const importo = euro(b.importo); if (!importo) return bad(res, 400, 'Scrivi l\'importo dell\'uscita (più di 0 €).');
  if (importo > 100000) return bad(res, 400, 'Importo troppo alto: controlla le cifre.');
  const nota = String(b.nota ?? '').trim().slice(0, 1000); if (nota.length < 3) return bad(res, 400, 'Scrivi a cosa si riferisce l\'uscita.');
  const metodo = str(b.metodo, 20); if (!METODI[metodo]) return bad(res, 400, 'Scegli come hai pagato: contanti, POS o assegno.');
  const id = db.newId();
  // la data è sempre quella di oggi: si compila da sola
  await db.q(`insert into uscite (id, sede_id, sede_nome, data, importo, nota, metodo, creato_da, creato_nome) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, sede.id, sede.nome, oggi(), importo, nota, metodo, req.me.id, req.me.nome]);
  log('uscita', id, req.me.nome, null, { sede: sede.nome, importo, nota, metodo });
  res.json({ ok: true, id });
}));
// l'amministratore associa la spesa a una voce del Consuntivo ('' = nessuna)
app.put('/api/uscite/:id/voce', needAdmin, wrap(async (req, res) => {
  const voce = str(req.body?.voce, 60);
  if (voce && !VOCI.includes(voce)) return bad(res, 400, 'Voce non valida.');
  const { rowCount } = await db.q('update uscite set voce = $2 where id = $1', [req.params.id, voce || null]);
  if (!rowCount) return bad(res, 404, 'Uscita non trovata.');
  res.json({ ok: true });
}));
// manda nel Consuntivo le spese da allineare (aggiunge, oppure toglie se annullate o con la voce cambiata)
async function inviaUscite(ids) {
  const { rows } = await db.q('select * from uscite where id = any($1)', [ids]);
  const daFare = rows.filter(r => !uguali(voluto(r), mandato(r)));
  if (!daFare.length) return { ok: true, mandate: 0 };
  const az = await finanza.aziendaToSmile();
  if (!az) throw Object.assign(new Error('Non trovo l\'azienda To Smile in Gestione finanziaria.'), { status: 400 });
  const perAnno = new Map();
  for (const r of daFare) {
    const v = voluto(r), m = mandato(r);
    for (const x of [m && { ...m, delta: -m.importo }, v && { ...v, delta: v.importo }].filter(Boolean)) {
      if (!perAnno.has(x.anno)) perAnno.set(x.anno, []);
      perAnno.get(x.anno).push({ r, ...x });
    }
  }
  let mandate = 0;
  for (const [anno, lista] of perAnno) {
    const cons = await finanza.chiama(`/api/_appgestione/consuntivo?azienda=${encodeURIComponent(az)}&anno=${anno}&mese=1`);
    if (cons.annoNelGestionale !== anno) throw Object.assign(new Error(`Nella Gestione finanziaria il consuntivo aperto è del ${cons.annoNelGestionale}: le spese del ${anno} non si possono mandare.`), { status: 409 });
    const movimenti = lista.map(x => {
      const f = sedeFin(cons, x.r.sede_nome);
      if (!f) throw Object.assign(new Error(`La sede ${x.r.sede_nome} non c'è in Gestione finanziaria (controlla che abbia lo stesso nome).`), { status: 400 });
      return { sedeId: f.id, mese: x.mese, voce: x.voce, delta: x.delta };
    });
    await finanza.scrivi('/api/_appgestione/costi-cassa', { azienda: az, anno, movimenti });
    const fatte = new Set(lista.map(x => x.r.id));
    for (const r of daFare.filter(r => fatte.has(r.id))) {
      const v = voluto(r);
      await db.q(`update uscite set inviata_voce = $2, inviata_importo = $3, inviata_anno = $4, inviata_mese = $5, inviata_il = now() where id = $1`,
        [r.id, v?.voce || null, v?.importo ?? null, v?.anno ?? null, v?.mese ?? null]);
      mandate++;
    }
  }
  return { ok: true, mandate };
}
app.post('/api/uscite/invia', needAdmin, wrap(async (req, res) => {
  const ids = (Array.isArray(req.body?.ids) ? req.body.ids : []).map(x => str(x, 60)).filter(Boolean).slice(0, 500);
  if (!ids.length) return bad(res, 400, 'Nessuna spesa da mandare.');
  try {
    const x = await inviaUscite(ids);
    log('spese mandate nel consuntivo', ids.length + ' spese', req.me.nome, null, { mandate: x.mandate });
    res.json(x);
  } catch (e) { bad(res, e.status || 502, finanza.messaggio(e)); }
}));
// quali delle voci ci sono davvero nella Gestione finanziaria
app.get('/api/voci', needAdmin, wrap(async (req, res) => {
  try {
    const az = await finanza.aziendaToSmile();
    const v = az && await finanza.chiama(`/api/_appgestione/voci?azienda=${encodeURIComponent(az)}&nomi=${encodeURIComponent(VOCI.join('|'))}`);
    res.json({ voci: VOCI, mancanti: v ? VOCI.filter(n => !v.voci?.[n]) : [], errore: az ? null : 'Non trovo l\'azienda To Smile in Gestione finanziaria.' });
  } catch (e) { res.json({ voci: VOCI, mancanti: [], errore: finanza.messaggio(e) }); }
}));
app.post('/api/uscite/:id/annulla', needVedere, wrap(async (req, res) => {
  const { rows: [r] } = await db.q('select * from uscite where id = $1', [req.params.id]);
  if (!r || !sedeVedere(req, r.sede_id)) return bad(res, 404, 'Uscita non trovata.');
  if (r.annullata) return bad(res, 400, 'È già annullata.');
  if (!req.me.pan && !(r.creato_da === req.me.id && r.data === oggi())) return bad(res, 403, 'Puoi annullare solo le uscite che hai registrato tu oggi. Per le altre chiedi all\'amministrazione.');
  const motivo = str(req.body?.motivo, 300);
  await db.q(`update uscite set annullata = true, annullata_da = $2, annullata_il = now(), annullata_motivo = $3 where id = $1`, [r.id, req.me.nome, motivo]);
  log('uscita annullata', r.id, req.me.nome, { importo: num(r.importo), nota: r.nota }, { motivo });
  // se era già nel Consuntivo, si toglie subito
  let tolta = null;
  if (r.inviata_voce) { try { await inviaUscite([r.id]); tolta = true; } catch (e) { tolta = false; console.warn('REC: storno non riuscito:', e.message); } }
  res.json({ ok: true, tolta });
}));

/* ============ CHIUSURA DI CASSA ============ */
// Ogni giorno: contanti e assegni della chiusura MENO le uscite pagate in contanti/assegno e i versamenti in banca approvati
// di quel giorno (i numeri scritti dall'operatore restano salvati: il netto si calcola). Il POS resta com'è.
const formaC = r => ({ sede: r.sede_id, sedeNome: r.sede_nome, data: r.data, contanti: num(r.contanti), pos: num(r.pos), assegni: num(r.assegni),
  totale: num(r.contanti) + num(r.pos) + num(r.assegni), note: r.note, chi: r.aggiornato_nome || r.creato_nome, il: r.aggiornato_il });
async function giorniCassa(ids, dal, al) {
  const [{ rows: ch }, { rows: us }, { rows: vs }] = await Promise.all([
    db.q(`select * from chiusure where sede_id = any($1) and data between $2 and $3`, [ids, dal, al]),
    db.q(`select sede_id, sede_nome, data, sum(importo) as t, sum(importo) filter (where metodo = 'contanti') as c, sum(importo) filter (where metodo = 'assegno') as a
      from uscite where sede_id = any($1) and data between $2 and $3 and not annullata group by sede_id, sede_nome, data`, [ids, dal, al]),
    db.q(`select sede_id, sede_nome, data, sum(contanti) as c, sum(assegni) as a from versamenti where sede_id = any($1) and data between $2 and $3 and stato = 'approvato'
      group by sede_id, sede_nome, data`, [ids, dal, al]),
  ]);
  const g = new Map(), k = (s, d) => s + '|' + d;
  const giorno = (s, nome, d) => { if (!g.has(k(s, d))) g.set(k(s, d), { sede: s, sedeNome: nome, data: d, fatta: false, inseriti: { contanti: 0, pos: 0, assegni: 0 },
    usciteTot: 0, uscite: { contanti: 0, assegni: 0 }, versati: { contanti: 0, assegni: 0 }, note: '', chi: '', il: null }); return g.get(k(s, d)); };
  for (const r of ch) Object.assign(giorno(r.sede_id, r.sede_nome, r.data), { fatta: true, inseriti: { contanti: num(r.contanti), pos: num(r.pos), assegni: num(r.assegni) },
    note: r.note, chi: r.aggiornato_nome || r.creato_nome, il: r.aggiornato_il });
  for (const r of us) { const x = giorno(r.sede_id, r.sede_nome, r.data); x.usciteTot = num(r.t); x.uscite = { contanti: num(r.c), assegni: num(r.a) }; }
  for (const r of vs) giorno(r.sede_id, r.sede_nome, r.data).versati = { contanti: num(r.c), assegni: num(r.a) };
  // un giorno senza chiusura compare solo se ha tolto contanti/assegni (uscite o versamenti)
  return [...g.values()].filter(x => x.fatta || x.uscite.contanti || x.uscite.assegni || x.versati.contanti || x.versati.assegni).map(x => {
    x.contanti = x.inseriti.contanti - x.uscite.contanti - x.versati.contanti;
    x.assegni = x.inseriti.assegni - x.uscite.assegni - x.versati.assegni;
    x.pos = x.inseriti.pos; x.totale = x.contanti + x.pos + x.assegni;
    return x;
  }).sort((a, b) => b.data.localeCompare(a.data) || a.sedeNome.localeCompare(b.sedeNome));
}
app.get('/api/chiusure', needVedere, wrap(async (req, res) => {
  const sedi = sediRichieste(req); if (!sedi) return bad(res, 403, 'Sede non tua.');
  const p = periodo(req.query.periodo), ids = sedi.map(s => s.id);
  const lista = await giorniCassa(ids, p.dal, p.al);
  const { rows: [u] } = await db.q(`select coalesce(sum(importo),0) as t from uscite where sede_id = any($1) and data between $2 and $3 and not annullata`, [ids, p.dal, p.al]);
  const tot = f => lista.reduce((s, r) => s + f(r), 0);
  res.json({ periodo: p.chiave, chiusure: lista.map(r => ({ ...r, usciteDett: r.uscite, uscite: r.usciteTot })), totali: { contanti: tot(r => r.contanti), pos: tot(r => r.pos), assegni: tot(r => r.assegni), totale: tot(r => r.totale),
    uscite: num(u.t), versatiContanti: tot(r => r.versati.contanti), versatiAssegni: tot(r => r.versati.assegni), giorni: lista.filter(r => r.fatta).length } });
}));
app.get('/api/chiusura', needUser, wrap(async (req, res) => {
  const sede = sedeOk(req, str(req.query.sede, 60)); if (!sede) return bad(res, 400, 'Scegli la sede.');
  const data = str(req.query.data, 10); if (!isDate(data)) return bad(res, 400, 'Data non valida.');
  const [{ rows: [r] }, { rows: [u] }, { rows: [v] }] = await Promise.all([
    db.q('select * from chiusure where sede_id = $1 and data = $2', [sede.id, data]),
    db.q(`select coalesce(sum(importo),0) as t, count(*)::int as n, coalesce(sum(importo) filter (where metodo = 'contanti'),0) as c, coalesce(sum(importo) filter (where metodo = 'assegno'),0) as a
      from uscite where sede_id = $1 and data = $2 and not annullata`, [sede.id, data]),
    db.q(`select coalesce(sum(contanti),0) as c, coalesce(sum(assegni),0) as a from versamenti where sede_id = $1 and data = $2 and stato = 'approvato'`, [sede.id, data]),
  ]);
  res.json({ chiusura: r ? formaC(r) : null, uscite: num(u.t), usciteN: u.n, usciteC: num(u.c), usciteA: num(u.a), versatiC: num(v.c), versatiA: num(v.a) });
}));
app.put('/api/chiusura', needUser, wrap(async (req, res) => {
  const b = req.body || {};
  const sede = sedeOk(req, str(b.sede, 60)); if (!sede) return bad(res, 400, 'Scegli la sede.');
  const data = str(b.data, 10) || oggi(); if (!isDate(data)) return bad(res, 400, 'Data non valida.');
  if (data > oggi()) return bad(res, 400, 'Non si chiude la cassa di un giorno che deve ancora venire.');
  if (data < addG(oggi(), -GIORNI_CHIUSURA)) return bad(res, 403, `Puoi chiudere o correggere solo gli ultimi ${GIORNI_CHIUSURA} giorni. Per le date più vecchie chiedi all'amministrazione.`);
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

/* ============ VERSAMENTI IN BANCA ============ */
const formaV = r => ({ id: r.id, sede: r.sede_id, sedeNome: r.sede_nome, data: r.data, contanti: num(r.contanti), assegni: num(r.assegni), totale: num(r.contanti) + num(r.assegni),
  assegniRighe: r.assegni_righe || [], nota: r.nota, stato: r.stato, chi: r.creato_nome, il: r.creato_il, decisoDa: r.deciso_nome || '', decisoIl: r.deciso_il, notaAdmin: r.nota_admin || '' });
async function adminCassa() {
  const { rows } = await store.q(`select u.id from users u where u.status = 'active' and (u.owner or exists (select 1 from user_apps a where a.user_id = u.id and a.app = $1 and a.role = 'admin' and not a.sospesa))`, [KEY]);
  return rows.map(r => r.id);
}
const avvisaCassa = (ids, payload) => require('../accessi/lib/notifiche').notifica(ids, KEY, payload).catch(e => console.warn('REC notifica:', e.message));
app.get('/api/versamenti', needVedere, wrap(async (req, res) => {
  const sedi = sediRichieste(req); if (!sedi) return bad(res, 403, 'Sede non tua.');
  const p = periodo(req.query.periodo), ids = sedi.map(s => s.id);
  const { rows } = await db.q(`select * from versamenti where sede_id = any($1) and data between $2 and $3 and stato <> 'annullato' order by data desc, creato_il desc`, [ids, p.dal, p.al]);
  // all'amministrazione anche tutti quelli da approvare, di qualunque periodo
  const attesa = req.me.pan ? (await db.q(`select * from versamenti where stato = 'attesa' order by creato_il`)).rows.map(formaV) : [];
  res.json({ periodo: p.chiave, versamenti: rows.map(r => ({ ...formaV(r), puoiAnnullare: r.stato === 'attesa' && r.creato_da === req.me.id })), attesa });
}));
app.post('/api/versamenti', needUser, wrap(async (req, res) => {
  const b = req.body || {};
  const sede = sedeOk(req, str(b.sede, 60)); if (!sede) return bad(res, 400, 'Scegli la sede.');
  const contanti = euro(b.contanti);
  if (contanti == null) return bad(res, 400, 'Controlla l\'importo dei contanti: solo numeri, anche 0.');
  // assegni: uno per riga, con nome e cognome del paziente che l'ha dato (obbligatorio)
  const righe = (Array.isArray(b.assegniRighe) ? b.assegniRighe : []).slice(0, 50).map(x => ({ paziente: str(x?.paziente, 120), importo: euro(x?.importo) }))
    .filter(x => x.paziente || x.importo);
  for (const x of righe) {
    if (x.paziente.split(' ').filter(Boolean).length < 2) return bad(res, 400, 'Per ogni assegno scrivi nome e cognome del paziente che l\'ha dato.');
    if (!(x.importo > 0)) return bad(res, 400, `Scrivi l'importo dell'assegno di ${x.paziente}.`);
  }
  const assegni = Math.round(righe.reduce((s, x) => s + x.importo, 0) * 100) / 100;
  if (!(contanti + assegni > 0)) return bad(res, 400, 'Scrivi quanto hai versato in contanti e/o in assegni.');
  if (contanti + assegni > 1000000) return bad(res, 400, 'Importo troppo alto: controlla le cifre.');
  const nota = String(b.nota ?? '').trim().slice(0, 500);
  const id = db.newId();
  await db.q(`insert into versamenti (id, sede_id, sede_nome, data, contanti, assegni, assegni_righe, nota, creato_da, creato_nome) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [id, sede.id, sede.nome, oggi(), contanti, assegni, JSON.stringify(righe), nota, req.me.id, req.me.nome]);
  // nello storico solo gli importi, non i nomi dei pazienti
  log('versamento', id, req.me.nome, null, { sede: sede.nome, contanti, assegni, nAssegni: righe.length });
  avvisaCassa(await adminCassa(), { title: 'Versamento in banca da approvare', body: `${sede.nome}: contanti ${euroTxt(contanti)}, assegni ${euroTxt(assegni)} (da ${req.me.nome}).`, url: 'https://appgestione.it/cassa/?v=pannello' });
  res.json({ ok: true, id });
}));
app.post('/api/versamenti/:id/annulla', needUser, wrap(async (req, res) => {
  const { rowCount } = await db.q(`update versamenti set stato = 'annullato' where id = $1 and creato_da = $2 and stato = 'attesa'`, [req.params.id, req.me.id]);
  if (!rowCount) return bad(res, 400, 'Si può annullare solo un versamento tuo ancora da approvare.');
  res.json({ ok: true });
}));
app.post('/api/versamenti/:id/decidi', needAdmin, wrap(async (req, res) => {
  const ok = !!req.body?.ok, nota = str(req.body?.nota, 300);
  const { rows: [r] } = await db.q(`update versamenti set stato = $2, deciso_da = $3, deciso_nome = $4, deciso_il = now(), nota_admin = $5 where id = $1 and stato = 'attesa' returning *`,
    [req.params.id, ok ? 'approvato' : 'rifiutato', req.me.id, req.me.nome, nota || null]);
  if (!r) return bad(res, 400, 'Questo versamento non è più da approvare.');
  log(ok ? 'versamento approvato' : 'versamento rifiutato', r.id, req.me.nome, null, { nota });
  avvisaCassa([r.creato_da], { title: ok ? 'Versamento approvato' : 'Versamento non approvato', body: `${r.sede_nome}, versamento del ${String(r.data).split('-').reverse().join('/')}: ${ok ? 'approvato, tolto dalla chiusura di cassa' : 'non approvato' + (nota ? ' (' + nota + ')' : '')}.`, url: 'https://appgestione.it/cassa/?v=uscite' });
  res.json({ ok: true });
}));

/* ============ PANNELLO (amministrazione) ============ */
app.get('/api/pannello', needAdmin, wrap(async (req, res) => {
  const p = periodo(req.query.periodo), sedi = req.me.pan.sedi, ids = sedi.map(s => s.id);
  const [{ rows: us }, giorni] = await Promise.all([
    db.q(`select sede_id, sum(importo) as t, count(*)::int as n, sum(importo) filter (where metodo = 'contanti') as uc, sum(importo) filter (where metodo = 'pos') as up,
      sum(importo) filter (where metodo = 'assegno') as ua from uscite where sede_id = any($1) and data between $2 and $3 and not annullata group by sede_id`, [ids, p.dal, p.al]),
    giorniCassa(ids, p.dal, p.al),
  ]);
  const U = new Map(us.map(r => [r.sede_id, r]));
  const righe = sedi.map(s => {
    const u = U.get(s.id) || {}, gg = giorni.filter(x => x.sede === s.id), somma = f => gg.reduce((a, x) => a + f(x), 0);
    const fatte = gg.filter(x => x.fatta);
    const r = { sede: s.id, nome: s.nome, uscite: num(u.t), usciteN: u.n || 0, usciteMetodo: { contanti: num(u.uc), pos: num(u.up), assegno: num(u.ua) },
      contanti: somma(x => x.contanti), pos: somma(x => x.pos), assegni: somma(x => x.assegni), versati: somma(x => x.versati.contanti + x.versati.assegni),
      giorni: fatte.length, ultima: fatte.length ? fatte.map(x => x.data).sort().pop() : null };
    r.incassi = r.contanti + r.pos + r.assegni;
    return r;
  });
  const tot = k => righe.reduce((s, r) => s + r[k], 0);
  // chiusure mancanti di ieri (solo guardando il mese in corso)
  const ieri = addG(oggi(), -1);
  const { rows: fatteIeri } = await db.q('select sede_id from chiusure where data = $1', [ieri]);
  res.json({ periodo: p.chiave, righe, totali: { uscite: tot('uscite'), usciteN: tot('usciteN'), contanti: tot('contanti'), pos: tot('pos'), assegni: tot('assegni'), incassi: tot('incassi'), versati: tot('versati'), giorni: tot('giorni') },
    ieri, senzaChiusuraIeri: sedi.filter(s => !fatteIeri.some(f => f.sede_id === s.id)).map(s => s.nome) });
}));

// sede della suite → sede della Gestione finanziaria (Sestu = la sede direzionale, se il nome non coincide)
const sedeFin = (cons, nome) => finanza.trova(cons.sedi, nome) || (/sestu/i.test(nome) ? (cons.sedi || []).find(x => x.id === cons.direzione?.sedeId) : null);

/* ============ PRODUZIONE DI UL ============ */
// ogni sede carica la produzione del mese (un totale in €); va nel Consuntivo della Gestione finanziaria
// solo quando l'amministratore la approva (se la carica l'amministratore, va subito)
const formaP = r => ({ sede: r.sede_id, sedeNome: r.sede_nome, anno: r.anno, mese: r.mese, valore: num(r.valore), stato: r.stato,
  inviatoDa: r.inviato_nome, inviatoIl: r.inviato_il, decisoDa: r.deciso_nome || '', decisoIl: r.deciso_il, nota: r.nota_admin || '',
  inviata: r.sincronizzato_il, errore: r.errore || '' });
async function adminProduzione() {
  const { rows } = await store.q(`select u.id from users u where u.status = 'active' and (u.owner or exists (select 1 from user_apps a where a.user_id = u.id and a.app = $1 and a.role = 'admin' and not a.sospesa))`, [KEY_P]);
  return rows.map(r => r.id);
}
const avvisa = (ids, payload) => require('../accessi/lib/notifiche').notifica(ids, KEY_P, payload).catch(e => console.warn('REC notifica:', e.message));
const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const euroTxt = n => (Math.round(n * 100) / 100).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' €';
// manda il valore nel Consuntivo (Produzione della sede, quel mese)
async function sincronizza(r) {
  const az = await finanza.aziendaToSmile();
  if (!az) throw new Error('Non trovo l\'azienda To Smile in Gestione finanziaria.');
  const cons = await finanza.chiama(`/api/_appgestione/consuntivo?azienda=${encodeURIComponent(az)}&anno=${r.anno}&mese=${r.mese}`);
  if (cons.annoNelGestionale !== r.anno) throw new Error(`In Gestione finanziaria il consuntivo aperto è del ${cons.annoNelGestionale}, non del ${r.anno}.`);
  const f = sedeFin(cons, r.sede_nome);
  if (!f) throw new Error(`La sede ${r.sede_nome} non c'è in Gestione finanziaria (controlla che abbia lo stesso nome).`);
  return finanza.scrivi('/api/_appgestione/produzione', { azienda: az, sedeId: f.id, anno: r.anno, mese: r.mese, valore: num(r.valore) });
}
async function approva(r, chi) {
  try {
    const x = await sincronizza(r);
    await db.q(`update produzione set stato = 'approvata', deciso_da = $4, deciso_nome = $5, deciso_il = now(), sincronizzato_il = now(), errore = '', valore_prima = $6
      where sede_id = $1 and anno = $2 and mese = $3`, [r.sede_id, r.anno, r.mese, chi.id, chi.nome, x.prima ?? null]);
    log('produzione approvata', `${r.sede_id}|${r.anno}-${r.mese}`, chi.nome, { valore: x.prima }, { valore: num(r.valore) });
    return { ok: true, prima: x.prima };
  } catch (e) {
    const msg = finanza.messaggio(e);
    await db.q(`update produzione set errore = $4 where sede_id = $1 and anno = $2 and mese = $3`, [r.sede_id, r.anno, r.mese, msg]);
    return { ok: false, errore: msg };
  }
}
app.get('/api/produzione', needProd, wrap(async (req, res) => {
  const anno = parseInt(req.query.anno, 10) || Number(oggi().slice(0, 4));
  const sedi = req.me.prod.sedi, ids = sedi.map(s => s.id);
  const { rows } = await db.q('select * from produzione where sede_id = any($1) and anno = $2 order by sede_nome, mese', [ids, anno]);
  let attesa = [];
  if (req.me.prod.admin) attesa = (await db.q(`select * from produzione where stato = 'attesa' order by inviato_il`)).rows.map(formaP);
  // all'amministratore: quanto c'è ora nel Consuntivo (per confrontare prima di approvare)
  let nelConsuntivo = null;
  if (req.me.prod.admin) {
    try {
      const az = await finanza.aziendaToSmile();
      const cons = az && await finanza.chiama(`/api/_appgestione/consuntivo?azienda=${encodeURIComponent(az)}&anno=${anno}&mese=1`);
      if (cons && cons.annoNelGestionale === anno) {
        nelConsuntivo = {};
        for (const s of sedi) { const f = finanza.trova(cons.sedi, s.nome) || (/sestu/i.test(s.nome) ? (cons.sedi || []).find(x => x.id === cons.direzione?.sedeId) : null); if (f) nelConsuntivo[s.id] = f.produzioneMesi || null; }
      }
    } catch { /* la Gestione finanziaria non risponde: si vede solo REC */ }
  }
  res.json({ anno, sedi, righe: rows.map(formaP), attesa, nelConsuntivo, oggi: oggi() });
}));
app.post('/api/produzione', needProd, wrap(async (req, res) => {
  const b = req.body || {};
  const sede = req.me.prod.sedi.find(s => s.id === str(b.sede, 60)); if (!sede) return bad(res, 400, 'Scegli la sede.');
  const anno = parseInt(b.anno, 10), mese = parseInt(b.mese, 10);
  const [ya, ma] = oggi().split('-').map(Number);
  if (!(mese >= 1 && mese <= 12) || !(anno === ya || anno === ya - 1)) return bad(res, 400, 'Scegli il mese.');
  if (anno === ya && mese > ma) return bad(res, 400, 'Non si carica la produzione di un mese che deve ancora venire.');
  const valore = euro(b.valore); if (valore == null || String(b.valore ?? '').trim() === '') return bad(res, 400, 'Scrivi la produzione del mese in € (anche 0).');
  if (valore > 10000000) return bad(res, 400, 'Importo troppo alto: controlla le cifre.');
  const { rows: [prima] } = await db.q('select * from produzione where sede_id = $1 and anno = $2 and mese = $3', [sede.id, anno, mese]);
  if (prima && prima.stato === 'approvata' && num(prima.valore) === valore) return res.json({ ok: true, stato: 'approvata', uguale: true });
  await db.q(`insert into produzione (sede_id, anno, mese, sede_nome, valore, stato, inviato_da, inviato_nome, inviato_il, errore)
      values ($1,$2,$3,$4,$5,'attesa',$6,$7,now(),'')
    on conflict (sede_id, anno, mese) do update set valore = excluded.valore, sede_nome = excluded.sede_nome, stato = 'attesa',
      inviato_da = excluded.inviato_da, inviato_nome = excluded.inviato_nome, inviato_il = now(), deciso_da = null, deciso_nome = null, deciso_il = null, nota_admin = null, errore = ''`,
    [sede.id, anno, mese, sede.nome, valore, req.me.id, req.me.nome]);
  log('produzione caricata', `${sede.id}|${anno}-${mese}`, req.me.nome, prima ? { valore: num(prima.valore), stato: prima.stato } : null, { valore });
  const { rows: [r] } = await db.q('select * from produzione where sede_id = $1 and anno = $2 and mese = $3', [sede.id, anno, mese]);
  if (req.me.prod.admin) { const x = await approva(r, req.me); return res.json({ ok: true, stato: x.ok ? 'approvata' : 'attesa', errore: x.errore || null }); }
  avvisa(await adminProduzione(), { title: 'Produzione da approvare', body: `${sede.nome}: produzione di ${MESI[mese - 1]} ${anno} ${euroTxt(valore)} (da ${req.me.nome}).`, url: 'https://appgestione.it/cassa/?v=produzione' });
  res.json({ ok: true, stato: 'attesa' });
}));
app.post('/api/produzione/decidi', needProd, wrap(async (req, res) => {
  if (!req.me.prod.admin) return bad(res, 403, 'Solo l\'amministratore approva la produzione.');
  const b = req.body || {};
  const { rows: [r] } = await db.q(`select * from produzione where sede_id = $1 and anno = $2 and mese = $3 and stato = 'attesa'`, [str(b.sede, 60), parseInt(b.anno, 10), parseInt(b.mese, 10)]);
  if (!r) return bad(res, 400, 'Questa produzione non è più da approvare.');
  if (b.ok) {
    const x = await approva(r, req.me);
    if (!x.ok) return bad(res, 502, 'Non sono riuscito a mandarla in Gestione finanziaria: ' + x.errore);
    if (r.inviato_da !== req.me.id) avvisa([r.inviato_da], { title: 'Produzione approvata', body: `${r.sede_nome}: produzione di ${MESI[r.mese - 1]} ${r.anno} ${euroTxt(num(r.valore))} approvata.`, url: 'https://appgestione.it/cassa/?v=produzione' });
    return res.json({ ok: true, prima: x.prima });
  }
  const nota = str(b.nota, 300);
  await db.q(`update produzione set stato = 'rifiutata', deciso_da = $4, deciso_nome = $5, deciso_il = now(), nota_admin = $6 where sede_id = $1 and anno = $2 and mese = $3`,
    [r.sede_id, r.anno, r.mese, req.me.id, req.me.nome, nota]);
  log('produzione rifiutata', `${r.sede_id}|${r.anno}-${r.mese}`, req.me.nome, null, { nota });
  avvisa([r.inviato_da], { title: 'Produzione da ricontrollare', body: `${r.sede_nome}, ${MESI[r.mese - 1]} ${r.anno}: non approvata${nota ? ' (' + nota + ')' : ''}. Correggi e rimandala.`, url: 'https://appgestione.it/cassa/?v=produzione' });
  res.json({ ok: true });
}));

/* ---------- pagine ---------- */
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.me) return res.redirect(accessi.loginUrl(`${req.protocol}://${req.get('host')}${req.originalUrl}`));
  if (!req.me.perm && !req.me.pan && !req.me.prod) return res.redirect(`${accessi.publicUrl()}/?noaccess=rec`);
  res.sendFile(path.join(PUB, 'app.html'));
});
app.use(express.static(PUB, { index: false, maxAge: '1h' }));
app.use((err, req, res, next) => {
  if (err.status && err.status < 500) return bad(res, err.status, err.message);
  console.error('REC:', err.message);
  bad(res, err.status || 500, 'Errore del server. Riprova.');
});

// Azzeramento di Gestione Cassa dopo le prove (chiesto il 16/11/2026), una volta sola:
// 1) le spese di prova già mandate nel Consuntivo si tolgono (storno); 2) uscite, chiusure e versamenti si copiano
// in tabelle di riserva (*_prove, non usate dall'app) e poi si svuotano. La Produzione di UL non si tocca.
async function azzeraProve() {
  const FLAG = '_azzera_cassa_2026_11_16';
  await db.q('create table if not exists flags (k text primary key, il timestamptz not null default now())');
  if ((await db.q('select 1 from flags where k = $1', [FLAG])).rowCount) return;
  const { rows: mandate } = await db.q('select id from uscite where inviata_voce is not null');
  if (mandate.length) {
    await db.q('update uscite set annullata = true where id = any($1)', [mandate.map(r => r.id)]);
    await inviaUscite(mandate.map(r => r.id)); // se la Gestione finanziaria non risponde, si ferma qui e riprova al prossimo avvio
  }
  const c = await db.pool.connect();
  try {
    await c.query('begin');
    const n = {};
    for (const t of ['uscite', 'chiusure', 'versamenti']) {
      await c.query(`create table if not exists ${t}_prove as select * from ${t} where false`);
      await c.query(`insert into ${t}_prove select * from ${t}`);
      n[t] = (await c.query(`delete from ${t}`)).rowCount;
    }
    await c.query(`delete from storico where cosa not like 'produzione%'`);
    await c.query('insert into flags (k) values ($1)', [FLAG]);
    await c.query('commit');
    console.log(`REC: Gestione Cassa azzerata (uscite ${n.uscite}, chiusure ${n.chiusure}, versamenti ${n.versamenti}; tolte dal consuntivo ${mandate.length}).`);
  } catch (e) { await c.query('rollback').catch(() => {}); throw e; } finally { c.release(); }
}
async function start() {
  await db.migrate();
  azzeraProve().catch(e => console.warn('REC: azzeramento non riuscito, riprovo al prossimo avvio:', e.message));
}
module.exports = { app, start };
