// Accesso unico: utenti, permessi per app, sessioni e link per la password.
// Dati nello schema "accessi" del database del gruppo.
const { Pool, types } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const { EventEmitter } = require('events');
const APPS = require('../apps');
const FIGURE = require('../figure');

types.setTypeParser(1082, v => v); // date come testo AAAA-MM-GG

const url = process.env.DATABASE_URL || '';
const useSsl = process.env.PGSSL === 'true' || /\.render\.com/.test(url);
const SCHEMA = (process.env.ACCESSI_DB_SCHEMA || 'accessi').replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'accessi';
const pool = new Pool({
  connectionString: url,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  options: `-c search_path=${SCHEMA},public`,
});
const q = (text, params) => pool.query(text, params);
const events = new EventEmitter(); // 'deleted' (userId): le app collegate possono ripulire i loro profili

const APP_KEYS = APPS.map(a => a.key);
const SESSION_DAYS = 30;
const sha = s => crypto.createHash('sha256').update(String(s)).digest('hex');
const randomToken = () => crypto.randomBytes(32).toString('base64url');
const ownerEmail = () => (process.env.ADMIN_USERNAME || '').trim().toLowerCase();

async function migrate() {
  await q(`create schema if not exists ${SCHEMA}`);
  await q(`
    create table if not exists users (
      id text primary key,
      first_name text not null default '',
      last_name text not null default '',
      birth_date date,
      email text unique not null,
      password_hash text,
      status text not null default 'pending' check (status in ('pending','active','disabled')),
      owner boolean not null default false,
      created_at timestamptz not null default now(),
      created_by text,
      approved_at timestamptz,
      last_login timestamptz
    );
    create table if not exists user_apps (
      user_id text not null references users(id) on delete cascade,
      app text not null,
      role text not null check (role in ('user','admin')),
      primary key (user_id, app)
    );
    create table if not exists sessions (
      token_hash text primary key,
      user_id text not null references users(id) on delete cascade,
      created_at timestamptz not null default now(),
      last_seen timestamptz not null default now(),
      expires_at timestamptz not null,
      agent text not null default ''
    );
    create index if not exists sessions_user_idx on sessions(user_id);
    create table if not exists sso_tickets (
      token_hash text primary key,
      user_id text,
      email text not null,
      app text not null,
      purpose text not null check (purpose in ('login','revoke')),
      data jsonb not null default '{}',
      expires_at timestamptz not null,
      used_at timestamptz
    );
    create table if not exists password_links (
      token_hash text primary key,
      user_id text not null references users(id) on delete cascade,
      purpose text not null default 'reset',
      expires_at timestamptz not null,
      used_at timestamptz
    );
  `);
  await q(`delete from sessions where expires_at < now()`);
  await q(`delete from password_links where expires_at < now() - interval '7 days'`);
  await q(`delete from sso_tickets where expires_at < now() - interval '1 day'`);
  // livello dentro l'app (Nuovalab, Ticket): ruolo e laboratorio/studio/medico/azienda scelti dal pannello accessi
  // email confermata: chi si registra conferma con un link; gli account già esistenti o creati dall'amministratore valgono come confermati
  await q(`alter table users add column if not exists email_verificata boolean;
    update users set email_verificata = true where email_verificata is null;
    alter table users alter column email_verificata set default false;`);
  await q(`alter table users add column if not exists figura text;
    alter table users add column if not exists cf text;
    alter table users add column if not exists albo_provincia text;
    alter table users add column if not exists albo_numero text;
    alter table user_apps add column if not exists livello text;
    alter table user_apps add column if not exists ente text;
    alter table user_apps add column if not exists ente_nome text;
    alter table user_apps add column if not exists enti jsonb; -- più studi: [{ id, nome }], il primo è anche in "ente"
    alter table sso_tickets drop constraint if exists sso_tickets_purpose_check;
    alter table sso_tickets add constraint sso_tickets_purpose_check check (purpose in ('login','revoke','catalog','sync','sedi'));`);
  // Sedi del gruppo: si gestiscono qui e vengono copiate in Turni, Calendario, Ticket e Nuovalab
  await q(`create table if not exists sedi (
      id text primary key,
      nome text not null,
      sigla text not null,
      indirizzo text not null default '',
      societa text not null default '',
      email text not null default '',
      riuniti int not null default 0,
      attiva boolean not null default true,
      sort int not null default 0,
      creata_il timestamptz not null default now()
    );
    create unique index if not exists sedi_sigla_idx on sedi (upper(sigla));`);
  // Turni: la figura scelta prima nel permesso diventa la figura della persona
  await q(`update users u set figura = ua.ente from user_apps ua
    where ua.user_id = u.id and ua.app = 'turni' and u.figura is null and ua.ente = any($1)`, [FIGURE.map(f => f.id)]);
  await q(`update user_apps set livello = case when ente = 'nessuna' and livello = 'admin' then 'admin_no' else livello end,
    ente = null, ente_nome = null where app = 'turni' and ente is not null`);
}

