// Trasloco del database (es. da Oregon a Francoforte) SENZA toccare l'originale.
// Si usa una volta sola sul servizio nuovo: con COPIA_DA = indirizzo esterno del vecchio database,
// all'avvio (dopo che le app hanno creato le loro tabelle) copia tutte le righe di tutti gli schemi,
// rimette i contatori (sequenze), confronta le righe tabella per tabella e scrive il resoconto
// nella tabella public._trasloco. Il vecchio database viene solo letto.
// Se qualcosa non torna il servizio NON parte: meglio fermo che con dati a metà.
const { Pool } = require('pg');

const testo = { getTypeParser: () => v => v }; // tutto come testo: lo rilegge Postgres con il tipo giusto (date, json, bytea…)
const ssl = url => (process.env.PGSSL === 'true' || /render\.com|supabase|sslmode=require/.test(url) ? { rejectUnauthorized: false } : false);
const qi = s => '"' + String(s).replace(/"/g, '""') + '"';

async function eseguiSeServe() {
  const da = process.env.COPIA_DA;
  if (!da) return false;
  const dst = new Pool({ connectionString: process.env.DATABASE_URL, ssl: ssl(process.env.DATABASE_URL || ''), types: testo, max: 2 });
  await dst.query(`create table if not exists public._trasloco (id serial primary key, fatto_il timestamptz default now(), esito text, resoconto jsonb)`);
  const { rows: fatti } = await dst.query(`select 1 from public._trasloco where esito = 'ok' limit 1`);
  if (fatti.length && process.env.COPIA_FORZA !== 'true') { await dst.end(); console.log('Trasloco: già fatto, non ricopio (togli COPIA_DA).'); return false; }
  const src = new Pool({ connectionString: da, ssl: ssl(da), types: testo, max: 2 });
  console.log('Trasloco: inizio copia dal vecchio database (sola lettura)…');
  const t0 = Date.now();
  const report = { tabelle: {}, sequenze: 0, saltate: [], differenze: [] };
  const c = await dst.connect();
  try {
    const sch = `n.nspname not like 'pg\\_%' and n.nspname <> 'information_schema'`;
    const { rows: tabSrc } = await src.query(`select n.nspname s, c.relname t from pg_class c join pg_namespace n on n.oid = c.relnamespace
      where c.relkind = 'r' and ${sch} and not (n.nspname = 'public' and c.relname = '_trasloco') order by 1, 2`);
    // schemi e tabelle mancanti nel nuovo (es. create solo "al primo uso"): si creano con le stesse colonne
    for (const { s, t } of tabSrc) {
      await c.query(`create schema if not exists ${qi(s)}`);
      const { rows: ex } = await c.query(`select 1 from information_schema.tables where table_schema = $1 and table_name = $2`, [s, t]);
      if (!ex.length) {
        const { rows: cols } = await src.query(`select a.attname n, format_type(a.atttypid, a.atttypmod) ty from pg_attribute a
          join pg_class c on c.oid = a.attrelid join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = $1 and c.relname = $2 and a.attnum > 0 and not a.attisdropped order by a.attnum`, [s, t]);
        await c.query(`create table ${qi(s)}.${qi(t)} (${cols.map(x => `${qi(x.n)} ${x.ty}`).join(', ')})`);
        report.saltate.push(`${s}.${t} (creata: mancava)`);
      }
    }
    const nomi = tabSrc.map(x => `${qi(x.s)}.${qi(x.t)}`);
    await c.query('begin');
    // vincoli tra tabelle controllati alla fine (così l'ordine di copia non conta)
    const { rows: fks } = await c.query(`select con.conname, n.nspname s, cl.relname t from pg_constraint con
      join pg_class cl on cl.oid = con.conrelid join pg_namespace n on n.oid = cl.relnamespace
      where con.contype = 'f' and not con.condeferrable and ${sch}`);
    for (const f of fks) await c.query(`alter table ${qi(f.s)}.${qi(f.t)} alter constraint ${qi(f.conname)} deferrable initially deferred`);
    await c.query('set constraints all deferred');
    if (nomi.length) await c.query(`truncate ${nomi.join(', ')} cascade`); // via i dati di prova creati all'avvio
    for (const { s, t } of tabSrc) {
      const { rows: colsDst } = await c.query(`select column_name n from information_schema.columns
        where table_schema = $1 and table_name = $2 and is_generated = 'NEVER' and coalesce(identity_generation, '') <> 'ALWAYS' order by ordinal_position`, [s, t]);
      const { rows: colsSrc } = await src.query(`select column_name n from information_schema.columns where table_schema = $1 and table_name = $2`, [s, t]);
      const cols = colsDst.map(x => x.n).filter(n => colsSrc.some(y => y.n === n));
      if (!cols.length) continue;
      const lista = cols.map(qi).join(', ');
      // tabelle con file (buste paga, allegati): poche righe per volta, per non riempire la memoria
      const { rows: bin } = await c.query(`select 1 from information_schema.columns where table_schema = $1 and table_name = $2 and data_type = 'bytea' limit 1`, [s, t]);
      const lotto = bin.length ? 4 : 300;
      let copiate = 0;
      for (let off = 0; ; off += lotto) {
        const { rows } = await src.query(`select ${lista} from ${qi(s)}.${qi(t)} order by ctid limit ${lotto} offset ${off}`);
        if (!rows.length) break;
        const vals = [], ph = rows.map((r, i) => '(' + cols.map((n, j) => { vals.push(r[n]); return '$' + (i * cols.length + j + 1); }).join(',') + ')');
        await c.query(`insert into ${qi(s)}.${qi(t)} (${lista}) values ${ph.join(',')}`, vals);
        copiate += rows.length;
        if (rows.length < lotto) break;
      }
      report.tabelle[`${s}.${t}`] = copiate;
    }
    // contatori (numeri progressivi di richieste, ordini, prenotazioni…)
    const { rows: seqs } = await src.query(`select n.nspname s, c.relname q from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'S' and ${sch}`);
    for (const { s, q } of seqs) {
      const { rows: v } = await src.query(`select last_value, is_called from ${qi(s)}.${qi(q)}`);
      const { rows: ex } = await c.query(`select 1 from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind = 'S' and n.nspname = $1 and c.relname = $2`, [s, q]);
      if (ex.length) { await c.query(`select setval($1, $2, $3)`, [`${qi(s)}.${qi(q)}`, v[0].last_value, v[0].is_called === 't' || v[0].is_called === true]); report.sequenze++; }
    }
    await c.query('commit'); // qui Postgres controlla tutti i vincoli tra tabelle
    for (const f of fks) await c.query(`alter table ${qi(f.s)}.${qi(f.t)} alter constraint ${qi(f.conname)} not deferrable`).catch(() => {});
    // controllo finale: stesse righe nel vecchio e nel nuovo
    for (const { s, t } of tabSrc) {
      const a = +(await src.query(`select count(*) n from ${qi(s)}.${qi(t)}`)).rows[0].n;
      const b = +(await c.query(`select count(*) n from ${qi(s)}.${qi(t)}`)).rows[0].n;
      if (a !== b) report.differenze.push(`${s}.${t}: vecchio ${a}, nuovo ${b}`);
    }
    report.secondi = Math.round((Date.now() - t0) / 1000);
    const esito = report.differenze.length ? 'differenze' : 'ok';
    await c.query(`insert into public._trasloco (esito, resoconto) values ($1, $2)`, [esito, JSON.stringify(report)]);
    const tot = Object.values(report.tabelle).reduce((x, y) => x + y, 0);
    console.log(`Trasloco: ${esito.toUpperCase()} · ${Object.keys(report.tabelle).length} tabelle, ${tot} righe, ${report.sequenze} contatori, ${report.secondi} s`);
    if (report.saltate.length) console.log('Trasloco, note:', report.saltate.join(' · '));
    if (report.differenze.length) throw new Error('righe diverse: ' + report.differenze.join(' · '));
    return true;
  } catch (e) {
    await c.query('rollback').catch(() => {});
    await dst.query(`insert into public._trasloco (esito, resoconto) values ('errore', $1)`, [JSON.stringify({ errore: e.message, ...report })]).catch(() => {});
    throw e;
  } finally {
    c.release(); await src.end().catch(() => {}); await dst.end().catch(() => {});
  }
}

module.exports = { eseguiSeServe };
