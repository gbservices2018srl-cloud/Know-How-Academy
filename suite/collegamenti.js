// Collegamenti di un cliente della suite (solo nel suo motore): le SUE chiavi Meta (e in futuro AlfaDocs).
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

const chiave = () => { const k = process.env.SUITE_CHIAVI_KEY || ''; if (k.length < 32) throw new Error('chiave dei collegamenti mancante'); return crypto.createHash('sha256').update(k).digest(); };
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
  const { rows: [r] } = await q('select dati, meta_verify from suite.collegamenti where slug = $1', [S.TENANT]);
  let verify = r?.meta_verify;
  if (!verify) { // token di verifica del webhook: si crea una volta e il cliente lo copia nella sua app Meta
    verify = `${S.TENANT}-${crypto.randomBytes(8).toString('base64url')}`;
    await q(`insert into suite.collegamenti (slug, meta_verify) values ($1,$2) on conflict (slug) do update set meta_verify = excluded.meta_verify`, [S.TENANT, verify]);
  }
  let dati = {};
  try { dati = decifra(r?.dati); } catch (e) { console.error('Collegamenti: chiavi non leggibili:', e.message); }
  return { dati, verify };
}
function applica({ dati, verify }) {
  const m = dati.meta || {};
  process.env.META_VERIFY_TOKEN = verify || '';
  process.env.META_APP_SECRET = m.secret || '';
  process.env.META_PAGE_TOKENS = JSON.stringify(m.pagine || {});
  process.env.META_PAGE_TOKEN = '';
}
async function carica() {
  if (!S.TENANT) return;
  try { applica(await leggi()); } catch (e) { console.error('Collegamenti:', e.message); }
}

function monta(app, { wrap, bad }) {
  if (!S.TENANT) return;
  const soloAdmin = (req, res, next) => (req.user?.owner || req.apps?.accessi === 'admin') ? next() : bad(res, 403, 'Solo l’amministratore della tua azienda.');
  const stato = async () => {
    const x = await leggi(), m = x.dati.meta || {};
    return { crm: S.accesa('crm'), meta: { webhook: `https://${S.host('', S.TENANT)}/crm/api/meta/webhook`, verify: x.verify, secret: !!m.secret,
      pagine: Object.keys(m.pagine || {}), pronto: !!(m.secret && Object.keys(m.pagine || {}).length) } };
  };
  app.get('/collegamenti', (req, res) => {
    if (!req.user) return res.redirect('/accedi?next=/collegamenti');
    if (!(req.user.owner || req.apps?.accessi === 'admin')) return res.redirect('/');
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
    await q('update suite.collegamenti set dati = $2, aggiornato_il = now(), da = $3 where slug = $1', [S.TENANT, cifra({ ...x.dati, meta: m }), req.user.email || req.user.id]);
    applica(await leggi());
    console.log('Collegamenti: chiavi Meta aggiornate da', req.user.email || req.user.id);
    res.json({ ok: true, ...(await stato()) });
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
