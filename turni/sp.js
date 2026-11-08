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
      create table if not exists sp_obiettivi (id text primary key, livello_id text not null, testo text not null, misura text not null default '', ordine int not null default 0, archiviato boolean not null default false);
      create table if not exists sp_perf (user_id text primary key, piano_id text not null, livello_n int not null, dal date not null default current_date);
      create table if not exists sp_perf_dati (id text primary key, user_id text not null, obiettivo_id text not null, dato text not null, stato text not null default 'verifica',
        nota text not null default '', il timestamptz not null default now(), deciso_il timestamptz);
      create table if not exists sp_passaggi (id text primary key, user_id text not null, piano_id text not null, da_n int not null, a_n int not null,
        stato text not null default 'attesa', bonus text not null default '', il timestamptz not null default now(), deciso_il timestamptz, deciso_da text);
    `);
    // turni tipo per riempire il calendario in fretta (si cambiano in Turni di lavoro)
    const { rows } = await q('select count(*)::int n from sp_preset');
    if (!rows[0].n) await q(`insert into sp_preset (id, nome, da, a, pausa, ordine) values
      ('giornata','Giornata','09:30','18:30',60,1),('mattina','Mattina','09:30','13:30',0,2),('pomeriggio','Pomeriggio','14:30','18:30',0,3) on conflict do nothing`);
  })().catch(e => { pronto = null; throw e; }));

  /* ---------- persone ---------- */
  const nomeDi = r => `${r.first_name || ''} ${r.last_name || ''}`.trim();
  async function persone() {
    await migrate();
    const { rows } = await store.q(`select u.id, u.first_name, u.last_name, u.figura, u.cf, u.email, u.owner from users u
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
      let sedi = medico ? (mm.get(r.id) || []) : x.sedi;
      if (!medico && !Array.isArray(sedi)) sedi = (await store.sediNote(r.id)).map(e => e.id).filter(Boolean);
      out.push({ id: r.id, nome: nomeDi(r) || r.email, figura: r.figura || '', cf: String(r.cf || '').toUpperCase(), email: r.email, owner: !!r.owner,
        admin: !!r.owner || am.has(r.id), medico, tipo: x.tipo || (medico ? 'piva' : null), tipoOk: !!x.tipo_ok, ore: x.ore_sett != null ? Number(x.ore_sett) : null,
        senzaNfc: !!x.senza_nfc, sedi: sedi || [], onb: !!x.onb });
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
  const TIPI = { ferie: 'Ferie', permesso: 'Permesso', malattia: 'Malattia', altro: 'Altra assenza' };
  const richShape = (r, nomi) => ({ id: r.id, user: r.user_id, nome: nomi?.get(r.user_id) || '', tipo: r.tipo, tipoTxt: TIPI[r.tipo], dal: r.dal, al: r.al, oraDa: r.ora_da, oraA: r.ora_a,
    quanti: r.quanti != null ? Number(r.quanti) : null, sost: r.sost_id, sostNome: nomi?.get(r.sost_id) || '', sostOk: r.sost_ok, stato: r.stato, nota: r.nota, prot: r.prot,
    creata: r.creata, decisaIl: r.decisa_il, notaAdmin: r.nota_admin });
  const descRich = r => r.tipo === 'permesso' ? `${TIPI[r.tipo]} ${fmtG(r.dal)}, ${r.ora_da}–${r.ora_a}` : (r.dal === r.al ? `${TIPI[r.tipo]} ${fmtG(r.dal)}` : `${TIPI[r.tipo]} dal ${fmtG(r.dal)} al ${fmtG(r.al)}`);

  // Approvazione: scala ferie/permessi e passa i turni al sostituto (se quel giorno è libero)
  async function applicaApprovazione(r, chi) {
    const p = await personaDi(r.user_id);
    if (p && isDip(p)) {
      if (r.tipo === 'ferie') await movimento(r.user_id, 'ferie', 'delta', -Number(r.quanti || 0), r.dal, descRich(r), 'rich:' + r.id, chi);
      if (r.tipo === 'permesso') await movimento(r.user_id, 'permessi', 'delta', -Number(r.quanti || 0), r.dal, descRich(r), 'rich:' + r.id, chi);
    }
    if (r.sost_id && ['ferie', 'malattia', 'altro'].includes(r.tipo)) {
      const ts = await turniDi(r.dal, r.al, [r.user_id, r.sost_id]);
      const nome = p?.nome || '';
      for (const t of ts.filter(t => t.user === r.user_id)) {
        if (ts.some(x => x.user === r.sost_id && x.giorno === t.giorno)) continue;
        await q(`update sp_turni set user_id = $2, nota = $3, aggiornato = now() where id = $1`, [t.id, r.sost_id, `Sostituisce ${nome}`.slice(0, 120)]);
      }
    }
  }

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
        if (ric.some(r => r.user_id === uid && r.dal <= g && r.al >= g)) continue;
        const s = (await saldi([uid]))[uid], ore = r2(minuti / 60);
        let esito = 'ingiustificata', valore = null, mov = null;
        if (s.ferie >= 1) { esito = 'ferie'; valore = 1; mov = await movimento(uid, 'ferie', 'delta', -1, g, `Mancata timbratura ${fmtG(g)} (automatico)`, 'manc:' + g, 'automatico'); }
        else if (ore > 0 && s.permessi >= ore) { esito = 'permessi'; valore = ore; mov = await movimento(uid, 'permessi', 'delta', -ore, g, `Mancata timbratura ${fmtG(g)} (automatico)`, 'manc:' + g, 'automatico'); }
        const ins = await q(`insert into sp_mancate (user_id, giorno, esito, valore, mov_id) values ($1,$2,$3,$4,$5) on conflict do nothing`, [uid, g, esito, valore, mov]);
        if (!ins.rowCount && mov) await q('update sp_movimenti set annullato = true where id = $1', [mov]);
        else avvisa([uid], { title: 'Mancata timbratura', body: `${fmtG(g)}: ${esito === 'ferie' ? 'scalato 1 giorno di ferie' : esito === 'permessi' ? `scalate ${ore} ore di permesso` : 'segnata come assenza ingiustificata'}. Se hai lavorato, avvisa l'amministrazione.` });
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
      q(`select * from sp_richieste where user_id = $1 and stato <> 'annullata' order by dal desc limit 40`, [p.id]),
      q(`select * from sp_richieste where sost_id = $1 and stato in ('attesa_sost','attesa_admin') and al >= $2 order by dal`, [p.id, g]),
      q(`select voce, tipo, valore, data, causale from sp_movimenti where user_id = $1 and not annullato order by data desc, il desc limit 30`, [p.id]),
      q(`select id, tipo, periodo, titolo, pubblicato, visto, ricevuto from sp_docs where user_id = $1 and stato = 'pubblicato' order by periodo desc, pubblicato desc`, [p.id]),
      perfUtente(p.id),
    ]);
    const tutti = await persone(), nomi = new Map(tutti.map(x => [x.id, x.nome]));
    const ss = await sch.sedi(), sedeNome = new Map(ss.map(x => [x.id, x.nome]));
    // colleghi per il sostituto: stessa figura e sede in comune per primi
    const colleghi = tutti.filter(x => x.id !== p.id && !x.owner).map(x => ({ id: x.id, nome: x.nome, figura: x.figura,
      vicino: (x.figura === p.figura ? 2 : 0) + (x.sedi.some(s2 => p.sedi.includes(s2)) ? 1 : 0) })).sort((a, b) => b.vicino - a.vicino || a.nome.localeCompare(b.nome));
    const { rows: tags } = await q('select cod, sede_id from sp_tag where sede_id is not null');
    res.json({
      oggi: g, ora: roma().hm,
      me: { id: p.id, nome: p.nome, figura: p.figura, medico: p.medico, admin: req.user.role === 'admin', tipo: p.tipo, tipoOk: p.tipoOk, ore: p.ore, senzaNfc: p.senzaNfc, onb: p.onb,
        sedi: p.sedi.map(id => ({ id, nome: sedeNome.get(id) || '' })) },
      timbrature: tim.map(t => ({ id: t.id, tipo: t.tipo, ora: t.ora, sede: sedeNome.get(t.sede_id) || '', modo: t.modo })),
      saldi: isDip(p) ? s[p.id] : null,
      richieste: mie.map(r => ({ ...richShape(r, nomi), desc: descRich(r) })),
      sostituzioni: sost.map(r => ({ ...richShape(r, nomi), desc: descRich(r) })),
      movimenti: mov.map(m => ({ voce: m.voce, tipo: m.tipo, valore: Number(m.valore), data: m.data, causale: m.causale })),
      colleghi, docs, perf: perfS, sedi: ss.map(x => ({ id: x.id, nome: x.nome })), tagSedi: tags.length,
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
    const { rows } = await q('select tipo_ok from sp_persone where user_id = $1', [req.user.sso_id]);
    if (rows[0]?.tipo_ok) return res.json({ ok: true, bloccato: true });
    const p = await io(req);
    avvisaAdmin({ title: 'Contratto da confermare', body: `${p.nome}: ${tipo === 'dip' ? `dipendente, ${ore} h/settimana` : 'partita IVA'}.`, url: '/?sez=persone' });
    res.json({ ok: true });
  }));

  /* ---------- timbratura ---------- */
  // Il tag NFC apre turni.appgestione.it/nfc/<codice>?e=…&c=… (dati firmati dal tag a ogni lettura)
  async function leggiTag(cod, e, c) {
    const { rows } = await q('select * from sp_tag where cod = $1', [String(cod || '').slice(0, 20)]);
    const t = rows[0];
    if (!t || !t.sede_id) throw Object.assign(new Error('Questo tag non è collegato a nessuna sede. Avvisa l\'amministrazione.'), { status: 400 });
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
    let sede = null, tagCod = null, modo = 'nfc';
    if (b.senzaNfc) {
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
    await q(`insert into sp_timbrature (id, user_id, giorno, ora, tipo, sede_id, modo, tag) values ($1,$2,$3,$4,$5,$6,$7,$8)`, [id, p.id, n.giorno, n.hm, tipo, sede, modo, tagCod]);
    const ss = await sch.sedi();
    res.json({ ok: true, tipo, ora: n.hm, sede: ss.find(s => s.id === sede)?.nome || '' });
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
    const dal = str(b.dal, 10), al = tipo === 'permesso' ? dal : str(b.al || b.dal, 10);
    if (!isG(dal) || !isG(al) || al < dal) return bad(res, 400, 'Controlla le date.');
    let quanti = null, oraDa = null, oraA = null;
    if (tipo === 'permesso') {
      oraDa = str(b.oraDa, 5); oraA = str(b.oraA, 5);
      if (!isHM(oraDa) || !isHM(oraA) || min(oraA) <= min(oraDa)) return bad(res, 400, 'Indica l\'ora di inizio e di fine del permesso.');
      quanti = r2((min(oraA) - min(oraDa)) / 60);
    } else if (tipo === 'ferie') quanti = await contaGiorni(per.id, dal, al);
    const fuoriAdmin = !(admin && b.user);
    if (fuoriAdmin && tipo !== 'malattia' && dal < oggi()) return bad(res, 400, 'Le richieste si fanno per oggi o per i giorni futuri.');
    const sost = str(b.sost, 64) || null;
    if (sost === per.id) return bad(res, 400, 'Il sostituto deve essere un\'altra persona.');
    if (fuoriAdmin && ['ferie', 'permesso'].includes(tipo) && !sost && !per.medico && per.tipo !== 'piva') return bad(res, 400, 'Indica chi ti sostituisce.');
    if (tipo === 'malattia' && fuoriAdmin && !str(b.prot, 40)) return bad(res, 400, 'Scrivi il numero di protocollo del certificato medico.');
    const { rows: sov } = await q(`select 1 from sp_richieste where user_id = $1 and stato in ('attesa_sost','attesa_admin','approvata') and dal <= $3 and al >= $2
      and (tipo <> 'permesso' or $4 <> 'permesso')`, [per.id, dal, al, tipo]);
    if (sov.length) return bad(res, 400, 'Hai già una richiesta per quei giorni.');
    const stato = admin && b.user ? 'approvata' : tipo === 'malattia' ? 'approvata' : sost ? 'attesa_sost' : 'attesa_admin';
    const id = db.newId();
    const { rows } = await q(`insert into sp_richieste (id, user_id, tipo, dal, al, ora_da, ora_a, quanti, sost_id, sost_ok, stato, nota, prot, decisa_il, decisa_da)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15) returning *`,
      [id, per.id, tipo, dal, al, oraDa, oraA, quanti, sost, admin && b.user && sost ? true : null, stato, str(b.nota, 500), str(b.prot, 40),
        stato === 'approvata' ? new Date() : null, stato === 'approvata' ? (admin && b.user ? req.user.email : 'automatico') : null]);
    const r = rows[0];
    if (stato === 'approvata') await applicaApprovazione(r, req.user.email);
    if (tipo === 'malattia' && fuoriAdmin) avvisaAdmin({ title: 'Malattia comunicata', body: `${per.nome}: ${descRich(r).toLowerCase()}.`, url: '/?sez=richieste' });
    if (stato === 'attesa_sost') avvisa([sost], { title: 'Ti chiedono una sostituzione', body: `${per.nome}: ${descRich(r).toLowerCase()}. Accetta o rifiuta nella sezione Assenze.`, url: '/?sez=assenze' });
    if (stato === 'attesa_admin') avvisaAdmin({ title: 'Richiesta da approvare', body: `${per.nome}: ${descRich(r).toLowerCase()}.`, url: '/?sez=richieste' });
    if (admin && b.user) avvisa([per.id], { title: 'Assenza registrata', body: `${descRich(r)} registrata dall'amministrazione.`, url: '/?sez=assenze' });
    let avviso = '';
    if (per.tipo === 'dip' && ['ferie', 'permesso'].includes(tipo)) {
      const s = (await saldi([per.id]))[per.id];
      if (tipo === 'ferie' && s.ferie < quanti) avviso = `Attenzione: hai ${s.ferie} giorni di ferie e ne chiedi ${quanti}.`;
      if (tipo === 'permesso' && s.permessi < quanti) avviso = `Attenzione: hai ${s.permessi} ore di permesso e ne chiedi ${quanti}.`;
    }
    res.json({ ok: true, stato, avviso });
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
    return piani.map(p => ({ id: p.id, nome: p.nome, livelli: liv.filter(l => l.piano_id === p.id).map(l => ({ id: l.id, n: l.n, ruolo: l.ruolo, bonus: l.bonus,
      obiettivi: ob.filter(o => o.livello_id === l.id).map(o => ({ id: o.id, testo: o.testo, misura: o.misura })) })) }));
  }
  async function perfUtente(uid) {
    await migrate();
    const { rows } = await q('select * from sp_perf where user_id = $1', [uid]);
    if (!rows[0]) return null;
    const piano = (await struttura()).find(p => p.id === rows[0].piano_id);
    if (!piano) return null;
    const cur = piano.livelli.find(l => l.n === rows[0].livello_n), next = piano.livelli.find(l => l.n > rows[0].livello_n);
    const { rows: dati } = await q(`select * from sp_perf_dati where user_id = $1 order by il desc`, [uid]);
    const { rows: pas } = await q(`select * from sp_passaggi where user_id = $1 and stato = 'attesa' limit 1`, [uid]);
    const ob = (next?.obiettivi || []).map(o => { const d = dati.find(x => x.obiettivo_id === o.id); return { ...o, stato: d?.stato || 'fare', dato: d?.dato || '', nota: d?.nota || '' }; });
    return { piano: piano.nome, ruolo: cur?.ruolo || '', prossimo: next ? { ruolo: next.ruolo, bonus: next.bonus } : null, obiettivi: ob,
      pass: ob.filter(o => o.stato === 'pass').length, inAttesa: !!pas[0] };
  }
  app.post('/api/sp/perf/dato', needSp, wrap(async (req, res) => {
    const dato = str(req.body.dato, 1000), oid = str(req.body.obiettivo, 64);
    if (!dato) return bad(res, 400, 'Scrivi il risultato raggiunto.');
    const p = await perfUtente(req.user.sso_id);
    const o = p?.obiettivi.find(x => x.id === oid);
    if (!o) return bad(res, 400, 'Obiettivo non trovato.');
    if (o.stato === 'pass' || o.stato === 'verifica') return bad(res, 400, o.stato === 'pass' ? 'Hai già il pass per questo obiettivo.' : 'Il dato è già in verifica.');
    await q('insert into sp_perf_dati (id, user_id, obiettivo_id, dato) values ($1,$2,$3,$4)', [db.newId(), req.user.sso_id, oid, dato]);
    const me = await io(req);
    avvisaAdmin({ title: 'Performance: dato da verificare', body: `${me.nome}: ${o.testo}`.slice(0, 160), url: '/?sez=perf' });
    res.json({ ok: true });
  }));

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
    if ('sedi' in b) { const ok = new Set((await sch.sedi()).map(s => s.id)); add('sedi', JSON.stringify((Array.isArray(b.sedi) ? b.sedi : []).filter(x => ok.has(x)))); }
    if ('conferma' in b) add('tipo_ok', true);
    if (!sets.length) return res.json({ ok: true });
    await q(`insert into sp_persone (user_id) values ($1) on conflict do nothing`, [req.params.id]);
    await q(`update sp_persone set ${sets.join(', ')}, aggiornato = now() where user_id = $1`, vals);
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
      q(`select * from sp_richieste where stato = 'approvata' and al >= $1 and dal <= $2`, [dal, al]),
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
        if (as) { nota = as.tipo === 'permesso' ? `Permesso ${as.ora_da}–${as.ora_a}` : TIPI[as.tipo]; k = 'info'; }
        if (mc) { nota = mc.esito === 'ingiustificata' ? 'Assenza ingiustificata' : `Mancata timbratura · ${mc.esito === 'ferie' ? 'ferie' : 'permessi'} (automatico)`; k = mc.esito === 'ingiustificata' ? 'no' : 'wait'; }
        if (!nota && mturni.length && !mt.length) { nota = g < oggi() ? 'Nessuna timbratura' : g === oggi() ? 'Non ancora timbrato' : 'In turno'; k = g < oggi() ? 'no' : 'info'; }
        if (!nota && aperta) { nota = 'Uscita non timbrata'; k = 'wait'; }
        if (!nota && mt.length && !mturni.length) { nota = 'Fuori turno'; k = 'info'; }
        if (!nota) nota = p.tipo === 'piva' ? 'Partita IVA' : 'Regolare';
        righe.push({ user: p.id, giorno: g, nome: p.nome, figura: p.figura, tipo: p.tipo,
          sede: [...new Set(mt.map(t => ss.get(t.sede_id)).concat(mturni.map(t => ss.get(t.sede))).filter(Boolean))].join(', '),
          turno: mturni.map(t => `${t.da}–${t.a}`).join(' + '),
          timbrature: mt.map(t => ({ id: t.id, tipo: t.tipo, ora: t.ora, modo: t.modo, nota: t.nota })), ore: minuti, nota, k, mancata: mc ? mc.esito : null });
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
      let tot = 0; const c = { F: 0, P: 0, M: 0, AI: 0 };
      const celle = g.map(x => {
        const mt = tim.filter(t => t.user_id === p.id && t.giorno === x), mturni = ts.filter(t => t.user === p.id && t.giorno === x);
        const as = ric.find(r => r.user_id === p.id && r.dal <= x && r.al >= x), mc = manc.find(r => r.user_id === p.id && r.giorno === x);
        let ricon = 0;
        for (const t of mturni) {
          let ov = 0; const a = min(t.da), b = min(t.a);
          for (const cp of coppie(mt)) if (cp.in && cp.out) ov += Math.max(0, Math.min(min(cp.out.ora), b) - Math.max(min(cp.in.ora), a));
          ricon += Math.min(ov, durata(t));
        }
        tot += ricon;
        let cod = '';
        if (mc) { cod = mc.esito === 'ferie' ? 'F*' : mc.esito === 'permessi' ? 'P*' : 'AI'; c[mc.esito === 'ferie' ? 'F' : mc.esito === 'permessi' ? 'P' : 'AI']++; }
        else if (as) { cod = as.tipo === 'ferie' ? 'F' : as.tipo === 'malattia' ? 'M' : as.tipo === 'permesso' ? 'P' : 'A'; if (c[cod] !== undefined) c[cod]++; }
        const fuori = mt.length && !mturni.length;
        return { min: ricon, cod, fuori, corto: mturni.length && ricon < mturni.reduce((s, t) => s + durata(t), 0) && !as };
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
      return csv(res, `ore_riconosciute_${m}.csv`, [['Persona', 'Mansione', 'Ore contratto/sett.', ...r.giorni.map(x => `${x.w} ${x.n}`), 'Totale riconosciuto', 'Tetto contratto', 'Ferie', 'Permessi', 'Malattia', 'Ass. ingiustificate'],
        ...r.righe.map(p => [p.nome, p.figura, p.ore ?? '', ...p.celle.map(c => [h(c.min), c.cod].filter(Boolean).join(' ')), hmDi(p.totale), hmDi(p.tetto), p.conta.F, p.conta.P, p.conta.M, p.conta.AI]),
        [], ['Legenda: F ferie, P permesso, M malattia, AI assenza ingiustificata, * = scalato in automatico per mancata timbratura. Ogni giorno conta al massimo il turno; il totale non supera il tetto del contratto.']]);
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
    const [{ rows: aperte }, { rows: recenti }, s, { rows: manc }] = await Promise.all([
      q(`select * from sp_richieste where stato in ('attesa_sost','attesa_admin') order by dal`),
      q(`select * from sp_richieste where stato in ('approvata','rifiutata') order by coalesce(decisa_il, creata) desc limit 40`),
      saldi(pp.map(p => p.id)),
      q(`select * from sp_mancate where giorno >= $1 order by giorno desc`, [addG(oggi(), -45)]),
    ]);
    const sh = r => ({ ...richShape(r, nomi), desc: descRich(r) });
    res.json({ aperte: aperte.map(sh), recenti: recenti.map(sh),
      saldi: pp.filter(isDip).map(p => ({ id: p.id, nome: p.nome, figura: p.figura, ...s[p.id] })),
      mancate: manc.map(m => ({ user: m.user_id, nome: nomi.get(m.user_id) || '', giorno: m.giorno, esito: m.esito, valore: m.valore != null ? Number(m.valore) : null, annullata: m.annullata })),
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
    const cod = String(req.params.cod).replace(/[^0-9A-Za-z]/g, '').slice(0, 10);
    if (!cod) return bad(res, 400, 'Codice non valido.');
    const ss = new Set((await sch.sedi()).map(s => s.id));
    const sede = ss.has(req.body.sede) ? req.body.sede : null;
    await q(`insert into sp_tag (cod, sede_id, nota) values ($1,$2,$3) on conflict (cod) do update set sede_id = excluded.sede_id, nota = excluded.nota`, [cod, sede, str(req.body.nota, 100)]);
    if (req.body.reimposta) await q('update sp_tag set uid = null, protetto = false, ctr = -1 where cod = $1', [cod]);
    res.json({ ok: true });
  }));

  // documenti: buste paga e CU divise per codice fiscale, contratti e altri per persona
  app.get('/api/sp/admin/doc', needAd, wrap(async (req, res) => {
    const { rows } = await q(`select id, user_id, tipo, periodo, titolo, pagine, stato, saldi, origine, pagina, suggerito, caricato, pubblicato, visto, ricevuto
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
      persone2.push({ id: p.id, nome: p.nome, figura: p.figura, piano: a?.piano_id || null, livello: a?.livello_n ?? null, stato: a ? await perfUtente(p.id) : null });
    }
    res.json({ piani, persone: persone2,
      dati: dati.map(d => ({ id: d.id, nome: nomi.get(d.user_id) || '', obiettivo: d.testo, dato: d.dato, il: d.il })),
      passaggi: pas.map(x => { const pi = piani.find(y => y.id === x.piano_id); return { id: x.id, nome: nomi.get(x.user_id) || '', da: pi?.livelli.find(l => l.n === x.da_n)?.ruolo || '', a: pi?.livelli.find(l => l.n === x.a_n)?.ruolo || '', bonus: pi?.livelli.find(l => l.n === x.a_n)?.bonus || '' }; }) });
  }));
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
          await tq(`insert into sp_livelli (id, piano_id, n, ruolo, bonus) values ($1,$2,$3,$4,$5) on conflict (id) do update set piano_id = excluded.piano_id, n = excluded.n, ruolo = excluded.ruolo, bonus = excluded.bonus, archiviato = false`,
            [lid, pid, n++, ruolo, str(l.bonus, 120)]);
          let oi = 0;
          for (const o of (Array.isArray(l.obiettivi) ? l.obiettivi : []).slice(0, 20)) {
            const testo = str(o.testo, 200); if (!testo) continue;
            const oid = /^[\w-]{6,64}$/.test(o.id || '') ? o.id : db.newId(); vivi.o.push(oid);
            await tq(`insert into sp_obiettivi (id, livello_id, testo, misura, ordine) values ($1,$2,$3,$4,$5) on conflict (id) do update set livello_id = excluded.livello_id, testo = excluded.testo, misura = excluded.misura, ordine = excluded.ordine, archiviato = false`,
              [oid, lid, testo, str(o.misura, 200), oi++]);
          }
        }
      }
      // quello che non c'è più si archivia (i dati inviati dalle persone restano)
      await tq('update sp_piani set archiviato = true where not (id = any($1))', [vivi.p]);
      await tq('update sp_livelli set archiviato = true where not (id = any($1))', [vivi.l]);
      await tq('update sp_obiettivi set archiviato = true where not (id = any($1))', [vivi.o]);
    });
    res.json({ ok: true });
  }));
  app.put('/api/sp/admin/perf/:user', needAd, wrap(async (req, res) => {
    const pid = str(req.body.piano, 64);
    if (!pid) { await q('delete from sp_perf where user_id = $1', [req.params.user]); return res.json({ ok: true }); }
    const p = (await struttura()).find(x => x.id === pid); if (!p) return bad(res, 400, 'Piano non trovato.');
    const n = parseInt(req.body.livello) || p.livelli[0]?.n || 1;
    await q(`insert into sp_perf (user_id, piano_id, livello_n, dal) values ($1,$2,$3,current_date) on conflict (user_id) do update set piano_id = excluded.piano_id, livello_n = excluded.livello_n, dal = current_date`, [req.params.user, pid, n]);
    await q(`update sp_passaggi set stato = 'superato' where user_id = $1 and stato = 'attesa'`, [req.params.user]);
    res.json({ ok: true });
  }));
  app.post('/api/sp/admin/perf/dato/:id', needAd, wrap(async (req, res) => {
    const ok = !!req.body.ok;
    const { rows } = await q(`update sp_perf_dati set stato = $2, nota = $3, deciso_il = now() where id = $1 and stato = 'verifica' returning *`, [req.params.id, ok ? 'pass' : 'no', str(req.body.nota, 300)]);
    if (!rows[0]) return bad(res, 400, 'Già valutato.');
    const uid = rows[0].user_id, st = await perfUtente(uid);
    avvisa([uid], { title: ok ? 'Pass ottenuto' : 'Dato non approvato', body: ok ? 'Un obiettivo della tua performance è stato approvato.' : 'Un tuo dato non è stato approvato: puoi reinviarlo.', url: '/?sez=perf' });
    // tutti i pass: si propone il passaggio di ruolo, che l'amministratore deve approvare
    if (st && st.prossimo && st.obiettivi.length && st.pass === st.obiettivi.length && !st.inAttesa) {
      const { rows: a } = await q('select * from sp_perf where user_id = $1', [uid]);
      const pi = (await struttura()).find(x => x.id === a[0].piano_id), next = pi.livelli.find(l => l.n > a[0].livello_n);
      await q(`insert into sp_passaggi (id, user_id, piano_id, da_n, a_n, bonus) values ($1,$2,$3,$4,$5,$6)`, [db.newId(), uid, pi.id, a[0].livello_n, next.n, next.bonus || '']);
      avvisaAdmin({ title: 'Passaggio di ruolo da approvare', body: `Tutti i pass raggiunti per ${next.ruolo}.`, url: '/?sez=perf' });
    }
    res.json({ ok: true });
  }));
  app.post('/api/sp/admin/passaggi/:id', needAd, wrap(async (req, res) => {
    const ok = !!req.body.ok;
    const { rows } = await q(`update sp_passaggi set stato = $2, deciso_il = now(), deciso_da = $3 where id = $1 and stato = 'attesa' returning *`, [req.params.id, ok ? 'approvato' : 'rimandato', req.user.email]);
    if (!rows[0]) return bad(res, 400, 'Già deciso.');
    const x = rows[0];
    if (ok) await q('update sp_perf set livello_n = $2, dal = current_date where user_id = $1', [x.user_id, x.a_n]);
    avvisa([x.user_id], { title: ok ? 'Nuovo ruolo!' : 'Passaggio rimandato', body: ok ? `Il passaggio di ruolo è stato approvato${x.bonus ? ' · bonus: ' + x.bonus : ''}.` : 'Il passaggio di ruolo per ora è rimandato.', url: '/?sez=perf' });
    res.json({ ok: true });
  }));

  return { migrate, elaboraMancate };
};
