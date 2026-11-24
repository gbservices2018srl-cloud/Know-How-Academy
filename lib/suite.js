// Suite per più clienti (studi): To Smile è il «cliente zero» e gira come oggi.
// Ogni altro cliente gira in un motore separato (stesso codice, processo a parte) con le sue aree nel database
// (es. rossi_accessi, rossi_crm…) e i suoi indirizzi: rossi.appgestione.it, turni-rossi.appgestione.it…
// Qui: chi sono (TENANT_SLUG), gli indirizzi, l'elenco delle app vendibili e quali sono accese per questo cliente.
const BASE = (process.env.ACCESSI_DOMAIN || 'appgestione.it').toLowerCase();
const TENANT = String(process.env.TENANT_SLUG || '').toLowerCase().replace(/[^a-z0-9]/g, '');
// app che vivono su un indirizzo tutto loro (turni.appgestione.it → turni-rossi.appgestione.it)
const SOTTO = ['calendario', 'magazzino', 'turni', 'comunicazioni', 'documenti', 'protocolli'];
const host = (sub, slug = TENANT) => slug ? (sub ? `${sub}-${slug}.${BASE}` : `${slug}.${BASE}`) : (sub ? `${sub}.${BASE}` : BASE);
const slugValido = s => /^[a-z][a-z0-9]{1,29}$/.test(s) && !SOTTO.includes(s) && !['www', 'finanza', 'laboratorio', 'ticket', 'portale', 'api', 'gestione', 'admin'].includes(s);

