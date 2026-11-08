// Gestione amministrativa · RAFFRONTO PREZZI
// 1) Listini: si caricano da PDF, foto o Excel, si leggono con l'AI e si salvano per fornitore (voci modificabili).
// 2) Confronto fattura: la fattura (PDF, foto o Excel) si legge e si confronta con il listino del fornitore:
//    voce corretta, più cara (rosso), più economica (verde), non a listino (si può aggiungere al listino).
//    Della fattura NON si salva niente: il report si stampa o si scarica, poi si esce.
const multer = require('multer');
const JSZip = require('jszip');
const crypto = require('crypto');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 } });
const newId = () => crypto.randomUUID();
const str = (v, n = 300) => String(v ?? '').trim().slice(0, n);
const num = v => {
  if (typeof v === 'number') return isFinite(v) ? v : null;
  let s = String(v ?? '').replace(/[€\s]/g, '');
  if (!s) return null;
  if (/,\d{1,4}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.'); // 1.234,56 → 1234.56
  else s = s.replace(/,/g, '');
  const n = parseFloat(s);
  return isFinite(n) ? n : null;
};

/* ---------- lettura dei file ---------- */
// Excel .xlsx (è uno zip di XML): tutti i fogli in righe di testo separate da tab
async function leggiXlsx(buf) {
  const zip = await JSZip.loadAsync(buf);
  const xmlTxt = s => s.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');
  const shared = [];
  const ss = zip.file('xl/sharedStrings.xml');
  if (ss) for (const m of (await ss.async('string')).matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(xmlTxt(m[1]));
  const fogli = Object.keys(zip.files).filter(f => /^xl\/worksheets\/sheet\d+\.xml$/.test(f)).sort((a, b) => parseInt(a.match(/\d+/)) - parseInt(b.match(/\d+/)));
  const out = [];
  for (const f of fogli) {
    const xml = await zip.file(f).async('string');
    for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const celle = [];
      for (const c of r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const at = c[1], body = c[2] || '';
        const col = (at.match(/r="([A-Z]+)\d+"/) || [])[1] || '';
        const t = (at.match(/t="(\w+)"/) || [])[1];
        let v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (t === 's' && v !== undefined) v = shared[+v] || '';
        else if (t === 'inlineStr') v = xmlTxt((body.match(/<is>([\s\S]*?)<\/is>/) || [])[1] || '');
        else if (v !== undefined) v = xmlTxt(v);
        const idx = col.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        if (idx >= 0) celle[idx] = v ?? '';
      }
      const riga = Array.from(celle, x => x ?? '').join('\t').trim();
      if (riga) out.push(riga);
    }
    out.push('');
  }
  return out.join('\n');
}
// il file → blocchi di contenuto per Claude (documento PDF, immagine o testo)
async function contenuto(file) {
  const nome = (file.originalname || '').toLowerCase(), b = file.buffer;
  if (nome.endsWith('.pdf') || b.slice(0, 5).toString() === '%PDF-')
    return [{ type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: b.toString('base64') } }];
  const img = /^image\/(jpeg|png|webp|gif)$/.exec(file.mimetype || '') || (/\.(jpe?g|png|webp|gif)$/.exec(nome) && [null, nome.split('.').pop().replace('jpg', 'jpeg')]);
  if (img) return [{ type: 'image', source: { type: 'base64', media_type: 'image/' + img[1], data: b.toString('base64') } }];
  if (nome.endsWith('.xlsx') || nome.endsWith('.xlsm')) {
    const t = await leggiXlsx(b);
    if (!t.trim()) throw Object.assign(new Error('Il file Excel è vuoto.'), { status: 400 });
    return [{ type: 'text', text: 'Contenuto del file Excel (colonne separate da tabulazioni):\n' + t.slice(0, 180000) }];
  }
  if (nome.endsWith('.csv') || nome.endsWith('.txt') || /^text\//.test(file.mimetype || ''))
    return [{ type: 'text', text: 'Contenuto del file:\n' + b.toString('utf8').slice(0, 180000) }];
  if (nome.endsWith('.xls')) throw Object.assign(new Error('I vecchi file .xls non si leggono: aprilo in Excel e salvalo come .xlsx (oppure carica il PDF).'), { status: 400 });
  throw Object.assign(new Error('Carica un PDF, una foto (JPG, PNG) o un file Excel (.xlsx o .csv).'), { status: 400 });
}
async function chiediAI(blocchi, prompt, maxTokens = 16000) {
  const txt = await require('../lib/consumo').chiedi('prezzi_letture', null, [{ role: 'user', content: [...blocchi, { type: 'text', text: prompt }] }], maxTokens, 'Lettura listini e fatture', { model: process.env.PREZZI_AI_MODEL || process.env.ASO_AI_MODEL, timeout: 170000 });
  try { return JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)); }
  catch { throw Object.assign(new Error('Non sono riuscito a leggere le voci del documento. Prova con un file più nitido.'), { status: 502 }); }
}
const pulisciVoce = v => ({ codice: str(v.codice, 60), descrizione: str(v.descrizione, 400), um: str(v.um, 20), prezzo: num(v.prezzo) });

