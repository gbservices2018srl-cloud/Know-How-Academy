// Protocolli (nuova struttura): contenitore dei protocolli assegnati per mansione (figura),
// modello e guida di scrittura, riadeguamento con Claude, letture, test generati e corretti con Claude.
// I flussi di lavoro restano nella tabella "flows" (stesso formato, con in più chi lo fa, protocollo collegato e decisioni Sì/No).
// Nessun dato esistente viene cancellato: i documenti della vecchia mappa vengono COPIATI qui una volta sola.
const db = require('./db');
const crypto = require('crypto');
const consumo = require('./consumo');
const CHAT_LIMITE = Math.max(1, parseInt(process.env.PROT_CHAT_LIMITE || '20', 10) || 20); // domande al giorno per persona
const { pdfText, wordText } = require('./extract');

const MODELLO_BASE = [
  { nome: 'Obiettivo', obbl: true }, { nome: 'Campo di applicazione', obbl: false }, { nome: 'Responsabile', obbl: true },
  { nome: 'Materiali e strumenti', obbl: false }, { nome: 'Procedura', obbl: true }, { nome: 'Cosa fare se…', obbl: false },
  { nome: 'Controlli e registrazioni', obbl: false }, { nome: 'Riferimenti', obbl: false }, { nome: 'Revisione', obbl: false },
];
const SOGLIA = 26, N_MC = 25, N_APERTE = 5;

async function migrate() {
  await db.q(`
    create table if not exists prot (
      id text primary key,
      titolo text not null,
      cartella text not null default 'Generale',
      sezioni jsonb not null default '[]',
      testo text not null default '',
      originale text not null default '',
      conforme boolean not null default false,
      mansioni jsonb not null default '[]',
      file bytea, file_name text, file_mime text,
      source_doc text unique, src_flow text, src_node text,
      creato timestamptz not null default now(),
      aggiornato timestamptz not null default now(),
      aggiornato_da text
    );
    create table if not exists prot_impostazioni (k text primary key, v jsonb not null);
    create table if not exists prot_letture (
      user_id text not null, prot_id text not null, letto timestamptz not null default now(),
      primary key (user_id, prot_id)
    );
    create table if not exists prot_test (
      id text primary key, figura text not null, titolo text not null,
      prot_ids jsonb not null default '[]', domande jsonb not null default '[]',
      scadenza date, origine text, creato timestamptz not null default now(), creato_da text
    );
    create table if not exists prot_invii (
      id text primary key, test_id text not null references prot_test(id) on delete cascade, user_id text not null,
      stato text not null default 'da_fare', risposte jsonb not null default '{}', valutazioni jsonb not null default '{}',
      punti int, esito text, inviato timestamptz not null default now(), consegnato timestamptz, ripetizione_di text
    );
    create index if not exists prot_invii_user on prot_invii(user_id);
    alter table prot_test add column if not exists riserva jsonb not null default '[]';
    create table if not exists prot_chat_cache (chiave text primary key, risposta text not null, fonti jsonb not null default '[]', creato timestamptz not null default now(), usi int not null default 0);
    create table if not exists prot_banca (id text primary key, figura text not null, prot_id text not null, d jsonb not null, creato timestamptz not null default now());
    create index if not exists prot_banca_fig on prot_banca(figura);
    create table if not exists prot_chat_uso (user_id text not null, giorno date not null, n int not null default 0, primary key (user_id, giorno));
  `);
  await importaVecchi();
  await togliEsempi();
}

// Copia una sola volta i documenti della vecchia mappa (gli esempi finiscono nella cartella "Esempi da sostituire"). La tabella docs resta com'è.
async function importaVecchi() {
  const fatto = await getImp('import_fatto');
  if (fatto) return;
  const { rows: docs } = await db.q(`select d.*, f.name as flow_name from docs d left join flows f on f.id = d.flow_id`);
  const { rows: af } = await db.q('select figura, flow_id, mode, nodes from access_figura');
  let n = 0;
  for (const d of docs) {
    const mans = af.filter(a => a.flow_id === d.flow_id && (a.mode === 'all' || (a.mode === 'some' && (a.nodes || []).includes(d.node_id)))).map(a => a.figura);
    const sezioni = daTesto(d.body || '');
    await db.q(`insert into prot (id, titolo, cartella, sezioni, testo, originale, conforme, mansioni, file, file_name, file_mime, source_doc, src_flow, src_node, aggiornato, aggiornato_da)
      values ($1,$2,$3,$4,$5,$6,false,$7,$8,$9,$10,$11,$12,$13,$14,$15) on conflict (source_doc) do nothing`,
      [db.newId(), d.title, d.example ? 'Esempi da sostituire' : (d.flow_name || 'Generale'), JSON.stringify(sezioni), testoDi(d.title, sezioni), d.body || '', JSON.stringify(mans),
        d.file, d.file_name, d.file_mime, d.id, d.flow_id, d.node_id, d.updated_at, d.updated_by]);
    n++;
  }
  await setImp('import_fatto', { quando: new Date().toISOString(), documenti: n });
  if (n) console.log(`Protocolli: copiati ${n} documenti dalla vecchia mappa.`);
}
// Su richiesta del proprietario (08/11/2026) si tolgono dai nuovi Protocolli le copie dei documenti di esempio.
// Solo la copia: la vecchia tabella docs resta intatta.
async function togliEsempi() {
  if (await getImp('esempi_tolti')) return;
  const r = await db.q('delete from prot where source_doc in (select id from docs where example)');
  await setImp('esempi_tolti', { quando: new Date().toISOString(), tolti: r.rowCount });
  console.log(`Protocolli: tolte ${r.rowCount} copie dei documenti di esempio.`);
}

