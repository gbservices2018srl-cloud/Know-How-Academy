// CRM Commerciale — server (stesso servizio delle altre app, all'indirizzo appgestione.it/crm/).
// Prende il posto del vecchio CRM su Google Sheets: i dati dei pazienti stanno solo nel database su Render (Europa).
// Micro app: Inserimento Preventivi, Richiami commerciali, Dashboard dati, Chiedi al CRM, Liste (solo amministratore).
// Permessi dal pannello Gestione accessi: Amministratore = tutte le sedi; Operatore/Commerciale = le sedi scelte.
// Dati personali (paziente, anno di nascita, note): solo in Inserimento e Richiami, mai nei KPI, nell'AI o nei log.
const path = require('path');
const express = require('express');
const multer = require('multer');
const db = require('./lib/db');
const K = require('./lib/kpi');
const importa = require('./lib/importa');
const accessi = require('../accessi/server');
const store = accessi.store;
const consumo = require('../lib/consumo');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => { res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' }); next(); });
app.use(express.json({ limit: '1mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024, files: 1 } });

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, code, msg) => res.status(code).json({ error: msg });
const fail = (status, msg) => Object.assign(new Error(msg), { status });
const str = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const oggi = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
const PUB = path.join(__dirname, 'public');
const ESITI = ['A', 'S', 'R'];

/* ---------- chi sta usando l'app ---------- */
const SEZ = { preventivi: 'crm_preventivi', richiami: 'crm_richiami', dashboard: 'crm_dashboard', chiedi: 'crm_chiedi' };
let sediCache = null, sediT = 0;
async function tutteLeSedi() {
  if (!sediCache || Date.now() - sediT > 60000) {
    // Tertenia è esclusa dal CRM
    sediCache = (await store.listSedi()).filter(s => s.attiva !== false && !/tertenia/i.test(s.nome)).map(s => ({ id: s.id, nome: s.nome }));
    sediT = Date.now();
  }
  return sediCache;
}
// una sede salvata in Gestione accessi entra subito nel CRM
store.events.on('sedi', () => { sediCache = null; });
app.use(wrap(async (req, res, next) => {
  const c = await store.check(accessi.readCookie(req));
  if (!c) return next();
  const u = c.user, owner = !!u.owner;
  const spente = await store.appSpente();
  const lv = owner ? {} : await store.livelliOf(u.id);
  const tutte = await tutteLeSedi();
  const perm = {};
  for (const [s, k] of Object.entries(SEZ)) {
    const role = owner ? 'admin' : c.apps[k];
    if (!role) continue;
    if (role !== 'admin' && spente.has(k)) continue;
    if (role === 'admin') perm[s] = { admin: true, sedi: tutte };
    // il commerciale/operatore vede tutte le sedi; le sue (scelte in Gestione accessi) sono quelle principali, da cui parte
    else perm[s] = { admin: false, sedi: tutte, mie: (lv[k]?.enti || []).map(e => e.id).filter(id => tutte.some(x => x.id === id)) };
  }
  if (owner || c.apps.crm_liste === 'admin') perm.liste = { admin: true, sedi: tutte };
  req.me = { id: u.id, nome: `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email, owner, perm };
  next();
}));
const needUser = (req, res, next) => req.me ? next() : bad(res, 401, 'Accesso richiesto');
const need = s => (req, res, next) => req.me?.perm?.[s] ? next() : bad(res, 403, 'Non sei abilitato a questa sezione.');
const sediDi = (req, s) => req.me.perm[s]?.sedi || [];
const sedeOk = (req, s, id) => sediDi(req, s).find(x => x.id === id) || null;
app.use('/api', (req, res, next) => (['GET', 'HEAD', 'DELETE'].includes(req.method) || req.is('application/json') || req.is('multipart/form-data')) ? next() : bad(res, 415, 'Formato non valido'));

/* ---------- liste e impostazioni ---------- */
async function liste() {
  const { rows } = await db.q('select tipo, valore, canale, attivo from liste order by tipo, valore');
  const per = t => rows.filter(r => r.tipo === t);
  return { tipo_ov: per('tipo_ov'), marketing: per('marketing'), tipo_pdc: per('tipo_pdc') };
}
// marketing grezzo → canale della dashboard (se non è impostato in Liste: il nome con l'iniziale maiuscola)
async function canaleDi() {
  const { rows } = await db.q(`select valore, canale from liste where tipo = 'marketing' and canale <> ''`);
  const m = new Map(rows.map(r => [r.valore, r.canale]));
  return mk => m.get(mk) || null;
}
// nomi del vecchio foglio collegati a una persona (Liste): così nei KPI e nei filtri la stessa persona è una riga sola
async function aliasComm() {
  const { rows } = await db.q('select nome, user_nome from alias_commerciali');
  const m = new Map(rows.map(r => [r.nome, r.user_nome]));
  return c => m.get(String(c || '').trim().toUpperCase()) || c;
}
const imp = async k => (await db.q('select v from impostazioni where k = $1', [k])).rows[0]?.v ?? null;
const impSet = (k, v) => db.q('insert into impostazioni (k, v) values ($1,$2) on conflict (k) do update set v = excluded.v', [k, JSON.stringify(v)]);

/* ---------- stato ---------- */
app.get('/api/stato', needUser, wrap(async (req, res) => {
  const p = req.me.perm;
  const anni = (await db.q('select distinct anno from preventivi order by anno desc')).rows.map(r => r.anno);
  res.json({ me: { id: req.me.id, nome: req.me.nome }, perm: p, liste: await liste(), oggi: oggi(), home: accessi.publicUrl(),
    anni: anni.length ? anni : [Number(oggi().slice(0, 4))], ai: !!process.env.ANTHROPIC_API_KEY });
}));

/* ============ INSERIMENTO PREVENTIVI ============ */
const COMMERCIALI = ['RAP', 'RUL'];
const nomeDi = u => `${u.first_name || ''} ${u.last_name || ''}`.trim();
// commerciali (RAP, RUL) e medici della sede, dall'anagrafica di Gestione accessi
app.get('/api/persone', needUser, need('preventivi'), wrap(async (req, res) => {
  const sede = sedeOk(req, 'preventivi', str(req.query.sede, 60)); if (!sede) return bad(res, 403, 'Sede non tua.');
  const { rows } = await store.q(`select id, first_name, last_name, figura, sedi from users where status = 'active' and not owner and figura = any($1) order by last_name, first_name`,
    [[...COMMERCIALI, 'Medico']]);
  const inSede = u => Array.isArray(u.sedi) && u.sedi.includes(sede.id);
  const forma = u => ({ id: u.id, nome: nomeDi(u), figura: u.figura });
  const comm = rows.filter(u => COMMERCIALI.includes(u.figura));
  const med = rows.filter(u => u.figura === 'Medico');
  const commSede = comm.filter(inSede), medSede = med.filter(inSede);
  res.json({ commerciali: (commSede.length ? commSede : comm).map(forma), commercialiTutti: !commSede.length,
    medici: (medSede.length ? medSede : med).map(forma), mediciTutti: !medSede.length });
}));

app.post('/api/preventivi', needUser, need('preventivi'), wrap(async (req, res) => {
  const b = req.body || {};
  const sede = sedeOk(req, 'preventivi', str(b.sede, 60)); if (!sede) return bad(res, 400, 'Scegli la sede.');
  const data = str(b.data, 10); if (!isDate(data)) return bad(res, 400, 'Scrivi la data.');
  const paziente = str(b.paziente, 120).toUpperCase(); if (paziente.length < 3) return bad(res, 400, 'Scrivi cognome e nome del paziente.');
  const an = parseInt(b.annoNascita, 10), annoOra = Number(oggi().slice(0, 4));
  if (!(an >= 1910 && an <= annoOra)) return bad(res, 400, "Scrivi l'anno di nascita (4 cifre, es. 1985).");
  const L = await liste();
  const tipo = str(b.tipoOv, 60).toUpperCase(); if (!L.tipo_ov.some(x => x.valore === tipo)) return bad(res, 400, 'Scegli il tipo di opportunità.');
  const mk = str(b.marketing, 80).toUpperCase(); if (!L.marketing.some(x => x.valore === mk)) return bad(res, 400, 'Scegli il canale marketing.');
  const num = v => { const n = Number(String(v ?? '').replace(',', '.')); return isFinite(n) && n >= 0 && String(v ?? '').trim() !== '' ? Math.round(n * 100) / 100 : null; };
  const pdc = num(b.pdc); if (pdc == null) return bad(res, 400, 'Scrivi il € del piano di cura (anche 0).');
  const pagato = num(b.pagato); if (pagato == null) return bad(res, 400, "Scrivi l'importo pagato (anche 0).");
  const tipoPdc = (L.tipo_pdc.find(x => x.attivo && x.valore === str(b.tipoPdc, 80).toUpperCase()) || {}).valore;
  if (!tipoPdc) return bad(res, 400, "Scegli il tipo di piano di cura dall'elenco.");
  const esito = str(b.esito, 1).toUpperCase(); if (!ESITI.includes(esito)) return bad(res, 400, "Scegli l'esito.");
  const note = String(b.note ?? '').trim().slice(0, 4000); if (note.length < 50) return bad(res, 400, `Note troppo brevi: minimo 50 caratteri (${note.length} scritti).`);
  const ids = [str(b.commerciale, 60), ...(Array.isArray(b.medici) ? b.medici : []).map(x => str(x, 60))].filter(Boolean);
  const { rows: us } = await store.q(`select id, first_name, last_name, figura from users where id = any($1) and status = 'active'`, [ids]);
  const comm = us.find(u => u.id === str(b.commerciale, 60) && COMMERCIALI.includes(u.figura)); if (!comm) return bad(res, 400, 'Scegli il commerciale.');
  const meds = [...new Set((Array.isArray(b.medici) ? b.medici : []).map(x => str(x, 60)))].map(id => us.find(u => u.id === id && u.figura === 'Medico')).filter(Boolean).slice(0, 4);
  if (!meds.length) return bad(res, 400, 'Scegli il medico che ha fatto la visita.');
  const id = db.newId();
  // medico come nel vecchio CRM: cognomi in maiuscolo, più medici separati da "/"
  await db.q(`insert into preventivi (id, sede_id, sede_nome, data, anno, mese, paziente, tipo_ov, marketing, pdc, esito, pagato, anno_nascita, tipo_pdc, note,
      commerciale_id, commerciale, medici_ids, medico, origine, creato_da, aggiornato_da)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,'app',$20,$20)`,
    [id, sede.id, sede.nome, data, Number(data.slice(0, 4)), Number(data.slice(5, 7)), paziente, tipo, mk, pdc, esito, pagato, an, tipoPdc, note,
      comm.id, nomeDi(comm).toUpperCase(), JSON.stringify(meds.map(m => m.id)), meds.map(m => String(m.last_name || m.first_name).toUpperCase()).join(' / '), req.me.id]);
  res.json({ ok: true, id });
}));

/* ============ RICHIAMI COMMERCIALI ============ */
app.get('/api/richiami', needUser, need('richiami'), wrap(async (req, res) => {
  const sedi = sediDi(req, 'richiami').map(s => s.id);
  const anno = parseInt(req.query.anno, 10) || Number(oggi().slice(0, 4));
  const { rows } = await db.q(`select id, sede_id, sede_nome, to_char(data, 'YYYY-MM-DD') as data, anno, mese, paziente, tipo_ov, marketing, pdc::float, esito,
      pagato::float, anno_nascita, tipo_pdc, note, commerciale, medico, aggiornato_il
    from preventivi where sede_id = any($1) and anno = $2 order by data desc nulls last, creato_il desc`, [sedi, anno]);
  const annoOra = Number(oggi().slice(0, 4)), al = await aliasComm();
  res.set('Cache-Control', 'no-store');
  res.json({ righe: rows.map(r => ({ ...r, commerciale: al(r.commerciale), eta: r.anno_nascita ? annoOra - r.anno_nascita : null, anno_nascita: undefined })) });
}));
app.patch('/api/richiami/:id', needUser, need('richiami'), wrap(async (req, res) => {
  const id = str(req.params.id, 60);
  const { rows: [r] } = await db.q('select id, sede_id, esito, note from preventivi where id = $1', [id]);
  if (!r || !sedeOk(req, 'richiami', r.sede_id)) return bad(res, 404, 'Preventivo non trovato.');
  const set = {};
  if (req.body.esito !== undefined) { const e = str(req.body.esito, 1).toUpperCase(); if (!ESITI.includes(e)) return bad(res, 400, 'Esito non valido.'); set.esito = e; }
  if (req.body.note !== undefined) set.note = String(req.body.note ?? '').trim().slice(0, 4000);
  const campi = Object.keys(set).filter(k => set[k] !== r[k]);
  if (!campi.length) return res.json({ ok: true });
  for (const k of campi) await db.q('insert into storico (preventivo_id, chi, campo, prima, dopo) values ($1,$2,$3,$4,$5)', [id, req.me.nome, k, r[k], set[k]]);
  await db.q(`update preventivi set ${campi.map((k, i) => `${k} = $${i + 2}`).join(', ')}, aggiornato_da = $${campi.length + 2}, aggiornato_il = now() where id = $1`,
    [id, ...campi.map(k => set[k]), req.me.id]);
  res.json({ ok: true });
}));

/* ============ DATI PER KPI (senza dati personali) ============ */
async function datiKpi(sediIds, anno) {
  const { rows } = await db.q(`select sede_nome, to_char(data, 'YYYY-MM-DD') as data, anno, mese, tipo_ov, marketing, pdc::float, esito, pagato::float, tipo_pdc, commerciale, medico
    from preventivi where sede_id = any($1) ${anno ? 'and anno = $2' : ''}`, anno ? [sediIds, anno] : [sediIds]);
  const al = await aliasComm();
  for (const r of rows) r.commerciale = al(r.commerciale);
  return K.dataset(rows, await canaleDi(), al);
}

/* ---------- Gestione finanziaria: tassi di finanziamento verso pazienti (consuntivo, da inizio anno a oggi) ---------- */
const FIN_URL = () => (process.env.FINANZA_URL || 'https://finanza.appgestione.it').replace(/\/$/, '');
const finCache = new Map();
async function finanza(p) {
  const key = process.env.SSO_API_KEY; if (!key) throw new Error('Collegamento con Gestione finanziaria non configurato.');
  const c = finCache.get(p); if (c && Date.now() - c.t < 5 * 60e3) return c.v;
  const r = await fetch(FIN_URL() + p, { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Gestione finanziaria non risponde (' + r.status + ').');
  const v = await r.json(); finCache.set(p, { t: Date.now(), v }); if (finCache.size > 50) finCache.clear();
  return v;
}
// azienda di Gestione finanziaria: quella scelta in Liste, altrimenti l'unica che si chiama "To Smile"
async function aziendaFin() {
  const scelta = await imp('fin_azienda'); if (scelta) return scelta;
  const az = (await finanza('/api/_appgestione/aziende')).aziende || [];
  const ts = az.filter(a => /to\s*smile/i.test(a.nome));
  return ts.length === 1 ? ts[0].id : null;
}
async function finanziamenti(sedi, anno) {
  const az = await aziendaFin();
  if (!az) return { errore: 'Scegli l’azienda di Gestione finanziaria in Liste.' };
  const d = await finanza(`/api/_appgestione/consuntivo?azienda=${encodeURIComponent(az)}&anno=${anno}&mese=1`);
  if (d.annoNelGestionale !== anno) return { errore: `In Gestione finanziaria il consuntivo aperto è del ${d.annoNelGestionale || '—'}, non del ${anno}.` };
  if (!d.voceFinanziamenti) return { errore: 'In Gestione finanziaria manca la voce «Tassi finanziamento verso pazienti».' };
  const [ya, ma] = oggi().split('-').map(Number);
  const fino = anno < ya ? 12 : ma; // da gennaio al mese in corso
  const finLib = require('../lib/finanza');
  const somma = (a, n) => (a || []).slice(0, n).reduce((x, y) => x + (Number(y) || 0), 0);
  const righe = sedi.map(s => {
    const f = finLib.trova(d.sedi, s.nome);
    if (!f) return { sede: s.nome, trovata: false };
    const tassi = somma(f.finanziamentiMesi, fino), fatt = somma(f.fatturatoMesi, fino);
    return { sede: s.nome, trovata: true, tassi, fatturato: fatt, incidenza: fatt > 0 ? tassi / fatt : null };
  });
  const tot = righe.filter(r => r.trovata).reduce((a, r) => ({ tassi: a.tassi + r.tassi, fatturato: a.fatturato + r.fatturato }), { tassi: 0, fatturato: 0 });
  return { azienda: d.azienda, fino, righe, totale: { ...tot, incidenza: tot.fatturato > 0 ? tot.tassi / tot.fatturato : null } };
}

/* ============ DASHBOARD DATI ============ */
app.get('/api/dashboard', needUser, need('dashboard'), wrap(async (req, res) => {
  const sedi = sediDi(req, 'dashboard');
  const anno = parseInt(req.query.anno, 10) || Number(oggi().slice(0, 4));
  const ds = await datiKpi(sedi.map(s => s.id), anno);
  let fin; try { fin = await finanziamenti(sedi, anno); } catch (e) { fin = { errore: /fetch failed|aborted|timeout/i.test(e.message) ? 'Gestione finanziaria non raggiungibile in questo momento: riprova tra poco.' : e.message }; }
  res.set('Cache-Control', 'no-store');
  res.json({ anno, sedi: sedi.map(s => s.nome), ...K.dashboard(ds), finanziamenti: fin });
}));

/* ============ CHIEDI AL CRM ============ */
const regole = (sedi, quando) => `Sei l'analista commerciale di To Smile, una rete di studi dentistici in Sardegna (studi visibili a chi chiede: ${sedi.join(', ')}). Rispondi in italiano, in modo chiaro e conciso, a chi gestisce le vendite.

Oggi è ${new Date().toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Rome' })}. I dati sono quelli del CRM Commerciale letti alle ${quando}. Il mese in corso è parziale.

Hai tre strumenti sui dati: schema, aggregate, rows. Ogni numero che scrivi deve venire da una chiamata a questi strumenti: non stimare e non inventare. Se servono valori esatti (nomi, canali, tipologie) chiama prima schema. Se la domanda non dice l'anno, usa l'anno in corso.

Regole dei KPI, uguali alla Dashboard dati:
- Preventivi presentati = numero di righe; accettati = esito A; % accettazione = accettati ÷ presentati.
- Incassato = pagato dei preventivi accettati; ticket medio = incassato ÷ accettati.
- Valore accettato = somma dei piani di cura accettati (pdc_accettato).
- I pagamenti dilazionati non entrano nei KPI; fatturato totale = incassato + dilazionati.
- Per studi, venditori, canali e tipologie usa il dataset "preventivi". Per i medici usa "medici" (dati da settembre 2026; una visita condivisa conta per ognuno). Usa "opportunita" solo per dettagli che gli altri non hanno (date, esiti S e R, tipo di cura, venditore grezzo).
- "Escludi preventivi sotto 200 €" = filtro pdc ≥ 200: applicalo solo se richiesto.
- Trimestri: Q1 gen-mar, Q2 apr-giu, Q3 lug-set, Q4 ott-dic.

Formato: comincia con la risposta in una o due frasi, poi una tabella Markdown se ci sono più righe da confrontare, poi al massimo 2-3 osservazioni utili. Euro senza decimali con il punto delle migliaia (es. 12.450 €), percentuali con un decimale (es. 41,3%). Indica in una riga finale quali filtri hai usato se non è ovvio. Segnala quando un numero è basato su pochi preventivi (meno di 10). Nei dati non ci sono nomi di pazienti: non nominarli mai.`;
app.post('/api/chiedi', needUser, need('chiedi'), wrap(async (req, res) => {
  const turni = (Array.isArray(req.body.messaggi) ? req.body.messaggi : []).slice(-12)
    .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 6000) })).filter(m => m.content);
  while (turni.length && turni[0].role !== 'user') turni.shift();
  if (!turni.length || turni[turni.length - 1].role !== 'user') return bad(res, 400, 'Scrivi una domanda.');
  const sedi = sediDi(req, 'chiedi');
  const DATA = await datiKpi(sedi.map(s => s.id), null);
  const quando = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome' });
  try {
    const r = await consumo.chiediConStrumenti('crm_chiedi', regole(sedi.map(s => s.nome), quando), turni, K.strumenti(DATA), 4000);
    res.json({ testo: r.text, troncato: r.troncato, passi: r.passi.map(p => p.nome === 'aggregate' ? `calcolo su ${p.input.dataset}${(p.input.group_by || []).length ? ' per ' + p.input.group_by.join(', ') : ''}` : p.nome === 'rows' ? `righe di ${p.input.dataset}` : 'struttura dei dati') });
  } catch (e) { if (e.status) return bad(res, e.status, e.message); throw e; }
}));

/* ============ LISTE (solo amministratore) ============ */
app.get('/api/liste', needUser, need('liste'), wrap(async (req, res) => {
  const { rows } = await db.q(`select tipo, valore, count(*)::int as n from (
      select 'tipo_ov' as tipo, tipo_ov as valore from preventivi union all select 'marketing', marketing from preventivi union all select 'tipo_pdc', tipo_pdc from preventivi) x
    where valore <> '' group by 1, 2`);
  const usi = Object.fromEntries(rows.map(r => [r.tipo + '|' + r.valore, r.n]));
  const imps = (await db.q('select file, righe, riepilogo, fatto_da, fatto_il from importazioni order by fatto_il desc limit 5')).rows;
  const tot = (await db.q(`select origine, count(*)::int as n from preventivi group by 1`)).rows;
  let aziende = [], finErr = null; try { aziende = (await finanza('/api/_appgestione/aziende')).aziende || []; } catch (e) { finErr = e.message; }
  // commerciali scritti a mano nel vecchio foglio (righe importate) e persone a cui collegarli
  const { rows: grezzi } = await db.q(`select commerciale as nome, count(*)::int as n from preventivi where origine = 'import' and commerciale <> '' group by 1 order by 2 desc`);
  const { rows: alias } = await db.q('select nome, user_id from alias_commerciali');
  const { rows: pers } = await store.q(`select id, first_name, last_name, figura from users where status = 'active' and not owner and coalesce(figura, '') <> 'Medico' order by (figura in ('RAP', 'RUL')) desc, last_name, first_name`);
  res.json({ liste: await liste(), usi, importazioni: imps, commGrezzi: grezzi, alias: Object.fromEntries(alias.map(a => [a.nome, a.user_id])),
    persone: pers.map(u => ({ id: u.id, nome: nomeDi(u), figura: u.figura || '' })), totali: Object.fromEntries(tot.map(r => [r.origine, r.n])),
    finAzienda: await imp('fin_azienda'), finAuto: await aziendaFin().catch(() => null), aziende, finErr });
}));
app.post('/api/liste/voce', needUser, need('liste'), wrap(async (req, res) => {
  const tipo = str(req.body.tipo, 20); if (!['tipo_ov', 'marketing', 'tipo_pdc'].includes(tipo)) return bad(res, 400, 'Elenco non valido.');
  const valore = str(req.body.valore, 80).toUpperCase(); if (!valore) return bad(res, 400, 'Scrivi la voce.');
  const prima = str(req.body.prima, 80).toUpperCase();
  const canale = tipo === 'marketing' ? str(req.body.canale, 60) : '';
  const attivo = req.body.attivo !== false;
  if (prima && prima !== valore) {
    // rinomina: anche nei preventivi già salvati, così filtri e KPI restano uniti
    const col = tipo;
    await db.q(`update liste set valore = $3, canale = $4, attivo = $5 where tipo = $1 and valore = $2`, [tipo, prima, valore, canale, attivo]);
    const { rowCount } = await db.q(`update preventivi set ${col} = $2 where ${col} = $1`, [prima, valore]);
    return res.json({ ok: true, aggiornati: rowCount });
  }
  await db.q(`insert into liste (tipo, valore, canale, attivo) values ($1,$2,$3,$4) on conflict (tipo, valore) do update set canale = excluded.canale, attivo = excluded.attivo`, [tipo, valore, canale, attivo]);
  res.json({ ok: true });
}));
app.post('/api/liste/alias', needUser, need('liste'), wrap(async (req, res) => {
  const nome = str(req.body.nome, 80).toUpperCase(); if (!nome) return bad(res, 400, 'Nome mancante.');
  const uid = str(req.body.userId, 60);
  if (!uid) { await db.q('delete from alias_commerciali where nome = $1', [nome]); return res.json({ ok: true }); }
  const { rows: [u] } = await store.q(`select id, first_name, last_name from users where id = $1 and status = 'active'`, [uid]);
  if (!u) return bad(res, 400, 'Persona non trovata.');
  await db.q('insert into alias_commerciali (nome, user_id, user_nome) values ($1,$2,$3) on conflict (nome) do update set user_id = excluded.user_id, user_nome = excluded.user_nome',
    [nome, u.id, nomeDi(u).toUpperCase()]);
  res.json({ ok: true });
}));
app.put('/api/liste/azienda', needUser, need('liste'), wrap(async (req, res) => {
  await impSet('fin_azienda', str(req.body.azienda, 80) || null); finCache.clear(); res.json({ ok: true });
}));

// importazione dal vecchio foglio Google: prima l'anteprima (niente si salva), poi la conferma
const anteprime = new Map();
// importazione dal vecchio foglio Google chiusa (novembre 2026): i dati sono già nel CRM e non si devono più sostituire
const IMPORT_CHIUSA = true;
app.post('/api/liste/importa/*', (req, res, next) => IMPORT_CHIUSA ? bad(res, 410, 'L’importazione dal vecchio foglio Google è chiusa: i dati sono già nel CRM.') : next());
app.post('/api/liste/importa/anteprima', needUser, need('liste'), (req, res, next) => upload.single('file')(req, res, err => {
  if (err) return bad(res, 400, err.code === 'LIMIT_FILE_SIZE' ? 'Il file è troppo grande (massimo 40 MB).' : 'Caricamento non valido.');
  next();
}), wrap(async (req, res) => {
  if (!req.file) return bad(res, 400, 'Scegli il file .xlsx.');
  const anno = parseInt(req.body.anno, 10) || 2026;
  const p = await importa.prepara(req.file.buffer, await tutteLeSedi(), anno);
  if (!p.righe.length) return bad(res, 400, 'Nel file non ho trovato righe da importare (fogli «Dati Grezzi», colonne A–O).');
  const token = db.newId();
  for (const [k, v] of anteprime) if (Date.now() - v.t > 30 * 60e3) anteprime.delete(k);
  anteprime.set(token, { t: Date.now(), p, anno, file: str(req.file.originalname, 120), uid: req.me.id });
  const { rows: [g] } = await db.q(`select count(*)::int as n from preventivi where origine = 'import'`);
  res.json({ token, anno, righe: p.righe.length, riepilogo: p.riepilogo, scartate: p.scartate, marketingNuovi: p.marketing.length, fogli: p.fogli, giaImportate: g.n });
}));
app.post('/api/liste/importa/conferma', needUser, need('liste'), wrap(async (req, res) => {
  const a = anteprime.get(str(req.body.token, 60));
  if (!a || a.uid !== req.me.id) return bad(res, 400, 'Anteprima scaduta: ricarica il file.');
  const { rows: [g] } = await db.q(`select count(*)::int as n from preventivi where origine = 'import'`);
  if (g.n && !req.body.sostituisci) return bad(res, 409, 'Ci sono già righe importate prima: conferma di sostituirle.');
  const client = await db.pool.connect();
  const impId = db.newId();
  try {
    await client.query('begin');
    if (g.n) {
      // le righe importate prima non si cancellano: vanno in archivio
      await client.query('create table if not exists preventivi_archivio (like preventivi including defaults)');
      await client.query(`alter table preventivi_archivio add column if not exists archiviato_il timestamptz default now()`);
      await client.query(`insert into preventivi_archivio select p.*, now() from preventivi p where origine = 'import'`);
      await client.query(`delete from preventivi where origine = 'import'`);
    }
    const R = a.p.righe, C = ['id', 'sede_id', 'sede_nome', 'data', 'anno', 'mese', 'paziente', 'tipo_ov', 'marketing', 'pdc', 'esito', 'pagato', 'anno_nascita', 'tipo_pdc', 'note', 'commerciale', 'medico', 'origine', 'import_id', 'creato_da', 'aggiornato_da'];
    for (let i = 0; i < R.length; i += 500) {
      const parte = R.slice(i, i + 500), vals = [], ph = [];
      parte.forEach((r, j) => {
        ph.push('(' + C.map((_, k) => '$' + (j * C.length + k + 1)).join(',') + ')');
        vals.push(db.newId(), r.sede_id, r.sede_nome, r.data, r.anno, r.mese, r.paziente, r.tipo_ov, r.marketing, r.pdc, r.esito, r.pagato, r.anno_nascita, r.tipo_pdc, r.note, r.commerciale, r.medico, 'import', impId, req.me.id, req.me.id);
      });
      await client.query(`insert into preventivi (${C.join(',')}) values ${ph.join(',')}`, vals);
    }
    // voci nuove negli elenchi (tipi, marketing, tipi PDC): si aggiungono, niente si toglie
    const nuove = [['tipo_ov', R.map(r => r.tipo_ov)], ['marketing', [...R.map(r => r.marketing), ...a.p.marketing]], ['tipo_pdc', R.map(r => r.tipo_pdc)]];
    // i tipi di piano di cura scritti a mano nel vecchio foglio restano per i filtri, ma nascosti dal modulo
    for (const [t, vs] of nuove) for (const v of new Set(vs.filter(Boolean))) await client.query('insert into liste (tipo, valore, attivo) values ($1,$2,$3) on conflict do nothing', [t, v, t !== 'tipo_pdc']);
    await client.query('insert into importazioni (id, file, righe, riepilogo, fatto_da) values ($1,$2,$3,$4,$5)',
      [impId, a.file, R.length, JSON.stringify({ sedi: a.p.riepilogo, scartate: a.p.scartate, anno: a.anno }), req.me.nome]);
    await client.query('commit');
  } catch (e) { await client.query('rollback').catch(() => {}); throw e; } finally { client.release(); }
  anteprime.delete(str(req.body.token, 60));
  console.log(`CRM: importate ${a.p.righe.length} righe dal foglio (${a.p.riepilogo.length} sedi).`);
  res.json({ ok: true, righe: a.p.righe.length });
}));

/* ---------- pagine ---------- */
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.me) return res.redirect(accessi.loginUrl(`${req.protocol}://${req.get('host')}${req.originalUrl}`));
  if (!Object.keys(req.me.perm).length) return res.redirect(`${accessi.publicUrl()}/?noaccess=crm`);
  res.sendFile(path.join(PUB, 'app.html'));
});
app.use(express.static(PUB, { index: false, maxAge: '1h' }));
app.use((err, req, res, next) => {
  if (err.status && err.status < 500) return bad(res, err.status, err.message);
  console.error('CRM Commerciale:', err.message);
  bad(res, err.status || 500, err.status ? err.message : 'Errore del server. Riprova.');
});

// Una volta sola (novembre 2026): CRM Commerciale a tutti i RAP e RUL attivi, come Commerciale/Operatore con le sedi
// della loro anagrafica (Inserimento, Richiami, Dashboard, Chiedi; Liste no), e una notifica. Chi ha già una micro app non si tocca.
async function attivaCommerciali() {
  if (!(await db.q(`insert into impostazioni (k, v) values ('_attiva_rap_rul_2026_11', 'true') on conflict do nothing`)).rowCount) return;
  const tutte = await tutteLeSedi();
  const { rows: us } = await store.q(`select id, sedi from users where status = 'active' and not owner and figura in ('RAP', 'RUL')`);
  const attivati = [];
  for (const u of us) {
    const enti = tutte.filter(s => Array.isArray(u.sedi) && u.sedi.includes(s.id));
    const { rows: ha } = await store.q(`select app from user_apps where user_id = $1 and app like 'crm%'`, [u.id]);
    let nuovo = false;
    for (const k of ['crm_preventivi', 'crm_richiami', 'crm_dashboard', 'crm_chiedi']) {
      if (ha.some(r => r.app === k)) continue;
      await store.setAppRole(u.id, k, 'user', { livello: 'operatore', ente: enti[0]?.id || null, enteNome: enti[0]?.nome || null, enti });
      nuovo = true;
    }
    if (nuovo) attivati.push(u.id);
  }
  let raggiunti = 0;
  if (attivati.length) {
    try {
      const r = await require('../accessi/lib/notifiche').notifica(attivati, 'crm_richiami', { title: 'Nuovo: CRM Commerciale',
        body: 'Da oggi trovi tra le tue app il CRM Commerciale: inserimento preventivi, richiami dei pazienti, dashboard e domande sui numeri. Il vecchio foglio Google non si usa più, e da oggi non si usa più nemmeno il link dato da Marco a suo tempo.',
        url: 'https://appgestione.it/crm/' });
      raggiunti = r.raggiunti.size;
    } catch (e) { console.warn('CRM: notifica non inviata:', e.message); }
  }
  console.log(`CRM: attivato a ${attivati.length} commerciali (RAP/RUL su ${us.length}); notifica arrivata a ${raggiunti}.`);
}
async function start() { await db.migrate(); attivaCommerciali().catch(async e => {
  console.warn('CRM: attivazione commerciali non riuscita (si riprova al prossimo avvio):', e.message);
  await db.q(`delete from impostazioni where k = '_attiva_rap_rul_2026_11'`).catch(() => {});
}); }
module.exports = { app, start };
