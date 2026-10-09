// Lettura delle bolle (DDT) dei fornitori: la foto o il PDF va all'API di Claude, che restituisce
// fornitore, numero, data e righe. Poi qui si cerca chi è il fornitore e a quale articolo/categoria
// va ogni riga, usando quello che è stato registrato le volte precedenti (tabella bolla_memo).
const TIPI = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'application/pdf']);

const norm = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const normPiva = s => String(s ?? '').toUpperCase().replace(/^IT/, '').replace(/[^0-9A-Z]/g, '');
// chiavi con cui si ricorda una riga: il codice del fornitore se c'è, sempre anche la descrizione
const chiavi = r => [r.codice && 'c:' + norm(r.codice), r.descrizione && 'd:' + norm(r.descrizione)].filter(k => k && k.length > 2);

const PROMPT = `Leggi questa bolla di consegna (DDT) o fattura accompagnatoria italiana: è merce arrivata al magazzino di un gruppo di studi dentistici (To Smile).
Rispondi SOLO con un oggetto JSON, senza testo prima o dopo:
{"fornitore":{"nome":"","piva":"","email":"","telefono":"","indirizzo":""},"numero":"","data":"AAAA-MM-GG","righe":[{"codice":"","descrizione":"","quantita":0,"unita":""}],"dubbi":[]}
Regole:
- "fornitore" è chi emette e spedisce la bolla (mittente, cedente, intestazione del documento), MAI il destinatario o il luogo di consegna (To Smile, studi, GB Services).
- "righe": solo la merce. Escludi spese di trasporto, imballo, contributi, sconti, totali, acconti e righe solo descrittive.
- Lotto e scadenza NON sono righe e non vanno nella descrizione.
- "quantita": numero (virgola decimale → punto). Se ci sono colli e pezzi, usa la quantità della merce consegnata.
- "unita": come è scritta (pz, conf, CF, scatola, kg…); se manca scrivi "pz".
- "codice": il codice articolo del fornitore, se c'è.
- Se un dato non c'è o non si legge, lascia la stringa vuota e scrivi il motivo in "dubbi" (breve, in italiano).`;

async function leggi(files) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error("La lettura delle bolle non è attiva: manca ANTHROPIC_API_KEY su Render."), { status: 400 });
  const content = [];
  for (const f of files) {
    if (!TIPI.has(f.tipo)) throw Object.assign(new Error('Formato non supportato: usa una foto (JPG, PNG) o un PDF.'), { status: 400 });
    content.push(f.tipo === 'application/pdf'
      ? { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: f.dati } }
      : { type: 'image', source: { type: 'base64', media_type: f.tipo, data: f.dati } });
  }
  content.push({ type: 'text', text: PROMPT });
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.MAG_AI_MODEL || process.env.TURNI_AI_MODEL || 'claude-sonnet-5-5', max_tokens: 6000,
        messages: [{ role: 'user', content }] }),
      signal: AbortSignal.timeout(120000),
    });
  } catch { throw Object.assign(new Error('La lettura ha impiegato troppo. Riprova, magari con una foto più nitida.'), { status: 502 }); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.warn('Magazzino bolla:', r.status, JSON.stringify(j).slice(0, 300));
    const msg = r.status === 429 ? 'Troppe richieste ravvicinate: riprova tra poco.' : r.status === 401 ? 'La chiave ANTHROPIC_API_KEY non è valida.'
      : r.status === 400 ? 'Il file non si riesce a leggere: prova con una foto JPG più piccola o un PDF.' : 'Il servizio di lettura non ha risposto. Riprova tra poco.';
    throw Object.assign(new Error(msg), { status: 502 });
  }
  const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  let out;
  try { out = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)); }
  catch { throw Object.assign(new Error('Non sono riuscito a leggere la bolla. Riprova con una foto più nitida e dritta.'), { status: 502 }); }
  const s = (v, n) => String(v ?? '').trim().slice(0, n);
  const f = out.fornitore || {};
  const data = s(out.data, 10);
  return {
    fornitore: { nome: s(f.nome, 120), piva: s(f.piva, 20), email: s(f.email, 160).toLowerCase(), telefono: s(f.telefono, 40), indirizzo: s(f.indirizzo, 200) },
    numero: s(out.numero, 40), data: /^\d{4}-\d{2}-\d{2}$/.test(data) ? data : '',
    righe: (Array.isArray(out.righe) ? out.righe : []).slice(0, 200).map(x => ({
      codice: s(x.codice, 60), descrizione: s(x.descrizione, 120),
      quantita: Math.max(0, Math.round(Number(String(x.quantita ?? '').replace(',', '.')) || 0)), unita: s(x.unita, 20) || 'pz',
    })).filter(x => x.descrizione),
    dubbi: (Array.isArray(out.dubbi) ? out.dubbi : []).slice(0, 10).map(x => s(x, 200)).filter(Boolean),
  };
}

// Chi è il fornitore: prima per partita IVA, poi per nome.
function trovaFornitore(fornitori, f) {
  const p = normPiva(f.piva);
  if (p.length >= 8) { const x = fornitori.find(y => normPiva(y.piva) === p); if (x) return x; }
  const n = norm(f.nome).replace(/\b(s ?r ?l|s ?p ?a|s ?n ?c|s ?a ?s|srls|unipersonale|spa|srl)\b/g, '').trim();
  if (!n) return null;
  return fornitori.find(y => {
    const m = norm(y.nome).replace(/\b(s ?r ?l|s ?p ?a|s ?n ?c|s ?a ?s|srls|unipersonale|spa|srl)\b/g, '').trim();
    return m && (m === n || (Math.min(m.length, n.length) >= 5 && (m.includes(n) || n.includes(m))));
  }) || null;
}

// Per ogni riga: articolo già esistente (memoria, codice, nome) oppure la categoria ricordata.
async function abbina(q, fornitoreId, righe) {
  const [{ rows: arts }, { rows: memo }] = await Promise.all([
    q('select id, nome, codice, categoria_id, fornitore_id, unita from articoli'),
    q('select fornitore_id, chiave, articolo_id, categoria_id from bolla_memo'),
  ]);
  const artById = new Map(arts.map(a => [a.id, a]));
  return righe.map(r => {
    const ks = chiavi(r);
    let hit = null, origine = '';
    for (const fid of [fornitoreId || '', null]) { // prima ciò che si è registrato con questo fornitore, poi con qualunque fornitore
      for (const k of ks) {
        const m = memo.find(x => x.chiave === k && (fid === null ? true : x.fornitore_id === fid));
        if (m) { hit = m; break; }
      }
      if (hit) break;
    }
    let articoloId = null, categoriaId = null;
    if (hit) {
      origine = 'memoria';
      if (hit.articolo_id && artById.has(hit.articolo_id)) articoloId = hit.articolo_id;
      else categoriaId = hit.categoria_id || null;
    }
    if (!articoloId && !categoriaId && r.codice) {
      const c = norm(r.codice);
      const a = arts.find(x => x.codice && norm(x.codice) === c && (!fornitoreId || !x.fornitore_id || x.fornitore_id === fornitoreId));
      if (a) { articoloId = a.id; origine = 'codice'; }
    }
    if (!articoloId && !categoriaId) {
      const d = norm(r.descrizione);
      const a = arts.find(x => norm(x.nome) === d);
      if (a) { articoloId = a.id; origine = 'nome'; }
    }
    if (articoloId) categoriaId = artById.get(articoloId).categoria_id;
    return { ...r, articoloId, categoriaId, origine };
  });
}

module.exports = { leggi, trovaFornitore, abbina, chiavi, norm, normPiva };