// Testo con titoli "## …" → sezioni
function daTesto(body) {
  const out = []; let cur = null;
  for (const riga of String(body).replace(/\r/g, '').split('\n')) {
    const m = riga.match(/^#{1,4}\s+(.*)/);
    if (m) { cur = { h: m[1].replace(/\*\*/g, '').trim(), t: '' }; out.push(cur); continue; }
    if (!cur) { cur = { h: 'Testo', t: '' }; out.push(cur); }
    cur.t += (cur.t ? '\n' : '') + riga;
  }
  return out.map(s => ({ h: s.h.slice(0, 120), t: s.t.trim() })).filter(s => s.t || s.h !== 'Testo');
}
const testoDi = (titolo, sezioni) => [titolo, ...(sezioni || []).map(s => s.h + '\n' + s.t)].join('\n\n');

async function getImp(k) { const { rows } = await db.q('select v from prot_impostazioni where k = $1', [k]); return rows[0] ? rows[0].v : null; }
async function setImp(k, v) { await db.q('insert into prot_impostazioni (k, v) values ($1,$2) on conflict (k) do update set v = excluded.v', [k, JSON.stringify(v)]); }
async function modello() { return (await getImp('modello')) || MODELLO_BASE; }
async function guida() { const g = await getImp('guida'); return typeof g === 'string' ? g : ''; }

/* ---------- Claude ---------- */
const AI_FUNZ = { 'Riadeguamento protocolli': 'prot_riadegua', 'Generazione test': 'prot_banca', 'Correzione test': 'prot_correzione', 'Assistente in chat': 'prot_chat' };
const claude = (system, user, maxTokens = 4000, funzione) => consumo.chiedi(AI_FUNZ[funzione], system, user, maxTokens, funzione);
function json(txt) {
  const s = String(txt || ''); const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) throw Object.assign(new Error('Risposta non valida dal servizio AI. Riprova.'), { status: 502 });
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { throw Object.assign(new Error('Risposta non valida dal servizio AI. Riprova.'), { status: 502 }); }
}

