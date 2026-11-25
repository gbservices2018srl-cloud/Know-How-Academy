// Classifiche e medaglie: calcoli, regole, frasi, chiusure automatiche (mese, trimestre, anno).
// Legge i dati che ci sono già nelle app (CRM, Produzione di UL, Manutenzione attrezzature, Gestione finanziaria): non li cambia mai.
// Scrive solo nel suo schema «classifiche»: gradi, medaglie, bacheca, applausi, feste da aprire, ordine delle frasi.
const { Pool, types } = require('pg');
types.setTypeParser(1082, v => v);
const crypto = require('crypto');
const store = require('../../accessi/lib/store');
const finanza = require('../../lib/finanza');

const url = process.env.DATABASE_URL || '';
const SCHEMA_CL = (process.env.CLASSIFICHE_DB_SCHEMA || 'classifiche').replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'classifiche';
const pool = new Pool({ connectionString: url, ssl: process.env.PGSSL === 'true' || /\.render\.com/.test(url) ? { rejectUnauthorized: false } : false, options: `-c search_path=${SCHEMA_CL},public`, max: 3 });
const q = (t, p) => pool.query(t, p);
const S = {
  crm: (process.env.CRM_DB_SCHEMA || 'crm').replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'crm',
  cassa: (process.env.CASSA_DB_SCHEMA || 'cassa').replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'cassa',
  aso: (process.env.ASO_DB_SCHEMA || 'aso').replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'aso',
};

async function migrate() {
  await q(`create schema if not exists ${SCHEMA_CL}`);
  await q(`
    create table if not exists gradi (categoria text not null, user_id text not null, periodo text not null, grado smallint not null, nome text not null default '', il timestamptz not null default now(), primary key (categoria, user_id, periodo));
    create table if not exists medaglie (id bigserial primary key, categoria text not null, periodo text not null, tipo text not null, user_id text not null, nome text not null default '', valore text not null default '', il timestamptz not null default now(), unique (categoria, periodo, tipo, user_id));
    create table if not exists chiusure (cosa text primary key, il timestamptz not null default now(), esito text not null default '');
    create table if not exists bacheca (id bigserial primary key, il timestamptz not null default now(), categoria text not null default '', testo text not null, user_id text, applausi jsonb not null default '[]');
    create index if not exists bacheca_il on bacheca(il desc);
    create table if not exists feste (id text primary key, user_id text not null, il timestamptz not null default now(), dati jsonb not null, aperta_il timestamptz);
    create table if not exists mazzi (chiave text primary key, ordine jsonb not null);
  `);
}

/* ---------- tempo (Europa/Roma) ---------- */
const oggi = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const trimDi = m => Math.ceil(m / 3);
const mesiTrim = t => [t * 3 - 2, t * 3 - 1, t * 3];
const fE = n => '€ ' + Math.round(n || 0).toLocaleString('it-IT', { useGrouping: 'always' });
const nAcc = n => `${n} ${n === 1 ? 'accettato' : 'accettati'}`;
const pc = n => (Math.round((n || 0) * 10) / 10).toLocaleString('it-IT') + '%';

/* ---------- regole (il regolamento le mostra così come sono) ---------- */
const REGOLE = {
  ticket: [{ s: 1, da: 0 }, { s: 2, da: 1800 }, { s: 3, da: 2300 }, { s: 4, da: 3000 }, { s: 5, da: 4500 }],   // target 3.000 €, overtarget oltre 4.500 €
  targetConc: 50,                                       // concretizzazione: target 50%
  fasce: [0, .6, .8, 1, 1.15],                          // stelle sul raggiungimento del target: <60% · 60% · 80% · target · +15%
  targetRec: 85,                                        // REC: produzione = 85% del fatturato (gold standard)
  minVisite: 10,                                        // medici: minimo 10 visite (preventivi) per la medaglia d'oro
  gradiComm: [
    { nome: 'Recluta', titolo: 'si parte', conc: 0, ticket: 0 },
    { nome: 'Sergente', titolo: '1° grado', conc: 40, ticket: 2500 },
    { nome: 'Tenente', titolo: '2° grado', conc: 50, ticket: 3000 },
    { nome: 'Capitano', titolo: '3° grado', conc: 60, ticket: 4000 },
  ],
  gradiRec: ['REC semplice', 'REC di grado 1', 'REC di grado 2', 'Maresciallo REC', 'Comandante REC'],
};
const stelleTicket = v => REGOLE.ticket.reduce((s, x) => v >= x.da ? x.s : s, 1);
const stelleFasce = (v, target) => REGOLE.fasce.reduce((s, k, i) => v >= k * target ? i + 1 : s, 1);
const stelleConc = v => stelleFasce(v, REGOLE.targetConc);
const stelleRec = v => stelleFasce(v, REGOLE.targetRec);
const gradoComm = (conc, ticket) => REGOLE.gradiComm.reduce((g, x, i) => conc >= x.conc && ticket >= x.ticket ? i : g, 0);
// REC: grado dal posto nella classifica dell'anno (1ª Comandante, 2ª–3ª Maresciallo, poi fasce proporzionali)
const gradoRecDa = (pos, n) => pos === 0 ? 4 : pos <= 2 ? 3 : pos < Math.ceil(n * .6) ? 2 : pos < Math.ceil(n * .85) ? 1 : 0;

