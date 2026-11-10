// Anagrafica unica della persona: i dati che servono a tutte le app stanno qui (accesso unico) e le app li leggono da qui.
//
// CAMPI è l'elenco dei dati obbligatori. Per aggiungerne uno nuovo basta una riga:
//   - chi lo compila: 'persona' (gli viene chiesto all'accesso e, finché manca, le app restano bloccate)
//   - per: chi deve averlo ('tutti' oppure un elenco di figure, es. ['Medico'])
//   - tipo: come si chiede (testo, tel, indirizzo, iban, contratto)
//   - conferma: 'admin' se poi l'amministratore lo deve confermare (la persona non resta bloccata nell'attesa)
// Alla prima apertura dopo la modifica, a chi manca il dato viene chiesto prima di poter usare le app.
const crypto = require('crypto');

const CAMPI = [
  { k: 'telefono', nome: 'Telefono', tipo: 'tel', chi: 'persona', per: 'tutti', aiuto: 'Il numero di cellulare, per essere contattato/a dallo studio.' },
  { k: 'residenza', nome: 'Indirizzo di residenza', tipo: 'indirizzo', chi: 'persona', per: 'tutti' },
  { k: 'iban', nome: 'IBAN per gli accrediti', tipo: 'iban', chi: 'persona', per: 'tutti',
    aiuto: 'Il conto corrente su cui vuoi ricevere gli accrediti (stipendio o compensi), intestato o cointestato a te. Viene salvato cifrato.' },
  { k: 'contratto', nome: 'Contratto', tipo: 'contratto', chi: 'persona', per: 'tutti', conferma: 'admin',
    aiuto: "Dipendente o partita IVA e, per i dipendenti, le ore settimanali del contratto. L'amministratore lo conferma." },
];

const perMe = (c, u) => c.per === 'tutti' || [].concat(c.per).includes(u.figura);
// chi deve compilare: le persone attive (il proprietario no: è l'amministratore, non viene mai bloccato)
const soggetto = u => u && u.status === 'active' && !u.owner;

/* ---------- cifratura dell'IBAN (AES-256-GCM, chiave ANAGRAFICA_KEY su Render) ---------- */
const KEY = () => { const b = Buffer.from(process.env.ANAGRAFICA_KEY || '', 'base64'); return b.length === 32 ? b : null; };
const cifraOk = () => !!KEY();
function cifra(testo) {
  const k = KEY(); if (!k) throw Object.assign(new Error("Manca la chiave di cifratura dell'anagrafica (ANAGRAFICA_KEY su Render)."), { status: 500 });
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const d = Buffer.concat([c.update(String(testo), 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), d].map(b => b.toString('base64')).join('.');
}
function decifra(s) {
  if (!s || !KEY()) return null;
  try {
    const [iv, tag, d] = String(s).split('.').map(x => Buffer.from(x, 'base64'));
    const c = crypto.createDecipheriv('aes-256-gcm', KEY(), iv); c.setAuthTag(tag);
    return Buffer.concat([c.update(d), c.final()]).toString('utf8');
  } catch { return null; }
}

/* ---------- controlli ---------- */
const str = (v, max = 200) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, max);
function ibanValido(iban) {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  if (iban.startsWith('IT') && iban.length !== 27) return false;
  const n = (iban.slice(4) + iban.slice(0, 4)).replace(/[A-Z]/g, ch => String(ch.charCodeAt(0) - 55));
  let r = 0; for (const ch of n) r = (r * 10 + +ch) % 97;
  return r === 1;
}


// legge e controlla un campo dal modulo: { ok, set: {colonna: valore} } oppure { errore }
function leggi(c, v) {
  v = v ?? {};
  if (c.tipo === 'tel') {
    const t = String(v).replace(/[^\d+]/g, '');
    if (!/^\+?\d{8,15}$/.test(t)) return { errore: 'Scrivi un numero di telefono valido (solo cifre, es. 3471234567).' };
    return { set: { telefono: t } };
  }
  if (c.tipo === 'indirizzo') {
    const r = { via: str(v.via, 120), cap: str(v.cap, 5), comune: str(v.comune, 80), provincia: str(v.provincia, 2).toUpperCase() };
    if (r.via.length < 3 || !/\d/.test(r.via)) return { errore: 'Scrivi via e numero civico della residenza.' };
    if (!/^\d{5}$/.test(r.cap)) return { errore: 'Il CAP ha 5 cifre.' };
    if (r.comune.length < 2) return { errore: 'Scrivi il comune di residenza.' };
    if (!/^[A-Z]{2}$/.test(r.provincia)) return { errore: 'Scrivi la sigla della provincia (2 lettere, es. CA).' };
    return { set: { residenza: JSON.stringify(r) } };
  }
  if (c.tipo === 'iban') {
    const i = String(v).replace(/\s+/g, '').toUpperCase();
    if (!ibanValido(i)) return { errore: "L'IBAN non è corretto: controlla lettere e cifre (in Italia sono 27, inizia con IT)." };
    return { set: { iban_cifrato: cifra(i), iban_fine: i.slice(-4) } };
  }
  if (c.tipo === 'contratto') {
    const tipo = v.tipo === 'dip' || v.tipo === 'piva' ? v.tipo : null;
    if (!tipo) return { errore: 'Scegli se sei dipendente o a partita IVA.' };
    const ore = Number(String(v.ore ?? '').replace(',', '.'));
    if (tipo === 'dip' && !(ore > 0 && ore <= 60)) return { errore: 'Scrivi le ore settimanali del contratto (per esempio 32).' };
    return { set: { contratto_tipo: tipo, contratto_ore: tipo === 'dip' ? ore : null } };
  }
  const t = str(v, 200);
  if (!t) return { errore: `Compila «${c.nome}».` };
  return { set: { [c.k]: t } };
}

// il dato c'è già?
function presente(c, u) {
  if (c.tipo === 'tel') return !!u.telefono;
  if (c.tipo === 'indirizzo') return !!(u.residenza && u.residenza.via && u.residenza.cap && u.residenza.comune);
  if (c.tipo === 'iban') return !!u.iban_cifrato;
  if (c.tipo === 'contratto') return !!u.contratto_tipo;
  return !!u[c.k];
}
const mancanti = u => soggetto(u) ? CAMPI.filter(c => c.chi === 'persona' && perMe(c, u) && !presente(c, u)).map(c => c.k) : [];

// valori da mostrare (l'IBAN intero solo quando serve: alla persona stessa e all'amministratore)
function valori(u, { ibanIntero = false } = {}) {
  return {
    telefono: u.telefono || '',
    residenza: u.residenza || null,
    iban: u.iban_cifrato ? (ibanIntero ? decifra(u.iban_cifrato) || '' : '•••• ' + (u.iban_fine || '')) : '',
    ibanFine: u.iban_fine || '',
    contratto: u.contratto_tipo ? { tipo: u.contratto_tipo, ore: u.contratto_ore != null ? Number(u.contratto_ore) : null, ok: !!u.contratto_ok } : null,
  };
}
const campiPer = u => CAMPI.filter(c => !u || perMe(c, u)).map(({ k, nome, tipo, chi, conferma, aiuto }) => ({ k, nome, tipo, chi, conferma: conferma || null, aiuto: aiuto || '' }));

module.exports = { CAMPI, campiPer, leggi, presente, mancanti, valori, cifra, decifra, cifraOk, ibanValido, soggetto };
