// Gestione Cassa UL — database PostgreSQL (stesso database delle altre app, schema separato "cassa", su Render in Europa).
// Uscite di cassa (importo + a cosa si riferiscono, data automatica) e chiusure di cassa giornaliere (contanti, POS, assegni).
// Niente si cancella: un'uscita sbagliata si annulla e resta nello storico.
const { Pool, types } = require('pg');
types.setTypeParser(1082, v => v); // le date restano "AAAA-MM-GG"
const crypto = require('crypto');

const url = process.env.DATABASE_URL || '';
const useSsl = process.env.PGSSL === 'true' || /\.render\.com/.test(url);
const SCHEMA = (process.env.CASSA_DB_SCHEMA || 'cassa').replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'cassa';
const pool = new Pool({ connectionString: url, ssl: useSsl ? { rejectUnauthorized: false } : false, options: `-c search_path=${SCHEMA},public`, max: 4 });
const q = (text, params) => pool.query(text, params);
const newId = () => crypto.randomUUID();

async function migrate() {
  await q(`create schema if not exists ${SCHEMA}`);
  await q(`
    create table if not exists uscite (
      id text primary key,
      sede_id text not null,
      sede_nome text not null default '',
      data date not null,
      importo numeric(12,2) not null check (importo > 0),
      nota text not null default '',
      creato_da text not null default '',
      creato_nome text not null default '',
      creato_il timestamptz not null default now(),
      annullata boolean not null default false,
      annullata_da text, annullata_il timestamptz, annullata_motivo text
    );
    create index if not exists uscite_sede_idx on uscite(sede_id, data);
    alter table uscite add column if not exists metodo text not null default 'contanti';
    -- voce del Consuntivo (Gestione finanziaria) scelta dall'amministratore, e cosa è già stato mandato (per non mandarlo due volte)
    alter table uscite add column if not exists voce text;
    alter table uscite add column if not exists inviata_voce text;
    alter table uscite add column if not exists inviata_importo numeric(12,2);
    alter table uscite add column if not exists inviata_anno smallint;
    alter table uscite add column if not exists inviata_mese smallint;
    alter table uscite add column if not exists inviata_il timestamptz;
    create table if not exists chiusure (
      sede_id text not null,
      data date not null,
      sede_nome text not null default '',
      contanti numeric(12,2) not null default 0,
      pos numeric(12,2) not null default 0,
      assegni numeric(12,2) not null default 0,
      note text not null default '',
      creato_da text not null default '', creato_nome text not null default '', creato_il timestamptz not null default now(),
      aggiornato_da text not null default '', aggiornato_nome text not null default '', aggiornato_il timestamptz not null default now(),
      primary key (sede_id, data)
    );
    create table if not exists produzione (
      sede_id text not null,
      anno smallint not null,
      mese smallint not null check (mese between 1 and 12),
      sede_nome text not null default '',
      valore numeric(14,2) not null default 0,
      stato text not null default 'attesa' check (stato in ('attesa','approvata','rifiutata')),
      inviato_da text, inviato_nome text not null default '', inviato_il timestamptz not null default now(),
      deciso_da text, deciso_nome text, deciso_il timestamptz, nota_admin text,
      sincronizzato_il timestamptz, valore_prima numeric(14,2), errore text not null default '',
      primary key (sede_id, anno, mese)
    );
    create table if not exists storico (
      id bigserial primary key,
      cosa text not null, rif text not null, chi text not null default '',
      prima jsonb, dopo jsonb, il timestamptz not null default now()
    );
  `);
}

module.exports = { q, pool, newId, migrate, SCHEMA };
