// AlfaDocs → Consuntivo di Gestione finanziaria (To Smile): incassato e produzione di ogni sede, dall'1 del mese a oggi.
// Ogni notte alle 03:30 (e con «Aggiorna adesso»); il giorno 1 si chiude anche il mese appena finito.
// Si scrive solo il mese indicato; Gestione finanziaria salva prima una copia e segnala i numeri scritti a mano diversi.
const { Pool } = require('pg');
const S = require('../lib/suite');
const AD = require('../lib/alfadocs');
const FIN = require('../lib/finanza');

const url = process.env.DATABASE_URL || '';
const pool = new Pool({ connectionString: url, ssl: process.env.PGSSL === 'true' || /\.render\.com/.test(url) ? { rejectUnauthorized: false } : false, max: 2 });
const q = (t, p) => pool.query(t, p);
let pronto = null;
const migrate = () => pronto || (pronto = q(`create schema if not exists suite;
  create table if not exists suite.alfadocs_mappa (slug text not null, sede text not null, site_id text not null, primary key (slug, sede));
  create table if not exists suite.alfadocs_esiti (slug text not null, mese text not null, sede text not null, incassato numeric, produzione numeric,
    prestazioni int, stato text not null default '', errore text not null default '', aggiornato timestamptz not null default now(), primary key (slug, mese, sede));
  create table if not exists suite.alfadocs_differenze (id serial primary key, slug text not null, mese text not null, sede text not null, site_id text not null,
    campo text not null, prima numeric not null, alfadocs numeric not null, il timestamptz not null default now(), esito text not null default '')`));
const SLUG = 'tosmile';
const roma = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
const fineMese = (anno, mese) => new Date(Date.UTC(anno, mese, 0)).toISOString().slice(0, 10);

let corsa = null; // aggiornamento in corso (uno alla volta)
const stato = { inCorso: false, sedeInCorso: '', iniziato: null, finito: null };

async function sediFinanza(anno, mese) {
  const az = await FIN.aziendaToSmile(); if (!az) throw new Error('Non trovo l’azienda To Smile in Gestione finanziaria.');
  const c = await FIN.chiama(`/api/_appgestione/consuntivo?azienda=${encodeURIComponent(az)}&anno=${anno}&mese=${mese}`);
  return { azienda: az, anno: c.annoNelGestionale, sedi: (c.sedi || []).map(s => ({ id: s.id, nome: s.nome })) };
}
async function mappa() { await migrate(); return Object.fromEntries((await q('select sede, site_id from suite.alfadocs_mappa where slug = $1', [SLUG])).rows.map(r => [r.sede, r.site_id])); }

// aggiorna un mese (anno, mese 1-12) per tutte le sedi con la chiave
async function aggiornaMese(anno, mese, finoA) {
  const da = `${anno}-${String(mese).padStart(2, '0')}-01`, a = finoA || fineMese(anno, mese), chiaveMese = da.slice(0, 7);
  const fin = await sediFinanza(anno, mese), M = await mappa();
  if (fin.anno !== anno) throw new Error(`In Gestione finanziaria il consuntivo aperto è del ${fin.anno}: il ${anno} non si aggiorna.`);
  const daScrivere = [];
  for (const sede of AD.chiavi()) {
    stato.sedeInCorso = sede;
    const site = M[sede] ? fin.sedi.find(s => s.id === M[sede]) : FIN.trova(fin.sedi, sede);
    try {
      if (!site) throw new Error('scegli a quale sede del consuntivo va');
      const r = await AD.calcola(AD.chiaveDi(sede), da, a);
      daScrivere.push({ sede, siteId: site.id, incassato: r.incassato, produzione: r.produzione, prestazioni: r.prestazioni });
    } catch (e) {
      await q(`insert into suite.alfadocs_esiti (slug, mese, sede, stato, errore) values ($1,$2,$3,'errore',$4)
        on conflict (slug, mese, sede) do update set stato = 'errore', errore = excluded.errore, aggiornato = now()`, [SLUG, chiaveMese, sede, String(e.message).slice(0, 300)]);
    }
  }
  if (!daScrivere.length) return;
  const r = await FIN.scrivi('/api/_appgestione/alfadocs', { azienda: fin.azienda, anno, mese, sedi: daScrivere.map(x => ({ sedeId: x.siteId, incassato: x.incassato, produzione: x.produzione })) });
  for (const x of daScrivere) {
    await q(`insert into suite.alfadocs_esiti (slug, mese, sede, incassato, produzione, prestazioni, stato, errore) values ($1,$2,$3,$4,$5,$6,'ok','')
      on conflict (slug, mese, sede) do update set incassato = excluded.incassato, produzione = excluded.produzione, prestazioni = excluded.prestazioni, stato = 'ok', errore = '', aggiornato = now()`,
      [SLUG, chiaveMese, x.sede, x.incassato, x.produzione, x.prestazioni]);
  }
  for (const d of r.differenze || []) {
    const sede = (daScrivere.find(x => x.siteId === d.sedeId) || {}).sede || '';
    await q(`insert into suite.alfadocs_differenze (slug, mese, sede, site_id, campo, prima, alfadocs) values ($1,$2,$3,$4,$5,$6,$7)`, [SLUG, chiaveMese, sede, d.sedeId, d.campo, d.prima, d.alfadocs]);
  }
  console.log(`AlfaDocs → Consuntivo: ${chiaveMese} aggiornato per ${daScrivere.length} sedi${(r.differenze || []).length ? `, ${r.differenze.length} differenze da vedere` : ''}`);
}
function aggiorna() {
  if (corsa) return corsa;
  stato.inCorso = true; stato.iniziato = new Date().toISOString();
  corsa = (async () => {
    await migrate();
    const oggi = roma(), anno = +oggi.slice(0, 4), mese = +oggi.slice(5, 7);
    // il giorno 1 (e il 2, se la notte prima non è andata) si chiude il mese appena finito
    if (+oggi.slice(8, 10) <= 2) { const pa = mese === 1 ? anno - 1 : anno, pm = mese === 1 ? 12 : mese - 1; await aggiornaMese(pa, pm).catch(e => console.error('AlfaDocs → Consuntivo (mese finito):', e.message)); }
    await aggiornaMese(anno, mese, oggi);
  })().catch(e => console.error('AlfaDocs → Consuntivo:', e.message)).finally(() => { corsa = null; stato.inCorso = false; stato.sedeInCorso = ''; stato.finito = new Date().toISOString(); });
  return corsa;
}

