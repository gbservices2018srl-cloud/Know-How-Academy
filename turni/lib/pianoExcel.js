// Piano di inserimento e crescita da Excel (Scheda personale → Performance).
// Colonne del file: RUOLO | FISSO EURO | VARIABILE | OBIETTIVI (HARD SKILL) | SOTTO OBIETTIVI | SOFT SKILL | SCUOLA DI FORMAZIONE
// Ogni riga è un obiettivo; le righe consecutive con lo stesso ruolo formano un livello. I testi si conservano come sono nel file.
// Il foglio «Fonti e criteri» si conserva come note del piano.
// Le voci del variabile diventano regole: quelle leggibili (% sul fatturato, a target / overtarget) si calcolano da sole,
// le altre restano «a mano» (l'amministrazione scrive l'importo ogni mese).
const { leggiFogli } = require('../../crm/lib/importa');

const cella = v => (v == null ? '' : String(v)).replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
const normRuolo = s => cella(s).toUpperCase().replace(/[—–-]+/g, '-').replace(/\s*-\s*/g, ' - ').replace(/\s+/g, ' ').trim();
const numero = s => { const m = String(s || '').replace(/\./g, '').match(/\d+(?:,\d+)?/); return m ? Number(m[0].replace(',', '.')) : null; };

// una voce del variabile → regola
function regola(riga, i) {
  const testo = riga.replace(/^[\s●•\-·]+/, '').trim();
  const U = testo.toUpperCase().replace(/’/g, "'");
  const base = { id: 'r' + (i + 1), testo };
  if (!testo) return null;
  // note senza importo (es. «SOLO P.iva», «VEDI PIANO INCENTIVI SPECIFICO»)
  if (/^SOLO\b|^VEDI\b/.test(U)) return { ...base, tipo: 'nota' };
  const pm = U.match(/(\d+(?:[.,]\d+)?)\s*%/);
  // non calcolabili con i dati dell'app: a mano
  if (!pm || !/FATTURATO/.test(U) || /PORTA PAZIENTI|OV LAVORATE|SBLOCCATO|€\s*(PER|OGNI)|OGNI \d+ OV/.test(U)) return { ...base, tipo: 'manuale' };
  const perc = Number(pm[1].replace(',', '.'));
  // base: fatturato personale o fatturato della sede (UL / studio / area)
  const dopo = (U.split('FATTURATO')[1] || '').split(/\s(?:A|AL|IN|SUL|SBLOCCATO)\s/)[0];
  const sede = /STUDIO|\bUL\b|AREA/.test(dopo);
  const pers = !sede && /PERSONAL/.test(dopo + ' ' + U);
  const periodo = /TRIMESTRAL/.test(U) ? 'trim' : 'mese';
  const cond = {};
  const ot = U.match(/OVERTARGET\s*\+?\s*(\d+)\s*%/) || U.match(/AL\s*\+\s*(\d+)\s*%\s*(?:DEL\s*)?TARGET/);
  const chi = pers ? 'pers' : 'ul';
  if (ot) cond[chi] = 1 + Number(ot[1]) / 100;
  if (/TARGET DELL'UL E DI TARGET PERSONALE|TARGET STUDIO E PERSONALE|TARGET DELL'UL E PERSONALE/.test(U)) { cond.ul = cond.ul || 1; cond.pers = cond.pers || 1; }
  else if (!ot && /\bTARGET\b/.test(U)) cond[/TARGET PERSONALE|TARGET TRIMESTRALE PERSONALE/.test(U) ? 'pers' : chi] = 1;
  const conc = U.match(/CONCRETIZZAZIONE[^%]*?(\d+)\s*%/); if (conc) cond.conc = Number(conc[1]);
  const tmv = U.match(/TMV[^\d]*([\d.]+)/); if (tmv) cond.tmv = Number(tmv[1].replace(/\./g, ''));
  return { ...base, tipo: 'perc', perc, base: pers ? 'pers' : 'ul', periodo, cond };
}
function regoleDa(variabile) {
  return cella(variabile).split('\n').map(x => x.trim()).filter(Boolean).map(regola).filter(Boolean)
    .map((r, i) => ({ ...r, id: 'r' + (i + 1) }));
}
// descrizione leggibile di una regola
function spiega(r) {
  if (r.tipo === 'nota') return 'Nota (nessun importo)';
  if (r.tipo === 'manuale') return 'A mano: l’amministrazione scrive l’importo ogni mese';
  const c = r.cond || {}, pz = [];
  const t = (k, n) => k === 1 ? `a target ${n}` : `a overtarget +${Math.round((k - 1) * 100)}% ${n}`;
  if (c.ul) pz.push(t(c.ul, 'della sede'));
  if (c.pers) pz.push(t(c.pers, 'personale'));
  if (c.conc) pz.push(`concretizzazione ≥ ${c.conc}%`);
  if (c.tmv) pz.push(`TMV ≥ € ${c.tmv.toLocaleString('it-IT')}`);
  return `${String(r.perc).replace('.', ',')}% del fatturato ${r.base === 'pers' ? 'personale' : 'della sede'} ${r.periodo === 'trim' ? 'del trimestre' : 'del mese'}${pz.length ? ' · ' + pz.join(' e ') : ' · sempre'}`;
}

