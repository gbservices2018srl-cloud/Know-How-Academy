// Lucchetto del pannello /gestione: oltre all'accesso da proprietario servono
// una password che conosce solo il titolare e un codice a 6 cifre dall'app sul telefono (2 fattori, TOTP).
// Lo sblocco dura 30 minuti (si rinnova lavorando). Dopo 5 tentativi sbagliati si blocca per 15 minuti.
// Se il titolare perde il telefono o la password: su Render si mette PANNELLO_RESET=true, si reimposta, poi si toglie.
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const QR = require('qrcode');
const { Pool } = require('pg');

const url = process.env.DATABASE_URL || '';
const pool = new Pool({ connectionString: url, ssl: process.env.PGSSL === 'true' || /\.render\.com/.test(url) ? { rejectUnauthorized: false } : false, max: 2 });
const q = (t, p) => pool.query(t, p);
let pronto = null;
const migrate = () => pronto || (pronto = q(`create schema if not exists suite;
  create table if not exists suite.pannello (id int primary key, pw_hash text not null, totp text not null, impostato_il timestamptz not null default now(), da text not null default '')`));

// ---- TOTP (RFC 6238: 30 secondi, 6 cifre, SHA-1, come Google Authenticator) ----
const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
function b32enc(buf) { let bits = '', out = ''; for (const b of buf) bits += b.toString(2).padStart(8, '0'); for (let i = 0; i + 5 <= bits.length; i += 5) out += B32[parseInt(bits.slice(i, i + 5), 2)]; return out; }
function b32dec(s) { let bits = ''; for (const c of s.replace(/=+$/, '').toUpperCase()) { const v = B32.indexOf(c); if (v < 0) continue; bits += v.toString(2).padStart(5, '0'); } const out = []; for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2)); return Buffer.from(out); }
function codiceAl(segreto, passo) {
  const msg = Buffer.alloc(8); msg.writeBigUInt64BE(BigInt(passo));
  const h = crypto.createHmac('sha1', b32dec(segreto)).update(msg).digest();
  const o = h[h.length - 1] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, '0');
}
const usati = new Map(); // un codice vale una volta sola
function totpOk(segreto, codice) {
  codice = String(codice || '').replace(/\s/g, '');
  if (!/^\d{6}$/.test(codice)) return false;
  const ora = Math.floor(Date.now() / 30000);
  for (const d of [-1, 0, 1]) {
    const c = codiceAl(segreto, ora + d);
    if (c.length === codice.length && crypto.timingSafeEqual(Buffer.from(c), Buffer.from(codice))) {
      const k = (ora + d) + ':' + c; if (usati.has(k)) return false;
      usati.set(k, Date.now()); for (const [x, t] of usati) if (Date.now() - t > 120000) usati.delete(x);
      return true;
    }
  }
  return false;
}

// ---- sblocco (cookie firmato, legato alla persona) ----
const COOKIE = 'ag_pannello', DURATA = 30 * 60 * 1000;
const chiave = () => crypto.createHash('sha256').update('pannello:' + (process.env.SSO_API_KEY || process.env.SESSION_SECRET || 'x')).digest();
const firma = s => crypto.createHmac('sha256', chiave()).update(s).digest('hex');
function leggi(req) {
  const m = String(req.headers.cookie || '').match(/(?:^|;\s*)ag_pannello=([^;]+)/); if (!m) return null;
  const [uid, exp, f] = decodeURIComponent(m[1]).split('.');
  if (!uid || !exp || !f || +exp < Date.now()) return null;
  const g = firma(uid + '.' + exp);
  return f.length === g.length && crypto.timingSafeEqual(Buffer.from(f), Buffer.from(g)) ? uid : null;
}
function scrivi(res, uid) {
  const exp = Date.now() + DURATA, v = `${uid}.${exp}.${firma(uid + '.' + exp)}`;
  res.append('Set-Cookie', `${COOKIE}=${encodeURIComponent(v)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${DURATA / 1000}${process.env.NODE_ENV === 'production' ? '; Secure' : ''}`);
}
const togli = res => res.append('Set-Cookie', `${COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`);

// tentativi sbagliati
const errori = new Map();
const bloccato = uid => { const e = errori.get(uid); return e && e.fino > Date.now() ? Math.ceil((e.fino - Date.now()) / 60000) : 0; };
function sbagliato(uid) { const e = errori.get(uid) || { n: 0, fino: 0 }; e.n++; if (e.n >= 5) { e.fino = Date.now() + 15 * 60000; e.n = 0; } errori.set(uid, e); }

