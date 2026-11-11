// Piano di crescita: punto d'incontro tra Gestione accessi e Scheda personale (stesso processo).
// - la Scheda personale (turni/sp.js) registra qui le sue funzioni: struttura dei piani, assegnazioni, passaggi di ruolo
// - Gestione accessi (accessi/server.js) le usa per assegnare il ruolo dal pannello e registra ruoloCambiato,
//   così quando un passaggio di ruolo viene approvato la figura della persona si aggiorna da sola.
const hub = { sp: null, accessi: null };

// figura dell'accesso unico → ruolo di partenza consigliato nel piano di crescita
const RUOLO_DA_FIGURA = { ASO: 'ASO', REC: 'REC', RAP: 'RAP', RUL: 'RUL', Manager: 'Manager', OperationExtra: 'Operativo di area' };
// ruolo del piano → figura dell'accesso unico (solo quando il ruolo corrisponde a una figura: es. RAP Senior → RUL)
const FIGURE_DA_RUOLO = ['ASO', 'REC', 'RAP', 'RUL', 'Manager'];
function figuraDaRuolo(ruolo) {
  const r = String(ruolo || '').trim();
  if (/^(capo|area)\b/i.test(r)) return null;
  return FIGURE_DA_RUOLO.find(f => r === f || r.startsWith(f + ' ')) || null;
}
// suggerimento per chi non ha ancora un ruolo: { piano, livello } dal primo piano che ha quel ruolo
function suggerito(figura, piani) {
  const ruolo = RUOLO_DA_FIGURA[figura]; if (!ruolo) return null;
  for (const p of piani || []) { const l = p.livelli.find(x => x.ruolo === ruolo); if (l) return { piano: p.id, livello: l.n }; }
  return null;
}

module.exports = { hub, figuraDaRuolo, suggerito, RUOLO_DA_FIGURA };