async function leggi(buf, nomeFile) {
  const fogli = await leggiFogli(buf);
  const nomi = Object.keys(fogli);
  const fp = nomi.find(n => /piano/i.test(n)) || nomi[0];
  const righe = fogli[fp] || [];
  const iH = righe.findIndex(r => normRuolo(r[0]) === 'RUOLO' && /OBIETTIV/i.test(cella(r[3])));
  if (iH < 0) throw Object.assign(new Error(`«${nomeFile}»: non trovo la riga di intestazione (RUOLO | FISSO | VARIABILE | OBIETTIVI…).`), { status: 400 });
  const intest = righe[iH].slice(0, 7).map(cella);
  const titoli = righe.slice(0, iH).map(r => cella(r[0])).filter(Boolean);
  const tuttoIl = (titoli.join(' ') + ' ' + nomeFile).toUpperCase();
  const contratto = /PARTITA\s*IVA|P\.?\s?IVA/.test(tuttoIl) ? 'piva' : /CCNL/.test(tuttoIl) ? 'dip' : '';
  const livelli = [];
  for (const r of righe.slice(iH + 1)) {
    const ruolo = cella(r[0]), ob = cella(r[3]);
    if (!ruolo && !ob) continue;
    let l = livelli[livelli.length - 1];
    if (!l || (ruolo && normRuolo(ruolo) !== l.chiave)) { l = { chiave: normRuolo(ruolo || l?.ruolo), ruolo: ruolo || l?.ruolo || '', fisso: '', variabile: '', obiettivi: [] }; livelli.push(l); }
    if (!l.fisso && cella(r[1])) l.fisso = cella(r[1]);
    // il variabile è ripetuto su più righe dello stesso ruolo: si uniscono le voci (senza doppioni), così non se ne perde nessuna
    for (const v of cella(r[2]).split('\n').map(x => x.trim()).filter(Boolean)) if (!l.variabile.split('\n').includes(v)) l.variabile = l.variabile ? l.variabile + '\n' + v : v;
    l.obiettivi.push({ testo: ob, sotto: cella(r[4]), soft: cella(r[5]), scuola: cella(r[6]), fisso: cella(r[1]), variabile: cella(r[2]),
      test: /^superamento del test/i.test(ob) });
  }
  if (!livelli.length) throw Object.assign(new Error(`«${nomeFile}»: nessun ruolo trovato sotto l'intestazione.`), { status: 400 });
  const ff = nomi.find(n => /fonti|criteri/i.test(n));
  const note = ff ? fogli[ff].map(r => [cella(r[0]), cella(r[1])].filter(Boolean).join(': ')).filter(Boolean).join('\n') : '';
  return {
    file: nomeFile, titolo: titoli.join(' · '), contratto, intestazioni: intest, note,
    nome: contratto === 'piva' ? 'Partita IVA' : contratto === 'dip' ? 'CCNL' : (titoli[1] || titoli[0] || nomeFile).slice(0, 80),
    livelli: livelli.map(l => ({ ruolo: l.ruolo.replace(/\s+/g, ' ').trim(), fisso: l.fisso, fissoNum: numero(l.fisso), variabile: l.variabile,
      regole: regoleDa(l.variabile), obiettivi: l.obiettivi })),
  };
}

module.exports = { leggi, regoleDa, spiega, normRuolo, numero };
