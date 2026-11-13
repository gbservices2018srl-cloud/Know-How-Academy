// Regole dei KPI di vendita, identiche a quelle della vecchia dashboard "KPI Vendite To Smile" (METRICHE.md),
// così i numeri coincidono. Qui entrano solo righe SENZA dati personali (niente paziente, anno di nascita, note).
const DILAZ = 'PAGAMENTO DILAZIONATO';
const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
// gennaio–luglio 2026: ogni studio aveva un solo commerciale e i preventivi vanno a lui, qualunque cosa dica il CRM
const UNICO_2026 = { cabras: 'Luca', elmas: 'Guarino', dolianova: 'Veronica', capoterra: 'Laura', maracalagonis: 'Alessandro Zoppi', sardara: 'Sardara (studio)' };
const ALIAS = { FRATTINI: 'FRATINI', CCAMPUS: 'CAMPUS', 'GV MANCA': 'MANCA', 'MANCA GV': 'MANCA', GV: 'MANCA', 'PINNA ALESSANDRO': 'PINNA', DIAS: 'DEIAS' };
const SCARTA = new Set(['IGIENISTA', 'NESSUNO', 'VARI', '?', '0', '--', '//', 'OK', 'SETTEMBRE', 'OTTOBRE']);

const r2 = x => Math.round(x * 100) / 100;
const cap = s => { s = String(s || '').trim(); return s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : s; };
const titolo = s => String(s || '').toLowerCase().replace(/(^|[\s'’-])(\S)/g, (m, a, b) => a + b.toUpperCase());
const normSede = x => String(x || '').toLowerCase().replace(/to\s*smile|studio|sede|ambulatorio/g, '').replace(/[^a-z0-9]/g, '');

// medici dalla colonna "Medico": maiuscolo, alias, più medici con / o +, scarti
function medici(raw) {
  const o = String(raw || '').trim().toUpperCase();
  if (!o || /\d/.test(o) || /PAG|DILAZ|RECALL|ORAL/.test(o)) return [];
  const out = [];
  for (let p of o.split(/[\/+]/)) {
    p = p.trim().replace(/\s+/g, ' '); p = ALIAS[p] || p;
    if (!p || SCARTA.has(p) || p.split(' ').length > 2) continue;
    if (!out.includes(p)) out.push(p);
  }
  return out.map(titolo);
}

// righe del database → dataset senza dati personali (come in "Chiedi al CRM")
// canaleDi: marketing grezzo → canale uniformato (dalla micro app Liste)
function dataset(rows, canaleDi, alias = c => c) {
  const preventivi = [], med = [], dilazionati = [], opportunita = [];
  for (const r of rows) {
    const sede = r.sede_nome, mese = Number(r.mese), anno = Number(r.anno), tri = Math.ceil(mese / 3);
    const pdc = Number(r.pdc) || 0, pagRaw = Number(r.pagato) || 0;
    const tipo = String(r.tipo_ov || '').trim().toUpperCase();
    if (tipo === DILAZ) { dilazionati.push({ sede, anno, mese, pagato: pagRaw }); continue; }
    const acc = r.esito === 'A' ? 1 : 0;
    const tipologia = tipo ? cap(tipo) : 'Non indicato';
    const mk = String(r.marketing || '').trim().toUpperCase();
    const canale = canaleDi(mk) || (mk ? cap(mk) : 'Non indicato');
    // commerciale unico (gennaio–luglio 2026): se in Liste quel nome è collegato a una persona, si usa la persona
    let unico = anno === 2026 && mese <= 7 ? UNICO_2026[normSede(sede)] : null;
    if (unico) { const m = alias(unico.toUpperCase()); if (m && m !== unico.toUpperCase()) unico = titolo(m); }
    const venditore = unico || titolo(r.commerciale) || 'Non indicato';
    const meds = medici(r.medico);
    preventivi.push({ sede, anno, mese, trimestre: tri, venditore, canale, tipologia, pdc, accettato: acc, pagato: acc ? pagRaw : 0 });
    opportunita.push({ sede, anno, mese, trimestre: tri, data: r.data || '', tipologia, canale_crm: mk || 'N/D', pdc, esito: r.esito || 'vuoto', accettato: acc,
      pagato: acc ? pagRaw : 0, tipo_pdc: String(r.tipo_pdc || '').toUpperCase(), venditore_crm: String(r.commerciale || '').toUpperCase(), medici: meds.join(' / ') });
    // il medico è indicato da settembre 2026
    if (anno > 2026 || mese >= 9) for (const m of meds) med.push({ sede, anno, mese, trimestre: tri, medico: m, tipologia, pdc, accettato: acc, pagato: acc ? pagRaw : 0, condiviso: meds.length > 1 ? 1 : 0 });
  }
  return { preventivi, medici: med, dilazionati, opportunita };
}

/* ---------- KPI della dashboard (stesse funzioni della vecchia pagina) ---------- */
function kpi(ov) {
  const agg = new Map();
  const add = (key, base, r) => {
    let a = agg.get(key);
    if (!a) { a = { key, ...base, presentati: 0, preventivato: 0, accettati: 0, pagato: 0, valore_accettato: 0 }; agg.set(key, a); }
    a.presentati += 1; a.preventivato += r.pdc; a.accettati += r.accettato; a.pagato += r.pagato; a.valore_accettato += r.accettato ? r.pdc : 0;
  };
  for (const r of ov) for (const modo of ['tutti', 'no0']) {
    if (modo === 'no0' && !(r.pdc >= 200)) continue;
    for (const periodo of ['m' + r.mese, 'q' + Math.ceil(r.mese / 3), 'anno']) {
      add(`rete|${periodo}|${modo}|Rete`, { livello: 'rete', periodo, modo, nome: 'Rete', sede: 'Tutti' }, r);
      add(`sede|${periodo}|${modo}|${r.sede}`, { livello: 'sede', periodo, modo, nome: r.sede, sede: r.sede }, r);
      if (r.venditore !== 'Non indicato') add(`venditore|${periodo}|${modo}|${r.sede}|${r.venditore}`, { livello: 'venditore', periodo, modo, nome: r.venditore, sede: r.sede }, r);
      for (const sede of ['Tutti', r.sede]) {
        add(`canale|${periodo}|${modo}|${sede}|${r.canale}`, { livello: 'canale', periodo, modo, nome: r.canale, sede }, r);
        add(`tipologia|${periodo}|${modo}|${sede}|${r.tipologia}`, { livello: 'tipologia', periodo, modo, nome: r.tipologia, sede }, r);
      }
    }
  }
  return [...agg.values()].map(a => ({ ...a, perc: a.presentati ? a.accettati / a.presentati : null, ticket: a.accettati ? a.pagato / a.accettati : null }));
}
const mean = xs => xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : null;
function medie(K) {
  const out = [];
  for (const modo of ['tutti', 'no0']) {
    const anno = K.find(r => r.key === `rete|anno|${modo}|Rete`);
    for (const livello of ['rete', 'sede', 'venditore', 'canale', 'tipologia']) {
      const base = K.filter(r => r.livello === livello && r.modo === modo && ((livello !== 'canale' && livello !== 'tipologia') || r.sede === 'Tutti'));
      const per = pre => base.filter(r => pre === 'anno' ? r.periodo === 'anno' : r.periodo[0] === pre);
      const m = per('m'), q = per('q'), y = per('anno');
      out.push({ key: `${livello}|${modo}`, livello, modo, perc_anno: anno ? anno.perc : null, ticket_anno: anno ? anno.ticket : null,
        presentati_mese: mean(m.map(r => r.presentati)), accettati_mese: mean(m.map(r => r.accettati)),
        presentati_trim: mean(q.map(r => r.presentati)), accettati_trim: mean(q.map(r => r.accettati)),
        presentati_anno: mean(y.map(r => r.presentati)), accettati_anno: mean(y.map(r => r.accettati)),
        preventivato_mese: mean(m.map(r => r.preventivato)), preventivato_trim: mean(q.map(r => r.preventivato)), preventivato_anno: mean(y.map(r => r.preventivato)) });
    }
    for (const s of K.filter(r => r.livello === 'sede' && r.modo === modo && r.periodo === 'anno')) {
      const own = K.filter(r => r.livello === 'sede' && r.modo === modo && r.nome === s.nome);
      const per = pre => own.filter(r => r.periodo[0] === pre);
      const m = per('m'), q = per('q');
      out.push({ key: `studio|${modo}|${s.nome}`, livello: 'studio', modo, nome: s.nome, perc_anno: s.perc, ticket_anno: s.ticket,
        presentati_mese: mean(m.map(r => r.presentati)), accettati_mese: mean(m.map(r => r.accettati)),
        presentati_trim: mean(q.map(r => r.presentati)), accettati_trim: mean(q.map(r => r.accettati)),
        presentati_anno: s.presentati, accettati_anno: s.accettati,
        preventivato_mese: mean(m.map(r => r.preventivato)), preventivato_trim: mean(q.map(r => r.preventivato)), preventivato_anno: s.preventivato });
    }
  }
  return out;
}
function dilazStudi(D) {
  const out = new Map();
  for (const d of D) {
    const p = Number(d.pagato) || 0;
    for (const periodo of ['m' + d.mese, 'q' + Math.ceil(d.mese / 3), 'anno']) for (const modo of ['tutti', 'no0']) {
      const key = `sede|${periodo}|${modo}|${d.sede}`;
      if (!out.has(key)) out.set(key, { key, periodo, modo, sede: d.sede, dilazionati: 0 });
      out.get(key).dilazionati += p;
    }
  }
  return [...out.values()];
}
function kpiMed(M) {
  const agg = new Map();
  for (const r of M) for (const modo of ['tutti', 'no0']) {
    if (modo === 'no0' && !(r.pdc >= 200)) continue;
    for (const periodo of ['m' + r.mese, 'q' + Math.ceil(r.mese / 3), 'anno']) for (const sede of ['Tutti', r.sede]) {
      const key = `medico|${periodo}|${modo}|${sede}|${r.medico}`;
      let a = agg.get(key);
      if (!a) { a = { key, livello: 'medico', periodo, modo, nome: r.medico, sede, sediSet: {}, presentati: 0, preventivato: 0, accettati: 0, pagato: 0 }; agg.set(key, a); }
      a.presentati += 1; a.preventivato += r.pdc; a.accettati += r.accettato; a.pagato += r.pagato; a.sediSet[r.sede] = 1;
    }
  }
  return [...agg.values()].map(({ sediSet, ...a }) => ({ ...a, sedi: Object.keys(sediSet).sort().join(', '), perc: a.presentati ? a.accettati / a.presentati : null, ticket: a.accettati ? a.pagato / a.accettati : null }));
}
function medieMed(KM, K) {
  return ['tutti', 'no0'].map(modo => {
    const anno = K.find(r => r.key === `rete|anno|${modo}|Rete`);
    const base = KM.filter(r => r.modo === modo && r.sede === 'Tutti');
    const per = pre => base.filter(r => pre === 'anno' ? r.periodo === 'anno' : r.periodo[0] === pre);
    const m = per('m'), q = per('q'), y = per('anno');
    return { key: `medico|${modo}`, livello: 'medico', modo, perc_anno: anno ? anno.perc : null, ticket_anno: anno ? anno.ticket : null,
      presentati_mese: mean(m.map(r => r.presentati)), accettati_mese: mean(m.map(r => r.accettati)),
      presentati_trim: mean(q.map(r => r.presentati)), accettati_trim: mean(q.map(r => r.accettati)),
      presentati_anno: mean(y.map(r => r.presentati)), accettati_anno: mean(y.map(r => r.accettati)) };
  });
}
function dashboard(ds) {
  const K = kpi(ds.preventivi), KM = kpiMed(ds.medici);
  return { kpi: K, medie: medie(K), dilaz_studi: dilazStudi(ds.dilazionati), kpi_med: KM, medie_med: medieMed(KM, K) };
}

/* ---------- strumenti per "Chiedi al CRM" (stessi della vecchia pagina) ---------- */
const NUMERIC = new Set(['anno', 'mese', 'trimestre', 'pdc', 'accettato', 'pagato', 'condiviso']);
function applyFilters(rows, filters) {
  if (!Array.isArray(filters)) return rows;
  return rows.filter(r => filters.every(f => {
    const v = r[f.field], x = f.value, op = f.op || 'eq';
    const s = a => String(a ?? '').toLowerCase();
    switch (op) {
      case 'eq': return NUMERIC.has(f.field) ? Number(v) === Number(x) : s(v) === s(x);
      case 'ne': return NUMERIC.has(f.field) ? Number(v) !== Number(x) : s(v) !== s(x);
      case 'in': return Array.isArray(x) && x.some(y => NUMERIC.has(f.field) ? Number(v) === Number(y) : s(v) === s(y));
      case 'not_in': return Array.isArray(x) && !x.some(y => NUMERIC.has(f.field) ? Number(v) === Number(y) : s(v) === s(y));
      case 'gt': return Number(v) > Number(x);
      case 'gte': return Number(v) >= Number(x);
      case 'lt': return Number(v) < Number(x);
      case 'lte': return Number(v) <= Number(x);
      case 'contains': return s(v).includes(s(x));
      default: throw new Error('Operatore non valido: ' + op);
    }
  }));
}
function metric(rows, m) {
  const sum = f => rows.reduce((a, r) => a + (Number(r[f]) || 0), 0);
  if (m === 'count' || m === 'presentati') return rows.length;
  if (m === 'accettati') return sum('accettato');
  if (m === 'perc_accettazione') return rows.length ? r2(100 * sum('accettato') / rows.length) : null;
  if (m === 'incassato') return r2(sum('pagato'));
  if (m === 'ticket_medio') { const a = sum('accettato'); return a ? r2(sum('pagato') / a) : null; }
  if (m === 'pdc_accettato') return r2(rows.reduce((a, r) => a + (r.accettato ? Number(r.pdc) || 0 : 0), 0));
  if (m === 'pdc_non_accettato') return r2(rows.reduce((a, r) => a + (r.accettato ? 0 : Number(r.pdc) || 0), 0));
  const [k, f] = String(m).split(':');
  if (!f) throw new Error('Metrica sconosciuta: ' + m);
  const xs = rows.map(r => Number(r[f])).filter(x => isFinite(x));
  if (k === 'sum') return r2(xs.reduce((a, b) => a + b, 0));
  if (k === 'avg') return xs.length ? r2(xs.reduce((a, b) => a + b, 0) / xs.length) : null;
  if (k === 'median') { if (!xs.length) return null; const s = xs.slice().sort((a, b) => a - b), h = s.length >> 1; return r2(s.length % 2 ? s[h] : (s[h - 1] + s[h]) / 2); }
  if (k === 'min') return xs.length ? Math.min(...xs) : null;
  if (k === 'max') return xs.length ? Math.max(...xs) : null;
  if (k === 'count_distinct') return new Set(rows.map(r => r[f])).size;
  throw new Error('Metrica sconosciuta: ' + m);
}
const DESC = {
  preventivi: 'Un preventivo presentato per riga (esclusi i pagamenti dilazionati). È la base dei KPI della dashboard. Campi: sede, anno, mese (1-12), trimestre, venditore (gennaio-luglio 2026 = commerciale unico dello studio; poi quello indicato; "Non indicato" se manca), canale (uniformato), tipologia, pdc (€ piano di cura), accettato (0/1), pagato (€, solo se accettato).',
  medici: 'Un preventivo per medico che ha fatto la visita, da settembre 2026. Una visita con più medici compare una volta per ognuno (condiviso=1). Campi: sede, anno, mese, trimestre, medico, tipologia, pdc, accettato, pagato, condiviso.',
  dilazionati: 'Rate di pagamenti dilazionati: sede, anno, mese, pagato. Non entrano nei KPI; servono solo per il fatturato totale (incassato + dilazionati).',
  opportunita: 'Riga per riga (esclusi dilazionati), per analisi di dettaglio: sede, anno, mese, trimestre, data (AAAA-MM-GG), tipologia, canale_crm (marketing grezzo), pdc, esito (A accettato, S sospeso, R rifiutato), accettato, pagato, tipo_pdc, venditore_crm, medici.',
};
const NOMI_DS = ['preventivi', 'medici', 'dilazionati', 'opportunita'];
function strumenti(DATA) {
  const ds = name => { const d = DATA[name]; if (!Array.isArray(d)) throw new Error('Dataset sconosciuto: ' + name + '. Usa: ' + NOMI_DS.join(', ')); return d; };
  return [
    { name: 'schema', description: 'Descrive i dataset del CRM: righe, campi e valori possibili dei campi testuali. Chiamalo per primo se non conosci i valori esatti (nomi di studi, medici, venditori, canali, tipologie).',
      input_schema: { type: 'object', properties: { dataset: { type: 'string', enum: NOMI_DS } } },
      execute(input) {
        const names = input.dataset ? [String(input.dataset)] : NOMI_DS;
        const out = {};
        for (const n of names) {
          const rows = ds(n), fields = rows.length ? Object.keys(rows[0]) : [];
          const valori = {};
          for (const f of fields) if (!NUMERIC.has(f) && f !== 'data') {
            const c = new Map(); rows.forEach(r => c.set(r[f], (c.get(r[f]) || 0) + 1));
            valori[f] = [...c.entries()].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([v, k]) => `${v} (${k})`);
          }
          out[n] = { descrizione: DESC[n], righe: rows.length, campi: fields, anni_presenti: [...new Set(rows.map(r => r.anno))].sort(), mesi_presenti: [...new Set(rows.map(r => r.mese))].sort((a, b) => a - b), valori_testuali: valori };
        }
        return out;
      } },
    { name: 'aggregate', description: 'Filtra e raggruppa un dataset e calcola metriche. Metriche: count (=presentati), accettati, perc_accettazione (0-100), incassato, ticket_medio (incassato ÷ accettati), pdc_accettato, pdc_non_accettato, oppure "sum:campo", "avg:campo", "median:campo", "min:campo", "max:campo", "count_distinct:campo". Restituisce al massimo 300 gruppi.',
      input_schema: { type: 'object', properties: {
        dataset: { type: 'string', enum: NOMI_DS },
        filters: { type: 'array', items: { type: 'object', properties: { field: { type: 'string' }, op: { type: 'string', enum: ['eq', 'ne', 'in', 'not_in', 'gt', 'gte', 'lt', 'lte', 'contains'] }, value: {} }, required: ['field', 'value'] } },
        group_by: { type: 'array', items: { type: 'string' }, description: 'Campi per cui raggruppare; vuoto = un solo totale.' },
        metrics: { type: 'array', items: { type: 'string' } },
        sort_by: { type: 'string', description: 'Metrica o campo per ordinare.' }, desc: { type: 'boolean' }, limit: { type: 'integer' },
      }, required: ['dataset', 'metrics'] },
      execute(input) {
        const rows = applyFilters(ds(String(input.dataset)), input.filters);
        const gb = Array.isArray(input.group_by) ? input.group_by.map(String) : [];
        const metrics = Array.isArray(input.metrics) && input.metrics.length ? input.metrics.map(String) : ['count'];
        const groups = new Map();
        for (const r of rows) { const k = JSON.stringify(gb.map(g => r[g])); if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
        let out = [...groups.entries()].map(([k, rs]) => { const o = {}; JSON.parse(k).forEach((v, i) => { o[gb[i]] = v; }); metrics.forEach(m => { o[m] = metric(rs, m); }); return o; });
        const sb = input.sort_by ? String(input.sort_by) : null;
        if (sb) out.sort((a, b) => { const x = a[sb], y = b[sb]; if (x == null) return 1; if (y == null) return -1; const c = typeof x === 'string' ? x.localeCompare(y, 'it') : x - y; return input.desc === false ? c : -c; });
        else if (gb.length) out.sort((a, b) => gb.reduce((c, g) => c || (typeof a[g] === 'number' ? a[g] - b[g] : String(a[g]).localeCompare(String(b[g]), 'it')), 0));
        return { righe_filtrate: rows.length, gruppi_totali: out.length, risultati: out.slice(0, Math.min(Number(input.limit) || 300, 300)) };
      } },
    { name: 'rows', description: 'Restituisce righe singole (già senza dati dei pazienti) di un dataset filtrato, per esempi o controlli puntuali. Massimo 60 righe.',
      input_schema: { type: 'object', properties: { dataset: { type: 'string', enum: NOMI_DS }, filters: { type: 'array', items: { type: 'object' } }, sort_by: { type: 'string' }, desc: { type: 'boolean' }, limit: { type: 'integer' } }, required: ['dataset'] },
      execute(input) {
        let rows = applyFilters(ds(String(input.dataset)), input.filters).slice();
        if (input.sort_by) { const f = String(input.sort_by); rows.sort((a, b) => { const c = typeof a[f] === 'number' ? a[f] - b[f] : String(a[f]).localeCompare(String(b[f]), 'it'); return input.desc === false ? c : -c; }); }
        return { totale: rows.length, righe: rows.slice(0, Math.min(Number(input.limit) || 30, 60)) };
      } },
  ];
}

module.exports = { DILAZ, MESI, medici, dataset, dashboard, strumenti, normSede, cap, titolo };
