// Scansione di un prodotto (amministratore del magazzino).
// 1) Il codice a barre / DataMatrix letto dalla fotocamera arriva come testo: qui si interpreta (GS1 / UDI, HIBC, EAN).
// 2) La foto dell'etichetta va all'API di Claude, che legge nome, produttore, REF, lotto e scadenza stampati.

const GS = '\u001d';

// Data GS1 AAMMGG → AAAA-MM-GG (giorno 00 = ultimo giorno del mese)
function dataGs1(s) {
  if (!/^\d{6}$/.test(s)) return '';
  const y = 2000 + +s.slice(0, 2), m = +s.slice(2, 4); let d = +s.slice(4, 6);
  if (m < 1 || m > 12) return '';
  if (d === 0) d = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

// Identificatori GS1 più usati sulle confezioni sanitarie: lunghezza fissa o variabile (fino al separatore)
const AI_FISSI = { '00': 18, '01': 14, '02': 14, '11': 6, '12': 6, '13': 6, '15': 6, '16': 6, '17': 6, '20': 2 };
const AI_VAR = ['10', '21', '22', '240', '241', '30', '37', '90', '91', '92', '93', '94', '95', '96', '97', '98', '99'];

function gs1(txt) {
  const out = {};
  let s = txt.replace(/^\][A-Za-z]\d/, ''); // prefisso di simbologia (]d2, ]C1, ]Q3…)
  if (/^\(\d{2,4}\)/.test(s)) { // forma leggibile: (01)…(17)…(10)…
    for (const m of s.matchAll(/\((\d{2,4})\)([^(]*)/g)) out[m[1]] = m[2].trim();
    return out;
  }
  s = s.replace(/^\u001d/, '');
  let i = 0, giri = 0;
  while (i < s.length && giri++ < 20) {
    if (s[i] === GS) { i++; continue; }
    const ai2 = s.slice(i, i + 2), ai3 = s.slice(i, i + 3);
    if (AI_FISSI[ai2] !== undefined) { out[ai2] = s.slice(i + 2, i + 2 + AI_FISSI[ai2]); i += 2 + AI_FISSI[ai2]; continue; }
    const ai = AI_VAR.includes(ai3) ? ai3 : AI_VAR.includes(ai2) ? ai2 : null;
    if (!ai) break;
    let j = s.indexOf(GS, i + ai.length); if (j < 0) j = s.length;
    out[ai] = s.slice(i + ai.length, j); i = j;
  }
  return out;
}

// Testo del codice → { tipo, gtin, lotto, scadenza, seriale, ref, grezzo }
function interpreta(testo) {
  const grezzo = String(testo || '').trim().slice(0, 300);
  const r = { tipo: '', gtin: '', lotto: '', scadenza: '', seriale: '', ref: '', grezzo: grezzo.replace(/\u001d/g, '|') };
  if (!grezzo) return r;
  const pulito = grezzo.replace(/^\][A-Za-z]\d/, '');
  if (/^\d{8}$|^\d{12,14}$/.test(pulito)) { r.tipo = 'EAN'; r.gtin = pulito.padStart(14, '0'); return r; }
  if (pulito.startsWith('+')) { // HIBC: +LIC(4) codice prodotto … / +$$ lotto
    r.tipo = 'HIBC';
    const parti = pulito.slice(1).split('/');
    const p = parti[0].startsWith('$') ? '' : parti[0];
    if (p.length > 5) r.ref = p.slice(4, -2); // senza codice produttore, unità e carattere di controllo
    const sec = (parti[0].startsWith('$') ? parti[0] : parti[1] || '').replace(/^\$+/, '');
    if (sec.length > 1) r.lotto = sec.slice(0, -1).slice(0, 40); // senza carattere di controllo (i formati con data vanno controllati a mano)
    return r;
  }
  const a = gs1(pulito);
  if (a['01'] || a['02'] || a['10'] || a['17']) {
    r.tipo = 'GS1';
    r.gtin = a['01'] || a['02'] || '';
    r.lotto = (a['10'] || '').slice(0, 40);
    r.scadenza = dataGs1(a['17'] || '');
    r.seriale = (a['21'] || '').slice(0, 40);
    r.ref = (a['240'] || '').slice(0, 60);
    return r;
  }
  r.tipo = 'ALTRO';
  return r;
}

