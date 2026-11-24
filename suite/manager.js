// Motore centrale della suite (gira solo nel servizio di To Smile, con SUITE_ATTIVA=true).
// - elenco clienti (schema «suite»): app comprese, posti utente, stato
// - avvia un motore separato per ogni cliente (stesso codice, processo a parte, aree proprie nel database)
// - inoltra le richieste di rossi.appgestione.it / turni-rossi.appgestione.it al motore di quel cliente
// - accesso da appgestione.it: se l'email è di un cliente, entra e viene portato sul suo indirizzo
// I dati di To Smile non passano mai di qui: To Smile resta nel processo principale, come oggi.
const http = require('http');
const path = require('path');
const crypto = require('crypto');
const { fork } = require('child_process');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const S = require('../lib/suite');

const url = process.env.DATABASE_URL || '';
const pool = new Pool({ connectionString: url, ssl: process.env.PGSSL === 'true' || /\.render\.com/.test(url) ? { rejectUnauthorized: false } : false, max: 3 });
const q = (t, p) => pool.query(t, p);
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const ATTIVA = process.env.SUITE_ATTIVA === 'true' && !S.TENANT;
const PORTA0 = parseInt(process.env.SUITE_PORTA_BASE, 10) || 4100;
// in produzione https; in prova sul computer http con la porta del servizio
const PROD = process.env.NODE_ENV === 'production';
const indirizzo = slug => PROD ? 'https://' + S.host('', slug) : `http://${S.host('', slug)}:${process.env.PORT || 3000}`;

async function migrate() {
  await q('create schema if not exists suite');
  await q(`
    create table if not exists suite.clienti (
      slug text primary key, nome text not null, stato text not null default 'prova',
      apps jsonb not null default '[]', posti int not null default 5,
      admin_email text not null default '', admin_nome text not null default '', admin_password text not null default '',
      referente text not null default '', telefono text not null default '', note text not null default '',
      privacy_ok boolean not null default false, alfadocs boolean not null default false,
      creato_il timestamptz not null default now(), aggiornato_il timestamptz not null default now()
    );
    create table if not exists suite.entrate (codice text primary key, slug text not null, token text not null, scade timestamptz not null);
    alter table suite.clienti add column if not exists logo text not null default '';
  `);
}
const clienti = async () => (await q('select * from suite.clienti order by creato_il')).rows;
const cliente = async slug => (await q('select * from suite.clienti where slug = $1', [slug])).rows[0] || null;

