// Ricerca dei passaggi pertinenti (per parole + per significato) da mandare all'assistente.
// Finché i documenti sono pochi l'assistente li legge tutti; oltre la soglia legge solo i brani trovati.
const db = require('./db');
const ai = require('./ai');

const THRESHOLD_DOCS = +process.env.RAG_THRESHOLD || 20;   // oltre questo numero di documenti si usa la ricerca
const THRESHOLD_CHARS = 120000;                            // ...oppure oltre questa quantità di testo
const TOP_CHUNKS = +process.env.RAG_TOP || 10;             // brani mandati all'assistente
const FULL_IF_SELECTED = 3;                                 // se l'utente sceglie fino a 3 fonti, le legge per intero

/* ---------- tabella dei brani ---------- */
async function migrate() {
  await db.q(`
    create table if not exists chunks (
      id bigserial primary key,
      doc_id text not null references docs(id) on delete cascade,
      idx int not null,
      doc_title text not null default '',
      heading text not null default '',
      text text not null,
      tsv tsvector generated always as (
        setweight(to_tsvector('italian', doc_title), 'A') || setweight(to_tsvector('italian', heading), 'B') || to_tsvector('italian', text)) stored,
      embedding real[],
      emb_model text
    );
    create index if not exists chunks_doc_idx on chunks(doc_id);
    create index if not exists chunks_tsv_idx on chunks using gin(tsv);
    alter table docs add column if not exists indexed_at timestamptz;
  `);
}

/* ---------- divisione in brani ---------- */
// Divide per titoli (## ...), poi per paragrafi in brani di circa 1.000 caratteri.
function chunkText(body) {
  const lines = String(body || '').replace(/\r/g, '').split('\n');
  const sections = []; let cur = { heading: '', lines: [] };
  for (const l of lines) {
    const m = l.match(/^#{1,4}\s+(.*)/);
    if (m) { if (cur.lines.join('').trim()) sections.push(cur); cur = { heading: m[1].trim(), lines: [] }; }
    else cur.lines.push(l);
  }
  if (cur.lines.join('').trim() || !sections.length) sections.push(cur);
  const out = [];
  for (const s of sections) {
    const paras = s.lines.join('\n').split(/\n\s*\n/).map(p => p.trim()).filter(Boolean);
    let buf = '';
    const flush = () => { if (buf.trim()) out.push({ heading: s.heading, text: buf.trim() }); buf = ''; };
    for (const p of paras) {
      if (p.length > 1400) { // paragrafo lunghissimo (tipico dei PDF): taglia per frasi
        flush();
        const sent = p.split(/(?<=[.!?;:])\s+/); let b = '';
        for (const x of sent) { if ((b + ' ' + x).length > 1000 && b) { out.push({ heading: s.heading, text: b.trim() }); b = b.slice(-150); } b += ' ' + x; }
        if (b.trim()) out.push({ heading: s.heading, text: b.trim() });
        continue;
      }
      if ((buf + '\n\n' + p).length > 1000 && buf) flush();
      buf += (buf ? '\n\n' : '') + p;
    }
    flush();
  }
  return out;
}

/* ---------- indicizzazione ---------- */
const vecCache = new Map(); // doc_id -> [{id, vec}]

async function reindexDoc(docId) {
  const { rows } = await db.q('select id, title, body from docs where id = $1', [docId]);
  vecCache.delete(docId);
  if (!rows[0]) return;
  const d = rows[0], parts = chunkText(d.body);
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    await client.query('delete from chunks where doc_id = $1', [docId]);
    for (let i = 0; i < parts.length; i++) {
      await client.query('insert into chunks (doc_id, idx, doc_title, heading, text) values ($1,$2,$3,$4,$5)', [docId, i, d.title, parts[i].heading, parts[i].text]);
    }
    await client.query('update docs set indexed_at = now() where id = $1', [docId]);
    await client.query('commit');
  } catch (e) { await client.query('rollback'); throw e; } finally { client.release(); }
  await embedMissing(docId).catch(e => console.warn('Impronte non calcolate:', e.message));
}

// Calcola le impronte mancanti o fatte con un altro modello (es. dopo un cambio di fornitore).
async function embedMissing(docId) {
  const info = ai.embedInfo(); if (!info.ok) return 0;
  const { rows } = await db.q(`select c.id, c.heading, c.text, d.title from chunks c join docs d on d.id = c.doc_id
    where (c.emb_model is distinct from $1) ${docId ? 'and c.doc_id = $2' : ''} order by c.id limit 2000`, docId ? [info.id, docId] : [info.id]);
  if (!rows.length) return 0;
  for (let i = 0; i < rows.length; i += 50) {
    const batch = rows.slice(i, i + 50);
    const vecs = await ai.embed(batch.map(r => `${r.title}${r.heading ? ' — ' + r.heading : ''}\n${r.text}`), 'doc');
    for (let k = 0; k < batch.length; k++) await db.q('update chunks set embedding = $2, emb_model = $3 where id = $1', [batch[k].id, vecs[k], info.id]);
  }
  vecCache.clear();
  return rows.length;
}

