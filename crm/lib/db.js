// CRM Commerciale — database PostgreSQL (stesso database delle altre app, schema separato "crm", su Render in Europa).
// Una riga per preventivo presentato (come una riga dei vecchi fogli "Dati Grezzi <Sede>" del CRM su Google Sheets).
// Dati personali: paziente, anno di nascita e note. Non escono mai dal server: niente KPI, niente AI, niente log.
// Il telefono non si salva (i commerciali lo trovano nel gestionale dello studio).
const { Pool } = require('pg');
const crypto = require('crypto');

const url = process.env.DATABASE_URL || '';
const useSsl = process.env.PGSSL === 'true' || /\.render\.com/.test(url);
const SCHEMA = (process.env.CRM_DB_SCHEMA || 'crm').replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'crm';
const pool = new Pool({ connectionString: url, ssl: useSsl ? { rejectUnauthorized: false } : false, options: `-c search_path=${SCHEMA},public`, max: 5 });
const q = (text, params) => pool.query(text, params);
const newId = () => crypto.randomUUID();

// elenchi iniziali (gli stessi del vecchio modulo); poi si cambiano dalla micro app Liste
const TIPO_OV = ['AMPLIAMENTO', 'ENTRO 30 GIORNI', 'IGIENE', 'N/D', 'OLD CONTACT', 'PAGAMENTO DILAZIONATO', 'PRIMA VISITA', 'REVISIONE', 'URGENZA'];
const MARKETING = ['ADS', 'CARD FIDELITY', 'CONVENZIONE BASKET SAN SPERATE', 'CONVENZIONE CARABINIERI', 'CONVENZIONI', 'DENTALNET',
  'ESTRATTI VECCHI CONTATTI', 'EVENTO TERRALBA', 'EVENTO VIVAIO TERR', 'FACEBOOK', 'FARMAINFORMA', 'FIDELITY', 'FIDELITY CARD',
  'GOLDEN TICKET', 'GOOGLE', 'INSTAGRAM', 'LEADS ELMAS', 'N/D', 'ORAL PRO', 'ORALPRO', 'ORTO DAY', 'OV INTERNA', 'PASSAPAROLA',
  'PAZIENTE DOTT LACONI', 'RADDOPPI', 'REFERRAL', 'REFERRAL STAFF', 'SARTIGLIA', 'SED', 'SHUT ADV', 'SPONTANEO', 'STRADA',
  'TELEMARKETING/OUTBOUND', 'UNISALUTE', 'VOLANTINAGGIO STAFF'];

async function migrate() {
  await q(`create schema if not exists ${SCHEMA}`);
  await q(`
    create table if not exists preventivi (
      id text primary key,
      sede_id text not null,
      sede_nome text not null default '',
      data date,
      anno smallint not null,
      mese smallint not null check (mese between 1 and 12),
      paziente text not null default '',
      tipo_ov text not null default '',
      marketing text not null default '',
      pdc numeric(12,2) not null default 0,
      esito text not null default '' check (esito in ('', 'A', 'S', 'R')),
      pagato numeric(12,2) not null default 0,
      anno_nascita smallint,
      tipo_pdc text not null default '',
      note text not null default '',
      commerciale_id text,
      commerciale text not null default '',
      medici_ids jsonb not null default '[]',
      medico text not null default '',
      origine text not null default 'app',
      import_id text,
      creato_da text not null default '',
      creato_il timestamptz not null default now(),
      aggiornato_da text not null default '',
      aggiornato_il timestamptz not null default now()
    );
    create index if not exists preventivi_sede_idx on preventivi(sede_id, anno, mese);
    create index if not exists preventivi_paz_idx on preventivi(lower(paziente));
    create table if not exists liste (
      tipo text not null check (tipo in ('tipo_ov', 'marketing', 'tipo_pdc')),
      valore text not null,
      canale text not null default '',
      attivo boolean not null default true,
      primary key (tipo, valore)
    );
    create table if not exists importazioni (
      id text primary key,
      file text not null default '',
      righe int not null default 0,
      riepilogo jsonb not null default '{}',
      fatto_da text not null default '',
      fatto_il timestamptz not null default now()
    );
    create table if not exists impostazioni (k text primary key, v jsonb not null);
    -- nome del commerciale scritto a mano nel vecchio foglio (es. "LUCA") → persona di Gestione accessi
    create table if not exists alias_commerciali (nome text primary key, user_id text not null, user_nome text not null default '');
    create table if not exists storico (
      id bigserial primary key,
      preventivo_id text not null,
      chi text not null default '',
      campo text not null,
      prima text, dopo text,
      il timestamptz not null default now()
    );
    create index if not exists storico_prev_idx on storico(preventivo_id);
  `);
  // elenchi iniziali, una volta sola
  const { rows: [n] } = await q('select count(*)::int as n from liste');
  if (!n.n) {
    for (const v of TIPO_OV) await q('insert into liste (tipo, valore) values ($1,$2) on conflict do nothing', ['tipo_ov', v]);
    for (const v of MARKETING) await q('insert into liste (tipo, valore) values ($1,$2) on conflict do nothing', ['marketing', v]);
  }
  // come nella vecchia dashboard: ORALPRO e ORAL PRO sono lo stesso canale (una volta sola; poi si cambia in Liste)
  if ((await q(`insert into impostazioni (k, v) values ('_seme_canali', 'true') on conflict do nothing`)).rowCount)
    await q(`update liste set canale = 'Oral Pro' where tipo = 'marketing' and valore in ('ORALPRO', 'ORAL PRO') and canale = ''`);
}

module.exports = { q, pool, newId, migrate, SCHEMA };