/* ---------- frasi: ognuno le vede tutte prima che una si ripeta ---------- */
const FRASI = require('./frasi');
async function frase(cat, uid) {
  const L = FRASI[cat], k = cat + ':' + uid;
  const { rows: [r] } = await q('select ordine from mazzi where chiave = $1', [k]);
  let m = Array.isArray(r?.ordine) ? r.ordine.filter(i => i < L.length) : [];
  if (!m.length) { m = L.map((_, i) => i); for (let i = m.length - 1; i > 0; i--) { const j = crypto.randomInt(i + 1); [m[i], m[j]] = [m[j], m[i]]; } }
  const i = m.shift();
  await q('insert into mazzi (chiave, ordine) values ($1,$2) on conflict (chiave) do update set ordine = excluded.ordine', [k, JSON.stringify(m)]);
  return L[i];
}

/* ---------- persone ---------- */
const nomeU = u => `${u.first_name || ''} ${u.last_name || ''}`.replace(/\s+/g, ' ').trim() || u.email || '';
async function utenti() {
  const { rows } = await store.q(`select id, first_name, last_name, email, figura, sedi, status, cf from users where not owner or coalesce(figura, '') <> ''`);
  return new Map(rows.map(u => [u.id, { id: u.id, nome: nomeU(u), cognome: u.last_name || '', nomeProprio: u.first_name || '', donna: /^[A-Z]{6}\d{2}[A-Z]([4-7]\d)/i.test(u.cf || ''), figura: u.figura || '', sedi: Array.isArray(u.sedi) ? u.sedi : [], attivo: u.status === 'active' }]));
}
const CATEGORIA_DI = { RAP: 'comm', RUL: 'comm', Medico: 'medici', REC: 'rec', ASO: 'aso' };

