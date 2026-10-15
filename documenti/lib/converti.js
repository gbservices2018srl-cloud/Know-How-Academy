// Trasforma un file caricato in una "pagina dell'app": un elenco di blocchi
//   { t:'h', x }  titolo di sezione        { t:'p', x }  paragrafo (con **grassetto**)
//   { t:'li', x, n } punto di elenco (n = numerato)   { t:'t', rows:[[...],[...]] } tabella (prima riga = intestazione)
//   { t:'img', id } immagine (salvata a parte)
// Word (.docx): con mammoth, fedele (titoli, elenchi, tabelle, grassetti, immagini).
// PDF: con Claude, se c'è la chiave (legge anche le scansioni e le tabelle); altrimenti dal testo del PDF.
const mammoth = require('mammoth');

const MAXB = 4000, MAXX = 6000;
// controlla e ripulisce i blocchi (arrivano dal browser o dall'AI)
function pulisci(blocchi) {
  const out = [];
  for (const b of Array.isArray(blocchi) ? blocchi.slice(0, MAXB) : []) {
    if (!b || typeof b !== 'object') continue;
    const x = String(b.x ?? '').replace(/\r/g, '').slice(0, MAXX);
    if (b.t === 'h' || b.t === 'p') { if (x.trim() || b.t === 'p') out.push({ t: b.t, x }); }
    else if (b.t === 'li') out.push({ t: 'li', x, ...(b.n ? { n: true } : {}) });
    else if (b.t === 't' && Array.isArray(b.rows)) {
      const rows = b.rows.slice(0, 200).map(r => (Array.isArray(r) ? r : []).slice(0, 12).map(c => String(c ?? '').slice(0, 1000)));
      const w = Math.max(1, ...rows.map(r => r.length));
      if (rows.length) out.push({ t: 't', rows: rows.map(r => [...r, ...Array(w - r.length).fill('')]) });
    } else if (b.t === 'img' && /^[0-9a-f-]{36}$/.test(String(b.id || ''))) out.push({ t: 'img', id: b.id });
  }
  return out;
}
// testo semplice, per la ricerca
const testoDi = blocchi => blocchi.map(b => b.t === 't' ? b.rows.map(r => r.join(' ')).join('\n') : (b.x || '')).join('\n').replace(/\*\*/g, '');

