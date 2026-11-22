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
const needUser = (req, res, next) => req.me ? next() : bad(res, 401, 'Accesso richiesto');
app.use('/api', (req, res, next) => (['GET', 'HEAD'].includes(req.method) || req.is('application/json')) ? next() : bad(res, 415, 'Formato non valido'));

app.get('/api/stato', needUser, (req, res) => {
  const o = C.oggi();
  res.set('Cache-Control', 'no-store');
  res.json({ me: req.me, oggi: o, anno: +o.slice(0, 4), mese: +o.slice(5, 7), regole: C.REGOLE });
});

// una classifica: comm e medici e aso per mese, rec per anno (fino al mese)
app.get('/api/classifica', needUser, wrap(async (req, res) => {
  const cat = String(req.query.cat || ''), o = C.oggi();
  if (!req.me.categorie.includes(cat)) return bad(res, 403, 'Questa classifica non è del tuo ruolo.');
  const anno = parseInt(req.query.anno, 10) || +o.slice(0, 4), mese = Math.min(12, Math.max(1, parseInt(req.query.mese, 10) || +o.slice(5, 7)));
  res.set('Cache-Control', 'no-store');
  if (cat === 'comm') {
    const L = await C.commerciali(anno, [mese]), t = C.trimDi(mese), T = await C.commerciali(anno, C.mesiTrim(t).filter(m => anno < +o.slice(0, 4) || m <= +o.slice(5, 7)));
    const righe = await Promise.all(L.map(async x => { const tt = T.find(y => y.id === x.id);
      return { ...x, sT: C.stelleTicket(x.ticket), sC: C.stelleConc(x.conc), grado: (await C.gradoSalvato('comm', x.id))?.grado ?? 0, gradoTrim: tt ? C.gradoComm(tt.conc, tt.ticket) : 0,
        trim: tt ? { conc: tt.conc, ticket: tt.ticket } : null, io: x.id === req.me.id }; }));
    const meT = T.find(y => y.id === req.me.id);
    return res.json({ cat, anno, mese, trimestre: t, righe, mio: req.me.mia === 'comm' ? { grado: (await C.gradoSalvato('comm', req.me.id))?.grado ?? 0, trim: meT || null, gradoTrim: meT ? C.gradoComm(meT.conc, meT.ticket) : 0 } : null });
  }
  if (cat === 'medici') {
    const L = await C.medici(anno, mese);
    return res.json({ cat, anno, mese, righe: L.map(x => ({ ...x, s: C.stelleConc(x.conc), io: x.id === req.me.id })), medagliere: await C.medagliere('medici', anno) });
  }
  if (cat === 'rec') {
    const { lista, senzaFinanza } = await C.rec(anno, mese), L = lista.filter(x => x.perc != null);
    const righe = await Promise.all(lista.map(async x => { const i = L.indexOf(x), sal = await C.gradoSalvato('rec', x.id);
      return { ...x, s: x.perc != null ? C.stelleRec(x.perc) : 0, grado: sal?.grado ?? (i >= 0 ? C.gradoRecDa(i, L.length) : 0), gradoProssimo: i >= 0 ? C.gradoRecDa(i, L.length) : null, provvisorio: !sal, io: x.id === req.me.id }; }));
    return res.json({ cat, anno, mese, righe, senzaFinanza });
  }
  const L = await C.aso(anno, mese);
  res.json({ cat, anno, mese, righe: L.map(x => ({ ...x, io: x.id === req.me.id })), medagliere: await C.medagliere('aso', anno) });
}));

// bacheca della squadra: solo riconoscimenti, con gli applausi
app.get('/api/bacheca', needUser, wrap(async (req, res) => {
  const { rows } = await C.q(`select id, il, categoria, testo, applausi from bacheca order by il desc limit 40`);
  res.set('Cache-Control', 'no-store');
  res.json({ righe: rows.map(r => ({ id: r.id, il: r.il, categoria: r.categoria, testo: r.testo, applausi: (r.applausi || []).length, mio: (r.applausi || []).includes(req.me.id) })) });
}));
app.post('/api/bacheca/:id/applausi', needUser, wrap(async (req, res) => {
  const id = parseInt(req.params.id, 10); if (!(id > 0)) return bad(res, 400, 'Non valido.');
  const { rows: [r] } = await C.q(`update bacheca set applausi = case when applausi ? $2 then applausi - $2 else applausi || to_jsonb($2::text) end where id = $1 returning applausi`, [id, req.me.id]);
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