// Il proprietario (ADMIN_USERNAME / ADMIN_PASSWORD su Render) è sempre attivo e amministratore di tutto.
async function ensureOwner() {
  const email = ownerEmail(), password = process.env.ADMIN_PASSWORD || '';
  if (!email || !password) { console.warn('Accesso unico: imposta ADMIN_USERNAME (email) e ADMIN_PASSWORD su Render.'); return; }
  let { rows } = await q('select * from users where email = $1', [email]);
  if (!rows.length) {
    const prev = await q('select * from users where owner order by created_at limit 1');
    if (prev.rows.length) { // email cambiata su Render: aggiorna il proprietario invece di crearne un secondo
      await q('update users set email = $2 where id = $1', [prev.rows[0].id, email]);
      rows = [{ ...prev.rows[0], email }];
    }
  }
  if (!rows.length) {
    const [first, ...rest] = String(process.env.ADMIN_NAME || 'Amministratore').trim().split(/\s+/);
    await q(`insert into users (id, first_name, last_name, email, password_hash, status, owner, approved_at)
             values ($1,$2,$3,$4,$5,'active',true,now())`,
      [crypto.randomUUID(), first, rest.join(' '), email, await bcrypt.hash(password, 12)]);
    console.log(`Accesso unico: amministratore "${email}" creato.`);
    return;
  }
  const u = rows[0];
  const same = u.password_hash && await bcrypt.compare(password, u.password_hash);
  await q(`update users set owner = true, status = 'active', password_hash = $2 where id = $1`,
    [u.id, same ? u.password_hash : await bcrypt.hash(password, 12)]);
  await q('update users set owner = false where owner and id <> $1', [u.id]);
}

