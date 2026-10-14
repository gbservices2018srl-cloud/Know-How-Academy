// Residui di ferie, ROL ed ex festività letti dal testo del cedolino con l'API di Claude.
// Ogni consulente impagina il cedolino a modo suo e le ferie possono essere in ore o in giorni:
// si legge il residuo con l'unità scritta nel cedolino e si mostra così, senza conversioni.
const UNITA = new Set(['ore', 'giorni']);

const PROMPT = `Questo è il testo estratto da un cedolino paga italiano (busta paga) di un dipendente. Trova i RESIDUI a fine mese di:
- ferie
- ROL / permessi (riduzione orario di lavoro, "PAR", "permessi retribuiti")
- ex festività (festività soppresse)
Per ognuno cerca nella tabella ferie/permessi la colonna o riga del residuo (può chiamarsi "Residuo", "Saldo", "Res.", "Da godere"; di solito residuo = residuo anno precedente + maturato - goduto).
Indica l'unità come è scritta nel cedolino: "ore" (ore, h, hh) oppure "giorni" (giorni, gg, gg.). Se l'unità non è scritta da nessuna parte, metti null.
Numeri con il punto decimale (es. 12,50 → 12.5). Se un residuo non c'è nel cedolino metti null.
Rispondi SOLO con JSON:
{"mese":"AAAA-MM o null","ferie":{"residuo":n|null,"unita":"ore"|"giorni"|null},"rol":{"residuo":n|null,"unita":"ore"|"giorni"|null},"exfest":{"residuo":n|null,"unita":"ore"|"giorni"|null},"dubbi":["breve, in italiano"]}

ESTRATTO DEL CEDOLINO (solo la parte di ferie e permessi; i dati personali sono stati tolti):
"""`;

// Minimizzazione dei dati: dal cedolino si tengono solo i pezzi intorno a ferie / ROL / permessi / ex festività
// (la tabella dei residui) e si cancellano codice fiscale, IBAN, email, matricole e importi in euro.
// Così al servizio di lettura non arrivano nome, dati anagrafici né retribuzione del dipendente.
const CHIAVI = /^(ferie|fer\.?|rol|r\.o\.l\.?|par|permess\w*|perm\.?|festivit\w*|ex-?fest\w*|fest\.?|soppress\w*|residu\w*|res\.?|saldo|maturat\w*|matur\.?|godut\w*|god\.?|spettant\w*|spett\.?|precedent\w*|prec\.?|a\.?p\.?|anno|da|godere|ore|giorni|gg\.?|hh)$/i;
const FORTI = /^(ferie|rol|r\.o\.l\.?|par|permess\w*|festivit\w*|ex-?fest\w*|soppress\w*|residu\w*)$/i;
function ritaglia(testo, togli = []) {
  const parole = String(testo || '').replace(/\s+/g, ' ').trim().split(' ');
  const tieni = new Uint8Array(parole.length);
  parole.forEach((w, i) => {
    if (!FORTI.test(w.replace(/[^\wàèéìòù.-]/gi, ''))) return;
    for (let k = Math.max(0, i - 12); k < Math.min(parole.length, i + 36); k++) tieni[k] = 1;
  });
  const pezzi = []; let cur = [];
  parole.forEach((w, i) => { if (tieni[i]) cur.push(w); else if (cur.length) { pezzi.push(cur.join(' ')); cur = []; } });
  if (cur.length) pezzi.push(cur.join(' '));
  return pezzi.join(' … ')
    .replace(/\b[A-Z]{6}\d{2}[A-Z]\d{2}[A-Z]\d{3}[A-Z]\b/gi, '[CF]')                // codice fiscale
    .replace(/\bIT\d{2}[A-Z]\d{10}[0-9A-Z]{12}\b/gi, '[IBAN]')                      // IBAN
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, '[email]')
    .replace(/€\s*-?[\d.]+(,\d+)?|-?[\d.]+(,\d+)?\s*€/g, '[importo]')              // importi in euro
    .replace(/\b\d{1,3}(\.\d{3})+(,\d+)?\b/g, '[importo]')                           // cifre con le migliaia: importi, non residui
    .replace(/\b\d{6,}\b/g, '[n]')                                                   // matricole, posizioni INPS…
    .replace(togli.length ? new RegExp(`\\b(${togli.map(x => x.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`, 'gi') : /$^/, '[…]');
}

async function leggi(testoCompleto, togli = []) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null;
  const t = ritaglia(testoCompleto, togli);
  const vuoti = { ferie: { residuo: null, unita: null }, rol: { residuo: null, unita: null }, exfest: { residuo: null, unita: null } };
  if (String(testoCompleto || '').replace(/\s+/g, ' ').trim().length < 80) return { ...vuoti, vuoto: true, dubbi: ['Il cedolino non contiene testo leggibile (forse è una scansione): scrivi i residui a mano.'], letto: new Date().toISOString() };
  if (t.length < 15) return { ...vuoti, vuoto: true, dubbi: ['Nel cedolino non trovo la tabella di ferie e permessi: scrivi i residui a mano.'], letto: new Date().toISOString() };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model: process.env.TURNI_AI_MODEL || 'claude-sonnet-5-5', max_tokens: 600,
      messages: [{ role: 'user', content: PROMPT + t.slice(0, 14000) + '"""' }] }),
    signal: AbortSignal.timeout(60000),
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`API ${r.status}`);
  const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  const out = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1));
  const voce = v => {
    const n = v && v.residuo != null ? Number(String(v.residuo).replace(',', '.')) : null;
    return { residuo: Number.isFinite(n) ? Math.round(n * 100) / 100 : null, unita: UNITA.has(v?.unita) ? v.unita : null };
  };
  const s = { ferie: voce(out.ferie), rol: voce(out.rol), exfest: voce(out.exfest),
    dubbi: (Array.isArray(out.dubbi) ? out.dubbi : []).slice(0, 5).map(x => String(x).slice(0, 200)), letto: new Date().toISOString() };
  return s.ferie.residuo == null && s.rol.residuo == null && s.exfest.residuo == null ? { ...s, vuoto: true } : s;
}

// Legge i residui di più buste, qualche alla volta, e li salva con salva(id, saldi). Gira dopo il caricamento, senza far aspettare.
async function leggiTutte(lista, salva) {
  const coda = [...lista];
  const lavora = async () => {
    for (let x = coda.shift(); x; x = coda.shift()) {
      try { const s = await leggi(x.testo, x.togli || []); if (s) await salva(x.id, s); }
      catch (e) { // si segna, così l'amministrazione vede che va riletto o scritto a mano
        console.warn('Turni, residui dal cedolino:', e.message);
        await salva(x.id, { ferie: { residuo: null, unita: null }, rol: { residuo: null, unita: null }, exfest: { residuo: null, unita: null },
          vuoto: true, dubbi: ['Lettura non riuscita: usa «Rileggi dal cedolino» o scrivi i residui a mano.'], letto: new Date().toISOString() }).catch(() => {});
      }
    }
  };
  await Promise.all([lavora(), lavora(), lavora()]);
}

module.exports = { leggi, leggiTutte, ritaglia };
