// Comunicazioni aziendali — database PostgreSQL (stesso database delle altre app, schema separato "comunicazioni").
// Le persone sono quelle dell'accesso unico (appgestione.it): qui si salva solo il loro id, con nome, figura e sedi
// "fotografati" al momento dell'invio (così l'elenco dei destinatari di una comunicazione resta quello di quel giorno).
const { Pool } = require('pg');
const crypto = require('crypto');

const url = process.env.DATABASE_URL || '';
const useSsl = process.env.PGSSL === 'true' || /\.render\.com/.test(url);
const SCHEMA = (process.env.COM_DB_SCHEMA || 'comunicazioni').replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'comunicazioni';
const pool = new Pool({
  connectionString: url,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  options: `-c search_path=${SCHEMA},public`,
  max: 5,
});
const q = (text, params) => pool.query(text, params);
const newId = () => crypto.randomUUID();

async function migrate() {
  await q(`create schema if not exists ${SCHEMA}`);
  await q(`
    create table if not exists messaggi (
      id text primary key,
      titolo text not null,
      testo text not null default '',
      importante boolean not null default false,
      conferma boolean not null default true,
      autore_id text not null,
      autore_nome text not null default '',
      a_chi text not null default '',
      gruppi jsonb not null default '[]',
      creato_il timestamptz not null default now()
    );
    create index if not exists messaggi_creato_idx on messaggi(creato_il desc);
    create table if not exists destinatari (
      messaggio_id text not null references messaggi(id) on delete cascade,
      user_id text not null,
      nome text not null default '',
      figura text not null default '',
      sedi text not null default '',
      letto_il timestamptz,
      confermato_il timestamptz,
      primary key (messaggio_id, user_id)
    );
    create index if not exists destinatari_user_idx on destinatari(user_id);
    create table if not exists chat (
      id text primary key,
      messaggio_id text not null references messaggi(id) on delete cascade,
      persona_id text not null,          -- il destinatario: ogni persona ha la sua conversazione privata
      da_admin boolean not null,
      autore_id text not null,
      autore_nome text not null default '',
      testo text not null,
      creato_il timestamptz not null default now(),
      letto boolean not null default false -- letto dall'altra parte
    );
    create index if not exists chat_msg_idx on chat(messaggio_id, persona_id, creato_il);
    create table if not exists solleciti (
      id text primary key,
      messaggio_id text not null references messaggi(id) on delete cascade,
      inviato_il timestamptz not null default now(),
      persone int not null default 0,
      raggiunte int not null default 0,
      da text not null default ''
    );
  `);
}

module.exports = { pool, q, newId, SCHEMA, migrate };
