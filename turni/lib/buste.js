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
// Pagine consecutive dello stesso codice fiscale formano una busta sola.
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
    const ult = gruppi[gruppi.length - 1];
    if (ult && ult.staffId === chi[i] && ult.pagine[ult.pagine.length - 1] === i - 1) ult.pagine.push(i);
    else gruppi.push({ staffId: chi[i], pagine: [i] });
  }
  for (const g of gruppi) g.buf = await estrai(buf, g.pagine);
  for (const s of sospese) s.buf = await estrai(buf, [s.pagina]);
  return { pagine: n, gruppi, sospese };
}

// "iPhone/iPad · Safari", "Windows · Edge"… (per il registro delle prese visione)
function dispositivo(ua) {
  const u = String(ua || '');
  const os = /iPhone|iPad/.test(u) ? 'iPhone/iPad' : /Android/.test(u) ? 'Android' : /Mac/.test(u) ? 'Mac' : /Windows/.test(u) ? 'Windows' : /Linux/.test(u) ? 'Linux' : 'Altro';
  const br = /Edg\//.test(u) ? 'Edge' : /Chrome\//.test(u) ? 'Chrome' : /Firefox\//.test(u) ? 'Firefox' : /Safari\//.test(u) ? 'Safari' : 'Browser';
  return `${os} · ${br}`;
}

module.exports = { attive, cifra, decifra, impronta, dividi, estrai, unisci, dispositivo };