/* ---------- utenti ---------- */
const cleanEmail = s => String(s || '').trim().toLowerCase().slice(0, 160);
const validEmail = s => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(s);
const cleanName = s => String(s || '').trim().replace(/\s+/g, ' ').slice(0, 80);
function cleanDate(s) {
  const v = String(s || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(v + 'T00:00:00Z');
  if (isNaN(d) || d.toISOString().slice(0, 10) !== v) return null;
  const y = d.getUTCFullYear(), now = new Date().getUTCFullYear();
  return y >= 1900 && y <= now ? v : null;
}

// Codice fiscale: formato e carattere di controllo (anche con omocodia)
const cleanFigura = s => FIGURE.some(f => f.id === s) ? s : null;
const cleanCf = s => String(s || '').toUpperCase().replace(/\s+/g, '').slice(0, 16);
const CF_DISPARI = { 0: 1, 1: 0, 2: 5, 3: 7, 4: 9, 5: 13, 6: 15, 7: 17, 8: 19, 9: 21, A: 1, B: 0, C: 5, D: 7, E: 9, F: 13, G: 15, H: 17, I: 19, J: 21,
  K: 2, L: 4, M: 18, N: 20, O: 11, P: 3, Q: 6, R: 8, S: 12, T: 14, U: 16, V: 10, W: 22, X: 25, Y: 24, Z: 23 };
function validCf(cf) {
  if (!/^[A-Z]{6}[0-9LMNPQRSTUV]{2}[ABCDEHLMPRST][0-9LMNPQRSTUV]{2}[A-Z][0-9LMNPQRSTUV]{3}[A-Z]$/.test(cf)) return false;
  let sum = 0;
  for (let i = 0; i < 15; i++) {
    const c = cf[i];
    sum += i % 2 === 0 ? CF_DISPARI[c] : (/\d/.test(c) ? +c : c.charCodeAt(0) - 65);
  }
  return String.fromCharCode(65 + sum % 26) === cf[15];
}
// Iscrizione all'albo (solo medici): provincia di 2 lettere e numero
const cleanProv = s => String(s || '').toUpperCase().replace(/[^A-Z]/g, '').slice(0, 2);
const cleanAlbo = s => String(s || '').trim().replace(/\s+/g, '').slice(0, 20);

async function livelliOf(userId) {
  const { rows } = await q('select app, livello, ente, ente_nome, enti from user_apps where user_id = $1 and livello is not null', [userId]);
  return Object.fromEntries(rows.map(r => [r.app, { livello: r.livello, ente: r.ente, enteNome: r.ente_nome,
    enti: Array.isArray(r.enti) && r.enti.length ? r.enti : r.ente ? [{ id: r.ente, nome: r.ente_nome }] : [] }]));
}
async function appsOf(user) {
  if (user.owner) return Object.fromEntries(APP_KEYS.map(k => [k, 'admin']));
  const { rows } = await q('select app, role from user_apps where user_id = $1', [user.id]);
  return Object.fromEntries(rows.filter(r => APP_KEYS.includes(r.app)).map(r => [r.app, r.role]));
}

function publicUser(u, apps) {
  return {
    id: u.id, firstName: u.first_name, lastName: u.last_name, birthDate: u.birth_date, email: u.email,
    status: u.status, owner: u.owner, createdAt: u.created_at, approvedAt: u.approved_at, lastLogin: u.last_login,
    hasPassword: !!u.password_hash, emailVerificata: u.email_verificata !== false || !!u.owner, figura: u.figura || '', cf: u.cf || '', alboProvincia: u.albo_provincia || '', alboNumero: u.albo_numero || '',
    ...(apps ? { apps } : {}),
  };
}

async function getUser(id) {
  const { rows } = await q('select * from users where id = $1', [id]);
  return rows[0] || null;
}
async function findByEmail(email) {
  const { rows } = await q('select * from users where email = $1', [cleanEmail(email)]);
  return rows[0] || null;
}

async function createUser({ firstName, lastName, birthDate, email, password, status = 'pending', createdBy = null, cf = null, alboProvincia = null, alboNumero = null, figura = null }) {
  const id = crypto.randomUUID();
  await q(`insert into users (id, first_name, last_name, birth_date, email, password_hash, status, created_by, approved_at, cf, albo_provincia, albo_numero, figura, email_verificata)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)`,
    [id, cleanName(firstName), cleanName(lastName), birthDate || null, cleanEmail(email),
     password ? await bcrypt.hash(password, 12) : null, status, createdBy, status === 'active' ? new Date() : null,
     cf || null, alboProvincia || null, alboNumero || null, figura || null, !!createdBy]);
  return getUser(id);
}

async function setPassword(userId, password) {
  await q('update users set password_hash = $2 where id = $1', [userId, await bcrypt.hash(String(password), 12)]);
}

// livello: per le app con "livelli" (Nuovalab, Ticket) → { livello, ente, enteNome }; il ruolo Utente/Amministratore ne deriva.
async function setAppRole(userId, app, role, livello = null) {
  if (!APP_KEYS.includes(app)) throw new Error('App sconosciuta');
  if (role === 'user' || role === 'admin') {
    if (app === 'accessi' && role === 'user') role = 'admin';
    await q(`insert into user_apps (user_id, app, role, livello, ente, ente_nome, enti) values ($1,$2,$3,$4,$5,$6,$7)
             on conflict (user_id, app) do update set role = excluded.role, livello = excluded.livello, ente = excluded.ente, ente_nome = excluded.ente_nome, enti = excluded.enti`,
      [userId, app, role, livello?.livello || null, livello?.ente || null, livello?.enteNome || null,
       livello?.enti?.length ? JSON.stringify(livello.enti) : null]);
  } else {
    await q('delete from user_apps where user_id = $1 and app = $2', [userId, app]);
  }
}

async function deleteUser(userId) {
  await q('delete from users where id = $1 and not owner', [userId]);
  events.emit('deleted', userId);
}

async function logoutEverywhere(userId) {
  await q('delete from sessions where user_id = $1', [userId]);
}

/* ---------- sessioni ---------- */
async function createSession(userId, agent) {
  const token = randomToken();
  await q(`insert into sessions (token_hash, user_id, expires_at, agent) values ($1,$2, now() + interval '${SESSION_DAYS} days', $3)`,
    [sha(token), userId, String(agent || '').slice(0, 200)]);
  await q('update users set last_login = now() where id = $1', [userId]);
  return token;
}
async function endSession(token) {
  if (token) await q('delete from sessions where token_hash = $1', [sha(token)]);
}

// Controlla un gettone di accesso. Restituisce { user, apps, renewed } oppure null.
// renewed = true quando la scadenza è stata spostata in avanti (il cookie va riscritto).
async function check(token) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const { rows } = await q(`select u.*, s.last_seen, s.token_hash from sessions s join users u on u.id = s.user_id
    where s.token_hash = $1 and s.expires_at > now()`, [sha(token)]);
  const u = rows[0];
  if (!u || u.status !== 'active') return null;
  let renewed = false;
  if (Date.now() - new Date(u.last_seen).getTime() > 60 * 60 * 1000) {
    await q(`update sessions set last_seen = now(), expires_at = now() + interval '${SESSION_DAYS} days' where token_hash = $1`, [u.token_hash]);
    renewed = true;
  }
  return { user: u, apps: await appsOf(u), renewed };
}

