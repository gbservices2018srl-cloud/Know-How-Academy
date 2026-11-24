// Collegamenti di un'azienda (To Smile o un cliente della suite): le SUE chiavi Meta e AlfaDocs (una per sede).
// Le chiavi si salvano cifrate (AES-256-GCM) con una chiave propria di ogni cliente, data dal servizio principale all'avvio:
// un cliente non può leggere quelle di un altro, e To Smile non le usa. Una volta salvate non si rileggono (si sostituiscono).
// Al salvataggio e all'avvio diventano le impostazioni del suo CRM (META_APP_SECRET, META_VERIFY_TOKEN, META_PAGE_TOKENS).
const crypto = require('crypto');
const { Pool } = require('pg');
const S = require('../lib/suite');

const url = process.env.DATABASE_URL || '';
const pool = new Pool({ connectionString: url, ssl: process.env.PGSSL === 'true' || /\.render\.com/.test(url) ? { rejectUnauthorized: false } : false, max: 2 });
const q = (t, p) => pool.query(t, p);
let pronto = null;
const migrate = () => pronto || (pronto = q(`create schema if not exists suite;
  create table if not exists suite.collegamenti (slug text primary key, dati bytea, meta_verify text not null default '', aggiornato_il timestamptz not null default now(), da text not null default '')`));

const SLUG = () => S.TENANT || 'tosmile';
// chiave di cifratura: per un cliente la dà il servizio principale all'avvio; per To Smile si ricava da SSO_API_KEY
const chiave = () => {
  const k = process.env.SUITE_CHIAVI_KEY || (!S.TENANT && process.env.SSO_API_KEY ? crypto.createHmac('sha256', process.env.SSO_API_KEY).update('chiavi:tosmile').digest('hex') : '');
  if (k.length < 32) throw new Error('chiave dei collegamenti mancante'); return crypto.createHash('sha256').update(k).digest();
};
function cifra(obj) {
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', chiave(), iv);
  const dati = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), dati]);
}
function decifra(buf) {
  if (!buf || buf.length < 29) return {};
  const d = crypto.createDecipheriv('aes-256-gcm', chiave(), buf.subarray(0, 12)); d.setAuthTag(buf.subarray(12, 28));
  return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString('utf8'));
}
async function leggi() {
  await migrate();
  const { rows: [r] } = await q('select dati, meta_verify from suite.collegamenti where slug = $1', [SLUG()]);
  let verify = r?.meta_verify;
  if (!verify) { // token di verifica del webhook: si crea una volta e il cliente lo copia nella sua app Meta
    verify = `${SLUG()}-${crypto.randomBytes(8).toString('base64url')}`;
    await q(`insert into suite.collegamenti (slug, meta_verify) values ($1,$2) on conflict (slug) do update set meta_verify = excluded.meta_verify`, [SLUG(), verify]);
  }
  let dati = {};
  try { dati = decifra(r?.dati); } catch (e) { console.error('Collegamenti: chiavi non leggibili:', e.message); }
  return { dati, verify };
}
// le chiavi salvate diventano le impostazioni del CRM (Meta) e di AlfaDocs.
// To Smile: se le chiavi Meta sono già su Render e qui non ce ne sono, restano quelle di Render.
const ENV0 = { META_VERIFY_TOKEN: process.env.META_VERIFY_TOKEN, META_APP_SECRET: process.env.META_APP_SECRET, META_PAGE_TOKENS: process.env.META_PAGE_TOKENS, META_PAGE_TOKEN: process.env.META_PAGE_TOKEN };
function applica({ dati, verify }) {
  const m = dati.meta || {}, usaQui = S.TENANT || m.secret || Object.keys(m.pagine || {}).length;
  if (usaQui) {
    process.env.META_VERIFY_TOKEN = verify || '';
    process.env.META_APP_SECRET = m.secret || '';
    process.env.META_PAGE_TOKENS = JSON.stringify(m.pagine || {});
    process.env.META_PAGE_TOKEN = '';
  } else for (const [k, v] of Object.entries(ENV0)) { if (v == null) delete process.env[k]; else process.env[k] = v; }
  process.env.ALFADOCS_CHIAVI_APP = JSON.stringify(dati.alfadocs || {}); // { "<nome sede>": "<chiave>" }
}
async function carica() {
  try { applica(await leggi()); } catch (e) { console.error('Collegamenti:', e.message); }
}

