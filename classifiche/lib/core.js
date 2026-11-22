// Classifiche e medaglie: calcoli, regole, frasi, chiusure automatiche (mese, trimestre, anno).
// Legge i dati che ci sono già nelle app (CRM, Produzione di UL, Manutenzione attrezzature, Gestione finanziaria): non li cambia mai.
// Scrive solo nel suo schema «classifiche»: gradi, medaglie, bacheca, applausi, feste da aprire, ordine delle frasi.
const { Pool, types } = require('pg');
types.setTypeParser(1082, v => v);
const crypto = require('crypto');
const store = require('../../accessi/lib/store');
const finanza = require('../../lib/finanza');

const url = process.env.DATABASE_URL || '';
const pool = new Pool({ connectionString: url, ssl: process.env.PGSSL === 'true' || /\.render\.com/.test(url) ? { rejectUnauthorized: false } : false, options: '-c search_path=classifiche,public', max: 3 });
const q = (t, p) => pool.query(t, p);
const S = {
  crm: (process.env.CRM_DB_SCHEMA || 'crm').replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'crm',
  cassa: (process.env.CASSA_DB_SCHEMA || 'cassa').replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'cassa',
  aso: (process.env.ASO_DB_SCHEMA || 'aso').replace(/[^a-z0-9_]/gi, '').toLowerCase() || 'aso',
};

