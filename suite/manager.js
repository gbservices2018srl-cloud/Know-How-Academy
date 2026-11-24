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
    create table if not exists suite.backup_scarichi (slug text not null, il timestamptz not null default now(), da text not null default '');
    alter table suite.clienti add column if not exists scadenza date;
    alter table suite.clienti add column if not exists sospeso_il timestamptz;
    alter table suite.clienti add column if not exists sospeso_auto boolean not null default false;
    alter table suite.clienti add column if not exists finanza_id text;
    alter table suite.clienti add column if not exists accesso_suite boolean not null default false;
    update suite.clienti set accesso_suite = true where not accesso_suite and exists (select 1 from jsonb_array_elements_text(apps) a where a <> 'finanza');
    create table if not exists suite.entrate_finanza (codice text primary key, slug text not null, utente text not null, nome text not null default '', email text not null default '', pagina text not null default '', scade timestamptz not null);
    update suite.clienti set scadenza = (creato_il at time zone 'Europe/Rome')::date + 30 where scadenza is null;
    create table if not exists suite.richieste (id text primary key, tipo text not null, dati jsonb not null default '{}', stato text not null default 'aperta',
      il timestamptz not null default now(), gestita_il timestamptz, nota text not null default '');
  `);
}
const clienti = async () => (await q('select * from suite.clienti order by creato_il')).rows;
const cliente = async slug => (await q('select * from suite.clienti where slug = $1', [slug])).rows[0] || null;

/* ---------- motori dei clienti ---------- */
const motori = new Map(); // slug → { proc, porta, pronto, riavvii }
let prossimaPorta = PORTA0;
// app della suite (che girano nel motore del cliente); Gestione finanziaria è un servizio a parte
const conAppSuite = c => (c.apps || []).some(a => !(S.CATALOGO.find(x => x.id === a) || {}).esterna);
// il motore serve se il cliente entra da appgestione.it; con la sola Gestione finanziaria è una «suite leggera» (accesso + Le mie app)
const haMotore = c => !!c.accesso_suite || conAppSuite(c);
function avvia(c) {
  if (motori.get(c.slug)?.proc || !haMotore(c)) return;
  const porta = motori.get(c.slug)?.porta || prossimaPorta++;
  const env = { ...process.env, SUITE_ATTIVA: '', ...S.envCliente({ ...c, leggera: !conAppSuite(c) }, porta), SUITE_FINANZA_URL: FIN_URL(), BACKUP_TOKEN: require('../lib/esporta').chiaveCliente(c.slug) };
  const proc = fork(path.join(__dirname, '..', 'index.js'), [], { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
  const m = { proc, porta, pronto: false, riavvii: motori.get(c.slug)?.riavvii || 0, avviato: Date.now(), ultimo: Date.now() };
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
  if (c.stato === 'sospeso') { pagina(res, 403, c.sospeso_auto ? 'Abbonamento scaduto' : 'Accesso sospeso', (c.sospeso_auto ? 'L’abbonamento a questa suite è scaduto' : 'L’accesso a questa suite è sospeso') + '. I dati sono conservati: contatta To Smile per riattivarlo.'); return true; }
  if (!haMotore(c)) { res.writeHead(302, { Location: FIN_URL() + '/' }); res.end(); return true; }
  let m = motori.get(c.slug);
  if (!m?.proc || !m.pronto) {
    if (!m?.proc) avvia(c);
    // suite leggera: si accende alla prima richiesta, si aspetta qualche secondo che sia pronta
    for (let i = 0; i < 40 && !(motori.get(c.slug)?.pronto); i++) await new Promise(ok => setTimeout(ok, 500));
    m = motori.get(c.slug);
    if (!m?.proc || !m.pronto) { pagina(res, 503, 'Un momento…', 'La suite si sta avviando. Ricarica la pagina tra qualche secondo.'); return true; }
  }
  m.ultimo = Date.now();
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
    creato_il: c.creato_il, admin_nome: c.admin_nome, scadenza: c.scadenza ? giorno(c.scadenza) : null, giorni: giorniA(c.scadenza),
    sospeso_il: c.sospeso_il, sospeso_auto: c.sospeso_auto, finanza_id: c.finanza_id || null, motoreServe: haMotore(c), leggera: haMotore(c) && !conAppSuite(c), accesso_suite: !!c.accesso_suite })));
}
const idApps = () => S.CATALOGO.filter(x => !x.esterna || x.vendibile).map(x => x.id);
/* ---------- Gestione finanziaria (servizio a parte): le aziende si comandano da qui ---------- */
const FIN_URL = () => (process.env.FINANZA_URL || 'https://finanza.appgestione.it').replace(/\/$/, '');
async function fin(metodo, percorso, corpo, attesa = 20000) {
  let r;
  try {
    r = await fetch(FIN_URL() + percorso, { method: metodo, headers: { Authorization: 'Bearer ' + (process.env.SSO_API_KEY || ''), ...(corpo ? { 'Content-Type': 'application/json' } : {}) },
      body: corpo ? JSON.stringify(corpo) : undefined, signal: AbortSignal.timeout(attesa) });
  } catch { throw Object.assign(new Error('Gestione finanziaria non risponde: riprova tra poco.'), { status: 502 }); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw Object.assign(new Error(j.error || 'Errore di Gestione finanziaria.'), { status: r.status >= 500 ? 502 : 400 });
  return j;
}
const finScade = d => d ? String(d).slice(0, 10) + 'T23:59:59' : null;
async function creaCliente(b) {
  const slug = String(b.slug || '').toLowerCase().trim();
  if (!S.slugValido(slug)) throw Object.assign(new Error('Indirizzo non valido: solo lettere minuscole e numeri, da 2 a 30, che inizi con una lettera.'), { status: 400 });
  if (await cliente(slug)) throw Object.assign(new Error('Questo indirizzo è già usato da un altro cliente.'), { status: 409 });
  const nome = String(b.nome || '').trim().slice(0, 80); if (nome.length < 2) throw Object.assign(new Error('Scrivi il nome del cliente.'), { status: 400 });
  const email = String(b.admin_email || '').trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw Object.assign(new Error("Scrivi l'email dell'amministratore del cliente."), { status: 400 });
  const apps = (b.apps || []).filter(a => idApps().includes(a));
  const posti = Math.max(1, Math.min(999, parseInt(b.posti, 10) || 5));
  const password = crypto.randomBytes(9).toString('base64url');
  let finanza = null;
  if (apps.includes('finanza')) {
    const scad = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
    finanza = await fin('POST', '/api/_suite/aziende', { name: nome, email, phone: String(b.telefono || ''), expires_at: finScade(scad) });
  }
  await q(`insert into suite.clienti (slug, nome, stato, apps, posti, admin_email, admin_nome, admin_password, referente, telefono, note, scadenza)
    values ($1,$2,'prova',$3,$4,$5,$6,$7,$8,$9,$10, (now() at time zone 'Europe/Rome')::date + 30)`, [slug, nome, JSON.stringify(apps), posti, email, String(b.admin_nome || '').slice(0, 80), password,
    String(b.referente || '').slice(0, 80), String(b.telefono || '').slice(0, 40), String(b.note || '').slice(0, 1000)]);
  await q('update suite.clienti set accesso_suite = true, finanza_id = $2 where slug = $1', [slug, finanza ? finanza.id : null]);
  elencoT = 0;
  const c = await cliente(slug);
  avvia(c);
  return { slug, password: haMotore(c) ? password : null, indirizzo: indirizzo(slug), finanza: finanza ? { nome: finanza.name, password: finanza.password } : null };
}
async function aggiornaCliente(slug, b) {
  const c = await cliente(slug); if (!c) throw Object.assign(new Error('Cliente non trovato.'), { status: 404 });
  const apps = Array.isArray(b.apps) ? b.apps.filter(a => idApps().includes(a)) : c.apps;
  const posti = b.posti != null ? Math.max(1, Math.min(999, parseInt(b.posti, 10) || c.posti)) : c.posti;
  const stato = ['prova', 'attivo', 'sospeso'].includes(b.stato) ? b.stato : c.stato;
  if (c.stato === 'sospeso' && stato !== 'sospeso' && c.scadenza && giorniA(c.scadenza) < 0) throw Object.assign(new Error('L’abbonamento è scaduto: prima rinnova (o scegli una nuova data di scadenza).'), { status: 400 });
  // logo del cliente: immagine PNG, JPG o SVG, al massimo circa 500 KB ('' = toglie il logo)
  if (b.logo !== undefined) {
    const l = String(b.logo || '');
    if (l && (l.length > 700000 || !/^data:image\/(png|jpeg|svg\+xml|webp);base64,[A-Za-z0-9+/=]+$/.test(l))) throw Object.assign(new Error('Logo non valido: immagine PNG, JPG o SVG, al massimo 500 KB.'), { status: 400 });
    await q('update suite.clienti set logo = $2, aggiornato_il = now() where slug = $1', [slug, l]);
  }
  await q(`update suite.clienti set apps = $2, posti = $3, stato = $4, referente = $5, telefono = $6, note = $7, aggiornato_il = now() where slug = $1`,
    [slug, JSON.stringify(apps), posti, stato, b.referente != null ? String(b.referente).slice(0, 80) : c.referente,
      b.telefono != null ? String(b.telefono).slice(0, 40) : c.telefono, b.note != null ? String(b.note).slice(0, 1000) : c.note]);
  if (stato !== c.stato) await q(`update suite.clienti set sospeso_il = $2, sospeso_auto = false where slug = $1`, [slug, stato === 'sospeso' ? new Date() : null]);
  elencoT = 0;
  // Gestione finanziaria: se l'app entra si crea l'azienda (se manca); se esce o il cliente è sospeso, l'azienda si sospende (i dati restano)
  let finanza = null;
  const cc = await cliente(slug);
  if (apps.includes('finanza') && !cc.finanza_id) {
    const f = await fin('POST', '/api/_suite/aziende', { name: cc.nome, email: cc.admin_email, phone: cc.telefono, expires_at: finScade(cc.scadenza ? giorno(cc.scadenza) : null) });
    await q('update suite.clienti set finanza_id = $2 where slug = $1', [slug, f.id]);
    finanza = { nome: f.name, password: f.password };
  } else if (cc.finanza_id) {
    await fin('PATCH', '/api/_suite/aziende/' + encodeURIComponent(cc.finanza_id), { suspended: stato === 'sospeso' || !apps.includes('finanza') });
  }
  if (!haMotore(cc)) { ferma(slug); return { ok: true, finanza }; }
  // app o posti cambiati: il motore riparte con le impostazioni nuove (pochi secondi)
  if (stato === 'sospeso') ferma(slug);
  else if (JSON.stringify(apps) !== JSON.stringify(c.apps) || posti !== c.posti || c.stato === 'sospeso' || !motori.get(slug)?.proc) riavvia(slug);
  return { ok: true, finanza };
}


/* ---------- abbonamento, utenti, richieste (pannello /gestione) ---------- */
const errore = (msg, status = 400) => Object.assign(new Error(msg), { status });
const oggi = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
const giorno = d => typeof d === 'string' ? d.slice(0, 10) : new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(d);
const giorniA = d => d ? Math.round((Date.parse(giorno(d)) - Date.parse(oggi())) / 86400000) : null;
async function serve(slug) { const c = await cliente(slug); if (!c) throw errore('Cliente non trovato.', 404); return c; }
// rinnovo: da oggi o dalla scadenza (la più lontana) per 1 mese / 1 anno, oppure una data scelta; se era sospeso per scadenza, riparte
async function rinnova(slug, b) {
  const c = await serve(slug);
  let nuova;
  if (b.data) { if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.data))) throw errore('Data non valida.'); nuova = String(b.data); }
  else {
    const mesi = b.mesi === 12 ? 12 : 1;
    const base = new Date(Math.max(Date.parse(oggi()), c.scadenza ? Date.parse(giorno(c.scadenza)) : 0));
    base.setUTCMonth(base.getUTCMonth() + mesi); nuova = base.toISOString().slice(0, 10);
  }
  const riattiva = c.stato === 'sospeso' && c.sospeso_auto && nuova >= oggi();
  await q(`update suite.clienti set scadenza = $2, ${riattiva ? `stato = 'attivo', sospeso_il = null, sospeso_auto = false,` : ''} aggiornato_il = now() where slug = $1`, [slug, nuova]);
  elencoT = 0; marchio = null;
  if (c.finanza_id) await fin('PATCH', '/api/_suite/aziende/' + encodeURIComponent(c.finanza_id), { expires_at: finScade(nuova), ...(riattiva ? { suspended: !(c.apps || []).includes('finanza') } : {}) });
  if (riattiva) riavvia(slug);
  return { ok: true, scadenza: nuova, riattivato: riattiva };
}
// ogni ora: chi ha passato la scadenza viene sospeso (i dati restano)
async function controllaScadenze() {
  const { rows } = await q(`update suite.clienti set stato = 'sospeso', sospeso_il = now(), sospeso_auto = true, aggiornato_il = now()
    where stato <> 'sospeso' and scadenza is not null and scadenza < (now() at time zone 'Europe/Rome')::date returning slug`);
  for (const r of rows) {
    console.log('Suite: abbonamento scaduto, sospeso', r.slug); ferma(r.slug);
    const c = await cliente(r.slug);
    if (c?.finanza_id) await fin('PATCH', '/api/_suite/aziende/' + encodeURIComponent(c.finanza_id), { suspended: true }).catch(e => console.error('Suite scadenze (finanza):', e.message));
  }
  if (rows.length) elencoT = 0;
}
async function aggiornaDati(slug, b) {
  const c = await serve(slug);
  if (b.nome != null) { const n = String(b.nome).trim().slice(0, 80); if (n.length < 2) throw errore('Scrivi il nome del cliente.'); await q('update suite.clienti set nome = $2, aggiornato_il = now() where slug = $1', [slug, n]); marchio = null;
    if (c.finanza_id) await fin('PATCH', '/api/_suite/aziende/' + encodeURIComponent(c.finanza_id), { name: n }); }
  if (b.admin_email != null) {
    const e = String(b.admin_email).trim().toLowerCase(); if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw errore('Email non valida.');
    const altro = haMotore(c) && (await q(`select 1 from ${slug}_accessi.users where email = $1 and not owner`, [e]).catch(() => ({ rows: [] }))).rows[0];
    if (altro) throw errore('Questa email è già di un altro utente del cliente.', 409);
    if (haMotore(c)) await q(`update ${slug}_accessi.users set email = $1 where owner`, [e]);
    if (c.finanza_id) await fin('PATCH', '/api/_suite/aziende/' + encodeURIComponent(c.finanza_id), { email: e });
    await q('update suite.clienti set admin_email = $2, aggiornato_il = now() where slug = $1', [slug, e]);
  }
  elencoT = 0;
  return { ok: true, nome: c.nome };
}
const pwNuova = () => crypto.randomBytes(9).toString('base64url');
async function utenti(slug) {
  const c0 = await serve(slug); if (!haMotore(c0)) return [];
  const { rows } = await q(`select id, first_name, last_name, email, status, owner, last_login from ${slug}_accessi.users order by owner desc, status, last_name, first_name`).catch(() => ({ rows: [] }));
  return rows.map(u => ({ id: u.id, nome: `${u.first_name} ${u.last_name}`.trim(), email: u.email, stato: u.status, admin: u.owner, ultimo: u.last_login }));
}
// nuova password per un utente del cliente (o per l'amministratore): si vede una volta sola; le sue sessioni aperte si chiudono
async function nuovaPassword(slug, uid, scelta) {
  const c0 = await serve(slug); if (!haMotore(c0)) throw errore('Questo cliente ha solo Gestione finanziaria: usa «Nuova password Gestione finanziaria».');
  const { rows: [u] } = await q(`select id, email from ${slug}_accessi.users where ${uid ? 'id = $1' : 'owner'} limit 1`, uid ? [uid] : []);
  if (!u) throw errore('Utente non trovato.', 404);
  const pw = String(scelta || '').trim() || pwNuova();
  if (pw.length < 8) throw errore('La password deve avere almeno 8 caratteri.');
  await q(`update ${slug}_accessi.users set password_hash = $2 where id = $1`, [u.id, await bcrypt.hash(pw, 12)]);
  await q(`delete from ${slug}_accessi.sessions where user_id = $1`, [u.id]);
  console.log(`Suite: nuova password generata per un utente di ${slug}`);
  return { email: u.email, password: pw };
}
// richieste: iscrizioni dal modulo pubblico
async function nuovaRichiesta(tipo, dati) {
  await migrate();
  const id = crypto.randomBytes(9).toString('hex');
  await q('insert into suite.richieste (id, tipo, dati) values ($1,$2,$3)', [id, tipo, JSON.stringify(dati)]);
  return id;
}
async function richieste() {
  const { rows } = await q(`select id, tipo, dati, il from suite.richieste where stato = 'aperta' order by il`);
  const scad = (await clienti()).filter(c => c.stato !== 'sospeso' && giorniA(c.scadenza) !== null && giorniA(c.scadenza) <= 15)
    .map(c => ({ id: 'scad-' + c.slug, tipo: 'scadenza', dati: { slug: c.slug, nome: c.nome, scadenza: giorno(c.scadenza), giorni: giorniA(c.scadenza) } }));
  let pw = [];
  try {
    const L = await clienti(), per = new Map(L.filter(c => c.finanza_id).map(c => [c.finanza_id, c]));
    pw = (await fin('GET', '/api/_suite/richieste-password', null, 5000)).richieste.map(r => ({ id: 'finpw-' + r.id, tipo: 'password_finanza',
      dati: { rid: r.id, azienda: r.company_name, quando: r.requested_at, slug: per.get(r.company_id)?.slug || null, company_id: r.company_id } }));
  } catch {}
  return [...rows, ...scad, ...pw];
}
async function decidi(id, approva) {
  const { rows: [r] } = await q(`select * from suite.richieste where id = $1 and stato = 'aperta'`, [id]);
  if (!r) throw errore('Richiesta non trovata o già gestita.', 404);
  let esito = { ok: true };
  if (approva && r.tipo === 'iscrizione') esito = await creaCliente(r.dati);
  await q(`update suite.richieste set stato = $2, gestita_il = now() where id = $1`, [id, approva ? 'approvata' : 'rifiutata']);
  return esito;
}

// Gestione finanziaria dal pannello: nuova password dell'azienda, aziende da portare nella suite, storico, persone del gruppo
async function nuovaPasswordFinanza(slug, scelta) {
  const c = await serve(slug); if (!c.finanza_id) throw errore('Questo cliente non ha Gestione finanziaria.');
  const r = await fin('PATCH', '/api/_suite/aziende/' + encodeURIComponent(c.finanza_id), { nuova_password: true, password: scelta || '' });
  console.log(`Suite: nuova password di Gestione finanziaria per ${slug}`);
  return { nome: c.nome, password: r.password };
}
async function aziendeFinanza() {
  const { aziende } = await fin('GET', '/api/_suite/aziende');
  const legate = new Map((await clienti()).filter(c => c.finanza_id).map(c => [c.finanza_id, c.slug]));
  return aziende.map(a => ({ id: a.id, nome: a.name, email: a.email, telefono: a.phone, creata: a.created_at, sospesa: a.suspended, scadenza: a.expires_at ? String(a.expires_at).slice(0, 10) : null,
    piano: a.plan, approvata: a.approved, gruppo: a.gruppo, cliente: legate.get(a.id) || null }));
}
// un'azienda esterna di Gestione finanziaria diventa cliente della suite (con la sola app Gestione finanziaria): i suoi dati restano dove sono
async function portaNellaSuite(cid, b) {
  const slug = String(b.slug || '').toLowerCase().trim();
  if (!S.slugValido(slug)) throw errore('Indirizzo non valido: solo lettere minuscole e numeri, da 2 a 30, che inizi con una lettera.');
  if (await cliente(slug)) throw errore('Questo indirizzo è già usato da un altro cliente.', 409);
  const a = (await aziendeFinanza()).find(x => x.id === cid); if (!a) throw errore('Azienda non trovata in Gestione finanziaria.', 404);
  if (a.cliente) throw errore('Questa azienda è già nella suite.', 409);
  const scad = /^\d{4}-\d{2}-\d{2}$/.test(String(b.scadenza || '')) ? String(b.scadenza) : (a.scadenza && a.scadenza >= oggi() ? a.scadenza : new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10));
  await q(`insert into suite.clienti (slug, nome, stato, apps, posti, admin_email, admin_nome, referente, telefono, note, scadenza, finanza_id)
    values ($1,$2,$3,'["finanza"]',1,$4,'',$5,$6,$7,$8,$9)`, [slug, a.nome, a.sospesa ? 'sospeso' : 'attivo', String(a.email || '').toLowerCase(), '', String(a.telefono || ''),
    'Portata nella suite da Gestione finanziaria il ' + oggi().split('-').reverse().join('/'), scad, cid]);
  if (a.sospesa) await q('update suite.clienti set sospeso_il = now() where slug = $1', [slug]);
  await fin('PATCH', '/api/_suite/aziende/' + encodeURIComponent(cid), { expires_at: finScade(scad), plan: 'pro', approva: true });
  elencoT = 0;
  console.log(`Suite: azienda di Gestione finanziaria portata nella suite come ${slug}`);
  return { ok: true, slug };
}
const versioniFinanza = cid => fin('GET', `/api/_suite/aziende/${encodeURIComponent(cid)}/versioni`);
const ripristinaFinanza = (cid, vid) => fin('POST', `/api/_suite/aziende/${encodeURIComponent(cid)}/versioni/${parseInt(vid, 10)}/ripristina`);
async function scaricaVersioneFinanza(cid, vid, res) {
  const r = await fetch(`${FIN_URL()}/api/_suite/aziende/${encodeURIComponent(cid)}/versioni/${parseInt(vid, 10)}`, { headers: { Authorization: 'Bearer ' + (process.env.SSO_API_KEY || '') }, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw errore('Versione non trovata.', 404);
  res.set({ 'Content-Type': 'application/json', 'Content-Disposition': r.headers.get('content-disposition') || 'attachment; filename="versione.json"', 'Cache-Control': 'no-store' });
  res.send(Buffer.from(await r.arrayBuffer()));
}
const personeFinanza = () => fin('GET', '/api/_suite/persone');
const assegnaFinanza = (uid, aziende) => fin('PUT', '/api/_suite/persone/' + encodeURIComponent(uid), { aziende });
const passwordGestita = rid => fin('POST', '/api/_suite/richieste-password/' + encodeURIComponent(rid));

// cliente portato da Gestione finanziaria: da ora entra anche da appgestione.it (si crea il suo amministratore)
async function attivaAccesso(slug) {
  const c = await serve(slug);
  if (c.accesso_suite) throw errore('L’accesso da appgestione.it è già attivo.', 409);
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(c.admin_email || '')) throw errore('Prima scrivi l’email dell’amministratore del cliente (Cambia email).');
  const password = crypto.randomBytes(9).toString('base64url');
  await q('update suite.clienti set accesso_suite = true, admin_password = $2, aggiornato_il = now() where slug = $1', [slug, password]);
  elencoT = 0;
  if (c.stato !== 'sospeso') riavvia(slug);
  console.log(`Suite: accesso da appgestione.it attivato per ${slug}`);
  return { ok: true, email: c.admin_email, password, indirizzo: indirizzo(slug) };
}
// passaggio senza seconda password: il motore del cliente crea un codice monouso, Gestione finanziaria lo ritira qui
async function ticketFinanza(slug, u, pagina) {
  const codice = crypto.randomBytes(24).toString('base64url');
  await q(`delete from suite.entrate_finanza where scade < now()`);
  await q(`insert into suite.entrate_finanza (codice, slug, utente, nome, email, pagina, scade) values ($1,$2,$3,$4,$5,$6, now() + interval '2 minutes')`,
    [sha(codice), slug, u.id, `${u.first_name || ''} ${u.last_name || ''}`.trim(), u.email || '', pagina === 'bilancio' ? 'bilancio' : '']);
  return codice;
}
async function ritiraTicketFinanza(codice) {
  const { rows: [t] } = await q(`delete from suite.entrate_finanza where codice = $1 and scade > now() returning *`, [sha(String(codice || ''))]);
  if (!t) return null;
  const c = await cliente(t.slug);
  if (!c || c.stato === 'sospeso' || !c.finanza_id || !(c.apps || []).includes('finanza')) return null;
  return { company_id: c.finanza_id, home: indirizzo(c.slug) + '/', utente: { id: t.utente, nome: t.nome, email: t.email }, pagina: t.pagina, cliente: c.slug };
}

async function start() {
  if (!ATTIVA) return;
  await migrate();
  await controllaScadenze().catch(e => console.error('Suite scadenze:', e.message));
  setInterval(() => controllaScadenze().catch(e => console.error('Suite scadenze:', e.message)), 3600000);
  // le suite leggere (sola Gestione finanziaria) non si accendono all'avvio: si accendono quando il cliente entra
  for (const c of await clienti()) if (c.stato !== 'sospeso' && conAppSuite(c)) avvia(c);
  console.log(`Suite: ${motori.size} clienti avviati`);
  // ogni 5 minuti: le suite leggere non usate da 20 minuti si spengono (memoria libera); i dati restano
  setInterval(async () => {
    for (const [slug, m] of motori) {
      if (!m.proc || Date.now() - (m.ultimo || m.avviato || 0) < 20 * 60000) continue;
      const c = await cliente(slug).catch(() => null);
      if (c && !conAppSuite(c)) { console.log(`Suite: suite leggera di ${slug} spenta (non usata da 20 minuti)`); ferma(slug); }
    }
  }, 5 * 60000).unref();
  const chiudi = () => { for (const [, m] of motori) if (m.proc) { m.fermato = true; m.proc.kill('SIGTERM'); } };
  process.on('SIGTERM', () => { chiudi(); setTimeout(() => process.exit(0), 300); }); process.on('exit', chiudi);
}
// nel motore del cliente: nome e logo (letti dall'elenco clienti, rinfrescati ogni minuto)
let marchio = null, marchioT = 0;
async function marchioCliente() {
  if (!S.TENANT) return null;
  if (!marchio || Date.now() - marchioT > 60000) {
    const c = await cliente(S.TENANT).catch(() => null);
    marchio = { nome: c?.nome || process.env.SUITE_NOME || '', logo: c?.logo || '', scadenza: c?.scadenza ? giorno(c.scadenza) : null, giorni: giorniA(c?.scadenza) }; marchioT = Date.now();
  }
  return marchio;
}
module.exports = { attivaAccesso, ticketFinanza, ritiraTicketFinanza, nuovaPasswordFinanza, aziendeFinanza, portaNellaSuite, versioniFinanza, ripristinaFinanza, scaricaVersioneFinanza, personeFinanza, assegnaFinanza, passwordGestita, FIN_URL,
  rinnova, aggiornaDati, utenti, nuovaPassword, nuovaRichiesta, richieste, decidi, slugLibero: async s => S.slugValido(s) && !(await cliente(s)),
  marchioCliente, ATTIVA, start, inoltra, accediCliente, ritiraEntrata, elencoPannello, creaCliente, aggiornaCliente, catalogo: () => S.CATALOGO, prezzo };
