// Gestione lead (setter): lettura dei file dei lead (.xlsx o .csv) e confronto con i preventivi del CRM.
// Nomi, telefoni, info e note dei lead sono dati personali: restano nel database e nella sezione Gestione lead,
// mai nei KPI di vendita, nell'AI o nei log. Il file caricato si legge in memoria e non si salva.
const { leggiFogli, dataIso } = require('./importa');

const ESITI = ['DA CHIAMARE', 'NON RISPONDE', 'DA RICHIAMARE', 'APPUNTAMENTO FISSATO', 'NON INTERESSATO', 'NUMERO ERRATO'];
const FISSATO = 'APPUNTAMENTO FISSATO';
// campi in cui può andare una colonna del file
const CAMPI = { nome: 'Nome', cognome: 'Cognome', nominativo: 'Nome e cognome (insieme)', telefono: 'Telefono', canale: 'Canale marketing',
  data: 'Data arrivo lead', info: 'Info aggiuntive', note: 'Note' };

const testo = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
// telefono confrontabile: solo cifre, senza prefisso italiano
function normTel(s) {
  let d = String(s ?? '').replace(/\D/g, '');
  if (d.startsWith('0039')) d = d.slice(4); else if (d.length > 10 && d.startsWith('39')) d = d.slice(2);
  return d;
}
// nome confrontabile: maiuscolo, senza accenti e segni; parole di almeno 2 lettere
const normNome = s => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z]+/g, ' ').trim();
const parole = s => [...new Set(normNome(s).split(' ').filter(w => w.length >= 2))];
// data AAAA-MM-GG solo se esiste davvero (niente 31/02) e non nel futuro lontano
const dataOk = d => d && /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d + 'T00:00:00Z')) && new Date(Date.parse(d + 'T00:00:00Z')).toISOString().slice(0, 10) === d && d > '2000' && d < '2100' ? d : null;
const giorni = (iso, n) => new Date(Date.parse(iso + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);

// CSV con ; , o tab (quello che compare di più nella prima riga), virgolette come Excel
function csv(buf) {
  const t = buf.toString('utf8').replace(/^﻿/, '');
  const prima = t.split(/\r?\n/)[0] || '';
  const sep = [';', ',', '\t'].sort((a, b) => prima.split(b).length - prima.split(a).length)[0];
  const righe = []; let riga = [], cella = '', q = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (q) { if (c === '"') { if (t[i + 1] === '"') { cella += '"'; i++; } else q = false; } else cella += c; }
    else if (c === '"') q = true;
    else if (c === sep) { riga.push(cella); cella = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && t[i + 1] === '\n') i++; riga.push(cella); righe.push(riga); riga = []; cella = ''; }
    else cella += c;
  }
  if (cella !== '' || riga.length) { riga.push(cella); righe.push(riga); }
  return righe;
}

// { titoli: [...], dati: [[...], ...] } dal primo foglio con dati. L'intestazione è la prima riga (entro le prime 15) con almeno 2 celle scritte.
async function leggiTabella(buf) {
  let righe;
  if (buf[0] === 0x50 && buf[1] === 0x4b) {
    const fogli = await leggiFogli(buf);
    righe = Object.values(fogli).find(rs => rs.some(r => r.filter(c => testo(c)).length >= 2)) || [];
  } else if (buf[0] === 0xd0 && buf[1] === 0xcf) {
    throw Object.assign(new Error('Il file è nel vecchio formato .xls: aprilo in Excel e salvalo come .xlsx.'), { status: 400 });
  } else righe = csv(buf);
  const h = righe.findIndex((r, i) => i < 15 && r.filter(c => testo(c)).length >= 2);
  if (h < 0) throw Object.assign(new Error('Nel file non trovo una riga di intestazione (nome, cognome, telefono…).'), { status: 400 });
  const dati = righe.slice(h + 1).filter(r => r.some(c => testo(c)));
  // colonne con un titolo o con almeno un valore
  const n = Math.max(righe[h].length, ...dati.map(r => r.length));
  const usate = [...Array(n).keys()].filter(i => testo(righe[h][i]) || dati.some(r => testo(r[i])));
  return { titoli: usate.map(i => testo(righe[h][i], 60) || `Colonna ${i + 1}`), dati: dati.map(r => usate.map(i => r[i] ?? '')) };
}

// campo proposto per una colonna, dal titolo
function suggerisci(titolo) {
  const t = String(titolo || '').toLowerCase().trim();
  if (/nome\s*(e|\/|\+|-)?\s*cognome|cognome\s*(e|\/|\+|-)?\s*nome|nominativo|full.?name|paziente|cliente|contatto/.test(t)) return 'nominativo';
  if (/cognome|last.?name|surname/.test(t)) return 'cognome';
  if (/^nome\b|first.?name|^name$/.test(t)) return 'nome';
  if (/tel|cell|phone|mobile|whatsapp|numero|cellulare/.test(t)) return 'telefono';
  if (/canale|fonte|source|marketing|campagna|campaign|provenienza|origine|piattaforma/.test(t)) return 'canale';
  if (/^data|date|creat|ricevut|arrivo|giorno/.test(t)) return 'data';
  if (/^note/.test(t)) return 'note';
  return t ? 'info' : '';
}