async function migrate() {
  await q('create schema if not exists classifiche');
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
const FRASI = {
  comm: ['Un altro sì conquistato con professionalità: questo è il lavoro di un vero commerciale.', 'Ascolto, pazienza e la proposta giusta: il paziente si è fidato di te.',
    'Il tuo atteggiamento fa la differenza, e oggi si vede.', 'Hai accompagnato il paziente con cura fino al sì. Ottimo lavoro!', 'Chiarezza, empatia e determinazione: hai la stoffa del vero commerciale.',
    'Hai dato al paziente fiducia e serenità nella scelta.', 'Costanza e gentilezza ripagano sempre. Applausi per te!', 'Il team To Smile è fiero del tuo lavoro.',
    'Hai trasformato una proposta in un sorriso. Continua così!', 'Professionalità da manuale: ecco come si chiude un preventivo.', 'Ogni sì è merito del tuo impegno e del modo in cui ti prendi cura dei pazienti.',
    'Precisione, ascolto e il sorriso giusto: sei un vero commerciale.', 'Hai spiegato bene, hai risposto ai dubbi, hai chiuso. Perfetto.', 'La fiducia del paziente non arriva per caso: te la sei guadagnata.',
    'Calma, competenza e il tono giusto: così si lavora.', 'Questo risultato porta la tua firma. Complimenti davvero.', 'Hai saputo capire cosa serviva al paziente. Questo è il vero valore.',
    'Un sì che nasce dalla tua serietà e dalla tua cortesia.', 'Il paziente ha scelto noi grazie a te.', 'Sei un punto di riferimento per i pazienti e per la squadra.',
    'Hai fatto sentire il paziente al centro. È questo che fa la differenza.', 'Determinazione gentile: la qualità più rara, e tu ce l\'hai.', 'Hai lavorato con il cuore e con la testa. Si vede nel risultato.',
    'Comunicazione chiara e atteggiamento positivo: la ricetta del successo.', 'Con il tuo modo di fare rendi facile anche la scelta più importante.', 'Hai creduto nella proposta e il paziente ha creduto in te.',
    'Hai gestito il colloquio come un professionista vero.', 'Hai alzato l\'asticella ancora una volta. Complimenti!', 'Pazienza, ascolto e convinzione: un mix perfetto.',
    'Ecco come si fa: rispetto per il paziente e risultato per lo studio.'],
  medici: ['La tua visita ha convinto: chiarezza e competenza fanno la differenza.', 'Il paziente si è fidato del tuo piano di cura. Ottimo lavoro clinico e umano.',
    'Hai spiegato la terapia con semplicità: il paziente ha detto sì.', 'Competenza e attenzione al paziente: questa è la medicina che sceglie To Smile.',
    'Un piano di cura chiaro e una visita accogliente: il risultato si vede.', 'Il paziente ha scelto di curarsi con noi grazie alla tua visita.', 'Hai trasmesso sicurezza: è il primo passo verso un sorriso nuovo.',
    'Ottima collaborazione con la squadra commerciale: insieme si vince.', 'La tua professionalità ha reso facile una scelta importante.', 'Precisione nella diagnosi e calore nel rapporto: complimenti davvero.',
    'Ogni sì dopo una tua visita è un segno di fiducia nel tuo lavoro.', 'Il tuo modo di visitare fa sentire il paziente in buone mani.'],
  rec: ['Produzione registrata con precisione: il tuo lavoro tiene in ordine tutta la sede.', 'Ogni numero che inserisci racconta un lavoro ben fatto. Grazie!',
    'Puntualità e cura: è così che si lavora in reception.', 'Il tuo impegno si vede nei risultati della sede.', 'Accoglienza, organizzazione e precisione: sei il cuore dello studio.',
    'Un altro mese gestito alla grande. Complimenti!', 'Grazie per la cura con cui segui pazienti, agenda e numeri.', 'La sede gira bene anche grazie a te. Avanti così!',
    'Ordine e costanza: le qualità di una REC di valore.', 'Hai chiuso con il sorriso e con i conti in ordine.'],
  aso: ['Manutenzione fatta: grazie a te lo studio lavora sicuro e in ordine.', 'Precisione e cura degli strumenti: la qualità parte da qui.',
    'Un riunito curato è un paziente sereno. Ottimo lavoro!', 'Il tuo scrupolo protegge pazienti e colleghi. Grazie!', 'Ordine, igiene e attenzione: sei una garanzia per tutta la sede.',
    'Ogni manutenzione registrata è un gesto di professionalità.', 'Il lavoro che non si vede è quello che fa la differenza. Complimenti!', 'Grazie per la costanza: gli strumenti sono in mani sicure.',
    'Ottima abitudine: prevenire è il modo migliore di lavorare.', 'Sei un esempio di cura per tutta la squadra.'],
};
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
  const { rows } = await store.q(`select id, first_name, last_name, email, figura, sedi, status from users where not owner or coalesce(figura, '') <> ''`);
  return new Map(rows.map(u => [u.id, { id: u.id, nome: nomeU(u), figura: u.figura || '', sedi: Array.isArray(u.sedi) ? u.sedi : [], attivo: u.status === 'active' }]));
}
const CATEGORIA_DI = { RAP: 'comm', RUL: 'comm', Medico: 'medici', REC: 'rec', ASO: 'aso' };

