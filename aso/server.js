// Gestione ASO — server (gira nello stesso servizio delle altre app, all'indirizzo appgestione.it/aso/).
// Raccoglie tre app: Magazzino (già esistente, magazzino.appgestione.it), Compliance sterilizzazione e
// Registro impianti (UDI). Si entra solo con l'accesso unico; i permessi sono nel pannello Gestione accessi:
//   Amministratore → tutte le sedi; Operatore → solo le sedi assegnate (ogni studio vede il suo).
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const express = require('express');
const db = require('./lib/db');
const accessi = require('../accessi/server');
const store = accessi.store;
const etichetta = require('../magazzino/lib/etichetta');

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => {
  res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' });
  next();
});
// foto in base64 (già ridotte dal telefono): fino a qualche MB
app.use(express.json({ limit: '9mb' }));

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, code, msg) => res.status(code).json({ error: msg });
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const fail = (status, msg) => Object.assign(new Error(msg), { status });
const isDate = s => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(Date.parse(s + 'T00:00:00Z'));
const oggi = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome' }).format(new Date());
const BASE = '/aso';

/* ---------- chi sta usando l'app ---------- */
// Permessi per app: { admin, sedi: [{id, nome}] } (admin vede tutte le sedi attive). Magazzino: solo se c'è.
const APPS_ASO = ['sterilizzazione', 'registro_udi', 'manutenzione'];
let sediCache = null, sediT = 0;
async function tutteLeSedi() {
  if (!sediCache || Date.now() - sediT > 60000) { sediCache = (await store.listSedi()).filter(s => s.attiva !== false).map(s => ({ id: s.id, nome: s.nome })); sediT = Date.now(); }
  return sediCache;
}
app.use(wrap(async (req, res, next) => {
  const c = await store.check(accessi.readCookie(req));
  if (!c) return next();
  const u = c.user, owner = !!u.owner;
  const spente = await store.appSpente();
  const lv = owner ? {} : await store.livelliOf(u.id);
  const perm = {};
  for (const k of APPS_ASO) {
    const role = c.apps[k];
    if (!role) continue;
    if (role !== 'admin' && !owner && spente.has(k)) { perm[k] = { spenta: true }; continue; }
    if (role === 'admin' || owner) perm[k] = { admin: true, sedi: await tutteLeSedi() };
    else perm[k] = { admin: false, sedi: (lv[k]?.enti || []).map(e => ({ id: e.id, nome: String(e.nome || '').split(' · ')[0] })) };
  }
  req.me = { id: u.id, nome: `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.email, owner, perm,
    magazzino: !!c.apps.magazzino && (owner || c.apps.magazzino === 'admin' || !spente.has('magazzino')) };
  next();
}));
const needUser = (req, res, next) => req.me ? next() : bad(res, 401, 'Accesso richiesto');
const permDi = (req, k) => { const p = req.me?.perm?.[k]; return p && !p.spenta ? p : null; };
const need = k => (req, res, next) => permDi(req, k) ? next() : bad(res, 403, 'Non sei abilitato a questa sezione.');
// la sede richiesta è tra quelle della persona?
function sedeOk(req, k, sedeId) {
  const p = permDi(req, k);
  return p && p.sedi.some(s => s.id === sedeId) ? p.sedi.find(s => s.id === sedeId) : null;
}
// Le richieste che cambiano dati devono essere JSON (un modulo di un altro sito non può inviarle).
app.use('/api', (req, res, next) => (['GET', 'HEAD', 'DELETE'].includes(req.method) || req.is('application/json')) ? next() : bad(res, 415, 'Formato non valido'));

/* ---------- foto ---------- */
async function salvaFoto(dataUrl, sedeId) {
  if (!dataUrl) return null;
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(dataUrl));
  if (!m) throw fail(400, 'Foto non valida.');
  const dati = Buffer.from(m[2], 'base64');
  if (dati.length > 6e6) throw fail(400, 'La foto è troppo grande.');
  const id = db.newId();
  await db.q('insert into foto (id, mime, dati, sede_id) values ($1,$2,$3,$4)', [id, m[1], dati, sedeId || '']);
  return id;
}
app.get('/api/foto/:id', needUser, wrap(async (req, res) => {
  const { rows } = await db.q('select mime, dati, sede_id from foto where id = $1', [str(req.params.id, 60)]);
  const f = rows[0];
  if (!f || !APPS_ASO.some(k => sedeOk(req, k, f.sede_id))) return bad(res, 404, 'Foto non trovata.');
  res.set({ 'Content-Type': f.mime, 'Cache-Control': 'private, max-age=86400' });
  res.send(f.dati);
}));

/* ---------- stato ---------- */
app.get('/api/stato', needUser, wrap(async (req, res) => {
  const p = req.me.perm;
  res.json({ me: { id: req.me.id, nome: req.me.nome },
    sterilizzazione: p.sterilizzazione || null, udi: p.registro_udi || null, manutenzione: p.manutenzione || null, voci: VOCI, magazzino: req.me.magazzino ? 'https://magazzino.appgestione.it' : null,
    ai: !!process.env.ANTHROPIC_API_KEY, oggi: oggi(), home: accessi.publicUrl() });
}));

/* ============ COMPLIANCE STERILIZZAZIONE ============ */
const ST = 'sterilizzazione';
const SPORE_GIORNI = 30;
const shapeTest = t => ({ id: t.id, tipo: t.tipo, esito: t.esito, note: t.note, fotoId: t.foto_id, operatore: t.operatore_nome, creatoIl: t.creato_il, aggiornatoIl: t.aggiornato_il });
const shapeCiclo = c => ({ id: c.id, numero: c.numero, temperatura: c.temperatura, esito: c.esito, note: c.note, fotoId: c.foto_id, operatore: c.operatore_nome, creatoIl: c.creato_il });

// Stato di ogni sterilizzatrice oggi: test giornalieri fatti, spore in scadenza, avvisi
async function statoMacchine(ids) {
  if (!ids.length) return new Map();
  const g = oggi();
  const { rows } = await db.q(`select m.id,
      (select json_agg(json_build_object('tipo', t.tipo, 'esito', t.esito)) from test t join schede s on s.id = t.scheda_id
        where s.macchina_id = m.id and s.giorno = $2 and t.tipo in ('bd','helix')) as test_oggi,
      (select count(*)::int from cicli c join schede s on s.id = c.scheda_id where s.macchina_id = m.id and s.giorno = $2) as cicli_oggi,
      (select max(s.giorno)::text from test t join schede s on s.id = t.scheda_id where s.macchina_id = m.id and t.tipo = 'spore') as ultima_spore,
      (select count(*)::int from test t join schede s on s.id = t.scheda_id where s.macchina_id = m.id and t.tipo = 'spore' and t.esito = 'attesa') as spore_attesa,
      (select id from schede s where s.macchina_id = m.id and s.giorno = $2) as scheda_oggi
    from sterilizzatrici m where m.id = any($1)`, [ids, g]);
  const dom = new Date(g + 'T12:00:00Z').getUTCDay() === 0; // la domenica i test giornalieri non si chiedono
  const out = new Map();
  for (const r of rows) {
    const t = r.test_oggi || [];
    const fatto = tipo => t.find(x => x.tipo === tipo);
    const avvisi = [];
    for (const [tipo, nome] of [['bd', 'Bowie-Dick'], ['helix', 'Helix']]) {
      const x = fatto(tipo);
      if (x?.esito === 'ko') avvisi.push({ livello: 'rosso', testo: `${nome} di oggi NON superato` });
      else if (!x && r.cicli_oggi) avvisi.push({ livello: 'rosso', testo: `Cicli registrati oggi senza ${nome}` });
      else if (!x && !dom) avvisi.push({ livello: 'giallo', testo: `${nome} di oggi da fare` });
    }
    const gg = r.ultima_spore ? Math.floor((Date.parse(g) - Date.parse(r.ultima_spore)) / 864e5) : null;
    if (gg === null) avvisi.push({ livello: 'rosso', testo: 'Test delle spore mai registrato' });
    else if (gg > SPORE_GIORNI) avvisi.push({ livello: 'rosso', testo: `Test delle spore scaduto da ${gg - SPORE_GIORNI} giorni` });
    else if (gg > SPORE_GIORNI - 5) avvisi.push({ livello: 'giallo', testo: `Test delle spore in scadenza tra ${SPORE_GIORNI - gg} giorni` });
    if (r.spore_attesa) avvisi.push({ livello: 'giallo', testo: 'Test delle spore in incubazione: inserisci l\'esito' });
    out.set(r.id, { bd: fatto('bd')?.esito || null, helix: fatto('helix')?.esito || null, cicliOggi: r.cicli_oggi,
      ultimaSpore: r.ultima_spore, prossimaSpore: r.ultima_spore ? new Date(Date.parse(r.ultima_spore) + SPORE_GIORNI * 864e5).toISOString().slice(0, 10) : null,
      schedaOggi: r.scheda_oggi, avvisi });
  }
  return out;
}

app.get('/api/steri/macchine', needUser, need(ST), wrap(async (req, res) => {
  const p = permDi(req, ST);
  const sedi = p.sedi.map(s => s.id);
  const { rows } = await db.q(`select * from sterilizzatrici where sede_id = any($1) ${req.query.tutte === '1' ? '' : 'and attiva'} order by sede_nome, marca, modello`, [sedi]);
  const st = await statoMacchine(rows.map(r => r.id));
  res.json({ macchine: rows.map(m => ({ id: m.id, sedeId: m.sede_id, sede: p.sedi.find(s => s.id === m.sede_id)?.nome || m.sede_nome,
    marca: m.marca, modello: m.modello, matricola: m.matricola, attiva: m.attiva, stato: st.get(m.id) })) });
}));
app.post('/api/steri/macchine', needUser, need(ST), wrap(async (req, res) => {
  const sede = sedeOk(req, ST, str(req.body.sede, 80));
  if (!sede) return bad(res, 400, 'Scegli la sede.');
  const marca = str(req.body.marca, 80), modello = str(req.body.modello, 80), matricola = str(req.body.matricola, 80);
  if (!marca) return bad(res, 400, 'Scrivi la marca della sterilizzatrice.');
  const id = db.newId();
  await db.q('insert into sterilizzatrici (id, sede_id, sede_nome, marca, modello, matricola) values ($1,$2,$3,$4,$5,$6)', [id, sede.id, sede.nome, marca, modello, matricola]);
  res.json({ id });
}));
async function macchinaMia(req, id) {
  const { rows } = await db.q('select * from sterilizzatrici where id = $1', [str(id, 60)]);
  const m = rows[0];
  if (!m || !sedeOk(req, ST, m.sede_id)) throw fail(404, 'Sterilizzatrice non trovata.');
  return m;
}
app.put('/api/steri/macchine/:id', needUser, need(ST), wrap(async (req, res) => {
  const m = await macchinaMia(req, req.params.id);
  const marca = str(req.body.marca, 80) || m.marca;
  await db.q('update sterilizzatrici set marca = $2, modello = $3, matricola = $4, attiva = $5 where id = $1',
    [m.id, marca, str(req.body.modello ?? m.modello, 80), str(req.body.matricola ?? m.matricola, 80), req.body.attiva !== false]);
  res.json({ ok: true });
}));

// Scheda del giorno: si apre con la data di oggi e chi la apre; una sola per sterilizzatrice e giorno
app.post('/api/steri/schede', needUser, need(ST), wrap(async (req, res) => {
  const m = await macchinaMia(req, req.body.macchina);
  const giorno = isDate(str(req.body.giorno, 10)) ? str(req.body.giorno, 10) : oggi();
  if (giorno > oggi()) return bad(res, 400, 'Non si può aprire una scheda per un giorno futuro.');
  await db.q(`insert into schede (id, macchina_id, sede_id, giorno, aperta_da, aperta_da_nome) values ($1,$2,$3,$4,$5,$6)
    on conflict (macchina_id, giorno) do nothing`, [db.newId(), m.id, m.sede_id, giorno, req.me.id, req.me.nome]);
  const { rows } = await db.q('select id from schede where macchina_id = $1 and giorno = $2', [m.id, giorno]);
  res.json({ id: rows[0].id });
}));
async function schedaMia(req, id) {
  const { rows } = await db.q('select s.*, to_char(s.giorno, \'YYYY-MM-DD\') as g from schede s where s.id = $1', [str(id, 60)]);
  const s = rows[0];
  if (!s || !sedeOk(req, ST, s.sede_id)) throw fail(404, 'Scheda non trovata.');
  return s;
}
app.get('/api/steri/schede/:id', needUser, need(ST), wrap(async (req, res) => {
  const s = await schedaMia(req, req.params.id);
  const m = await macchinaMia(req, s.macchina_id);
  const [{ rows: t }, { rows: c }] = await Promise.all([
    db.q('select * from test where scheda_id = $1 order by creato_il', [s.id]),
    db.q('select * from cicli where scheda_id = $1 order by creato_il', [s.id])]);
  const st = (await statoMacchine([m.id])).get(m.id);
  res.json({ id: s.id, giorno: s.g, apertaDa: s.aperta_da_nome, creataIl: s.creata_il, oggi: s.g === oggi(),
    macchina: { id: m.id, marca: m.marca, modello: m.modello, matricola: m.matricola, sede: sedeOk(req, ST, m.sede_id)?.nome || m.sede_nome },
    test: t.map(shapeTest), cicli: c.map(shapeCiclo), stato: st });
}));
// Storico delle schede di una sterilizzatrice (ultimi 120 giorni, o il periodo chiesto)
app.get('/api/steri/storico', needUser, need(ST), wrap(async (req, res) => {
  const m = await macchinaMia(req, req.query.macchina);
  const a = isDate(str(req.query.a, 10)) ? str(req.query.a, 10) : oggi();
  const da = isDate(str(req.query.da, 10)) ? str(req.query.da, 10) : new Date(Date.parse(a) - 120 * 864e5).toISOString().slice(0, 10);
  const { rows } = await db.q(`select s.id, to_char(s.giorno, 'YYYY-MM-DD') as giorno, s.aperta_da_nome,
      (select json_agg(json_build_object('tipo', t.tipo, 'esito', t.esito) order by t.creato_il) from test t where t.scheda_id = s.id) as test,
      (select count(*)::int from cicli c where c.scheda_id = s.id) as cicli,
      (select count(*)::int from cicli c where c.scheda_id = s.id and c.esito = 'ko') as cicli_ko
    from schede s where s.macchina_id = $1 and s.giorno between $2 and $3 order by s.giorno desc`, [m.id, da, a]);
  res.json({ schede: rows.map(r => ({ id: r.id, giorno: r.giorno, apertaDa: r.aperta_da_nome, test: r.test || [], cicli: r.cicli, cicliKo: r.cicli_ko })) });
}));

const ESITI = ['ok', 'ko', 'attesa'];
app.post('/api/steri/schede/:id/test', needUser, need(ST), wrap(async (req, res) => {
  const s = await schedaMia(req, req.params.id);
  const tipo = str(req.body.tipo, 10), esito = str(req.body.esito, 10);
  if (!['bd', 'helix', 'spore'].includes(tipo)) return bad(res, 400, 'Tipo di test non valido.');
  if (!ESITI.includes(esito) || (esito === 'attesa' && tipo !== 'spore')) return bad(res, 400, 'Scegli l\'esito del test.');
  const foto = await salvaFoto(req.body.foto, s.sede_id);
  const id = db.newId();
  await db.q(`insert into test (id, scheda_id, tipo, esito, note, foto_id, operatore_id, operatore_nome) values ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [id, s.id, tipo, esito, str(req.body.note, 1000), foto, req.me.id, req.me.nome]);
  res.json({ id });
}));
async function testMio(req, id) {
  const { rows } = await db.q('select t.*, s.sede_id from test t join schede s on s.id = t.scheda_id where t.id = $1', [str(id, 60)]);
  if (!rows[0] || !sedeOk(req, ST, rows[0].sede_id)) throw fail(404, 'Test non trovato.');
  return rows[0];
}
// Aggiorna un test (es. l'esito delle spore dopo l'incubazione, o una foto aggiunta dopo)
app.put('/api/steri/test/:id', needUser, need(ST), wrap(async (req, res) => {
  const t = await testMio(req, req.params.id);
  const esito = str(req.body.esito, 10) || t.esito;
  if (!ESITI.includes(esito) || (esito === 'attesa' && t.tipo !== 'spore')) return bad(res, 400, 'Esito non valido.');
  const foto = req.body.foto ? await salvaFoto(req.body.foto, t.sede_id) : t.foto_id;
  await db.q(`update test set esito = $2, note = $3, foto_id = $4, aggiornato_il = now(),
      operatore_nome = case when $5 <> '' then operatore_nome || ' · aggiornato da ' || $5 else operatore_nome end where id = $1`,
    [t.id, esito, str(req.body.note ?? t.note, 1000), foto, t.operatore_id === req.me.id ? '' : req.me.nome]);
  res.json({ ok: true });
}));
const puoCancellare = (req, r) => permDi(req, ST)?.admin || (r.operatore_id === req.me.id && Date.now() - new Date(r.creato_il) < 24 * 3600e3);
app.delete('/api/steri/test/:id', needUser, need(ST), wrap(async (req, res) => {
  const t = await testMio(req, req.params.id);
  if (!puoCancellare(req, t)) return bad(res, 403, 'Puoi togliere solo un test che hai registrato tu nelle ultime 24 ore (o chiedere all\'amministratore).');
  await db.q('delete from test where id = $1', [t.id]);
  res.json({ ok: true });
}));