/* ---------- Word ---------- */
const ent = s => s.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
function inline(html) {
  return ent(html
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<(strong|b)>([\s\S]*?)<\/\1>/gi, (m, t, x) => x.replace(/<[^>]+>/g, '').trim() ? `**${x}**` : x)
    .replace(/<a [^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (m, u, x) => { const t = x.replace(/<[^>]+>/g, ''); return t === u || /^#/.test(u) ? t : `${t} (${u})`; })
    .replace(/<[^>]+>/g, '')).replace(/\*\*\s*\*\*/g, '').replace(/[ \t]+/g, ' ').trim();
}
function htmlABlocchi(html) {
  const out = [];
  const re = /<(h[1-6]|p|ul|ol|table)\b[^>]*>([\s\S]*?)<\/\1>/gi; let m;
  while ((m = re.exec(html))) {
    const tag = m[1].toLowerCase(), inner = m[2];
    const imgs = [...inner.matchAll(/<img [^>]*src="img:([0-9a-f-]{36})"/gi)].map(x => x[1]);
    if (tag[0] === 'h') { const x = inline(inner); if (x) out.push({ t: 'h', x: x.replace(/\*\*/g, '') }); }
    else if (tag === 'p') { const x = inline(inner); if (x) out.push({ t: 'p', x }); }
    else if (tag === 'ul' || tag === 'ol') {
      for (const li of inner.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)) { const x = inline(li[1].replace(/<(ul|ol)[\s\S]*$/i, '')); if (x) out.push({ t: 'li', x, ...(tag === 'ol' ? { n: true } : {}) }); }
    } else if (tag === 'table') {
      const rows = [...inner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(r => [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => inline(c[1]).replace(/\*\*/g, '')));
      if (rows.length) out.push({ t: 't', rows });
    }
    for (const id of imgs) out.push({ t: 'img', id });
  }
  return out;
}
async function daWord(buffer, salvaImmagine) {
  const r = await mammoth.convertToHtml({ buffer }, {
    convertImage: mammoth.images.imgElement(async img => {
      const dati = await img.read();
      if (!/^image\/(png|jpe?g|gif|webp)$/.test(img.contentType) || dati.length > 5e6) return { src: '' };
      return { src: 'img:' + await salvaImmagine(dati, img.contentType) };
    }),
  });
  return pulisci(htmlABlocchi(r.value || ''));
}

/* ---------- PDF dal testo (senza AI) ---------- */
async function testoPdf(buffer) {
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');
  const r = await pdfParse(Buffer.from(buffer));
  return { testo: (r.text || '').replace(/\r/g, ''), pagine: r.numpages || 0 };
}
function testoABlocchi(testo) {
  const out = [];
  const pezzi = testo.replace(/[ \t]+\n/g, '\n').split(/\n\s*\n/);
  const elenco = /^\s*([•\-–▪◦*·]|\d{1,2}[.)])\s+/;
  for (const pz of pezzi) {
    const righe = pz.split('\n').map(r => r.trim()).filter(Boolean).filter(r => !/^(pag(ina)?\.?\s*)?\d{1,3}(\s*(di|\/)\s*\d{1,3})?$/i.test(r));
    let para = [];
    const chiudi = () => { if (para.length) { out.push({ t: 'p', x: para.join(' ').replace(/-\s(?=[a-zà-ù])/g, '') }); para = []; } };
    for (const [k, r] of righe.entries()) {
      if (elenco.test(r)) { chiudi(); out.push({ t: 'li', x: r.replace(elenco, ''), ...(/^\s*\d/.test(r) ? { n: true } : {}) }); continue; }
      const corta = r.length <= 80 && !/[.,;:]$/.test(r);
      const maiuscola = r.replace(/[^A-Za-zÀ-ÿ]/g, '').length > 3 && r === r.toUpperCase();
      const dopo = righe[k + 1];
      const titoletto = corta && r.length <= 50 && /^[A-ZÀ-Ý]/.test(r) && (!para.length || /[.!?:]$/.test(para[para.length - 1]))
        && (!dopo || elenco.test(dopo)) && (para.length > 0 || out[out.length - 1]?.t !== 'h');
      if (titoletto || corta && (maiuscola || (/^\d+(\.\d+)*\.?\s+\S/.test(r) && r.length <= 60) || (righe.length === 1 && r.length <= 60))) { chiudi(); out.push({ t: 'h', x: r }); continue; }
      const prec = out[out.length - 1];
      if (!para.length && prec?.t === 'li' && /^[a-zà-ù]/.test(r)) { prec.x += ' ' + r; continue; } // continuazione del punto
      // nuovo paragrafo quando la riga prima finisce una frase e questa inizia con la maiuscola
      if (para.length && /[.!?:]$/.test(para[para.length - 1]) && /^[A-ZÀ-Ý«"]/.test(r)) chiudi();
      para.push(r);
    }
    chiudi();
  }
  return pulisci(out);
}

/* ---------- PDF con Claude ---------- */
const PROMPT = `Trascrivi questo documento in blocchi strutturati per una pagina web, in italiano, MANTENENDO IL TESTO ESATTAMENTE COM'È.
Regole:
- Non riassumere, non correggere, non riformulare, non inventare nulla. Copia ogni parola.
- Togli solo intestazioni e piè di pagina che si ripetono su ogni pagina e i numeri di pagina.
- Ricomponi i paragrafi spezzati tra righe o tra pagine.
- Usa **testo** per le parti in grassetto.
- Le tabelle diventano tabelle (prima riga = intestazione). Le caselle da compilare dei moduli restano come "________".
- Se c'è un'immagine o un logo, scrivi un paragrafo "[Immagine: breve descrizione]".
Rispondi SOLO con JSON valido, senza altro testo:
{"titolo":"titolo del documento","blocchi":[{"t":"h","x":"titolo di sezione"},{"t":"p","x":"paragrafo"},{"t":"li","x":"punto elenco"},{"t":"li","x":"punto numerato","n":true},{"t":"t","rows":[["intestazione 1","intestazione 2"],["cella","cella"]]}]}`;
async function pdfConAI(buffer) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.DOC_AI_MODEL || process.env.TURNI_AI_MODEL || 'claude-sonnet-5-5', max_tokens: 32000,
      messages: [{ role: 'user', content: [
        { type: 'document', source: { type: 'base64', media_type: 'application/pdf', data: Buffer.from(buffer).toString('base64') } },
        { type: 'text', text: PROMPT } ] }] }),
    signal: AbortSignal.timeout(240000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`API ${r.status} ${j?.error?.message || ''}`.trim());
  const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const out = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
  return { titolo: String(out.titolo || '').slice(0, 200), blocchi: pulisci(out.blocchi), troncato: j.stop_reason === 'max_tokens' };
}

// PDF → blocchi: con l'AI se c'è (fino a 60 pagine), altrimenti dal testo. Restituisce anche come è stato letto.
async function daPdf(buffer) {
  const { testo, pagine } = await testoPdf(buffer).catch(() => ({ testo: '', pagine: 0 }));
  const conTesto = testo.replace(/\s+/g, '').length > 40;
  if (process.env.ANTHROPIC_API_KEY && pagine <= 60) {
    try {
      const a = await pdfConAI(buffer);
      if (a && a.blocchi.length) return { ...a, pagine, come: 'ai' };
    } catch (e) { console.warn('Documenti, lettura PDF con AI non riuscita:', e.message); }
  }
  if (!conTesto) return { titolo: '', blocchi: [], pagine, come: 'vuoto' };
  return { titolo: '', blocchi: testoABlocchi(testo), pagine, come: 'testo' };
}

module.exports = { daWord, daPdf, testoPdf, pulisci, testoDi, testoABlocchi, htmlABlocchi };