// To Smile: solo il proprietario; cliente: il titolare o gli amministratori di Gestione accessi
const puo = req => !!req.user && (req.user.owner || (S.TENANT && req.apps?.accessi === 'admin'));
function monta(app, { wrap, bad, sedi }) {
  const soloAdmin = (req, res, next) => puo(req) ? next() : bad(res, 403, S.TENANT ? 'Solo l’amministratore della tua azienda.' : 'Solo il proprietario.');
  const stato = async () => {
    const x = await leggi(), m = x.dati.meta || {}, a = x.dati.alfadocs || {};
    const elenco = (await sedi().catch(() => [])).filter(s => s.attiva !== false).map(s => ({ nome: s.nome, collegata: !!a[s.nome] }));
    for (const n of Object.keys(a)) if (!elenco.some(s => s.nome === n)) elenco.push({ nome: n, collegata: true });
    const daRender = !S.TENANT && !m.secret && !!(ENV0.META_APP_SECRET);
    return { tosmile: !S.TENANT, crm: S.accesa('crm'), alfadocs: { sedi: elenco },
      meta: { webhook: `https://${S.host('', S.TENANT)}/crm/api/meta/webhook`, verify: daRender ? '(quello impostato su Render)' : x.verify, secret: !!m.secret || daRender,
        pagine: Object.keys(m.pagine || {}), pronto: !!(m.secret && Object.keys(m.pagine || {}).length) || daRender, daRender } };
  };
  app.get('/collegamenti', (req, res) => {
    if (!req.user) return res.redirect('/accedi?next=/collegamenti');
    if (!puo(req)) return res.redirect('/');
    res.set('Cache-Control', 'no-store').sendFile(require('path').join(__dirname, 'collegamenti.html'));
  });
  app.get('/api/collegamenti', soloAdmin, wrap(async (req, res) => { res.set('Cache-Control', 'no-store').json(await stato()); }));
  // salva le chiavi Meta: secret (vuoto = resta quella di prima), pagine da aggiungere/sostituire, pagine da togliere
  app.put('/api/collegamenti/meta', soloAdmin, wrap(async (req, res) => {
    const x = await leggi(), m = { secret: '', pagine: {}, ...(x.dati.meta || {}) };
    const b = req.body || {};
    if (b.secret != null && String(b.secret).trim()) {
      const s = String(b.secret).trim(); if (!/^[a-f0-9]{16,64}$/i.test(s)) return bad(res, 400, 'La chiave segreta dell’app (App Secret) è fatta di lettere a-f e numeri: controlla di averla copiata tutta.');
      m.secret = s;
    }
    for (const p of Array.isArray(b.pagine) ? b.pagine : []) {
      const id = String(p.id || '').trim(), tok = String(p.token || '').trim();
      if (!id && !tok) continue;
      if (!/^\d{5,25}$/.test(id)) return bad(res, 400, 'L’ID della pagina Facebook è fatto solo di numeri.');
      if (tok.length < 20) return bad(res, 400, 'Il token della pagina sembra incompleto: copialo tutto.');
      m.pagine[id] = tok;
    }
    for (const id of Array.isArray(b.togli) ? b.togli : []) delete m.pagine[String(id)];
    if (b.scollega === true) { m.secret = ''; m.pagine = {}; }
    await q('update suite.collegamenti set dati = $2, aggiornato_il = now(), da = $3 where slug = $1', [SLUG(), cifra({ ...x.dati, meta: m }), req.user.email || req.user.id]);
    applica(await leggi());
    console.log('Collegamenti: chiavi Meta aggiornate da', req.user.email || req.user.id);
    res.json({ ok: true, ...(await stato()) });
  }));
  // AlfaDocs: una chiave per sede (vuota = resta quella salvata; togli = la toglie)
  app.put('/api/collegamenti/alfadocs', soloAdmin, wrap(async (req, res) => {
    const x = await leggi(), a = { ...(x.dati.alfadocs || {}) }, nomi = (await sedi().catch(() => [])).map(s => s.nome);
    const sede = String(req.body?.sede || '').trim(), k = String(req.body?.chiave || '').trim();
    if (!nomi.includes(sede) && !(sede in a)) return bad(res, 400, 'Sede non valida.');
    if (req.body?.togli === true) delete a[sede];
    else { if (k.length < 16 || /\s/.test(k)) return bad(res, 400, 'La chiave sembra incompleta: copiala tutta da AlfaDocs (Impostazioni → Studio → Chiavi).'); a[sede] = k; }
    await q('update suite.collegamenti set dati = $2, aggiornato_il = now(), da = $3 where slug = $1', [SLUG(), cifra({ ...x.dati, alfadocs: a }), req.user.email || req.user.id]);
    applica(await leggi());
    console.log('Collegamenti: chiave AlfaDocs ' + (req.body?.togli === true ? 'tolta' : 'salvata') + ' per una sede, da', req.user.email || req.user.id);
    res.json({ ok: true, ...(await stato()) });
  }));
  app.post('/api/collegamenti/alfadocs/prova', soloAdmin, wrap(async (req, res) => {
    const sede = String(req.body?.sede || '');
    res.json(await require('../lib/alfadocs').provaBreve(sede));
  }));
  // prova: con ogni chiave di pagina si chiede a Meta il nome della pagina
  app.post('/api/collegamenti/meta/prova', soloAdmin, wrap(async (req, res) => {
    const m = (await leggi()).dati.meta || {}, META = require('../crm/lib/meta');
    const esiti = [];
    for (const [id, tok] of Object.entries(m.pagine || {})) {
      try { const p = await META.graph(`${encodeURIComponent(id)}?fields=name`, tok); esiti.push({ id, ok: true, nome: p.name || '' }); }
      catch (e) { esiti.push({ id, ok: false, errore: String(e.message).slice(0, 200) }); }
    }
    res.json({ esiti, secret: !!m.secret });
  }));
}
module.exports = { monta, carica };
