// Database PostgreSQL: tabelle, dati iniziali e utente amministratore dalle impostazioni di Render.
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

// Con URL "External" di Render serve SSL; con URL "Internal" (stessa regione) no.
const url = process.env.DATABASE_URL || '';
const useSsl = process.env.PGSSL === 'true' || /\.render\.com/.test(url);
// Spazio separato nel database (utile se il database è condiviso con un'altra app).
const SCHEMA = (process.env.DB_SCHEMA || 'public').replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'public';
const pool = new Pool({
  connectionString: url,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  ...(SCHEMA !== 'public' ? { options: `-c search_path=${SCHEMA},public` } : {}),
});

const q = (text, params) => pool.query(text, params);
const newId = () => crypto.randomUUID();

async function migrate() {
  if (SCHEMA !== 'public') await q(`create schema if not exists ${SCHEMA}`);
  await q(`
    create table if not exists users (
      id text primary key,
      username text unique not null,
      name text not null default '',
      title text not null default '',
      role text not null default 'collab' check (role in ('admin','collab')),
      password_hash text not null,
      from_env boolean not null default false,
      created_at timestamptz not null default now()
    );
    create table if not exists flows (
      id text primary key,
      name text not null,
      data jsonb not null default '{"nodes":[],"edges":[]}',
      sort int not null default 0,
      updated_at timestamptz not null default now()
    );
    create table if not exists access (
      user_id text not null references users(id) on delete cascade,
      flow_id text not null references flows(id) on delete cascade,
      mode text not null check (mode in ('none','all','some')),
      hide boolean not null default false,
      nodes jsonb not null default '[]',
      primary key (user_id, flow_id)
    );
    create table if not exists docs (
      id text primary key,
      flow_id text not null references flows(id) on delete cascade,
      node_id text not null,
      title text not null,
      type text not null default 'Protocollo',
      body text not null default '',
      example boolean not null default false,
      file bytea,
      file_name text,
      file_mime text,
      updated_at timestamptz not null default now(),
      updated_by text
    );
    create index if not exists docs_flow_idx on docs(flow_id);
    alter table users add column if not exists sso_id text unique;
    alter table users add column if not exists figura text;
    create table if not exists access_figura (
      figura text not null,
      flow_id text not null references flows(id) on delete cascade,
      mode text not null check (mode in ('none','all','some')),
      hide boolean not null default false,
      nodes jsonb not null default '[]',
      primary key (figura, flow_id)
    );
  `);
}

// Crea o aggiorna l'amministratore definito in ADMIN_USERNAME / ADMIN_PASSWORD.
async function ensureEnvAdmin() {
  const username = (process.env.ADMIN_USERNAME || '').trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD || '';
  if (!username || !password) {
    console.warn('ATTENZIONE: imposta ADMIN_USERNAME e ADMIN_PASSWORD su Render per poter entrare come amministratore.');
    return;
  }
  let { rows } = await q('select * from users where username = $1', [username]);
  if (!rows.length) {
    // Nome utente cambiato su Render: rinomina l'amministratore principale invece di crearne un secondo.
    const prev = await q('select * from users where from_env = true order by created_at limit 1');
    if (prev.rows.length) {
      await q('update users set username = $2 where id = $1', [prev.rows[0].id, username]);
      await q(`delete from session where sess->>'uid' = $1`, [prev.rows[0].id]).catch(() => {});
      console.log(`Amministratore principale rinominato in "${username}".`);
      rows = [{ ...prev.rows[0], username }];
    }
  }
  if (!rows.length) {
    await q(`insert into users (id, username, name, title, role, password_hash, from_env)
             values ($1, $2, $3, 'Amministratore', 'admin', $4, true)`,
      [newId(), username, process.env.ADMIN_NAME || username, await bcrypt.hash(password, 12)]);
    console.log(`Amministratore "${username}" creato.`);
  } else {
    const u = rows[0];
    const same = await bcrypt.compare(password, u.password_hash);
    if (!same || u.role !== 'admin' || !u.from_env) {
      await q('update users set password_hash = $2, role = $3, from_env = true where id = $1',
        [u.id, same ? u.password_hash : await bcrypt.hash(password, 12), 'admin']);
      console.log(`Amministratore "${username}" aggiornato dalle impostazioni.`);
    }
  }
}

// Al primo avvio carica il flusso "Percorso paziente" e i documenti di esempio.
async function seedIfEmpty() {
  const { rows } = await q('select count(*)::int as n from flows');
  if (rows[0].n > 0 || process.env.SKIP_SEED === 'true') return;
  const seed = require('./seed.json');
  let sort = 0;
  for (const f of seed.flows) {
    await q('insert into flows (id, name, data, sort) values ($1, $2, $3, $4)',
      [f.id, f.name, JSON.stringify({ nodes: f.nodes, edges: f.edges, manual: false }), sort++]);
  }
  for (const d of seed.docs) {
    await q(`insert into docs (id, flow_id, node_id, title, type, body, example, updated_at)
             values ($1,$2,$3,$4,$5,$6,true,$7)`,
      [newId(), d.flowId, d.nodeId, d.title, d.type, d.body, d.updated]);
  }
  console.log('Dati di esempio caricati.');
}

module.exports = { pool, q, newId, SCHEMA, migrate, ensureEnvAdmin, seedIfEmpty };
