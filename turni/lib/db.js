// Turnario: database (schema "turni" nel database del gruppo).
const { Pool, types } = require('pg');
const crypto = require('crypto');

types.setTypeParser(1082, v => v); // date come testo AAAA-MM-GG

const url = process.env.DATABASE_URL || '';
const useSsl = process.env.PGSSL === 'true' || /\.render\.com/.test(url);
const SCHEMA = (process.env.TURNI_DB_SCHEMA || 'turni').replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'turni';
const pool = new Pool({
  connectionString: url,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  options: `-c search_path=${SCHEMA},public`,
});
const q = (text, params) => pool.query(text, params);
const newId = () => crypto.randomUUID();

async function tx(fn) {
  const c = await pool.connect();
  try {
    await c.query('begin');
    const out = await fn((text, params) => c.query(text, params));
    await c.query('commit');
    return out;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    throw e;
  } finally {
    c.release();
  }
}

async function migrate() {
  await q(`create schema if not exists ${SCHEMA}`);
  await q(`
    create table if not exists config (
      id int primary key check (id = 1),
      data jsonb not null,
      version int not null default 1,
      aggiornata_il timestamptz not null default now(),
      aggiornata_da text
    );
    create table if not exists piano (
      id int primary key check (id = 1),
      data jsonb not null default '{}',
      generato_il timestamptz
    );
    create sequence if not exists richieste_numero_seq;
    create table if not exists richieste (
      id text primary key,
      numero int not null default nextval('richieste_numero_seq'),
      staff_id text not null,
      tipo text not null check (tipo in ('FE','ROL','MAL')),
      dal date not null,
      al date not null,
      ore int,
      sost text,
      prot text not null default '',
      note text not null default '',
      stato text not null check (stato in ('attesa_sost','attesa_admin','approvata','rifiutata','annullata')),
      sost_ok boolean,
      inviata date not null,
      creata_il timestamptz not null default now(),
      gestita_il timestamptz,
      gestita_da text
    );
    create index if not exists richieste_staff_idx on richieste(staff_id);
    create table if not exists assenze_ai (
      staff_id text not null,
      data date not null,
      creata_il timestamptz not null default now(),
      primary key (staff_id, data)
    );
    create table if not exists privacy (
      staff_id text primary key,
      accettata_il timestamptz not null default now(),
      dispositivo text not null default '',
      email text not null default ''
    );
    create table if not exists buste (
      id text primary key,
      staff_id text not null,
      mese text not null,
      file bytea not null,
      iv bytea not null,
      tag bytea not null,
      impronta text not null,
      pagine int not null default 1,
      stato text not null default 'bozza' check (stato in ('bozza','pubblicata')),
      origine text not null default '',
      creata_il timestamptz not null default now(),
      pubblicata_il timestamptz,
      aperta_il timestamptz,
      aperta_disp text,
      confermata_il timestamptz,
      confermata_disp text
    );
    create index if not exists buste_mese_idx on buste(mese);
    create index if not exists buste_staff_idx on buste(staff_id);
    create table if not exists pagine_sospese (
      id text primary key,
      mese text not null,
      origine text not null default '',
      pagina int not null,
      file bytea not null,
      iv bytea not null,
      tag bytea not null,
      suggerito text,
      creata_il timestamptz not null default now()
    );
    create table if not exists users (
      id text primary key,
      sso_id text unique,
      email text not null,
      name text not null default '',
      role text not null default 'emp' check (role in ('admin','emp'))
    );
    create table if not exists push_subs (
      endpoint text primary key,
      user_id text not null references users(id) on delete cascade,
      p256dh text not null,
      auth text not null,
      created_at timestamptz not null default now()
    );
    create table if not exists app_settings (
      key text primary key,
      value text not null
    );
  `);
}

module.exports = { pool, q, tx, newId, SCHEMA, migrate };
