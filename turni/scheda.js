// Scheda personale (nasce accanto a Turni, stesso servizio): fase 1 = Info utili + Branche medici.
// Dati ufficiali: sedi e medici dal pannello accessi; orari di partenza 9:30-18:30 lun-ven, sabato e domenica chiusi.
// Finché l'amministratore non la attiva per tutti, la vedono solo gli amministratori.
const store = require('../accessi/lib/store');
const { pdfText, wordText } = require('../lib/extract');

const BRANCHE = ['Conservativa', 'Intarsi', 'Endo', 'Endo avanzata', 'Chirurgia base', 'Implantologia base', 'Chirurgia avanzata',
  'Protesi su impianti', 'Protesi full arch', 'Protesi mobile', 'Protesi su denti naturali', 'Protesi denti naturali avanzato',
  'Ortodonzia', 'Pedodonzia', 'Parodonto', 'Sbiancamento', 'Igiene professionale'];
const GIORNI = ['Lunedì', 'Martedì', 'Mercoledì', 'Giovedì', 'Venerdì', 'Sabato', 'Domenica'];
const ORARIO_BASE = GIORNI.map((g, i) => i < 5 ? { aperto: true, da: '09:30', a: '18:30' } : { aperto: false, da: '', a: '' });
const MEDICO = 'Medico';
// sezioni della Scheda che vede un medico (le altre sono per il personale)
const SEZIONI_MEDICO = ['info', 'assenze', 'turni', 'cu', 'contratti'];

