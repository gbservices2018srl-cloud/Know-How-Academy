// Estrae il testo dai file caricati: PDF (per ricerca e assistente) e Word (convertito nel formato dei documenti).
const pdfParse = require('pdf-parse/lib/pdf-parse.js');
const mammoth = require('mammoth');

async function pdfText(buffer) {
  const r = await pdfParse(buffer);
  return (r.text || '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

// HTML semplice di Word → formato dei documenti (## titoli, - elenchi, 1. passaggi, **grassetto**)
function htmlToDocText(html) {
  const decode = s => s.replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").trim();
  const inline = s => decode(s.replace(/<(strong|b)>(.*?)<\/\1>/gi, '**$2**'));
  let out = [];
  const re = /<(h[1-6]|p|ul|ol|table)[^>]*>([\s\S]*?)<\/\1>/gi; let m;
  while ((m = re.exec(html))) {
    const tag = m[1].toLowerCase(), inner = m[2];
    if (tag[0] === 'h') out.push('## ' + inline(inner));
    else if (tag === 'p') { const t = inline(inner); if (t) out.push(t); }
    else if (tag === 'ul' || tag === 'ol') {
      const items = [...inner.matchAll(/<li[^>]*>([\s\S]*?)<\/li>/gi)].map((x, i) => (tag === 'ol' ? `${i + 1}. ` : '- ') + inline(x[1]));
      out.push(items.join('\n'));
    } else if (tag === 'table') {
      const rows = [...inner.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map(r => [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => inline(c[1])).join(' · '));
      out.push(rows.map(r => '- ' + r).join('\n'));
    }
  }
  return out.join('\n\n').trim();
}

async function wordText(buffer) {
  const r = await mammoth.convertToHtml({ buffer });
  return htmlToDocText(r.value || '');
}

module.exports = { pdfText, wordText };
