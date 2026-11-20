// Persone registrate nelle app → Gestione finanziaria (azienda To Smile).
// Medico a partita IVA → tra i dottori dei «Costi per dottori», spuntato nelle sue sedi.
// Dipendente CCNL o partita IVA non medico → negli «Stipendi fissi lordi», nelle sue sedi.
// Le sedi sono quelle dell'anagrafica (Gestione accessi; ai medici arrivano da Nuovalab).
// Gestione finanziaria aggiunge e collega soltanto: non toglie, non rinomina, non tocca gli importi.
const finanza = require('../../lib/finanza');
const store = require('./store');

function tipoDi(u) {
  if (!u || u.owner || u.status !== 'active') return null;
  if (u.figura === 'Medico') return u.contratto_tipo === 'dip' ? 'stipendio' : 'medico';
  return u.contratto_tipo === 'dip' || u.contratto_tipo === 'piva' ? 'stipendio' : null;   // senza contratto indicato: non si sa dove metterla
}
async function personeFin(users) {
  const nomi = new Map((await store.listSedi()).map(s => [s.id, s.nome]));
  return users.map(u => ({ u, tipo: tipoDi(u) })).filter(x => x.tipo).map(({ u, tipo }) => ({
    ref: u.id, tipo, nome: `${u.first_name || ''} ${u.last_name || ''}`.replace(/\s+/g, ' ').trim(),
    sedi: (Array.isArray(u.sedi) ? u.sedi : []).map(id => nomi.get(id)).filter(Boolean),
  })).filter(p => p.nome && p.sedi.length);
}
async function manda(persone, prova) {
  const az = await finanza.aziendaToSmile();
  if (!az) throw new Error('In Gestione finanziaria non trovo l’azienda To Smile.');
  if (!persone.length) return { esiti: [] };
  return finanza.scrivi('/api/_appgestione/persone', { azienda: az, prova: !!prova, persone });
}
// una persona (dopo approvazione o modifica): in background, un errore non blocca niente
function allineaUno(userId) {
  setTimeout(async () => {
    try {
      const u = await store.getUser(userId);
      const p = await personeFin([u]);
      if (!p.length) return;
      const r = await manda(p, false);
      const e = r.esiti?.[0];
      if (e && (e.azione !== 'presente' || e.nuove?.length)) console.log(`Gestione finanziaria: ${e.nome} (${e.tipo}) ${e.azione}${e.nuove?.length ? ' · sedi ' + e.nuove.join(', ') : ''}`);
    } catch (err) { console.warn('Gestione finanziaria (persone):', err.message); }
  }, 500);
}
// tutte le persone attive: prima la prova (cosa cambierebbe), poi davvero
async function allineaTutti(prova) {
  const { rows } = await store.q(`select * from users where status = 'active' and not owner`);
  const r = await manda(await personeFin(rows), prova);
  // chi resta fuori: senza contratto indicato o senza sede
  const nome = u => `${u.first_name || ''} ${u.last_name || ''}`.trim();
  r.senzaContratto = rows.filter(u => !tipoDi(u)).map(nome).sort();
  r.senzaSede = rows.filter(u => tipoDi(u) && !(Array.isArray(u.sedi) && u.sedi.length)).map(nome).sort();
  return r;
}
module.exports = { allineaUno, allineaTutti, tipoDi };