// App della suite che si vendono (una spunta nel pannello /gestione = 32 € al mese). Gestione accessi è sempre inclusa.
// chiavi = le app del pannello accessi che ne fanno parte; percorsi / sotto = dove vive (per spegnerla se non è compresa)
const CATALOGO = [
  { id: 'crm', nome: 'CRM Commerciale', chiavi: ['crm', 'crm_preventivi', 'crm_richiami', 'crm_dashboard', 'crm_chiedi', 'crm_lead', 'crm_liste'], percorsi: ['/crm'] },
  { id: 'turni', nome: 'Turni e Scheda personale', chiavi: ['hr', 'turni', 'iprofile', 'iprofile_consegna'], sotto: 'turni', percorsi: ['/hr'] },
  { id: 'cassa', nome: 'Cassa e Produzione', chiavi: ['rec', 'cassa', 'produzione'], percorsi: ['/cassa'] },
  { id: 'aso', nome: 'Gestione ASO', chiavi: ['aso', 'sterilizzazione', 'registro_udi', 'manutenzione', 'misure'], percorsi: ['/aso'] },
  { id: 'magazzino', nome: 'Magazzino', chiavi: ['magazzino'], sotto: 'magazzino' },
  { id: 'protocolli', nome: 'Protocolli', chiavi: ['protocolli'], sotto: 'protocolli' },
  { id: 'documenti', nome: 'Documenti', chiavi: ['documenti'], sotto: 'documenti' },
  { id: 'comunicazioni', nome: 'Comunicazioni', chiavi: ['area_comunicazioni', 'comunicazioni', 'clinica'], sotto: 'comunicazioni', percorsi: ['/clinica'] },
  { id: 'calendario', nome: 'Calendario', chiavi: ['calendario'], sotto: 'calendario' },
  { id: 'classifiche', nome: 'Classifiche e medaglie', chiavi: [], percorsi: ['/classifiche'] },
  { id: 'compensi', nome: 'Compenso medici', chiavi: ['compensi'], percorsi: ['/compensi'] },
  { id: 'prezzi', nome: 'Raffronto prezzi', chiavi: ['prezzi'], percorsi: ['/amm/prezzi'] },
  // collegate a servizi esterni: si aprono ai clienti in una fase successiva
  { id: 'finanza', nome: 'Gestione finanziaria', chiavi: ['controllo', 'finanza', 'bilancio'], esterna: true },
  { id: 'nuovalab', nome: 'Nuovalab', chiavi: ['laboratorio'], esterna: true },
  { id: 'ticket', nome: 'Ticket assistenza', chiavi: ['ticket'], esterna: true },
];
// app accese per questo cliente (SUITE_APPS = id separati da virgola). To Smile: tutte.
const ACCESE = TENANT ? new Set(String(process.env.SUITE_APPS || '').split(',').map(s => s.trim()).filter(Boolean)) : null;
const accesa = id => !ACCESE || ACCESE.has(id);
const chiaviAccese = () => {
  if (!ACCESE) return null;
  const s = new Set(['accessi']);
  for (const c of CATALOGO) if (ACCESE.has(c.id) && !c.esterna) c.chiavi.forEach(k => s.add(k));
  return s;
};
// elenco delle app del pannello accessi ridotto a quelle comprese (i gruppi restano se hanno almeno un'app dentro)
function filtraApps(apps) {
  const ok = chiaviAccese(); if (!ok) return apps;
  const tenuti = apps.filter(a => !a.virtuale && ok.has(a.key));
  const gruppi = apps.filter(a => a.virtuale && (ok.has(a.key) || (a.gruppo || []).some(k => tenuti.some(t => t.key === k))))
    .map(g => ({ ...g, gruppo: (g.gruppo || []).filter(k => tenuti.some(t => t.key === k)) }));
  return apps.filter(a => tenuti.includes(a) || gruppi.some(g => g.key === a.key)).map(a => gruppi.find(g => g.key === a.key) || a);
}
// questa richiesta è di un'app non compresa per questo cliente?
function spenta(hostname, url) {
  if (!ACCESE) return null;
  const h = String(hostname || '').toLowerCase(), p = String(url || '/');
  for (const c of CATALOGO) {
    if (accesa(c.id) && !c.esterna) continue;
    if (c.sotto && h === host(c.sotto)) return c;
    if ((c.percorsi || []).some(x => p === x || p.startsWith(x + '/') || p.startsWith(x + '?')) && h === host('')) return c;
  }
  return null;
}
// nelle risposte di un cliente gli indirizzi di To Smile diventano i suoi (https://turni.appgestione.it → https://turni-rossi.appgestione.it)
const RE = new RegExp(`https://(?:(${SOTTO.join('|')}|www)\\.)?${BASE.replace(/\./g, '\\.')}(?![a-z0-9-])`, 'g');
const riscrivi = (testo, slug = TENANT) => !slug ? testo : String(testo).replace(RE, (m, sub) => 'https://' + host(sub && sub !== 'www' ? sub : '', slug));
// variabili d'ambiente del motore di un cliente: aree proprie nel database, indirizzi, cookie, app accese
function envCliente(c, port) {
  const s = c.slug, sch = n => `${s}_${n}`;
  return {
    TENANT_SLUG: s, PORT: String(port), SUITE_APPS: (c.apps || []).join(','), SUITE_POSTI: String(c.posti || 0), SUITE_NOME: c.nome || '',
    ACCESSI_COOKIE: 'ag_' + s,
    ACCESSI_HOSTS: host('', s), CALENDARIO_HOSTS: host('calendario', s), MAGAZZINO_HOSTS: host('magazzino', s), TURNI_HOSTS: host('turni', s),
    COMUNICAZIONI_HOSTS: host('comunicazioni', s), DOCUMENTI_HOSTS: host('documenti', s),
    ACCESSI_DB_SCHEMA: sch('accessi'), DB_SCHEMA: sch('protocolli'), CAL_DB_SCHEMA: sch('calendario'), MAG_DB_SCHEMA: sch('magazzino'),
    TURNI_DB_SCHEMA: sch('turni'), COM_DB_SCHEMA: sch('comunicazioni'), DOC_DB_SCHEMA: sch('documenti'), ASO_DB_SCHEMA: sch('aso'),
    CRM_DB_SCHEMA: sch('crm'), CASSA_DB_SCHEMA: sch('cassa'), COMPENSI_DB_SCHEMA: sch('compensi'), CLASSIFICHE_DB_SCHEMA: sch('classifiche'),
    // il primo amministratore del cliente (la password la sceglie lui al primo accesso)
    ADMIN_USERNAME: c.admin_email || '', ADMIN_PASSWORD: c.admin_password || '', ADMIN_NAME: c.admin_nome || c.nome || '',
    // collegamenti di To Smile che un cliente non deve usare
    FINANZA_URL: '', FINANZA_ALLINEA_AUTO: '', ALFADOCS_API_KEY: c.alfadocs_key || '', META_APP_SECRET: '', META_VERIFY_TOKEN: '', META_PAGE_TOKEN: '', META_PAGE_TOKENS: '',
    COPIA_DA: '', MANUTENZIONE: '', SSO_API_KEY: '', SKIP_SEED: 'true', CAL_SKIP_SEED: 'true', CRM_CANCELLA_EMAIL: c.admin_email || '',
    ACCESSI_URL: 'https://' + host('', s), CALENDARIO_URL: 'https://' + host('calendario', s),
  };
}
module.exports = { BASE, TENANT, SOTTO, host, slugValido, CATALOGO, accesa, filtraApps, spenta, riscrivi, envCliente };
