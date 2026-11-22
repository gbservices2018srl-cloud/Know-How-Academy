// Classifiche e medaglie (appgestione.it/classifiche/): il bottone in «Le mie app» per tutti.
// Ognuno vede la classifica del suo ruolo (RAP/RUL, Medico, REC, ASO), la bacheca della squadra e il regolamento; l'amministrazione vede tutto.
// Le lodi con i festoni partono dalle app dove si lavora (CRM, Produzione di UL, Manutenzione attrezzature); qui si aprono anche le feste delle notifiche.
const path = require('path');
const express = require('express');
const accessi = require('../accessi/server');
const C = require('./lib/core');
const store = accessi.store;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => { res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' }); next(); });
app.use(express.json({ limit: '20kb' }));
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, code, msg) => res.status(code).json({ error: msg });
const CAT = ['comm', 'medici', 'rec', 'aso'];

app.use(wrap(async (req, res, next) => {
  const c = await store.check(accessi.readCookie(req));
  if (c) {
    const u = c.user, admin = !!u.owner || c.apps.accessi === 'admin';
    const mia = C.CATEGORIA_DI[u.figura] || '';
    req.me = { id: u.id, nome: `${u.first_name || ''} ${u.last_name || ''}`.trim(), figura: u.figura || '', admin, mia, categorie: admin ? CAT : mia ? [mia] : [] };
  }
  next();
}));
const needUser = (req, res, next) => !req.me ? bad(res, 401, 'Accesso richiesto') : req.me.categorie.length ? next() : bad(res, 403, 'Le classifiche sono per commerciali, medici, REC e ASO.');
app.use('/api', (req, res, next) => (['GET', 'HEAD'].includes(req.method) || req.is('application/json')) ? next() : bad(res, 415, 'Formato non valido'));

app.get('/api/stato', needUser, (req, res) => {
  const o = C.oggi();
  res.set('Cache-Control', 'no-store');
  res.json({ me: req.me, oggi: o, anno: +o.slice(0, 4), mese: +o.slice(5, 7), regole: C.REGOLE });
});

// una classifica. Ognuno vede i suoi numeri; degli altri: commerciali e REC solo grado e nome, medici e ASO solo posizione e nome. L'amministrazione vede tutto.
app.get('/api/classifica', needUser, wrap(async (req, res) => {
  const cat = String(req.query.cat || ''), o = C.oggi(), adm = req.me.admin;
  if (!req.me.categorie.includes(cat)) return bad(res, 403, 'Questa classifica non è del tuo ruolo.');
  const anno = parseInt(req.query.anno, 10) || +o.slice(0, 4), mese = Math.min(12, Math.max(1, parseInt(req.query.mese, 10) || +o.slice(5, 7)));
  const mia = x => x.id === req.me.id;
  res.set('Cache-Control', 'no-store');
  if (cat === 'comm') {
    const L = await C.commerciali(anno, [mese]), t = C.trimDi(mese), T = await C.commerciali(anno, C.mesiTrim(t).filter(m => anno < +o.slice(0, 4) || m <= +o.slice(5, 7)));
    // tutti i commerciali registrati compaiono con il loro grado, anche senza preventivi nel mese
    const U = await C.utenti(), ids = new Set([...L.map(x => x.id), ...[...U.values()].filter(u => u.attivo && C.CATEGORIA_DI[u.figura] === 'comm').map(u => u.id)]);
    const righe = await Promise.all([...ids].map(async id => {
      const x = L.find(y => y.id === id) || { id, nome: U.get(id)?.nome || '', n: 0, acc: 0, fatt: 0, conc: 0, ticket: 0, pTmv: 0, pConc: 0, punteggio: 0 }, tt = T.find(y => y.id === id);
      const base = { nome: x.nome, grado: (await C.gradoSalvato('comm', id))?.grado ?? 0, io: mia(x) };
      return adm || mia(x) ? { ...base, ...x, id: undefined, sT: C.stelleTicket(x.ticket), sC: C.stelleConc(x.conc), gradoTrim: tt ? C.gradoComm(tt.conc, tt.ticket) : 0, trim: tt ? { conc: tt.conc, ticket: tt.ticket } : null } : base;
    }));
    // amministrazione: classifica sulla % del target di TMV e concretizzazione; i commerciali vedono solo i gradi (dal più alto)
    righe.sort(adm ? (a, b) => (b.punteggio ?? -1) - (a.punteggio ?? -1) || a.nome.localeCompare(b.nome, 'it') : (a, b) => b.grado - a.grado || a.nome.localeCompare(b.nome, 'it'));
    return res.json({ cat, anno, mese, trimestre: t, righe, completo: adm });
  }
  if (cat === 'medici') {
    const L = await C.medici(anno, mese);
    const righe = L.map((x, i) => adm || mia(x) ? { ...x, id: undefined, pos: i + 1, s: C.stelleConc(x.conc), io: mia(x) } : { nome: x.nome, pos: i + 1, inGara: x.inGara });
    const M = (await C.medagliere('medici', anno)).map(r => ({ nome: r.nome, oro: r.oro, argento: r.argento, bronzo: r.bronzo, totale: r.totale, io: r.user_id === req.me.id }));
    return res.json({ cat, anno, mese, righe, medagliere: M, completo: adm });
  }
  if (cat === 'rec') {
    const { lista, senzaFinanza } = await C.rec(anno, mese), L = lista.filter(x => x.perc != null);
    const righe = await Promise.all(lista.map(async x => { const i = L.indexOf(x), sal = await C.gradoSalvato('rec', x.id);
      const base = { nome: x.nome, sedeNome: x.sedeNome, grado: sal?.grado ?? (i >= 0 ? C.gradoRecDa(i, L.length) : 0), io: mia(x) };
      return adm || mia(x) ? { ...base, perc: x.perc, s: x.perc != null ? C.stelleRec(x.perc) : 0, gradoProssimo: i >= 0 ? C.gradoRecDa(i, L.length) : null } : base; }));
    righe.sort((a, b) => b.grado - a.grado || (b.perc ?? -1) - (a.perc ?? -1) || a.nome.localeCompare(b.nome, 'it'));
    return res.json({ cat, anno, mese, righe, senzaFinanza: adm ? senzaFinanza : false, completo: adm });
  }
  const L = await C.aso(anno, mese);
  const righe = L.map((x, i) => adm || mia(x) ? { nome: x.nome, n: x.n, pos: i + 1, io: mia(x) } : { nome: x.nome, pos: i + 1 });
  const M = (await C.medagliere('aso', anno)).map(r => ({ nome: r.nome, oro: r.oro, argento: r.argento, bronzo: r.bronzo, totale: r.totale, io: r.user_id === req.me.id }));
  res.json({ cat, anno, mese, righe, medagliere: M, completo: adm });
}));