/* ---------- calcoli ---------- */
// commerciali: la classifica si fa sulla % del target di TMV (3.000 €) e di concretizzazione (50%), in media, non sul fatturato
function conPunteggio(x) {
  const conc = x.n ? x.acc / x.n * 100 : 0, ticket = x.acc ? x.fatt / x.acc : 0;
  const pTmv = ticket / REGOLE.ticket.find(t => t.s === 4).da * 100, pConc = conc / REGOLE.targetConc * 100;
  return { ...x, conc, ticket, pTmv, pConc, punteggio: (pTmv + pConc) / 2 };
}
const ordineComm = (a, b) => b.punteggio - a.punteggio || b.pConc - a.pConc || a.nome.localeCompare(b.nome, 'it');
// commerciali: preventivi del periodo per commerciale (come la Scheda personale: € piano di cura con esito A, mese del preventivo)
async function commerciali(anno, mesi) {
  const U = await utenti();
  const { rows: al } = await q(`select upper(nome) nome, user_id from ${S.crm}.alias_commerciali`);
  const alias = new Map(al.map(a => [a.nome, a.user_id]));
  const { rows } = await q(`select commerciale_id, upper(commerciale) commerciale, count(*)::int n, count(*) filter (where esito = 'A')::int na, coalesce(sum(pdc) filter (where esito = 'A'), 0)::float fatt
    from ${S.crm}.preventivi where anno = $1 and mese = any($2) group by 1, 2`, [anno, mesi]);
  const per = new Map();
  for (const r of rows) {
    const uid = r.commerciale_id || alias.get(r.commerciale) || null;
    if (!uid || !U.get(uid)) continue;                          // solo persone registrate nelle app
    const x = per.get(uid) || { id: uid, nome: U.get(uid).nome, n: 0, acc: 0, fatt: 0 };
    x.n += r.n; x.acc += r.na; x.fatt += r.fatt; per.set(uid, x);
  }
  return [...per.values()].map(x => conPunteggio({ ...x, fatt: Math.round(x.fatt * 100) / 100 })).sort(ordineComm);
}
// medici: ogni preventivo col medico è una visita; % = accettati / visite. In gara per l'oro solo con almeno 10 visite.
// mese: un mese oppure un elenco di mesi (classifica dell'anno: da gennaio a oggi)
async function medici(anno, mese) {
  const U = await utenti();
  const { rows } = await q(`select medici_ids, medico, esito from ${S.crm}.preventivi where anno = $1 and mese = any($2::int[])`, [anno, Array.isArray(mese) ? mese : [mese]]);
  // preventivi importati dal vecchio foglio: solo il cognome del medico nel testo → si collega se c'è un solo medico con quel cognome
  const perCognome = new Map();
  for (const u of U.values()) if (u.figura === 'Medico') { const c = String(u.cognome || '').toUpperCase().trim(); if (c) perCognome.set(c, perCognome.has(c) ? null : u.id); }
  const idsDi = r => Array.isArray(r.medici_ids) && r.medici_ids.length ? r.medici_ids
    : String(r.medico || '').split('/').map(x => perCognome.get(x.trim().toUpperCase())).filter(Boolean);
  const per = new Map();
  for (const r of rows) for (const id of idsDi(r)) {
    if (!U.get(id)) continue;
    const x = per.get(id) || { id, nome: U.get(id).nome, visite: 0, acc: 0 }; x.visite++; if (r.esito === 'A') x.acc++; per.set(id, x);
  }
  return [...per.values()].map(x => ({ ...x, conc: x.visite ? x.acc / x.visite * 100 : 0, inGara: x.visite >= REGOLE.minVisite }))
    .sort((a, b) => b.inGara - a.inGara || b.conc - a.conc || b.visite - a.visite);
}
// REC: produzione approvata della sede ÷ fatturato della sede (Gestione finanziaria), da gennaio al mese indicato. Vale per le REC della sede.
async function rec(anno, finoMese) {
  const U = await utenti();
  const { rows: prod } = await q(`select sede_id, sede_nome, mese, valore::float valore from ${S.cassa}.produzione where anno = $1 and mese <= $2 and stato = 'approvata'`, [anno, finoMese]);
  let cons = null;
  try { const az = await finanza.aziendaToSmile(); cons = az && await finanza.chiama(`/api/_appgestione/consuntivo?azienda=${encodeURIComponent(az)}&anno=${anno}&mese=1`); } catch {}
  const sedi = new Map();
  for (const p of prod) {
    const f = cons && cons.annoNelGestionale === anno ? finanza.trova(cons.sedi, p.sede_nome) : null;
    const fatt = Number(f?.fatturatoMesi?.[p.mese - 1]) || 0;
    if (!(fatt > 0)) continue;                                   // mese senza fatturato: non conta
    const x = sedi.get(p.sede_id) || { sede: p.sede_id, sedeNome: p.sede_nome, prod: 0, fatt: 0, mesi: 0 };
    x.prod += p.valore; x.fatt += fatt; x.mesi++; sedi.set(p.sede_id, x);
  }
  const out = [];
  for (const u of U.values()) {
    if (u.figura !== 'REC' || !u.attivo) continue;
    const ss = u.sedi.map(id => sedi.get(id)).filter(Boolean);
    if (!ss.length) { out.push({ id: u.id, nome: u.nome, sedeNome: '', perc: null }); continue; }
    const p = ss.reduce((s, x) => s + x.prod, 0), f = ss.reduce((s, x) => s + x.fatt, 0);
    out.push({ id: u.id, nome: u.nome, sedeNome: ss.map(x => x.sedeNome).join(', '), perc: f ? p / f * 100 : null, mesi: Math.max(...ss.map(x => x.mesi)) });
  }
  return { senzaFinanza: !cons, lista: out.sort((a, b) => (b.perc ?? -1) - (a.perc ?? -1) || a.nome.localeCompare(b.nome, 'it')) };
}
// ASO: manutenzioni attrezzature del mese (una registrazione = un'attrezzatura in un giorno, con tutte le operazioni spuntate)
async function aso(anno, mese) {
  const U = await utenti();
  const { rows } = await q(`select operatore_id, count(distinct (attrezzatura_id, (eseguita_il at time zone 'Europe/Rome')::date))::int n
    from ${S.aso}.manutenzioni where extract(year from eseguita_il at time zone 'Europe/Rome') = $1 and extract(month from eseguita_il at time zone 'Europe/Rome') = $2 and operatore_id <> '' group by 1`, [anno, mese]);
  return rows.filter(r => U.get(r.operatore_id)).map(r => ({ id: r.operatore_id, nome: U.get(r.operatore_id).nome, n: r.n })).sort((a, b) => b.n - a.n || a.nome.localeCompare(b.nome, 'it'));
}
// gradi e medaglie salvati
async function gradoSalvato(cat, uid) { const { rows: [r] } = await q('select grado, periodo from gradi where categoria = $1 and user_id = $2 order by periodo desc limit 1', [cat, uid]); return r || null; }
async function medagliere(cat, anno) {
  const { rows } = await q(`select user_id, max(nome) nome, count(*) filter (where tipo = 'oro')::int oro, count(*) filter (where tipo = 'argento')::int argento, count(*) filter (where tipo = 'bronzo')::int bronzo,
    json_agg(json_build_object('periodo', periodo, 'tipo', tipo, 'valore', valore) order by periodo) lista from medaglie where categoria = $1 and periodo like $2 group by user_id`, [cat, anno + '-%']);
  return rows.map(r => ({ ...r, totale: r.oro + r.argento + r.bronzo })).sort((a, b) => b.totale - a.totale || b.oro - a.oro || b.argento - a.argento);
}

/* ---------- bacheca, avvisi, feste ---------- */
const bacheca = (cat, testo, uid) => q('insert into bacheca (categoria, testo, user_id) values ($1,$2,$3)', [cat, testo, uid || null]).catch(() => {});
const avvisa = (ids, payload) => ids.length && require('../../accessi/lib/notifiche').notifica(ids, 'classifiche', payload).catch(e => console.warn('Classifiche notifica:', e.message));
async function festaDaAprire(uid, dati) { const id = crypto.randomUUID(); await q('insert into feste (id, user_id, dati) values ($1,$2,$3)', [id, uid, JSON.stringify(dati)]); return id; }
const URL_C = 'https://appgestione.it/classifiche/';