// righe del file → lead da salvare. mappa: { indiceColonna: campo }. opz: { canali: Set, def, oggi, visti: Set di telefoni già presenti }
function preparaImport(tab, mappa, opz) {
  const col = c => Object.entries(mappa).filter(([, v]) => v === c).map(([k]) => Number(k)).filter(i => i >= 0 && i < tab.titoli.length);
  const [cN, cC, cNC, cT, cK, cD, cI, cNo] = ['nome', 'cognome', 'nominativo', 'telefono', 'canale', 'data', 'info', 'note'].map(col);
  if (!cNC.length && !(cN.length && cC.length)) return { errore: 'Indica le colonne di nome e cognome (o una colonna con nome e cognome insieme).' };
  if (!cT.length) return { errore: 'Indica la colonna del telefono.' };
  const righe = [], visti = new Set(opz.visti);
  let doppioni = 0, scartate = 0, senzaCanale = 0;
  for (const r of tab.dati) {
    const v = cs => cs.map(i => testo(r[i], 120)).filter(Boolean).join(' ');
    let nome = v(cN), cognome = v(cC);
    // nome e cognome nella stessa colonna: si salva tutto nel cognome (per la ricerca nel CRM l'ordine non conta)
    if (!nome && !cognome) cognome = v(cNC);
    const telefono = cT.map(i => testo(r[i], 40)).find(Boolean) || '';
    if (!(nome || cognome) || normTel(telefono).length < 6) { scartate++; continue; }
    const tel = normTel(telefono);
    if (visti.has(tel)) { doppioni++; continue; }
    visti.add(tel);
    let marketing = '', info = cI.map(i => testo(r[i], 500) ? `${tab.titoli[i]}: ${testo(r[i], 500)}` : '').filter(Boolean);
    const k = v(cK).toUpperCase();
    if (k && opz.canali.has(k)) marketing = k;
    else { if (k) info.unshift(`Canale nel file: ${k}`); marketing = opz.def; }
    if (!marketing) { senzaCanale++; continue; }
    const dRaw = cD.map(i => r[i]).find(x => testo(x));
    righe.push({ nome: nome.toUpperCase().slice(0, 80), cognome: cognome.toUpperCase().slice(0, 80), telefono: telefono.slice(0, 40), marketing,
      info: info.join(' · ').slice(0, 2000), note: cNo.map(i => testo(r[i], 2000)).filter(Boolean).join(' · ').slice(0, 4000),
      data_lead: dataOk(dRaw != null ? dataIso(dRaw) : null) || opz.oggi });
  }
  if (!righe.length) return { errore: senzaCanale ? 'Le righe non hanno un canale marketing dell\'elenco: scegli il canale da usare quando manca.' : 'Nessuna riga nuova da caricare (tutte senza nome/telefono o già presenti).' };
  return { righe, doppioni, scartate, senzaCanale };
}

// Lead con appuntamento → visita nel CRM, cercata per nome e cognome (tutte le parole del lead nel nome del paziente, in qualsiasi ordine),
// tra i preventivi dalla settimana prima dell'appuntamento in poi. prev: righe dei preventivi (nomi dei pazienti: restano sul server).
// stato: 'trovato' · 'attesa' (appuntamento ancora da venire) · 'non_trovato' (in rosso: come se non si fosse presentato)
function confronta(leads, prev, oggi) {
  const idx = new Map();
  for (const p of prev) {
    p.pk = new Set(parole(p.paziente));
    for (const w of p.pk) { if (!idx.has(w)) idx.set(w, []); idx.get(w).push(p); }
  }
  const peso = { A: 3, S: 2, R: 1 };
  return leads.map(l => {
    const pw = parole(`${l.nome} ${l.cognome}`);
    const base = [l.data_fissato, l.data_app, l.data_lead].filter(Boolean).sort()[0];
    const da = base ? giorni(base, -7) : null;
    let trovati = [];
    if (pw.length >= 2) {
      const rara = pw.slice().sort((a, b) => (idx.get(a)?.length || 0) - (idx.get(b)?.length || 0))[0];
      trovati = (idx.get(rara) || []).filter(p => pw.every(w => p.pk.has(w)) && (!da || (p.data && p.data >= da)));
    }
    if (!trovati.length) {
      const attesa = l.data_app && l.data_app >= oggi;
      return { id: l.id, stato: attesa ? 'attesa' : 'non_trovato', esito: '', preventivi: 0, pdc: 0, incassato: 0, sede: '', data: '' };
    }
    const visite = trovati.filter(p => String(p.tipo_ov || '').toUpperCase() !== 'PAGAMENTO DILAZIONATO');
    const esito = visite.reduce((e, p) => (peso[p.esito] || 0) > (peso[e] || 0) ? p.esito : e, '');
    const date = trovati.map(p => p.data).filter(Boolean).sort();
    return { id: l.id, stato: 'trovato', esito, preventivi: visite.length, pdc: Math.round(visite.reduce((a, p) => a + (Number(p.pdc) || 0), 0) * 100) / 100,
      // incassato = tutto il pagato del paziente nel CRM (preventivi e rate dei dilazionati) dalla settimana prima dell'appuntamento
      incassato: Math.round(trovati.reduce((a, p) => a + (Number(p.pagato) || 0), 0) * 100) / 100,
      sede: [...new Set(trovati.map(p => p.sede_nome))].join(', '), data: date[0] || '' };
  });
}

module.exports = { ESITI, FISSATO, CAMPI, normTel, normNome, parole, giorni, leggiTabella, suggerisci, preparaImport, confronta, csv };