const PROMPT = (codice) => `Questa è la foto dell'etichetta o della confezione di un prodotto arrivato al magazzino di un gruppo di studi dentistici (materiali di consumo, impianti, frese, farmaci, dispositivi medici).
${codice ? `Dal codice a barre della confezione è già stato letto: ${codice}. Se è coerente con l'etichetta, usalo per lotto, scadenza e GTIN.\n` : ''}Rispondi SOLO con un oggetto JSON, senza testo prima o dopo:
{"nome":"","produttore":"","ref":"","gtin":"","lotto":"","scadenza":"AAAA-MM-GG","unita":"","pezziPerConfezione":0,"dubbi":[]}
Regole:
- "nome": nome commerciale chiaro e breve con le caratteristiche che distinguono l'articolo (misura, diametro, lunghezza, colore, taglia, gradazione…), es. "Impianto Unimax Ø 3,30 x 10 mm".
- "produttore": l'azienda che produce o distribuisce.
- "ref": il codice articolo (simbolo REF, "Cod.", "Art.").
- "gtin": le 14 cifre dopo (01) se stampate, altrimenti vuoto.
- "lotto": il valore accanto al simbolo LOT o "Lotto"/"Batch".
- "scadenza": la data accanto alla clessidra o "Scad."/"EXP"/"Use by"; se c'è solo mese e anno usa l'ultimo giorno del mese.
- "unita": come si conta l'articolo in magazzino (pz, conf, blister, flacone…).
- Se un dato non c'è o non si legge, lascia vuoto e scrivi il motivo in "dubbi" (breve, in italiano).`;

async function leggiEtichetta(files, codice) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error("La lettura delle etichette non è attiva: manca ANTHROPIC_API_KEY su Render."), { status: 400 });
  const content = files.map(f => ({ type: 'image', source: { type: 'base64', media_type: f.tipo, data: f.dati } }));
  content.push({ type: 'text', text: PROMPT(codice) });
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.MAG_AI_MODEL || process.env.TURNI_AI_MODEL || 'claude-sonnet-5-5', max_tokens: 1500,
        messages: [{ role: 'user', content }] }),
      signal: AbortSignal.timeout(60000),
    });
  } catch { throw Object.assign(new Error("La lettura ha impiegato troppo. Riprova con una foto più nitida."), { status: 502 }); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.warn('Magazzino etichetta:', r.status, JSON.stringify(j).slice(0, 300));
    throw Object.assign(new Error(r.status === 429 ? 'Troppe richieste ravvicinate: riprova tra poco.' : "Il servizio di lettura non ha risposto. Riprova tra poco."), { status: 502 });
  }
  const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  let o;
  try { o = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)); }
  catch { throw Object.assign(new Error("Non sono riuscito a leggere l'etichetta. Riprova con una foto più vicina e dritta."), { status: 502 }); }
  const s = (v, n) => String(v ?? '').trim().slice(0, n);
  const scad = s(o.scadenza, 10);
  return {
    nome: s(o.nome, 120), produttore: s(o.produttore, 120), ref: s(o.ref, 60), gtin: s(o.gtin, 14).replace(/\D/g, ''),
    lotto: s(o.lotto, 40), scadenza: /^\d{4}-\d{2}-\d{2}$/.test(scad) ? scad : '', unita: s(o.unita, 20),
    pezziPerConfezione: Math.max(0, Math.round(Number(o.pezziPerConfezione) || 0)),
    dubbi: (Array.isArray(o.dubbi) ? o.dubbi : []).slice(0, 6).map(x => s(x, 200)).filter(Boolean),
  };
}

module.exports = { interpreta, leggiEtichetta, dataGs1 };
