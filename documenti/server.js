// Documenti di studio — server (gira insieme alle altre app: vedi index.js). Indirizzo: documenti.appgestione.it
//  - Amministratori (ruolo "Amministratore" dal pannello Gestione accessi): creano le categorie, caricano PDF o Word,
//    che diventano pagine dell'app (modificabili qui) oppure restano con l'impaginazione originale (solo PDF, sola lettura);
//    scelgono chi li vede (tutti, figure, sedi, persone) e se si possono scaricare.
//  - Tutti gli altri: leggono i documenti destinati a loro e, se permesso, li scaricano in PDF. Non possono modificarli.
const path = require('path');
const fs = require('fs');
const express = require('express');
const multer = require('multer');
const db = require('./lib/db');
const conv = require('./lib/converti');
const gruppo = require('../lib/gruppo');
const notifiche = require('../accessi/lib/notifiche');
const ACC = require('../accessi/lib/store').SCHEMA;

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use((req, res, next) => { res.set({ 'X-Frame-Options': 'DENY', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' }); next(); });
app.use(express.json({ limit: '4mb' }));
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024, files: 1 } });

const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const bad = (res, code, msg) => res.status(code).json({ error: msg });
const str = (v, max = 200) => String(v ?? '').trim().slice(0, max);
const arr = (v, max = 500) => (Array.isArray(v) ? v : []).slice(0, max).map(x => String(x).slice(0, 120));

/* ---------- accesso ---------- */
const sso = require('../accessi/collega')({
  app: 'documenti',
  toLocal: async (c, role) => ({ id: c.id, name: gruppo.nomeDi(c), figura: c.figura || '', admin: role === 'admin' }),
});
const G = gruppo.crea(sso);
app.use(wrap(async (req, res, next) => {
  if (!sso.enabled()) return next();
  const r = await sso.identify(req);
  if (r?.user) req.user = r.user; else if (r?.denied) req.ssoDenied = true;
  next();
}));
const needUser = (req, res, next) => req.user ? next() : bad(res, 401, 'Accesso richiesto');
const needAdmin = (req, res, next) => req.user?.admin ? next() : bad(res, 403, 'Solo per gli amministratori dei documenti.');

// Chi sono io per la visibilità (figura e sedi)
async function io(req) {
  const p = (await G.persone()).find(x => x.id === req.user.id);
  return p || { id: req.user.id, nome: req.user.name, figura: req.user.figura || '', sedi: [] };
}
const vede = (d, me) => !d.bozza && gruppo.rientra(me, d.vis_gruppi, d.vis_persone);
async function caricaDoc(id) { const { rows } = await db.q('select * from documenti where id = $1', [id]); return rows[0] || null; }
// Il documento esiste e questa persona può vederlo? (gli amministratori vedono tutto, anche le bozze)
async function docVisibile(req, id) {
  const d = await caricaDoc(id); if (!d) return null;
  if (req.user.admin) return d;
  return vede(d, await io(req)) ? d : null;
}

/* ---------- stato e persone ---------- */
app.get('/api/stato', needUser, wrap(async (req, res) => {
  const { rows: dev } = await db.q(`select count(*)::int n from ${ACC}.notif_subs where user_id = $1`, [req.user.id]);
  const { rows: pr } = await db.q(`select attiva from ${ACC}.notif_prefs where user_id = $1 and app = 'documenti'`, [req.user.id]);
  res.json({ me: { id: req.user.id, name: req.user.name, admin: !!req.user.admin }, ai: !!process.env.ANTHROPIC_API_KEY,
    notifiche: { dispositivi: dev[0].n, attiva: pr[0]?.attiva !== false }, links: sso.links() });
}));
app.get('/api/destinatari', needAdmin, wrap(async (req, res) => {
  const people = await G.persone();
  res.json({ persone: people, gruppi: gruppo.gruppiDi(people) });
}));

/* ---------- categorie ---------- */
app.get('/api/categorie', needUser, wrap(async (req, res) => {
  const { rows: cats } = await db.q('select id, nome from categorie order by ordine, lower(nome)');
  const { rows: docs } = await db.q('select id, categoria_id, bozza, vis_gruppi, vis_persone from documenti');
  const me = req.user.admin ? null : await io(req);
  const conta = id => docs.filter(d => d.categoria_id === id && (me ? vede(d, me) : true)).length;
  res.json({ categorie: cats.map(c => ({ ...c, n: conta(c.id) })) });
}));
app.post('/api/categorie', needAdmin, wrap(async (req, res) => {
  const nome = str(req.body.nome, 80);
  if (!nome) return bad(res, 400, 'Scrivi il nome della categoria.');
  const { rows: m } = await db.q('select coalesce(max(ordine), -1) + 1 as o from categorie');
  const id = db.newId();
  try { await db.q('insert into categorie (id, nome, ordine) values ($1,$2,$3)', [id, nome, m[0].o]); }
  catch (e) { if (e.code === '23505') return bad(res, 400, 'Esiste già una categoria con questo nome.'); throw e; }
  res.json({ id });
}));
app.put('/api/categorie/:id', needAdmin, wrap(async (req, res) => {
  const nome = str(req.body.nome, 80);
  if (!nome) return bad(res, 400, 'Scrivi il nome della categoria.');
  try { await db.q('update categorie set nome = $2 where id = $1', [req.params.id, nome]); }
  catch (e) { if (e.code === '23505') return bad(res, 400, 'Esiste già una categoria con questo nome.'); throw e; }
  res.json({ ok: true });
}));
app.delete('/api/categorie/:id', needAdmin, wrap(async (req, res) => {
  const { rows } = await db.q('select count(*)::int n from documenti where categoria_id = $1', [req.params.id]);
  if (rows[0].n) return bad(res, 400, `La categoria contiene ${rows[0].n === 1 ? 'un documento' : rows[0].n + ' documenti'}: spostali in un'altra categoria prima di eliminarla.`);
  await db.q('delete from categorie where id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/* ---------- elenco documenti (con ricerca per parola o frase in titolo e contenuto) ---------- */
app.get('/api/documenti', needUser, wrap(async (req, res) => {
  const params = [req.user.id]; const dove = [];
  const t = str(req.query.q, 120).replace(/[\\%_]/g, c => '\\' + c);
  if (t) { params.push('%' + t + '%'); dove.push(`(d.titolo ilike $${params.length} or d.testo ilike $${params.length})`); }
  if (req.query.categoria) { params.push(str(req.query.categoria, 80)); dove.push(`d.categoria_id = $${params.length}`); }
  const { rows } = await db.q(`select d.id, d.titolo, d.categoria_id, c.nome as categoria, d.tipo, d.scaricabile, d.bozza, d.vis_gruppi, d.vis_persone,
      d.aggiornato_il, d.pubblicato_il, d.versione, v.versione as vista, left(d.testo, 220) as anteprima
    from documenti d left join categorie c on c.id = d.categoria_id left join viste v on v.documento_id = d.id and v.user_id = $1
    ${dove.length ? 'where ' + dove.join(' and ') : ''} order by d.aggiornato_il desc limit 500`, params);
  let lista = rows;
  if (req.user.admin) {
    const people = await G.persone();
    lista = rows.map(d => ({ ...d, a_chi: gruppo.etichetta(people, d.vis_gruppi, d.vis_persone) || 'nessuno' }));
  } else {
    const me = await io(req);
    lista = rows.filter(d => vede(d, me)).map(d => ({ ...d, vis_gruppi: undefined, vis_persone: undefined }));
  }
  res.json({ documenti: lista.map(d => ({ ...d, nuovo: !d.bozza && (d.vista == null || d.vista < d.versione) })) });
}));

/* ---------- un documento ---------- */
app.get('/api/documenti/:id', needUser, wrap(async (req, res) => {
  const d = await docVisibile(req, req.params.id);
  if (!d) return bad(res, 404, 'Documento non trovato.');
  if (!d.bozza) await db.q(`insert into viste (documento_id, user_id, versione) values ($1,$2,$3)
    on conflict (documento_id, user_id) do update set versione = excluded.versione, visto_il = now()`, [d.id, req.user.id, d.versione]);
  const { rows: o } = await db.q('select nome, pagine from originali where documento_id = $1', [d.id]);
  const { rows: c } = await db.q('select nome from categorie where id = $1', [d.categoria_id]);
  const out = { id: d.id, titolo: d.titolo, categoriaId: d.categoria_id, categoria: c[0]?.nome || '', tipo: d.tipo, blocchi: d.blocchi,
    scaricabile: d.scaricabile, aggiornatoIl: d.aggiornato_il, pubblicatoIl: d.pubblicato_il, versione: d.versione,
    originale: o[0] ? { nome: o[0].nome, pagine: o[0].pagine } : null };
  if (req.user.admin) Object.assign(out, { bozza: d.bozza, notifica: d.notifica, gruppi: d.vis_gruppi, persone: d.vis_persone, origine: d.origine, aggiornatoDa: d.aggiornato_da });
  res.json(out);
}));

// Il file originale (documenti "impaginazione originale"): per il visore; scaricabile solo se permesso
app.get('/api/documenti/:id/originale', needUser, wrap(async (req, res) => {
  const d = await docVisibile(req, req.params.id);
  if (!d) return bad(res, 404, 'Documento non trovato.');
  const { rows } = await db.q('select nome, mime, dati from originali where documento_id = $1', [d.id]);
  if (!rows[0]) return bad(res, 404, 'Nessun file originale.');
  const scarica = req.query.scarica === '1';
  if (scarica && !d.scaricabile && !req.user.admin) return bad(res, 403, 'Questo documento non si può scaricare.');
  const nome = (d.titolo.normalize('NFD').replace(/[^\w\s-]/g, '').trim().replace(/\s+/g, '-').slice(0, 80) || 'documento') + '.pdf';
  res.set({ 'Content-Type': rows[0].mime, 'Cache-Control': 'private, no-store',
    'Content-Disposition': `${scarica ? 'attachment' : 'inline'}; filename="${nome}"` });
  // il PDF scaricato porta il logo To Smile in ogni pagina (nell'app si vede l'originale com'è)
  res.send(scarica ? await conLogo(rows[0].dati) : rows[0].dati);
}));
app.get('/api/immagini/:id', needUser, wrap(async (req, res) => {
  const { rows } = await db.q('select documento_id, mime, dati from immagini where id = $1', [str(req.params.id, 40)]);
  if (!rows[0] || !(await docVisibile(req, rows[0].documento_id))) return bad(res, 404, 'Immagine non trovata.');
  res.set({ 'Content-Type': rows[0].mime, 'Cache-Control': 'private, max-age=86400' });
  res.send(rows[0].dati);
}));

// Logo To Smile in alto a destra, nel margine di ogni pagina. Se qualcosa non va, si scarica il PDF originale.
const LOGO_PNG = fs.readFileSync(path.join(__dirname, 'public', 'logo.png'));
async function conLogo(dati) {
  try {
    const { PDFDocument } = require('pdf-lib');
    const pdf = await PDFDocument.load(dati, { ignoreEncryption: true });
    const logo = await pdf.embedPng(LOGO_PNG);
    for (const pg of pdf.getPages()) {
      const { width, height } = pg.getSize();
      const w = Math.min(84, width * 0.16), h = w * logo.height / logo.width, m = Math.max(12, Math.min(22, width * 0.03));
      pg.drawImage(logo, { x: width - w - m, y: height - h - m * 0.7, width: w, height: h });
    }
    return Buffer.from(await pdf.save());
  } catch (e) { console.warn('Documenti, logo sul PDF non aggiunto:', e.message); return dati; }
}

/* ---------- caricamento (amministratore) ---------- */
const salvaImmagineIn = docId => async (dati, mime) => {
  const id = db.newId();
  await db.q('insert into immagini (id, documento_id, mime, dati) values ($1,$2,$3,$4)', [id, docId, mime, Buffer.from(dati)]);
  return id;
};
app.post('/api/carica', needAdmin, upload.single('file'), wrap(async (req, res) => {
  const f = req.file;
  if (!f) return bad(res, 400, 'Scegli un file.');
  const nome = str(f.originalname, 200);
  const ext = (nome.match(/\.([a-z0-9]+)$/i)?.[1] || '').toLowerCase();
  const isPdf = ext === 'pdf' || f.buffer.slice(0, 5).toString() === '%PDF-';
  const isDocx = ext === 'docx' && f.buffer.slice(0, 2).toString() === 'PK';
  if (!isPdf && !isDocx) return bad(res, 400, ext === 'doc' ? 'I vecchi file .doc non si leggono: aprilo in Word e salvalo come .docx o PDF.' : 'Carica un PDF o un file Word (.docx).');
  const modo = req.body.modo === 'originale' ? 'originale' : 'pagina';
  if (modo === 'originale' && !isPdf) return bad(res, 400, 'L\'impaginazione originale si tiene solo per i PDF: salva il Word come PDF e ricaricalo, oppure scegli «Trasforma in pagina dell\'app».');
  const { rows: cats } = await db.q('select id from categorie where id = $1', [str(req.body.categoria, 80)]);
  let categoria = cats[0]?.id || null;
  if (!categoria) categoria = (await db.q('select id from categorie order by ordine limit 1')).rows[0]?.id || null;
  const id = db.newId();
  const titoloFile = nome.replace(/\.[a-z0-9]+$/i, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 160) || 'Documento';
  await db.q(`insert into documenti (id, titolo, categoria_id, tipo, origine, aggiornato_da) values ($1,$2,$3,$4,$5,$6)`,
    [id, titoloFile, categoria, modo, '', req.user.name]);
  try {
    let titolo = titoloFile, blocchi = [], origine, avviso = '';
    const oggi = new Date().toLocaleDateString('it-IT', { day: 'numeric', month: 'long', year: 'numeric', timeZone: 'Europe/Rome' });
    if (modo === 'originale') {
      const { testo, pagine } = await conv.testoPdf(f.buffer).catch(() => ({ testo: '', pagine: 0 }));
      await db.q('insert into originali (documento_id, nome, mime, dati, pagine) values ($1,$2,$3,$4,$5)', [id, nome, 'application/pdf', f.buffer, pagine]);
      await db.q('update documenti set testo = $2 where id = $1', [id, testo.replace(/\s+/g, ' ').slice(0, 200000)]);
      origine = `Da «${nome}» · ${oggi} · impaginazione originale${pagine ? `, ${pagine} ${pagine === 1 ? 'pagina' : 'pagine'}` : ''}`;
    } else if (isDocx) {
      blocchi = await conv.daWord(f.buffer, salvaImmagineIn(id));
      const h = blocchi.find(b => b.t === 'h'); if (h && blocchi.indexOf(h) <= 1) { titolo = h.x.slice(0, 160); blocchi = blocchi.filter(b => b !== h); }
      origine = `Da «${nome}» · ${oggi}`;
    } else {
      const r = await conv.daPdf(f.buffer);
      blocchi = r.blocchi; if (r.titolo) titolo = r.titolo.slice(0, 160);
      else if (blocchi[0]?.t === 'h') { const t = blocchi[0].x; titolo = (t === t.toUpperCase() ? t.charAt(0) + t.slice(1).toLowerCase() : t).slice(0, 160); blocchi = blocchi.slice(1); }
      if (blocchi[0]?.t === 'h' && blocchi[0].x.toLowerCase() === titolo.toLowerCase()) blocchi = blocchi.slice(1);
      origine = `Da «${nome}» · ${oggi}` + (r.come === 'ai' ? ' · letto con l\'AI' : '');
      if (r.come === 'vuoto') avviso = 'Il PDF non contiene testo leggibile (forse è una scansione)' + (process.env.ANTHROPIC_API_KEY ? ' e la lettura automatica non è riuscita' : ' e la lettura automatica non è attiva') + ': scegli «Mantieni l\'impaginazione originale» oppure scrivi il testo qui.';
      else if (r.come === 'testo') avviso = 'Letto dal testo del PDF: controlla titoli ed elenchi prima di pubblicare.';
      if (r.troncato) avviso = 'Il documento è molto lungo: l\'ultima parte potrebbe mancare, controlla la fine prima di pubblicare.';
    }
    await db.q('update documenti set titolo = $2, blocchi = $3, testo = case when tipo = \'pagina\' then $4 else testo end, origine = $5 where id = $1',
      [id, titolo, JSON.stringify(blocchi), conv.testoDi(blocchi), origine]);
    res.json({ id, avviso });
  } catch (e) {
    console.warn('Documenti, caricamento non riuscito:', e.message);
    await db.q('delete from documenti where id = $1', [id]).catch(() => {});
    bad(res, 400, 'Non sono riuscito a leggere il file. È un PDF o un Word valido? Se è protetto da password, toglila e riprova.');
  }
}));
// Immagine aggiunta a mano nella pagina
app.post('/api/documenti/:id/immagine', needAdmin, upload.single('file'), wrap(async (req, res) => {
  const d = await caricaDoc(req.params.id);
  if (!d) return bad(res, 404, 'Documento non trovato.');
  if (!req.file || !/^image\/(png|jpe?g|gif|webp)$/.test(req.file.mimetype)) return bad(res, 400, 'Scegli un\'immagine (JPG, PNG, GIF o WebP).');
  if (req.file.size > 5e6) return bad(res, 400, 'L\'immagine è troppo grande (massimo 5 MB).');
  res.json({ id: await salvaImmagineIn(d.id)(req.file.buffer, req.file.mimetype) });
}));

/* ---------- salvataggio e pubblicazione ---------- */
app.put('/api/documenti/:id', needAdmin, wrap(async (req, res) => {
  const d = await caricaDoc(req.params.id);
  if (!d) return bad(res, 404, 'Documento non trovato.');
  const b = req.body;
  const titolo = str(b.titolo, 160);
  if (!titolo) return bad(res, 400, 'Il documento ha bisogno di un titolo.');
  const { rows: c } = await db.q('select id from categorie where id = $1', [str(b.categoria, 80)]);
  if (!c[0]) return bad(res, 400, 'Scegli la categoria.');
  const gruppi = arr(b.gruppi, 50), persone = arr(b.persone, 500);
  const pubblica = b.pubblica === true, bozza = pubblica ? false : (b.bozza === true ? true : d.bozza);
  if (!bozza && !gruppi.length && !persone.length) return bad(res, 400, 'Scegli chi può vederlo: Tutti, un gruppo o almeno una persona.');
  const blocchi = d.tipo === 'pagina' ? conv.pulisci(b.blocchi) : d.blocchi;
  // nuova versione (= di nuovo "nuovo" per chi l'ha già visto) solo quando cambia il contenuto o si pubblica la prima volta
  const contenutoCambiato = d.tipo === 'pagina' && JSON.stringify(blocchi) !== JSON.stringify(d.blocchi) || titolo !== d.titolo;
  const primaPubblicazione = d.bozza && !bozza;
  const nuovaVersione = !bozza && (primaPubblicazione || contenutoCambiato);
  // immagini non più usate: si tolgono
  const usate = blocchi.filter(x => x.t === 'img').map(x => x.id);
  await db.q(`update documenti set titolo=$2, categoria_id=$3, blocchi=$4, testo = case when tipo = 'pagina' then $5 else testo end, scaricabile=$6, notifica=$7,
      bozza=$8, vis_gruppi=$9, vis_persone=$10, aggiornato_il=now(), aggiornato_da=$11,
      versione = versione + $12, pubblicato_il = case when $12 = 1 then now() else pubblicato_il end where id=$1`,
    [d.id, titolo, c[0].id, JSON.stringify(blocchi), conv.testoDi(blocchi), b.scaricabile !== false, b.notifica !== false, bozza,
     JSON.stringify(gruppi), JSON.stringify(persone), req.user.name, nuovaVersione ? 1 : 0]);
  if (d.tipo === 'pagina') await db.q('delete from immagini where documento_id = $1 and not (id = any($2))', [d.id, usate]);
  // chi lo riceve ora (per la notifica e per il riepilogo)
  const people = await G.persone();
  const chi = bozza ? [] : gruppo.risolvi(people, gruppi, persone).filter(p => p.id !== req.user.id);
  let raggiunti = 0;
  if (nuovaVersione && b.notifica !== false && chi.length) {
    try {
      const r = await notifiche.notifica(chi.map(p => p.id), 'documenti', {
        title: `${primaPubblicazione ? 'Nuovo documento' : 'Documento aggiornato'}: ${titolo}`,
        body: primaPubblicazione ? 'È disponibile nell\'app Documenti di studio.' : 'È stata pubblicata una nuova versione: aprila per leggere le modifiche.',
        url: `/?d=${d.id}`, tag: 'doc-' + d.id,
      });
      raggiunti = r.raggiunti.size;
    } catch (e) { console.warn('Documenti, notifica non inviata:', e.message); }
    console.log(`Documenti: «${titolo}» ${primaPubblicazione ? 'pubblicato' : 'aggiornato'} per ${chi.length} persone, notifica arrivata a ${raggiunti}`);
  }
  res.json({ ok: true, bozza, persone: chi.length, raggiunti, notificato: nuovaVersione && b.notifica !== false });
}));
app.delete('/api/documenti/:id', needAdmin, wrap(async (req, res) => {
  await db.q('delete from documenti where id = $1', [req.params.id]);
  res.json({ ok: true });
}));

/* ---------- pagine ---------- */
const PUB = path.join(__dirname, 'public');
app.get('/', (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!sso.enabled()) return res.status(503).send('Documenti di studio: serve l\'accesso unico di appgestione.it (SSO_ATTIVO=true).');
  if (!req.user) return req.ssoDenied ? sso.toDenied(res) : sso.toLogin(req, res);
  res.sendFile(path.join(PUB, 'app.html'));
});
app.get('/healthz', (req, res) => res.send('ok'));
app.get('/manifest.webmanifest', (req, res) => res.sendFile(path.join(PUB, 'manifest.webmanifest')));
for (const f of ['logo.png', 'icon-192.png', 'icon-512.png', 'apple-touch-icon.png', 'icon.svg']) app.get('/' + f, (req, res) => res.sendFile(path.join(PUB, f), { maxAge: '7d' }));
// visore dei PDF con impaginazione originale (pdf.js, dai nostri server)
const PDFJS = (() => { try { return path.dirname(require.resolve('pdfjs-dist/package.json')); } catch { return null; } })();
app.get(['/vendor/pdf.min.mjs', '/vendor/pdf.worker.min.mjs'], (req, res) => {
  const f = PDFJS && path.join(PDFJS, 'legacy', 'build', path.basename(req.path));
  if (!f || !fs.existsSync(f)) return res.status(404).end();
  res.set({ 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'public, max-age=604800' });
  res.sendFile(f);
});
app.post('/api/esci', wrap(async (req, res) => { await sso.logout(req, res); res.json({ ok: true, url: sso.links().home }); }));

app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) return bad(res, 400, err.code === 'LIMIT_FILE_SIZE' ? 'Il file è troppo grande (massimo 25 MB).' : 'Caricamento non valido.');
  console.error(err);
  bad(res, 500, 'Errore del server. Riprova.');
});

async function start() { await db.migrate(); setTimeout(riepilogoVisibilita, 20000).unref?.(); }
// Nel registro, all'avvio: chi vede cosa (solo titoli e numeri), per capire perché qualcuno non vede un documento
async function riepilogoVisibilita() {
  try {
    const people = await G.persone();
    const { rows } = await db.q('select titolo, bozza, vis_gruppi, vis_persone from documenti order by aggiornato_il desc limit 40');
    const store = require('../accessi/lib/store');
    const { rows: tot } = await store.q(`select count(*)::int n, count(*) filter (where coalesce(figura,'') = '')::int senza_figura from users where status = 'active' and not owner`);
    console.log(`Documenti: ${people.length} persone con l'app (su ${tot[0].n} attive, ${tot[0].senza_figura} senza figura), ${rows.length} documenti`);
    for (const d of rows) console.log(`Documenti: «${d.titolo}» ${d.bozza ? 'BOZZA (non pubblicato)' : 'pubblicato'} · a: ${gruppo.etichetta(people, d.vis_gruppi, d.vis_persone) || 'nessuno'} · lo vedono ${d.bozza ? 0 : gruppo.risolvi(people, d.vis_gruppi, d.vis_persone).length} persone`);
  } catch (e) { console.warn('Documenti, riepilogo:', e.message); }
}
module.exports = { app, start };