module.exports = function scheda(app, { db, needUser, needAdmin, wrap, bad, upload, PUB, sso }) {
  const path = require('path');
  let pronto = null;
  const migrate = () => pronto || (pronto = (async () => {
    await db.q(`
      create table if not exists sch_impostazioni (k text primary key, v jsonb not null);
      create table if not exists sch_orari (sede_id text primary key, orari jsonb not null, aggiornato timestamptz not null default now());
      create table if not exists sch_medici (medico_id text primary key, sedi jsonb not null default '[]', aggiornato timestamptz not null default now());
      create table if not exists sch_branche (medico_id text not null, sede_id text not null, branche jsonb not null default '[]', aggiornato timestamptz not null default now(), primary key (medico_id, sede_id));
      create table if not exists sch_doc (
        id text primary key, tipo text not null, titolo text not null, versione int not null default 1, mansioni jsonb not null default '[]',
        file bytea, file_nome text, file_mime text, testo text not null default '', attivo boolean not null default true,
        caricato timestamptz not null default now(), caricato_da text);
      create table if not exists sch_letture (user_id text not null, doc_id text not null, letto timestamptz not null default now(), primary key (user_id, doc_id));
    `);
  })().catch(e => { pronto = null; throw e; }));

  const imp = async k => { await migrate(); const { rows } = await db.q('select v from sch_impostazioni where k = $1', [k]); return rows[0] ? rows[0].v : null; };
  const setImp = async (k, v) => { await migrate(); await db.q('insert into sch_impostazioni (k, v) values ($1,$2) on conflict (k) do update set v = excluded.v', [k, JSON.stringify(v)]); };
  const isAdmin = u => u?.role === 'admin';

  // persona del pannello accessi (nome, figura) a partire dall'utente locale di Turni
  async function persona(u) {
    const { rows } = await store.q('select id, first_name, last_name, figura, contratto_tipo from users where id = $1', [u.sso_id]);
    const p = rows[0] || {};
    return { ssoId: u.sso_id, nome: `${p.first_name || ''} ${p.last_name || ''}`.trim() || u.name, figura: p.figura || '', contratto: p.contratto_tipo || '' };
  }
  async function sedi() { return (await store.listSedi()).filter(s => s.attiva); }
  // Medici e loro sedi: sempre dal pannello accessi, dall'assegnazione di Nuovalab (livello "Medico" con uno o più
  // medici, ognuno legato a uno studio = una sede). Si cambia solo lì; vale anche per i medici nuovi.
  // medici e sedi: sempre dal pannello accessi (assegnazione Nuovalab), stessa fonte di Misure implantari
  const sediMedici = (o) => require('../accessi/lib/medici-sedi').sediMedici(o);
  async function orari() {
    await migrate();
    const ss = await sedi();
    const { rows } = await db.q('select sede_id, orari from sch_orari');
    const m = new Map(rows.map(r => [r.sede_id, r.orari]));
    return ss.map(s => ({ id: s.id, nome: s.nome, sigla: s.sigla, indirizzo: s.indirizzo, orari: m.get(s.id) || ORARIO_BASE }));
  }
  async function branche() {
    await migrate();
    const { rows } = await db.q('select medico_id, sede_id, branche from sch_branche');
    return rows;
  }
  const docShape = (d, letto) => ({ id: d.id, tipo: d.tipo, titolo: d.titolo, versione: d.versione, mansioni: d.mansioni, caricato: d.caricato,
    haFile: !!d.file_nome, mime: d.file_mime, pdf: /pdf/i.test(d.file_mime || ''), testo: /pdf/i.test(d.file_mime || '') ? '' : d.testo, letto: letto || null });

  async function vede(req) {
    if (isAdmin(req.user)) return true;
    return !!(await imp('attiva'));
  }

  app.get('/api/scheda/state', needUser, wrap(async (req, res) => {
    if (!(await vede(req))) return bad(res, 403, 'La Scheda personale non è ancora attiva.');
    const me = await persona(req.user);
    const admin = isAdmin(req.user), medico = me.figura === MEDICO;
    const [ss, ors, meds, br] = await Promise.all([sedi(), orari(), sediMedici({ conIgienisti: true }), branche()]);
    // sedi della persona: un medico le ha in Branche medici, gli altri quelle assegnate nel pannello accessi
    let mieSedi = medico ? (meds.find(m => m.id === me.ssoId)?.sedi || []) : (await store.sediNote(me.ssoId)).map(e => e.id);
    if (admin && !mieSedi.length) mieSedi = ss.map(s => s.id);
    const { rows: docs } = await db.q(`select * from sch_doc where attivo order by tipo, titolo`);
    const { rows: lett } = await db.q('select doc_id, letto from sch_letture where user_id = $1', [me.ssoId]);
    const lm = Object.fromEntries(lett.map(l => [l.doc_id, l.letto]));
    const visDoc = d => admin || !(d.mansioni || []).length || (d.mansioni || []).includes(me.figura);
    const out = {
      me: { id: me.ssoId, nome: me.nome, figura: me.figura, admin, medico, sezioni: medico ? SEZIONI_MEDICO : null },
      branche: BRANCHE, giorni: GIORNI,
      sedi: ors.filter(s => admin || mieSedi.includes(s.id)),
      medici: meds.filter(m => m.sedi.some(s => admin || mieSedi.includes(s))).map(m => ({ id: m.id, nome: m.nome, sedi: m.sedi,
        branche: Object.fromEntries(br.filter(b => b.medico_id === m.id).map(b => [b.sede_id, b.branche])) })),
      docs: docs.filter(visDoc).map(d => docShape(d, lm[d.id])),
      convenzioni: (await store.convenzioni(admin ? null : mieSedi, me.contratto).catch(() => [])).map(c => ({ id: c.id, titolo: c.titolo, descrizione: c.descrizione, link: c.link, sedi: c.sedi, per: c.per, qr: c.qr || '' })),
      contatti: (await store.contattiUtili(admin ? null : mieSedi).catch(() => [])).map(c => ({ id: c.id, riferimento: c.riferimento, ruolo: c.ruolo || '', email: c.email, telefono: c.telefono, sedi: c.sedi })),
      attiva: !!(await imp('attiva')),
    };
    if (admin) {
      out.tutteSedi = ss.map(s => ({ id: s.id, nome: s.nome, sigla: s.sigla }));
      out.tuttiMedici = meds;
      const { rows: tot } = await store.q(`select count(*)::int as n from users u where u.status = 'active' and not u.owner
        and exists (select 1 from user_apps a where a.user_id = u.id and a.app = any($1) and not a.sospesa)`, [['turni', 'hr']]);
      out.persone = tot[0].n;
      const reg = docs.find(d => d.tipo === 'regolamento');
      if (reg) {
        const { rows: l } = await db.q('select count(*)::int as n from sch_letture where doc_id = $1', [reg.id]);
        out.regLetti = l[0].n;
      }
    }
    res.json(out);
  }));

  /* ---- amministratore ---- */
  app.put('/api/scheda/attiva', needAdmin, wrap(async (req, res) => {
    await setImp('attiva', !!req.body.attiva);
    // da quando è attiva si controllano le mancate timbrature (mai sui giorni prima)
    if (req.body.attiva && !(await imp('avvio'))) await setImp('avvio', new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' }));
    res.json({ ok: true });
  }));
  const ORA = /^([01]\d|2[0-3]):[0-5]\d$/;
  app.put('/api/scheda/orari/:sede', needAdmin, wrap(async (req, res) => {
    const o = Array.isArray(req.body.orari) ? req.body.orari : [];
    if (o.length !== 7) return bad(res, 400, 'Servono i 7 giorni.');
    const pulito = o.map(g => g.aperto ? { aperto: true, da: ORA.test(g.da) ? g.da : '09:30', a: ORA.test(g.a) ? g.a : '18:30', nota: String(g.nota || '').slice(0, 80) } : { aperto: false, da: '', a: '', nota: String(g.nota || '').slice(0, 80) });
    await migrate();
    await db.q('insert into sch_orari (sede_id, orari, aggiornato) values ($1,$2,now()) on conflict (sede_id) do update set orari = excluded.orari, aggiornato = now()', [req.params.sede, JSON.stringify(pulito)]);
    res.json({ ok: true });
  }));
  app.put('/api/scheda/medici/:id/sedi', needAdmin, (req, res) => bad(res, 400, 'Le sedi dei medici si cambiano nel pannello accessi (Nuovalab, livello Medico).'));
  app.put('/api/scheda/branche/:medico/:sede', needAdmin, wrap(async (req, res) => {
    const b = [...new Set((Array.isArray(req.body.branche) ? req.body.branche : []).map(String).filter(x => BRANCHE.includes(x)))];
    await migrate();
    await db.q(`insert into sch_branche (medico_id, sede_id, branche, aggiornato) values ($1,$2,$3,now())
      on conflict (medico_id, sede_id) do update set branche = excluded.branche, aggiornato = now()`, [req.params.medico, req.params.sede, JSON.stringify(b)]);
    res.json({ ok: true });
  }));
  // PDF delle branche di una sede: tabella branche × medici e igienisti (A4 orizzontale, al massimo 9 colonne per pagina)
  app.get('/api/scheda/branche-pdf/:sede', needAdmin, wrap(async (req, res) => {
    const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
    const [ss, meds, br] = await Promise.all([sedi(), sediMedici({ conIgienisti: true }), branche()]);
    const sede = ss.find(s => s.id === req.params.sede);
    if (!sede) return bad(res, 404, 'Sede non trovata.');
    const ms = meds.filter(m => m.sedi.includes(sede.id));
    const di = m => (br.find(b => b.medico_id === m.id && b.sede_id === sede.id)?.branche) || [];
    const doc = await PDFDocument.create(), f = await doc.embedFont(StandardFonts.Helvetica), fb = await doc.embedFont(StandardFonts.HelveticaBold);
    // i font standard non hanno tutti i caratteri: si tengono le lettere accentate italiane, il resto si toglie
    const T = x => String(x || '').normalize('NFC').replace(/[^\x20-\x7E\u00A0-\u00FF]/g, '');
    const W = 842, H = 595, M = 36, PRIMA = 190, PER = 9, RIGA = 25;
    const verde = rgb(0.10, 0.45, 0.45), linea = rgb(0.85, 0.85, 0.82), grigio = rgb(0.4, 0.4, 0.4);
    const oggi = new Date().toLocaleDateString('it-IT', { timeZone: 'Europe/Rome' });
    const gruppi = []; for (let i = 0; i < Math.max(ms.length, 1); i += PER) gruppi.push(ms.slice(i, i + PER));
    const spezza = (t, font, sz, max) => { const out = []; let r = '';
      for (const w of T(t).split(' ')) { const p = r ? r + ' ' + w : w; if (font.widthOfTextAtSize(p, sz) > max && r) { out.push(r); r = w; } else r = p; }
      if (r) out.push(r); return out.slice(0, 2); };
    gruppi.forEach((g, gi) => {
      const pg = doc.addPage([W, H]);
      pg.drawText(T(`Branche medici - ${sede.nome}`), { x: M, y: H - M - 8, size: 16, font: fb, color: verde });
      pg.drawText(T(`To Smile - aggiornato al ${oggi}${gruppi.length > 1 ? ` - pagina ${gi + 1} di ${gruppi.length}` : ''}`), { x: M, y: H - M - 26, size: 9, font: f, color: grigio });
      if (!g.length) { pg.drawText('Nessun medico in questa sede.', { x: M, y: H - M - 60, size: 11, font: f }); return; }
      const col = Math.min(70, (W - 2 * M - PRIMA) / g.length), top = H - M - 50, testa = 34;
      pg.drawRectangle({ x: M, y: top - testa, width: PRIMA + col * g.length, height: testa, color: rgb(0.95, 0.95, 0.93) });
      pg.drawText('Branca', { x: M + 6, y: top - testa + 8, size: 9.5, font: fb });
      g.forEach((m, i) => {
        const cx = M + PRIMA + col * i + col / 2, righe = spezza(m.nome, fb, 8, col - 6);
        if (m.igienista) righe.push('Igienista');
        righe.forEach((r, k) => { const font = m.igienista && k === righe.length - 1 ? f : fb, sz = 8;
          pg.drawText(r, { x: cx - font.widthOfTextAtSize(r, sz) / 2, y: top - 12 - k * 9.5, size: sz, font, color: k === righe.length - 1 && m.igienista ? grigio : rgb(0, 0, 0) }); });
      });
      BRANCHE.forEach((b, r) => {
        const y = top - testa - RIGA * (r + 1);
        pg.drawLine({ start: { x: M, y }, end: { x: M + PRIMA + col * g.length, y }, thickness: 0.5, color: linea });
        pg.drawText(T(b), { x: M + 6, y: y + 8, size: 9.5, font: fb });
        g.forEach((m, i) => { if (!di(m).includes(b)) return;
          const cx = M + PRIMA + col * i + col / 2, cy = y + RIGA / 2;
          pg.drawRectangle({ x: cx - 7, y: cy - 7, width: 14, height: 14, color: verde });
          pg.drawLine({ start: { x: cx - 4, y: cy }, end: { x: cx - 1, y: cy - 3 }, thickness: 1.8, color: rgb(1, 1, 1) });
          pg.drawLine({ start: { x: cx - 1, y: cy - 3 }, end: { x: cx + 4.5, y: cy + 3.5 }, thickness: 1.8, color: rgb(1, 1, 1) }); });
      });
    });
    const buf = Buffer.from(await doc.save());
    const nome = `Branche ${sede.nome}`.replace(/[^\w\s.-]/g, '').trim() + '.pdf';
    res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${nome}"`, 'Cache-Control': 'no-store' });
    res.send(buf);
  }));
  // documenti: policy (anche più di una) e regolamento (una versione attiva per volta)
  app.post('/api/scheda/doc', needAdmin, upload.single('file'), wrap(async (req, res) => {
    // Linee aziendali: policy, pilastri valoriali, pilastri clinici (più documenti per sezione)
    const f = req.file, tipo = ['regolamento', 'policy', 'valori', 'clinici'].includes(req.body.tipo) ? req.body.tipo : 'policy';
    if (!f) return bad(res, 400, 'Scegli un file PDF o Word.');
    const nome = f.originalname || 'documento';
    const pdf = /pdf$/i.test(f.mimetype) || /\.pdf$/i.test(nome), docx = /\.docx$/i.test(nome);
    if (!pdf && !docx) return bad(res, 400, 'Carica un PDF o un Word (.docx).');
    let testo = '';
    try { testo = pdf ? await pdfText(f.buffer) : await wordText(f.buffer); } catch { testo = ''; }
    if (docx && !testo.trim()) return bad(res, 400, 'Dal file Word non si legge nessun testo.');
    const titolo = String(req.body.titolo || '').trim().slice(0, 160) || nome.replace(/\.[^.]+$/, '');
    let mans = []; try { mans = JSON.parse(req.body.mansioni || '[]').map(String).slice(0, 20); } catch {}
    await migrate();
    const id = db.newId();
    let versione = 1;
    if (tipo === 'regolamento') {
      const { rows } = await db.q(`select max(versione)::int as v from sch_doc where tipo = 'regolamento'`);
      versione = (rows[0].v || 0) + 1;
      await db.q(`update sch_doc set attivo = false where tipo = 'regolamento' and attivo`);
    } else if (req.body.sostituisce) {
      const { rows } = await db.q(`select versione, titolo, mansioni from sch_doc where id = $1 and tipo = $2`, [req.body.sostituisce, tipo]);
      if (rows[0]) { versione = rows[0].versione + 1; await db.q('update sch_doc set attivo = false where id = $1', [req.body.sostituisce]); }
    }
    await db.q(`insert into sch_doc (id, tipo, titolo, versione, mansioni, file, file_nome, file_mime, testo, caricato_da) values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
      [id, tipo, titolo, versione, JSON.stringify(mans), f.buffer, nome, pdf ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', testo.slice(0, 500000), req.user.sso_id]);
    res.json({ id, versione });
  }));
  app.put('/api/scheda/doc/:id', needAdmin, wrap(async (req, res) => {
    const titolo = String(req.body.titolo || '').trim().slice(0, 160);
    const mans = Array.isArray(req.body.mansioni) ? req.body.mansioni.map(String).slice(0, 20) : null;
    await db.q('update sch_doc set titolo = coalesce(nullif($2, \'\'), titolo), mansioni = coalesce($3, mansioni) where id = $1', [req.params.id, titolo, mans ? JSON.stringify(mans) : null]);
    res.json({ ok: true });
  }));
  // "Togli": il documento non si vede più ma resta archiviato (non si cancella)
  app.delete('/api/scheda/doc/:id', needAdmin, wrap(async (req, res) => {
    await db.q('update sch_doc set attivo = false where id = $1', [req.params.id]);
    res.json({ ok: true });
  }));
  app.get('/api/scheda/doc/:id/file', needUser, wrap(async (req, res) => {
    if (!(await vede(req))) return bad(res, 403, 'Non disponibile');
    const { rows } = await db.q('select file, file_mime, mansioni, attivo from sch_doc where id = $1', [req.params.id]);
    const d = rows[0];
    if (!d || !d.file || !/pdf/i.test(d.file_mime || '')) return bad(res, 404, 'Documento non disponibile');
    if (!isAdmin(req.user)) {
      if (!d.attivo) return bad(res, 404, 'Documento non disponibile');
      const me = await persona(req.user);
      if ((d.mansioni || []).length && !(d.mansioni || []).includes(me.figura)) return bad(res, 404, 'Documento non disponibile');
    }
    res.set({ 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'inline', 'Cache-Control': 'no-store, private' });
    res.send(d.file);
  }));
  app.post('/api/scheda/doc/:id/letto', needUser, wrap(async (req, res) => {
    if (!(await vede(req))) return bad(res, 403, 'Non disponibile');
    const me = await persona(req.user);
    await db.q('insert into sch_letture (user_id, doc_id) values ($1,$2) on conflict do nothing', [me.ssoId, req.params.id]);
    res.json({ ok: true });
  }));
  app.get('/api/scheda/doc/:id/letture', needAdmin, wrap(async (req, res) => {
    const { rows: l } = await db.q('select user_id, letto from sch_letture where doc_id = $1', [req.params.id]);
    const lm = new Map(l.map(x => [x.user_id, x.letto]));
    const { rows: pp } = await store.q(`select u.id, u.first_name, u.last_name, u.figura from users u where u.status = 'active' and not u.owner
      and exists (select 1 from user_apps a where a.user_id = u.id and a.app = any($1) and not a.sospesa) order by u.last_name, u.first_name`, [['turni', 'hr']]);
    res.json({ persone: pp.map(p => ({ nome: `${p.first_name || ''} ${p.last_name || ''}`.trim(), figura: p.figura || '', letto: lm.get(p.id) || null })) });
  }));

  // pagina: la Scheda personale è la pagina principale di turni.appgestione.it (anche /nfc/<codice> dei tag)
  app.get('/sp/:f', (req, res) => {
    if (!/^[a-z]+\.js$/.test(req.params.f)) return res.status(404).end();
    res.set('Cache-Control', 'no-cache');
    res.sendFile(path.join(PUB, 'sp', req.params.f), err => { if (err && !res.headersSent) res.status(404).end(); });
  });
  app.get(['/', '/scheda', '/nfc/:cod'], (req, res) => {
    res.set('Cache-Control', 'no-store');
    if (!req.user) return req.ssoDenied ? sso.toDenied(res) : sso.toLogin(req, res);
    res.sendFile(path.join(PUB, 'scheda.html'));
  });

  return { migrate, imp, setImp, vede, persona, sedi, orari, sediMedici, isAdmin };
};
module.exports.MEDICO = MEDICO;
module.exports.SEZIONI_MEDICO = SEZIONI_MEDICO;
