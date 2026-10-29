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
  // test delle spore: la foto del risultato dopo l'incubazione si aggiunge a quella iniziale
  await q('alter table test add column if not exists foto_esito_id text references foto(id) on delete set null');
  // Manutenzione: riuniti e aspiratori arrivano dalle Sedi di Gestione accessi; "rif" = posizione (r1, r2… a1…) nella sede
  await q('alter table attrezzature add column if not exists rif text');
  // Misure implantari: richieste delle ASO al medico della sede (Comunicazioni cliniche)
  await q(`create table if not exists misure (
      id text primary key,
      sede_id text not null,
      sede_nome text not null default '',
      paziente_cognome text not null,
      paziente_nome text not null default '',
      lavoro text not null,
      data_intervento date not null,
      tipo text not null default 'standard' check (tipo in ('standard','emergenza')),
      dtx boolean not null default false,
      medico_id text not null,
      medico_nome text not null default '',
      stato text not null default 'inviata' check (stato in ('inviata','in_carico','pianificata','annullata')),
      note text not null default '',
      creato_da text not null default '',
      creato_da_nome text not null default '',
      creato_il timestamptz not null default now(),
      presa_il timestamptz,
      pianificata_il timestamptz,
      nota_medico text not null default '',
      annullata_il timestamptz
    );
    create index if not exists misure_sede_idx on misure(sede_id, creato_il desc);
    create index if not exists misure_medico_idx on misure(medico_id, stato);`);
  // Registro impianti per paziente: il paziente si crea una volta, poi si registrano le etichette dente per dente
  await q(`create table if not exists pazienti (
      id text primary key,
      sede_id text not null,
      sede_nome text not null default '',
      cognome text not null,
      nome text not null default '',
      nascita date,
      note text not null default '',
      operatore_nome text not null default '',
      creato_il timestamptz not null default now()
    );
    create index if not exists pazienti_sede_idx on pazienti(sede_id, lower(cognome), lower(nome));
    alter table impianti add column if not exists paziente_id text references pazienti(id);
    create index if not exists impianti_paziente_idx on impianti(paziente_id);`);
  // impianti registrati prima (senza paziente): si crea il paziente con lo stesso cognome e nome nella stessa sede e si collegano
  await q(`insert into pazienti (id, sede_id, sede_nome, cognome, nome, operatore_nome, creato_il)
    select md5(random()::text || clock_timestamp()::text), x.sede_id, x.sede_nome, x.paziente_cognome, x.paziente_nome, x.operatore_nome, x.creato_il
    from (select distinct on (sede_id, lower(paziente_cognome), lower(paziente_nome)) sede_id, sede_nome, paziente_cognome, paziente_nome, operatore_nome, creato_il
          from impianti where paziente_id is null order by sede_id, lower(paziente_cognome), lower(paziente_nome), creato_il) x
    where not exists (select 1 from pazienti p where p.sede_id = x.sede_id and lower(p.cognome) = lower(x.paziente_cognome) and lower(p.nome) = lower(x.paziente_nome))`);
  await q(`update impianti i set paziente_id = p.id from pazienti p
    where i.paziente_id is null and p.sede_id = i.sede_id and lower(p.cognome) = lower(i.paziente_cognome) and lower(p.nome) = lower(i.paziente_nome)`);
}

module.exports = { pool, q, newId, SCHEMA, migrate };
