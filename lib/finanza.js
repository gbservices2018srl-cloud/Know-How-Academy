// Collegamento con Gestione finanziaria (finanza.appgestione.it) per le app della suite: stessa chiave SSO_API_KEY.
// Solo dati aggregati per sede (fatturato, voci di costo): niente dati personali.
const FIN_URL = () => (process.env.FINANZA_URL || 'https://finanza.appgestione.it').replace(/\/$/, '');
const cache = new Map();
async function chiama(p) {
  const key = process.env.SSO_API_KEY; if (!key) throw new Error('Collegamento con Gestione finanziaria non configurato.');
  const c = cache.get(p); if (c && Date.now() - c.t < 5 * 60e3) return c.v;
  const r = await fetch(FIN_URL() + p, { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) throw new Error('Gestione finanziaria non risponde (' + r.status + ').');
  const v = await r.json(); cache.set(p, { t: Date.now(), v }); if (cache.size > 50) cache.clear();
  return v;
}
// l'azienda To Smile: quella scelta nel CRM (Liste), altrimenti l'unica che si chiama "To Smile"
async function aziendaToSmile() {
  try {
    const store = require('../accessi/server').store;
    const { rows: [r] } = await store.q(`select v from crm.impostazioni where k = 'fin_azienda'`);
    if (r && r.v) return r.v;
  } catch { /* il CRM non c'è ancora */ }
  const az = (await chiama('/api/_appgestione/aziende')).aziende || [];
  const ts = az.filter(a => /to\s*smile/i.test(a.nome));
  return ts.length === 1 ? ts[0].id : null;
}
// sede della suite → sede di Gestione finanziaria: stesso nome (senza «To Smile», «studio», spazi…), altrimenti
// l'unica il cui nome contiene l'altro (es. «Capoterra» e «Capoterra Poggio dei Pini»). Nessuna o più di una → null
function trova(lista, nome) {
  const n = normSede(nome); if (!n) return null;
  const L = (lista || []).map(x => ({ x, k: normSede(x.nome) })).filter(o => o.k);
  const es = L.filter(o => o.k === n); if (es.length === 1) return es[0].x;
  const c = L.filter(o => o.k.includes(n) || n.includes(o.k)); if (c.length === 1) return c[0].x;
  return null;
}
const normSede = x => String(x || '').toLowerCase().replace(/to\s*smile|studio|sede|ambulatorio/g, '').replace(/[^a-z0-9]/g, '');
const messaggio = e => /fetch failed|aborted|timeout/i.test(e.message) ? 'Gestione finanziaria non raggiungibile in questo momento: riprova tra poco.' : e.message;
module.exports = { chiama, aziendaToSmile, normSede, trova, messaggio };
