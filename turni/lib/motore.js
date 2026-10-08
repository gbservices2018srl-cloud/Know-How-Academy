// Carica il motore condiviso (public/motore.js) dentro una funzione, con uno stato preso dal database.
// Ogni chiamata crea un motore nuovo: niente stato condiviso tra richieste diverse.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'public', 'motore.js'), 'utf8');
const ESPORTA = ['genera', 'applySubstitution', 'avanzi', 'suggerimenti', 'absenceOn', 'blocked', 'conChi', 'oreMese', 'azioneValida',
  'azioneTxt', 'applyAzioni', 'removeRule', 'cfgTxt', 'cadTxt', 'cfgToCad', 'cfgHours', 'sede', 'emp', 'full', 'sediOf', 'oreTot', 'turnoTxt',
  'shiftsOf', 'cellCode', 'partnerOf', 'hoursOn', 'isOpen', 'riuniti', 'need', 'diffDays', 'addDays', 'fmt', 'DOWL', 'TIPI', 'TIPI_PROF',
  'ALTRI', 'allDays', 'weekKey', 'inRange', 'H', 'fmtH', 'esc', 'calcFestivi', 'calcMonths', 'oggiRoma', 'nowStr', 'dow', 'daysIn', 'dstr',
  'unavTxt', 'listIt', 'sedeList', 'oreList', 'meseShort', 'meseLabel'];
const VARS = ['SEDI', 'STAFF', 'REMOVED', 'REG', 'FESTIVI', 'DEROGHE', 'CAD', 'UNAV', 'RULES_TXT', 'reqs', 'AI', 'plan', 'short', 'fixMiss', 'genAt', 'dirty', 'TODAY', 'MONTHS'];
const factory = new Function('S', `
  let { ${VARS.join(', ')} } = S;
  const uid = () => S.uid();
  ${SRC}
  if (!FESTIVI) FESTIVI = calcFestivi(MONTHS);
  return { ${ESPORTA.join(', ')}, stato: () => ({ ${VARS.join(', ')} }) };
`);

// stato: { config, planDoc, reqs, ai[] , today? }
function crea({ config, planDoc, reqs = [], ai = [], today }) {
  const c = config || {};
  const pd = planDoc || {};
  const TODAY = today || new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  const pad = n => String(n).padStart(2, '0');
  const [y, m] = TODAY.split('-').map(Number);
  const MONTHS = [-1, 0, 1, 2].map(k => { const t = new Date(y, m - 1 + k, 15); return `${t.getFullYear()}-${pad(t.getMonth() + 1)}`; });
  return factory({
    SEDI: c.sedi || [], STAFF: c.staff || [], REMOVED: c.removed || [], REG: c.reg || defaultReg(), FESTIVI: null,
    DEROGHE: c.deroghe || [], CAD: c.cad || [], UNAV: c.unav || [], RULES_TXT: c.rules || [],
    reqs, AI: new Set(ai), plan: pd.plan || {}, short: pd.short || {}, fixMiss: pd.fixMiss || {}, genAt: pd.genAt || '', dirty: false,
    TODAY, MONTHS, uid: () => crypto.randomBytes(5).toString('hex'),
  });
}

function defaultReg() {
  return {
    orario: [{ M: false, P: false }, { M: true, P: true }, { M: true, P: true }, { M: true, P: true }, { M: true, P: true }, { M: true, P: true }, { M: true, P: false }],
    ore: { M: ['09:00', '13:00'], P: ['15:00', '19:00'] },
    maxGiorno: 8, minRiuniti: 1,
    altri: { REC: { min: 1, max: 2 }, RAP: { min: 0, max: 1 }, RUL: { min: 0, max: 1 }, Altro: { min: 0, max: 1 } },
    festivi: true,
  };
}

module.exports = { crea, defaultReg };