/* ---------- lodi (al momento del gesto) ---------- */
const TITOLI = ['Grande', 'Complimenti', 'Bravissimo lavoro', 'Ottimo', 'Applausi'];
const caso = A => A[crypto.randomInt(A.length)];
const nomeBreve = n => String(n || '').split(' ')[0];
const sorpassi = (prima, dopo, uid) => { const pp = prima.findIndex(x => x.id === uid), pd = dopo.findIndex(x => x.id === uid);
  return { pos: pd + 1, superati: pp < 0 || pd < 0 ? [] : prima.slice(pd, pp).filter(x => x.id !== uid).map(x => x.nome) }; };

// commerciale: preventivo passato ad «A». prima = classifica senza questo accettato (per vedere i sorpassi)
async function lodeCommerciale({ uid, anno, mese, pdc, primaDi }) {
  const dopo = await commerciali(anno, [mese]), me = dopo.find(x => x.id === uid); if (!me) return null;
  const prima = primaDi || dopo.map(x => x.id === uid ? conPunteggio({ ...x, acc: x.acc - 1, fatt: x.fatt - pdc }) : x).sort(ordineComm);
  const sp = sorpassi(prima, dopo, uid), sT = stelleTicket(me.ticket), sC = stelleConc(me.conc);
  const tr = pdc >= 10000 ? ['Preventivo d\'oro!', 'Un preventivo importante, chiuso con grande sicurezza. Lavoro di altissimo livello.']
    : me.acc === 1 ? ['Il primo sì del mese!', 'Il mese parte alla grande: hai dato il ritmo giusto alla squadra.']
    : me.acc % 10 === 0 ? [`${me.acc}° accettato del mese!`, `Quota ${me.acc} raggiunta! Costanza e professionalità da vero commerciale.`] : null;
  const t = trimDi(mese), tr3 = await commerciali(anno, mesiTrim(t).filter(m => m <= mese)), mt = tr3.find(x => x.id === uid);
  const g = mt ? gradoComm(mt.conc, mt.ticket) : 0, gs = (await gradoSalvato('comm', uid))?.grado ?? 0;
  const passi = [];
  if (sT < 5) passi.push(`TMV a ${fE(REGOLE.ticket[sT].da)} per la ${sT + 1}ª stella`);
  if (sC < 5) { const soglia = REGOLE.fasce[sC] * REGOLE.targetConc / 100, serve = Math.max(1, Math.ceil((soglia * me.n - me.acc) / (1 - soglia))); passi.push(`${serve} ${serve === 1 ? 'accettato' : 'accettati'} in più per la ${sC + 1}ª stella di concretizzazione`); }
  return { tipo: 'comm', titolo: 'Preventivo accettato!', chi: `${caso(TITOLI)}, ${nomeBreve(me.nome)}!`, traguardo: tr?.[0] || '', frase: tr ? tr[1] : await frase('comm', uid),
    sorpasso: sp.superati.length ? `Hai superato ${sp.superati.join(' e ')} su TMV e concretizzazione di ${MESI[mese - 1]}!` : '',
    posizione: `Il tuo fatturato accettato di ${MESI[mese - 1]}: ${fE(me.fatt)}`,
    stelle: Math.round((sT + sC) / 2),
    parametri: [
      { nome: 'TMV (ticket medio di vendita)', stelle: sT, valore: `${fE(me.ticket)} su ${nAcc(me.acc)}`, ok: me.ticket >= 3000, goal: me.ticket >= 3000 ? '✓ Target di 3.000 € raggiunto' : 'Target: 3.000 €' },
      { nome: 'Concretizzazione', stelle: sC, valore: `${pc(me.conc)} · ${nAcc(me.acc)} su ${me.n} presentati`, ok: me.conc >= 50, goal: me.conc >= 50 ? '✓ Target del 50% raggiunto' : 'Target: 50%' }],
    doppio: me.ticket >= 3000 && me.conc >= 50 ? 'Doppio obiettivo centrato. Lavoro da vero commerciale!' : '',
    grado: g > gs ? `Con questi numeri a fine trimestre diventi ${REGOLE.gradiComm[g].nome}!` : '',
    passo: passi.join(' · '), grande: !!(sp.superati.length || tr || (me.ticket >= 3000 && me.conc >= 50)), nome: me.nome, pos: sp.pos, superati: sp.superati };
}
// medico: un suo paziente ha accettato
async function lodeMedico({ uid, anno, mese, paziente, pdc, tipo, data, da }) {
  const dopo = await medici(anno, mese), me = dopo.find(x => x.id === uid); if (!me) return null;
  const prima = dopo.map(x => x.id === uid ? { ...x, acc: x.acc - 1, conc: (x.acc - 1) / x.visite * 100 } : x).sort((a, b) => b.inGara - a.inGara || b.conc - a.conc || b.visite - a.visite);
  const sp = sorpassi(prima, dopo, uid), s = stelleConc(me.conc), primo = sp.pos === 1 && me.inGara;
  const fr = await frase('medici', uid);
  // la lode arriva come messaggio del commerciale che ha chiuso il preventivo
  const messaggio = da ? { da: da.nome, ruolo: [da.figura, da.sede].filter(Boolean).join(' · '), iniziali: da.nome.split(/\s+/).map(x => x[0] || '').join('').slice(0, 2).toUpperCase(),
    apertura: `Ciao ${da.dott}, sono ${da.nomeProprio}! 🎉`, testo: `Abbiamo chiuso il piano di cura di ${paziente}${tipo || pdc ? ` (${[tipo, pdc ? fE(pdc) : ''].filter(Boolean).join(' · ')})` : ''} dopo la tua visita${data ? ' del ' + data.split('-').reverse().slice(0, 2).join('/') : ''}.`,
    frase: fr, chiusura: 'Grazie, continuiamo così!' } : null;
  return { tipo: 'medici', titolo: 'Il tuo paziente ha accettato!', chi: messaggio ? '' : `Complimenti, ${me.nome}!`, frase: messaggio ? '' : fr, messaggio,
    paziente: messaggio ? null : { nome: paziente, dettaglio: [tipo, pdc ? fE(pdc) : '', data ? 'visita del ' + data.split('-').reverse().join('/') : ''].filter(Boolean).join(' · ') },
    sorpasso: sp.superati.length && me.inGara ? `Hai superato ${sp.superati.join(' e ')}: ora sei ${sp.pos}° nella classifica medici!` : '',
    posizione: me.inGara ? `Sei ${sp.pos}° nella classifica medici di ${MESI[mese - 1]}` : `Ancora ${REGOLE.minVisite - me.visite} visite per entrare in gara per la medaglia d'oro`,
    parametri: [{ nome: `La tua concretizzazione di ${MESI[mese - 1]}`, stelle: s, valore: `${pc(me.conc)} · ${nAcc(me.acc)} su ${me.visite} visite`, ok: primo,
      goal: primo ? '✓ Sei in testa: la medaglia d\'oro è a portata di mano!' : 'La medaglia d\'oro si decide a fine mese' }],
    grande: true, nome: me.nome, pos: sp.pos, superati: sp.superati };
}
async function lodeRec({ uid, anno, mese }) {
  // REC: niente numeri né posizioni, solo il grado
  const { lista } = await rec(anno, mese), L = lista.filter(x => x.perc != null), i = L.findIndex(x => x.id === uid);
  const gs = (await gradoSalvato('rec', uid))?.grado, U = await utenti(), g = gs ?? (i >= 0 ? gradoRecDa(i, L.length) : 0);
  const prossimo = i >= 0 ? gradoRecDa(i, L.length) : null;
  return { tipo: 'rec', titolo: 'Produzione salvata!', chi: `Grazie, ${nomeBreve(U.get(uid)?.nome || '')}!`, frase: await frase('rec', uid), grande: false,
    insegna: { cat: 'rec', grado: g }, posizione: `Il tuo grado: ${REGOLE.gradiRec[g]}`,
    grado: prossimo != null && prossimo > g ? `Se chiudi il mese così, sali a ${REGOLE.gradiRec[prossimo]}!` : '' };
}
async function lodeAso({ uid, anno, mese }) {
  const L = await aso(anno, mese), me = L.find(x => x.id === uid); if (!me) return null;
  const prima = L.map(x => x.id === uid ? { ...x, n: x.n - 1 } : x).sort((a, b) => b.n - a.n || a.nome.localeCompare(b.nome, 'it'));
  const sp = sorpassi(prima, L, uid), dav = L[sp.pos - 2], pod = ['oro', 'argento', 'bronzo'][sp.pos - 1];
  return { tipo: 'aso', titolo: 'Manutenzione registrata!', chi: `Ottimo lavoro, ${nomeBreve(me.nome)}!`, frase: await frase('aso', uid),
    sorpasso: sp.superati.length ? `Hai superato ${sp.superati.join(' e ')}: ora sei ${sp.pos}ª a ${MESI[mese - 1]}!` : '',
    posizione: `Sei ${sp.pos}ª a ${MESI[mese - 1]} con ${me.n} manutenzioni`,
    passo: (pod ? `Se il mese finisse oggi: medaglia d'${pod === 'oro' ? 'oro' : pod}.` : '') + (dav ? ` Prossimo obiettivo: superare ${dav.nome}.` : ' Difendi l\'oro fino a fine mese!'),
    grande: sp.superati.length > 0, nome: me.nome, pos: sp.pos, superati: sp.superati };
}

