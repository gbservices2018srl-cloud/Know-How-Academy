// Gestione ASO — database PostgreSQL (stesso database delle altre app, schema separato "aso").
// Compliance sterilizzazione: sterilizzatrici per sede, una scheda per giorno e per sterilizzatrice con i test
// (Bowie-Dick e Helix giornalieri, spore mensile) e i cicli con la foto della vapor line.
// Registro impianti: interventi con paziente, posizione (dente), medico e dati UDI (GTIN, lotto, scadenza, seriale).
// Le foto sono ridotte dal telefono prima dell'invio (circa 100–250 KB) e stanno nella tabella "foto".
const { Pool } = require('pg');
const crypto = require('crypto');

const url = process.env.DATABASE_URL || '';
const useSsl = process.env.PGSSL === 'true' || /\.render\.com/.test(url);
const SCHEMA = (process.env.ASO_DB_SCHEMA || 'aso').replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'aso';
const pool = new Pool({ connectionString: url, ssl: useSsl ? { rejectUnauthorized: false } : false, options: `-c search_path=${SCHEMA},public`, max: 5 });
const q = (text, params) => pool.query(text, params);
const newId = () => crypto.randomUUID();

async function migrate() {
  await q(`create schema if not exists ${SCHEMA}`);
  await q(`
    create table if not exists foto (
      id text primary key,
      mime text not null,
      dati bytea not null,
      sede_id text not null default '',
      creata_il timestamptz not null default now()
    );
    create table if not exists sterilizzatrici (
      id text primary key,
      sede_id text not null,
      sede_nome text not null default '',
      marca text not null,
      modello text not null default '',
      matricola text not null default '',
      attiva boolean not null default true,
      creata_il timestamptz not null default now()
    );
    create index if not exists sterilizzatrici_sede_idx on sterilizzatrici(sede_id);
    create table if not exists schede (
      id text primary key,
      macchina_id text not null references sterilizzatrici(id) on delete cascade,
      sede_id text not null,
      giorno date not null,
      aperta_da text not null default '',
      aperta_da_nome text not null default '',
      creata_il timestamptz not null default now(),
      unique (macchina_id, giorno)
    );
    create table if not exists test (
      id text primary key,
      scheda_id text not null references schede(id) on delete cascade,
      tipo text not null check (tipo in ('bd','helix','spore')),
      esito text not null check (esito in ('ok','ko','attesa')),
      note text not null default '',
      foto_id text references foto(id) on delete set null,
      operatore_id text not null default '',
      operatore_nome text not null default '',
      creato_il timestamptz not null default now(),
      aggiornato_il timestamptz not null default now()
    );
    create index if not exists test_scheda_idx on test(scheda_id);
    create table if not exists cicli (
      id text primary key,
      scheda_id text not null references schede(id) on delete cascade,
      numero text not null default '',
      temperatura int check (temperatura in (121,134)),
      esito text not null default 'ok' check (esito in ('ok','ko')),
      note text not null default '',
      foto_id text references foto(id) on delete set null,
      operatore_id text not null default '',
      operatore_nome text not null default '',
      creato_il timestamptz not null default now()
    );
    create index if not exists cicli_scheda_idx on cicli(scheda_id);
    create table if not exists impianti (
      id text primary key,
      sede_id text not null,
      sede_nome text not null default '',
      data_intervento date not null,
      paziente_cognome text not null,
      paziente_nome text not null default '',
      denti smallint[] not null default '{}',
      medico text not null default '',
      prodotto text not null default '',
      produttore text not null default '',
      ref text not null default '',
      udi text not null default '',
      gtin text not null default '',
      lotto text not null default '',
      scadenza date,
      seriale text not null default '',
      note text not null default '',
      foto_id text references foto(id) on delete set null,
      operatore_id text not null default '',
      operatore_nome text not null default '',
      creato_il timestamptz not null default now(),
      aggiornato_il timestamptz not null default now()
    );
    create index if not exists impianti_sede_idx on impianti(sede_id, data_intervento desc);
    create index if not exists impianti_paz_idx on impianti(lower(paziente_cognome), lower(paziente_nome));
    -- Manutenzione attrezzature: riuniti e aspiratori per sede (li crea l'amministratore) e registro degli interventi
    create table if not exists attrezzature (
      id text primary key,
      sede_id text not null,
      sede_nome text not null default '',
      tipo text not null check (tipo in ('riunito','aspiratore')),
      nome text not null,
      attiva boolean not null default true,
      creata_il timestamptz not null default now()
    );
    create index if not exists attrezzature_sede_idx on attrezzature(sede_id);
    create table if not exists manutenzioni (
      id text primary key,
      attrezzatura_id text not null references attrezzature(id) on delete cascade,
      sede_id text not null,
      voce text not null,
      eseguita_il timestamptz not null default now(),
      operatore_id text not null default '',
      operatore_nome text not null default '',
      note text not null default '',
      modificata_da text not null default '',
      modificata_il timestamptz
    );
    create index if not exists manutenzioni_att_idx on manutenzioni(attrezzatura_id, eseguita_il desc);
    -- Esportazioni dei dati di una sterilizzatrice (scarica e svuota): resta la traccia di chi e quando
    create table if not exists esportazioni (
      id text primary key,
      macchina_id text not null,
      sede_id text not null,
      fatta_il timestamptz not null default now(),
      fatta_da text not null default '',
      conteggi jsonb not null default '{}',
      cancellata_il timestamptz,
      cancellata_da text not null default '',
      cancellati jsonb
    );
    create index if not exists manutenzioni_sede_idx on manutenzioni(sede_id, eseguita_il desc);
  `);
}

module.exports = { pool, q, newId, SCHEMA, migrate };
