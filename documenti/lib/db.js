// Documenti di studio — database (stesso database delle altre app, schema separato "documenti").
const { Pool } = require('pg');
const crypto = require('crypto');

const url = process.env.DATABASE_URL || '';
const useSsl = process.env.PGSSL === 'true' || /\.render\.com/.test(url);
const SCHEMA = (process.env.DOC_DB_SCHEMA || 'documenti').replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'documenti';
const pool = new Pool({ connectionString: url, ssl: useSsl ? { rejectUnauthorized: false } : false, options: `-c search_path=${SCHEMA},public`, max: 5 });
const q = (text, params) => pool.query(text, params);
const newId = () => crypto.randomUUID();

async function migrate() {
  await q(`create schema if not exists ${SCHEMA}`);
  await q(`
    create table if not exists categorie (
      id text primary key,
      nome text not null,
      ordine int not null default 0,
      creata_il timestamptz not null default now()
    );
    create unique index if not exists categorie_nome_idx on categorie (lower(nome));
    create table if not exists documenti (
      id text primary key,
      titolo text not null,
      categoria_id text references categorie(id) on delete restrict,
      tipo text not null default 'pagina' check (tipo in ('pagina','originale')),
      blocchi jsonb not null default '[]',
      testo text not null default '',          -- testo semplice, per la ricerca
      scaricabile boolean not null default true,
      notifica boolean not null default true,
      bozza boolean not null default true,
      vis_gruppi jsonb not null default '[]',
      vis_persone jsonb not null default '[]',
      origine text not null default '',
      versione int not null default 0,         -- sale a ogni pubblicazione: chi non ha visto l'ultima la vede come "aggiornato"
      creato_il timestamptz not null default now(),
      aggiornato_il timestamptz not null default now(),
      aggiornato_da text not null default '',
      pubblicato_il timestamptz
    );
    create index if not exists documenti_cat_idx on documenti(categoria_id);
    create table if not exists originali (
      documento_id text primary key references documenti(id) on delete cascade,
      nome text not null,
      mime text not null,
      dati bytea not null,
      pagine int not null default 0
    );
    create table if not exists immagini (
      id text primary key,
      documento_id text not null references documenti(id) on delete cascade,
      mime text not null,
      dati bytea not null
    );
    create index if not exists immagini_doc_idx on immagini(documento_id);
    create table if not exists viste (
      documento_id text not null references documenti(id) on delete cascade,
      user_id text not null,
      versione int not null,
      visto_il timestamptz not null default now(),
      primary key (documento_id, user_id)
    );
  `);
  // categorie iniziali, solo la prima volta (si possono rinominare o eliminare)
  const { rows } = await q('select count(*)::int n from categorie');
  if (!rows[0].n) for (const [i, n] of ['Procedure', 'Moduli', 'Regolamenti', 'Privacy e sicurezza'].entries())
    await q('insert into categorie (id, nome, ordine) values ($1,$2,$3) on conflict do nothing', [newId(), n, i]);
}

module.exports = { pool, q, newId, SCHEMA, migrate };
