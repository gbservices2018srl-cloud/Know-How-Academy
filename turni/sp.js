// Scheda personale: timbratura NFC, turni del mese, assenze e saldi, report, documenti personali, performance.
// Le persone sono quelle del pannello accessi con l'app (Turni/HR); qui si aggiungono solo i dati di lavoro.
// Orari e giorni sono sempre quelli italiani (Europe/Rome). Nessun dato viene cancellato: si annulla o si archivia.
const crypto = require('crypto');
const store = require('../accessi/lib/store');
const sun = require('./lib/sun');
const buste = require('./lib/buste');
const saldiCedolino = require('./lib/saldi');
const { MEDICO } = require('./scheda');

/* ---------- date e ore (Italia) ---------- */
const fmtR = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
const roma = (d = new Date()) => { const s = fmtR.format(d); return { giorno: s.slice(0, 10), hm: s.slice(11, 16) }; };
const oggi = () => roma().giorno;
const addG = (g, n) => { const d = new Date(g + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const dow = g => new Date(g + 'T12:00:00Z').getUTCDay(); // 0 domenica
const isG = s => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !isNaN(Date.parse(s + 'T12:00:00Z'));
const isM = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(s || '');
const isHM = s => /^([01]\d|2[0-3]):[0-5]\d$/.test(s || '');
const min = hm => +hm.slice(0, 2) * 60 + +hm.slice(3, 5);
const hmDi = m => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
const giorniMese = m => { const out = []; for (let g = m + '-01'; g.startsWith(m); g = addG(g, 1)) out.push(g); return out; };
const fineMese = m => giorniMese(m).pop();
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const num = v => { const n = Number(String(v ?? '').replace(',', '.')); return Number.isFinite(n) ? n : null; };
const r2 = n => Math.round(n * 100) / 100;
const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const fmtG = g => { const d = new Date(g + 'T12:00:00Z'); return `${['dom', 'lun', 'mar', 'mer', 'gio', 'ven', 'sab'][d.getUTCDay()]} ${d.getUTCDate()} ${MESI[d.getUTCMonth()]}`; };

/* ---------- cifratura dei documenti personali (AES-256-GCM, chiave su Render) ---------- */
const KEY = () => { const b = Buffer.from(process.env.SCHEDA_DOC_KEY || process.env.BUSTE_KEY || '', 'base64'); return b.length === 32 ? b : null; };
const cifraOk = () => !!KEY();
function cifra(buf) {
  const k = KEY(); if (!k) throw Object.assign(new Error('Manca la chiave di cifratura dei documenti su Render.'), { status: 400 });
  const iv = crypto.randomBytes(12), c = crypto.createCipheriv('aes-256-gcm', k, iv);
  const file = Buffer.concat([c.update(buf), c.final()]);
  return { file, iv, tag: c.getAuthTag() };
}
function decifra(r) { const d = crypto.createDecipheriv('aes-256-gcm', KEY(), r.iv); d.setAuthTag(r.tag); return Buffer.concat([d.update(r.file), d.final()]); }

const crescita = require('../lib/crescita');
module.exports = function sp(app, ctx) {
  const { db, needUser, needAdmin, wrap, bad, upload, push, sch } = ctx;
  const q = db.q;

  let pronto = null;
  const migrate = () => pronto || (pronto = (async () => {
    await q(`
      create table if not exists sp_persone (user_id text primary key, tipo text, tipo_ok boolean not null default false, ore_sett numeric,
        senza_nfc boolean not null default false, sedi jsonb, onb timestamptz, aggiornato timestamptz not null default now());
      create table if not exists sp_tag (cod text primary key, sede_id text, uid text, protetto boolean not null default false, ctr int not null default -1,
        ultima timestamptz, nota text not null default '');
      create table if not exists sp_timbrature (id text primary key, user_id text not null, giorno date not null, ora text not null, il timestamptz not null default now(),
        tipo text not null, sede_id text, modo text not null, tag text, nota text not null default '', annullata boolean not null default false, da text);
      create index if not exists sp_timbrature_g on sp_timbrature (giorno, user_id);
      -- smart working: posizione presa solo al momento della timbratura, arrotondata (circa 100 m)
      alter table sp_timbrature add column if not exists lat numeric(7,3);
      alter table sp_timbrature add column if not exists lon numeric(7,3);
      alter table sp_timbrature add column if not exists prec int;
      -- lutto (certificato di morte) e malattia (protocollo): approvate subito, ma restano da completare fino alla scadenza
      alter table sp_richieste add column if not exists doc_stato text not null default '';
      alter table sp_richieste add column if not exists scadenza date;
      alter table sp_richieste add column if not exists doc_nome text;
      alter table sp_richieste add column if not exists doc_tipo text;
      alter table sp_richieste add column if not exists doc_dati bytea;
      alter table sp_richieste add column if not exists doc_iv bytea;
      alter table sp_richieste add column if not exists doc_tag bytea;
      alter table sp_richieste add column if not exists doc_il timestamptz;
      alter table sp_mancate add column if not exists motivo text not null default '';
      -- certificati letti e approvati dall'amministrazione: compaiono nei «I miei documenti» della persona
      alter table sp_richieste add column if not exists doc_approvato timestamptz;
      alter table sp_richieste add column if not exists doc_approvato_da text;
      -- firma con il dito (firma elettronica semplice): immagine cifrata, data, dispositivo e impronta del documento firmato
      alter table sp_docs add column if not exists firma bytea;
      alter table sp_docs add column if not exists firma_iv bytea;
      alter table sp_docs add column if not exists firma_tag bytea;
      alter table sp_docs add column if not exists firmato timestamptz;
      alter table sp_docs add column if not exists firma_disp text;
      alter table sp_docs add column if not exists firma_impronta text;
      create table if not exists sp_turni (id text primary key, user_id text not null, giorno date not null, sede_id text, da text not null, a text not null,
        pausa int not null default 0, nota text not null default '', aggiornato timestamptz not null default now());
      create index if not exists sp_turni_g on sp_turni (giorno, user_id);
      create table if not exists sp_preset (id text primary key, nome text not null, da text not null, a text not null, pausa int not null default 0, ordine int not null default 0);
      create table if not exists sp_richieste (id text primary key, user_id text not null, tipo text not null, dal date not null, al date not null,
        ora_da text, ora_a text, quanti numeric, sost_id text, sost_ok boolean, stato text not null, nota text not null default '', prot text not null default '',
        creata timestamptz not null default now(), decisa_il timestamptz, decisa_da text, nota_admin text not null default '');
      create table if not exists sp_movimenti (id text primary key, user_id text not null, voce text not null, tipo text not null, valore numeric not null,
        data date not null, causale text not null default '', rif text, il timestamptz not null default now(), da text, annullato boolean not null default false);
      create table if not exists sp_mancate (user_id text not null, giorno date not null, esito text not null, valore numeric, mov_id text,
        annullata boolean not null default false, il timestamptz not null default now(), primary key (user_id, giorno));
      create table if not exists sp_docs (id text primary key, user_id text, tipo text not null, periodo text not null default '', titolo text not null default '',
        file bytea, iv bytea, tag bytea, impronta text, pagine int, stato text not null default 'bozza', saldi jsonb, origine text not null default '',
        pagina int, suggerito text, caricato timestamptz not null default now(), pubblicato timestamptz, visto timestamptz, ricevuto timestamptz,
        ricevuto_disp text, da text);
      create table if not exists sp_piani (id text primary key, nome text not null, ordine int not null default 0, archiviato boolean not null default false);
      create table if not exists sp_livelli (id text primary key, piano_id text not null, n int not null, ruolo text not null, bonus text not null default '', archiviato boolean not null default false);
      alter table sp_livelli add column if not exists fisso text not null default '';
      alter table sp_livelli add column if not exists variabile text not null default '';
      alter table sp_livelli add column if not exists area text not null default '';
      alter table sp_livelli add column if not exists skill jsonb not null default '[]';
      alter table sp_livelli add column if not exists inc_perc numeric;
      alter table sp_livelli add column if not exists inc_soglia text not null default 'target';
      alter table sp_perf_dati add column if not exists file_nome text;
      alter table sp_perf_dati add column if not exists file_tipo text;
      alter table sp_perf_dati add column if not exists file_dati bytea;
      alter table sp_perf_dati add column if not exists file_iv bytea;
      alter table sp_perf_dati add column if not exists file_tag bytea;
      alter table sp_perf add column if not exists test_invio text;
      create table if not exists sp_obiettivi (id text primary key, livello_id text not null, testo text not null, misura text not null default '', ordine int not null default 0, archiviato boolean not null default false);
      create table if not exists sp_perf (user_id text primary key, piano_id text not null, livello_n int not null, dal date not null default current_date);
      create table if not exists sp_perf_dati (id text primary key, user_id text not null, obiettivo_id text not null, dato text not null, stato text not null default 'verifica',
        nota text not null default '', il timestamptz not null default now(), deciso_il timestamptz);
      create table if not exists sp_passaggi (id text primary key, user_id text not null, piano_id text not null, da_n int not null, a_n int not null,
        stato text not null default 'attesa', bonus text not null default '', il timestamptz not null default now(), deciso_il timestamptz, deciso_da text);
      -- piani caricati da Excel (Piano di inserimento e crescita): colonne del file conservate come sono
      alter table sp_piani add column if not exists contratto text not null default '';
      alter table sp_piani add column if not exists fonte text not null default '';
      alter table sp_piani add column if not exists intestazioni jsonb not null default '[]';
      alter table sp_piani add column if not exists note text not null default '';
      alter table sp_livelli add column if not exists regole jsonb not null default '[]';
      alter table sp_livelli add column if not exists fisso_num numeric;
      -- condizione del fisso: 'senza_target_pers' = il fisso spetta solo se il target personale NON è raggiunto (null = mai impostata)
      alter table sp_livelli add column if not exists fisso_cond text;
      alter table sp_obiettivi add column if not exists sotto text not null default '';
      alter table sp_obiettivi add column if not exists soft text not null default '';
      alter table sp_obiettivi add column if not exists scuola text not null default '';
      alter table sp_obiettivi add column if not exists r_fisso text not null default '';
      alter table sp_obiettivi add column if not exists r_variabile text not null default '';
      alter table sp_obiettivi add column if not exists test boolean not null default false;
      -- compenso della persona: se l'amministratore lo cambia, vale questo invece di quello del livello
      alter table sp_perf add column if not exists fisso_man numeric;
      alter table sp_perf add column if not exists variabile_man text;
      -- guadagni: accordi presi per sede e mese (cifra tolta dal fatturato per il netto), dati del mese per persona, archivio
      create table if not exists sp_accordi (sede_id text not null, mese text not null, importo numeric not null default 0, nota text not null default '',
        aggiornato timestamptz not null default now(), primary key (sede_id, mese));
      create table if not exists sp_mese (user_id text not null, mese text not null, malus boolean not null default false, malus_nota text not null default '',
        target_perc numeric, manuali jsonb not null default '{}', aggiornato timestamptz not null default now(), da text not null default '', primary key (user_id, mese));
      -- I-Profile della persona: solo i numeri del grafico (la foto non si conserva). Lo carica l'amministratore.
      create table if not exists sp_iprofile (user_id text primary key, valori jsonb not null, il timestamptz not null default now(), da text not null default '');
      create table if not exists sp_guadagni (user_id text not null, mese text not null, dati jsonb not null, aggiornato timestamptz not null default now(), primary key (user_id, mese));
    `);
    // turni tipo per riempire il calendario in fretta (si cambiano in Turni di lavoro)
    const { rows } = await q('select count(*)::int n from sp_preset');
    if (!rows[0].n) await q(`insert into sp_preset (id, nome, da, a, pausa, ordine) values
      ('giornata','Giornata','09:30','18:30',60,1),('mattina','Mattina','09:30','13:30',0,2),('pomeriggio','Pomeriggio','14:30','18:30',0,3) on conflict do nothing`);
    // il contratto ora sta nell'anagrafica unica (accesso unico): quelli già dichiarati qui la riempiono (solo dove è vuota)
    await q(`update ${store.SCHEMA}.users u set contratto_tipo = p.tipo, contratto_ore = case when p.tipo = 'dip' then p.ore_sett end, contratto_ok = p.tipo_ok,
        contratto_il = coalesce(p.onb, p.aggiornato) from ${db.SCHEMA}.sp_persone p
      where p.user_id = u.id and u.contratto_tipo is null and p.tipo in ('dip','piva')`).catch(e => console.warn('Scheda personale: recupero contratti:', e.message));
  })().catch(e => { pronto = null; throw e; }));

  /* ---------- persone ---------- */
  const nomeDi = r => `${r.first_name || ''} ${r.last_name || ''}`.trim();
  async function persone() {
    await migrate();
    const { rows } = await store.q(`select u.id, u.first_name, u.last_name, u.figura, u.cf, u.email, u.owner, u.contratto_tipo, u.contratto_ore, u.contratto_ok, u.sedi as sedi_anag from users u
      where u.status = 'active' and (u.owner or exists (select 1 from user_apps a where a.user_id = u.id and a.app = any($1) and not a.sospesa))
      order by u.last_name, u.first_name`, [['turni', 'hr']]);
    const ids = rows.map(r => r.id);
    const [{ rows: sp }, { rows: adm }, meds] = await Promise.all([
      q('select * from sp_persone where user_id = any($1)', [ids]),
      q(`select sso_id from users where role = 'admin' and sso_id = any($1)`, [ids]),
      sch.sediMedici(),
    ]);
    const spm = new Map(sp.map(x => [x.user_id, x])), am = new Set(adm.map(x => x.sso_id)), mm = new Map(meds.map(m => [m.id, m.sedi]));
    const out = [];
    for (const r of rows) {
      const x = spm.get(r.id) || {}, medico = r.figura === MEDICO;
      // sedi: quelle dell'anagrafica unica (i medici: dagli studi Nuovalab); se mancano, quelle di prima
      let sedi = medico ? (mm.get(r.id) || []) : Array.isArray(r.sedi_anag) && r.sedi_anag.length ? r.sedi_anag : x.sedi;
      if (!medico && !Array.isArray(sedi)) sedi = (await store.sediNote(r.id)).map(e => e.id).filter(Boolean);
      out.push({ id: r.id, nome: nomeDi(r) || r.email, figura: r.figura || '', cf: String(r.cf || '').toUpperCase(), email: r.email, owner: !!r.owner,
        // contratto: dall'anagrafica unica; se lì manca ancora, quello di prima di questa app
        ...(r.contratto_tipo ? { tipo: r.contratto_tipo, tipoOk: !!r.contratto_ok, ore: r.contratto_ore != null ? Number(r.contratto_ore) : null }
          : { tipo: x.tipo || (medico ? 'piva' : null), tipoOk: !!x.tipo_ok, ore: x.ore_sett != null ? Number(x.ore_sett) : null }),
        admin: !!r.owner || am.has(r.id), medico, senzaNfc: !!x.senza_nfc, sedi: sedi || [], onb: !!x.onb || !!r.contratto_tipo });
    }
    return out;
  }
  const personaDi = async ssoId => (await persone()).find(p => p.id === ssoId) || null;
  async function io(req) {
    const p = await personaDi(req.user.sso_id);
    if (p) return p;
    const me = await sch.persona(req.user);
    return { id: req.user.sso_id, nome: me.nome, figura: me.figura, cf: '', admin: req.user.role === 'admin', medico: me.figura === MEDICO, tipo: null, sedi: [], ore: null };
  }
  const isDip = p => p.tipo === 'dip';
  const oreGiorno = p => (p.ore || 0) / 5;

  /* ---------- notifiche (centro notifiche unico) ---------- */
  async function avvisa(ssoIds, payload) {
    try {
      const ids = [...new Set(ssoIds.filter(Boolean))];
      if (!ids.length) return;
      const { rows } = await q('select id from users where sso_id = any($1)', [ids]);
      await push.sendToUsers(rows.map(r => r.id), { url: '/', ...payload });
    } catch (e) { console.warn('Scheda personale, notifica:', e.message); }
  }
  async function avvisaAdmin(payload) {
    try { const { rows } = await q(`select id from users where role = 'admin'`); await push.sendToUsers(rows.map(r => r.id), { url: '/', ...payload }); }
    catch (e) { console.warn('Scheda personale, notifica admin:', e.message); }
  }
  const attiva = async () => !!(await sch.imp('attiva'));
  const puoUsare = async req => req.user.role === 'admin' || await attiva();
  const needSp = wrap(async (req, res, next) => { if (!req.user) return bad(res, 401, 'Accesso richiesto'); if (!(await puoUsare(req))) return bad(res, 403, 'La Scheda personale non è ancora attiva.'); await migrate(); next(); });

  /* ---------- saldi ferie (giorni) e permessi (ore) ---------- */
  async function saldi(userIds) {
    const { rows } = await q(`select user_id, voce, tipo, valore from sp_movimenti where not annullato and user_id = any($1) order by data, il`, [userIds]);
    const out = {};
    for (const id of userIds) out[id] = { ferie: 0, permessi: 0, base: { ferie: false, permessi: false } };
    for (const m of rows) {
      const s = out[m.user_id]; if (!s) continue;
      if (m.tipo === 'saldo') { s[m.voce] = Number(m.valore); s.base[m.voce] = true; } else s[m.voce] += Number(m.valore);
    }
    for (const id of userIds) { out[id].ferie = r2(out[id].ferie); out[id].permessi = r2(out[id].permessi); }
    return out;
  }
  const movimento = (user_id, voce, tipo, valore, data, causale, rif, da) => {
    const id = db.newId();
    return q(`insert into sp_movimenti (id, user_id, voce, tipo, valore, data, causale, rif, da) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, user_id, voce, tipo, r2(valore), data, causale, rif || null, da || null]).then(() => id);
  };

  /* ---------- turni ---------- */
  const turnoShape = t => ({ id: t.id, user: t.user_id, giorno: t.giorno, sede: t.sede_id, da: t.da, a: t.a, pausa: t.pausa, nota: t.nota });
  async function turniDi(dal, al, userIds) {
    const { rows } = await q(`select * from sp_turni where giorno between $1 and $2 ${userIds ? 'and user_id = any($3)' : ''} order by giorno, da`, userIds ? [dal, al, userIds] : [dal, al]);
    return rows.map(turnoShape);
  }
  const durata = t => Math.max(0, min(t.a) - min(t.da) - (t.pausa || 0));

  /* ---------- richieste: quante unità ---------- */
  async function contaGiorni(userId, dal, al) {
    const ts = await turniDi(dal, al, [userId]);
    const conTurno = new Set(ts.map(t => t.giorno));
    if (conTurno.size) return conTurno.size;
    let n = 0; for (let g = dal; g <= al; g = addG(g, 1)) if (dow(g) >= 1 && dow(g) <= 5) n++;
    return n;
  }
  // le colonne delle richieste senza il file del certificato (si legge solo quando serve)
  const RCOLS = `id, user_id, tipo, dal, al, ora_da, ora_a, quanti, sost_id, sost_ok, stato, nota, prot, creata, decisa_il, decisa_da, nota_admin, doc_stato, scadenza, doc_il, doc_nome, doc_approvato`;
  const TIPI = { ferie: 'Ferie', permesso: 'ROL', malattia: 'Malattia', altro: 'Altra assenza', smart: 'Smart working', lutto: 'Lutto',
    parentale: 'Congedo parentale', maternita: 'Maternità', pnr: 'Permesso non retribuito' };
  // congedo parentale: preavviso minimo e al massimo metà delle ore giornaliere del contratto
  // preavviso: 5 giorni per il congedo a giornate, 2 giorni per quello a ore (art. 32, c. 3, D.Lgs. 151/2001)
  const PREAVVISO_PARENTALE = 5, PREAVVISO_PARENTALE_ORE = 2;
  const LEGGE_PREAVVISO = 'art. 32, comma 3, D.Lgs. 26 marzo 2001 n. 151 (Testo unico maternità e paternità)';
  const richShape = (r, nomi) => ({ id: r.id, user: r.user_id, nome: nomi?.get(r.user_id) || '', tipo: r.tipo, tipoTxt: TIPI[r.tipo], dal: r.dal, al: r.al, oraDa: r.ora_da, oraA: r.ora_a,
    quanti: r.quanti != null ? Number(r.quanti) : null, sost: r.sost_id, sostNome: nomi?.get(r.sost_id) || '', sostOk: r.sost_ok, stato: r.stato, nota: r.nota, prot: r.prot,
    creata: r.creata, decisaIl: r.decisa_il, notaAdmin: r.nota_admin, docStato: r.doc_stato || '', scadenza: r.scadenza || null, haDoc: !!r.doc_il, docNome: r.doc_nome || '', docApprovato: r.doc_approvato || null });
  const descRich = r => {
    const ore = r.ora_da && r.ora_a ? `, ${r.ora_da}–${r.ora_a}` : '';
    if (r.tipo === 'permesso') return `${TIPI[r.tipo]} ${fmtG(r.dal)}${ore}`;
    const t = TIPI[r.tipo] + (r.tipo === 'maternita' ? (r.dal === r.al ? '' : ' (fine presunta)') : '');
    return (r.dal === r.al ? `${TIPI[r.tipo]} ${fmtG(r.dal)}` : `${t} dal ${fmtG(r.dal)} al ${fmtG(r.al)}`) + (r.tipo === 'parentale' || r.tipo === 'pnr' ? ore : '');
  };

  // Approvazione: scala ferie/permessi e passa i turni al sostituto (se quel giorno è libero)
  async function applicaApprovazione(r, chi) {
    const p = await personaDi(r.user_id);
    if (p && isDip(p)) {
      if (r.tipo === 'ferie') await movimento(r.user_id, 'ferie', 'delta', -Number(r.quanti || 0), r.dal, descRich(r), 'rich:' + r.id, chi);
      if (r.tipo === 'permesso') await movimento(r.user_id, 'permessi', 'delta', -Number(r.quanti || 0), r.dal, descRich(r), 'rich:' + r.id, chi);
    }
    if (r.sost_id && ['ferie', 'malattia', 'altro', 'lutto'].includes(r.tipo)) {
      const ts = await turniDi(r.dal, r.al, [r.user_id, r.sost_id]);
      const nome = p?.nome || '';
      for (const t of ts.filter(t => t.user === r.user_id)) {
        if (ts.some(x => x.user === r.sost_id && x.giorno === t.giorno)) continue;
        await q(`update sp_turni set user_id = $2, nota = $3, aggiornato = now() where id = $1`, [t.id, r.sost_id, `Sostituisce ${nome}`.slice(0, 120)]);
      }
    }
  }

  /* ---------- giorni lavorativi: i giorni con turno; se non ci sono turni, da lunedì a venerdì ---------- */
  async function giorniLav(uid, dal, al) {
    const ts = await turniDi(dal, al, [uid]);
    const conTurno = [...new Set(ts.map(t => t.giorno))].sort();
    if (conTurno.length) return conTurno;
    const out = []; for (let g = dal; g <= al; g = addG(g, 1)) if (dow(g) >= 1 && dow(g) <= 5) out.push(g);
    return out;
  }
  // lutto: 3 giorni lavorativi dal giorno scelto
  async function fineLutto(uid, dal) {
    const ts = await turniDi(dal, addG(dal, 40), [uid]);
    const conTurno = [...new Set(ts.map(t => t.giorno))].sort();
    if (conTurno.length >= 3) return conTurno[2];
    let n = 0, g = dal; for (;; g = addG(g, 1)) if (dow(g) >= 1 && dow(g) <= 5 && ++n === 3) return g;
  }
  const fineMese = g => { const [y, m] = g.split('-').map(Number); return new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10); };

  /* ---------- lutto senza certificato / malattia senza protocollo entro la scadenza: ferie, altrimenti assenza ingiustificata ---------- */
  async function elaboraScadenze() {
    try {
      await migrate();
      if (!(await attiva())) return;
      const { rows } = await q(`update sp_richieste set doc_stato = 'scaduta' where stato = 'approvata' and doc_stato = 'attesa' and scadenza < $1 returning *`, [oggi()]);
      for (const r of rows) {
        const p = await personaDi(r.user_id);
        const cosa = r.tipo === 'lutto' ? 'certificato di morte non caricato' : 'protocollo non inserito';
        const motivo = `${TIPI[r.tipo]} senza ${r.tipo === 'lutto' ? 'certificato' : 'protocollo'}`;
        if (!p || !isDip(p)) { avvisaAdmin({ title: `${TIPI[r.tipo]}: ${cosa}`, body: `${p?.nome || ''}: ${descRich(r).toLowerCase()}.`, url: '/?sez=richieste' }); continue; }
        let ferie = 0, ingiust = 0;
        for (const g of await giorniLav(r.user_id, r.dal, r.al)) {
          const s = (await saldi([r.user_id]))[r.user_id];
          let esito = 'ingiustificata', valore = null, mov = null;
          if (s.ferie >= 1) { esito = 'ferie'; valore = 1; mov = await movimento(r.user_id, 'ferie', 'delta', -1, g, `${motivo} ${fmtG(g)} (automatico)`, 'scad:' + r.id + ':' + g, 'automatico'); }
          const ins = await q(`insert into sp_mancate (user_id, giorno, esito, valore, mov_id, motivo) values ($1,$2,$3,$4,$5,$6) on conflict do nothing`, [r.user_id, g, esito, valore, mov, motivo]);
          if (!ins.rowCount) { if (mov) await q('update sp_movimenti set annullato = true where id = $1', [mov]); continue; }
          if (esito === 'ferie') ferie++; else ingiust++;
        }
        const esitoTxt = [ferie ? `${ferie} ${ferie === 1 ? 'giorno' : 'giorni'} di ferie scalat${ferie === 1 ? 'o' : 'i'}` : '', ingiust ? `${ingiust} ${ingiust === 1 ? 'giorno' : 'giorni'} di assenza ingiustificata` : ''].filter(Boolean).join(' e ') || 'nessun giorno da scalare';
        avvisa([r.user_id], { title: `${TIPI[r.tipo]}: ${cosa}`, body: `${descRich(r)}: ${esitoTxt}. Se è un errore, parla con l'amministrazione.`, url: '/?sez=assenze' });
        avvisaAdmin({ title: `${TIPI[r.tipo]}: ${cosa}`, body: `${p.nome}, ${descRich(r).toLowerCase()}: ${esitoTxt}.`, url: '/?sez=richieste' });
      }
    } catch (e) { console.warn('Scheda personale, scadenze lutto/malattia:', e.message); }
  }
  setTimeout(elaboraScadenze, 25000).unref();
  setInterval(elaboraScadenze, 30 * 60 * 1000).unref();

  /* ---------- mancate timbrature: prima ferie, poi permessi, poi assenza ingiustificata ---------- */
  let elaborando = false;
  async function elaboraMancate() {
    if (elaborando) return; elaborando = true;
    try {
      await migrate();
      if (!(await attiva())) return;
      const avvio = await sch.imp('avvio'); if (!avvio) return;
      const ieri = addG(oggi(), -1);
      let dal = addG(oggi(), -21); if (dal < avvio) dal = avvio;
      if (dal > ieri) return;
      const pp = (await persone()).filter(isDip), ids = pp.map(p => p.id);
      if (!ids.length) return;
      const [ts, { rows: tim }, { rows: ric }, { rows: fatte }] = await Promise.all([
        turniDi(dal, ieri, ids),
        q(`select distinct user_id, giorno from sp_timbrature where not annullata and giorno between $1 and $2`, [dal, ieri]),
        q(`select user_id, tipo, dal, al from sp_richieste where stato = 'approvata' and al >= $1 and dal <= $2`, [dal, ieri]),
        q(`select user_id, giorno from sp_mancate where giorno between $1 and $2`, [dal, ieri]),
      ]);
      const timS = new Set(tim.map(t => t.user_id + '|' + t.giorno)), fatteS = new Set(fatte.map(t => t.user_id + '|' + t.giorno));
      const perGiorno = new Map();
      for (const t of ts) { const k = t.user + '|' + t.giorno; perGiorno.set(k, (perGiorno.get(k) || 0) + durata(t)); }
      for (const [k, minuti] of perGiorno) {
        if (timS.has(k) || fatteS.has(k)) continue;
        const [uid, g] = k.split('|');
        if (ric.some(r => r.user_id === uid && r.dal <= g && r.al >= g && r.tipo !== 'smart' && r.tipo !== 'parentale' && !(r.tipo === 'pnr' && r.ora_da))) continue;
        const s = (await saldi([uid]))[uid], ore = r2(minuti / 60);
        let esito = 'ingiustificata', valore = null, mov = null;
        if (s.ferie >= 1) { esito = 'ferie'; valore = 1; mov = await movimento(uid, 'ferie', 'delta', -1, g, `Mancata timbratura ${fmtG(g)} (automatico)`, 'manc:' + g, 'automatico'); }
        else if (ore > 0 && s.permessi >= ore) { esito = 'permessi'; valore = ore; mov = await movimento(uid, 'permessi', 'delta', -ore, g, `Mancata timbratura ${fmtG(g)} (automatico)`, 'manc:' + g, 'automatico'); }
        const ins = await q(`insert into sp_mancate (user_id, giorno, esito, valore, mov_id) values ($1,$2,$3,$4,$5) on conflict do nothing`, [uid, g, esito, valore, mov]);
        if (!ins.rowCount && mov) await q('update sp_movimenti set annullato = true where id = $1', [mov]);
        else avvisa([uid], { title: 'Mancata timbratura', body: `${fmtG(g)}: ${esito === 'ferie' ? 'scalato 1 giorno di ferie' : esito === 'permessi' ? `scalate ${ore} ore di ROL` : 'segnata come assenza ingiustificata'}. Se hai lavorato, avvisa l'amministrazione.` });
      }
    } catch (e) { console.warn('Scheda personale, mancate timbrature:', e.message); }
    finally { elaborando = false; }
  }
  setTimeout(elaboraMancate, 20000).unref();
  setInterval(elaboraMancate, 60 * 60 * 1000).unref();

  /* ================= utente ================= */
  app.get('/api/sp/me', needSp, wrap(async (req, res) => {
    const p = await io(req);
    const g = oggi();
    const [{ rows: tim }, s, { rows: mie }, { rows: sost }, { rows: mov }, { rows: docs }, perfS] = await Promise.all([
      q(`select * from sp_timbrature where user_id = $1 and giorno = $2 and not annullata order by il`, [p.id, g]),
      saldi([p.id]),
      q(`select ${RCOLS} from sp_richieste where user_id = $1 and stato <> 'annullata' order by dal desc limit 40`, [p.id]),
      q(`select ${RCOLS} from sp_richieste where sost_id = $1 and stato in ('attesa_sost','attesa_admin') and al >= $2 order by dal`, [p.id, g]),
      q(`select voce, tipo, valore, data, causale from sp_movimenti where user_id = $1 and not annullato order by data desc, il desc limit 30`, [p.id]),
      q(`select id, tipo, periodo, titolo, pubblicato, visto, ricevuto, firmato from sp_docs where user_id = $1 and stato = 'pubblicato' order by periodo desc, pubblicato desc`, [p.id]),
      perfUtente(p.id),
    ]);
    const tutti = await persone(), nomi = new Map(tutti.map(x => [x.id, x.nome]));
    const ss = await sch.sedi(), sedeNome = new Map(ss.map(x => [x.id, x.nome]));
    // colleghi per il sostituto: stessa figura e sede in comune per primi
    const colleghi = tutti.filter(x => x.id !== p.id && !x.owner).map(x => ({ id: x.id, nome: x.nome, figura: x.figura,
      vicino: (x.figura === p.figura ? 2 : 0) + (x.sedi.some(s2 => p.sedi.includes(s2)) ? 1 : 0) })).sort((a, b) => b.vicino - a.vicino || a.nome.localeCompare(b.nome));
    const { rows: tags } = await q('select cod, sede_id from sp_tag where sede_id is not null');
    const smartOggi = !p.medico && await smartIl(p.id, g);
    // i miei documenti: certificati caricati dalla persona e approvati dall'amministrazione (solo da leggere)
    const { rows: miei } = await q(`select id, tipo, dal, al, doc_nome, doc_il, doc_approvato from sp_richieste where user_id = $1 and doc_approvato is not null and stato <> 'annullata' order by doc_il desc`, [p.id]);
    res.json({
      oggi: g, ora: roma().hm,
      me: { id: p.id, nome: p.nome, figura: p.figura, medico: p.medico, admin: req.user.role === 'admin', tipo: p.tipo, tipoOk: p.tipoOk, ore: p.ore, senzaNfc: p.senzaNfc, smartOggi, onb: p.onb,
        sedi: p.sedi.map(id => ({ id, nome: sedeNome.get(id) || '' })) },
      timbrature: tim.map(t => ({ id: t.id, tipo: t.tipo, ora: t.ora, sede: t.modo === 'smart' ? 'Smart working' : sedeNome.get(t.sede_id) || '', modo: t.modo })),
      saldi: isDip(p) ? s[p.id] : null,
      richieste: mie.map(r => ({ ...richShape(r, nomi), desc: descRich(r) })),
      sostituzioni: sost.map(r => ({ ...richShape(r, nomi), desc: descRich(r) })),
      movimenti: mov.map(m => ({ voce: m.voce, tipo: m.tipo, valore: Number(m.valore), data: m.data, causale: m.causale })),
      colleghi, docs, perf: perfS,
      miei: miei.map(r => ({ id: r.id, titolo: (r.tipo === 'lutto' ? 'Certificato di morte' : r.tipo === 'maternita' ? 'Certificato di maternità' : 'Certificato') + ' · ' + descRich(r), nome: r.doc_nome, caricato: r.doc_il, approvato: r.doc_approvato })), sedi: ss.map(x => ({ id: x.id, nome: x.nome })), tagSedi: tags.length,
    });
  }));

  // primo accesso: dipendente o partita IVA, ore del contratto
  app.post('/api/sp/onb', needSp, wrap(async (req, res) => {
    const tipo = req.body.tipo === 'piva' ? 'piva' : req.body.tipo === 'dip' ? 'dip' : null;
    if (!tipo) return bad(res, 400, 'Scegli dipendente o partita IVA.');
    const ore = num(req.body.ore);
    if (tipo === 'dip' && !(ore > 0 && ore <= 60)) return bad(res, 400, 'Scrivi le ore settimanali del contratto (per esempio 32).');
    await q(`insert into sp_persone (user_id, tipo, ore_sett, onb, tipo_ok) values ($1,$2,$3,now(),false)
      on conflict (user_id) do update set tipo = case when sp_persone.tipo_ok then sp_persone.tipo else excluded.tipo end,
        ore_sett = case when sp_persone.tipo_ok then sp_persone.ore_sett else excluded.ore_sett end, onb = coalesce(sp_persone.onb, now()), aggiornato = now()`,
      [req.user.sso_id, tipo, tipo === 'dip' ? ore : null]);
    await store.q(`update users set contratto_tipo = $2, contratto_ore = $3, contratto_ok = false, contratto_il = now() where id = $1 and not contratto_ok`,
      [req.user.sso_id, tipo, tipo === 'dip' ? ore : null]);
    const { rows } = await q('select tipo_ok from sp_persone where user_id = $1', [req.user.sso_id]);
    if (rows[0]?.tipo_ok) return res.json({ ok: true, bloccato: true });
    const p = await io(req);
    avvisaAdmin({ title: 'Contratto da confermare', body: `${p.nome}: ${tipo === 'dip' ? `dipendente, ${ore} h/settimana` : 'partita IVA'}.`, url: '/?sez=persone' });
    res.json({ ok: true });
  }));

  /* ---------- timbratura ---------- */
  // Il tag NFC apre turni.appgestione.it/nfc/<codice>?e=…&c=… (dati firmati dal tag a ogni lettura)
  // codice del tag: "1", "01", " 01 " sono lo stesso tag (numeri a due cifre)
  const codTag = c => { const x = String(c || '').trim().replace(/[^0-9A-Za-z]/g, '').slice(0, 10).toUpperCase(); return /^\d{1,2}$/.test(x) ? x.padStart(2, '0') : x; };
  async function leggiTag(cod, e, c) {
    const k = codTag(cod);
    const { rows } = await q('select * from sp_tag where cod = $1', [k]);
    const t = rows[0];
    if (!t || !t.sede_id) throw Object.assign(new Error(`Il tag ${k || '?'} non è collegato a nessuna sede. Avvisa l'amministrazione.`), { status: 400 });
    if (e || c) {
      const v = sun.verifica(String(e || ''), String(c || ''));
      if (!v) throw Object.assign(new Error('Tag non valido. Riappoggia il telefono al tag.'), { status: 400 });
      if (t.uid && t.uid !== v.uid) throw Object.assign(new Error('Questo tag non è quello registrato per la sede.'), { status: 400 });
      if (v.ctr <= t.ctr) throw Object.assign(new Error('Lettura già usata: riappoggia il telefono al tag.'), { status: 400 });
      return { t, v };
    }
    if (t.protetto) throw Object.assign(new Error('Lettura non valida: appoggia il telefono al tag (non usare link salvati).'), { status: 400 });
    return { t, v: null };
  }
  // smart working approvato dall'amministrazione per quel giorno
  async function smartIl(uid, g) {
    const { rows } = await q(`select 1 from sp_richieste where user_id = $1 and tipo = 'smart' and stato = 'approvata' and dal <= $2 and al >= $2 limit 1`, [uid, g]);
    return !!rows[0];
  }
  async function prossimoTipo(uid, g) {
    const { rows } = await q(`select tipo from sp_timbrature where user_id = $1 and giorno = $2 and not annullata order by il desc limit 1`, [uid, g]);
    return rows[0]?.tipo === 'in' ? 'out' : 'in';
  }
  app.get('/api/sp/timbra/anteprima', needSp, wrap(async (req, res) => {
    const p = await io(req);
    if (p.medico) return bad(res, 400, 'I medici non timbrano.');
    const { t } = await leggiTag(req.query.cod, req.query.e, req.query.c);
    const ss = await sch.sedi(), n = roma();
    res.json({ sede: ss.find(s => s.id === t.sede_id)?.nome || '', tipo: await prossimoTipo(p.id, n.giorno), ora: n.hm, protetto: !!(req.query.e && req.query.c) });
  }));
  app.post('/api/sp/timbra', needSp, wrap(async (req, res) => {
    const p = await io(req);
    if (p.medico) return bad(res, 400, 'I medici non timbrano.');
    const n = roma(), b = req.body;
    let sede = null, tagCod = null, modo = 'nfc', pos = null;
    if (b.smart) {
      if (!(await smartIl(p.id, n.giorno))) return bad(res, 403, 'Oggi non hai uno smart working approvato: si timbra con il tag NFC.');
      const lat = Number(b.lat), lon = Number(b.lon);
      if (!isFinite(lat) || !isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180 || (!lat && !lon)) return bad(res, 400, 'Per timbrare in smart working serve la posizione del telefono.');
      modo = 'smart';
      pos = [Math.round(lat * 1000) / 1000, Math.round(lon * 1000) / 1000, Math.min(99999, Math.max(0, Math.round(Number(b.prec) || 0)))];
    } else if (b.senzaNfc) {
      if (!p.senzaNfc) return bad(res, 403, 'Si timbra solo con il tag NFC. Se il telefono non ha l\'NFC chiedi l\'autorizzazione all\'amministrazione.');
      modo = 'app';
      sede = p.sedi.includes(b.sede) ? b.sede : p.sedi[0] || null;
    } else {
      const { t, v } = await leggiTag(b.cod, b.e, b.c);
      sede = t.sede_id; tagCod = t.cod;
      if (v) {
        const up = await q(`update sp_tag set ctr = $2, uid = coalesce(uid, $3), protetto = true, ultima = now() where cod = $1 and ctr < $2`, [t.cod, v.ctr, v.uid]);
        if (!up.rowCount) return bad(res, 400, 'Lettura già usata: riappoggia il telefono al tag.');
      } else await q('update sp_tag set ultima = now() where cod = $1', [t.cod]);
    }
    const tipo = b.tipo === 'in' || b.tipo === 'out' ? b.tipo : await prossimoTipo(p.id, n.giorno);
    const id = db.newId();
    await q(`insert into sp_timbrature (id, user_id, giorno, ora, tipo, sede_id, modo, tag, lat, lon, prec) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
      [id, p.id, n.giorno, n.hm, tipo, sede, modo, tagCod, pos ? pos[0] : null, pos ? pos[1] : null, pos ? pos[2] : null]);
    const ss = await sch.sedi();
    res.json({ ok: true, tipo, ora: n.hm, sede: modo === 'smart' ? 'Smart working' : ss.find(s => s.id === sede)?.nome || '' });
  }));

  /* ---------- turni (utente: i suoi) ---------- */
  app.get('/api/sp/turni', needSp, wrap(async (req, res) => {
    const m = isM(req.query.mese) ? req.query.mese : oggi().slice(0, 7);
    const admin = req.user.role === 'admin' && req.query.tutti;
    const g = giorniMese(m);
    const ts = await turniDi(g[0], g[g.length - 1], admin ? null : [req.user.sso_id]);
    const out = { mese: m, turni: ts };
    const { rows: ric } = await q(`select user_id, tipo, dal, al, ora_da, ora_a from sp_richieste where stato = 'approvata' and al >= $1 and dal <= $2 ${admin ? '' : 'and user_id = $3'}`,
      admin ? [g[0], g[g.length - 1]] : [g[0], g[g.length - 1], req.user.sso_id]);
    out.assenze = ric.map(r => ({ user: r.user_id, tipo: r.tipo, dal: r.dal, al: r.al, oraDa: r.ora_da, oraA: r.ora_a }));
    if (admin) {
      out.preset = (await q('select * from sp_preset order by ordine, nome')).rows;
      out.persone = (await persone()).map(p => ({ id: p.id, nome: p.nome, figura: p.figura, sedi: p.sedi, ore: p.ore, tipo: p.tipo, medico: p.medico }));
    }
    res.json(out);
  }));

  /* ---------- richieste di assenza ---------- */
  app.post('/api/sp/richieste', needSp, wrap(async (req, res) => {
    const admin = req.user.role === 'admin';
    const b = req.body;
    const per = admin && b.user ? await personaDi(b.user) : await io(req);
    if (!per) return bad(res, 400, 'Persona non trovata.');
    const tipo = TIPI[b.tipo] ? b.tipo : null;
    if (!tipo) return bad(res, 400, 'Scegli il tipo di assenza.');
    if (tipo === 'smart' && per.medico) return bad(res, 400, 'Lo smart working è per chi timbra.');
    const dal = str(b.dal, 10); let al = tipo === 'permesso' || tipo === 'lutto' ? dal : str(b.al || b.dal, 10);
    if (!isG(dal) || !isG(al) || al < dal) return bad(res, 400, 'Controlla le date.');
    let quanti = null, oraDa = null, oraA = null;
    const fuoriAdmin = !(admin && b.user);
    if (tipo === 'permesso') {
      oraDa = str(b.oraDa, 5); oraA = str(b.oraA, 5);
      if (!isHM(oraDa) || !isHM(oraA) || min(oraA) <= min(oraDa)) return bad(res, 400, 'Indica l\'ora di inizio e di fine del permesso.');
      quanti = r2((min(oraA) - min(oraDa)) / 60);
    } else if (tipo === 'ferie') quanti = await contaGiorni(per.id, dal, al);
    else if (tipo === 'parentale') {
      // a ore: ogni giorno dalle–alle, al massimo metà delle ore giornaliere del contratto; preavviso minimo
      oraDa = str(b.oraDa, 5); oraA = str(b.oraA, 5);
      if (!isHM(oraDa) || !isHM(oraA) || min(oraA) <= min(oraDa)) return bad(res, 400, 'Indica dalle che ora a che ora, ogni giorno.');
      quanti = r2((min(oraA) - min(oraDa)) / 60);
      const maxOre = oreGiorno(per) / 2;
      if (!maxOre) return bad(res, 400, 'Nel tuo contratto non ci sono ancora le ore settimanali: chiedi all\'amministrazione.');
      if (quanti > maxOre + 0.001) return bad(res, 400, `Il congedo parentale si può chiedere al massimo per metà delle tue ore giornaliere: ${String(r2(maxOre)).replace('.', ',')} ore al giorno.`);
      // qui il congedo è sempre a ore: preavviso di legge 2 giorni
      if (fuoriAdmin && dal < addG(oggi(), PREAVVISO_PARENTALE_ORE)) return bad(res, 400, `Preavviso non rispettato: il congedo parentale a ore va chiesto almeno ${PREAVVISO_PARENTALE_ORE} giorni prima dell'inizio (${LEGGE_PREAVVISO}). Il primo giorno possibile è il ${fmtG(addG(oggi(), PREAVVISO_PARENTALE_ORE))}.`);
    } else if (tipo === 'pnr') {
      // giorni interi, oppure a ore in un giorno solo
      if (b.oraDa || b.oraA) {
        oraDa = str(b.oraDa, 5); oraA = str(b.oraA, 5);
        if (!isHM(oraDa) || !isHM(oraA) || min(oraA) <= min(oraDa)) return bad(res, 400, 'Indica l\'ora di inizio e di fine del permesso.');
        if (al !== dal) return bad(res, 400, 'Il permesso a ore è per un giorno solo.');
        quanti = r2((min(oraA) - min(oraDa)) / 60);
      } else quanti = await contaGiorni(per.id, dal, al);
    } else if (tipo === 'maternita') {
      if (fuoriAdmin && !b.conCertificato) return bad(res, 400, 'Carica il certificato di maternità.');
      quanti = Math.round((Date.parse(al) - Date.parse(dal)) / 86400000) + 1;
    }
    if (tipo === 'lutto') { al = await fineLutto(per.id, dal); quanti = 3; }
    if (fuoriAdmin && !['malattia', 'maternita'].includes(tipo) && dal < oggi()) return bad(res, 400, 'Le richieste si fanno per oggi o per i giorni futuri.');
    const sost = str(b.sost, 64) || null;
    if (sost === per.id) return bad(res, 400, 'Il sostituto deve essere un\'altra persona.');
    if (fuoriAdmin && ['ferie', 'permesso'].includes(tipo) && !sost && !per.medico && per.tipo !== 'piva') return bad(res, 400, 'Indica chi ti sostituisce.');
    const { rows: sov } = await q(`select 1 from sp_richieste where user_id = $1 and stato in ('attesa_sost','attesa_admin','approvata') and dal <= $3 and al >= $2
      and not (ora_da is not null and $4::text is not null)`, [per.id, dal, al, oraDa]);
    if (sov.length) return bad(res, 400, 'Hai già una richiesta per quei giorni.');
    const stato = admin && b.user ? 'approvata' : ['malattia', 'lutto', 'maternita'].includes(tipo) ? 'approvata' : sost ? 'attesa_sost' : 'attesa_admin';
    const id = db.newId();
    const { rows } = await q(`insert into sp_richieste (id, user_id, tipo, dal, al, ora_da, ora_a, quanti, sost_id, sost_ok, stato, nota, prot, decisa_il, decisa_da)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
      [id, per.id, tipo, dal, al, oraDa, oraA, quanti, sost, admin && b.user && sost ? true : null, stato, str(b.nota, 500), str(b.prot, 40),
        stato === 'approvata' ? new Date() : null, stato === 'approvata' ? (admin && b.user ? req.user.email : 'automatico') : null]);
    let r = rows[0];
    // lutto: certificato di morte entro la fine del mese; malattia: protocollo entro le 23:59 del giorno della richiesta
    if (fuoriAdmin && (tipo === 'lutto' || (tipo === 'malattia' && !r.prot))) {
      r = (await q(`update sp_richieste set doc_stato = 'attesa', scadenza = $2 where id = $1 returning *`, [r.id, tipo === 'lutto' ? fineMese(r.al) : oggi()])).rows[0];
    }
    // maternità: il certificato si carica subito dopo (senza scadenza: niente ferie scalate)
    if (fuoriAdmin && tipo === 'maternita') r = (await q(`update sp_richieste set doc_stato = 'attesa', scadenza = null where id = $1 returning *`, [r.id])).rows[0];
    if (tipo === 'maternita' && fuoriAdmin) avvisaAdmin({ title: 'Maternità comunicata', body: `${per.nome}: ${descRich(r).toLowerCase()}. Il certificato è in Certificati da controllare.`, url: '/?sez=richieste' });
    if (stato === 'approvata') await applicaApprovazione(r, req.user.email);
    if (tipo === 'malattia' && fuoriAdmin) avvisaAdmin({ title: 'Malattia comunicata', body: `${per.nome}: ${descRich(r).toLowerCase()}${r.prot ? '' : ' (protocollo da inserire entro oggi)'}.`, url: '/?sez=richieste' });
    if (['lutto', 'malattia'].includes(tipo) && fuoriAdmin && sost) avvisa([sost], { title: 'Sostituisci un collega', body: `${per.nome}: ${descRich(r).toLowerCase()}. I suoi turni di quei giorni passano a te, se sei libero.`, url: '/?sez=turni' });
    if (tipo === 'lutto' && fuoriAdmin) avvisaAdmin({ title: 'Lutto comunicato (per conoscenza)', body: `${per.nome}: ${descRich(r).toLowerCase()}. Certificato da caricare entro il ${fmtG(r.scadenza)}.`, url: '/?sez=richieste' });
    if (stato === 'attesa_sost') avvisa([sost], { title: 'Ti chiedono una sostituzione', body: `${per.nome}: ${descRich(r).toLowerCase()}. Accetta o rifiuta nella sezione Assenze.`, url: '/?sez=assenze' });
    if (stato === 'attesa_admin') avvisaAdmin({ title: 'Richiesta da approvare', body: `${per.nome}: ${descRich(r).toLowerCase()}.`, url: '/?sez=richieste' });
    if (admin && b.user) avvisa([per.id], { title: 'Assenza registrata', body: `${descRich(r)} registrata dall'amministrazione.`, url: '/?sez=assenze' });
    let avviso = '';
    if (per.tipo === 'dip' && ['ferie', 'permesso'].includes(tipo)) {
      const s = (await saldi([per.id]))[per.id];
      if (tipo === 'ferie' && s.ferie < quanti) avviso = `Attenzione: hai ${s.ferie} giorni di ferie e ne chiedi ${quanti}.`;
      if (tipo === 'permesso' && s.permessi < quanti) avviso = `Attenzione: hai ${s.permessi} ore di ROL e ne chiedi ${quanti}.`;
    }
    res.json({ ok: true, id: r.id, stato, avviso, scadenza: r.doc_stato === 'attesa' && r.scadenza ? r.scadenza : null });
  }));
  // maternità: la data di fine è presunta, la persona o l'amministrazione la aggiornano
  app.put('/api/sp/richieste/:id/fine', needSp, wrap(async (req, res) => {
    const al = str(req.body.al, 10);
    const { rows: [r] } = await q(`select ${RCOLS} from sp_richieste where id = $1 and tipo = 'maternita' and stato = 'approvata'`, [req.params.id]);
    if (!r || (req.user.role !== 'admin' && r.user_id !== req.user.sso_id)) return bad(res, 404, 'Richiesta non trovata.');
    if (!isG(al) || al < r.dal) return bad(res, 400, 'La fine non può essere prima dell\'inizio.');
    const n = Math.round((Date.parse(al) - Date.parse(r.dal)) / 86400000) + 1;
    await q('update sp_richieste set al = $2, quanti = $3 where id = $1', [r.id, al, n]);
    if (req.user.role !== 'admin') { const p = await personaDi(r.user_id); avvisaAdmin({ title: 'Maternità: nuova data di fine', body: `${p?.nome || ''}: fine il ${fmtG(al)}.`, url: '/?sez=richieste' }); }
    res.json({ ok: true });
  }));
  // completare: certificato di morte (lutto) o numero di protocollo (malattia), entro la scadenza
  async function richiestaDaCompletare(req, tipo) {
    const { rows: [r] } = await q(`select ${RCOLS} from sp_richieste where id = $1 and user_id = $2 and tipo = any($3)`, [req.params.id, req.user.sso_id, [].concat(tipo)]);
    if (!r) throw Object.assign(new Error('Richiesta non trovata.'), { status: 404 });
    if (r.doc_stato === 'scaduta') throw Object.assign(new Error('Il tempo è scaduto: parla con l\'amministrazione.'), { status: 400 });
    if (r.doc_stato !== 'attesa') throw Object.assign(new Error('Questa richiesta è già completa.'), { status: 400 });
    if (r.scadenza && oggi() > r.scadenza) throw Object.assign(new Error('Il tempo è scaduto: parla con l\'amministrazione.'), { status: 400 });
    return r;
  }
  app.post('/api/sp/richieste/:id/certificato', needSp, upload.single('file'), wrap(async (req, res) => {
    const r = await richiestaDaCompletare(req, ['lutto', 'maternita']), f = req.file;
    if (!f || !f.size) return bad(res, 400, 'Scegli il file del certificato (foto o PDF).');
    if (f.size > 15 * 1024 * 1024) return bad(res, 400, 'Il file è troppo grande (massimo 15 MB).');
    if (!/^(image\/|application\/pdf)/.test(f.mimetype || '')) return bad(res, 400, 'Carica una foto o un PDF.');
    const nome = String(f.originalname || 'certificato').replace(/[^\w.\- àèéìòù()]/gi, '').slice(0, 120) || 'certificato';
    const c = cifraOk() ? cifra(f.buffer) : { file: f.buffer, iv: null, tag: null };
    await q(`update sp_richieste set doc_stato = 'ok', doc_il = now(), doc_nome = $2, doc_tipo = $3, doc_dati = $4, doc_iv = $5, doc_tag = $6 where id = $1 and doc_stato = 'attesa'`,
      [r.id, nome, f.mimetype, c.file, c.iv, c.tag]);
    const me = await io(req);
    avvisaAdmin({ title: 'Lutto: certificato caricato', body: `${me.nome}: ${descRich(r).toLowerCase()}.`, url: '/?sez=richieste' });
    res.json({ ok: true });
  }));
  app.post('/api/sp/richieste/:id/protocollo', needSp, wrap(async (req, res) => {
    const r = await richiestaDaCompletare(req, 'malattia'), prot = str(req.body.prot, 40);
    if (!prot) return bad(res, 400, 'Scrivi il numero di protocollo del certificato medico.');
    await q(`update sp_richieste set doc_stato = 'ok', prot = $2 where id = $1 and doc_stato = 'attesa'`, [r.id, prot]);
    res.json({ ok: true });
  }));
  // il certificato lo vedono la persona e l'amministrazione
  app.get('/api/sp/richieste/:id/certificato', needSp, wrap(async (req, res) => {
    const { rows: [d] } = await q('select user_id, doc_nome, doc_tipo, doc_dati, doc_iv, doc_tag from sp_richieste where id = $1', [req.params.id]);
    if (!d || !d.doc_dati || (req.user.role !== 'admin' && d.user_id !== req.user.sso_id)) return bad(res, 404, 'File non disponibile');
    const buf = d.doc_iv ? decifra({ file: d.doc_dati, iv: d.doc_iv, tag: d.doc_tag }) : d.doc_dati;
    res.set({ 'Content-Type': d.doc_tipo || 'application/octet-stream', 'Content-Disposition': `inline; filename="${encodeURIComponent(d.doc_nome || 'certificato')}"`, 'Cache-Control': 'private, no-store' });
    res.send(buf);
  }));
  app.post('/api/sp/richieste/:id/sostituto', needSp, wrap(async (req, res) => {
    const ok = !!req.body.ok;
    const { rows } = await q(`update sp_richieste set sost_ok = $3, stato = $4 where id = $1 and sost_id = $2 and stato = 'attesa_sost' returning *`,
      [req.params.id, req.user.sso_id, ok, ok ? 'attesa_admin' : 'rifiutata']);
    if (!rows[0]) return bad(res, 400, 'La richiesta non è più in attesa della tua risposta.');
    const r = rows[0], me = await io(req), chi = await personaDi(r.user_id);
    avvisa([r.user_id], { title: ok ? 'Sostituzione accettata' : 'Sostituzione rifiutata', body: ok ? `${me.nome} ti sostituisce: ora decide l'amministrazione.` : `${me.nome} non può sostituirti: fai una nuova richiesta con un altro collega.`, url: '/?sez=assenze' });
    if (ok) avvisaAdmin({ title: 'Richiesta da approvare', body: `${chi?.nome || ''}: ${descRich(r).toLowerCase()} (sostituto ${me.nome}).`, url: '/?sez=richieste' });
    res.json({ ok: true });
  }));
  app.post('/api/sp/richieste/:id/annulla', needSp, wrap(async (req, res) => {
    const { rowCount } = await q(`update sp_richieste set stato = 'annullata' where id = $1 and user_id = $2 and stato in ('attesa_sost','attesa_admin')`, [req.params.id, req.user.sso_id]);
    if (!rowCount) return bad(res, 400, 'La richiesta non si può più annullare.');
    res.json({ ok: true });
  }));

  /* ---------- performance (utente) ---------- */
  async function struttura() {
    const [{ rows: piani }, { rows: liv }, { rows: ob }] = await Promise.all([
      q('select * from sp_piani where not archiviato order by ordine, nome'),
      q('select * from sp_livelli where not archiviato order by n'),
      q('select * from sp_obiettivi where not archiviato order by ordine'),
    ]);
    return piani.map(p => ({ id: p.id, nome: p.nome, contratto: p.contratto || '', fonte: p.fonte || '', intestazioni: Array.isArray(p.intestazioni) ? p.intestazioni : [], note: p.note || '',
      livelli: liv.filter(l => l.piano_id === p.id).map(l => ({ id: l.id, n: l.n, ruolo: l.ruolo, bonus: l.bonus,
      fisso: l.fisso || '', fissoNum: l.fisso_num != null ? Number(l.fisso_num) : null, fissoCond: l.fisso_cond || '', variabile: l.variabile || '', area: l.area || '', skill: Array.isArray(l.skill) ? l.skill : [],
      incPerc: l.inc_perc != null ? Number(l.inc_perc) : null, incSoglia: l.inc_soglia || 'target', regole: Array.isArray(l.regole) ? l.regole : [],
      obiettivi: ob.filter(o => o.livello_id === l.id).map(o => ({ id: o.id, testo: o.testo, misura: o.misura, sotto: o.sotto || '', soft: o.soft || '', scuola: o.scuola || '',
        rFisso: o.r_fisso || '', rVariabile: o.r_variabile || '', test: !!o.test })) })) }));
  }
  /* ---------- incentivi: fatturato a consuntivo della sede da Gestione finanziaria ---------- */
  const FIN_URL = () => (process.env.FINANZA_URL || 'https://finanza.appgestione.it').replace(/\/$/, '');
  const finCache = new Map();
  async function finanza(path) {
    const key = process.env.SSO_API_KEY; if (!key) throw new Error('Collegamento con Gestione finanziaria non configurato (SSO_API_KEY).');
    const c = finCache.get(path); if (c && Date.now() - c.t < 5 * 60e3) return c.v;
    const r = await fetch(FIN_URL() + path, { headers: { Authorization: 'Bearer ' + key }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) throw new Error('Gestione finanziaria non risponde (' + r.status + ').');
    const v = await r.json(); finCache.set(path, { t: Date.now(), v }); if (finCache.size > 100) finCache.clear();
    return v;
  }
  const normSede = x => String(x || '').toLowerCase().replace(/to\s*smile|studio|sede|ambulatorio/g, '').replace(/[^a-z0-9]/g, '');
  // mese di riferimento: quello passato (il consuntivo del mese in corso è ancora parziale)
  const meseScorso = () => { const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' })); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); };
  async function consuntivo(mese) {
    const az = await sch.imp('sp_fin_azienda'); if (!az) return null;
    const [a, m] = mese.split('-').map(Number);
    return finanza(`/api/_appgestione/consuntivo?azienda=${encodeURIComponent(az)}&anno=${a}&mese=${m}`);
  }
  const eur = n => '€ ' + Number(n).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  // incentivo di un livello per una persona in un mese: % sul fatturato a consuntivo della sua sede (solo se a target, se così impostato)
  async function incentivo(livello, sediPersona, mese) {
    if (!livello || livello.incPerc == null) return { regola: livello?.variabile ? 'Variabile da calcolare a mano: ' + livello.variabile.split('\n')[0] : 'Nessun variabile per questo ruolo.', calcolabile: false };
    const regola = `${String(livello.incPerc).replace('.', ',')}% sul fatturato della sede${livello.incSoglia === 'target' ? ' a target' : ''}`;
    let c; try { c = await consuntivo(mese); } catch (e) { return { regola, calcolabile: false, errore: e.message }; }
    if (!c) return { regola, calcolabile: false, errore: 'Scegli l’azienda di Gestione finanziaria (Performance → Incentivi).' };
    const nomi = new Map((await sch.sedi()).map(x => [x.id, x.nome]));
    const nomeSede = nomi.get((sediPersona || [])[0]) || '';
    const s = c.sedi.find(x => normSede(x.nome) === normSede(nomeSede)) || c.sedi.find(x => normSede(nomeSede).length >= 3 && (normSede(x.nome).includes(normSede(nomeSede)) || normSede(nomeSede).includes(normSede(x.nome))));
    if (!nomeSede) return { regola, calcolabile: false, errore: 'La persona non ha una sede nell’anagrafica.' };
    if (!s) return { regola, sede: nomeSede, calcolabile: false, errore: `La sede ${nomeSede} non si trova in Gestione finanziaria.` };
    if (s.fatturato == null) return { regola, sede: nomeSede, calcolabile: false, errore: `Consuntivo di ${mese} non disponibile in Gestione finanziaria.` };
    const aTarget = !s.target || s.fatturato >= s.target, valore = livello.incSoglia === 'target' && !aTarget ? 0 : s.fatturato * livello.incPerc / 100;
    return { regola, sede: nomeSede, mese, calcolabile: true, fatturato: s.fatturato, target: s.target, pct: s.target ? Math.round(s.fatturato / s.target * 100) : null, aTarget,
      valore: Math.round(valore * 100) / 100, testo: { fatturato: eur(s.fatturato), target: s.target ? eur(s.target) : '—', valore: eur(valore) } };
  }

  // piani già caricati da Excel: la condizione del fisso si legge dalle note (una volta sola: poi vale quella salvata)
  setTimeout(async () => { try { await migrate();
    const { rows } = await q(`select l.id, l.ruolo, p.note from sp_livelli l join sp_piani p on p.id = l.piano_id where l.fisso_cond is null and p.note <> ''`);
    for (const r of rows) await q('update sp_livelli set fisso_cond = $2 where id = $1', [r.id, require('./lib/pianoExcel').condFissoDaNote(r.note, r.ruolo)]);
  } catch (e) { console.warn('Condizione del fisso:', e.message); } }, 5000);

  /* ---------- guadagni: fisso + bonus del mese e del trimestre, malus, fatturato personale (CRM) ---------- */
  // Regole del livello (dal piano Excel): { tipo: 'perc'|'manuale'|'nota', perc, base: 'ul'|'pers', periodo: 'mese'|'trim', cond: { ul, pers, conc, tmv } }
  // ul/pers in cond = moltiplicatore del target (1 = a target, 1.15 = overtarget +15%). Fatturato della sede: lordo, da Gestione finanziaria.
  // Target personale = % (35 di base, l'amministratore la cambia mese per mese) del target della sede.
  // Malus: azzera i bonus del mese; la stessa cifra si toglie dal bonus del trimestre.
  const TARGET_PERS = 35;
  const meseOra = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Europe/Rome' })).toISOString().slice(0, 7);
  const meseAdd = (m, d) => { const [a, b] = m.split('-').map(Number), x = new Date(Date.UTC(a, b - 1 + d, 15)); return x.toISOString().slice(0, 7); };
  const meseNome = m => new Date(m + '-15').toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
  const r2 = n => Math.round((Number(n) || 0) * 100) / 100;
  const mesiTrim = m => { const [a, b] = m.split('-').map(Number), q0 = Math.floor((b - 1) / 3) * 3; return [1, 2, 3].map(i => `${a}-${String(q0 + i).padStart(2, '0')}`); };
  // sede della persona in Gestione finanziaria (per nome)
  const trovaSede = (c, nome) => c.sedi.find(x => normSede(x.nome) === normSede(nome)) || c.sedi.find(x => normSede(nome).length >= 3 && (normSede(x.nome).includes(normSede(nome)) || normSede(nome).includes(normSede(x.nome))));
  // fatturato e target (somma delle sedi della persona) per i mesi richiesti dello stesso anno
  async function fattSedi(sediIds, mesi) {
    const out = { mesi: {}, sedi: [], errore: null };
    if (!(sediIds || []).length) { out.errore = 'Nella tua anagrafica non c’è una sede.'; return out; }
    let c; try { c = await consuntivo(mesi[mesi.length - 1]); } catch (e) { out.errore = e.message; return out; }
    if (!c) { out.errore = 'Gestione finanziaria non è ancora collegata (Performance → Guadagni).'; return out; }
    const nomi = new Map((await sch.sedi()).map(x => [x.id, x.nome]));
    for (const id of sediIds) {
      const nome = nomi.get(id) || ''; if (!nome) continue;
      const s = trovaSede(c, nome);
      const sd = { id, nome, trovata: !!s, mesi: {} }; out.sedi.push(sd);
      if (!s) { out.errore = `La sede ${nome} non si trova in Gestione finanziaria.`; continue; }
      for (const m of mesi) {
        const i = Number(m.slice(5)) - 1, x = out.mesi[m] || (out.mesi[m] = { fatt: 0, target: 0, dati: true });
        const f = Array.isArray(s.fatturatoMesi) ? s.fatturatoMesi[i] : null;
        if (f == null) x.dati = false;
        x.fatt += Number(f) || 0; x.target += Number(s.target) || 0;
        sd.mesi[m] = { fatt: Number(f) || 0, target: Number(s.target) || 0 };   // ogni sede da sola (per chi ne ha più di una)
      }
    }
    return out;
  }
  // fatturato personale dal CRM Commerciale: € piano di cura dei preventivi con esito A (Accettato) del commerciale
  async function crmPersonale(uid, mesi) {
    const crm = require('../crm/lib/db'), anno = Number(mesi[0].slice(0, 4)), mm = mesi.map(m => Number(m.slice(5)));
    const { rows: al } = await crm.q('select nome from alias_commerciali where user_id = $1', [uid]);
    const { rows } = await crm.q(`select mese, count(*)::int n, count(*) filter (where esito = 'A')::int na, coalesce(sum(pdc) filter (where esito = 'A'), 0)::float fatt
      from preventivi where anno = $1 and mese = any($2) and (commerciale_id = $3 or upper(commerciale) = any($4)) group by mese`, [anno, mm, uid, al.map(a => String(a.nome).toUpperCase())]);
    const out = {};
    for (const m of mesi) { const r = rows.find(x => x.mese === Number(m.slice(5))) || { n: 0, na: 0, fatt: 0 };
      out[m] = { fatt: r2(r.fatt), n: r.n, na: r.na, conc: r.n ? Math.round(r.na / r.n * 1000) / 10 : 0, tmv: r.na ? r2(r.fatt / r.na) : 0 }; }
    return out;
  }
  const spiegaRegola = r => require('./lib/pianoExcel').spiega(r);
  // calcolo di un mese per una persona (senza scrivere nulla tranne l'archivio)
  async function guadagni(uid, mese, persona, livello, perfRow) {
    const regole = (livello?.regole || []);
    const { rows: [mm] } = await q('select * from sp_mese where user_id = $1 and mese = $2', [uid, mese]);
    const trim = mesiTrim(mese).filter(m => m <= mese), fineTrim = mesiTrim(mese)[2] === mese;
    const { rows: mt } = await q('select * from sp_mese where user_id = $1 and mese = any($2)', [uid, trim]);
    const sedi = persona?.sedi || [];
    const F = await fattSedi(sedi, mesiTrim(mese));
    const condFisso = livello?.fissoCond === 'senza_target_pers' && perfRow?.fisso_man == null;
    const usaPers = condFisso || regole.some(r => r.tipo === 'perc' && (r.base === 'pers' || r.cond?.pers || r.cond?.conc || r.cond?.tmv));
    let P = null, errPers = null;
    if (usaPers) { try { P = await crmPersonale(uid, trim); } catch (e) { errPers = 'CRM Commerciale non raggiungibile: ' + e.message; } }
    const tPerc = m => { const x = mt.find(y => y.mese === m); return x?.target_perc != null ? Number(x.target_perc) : TARGET_PERS; };
    const ul = m => F.mesi[m] || { fatt: 0, target: 0, dati: false };
    const pers = m => P?.[m] || { fatt: 0, n: 0, na: 0, conc: 0, tmv: 0 };
    const tPers = m => r2(ul(m).target * tPerc(m) / 100);
    // valori del periodo (mese o trimestre fino a questo mese)
    const periodo = ms => ({ ulF: ms.reduce((t, m) => t + ul(m).fatt, 0), ulT: ms.reduce((t, m) => t + ul(m).target, 0),
      pF: ms.reduce((t, m) => t + pers(m).fatt, 0), pT: ms.reduce((t, m) => t + tPers(m), 0),
      conc: (n => n ? ms.reduce((t, m) => t + pers(m).na, 0) / n * 100 : 0)(ms.reduce((t, m) => t + pers(m).n, 0)),
      tmv: (na => na ? ms.reduce((t, m) => t + pers(m).fatt, 0) / na : 0)(ms.reduce((t, m) => t + pers(m).na, 0)) });
    const calcola = (r, v) => {
      const c = r.cond || {}, motivi = [];
      if (c.ul) { if (!v.ulT) motivi.push('manca il target della sede'); else if (v.ulF < v.ulT * c.ul) motivi.push(`${F.sedi.length > 1 ? 'area' : 'sede'} al ${Math.round(v.ulF / v.ulT * 100)}% (serve ${Math.round(c.ul * 100)}%)`); }
      if (c.pers) { if (!v.pT) motivi.push('manca il target personale'); else if (v.pF < v.pT * c.pers) motivi.push(`personale al ${Math.round(v.pF / v.pT * 100)}% (serve ${Math.round(c.pers * 100)}%)`); }
      if (c.conc && v.conc < c.conc) motivi.push(`concretizzazione ${Math.round(v.conc)}% (serve ${c.conc}%)`);
      if (c.tmv && v.tmv < c.tmv) motivi.push(`TMV € ${Math.round(v.tmv).toLocaleString('it-IT')} (serve € ${c.tmv.toLocaleString('it-IT')})`);
      const base = r.base === 'pers' ? v.pF : v.ulF;
      return { importo: motivi.length ? 0 : r2(base * r.perc / 100), base: r2(base), ok: !motivi.length, motivo: motivi.join(' · ') };
    };
    // bonus del mese (regole mensili + voci a mano) di un mese qualsiasi del trimestre
    const bonusMese = m => {
      const v = periodo([m]), man = (mt.find(y => y.mese === m)?.manuali) || {};
      const voci = regole.filter(r => r.tipo === 'perc' && r.periodo === 'mese').map(r => ({ id: r.id, testo: r.testo, regola: spiegaRegola(r), ...calcola(r, v) }))
        .concat(regole.filter(r => r.tipo === 'manuale').map(r => ({ id: r.id, testo: r.testo, regola: 'Importo scritto dall’amministrazione', manuale: true, importo: r2(man[r.id] || 0), ok: true })));
      return { voci, totale: r2(voci.reduce((t, x) => t + x.importo, 0)), malus: !!mt.find(y => y.mese === m)?.malus };
    };
    const bm = bonusMese(mese), malus = !!mm?.malus;
    // trimestre: si paga a fine trimestre; si tolgono i bonus mensili annullati dal malus nei mesi del trimestre
    const vT = periodo(trim);
    const vociT = regole.filter(r => r.tipo === 'perc' && r.periodo === 'trim').map(r => ({ id: r.id, testo: r.testo, regola: spiegaRegola(r), ...calcola(r, vT) }));
    const lordoT = r2(vociT.reduce((t, x) => t + x.importo, 0));
    const annullati = r2(trim.reduce((t, m) => { const b = bonusMese(m); return t + (b.malus ? b.totale : 0); }, 0));
    const trimestre = vociT.length ? { voci: vociT, lordo: lordoT, annullati, importo: fineTrim ? r2(Math.max(0, lordoT - annullati)) : 0, maturato: r2(Math.max(0, lordoT - annullati)), fineTrim,
      mesi: trim, fine: meseNome(mesiTrim(mese)[2]) } : null;
    let fisso = perfRow?.fisso_man != null ? Number(perfRow.fisso_man) : livello?.fissoNum ?? null, fissoNota = '';
    // es. RAP Step 3: il fisso spetta solo se il target personale del mese NON è raggiunto
    if (condFisso && fisso != null) {
      const pf = pers(mese).fatt, pt = tPers(mese);
      if (pt && pf >= pt) { fissoNota = `Target personale raggiunto: il fisso di ${fisso.toLocaleString('it-IT', { useGrouping: 'always' })} € di questo step non spetta.`; fisso = 0; }
      else fissoNota = 'Il fisso spetta perché il target personale del mese non è raggiunto.';
    }
    const { rows: acc } = await q('select coalesce(sum(importo), 0)::float t, string_agg(nullif(nota, \'\'), \' · \') n from sp_accordi where mese = $1 and sede_id = any($2)', [mese, sedi]);
    const u = ul(mese), bonusMeseNetto = malus ? 0 : bm.totale;
    const dati = {
      mese, nomeMese: meseNome(mese), ruolo: livello?.ruolo || '', aggiornato: new Date().toISOString(),
      sede: { nomi: F.sedi.map(x => x.nome), area: F.sedi.length > 1,
        dettaglio: F.sedi.length > 1 ? F.sedi.map(x => { const v = x.mesi[mese] || { fatt: 0, target: 0 }; return { nome: x.nome, trovata: x.trovata, fatturato: r2(v.fatt), target: r2(v.target), pct: v.target ? Math.round(v.fatt / v.target * 100) : null }; }) : [],
        fatturato: r2(u.fatt), target: r2(u.target), pct: u.target ? Math.round(u.fatt / u.target * 100) : null,
        accordi: r2(acc[0]?.t || 0), accordiNota: acc[0]?.n || '', netto: r2(u.fatt - (acc[0]?.t || 0)), dati: u.dati, errore: F.errore },
      personale: usaPers ? { ...pers(mese), target: tPers(mese), targetPerc: tPerc(mese), pct: tPers(mese) ? Math.round(pers(mese).fatt / tPers(mese) * 100) : null, errore: errPers } : null,
      fisso, fissoNota, bonus: bm.voci, bonusTotale: bm.totale, malus, malusNota: mm?.malus_nota || '', bonusPagato: bonusMeseNetto,
      trimestre, note: regole.filter(r => r.tipo === 'nota').map(r => r.testo),
      totale: r2((fisso || 0) + bonusMeseNetto + (trimestre?.importo || 0)),
    };
    return dati;
  }
  // guadagni da mostrare: il mese in corso (aggiornato ogni giorno) e i 2 mesi prima (poi spariscono: gennaio sparisce il 1° aprile).
  // Ogni calcolo si salva in archivio; se Gestione finanziaria non ha più i dati (es. anno nuovo) si usa l'archivio.
  async function guadagniPersona(uid, persona, livello, perfRow) {
    const ora = meseOra(), out = [];
    for (const m of [ora, meseAdd(ora, -1), meseAdd(ora, -2)]) {
      let d = null;
      try { d = await guadagni(uid, m, persona, livello, perfRow); } catch (e) { console.warn('Guadagni', uid, m, e.message); }
      const { rows: [arch] } = await q('select dati from sp_guadagni where user_id = $1 and mese = $2', [uid, m]);
      if (d && (d.sede.dati || !arch)) { await q(`insert into sp_guadagni (user_id, mese, dati, aggiornato) values ($1,$2,$3,now()) on conflict (user_id, mese) do update set dati = excluded.dati, aggiornato = now()`, [uid, m, JSON.stringify(d)]); out.push(d); }
      else if (arch) out.push({ ...arch.dati, archivio: true });
    }
    return out;
  }

  async function perfUtente(uid, persona = null) {
    await migrate();
    const { rows } = await q('select * from sp_perf where user_id = $1', [uid]);
    if (!rows[0]) return null;
    const piano = (await struttura()).find(p => p.id === rows[0].piano_id);
    if (!piano) return null;
    const cur = piano.livelli.find(l => l.n === rows[0].livello_n), next = piano.livelli.find(l => l.n > rows[0].livello_n);
    const { rows: dati } = await q(`select id, obiettivo_id, dato, stato, nota, il, file_nome from sp_perf_dati where user_id = $1 order by il desc`, [uid]);
    const { rows: pas } = await q(`select * from sp_passaggi where user_id = $1 and stato = 'attesa' limit 1`, [uid]);
    // piani da Excel: gli obiettivi sono quelli del livello attuale (per superarlo); piani di prima: quelli del livello successivo.
    // La riga «Superamento del test…» non è un obiettivo da provare: è il test che si fa a termometro pieno.
    const daExcel = !!piano.fonte;
    const conStato = o => { const d = dati.find(x => x.obiettivo_id === o.id);
      return { ...o, stato: o.test ? 'test' : d?.stato || 'fare', dato: d?.dato || '', nota: d?.nota || '', datoId: d?.id || null, file: d?.file_nome || '', il: d?.il || null }; };
    const righe = daExcel ? (cur?.obiettivi || []).map(conStato) : [];
    const ob = daExcel ? righe.filter(o => !o.test) : (next?.obiettivi || []).map(conStato);
    const comp = l => l ? { fisso: l.fisso, variabile: l.variabile, area: l.area } : null;
    const pass = ob.filter(o => o.stato === 'pass').length;
    // test di passaggio (dai Protocolli): si sblocca con tutti i pass; superato → passaggio di ruolo da approvare
    let test = { disponibile: !!next && ob.length > 0 && pass === ob.length, stato: null };
    if (rows[0].test_invio) {
      const P = require('../lib/protocolli').api;
      const e = P ? await P.esitoInvio(rows[0].test_invio).catch(() => null) : null;
      test.stato = !e ? 'inviato' : e.esito || e.stato; test.punti = e?.punti ?? null;
      if (e?.esito === 'superato' && next && !pas[0]) {
        const { rows: gia } = await q(`select 1 from sp_passaggi where user_id = $1 and a_n = $2 and stato in ('attesa','approvato') limit 1`, [uid, next.n]);
        if (!gia[0]) { await q(`insert into sp_passaggi (id, user_id, piano_id, da_n, a_n, bonus) values ($1,$2,$3,$4,$5,$6)`, [db.newId(), uid, piano.id, rows[0].livello_n, next.n, next.bonus || '']);
          avvisaAdmin({ title: 'Passaggio di ruolo da approvare', body: `Test superato: passaggio a ${next.ruolo}.`, url: '/?sez=perf' }); pas[0] = { stato: 'attesa' }; }
      }
    }
    const per = persona || (await persone()).find(p => p.id === uid);
    const mese = meseScorso();
    const nomiSedi = new Map((await sch.sedi()).map(x => [x.id, x.nome]));
    // la tua situazione: contratto, sede, ore, fisso e variabile (quelli del livello, o quelli scritti dall'amministratore)
    const situazione = { contratto: per?.tipo === 'piva' ? 'Partita IVA' : per?.tipo === 'dip' ? 'CCNL' : '', sedi: (per?.sedi || []).map(x => nomiSedi.get(x)).filter(Boolean), ore: per?.ore ?? null,
      fisso: rows[0].fisso_man != null ? Number(rows[0].fisso_man) : cur?.fissoNum ?? null, fissoTesto: rows[0].fisso_man != null ? '' : (cur?.fisso || '') + (cur?.fissoCond === 'senza_target_pers' ? ' · solo se non raggiungi il target personale' : ''), fissoMan: rows[0].fisso_man != null,
      variabile: rows[0].variabile_man != null ? rows[0].variabile_man : cur?.variabile || '', variabileMan: rows[0].variabile_man != null };
    const { rows: [ip] } = await q('select valori, il from sp_iprofile where user_id = $1', [uid]);
    return { iprofile: ip ? { valori: ip.valori, il: ip.il } : null, piano: piano.nome, pianoId: piano.id, daExcel, intestazioni: piano.intestazioni, righe, situazione, livello: rows[0].livello_n, ruolo: cur?.ruolo || '', attuale: comp(cur), regole: (await sch.imp('sp_regole')) || '',

      prossimo: next ? { ruolo: next.ruolo, bonus: next.bonus, ...comp(next), skill: next.skill } : null, obiettivi: ob,
      pass, inAttesa: !!pas[0], test,
      incentivo: await incentivo(cur, per?.sedi, mese), incentivoProssimo: next && next.incPerc != null && (cur?.incPerc == null) ? await incentivo(next, per?.sedi, mese) : null };
  }
  // i miei guadagni: mese in corso + i 2 mesi prima (solo piani da Excel)
  async function guadagniDi(uid, persona) {
    const { rows: [a] } = await q('select * from sp_perf where user_id = $1', [uid]); if (!a) return null;
    const pi = (await struttura()).find(x => x.id === a.piano_id); if (!pi?.fonte) return null;
    const l = pi.livelli.find(x => x.n === a.livello_n);
    return guadagniPersona(uid, persona || await personaDi(uid), l, a);
  }
  app.get('/api/sp/perf/guadagni', needSp, wrap(async (req, res) => res.json({ mesi: (await guadagniDi(req.user.sso_id)) || [] })));

  // la persona carica la prova di un obiettivo (foto o file, con una nota): va all'amministratore da verificare
  app.post('/api/sp/perf/dato', needSp, upload.single('file'), wrap(async (req, res) => {
    const dato = str(req.body.dato, 1000), oid = str(req.body.obiettivo, 64), f = req.file;
    if (!dato && !f) return bad(res, 400, 'Carica una foto o un file, oppure scrivi il risultato raggiunto.');
    if (f && f.size > 15 * 1024 * 1024) return bad(res, 400, 'Il file è troppo grande (massimo 15 MB).');
    const p = await perfUtente(req.user.sso_id);
    const o = p?.obiettivi.find(x => x.id === oid);
    if (!o) return bad(res, 400, 'Obiettivo non trovato.');
    if (o.stato === 'pass' || o.stato === 'verifica') return bad(res, 400, o.stato === 'pass' ? 'Hai già il pass per questo obiettivo.' : 'La prova è già in verifica.');
    let fileCol = [null, null, null, null, null];
    if (f) {
      const nome = String(f.originalname || 'prova').replace(/[^\w.\- àèéìòù()]/gi, '').slice(0, 120) || 'prova';
      if (cifraOk()) { const c = cifra(f.buffer); fileCol = [nome, f.mimetype || 'application/octet-stream', c.file, c.iv, c.tag]; }
      else fileCol = [nome, f.mimetype || 'application/octet-stream', f.buffer, null, null];
    }
    await q('insert into sp_perf_dati (id, user_id, obiettivo_id, dato, file_nome, file_tipo, file_dati, file_iv, file_tag) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)',
      [db.newId(), req.user.sso_id, oid, dato || '(prova caricata)', ...fileCol]);
    const me = await io(req);
    avvisaAdmin({ title: 'Performance: prova da verificare', body: `${me.nome}: ${o.testo}`.slice(0, 160), url: '/?sez=perf' });
    res.json({ ok: true });
  }));
  // file della prova: lo vedono la persona e l'amministratore
  app.get('/api/sp/perf/prova/:id', needSp, wrap(async (req, res) => {
    const { rows: [d] } = await q('select user_id, file_nome, file_tipo, file_dati, file_iv, file_tag from sp_perf_dati where id = $1', [req.params.id]);
    if (!d || !d.file_dati || (req.user.role !== 'admin' && d.user_id !== req.user.sso_id)) return bad(res, 404, 'File non disponibile');
    const buf = d.file_iv ? decifra({ file: d.file_dati, iv: d.file_iv, tag: d.file_tag }) : d.file_dati;
    res.set({ 'Content-Type': d.file_tipo || 'application/octet-stream', 'Content-Disposition': `inline; filename="${encodeURIComponent(d.file_nome || 'prova')}"`, 'Cache-Control': 'private, no-store' });
    res.send(buf);
  }));
  // tutti i pass: la persona genera il test (domande dai Protocolli della sua mansione)
  app.post('/api/sp/perf/test', needSp, wrap(async (req, res) => {
    const p = await perfUtente(req.user.sso_id);
    if (!p?.test?.disponibile) return bad(res, 400, 'Il test si sblocca quando tutti gli obiettivi sono approvati.');
    if (p.test.stato && p.test.stato !== 'da_ripetere') return res.json({ ok: true, url: 'https://protocolli.appgestione.it/?v=test' });
    const me = await io(req), P = require('../lib/protocolli').api;
    const r = P ? await P.testPassaggio({ ssoId: req.user.sso_id, figura: me.figura, ruolo: p.prossimo.ruolo }) : { errore: 'protocolli' };
    if (r.errore) {
      avvisaAdmin({ title: 'Test di passaggio da preparare', body: `${me.nome} ha tutti i pass per ${p.prossimo.ruolo}, ma la banca domande dei Protocolli per la sua mansione non è pronta.`, url: '/?sez=perf' });
      return bad(res, 400, r.errore === 'banca' ? 'Il test per la tua mansione non è ancora pronto (mancano le domande nei Protocolli). L’amministratore è stato avvisato.' : r.errore === 'utente' ? 'Apri una volta l’app Protocolli, poi riprova.' : 'Il test non si può generare adesso: l’amministratore è stato avvisato.');
    }
    await q('update sp_perf set test_invio = $2 where user_id = $1', [req.user.sso_id, r.invio]);
    res.json({ ok: true, url: 'https://protocolli.appgestione.it/?v=test' });
  }));

  /* ---------- tutti i documenti personali di una persona (per l'invio quando si elimina il profilo) ---------- */
  // Buste paga, CU, contratti e altri documenti pubblicati (con la firma, se c'è) + certificati approvati.
  // Non cancella nulla: legge soltanto.
  store.hooks.documentiPersonali = async uid => {
    await migrate();
    const pulisci = s => String(s || '').replace(/[^\w\- .àèéìòù()]/gi, '').replace(/\s+/g, ' ').trim().slice(0, 90) || 'documento';
    const files = [], usati = new Set();
    const aggiungi = (cartella, nome, buf) => {
      let n = `${cartella}/${nome}`, i = 2;
      while (usati.has(n.toLowerCase())) { n = `${cartella}/${nome.replace(/(\.\w+)$/, ` (${i++})$1`)}`; }
      usati.add(n.toLowerCase()); files.push({ nome: n, buf });
    };
    const { rows: docs } = await q(`select * from sp_docs where user_id = $1 and stato = 'pubblicato' order by periodo, pubblicato`, [uid]);
    const firme = [];
    for (const d of docs) {
      const nome = pulisci(`${d.periodo ? d.periodo + ' ' : ''}${d.titolo || d.tipo}`);
      aggiungi('Documenti', nome + '.pdf', decifra(d));
      if (d.firma) {
        aggiungi('Firme', nome + ' - firma.png', d.firma_iv ? decifra({ file: d.firma, iv: d.firma_iv, tag: d.firma_tag }) : d.firma);
        firme.push(`${nome}: firmato il ${new Date(d.firmato).toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}${d.firma_impronta ? ` · impronta SHA-256 del documento ${d.firma_impronta}` : ''}`);
      }
    }
    if (firme.length) aggiungi('Firme', 'Riepilogo firme.txt', Buffer.from('Firme con il dito fatte nella Scheda personale\r\n\r\n' + firme.join('\r\n') + '\r\n'));
    const { rows: cert } = await q(`select id, tipo, dal, al, ora_da, ora_a, doc_nome, doc_dati, doc_iv, doc_tag from sp_richieste
      where user_id = $1 and doc_approvato is not null and doc_dati is not null and stato <> 'annullata' order by dal`, [uid]);
    for (const r of cert) {
      const est = (String(r.doc_nome || '').match(/\.(\w{2,5})$/) || [, 'pdf'])[1].toLowerCase();
      const titolo = (r.tipo === 'lutto' ? 'Certificato di morte' : r.tipo === 'maternita' ? 'Certificato di maternità' : 'Certificato') + ' ' + r.dal;
      aggiungi('Certificati', pulisci(titolo) + '.' + est, r.doc_iv ? decifra({ file: r.doc_dati, iv: r.doc_iv, tag: r.doc_tag }) : r.doc_dati);
    }
    return files;
  };

  /* ---------- documenti (utente: solo i suoi) ---------- */
  app.get('/api/sp/doc/:id/file', needSp, wrap(async (req, res) => {
    const { rows } = await q('select * from sp_docs where id = $1', [req.params.id]);
    const d = rows[0], admin = req.user.role === 'admin';
    if (!d || (!admin && (d.user_id !== req.user.sso_id || d.stato !== 'pubblicato'))) return bad(res, 404, 'Documento non disponibile');
    if (!admin) await q('update sp_docs set visto = coalesce(visto, now()) where id = $1', [d.id]);
    const nome = (d.titolo || 'documento').replace(/[^\w\- àèéìòù]/gi, '').trim() || 'documento';
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `${req.query.scarica ? 'attachment' : 'inline'}; filename="${nome}.pdf"`, 'Cache-Control': 'no-store, private' });
    res.send(decifra(d));
  }));
  app.post('/api/sp/doc/:id/ricevuto', needSp, wrap(async (req, res) => {
    const { rowCount } = await q(`update sp_docs set ricevuto = coalesce(ricevuto, now()), ricevuto_disp = coalesce(ricevuto_disp, $3), visto = coalesce(visto, now())
      where id = $1 and user_id = $2 and stato = 'pubblicato'`, [req.params.id, req.user.sso_id, buste.dispositivo(req.get('user-agent'))]);
    if (!rowCount) return bad(res, 404, 'Documento non trovato');
    res.json({ ok: true });
  }));

  // firma per ricevuta con il dito: vale anche come conferma di ricezione
  app.post('/api/sp/doc/:id/firma', needSp, wrap(async (req, res) => {
    const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.png || ''));
    if (!m) return bad(res, 400, 'Firma non valida: firma nel riquadro e riprova.');
    const png = Buffer.from(m[1], 'base64');
    if (png.length < 300 || png.length > 400 * 1024) return bad(res, 400, 'Firma non valida: firma nel riquadro e riprova.');
    const { rows: [d] } = await q(`select * from sp_docs where id = $1 and user_id = $2 and stato = 'pubblicato'`, [req.params.id, req.user.sso_id]);
    if (!d) return bad(res, 404, 'Documento non trovato');
    if (d.firmato) return bad(res, 400, 'Hai già firmato questo documento.');
    const impronta = crypto.createHash('sha256').update(decifra(d)).digest('hex');
    const c = cifraOk() ? cifra(png) : { file: png, iv: null, tag: null };
    const disp = buste.dispositivo(req.get('user-agent'));
    await q(`update sp_docs set firma = $2, firma_iv = $3, firma_tag = $4, firmato = now(), firma_disp = $5, firma_impronta = $6,
        ricevuto = coalesce(ricevuto, now()), ricevuto_disp = coalesce(ricevuto_disp, $5), visto = coalesce(visto, now()) where id = $1 and firmato is null`,
      [d.id, c.file, c.iv, c.tag, disp, impronta]);
    res.json({ ok: true });
  }));
  app.get('/api/sp/doc/:id/firma', needSp, wrap(async (req, res) => {
    const { rows: [d] } = await q('select user_id, firma, firma_iv, firma_tag from sp_docs where id = $1', [req.params.id]);
    if (!d || !d.firma || (req.user.role !== 'admin' && d.user_id !== req.user.sso_id)) return bad(res, 404, 'Firma non disponibile');
    res.set({ 'Content-Type': 'image/png', 'Cache-Control': 'private, no-store' });
    res.send(d.firma_iv ? decifra({ file: d.firma, iv: d.firma_iv, tag: d.firma_tag }) : d.firma);
  }));

  /* ================= amministratore ================= */
  const needAd = [needAdmin, needSp];

  app.get('/api/sp/admin/persone', needAd, wrap(async (req, res) => {
    const pp = await persone();
    const s = await saldi(pp.map(p => p.id));
    res.json({ persone: pp.map(p => ({ ...p, cf: p.cf ? p.cf.slice(0, 6) + '…' + p.cf.slice(-2) : '', haCf: !!p.cf, saldi: s[p.id] })), sedi: (await sch.sedi()).map(x => ({ id: x.id, nome: x.nome })) });
  }));
  app.put('/api/sp/admin/persone/:id', needAd, wrap(async (req, res) => {
    const b = req.body, sets = [], vals = [req.params.id];
    const add = (col, v) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
    if ('tipo' in b) { const t = b.tipo === 'dip' || b.tipo === 'piva' ? b.tipo : null; add('tipo', t); add('tipo_ok', !!t); }
    if ('ore' in b) { const o = num(b.ore); if (o !== null && !(o >= 0 && o <= 60)) return bad(res, 400, 'Ore non valide.'); add('ore_sett', o); }
    if ('senzaNfc' in b) add('senza_nfc', !!b.senzaNfc);
    if ('sedi' in b) {
      const ok = new Set((await sch.sedi()).map(s => s.id)), ids = (Array.isArray(b.sedi) ? b.sedi : []).filter(x => ok.has(x));
      add('sedi', JSON.stringify(ids));
      const { rows: [pu] } = await store.q('select figura from users where id = $1', [req.params.id]);
      if (pu && pu.figura !== MEDICO) await store.impostaSedi(req.params.id, ids); // le sedi stanno nell'anagrafica unica: valgono per tutte le app
    }
    if ('conferma' in b) add('tipo_ok', true);
    if (!sets.length) return res.json({ ok: true });
    await q(`insert into sp_persone (user_id) values ($1) on conflict do nothing`, [req.params.id]);
    await q(`update sp_persone set ${sets.join(', ')}, aggiornato = now() where user_id = $1`, vals);
    // contratto: lo stesso anche nell'anagrafica unica (è lei che vale per tutte le app)
    const us = [], uv = [req.params.id], uadd = (c, v) => { uv.push(v); us.push(`${c} = $${uv.length}`); };
    if ('tipo' in b) { const t = b.tipo === 'dip' || b.tipo === 'piva' ? b.tipo : null; uadd('contratto_tipo', t); uadd('contratto_ok', !!t); if (t === 'piva') uadd('contratto_ore', null); }
    if ('ore' in b && b.tipo !== 'piva') uadd('contratto_ore', num(b.ore));
    if ('conferma' in b) uadd('contratto_ok', true);
    if (us.length) await store.q(`update users set ${us.join(', ')}, contratto_il = coalesce(contratto_il, now()) where id = $1`, uv);
    res.json({ ok: true });
  }));

  // timbrature: in servizio adesso, correzioni a mano
  app.get('/api/sp/admin/inservizio', needAd, wrap(async (req, res) => {
    const g = oggi();
    const { rows } = await q(`select distinct on (user_id) user_id, tipo, ora, sede_id from sp_timbrature where giorno = $1 and not annullata order by user_id, il desc`, [g]);
    const pp = await persone(), nomi = new Map(pp.map(p => [p.id, p.nome])), ss = new Map((await sch.sedi()).map(s => [s.id, s.nome]));
    res.json({ dentro: rows.filter(r => r.tipo === 'in').map(r => ({ nome: nomi.get(r.user_id) || '', sede: ss.get(r.sede_id) || '', ora: r.ora })).sort((a, b) => a.ora.localeCompare(b.ora)) });
  }));
  app.post('/api/sp/admin/timbrature', needAd, wrap(async (req, res) => {
    const b = req.body;
    if (!isG(b.giorno) || !isHM(b.ora) || !['in', 'out'].includes(b.tipo)) return bad(res, 400, 'Indica giorno, ora e se è ingresso o uscita.');
    const p = await personaDi(b.user); if (!p) return bad(res, 400, 'Persona non trovata.');
    const nota = str(b.nota, 200); if (!nota) return bad(res, 400, 'Scrivi il motivo della correzione (resta nello storico).');
    await q(`insert into sp_timbrature (id, user_id, giorno, ora, tipo, sede_id, modo, nota, da) values ($1,$2,$3,$4,$5,$6,'manuale',$7,$8)`,
      [db.newId(), p.id, b.giorno, b.ora, b.tipo, b.sede || p.sedi[0] || null, nota, req.user.email]);
    // se quel giorno era stato segnato come mancata timbratura, si annulla e si restituisce quanto scalato
    await annullaMancata(p.id, b.giorno);
    res.json({ ok: true });
  }));
  app.delete('/api/sp/admin/timbrature/:id', needAd, wrap(async (req, res) => {
    await q(`update sp_timbrature set annullata = true, nota = trim(nota || ' · annullata da ' || $2) where id = $1`, [req.params.id, req.user.email]);
    res.json({ ok: true });
  }));
  async function annullaMancata(uid, g) {
    const { rows } = await q(`update sp_mancate set annullata = true where user_id = $1 and giorno = $2 and not annullata returning mov_id`, [uid, g]);
    if (rows[0]?.mov_id) await q('update sp_movimenti set annullato = true where id = $1', [rows[0].mov_id]);
    return !!rows[0];
  }
  app.post('/api/sp/admin/mancate/annulla', needAd, wrap(async (req, res) => {
    if (!(await annullaMancata(str(req.body.user, 64), str(req.body.giorno, 10)))) return bad(res, 400, 'Niente da annullare.');
    res.json({ ok: true });
  }));

  // report 1: presenze effettive (gli orari veri di timbratura)
  async function datiPeriodo(dal, al) {
    const pp = await persone(), ids = pp.map(p => p.id);
    const [ts, { rows: tim }, { rows: ric }, { rows: manc }] = await Promise.all([
      turniDi(dal, al, ids),
      q(`select * from sp_timbrature where giorno between $1 and $2 and not annullata order by giorno, il`, [dal, al]),
      q(`select ${RCOLS} from sp_richieste where stato = 'approvata' and al >= $1 and dal <= $2`, [dal, al]),
      q(`select * from sp_mancate where giorno between $1 and $2 and not annullata`, [dal, al]),
    ]);
    return { pp, ts, tim, ric, manc };
  }
  // coppie ingresso/uscita della giornata
  const coppie = tt => { const out = []; let aperto = null; for (const t of tt) { if (t.tipo === 'in') { if (aperto) out.push({ in: aperto, out: null }); aperto = t; } else { out.push({ in: aperto, out: t }); aperto = null; } } if (aperto) out.push({ in: aperto, out: null }); return out; };
  const filtra = (pp, sede, fig) => pp.filter(p => (!sede || p.sedi.includes(sede)) && (!fig || p.figura === fig));

  app.get('/api/sp/admin/presenze', needAd, wrap(async (req, res) => {
    const dal = isG(req.query.dal) ? req.query.dal : addG(oggi(), -6), al = isG(req.query.al) ? req.query.al : oggi();
    if (al < dal || (Date.parse(al) - Date.parse(dal)) / 864e5 > 62) return bad(res, 400, 'Scegli un periodo di al massimo due mesi.');
    const { pp, ts, tim, ric, manc } = await datiPeriodo(dal, al);
    const ss = new Map((await sch.sedi()).map(s => [s.id, s.nome]));
    const righe = [];
    for (const p of filtra(pp, req.query.sede, req.query.figura)) {
      for (let g = dal; g <= al; g = addG(g, 1)) {
        const mt = tim.filter(t => t.user_id === p.id && t.giorno === g), mturni = ts.filter(t => t.user === p.id && t.giorno === g);
        const as = ric.find(r => r.user_id === p.id && r.dal <= g && r.al >= g), mc = manc.find(m => m.user_id === p.id && m.giorno === g);
        if (!mt.length && !mturni.length && !as && !mc) continue;
        let minuti = 0, aperta = false;
        for (const c of coppie(mt)) { if (c.in && c.out) minuti += Math.max(0, min(c.out.ora) - min(c.in.ora)); else aperta = true; }
        let nota = '', k = 'ok';
        if (as && as.tipo === 'smart') { nota = 'Smart working'; k = 'info'; if (!mt.length && g < oggi()) { nota = 'Smart working · nessuna timbratura'; k = 'no'; } else if (aperta && g < oggi()) { nota = 'Smart working · uscita non timbrata'; k = 'wait'; } }
        else if (as) { nota = as.tipo === 'permesso' ? `Permesso ${as.ora_da}–${as.ora_a}` : TIPI[as.tipo]; k = 'info';
          if (as.doc_stato === 'attesa') nota += as.tipo === 'lutto' ? ' · certificato da caricare' : ' · protocollo da inserire'; }
        if (mc) { nota = mc.motivo ? `${mc.motivo} · ${mc.esito === 'ferie' ? 'ferie scalate' : 'assenza ingiustificata'}` : mc.esito === 'ingiustificata' ? 'Assenza ingiustificata' : `Mancata timbratura · ${mc.esito === 'ferie' ? 'ferie' : 'permessi'} (automatico)`; k = mc.esito === 'ingiustificata' ? 'no' : 'wait'; }
        if (!nota && mturni.length && !mt.length) { nota = g < oggi() ? 'Nessuna timbratura' : g === oggi() ? 'Non ancora timbrato' : 'In turno'; k = g < oggi() ? 'no' : 'info'; }
        if (!nota && aperta) { nota = 'Uscita non timbrata'; k = 'wait'; }
        if (!nota && mt.length && !mturni.length) { nota = 'Fuori turno'; k = 'info'; }
        if (!nota) nota = p.tipo === 'piva' ? 'Partita IVA' : 'Regolare';
        righe.push({ user: p.id, giorno: g, nome: p.nome, figura: p.figura, tipo: p.tipo,
          sede: [...new Set(mt.map(t => ss.get(t.sede_id)).concat(mturni.map(t => ss.get(t.sede))).filter(Boolean))].join(', '),
          turno: mturni.map(t => `${t.da}–${t.a}`).join(' + '),
          timbrature: mt.map(t => ({ id: t.id, tipo: t.tipo, ora: t.ora, modo: t.modo, nota: t.nota, ...(t.lat != null ? { lat: Number(t.lat), lon: Number(t.lon), prec: t.prec } : {}) })), ore: minuti, nota, k, mancata: mc ? mc.esito : null });
      }
    }
    righe.sort((a, b) => a.giorno.localeCompare(b.giorno) || a.nome.localeCompare(b.nome));
    if (req.query.csv) return csv(res, `presenze_${dal}_${al}.csv`, [['Data', 'Persona', 'Mansione', 'Sede', 'Turno', 'Timbrature', 'Ore effettive', 'Nota'],
      ...righe.map(r => [r.giorno, r.nome, r.figura, r.sede, r.turno, r.timbrature.map(t => `${t.tipo === 'in' ? 'E' : 'U'} ${t.ora}${t.modo !== 'nfc' ? ' (' + t.modo + ')' : ''}`).join(' '), hmDi(r.ore).replace(/^0/, ''), r.nota])]);
    res.json({ dal, al, righe });
  }));

  // report 2: ore riconosciute del mese (solo dipendenti), per la consulente
  async function oreRiconosciute(m, sede, fig) {
    const g = giorniMese(m), dal = g[0], al = g[g.length - 1];
    const { pp, ts, tim, ric, manc } = await datiPeriodo(dal, al);
    const lav = g.filter(x => dow(x) >= 1 && dow(x) <= 5).length;
    const ss = new Map((await sch.sedi()).map(s => [s.id, s.nome]));
    return { mese: m, giorni: g.map(x => ({ g: x, n: +x.slice(8), w: 'DLMMGVS'[dow(x)], fest: dow(x) === 0 || dow(x) === 6 })), righe: filtra(pp, sede, fig).filter(isDip).map(p => {
      let tot = 0; const c = { F: 0, P: 0, M: 0, AI: 0, SW: 0, L: 0, CP: 0, MAT: 0, PNR: 0 };
      const celle = g.map(x => {
        const mt = tim.filter(t => t.user_id === p.id && t.giorno === x), mturni = ts.filter(t => t.user === p.id && t.giorno === x);
        const as = ric.find(r => r.user_id === p.id && r.dal <= x && r.al >= x), mc = manc.find(r => r.user_id === p.id && r.giorno === x);
        let ricon = 0;
        for (const t of mturni) {
          let ov = 0; const a = min(t.da), b = min(t.a);
          for (const cp of coppie(mt)) if (cp.in && cp.out) ov += Math.max(0, Math.min(min(cp.out.ora), b) - Math.max(min(cp.in.ora), a));
          ricon += Math.min(ov, durata(t));
        }
        const smart = as && as.tipo === 'smart';
        // smart working senza turno: contano le ore timbrate (il tetto del contratto resta)
        if (smart && !mturni.length) for (const cp of coppie(mt)) if (cp.in && cp.out) ricon += Math.max(0, min(cp.out.ora) - min(cp.in.ora));
        // lutto con certificato (o registrato dall'amministrazione): conta come il turno del giorno
        const lutto = as && as.tipo === 'lutto';
        if (lutto && !mc && ['ok', ''].includes(as.doc_stato || '')) ricon = mturni.length ? mturni.reduce((s, t) => s + durata(t), 0) : (dow(x) >= 1 && dow(x) <= 5 ? Math.round(oreGiorno(p) * 60) : 0);
        tot += ricon;
        let cod = '';
        if (mc) { cod = mc.esito === 'ferie' ? 'F*' : mc.esito === 'permessi' ? 'P*' : 'AI'; c[mc.esito === 'ferie' ? 'F' : mc.esito === 'permessi' ? 'P' : 'AI']++; }
        else if (as) { cod = { ferie: 'F', malattia: 'M', permesso: 'P', smart: 'SW', lutto: 'L', parentale: 'CP', maternita: 'MAT', pnr: 'PNR' }[as.tipo] || 'A'; if (c[cod] !== undefined) c[cod]++; }
        const fuori = mt.length && !mturni.length && !smart;
        return { min: ricon, cod, fuori, corto: mturni.length && ricon < mturni.reduce((s, t) => s + durata(t), 0) && (!as || smart), attesa: !!(as && as.doc_stato === 'attesa') };
      });
      const tetto = Math.round((p.ore || 0) * 60 * lav / 5);
      return { user: p.id, nome: p.nome, figura: p.figura, sedi: p.sedi.map(s => ss.get(s)).filter(Boolean).join(', '), ore: p.ore, celle,
        totale: Math.min(tot, tetto || tot), oltre: tetto && tot > tetto, tetto, conta: c };
    }) };
  }
  app.get('/api/sp/admin/ore', needAd, wrap(async (req, res) => {
    const m = isM(req.query.mese) ? req.query.mese : oggi().slice(0, 7);
    const r = await oreRiconosciute(m, req.query.sede, req.query.figura);
    if (req.query.csv) {
      const h = v => v ? hmDi(v) : '';
      return csv(res, `ore_riconosciute_${m}.csv`, [['Persona', 'Mansione', 'Ore contratto/sett.', ...r.giorni.map(x => `${x.w} ${x.n}`), 'Totale riconosciuto', 'Tetto contratto', 'Ferie', 'Permessi', 'Malattia', 'Ass. ingiustificate', 'Smart working', 'Lutto', 'Congedo parentale', 'Maternità', 'Permesso non retribuito'],
        ...r.righe.map(p => [p.nome, p.figura, p.ore ?? '', ...p.celle.map(c => [h(c.min), c.cod].filter(Boolean).join(' ')), hmDi(p.totale), hmDi(p.tetto), p.conta.F, p.conta.P, p.conta.M, p.conta.AI, p.conta.SW, p.conta.L, p.conta.CP, p.conta.MAT, p.conta.PNR]),
        [], ['Legenda: F ferie, P permesso, M malattia, AI assenza ingiustificata, SW smart working, L lutto (con certificato conta come turno), CP congedo parentale (a ore), MAT maternità, PNR permesso non retribuito, * = scalato in automatico per mancata timbratura. Ogni giorno conta al massimo il turno; il totale non supera il tetto del contratto.']]);
    }
    res.json(r);
  }));
  function csv(res, nome, righe) {
    const cella = v => { const s = String(v ?? ''); return /[";\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s; };
    res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="${nome}"` });
    res.send('﻿' + righe.map(r => r.map(cella).join(';')).join('\r\n'));
  }

  // richieste e saldi
  app.get('/api/sp/admin/richieste', needAd, wrap(async (req, res) => {
    const pp = await persone(), nomi = new Map(pp.map(p => [p.id, p.nome]));
    const [{ rows: aperte }, { rows: recenti }, s, { rows: manc }, { rows: dacomp }, { rows: dacontr }] = await Promise.all([
      q(`select ${RCOLS} from sp_richieste where stato in ('attesa_sost','attesa_admin') order by dal`),
      q(`select ${RCOLS} from sp_richieste where stato in ('approvata','rifiutata','revocata') order by coalesce(decisa_il, creata) desc limit 60`),
      saldi(pp.map(p => p.id)),
      q(`select * from sp_mancate where giorno >= $1 order by giorno desc`, [addG(oggi(), -45)]),
      q(`select ${RCOLS} from sp_richieste where stato = 'approvata' and doc_stato = 'attesa' order by scadenza, dal`),
      q(`select ${RCOLS} from sp_richieste where doc_stato = 'ok' and doc_il is not null and doc_approvato is null and stato <> 'annullata' order by doc_il`),
    ]);
    const sh = r => ({ ...richShape(r, nomi), desc: descRich(r) });
    res.json({ aperte: aperte.map(sh), recenti: recenti.map(sh), daCompletare: dacomp.map(sh), certificati: dacontr.map(sh),
      saldi: pp.filter(isDip).map(p => ({ id: p.id, nome: p.nome, figura: p.figura, ...s[p.id] })),
      mancate: manc.map(m => ({ user: m.user_id, nome: nomi.get(m.user_id) || '', giorno: m.giorno, esito: m.esito, valore: m.valore != null ? Number(m.valore) : null, annullata: m.annullata, motivo: m.motivo || '' })),
      persone: pp.map(p => ({ id: p.id, nome: p.nome, tipo: p.tipo, medico: p.medico })) });
  }));
  app.post('/api/sp/admin/richieste/:id', needAd, wrap(async (req, res) => {
    const ok = !!req.body.ok;
    const { rows } = await q(`update sp_richieste set stato = $2, decisa_il = now(), decisa_da = $3, nota_admin = $4 where id = $1 and stato in ('attesa_sost','attesa_admin') returning *`,
      [req.params.id, ok ? 'approvata' : 'rifiutata', req.user.email, str(req.body.nota, 300)]);
    if (!rows[0]) return bad(res, 400, 'La richiesta non è più in attesa.');
    const r = rows[0];
    if (ok) await applicaApprovazione(r, req.user.email);
    avvisa([r.user_id], { title: ok ? 'Richiesta approvata' : 'Richiesta rifiutata', body: descRich(r) + (ok ? ' approvata.' : ' rifiutata.'), url: '/?sez=assenze' });
    if (ok && r.sost_id) avvisa([r.sost_id], { title: 'Sostituzione confermata', body: `${descRich(r)}: confermata dall'amministrazione.`, url: '/?sez=turni' });
    res.json({ ok: true });
  }));
  // certificato: l'amministrazione lo legge e lo approva (va nei «I miei documenti») oppure lo segna non valido (va ricaricato)
  app.post('/api/sp/admin/richieste/:id/certificato', needAd, wrap(async (req, res) => {
    const ok = !!req.body.ok, nota = str(req.body.nota, 300);
    const { rows: [r] } = await q(`select ${RCOLS} from sp_richieste where id = $1 and doc_il is not null and doc_stato = 'ok'`, [req.params.id]);
    if (!r) return bad(res, 400, 'Nessun certificato da controllare per questa richiesta.');
    if (ok) {
      await q(`update sp_richieste set doc_approvato = now(), doc_approvato_da = $2 where id = $1`, [r.id, req.user.email]);
      avvisa([r.user_id], { title: 'Certificato approvato', body: `${descRich(r)}: lo trovi in Documenti → I miei documenti.`, url: '/?sez=doc' });
    } else {
      // da ricaricare: la scadenza resta, ma almeno fino a fine giornata
      await q(`update sp_richieste set doc_stato = 'attesa', doc_il = null, doc_nome = null, doc_tipo = null, doc_dati = null, doc_iv = null, doc_tag = null, doc_approvato = null,
        scadenza = greatest(scadenza, $2::date) where id = $1`, [r.id, oggi()]);
      avvisa([r.user_id], { title: 'Certificato da ricaricare', body: `${descRich(r)}: il certificato non va bene${nota ? ' (' + nota + ')' : ''}. Caricalo di nuovo nella sezione Assenze.`, url: '/?sez=assenze' });
    }
    res.json({ ok: true });
  }));
  // revoca (anche di richieste già approvate): ferie/ROL restituiti, turni tornati alla persona, avvisi
  app.post('/api/sp/admin/richieste/:id/revoca', needAd, wrap(async (req, res) => {
    const nota = str(req.body.nota, 300);
    const { rows } = await q(`update sp_richieste set stato = 'revocata', decisa_il = now(), decisa_da = $2, nota_admin = $3,
        doc_stato = case when doc_stato = 'attesa' then '' else doc_stato end
      where id = $1 and stato in ('attesa_sost','attesa_admin','approvata') returning ${RCOLS}`, [req.params.id, req.user.email, nota]);
    if (!rows[0]) return bad(res, 400, 'Questa richiesta non si può revocare (forse è già rifiutata, annullata o revocata).');
    const r = rows[0];
    // ferie e ROL scalati all'approvazione tornano indietro
    await q(`update sp_movimenti set annullato = true where rif = $1 and not annullato`, ['rich:' + r.id]);
    // i turni passati al sostituto tornano alla persona (solo quelli spostati da questa richiesta)
    let turniTornati = 0;
    if (r.sost_id) {
      const p = await personaDi(r.user_id);
      const up = await q(`update sp_turni set user_id = $1, nota = '', aggiornato = now() where user_id = $2 and giorno between $3 and $4 and nota = $5`,
        [r.user_id, r.sost_id, r.dal, r.al, `Sostituisce ${p?.nome || ''}`.slice(0, 120)]);
      turniTornati = up.rowCount;
    }
    avvisa([r.user_id], { title: 'Richiesta revocata', body: `${descRich(r)}: revocata dall'amministrazione${nota ? ' · ' + nota : ''}.`, url: '/?sez=assenze' });
    if (r.sost_id) avvisa([r.sost_id], { title: 'Sostituzione revocata', body: `${descRich(r)}: non serve più la tua sostituzione${turniTornati ? ', i turni sono tornati alla collega o al collega' : ''}.`, url: '/?sez=turni' });
    res.json({ ok: true, turniTornati });
  }));
  app.get('/api/sp/admin/movimenti/:user', needAd, wrap(async (req, res) => {
    const { rows } = await q(`select * from sp_movimenti where user_id = $1 order by data desc, il desc limit 100`, [req.params.user]);
    res.json({ movimenti: rows.map(m => ({ id: m.id, voce: m.voce, tipo: m.tipo, valore: Number(m.valore), data: m.data, causale: m.causale, da: m.da, annullato: m.annullato })) });
  }));
  app.post('/api/sp/admin/movimenti', needAd, wrap(async (req, res) => {
    const b = req.body, voce = b.voce === 'permessi' ? 'permessi' : b.voce === 'ferie' ? 'ferie' : null, tipo = b.tipo === 'saldo' ? 'saldo' : 'delta', v = num(b.valore);
    if (!voce || v === null) return bad(res, 400, 'Indica ferie o permessi e il valore.');
    const p = await personaDi(b.user); if (!p) return bad(res, 400, 'Persona non trovata.');
    await movimento(p.id, voce, tipo, v, isG(b.data) ? b.data : oggi(), str(b.causale, 200) || (tipo === 'saldo' ? 'Saldo impostato dall\'amministrazione' : 'Correzione amministratore'), null, req.user.email);
    res.json({ ok: true });
  }));

  // turni: modifica di un giorno, copia della settimana, turni tipo
  app.put('/api/sp/admin/turni', needAd, wrap(async (req, res) => {
    const b = req.body, giorni = Array.isArray(b.giorni) ? b.giorni.filter(isG).slice(0, 62) : [b.giorno].filter(isG);
    const users = Array.isArray(b.users) ? b.users.map(String).slice(0, 200) : [str(b.user, 64)];
    if (!giorni.length || !users[0]) return bad(res, 400, 'Giorno o persona mancanti.');
    const lista = (Array.isArray(b.turni) ? b.turni : []).slice(0, 3);
    for (const t of lista) if (!isHM(t.da) || !isHM(t.a) || min(t.a) <= min(t.da)) return bad(res, 400, 'Orario del turno non valido.');
    await db.tx(async tq => {
      for (const u of users) for (const g of giorni) {
        await tq('delete from sp_turni where user_id = $1 and giorno = $2', [u, g]);
        for (const t of lista) await tq(`insert into sp_turni (id, user_id, giorno, sede_id, da, a, pausa, nota) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
          [db.newId(), u, g, t.sede || null, t.da, t.a, Math.max(0, Math.min(240, parseInt(t.pausa) || 0)), str(t.nota, 120)]);
      }
    });
    res.json({ ok: true });
  }));
  app.post('/api/sp/admin/turni/copia', needAd, wrap(async (req, res) => {
    const da = str(req.body.da, 10), a = str(req.body.a, 10), users = Array.isArray(req.body.users) ? req.body.users.map(String) : [];
    if (!isG(da) || !isG(a) || !users.length) return bad(res, 400, 'Settimane non valide.');
    const src = await turniDi(da, addG(da, 6), users);
    await db.tx(async tq => {
      await tq('delete from sp_turni where user_id = any($1) and giorno between $2 and $3', [users, a, addG(a, 6)]);
      for (const t of src) {
        const off = Math.round((Date.parse(t.giorno) - Date.parse(da)) / 864e5);
        await tq(`insert into sp_turni (id, user_id, giorno, sede_id, da, a, pausa) values ($1,$2,$3,$4,$5,$6,$7)`, [db.newId(), t.user, addG(a, off), t.sede, t.da, t.a, t.pausa]);
      }
    });
    res.json({ ok: true, copiati: src.length });
  }));
  app.post('/api/sp/admin/turni/avvisa', needAd, wrap(async (req, res) => {
    const m = isM(req.body.mese) ? req.body.mese : oggi().slice(0, 7);
    const g = giorniMese(m), ts = await turniDi(g[0], g[g.length - 1]);
    const chi = [...new Set(ts.map(t => t.user))];
    await avvisa(chi, { title: 'Turni pubblicati', body: `I tuoi turni di ${MESI[+m.slice(5) - 1]} sono pronti.`, url: '/?sez=turni' });
    res.json({ ok: true, persone: chi.length });
  }));
  app.put('/api/sp/admin/preset', needAd, wrap(async (req, res) => {
    const l = (Array.isArray(req.body.preset) ? req.body.preset : []).slice(0, 12);
    for (const p of l) if (!str(p.nome, 40) || !isHM(p.da) || !isHM(p.a) || min(p.a) <= min(p.da)) return bad(res, 400, 'Controlla nome e orari dei turni tipo.');
    await db.tx(async tq => {
      await tq('delete from sp_preset');
      let i = 0; for (const p of l) await tq('insert into sp_preset (id, nome, da, a, pausa, ordine) values ($1,$2,$3,$4,$5,$6)', [db.newId(), str(p.nome, 40), p.da, p.a, Math.max(0, parseInt(p.pausa) || 0), i++]);
    });
    res.json({ ok: true });
  }));

  // sedi e tag NFC (codici 01–15)
  app.get('/api/sp/admin/tag', needAd, wrap(async (req, res) => {
    const { rows } = await q('select * from sp_tag order by cod');
    res.json({ tag: rows.map(t => ({ cod: t.cod, sede: t.sede_id, protetto: t.protetto, uid: t.uid ? '••' + t.uid.slice(-4) : '', ultima: t.ultima, nota: t.nota })),
      sedi: (await sch.sedi()).map(x => ({ id: x.id, nome: x.nome })), chiaveFabbrica: sun.chiaveDiFabbrica() });
  }));
  app.put('/api/sp/admin/tag/:cod', needAd, wrap(async (req, res) => {
    const cod = codTag(req.params.cod);
    if (!cod) return bad(res, 400, 'Codice non valido.');
    const ss = new Set((await sch.sedi()).map(s => s.id));
    const sede = ss.has(req.body.sede) ? req.body.sede : null;
    await q(`insert into sp_tag (cod, sede_id, nota) values ($1,$2,$3) on conflict (cod) do update set sede_id = excluded.sede_id, nota = excluded.nota`, [cod, sede, str(req.body.nota, 100)]);
    if (req.body.reimposta) await q('update sp_tag set uid = null, protetto = false, ctr = -1 where cod = $1', [cod]);
    res.json({ ok: true });
  }));

  // documenti: buste paga e CU divise per codice fiscale, contratti e altri per persona
  app.get('/api/sp/admin/doc', needAd, wrap(async (req, res) => {
    const { rows } = await q(`select id, user_id, tipo, periodo, titolo, pagine, stato, saldi, origine, pagina, suggerito, caricato, pubblicato, visto, ricevuto, firmato, firma_disp, firma_impronta
      from sp_docs where stato not in ('ritirato','unita') order by periodo desc, caricato desc limit 600`);
    const pp = await persone();
    res.json({ docs: rows, cifra: cifraOk(), persone: pp.map(p => ({ id: p.id, nome: p.nome, haCf: !!p.cf, tipo: p.tipo, ore: p.ore })) });
  }));
  const titoloDi = (tipo, periodo) => tipo === 'cu' ? `CU ${periodo} (redditi ${+periodo - 1})` : `Busta paga di ${MESI[+periodo.slice(5, 7) - 1]} ${periodo.slice(0, 4)}`;
  app.post('/api/sp/admin/doc/carica', needAd, upload.single('file'), wrap(async (req, res) => {
    if (!cifraOk()) return bad(res, 400, 'Manca la chiave di cifratura dei documenti su Render.');
    const tipo = req.body.tipo === 'cu' ? 'cu' : 'busta', periodo = str(req.body.periodo, 7);
    if (tipo === 'busta' ? !isM(periodo) : !/^20\d{2}$/.test(periodo)) return bad(res, 400, tipo === 'cu' ? 'Indica l\'anno della CU.' : 'Indica il mese della busta paga.');
    const f = req.file; if (!f || !/pdf/i.test(f.mimetype + f.originalname)) return bad(res, 400, 'Carica il PDF.');
    const pp = await persone();
    const div = await buste.dividi(f.buffer, pp.map(p => ({ id: p.id, cf: p.cf })));
    const origine = str(f.originalname, 120), creati = [];
    for (const g of div.gruppi) {
      const c = cifra(g.buf), id = db.newId();
      await q(`insert into sp_docs (id, user_id, tipo, periodo, titolo, file, iv, tag, impronta, pagine, stato, origine, da) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'bozza',$11,$12)`,
        [id, g.staffId, tipo, periodo, titoloDi(tipo, periodo), c.file, c.iv, c.tag, buste.impronta(g.buf), g.pagine.length, origine, req.user.email]);
      if (tipo === 'busta') creati.push({ id, testo: g.testo, togli: (pp.find(p => p.id === g.staffId)?.nome || '').split(' ').filter(x => x.length > 2) });
    }
    for (const s of div.sospese) {
      const c = cifra(s.buf);
      await q(`insert into sp_docs (id, user_id, tipo, periodo, titolo, file, iv, tag, impronta, pagine, stato, origine, pagina, suggerito, da) values ($1,null,$2,$3,$4,$5,$6,$7,$8,1,'sospesa',$9,$10,$11,$12)`,
        [db.newId(), tipo, periodo, titoloDi(tipo, periodo), c.file, c.iv, c.tag, buste.impronta(s.buf), origine, s.pagina + 1, s.suggerito, req.user.email]);
    }
    // residui di ferie e permessi letti dal cedolino, senza far aspettare
    if (creati.length) saldiCedolino.leggiTutte(creati, (id, s) => q('update sp_docs set saldi = $2 where id = $1', [id, JSON.stringify(s)])).catch(e => console.warn('Scheda, residui:', e.message));
    res.json({ pagine: div.pagine, divise: div.gruppi.length, sospese: div.sospese.length });
  }));
  app.post('/api/sp/admin/doc/:id/assegna', needAd, wrap(async (req, res) => {
    const p = await personaDi(req.body.user); if (!p) return bad(res, 400, 'Scegli la persona.');
    const { rows } = await q(`select * from sp_docs where id = $1 and stato = 'sospesa'`, [req.params.id]);
    const s = rows[0]; if (!s) return bad(res, 400, 'Pagina già assegnata.');
    // se la persona ha già una busta dello stesso periodo in bozza, la pagina si aggiunge in fondo
    const { rows: gia } = await q(`select * from sp_docs where user_id = $1 and tipo = $2 and periodo = $3 and stato = 'bozza' limit 1`, [p.id, s.tipo, s.periodo]);
    if (gia[0]) {
      const unito = await buste.unisci([decifra(gia[0]), decifra(s)]), c = cifra(unito);
      await q('update sp_docs set file = $2, iv = $3, tag = $4, impronta = $5, pagine = pagine + 1 where id = $1', [gia[0].id, c.file, c.iv, c.tag, buste.impronta(unito)]);
      await q(`update sp_docs set stato = 'unita', user_id = $2 where id = $1`, [s.id, p.id]);
    } else await q(`update sp_docs set user_id = $2, stato = 'bozza' where id = $1`, [s.id, p.id]);
    res.json({ ok: true });
  }));
  app.put('/api/sp/admin/doc/:id/saldi', needAd, wrap(async (req, res) => {
    const v = x => { const n = num(x); return n === null ? null : r2(n); };
    const s = { ferie: { residuo: v(req.body.ferie), unita: 'giorni' }, rol: { residuo: v(req.body.permessi), unita: 'ore' }, exfest: { residuo: null, unita: null }, manuale: true, letto: new Date().toISOString() };
    await q('update sp_docs set saldi = $2 where id = $1', [req.params.id, JSON.stringify(s)]);
    res.json({ ok: true });
  }));
  // da busta paga a saldo: ferie in giorni, permessi (ROL + ex festività) in ore
  function saldoDaBusta(s, p) {
    if (!s) return null;
    const og = oreGiorno(p);
    const conv = (v, voglio) => { if (!v || v.residuo == null) return null; if (!v.unita || v.unita === voglio) return v.residuo; if (!og) return null; return voglio === 'giorni' ? v.residuo / og : v.residuo * og; };
    const f = conv(s.ferie, 'giorni'), r = conv(s.rol, 'ore'), e = conv(s.exfest, 'ore');
    return { ferie: f == null ? null : r2(f), permessi: r == null && e == null ? null : r2((r || 0) + (e || 0)) };
  }
  app.post('/api/sp/admin/doc/pubblica', needAd, wrap(async (req, res) => {
    const tipo = req.body.tipo === 'cu' ? 'cu' : 'busta', periodo = str(req.body.periodo, 7);
    const { rows } = await q(`update sp_docs set stato = 'pubblicato', pubblicato = now() where tipo = $1 and periodo = $2 and stato = 'bozza' and user_id is not null returning id, user_id, saldi`, [tipo, periodo]);
    const pp = await persone();
    let saldiAgg = 0;
    if (tipo === 'busta') for (const d of rows) {
      const p = pp.find(x => x.id === d.user_id); if (!p || !isDip(p)) continue;
      const s = saldoDaBusta(d.saldi, p); if (!s) continue;
      const data = fineMese(periodo), caus = `Saldo dalla busta paga di ${MESI[+periodo.slice(5) - 1]} ${periodo.slice(0, 4)}`;
      if (s.ferie != null) { await movimento(p.id, 'ferie', 'saldo', s.ferie, data, caus, 'doc:' + d.id, req.user.email); saldiAgg++; }
      if (s.permessi != null) await movimento(p.id, 'permessi', 'saldo', s.permessi, data, caus, 'doc:' + d.id, req.user.email);
    }
    await avvisa(rows.map(d => d.user_id), { title: tipo === 'cu' ? 'CU disponibile' : 'Nuova busta paga', body: `${titoloDi(tipo, periodo)}: la trovi in Documenti.`, url: '/?sez=doc' });
    res.json({ ok: true, pubblicati: rows.length, saldi: saldiAgg });
  }));
  // togliere una bozza o ritirare un documento: resta archiviato, non si cancella
  app.post('/api/sp/admin/doc/:id/ritira', needAd, wrap(async (req, res) => {
    await q(`update sp_docs set stato = 'ritirato' where id = $1`, [req.params.id]);
    res.json({ ok: true });
  }));
  app.post('/api/sp/admin/doc/persona', needAd, upload.single('file'), wrap(async (req, res) => {
    if (!cifraOk()) return bad(res, 400, 'Manca la chiave di cifratura dei documenti su Render.');
    const p = await personaDi(req.body.user); if (!p) return bad(res, 400, 'Scegli la persona.');
    const f = req.file; if (!f || !/pdf/i.test(f.mimetype + f.originalname)) return bad(res, 400, 'Carica un PDF.');
    const tipo = req.body.tipo === 'contratto' ? 'contratto' : 'altro';
    const titolo = str(req.body.titolo, 120) || (tipo === 'contratto' ? 'Contratto di lavoro' : f.originalname.replace(/\.pdf$/i, ''));
    const c = cifra(f.buffer);
    await q(`insert into sp_docs (id, user_id, tipo, periodo, titolo, file, iv, tag, impronta, stato, pubblicato, origine, da) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'pubblicato',now(),$10,$11)`,
      [db.newId(), p.id, tipo, oggi(), titolo, c.file, c.iv, c.tag, buste.impronta(f.buffer), str(f.originalname, 120), req.user.email]);
    avvisa([p.id], { title: 'Nuovo documento', body: `${titolo}: lo trovi in Documenti.`, url: '/?sez=doc' });
    res.json({ ok: true });
  }));

  // performance: piani di carriera, ruoli, pass
  app.get('/api/sp/admin/perf', needAd, wrap(async (req, res) => {
    const pp = await persone(), nomi = new Map(pp.map(p => [p.id, p.nome]));
    const [piani, { rows: as }, { rows: dati }, { rows: pas }] = await Promise.all([
      struttura(), q('select * from sp_perf'),
      q(`select d.*, o.testo from sp_perf_dati d join sp_obiettivi o on o.id = d.obiettivo_id where d.stato = 'verifica' order by d.il`),
      q(`select * from sp_passaggi where stato = 'attesa' order by il`),
    ]);
    const persone2 = [];
    for (const p of pp.filter(x => !x.medico)) {
      const a = as.find(x => x.user_id === p.id);
      persone2.push({ id: p.id, nome: p.nome, figura: p.figura, sedi: p.sedi, piano: a?.piano_id || null, livello: a?.livello_n ?? null, stato: a ? await perfUtente(p.id, p) : null });
    }
    res.json({ piani, persone: persone2, regole: (await sch.imp('sp_regole')) || '', mese: meseScorso(), finAzienda: (await sch.imp('sp_fin_azienda')) || null,
      sediNomi: Object.fromEntries((await sch.sedi()).map(x => [x.id, x.nome])),
      dati: dati.map(d => ({ id: d.id, nome: nomi.get(d.user_id) || '', obiettivo: d.testo, dato: d.dato, il: d.il })),
      passaggi: pas.map(x => { const pi = piani.find(y => y.id === x.piano_id); return { id: x.id, nome: nomi.get(x.user_id) || '', da: pi?.livelli.find(l => l.n === x.da_n)?.ruolo || '', a: pi?.livelli.find(l => l.n === x.a_n)?.ruolo || '', bonus: pi?.livelli.find(l => l.n === x.a_n)?.bonus || '' }; }) });
  }));
  // incentivi: azienda di Gestione finanziaria da cui prendere il consuntivo, e calcolo per un mese
  app.get('/api/sp/admin/finanza/aziende', needAd, wrap(async (req, res) => {
    try { res.json({ aziende: (await finanza('/api/_appgestione/aziende')).aziende, scelta: (await sch.imp('sp_fin_azienda')) || null }); }
    catch (e) { bad(res, 502, e.message); }
  }));
  app.put('/api/sp/admin/finanza/azienda', needAd, wrap(async (req, res) => { await sch.setImp('sp_fin_azienda', str(req.body.azienda, 64) || null); finCache.clear(); res.json({ ok: true }); }));
  app.get('/api/sp/admin/incentivi', needAd, wrap(async (req, res) => {
    const mese = /^\d{4}-\d{2}$/.test(req.query.mese || '') ? req.query.mese : meseScorso();
    const pp = await persone(), piani = await struttura(), { rows: as } = await q('select * from sp_perf');
    const righe = [];
    for (const a of as) {
      const p = pp.find(x => x.id === a.user_id); if (!p) continue;
      const pi = piani.find(x => x.id === a.piano_id), l = pi?.livelli.find(x => x.n === a.livello_n);
      righe.push({ id: p.id, nome: p.nome, ruolo: l?.ruolo || '', ...(await incentivo(l, p.sedi, mese)) });
    }
    righe.sort((x, y) => x.nome.localeCompare(y.nome, 'it'));
    res.json({ mese, righe, totale: righe.reduce((t, r) => t + (r.valore || 0), 0) });
  }));
  /* ---------- piani da Excel: anteprima e sostituzione dei piani attuali ---------- */
  const PX = require('./lib/pianoExcel');
  async function leggiPianiExcel(files) {
    if (!files?.length) throw Object.assign(new Error('Scegli i file Excel dei piani (.xlsx).'), { status: 400 });
    const piani = [];
    for (const f of files.slice(0, 4)) piani.push(await PX.leggi(f.buffer, String(f.originalname || 'piano.xlsx')));
    const doppi = piani.map(p => p.contratto).filter((c, i, a) => c && a.indexOf(c) !== i);
    if (doppi.length) throw Object.assign(new Error('Hai scelto due file per lo stesso contratto: carica un file CCNL e uno Partita IVA.'), { status: 400 });
    return piani;
  }
  // modi di caricamento per ogni file: { file: 'nuovo' | <id del piano da sostituire> }
  // Chi va dove: per un piano che ne sostituisce un altro, le persone di quel piano (stesso ruolo, se c'è);
  // per un piano nuovo, le persone del suo contratto che oggi non hanno un piano (primo ruolo della loro figura).
  async function mappaPersone(piani, modi = {}) {
    const pp = (await persone()).filter(p => !p.medico && !p.owner), vecchi = await struttura(), { rows: as } = await q('select * from sp_perf');
    const out = [];
    for (const p of pp) {
      const a = as.find(x => x.user_id === p.id), vp = a && vecchi.find(x => x.id === a.piano_id), vl = vp?.livelli.find(x => x.n === a.livello_n);
      // in quale piano del file può andare
      let np = piani.find(x => vp && modi[x.file] === vp.id);
      if (!np && !vp) np = piani.find(x => (modi[x.file] || 'nuovo') === 'nuovo' && x.contratto && x.contratto === p.tipo);
      if (!np) continue;
      const N = l => PX.normRuolo(l.ruolo);
      let li = -1;
      if (vl) li = np.livelli.findIndex(l => N(l) === PX.normRuolo(vl.ruolo));
      if (li < 0 && vl) li = np.livelli.findIndex(l => N(l).startsWith(PX.normRuolo(vl.ruolo) + ' '));
      if (li < 0 && p.figura) li = np.livelli.findIndex(l => N(l) === PX.normRuolo(p.figura) || N(l).startsWith(PX.normRuolo(p.figura) + ' '));
      out.push({ id: p.id, nome: p.nome, contratto: p.tipo || '', figura: p.figura || '', da: vl ? `${vp.nome} · ${vl.ruolo}` : '', file: np.file, livello: li >= 0 ? li + 1 : null,
        a: li >= 0 ? `${np.nome} · ${np.livelli[li].ruolo}` : '' });
    }
    return out.sort((x, y) => x.nome.localeCompare(y.nome, 'it'));
  }
  app.post('/api/sp/admin/piani/excel/anteprima', needAd, upload.array('file', 4), wrap(async (req, res) => {
    const piani = await leggiPianiExcel(req.files), esistenti = await struttura();
    // proposta: se c'è già un piano dello stesso contratto (o con lo stesso nome) lo sostituisce, altrimenti si aggiunge
    let modi = {}; try { modi = JSON.parse(req.body.modi || 'null') || {}; } catch {}
    for (const p of piani) if (!modi[p.file]) { const e = esistenti.find(x => (p.contratto && x.contratto === p.contratto) || x.nome.trim().toLowerCase() === p.nome.toLowerCase()); modi[p.file] = e ? e.id : 'nuovo'; }
    res.json({ piani: piani.map(p => ({ ...p, livelli: p.livelli.map(l => ({ ...l, regole: l.regole.map(r => ({ ...r, spiega: PX.spiega(r) })) })) })), modi,
      esistenti: esistenti.map(x => ({ id: x.id, nome: x.nome || 'Senza nome', contratto: x.contratto })), persone: await mappaPersone(piani, modi) });
  }));
  // conferma: i piani di adesso si archiviano (le prove già inviate restano), si creano quelli del file e si assegnano le persone
  // conferma: ogni file si aggiunge come piano nuovo oppure sostituisce un piano (stesso piano, livelli e obiettivi nuovi;
  // quelli di prima si archiviano, le prove già inviate restano). Poi si assegnano le persone scelte nell'anteprima.
  app.post('/api/sp/admin/piani/excel/conferma', needAd, upload.array('file', 4), wrap(async (req, res) => {
    const piani = await leggiPianiExcel(req.files), esistenti = await struttura();
    const J = k => { try { return JSON.parse(req.body[k] || '{}') || {}; } catch { return {}; } };
    const modi = J('modi'), scelte = J('scelte');
    const ids = {};
    await db.tx(async tq => {
      let ord = esistenti.length;
      for (const p of piani) {
        const sost = esistenti.find(x => x.id === modi[p.file]);
        const pid = sost ? sost.id : db.newId(); ids[p.file] = pid;
        if (sost) {
          await tq('update sp_piani set nome = $2, contratto = $3, fonte = $4, intestazioni = $5, note = $6, archiviato = false where id = $1', [pid, p.nome, p.contratto, p.file.slice(0, 200), JSON.stringify(p.intestazioni), p.note.slice(0, 20000)]);
          await tq('update sp_obiettivi set archiviato = true where livello_id in (select id from sp_livelli where piano_id = $1)', [pid]);
          await tq('update sp_livelli set archiviato = true where piano_id = $1', [pid]);
        } else await tq('insert into sp_piani (id, nome, ordine, contratto, fonte, intestazioni, note) values ($1,$2,$3,$4,$5,$6,$7)',
          [pid, p.nome, ord++, p.contratto, p.file.slice(0, 200), JSON.stringify(p.intestazioni), p.note.slice(0, 20000)]);
        let n = 1;
        for (const l of p.livelli) {
          const lid = db.newId();
          await tq(`insert into sp_livelli (id, piano_id, n, ruolo, fisso, fisso_num, variabile, regole, fisso_cond) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
            [lid, pid, n++, l.ruolo.slice(0, 80), l.fisso.slice(0, 160), l.fissoNum, l.variabile.slice(0, 4000), JSON.stringify(l.regole), l.fissoCond || '']);
          let oi = 0;
          for (const o of l.obiettivi) await tq(`insert into sp_obiettivi (id, livello_id, testo, ordine, sotto, soft, scuola, r_fisso, r_variabile, test) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
            [db.newId(), lid, (o.testo || '—').slice(0, 400), oi++, o.sotto.slice(0, 8000), o.soft.slice(0, 2000), o.scuola.slice(0, 2000), o.fisso.slice(0, 200), o.variabile.slice(0, 4000), o.test]);
        }
      }
      // assegnazioni scelte nell'anteprima: { persona: { file, livello } } (file vuoto = lascia com'è)
      for (const [uid, sc] of Object.entries(scelte)) {
        const pid = ids[sc?.file], lv = parseInt(sc?.livello);
        if (!pid || !(lv >= 1)) continue;
        await tq(`insert into sp_perf (user_id, piano_id, livello_n, dal) values ($1,$2,$3,current_date)
          on conflict (user_id) do update set piano_id = excluded.piano_id, livello_n = excluded.livello_n, dal = current_date, test_invio = null, fisso_man = null, variabile_man = null`, [str(uid, 64), pid, lv]);
      }
    });
    res.json({ ok: true, piani: piani.length });
  }));

  // un solo piano: crea / salva (livelli e obiettivi con sotto-obiettivi, soft skill, scuola). Gli altri piani non si toccano.
  app.put('/api/sp/admin/piano/:id', needAd, wrap(async (req, res) => {
    const p = req.body || {}, nome = str(p.nome, 80); if (!nome) return bad(res, 400, 'Scrivi il nome del piano.');
    const liv = (Array.isArray(p.livelli) ? p.livelli : []).filter(l => str(l.ruolo, 80)).slice(0, 20);
    if (!liv.length) return bad(res, 400, 'Serve almeno un livello con il nome del ruolo.');
    const esiste = (await q('select id from sp_piani where id = $1', [str(req.params.id, 64)])).rows[0];
    const pid = esiste ? esiste.id : db.newId();
    const t = (v, max) => String(v ?? '').replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').trim().slice(0, max);
    await db.tx(async tq => {
      if (esiste) await tq('update sp_piani set nome = $2, contratto = $3, archiviato = false where id = $1', [pid, nome, ['dip', 'piva'].includes(p.contratto) ? p.contratto : '']);
      else await tq(`insert into sp_piani (id, nome, ordine, contratto, intestazioni) values ($1,$2,(select coalesce(max(ordine),0)+1 from sp_piani),$3,$4)`,
        [pid, nome, ['dip', 'piva'].includes(p.contratto) ? p.contratto : '', JSON.stringify(['RUOLO', 'FISSO EURO', 'VARIABILE', 'OBIETTIVI (HARD SKILL)', 'SOTTO OBIETTIVI', 'SOFT SKILL', 'SCUOLA DI FORMAZIONE'])]);
      // fonte segna i piani «nuovi» (percorso sul livello attuale, guadagni): anche quelli creati qui
      await tq(`update sp_piani set fonte = coalesce(nullif(fonte, ''), 'Creato nell''app') where id = $1`, [pid]);
      const vivi = { l: [], o: [] };
      let n = 1;
      for (const l of liv) {
        const lid = /^[\w-]{6,64}$/.test(l.id || '') ? l.id : db.newId(); vivi.l.push(lid);
        const variabile = t(l.variabile, 4000), fisso = str(l.fisso, 160);
        await tq(`insert into sp_livelli (id, piano_id, n, ruolo, fisso, fisso_num, variabile, regole, fisso_cond) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
          on conflict (id) do update set piano_id = excluded.piano_id, n = excluded.n, ruolo = excluded.ruolo, fisso = excluded.fisso, fisso_num = excluded.fisso_num,
          variabile = excluded.variabile, regole = excluded.regole, fisso_cond = excluded.fisso_cond, archiviato = false`,
          [lid, pid, n++, str(l.ruolo, 80), fisso, PX.numero(fisso), variabile, JSON.stringify(PX.regoleDa(variabile)), l.fissoCond === 'senza_target_pers' ? 'senza_target_pers' : '']);
        let oi = 0;
        for (const o of (Array.isArray(l.obiettivi) ? l.obiettivi : []).slice(0, 40)) {
          const testo = str(o.testo, 400); if (!testo) continue;
          const oid = /^[\w-]{6,64}$/.test(o.id || '') ? o.id : db.newId(); vivi.o.push(oid);
          await tq(`insert into sp_obiettivi (id, livello_id, testo, misura, ordine, sotto, soft, scuola, test) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
            on conflict (id) do update set livello_id = excluded.livello_id, testo = excluded.testo, misura = excluded.misura, ordine = excluded.ordine,
            sotto = excluded.sotto, soft = excluded.soft, scuola = excluded.scuola, test = excluded.test, archiviato = false`,
            [oid, lid, testo, str(o.misura, 200), oi++, t(o.sotto, 8000), t(o.soft, 2000), t(o.scuola, 2000), /^superamento del test/i.test(testo)]);
        }
      }
      // livelli e obiettivi tolti da questo piano: archiviati (le prove già inviate restano)
      await tq('update sp_obiettivi set archiviato = true where livello_id in (select id from sp_livelli where piano_id = $1) and not (id = any($2))', [pid, vivi.o]);
      await tq('update sp_livelli set archiviato = true where piano_id = $1 and not (id = any($2))', [pid, vivi.l]);
    });
    res.json({ ok: true, id: pid });
  }));
  // togli un piano: si archivia; le persone assegnate restano senza piano (l'anteprima lo dice prima)
  app.delete('/api/sp/admin/piano/:id', needAd, wrap(async (req, res) => {
    const id = str(req.params.id, 64);
    await q('update sp_piani set archiviato = true where id = $1', [id]);
    res.json({ ok: true });
  }));
  app.put('/api/sp/admin/regole', needAd, wrap(async (req, res) => { await sch.setImp('sp_regole', String(req.body.regole || '').replace(/\r/g, '').slice(0, 12000)); res.json({ ok: true }); }));

  /* ---------- guadagni (amministratore): tabella del mese, accordi per sede, malus, target personale, voci a mano, compenso ---------- */
  app.get('/api/sp/admin/guadagni', needAd, wrap(async (req, res) => {
    const mese = /^\d{4}-\d{2}$/.test(req.query.mese || '') ? req.query.mese : meseOra();
    const pp = await persone(), piani = await struttura(), { rows: as } = await q('select * from sp_perf');
    const righe = [];
    for (const a of as) {
      const p = pp.find(x => x.id === a.user_id), pi = piani.find(x => x.id === a.piano_id); if (!p || !pi?.fonte) continue;
      const l = pi.livelli.find(x => x.n === a.livello_n);
      let d = null; try { d = await guadagni(p.id, mese, p, l, a); } catch (e) { d = { errore: e.message }; }
      righe.push({ id: p.id, nome: p.nome, piano: pi.nome, regole: (l?.regole || []).map(r => ({ ...r, spiega: PX.spiega(r) })),
        fissoLivello: l?.fissoNum ?? null, fissoMan: a.fisso_man != null ? Number(a.fisso_man) : null, variabileMan: a.variabile_man, ...d });
    }
    righe.sort((x, y) => x.nome.localeCompare(y.nome, 'it'));
    const sedi = await sch.sedi(), { rows: acc } = await q('select * from sp_accordi where mese = $1', [mese]);
    res.json({ mese, nomeMese: meseNome(mese), mesi: Array.from({ length: 12 }, (_, i) => meseAdd(meseOra(), -i)), righe,
      accordi: sedi.map(x => { const r = acc.find(y => y.sede_id === x.id); return { id: x.id, nome: x.nome, importo: r ? Number(r.importo) : 0, nota: r?.nota || '' }; }),
      totale: r2(righe.reduce((t, x) => t + (x.totale || 0), 0)), finAzienda: (await sch.imp('sp_fin_azienda')) || null });
  }));
  app.put('/api/sp/admin/accordi', needAd, wrap(async (req, res) => {
    const mese = str(req.body.mese, 7), sede = str(req.body.sede, 60); if (!/^\d{4}-\d{2}$/.test(mese) || !sede) return bad(res, 400, 'Dati non validi.');
    const imp = Number(String(req.body.importo ?? '').replace(/\s|€/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
    if (!isFinite(imp) || imp < 0) return bad(res, 400, 'Importo non valido.');
    await q(`insert into sp_accordi (sede_id, mese, importo, nota, aggiornato) values ($1,$2,$3,$4,now()) on conflict (sede_id, mese) do update set importo = excluded.importo, nota = excluded.nota, aggiornato = now()`,
      [sede, mese, r2(imp), str(req.body.nota, 300)]);
    res.json({ ok: true });
  }));
  app.put('/api/sp/admin/mese/:uid', needAd, wrap(async (req, res) => {
    const mese = str(req.body.mese, 7), uid = str(req.params.uid, 64); if (!/^\d{4}-\d{2}$/.test(mese)) return bad(res, 400, 'Mese non valido.');
    const b = req.body, malus = !!b.malus, nota = str(b.malusNota, 500);
    if (malus && !nota) return bad(res, 400, 'Scrivi il motivo del malus: lo legge la persona.');
    const tp = b.targetPerc === '' || b.targetPerc == null ? null : Number(String(b.targetPerc).replace(',', '.'));
    if (tp != null && !(tp >= 0 && tp <= 100)) return bad(res, 400, 'Target personale: una percentuale da 0 a 100.');
    const man = {}; for (const [k, v] of Object.entries(b.manuali || {})) { const n = Number(String(v ?? '').replace(/\s|€/g, '').replace(',', '.')); if (/^r\d+$/.test(k) && isFinite(n) && n >= 0) man[k] = r2(n); }
    const me = await io(req);
    await q(`insert into sp_mese (user_id, mese, malus, malus_nota, target_perc, manuali, aggiornato, da) values ($1,$2,$3,$4,$5,$6,now(),$7)
      on conflict (user_id, mese) do update set malus = excluded.malus, malus_nota = excluded.malus_nota, target_perc = excluded.target_perc, manuali = excluded.manuali, aggiornato = now(), da = excluded.da`,
      [uid, mese, malus, malus ? nota : '', tp, JSON.stringify(man), me.nome]);
    if (malus) avvisa([uid], { title: 'Malus del mese', body: `${meseNome(mese)}: ${nota}`.slice(0, 160), url: '/?sez=perf' });
    res.json({ ok: true });
  }));
  app.put('/api/sp/admin/perf/:uid/compenso', needAd, wrap(async (req, res) => {
    const f = req.body.fisso === '' || req.body.fisso == null ? null : Number(String(req.body.fisso).replace(/\s|€/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.'));
    if (f != null && !(f >= 0)) return bad(res, 400, 'Fisso non valido.');
    const v = req.body.variabile == null || String(req.body.variabile).trim() === '' ? null : String(req.body.variabile).replace(/\r/g, '').trim().slice(0, 3000);
    const { rowCount } = await q('update sp_perf set fisso_man = $2, variabile_man = $3 where user_id = $1', [str(req.params.uid, 64), f, v]);
    if (!rowCount) return bad(res, 400, 'La persona non è in un piano.');
    res.json({ ok: true });
  }));

  // piano di crescita ufficiale To Smile (dal documento): si carica nell'editor, poi lo salva l'amministratore
  app.get('/api/sp/admin/piani/modello', needAd, (req, res) => res.json(require('./data/piano-crescita-2025.json')));
  app.put('/api/sp/admin/piani', needAd, wrap(async (req, res) => {
    const piani = (Array.isArray(req.body.piani) ? req.body.piani : []).slice(0, 30);
    await db.tx(async tq => {
      const vivi = { p: [], l: [], o: [] };
      let pi = 0;
      for (const p of piani) {
        const nome = str(p.nome, 80); if (!nome) continue;
        const pid = /^[\w-]{6,64}$/.test(p.id || '') ? p.id : db.newId(); vivi.p.push(pid);
        await tq(`insert into sp_piani (id, nome, ordine) values ($1,$2,$3) on conflict (id) do update set nome = excluded.nome, ordine = excluded.ordine, archiviato = false`, [pid, nome, pi++]);
        let n = 1;
        for (const l of (Array.isArray(p.livelli) ? p.livelli : []).slice(0, 15)) {
          const ruolo = str(l.ruolo, 80); if (!ruolo) continue;
          const lid = /^[\w-]{6,64}$/.test(l.id || '') ? l.id : db.newId(); vivi.l.push(lid);
          const testo = (v, max) => String(v ?? '').replace(/\r/g, '').split('\n').map(x => x.replace(/\s+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, max);
          const skill = (Array.isArray(l.skill) ? l.skill : String(l.skill || '').split('\n')).map(x => str(x, 300)).filter(Boolean).slice(0, 25);
          const perc = l.incPerc === '' || l.incPerc == null ? null : Number(String(l.incPerc).replace(',', '.'));
          await tq(`insert into sp_livelli (id, piano_id, n, ruolo, bonus, fisso, variabile, area, skill, inc_perc, inc_soglia) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
              on conflict (id) do update set piano_id = excluded.piano_id, n = excluded.n, ruolo = excluded.ruolo, bonus = excluded.bonus,
              fisso = excluded.fisso, variabile = excluded.variabile, area = excluded.area, skill = excluded.skill, inc_perc = excluded.inc_perc, inc_soglia = excluded.inc_soglia, archiviato = false`,
            [lid, pid, n++, ruolo, str(l.bonus, 120), str(l.fisso, 160), testo(l.variabile, 2000), testo(l.area, 600), JSON.stringify(skill),
             perc != null && perc >= 0 && perc <= 100 ? perc : null, l.incSoglia === 'sempre' ? 'sempre' : 'target']);
          let oi = 0;
          for (const o of (Array.isArray(l.obiettivi) ? l.obiettivi : []).slice(0, 20)) {
            const testoO = str(o.testo, 400); if (!testoO) continue;
            const oid = /^[\w-]{6,64}$/.test(o.id || '') ? o.id : db.newId(); vivi.o.push(oid);
            await tq(`insert into sp_obiettivi (id, livello_id, testo, misura, ordine) values ($1,$2,$3,$4,$5) on conflict (id) do update set livello_id = excluded.livello_id, testo = excluded.testo, misura = excluded.misura, ordine = excluded.ordine, archiviato = false`,
              [oid, lid, testoO, str(o.misura, 200), oi++]);
          }
        }
      }
      if (typeof req.body.regole === 'string') await sch.setImp('sp_regole', String(req.body.regole).replace(/\r/g, '').slice(0, 12000));
      // quello che non c'è più si archivia (i dati inviati dalle persone restano)
      await tq('update sp_piani set archiviato = true where not (id = any($1))', [vivi.p]);
      await tq('update sp_livelli set archiviato = true where not (id = any($1))', [vivi.l]);
      await tq('update sp_obiettivi set archiviato = true where not (id = any($1))', [vivi.o]);
    });
    res.json({ ok: true });
  }));
  // assegna (o toglie) il ruolo del piano di crescita: usato qui e da Gestione accessi
  async function assegna(uid, pid, livello) {
    await migrate();
    if (!pid) { await q('delete from sp_perf where user_id = $1', [uid]); return { ok: true }; }
    const p = (await struttura()).find(x => x.id === pid); if (!p) throw Object.assign(new Error('Piano non trovato.'), { status: 400 });
    const n = p.livelli.some(l => l.n === parseInt(livello)) ? parseInt(livello) : p.livelli[0]?.n || 1;
    const { rows: [prima] } = await q('select piano_id, livello_n from sp_perf where user_id = $1', [uid]);
    if (prima && prima.piano_id === pid && prima.livello_n === n) return { ok: true, ruolo: p.livelli.find(l => l.n === n)?.ruolo };
    await q(`insert into sp_perf (user_id, piano_id, livello_n, dal) values ($1,$2,$3,current_date) on conflict (user_id) do update set piano_id = excluded.piano_id, livello_n = excluded.livello_n, dal = current_date, test_invio = null,
      fisso_man = case when sp_perf.piano_id = excluded.piano_id and sp_perf.livello_n = excluded.livello_n then sp_perf.fisso_man end,
      variabile_man = case when sp_perf.piano_id = excluded.piano_id and sp_perf.livello_n = excluded.livello_n then sp_perf.variabile_man end`, [uid, pid, n]);
    await q(`update sp_passaggi set stato = 'superato' where user_id = $1 and stato = 'attesa'`, [uid]);
    return { ok: true, ruolo: p.livelli.find(l => l.n === n)?.ruolo };
  }
  app.put('/api/sp/admin/perf/:user', needAd, wrap(async (req, res) => {
    try { res.json(await assegna(req.params.user, str(req.body.piano, 64), req.body.livello)); } catch (e) { if (e.status) return bad(res, e.status, e.message); throw e; }
  }));
  app.post('/api/sp/admin/perf/dato/:id', needAd, wrap(async (req, res) => {
    const ok = !!req.body.ok;
    const { rows } = await q(`update sp_perf_dati set stato = $2, nota = $3, deciso_il = now() where id = $1 and stato = 'verifica' returning *`, [req.params.id, ok ? 'pass' : 'no', str(req.body.nota, 300)]);
    if (!rows[0]) return bad(res, 400, 'Già valutato.');
    const uid = rows[0].user_id, st = await perfUtente(uid);
    avvisa([uid], { title: ok ? 'Pass ottenuto' : 'Prova non approvata', body: ok ? 'Un obiettivo della tua performance è stato approvato.' : 'Una tua prova non è stata approvata: puoi caricarne un’altra.', url: '/?sez=perf' });
    // tutti i pass: la persona può generare il test; superato il test, il passaggio arriva qui da approvare
    if (st && st.test?.disponibile) avvisa([uid], { title: 'Tutti i pass!', body: `Puoi generare il test per diventare ${st.prossimo.ruolo}.`, url: '/?sez=perf' });
    res.json({ ok: true });
  }));
  // passaggio di ruolo (dopo il test superato): approvato → la persona sale di livello e, se il nuovo ruolo è una figura, la figura si aggiorna
  async function decidiPassaggio(id, ok, chi) {
    await migrate();
    const { rows } = await q(`update sp_passaggi set stato = $2, deciso_il = now(), deciso_da = $3 where id = $1 and stato = 'attesa' returning *`, [id, ok ? 'approvato' : 'rimandato', chi || '']);
    if (!rows[0]) throw Object.assign(new Error('Già deciso.'), { status: 400 });
    const x = rows[0];
    let ruolo = null;
    if (ok) {
      await q('update sp_perf set livello_n = $2, dal = current_date, test_invio = null, fisso_man = null, variabile_man = null where user_id = $1', [x.user_id, x.a_n]);
      ruolo = (await struttura()).find(p => p.id === x.piano_id)?.livelli.find(l => l.n === x.a_n)?.ruolo || null;
      if (ruolo && crescita.hub.accessi) await crescita.hub.accessi.ruoloCambiato(x.user_id, ruolo).catch(e => console.warn('Piano di crescita, figura:', e.message));
    }
    avvisa([x.user_id], { title: ok ? 'Nuovo ruolo!' : 'Passaggio rimandato', body: ok ? `Il passaggio di ruolo è stato approvato${ruolo ? ': ora sei ' + ruolo : ''}${x.bonus ? ' · bonus: ' + x.bonus : ''}.` : 'Il passaggio di ruolo per ora è rimandato.', url: '/?sez=perf' });
    return { ok: true, ruolo };
  }
  app.post('/api/sp/admin/passaggi/:id', needAd, wrap(async (req, res) => {
    try { res.json(await decidiPassaggio(req.params.id, !!req.body.ok, req.user.email)); } catch (e) { if (e.status) return bad(res, e.status, e.message); throw e; }
  }));

  // per Gestione accessi: piani, ruolo di ognuno e passaggi da approvare
  async function riepilogo() {
    await migrate();
    const [piani, { rows: as }, { rows: pas }] = await Promise.all([struttura(), q('select * from sp_perf'), q(`select * from sp_passaggi where stato = 'attesa' order by il`)]);
    const ruoloDi = (pid, n) => piani.find(p => p.id === pid)?.livelli.find(l => l.n === n)?.ruolo || '';
    return {
      piani: piani.map(p => ({ id: p.id, nome: p.nome, livelli: p.livelli.map(l => ({ n: l.n, ruolo: l.ruolo })) })),
      assegnati: Object.fromEntries(as.map(a => [a.user_id, { piano: a.piano_id, livello: a.livello_n, ruolo: ruoloDi(a.piano_id, a.livello_n), dal: a.dal }])),
      passaggi: pas.map(x => ({ id: x.id, userId: x.user_id, da: ruoloDi(x.piano_id, x.da_n), a: ruoloDi(x.piano_id, x.a_n), bonus: x.bonus || '', il: x.il })),
    };
  }
  crescita.hub.sp = { riepilogo, assegna, decidiPassaggio };

  return { migrate, elaboraMancate };
};