async function riadegua(titolo, testo) {
  const mod = await modello(), g = await guida();
  const system = `Riorganizzi i protocolli di uno studio odontoiatrico in un modello fisso, in italiano.
Sezioni del modello, in quest'ordine: ${mod.map(s => `"${s.nome}"${s.obbl ? ' (obbligatoria)' : ' (solo se ci sono informazioni)'}`).join(', ')}.
Regole:
- Usa SOLO le informazioni del testo originale. Non inventare nulla: niente dosi, tempi, temperature, nomi o norme che non ci sono.
- Se una sezione obbligatoria non ha informazioni nel testo, scrivi come testo "Da completare" e mettila tra le mancanti.
- Le sezioni facoltative senza informazioni non vanno incluse.
- Procedura: passaggi numerati "1. ", "2. ", una azione per riga, verbo all'imperativo.
- Linguaggio semplice e chiaro.
${g ? `\nGUIDA DI SCRITTURA DELL'AMMINISTRATORE (seguila):\n${g.slice(0, 12000)}\n` : ''}
Rispondi SOLO con JSON: {"titolo":"...","sezioni":[{"h":"nome sezione","t":"testo"}],"mancanti":["nome sezione"]}`;
  const out = json(await claude(system, `TITOLO: ${titolo}\n\nTESTO ORIGINALE:\n"""\n${String(testo).slice(0, 60000)}\n"""`, 6000, 'Riadeguamento protocolli'));
  const sezioni = (Array.isArray(out.sezioni) ? out.sezioni : []).map(s => ({ h: String(s.h || '').slice(0, 120), t: String(s.t || '') })).filter(s => s.h);
  return { titolo: String(out.titolo || titolo).slice(0, 200), sezioni, mancanti: (out.mancanti || []).map(String) };
}

function testoProtPerTest(pp) {
  let budget = 70000;
  return pp.map((p, i) => { let t = `[P${i + 1}] ${p.titolo}\n${(p.testo || '').slice(0, 20000)}`; t = t.slice(0, Math.max(0, budget)); budget -= t.length; return t; }).join('\n\n---\n\n');
}
const SYS_TEST = `Prepari test di verifica sui protocolli di uno studio odontoiatrico, in italiano.
Ogni domanda deve basarsi SOLO sul testo dei protocolli dati: niente conoscenze esterne.
Domande a scelta multipla: 4 risposte plausibili, una sola giusta, indice "ok" da 0 a 3 (varia la posizione della risposta giusta).
Domande aperte: chiedono di spiegare cosa fare; "criteri" elenca i punti che una risposta giusta deve contenere.
Ogni domanda indica "prot" = il codice del protocollo da cui viene (es. "P2"). Distribuisci le domande su tutti i protocolli.`;
async function generaDomande(pp, nMc = N_MC, nAp = N_APERTE, evita = []) {
  const user = `Prepara ${nMc} domande a scelta multipla e ${nAp} domande aperte.${evita.length ? `\nNON ripetere queste domande:\n- ${evita.slice(0, 60).join('\n- ')}` : ''}
Rispondi SOLO con JSON: {"domande":[{"tipo":"mc","t":"domanda","o":["a","b","c","d"],"ok":0,"prot":"P1"},{"tipo":"aperta","t":"domanda","criteri":"punti richiesti","prot":"P1"}]}

PROTOCOLLI:
${testoProtPerTest(pp)}`;
  const out = json(await claude(SYS_TEST, user, 12000, 'Generazione test'));
  const ids = pp.map(p => p.id);
  const pulisci = d => {
    const prot = ids[(parseInt(String(d.prot || '').replace(/\D/g, ''), 10) || 1) - 1] || ids[0];
    if (d.tipo === 'mc' && Array.isArray(d.o) && d.o.length === 4) return { tipo: 'mc', t: String(d.t), o: d.o.map(String), ok: Math.min(3, Math.max(0, +d.ok || 0)), prot };
    if (d.tipo !== 'mc') return { tipo: 'aperta', t: String(d.t), criteri: String(d.criteri || ''), prot };
    return null;
  };
  const tutte = (out.domande || []).map(pulisci).filter(Boolean);
  const mc = tutte.filter(d => d.tipo === 'mc').slice(0, nMc), ap = tutte.filter(d => d.tipo === 'aperta').slice(0, nAp);
  return [...mc, ...ap];
}

async function correggiAperte(domande, risposte) {
  const aperte = domande.map((d, i) => ({ d, i })).filter(x => x.d.tipo === 'aperta');
  const val = {};
  const da = aperte.filter(x => String(risposte[x.i] || '').trim());
  aperte.filter(x => !String(risposte[x.i] || '').trim()).forEach(x => { val[x.i] = { ok: false, motivo: 'Nessuna risposta.', da: 'auto' }; });
  if (!da.length) return val;
  const system = `Correggi risposte aperte di un test sui protocolli di uno studio odontoiatrico. Per ogni risposta decidi se è corretta (true) o no (false) confrontandola con i criteri: è corretta se contiene i punti essenziali, anche con parole diverse. Motivo: una frase breve in italiano. Rispondi SOLO con JSON: {"valutazioni":[{"n":numero,"ok":true,"motivo":"..."}]}`;
  const user = da.map(x => `n=${x.i}\nDOMANDA: ${x.d.t}\nCRITERI: ${x.d.criteri}\nRISPOSTA: ${String(risposte[x.i]).slice(0, 2000)}`).join('\n\n');
  const out = json(await claude(system, user, 2000, 'Correzione test'));
  for (const v of out.valutazioni || []) { const n = +v.n; if (da.some(x => x.i === n)) val[n] = { ok: !!v.ok, motivo: String(v.motivo || ''), da: 'claude' }; }
  da.forEach(x => { if (!val[x.i]) val[x.i] = { ok: false, motivo: 'Da controllare.', da: 'claude' }; });
  return val;
}
function punteggio(domande, risposte, val) {
  let p = 0;
  domande.forEach((d, i) => { if (d.tipo === 'mc' ? risposte[i] === d.ok : val[i]?.ok) p++; });
  return p;
}

let notifiche = null;
try { notifiche = require('../accessi/lib/notifiche'); } catch (e) { console.warn('Protocolli: notifiche non disponibili:', e.message); }
async function avvisa(userIds, payload) {
  if (!notifiche || !userIds.length) return;
  try {
    const { rows } = await db.q('select sso_id from users where id = any($1) and sso_id is not null', [userIds]);
    const r = await notifiche.notifica(rows.map(x => x.sso_id), 'protocolli', payload);
    console.log(`Protocolli: avviso «${payload.title}» a ${userIds.length} persone, raggiunte ${r.raggiunti.size}`);
  } catch (e) { console.warn('Protocolli, avviso non inviato:', e.message); }
}

module.exports = function registra(app, { needUser, needAdmin, wrap, bad, upload, FIGURE, sso, localProfile }) {
  const isAdmin = u => u.role === 'admin';
  const vede = (u, p) => isAdmin(u) || (u.figura && (p.mansioni || []).includes(u.figura));

  async function persone() {
    let only = null;
    if (sso.enabled()) {
      only = new Set();
      for (const c of await sso.usersWithApp()) only.add((await localProfile(c, c.role)).id);
    }
    const { rows } = await db.q('select id, name, username, figura, role from users order by name');
    return rows.filter(u => !only || only.has(u.id));
  }

  app.get('/api/p/state', needUser, wrap(async (req, res) => {
    const u = req.user;
    const { rows } = await db.q(`select id, titolo, cartella, sezioni, testo, conforme, mansioni, (file is not null) as has_file, file_mime,
      src_flow, src_node, to_char(aggiornato, 'YYYY-MM-DD') as agg, aggiornato from prot order by cartella, titolo`);
    const { rows: lett } = await db.q('select prot_id, letto from prot_letture where user_id = $1', [u.id]);
    const lm = Object.fromEntries(lett.map(l => [l.prot_id, l.letto]));
    const prot = rows.filter(p => vede(u, p)).map(p => ({ id: p.id, titolo: p.titolo, cartella: p.cartella, sezioni: p.sezioni, testo: p.testo, conforme: p.conforme,
      mansioni: p.mansioni, hasFile: p.has_file, srcFlow: p.src_flow, srcNode: p.src_node, agg: p.agg, nuovo: !lm[p.id] || new Date(lm[p.id]) < new Date(p.aggiornato) }));
    const { rows: inv } = await db.q(`select i.id, i.stato, i.punti, i.esito, i.risposte, to_char(i.inviato,'YYYY-MM-DD') as inviato, to_char(i.consegnato,'YYYY-MM-DD') as consegnato,
      t.titolo, t.domande, to_char(t.scadenza,'YYYY-MM-DD') as scadenza from prot_invii i join prot_test t on t.id = i.test_id where i.user_id = $1 order by i.inviato desc`, [u.id]);
    const test = inv.map(i => {
      const dom = (i.domande || []).map(d => d.tipo === 'mc' ? { tipo: 'mc', t: d.t, o: d.o } : { tipo: 'aperta', t: d.t });
      const out = { id: i.id, titolo: i.titolo, stato: i.stato, scadenza: i.scadenza, inviato: i.inviato, consegnato: i.consegnato, n: dom.length };
      if (i.stato !== 'consegnato') { out.domande = dom; out.risposte = i.risposte; }
      else { out.punti = i.punti; out.esito = i.esito; }
      return out;
    });
    const aiSt = await consumo.interruttori();
    const out = { chat: aiSt.prot_chat !== 'off', me: { id: u.id, name: u.name, username: u.username, role: u.role, figura: u.figura || '' }, figure: FIGURE, prot, test, soglia: SOGLIA,
      sso: sso.enabled() ? sso.links() : null };
    if (isAdmin(u)) {
      out.modello = await modello(); out.guida = await guida();
      out.cartelle = (await getImp('cartelle')) || [];
      out.ai = await consumo.interruttori();
      const pers = await persone();
      out.persone = pers.map(p => ({ id: p.id, name: p.name || p.username, figura: p.figura || '', role: p.role }));
      const { rows: tl } = await db.q('select user_id, prot_id, letto from prot_letture');
      out.letture = tl.map(l => ({ u: l.user_id, p: l.prot_id, t: l.letto }));
      const { rows: tt } = await db.q(`select id, figura, titolo, prot_ids, domande, to_char(scadenza,'YYYY-MM-DD') as scadenza, origine, to_char(creato,'YYYY-MM-DD') as creato from prot_test order by creato desc limit 100`);
      const { rows: ii } = await db.q(`select id, test_id, user_id, stato, punti, esito, risposte, valutazioni, to_char(inviato,'YYYY-MM-DD') as inviato, to_char(consegnato,'YYYY-MM-DD HH24:MI') as consegnato, ripetizione_di from prot_invii order by inviato desc limit 500`);
      out.tests = tt; out.invii = ii;
      const { rows: bc } = await db.q(`select figura, count(*)::int as n, count(*) filter (where d->>'tipo' = 'mc')::int as mc from prot_banca group by figura`);
      out.banche = {};
      for (const f of FIGURE) { const b = bc.find(x => x.figura === f.id); out.banche[f.id] = { n: b ? b.n : 0, mc: b ? b.mc : 0, stato: await statoBanca(f.id) }; }
    }
    res.json(out);
  }));

  /* ---------- protocolli ---------- */
  const pulisciSez = s => (Array.isArray(s) ? s : []).map(x => ({ h: String(x.h || '').slice(0, 120), t: String(x.t || '').slice(0, 40000) })).filter(x => x.h || x.t).slice(0, 30);
  const figureOk = m => (Array.isArray(m) ? m : []).map(String).filter(f => FIGURE.some(x => x.id === f));
  app.post('/api/p/prot', needAdmin, wrap(async (req, res) => {
    const b = req.body, titolo = String(b.titolo || '').trim().slice(0, 200);
    if (!titolo) return bad(res, 400, 'Manca il titolo.');
    const sezioni = pulisciSez(b.sezioni), cartella = String(b.cartella || 'Generale').trim().slice(0, 80) || 'Generale';
    const testo = testoDi(titolo, sezioni), mans = figureOk(b.mansioni), conf = b.conforme !== false;
    if (b.id) {
      const r = await db.q(`update prot set titolo=$2, cartella=$3, sezioni=$4, testo=$5, mansioni=$6, conforme=$7, aggiornato=now(), aggiornato_da=$8
        ${b.originale !== undefined ? ', originale=$9' : ''} where id=$1`,
        [b.id, titolo, cartella, JSON.stringify(sezioni), testo, JSON.stringify(mans), conf, req.user.id, ...(b.originale !== undefined ? [String(b.originale).slice(0, 200000)] : [])]);
      if (!r.rowCount) return bad(res, 404, 'Protocollo non trovato');
      return res.json({ id: b.id });
    }
    const id = db.newId();
    await db.q(`insert into prot (id, titolo, cartella, sezioni, testo, originale, conforme, mansioni, aggiornato_da) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [id, titolo, cartella, JSON.stringify(sezioni), testo, String(b.originale || '').slice(0, 200000), conf, JSON.stringify(mans), req.user.id]);
    res.json({ id });
  }));
  app.put('/api/p/prot/:id/mansioni', needAdmin, wrap(async (req, res) => {
    await db.q('update prot set mansioni = $2 where id = $1', [req.params.id, JSON.stringify(figureOk(req.body.mansioni))]);
    res.json({ ok: true });
  }));
  app.delete('/api/p/prot/:id', needAdmin, wrap(async (req, res) => {
    await db.q('delete from prot where id = $1', [req.params.id]);
    res.json({ ok: true });
  }));
  // File caricato → testo → riscrittura nel modello (non salva: l'amministratore controlla e poi salva)
  app.post('/api/p/carica', needAdmin, upload.single('file'), wrap(async (req, res) => {
    const f = req.file; if (!f) return bad(res, 400, 'Nessun file.');
    const name = f.originalname || 'file'; let testo = '';
    if (/pdf$/i.test(f.mimetype) || /\.pdf$/i.test(name)) testo = await pdfText(f.buffer);
    else if (/\.docx$/i.test(name)) testo = await wordText(f.buffer);
    else if (/\.(txt|md)$/i.test(name) || /^text\//.test(f.mimetype)) testo = f.buffer.toString('utf8');
    else return bad(res, 400, 'Formato non supportato: carica un PDF, un Word (.docx) o un file di testo.');
    if (!testo.trim()) return bad(res, 400, 'Dal file non si legge nessun testo (forse è una scansione).');
    const titolo = name.replace(/\.[^.]+$/, '').replace(/[_-]+/g, ' ');
    const r = await riadegua(titolo, testo);
    res.json({ ...r, originale: testo, nomeFile: name });
  }));
  app.post('/api/p/prot/:id/riadegua', needAdmin, wrap(async (req, res) => {
    const { rows } = await db.q('select titolo, testo, originale from prot where id = $1', [req.params.id]);
    if (!rows[0]) return bad(res, 404, 'Protocollo non trovato');
    const r = await riadegua(rows[0].titolo, rows[0].originale || rows[0].testo);
    res.json({ ...r, originale: rows[0].originale || rows[0].testo });
  }));
  app.get('/api/p/prot/:id/file', needUser, wrap(async (req, res) => {
    const { rows } = await db.q('select file, mansioni from prot where id = $1', [req.params.id]);
    if (!rows[0]?.file || !vede(req.user, rows[0])) return bad(res, 404, 'Documento non disponibile');
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'inline', 'Cache-Control': 'no-store, private' });
    res.send(rows[0].file);
  }));
  app.post('/api/p/letto/:id', needUser, wrap(async (req, res) => {
    await db.q('insert into prot_letture (user_id, prot_id, letto) values ($1,$2,now()) on conflict (user_id, prot_id) do update set letto = now()', [req.user.id, req.params.id]);
    res.json({ ok: true });
  }));
  app.put('/api/p/impostazioni', needAdmin, wrap(async (req, res) => {
    const b = req.body;
    if (Array.isArray(b.modello)) await setImp('modello', b.modello.map(s => ({ nome: String(s.nome || '').trim().slice(0, 80), obbl: !!s.obbl })).filter(s => s.nome).slice(0, 20));
    if (typeof b.guida === 'string') await setImp('guida', b.guida.slice(0, 30000));
    if (Array.isArray(b.cartelle)) await setImp('cartelle', b.cartelle.map(c => String(c).trim().slice(0, 80)).filter(Boolean).slice(0, 60));
    res.json({ ok: true });
  }));

  /* ---------- test ---------- */
  async function protDi(ids) {
    const { rows } = await db.q('select id, titolo, testo from prot where id = any($1)', [ids]);
    return ids.map(id => rows.find(r => r.id === id)).filter(Boolean);
  }
  /* ---- banca domande per mansione: si genera una volta (solo l'amministratore), i test pescano da lì ---- */
  const BANCA_MC = 250, BANCA_AP = 50;
  const mescola = a => { const b = [...a]; for (let k = b.length - 1; k > 0; k--) { const j = Math.floor(Math.random() * (k + 1)); [b[k], b[j]] = [b[j], b[k]]; } return b; };
  const statoBanca = f => getImp('banca_stato_' + f);
  async function bancaDi(figura, protIds) {
    const { rows } = await db.q('select id, prot_id, d from prot_banca where figura = $1' + (protIds ? ' and prot_id = any($2)' : ''), protIds ? [figura, protIds] : [figura]);
    return rows.map(r => ({ ...r.d, bid: r.id, prot: r.prot_id }));
  }
  const lavoriBanca = new Set();
  async function generaBanca(figura, pp, uid) {
    if (lavoriBanca.has(figura)) return;
    lavoriBanca.add(figura);
    // domande divise tra i protocolli in base alla lunghezza del testo (i testi corti ne reggono meno)
    const lun = pp.map(p => Math.max(400, (p.testo || '').length)), tot = lun.reduce((a, b) => a + b, 0);
    const piano = pp.map((p, i) => { const cap = Math.max(6, Math.floor(lun[i] / 100)); const n = Math.min(cap, Math.max(6, Math.round((BANCA_MC + BANCA_AP) * lun[i] / tot)));
      const ap = Math.max(1, Math.round(n * BANCA_AP / (BANCA_MC + BANCA_AP))); return { p, mc: n - ap, ap }; });
    const totale = piano.reduce((s, x) => s + x.mc + x.ap, 0);
    const nuove = [];
    await setImp('banca_stato_' + figura, { stato: 'in_corso', fatte: 0, totale, quando: new Date().toISOString() });
    try {
      for (const x of piano) {
        let mc = x.mc, ap = x.ap, giri = 0;
        while ((mc > 0 || ap > 0) && giri++ < 8) {
          const chiedeMc = Math.min(25, mc), chiedeAp = Math.min(5, ap);
          const d = await generaDomande([x.p], chiedeMc, chiedeAp, nuove.filter(q => q.prot === x.p.id).map(q => q.t));
          const okMc = d.filter(q => q.tipo === 'mc'), okAp = d.filter(q => q.tipo !== 'mc');
          nuove.push(...okMc, ...okAp); mc -= okMc.length; ap -= okAp.length;
          if (!d.length) break;
          await setImp('banca_stato_' + figura, { stato: 'in_corso', fatte: nuove.length, totale, quando: new Date().toISOString() });
        }
      }
      if (nuove.length < 30) throw new Error('domande generate troppo poche');
      const c = await db.pool.connect();
      try {
        await c.query('begin');
        await c.query('delete from prot_banca where figura = $1', [figura]);
        for (const q of nuove) { const { prot, ...d } = q; await c.query('insert into prot_banca (id, figura, prot_id, d) values ($1,$2,$3,$4)', [db.newId(), figura, prot, JSON.stringify(d)]); }
        await c.query('commit');
      } catch (e) { await c.query('rollback'); throw e; } finally { c.release(); }
      await setImp('banca_stato_' + figura, { stato: 'pronta', fatte: nuove.length, totale: nuove.length, quando: new Date().toISOString() });
      console.log(`Protocolli: banca ${figura} pronta con ${nuove.length} domande`);
    } catch (e) {
      console.warn('Protocolli: banca non generata:', e.message);
      await setImp('banca_stato_' + figura, { stato: 'errore', fatte: nuove.length, totale, msg: e.spenta ? 'La generazione è spenta negli interruttori AI.' : 'Generazione interrotta: la banca precedente resta valida. Riprova più tardi.', quando: new Date().toISOString() });
    } finally { lavoriBanca.delete(figura); }
  }
  app.get('/api/p/banca/:figura', needAdmin, wrap(async (req, res) => {
    const b = await bancaDi(req.params.figura);
    res.json({ domande: b.map(d => ({ bid: d.bid, tipo: d.tipo, t: d.t, o: d.o, ok: d.ok, criteri: d.criteri, prot: d.prot })), stato: await statoBanca(req.params.figura) });
  }));
  app.post('/api/p/banca/:figura/genera', needAdmin, wrap(async (req, res) => {
    const figura = req.params.figura;
    if (!FIGURE.some(f => f.id === figura)) return bad(res, 400, 'Mansione sconosciuta.');
    if ((await consumo.stato('prot_banca')) === 'off') return bad(res, 400, 'La generazione della banca è spenta negli interruttori AI (pannello accessi → Consumo AI).');
    if (lavoriBanca.has(figura)) return bad(res, 400, 'La banca di questa mansione è già in preparazione.');
    const { rows } = await db.q('select id, titolo, testo, mansioni from prot');
    const pp = rows.filter(p => (p.mansioni || []).includes(figura));
    if (!pp.length) return bad(res, 400, 'Nessun protocollo assegnato a questa mansione.');
    generaBanca(figura, pp, req.user.id);
    res.json({ ok: true });
  }));
  app.delete('/api/p/banca/domanda/:bid', needAdmin, wrap(async (req, res) => {
    await db.q('delete from prot_banca where id = $1', [req.params.bid]);
    res.json({ ok: true });
  }));
  // sceglie a caso 25 domande a scelta multipla e 5 aperte (se le aperte mancano, completa con scelte multiple)
  function pesca(banca, evita = new Set()) {
    const libere = banca.filter(d => !evita.has(d.t));
    const usa = libere.length >= N_MC + N_APERTE ? libere : banca;
    const ap = mescola(usa.filter(d => d.tipo !== 'mc')).slice(0, N_APERTE);
    const mc = mescola(usa.filter(d => d.tipo === 'mc')).slice(0, N_MC + N_APERTE - ap.length);
    return mescola(mc).concat(ap).map(({ bid, ...d }) => d);
  }
  app.post('/api/p/test/componi', needAdmin, wrap(async (req, res) => {
    const figura = String(req.body.figura || ''), ids = (req.body.protIds || []).map(String);
    if (!FIGURE.some(f => f.id === figura)) return bad(res, 400, 'Scegli la mansione.');
    const banca = await bancaDi(figura, ids.length ? ids : null);
    if (banca.length < N_MC + N_APERTE) return bad(res, 400, `Nella banca ci sono solo ${banca.length} domande per questi protocolli: ne servono almeno ${N_MC + N_APERTE}. Genera la banca o scegli più protocolli.`);
    const domande = pesca(banca);
    const id = db.newId(), mese = new Date().toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
    const protIds = [...new Set(banca.map(d => d.prot))];
    await db.q('insert into prot_test (id, figura, titolo, prot_ids, domande, creato_da) values ($1,$2,$3,$4,$5,$6)',
      [id, figura, `Test protocolli ${figura} · ${mese}`, JSON.stringify(ids.length ? ids : protIds), JSON.stringify(domande), req.user.id]);
    res.json({ id, domande });
  }));
  // "Cambia": sostituisce una domanda con un'altra della banca dello stesso tipo (gratis)
  app.post('/api/p/test/:id/rigenera/:n', needAdmin, wrap(async (req, res) => {
    const { rows } = await db.q('select * from prot_test where id = $1', [req.params.id]);
    const t = rows[0]; if (!t) return bad(res, 404, 'Test non trovato');
    const n = +req.params.n, d = t.domande[n]; if (!d) return bad(res, 404, 'Domanda non trovata');
    const usate = new Set(t.domande.map(x => x.t));
    const altre = (await bancaDi(t.figura, t.prot_ids)).filter(x => x.tipo === d.tipo && !usate.has(x.t));
    if (!altre.length) return bad(res, 400, 'Nella banca non ci sono altre domande di questo tipo.');
    const { bid, ...nuova } = altre[Math.floor(Math.random() * altre.length)];
    t.domande[n] = nuova;
    await db.q('update prot_test set domande = $2 where id = $1', [t.id, JSON.stringify(t.domande)]);
    res.json({ domanda: nuova });
  }));
  app.post('/api/p/test/:id/invia', needAdmin, wrap(async (req, res) => {
    const ids = (req.body.userIds || []).map(String), scad = /^\d{4}-\d{2}-\d{2}$/.test(req.body.scadenza || '') ? req.body.scadenza : null;
    if (!ids.length) return bad(res, 400, 'Scegli almeno una persona.');
    await db.q('update prot_test set scadenza = $2 where id = $1', [req.params.id, scad]);
    for (const uid of ids) await db.q('insert into prot_invii (id, test_id, user_id) values ($1,$2,$3)', [db.newId(), req.params.id, uid]);
    const { rows: tt } = await db.q('select titolo from prot_test where id = $1', [req.params.id]);
    avvisa(ids, { title: 'Nuovo test da fare', body: (tt[0]?.titolo || 'Test protocolli') + (scad ? ` · entro il ${scad.split('-').reverse().join('/')}` : ''), url: '/?v=test', tag: 'test-' + req.params.id });
    res.json({ ok: true, inviati: ids.length });
  }));
  // per la Scheda personale (passaggio di ruolo): test composto dalla banca della mansione e mandato alla persona
  module.exports.api = {
    async testPassaggio({ ssoId, figura, ruolo }) {
      if (!FIGURE.some(f => f.id === figura)) return { errore: 'figura' };
      const banca = await bancaDi(figura, null);
      if (banca.length < N_MC + N_APERTE) return { errore: 'banca', domande: banca.length };
      const { rows: [u] } = await db.q('select id from users where sso_id = $1', [ssoId]);
      if (!u) return { errore: 'utente' };
      const id = db.newId(), invio = db.newId();
      await db.q('insert into prot_test (id, figura, titolo, prot_ids, domande, creato_da) values ($1,$2,$3,$4,$5,$6)',
        [id, figura, `Test per diventare ${ruolo}`.slice(0, 200), JSON.stringify([...new Set(banca.map(d => d.prot))]), JSON.stringify(pesca(banca)), u.id]);
      await db.q('insert into prot_invii (id, test_id, user_id) values ($1,$2,$3)', [invio, id, u.id]);
      return { invio };
    },
    async esitoInvio(invio) {
      const { rows: [i] } = await db.q('select stato, esito, punti from prot_invii where id = $1', [invio]);
      return i || null;
    },
  };
  app.delete('/api/p/test/:id', needAdmin, wrap(async (req, res) => {
    await db.q('delete from prot_test where id = $1', [req.params.id]);
    res.json({ ok: true });
  }));
  async function mioInvio(req) {
    const { rows } = await db.q('select i.*, t.domande, t.prot_ids, t.figura, t.titolo from prot_invii i join prot_test t on t.id = i.test_id where i.id = $1', [req.params.id]);
    const i = rows[0];
    if (!i || i.user_id !== req.user.id) { const e = new Error('Test non trovato'); e.status = 400; throw e; }
    return i;
  }
  app.put('/api/p/invio/:id/risposte', needUser, wrap(async (req, res) => {
    const i = await mioInvio(req); if (i.stato === 'consegnato') return bad(res, 400, 'Test già consegnato.');
    const r = {}; const src = req.body.risposte || {};
    i.domande.forEach((d, n) => { if (src[n] === undefined || src[n] === null) return; r[n] = d.tipo === 'mc' ? Math.min(3, Math.max(0, +src[n])) : String(src[n]).slice(0, 3000); });
    await db.q(`update prot_invii set risposte = $2, stato = 'in_corso' where id = $1`, [i.id, JSON.stringify(r)]);
    res.json({ ok: true });
  }));
  // Chi non supera il test ne riceve un altro pescato dalla banca, evitando le domande che ha già avuto (nessuna chiamata all'AI).
  async function ripetizione(i) {
    try {
      const { rows: t0 } = await db.q('select origine from prot_test where id = $1', [i.test_id]);
      const radiceId = t0[0]?.origine || i.test_id;
      const { rows: avute } = await db.q(`select t.domande from prot_invii v join prot_test t on t.id = v.test_id where v.user_id = $1 and (t.id = $2 or t.origine = $2)`, [i.user_id, radiceId]);
      const gia = new Set(avute.flatMap(a => (a.domande || []).map(d => d.t)));
      const banca = await bancaDi(i.figura, i.prot_ids);
      const domande = banca.length >= 10 ? pesca(banca, gia) : [];
      if (domande.length < 10) { console.warn('Protocolli: banca vuota, ripetizione non creata per', i.user_id); return; }
      const tid = db.newId();
      await db.q('insert into prot_test (id, figura, titolo, prot_ids, domande, origine, creato_da) values ($1,$2,$3,$4,$5,$6,$7)',
        [tid, i.figura, i.titolo.replace(/ · ripetizione$/, '') + ' · ripetizione', JSON.stringify(i.prot_ids), JSON.stringify(domande), radiceId, 'auto']);
      await db.q('insert into prot_invii (id, test_id, user_id, ripetizione_di) values ($1,$2,$3,$4)', [db.newId(), tid, i.user_id, i.id]);
      avvisa([i.user_id], { title: 'Test da ripetere', body: 'Ripassa i protocolli indicati e rifai il test: le domande sono nuove.', url: '/?v=test', tag: 'test-' + tid });
    } catch (e) { console.warn('Protocolli: ripetizione non creata:', e.message); }
  }
  app.post('/api/p/invio/:id/consegna', needUser, wrap(async (req, res) => {
    const i = await mioInvio(req); if (i.stato === 'consegnato') return bad(res, 400, 'Test già consegnato.');
    const r = {}; const src = req.body.risposte || i.risposte || {};
    i.domande.forEach((d, n) => { if (src[n] === undefined || src[n] === null) return; r[n] = d.tipo === 'mc' ? Math.min(3, Math.max(0, +src[n])) : String(src[n]).slice(0, 3000); });
    let val;
    try { val = (await consumo.stato('prot_correzione')) === 'off' ? null : await correggiAperte(i.domande, r); }
    catch (e) { console.warn('Protocolli: correzione automatica non riuscita:', e.message); val = null; }
    if (!val) { // le risposte aperte le corregge l'amministratore: l'esito arriva dopo
      val = {}; i.domande.forEach((d, n) => { if (d.tipo !== 'mc') val[n] = String(r[n] || '').trim() ? { ok: null, da: 'attesa' } : { ok: false, motivo: 'Nessuna risposta.', da: 'auto' }; });
    }
    const attesa = Object.values(val).some(v => v.ok === null);
    const punti = attesa ? null : punteggio(i.domande, r, val), esito = attesa ? 'in_correzione' : punti >= SOGLIA ? 'superato' : 'da_ripetere';
    await db.q(`update prot_invii set risposte=$2, valutazioni=$3, punti=$4, esito=$5, stato='consegnato', consegnato=now() where id=$1`, [i.id, JSON.stringify(r), JSON.stringify(val), punti, esito]);
    if (esito === 'da_ripetere') ripetizione(i);
    res.json({ punti, esito, totale: i.domande.length });
  }));
  // Esito per l'utente: punteggio e domande sbagliate (con il protocollo da rileggere)
  app.get('/api/p/invio/:id/esito', needUser, wrap(async (req, res) => {
    const i = await mioInvio(req); if (i.stato !== 'consegnato') return bad(res, 400, 'Test non ancora consegnato.');
    if (i.esito === 'in_correzione') return res.json({ esito: 'in_correzione', totale: i.domande.length, errori: [] });
    const { rows: pp } = await db.q('select id, titolo from prot where id = any($1)', [i.prot_ids]);
    const errori = i.domande.map((d, n) => ({ d, n })).filter(x => x.d.tipo === 'mc' ? i.risposte[x.n] !== x.d.ok : !i.valutazioni[x.n]?.ok)
      .map(x => ({ t: x.d.t, giusta: x.d.tipo === 'mc' ? x.d.o[x.d.ok] : null, nota: x.d.tipo === 'aperta' ? (i.valutazioni[x.n]?.motivo || '') : null, prot: x.d.prot, protT: (pp.find(p => p.id === x.d.prot) || {}).titolo || '' }));
    res.json({ punti: i.punti, esito: i.esito, totale: i.domande.length, errori });
  }));
  app.post('/api/p/invio/:id/valuta', needAdmin, wrap(async (req, res) => {
    const { rows } = await db.q('select i.*, t.domande, t.prot_ids, t.figura, t.titolo from prot_invii i join prot_test t on t.id = i.test_id where i.id = $1', [req.params.id]);
    const i = rows[0]; if (!i || i.stato !== 'consegnato') return bad(res, 400, 'Test non consegnato.');
    const n = +req.body.n; if (i.domande[n]?.tipo !== 'aperta') return bad(res, 400, 'Domanda non valida.');
    i.valutazioni[n] = { ...(i.valutazioni[n] || {}), ok: !!req.body.ok, da: 'admin' };
    const attesa = i.domande.some((d, k) => d.tipo !== 'mc' && (i.valutazioni[k]?.ok === null || i.valutazioni[k]?.ok === undefined));
    const punti = attesa ? null : punteggio(i.domande, i.risposte, i.valutazioni), esito = attesa ? 'in_correzione' : punti >= SOGLIA ? 'superato' : 'da_ripetere';
    await db.q('update prot_invii set valutazioni=$2, punti=$3, esito=$4 where id=$1', [i.id, JSON.stringify(i.valutazioni), punti, esito]);
    if (i.esito === 'in_correzione' && !attesa) avvisa([i.user_id], { title: 'Esito del test pronto', body: `${punti}/${i.domande.length} · ${esito === 'superato' ? 'superato' : 'da ripetere'}`, url: '/?v=test', tag: 'esito-' + i.id });
    if (esito === 'da_ripetere' && i.esito !== 'da_ripetere') {
      const { rows: g } = await db.q('select 1 from prot_invii where ripetizione_di = $1', [i.id]);
      if (!g.length) ripetizione(i);
    }
    res.json({ punti, esito });
  }));

  /* ---------- assistente in chat (risponde solo dai protocolli che la persona può vedere) ---------- */
  const chatHits = new Map();
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
  const VUOTE = new Set('come cosa quando quale quali dove perche chi della delle dello degli dei del dal dalla dalle alla alle allo agli con per tra fra sono essere fare devo deve devono posso puoi questo questa quello quella anche ancora molto poco tutto tutti tutte prima dopo sopra sotto nella nelle negli nello allora quindi oppure sempre'.split(' '));
  function pertinenti(lista, domanda) {
    const parole = [...new Set(norm(domanda).split(/[^a-z0-9]+/).filter(w => w.length >= 4 && !VUOTE.has(w)))];
    const radici = parole.map(w => w.length > 6 ? w.slice(0, w.length - 2) : w);
    const punteggio = (t, peso) => radici.reduce((s, r) => s + (norm(t).split(r).length - 1) * peso, 0);
    return lista.map(p => ({ p, s: punteggio(p.titolo, 6) + punteggio(p.testo, 1) })).filter(x => x.s > 0).sort((a, b) => b.s - a.s).slice(0, 6).map(x => {
      let t = x.p.testo || '';
      if (t.length > 12000) { // tiene i paragrafi più pertinenti, nell'ordine originale
        const par = t.split(/\n{2,}/).map((c, i) => ({ c, i, s: punteggio(c, 1) }));
        const scelti = new Set(); let n = 0;
        for (const q of [...par].sort((a, b) => b.s - a.s)) { if (n + q.c.length > 12000) continue; scelti.add(q.i); n += q.c.length; }
        t = par.filter(q => scelti.has(q.i)).map(q => q.c).join('\n[…]\n');
      }
      return { id: x.p.id, titolo: x.p.titolo, testo: t };
    });
  }
  const oggi = () => new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  async function usoOggi(uid) { const { rows } = await db.q('select n from prot_chat_uso where user_id = $1 and giorno = $2', [uid, oggi()]); return rows[0] ? rows[0].n : 0; }
  async function contaUso(uid) { const { rows } = await db.q('insert into prot_chat_uso (user_id, giorno, n) values ($1,$2,1) on conflict (user_id, giorno) do update set n = prot_chat_uso.n + 1 returning n', [uid, oggi()]); return rows[0].n; }
  app.get('/api/p/chat/rimaste', needUser, wrap(async (req, res) => res.json({ rimaste: Math.max(0, CHAT_LIMITE - await usoOggi(req.user.id)), limite: CHAT_LIMITE })));
  app.post('/api/p/chat', needUser, wrap(async (req, res) => {
    if ((await consumo.stato('prot_chat')) === 'off') return bad(res, 403, 'L’assistente è spento.');
    const now = Date.now(), h = (chatHits.get(req.user.id) || []).filter(t => now - t < 60000);
    if (h.length >= 12) return bad(res, 429, 'Troppe domande ravvicinate. Riprova tra un minuto.');
    h.push(now); chatHits.set(req.user.id, h);
    const msgs = (Array.isArray(req.body.messages) ? req.body.messages : []).slice(-8)
      .map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '').slice(0, 3000).replace(/\s?\[\d+(?:\s*,\s*\d+)*\]/g, '') })).filter(m => m.content);
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    if (!msgs.length || msgs[msgs.length - 1].role !== 'user') return bad(res, 400, 'Scrivi una domanda.');
    const { rows } = await db.q('select id, titolo, testo, mansioni, aggiornato from prot');
    const visibili = rows.filter(p => vede(req.user, p));
    const domande = msgs.filter(m => m.role === 'user').map(m => m.content);
    const fonti = pertinenti(visibili, domande.slice(-2).join('\n'));
    // stessa domanda (prima della conversazione) con gli stessi protocolli non cambiati → risposta salvata, gratis e non conta nel limite
    const agg = Object.fromEntries(visibili.map(p => [p.id, new Date(p.aggiornato).toISOString()]));
    const chiave = msgs.length === 1 ? crypto.createHash('sha256').update(norm(domande[0]).replace(/[^a-z0-9]+/g, ' ').trim() + '|' + fonti.map(f => f.id + ':' + agg[f.id]).join(',')).digest('hex') : null;
    const usate = await usoOggi(req.user.id);
    if (chiave) {
      const { rows: c } = await db.q('select risposta, fonti from prot_chat_cache where chiave = $1', [chiave]);
      if (c[0]) { db.q('update prot_chat_cache set usi = usi + 1 where chiave = $1', [chiave]).catch(() => {}); return res.json({ text: c[0].risposta, fonti: c[0].fonti, salvata: true, rimaste: Math.max(0, CHAT_LIMITE - usate), limite: CHAT_LIMITE }); }
    }
    if (usate >= CHAT_LIMITE) return bad(res, 429, `Hai usato le ${CHAT_LIMITE} domande di oggi. Domani ne avrai di nuovo ${CHAT_LIMITE}.`);
    const system = `Sei l'assistente interno di uno studio odontoiatrico. Rispondi a ${req.user.name || 'un collaboratore'} in italiano, in modo chiaro e pratico.
Regole:
- Usa SOLO le informazioni dei PROTOCOLLI qui sotto. Non aggiungere conoscenze esterne e non inventare procedure, dosi o tempi.
- Dopo ogni informazione presa da un protocollo cita il suo numero tra parentesi quadre, per esempio [2].
- Se la risposta non c'è nei protocolli, dillo chiaramente e consiglia di chiedere all'amministratore.
- Per le procedure usa passaggi numerati. Risposte brevi: al massimo circa 200 parole.
- Formattazione ammessa: paragrafi, elenchi con "-" o "1.", **grassetto**.

PROTOCOLLI:
${fonti.length ? fonti.map((f, i) => `[${i + 1}] ${f.titolo}\n${f.testo}`).join('\n\n---\n\n') : '(nessun protocollo pertinente trovato)'}`;
    const text = await claude(system, msgs, 1200, 'Assistente in chat');
    const fl = fonti.map(f => ({ id: f.id, titolo: f.titolo }));
    const n = await contaUso(req.user.id);
    if (chiave && text) db.q('insert into prot_chat_cache (chiave, risposta, fonti) values ($1,$2,$3) on conflict (chiave) do nothing', [chiave, text, JSON.stringify(fl)]).catch(() => {});
    res.json({ text: text || 'Non è arrivata una risposta. Prova a riformulare la domanda.', fonti: fl, rimaste: Math.max(0, CHAT_LIMITE - n), limite: CHAT_LIMITE });
  }));

  return { migrate };
};
module.exports.migrate = migrate;
module.exports._interni = { daTesto, testoDi, punteggio };
