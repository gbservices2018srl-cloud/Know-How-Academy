// AlfaDocs (gestionale dello studio): lettura con la chiave API dell'archivio (intestazione X-Api-Key).
// Una chiave per ogni sede, solo nelle impostazioni di Render: ALFADOCS_KEY_<SEDE> (es. ALFADOCS_KEY_CABRAS), mai nel codice o nei log.
// (ALFADOCS_API_KEY, se c'è, vale come chiave unica senza sede.)
// Questo modulo per ora serve alla PROVA del collegamento: legge solo nomi dei campi e conteggi, mai dati dei pazienti.
const BASE = (process.env.ALFADOCS_URL || 'https://app.alfadocs.com').replace(/\/$/, '');
// [{ sede: 'CABRAS', chiave }] dalle variabili ALFADOCS_KEY_<SEDE>
function chiavi() {
  const L = Object.keys(process.env).filter(k => /^ALFADOCS_KEY_[A-Z0-9_]+$/.test(k) && process.env[k]).sort()
    .map(k => ({ sede: k.slice('ALFADOCS_KEY_'.length).replace(/_/g, ' '), chiave: process.env[k] }));
  if (process.env.ALFADOCS_API_KEY) L.push({ sede: '(chiave unica)', chiave: process.env.ALFADOCS_API_KEY });
  // chiavi inserite dall'app (pagina Collegamenti, salvate cifrate): per sede, hanno la precedenza
  let app = {}; try { app = JSON.parse(process.env.ALFADOCS_CHIAVI_APP || '{}') || {}; } catch { app = {}; }
  for (const [sede, chiave] of Object.entries(app)) {
    const i = L.findIndex(x => x.sede.toUpperCase() === sede.toUpperCase());
    if (i >= 0) L[i] = { sede, chiave }; else L.push({ sede, chiave });
  }
  return L;
}
const configurato = () => chiavi().length > 0;