function monta(app, { wrap, bad }) {
  if (S.TENANT) return; // per ora solo To Smile
  const soloTitolare = (req, res, next) => req.user?.owner ? next() : bad(res, 403, 'Solo il proprietario.');
  app.get('/api/collegamenti/alfadocs/consuntivo', soloTitolare, wrap(async (req, res) => {
    await migrate();
    const oggi = roma(), anno = +oggi.slice(0, 4), mese = +oggi.slice(5, 7), chiaveMese = oggi.slice(0, 7);
    let fin = null, errFin = '';
    try { fin = await sediFinanza(anno, mese); } catch (e) { errFin = FIN.messaggio(e); }
    const M = await mappa();
    const esiti = Object.fromEntries((await q('select * from suite.alfadocs_esiti where slug = $1 and mese = $2', [SLUG, chiaveMese])).rows.map(r => [r.sede, r]));
    const sedi = AD.chiavi().map(sede => {
      const site = fin ? (M[sede] ? fin.sedi.find(s => s.id === M[sede]) : FIN.trova(fin.sedi, sede)) : null;
      const e = esiti[sede];
      return { sede, siteId: site?.id || '', sceltaAMano: !!M[sede], incassato: e ? Number(e.incassato) : null, produzione: e ? Number(e.produzione) : null,
        prestazioni: e?.prestazioni ?? null, stato: e?.stato || '', errore: e?.errore || '', aggiornato: e?.aggiornato || null };
    });
    const { rows: diff } = await q(`select id, mese, sede, campo, prima, alfadocs, il from suite.alfadocs_differenze where slug = $1 and esito = '' order by il`, [SLUG]);
    res.set('Cache-Control', 'no-store').json({ mese: chiaveMese, sedi, sediConsuntivo: fin?.sedi || [], errFin, stato,
      differenze: diff.map(d => ({ ...d, prima: Number(d.prima), alfadocs: Number(d.alfadocs) })) });
  }));
  app.post('/api/collegamenti/alfadocs/consuntivo/aggiorna', soloTitolare, (req, res) => { aggiorna(); res.json({ ok: true, stato }); });
  app.put('/api/collegamenti/alfadocs/consuntivo/mappa', soloTitolare, wrap(async (req, res) => {
    await migrate();
    const sede = String(req.body?.sede || ''), site = String(req.body?.siteId || '');
    if (!AD.chiavi().includes(sede)) return bad(res, 400, 'Sede non valida.');
    if (site) await q(`insert into suite.alfadocs_mappa (slug, sede, site_id) values ($1,$2,$3) on conflict (slug, sede) do update set site_id = excluded.site_id`, [SLUG, sede, site]);
    else await q('delete from suite.alfadocs_mappa where slug = $1 and sede = $2', [SLUG, sede]); // torna alla scelta automatica per nome
    res.json({ ok: true });
  }));
  // differenza: «visto» oppure «rimetti il mio valore» (la casella resta a mano per quel mese)
  app.post('/api/collegamenti/alfadocs/consuntivo/differenza/:id', soloTitolare, wrap(async (req, res) => {
    await migrate();
    const { rows: [d] } = await q(`select * from suite.alfadocs_differenze where id = $1 and slug = $2 and esito = ''`, [parseInt(req.params.id, 10) || 0, SLUG]);
    if (!d) return bad(res, 404, 'Differenza già gestita.');
    if (req.body?.azione === 'ripristina') {
      const az = await FIN.aziendaToSmile();
      try { await FIN.scrivi('/api/_appgestione/alfadocs/ripristina', { azienda: az, anno: +d.mese.slice(0, 4), mese: +d.mese.slice(5, 7), sedeId: d.site_id, campo: d.campo, valore: Number(d.prima) }); }
      catch (e) { return bad(res, 502, FIN.messaggio(e)); }
    }
    await q(`update suite.alfadocs_differenze set esito = $2 where id = $1`, [d.id, req.body?.azione === 'ripristina' ? 'ripristinato' : 'visto']);
    res.json({ ok: true });
  }));
}
// ogni 10 minuti: alle 03:30 (ora italiana) parte l'aggiornamento della notte, una volta al giorno
let fattoIl = '';
function pianifica() {
  if (S.TENANT) return;
  setInterval(() => {
    if (!AD.configurato()) return;
    const ora = new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
    const g = roma();
    if (ora >= '03:30' && ora < '05:00' && fattoIl !== g) { fattoIl = g; aggiorna(); }
  }, 10 * 60000).unref();
}
module.exports = { monta, pianifica, aggiorna };