const PROMPT_LISTINO = `Il documento è un listino prezzi o un preventivo di un fornitore (può essere una foto, un PDF o un foglio Excel).
Estrai TUTTE le voci con il loro prezzo unitario. Non inventare nulla: se un dato manca lascialo vuoto.
Rispondi SOLO con JSON: {"fornitore":"nome del fornitore se scritto","voci":[{"codice":"codice articolo se c'è","descrizione":"descrizione della voce","um":"unità di misura (pz, kg, ora…) se c'è","prezzo":12.50}]}
- "prezzo": numero con il punto decimale, prezzo unitario netto IVA esclusa se il documento lo distingue (altrimenti quello indicato).
- Ignora intestazioni, totali, note legali e condizioni di vendita.`;
const promptFattura = voci => `Il documento è una fattura (o un DDT) di un fornitore. Estrai tutte le righe con quantità, prezzo unitario e importo.
Poi confronta ogni riga con questo LISTINO del fornitore (id, codice, descrizione, unità di misura, prezzo unitario):
${voci.map(v => `${v.id} | ${v.codice || '-'} | ${v.descrizione} | ${v.um || '-'} | ${v.prezzo ?? '-'}`).join('\n') || '(listino vuoto)'}
Per ogni riga della fattura indica in "listino_id" l'id della voce di listino che corrisponde allo stesso prodotto o servizio (stesso codice, oppure stessa descrizione anche se scritta in modo diverso); usa null se nel listino non c'è.
Rispondi SOLO con JSON: {"fornitore":"","numero":"","data":"","voci":[{"codice":"","descrizione":"","quantita":1,"um":"","prezzo":10.0,"importo":10.0,"listino_id":null,"nota":""}]}
- "prezzo": prezzo unitario della riga (netto, IVA esclusa), numero con il punto decimale. Se manca ma ci sono quantità e importo, calcolalo.
- "nota": solo se serve (es. "unità di misura diversa dal listino", "sconto in riga").
- Non includere righe di totale, IVA, spese di incasso o trasporto se non sono vere voci di prodotto/servizio (le spese di trasporto, se fatturate, sono una voce).`;

