// Turnario — server (gira insieme alle altre app del gruppo: vedi index.js).
// Si entra solo con l'accesso unico di appgestione.it. Ruoli dal pannello accessi:
//   Amministratore → planning, richieste, personale, regole, sedi, buste paga;
//   Utente         → il dipendente: i suoi turni, richieste di assenza, sostituzioni, buste paga.
// Il dipendente è riconosciuto dall'email: la stessa scritta nella sua scheda in Personale.
const path = require('path');
const express = require('express');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const db = require('./lib/db');
const motore = require('./lib/motore');
const push = require('./lib/push');
const buste = require('./lib/buste');
const mail = require('../accessi/lib/mail');
const accessiStore = require('../accessi/lib/store');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Frame-Options': 'SAMEORIGIN', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
  next();
});
app.use(express.json({ limit: '3mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 40 * 1024 * 1024 } });

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, code, msg) => res.status(code).json({ error: msg });
const fail = (status, msg) => Object.assign(new Error(msg), { status });
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T12:00:00Z'));
const oggi = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
const ora = () => new Date();

/* ---------- accesso unico ---------- */
const sso = require('../accessi/collega')({ app: 'turni', toLocal: localProfile });
async function localProfile(c, role) {
  const r = role === 'admin' ? 'admin' : 'emp';
  const name = `${c.firstName} ${c.lastName}`.trim() || c.email;
  const { rows } = await db.q(`insert into users (id, sso_id, email, name, role) values ($1,$2,$3,$4,$5)
    on conflict (sso_id) do update set email = excluded.email, name = excluded.name, role = excluded.role
    returning id, email, name, role, sso_id`, [db.newId(), c.id, c.email.toLowerCase(), name, r]);
  return { ...rows[0], emailOk: c.emailVerificata !== false, pannello: !!c.pannello };
}
app.use(wrap(async (req, res, next) => {
  const r = await sso.identify(req);
  if (r?.user) req.user = r.user; else if (r?.denied) req.ssoDenied = true;
  next();
}));
const needUser = (req, res, next) => req.user ? next() : bad(res, 401, 'Accesso richiesto');
const needAdmin = (req, res, next) => req.user?.role === 'admin' ? next() : bad(res, 403, 'Solo amministratori');
app.use('/api', (req, res, next) => (['GET', 'HEAD', 'DELETE'].includes(req.method) || req.is('application/json') || req.is('multipart/form-data')) ? next() : bad(res, 415, 'Formato non valido'));

/* ---------- profilo creato dal pannello accessi ---------- */
// Quando l'amministratore approva qualcuno (o gli dà Turni, o ne cambia i dati) il collaboratore compare nel Personale
// con nome, cognome, email, codice fiscale e figura: restano da impostare solo sedi e orario.
sso.onProvision(async ({ user, livello, oldEmail }) => {
  // la figura è quella della persona (pannello accessi); "Amministratore, non in turno" non entra nel Personale
  const inTurno = !livello || livello.livello !== 'admin_no';
  const figura = inTurno && user.figura ? user.figura : null;
  const low = x => String(x || '').toLowerCase();
  const email = low(user.email), vecchia = low(oldEmail);
  await caricaConfig(); // crea la configurazione vuota se non c'è ancora
  return db.tx(async qq => {
    const { rows } = await qq('select data from config where id = 1 for update');
    const c = rows[0].data; c.staff ||= []; c.removed ||= [];
    const prima = JSON.stringify(c);
    // 1) il collaboratore già collegato a questa persona
    let e = c.staff.find(x => x.ssoId === user.id);
    // chi è stato rimosso dal Personale non rientra da solo
    if (!e && c.removed.some(x => x.ssoId === user.id || (!x.ssoId && [email, vecchia].includes(low(x.email))))) return null;
    // 2) una scheda inserita a mano con la stessa email (solo se l'email è confermata e la scheda non è di un altro)
    if (!e && user.emailVerificata) e = c.staff.find(x => !x.ssoId && [email, vecchia].filter(Boolean).includes(low(x.email)));
    // 3) stesso codice fiscale su una scheda senza email: non la prendiamo da soli, lo segnaliamo
    if (!e && user.cf) {
      const g = c.staff.find(x => !x.ssoId && !x.email && String(x.cf || '').toUpperCase() === user.cf);
      if (g) return `Turni: nel Personale c'è già «${g.nome} ${g.cognome}» con lo stesso codice fiscale ma senza email. Se è la stessa persona scrivi ${user.email} nella sua scheda in Turni.`;
    }
    if (!e && !figura) return inTurno && livello ? 'Turni: manca la figura della persona, scegline una con «Modifica».' : null;
    const avvisi = [];
    if (!e) {
      e = { id: 'u' + crypto.randomBytes(6).toString('hex'), ore: {}, cfg: {}, ferie: 22, rol: 72 };
      c.staff.push(e);
    }
    const altro = c.staff.find(x => x !== e && low(x.email) === email);
    Object.assign(e, { ssoId: user.id, nome: user.firstName, cognome: user.lastName, accesso: true });
    if (altro) avvisi.push(`Turni: l'email ${email} è già nella scheda di ${altro.nome} ${altro.cognome}; correggila in Turni.`);
    else e.email = email;
    if (user.cf && !c.staff.some(x => x !== e && x.tipo !== 'Medico' && String(x.cf || '').toUpperCase() === user.cf)) e.cf = user.cf;
    if (figura) e.tipo = figura;
    if (!e.tipo) e.tipo = 'Altro';
    if (JSON.stringify(c) !== prima) // si salva solo se è cambiato qualcosa (così non si disturba chi sta lavorando sui turni)
      await qq(`update config set data = $1, version = version + 1, aggiornata_il = now(), aggiornata_da = 'accesso unico' where id = 1`, [JSON.stringify(c)]);
    return avvisi.join(' ') || null;
  });
});

/* ---------- sedi dal pannello accessi ---------- */
// Le sedi si gestiscono in Gestione accessi: qui si copiano nome, sigla e riuniti. Una sede disattivata
// esce dal planning (le ore dei collaboratori in quella sede si tolgono, i turni futuri lì si cancellano).
const normSede = s => String(s || '').toLowerCase().replace(/to\s*smile|studio|sede|ambulatorio/g, '').replace(/[^a-z0-9]/g, '');
sso.onSedi(async sedi => {
  await caricaConfig();
  return db.tx(async qq => {
    const { rows } = await qq('select data from config where id = 1 for update');
    const c = rows[0].data; c.sedi ||= [];
    const prima = JSON.stringify(c), tolte = [];
    for (const x of sedi) {
      let t = c.sedi.find(s => s.centrale === x.id)
        || c.sedi.find(s => !s.centrale && (String(s.sigla).toUpperCase() === x.sigla.toUpperCase() || normSede(s.nome) === normSede(x.nome)));
      if (!x.attiva) { if (t) tolte.push(t.id); continue; }
      if (!t) { t = { id: 's' + crypto.randomBytes(4).toString('hex') }; c.sedi.push(t); }
      Object.assign(t, { centrale: x.id, nome: x.nome, sigla: x.sigla, riuniti: x.riuniti });
    }
    if (tolte.length) {
      c.sedi = c.sedi.filter(s => !tolte.includes(s.id));
      c.deroghe = (c.deroghe || []).filter(d => !tolte.includes(d.sede));
      c.cad = (c.cad || []).filter(d => !tolte.includes(d.sede));
      for (const e of c.staff || []) for (const id of tolte) { delete (e.ore || {})[id]; delete (e.cfg || {})[id]; }
      const { rows: pr } = await qq('select data from piano where id = 1 for update');
      if (pr[0]) {
        const pd = pr[0].data, da = oggi();
        for (const id in pd.plan || {}) for (const d in pd.plan[id]) if (d >= da && tolte.includes(pd.plan[id][d].s)) delete pd.plan[id][d];
        await qq('update piano set data = $1 where id = 1', [JSON.stringify(pd)]);
      }
    }
    if (JSON.stringify(c) !== prima)
      await qq(`update config set data = $1, version = version + 1, aggiornata_il = now(), aggiornata_da = 'accesso unico' where id = 1`, [JSON.stringify(c)]);
    return null;
  });
});

/* ---------- caricamento dello stato ---------- */
async function caricaConfig() {
  const { rows } = await db.q('select data, version, aggiornata_il from config where id = 1');
  if (rows[0]) return rows[0];
  const vuota = { sedi: [], staff: [], removed: [], reg: motore.defaultReg(), deroghe: [], cad: [], unav: [], rules: [] };
  await db.q(`insert into config (id, data) values (1, $1) on conflict (id) do nothing`, [JSON.stringify(vuota)]);
  return { data: vuota, version: 1, aggiornata_il: new Date() };
}
async function caricaPiano() {
  const { rows } = await db.q('select data, generato_il from piano where id = 1');
  return rows[0] || { data: {}, generato_il: null };
}
const reqFromRow = r => ({ id: r.id, numero: r.numero, emp: r.staff_id, tipo: r.tipo, dal: r.dal, al: r.al, ore: r.ore ?? undefined,
  sost: r.sost || null, prot: r.prot || undefined, note: r.note, motivo: r.motivo || undefined, stato: r.stato, sostOk: r.sost_ok, inviata: r.inviata,
  decisaAdmin: !!r.gestita_da, ...(r.eventi ? { eventi: r.eventi } : {}) });
async function caricaRichieste() {
  const { rows } = await db.q(`select r.*, coalesce((select json_agg(json_build_object('azione', e.azione, 'chi', e.chi, 'il', e.il, 'disp', e.dispositivo) order by e.il)
      from richieste_eventi e where e.richiesta_id = r.id), '[]') as eventi
    from richieste r where r.stato <> 'annullata' order by r.dal`);
  return rows.map(reqFromRow);
}
// Storico della richiesta (chi = id del collaboratore, oppure l'email dell'amministratore)
const evento = (id, azione, chi, req) => db.q('insert into richieste_eventi (richiesta_id, azione, chi, dispositivo) values ($1,$2,$3,$4)',
  [id, azione, chi || '', req ? buste.dispositivo(req.get('user-agent')) : '']).catch(e => console.warn('Turni, storico richiesta:', e.message));
async function caricaAI() {
  const { rows } = await db.q('select staff_id, data from assenze_ai');
  return rows.map(r => `${r.staff_id}|${r.data}`);
}
async function motoreCompleto() {
  const [cfg, pd, reqs, ai] = await Promise.all([caricaConfig(), caricaPiano(), caricaRichieste(), caricaAI()]);
  return { cfg, pd, reqs, ai, m: motore.crea({ config: cfg.data, planDoc: pd.data, reqs, ai, today: oggi() }) };
}
async function salvaPiano(m) {
  const s = m.stato();
  await db.q(`insert into piano (id, data, generato_il) values (1, $1, now())
    on conflict (id) do update set data = excluded.data, generato_il = excluded.generato_il`,
    [JSON.stringify({ plan: s.plan, short: s.short, fixMiss: s.fixMiss, genAt: s.genAt })]);
}
const staffById = (cfg, id) => (cfg.data.staff || []).find(e => e.id === id) || (cfg.data.removed || []).find(e => e.id === id);
const nome = e => e ? `${e.nome} ${e.cognome}` : '—';
// Il collaboratore che corrisponde a chi è entrato: prima quello collegato al suo accesso unico,
// poi una scheda inserita a mano con la sua email (solo se l'email è confermata e la scheda non è di un altro).
const staffDiUtente = (staff, user) => (staff || []).find(x => x.ssoId && x.ssoId === user.sso_id)
  || (user.emailOk ? (staff || []).find(x => !x.ssoId && String(x.email || '').toLowerCase() === user.email) : null);
async function staffDi(user) {
  const cfg = await caricaConfig();
  return { cfg, e: staffDiUtente(cfg.data.staff, user) };
}

/* ---------- notifiche ---------- */
async function utentiDiStaff(cfg, ids) {
  const st = ids.map(id => staffById(cfg, id)).filter(Boolean);
  const sso = st.map(e => e.ssoId).filter(Boolean), emails = st.filter(e => !e.ssoId).map(e => String(e.email || '').toLowerCase()).filter(Boolean);
  if (!sso.length && !emails.length) return [];
  const { rows } = await db.q('select id from users where sso_id = any($1) or email = any($2)', [sso, emails]);
  return rows.map(r => r.id);
}
async function avvisaStaff(cfg, ids, payload, email) {
  try { await push.sendToUsers(await utentiDiStaff(cfg, ids), payload); } catch (e) { console.warn('Turni, notifica:', e.message); }
  if (email && mail.enabled()) {
    for (const id of ids) {
      const e = staffById(cfg, id);
      if (e?.email) mail.send({ to: e.email, subject: email.subject, text: email.text,
        html: mail.layout(email.subject, [mail.esc(email.text)], { url: 'https://turni.appgestione.it' + (payload.url || '/'), label: 'Apri i turni' }) });
    }
  }
}
async function avvisaAdmin(payload) {
  try {
    const { rows } = await db.q(`select id from users where role = 'admin'`);
    await push.sendToUsers(rows.map(r => r.id), payload);
  } catch (e) { console.warn('Turni, notifica admin:', e.message); }
}

/* ---------- stato per la pagina ---------- */
app.get('/api/state', needUser, wrap(async (req, res) => {
  const vistaDip = req.query.vista === 'dipendente';
  if (req.user.role === 'admin' && !vistaDip) return res.json(await statoAdmin(req));
  res.json(await statoDipendente(req));
}));

async function statoAdmin(req) {
  const [cfg, pd, reqs, ai] = await Promise.all([caricaConfig(), caricaPiano(), caricaRichieste(), caricaAI()]);
  const { rows: priv } = await db.q('select staff_id, accettata_il, dispositivo from privacy');
  const meStaff = staffDiUtente(cfg.data.staff, req.user);
  return {
    role: 'admin', me: { name: req.user.name, email: req.user.email, staffId: meStaff?.id || null, pannello: !!req.user.pannello },
    today: oggi(), config: cfg.data, version: cfg.version, planDoc: pd.data,
    dirty: !pd.generato_il || new Date(cfg.aggiornata_il) > new Date(pd.generato_il),
    reqs, ai, privacy: Object.fromEntries(priv.map(p => [p.staff_id, { il: p.accettata_il, disp: p.dispositivo }])),
    aiEnabled: !!process.env.ANTHROPIC_API_KEY, busteEnabled: buste.attive(), mailEnabled: mail.enabled(), links: sso.links(),
  };
}

async function statoDipendente(req) {
  const { cfg, e } = await staffDi(req.user);
  const base = { role: 'emp', isAdmin: req.user.role === 'admin', me: { name: req.user.name, email: req.user.email }, links: sso.links(), today: oggi() };
  if (!e) return { ...base, sconosciuto: true };
  const { rows: pr } = await db.q('select accettata_il from privacy where staff_id = $1', [e.id]);
  if (!pr[0]) return { ...base, privacy: false, staff: { nome: e.nome } };
  const { m, reqs } = await motoreCompleto();
  const st = m.stato();
  const giorni = [];
  for (const d of m.allDays()) {
    const a = m.absenceOn(e.id, d), p = st.plan[e.id]?.[d];
    if (!a && !p) continue;
    const g = { d };
    if (a && a.code !== 'PEND') g.abs = { code: a.code, tipo: a.r ? m.TIPI[a.r.tipo] : 'Assenza senza richiesta', sost: a.r?.sost ? m.full(m.emp(a.r.sost)) : null };
    else {
      g.code = m.cellCode(p);
      g.turni = m.shiftsOf(p).map(t => ({ t, label: m.turnoTxt(t), sede: m.sede(p.s)?.nome || '', fisso: (p.fx || []).includes(t), conChi: m.conChi(e.id, d, t) }));
      if (a) g.attesa = m.TIPI[a.r.tipo];
    }
    giorni.push(g);
  }
  const next = giorni.find(g => g.d >= oggi() && g.turni && !g.abs) || null;
  const anno = oggi().slice(0, 4);
  const mie = reqs.filter(r => r.emp === e.id);
  const ferieUsate = mie.filter(r => r.tipo === 'FE' && r.stato === 'approvata' && r.dal.startsWith(anno)).reduce((s, r) => s + m.diffDays(r.dal, r.al) + 1, 0);
  const rolUsate = mie.filter(r => r.tipo === 'ROL' && r.stato === 'approvata' && r.dal.startsWith(anno)).reduce((s, r) => s + (r.ore || 8), 0);
  const conNomi = r => ({ ...r, eventi: undefined, nome: m.full(m.emp(r.emp)), figura: m.emp(r.emp)?.tipo || '', sedi: m.emp(r.emp) ? m.sedeList(m.emp(r.emp)) : '',
    sostNome: r.sost ? m.full(m.emp(r.sost)) : null });
  // per il sostituto si può scegliere chiunque sia registrato (con accesso all'app); in testa chi ha la stessa figura e una sede in comune
  const colleghi = st.STAFF.filter(x => x.id !== e.id && (x.ssoId || x.email))
    .map(x => ({ id: x.id, nome: m.full(x), cognome: x.cognome || '', sedi: m.sedeList(x), figura: x.tipo,
      stessa: x.tipo === e.tipo, vicino: x.tipo === e.tipo && m.sediOf(x).some(s => m.sediOf(e).includes(s)) }))
    .sort((a, b) => (b.vicino - a.vicino) || a.cognome.localeCompare(b.cognome, 'it') || a.nome.localeCompare(b.nome, 'it'));
  const oreMese = Object.fromEntries(st.MONTHS.map(ym => [ym, m.oreMese(e, ym).coll]));
  const { rows: bl } = await db.q(`select id, tipo, mese, aperta_il, confermata_il, firmata_il from buste where staff_id = $1 and stato = 'pubblicata' and ${VISIBILE}
    order by mese desc`, [e.id, cutoff(), cutoffCud()]);
  return {
    ...base, privacy: true,
    staff: { id: e.id, nome: e.nome, cognome: e.cognome, tipo: e.tipo,
      descr: [m.oreList(e) ? m.oreList(e) + ' a settimana' : '', ...st.CAD.filter(c => c.emp === e.id && m.sede(c.sede)).map(c => `${m.sede(c.sede).nome} ${m.cadTxt(c)}`)].filter(Boolean).join(' · '),
      ferie: (e.ferie ?? 22) - ferieUsate, rol: (e.rol ?? 72) - rolUsate, medico: e.tipo === 'Medico' },
    months: st.MONTHS, ore: st.REG.ore, giorni, next, oreMese,
    myAI: [...st.AI].filter(k => k.startsWith(e.id + '|')).map(k => k.split('|')[1]),
    mie: mie.map(conNomi).sort((a, b) => b.dal.localeCompare(a.dal)),
    sostituzioni: reqs.filter(r => r.sost === e.id).map(conNomi),
    colleghi, buste: bl.map(b => ({ id: b.id, tipo: b.tipo, mese: b.mese, aperta: b.aperta_il, confermata: b.confermata_il, firmata: b.firmata_il })),
  };
}

/* ---------- amministratore: configurazione e generazione ---------- */
function validaConfig(c) {
  if (!c || typeof c !== 'object') throw fail(400, 'Configurazione non valida');
  for (const k of ['sedi', 'staff', 'deroghe', 'cad', 'unav', 'rules']) if (!Array.isArray(c[k])) throw fail(400, `Configurazione non valida (${k})`);
  if (!c.reg || typeof c.reg !== 'object') throw fail(400, 'Configurazione non valida (regole)');
  const emails = new Set(), cfs = new Set();
  for (const e of c.staff) {
    if (!e.id || !e.nome) throw fail(400, 'Collaboratore senza nome');
    const em = String(e.email || '').toLowerCase().trim();
    if (em) { if (emails.has(em)) throw fail(400, `L'email ${em} è usata da due collaboratori.`); emails.add(em); }
    const cf = String(e.cf || '').toUpperCase().trim();
    if (cf && e.tipo !== 'Medico') { if (cfs.has(cf)) throw fail(400, `Il codice fiscale ${cf} è usato da due collaboratori.`); cfs.add(cf); }
  }
  return { sedi: c.sedi, staff: c.staff, removed: Array.isArray(c.removed) ? c.removed : [], reg: c.reg, deroghe: c.deroghe, cad: c.cad, unav: c.unav, rules: c.rules };
}
app.put('/api/config', needAdmin, wrap(async (req, res) => {
  const c = validaConfig(req.body.config);
  if (!req.user.pannello) { // i collaboratori arrivano dalla registrazione su appgestione.it: qui non se ne aggiungono a mano
    const ora = (await caricaConfig()).data, noti = new Set([...(ora.staff || []), ...(ora.removed || [])].map(e => e.id));
    if (c.staff.some(e => !noti.has(e.id))) return bad(res, 403, "I collaboratori si registrano da appgestione.it e compaiono qui quando li approvi in Gestione accessi. Solo l'amministratore del pannello può aggiungerli a mano.");
  }
  const json = JSON.stringify(c);
  if (json.length > 2.5e6) return bad(res, 400, 'Configurazione troppo grande');
  const { rows } = await db.q(`update config set data = $1, version = version + 1, aggiornata_il = now(), aggiornata_da = $3
    where id = 1 and version = $2 returning version`, [json, int(req.body.version), req.user.email]);
  if (!rows[0]) return bad(res, 409, "Un altro amministratore ha appena modificato i dati: ricarico la pagina con l'ultima versione.");
  res.json({ version: rows[0].version });
}));
const int = v => Number.isFinite(+v) ? Math.round(+v) : 0;

app.post('/api/genera', needAdmin, wrap(async (req, res) => {
  const { m } = await motoreCompleto();
  const da = oggi();
  m.genera(da);
  const st = m.stato();
  for (const e of st.REMOVED) for (const d in (st.plan[e.id] || {})) if (d >= da) delete st.plan[e.id][d];
  await salvaPiano(m);
  res.json({ planDoc: { plan: st.plan, short: st.short, fixMiss: st.fixMiss, genAt: st.genAt } });
}));

// Assenza senza richiesta segnata dall'amministratore sul planning (si toglie con un secondo tocco)
app.post('/api/assenze-ai', needAdmin, wrap(async (req, res) => {
  const id = str(req.body.staffId, 64), d = str(req.body.data, 10);
  if (!id || !isDate(d)) return bad(res, 400, 'Dati non validi');
  const del = await db.q('delete from assenze_ai where staff_id = $1 and data = $2', [id, d]);
  if (!del.rowCount) await db.q('insert into assenze_ai (staff_id, data) values ($1,$2)', [id, d]);
  res.json({ ai: await caricaAI(), attiva: !del.rowCount });
}));

/* ---------- richieste di assenza ---------- */
app.post('/api/richieste/:id/approva', needAdmin, wrap(async (req, res) => {
  const { rows } = await db.q(`update richieste set stato = 'approvata', gestita_il = now(), gestita_da = $2
    where id = $1 and stato = 'attesa_admin' returning *`, [req.params.id, req.user.email]);
  if (!rows[0]) return bad(res, 400, 'La richiesta non è più in attesa.');
  await evento(rows[0].id, 'approvata', req.user.email, req);
  const { m, cfg } = await motoreCompleto();
  const esito = m.applySubstitution(reqFromRow(rows[0]));
  await salvaPiano(m);
  const r = rows[0];
  avvisaStaff(cfg, [r.staff_id], { title: 'Richiesta approvata', body: `${m.TIPI[r.tipo]} dal ${m.fmt(r.dal)} al ${m.fmt(r.al)} approvata.`, url: '/' });
  if (r.sost) avvisaStaff(cfg, [r.sost], { title: 'Sostituzione confermata', body: `Prendi i turni di ${nome(staffById(cfg, r.staff_id))} dal ${m.fmt(r.dal)} al ${m.fmt(r.al)}.`, url: '/' });
  res.json({ esito, reqs: await caricaRichieste(), planDoc: (await caricaPiano()).data });
}));
app.post('/api/richieste/:id/rifiuta', needAdmin, wrap(async (req, res) => {
  const { rows } = await db.q(`update richieste set stato = 'rifiutata', gestita_il = now(), gestita_da = $2
    where id = $1 and stato in ('attesa_admin','attesa_sost') returning *`, [req.params.id, req.user.email]);
  if (!rows[0]) return bad(res, 400, 'La richiesta non è più in attesa.');
  await evento(rows[0].id, 'rifiutata', req.user.email, req);
  const cfg = await caricaConfig();
  avvisaStaff(cfg, [rows[0].staff_id], { title: 'Richiesta rifiutata', body: "L'amministrazione ha rifiutato la tua richiesta di assenza.", url: '/' });
  res.json({ reqs: await caricaRichieste() });
}));

// Dipendente: nuova richiesta (ferie, ROL, malattia)
app.post('/api/richieste', needUser, wrap(async (req, res) => {
  const { cfg, e } = await staffDi(req.user);
  if (!e) return bad(res, 403, 'Non sei nell\'elenco del personale.');
  const b = req.body, tipo = ['FE', 'ROL', 'MAL', 'CP', 'ALT'].includes(b.tipo) ? b.tipo : null;
  const motivo = str(b.motivo, 500);
  const dal = str(b.dal, 10), al = str(b.al, 10), sost = str(b.sost, 64) || null;
  if (!tipo) return bad(res, 400, 'Tipo non valido');
  if (!isDate(dal) || !isDate(al) || al < dal) return bad(res, 400, 'Controlla le date: la fine non può precedere l\'inizio.');
  if (tipo !== 'MAL' && dal < oggi()) return bad(res, 400, 'Questa richiesta si fa per oggi o per giorni futuri.');
  if (tipo !== 'MAL' && !sost) return bad(res, 400, 'Indica chi ti sostituisce.');
  if (tipo !== 'MAL' && !b.accordo) return bad(res, 400, 'Conferma di esserti accordato con il sostituto.');
  if (tipo === 'MAL' && !str(b.prot, 40)) return bad(res, 400, 'Inserisci il numero di protocollo del certificato.');
  if (tipo === 'ALT' && motivo.length < 3) return bad(res, 400, 'Scrivi la motivazione della richiesta.');
  const { m, reqs } = await motoreCompleto();
  const sovrapposta = reqs.find(r => r.emp === e.id && ['attesa_sost', 'attesa_admin', 'approvata'].includes(r.stato) && r.dal <= al && r.al >= dal);
  if (sovrapposta) return bad(res, 400, `Hai già una richiesta per quei giorni (${m.TIPI[sovrapposta.tipo].toLowerCase()} dal ${m.fmt(sovrapposta.dal)} al ${m.fmt(sovrapposta.al)}).`);
  if (sost) {
    const x = m.emp(sost);
    if (!x || x.id === e.id) return bad(res, 400, 'Sostituto non valido.');
    for (let d = dal; d <= al; d = m.addDays(d, 1)) if (m.blocked(sost, d)) return bad(res, 400, `${m.full(x)} è assente il ${m.fmt(d)}: scegli un altro collega.`);
  }
  const id = db.newId(), ore = tipo === 'ROL' ? Math.min(8, Math.max(1, int(b.ore) || 4)) : null;
  const stato = tipo === 'MAL' ? 'approvata' : 'attesa_sost';
  const { rows } = await db.q(`insert into richieste (id, staff_id, tipo, dal, al, ore, sost, prot, note, motivo, stato, sost_ok, inviata)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) returning *`,
    [id, e.id, tipo, dal, al, ore, sost, tipo === 'MAL' ? str(b.prot, 40) : '', str(b.note, 500), tipo === 'ALT' ? motivo : '', stato, tipo === 'MAL' ? (sost ? true : null) : null, oggi()]);
  await evento(id, 'inviata', e.id, req);
  if (tipo === 'MAL') {
    const mm = (await motoreCompleto()).m;
    mm.applySubstitution(reqFromRow(rows[0]));
    await salvaPiano(mm);
    avvisaAdmin({ title: 'Malattia registrata', body: `${nome(e)}: dal ${m.fmt(dal)} al ${m.fmt(al)}.`, url: '/?tab=richieste' });
    if (sost) avvisaStaff(cfg, [sost], { title: 'Sostituzione per malattia', body: `Prendi i turni di ${nome(e)} dal ${m.fmt(dal)} al ${m.fmt(al)}.`, url: '/' });
  } else {
    avvisaStaff(cfg, [sost], { title: 'Ti chiedono una sostituzione', body: `${nome(e)}: ${m.TIPI[tipo].toLowerCase()} dal ${m.fmt(dal)} al ${m.fmt(al)}. Conferma o rifiuta.`, url: '/?tab=conferme' },
      { subject: 'Richiesta di sostituzione', text: `${nome(e)} ti ha indicato come sostituto per ${m.TIPI[tipo].toLowerCase()} dal ${m.fmt(dal)} al ${m.fmt(al)}. Apri l'app per confermare o rifiutare.` });
  }
  res.json({ ok: true, stato });
}));
// Il sostituto conferma o rifiuta
app.post('/api/richieste/:id/sostituto', needUser, wrap(async (req, res) => {
  const { cfg, e } = await staffDi(req.user);
  if (!e) return bad(res, 403, 'Non sei nell\'elenco del personale.');
  const ok = !!req.body.ok;
  // la risposta si può cambiare (sì → no, no → sì) finché l'amministrazione non ha deciso; ogni risposta resta nello storico
  const { rows: pr } = await db.q(`select * from richieste where id = $1 and sost = $2`, [req.params.id, e.id]);
  const prima = pr[0];
  if (!prima) return bad(res, 404, 'Richiesta non trovata.');
  if (prima.gestita_da || prima.stato === 'approvata' || prima.stato === 'annullata')
    return bad(res, 400, prima.stato === 'annullata' ? 'Il collega ha annullato la richiesta.' : "L'amministrazione ha già deciso: per cambiare la tua risposta contattala.");
  if (prima.sost_ok === ok) return bad(res, 400, ok ? 'Hai già confermato.' : 'Hai già risposto che non puoi.');
  if (ok && prima.stato === 'rifiutata') { // nel frattempo il collega potrebbe aver chiesto gli stessi giorni con un altro sostituto
    const { rows: alt } = await db.q(`select 1 from richieste where staff_id = $1 and id <> $2 and stato in ('attesa_sost','attesa_admin','approvata') and dal <= $4 and al >= $3`,
      [prima.staff_id, prima.id, prima.dal, prima.al]);
    if (alt.length) return bad(res, 400, 'Il collega ha già fatto un\'altra richiesta per quei giorni: non serve più la tua conferma.');
  }
  const { rows } = await db.q(`update richieste set sost_ok = $3, stato = $4 where id = $1 and sost = $2 and gestita_da is null and stato in ('attesa_sost','attesa_admin','rifiutata') returning *`,
    [req.params.id, e.id, ok, ok ? 'attesa_admin' : 'rifiutata']);
  if (!rows[0]) return bad(res, 400, 'La richiesta non è più modificabile.');
  const r = rows[0], cambio = prima.sost_ok !== null;
  await evento(r.id, (ok ? 'sost_si' : 'sost_no') + (cambio ? '_cambio' : ''), e.id, req);
  const chi = nome(staffById(cfg, r.staff_id));
  if (ok) avvisaAdmin({ title: cambio ? 'Sostituto ci ripensa: ora conferma' : 'Richiesta da approvare', body: `${chi}: ${nome(e)} conferma la sostituzione.`, url: '/?tab=richieste' });
  else if (cambio) avvisaAdmin({ title: 'Sostituto ritira la conferma', body: `${chi}: ${nome(e)} ora non può sostituire. La richiesta è respinta.`, url: '/?tab=richieste' });
  avvisaStaff(cfg, [r.staff_id], { title: ok ? 'Il sostituto ha confermato' : (cambio ? 'Il sostituto non può più' : 'Il sostituto non può'),
    body: ok ? 'Ora la richiesta passa all\'amministrazione.' : 'Indica un altro collega con una nuova richiesta.', url: '/' });
  res.json({ ok: true, cambio });
}));
app.post('/api/richieste/:id/annulla', needUser, wrap(async (req, res) => {
  const { e } = await staffDi(req.user);
  if (!e) return bad(res, 403, 'Non sei nell\'elenco del personale.');
  const { rowCount } = await db.q(`update richieste set stato = 'annullata' where id = $1 and staff_id = $2 and stato in ('attesa_sost','attesa_admin')`, [req.params.id, e.id]);
  if (!rowCount) return bad(res, 400, 'La richiesta non si può più annullare.');
  await evento(req.params.id, 'annullata', e.id, req);
  res.json({ ok: true });
}));

/* ---------- privacy ---------- */
app.post('/api/privacy/accetta', needUser, wrap(async (req, res) => {
  const { e } = await staffDi(req.user);
  if (!e) return bad(res, 403, 'Non sei nell\'elenco del personale.');
  await db.q(`insert into privacy (staff_id, dispositivo, email) values ($1,$2,$3) on conflict (staff_id) do nothing`,
    [e.id, buste.dispositivo(req.get('user-agent')), req.user.email]);
  res.json({ ok: true });
}));

/* ---------- regole scritte con l'AI ---------- */
app.post('/api/ai/regola', needAdmin, wrap(async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return bad(res, 400, "L'AI non è attiva: manca ANTHROPIC_API_KEY su Render.");
  const testo = str(req.body.testo, 2000), scope = str(req.body.scope, 64) || null;
  if (!testo) return bad(res, 400, 'Scrivi prima la regola.');
  const { m } = await motoreCompleto();
  const st = m.stato();
  const p = scope ? m.emp(scope) : null;
  const mesi = st.MONTHS.slice(1).map(ym => m.meseLabel(ym)).join(', ');
  const prompt = `Sei l'assistente di un'app che genera i turni di uno studio odontoiatrico con più sedi. L'amministratore scrive una regola in italiano: trasformala in azioni strutturate per l'app.

DATI ATTUALI
Sedi: ${JSON.stringify(st.SEDI.map(s => ({ id: s.id, nome: s.nome, riuniti: s.riuniti })))}
Persone: ${JSON.stringify(st.STAFF.map(e => ({ id: e.id, nome: m.full(e), figura: e.tipo })))}
Figure: Medico, Igienista (igienista dentale), ASO (assistente alla poltrona), REC (reception), RAP, RUL, Extrambulatoriale, Altro. Ogni riunito ha un medico e un'ASO.
Giorni: 1 lunedì, 2 martedì, 3 mercoledì, 4 giovedì, 5 venerdì, 6 sabato (la domenica è chiuso).
Turni: "M" mattina ${st.REG.ore.M.join('-')}, "P" pomeriggio ${st.REG.ore.P.join('-')}, "G" giornata intera.
Oggi è ${oggi()}. Il planning copre ${mesi}. Date nel formato AAAA-MM-GG.
${p ? `La regola riguarda ${m.full(p)} (id "${p.id}", ${p.tipo}): se non nomina altre persone, è lei.` : ''}

AZIONI POSSIBILI (usa solo queste, con questi campi)
1. {"azione":"deroga_sede","sede":id,"quando":"sempre"|"giorno"|"data","giorno":1-6,"data":"AAAA-MM-GG","cosa":"chiusa"|"solo_mattina"|"aperta"|"riuniti"|"minimo","numero":n,"figura":"Igienista"|"REC"|"RAP"|"RUL"|"Extrambulatoriale"|"Altro","turno":"M"|"P"|"MP"}
   ("riuniti" = quanti riuniti sono disponibili; "minimo" = persone minime di una figura non medica. Per "tutte le sedi" crea un'azione per ogni sede.)
2. {"azione":"presenza_fissa","persona":id,"sede":id,"settimane":[1,2,3,4,5] dove 5 = ultima del mese, oppure [0] per ogni settimana,"giorno":1-6,"turno":"M"|"P"|"G","ogni_due_settimane":true|false}
3. {"azione":"non_disponibile","persona":id,"giorno":1-6 oppure null,"dal":"AAAA-MM-GG" oppure null,"al":"AAAA-MM-GG" oppure null,"turno":"M"|"P"|"G"}
4. {"azione":"ore_settimanali","persona":id,"sede":id,"ore":n}
5. {"azione":"riuniti","sede":id,"numero":n}
6. {"azione":"limiti_figura","figura":"Igienista"|"REC"|"RAP"|"RUL"|"Extrambulatoriale"|"Altro","minimo":n oppure null,"massimo":n oppure null}
Se una parte non si può esprimere con queste azioni aggiungi {"azione":"non_supportata","motivo":"spiegazione breve in italiano"}.
Non inventare persone o sedi: se un nome è ambiguo o non esiste, mettilo nei dubbi e non creare l'azione.

Rispondi SOLO con un oggetto JSON:
{"riassunto":"una frase in italiano semplice che dice cosa farà l'app","azioni":[...],"dubbi":["domande brevi se qualcosa è ambiguo"]}

REGOLA: """${testo}"""`;
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.TURNI_AI_MODEL || 'claude-sonnet-5-5', max_tokens: 1500, messages: [{ role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(60000),
    });
  } catch (e) { return bad(res, 502, "L'AI non ha risposto in tempo. Riprova."); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    console.warn('Turni AI:', r.status, JSON.stringify(j).slice(0, 300));
    return bad(res, 502, r.status === 429 ? 'Troppe richieste ravvicinate: riprova tra poco.' : r.status === 401 ? 'La chiave ANTHROPIC_API_KEY non è valida.' : "L'AI non ha risposto. Riprova tra poco.");
  }
  const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  let out;
  try { out = JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)); }
  catch { return bad(res, 502, 'La risposta non era leggibile. Riprova o scrivi la regola in modo più semplice.'); }
  const az = Array.isArray(out.azioni) ? out.azioni : [];
  res.json({ riassunto: String(out.riassunto || ''), dubbi: Array.isArray(out.dubbi) ? out.dubbi.map(String) : [],
    azioni: az.map(a => ({ a, ok: m.azioneValida(a) })) });
}));

