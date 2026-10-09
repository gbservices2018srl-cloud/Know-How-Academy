// Buste paga: divisione del PDF della consulente per codice fiscale e cifratura dei file.
// I file restano nel database solo cifrati (AES-256-GCM) con la chiave BUSTE_KEY impostata su Render.
const crypto = require('crypto');

const KEY = () => {
  const k = process.env.BUSTE_KEY || '';
  const b = Buffer.from(k, 'base64');
  return b.length === 32 ? b : null;
};
const attive = () => !!KEY();

function cifra(buf) {
  const key = KEY();
  if (!key) throw Object.assign(new Error('Le buste paga non sono attive: manca BUSTE_KEY su Render.'), { status: 400 });
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', key, iv);
  const file = Buffer.concat([c.update(buf), c.final()]);
  return { file, iv, tag: c.getAuthTag() };
}
function decifra({ file, iv, tag }) {
  const d = crypto.createDecipheriv('aes-256-gcm', KEY(), iv);
  d.setAuthTag(tag);
  return Buffer.concat([d.update(file), d.final()]);
}
const impronta = buf => crypto.createHash('sha256').update(buf).digest('hex');

// Testo di ogni pagina (per cercare il codice fiscale)
async function testoPagine(buf) {
  const pdfParse = require('pdf-parse/lib/pdf-parse.js');
  const testi = [];
  // copia in un ArrayBuffer tutto suo: pdf.js legge buf.buffer per intero (i Buffer piccoli di Node stanno in un'area condivisa)
  // e può anche "consumarlo"; così il PDF originale resta intatto per la divisione con pdf-lib
  await pdfParse(new Uint8Array(buf), {
    max: 0,
    pagerender: async pageData => {
      const tc = await pageData.getTextContent({ normalizeWhitespace: false, disableCombineTextItems: false });
      const t = tc.items.map(i => i.str).join(' ');
      testi.push(t);
      return t;
    },
  });
  return testi;
}

// Un PDF con le pagine indicate (indici da 0)
async function estrai(buf, pagine) {
  const { PDFDocument } = require('pdf-lib');
  const src = await PDFDocument.load(buf, { ignoreEncryption: true });
  const out = await PDFDocument.create();
  const copie = await out.copyPages(src, pagine);
  copie.forEach(p => out.addPage(p));
  return Buffer.from(await out.save());
}
async function contaPagine(buf) {
  const { PDFDocument } = require('pdf-lib');
  return (await PDFDocument.load(buf, { ignoreEncryption: true })).getPageCount();
}
// Più PDF in uno solo (per l'archivio dell'amministrazione)
async function unisci(bufs) {
  const { PDFDocument } = require('pdf-lib');
  const out = await PDFDocument.create();
  for (const b of bufs) {
    const src = await PDFDocument.load(b, { ignoreEncryption: true });
    (await out.copyPages(src, src.getPageIndices())).forEach(p => out.addPage(p));
  }
  return Buffer.from(await out.save());
}