// bacheca della squadra: solo riconoscimenti, con gli applausi
app.get('/api/bacheca', needUser, wrap(async (req, res) => {
  // ognuno vede la bacheca del suo ruolo; l'amministrazione tutte
  const { rows } = req.me.admin ? await C.q(`select id, il, categoria, testo, applausi from bacheca order by il desc limit 40`)
    : await C.q(`select id, il, categoria, testo, applausi from bacheca where categoria = any($1) order by il desc limit 40`, [req.me.categorie]);
  res.set('Cache-Control', 'no-store');
  res.json({ righe: rows.map(r => ({ id: r.id, il: r.il, categoria: r.categoria, testo: r.testo, applausi: (r.applausi || []).length, mio: (r.applausi || []).includes(req.me.id) })) });
}));
app.post('/api/bacheca/:id/applausi', needUser, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10); if (!(id > 0)) return bad(res, 400, 'Non valido.');
  const { rows: [r] } = await C.q(`update bacheca set applausi = case when applausi ? $2 then applausi - $2 else applausi || to_jsonb($2::text) end where id = $1 and ($3 or categoria = any($4)) returning applausi`, [id, req.me.id, req.me.admin, req.me.categorie]);
  if (!r) return bad(res, 404, 'Non trovato.');
  res.json({ applausi: r.applausi.length, mio: r.applausi.includes(req.me.id) });
}));
// una festa da aprire (dalla notifica: medico, medaglie, promozioni)
app.get('/api/festa/:id', needUser, wrap(async (req, res) => {
  const { rows: [f] } = await C.q('update feste set aperta_il = coalesce(aperta_il, now()) where id = $1 and user_id = $2 returning dati', [String(req.params.id).slice(0, 60), req.me.id]);
  if (!f) return bad(res, 404, 'Festa non trovata.');
  res.json(f.dati);
}));

const PUB = path.join(__dirname, 'public');
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.me) return res.redirect(accessi.loginUrl(`${req.protocol}://${req.get('host')}${req.originalUrl}`));
  if (!req.me.categorie.length) return res.redirect('/');
  res.sendFile(path.join(PUB, 'app.html'));
});
app.use(express.static(PUB, { index: false, maxAge: '1h' }));
app.use((err, req, res, next) => { console.error('Classifiche:', err.message); bad(res, 500, 'Errore del server. Riprova.'); });

async function start() {
  await C.migrate();
  const giro = () => C.controllaChiusure().catch(e => console.error('Classifiche:', e.message));
  setTimeout(giro, 60e3); setInterval(giro, 30 * 60e3);
}
module.exports = { app, start, core: C };