/* ---------- calcoli ---------- */
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
  return [...per.values()].map(x => ({ ...x, fatt: Math.round(x.fatt * 100) / 100, conc: x.n ? x.acc / x.n * 100 : 0, ticket: x.acc ? x.fatt / x.acc : 0 }))
    .sort((a, b) => b.fatt - a.fatt || b.conc - a.conc);
}
// medici: ogni preventivo col medico è una visita; % = accettati / visite. In gara per l'oro solo con almeno 10 visite.
async function medici(anno, mese) {
  const U = await utenti();
  const { rows } = await q(`select medici_ids, esito from ${S.crm}.preventivi where anno = $1 and mese = $2`, [anno, mese]);
  const per = new Map();
  for (const r of rows) for (const id of Array.isArray(r.medici_ids) ? r.medici_ids : []) {
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
  return rows.sort((a, b) => b.oro - a.oro || b.argento - a.argento || b.bronzo - a.bronzo);
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
  const prima = primaDi || dopo.map(x => x.id === uid ? { ...x, fatt: x.fatt - pdc } : x).sort((a, b) => b.fatt - a.fatt);
  const sp = sorpassi(prima, dopo, uid), sT = stelleTicket(me.ticket), sC = stelleConc(me.conc);
  const tr = pdc >= 10000 ? ['Preventivo d\'oro!', 'Un preventivo importante, chiuso con grande sicurezza. Lavoro di altissimo livello.']
    : me.acc === 1 ? ['Il primo sì del mese!', 'Il mese parte alla grande: hai dato il ritmo giusto alla squadra.']
    : me.acc % 10 === 0 ? [`${me.acc}° accettato del mese!`, `Quota ${me.acc} raggiunta! Costanza e professionalità da vero commerciale.`] : null;
  const t = trimDi(mese), tr3 = await commerciali(anno, mesiTrim(t).filter(m => m <= mese)), mt = tr3.find(x => x.id === uid);
  const g = mt ? gradoComm(mt.conc, mt.ticket) : 0, gs = (await gradoSalvato('comm', uid))?.grado ?? 0;
  const passi = [];
  if (sT < 5) passi.push(`ticket medio a ${fE(REGOLE.ticket[sT].da)} per la ${sT + 1}ª stella`);
  if (sC < 5) { const soglia = REGOLE.fasce[sC] * REGOLE.targetConc / 100, serve = Math.max(1, Math.ceil((soglia * me.n - me.acc) / (1 - soglia))); passi.push(`${serve} ${serve === 1 ? 'accettato' : 'accettati'} in più per la ${sC + 1}ª stella di concretizzazione`); }
  return { tipo: 'comm', titolo: 'Preventivo accettato!', chi: `${caso(TITOLI)}, ${nomeBreve(me.nome)}!`, traguardo: tr?.[0] || '', frase: tr ? tr[1] : await frase('comm', uid),
    sorpasso: sp.superati.length ? `Hai superato ${sp.superati.join(' e ')} in classifica: ora sei ${sp.pos}° per fatturato di ${MESI[mese - 1]}!` : '',
    posizione: `Sei ${sp.pos}° in classifica a ${MESI[mese - 1]} con ${fE(me.fatt)}`,
    stelle: Math.round((sT + sC) / 2),
    parametri: [
      { nome: 'Ticket medio di vendita', stelle: sT, valore: `${fE(me.ticket)} su ${nAcc(me.acc)}`, ok: me.ticket >= 3000, goal: me.ticket >= 3000 ? '✓ Target di 3.000 € raggiunto' : 'Target: 3.000 €' },
      { nome: 'Concretizzazione', stelle: sC, valore: `${pc(me.conc)} · ${nAcc(me.acc)} su ${me.n} presentati`, ok: me.conc >= 50, goal: me.conc >= 50 ? '✓ Target del 50% raggiunto' : 'Target: 50%' }],
    doppio: me.ticket >= 3000 && me.conc >= 50 ? 'Doppio obiettivo centrato. Lavoro da vero commerciale!' : '',
    grado: g > gs ? `Con questi numeri a fine trimestre diventi ${REGOLE.gradiComm[g].nome}!` : '',
    passo: passi.join(' · '), grande: !!(sp.superati.length || tr || (me.ticket >= 3000 && me.conc >= 50)), nome: me.nome, pos: sp.pos, superati: sp.superati };
}
// medico: un suo paziente ha accettato
async function lodeMedico({ uid, anno, mese, paziente, pdc, tipo, data }) {
  const dopo = await medici(anno, mese), me = dopo.find(x => x.id === uid); if (!me) return null;
  const prima = dopo.map(x => x.id === uid ? { ...x, acc: x.acc - 1, conc: (x.acc - 1) / x.visite * 100 } : x).sort((a, b) => b.inGara - a.inGara || b.conc - a.conc || b.visite - a.visite);
  const sp = sorpassi(prima, dopo, uid), s = stelleConc(me.conc), primo = sp.pos === 1 && me.inGara;
  return { tipo: 'medici', titolo: 'Il tuo paziente ha accettato!', chi: `Complimenti, ${me.nome}!`, frase: await frase('medici', uid),
    paziente: { nome: paziente, dettaglio: [tipo, pdc ? fE(pdc) : '', data ? 'visita del ' + data.split('-').reverse().join('/') : ''].filter(Boolean).join(' · ') },
    sorpasso: sp.superati.length && me.inGara ? `Hai superato ${sp.superati.join(' e ')}: ora sei ${sp.pos}° nella classifica medici!` : '',
    posizione: me.inGara ? `Sei ${sp.pos}° nella classifica medici di ${MESI[mese - 1]}` : `Ancora ${REGOLE.minVisite - me.visite} visite per entrare in gara per la medaglia d'oro`,
    parametri: [{ nome: `La tua concretizzazione di ${MESI[mese - 1]}`, stelle: s, valore: `${pc(me.conc)} · ${nAcc(me.acc)} su ${me.visite} visite`, ok: primo,
      goal: primo ? '✓ Sei in testa: la medaglia d\'oro è a portata di mano!' : 'La medaglia d\'oro si decide a fine mese' }],
    grande: true, nome: me.nome, pos: sp.pos, superati: sp.superati };
}
async function lodeRec({ uid, anno, mese }) {
  const { lista } = await rec(anno, mese), L = lista.filter(x => x.perc != null), me = L.find(x => x.id === uid);
  const gs = (await gradoSalvato('rec', uid))?.grado, U = await utenti();
  const base = { tipo: 'rec', titolo: 'Produzione salvata!', chi: `Grazie, ${nomeBreve(U.get(uid)?.nome || '')}!`, frase: await frase('rec', uid), grande: false };
  if (!me) return { ...base, posizione: 'La tua posizione in classifica arriva quando l\'amministrazione approva la produzione e il fatturato del mese è in Gestione finanziaria.' };
  const pos = L.indexOf(me) + 1, dav = L[pos - 2];
  return { ...base, posizione: `Sei ${pos}ª nella classifica REC ${anno} con il ${pc(me.perc)} di produzione sul fatturato`,
    parametri: [{ nome: 'Produzione sul fatturato', stelle: stelleRec(me.perc), valore: `${pc(me.perc)} · gold standard ${REGOLE.targetRec}%`, ok: me.perc >= REGOLE.targetRec, goal: me.perc >= REGOLE.targetRec ? '✓ Gold standard raggiunto' : `Gold standard: ${REGOLE.targetRec}%` }],
    passo: dav ? `Ti mancano ${pc(dav.perc - me.perc + .1)} punti per superare ${dav.nome}.` : 'Sei in testa: tieni il comando fino a fine mese!',
    grado: `Il tuo grado: ${REGOLE.gradiRec[gs ?? gradoRecDa(pos - 1, L.length)]} · si aggiorna a fine mese` };
}
async function lodeAso({ uid, anno, mese }) {
  const L = await aso(anno, mese), me = L.find(x => x.id === uid); if (!me) return null;
  const prima = L.map(x => x.id === uid ? { ...x, n: x.n - 1 } : x).sort((a, b) => b.n - a.n || a.nome.localeCompare(b.nome, 'it'));
  const sp = sorpassi(prima, L, uid), dav = L[sp.pos - 2], pod = ['oro', 'argento', 'bronzo'][sp.pos - 1];
  return { tipo: 'aso', titolo: 'Manutenzione registrata!', chi: `Ottimo lavoro, ${nomeBreve(me.nome)}!`, frase: await frase('aso', uid),
    sorpasso: sp.superati.length ? `Hai superato ${sp.superati.join(' e ')}: ora sei ${sp.pos}ª a ${MESI[mese - 1]}!` : '',
    posizione: `Sei ${sp.pos}ª a ${MESI[mese - 1]} con ${me.n} manutenzioni`,
    passo: pod ? `Se il mese finisse oggi: medaglia d'${pod === 'oro' ? 'oro' : pod}.` + (dav ? ` ${dav.nome} è a ${dav.n}: ancora ${dav.n - me.n + 1} per superarla.` : ' Difendi l\'oro fino a fine mese!')
      : `${dav.nome} è a ${dav.n}: ancora ${dav.n - me.n + 1} per superarla.`,
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
        bacheca('comm', `${l.nome} ha chiuso un preventivo da ${fE(pdc)}${l.superati.length ? ` e sale al ${l.pos}° posto` : ''}`, p.commerciale_id);
      }
    }
    const parti = String(p.paziente || '').trim().split(/\s+/), breve = parti.length > 1 ? `${titolo(parti[0])} ${parti[1][0]}.` : titolo(parti[0]);
    for (const mid of (Array.isArray(p.medici_ids) ? p.medici_ids : [])) {
      const l = await lodeMedico({ uid: mid, anno, mese, paziente: titolo(p.paziente), pdc, tipo: titolo(p.tipo_pdc), data: p.data });
      if (!l) continue;
      const fid = await festaDaAprire(mid, l);
      // sul telefono bloccato solo cognome e iniziale; il nome intero si vede aprendo l'app
      avvisa([mid], { title: 'Il tuo paziente ha accettato! 🎉', body: `${breve} ha accettato il piano di cura dopo la tua visita. Tocca per vedere.`, url: URL_C + '?festa=' + fid });
      bacheca('medici', `${l.nome}: un paziente ha accettato dopo la sua visita${l.superati.length ? ` · sale al ${l.pos}° posto` : ''}`, mid);
    }
  } catch (e) { console.warn('Classifiche (preventivo accettato):', e.message); }
  return festa;
}
async function produzioneSalvata(uid, anno, mese) { try { if ((await utenti()).get(uid)?.figura !== 'REC') return null; return await lodeRec({ uid, anno, mese }); } catch (e) { console.warn('Classifiche (produzione):', e.message); return null; } }
async function manutenzioneFatta(uid) {
  try {
    const d = oggi(), l = await lodeAso({ uid, anno: +d.slice(0, 4), mese: +d.slice(5, 7) });
    if (l?.superati.length) bacheca('aso', `${l.nome} ha registrato una manutenzione e sale al ${l.pos}° posto`, uid);
    return l;
  } catch (e) { console.warn('Classifiche (manutenzione):', e.message); return null; }
}

