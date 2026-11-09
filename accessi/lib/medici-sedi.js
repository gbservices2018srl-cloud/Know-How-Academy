// Sedi dei medici secondo il pannello accessi: l'assegnazione Nuovalab (app "laboratorio", livello MEDICO,
// un medico per studio = una sede). È la fonte unica usata da Scheda personale (Branche medici) e Misure implantari.
const store = require('./store');

const MEDICO = 'Medico';
const normSede = x => String(x || '').toLowerCase().replace(/to\s*smile|studio|sede|ambulatorio/g, '').replace(/[^a-z0-9]/g, '');

// [{ id, nome, sedi: [id sede] }] per tutti i medici attivi (figura Medico o livello MEDICO in Nuovalab)
async function sediMedici() {
  const [ss, { rows }] = await Promise.all([store.listSedi(), store.q(`select u.id, u.first_name, u.last_name, ua.enti, ua.ente_nome from users u
    left join user_apps ua on ua.user_id = u.id and ua.app = 'laboratorio' and ua.livello = 'MEDICO'
    where u.status = 'active' and not u.owner and (u.figura = $1 or ua.user_id is not null) order by u.last_name, u.first_name`, [MEDICO])]);
  const attive = ss.filter(s => s.attiva);
  const sedeDi = nome => {
    const n = normSede(String(nome || '').split(' · ').slice(1).join(' · '));
    if (!n) return null;
    return (attive.find(s => normSede(s.nome) === n) || attive.find(s => normSede(s.nome).length >= 3 && (n.includes(normSede(s.nome)) || normSede(s.nome).includes(n))))?.id || null;
  };
  return rows.map(r => {
    const enti = Array.isArray(r.enti) && r.enti.length ? r.enti : r.ente_nome ? [{ nome: r.ente_nome }] : [];
    return { id: r.id, nome: `${r.first_name || ''} ${r.last_name || ''}`.trim(), sedi: [...new Set(enti.map(e => sedeDi(e.nome)).filter(Boolean))] };
  });
}

module.exports = { sediMedici, MEDICO };
