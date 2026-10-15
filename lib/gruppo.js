// Persone e gruppi del gruppo To Smile, per le app che mandano qualcosa "a chi": Comunicazioni, Documenti di studio.
// Le persone sono quelle dell'accesso unico abilitate all'app; la figura viene dall'accesso unico,
// le sedi da Turni (sedi in cui la persona lavora). Gruppi: tutti, figura:<id>, sede:<nome>.
const FIGURE = require('../accessi/figure');
const FIG = Object.fromEntries(FIGURE.map(f => [f.id, f]));
const nomeDi = c => `${c.firstName || ''} ${c.lastName || ''}`.trim() || c.email;

async function sediPerPersona() {
  const m = new Map();
  try {
    const turni = require('../turni/lib/db');
    const { rows } = await turni.q('select data from config where id = 1');
    const c = rows[0]?.data || {};
    for (const e of c.staff || []) {
      if (!e.ssoId) continue;
      const nomi = (c.sedi || []).filter(s => (e.ore?.[s.id] || 0) > 0).map(s => s.nome).filter(Boolean);
      if (nomi.length) m.set(e.ssoId, nomi);
    }
  } catch (e) { console.warn('Sedi dai Turni non lette:', e.message); }
  return m;
}

// sso: il collegamento dell'app all'accesso unico (accessi/collega). Elenco breve in memoria per 30 secondi.
function crea(sso) {
  let cache = null, quando = 0;
  async function persone() {
    if (cache && Date.now() - quando < 30000) return cache;
    const [lista, sedi] = await Promise.all([sso.usersWithApp(), sediPerPersona()]);
    cache = lista.map(c => ({ id: c.id, nome: nomeDi(c), figura: c.figura || '', figuraNome: FIG[c.figura]?.gruppo || '',
      sedi: sedi.get(c.id) || [], admin: c.role === 'admin' })).sort((a, b) => a.nome.localeCompare(b.nome, 'it'));
    quando = Date.now();
    return cache;
  }
  return { persone, svuota: () => { cache = null; } };
}

function gruppiDi(people) {
  const g = [{ id: 'tutti', label: 'Tutti', n: people.length }];
  for (const f of FIGURE) {
    const n = people.filter(p => p.figura === f.id).length;
    if (n) g.push({ id: 'figura:' + f.id, label: f.gruppo, n, tipo: 'figura' });
  }
  const sedi = [...new Set(people.flatMap(p => p.sedi))].sort((a, b) => a.localeCompare(b, 'it'));
  for (const s of sedi) g.push({ id: 'sede:' + s, label: 'Sede ' + s, n: people.filter(p => p.sedi.includes(s)).length, tipo: 'sede' });
  return g;
}
// La persona rientra nei gruppi o tra i singoli scelti?
const rientra = (p, gruppi, singoli) => (singoli || []).includes(p.id) || (gruppi || []).some(g => g === 'tutti'
  || (g.startsWith('figura:') && p.figura === g.slice(7)) || (g.startsWith('sede:') && p.sedi.includes(g.slice(5))));
const risolvi = (people, gruppi, singoli) => people.filter(p => rientra(p, gruppi, singoli));
// Testo leggibile: "ASO, Sede Elmas, Giulia Serra"
function etichetta(people, gruppi, singoli) {
  const gl = gruppiDi(people);
  return [...(gruppi || []).map(g => gl.find(x => x.id === g)?.label || (g === 'tutti' ? 'Tutti' : g.replace(/^(figura|sede):/, ''))),
    ...(singoli || []).map(id => people.find(p => p.id === id)?.nome).filter(Boolean)].join(', ');
}

module.exports = { crea, gruppiDi, rientra, risolvi, etichetta, FIG, nomeDi };