/* ---------- buste paga ---------- */
const pad = n => String(n).padStart(2, '0');
function cutoff() { // mesi visibili ai dipendenti: gli ultimi 18
  const t = new Date(oggi() + 'T12:00:00Z'); t.setUTCMonth(t.getUTCMonth() - 18);
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}`;
}
const meseOk = s => /^\d{4}-(0[1-9]|1[0-2])$/.test(s);
// I documenti sono di due tipi: buste paga (periodo AAAA-MM, visibili 18 mesi) e CUD (periodo AAAA = anno del CUD, redditi dell'anno prima; visibili 5 anni).
const tipoDoc = v => v === 'cud' ? 'cud' : 'busta';
const periodoOk = (tipo, s) => tipo === 'cud' ? /^20\d{2}$/.test(s) : meseOk(s);
function cutoffCud() { return String(+oggi().slice(0, 4) - 5); }
const cutoffDi = tipo => tipo === 'cud' ? cutoffCud() : cutoff();
const VISIBILE = `((tipo = 'busta' and mese >= $2) or (tipo = 'cud' and mese >= $3))`; // con $2 = cutoff(), $3 = cutoffCud()
const MESI = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];
const titoloDoc = (tipo, periodo) => tipo === 'cud' ? `CUD ${periodo} (redditi ${+periodo - 1})` : `Busta paga di ${MESI[+periodo.slice(5, 7) - 1]} ${periodo.slice(0, 4)}`;
const nomeDoc = tipo => tipo === 'cud' ? 'CUD' : 'busta paga';

app.get('/api/buste', needAdmin, wrap(async (req, res) => {
  const tipo = tipoDoc(req.query.tipo);
  const { rows } = await db.q(`select id, staff_id, tipo, mese, impronta, pagine, stato, origine, creata_il, pubblicata_il, aperta_il, aperta_disp,
    confermata_il, confermata_disp, firmata_il, firmata_disp from buste where tipo = $1 order by mese desc, staff_id`, [tipo]);
  const { rows: sosp } = await db.q('select id, mese, origine, pagina, suggerito from pagine_sospese where tipo = $1 order by mese desc, pagina', [tipo]);
  res.json({ tipo, buste: rows, sospese: sosp, cutoff: cutoffDi(tipo), attive: buste.attive() });
}));

app.post('/api/buste/carica', needAdmin, upload.single('file'), wrap(async (req, res) => {
  if (!buste.attive()) return bad(res, 400, 'Le buste paga non sono attive: manca BUSTE_KEY su Render.');
  const tipo = tipoDoc(req.body.tipo), mese = str(req.body.mese, 7);
  if (!periodoOk(tipo, mese)) return bad(res, 400, tipo === 'cud' ? "Scegli l'anno." : 'Scegli il mese.');
  if (!req.file || !/pdf/i.test(req.file.mimetype + req.file.originalname)) return bad(res, 400, tipo === 'cud' ? 'Carica il PDF con i CUD.' : 'Carica il PDF con le buste.');
  const cfg = await caricaConfig();
  const staff = (cfg.data.staff || []).filter(e => e.tipo !== 'Medico');
  let r;
  try { r = await buste.dividi(req.file.buffer, staff); }
  catch (e) { console.warn('Buste, PDF:', e.message); return bad(res, 400, 'Non riesco a leggere questo PDF. È protetto da password o danneggiato?'); }
  const origine = str(req.file.originalname, 120);
  const giaCaricati = (await db.q('select staff_id from buste where mese = $1 and tipo = $2', [mese, tipo])).rows.map(x => x.staff_id);
  const doppi = [];
  await db.tx(async qq => {
    for (const g of r.gruppi) {
      if (giaCaricati.includes(g.staffId)) { doppi.push(nome(staffById(cfg, g.staffId))); continue; } // busta del mese caricata in un caricamento precedente
      const c = buste.cifra(g.buf);
      await qq(`insert into buste (id, staff_id, tipo, mese, file, iv, tag, impronta, pagine, origine) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [db.newId(), g.staffId, tipo, mese, c.file, c.iv, c.tag, buste.impronta(g.buf), g.pagine.length, origine]);
    }
    for (const s of r.sospese) {
      const c = buste.cifra(s.buf);
      await qq(`insert into pagine_sospese (id, tipo, mese, origine, pagina, file, iv, tag, suggerito) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [db.newId(), tipo, mese, origine, s.pagina + 1, c.file, c.iv, c.tag, s.suggerito]);
    }
  });
  res.json({ pagine: r.pagine, abbinate: r.gruppi.length - doppi.length, sospese: r.sospese.length, doppi });
}));
// Pagina senza codice fiscale riconosciuto: si assegna a una persona (si aggiunge alla sua busta del mese) o si scarta
app.post('/api/buste/sospese/:id/assegna', needAdmin, wrap(async (req, res) => {
  const staffId = str(req.body.staffId, 64);
  const { rows } = await db.q('select * from pagine_sospese where id = $1', [req.params.id]);
  const p = rows[0];
  if (!p) return bad(res, 404, 'Pagina non trovata');
  const cfg = await caricaConfig();
  if (!staffById(cfg, staffId)) return bad(res, 400, 'Scegli a chi assegnarla.');
  const pagina = buste.decifra(p);
  await db.tx(async qq => {
    const { rows: es } = await qq(`select * from buste where staff_id = $1 and mese = $2 and tipo = $3 for update`, [staffId, p.mese, p.tipo]);
    let pdf = pagina, pagine = 1;
    if (es[0]) { pdf = await buste.unisci([buste.decifra(es[0]), pagina]); pagine = es[0].pagine + 1; }
    const c = buste.cifra(pdf);
    // il documento cambia: aperture e firme precedenti non valgono più
    if (es[0]) await qq(`update buste set file=$2, iv=$3, tag=$4, impronta=$5, pagine=$6, aperta_il=null, confermata_il=null,
      firmata_il=null, firma=null, firma_iv=null, firma_tag=null, firmata_disp=null where id=$1`,
      [es[0].id, c.file, c.iv, c.tag, buste.impronta(pdf), pagine]);
    else await qq(`insert into buste (id, staff_id, tipo, mese, file, iv, tag, impronta, pagine, origine) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [db.newId(), staffId, p.tipo, p.mese, c.file, c.iv, c.tag, buste.impronta(pdf), 1, p.origine]);
    await qq('delete from pagine_sospese where id = $1', [p.id]);
  });
  res.json({ ok: true });
}));
app.delete('/api/buste/sospese/:id', needAdmin, wrap(async (req, res) => {
  await db.q('delete from pagine_sospese where id = $1', [req.params.id]);
  res.json({ ok: true });
}));
app.get('/api/buste/sospese/:id/file', needAdmin, wrap(async (req, res) => {
  const { rows } = await db.q('select * from pagine_sospese where id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).send('Non trovata');
  inviaPdf(res, buste.decifra(rows[0]), `pagina-${rows[0].pagina}.pdf`);
}));
app.post('/api/buste/pubblica', needAdmin, wrap(async (req, res) => {
  const tipo = tipoDoc(req.body.tipo), mese = str(req.body.mese, 7);
  if (!periodoOk(tipo, mese)) return bad(res, 400, 'Periodo non valido');
  const { rows: sosp } = await db.q('select count(*)::int n from pagine_sospese where mese = $1 and tipo = $2', [mese, tipo]);
  if (sosp[0].n) return bad(res, 400, `Ci sono ancora ${sosp[0].n} pagine da assegnare o scartare.`);
  const { rows } = await db.q(`update buste set stato = 'pubblicata', pubblicata_il = now() where mese = $1 and tipo = $2 and stato = 'bozza' returning staff_id`, [mese, tipo]);
  const cfg = await caricaConfig(), tit = titoloDoc(tipo, mese), tab = tipo === 'cud' ? 'cudEmp' : 'bpEmp';
  avvisaStaff(cfg, rows.map(r => r.staff_id), { title: tipo === 'cud' ? 'Nuovo CUD' : 'Nuova busta paga', body: `È disponibile: ${tit}. Aprilo e firma per ricevuta.`, url: '/?tab=' + tab },
    { subject: tipo === 'cud' ? 'Nuovo CUD disponibile' : 'Nuova busta paga disponibile',
      text: `È disponibile: ${tit}. Aprilo dall'app Turni con la password di appgestione.it e firma per ricevuta.` });
  res.json({ pubblicate: rows.length });
}));
app.post('/api/buste/sollecito', needAdmin, wrap(async (req, res) => {
  const tipo = tipoDoc(req.body.tipo), mese = str(req.body.mese, 7);
  const { rows } = await db.q(`select staff_id from buste where mese = $1 and tipo = $2 and stato = 'pubblicata' and firmata_il is null and confermata_il is null`, [mese, tipo]);
  const cfg = await caricaConfig(), tit = titoloDoc(tipo, mese), tab = tipo === 'cud' ? 'cudEmp' : 'bpEmp';
  avvisaStaff(cfg, rows.map(r => r.staff_id), { title: 'Documento da firmare', body: `${tit}: aprilo e firma per ricevuta.`, url: '/?tab=' + tab },
    { subject: `Promemoria: ${nomeDoc(tipo)} da firmare`, text: `Ti ricordiamo di aprire ${tit} dall'app Turni e firmare per ricevuta.` });
  res.json({ sollecitati: rows.length });
}));
// Archivio dell'amministrazione: tutte le buste di un mese in un PDF, e il registro delle prese visione
app.get('/api/buste/mese/:mese/pdf', needAdmin, wrap(async (req, res) => {
  const tipo = tipoDoc(req.query.tipo), mese = req.params.mese;
  if (!periodoOk(tipo, mese)) return res.status(400).send('Periodo non valido');
  const { rows } = await db.q('select * from buste where mese = $1 and tipo = $2 order by staff_id', [mese, tipo]);
  if (!rows.length) return res.status(404).send('Nessun documento');
  inviaPdf(res, await buste.unisci(rows.map(b => buste.decifra(b))), `${tipo === 'cud' ? 'cud' : 'buste'}-${mese}.pdf`, true);
}));
app.get('/api/buste/mese/:mese/registro.csv', needAdmin, wrap(async (req, res) => {
  const tipo = tipoDoc(req.query.tipo), mese = req.params.mese;
  if (!periodoOk(tipo, mese)) return res.status(400).send('Periodo non valido');
  const { rows } = await db.q('select * from buste where mese = $1 and tipo = $2 order by staff_id', [mese, tipo]);
  const cfg = await caricaConfig();
  const f = d => d ? new Date(d).toLocaleString('it-IT', { timeZone: 'Europe/Rome' }) : '';
  const righe = [['Dipendente', 'Codice fiscale', 'Documento', 'Pubblicato', 'Aperto', 'Dispositivo apertura', 'Firmato', 'Dispositivo firma', 'Presa visione (senza firma)', 'Impronta SHA-256']]
    .concat(rows.map(b => { const e = staffById(cfg, b.staff_id); return [nome(e), e?.cf || '', titoloDoc(tipo, b.mese), f(b.pubblicata_il), f(b.aperta_il), b.aperta_disp || '',
      f(b.firmata_il), b.firmata_disp || '', b.firmata_il ? '' : f(b.confermata_il), b.impronta]; }));
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': `attachment; filename="registro-${tipo === 'cud' ? 'cud' : 'buste'}-${mese}.csv"` });
  // una cella che inizia con = + - @ verrebbe letta da Excel come formula: la neutralizziamo con un apostrofo
  const cella = x => { let v = String(x ?? ''); if (/^[=+\-@\t\r]/.test(v)) v = "'" + v; return `"${v.replace(/"/g, '""')}"`; };
  res.send('﻿' + righe.map(r => r.map(cella).join(';')).join('\n'));
}));
app.delete('/api/buste/mese/:mese', needAdmin, wrap(async (req, res) => {
  const tipo = tipoDoc(req.query.tipo), mese = req.params.mese;
  if (!periodoOk(tipo, mese)) return bad(res, 400, 'Periodo non valido');
  const r = await db.q('delete from buste where mese = $1 and tipo = $2', [mese, tipo]);
  await db.q('delete from pagine_sospese where mese = $1 and tipo = $2', [mese, tipo]);
  res.json({ eliminate: r.rowCount });
}));
app.delete('/api/buste/:id', needAdmin, wrap(async (req, res) => {
  await db.q(`delete from buste where id = $1 and stato = 'bozza'`, [req.params.id]);
  res.json({ ok: true });
}));
app.get('/api/buste/:id/anteprima', needAdmin, wrap(async (req, res) => {
  const { rows } = await db.q('select * from buste where id = $1', [req.params.id]);
  if (!rows[0]) return res.status(404).send('Non trovata');
  inviaPdf(res, buste.decifra(rows[0]), `${rows[0].tipo === 'cud' ? 'cud' : 'busta'}-${rows[0].mese}.pdf`);
}));
// Copia firmata per l'amministrazione: il documento con in fondo la ricevuta (firma, data, dispositivo, impronta)
app.get('/api/buste/:id/firmata', needAdmin, wrap(async (req, res) => {
  const { rows } = await db.q('select * from buste where id = $1 and firmata_il is not null', [req.params.id]);
  const b = rows[0];
  if (!b) return res.status(404).send('Documento non firmato');
  const cfg = await caricaConfig(), e = staffById(cfg, b.staff_id);
  const pdf = await buste.ricevuta({ documento: buste.decifra(b), nome: nome(e), cf: e?.cf, titolo: titoloDoc(b.tipo, b.mese), firmataIl: b.firmata_il,
    dispositivo: b.firmata_disp, impronta: b.impronta, firmaPng: buste.decifra({ file: b.firma, iv: b.firma_iv, tag: b.firma_tag }) });
  inviaPdf(res, pdf, `${b.tipo === 'cud' ? 'cud' : 'busta'}-${b.mese}-firmata-${String(e?.cognome || 'dipendente').toLowerCase().replace(/[^a-z0-9]+/g, '-')}.pdf`);
}));

// Dipendente: apre la busta con la sua password di appgestione.it
const aperture = new Map(); // gettone → { id, staffId, scade }
const tentativi = new Map();
setInterval(() => { const now = Date.now(); for (const [k, v] of aperture) if (v.scade < now) aperture.delete(k); }, 60000).unref();
app.post('/api/buste/:id/apri', needUser, wrap(async (req, res) => {
  const { e } = await staffDi(req.user);
  if (!e) return bad(res, 403, 'Non sei nell\'elenco del personale.');
  const k = req.user.email, now = Date.now();
  const t = (tentativi.get(k) || []).filter(x => now - x < 15 * 60000);
  if (t.length >= 5) return bad(res, 429, 'Troppi tentativi. Riprova tra 15 minuti.');
  const { rows } = await db.q(`select id, aperta_il from buste where id = $1 and staff_id = $4 and stato = 'pubblicata' and ${VISIBILE}`,
    [req.params.id, cutoff(), cutoffCud(), e.id]);
  if (!rows[0]) return bad(res, 404, 'Documento non disponibile.');
  const u = await accessiStore.findByEmail(req.user.email);
  if (!u?.password_hash || !(await bcrypt.compare(String(req.body.password || ''), u.password_hash))) {
    t.push(now); tentativi.set(k, t);
    return bad(res, 401, 'Password non corretta. È la stessa che usi per entrare in appgestione.it.');
  }
  tentativi.delete(k);
  if (!rows[0].aperta_il) await db.q('update buste set aperta_il = now(), aperta_disp = $2 where id = $1', [rows[0].id, buste.dispositivo(req.get('user-agent'))]);
  const token = crypto.randomBytes(24).toString('base64url');
  aperture.set(token, { id: rows[0].id, staffId: e.id, scade: now + 10 * 60000 });
  res.json({ token });
}));
app.get('/api/buste/:id/file', needUser, wrap(async (req, res) => {
  const a = aperture.get(String(req.query.t || ''));
  if (!a || a.id !== req.params.id || a.scade < Date.now()) return res.status(403).send('Link scaduto: apri di nuovo la busta.');
  const { e } = await staffDi(req.user);
  if (!e || e.id !== a.staffId) return res.status(403).send('Questa busta non è tua.');
  const { rows } = await db.q('select * from buste where id = $1 and staff_id = $2', [a.id, a.staffId]);
  if (!rows[0]) return res.status(404).send('Non trovata');
  inviaPdf(res, buste.decifra(rows[0]), `${rows[0].tipo === 'cud' ? 'cud' : 'busta-paga'}-${rows[0].mese}.pdf`);
}));
// Firma per ricevuta (col dito o col mouse): si salva cifrata, l'amministrazione riceve la ricevuta firmata
app.post('/api/buste/:id/firma', needUser, wrap(async (req, res) => {
  const { cfg, e } = await staffDi(req.user);
  if (!e) return bad(res, 403, 'Non sei nell\'elenco del personale.');
  const m = String(req.body.firma || '').match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  const png = m ? Buffer.from(m[1], 'base64') : null;
  if (!png || png.length < 200 || png.length > 600000 || png.readUInt32BE(0) !== 0x89504e47) return bad(res, 400, 'Firma non valida: firma di nuovo nel riquadro.');
  const c = buste.cifra(png), disp = buste.dispositivo(req.get('user-agent'));
  const { rows } = await db.q(`update buste set firma = $3, firma_iv = $4, firma_tag = $5, firmata_il = now(), firmata_disp = $6,
      confermata_il = coalesce(confermata_il, now()), confermata_disp = coalesce(confermata_disp, $6)
    where id = $1 and staff_id = $2 and stato = 'pubblicata' and aperta_il is not null and firmata_il is null returning *`,
    [req.params.id, e.id, c.file, c.iv, c.tag, disp]);
  if (!rows[0]) return bad(res, 400, 'Apri prima il documento (o è già firmato).');
  res.json({ ok: true });
  const b = rows[0], tit = titoloDoc(b.tipo, b.mese);
  avvisaAdmin({ title: `${b.tipo === 'cud' ? 'CUD' : 'Busta paga'} firmata`, body: `${nome(e)}: ${tit}.`, url: '/?tab=' + (b.tipo === 'cud' ? 'cudAdmin' : 'bpAdmin') });
  if (mail.enabled()) (async () => { // email agli amministratori con la sola ricevuta (il documento resta nell'app)
    const { rows: adm } = await db.q(`select email from users where role = 'admin'`);
    if (!adm.length) return;
    const pdf = await buste.ricevuta({ nome: nome(e), cf: e.cf, titolo: tit, firmataIl: b.firmata_il, dispositivo: disp, impronta: b.impronta, firmaPng: png });
    const testo = `${nome(e)} ha firmato per ricevuta: ${tit}, il ${new Date(b.firmata_il).toLocaleString('it-IT', { timeZone: 'Europe/Rome' })}.`;
    await mail.send({ to: adm.map(a => a.email), subject: `Firmata: ${tit} · ${nome(e)}`, text: testo + ' In allegato la ricevuta firmata.',
      html: mail.layout('Documento firmato', [mail.esc(testo), 'In allegato la ricevuta con la firma. La copia completa firmata è in Turni.'],
        { url: 'https://turni.appgestione.it/?tab=' + (b.tipo === 'cud' ? 'cudAdmin' : 'bpAdmin'), label: 'Apri Turni' }),
      attachments: [{ filename: `ricevuta-${b.tipo}-${b.mese}.pdf`, content: pdf }] });
  })().catch(err => console.warn('Turni, email firma:', err.message));
}));
app.post('/api/buste/:id/conferma', needUser, wrap(async (req, res) => {
  const { e } = await staffDi(req.user);
  if (!e) return bad(res, 403, 'Non sei nell\'elenco del personale.');
  const { rowCount } = await db.q(`update buste set confermata_il = now(), confermata_disp = $3
    where id = $1 and staff_id = $2 and aperta_il is not null and confermata_il is null`, [req.params.id, e.id, buste.dispositivo(req.get('user-agent'))]);
  if (!rowCount) return bad(res, 400, 'Apri prima la busta.');
  res.json({ ok: true });
}));
function inviaPdf(res, buf, nomeFile, scarica) {
  res.set({ 'Content-Type': 'application/pdf', 'Cache-Control': 'no-store, private',
    'Content-Disposition': `${scarica ? 'attachment' : 'inline'}; filename="${nomeFile}"` });
  res.send(buf);
}

/* ---------- notifiche sul dispositivo ---------- */
app.get('/api/push/key', needUser, wrap(async (req, res) => res.json({ key: await push.publicKey() })));
app.post('/api/push/subscribe', needUser, wrap(async (req, res) => {
  const s = req.body.subscription || {};
  if (!s.endpoint || !s.keys?.p256dh || !s.keys?.auth || !/^https:\/\//.test(s.endpoint)) return bad(res, 400, 'Iscrizione non valida');
  await db.q(`insert into push_subs (endpoint, user_id, p256dh, auth) values ($1,$2,$3,$4)
    on conflict (endpoint) do update set user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`,
    [String(s.endpoint).slice(0, 1000), req.user.id, String(s.keys.p256dh).slice(0, 300), String(s.keys.auth).slice(0, 300)]);
  res.json({ ok: true });
}));
app.post('/api/push/unsubscribe', needUser, wrap(async (req, res) => {
  await db.q('delete from push_subs where endpoint = $1 and user_id = $2', [str(req.body.endpoint, 1000), req.user.id]);
  res.json({ ok: true });
}));
app.post('/api/push/test', needUser, wrap(async (req, res) => {
  const reached = await push.sendToUsers([req.user.id], { title: 'Notifiche attive', body: 'Da ora ricevi qui gli avvisi dei Turni.', url: '/' });
  res.json({ ok: reached.size > 0 });
}));
app.post('/api/logout', wrap(async (req, res) => { await sso.logout(req, res); res.json({ ok: true, home: sso.links().home }); }));

/* ---------- pagine ---------- */
const PUB = path.join(__dirname, 'public');
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return req.ssoDenied ? sso.toDenied(res) : sso.toLogin(req, res);
  res.sendFile(path.join(PUB, 'app.html'));
});
app.get(['/admin', '/login'], (req, res) => res.redirect('/'));
app.get('/motore.js', (req, res) => { res.set('Cache-Control', 'no-cache'); res.sendFile(path.join(PUB, 'motore.js')); });
app.get('/sw.js', (req, res) => { res.set({ 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' }); res.sendFile(path.join(PUB, 'sw.js')); });
for (const f of ['manifest.webmanifest', 'icon.svg', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'logo-tosmile.png']) {
  app.get('/' + f, (req, res) => res.sendFile(path.join(PUB, f), { maxAge: '7d' }));
}
app.get('/healthz', (req, res) => res.send('ok'));
app.use((req, res) => res.status(404).send('Pagina non trovata'));

app.use((err, req, res, next) => {
  if (err.status && err.status < 500) return bad(res, err.status, err.message);
  if (err.code === 'LIMIT_FILE_SIZE') return bad(res, 400, 'Il PDF supera 40 MB.');
  if (err.type === 'entity.parse.failed') return bad(res, 400, 'Richiesta non valida');
  console.error('Turni:', err);
  bad(res, 500, 'Errore del server. Riprova.');
});

async function start() { await db.migrate(); }
module.exports = { app, start };