// Per le app: chi è l'utente e che ruolo ha in quell'app. null se non può entrare.
async function verify(token, app) {
  const c = await check(token);
  if (!c) return null;
  const role = c.apps[app];
  if (!role) return { denied: true, user: publicUser(c.user) };
  // pannello: è amministratore di Gestione accessi (o proprietario): può fare cose riservate anche nelle app
  return { user: { ...publicUser(c.user), pannello: !!(c.user.owner || c.apps.accessi === 'admin') }, role };
}

// Tutti gli utenti attivi che possono entrare in un'app, con il loro ruolo (per preparare i profili nelle app).
async function usersWithApp(app) {
  const { rows } = await q(`select u.*, case when u.owner then 'admin' else ua.role end as app_role
    from users u left join user_apps ua on ua.user_id = u.id and ua.app = $1
    where u.status = 'active' and (u.owner or ua.role is not null) order by u.last_name, u.first_name`, [app]);
  return rows.map(r => ({ ...publicUser(r), role: r.app_role }));
}

/* ---------- biglietti monouso per le app su Supabase (Nuovalab, Ticket) ---------- */
// Il biglietto vale 2 minuti e una sola volta; lo riscatta la funzione "sso" dell'app.
async function createTicket(u, app, purpose, role, extra = {}) {
  const token = randomToken();
  await q(`insert into sso_tickets (token_hash, user_id, email, app, purpose, data, expires_at)
           values ($1,$2,$3,$4,$5,$6, now() + interval '2 minutes')`,
    [sha(token), u.id || null, u.email, app, purpose,
     JSON.stringify({ firstName: u.first_name ?? u.firstName ?? '', lastName: u.last_name ?? u.lastName ?? '',
       birthDate: u.birth_date ?? u.birthDate ?? null, role: role || null, ...extra })]);
  return token;
}
async function redeemTicket(token, app) {
  if (!token || typeof token !== 'string' || token.length > 100) return null;
  const { rows } = await q(`update sso_tickets set used_at = now()
    where token_hash = $1 and app = $2 and used_at is null and expires_at > now() returning *`, [sha(token), app]);
  const t = rows[0];
  if (!t) return null;
  if (t.purpose === 'login' || t.purpose === 'sync') { // ancora attivo e abilitato a quell'app?
    const u = await getUser(t.user_id);
    if (!u || u.status !== 'active') return null;
    const role = (await appsOf(u))[app];
    if (!role) return null;
    const lv = u.owner ? null : (await livelliOf(u.id))[app] || null;
    return { purpose: t.purpose, ssoId: u.id, email: u.email, firstName: u.first_name, lastName: u.last_name, birthDate: u.birth_date, role,
      livello: lv?.livello || null, ente: lv?.ente || null, enti: (lv?.enti || []).map(x => x.id),
      cf: u.cf || null, alboProvincia: u.albo_provincia || null, alboNumero: u.albo_numero || null, figura: u.figura || null,
      oldEmail: t.data?.oldEmail && t.data.oldEmail !== u.email ? t.data.oldEmail : null };
  }
  if (t.purpose === 'sedi') return { purpose: 'sedi', email: t.email, sedi: t.data?.sedi || [] };
  return { purpose: t.purpose, ssoId: t.user_id || null, email: t.email };
}
const shapeSede = r => ({ id: r.id, nome: r.nome, sigla: r.sigla, indirizzo: r.indirizzo, societa: r.societa, email: r.email, riuniti: r.riuniti, attiva: r.attiva });
async function listSedi() {
  const { rows } = await q('select * from sedi order by attiva desc, sort, nome');
  return rows.map(shapeSede);
}
// Conferma dell'email dopo la registrazione (link valido 7 giorni)
async function confirmEmail(token) {
  const { rows } = await q(`update password_links set used_at = now() where token_hash = $1 and purpose = 'verify' and used_at is null and expires_at > now()
    returning user_id`, [sha(token)]);
  if (!rows[0]) return null;
  await q('update users set email_verificata = true where id = $1', [rows[0].user_id]);
  return getUser(rows[0].user_id);
}