/* ---------- chiusure automatiche ---------- */
async function blocca(cosa) { const { rows } = await q('insert into chiusure (cosa) values ($1) on conflict do nothing returning cosa', [cosa]); return rows.length > 0; }
async function chiudiMese(anno, mese) {
  const per = `${anno}-${String(mese).padStart(2, '0')}`, U = await utenti();
  const attivi = f => [...U.values()].filter(u => u.attivo && u.figura === f).map(u => u.id);
  // medici: medaglia d'oro alla miglior concretizzazione con almeno 10 visite
  if (await blocca('medici:' + per)) {
    const L = (await medici(anno, mese)).filter(x => x.inGara), v = L[0];
    if (v) {
      await q('insert into medaglie (categoria, periodo, tipo, user_id, nome, valore) values ($1,$2,$3,$4,$5,$6) on conflict do nothing', ['medici', per, 'oro', v.id, v.nome, `${pc(v.conc)} su ${v.visite} visite`]);
      const fid = await festaDaAprire(v.id, { tipo: 'oro', titolo: 'Medaglia d\'oro!', chi: v.nome, frase: `Miglior concretizzazione di ${MESI[mese - 1]}: ${pc(v.conc)} con ${v.acc} accettati su ${v.visite} visite. Complimenti!`, grande: true, oro: true });
      avvisa([v.id], { title: 'Medaglia d\'oro! 🥇', body: `Hai vinto la medaglia d'oro di ${MESI[mese - 1]}: ${pc(v.conc)} di accettati.`, url: URL_C + '?festa=' + fid });
      avvisa(attivi('Medico').filter(id => id !== v.id), { title: `Medaglia d'oro di ${MESI[mese - 1]}`, body: `${v.nome}: ${pc(v.conc)} di accettati su ${v.visite} visite. Complimenti! Da domani si riparte: la prossima può essere tua.`, url: URL_C });
      bacheca('medici', `🥇 Medaglia d'oro di ${MESI[mese - 1]} a ${v.nome}: ${pc(v.conc)} di accettati su ${v.visite} visite`, v.id);
    }
  }
  // ASO: oro, argento e bronzo per numero di manutenzioni
  if (await blocca('aso:' + per)) {
    const L = (await aso(anno, mese)).filter(x => x.n > 0), T = ['oro', 'argento', 'bronzo'], E = ['🥇', '🥈', '🥉'];
    for (let i = 0; i < Math.min(3, L.length); i++) {
      const x = L[i];
      await q('insert into medaglie (categoria, periodo, tipo, user_id, nome, valore) values ($1,$2,$3,$4,$5,$6) on conflict do nothing', ['aso', per, T[i], x.id, x.nome, `${x.n} manutenzioni`]);
      const fid = await festaDaAprire(x.id, { tipo: T[i], titolo: `Medaglia d'${T[i] === 'oro' ? 'oro' : T[i]}!`, chi: x.nome, frase: `${x.n} manutenzioni attrezzature a ${MESI[mese - 1]}: ${i + 1}ª classificata. Finisce nel tuo medagliere ${anno}!`, grande: true, oro: i === 0 });
      avvisa([x.id], { title: `Medaglia d'${T[i] === 'oro' ? 'oro' : T[i]}! ${E[i]}`, body: `${i + 1}ª a ${MESI[mese - 1]} con ${x.n} manutenzioni attrezzature.`, url: URL_C + '?festa=' + fid });
    }
    if (L.length) {
      const pod = L.slice(0, 3).map((x, i) => `${E[i]} ${x.nome} (${x.n})`).join(' · ');
      avvisa(attivi('ASO').filter(id => !L.slice(0, 3).some(x => x.id === id)), { title: `Podio manutenzioni di ${MESI[mese - 1]}`, body: `${pod}. Complimenti! Da domani si riparte da zero.`, url: URL_C });
      bacheca('aso', `Podio manutenzioni attrezzature di ${MESI[mese - 1]}: ${pod}`);
    }
  }
  // REC: gradi dal posto nella classifica dell'anno
  if (await blocca('rec:' + per)) {
    const L = (await rec(anno, mese)).lista.filter(x => x.perc != null), promossi = [];
    for (let i = 0; i < L.length; i++) {
      const x = L[i], g = gradoRecDa(i, L.length), prima = (await gradoSalvato('rec', x.id))?.grado;
      await q('insert into gradi (categoria, user_id, periodo, grado, nome) values ($1,$2,$3,$4,$5) on conflict do nothing', ['rec', x.id, per, g, x.nome]);
      if (prima == null || g === prima) continue;
      if (g > prima) {
        promossi.push(`${x.nome} sale a ${REGOLE.gradiRec[g]}`);
        const fid = await festaDaAprire(x.id, { tipo: 'grado', titolo: `Promozione: ${REGOLE.gradiRec[g]}!`, chi: x.nome, grado: g, cat: 'rec', frase: `Sei ${i + 1}ª nella classifica REC ${anno} con il ${pc(x.perc)} di produzione sul fatturato. Il grado è tuo: lo vede tutta la squadra.`, grande: true });
        avvisa([x.id], { title: `Promozione: ${REGOLE.gradiRec[g]}! 🎉`, body: `Sei ${i + 1}ª nella classifica REC dell'anno.`, url: URL_C + '?festa=' + fid });
      } else avvisa([x.id], { title: `Il tuo grado di ${MESI[mese - 1]}: ${REGOLE.gradiRec[g]}`, body: 'Il grado si riconquista già dal prossimo mese: ogni produzione conta, e tu sai come si fa.', url: URL_C });
    }
    if (promossi.length) { avvisa(attivi('REC'), { title: 'Gradi REC aggiornati', body: promossi.join(' · ') + '. Complimenti!', url: URL_C }); bacheca('rec', `Gradi REC di ${MESI[mese - 1]}: ${promossi.join(' · ')}`); }
  }
  // fine trimestre: gradi dei commerciali
  if (mese % 3 === 0 && await blocca(`comm:${anno}-T${mese / 3}`)) {
    const L = await commerciali(anno, mesiTrim(mese / 3)), pro = [];
    for (const x of L) {
      const g = gradoComm(x.conc, x.ticket), prima = (await gradoSalvato('comm', x.id))?.grado ?? 0;
      await q('insert into gradi (categoria, user_id, periodo, grado, nome) values ($1,$2,$3,$4,$5) on conflict do nothing', ['comm', x.id, `${anno}-T${mese / 3}`, g, x.nome]);
      if (g > prima) {
        pro.push(`${x.nome} è ${REGOLE.gradiComm[g].nome}`);
        const fid = await festaDaAprire(x.id, { tipo: 'grado', titolo: `Promozione: ${REGOLE.gradiComm[g].nome}!`, chi: x.nome, grado: g, cat: 'comm', frase: `Nel trimestre: concretizzazione ${pc(x.conc)} e ticket medio ${fE(x.ticket)}. Il grado di ${REGOLE.gradiComm[g].nome} è tuo: lo vede tutta la squadra.`, grande: true });
        avvisa([x.id], { title: `Promozione: ${REGOLE.gradiComm[g].nome}! 🎉`, body: `${REGOLE.gradiComm[g].titolo} sui numeri del trimestre.`, url: URL_C + '?festa=' + fid });
      } else if (g < prima) avvisa([x.id], { title: `Il tuo grado del trimestre: ${REGOLE.gradiComm[g].nome}`, body: 'Il grado si riconquista nel prossimo trimestre: hai tutto per farlo.', url: URL_C });
    }
    if (pro.length) { bacheca('comm', `Promozioni del trimestre: ${pro.join(' · ')}`); }
  }
  // fine anno: vince il medagliere ASO chi ha più ori
  if (mese === 12 && await blocca(`aso-anno:${anno}`)) {
    const M = await medagliere('aso', anno), v = M[0];
    if (v) { bacheca('aso', `🏆 Medagliere ${anno} delle ASO: vince ${v.nome} con ${v.oro} ori, ${v.argento} argenti e ${v.bronzo} bronzi!`, v.user_id);
      avvisa([...U.values()].filter(u => u.attivo && u.figura === 'ASO').map(u => u.id), { title: `Medagliere ${anno}: vince ${v.nome}! 🏆`, body: `${v.oro} ori, ${v.argento} argenti, ${v.bronzo} bronzi. Complimenti!`, url: URL_C }); }
  }
}
// ogni mezz'ora: se è cominciato un mese nuovo, si chiude quello prima (una volta sola, anche con più istanze)
async function controllaChiusure() {
  const d = oggi(), a = +d.slice(0, 4), m = +d.slice(5, 7), pa = m === 1 ? a - 1 : a, pm = m === 1 ? 12 : m - 1;
  const per = `${pa}-${String(pm).padStart(2, '0')}`;
  // primo avvio: il mese prima di oggi si segna come già chiuso (niente medaglie per mesi passati prima di questa app)
  if (await blocca('avvio')) { for (const c of ['medici', 'aso', 'rec']) await blocca(`${c}:${per}`); if (pm % 3 === 0) await blocca(`comm:${pa}-T${pm / 3}`); if (pm === 12) await blocca(`aso-anno:${pa}`); return; }
  try { await chiudiMese(pa, pm); } catch (e) { console.error('Classifiche, chiusura del mese:', e.message); }
}

module.exports = { q, migrate, oggi, MESI, REGOLE, trimDi, mesiTrim, stelleTicket, stelleConc, stelleRec, gradoComm, gradoRecDa, CATEGORIA_DI,
  commerciali, medici, rec, aso, gradoSalvato, medagliere, utenti, bacheca, avvisa, festaDaAprire, URL_C,
  lodeCommerciale, lodeMedico, lodeRec, lodeAso, preventivoAccettato, produzioneSalvata, manutenzioneFatta, controllaChiusure, chiudiMese, fE, pc };