// Divide il PDF: ogni pagina va al collaboratore il cui codice fiscale compare nel testo.
// Tutte le pagine dello stesso codice fiscale formano una busta sola (anche se non sono una dopo l'altra, es. la tredicesima in fondo).
// Le pagine senza codice fiscale riconosciuto restano "da assegnare" (con un suggerimento: la persona della pagina prima).
async function dividi(buf, staff) {
  const conCf = staff.filter(e => /^[A-Z0-9]{16}$/.test(String(e.cf || '').toUpperCase()));
  const testi = await testoPagine(buf);
  const n = Math.max(testi.length, await contaPagine(buf));
  const chi = [];
  for (let i = 0; i < n; i++) {
    const t = String(testi[i] || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    const trovati = conCf.filter(e => t.includes(e.cf.toUpperCase()));
    chi.push(trovati.length === 1 ? trovati[0].id : null); // due codici fiscali nella stessa pagina: meglio farla scegliere
  }
  const gruppi = [], sospese = [];
  for (let i = 0; i < n; i++) {
    if (!chi[i]) { sospese.push({ pagina: i, suggerito: i > 0 ? chi[i - 1] : null }); continue; }
    const g = gruppi.find(x => x.staffId === chi[i]);
    if (g) g.pagine.push(i); else gruppi.push({ staffId: chi[i], pagine: [i] });
  }
  for (const g of gruppi) g.buf = await estrai(buf, g.pagine);
  for (const s of sospese) s.buf = await estrai(buf, [s.pagina]);
  return { pagine: n, gruppi, sospese };
}

// Pagina di ricevuta firmata: chi, quale documento, quando, da quale dispositivo, impronta del file e firma.
// Se si passa il documento, la ricevuta viene aggiunta in fondo (copia firmata per l'amministrazione).
async function ricevuta({ documento, nome, cf, titolo, firmataIl, dispositivo, impronta, firmaPng }) {
  const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
  const out = documento ? await PDFDocument.load(documento, { ignoreEncryption: true }) : await PDFDocument.create();
  const p = out.addPage([595.28, 841.89]);
  const f = await out.embedFont(StandardFonts.Helvetica), fb = await out.embedFont(StandardFonts.HelveticaBold);
  // i font standard scrivono solo i caratteri dell'alfabeto latino (WinAnsi): il resto diventa "?"
  const t = s => String(s ?? '').replace(/[’‘]/g, "'").replace(/[“”]/g, '"').replace(/[–—]/g, '-').replace(/[^\x20-\x7E\xA0-\xFF]/g, '?');
  const ink = rgb(0.17, 0.19, 0.2), muted = rgb(0.42, 0.45, 0.46), teal = rgb(0.16, 0.49, 0.49);
  let y = 780;
  p.drawText('To Smile', { x: 56, y, size: 16, font: fb, color: teal });
  y -= 34; p.drawText(t('Ricevuta di consegna firmata'), { x: 56, y, size: 20, font: fb, color: ink });
  y -= 22; p.drawText(t(titolo), { x: 56, y, size: 13, font: f, color: muted });
  const riga = (k, v) => { y -= 26; p.drawText(t(k), { x: 56, y, size: 10.5, font: f, color: muted }); p.drawText(t(v), { x: 190, y, size: 11.5, font: fb, color: ink }); };
  y -= 14;
  riga('Dipendente', nome);
  if (cf) riga('Codice fiscale', cf);
  riga('Documento', titolo);
  riga('Firmato il', new Date(firmataIl).toLocaleString('it-IT', { timeZone: 'Europe/Rome', dateStyle: 'long', timeStyle: 'short' }));
  riga('Dispositivo', dispositivo || '-');
  y -= 26; p.drawText('Impronta SHA-256 del documento', { x: 56, y, size: 10.5, font: f, color: muted });
  y -= 16; p.drawText(t(impronta), { x: 56, y, size: 8.5, font: f, color: ink });
  y -= 40; p.drawText(t('Il dipendente dichiara di aver ricevuto e preso visione del documento sopra indicato.'), { x: 56, y, size: 11, font: f, color: ink });
  y -= 24; p.drawText('Firma', { x: 56, y, size: 10.5, font: f, color: muted });
  if (firmaPng) {
    const img = await out.embedPng(firmaPng);
    const w = Math.min(380, img.width), h = img.height * (w / img.width);
    const hh = Math.min(h, 170), ww = w * (hh / h);
    p.drawRectangle({ x: 56, y: y - 14 - hh - 16, width: ww + 24, height: hh + 16, borderColor: rgb(0.85, 0.85, 0.82), borderWidth: 1 });
    p.drawImage(img, { x: 68, y: y - 14 - hh - 8, width: ww, height: hh });
  }
  p.drawText(t('Documento generato da turni.appgestione.it.'), { x: 56, y: 72, size: 8.5, font: f, color: muted });
  p.drawText(t("La firma e la data sono registrate sul server insieme all'impronta del file."), { x: 56, y: 60, size: 8.5, font: f, color: muted });
  return Buffer.from(await out.save());
}

// "iPhone/iPad · Safari", "Windows · Edge"… (per il registro delle prese visione)
function dispositivo(ua) {
  const u = String(ua || '');
  const os = /iPhone|iPad/.test(u) ? 'iPhone/iPad' : /Android/.test(u) ? 'Android' : /Mac/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : /Linux/.test(u) ? 'Linux' : 'Altro';
  const br = /Edg\//.test(u) ? 'Edge' : /Chrome\//.test(u) ? 'Chrome' : /Firefox\//.test(u) ? 'Firefox' : /Safari\//.test(u) ? 'Safari' : 'Browser';
  return `${os} · ${br}`;
}

module.exports = { attive, cifra, decifra, impronta, dividi, estrai, unisci, dispositivo, ricevuta };