/* ---------- link per impostare o reimpostare la password ---------- */
async function createPasswordLink(userId, purpose = 'reset', hours = 2) {
  const token = randomToken();
  // un nuovo link annulla i precedenti dello stesso tipo (la conferma email resta separata dai link per la password)
  await q(`update password_links set used_at = now() where user_id = $1 and used_at is null and (purpose = 'verify') = ($2 = 'verify')`, [userId, purpose]);
  await q(`insert into password_links (token_hash, user_id, purpose, expires_at) values ($1,$2,$3, now() + ($4 || ' hours')::interval)`,
    [sha(token), userId, purpose, String(hours)]);
  return token;
}
async function usePasswordLink(token, password) {
  const { rows } = await q(`select * from password_links where token_hash = $1 and purpose <> 'verify' and used_at is null and expires_at > now()`, [sha(token)]);
  const l = rows[0];
  if (!l) return null;
  await q('update password_links set used_at = now() where token_hash = $1', [l.token_hash]);
  await setPassword(l.user_id, password);
  await logoutEverywhere(l.user_id);
  return getUser(l.user_id);
}
async function peekPasswordLink(token) {
  const { rows } = await q(`select u.first_name, u.email, l.purpose from password_links l join users u on u.id = l.user_id
    where l.token_hash = $1 and l.purpose <> 'verify' and l.used_at is null and l.expires_at > now()`, [sha(token)]);
  return rows[0] || null;
}

module.exports = {
  pool, q, SCHEMA, APPS, APP_KEYS, events, migrate, ensureOwner,
  cleanEmail, validEmail, cleanName, cleanDate, cleanFigura, FIGURE, cleanCf, validCf, cleanProv, cleanAlbo, appsOf, publicUser, getUser, findByEmail, createUser, setPassword,
  setAppRole, livelliOf, deleteUser, usersWithApp, logoutEverywhere, createSession, endSession, check, verify,
  createPasswordLink, usePasswordLink, peekPasswordLink, confirmEmail, listSedi, SESSION_DAYS, sha, createTicket, redeemTicket,
};