async function config() { await migrate(); const { rows: [r] } = await q('select pw_hash, totp from suite.pannello where id = 1'); return process.env.PANNELLO_RESET === 'true' ? null : r || null; }

// segreto proposto durante l'impostazione (in memoria, 10 minuti)
const proposte = new Map();

function monta(app, { wrap, bad }) {
  const soloTitolare = (req, res, next) => req.user?.owner ? next() : bad(res, 403, 'Solo il proprietario della suite.');
  app.get('/api/gestione/lucchetto', soloTitolare, wrap(async (req, res) => {
    res.set('Cache-Control', 'no-store');
    const c = await config();
    res.json({ impostato: !!c, sbloccato: !!c && leggi(req) === req.user.id, attesa: bloccato(req.user.id) });
  }));
  app.post('/api/gestione/lucchetto/nuovo', soloTitolare, wrap(async (req, res) => {
    if (await config()) return bad(res, 409, 'Il lucchetto è già impostato.');
    const segreto = b32enc(crypto.randomBytes(20));
    proposte.set(req.user.id, { segreto, il: Date.now() });
    const uri = `otpauth://totp/${encodeURIComponent('To Smile:Gestione suite')}?secret=${segreto}&issuer=${encodeURIComponent('To Smile')}&digits=6&period=30`;
    res.set('Cache-Control', 'no-store').json({ segreto: segreto.match(/.{1,4}/g).join(' '), qr: await QR.toString(uri, { type: 'svg', margin: 1, width: 200 }) });
  }));
  app.post('/api/gestione/lucchetto/imposta', soloTitolare, wrap(async (req, res) => {
    if (await config()) return bad(res, 409, 'Il lucchetto è già impostato.');
    const p = proposte.get(req.user.id);
    if (!p || Date.now() - p.il > 10 * 60000) return bad(res, 400, 'Tempo scaduto: ricomincia dal codice QR.');
    const pw = String(req.body?.password || '');
    if (pw.length < 10) return bad(res, 400, 'La password deve avere almeno 10 caratteri.');
    if (!totpOk(p.segreto, req.body?.codice)) return bad(res, 400, 'Codice a 6 cifre non valido: controlla l’app sul telefono e riprova.');
    await q(`insert into suite.pannello (id, pw_hash, totp, da) values (1, $1, $2, $3)
      on conflict (id) do update set pw_hash = excluded.pw_hash, totp = excluded.totp, da = excluded.da, impostato_il = now()`,
      [await bcrypt.hash(pw, 12), p.segreto, req.user.email || req.user.id]);
    proposte.delete(req.user.id);
    console.log('Gestione suite: lucchetto impostato da', req.user.email || req.user.id);
    scrivi(res, req.user.id); res.json({ ok: true });
  }));
  app.post('/api/gestione/lucchetto/sblocca', soloTitolare, wrap(async (req, res) => {
    const uid = req.user.id, att = bloccato(uid);
    if (att) return bad(res, 429, `Troppi tentativi sbagliati: riprova tra ${att} minuti.`);
    const c = await config(); if (!c) return bad(res, 409, 'Il lucchetto non è ancora impostato.');
    const okPw = await bcrypt.compare(String(req.body?.password || ''), c.pw_hash);
    const okCod = totpOk(c.totp, req.body?.codice);
    if (!okPw || !okCod) { sbagliato(uid); console.log('Gestione suite: sblocco non riuscito per', req.user.email || uid); return bad(res, 401, 'Password o codice non corretti.'); }
    errori.delete(uid); scrivi(res, uid); res.json({ ok: true });
  }));
  app.post('/api/gestione/lucchetto/chiudi', soloTitolare, (req, res) => { togli(res); res.json({ ok: true }); });
}
// per le API del pannello: serve lo sblocco (e lo rinnova)
async function serveSblocco(req, res, next) {
  try {
    if (!(await config())) return res.status(423).json({ error: 'Imposta prima il lucchetto del pannello.', lucchetto: true });
    if (leggi(req) !== req.user?.id) return res.status(423).json({ error: 'Pannello bloccato: inserisci password e codice.', lucchetto: true });
    scrivi(res, req.user.id); next();
  } catch (e) { next(e); }
}
module.exports = { monta, serveSblocco, _totp: { codiceAl, b32enc } };