/* ---------- motori dei clienti ---------- */
const motori = new Map(); // slug → { proc, porta, pronto, riavvii }
let prossimaPorta = PORTA0;
function avvia(c) {
  if (motori.get(c.slug)?.proc) return;
  const porta = motori.get(c.slug)?.porta || prossimaPorta++;
  const env = { ...process.env, SUITE_ATTIVA: '', ...S.envCliente(c, porta) };
  const proc = fork(path.join(__dirname, '..', 'index.js'), [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const m = { proc, porta, pronto: false, riavvii: motori.get(c.slug)?.riavvii || 0 };
  motori.set(c.slug, m);
  const log = d => String(d).split('\n').filter(Boolean).forEach(r => {
    if (/attivi sulla porta/.test(r)) m.pronto = true;
    console.log(`[${c.slug}] ${r}`);
  });
  proc.stdout.on('data', log); proc.stderr.on('data', log);
  proc.on('exit', code => {
    m.proc = null; m.pronto = false;
    if (m.fermato) return;
    m.riavvii++;
    const attesa = Math.min(60000, 2000 * m.riavvii);
    console.warn(`Suite: il motore di ${c.slug} si è fermato (${code}); riparte tra ${attesa / 1000} s`);
    setTimeout(async () => { const x = await cliente(c.slug).catch(() => null); if (x && x.stato !== 'sospeso') avvia(x); }, attesa);
  });
  // la password iniziale serve una volta sola: il motore ha creato l'amministratore, la si toglie dal database
  setTimeout(() => { if (c.admin_password) q(`update suite.clienti set admin_password = '' where slug = $1`, [c.slug]).catch(() => {}); }, 120000);
}
function ferma(slug) {
  const m = motori.get(slug); if (!m?.proc) return;
  m.fermato = true; m.proc.kill('SIGTERM');
  setTimeout(() => { m.fermato = false; }, 5000);
}
async function riavvia(slug) {
  ferma(slug);
  const c = await cliente(slug);
  setTimeout(() => { if (c && c.stato !== 'sospeso') { const m = motori.get(slug); if (m) m.fermato = false; avvia(c); } }, 1500);
}

/* ---------- a quale cliente va questa richiesta ---------- */
const RE_HOST = new RegExp(`^(?:(${S.SOTTO.join('|')})-)?([a-z][a-z0-9]{1,29})\\.${S.BASE.replace(/\./g, '\\.')}$`);
let elenco = new Map(), elencoT = 0;
async function slugDaHost(h) {
  const m = RE_HOST.exec(String(h || '').toLowerCase()); if (!m) return null;
  if (Date.now() - elencoT > 30000) { elenco = new Map((await clienti()).map(c => [c.slug, c])); elencoT = Date.now(); }
  return elenco.has(m[2]) ? elenco.get(m[2]) : null;
}
const pagina = (res, code, titolo, testo) => {
  res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(`<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${titolo}</title>
<body style="margin:0;font-family:system-ui,sans-serif;background:#FBFBF8;color:#2B3033;display:grid;place-items:center;min-height:100vh;padding:24px;text-align:center">
<div><h1 style="font-size:22px">${titolo}</h1><p style="color:#6B7276;max-width:440px">${testo}</p><p style="font-size:12px;color:#9aa">powered by To Smile</p></div></body></html>`);
};
// true = la richiesta era di un cliente ed è stata gestita qui
async function inoltra(req, res) {
  if (!ATTIVA) return false;
  const h = String(req.headers.host || '').split(':')[0].toLowerCase();
  if (h === S.BASE || !h.endsWith('.' + S.BASE)) return false;
  const c = await slugDaHost(h).catch(() => null); if (!c) return false;
  if (c.stato === 'sospeso') { pagina(res, 403, 'Accesso sospeso', 'L’accesso a questa suite è sospeso. I dati sono conservati: contatta To Smile per riattivarlo.'); return true; }
  const m = motori.get(c.slug);
  if (!m?.proc || !m.pronto) { if (!m?.proc) avvia(c); pagina(res, 503, 'Un momento…', 'La suite si sta avviando. Ricarica la pagina tra qualche secondo.'); return true; }
  const p = http.request({ host: '127.0.0.1', port: m.porta, method: req.method, path: req.url,
    headers: { ...req.headers, 'x-forwarded-for': req.socket.remoteAddress || '', 'x-forwarded-proto': 'https' } }, r => {
    res.writeHead(r.statusCode, r.headers); r.pipe(res);
  });
  p.on('error', () => { if (!res.headersSent) pagina(res, 502, 'Un momento…', 'La suite non risponde. Riprova tra poco.'); else res.end(); });
  req.pipe(p);
  return true;
}

/* ---------- accesso da appgestione.it per le persone dei clienti ---------- */
// null = l'email non è di nessun cliente (resta l'errore normale di To Smile)
async function accediCliente(email, password, agente) {
  if (!ATTIVA || !email) return null;
  for (const c of await clienti()) {
    let u;
    try { u = (await q(`select id, password_hash, status from ${c.slug}_accessi.users where email = $1`, [email])).rows[0]; } catch { continue; }
    if (!u) continue;
    if (!(u.password_hash && await bcrypt.compare(password, u.password_hash))) return { errore: 401, msg: 'Email o password non corretti.' };
    if (c.stato === 'sospeso') return { errore: 403, msg: 'L’accesso della tua azienda è sospeso. Contatta il tuo amministratore.' };
    if (u.status === 'pending') return { errore: 403, msg: "La tua registrazione è in attesa di approvazione. Riceverai un'email quando l'accesso sarà attivo." };
    if (u.status === 'disabled') return { errore: 403, msg: "Il tuo accesso è stato disattivato. Contatta l'amministratore." };
    const token = crypto.randomBytes(32).toString('base64url'), codice = crypto.randomBytes(24).toString('base64url');
    await q(`insert into ${c.slug}_accessi.sessions (token_hash, user_id, expires_at, agent) values ($1,$2, now() + interval '30 days', $3)`, [sha(token), u.id, String(agente || '').slice(0, 200)]);
    await q(`update ${c.slug}_accessi.users set last_login = now() where id = $1`, [u.id]);
    await q(`delete from suite.entrate where scade < now()`);
    await q(`insert into suite.entrate (codice, slug, token, scade) values ($1,$2,$3, now() + interval '2 minutes')`, [sha(codice), c.slug, token]);
    return { next: `${indirizzo(c.slug)}/_suite/entra?c=${encodeURIComponent(codice)}` };
  }
  return null;
}
// nel motore del cliente: il codice monouso diventa la sessione (il cookie del cliente)
async function ritiraEntrata(codice) {
  if (!S.TENANT || !codice) return null;
  const { rows: [r] } = await q(`delete from suite.entrate where codice = $1 and slug = $2 and scade > now() returning token`, [sha(codice), S.TENANT]);
  return r ? r.token : null;
}

/* ---------- pannello /gestione ---------- */
const prezzo = c => 20 + 32 * (c.apps || []).length + 6 * (c.posti || 0);
async function utentiAttivi(slug) {
  try { return (await q(`select count(*)::int as n from ${slug}_accessi.users where status = 'active'`)).rows[0].n; } catch { return 0; }
}
async function elencoPannello() {
  const L = await clienti();
  return Promise.all(L.map(async c => ({ slug: c.slug, nome: c.nome, stato: c.stato, apps: c.apps, posti: c.posti, attivi: await utentiAttivi(c.slug),
    admin_email: c.admin_email, logo: !!c.logo, referente: c.referente, telefono: c.telefono, note: c.note, privacy_ok: c.privacy_ok, alfadocs: c.alfadocs,
    prezzo: prezzo(c), indirizzo: indirizzo(c.slug), motore: motori.get(c.slug)?.pronto ? 'acceso' : motori.get(c.slug)?.proc ? 'in avvio' : 'spento',
    creato_il: c.creato_il })));
}
const idApps = () => S.CATALOGO.filter(x => !x.esterna).map(x => x.id);
async function creaCliente(b) {
  const slug = String(b.slug || '').toLowerCase().trim();
  if (!S.slugValido(slug)) throw Object.assign(new Error('Indirizzo non valido: solo lettere minuscole e numeri, da 2 a 30, che inizi con una lettera.'), { status: 400 });
  if (await cliente(slug)) throw Object.assign(new Error('Questo indirizzo è già usato da un altro cliente.'), { status: 409 });
  const nome = String(b.nome || '').trim().slice(0, 80); if (nome.length < 2) throw Object.assign(new Error('Scrivi il nome del cliente.'), { status: 400 });
  const email = String(b.admin_email || '').trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw Object.assign(new Error("Scrivi l'email dell'amministratore del cliente."), { status: 400 });
  const apps = (b.apps || []).filter(a => idApps().includes(a));
  const posti = Math.max(1, Math.min(999, parseInt(b.posti, 10) || 5));
  const password = crypto.randomBytes(9).toString('base64url');
  await q(`insert into suite.clienti (slug, nome, stato, apps, posti, admin_email, admin_nome, admin_password, referente, telefono, note)
    values ($1,$2,'prova',$3,$4,$5,$6,$7,$8,$9,$10)`, [slug, nome, JSON.stringify(apps), posti, email, String(b.admin_nome || '').slice(0, 80), password,
    String(b.referente || '').slice(0, 80), String(b.telefono || '').slice(0, 40), String(b.note || '').slice(0, 1000)]);
  elencoT = 0;
  avvia(await cliente(slug));
  return { slug, password, indirizzo: indirizzo(slug) };
}
async function aggiornaCliente(slug, b) {
  const c = await cliente(slug); if (!c) throw Object.assign(new Error('Cliente non trovato.'), { status: 404 });
  const apps = Array.isArray(b.apps) ? b.apps.filter(a => idApps().includes(a)) : c.apps;
  const posti = b.posti != null ? Math.max(1, Math.min(999, parseInt(b.posti, 10) || c.posti)) : c.posti;
  const stato = ['prova', 'attivo', 'sospeso'].includes(b.stato) ? b.stato : c.stato;
  // logo del cliente: immagine PNG, JPG o SVG, al massimo circa 500 KB ('' = toglie il logo)
  if (b.logo !== undefined) {
    const l = String(b.logo || '');
    if (l && (l.length > 700000 || !/^data:image\/(png|jpeg|svg\+xml|webp);base64,[A-Za-z0-9+/=]+$/.test(l))) throw Object.assign(new Error('Logo non valido: immagine PNG, JPG o SVG, al massimo 500 KB.'), { status: 400 });
    await q('update suite.clienti set logo = $2, aggiornato_il = now() where slug = $1', [slug, l]);
  }
  await q(`update suite.clienti set apps = $2, posti = $3, stato = $4, referente = $5, telefono = $6, note = $7, aggiornato_il = now() where slug = $1`,
    [slug, JSON.stringify(apps), posti, stato, b.referente != null ? String(b.referente).slice(0, 80) : c.referente,
      b.telefono != null ? String(b.telefono).slice(0, 40) : c.telefono, b.note != null ? String(b.note).slice(0, 1000) : c.note]);
  elencoT = 0;
  // app o posti cambiati: il motore riparte con le impostazioni nuove (pochi secondi)
  if (stato === 'sospeso') ferma(slug);
  else if (JSON.stringify(apps) !== JSON.stringify(c.apps) || posti !== c.posti || c.stato === 'sospeso') riavvia(slug);
  return { ok: true };
}

async function start() {
  if (!ATTIVA) return;
  await migrate();
  for (const c of await clienti()) if (c.stato !== 'sospeso') avvia(c);
  console.log(`Suite: ${motori.size} clienti avviati`);
  const chiudi = () => { for (const [, m] of motori) if (m.proc) { m.fermato = true; m.proc.kill('SIGTERM'); } };
  process.on('SIGTERM', () => { chiudi(); setTimeout(() => process.exit(0), 300); }); process.on('exit', chiudi);
}
// nel motore del cliente: nome e logo (letti dall'elenco clienti, rinfrescati ogni minuto)
let marchio = null, marchioT = 0;
async function marchioCliente() {
  if (!S.TENANT) return null;
  if (!marchio || Date.now() - marchioT > 60000) {
    const c = await cliente(S.TENANT).catch(() => null);
    marchio = { nome: c?.nome || process.env.SUITE_NOME || '', logo: c?.logo || '' }; marchioT = Date.now();
  }
  return marchio;
}
module.exports = { marchioCliente, ATTIVA, start, inoltra, accediCliente, ritiraEntrata, elencoPannello, creaCliente, aggiornaCliente, catalogo: () => S.CATALOGO, prezzo };