module.exports = function (app, { store, needUser, wrap, bad, sendPage }) {
  const accesso = async req => {
    const r = req.user && (req.user.owner ? 'admin' : req.apps?.prezzi);
    if (!r) return null;
    if (r !== 'admin' && (await store.appSpente()).has('prezzi')) return null;
    return r;
  };
  const need = wrap(async (req, res, next) => (await accesso(req)) ? next() : bad(res, 403, 'Non sei abilitato al Raffronto prezzi.'));
  const migra = store.q(`create table if not exists prezzi_listini (
      id text primary key, fornitore text not null, nome text not null default '', note text not null default '',
      creato_il timestamptz not null default now(), creato_da text not null default '', aggiornato_il timestamptz not null default now(), aggiornato_da text not null default '');
    create table if not exists prezzi_voci (
      id text primary key, listino_id text not null references prezzi_listini(id) on delete cascade,
      ordine int not null default 0, codice text not null default '', descrizione text not null, um text not null default '', prezzo numeric,
      aggiunta_da_fattura boolean not null default false, creato_il timestamptz not null default now());
    create index if not exists prezzi_voci_listino_idx on prezzi_voci(listino_id, ordine);`).catch(e => console.warn('Raffronto prezzi: tabelle non create:', e.message));
  const nomeDi = u => `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email;
  const shapeL = r => ({ id: r.id, fornitore: r.fornitore, nome: r.nome, note: r.note, creatoIl: r.creato_il, aggiornatoIl: r.aggiornato_il, aggiornatoDa: r.aggiornato_da, nVoci: Number(r.n_voci || 0) });
  const shapeV = r => ({ id: r.id, codice: r.codice, descrizione: r.descrizione, um: r.um, prezzo: r.prezzo === null ? null : Number(r.prezzo), daFattura: r.aggiunta_da_fattura });
  async function vociDi(id) { return (await store.q('select * from prezzi_voci where listino_id = $1 order by ordine, creato_il', [id])).rows.map(shapeV); }
  async function salvaVoci(client, listinoId, voci) {
    await client.query('delete from prezzi_voci where listino_id = $1', [listinoId]);
    let i = 0;
    for (const v of voci) {
      const p = pulisciVoce(v); if (!p.descrizione) continue;
      await client.query('insert into prezzi_voci (id, listino_id, ordine, codice, descrizione, um, prezzo, aggiunta_da_fattura) values ($1,$2,$3,$4,$5,$6,$7,$8)',
        [newId(), listinoId, i++, p.codice, p.descrizione, p.um, p.prezzo, !!v.daFattura]);
    }
  }

  // pagina
  app.get(['/amm/prezzi', '/amm/prezzi/'], wrap(async (req, res) => {
    if (!req.user) return res.redirect('/accedi?next=' + encodeURIComponent('/amm/prezzi'));
    if (!await accesso(req)) return res.redirect('/?noaccess=prezzi');
    sendPage('prezzi.html')(req, res);
  }));
  // lettura (listino o fattura): il file non viene salvato
  app.post('/api/prezzi/leggi-listino', needUser, need, upload.single('file'), wrap(async (req, res) => {
    if (!req.file) return bad(res, 400, 'Scegli il file del listino.');
    const o = await chiediAI(await contenuto(req.file), PROMPT_LISTINO);
    const voci = (Array.isArray(o.voci) ? o.voci : []).map(pulisciVoce).filter(v => v.descrizione).slice(0, 2000);
    res.json({ fornitore: str(o.fornitore, 160), voci });
  }));
  app.post('/api/prezzi/leggi-fattura', needUser, need, upload.single('file'), wrap(async (req, res) => {
    if (!req.file) return bad(res, 400, 'Scegli il file della fattura.');
    const id = str(req.body.listino, 60);
    const { rows: [l] } = await store.q('select * from prezzi_listini where id = $1', [id]);
    if (!l) return bad(res, 400, 'Scegli il listino del fornitore con cui confrontare.');
    const listino = await vociDi(id);
    const o = await chiediAI(await contenuto(req.file), promptFattura(listino));
    const perId = new Map(listino.map(v => [v.id, v]));
    const righe = (Array.isArray(o.voci) ? o.voci : []).map(v => {
      const r = { ...pulisciVoce(v), quantita: num(v.quantita), importo: num(v.importo), nota: str(v.nota, 200) };
      if (r.prezzo === null && r.importo !== null && r.quantita) r.prezzo = Math.round(r.importo / r.quantita * 10000) / 10000;
      const lv = v.listino_id ? perId.get(String(v.listino_id)) : null;
      if (!lv) return { ...r, stato: 'nuova' };
      const diff = r.prezzo !== null && lv.prezzo !== null ? r.prezzo - lv.prezzo : null;
      const tol = lv.prezzo ? Math.max(0.01, Math.abs(lv.prezzo) * 0.005) : 0.01;
      const stato = diff === null ? 'da_verificare' : Math.abs(diff) <= tol ? 'ok' : diff > 0 ? 'piu' : 'meno';
      return { ...r, stato, listino: { id: lv.id, codice: lv.codice, descrizione: lv.descrizione, um: lv.um, prezzo: lv.prezzo },
        diff, diffPct: diff !== null && lv.prezzo ? diff / lv.prezzo : null, diffTot: diff !== null ? diff * (r.quantita || 1) : null };
    }).filter(r => r.descrizione);
    res.json({ fornitore: str(o.fornitore, 160), numero: str(o.numero, 60), data: str(o.data, 40), listino: shapeL({ ...l, n_voci: listino.length }), righe });
  }));
  // listini
  app.get('/api/prezzi/listini', needUser, need, wrap(async (req, res) => {
    await migra;
    const { rows } = await store.q('select l.*, (select count(*) from prezzi_voci v where v.listino_id = l.id) as n_voci from prezzi_listini l order by lower(l.fornitore), lower(l.nome)');
    res.json({ listini: rows.map(shapeL), ai: !!(process.env.ANTHROPIC_API_KEY || process.env.GEMINI_API_KEY) });
  }));
  app.get('/api/prezzi/listini/:id', needUser, need, wrap(async (req, res) => {
    const { rows: [l] } = await store.q('select * from prezzi_listini where id = $1', [str(req.params.id, 60)]);
    if (!l) return bad(res, 404, 'Listino non trovato.');
    const voci = await vociDi(l.id);
    res.json({ listino: shapeL({ ...l, n_voci: voci.length }), voci });
  }));
  app.post('/api/prezzi/listini', needUser, need, wrap(async (req, res) => {
    await migra;
    const fornitore = str(req.body.fornitore, 160), voci = Array.isArray(req.body.voci) ? req.body.voci.slice(0, 2000) : [];
    if (!fornitore) return bad(res, 400, 'Scrivi il nome del fornitore.');
    const id = newId(), chi = nomeDi(req.user), client = await store.pool.connect();
    try {
      await client.query('begin');
      await client.query('insert into prezzi_listini (id, fornitore, nome, note, creato_da, aggiornato_da) values ($1,$2,$3,$4,$5,$5)', [id, fornitore, str(req.body.nome, 160), str(req.body.note, 1000), chi]);
      await salvaVoci(client, id, voci);
      await client.query('commit');
    } catch (e) { await client.query('rollback').catch(() => {}); throw e; } finally { client.release(); }
    res.json({ id });
  }));
  // modifica: dati del listino e (se mandate) tutte le voci
  app.put('/api/prezzi/listini/:id', needUser, need, wrap(async (req, res) => {
    const id = str(req.params.id, 60);
    const { rows: [l] } = await store.q('select id from prezzi_listini where id = $1', [id]);
    if (!l) return bad(res, 404, 'Listino non trovato.');
    const fornitore = str(req.body.fornitore, 160);
    if (!fornitore) return bad(res, 400, 'Scrivi il nome del fornitore.');
    const client = await store.pool.connect();
    try {
      await client.query('begin');
      await client.query('update prezzi_listini set fornitore = $2, nome = $3, note = $4, aggiornato_il = now(), aggiornato_da = $5 where id = $1', [id, fornitore, str(req.body.nome, 160), str(req.body.note, 1000), nomeDi(req.user)]);
      if (Array.isArray(req.body.voci)) await salvaVoci(client, id, req.body.voci.slice(0, 2000));
      await client.query('commit');
    } catch (e) { await client.query('rollback').catch(() => {}); throw e; } finally { client.release(); }
    res.json({ ok: true });
  }));
  // voce nuova trovata in fattura → aggiunta al listino
  app.post('/api/prezzi/listini/:id/voci', needUser, need, wrap(async (req, res) => {
    const id = str(req.params.id, 60), p = pulisciVoce(req.body);
    if (!p.descrizione) return bad(res, 400, 'Manca la descrizione della voce.');
    const { rows: [l] } = await store.q('select id from prezzi_listini where id = $1', [id]);
    if (!l) return bad(res, 404, 'Listino non trovato.');
    const { rows: [m] } = await store.q('select coalesce(max(ordine), -1) + 1 as n from prezzi_voci where listino_id = $1', [id]);
    const vid = newId();
    await store.q('insert into prezzi_voci (id, listino_id, ordine, codice, descrizione, um, prezzo, aggiunta_da_fattura) values ($1,$2,$3,$4,$5,$6,$7,true)', [vid, id, m.n, p.codice, p.descrizione, p.um, p.prezzo]);
    await store.q('update prezzi_listini set aggiornato_il = now(), aggiornato_da = $2 where id = $1', [id, nomeDi(req.user)]);
    res.json({ id: vid });
  }));
  app.delete('/api/prezzi/listini/:id', needUser, need, wrap(async (req, res) => {
    await store.q('delete from prezzi_listini where id = $1', [str(req.params.id, 60)]);
    res.json({ ok: true });
  }));
  // errori di caricamento (file troppo grande ecc.)
  app.use('/api/prezzi', (err, req, res, next) => {
    if (err instanceof multer.MulterError) return bad(res, 400, err.code === 'LIMIT_FILE_SIZE' ? 'Il file è troppo grande (massimo 20 MB).' : 'Caricamento non valido.');
    if (err.status) return bad(res, err.status, err.message);
    next(err);
  });
};
