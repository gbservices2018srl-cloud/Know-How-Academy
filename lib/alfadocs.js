// AlfaDocs (gestionale dello studio): una chiave API per ogni sede (intestazione X-Api-Key).
// Le chiavi si inseriscono in «Collegamenti» (cifrate nel database) oppure su Render come ALFADOCS_KEY_<SEDE>.
// Calcola, per un periodo: incassato (incassi in entrata), produzione (prestazioni eseguite, al prezzo scontato)
// ed eseguito per medico. Solo numeri aggregati: nessun dato dei pazienti viene salvato, registrato o mandato all'AI.
const BASE = () => (process.env.ALFADOCS_URL || 'https://app.alfadocs.com').replace(/\/$/, '');

// [{ sede, chiave }]: prima le variabili di Render, poi quelle inserite dall'app (che hanno la precedenza)
function chiavi() {
  const L = Object.keys(process.env).filter(k => /^ALFADOCS_KEY_[A-Z0-9_]+$/.test(k) && process.env[k]).sort()
    .map(k => ({ sede: k.slice('ALFADOCS_KEY_'.length).replace(/_/g, ' '), chiave: process.env[k] }));
  let app = {}; try { app = JSON.parse(process.env.ALFADOCS_CHIAVI_APP || '{}') || {}; } catch { app = {}; }
  for (const [sede, chiave] of Object.entries(app)) {
    const i = L.findIndex(x => x.sede.toUpperCase() === sede.toUpperCase());
    if (i >= 0) L[i] = { sede, chiave }; else L.push({ sede, chiave });
  }
  return L;
}
const configurato = () => chiavi().length > 0;

// al massimo ~8 richieste al secondo (AlfaDocs ne permette 10)
let ultima = 0;
const attesa = async () => { const d = ultima + 125 - Date.now(); ultima = Math.max(Date.now(), ultima + 125); if (d > 0) await new Promise(ok => setTimeout(ok, d)); };
async function chiedi(percorso, chiave, prove = 3) {
  for (let i = 0; ; i++) {
    await attesa();
    let r;
    try { r = await fetch(BASE() + percorso, { headers: { 'X-Api-Key': chiave, Accept: 'application/json' }, signal: AbortSignal.timeout(30000) }); }
    catch { if (i < prove) { await new Promise(ok => setTimeout(ok, 2000 * (i + 1))); continue; } throw new Error('AlfaDocs non raggiungibile'); }
    if (r.status === 429 && i < prove) { await new Promise(ok => setTimeout(ok, 3000 * (i + 1))); continue; }
    const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* non JSON */ }
    if (!r.ok) {
      const spiega = j?.message || j?.error_description || j?.error?.message || (typeof j?.error === 'string' ? j.error : '') || j?.detail || '';
      throw new Error(`AlfaDocs ${r.status}${r.status === 403 ? ' (accesso negato)' : r.status === 401 ? ' (chiave non valida)' : ''}${spiega ? ': ' + String(spiega).slice(0, 150) : ''}`);
    }
    return j;
  }
}
const lista = j => Array.isArray(j) ? j : Array.isArray(j?.data) ? j.data : Array.isArray(j?.items) ? j.items : Array.isArray(j?.data?.items) ? j.data.items : [];
const num = v => { const n = Number(v); return Number.isFinite(n) ? n : 0; };
const vero = v => v === true || v === 'true' || v === 1 || v === '1';
const g10 = s => String(s || '').slice(0, 10);

async function base(chiave) {
  const me = await chiedi('/api/v1/me', chiave), d = me?.data || me || {};
  const pid = d.practiceId || d.practice?.id, aid = d.archiveId || d.archive?.id;
  if (!pid || !aid) throw new Error('AlfaDocs non indica studio e archivio di questa chiave');
  return `/api/v1/practices/${encodeURIComponent(pid)}/archives/${encodeURIComponent(aid)}`;
}

// prova veloce di una sede: la chiave funziona?
async function provaBreve(sede) {
  const c = chiavi().find(x => x.sede === sede); if (!c) return { ok: false, errore: 'Nessuna chiave per questa sede.' };
  try { await base(c.chiave); return { ok: true }; } catch (e) { return { ok: false, errore: e.message }; }
}

// periodo [da, a] (date YYYY-MM-DD, al massimo un mese): incassato, produzione, eseguito per medico
async function calcola(chiave, da, a, avanza = () => {}) {
  const B = await base(chiave);
  avanza('incassi');
  // incassato: incassi in entrata non annullati con data nel periodo
  const tr = lista(await chiedi(`${B}/transactions?direction=incoming&dateStart=${da}&dateEnd=${a}`, chiave));
  const incassato = tr.filter(t => !vero(t.deleted) && (t.direction || 'incoming') === 'incoming' && g10(t.date) >= da && g10(t.date) <= a)
    .reduce((s, t) => s + num(t.amount), 0);
  // produzione: prestazioni eseguite nel periodo. Ci si arriva dai pazienti degli appuntamenti e dai piani di cura delle fatture
  const pazienti = new Set(), piani = new Set();
  const m15 = da.slice(0, 8) + '15', m16 = da.slice(0, 8) + '16';
  avanza('appuntamenti');
  for (const [x, y] of [[da, m15 < a ? m15 : a], [m16, a]]) {
    if (x > y) continue;
    for (const ap of lista(await chiedi(`${B}/appointments?dateStart=${x}&dateEnd=${y}`, chiave))) {
      if (ap.state === 'cancelled' || ap.state === 'absent') continue;
      if (ap.patientId) pazienti.add(ap.patientId);
      if (ap.carePlanId) piani.add(ap.carePlanId);
    }
  }
  for (const b of lista(await chiedi(`${B}/bills?dateStart=${da}&dateEnd=${a}`, chiave))) if (b.carePlanId) piani.add(b.carePlanId);
  let n = 0;
  for (const p of pazienti) {
    if (++n % 25 === 0) avanza(`pazienti ${n} su ${pazienti.size}`);
    try { for (const c of lista(await chiedi(`${B}/patients/${encodeURIComponent(p)}/care-plans`, chiave))) if (c.id && !vero(c.deleted)) piani.add(c.id); }
    catch { /* paziente non leggibile: si va avanti */ }
  }
  let produzione = 0, prestazioni = 0;
  const perMedico = {};
  let k = 0;
  for (const id of piani) {
    if (++k % 25 === 0) avanza(`piani di cura ${k} su ${piani.size}`);
    let L = [];
    try { L = lista(await chiedi(`${B}/care-plans/${encodeURIComponent(id)}/entries/default?extended=true`, chiave)); } catch { continue; }
    for (const e of L) {
      if (vero(e.deleted) || !(vero(e.isExecuted) || vero(e.done))) continue;
      const quando = g10(e.executionDate || e.dateDone);
      if (!quando || quando < da || quando > a) continue;
      const valore = Math.max(0, num(e.price) - num(e.calculatedAbsoluteDiscount));
      produzione += valore; prestazioni++;
      const op = e.operatorId || 'senza medico';
      perMedico[op] = (perMedico[op] || 0) + valore;
    }
  }
  const r2 = v => Math.round(v * 100) / 100;
  return { incassato: r2(incassato), produzione: r2(produzione), prestazioni, pazienti: pazienti.size, piani: piani.size,
    perMedico: Object.fromEntries(Object.entries(perMedico).map(([k, v]) => [k, r2(v)])) };
}
module.exports = { chiavi: () => chiavi().map(c => c.sede), chiaveDi: sede => (chiavi().find(c => c.sede === sede) || {}).chiave, configurato, provaBreve, calcola };
