// Importazione del vecchio CRM su Google Sheets (scaricato come .xlsx): fogli "Dati Grezzi <Sede>" (colonne A–O).
// Il file si legge qui sul server (Render, Europa) e non si salva: restano solo le righe nel database.
// Regole come il vecchio CRM: si saltano le righe senza sede, "Sede", "DATI…" o senza un mese valido. Tertenia esclusa.
// Esito E → R (Rifiutato). Il telefono (colonna J) non si importa.
const JSZip = require('jszip');
const { MESI, normSede } = require('./kpi');

const xmlTxt = s => String(s).replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (m, n) => String.fromCharCode(+n)).replace(/&amp;/g, '&');

// { nomeFoglio: [[celle…], …] } — le celle numeriche restano numeri, il testo resta testo
async function leggiFogli(buf) {
  let zip;
  try { zip = await JSZip.loadAsync(buf); } catch { throw Object.assign(new Error('Il file non è un Excel .xlsx valido.'), { status: 400 }); }
  const wb = zip.file('xl/workbook.xml'), rels = zip.file('xl/_rels/workbook.xml.rels');
  if (!wb || !rels) throw Object.assign(new Error('Il file non è un Excel .xlsx valido.'), { status: 400 });
  const shared = [];
  const ss = zip.file('xl/sharedStrings.xml');
  if (ss) for (const m of (await ss.async('string')).matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(xmlTxt(m[1].replace(/<rPh[\s\S]*?<\/rPh>/g, '')));
  const relMap = new Map([...(await rels.async('string')).matchAll(/<Relationship\b[^>]*>/g)].map(m => [(m[0].match(/Id="([^"]+)"/) || [])[1], (m[0].match(/Target="([^"]+)"/) || [])[1]]));
  const out = {};
  for (const m of (await wb.async('string')).matchAll(/<sheet\b[^>]*>/g)) {
    const nome = xmlTxt((m[0].match(/name="([^"]*)"/) || [])[1] || ''), rid = (m[0].match(/r:id="([^"]+)"/) || [])[1];
    let t = relMap.get(rid); if (!t) continue;
    t = t.startsWith('/') ? t.slice(1) : 'xl/' + t.replace(/^\.\//, '');
    const f = zip.file(t); if (!f) continue;
    const xml = await f.async('string'), righe = [];
    for (const r of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
      const celle = [];
      for (const c of r[1].matchAll(/<c ([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const at = c[1], body = c[2] || '';
        const col = (at.match(/r="([A-Z]+)\d+"/) || [])[1] || '';
        const tp = (at.match(/t="(\w+)"/) || [])[1];
        let v = (body.match(/<v>([\s\S]*?)<\/v>/) || [])[1];
        if (tp === 's' && v !== undefined) v = shared[+v] ?? '';
        else if (tp === 'inlineStr') v = xmlTxt((body.match(/<is>([\s\S]*?)<\/is>/) || [])[1] || '');
        else if (tp === 'str' || tp === 'e') v = v !== undefined ? xmlTxt(v) : '';
        else if (tp === 'b') v = v === '1';
        else if (v !== undefined) { const n = Number(v); v = isFinite(n) ? n : xmlTxt(v); }
        const idx = col.split('').reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0) - 1;
        if (idx >= 0 && idx < 40) celle[idx] = v ?? '';
      }
      righe.push(Array.from({ length: Math.max(15, celle.length) }, (_, i) => celle[i] ?? ''));
    }
    out[nome] = righe;
  }
  return out;
}

// importi: numero già numerico, oppure testo "4.277 €" / "€ 17.895,00" (punti delle migliaia, virgola decimale)
function importo(v) {
  if (typeof v === 'number') return Math.round(v * 100) / 100;
  let s = String(v ?? '').replace(/[€\s ]/g, '');
  if (!s) return 0;
  s = s.replace(/\./g, '').replace(',', '.');
  const n = Number(s);
  return isFinite(n) ? Math.round(n * 100) / 100 : 0;
}
// data: numero di Excel (giorni dal 30/12/1899), "2026-01-08 0:00:00" o "09/01/2026"
function dataIso(v) {
  if (typeof v === 'number' && v > 20000 && v < 80000) { const d = new Date(Date.UTC(1899, 11, 30) + Math.round(v) * 864e5); return d.toISOString().slice(0, 10); }
  const s = String(v ?? '').trim();
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/); if (m) return m[0];
  m = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/); if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return null;
}
const testo = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);

// legge il file e prepara le righe (senza scrivere nulla). sedi: [{id, nome}] della suite
async function prepara(buf, sedi, anno) {
  const fogli = await leggiFogli(buf);
  const nomiFogli = Object.keys(fogli);
  const grezzi = nomiFogli.filter(n => /^dati\s*grezzi\b/i.test(n.trim()));
  if (!grezzi.length) throw Object.assign(new Error('Nel file non ci sono i fogli «Dati Grezzi <Sede>». Scarica il foglio del CRM da Google con File → Scarica → Microsoft Excel (.xlsx).'), { status: 400 });
  const perNome = new Map(sedi.map(s => [normSede(s.nome), s]));
  const righe = [], perSede = {}, scartate = { tertenia: 0, senzaSede: 0, sedeSconosciuta: {}, eInR: 0, esitoVuoto: 0 };
  for (const nf of grezzi) {
    for (const r of fogli[nf]) {
      const sedeTxt = testo(r[0], 80);
      if (!sedeTxt || /^sede$/i.test(sedeTxt) || /^dati/i.test(sedeTxt)) continue;
      const mi = MESI.indexOf(String(r[1] ?? '').replace(/\s+/g, '').toLowerCase());
      if (mi < 0) continue;
      if (/tertenia/i.test(sedeTxt)) { scartate.tertenia++; continue; }
      const sede = perNome.get(normSede(sedeTxt));
      if (!sede) { scartate.sedeSconosciuta[sedeTxt] = (scartate.sedeSconosciuta[sedeTxt] || 0) + 1; continue; }
      let esito = testo(r[7], 5).toUpperCase();
      if (esito === 'E') { esito = 'R'; scartate.eInR++; }
      if (!['A', 'S', 'R'].includes(esito)) { if (esito) scartate.altriEsiti = (scartate.altriEsiti || 0) + 1; esito = ''; scartate.esitoVuoto++; }
      const an = Number(String(r[10] ?? '').replace(/\D/g, ''));
      const riga = {
        sede_id: sede.id, sede_nome: sede.nome, anno, mese: mi + 1, data: dataIso(r[2]),
        paziente: testo(r[3], 120).toUpperCase(), tipo_ov: testo(r[4], 60).toUpperCase(), marketing: testo(r[5], 80).toUpperCase(),
        pdc: importo(r[6]), esito, pagato: importo(r[8]),
        anno_nascita: an >= 1900 && an <= new Date().getFullYear() ? an : null,
        tipo_pdc: testo(r[11], 80).toUpperCase(), note: String(r[12] ?? '').trim().slice(0, 4000),
        commerciale: testo(r[13], 80).toUpperCase(), medico: testo(r[14], 80).toUpperCase(),
      };
      righe.push(riga);
      const p = perSede[sede.nome] || (perSede[sede.nome] = { righe: 0, A: 0, S: 0, R: 0, senzaEsito: 0, dilazionati: 0, pdc: 0, mesi: new Set() });
      p.righe++; if (esito) p[esito]++; else p.senzaEsito++;
      if (riga.tipo_ov === 'PAGAMENTO DILAZIONATO') p.dilazionati++; else p.pdc += riga.pdc;
      p.mesi.add(riga.mese);
    }
  }
  // canali marketing del foglio "_Liste" (colonna D), se c'è
  const liste = fogli[nomiFogli.find(n => /^_?liste$/i.test(n.trim()))] || [];
  const marketing = [...new Set(liste.slice(1).map(r => testo(r[3], 80).toUpperCase()).filter(Boolean))];
  const riepilogo = Object.entries(perSede).map(([sede, p]) => ({ sede, ...p, pdc: Math.round(p.pdc), mesi: [...p.mesi].sort((a, b) => a - b) }))
    .sort((a, b) => a.sede.localeCompare(b.sede, 'it'));
  return { righe, riepilogo, scartate, marketing, fogli: grezzi.length };
}

module.exports = { prepara, leggiFogli, importo, dataIso };