app.post('/api/steri/schede/:id/cicli', needUser, need(ST), wrap(async (req, res) => {
  const s = await schedaMia(req, req.params.id);
  const temp = Number(req.body.temperatura);
  if (![121, 134].includes(temp)) return bad(res, 400, 'Scegli la temperatura del ciclo: 134 °C o 121 °C.');
  const numero = str(req.body.numero, 30);
  if (!numero) return bad(res, 400, 'Scrivi il numero del ciclo dell\'autoclave.');
  const esito = str(req.body.esito, 4) === 'ko' ? 'ko' : 'ok';
  const foto = await salvaFoto(req.body.foto, s.sede_id);
  if (!foto) return bad(res, 400, 'Aggiungi la foto della vapor line.');
  const id = db.newId();
  await db.q(`insert into cicli (id, scheda_id, numero, temperatura, esito, note, foto_id, operatore_id, operatore_nome) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [id, s.id, numero, temp, esito, str(req.body.note, 1000), foto, req.me.id, req.me.nome]);
  res.json({ id });
}));
app.delete('/api/steri/cicli/:id', needUser, need(ST), wrap(async (req, res) => {
  const { rows } = await db.q('select c.*, s.sede_id from cicli c join schede s on s.id = c.scheda_id where c.id = $1', [str(req.params.id, 60)]);
  const c = rows[0];
  if (!c || !sedeOk(req, ST, c.sede_id)) return bad(res, 404, 'Ciclo non trovato.');
  if (!puoCancellare(req, c)) return bad(res, 403, 'Puoi togliere solo un ciclo che hai registrato tu nelle ultime 24 ore (o chiedere all\'amministratore).');
  await db.q('delete from cicli where id = $1', [c.id]);
  res.json({ ok: true });
}));

/* ---------- Scarica e svuota (solo amministratore) ---------- */
// ZIP "store" scritto un file alla volta (le foto non stanno tutte in memoria insieme)
function zipStream(res) {
  const cd = []; let off = 0;
  const now = new Date();
  const t = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1);
  const d = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
  const w = b => { off += b.length; return res.write(b) ? null : new Promise(r => res.once('drain', r)); };
  return {
    async add(name, data) {
      data = Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8');
      const nb = Buffer.from(name, 'utf8'), crc = zlib.crc32(data), h = Buffer.alloc(30);
      h.writeUInt32LE(0x04034b50, 0); h.writeUInt16LE(20, 4); h.writeUInt16LE(0x0800, 6); h.writeUInt16LE(0, 8);
      h.writeUInt16LE(t, 10); h.writeUInt16LE(d, 12); h.writeUInt32LE(crc, 14); h.writeUInt32LE(data.length, 18); h.writeUInt32LE(data.length, 22);
      h.writeUInt16LE(nb.length, 26); h.writeUInt16LE(0, 28);
      cd.push({ nb, crc, size: data.length, off });
      await w(h); await w(nb); await w(data);
    },
    async end() {
      const start = off;
      for (const e of cd) {
        const c = Buffer.alloc(46);
        c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(0x0800, 8); c.writeUInt16LE(0, 10);
        c.writeUInt16LE(t, 12); c.writeUInt16LE(d, 14); c.writeUInt32LE(e.crc, 16); c.writeUInt32LE(e.size, 20); c.writeUInt32LE(e.size, 24);
        c.writeUInt16LE(e.nb.length, 28); c.writeUInt32LE(e.off, 42);
        await w(c); await w(e.nb);
      }
      const z = Buffer.alloc(22);
      z.writeUInt32LE(0x06054b50, 0); z.writeUInt16LE(cd.length, 8); z.writeUInt16LE(cd.length, 10); z.writeUInt32LE(off - start, 12); z.writeUInt32LE(start, 16);
      await w(z); res.end();
    },
  };
}
const adminST = req => !!permDi(req, ST)?.admin;
const escH = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const csv = rows => '﻿' + rows.map(r => r.map(v => { const x = String(v ?? ''); return /[;"\n\r]/.test(x) ? '"' + x.replace(/"/g, '""') + '"' : x; }).join(';')).join('\r\n');
const oraIt = d => new Intl.DateTimeFormat('it-IT', { timeZone: 'Europe/Rome', hour: '2-digit', minute: '2-digit' }).format(new Date(d));
const dataIt = g => { const [y, m, dd] = String(g).slice(0, 10).split('-'); return `${dd}/${m}/${y}`; };
const slug = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'x';
const NOMI_T = { bd: 'Bowie-Dick', helix: 'Helix test', spore: 'Test delle spore' };
const ESITI_T = { ok: 'Superato', ko: 'NON superato', attesa: 'In incubazione' };

// Scarica tutti i dati della sterilizzatrice fino a questo momento (ZIP: registro HTML con le foto, CSV per Excel, foto)
app.get('/api/steri/macchine/:id/esporta', needUser, need(ST), wrap(async (req, res) => {
  if (!adminST(req)) return bad(res, 403, 'Solo l\'amministratore può scaricare e svuotare i dati.');
  const m = await macchinaMia(req, req.params.id);
  const { rows: [{ ora: cut }] } = await db.q('select now() as ora');
  const { rows: schede } = await db.q(`select id, to_char(giorno, 'YYYY-MM-DD') as giorno, aperta_da_nome, creata_il from schede
    where macchina_id = $1 and creata_il <= $2 order by giorno`, [m.id, cut]);
  const ids = schede.map(x => x.id);
  const { rows: test } = await db.q('select t.*, f.mime from test t left join foto f on f.id = t.foto_id where scheda_id = any($1) and creato_il <= $2 order by creato_il', [ids, cut]);
  const { rows: cicli } = await db.q('select c.*, f.mime from cicli c left join foto f on f.id = c.foto_id where scheda_id = any($1) and creato_il <= $2 order by creato_il', [ids, cut]);
  const giornoDi = new Map(schede.map(x => [x.id, x.giorno]));
  const ext = mime => mime === 'image/png' ? 'png' : mime === 'image/webp' ? 'webp' : 'jpg';
  const nomeFoto = (r, cosa) => r.foto_id ? `foto/${giornoDi.get(r.scheda_id)}_${cosa}_${r.foto_id.slice(0, 8)}.${ext(r.mime)}` : '';
  const foto = [...test.map(t => [t.foto_id, nomeFoto(t, t.tipo)]), ...cicli.map(c => [c.foto_id, nomeFoto(c, 'ciclo-' + slug(c.numero))])].filter(x => x[0]);
  const id = db.newId(), sede = sedeOk(req, ST, m.sede_id)?.nome || m.sede_nome, nomeM = `${m.marca} ${m.modello}`.trim();
  const conteggi = { schede: schede.length, test: test.length, cicli: cicli.length, foto: foto.length };
  await db.q('insert into esportazioni (id, macchina_id, sede_id, fatta_il, fatta_da, conteggi) values ($1,$2,$3,$4,$5,$6)', [id, m.id, m.sede_id, cut, req.me.nome, JSON.stringify(conteggi)]);
  const file = `sterilizzazione_${slug(sede)}_${slug(nomeM)}_${oggi()}.zip`;
  res.set({ 'Content-Type': 'application/zip', 'Content-Disposition': `attachment; filename="${file}"`, 'X-Esportazione': id,
    'X-Conteggi': JSON.stringify(conteggi), 'Cache-Control': 'no-store', 'Access-Control-Expose-Headers': 'X-Esportazione, X-Conteggi, Content-Disposition' });
  const z = zipStream(res);
  // registro leggibile e stampabile
  const perScheda = s => {
    const tt = test.filter(t => t.scheda_id === s.id), cc = cicli.filter(c => c.scheda_id === s.id);
    const img = r => r.foto_id ? `<a href="${nomeFoto(r, r.tipo || 'ciclo-' + slug(r.numero))}"><img src="${nomeFoto(r, r.tipo || 'ciclo-' + slug(r.numero))}" alt=""></a>` : '<span class="no">senza foto</span>';
    return `<section><h2>${dataIt(s.giorno)}</h2><p class="m">Scheda aperta da ${escH(s.aperta_da_nome)} alle ${oraIt(s.creata_il)}</p>
      ${tt.length ? `<table><tr><th>Test</th><th>Esito</th><th>Operatore</th><th>Ora</th><th>Note</th><th>Foto</th></tr>${tt.map(t => `<tr class="${t.esito}"><td>${NOMI_T[t.tipo]}</td><td><b>${ESITI_T[t.esito]}</b></td><td>${escH(t.operatore_nome)}</td><td>${oraIt(t.creato_il)}</td><td>${escH(t.note)}</td><td>${img(t)}</td></tr>`).join('')}</table>` : '<p class="no">Nessun test registrato</p>'}
      ${cc.length ? `<table><tr><th>Ciclo n.</th><th>Temperatura</th><th>Vapor line</th><th>Operatore</th><th>Ora</th><th>Note</th><th>Foto</th></tr>${cc.map(c => `<tr class="${c.esito}"><td><b>${escH(c.numero)}</b></td><td>${c.temperatura ? c.temperatura + ' °C' : ''}</td><td><b>${c.esito === 'ok' ? 'Virata' : 'NON virata'}</b></td><td>${escH(c.operatore_nome)}</td><td>${oraIt(c.creato_il)}</td><td>${escH(c.note)}</td><td>${img(c)}</td></tr>`).join('')}</table>` : ''}
    </section>`;
  };
  await z.add('Registro sterilizzazione.html', `<!doctype html><html lang="it"><head><meta charset="utf-8"><title>Registro sterilizzazione · ${escH(nomeM)} · ${escH(sede)}</title>
<style>body{font:14px/1.45 system-ui,sans-serif;color:#1f2a2b;max-width:1000px;margin:24px auto;padding:0 16px}h1{margin:0 0 4px}h2{font-size:17px;margin:22px 0 2px;border-top:2px solid #2B8384;padding-top:10px}
.m{color:#5e6b6c;margin:0 0 8px}table{width:100%;border-collapse:collapse;margin:6px 0 10px}th,td{border:1px solid #dce7e7;padding:5px 8px;text-align:left;vertical-align:top}th{background:#eff5f5;font-size:12px}
tr.ko td{background:#fbe3e0}tr.attesa td{background:#efe7f2}img{width:90px;height:90px;object-fit:cover;border-radius:6px}.no{color:#999}section{break-inside:avoid}@media print{a{color:inherit}}</style></head><body>
<h1>Registro sterilizzazione</h1><p class="m"><b>${escH(nomeM)}</b>${m.matricola ? ' · matricola ' + escH(m.matricola) : ''} · sede ${escH(sede)}<br>
Esportato il ${dataIt(oggi())} alle ${oraIt(cut)} da ${escH(req.me.nome)} · ${schede.length} schede, ${test.length} test, ${cicli.length} cicli, ${foto.length} foto${schede.length ? ` · dal ${dataIt(schede[0].giorno)} al ${dataIt(schede[schede.length - 1].giorno)}` : ''}</p>
${schede.map(perScheda).join('') || '<p>Nessuna scheda.</p>'}</body></html>`);
  await z.add('test.csv', csv([['Data', 'Ora', 'Test', 'Esito', 'Operatore', 'Note', 'Foto'],
    ...test.map(t => [dataIt(giornoDi.get(t.scheda_id)), oraIt(t.creato_il), NOMI_T[t.tipo], ESITI_T[t.esito], t.operatore_nome, t.note, nomeFoto(t, t.tipo)])]));
  await z.add('cicli.csv', csv([['Data', 'Ora', 'Numero ciclo', 'Temperatura (°C)', 'Vapor line', 'Operatore', 'Note', 'Foto'],
    ...cicli.map(c => [dataIt(giornoDi.get(c.scheda_id)), oraIt(c.creato_il), c.numero, c.temperatura || '', c.esito === 'ok' ? 'Virata' : 'NON virata', c.operatore_nome, c.note, nomeFoto(c, 'ciclo-' + slug(c.numero))])]));
  for (const [fid, nome] of foto) {
    const { rows } = await db.q('select dati from foto where id = $1', [fid]);
    if (rows[0]) await z.add(nome, rows[0].dati);
  }
  await z.end();
}));

// Dopo lo scarico: cancella dall'app i dati scaricati (solo quelli fino al momento dello scarico).
// Restano: la scheda di oggi, l'ultimo test delle spore (serve per la scadenza del prossimo) e le spore ancora in incubazione.
app.post('/api/steri/esportazioni/:id/cancella', needUser, need(ST), wrap(async (req, res) => {
  if (!adminST(req)) return bad(res, 403, 'Solo l\'amministratore può svuotare i dati.');
  const { rows: [e] } = await db.q('select * from esportazioni where id = $1', [str(req.params.id, 60)]);
  if (!e || !sedeOk(req, ST, e.sede_id)) return bad(res, 404, 'Scarico non trovato.');
  if (e.cancellata_il) return bad(res, 400, 'Questi dati sono già stati cancellati.');
  if (Date.now() - new Date(e.fatta_il) > 6 * 3600e3) return bad(res, 400, 'Lo scarico è di più di 6 ore fa: scarica di nuovo i dati prima di cancellarli.');
  const cut = e.fatta_il, g = oggi();
  const client = await db.pool.connect();
  try {
    await client.query('begin');
    const { rows: [sp] } = await client.query(`select t.id from test t join schede s on s.id = t.scheda_id where s.macchina_id = $1 and t.tipo = 'spore'
      order by s.giorno desc, t.creato_il desc limit 1`, [e.macchina_id]);
    const tenere = sp?.id || '';
    const fotoT = await client.query(`delete from test t using schede s where s.id = t.scheda_id and s.macchina_id = $1 and s.giorno < $3
      and t.creato_il <= $2 and t.aggiornato_il <= $2 and t.esito <> 'attesa' and t.id <> $4 returning t.foto_id`, [e.macchina_id, cut, g, tenere]);
    const fotoC = await client.query(`delete from cicli c using schede s where s.id = c.scheda_id and s.macchina_id = $1 and s.giorno < $3
      and c.creato_il <= $2 returning c.foto_id`, [e.macchina_id, cut, g]);
    const sch = await client.query(`delete from schede s where s.macchina_id = $1 and s.giorno < $3 and s.creata_il <= $2
      and not exists (select 1 from test t where t.scheda_id = s.id) and not exists (select 1 from cicli c where c.scheda_id = s.id)`, [e.macchina_id, cut, g]);
    const fids = [...fotoT.rows, ...fotoC.rows].map(r => r.foto_id).filter(Boolean);
    const fo = fids.length ? await client.query('delete from foto f where id = any($1) and not exists (select 1 from test where foto_id = f.id) and not exists (select 1 from cicli where foto_id = f.id)', [fids]) : { rowCount: 0 };
    const cancellati = { schede: sch.rowCount, test: fotoT.rowCount, cicli: fotoC.rowCount, foto: fo.rowCount };
    await client.query('update esportazioni set cancellata_il = now(), cancellata_da = $2, cancellati = $3 where id = $1', [e.id, req.me.nome, JSON.stringify(cancellati)]);
    await client.query('commit');
    console.log(`Gestione ASO: dati della sterilizzatrice ${e.macchina_id} cancellati da ${req.me.nome} dopo lo scarico`, cancellati);
    res.json({ ok: true, cancellati });
  } catch (x) { await client.query('rollback').catch(() => {}); throw x; }
  finally { client.release(); }
}));
// Ultimi scarichi della sterilizzatrice (per l'amministratore)
app.get('/api/steri/macchine/:id/esportazioni', needUser, need(ST), wrap(async (req, res) => {
  if (!adminST(req)) return bad(res, 403, 'Solo l\'amministratore.');
  const m = await macchinaMia(req, req.params.id);
  const { rows } = await db.q('select * from esportazioni where macchina_id = $1 order by fatta_il desc limit 20', [m.id]);
  res.json({ esportazioni: rows.map(r => ({ id: r.id, fattaIl: r.fatta_il, fattaDa: r.fatta_da, conteggi: r.conteggi, cancellataIl: r.cancellata_il, cancellataDa: r.cancellata_da, cancellati: r.cancellati })) });
}));

// Lettura della foto (vapor line o stampa dell'autoclave) con l'AI: numero di ciclo, temperatura, viraggio
async function chiediAI(dataUrl, prompt) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw fail(400, 'La lettura automatica delle foto non è attiva.');
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(dataUrl || ''));
  if (!m) throw fail(400, 'Foto non valida.');
  let r;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model: process.env.ASO_AI_MODEL || process.env.MAG_AI_MODEL || 'claude-sonnet-5-5', max_tokens: 800,
        messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: m[1], data: m[2] } }, { type: 'text', text: prompt }] }] }),
      signal: AbortSignal.timeout(60000),
    });
  } catch { throw fail(502, 'La lettura ha impiegato troppo. Riprova o compila a mano.'); }
  const j = await r.json().catch(() => ({}));
  if (!r.ok) { console.warn('ASO lettura foto:', r.status, JSON.stringify(j).slice(0, 200)); throw fail(502, 'La lettura automatica non ha risposto. Compila a mano.'); }
  const txt = (j.content || []).filter(c => c.type === 'text').map(c => c.text).join('');
  try { return JSON.parse(txt.slice(txt.indexOf('{'), txt.lastIndexOf('}') + 1)); } catch { throw fail(502, 'Non sono riuscito a leggere la foto. Compila a mano.'); }
}
app.post('/api/steri/leggi-ciclo', needUser, need(ST), wrap(async (req, res) => {
  const o = await chiediAI(req.body.foto, `Foto scattata in uno studio dentistico dopo un ciclo di sterilizzazione in autoclave: un indicatore chimico (vapor line / integratore) e/o lo scontrino o il display dell'autoclave.
Rispondi SOLO con JSON: {"numero":"","temperatura":134,"esito":"ok","dubbi":[]}
- "numero": il numero del ciclo dell'autoclave se scritto o stampato, altrimenti vuoto.
- "temperatura": 134 o 121 se si legge (o se il programma lo indica), altrimenti null.
- "esito": "ok" se l'indicatore ha virato completamente / il ciclo risulta concluso correttamente, "ko" se non ha virato o il ciclo è fallito, "" se non si capisce.
- "dubbi": brevi note in italiano su cosa non si legge.`);
  const t = Number(o.temperatura);
  res.json({ numero: str(o.numero, 30), temperatura: [121, 134].includes(t) ? t : null, esito: ['ok', 'ko'].includes(o.esito) ? o.esito : '',
    dubbi: (Array.isArray(o.dubbi) ? o.dubbi : []).slice(0, 4).map(x => str(x, 160)) });
}));

/* ============ REGISTRO IMPIANTI (UDI) ============ */
const UD = 'registro_udi';
const shapeImpianto = (r, p) => ({ id: r.id, sedeId: r.sede_id, sede: p.sedi.find(s => s.id === r.sede_id)?.nome || r.sede_nome,
  dataIntervento: r.data_intervento, pazienteCognome: r.paziente_cognome, pazienteNome: r.paziente_nome, denti: r.denti || [],
  medico: r.medico, prodotto: r.prodotto, produttore: r.produttore, ref: r.ref, udi: r.udi, gtin: r.gtin, lotto: r.lotto,
  scadenza: r.scadenza, seriale: r.seriale, note: r.note, fotoId: r.foto_id, operatore: r.operatore_nome, creatoIl: r.creato_il });
const COLS_IMP = `id, sede_id, sede_nome, to_char(data_intervento, 'YYYY-MM-DD') as data_intervento, paziente_cognome, paziente_nome, denti, medico,
  prodotto, produttore, ref, udi, gtin, lotto, to_char(scadenza, 'YYYY-MM-DD') as scadenza, seriale, note, foto_id, operatore_id, operatore_nome, creato_il`;

app.get('/api/udi', needUser, need(UD), wrap(async (req, res) => {
  const p = permDi(req, UD);
  const sede = str(req.query.sede, 80);
  const sedi = sede && sedeOk(req, UD, sede) ? [sede] : p.sedi.map(s => s.id);
  const params = [sedi];
  let f = 'true';
  const t = str(req.query.q, 80);
  if (t) { // ricerca per cognome e/o nome del paziente (anche "rossi mario" o "mario rossi")
    const parole = t.toLowerCase().split(/\s+/).filter(Boolean).slice(0, 4);
    f = parole.map(w => { params.push('%' + w.replace(/[\\%_]/g, c => '\\' + c) + '%'); return `(lower(paziente_cognome) like $${params.length} or lower(paziente_nome) like $${params.length})`; }).join(' and ');
  }
  const { rows } = await db.q(`select ${COLS_IMP} from impianti where sede_id = any($1) and ${f} order by data_intervento desc, creato_il desc limit 500`, params);
  res.json({ impianti: rows.map(r => shapeImpianto(r, p)) });
}));
function campiImpianto(b) {
  const data = str(b.dataIntervento, 10), scad = str(b.scadenza, 10);
  const denti = (Array.isArray(b.denti) ? b.denti : []).map(Number).filter(n => (n >= 11 && n <= 48) || (n >= 51 && n <= 85)).slice(0, 32);
  const f = { data, cognome: str(b.pazienteCognome, 80), nome: str(b.pazienteNome, 80), denti: [...new Set(denti)], medico: str(b.medico, 120),
    prodotto: str(b.prodotto, 160), produttore: str(b.produttore, 120), ref: str(b.ref, 60), udi: str(b.udi, 300), gtin: str(b.gtin, 14).replace(/\D/g, ''),
    lotto: str(b.lotto, 40), scadenza: isDate(scad) ? scad : null, seriale: str(b.seriale, 40), note: str(b.note, 1000) };
  if (!isDate(data)) throw fail(400, 'Scegli la data dell\'intervento.');
  if (!f.cognome) throw fail(400, 'Scrivi il cognome del paziente.');
  if (!f.medico) throw fail(400, 'Scrivi il medico che ha eseguito l\'intervento.');
  if (!f.lotto && !f.udi && !f.gtin) throw fail(400, 'Servono almeno il lotto o il codice UDI: fotografa l\'etichetta o scrivili a mano.');
  return f;
}
app.post('/api/udi', needUser, need(UD), wrap(async (req, res) => {
  const sede = sedeOk(req, UD, str(req.body.sede, 80));
  if (!sede) return bad(res, 400, 'Scegli la sede.');
  const f = campiImpianto(req.body);
  const foto = await salvaFoto(req.body.foto, sede.id);
  const id = db.newId();
  await db.q(`insert into impianti (id, sede_id, sede_nome, data_intervento, paziente_cognome, paziente_nome, denti, medico, prodotto, produttore, ref, udi, gtin,
      lotto, scadenza, seriale, note, foto_id, operatore_id, operatore_nome) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20)`,
    [id, sede.id, sede.nome, f.data, f.cognome, f.nome, f.denti, f.medico, f.prodotto, f.produttore, f.ref, f.udi, f.gtin, f.lotto, f.scadenza, f.seriale, f.note, foto, req.me.id, req.me.nome]);
  res.json({ id });
}));
async function impiantoMio(req, id) {
  const { rows } = await db.q(`select ${COLS_IMP} from impianti where id = $1`, [str(id, 60)]);
  if (!rows[0] || !sedeOk(req, UD, rows[0].sede_id)) throw fail(404, 'Registrazione non trovata.');
  return rows[0];
}
app.put('/api/udi/:id', needUser, need(UD), wrap(async (req, res) => {
  const r = await impiantoMio(req, req.params.id);
  const f = campiImpianto(req.body);
  const foto = req.body.foto ? await salvaFoto(req.body.foto, r.sede_id) : r.foto_id;
  await db.q(`update impianti set data_intervento=$2, paziente_cognome=$3, paziente_nome=$4, denti=$5, medico=$6, prodotto=$7, produttore=$8, ref=$9, udi=$10,
      gtin=$11, lotto=$12, scadenza=$13, seriale=$14, note=$15, foto_id=$16, aggiornato_il=now() where id=$1`,
    [r.id, f.data, f.cognome, f.nome, f.denti, f.medico, f.prodotto, f.produttore, f.ref, f.udi, f.gtin, f.lotto, f.scadenza, f.seriale, f.note, foto]);
  res.json({ ok: true });
}));
app.delete('/api/udi/:id', needUser, need(UD), wrap(async (req, res) => {
  const r = await impiantoMio(req, req.params.id);
  if (!permDi(req, UD).admin && !(r.operatore_id === req.me.id && Date.now() - new Date(r.creato_il) < 24 * 3600e3))
    return bad(res, 403, 'Puoi eliminare solo una registrazione fatta da te nelle ultime 24 ore (o chiedere all\'amministratore).');
  await db.q('delete from impianti where id = $1', [r.id]);
  res.json({ ok: true });
}));
// Codice letto dalla fotocamera (DataMatrix GS1 / HIBC / EAN) → GTIN, lotto, scadenza, seriale
app.post('/api/udi/codice', needUser, need(UD), wrap(async (req, res) => {
  res.json(etichetta.interpreta(str(req.body.testo, 300)));
}));
// Foto della targhetta / etichetta dell'impianto → nome, produttore, REF, lotto, scadenza (con l'AI)
app.post('/api/udi/leggi', needUser, need(UD), wrap(async (req, res) => {
  const m = /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(String(req.body.foto || ''));
  if (!m) return bad(res, 400, 'Foto non valida.');
  res.json(await etichetta.leggiEtichetta([{ tipo: m[1], dati: m[2] }], str(req.body.codice, 300)));
}));
// Lettore del DataMatrix (lo stesso del Magazzino)
const ZXING = ['umd/index.min.js', 'umd/index.js'].map(f => path.join(__dirname, '..', 'node_modules', '@zxing', 'library', f)).find(f => fs.existsSync(f));
app.get('/vendor/zxing.js', (req, res) => ZXING ? res.sendFile(ZXING, { maxAge: '7d' }) : res.status(404).type('js').send('/* ZXing non installato */'));

/* ============ MANUTENZIONE ATTREZZATURE ============ */
// L'amministratore crea riuniti e aspiratori per sede; chi lavora spunta le operazioni fatte (dopo conferma).
// Le registrazioni non si modificano: solo l'amministratore può correggerle o toglierle.
const MT = 'manutenzione';
const VOCI = {
  riunito: [['filtro_riunito', 'Pulizia filtro riunito'], ['filtro_bacinella', 'Pulizia filtro sottobacinella'],
    ['tubi_aspiranti', 'Pulizia tubi aspiranti'], ['cordoni', 'Lavaggio cordoni']],
  aspiratore: [['filtro_aspiratore', 'Pulizia filtro aspiratore'], ['filtro_amalgama', 'Sostituzione filtro amalgama']],
};
const nomeVoce = (tipo, v) => (VOCI[tipo] || []).find(x => x[0] === v)?.[1] || v;
const adminMT = req => !!permDi(req, MT)?.admin;
async function attrezzaturaMia(req, id) {
  const { rows } = await db.q('select * from attrezzature where id = $1', [str(id, 60)]);
  if (!rows[0] || !sedeOk(req, MT, rows[0].sede_id)) throw fail(404, 'Attrezzatura non trovata.');
  return rows[0];
}
app.get('/api/man/attrezzature', needUser, need(MT), wrap(async (req, res) => {
  const p = permDi(req, MT);
  const { rows } = await db.q(`select a.*,
      (select json_object_agg(x.voce, json_build_object('il', x.il, 'chi', x.chi)) from (
        select distinct on (m.voce) m.voce, m.eseguita_il as il, m.operatore_nome as chi from manutenzioni m
        where m.attrezzatura_id = a.id order by m.voce, m.eseguita_il desc) x) as ultime
    from attrezzature a where a.sede_id = any($1) and a.attiva order by a.sede_nome, a.tipo desc, a.nome`, [p.sedi.map(s => s.id)]);
  res.json({ admin: p.admin, attrezzature: rows.map(a => ({ id: a.id, sedeId: a.sede_id, sede: p.sedi.find(s => s.id === a.sede_id)?.nome || a.sede_nome,
    tipo: a.tipo, nome: a.nome, ultime: a.ultime || {} })) });
}));
app.post('/api/man/attrezzature', needUser, need(MT), wrap(async (req, res) => {
  if (!adminMT(req)) return bad(res, 403, 'Solo l\'amministratore aggiunge le attrezzature.');
  const sede = sedeOk(req, MT, str(req.body.sede, 80));
  if (!sede) return bad(res, 400, 'Scegli la sede.');
  const tipo = str(req.body.tipo, 12), nome = str(req.body.nome, 80);
  if (!VOCI[tipo]) return bad(res, 400, 'Scegli se è un riunito o un aspiratore.');
  if (!nome) return bad(res, 400, 'Scrivi il nome.');
  const id = db.newId();
  await db.q('insert into attrezzature (id, sede_id, sede_nome, tipo, nome) values ($1,$2,$3,$4,$5)', [id, sede.id, sede.nome, tipo, nome]);
  res.json({ id });
}));
app.put('/api/man/attrezzature/:id', needUser, need(MT), wrap(async (req, res) => {
  if (!adminMT(req)) return bad(res, 403, 'Solo l\'amministratore modifica le attrezzature.');
  const a = await attrezzaturaMia(req, req.params.id);
  await db.q('update attrezzature set nome = $2, attiva = $3 where id = $1', [a.id, str(req.body.nome, 80) || a.nome, req.body.attiva !== false]);
  res.json({ ok: true });
}));
// Registra le operazioni spuntate (una riga per operazione), con chi e quando
app.post('/api/man/attrezzature/:id/registra', needUser, need(MT), wrap(async (req, res) => {
  const a = await attrezzaturaMia(req, req.params.id);
  const valide = VOCI[a.tipo].map(v => v[0]);
  const voci = [...new Set((Array.isArray(req.body.voci) ? req.body.voci : []).map(v => str(v, 30)))].filter(v => valide.includes(v));
  if (!voci.length) return bad(res, 400, 'Spunta almeno un\'operazione.');
  const note = str(req.body.note, 500);
  for (const v of voci) await db.q('insert into manutenzioni (id, attrezzatura_id, sede_id, voce, operatore_id, operatore_nome, note) values ($1,$2,$3,$4,$5,$6,$7)',
    [db.newId(), a.id, a.sede_id, v, req.me.id, req.me.nome, note]);
  res.json({ ok: true, n: voci.length });
}));
// Registro: per sede / attrezzatura / periodo
app.get('/api/man/registro', needUser, need(MT), wrap(async (req, res) => {
  const p = permDi(req, MT);
  const sede = str(req.query.sede, 80);
  const params = [sede && sedeOk(req, MT, sede) ? [sede] : p.sedi.map(s => s.id)];
  let f = '';
  const att = str(req.query.attrezzatura, 60);
  if (att) { params.push(att); f += ` and m.attrezzatura_id = $${params.length}`; }
  const da = str(req.query.da, 10), a = str(req.query.a, 10);
  if (isDate(da)) { params.push(da); f += ` and (m.eseguita_il at time zone 'Europe/Rome')::date >= $${params.length}`; }
  if (isDate(a)) { params.push(a); f += ` and (m.eseguita_il at time zone 'Europe/Rome')::date <= $${params.length}`; }
  const { rows } = await db.q(`select m.*, t.nome as att_nome, t.tipo, t.sede_nome from manutenzioni m join attrezzature t on t.id = m.attrezzatura_id
    where m.sede_id = any($1) ${f} order by m.eseguita_il desc limit 1000`, params);
  res.json({ admin: p.admin, righe: rows.map(r => ({ id: r.id, attrezzaturaId: r.attrezzatura_id, attrezzatura: r.att_nome, tipo: r.tipo,
    sede: p.sedi.find(s => s.id === r.sede_id)?.nome || r.sede_nome, voce: r.voce, voceNome: nomeVoce(r.tipo, r.voce), eseguitaIl: r.eseguita_il,
    operatore: r.operatore_nome, note: r.note, modificataDa: r.modificata_da, modificataIl: r.modificata_il })) });
}));
async function rigaMia(req, id) {
  const { rows } = await db.q('select m.*, t.tipo from manutenzioni m join attrezzature t on t.id = m.attrezzatura_id where m.id = $1', [str(id, 60)]);
  if (!rows[0] || !sedeOk(req, MT, rows[0].sede_id)) throw fail(404, 'Registrazione non trovata.');
  return rows[0];
}
// Solo l'amministratore corregge (operazione, data e ora, note): resta traccia di chi ha modificato
app.put('/api/man/registro/:id', needUser, need(MT), wrap(async (req, res) => {
  if (!adminMT(req)) return bad(res, 403, 'Le registrazioni le può correggere solo l\'amministratore.');
  const r = await rigaMia(req, req.params.id);
  const voce = str(req.body.voce, 30) || r.voce;
  if (!VOCI[r.tipo].some(v => v[0] === voce)) return bad(res, 400, 'Operazione non valida.');
  const quando = str(req.body.eseguitaIl, 40);
  const t = quando ? new Date(quando) : new Date(r.eseguita_il);
  if (isNaN(t) || t > new Date(Date.now() + 6e4)) return bad(res, 400, 'Data e ora non valide.');
  await db.q('update manutenzioni set voce = $2, eseguita_il = $3, note = $4, modificata_da = $5, modificata_il = now() where id = $1',
    [r.id, voce, t.toISOString(), str(req.body.note ?? r.note, 500), req.me.nome]);
  res.json({ ok: true });
}));
app.delete('/api/man/registro/:id', needUser, need(MT), wrap(async (req, res) => {
  if (!adminMT(req)) return bad(res, 403, 'Le registrazioni le può togliere solo l\'amministratore.');
  const r = await rigaMia(req, req.params.id);
  await db.q('delete from manutenzioni where id = $1', [r.id]);
  res.json({ ok: true });
}));

/* ---------- pagina ---------- */
const PUB = path.join(__dirname, 'public');
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.me) return res.redirect(accessi.loginUrl(`${req.protocol}://${req.get('host')}${req.originalUrl}`));
  const p = req.me.perm;
  if (!p.sterilizzazione && !p.registro_udi && !p.manutenzione && !req.me.magazzino) return res.redirect(`${accessi.publicUrl()}/?noaccess=aso`);
  res.sendFile(path.join(PUB, 'app.html'));
});
app.use(express.static(PUB, { index: false, maxAge: '1h' }));
app.get('/healthz', (req, res) => res.send('ok'));

app.use((err, req, res, next) => {
  if (err.status && err.status < 500) return bad(res, err.status, err.message);
  console.error('Gestione ASO:', err);
  bad(res, err.status || 500, err.status ? err.message : 'Errore del server. Riprova.');
});

async function start() { await db.migrate(); }
module.exports = { app, start, BASE };