/* ---------- eventi dalle app ---------- */
const titolo = t => String(t || '').toLowerCase().replace(/(^|[\s'-])\p{L}/gu, x => x.toUpperCase());
// CRM: un preventivo è diventato «A». Torna la festa per chi ha salvato (se è il commerciale); agli altri arriva la notifica.
async function preventivoAccettato(p, salvatoDa) {
  let festa = null;
  try {
    const anno = +p.anno, mese = +p.mese, pdc = Number(p.pdc) || 0;
    if (p.commerciale_id) {
      const l = await lodeCommerciale({ uid: p.commerciale_id, anno, mese, pdc });
      if (l) {
        if (salvatoDa === p.commerciale_id) festa = l;
        else { const fid = await festaDaAprire(p.commerciale_id, l); avvisa([p.commerciale_id], { title: 'Preventivo accettato! 🎉', body: l.sorpasso || l.frase, url: URL_C + '?festa=' + fid }); }
        bacheca('comm', `${l.nome} ha chiuso un preventivo${l.superati.length ? ` e ha superato ${l.superati.join(' e ')}` : ''} 🎉`, p.commerciale_id);
      }
    }
    const parti = String(p.paziente || '').trim().split(/\s+/), breve = parti.length > 1 ? `${titolo(parti[0])} ${parti[1][0]}.` : titolo(parti[0]);
    const U = await utenti(), cm = U.get(p.commerciale_id);
    const da = cm ? { nome: cm.nome, nomeProprio: cm.nomeProprio || cm.nome.split(' ')[0], figura: cm.figura, sede: titolo(p.sede_nome || '') } : null;
    for (const mid of (Array.isArray(p.medici_ids) ? p.medici_ids : [])) {
      const md = U.get(mid), dott = md ? `${md.donna ? 'Dott.ssa' : 'Dott.'} ${titolo(md.cognome || md.nome)}` : 'Dottore';
      const l = await lodeMedico({ uid: mid, anno, mese, paziente: titolo(p.paziente), pdc, tipo: titolo(p.tipo_pdc), data: p.data, da: da && { ...da, dott } });
      if (!l) continue;
      const fid = await festaDaAprire(mid, l);
      // sul telefono bloccato solo cognome e iniziale; il nome intero si vede aprendo l'app
      avvisa([mid], da ? { title: `${da.nomeProprio} · CRM To Smile`, body: `Ciao ${dott}, abbiamo chiuso ${breve} dopo la tua visita! 🎉 Tocca per leggere`, url: URL_C + '?festa=' + fid }
        : { title: 'Il tuo paziente ha accettato! 🎉', body: `${breve} ha accettato il piano di cura dopo la tua visita. Tocca per vedere.`, url: URL_C + '?festa=' + fid });
      bacheca('medici', `${l.nome}: un paziente ha accettato dopo la sua visita 🎉`, mid);
    }
  } catch (e) { console.warn('Classifiche (preventivo accettato):', e.message); }
  return festa;
}
async function produzioneSalvata(uid, anno, mese) { try { if ((await utenti()).get(uid)?.figura !== 'REC') return null; return await lodeRec({ uid, anno, mese }); } catch (e) { console.warn('Classifiche (produzione):', e.message); return null; } }
async function manutenzioneFatta(uid) {
  try {
    const d = oggi(), l = await lodeAso({ uid, anno: +d.slice(0, 4), mese: +d.slice(5, 7) });
    if (l?.superati.length) bacheca('aso', `${l.nome} ha registrato una manutenzione e ha superato ${l.superati.join(' e ')}`, uid);
    return l;
  } catch (e) { console.warn('Classifiche (manutenzione):', e.message); return null; }
}

/* ---------- chiusure automatiche ---------- */
const T3 = ['oro', 'argento', 'bronzo'], E3 = ['🥇', '🥈', '🥉'];
const nomeMedaglia = t => `medaglia d'${t === 'oro' ? 'oro' : t}`;
// (le chiavi hanno «v2:» davanti: i segni lasciati dalla prima prova online non contano)
async function blocca(cosa) { const { rows } = await q('insert into chiusure (cosa) values ($1) on conflict do nothing returning cosa', ['v2:' + cosa]); return rows.length > 0; }
// podio del mese (medici o ASO): oro, argento, bronzo ai primi tre. muto = ricostruzione: si salva e basta, senza notifiche
async function podio(cat, anno, mese, L, valore, muto) {
  const per = `${anno}-${String(mese).padStart(2, '0')}`, U = await utenti();
  const P = L.slice(0, 3);
  for (let i = 0; i < P.length; i++) await q('insert into medaglie (categoria, periodo, tipo, user_id, nome, valore) values ($1,$2,$3,$4,$5,$6) on conflict do nothing', [cat, per, T3[i], P[i].id, P[i].nome, valore(P[i])]);
  if (muto || !P.length) return;
  const testo = P.map((x, i) => `${E3[i]} ${x.nome}`).join(' · '), chi = cat === 'medici' ? 'Medico' : 'ASO';
  for (let i = 0; i < P.length; i++) {
    const x = P[i], fid = await festaDaAprire(x.id, { tipo: T3[i], titolo: `${nomeMedaglia(T3[i])[0].toUpperCase()}${nomeMedaglia(T3[i]).slice(1)}!`, chi: x.nome, grande: true, oro: i === 0, bottone: 'Grazie!',
      frase: `${i + 1}° posto a ${MESI[mese - 1]}: ${valore(x)}. Finisce nel tuo medagliere ${anno}!` });
    avvisa([x.id], { title: `Hai vinto la ${nomeMedaglia(T3[i])}! ${E3[i]}`, body: `${i + 1}° posto a ${MESI[mese - 1]}: ${valore(x)}.`, url: URL_C + '?festa=' + fid });
  }
  avvisa([...U.values()].filter(u => u.attivo && u.figura === chi && !P.some(x => x.id === u.id)).map(u => u.id), { title: `Podio di ${MESI[mese - 1]}`, body: `${testo}. Complimenti! Da domani si riparte: il prossimo podio può essere tuo.`, url: URL_C });
  bacheca(cat, `Podio di ${MESI[mese - 1]}: ${testo}`);
}
async function chiudiMese(anno, mese, muto = false) {
  const per = `${anno}-${String(mese).padStart(2, '0')}`, U = await utenti();
  if (await blocca('medici:' + per))
    await podio('medici', anno, mese, (await medici(anno, mese)).filter(x => x.inGara && x.acc > 0), x => `${pc(x.conc)} di accettati su ${x.visite} visite`, muto);
  if (await blocca('aso:' + per))
    await podio('aso', anno, mese, (await aso(anno, mese)).filter(x => x.n > 0), x => `${x.n} manutenzioni`, muto);
  // REC: gradi dal posto nella classifica dell'anno
  if (await blocca('rec:' + per)) {
    const L = (await rec(anno, mese)).lista.filter(x => x.perc != null), promossi = [];
    for (let i = 0; i < L.length; i++) {
      const x = L[i], g = gradoRecDa(i, L.length), prima = (await gradoSalvato('rec', x.id))?.grado;
      await q('insert into gradi (categoria, user_id, periodo, grado, nome) values ($1,$2,$3,$4,$5) on conflict do nothing', ['rec', x.id, per, g, x.nome]);
      if (muto || prima == null || g === prima) continue;
      if (g > prima) {
        promossi.push(`${x.nome} è ${REGOLE.gradiRec[g]}`);
        const fid = await festaDaAprire(x.id, { tipo: 'grado', titolo: `Promozione: ${REGOLE.gradiRec[g]}!`, chi: x.nome, grado: g, cat: 'rec', grande: true, bottone: 'Grazie!',
          frase: 'Il grado è tuo: lo vede tutta la squadra. Una medaglia o un grado qualificano il tuo lavoro!' });
        avvisa([x.id], { title: `Promozione: ${REGOLE.gradiRec[g]}! 🎉`, body: 'Il tuo nuovo grado è nelle Classifiche.', url: URL_C + '?festa=' + fid });
      } else avvisa([x.id], { title: `Il tuo grado di ${MESI[mese - 1]}: ${REGOLE.gradiRec[g]}`, body: 'Il grado si riconquista già dal prossimo mese: ogni produzione conta, e tu sai come si fa.', url: URL_C });
    }
    if (promossi.length) { avvisa([...U.values()].filter(u => u.attivo && u.figura === 'REC').map(u => u.id), { title: 'Gradi REC aggiornati', body: promossi.join(' · ') + '. Complimenti!', url: URL_C }); bacheca('rec', `Promozioni di ${MESI[mese - 1]}: ${promossi.join(' · ')}`); }
  }
  // fine trimestre: gradi dei commerciali
  if (mese % 3 === 0 && await blocca(`comm:${anno}-T${mese / 3}`)) {
    const L = await commerciali(anno, mesiTrim(mese / 3)), pro = [];
    for (const x of L) {
      const g = gradoComm(x.conc, x.ticket), prima = (await gradoSalvato('comm', x.id))?.grado ?? 0;
      await q('insert into gradi (categoria, user_id, periodo, grado, nome) values ($1,$2,$3,$4,$5) on conflict do nothing', ['comm', x.id, `${anno}-T${mese / 3}`, g, x.nome]);
      if (muto) continue;
      if (g > prima) {
        pro.push(`${x.nome} è ${REGOLE.gradiComm[g].nome}`);
        const fid = await festaDaAprire(x.id, { tipo: 'grado', titolo: `Promozione: ${REGOLE.gradiComm[g].nome}!`, chi: x.nome, grado: g, cat: 'comm', grande: true, bottone: 'Grazie!',
          frase: `Nel trimestre: concretizzazione ${pc(x.conc)} e TMV ${fE(x.ticket)}. Il grado è tuo: lo vede tutta la squadra.` });
        avvisa([x.id], { title: `Promozione: ${REGOLE.gradiComm[g].nome}! 🎉`, body: `${REGOLE.gradiComm[g].titolo} sui numeri del trimestre.`, url: URL_C + '?festa=' + fid });
      } else if (g < prima) avvisa([x.id], { title: `Il tuo grado del trimestre: ${REGOLE.gradiComm[g].nome}`, body: 'Il grado si riconquista nel prossimo trimestre: hai tutto per farlo.', url: URL_C });
    }
    if (pro.length) bacheca('comm', `Promozioni del trimestre: ${pro.join(' · ')}`);
  }
  // fine anno: medici e ASO, vince chi ha più medaglie (a parità più ori, poi più argenti)
  if (mese === 12 && !muto) for (const [cat, fig] of [['medici', 'Medico'], ['aso', 'ASO']]) {
    if (!await blocca(`${cat}-anno:${anno}`)) continue;
    const v = (await medagliere(cat, anno))[0]; if (!v) continue;
    const txt = `${v.totale} medaglie (${v.oro} ori, ${v.argento} argenti, ${v.bronzo} bronzi)`;
    bacheca(cat, `🏆 Medagliere ${anno}: vince ${v.nome} con ${txt}!`, v.user_id);
    avvisa([...U.values()].filter(u => u.attivo && u.figura === fig).map(u => u.id), { title: `Medagliere ${anno}: vince ${v.nome}! 🏆`, body: `${txt}. Complimenti!`, url: URL_C });
  }
}
// ricostruzione dal 1° gennaio: medaglie e gradi dei mesi e trimestri già finiti, senza notifiche (una volta sola)
async function ricostruisci(anno) {
  const d = oggi(), mOggi = +d.slice(0, 4) === anno ? +d.slice(5, 7) : 13;
  for (let m = 1; m < mOggi && m <= 12; m++) await chiudiMese(anno, m, true);
}
// a ognuno il suo stato attuale (solo i suoi numeri)
async function statoAttuale() {
  const d = oggi(), anno = +d.slice(0, 4), mese = +d.slice(5, 7), U = await utenti();
  const [C, M, R, A, MM, MA] = await Promise.all([commerciali(anno, [mese]), medici(anno, mese), rec(anno, mese), aso(anno, mese), medagliere('medici', anno), medagliere('aso', anno)]);
  const med = (L, id) => { const x = L.find(y => y.user_id === id); return x ? `${x.totale} medaglie nel ${anno} (🥇${x.oro} 🥈${x.argento} 🥉${x.bronzo})` : `ancora nessuna medaglia nel ${anno}`; };
  let n = 0;
  for (const u of U.values()) {
    if (!u.attivo) continue;
    const cat = CATEGORIA_DI[u.figura]; let body = '';
    if (cat === 'comm') {
      const g = (await gradoSalvato('comm', u.id))?.grado ?? 0, x = C.find(y => y.id === u.id);
      body = `Il tuo grado: ${REGOLE.gradiComm[g].nome}.` + (x ? ` A ${MESI[mese - 1]}: ${x.acc} accettati, TMV ${fE(x.ticket)}, concretizzazione ${pc(x.conc)}.` : '');
    } else if (cat === 'medici') {
      const L = M.filter(x => x.inGara), i = L.findIndex(x => x.id === u.id), x = M.find(y => y.id === u.id);
      body = (i >= 0 ? `Sei ${i + 1}° a ${MESI[mese - 1]} con il ${pc(x.conc)} di accettati. ` : x ? `A ${MESI[mese - 1]}: ${x.visite} visite, in gara da ${REGOLE.minVisite}. ` : '') + `Hai ${med(MM, u.id)}.`;
    } else if (cat === 'rec') {
      const L = R.lista.filter(x => x.perc != null), i = L.findIndex(x => x.id === u.id), g = (await gradoSalvato('rec', u.id))?.grado ?? (i >= 0 ? gradoRecDa(i, L.length) : 0);
      body = `Il tuo grado: ${REGOLE.gradiRec[g]}.`;
    } else if (cat === 'aso') {
      const i = A.findIndex(x => x.id === u.id);
      body = (i >= 0 ? `Sei ${i + 1}ª a ${MESI[mese - 1]} con ${A[i].n} manutenzioni. ` : '') + `Hai ${med(MA, u.id)}.`;
    } else continue;
    avvisa([u.id], { title: 'Classifiche e medaglie: il tuo stato 🏆', body, url: URL_C }); n++;
  }
  return n;
}
// ogni mezz'ora: se è cominciato un mese nuovo, si chiude quello prima (una volta sola, anche con più istanze)
async function controllaChiusure() {
  const d = oggi(), a = +d.slice(0, 4), m = +d.slice(5, 7), pa = m === 1 ? a - 1 : a, pm = m === 1 ? 12 : m - 1;
  // primo avvio: si ricostruisce l'anno dal 1° gennaio (senza notifiche) e poi a ognuno arriva il suo stato attuale
  if (await blocca('avvio-' + a)) {
    try { await ricostruisci(a); const n = await statoAttuale(); await q("update chiusure set esito = $2 where cosa = $1", ['v2:avvio-' + a, `stato a ${n} persone`]); console.log(`Classifiche: ricostruito il ${a}, stato mandato a ${n} persone`); }
    catch (e) { console.error('Classifiche, ricostruzione:', e.message); }
    return;
  }
  try { await chiudiMese(pa, pm); } catch (e) { console.error('Classifiche, chiusura del mese:', e.message); }
}

module.exports = { q, migrate, oggi, MESI, REGOLE, trimDi, mesiTrim, stelleTicket, stelleConc, stelleRec, gradoComm, gradoRecDa, CATEGORIA_DI,
  commerciali, medici, rec, aso, gradoSalvato, medagliere, utenti, bacheca, avvisa, festaDaAprire, URL_C,
  lodeCommerciale, lodeMedico, lodeRec, lodeAso, preventivoAccettato, produzioneSalvata, manutenzioneFatta, controllaChiusure, chiudiMese, ricostruisci, statoAttuale, fE, pc };