// All'avvio: indicizza i documenti mai indicizzati e completa le impronte, in sottofondo.
async function indexAll() {
  const { rows } = await db.q('select id from docs where indexed_at is null or indexed_at < updated_at');
  for (const r of rows) await reindexDoc(r.id).catch(e => console.warn('Indicizzazione non riuscita', r.id, e.message));
  let n; do { n = await embedMissing().catch(e => { console.warn('Impronte non calcolate:', e.message); return 0; }); } while (n >= 2000);
}

/* ---------- ricerca ---------- */
const STOP = new Set('il lo la i gli le un uno una di a da in con su per tra fra e o ma se che chi cosa come quando dove perché del dello della dei degli delle al allo alla ai agli alle dal dalla dai dalle nel nella nei nelle sul sulla sui sulle è sono ho hai ha devo deve fare faccio mi ti si ci vi non più anche quale quali questo questa quello quella ogni quanto quanti fanno fa dopo prima dice dire posso può puoi bisogna serve'.split(' '));
function keywordQuery(q) {
  const words = String(q).toLowerCase().normalize('NFC').match(/[a-zàèéìòóù0-9]{3,}/g) || [];
  return [...new Set(words.filter(w => !STOP.has(w)))].slice(0, 20).join(' | ');
}
async function vectorsFor(docIds, model) {
  const missing = docIds.filter(id => !vecCache.has(id));
  if (missing.length) {
    const { rows } = await db.q('select id, doc_id, embedding from chunks where doc_id = any($1) and emb_model = $2 and embedding is not null', [missing, model]);
    missing.forEach(id => vecCache.set(id, []));
    rows.forEach(r => vecCache.get(r.doc_id).push({ id: +r.id, vec: r.embedding }));
  }
  return docIds.flatMap(id => vecCache.get(id) || []);
}

/**
 * docs: documenti leggibili dall'utente (già filtrati per permessi e fonti scelte)
 * question: testo da cercare (ultima domanda + la precedente)
 * explicit: true se l'utente ha scelto a mano poche fonti
 * Restituisce { mode: 'all'|'search', items: [{doc, excerpts: [{heading, text}] | null}] }
 */
async function retrieve(docs, question, explicit) {
  const total = docs.reduce((s, d) => s + (d.body || '').length, 0);
  if ((explicit && docs.length <= FULL_IF_SELECTED) || (docs.length <= THRESHOLD_DOCS && total <= THRESHOLD_CHARS)) {
    return { mode: 'all', items: docs.map(d => ({ doc: d, excerpts: null })) };
  }
  const ids = docs.map(d => d.id);
  const rank = new Map(); // chunk id -> punteggio combinato (reciprocal rank fusion)
  const add = (list) => list.forEach((id, i) => rank.set(id, (rank.get(id) || 0) + 1 / (60 + i)));

  const kq = keywordQuery(question);
  if (kq) {
    try {
      const { rows } = await db.q(`select id from chunks, to_tsquery('italian', $1) q
        where doc_id = any($2) and tsv @@ q order by ts_rank_cd(tsv, q) desc limit 25`, [kq, ids]);
      add(rows.map(r => +r.id));
    } catch (e) { console.warn('Ricerca per parole non riuscita:', e.message); }
  }
  const info = ai.embedInfo();
  if (info.ok) {
    try {
      const [qv] = await ai.embed([question], 'query');
      const cand = await vectorsFor(ids, info.id);
      const scored = cand.map(c => { let s = 0; for (let i = 0; i < qv.length; i++) s += qv[i] * c.vec[i]; return { id: c.id, s }; })
        .sort((a, b) => b.s - a.s).slice(0, 25);
      add(scored.map(x => x.id));
    } catch (e) { console.warn('Ricerca per significato non riuscita:', e.message); }
  }
  const top = [...rank.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP_CHUNKS).map(([id]) => id);
  if (!top.length) return { mode: 'search', items: [] };
  const { rows } = await db.q('select id, doc_id, idx, heading, text from chunks where id = any($1) order by doc_id, idx', [top]);
  const byDoc = new Map();
  rows.forEach(r => { if (!byDoc.has(r.doc_id)) byDoc.set(r.doc_id, []); byDoc.get(r.doc_id).push({ heading: r.heading, text: r.text }); });
  // ordine dei documenti: quello del brano migliore
  const order = [...new Set(top.map(id => rows.find(r => +r.id === id)?.doc_id).filter(Boolean))];
  return { mode: 'search', items: order.map(id => ({ doc: docs.find(d => d.id === id), excerpts: byDoc.get(id) })) };
}

module.exports = { migrate, reindexDoc, indexAll, retrieve, chunkText };
