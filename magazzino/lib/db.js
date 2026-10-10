// Magazzino centrale: database (schema "magazzino" nel database del gruppo).
const { Pool, types } = require('pg');
const crypto = require('crypto');

types.setTypeParser(1082, v => v); // date come testo AAAA-MM-GG
types.setTypeParser(20, v => parseInt(v, 10)); // count(*) come numero

const url = process.env.DATABASE_URL || '';
const useSsl = process.env.PGSSL === 'true' || /\.render\.com/.test(url);
const SCHEMA = (process.env.MAG_DB_SCHEMA || 'magazzino').replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'magazzino';
const pool = new Pool({
  connectionString: url,
  ssl: useSsl ? { rejectUnauthorized: false } : false,
  options: `-c search_path=${SCHEMA},public`,
});
const q = (text, params) => pool.query(text, params);
const newId = () => crypto.randomUUID();

// Esegue fn(client) in una transazione: tutto o niente.
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
    create table if not exists users (
      id text primary key,
      sso_id text unique,
      email text not null,
      name text not null default '',
      role text not null default 'client' check (role in ('admin','client')),
      last_seen timestamptz
    );
    create table if not exists categorie (
      id text primary key,
      nome text not null,
      ordine int not null default 0
    );
    create table if not exists fornitori (
      id text primary key,
      nome text not null,
      email text not null default '',
      telefono text not null default '',
      note text not null default ''
    );
    create table if not exists articoli (
      id text primary key,
      categoria_id text not null references categorie(id),
      nome text not null,
      codice text not null default '',
      unita text not null default 'pz',
      giacenza int not null default 0 check (giacenza >= 0),
      scorta_minima int not null default 0 check (scorta_minima >= 0),
      livello_carico int not null default 0 check (livello_carico >= 0),
      fornitore_id text references fornitori(id) on delete set null,
      attivo boolean not null default true,
      note text not null default '',
      creato_il timestamptz not null default now(),
      aggiornato_il timestamptz not null default now()
    );
    create index if not exists articoli_cat_idx on articoli(categoria_id);
    create sequence if not exists prenotazioni_numero_seq;
    create table if not exists prenotazioni (
      id text primary key,
      numero int not null default nextval('prenotazioni_numero_seq'),
      utente_id text not null references users(id),
      stato text not null default 'in_attesa' check (stato in ('in_attesa','confermata','rifiutata','annullata')),
      note text not null default '',
      motivo text not null default '',
      creata_il timestamptz not null default now(),
      gestita_il timestamptz,
      gestita_da text references users(id)
    );
    create index if not exists prenotazioni_stato_idx on prenotazioni(stato);
    create table if not exists prenotazione_righe (
      id text primary key,
      prenotazione_id text not null references prenotazioni(id) on delete cascade,
      articolo_id text not null references articoli(id),
      nome text not null,
      unita text not null default 'pz',
      quantita int not null check (quantita > 0)
    );
    create index if not exists prenotazione_righe_idx on prenotazione_righe(prenotazione_id);
    create table if not exists carrello (
      articolo_id text primary key references articoli(id) on delete cascade,
      quantita int,
      escluso boolean not null default false
    );
    create sequence if not exists ordini_numero_seq;
    create table if not exists ordini_fornitore (
      id text primary key,
      numero int not null default nextval('ordini_numero_seq'),
      fornitore_id text references fornitori(id) on delete set null,
      fornitore_nome text not null default '',
      fornitore_email text not null default '',
      stato text not null default 'da_inviare' check (stato in ('da_inviare','inviato','ricevuto','annullato')),
      note text not null default '',
      creato_il timestamptz not null default now(),
      creato_da text references users(id),
      inviato_il timestamptz,
      ricevuto_il timestamptz
    );
    create table if not exists ordine_righe (
      id text primary key,
      ordine_id text not null references ordini_fornitore(id) on delete cascade,
      articolo_id text references articoli(id) on delete set null,
      nome text not null,
      codice text not null default '',
      unita text not null default 'pz',
      quantita int not null check (quantita > 0),
      quantita_ricevuta int
    );
    create table if not exists movimenti (
      id text primary key,
      articolo_id text not null references articoli(id) on delete cascade,
      delta int not null,
      giacenza_dopo int not null,
      causale text not null,
      riferimento text not null default '',
      utente_id text references users(id),
      creato_il timestamptz not null default now()
    );
    create index if not exists movimenti_art_idx on movimenti(articolo_id, creato_il desc);
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
    alter table users add column if not exists figura text;
    alter table fornitori add column if not exists piva text not null default '';
    alter table fornitori add column if not exists indirizzo text not null default '';
    -- righe delle bolle già registrate: la prossima volta lo stesso prodotto va da solo al suo articolo/categoria
    create table if not exists bolla_memo (
      fornitore_id text not null default '',
      chiave text not null,
      articolo_id text references articoli(id) on delete set null,
      categoria_id text references categorie(id) on delete cascade,
      aggiornato_il timestamptz not null default now(),
      primary key (fornitore_id, chiave)
    );
    create table if not exists bolle (
      id text primary key,
      fornitore_id text references fornitori(id) on delete set null,
      fornitore_nome text not null default '',
      numero text not null default '',
      data text not null default '',
      righe int not null default 0,
      giacenza boolean not null default true,
      caricata_il timestamptz not null default now(),
      utente_id text references users(id)
    );
    -- eliminando un articolo le prenotazioni passate restano (con nome e quantità), senza collegamento
    alter table prenotazione_righe alter column articolo_id drop not null;
    -- come vuole ricevere la merce chi prenota: ritiro in magazzino oppure spedizione (con indirizzo)
    alter table prenotazioni add column if not exists consegna text not null default '';
    alter table prenotazioni add column if not exists indirizzo text not null default '';
  `);
  await q(`do $$ begin
    if exists (select 1 from pg_constraint where conrelid = 'prenotazione_righe'::regclass and conname = 'prenotazione_righe_articolo_id_fkey' and confdeltype <> 'n') then
      alter table prenotazione_righe drop constraint prenotazione_righe_articolo_id_fkey;
      alter table prenotazione_righe add constraint prenotazione_righe_articolo_id_fkey foreign key (articolo_id) references articoli(id) on delete set null;
    end if; end $$`);
}

module.exports = { pool, q, tx, newId, SCHEMA, migrate };