async function chiedi(percorso, chiave) {
  const r = await fetch(BASE + percorso, { headers: { 'X-Api-Key': chiave, Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* non JSON */ }
  if (!r.ok) {
    const spiega = j?.message || j?.error_description || j?.error?.message || (typeof j?.error === 'string' ? j.error : '') || j?.detail || j?.title || (j ? '' : t.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    throw new Error(`AlfaDocs ${r.status}${r.status === 403 ? ' (accesso negato)' : r.status === 401 ? ' (chiave non valida)' : ''}${spiega ? ': ' + String(spiega).slice(0, 200) : ''}`);
  }
  return j;
}
// struttura senza valori: solo i nomi dei campi (anche annidati), per capire cosa arriva senza vedere dati personali
function forma(x, prof = 0) {
  if (Array.isArray(x)) return x.length ? [forma(x[0], prof + 1)] : [];
  if (x && typeof x === 'object') { if (prof > 4) return '{…}'; const o = {}; for (const k of Object.keys(x)) o[k] = forma(x[k], prof + 1); return o; }
  return typeof x;
}
const lista = j => Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : Array.isArray(j?.items) ? j.items : Array.isArray(j?.data?.items) ? j.data.items : [];
const giorno = d => d.toISOString().slice(0, 10);

async function prova() {
  if (!configurato()) return { configurato: false, sedi: [] };
  const sedi = [];
  for (const { sede, chiave } of chiavi()) sedi.push({ sede, ...(await provaSede(chiave)) });
  return { configurato: true, sedi };
}
async function provaSede(chiave) {
  const out = { passi: [] };
  const passo = async (nome, fn) => { try { const r = await fn(); out.passi.push({ nome, ok: true, ...Object.fromEntries(Object.entries(r || {}).filter(([k]) => !k.startsWith('_'))) }); return r; } catch (e) { out.passi.push({ nome, ok: false, errore: e.message }); return null; } };
  const me = await passo('Chi sono (studio e archivio)', async () => { const j = await chiedi('/api/v1/me', chiave); return { forma: forma(j), _j: j }; });
  const d = me?._j?.data || me?._j || {};
  const pid = d.practiceId || d.practice?.id || d.practice_id, aid = d.archiveId || d.archive?.id || d.archive_id;
  if (me) delete me._j;
  if (!pid || !aid) { out.nota = 'Non trovo practiceId/archiveId nella risposta di /me: guarda la forma qui sopra.'; return out; }
  const base = `/api/v1/practices/${encodeURIComponent(pid)}/archives/${encodeURIComponent(aid)}`;
  await passo('Archivio', async () => { const j = await chiedi('/api/v1/archives/current', chiave); const a = j?.data || j || {}; return { archivio: a.name || a.nome || '', forma: forma(j) }; });
  await passo('Medici e operatori', async () => { const j = await chiedi(`${base}/operators`, chiave); const L = lista(j); return { quanti: L.length, nomi: L.map(o => [o.firstName || o.name || '', o.lastName || ''].join(' ').trim()).filter(Boolean).slice(0, 60), forma: forma(L[0] || j) }; });
  const oggi = new Date(), sette = new Date(Date.now() - 7 * 86400000);
  const app = await passo('Appuntamenti ultimi 7 giorni', async () => {
    const j = await chiedi(`${base}/appointments?startDate=${giorno(sette)}&endDate=${giorno(oggi)}`, chiave); const L = lista(j);
    const fatti = L.filter(a => a.state && a.state !== 'cancelled'), conPiano = L.filter(a => a.carePlanId);
    return { quanti: L.length, stati: [...new Set(L.map(a => a.state))], conPianoDiCura: conPiano.length, forma: forma(L[0] || j), _primo: fatti.find(a => a.carePlanId) || fatti[0] || L[0], _piani: [...new Set(conPiano.map(a => a.carePlanId))].slice(0, 15) };
  });
  // prestazioni eseguite: stanno nei piani di cura (si prova su alcuni piani degli appuntamenti della settimana)
  if (app?._piani?.length) {
    await passo('Prestazioni nei piani di cura', async () => {
      let tot = 0, fatte = 0, esempio = null, conMedico = 0;
      for (const id of app._piani) {
        const L = lista(await chiedi(`${base}/care-plans/${encodeURIComponent(id)}/entries/default?extended=true`, chiave));
        tot += L.length;
        for (const e of L) { const f = e.done === true || e.done === 'true' || e.done === 1; if (f) { fatte++; if (!esempio) esempio = e; } if (e.operatorId || e.operator || e.executedByOperatorId) conMedico++; }
        if (!esempio && L[0]) esempio = L[0];
      }
      return { pianiProvati: app._piani.length, quanti: tot, eseguite: fatte, conMedico, forma: forma(esempio || {}) };
    });
  }
  if (app?._primo) {
    const id = app._primo.id;
    await passo('Prestazioni di un appuntamento', async () => { const j = await chiedi(`${base}/appointments/${encodeURIComponent(id)}/entries`, chiave); const L = lista(j); return { quanti: L.length, forma: forma(L[0] || j) }; });
  } else if (app) delete app._primo;
  await passo('Fatture ultimi 31 giorni', async () => { const j = await chiedi(`${base}/bills`, chiave); const L = lista(j); return { quanti: L.length, forma: forma(L[0] || j) }; });
  await passo('Incassi ultimi 31 giorni', async () => { const j = await chiedi(`${base}/transactions?direction=incoming`, chiave); const L = lista(j); return { quanti: L.length, forma: forma(L[0] || j) }; });
  await passo('Poltrone (riuniti)', async () => { const j = await chiedi(`${base}/chairs`, chiave); const L = lista(j); return { quanti: L.length, nomi: L.map(c => c.name || '').filter(Boolean), forma: forma(L[0] || j) }; });
  return out;
}
// prova veloce di una sede: la chiave funziona? (nome dell'archivio)
async function provaBreve(sede) {
  const c = chiavi().find(x => x.sede === sede); if (!c) return { ok: false, errore: 'Nessuna chiave per questa sede.' };
  try {
    const me = await chiedi('/api/v1/me', c.chiave);
    let archivio = '';
    try { const j = await chiedi('/api/v1/archives/current', c.chiave), a = j?.data || j || {}; archivio = a.name || a.nome || ''; } catch { /* il nome dell'archivio è facoltativo */ }
    const d = me?.data || me || {};
    return { ok: true, archivio, ids: !!((d.practiceId || d.practice?.id) && (d.archiveId || d.archive?.id)) };
  } catch (e) { return { ok: false, errore: e.message }; }
}
module.exports = { provaBreve, configurato, chiavi: () => chiavi().map(c => c.sede), prova, forma };
