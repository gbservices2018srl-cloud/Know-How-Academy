// AlfaDocs (gestionale dello studio): lettura con la chiave API dell'archivio (intestazione X-Api-Key).
// Chiave solo nelle impostazioni di Render (ALFADOCS_API_KEY), mai nel codice o nei log.
// Questo modulo per ora serve alla PROVA del collegamento: legge solo nomi dei campi e conteggi, mai dati dei pazienti.
const BASE = (process.env.ALFADOCS_URL || 'https://app.alfadocs.com').replace(/\/$/, '');
const chiave = () => process.env.ALFADOCS_API_KEY || '';
const configurato = () => !!chiave();

async function chiedi(percorso) {
  const r = await fetch(BASE + percorso, { headers: { 'X-Api-Key': chiave(), Accept: 'application/json' }, signal: AbortSignal.timeout(20000) });
  const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* non JSON */ }
  if (!r.ok) throw new Error(`AlfaDocs ${r.status}${j?.message ? ': ' + String(j.message).slice(0, 150) : ''}`);
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
  if (!configurato()) return { configurato: false };
  const out = { configurato: true, passi: [] };
  const passo = async (nome, fn) => { try { const r = await fn(); out.passi.push({ nome, ok: true, ...r }); return r; } catch (e) { out.passi.push({ nome, ok: false, errore: e.message }); return null; } };
  const me = await passo('Chi sono (studio e archivio)', async () => { const j = await chiedi('/api/v1/me'); return { forma: forma(j), _j: j }; });
  const d = me?._j?.data || me?._j || {};
  const pid = d.practiceId || d.practice?.id || d.practice_id, aid = d.archiveId || d.archive?.id || d.archive_id;
  if (me) delete me._j;
  if (!pid || !aid) { out.nota = 'Non trovo practiceId/archiveId nella risposta di /me: guarda la forma qui sopra.'; return out; }
  const base = `/api/v1/practices/${encodeURIComponent(pid)}/archives/${encodeURIComponent(aid)}`;
  await passo('Archivio', async () => { const j = await chiedi('/api/v1/archives/current'); const a = j?.data || j || {}; return { archivio: a.name || a.nome || '', forma: forma(j) }; });
  await passo('Medici e operatori', async () => { const j = await chiedi(`${base}/operators`); const L = lista(j); return { quanti: L.length, nomi: L.map(o => [o.firstName || o.name || '', o.lastName || ''].join(' ').trim()).filter(Boolean).slice(0, 60), forma: forma(L[0] || j) }; });
  const oggi = new Date(), sette = new Date(Date.now() - 7 * 86400000);
  const app = await passo('Appuntamenti ultimi 7 giorni', async () => {
    const j = await chiedi(`${base}/appointments?startDate=${giorno(sette)}&endDate=${giorno(oggi)}`); const L = lista(j);
    return { quanti: L.length, forma: forma(L[0] || j), _primo: L.find(a => a.id) };
  });
  if (app?._primo) {
    const id = app._primo.id; delete app._primo;
    await passo('Prestazioni di un appuntamento', async () => { const j = await chiedi(`${base}/appointments/${encodeURIComponent(id)}/entries`); const L = lista(j); return { quanti: L.length, forma: forma(L[0] || j) }; });
  } else if (app) delete app._primo;
  await passo('Fatture ultimi 31 giorni', async () => { const j = await chiedi(`${base}/bills`); const L = lista(j); return { quanti: L.length, forma: forma(L[0] || j) }; });
  await passo('Incassi ultimi 31 giorni', async () => { const j = await chiedi(`${base}/transactions?direction=incoming`); const L = lista(j); return { quanti: L.length, forma: forma(L[0] || j) }; });
  await passo('Poltrone (riuniti)', async () => { const j = await chiedi(`${base}/chairs`); const L = lista(j); return { quanti: L.length, nomi: L.map(c => c.name || '').filter(Boolean), forma: forma(L[0] || j) }; });
  return out;
}
module.exports = { configurato, prova, forma };
