// Documenti privacy del cliente della suite (solo nei motori dei clienti, mai per To Smile).
// Finché mancano i documenti obbligatori, in tutte le pagine resta visibile un avviso grande.
// I testi di To Smile (privacy, cookie, termini) per i clienti non si vedono: /privacy mostra i documenti del cliente.
// I file stanno nello schema «suite» del database (tabella privacy_doc), separati per cliente.
const express = require('express');
const crypto = require('crypto');
const { Pool } = require('pg');
const S = require('../lib/suite');

const url = process.env.DATABASE_URL || '';
const pool = new Pool({ connectionString: url, ssl: process.env.PGSSL === 'true' || /\.render\.com/.test(url) ? { rejectUnauthorized: false } : false, max: 2 });
const q = (t, p) => pool.query(t, p);
const TIPI = [
  { id: 'informativa_dipendenti', nome: 'Informativa privacy per dipendenti e collaboratori', obbligo: true },
  { id: 'nomina', nome: 'Nomina di To Smile a responsabile del trattamento (art. 28 GDPR)', obbligo: true },
  { id: 'informativa_pazienti', nome: 'Informativa privacy per i pazienti', obbligo: false },
  { id: 'cookie', nome: 'Cookie policy', obbligo: false },
  { id: 'altro', nome: 'Altro documento', obbligo: false },
];
const MIME = { 'application/pdf': 'pdf', 'image/png': 'png', 'image/jpeg': 'jpg' };

let pronto = null;
const migrate = () => pronto || (pronto = q(`
  create schema if not exists suite;
  create table if not exists suite.privacy_doc (id text primary key, slug text not null, tipo text not null, titolo text not null,
    mime text not null, dati bytea not null, caricato_da text not null default '', caricato_il timestamptz not null default now());
  create index if not exists privacy_doc_slug on suite.privacy_doc (slug);
`));

// stato per l'avviso (in memoria per un minuto)
let stato = null, statoT = 0;
async function mancanti() {
  if (!S.TENANT) return [];
  if (stato && Date.now() - statoT < 60000) return stato;
  await migrate();
  const { rows } = await q('select distinct tipo from suite.privacy_doc where slug = $1', [S.TENANT]);
  const ci = new Set(rows.map(r => r.tipo));
  stato = TIPI.filter(t => t.obbligo && !ci.has(t.id)); statoT = Date.now();
  await q('update suite.clienti set privacy_ok = $2 where slug = $1', [S.TENANT, !stato.length]).catch(() => {});
  return stato;
}
const ultimoStato = () => stato;
const BANNER = () => `<div role="status" style="position:sticky;top:0;z-index:2147483001;background:#fdecd3;color:#8a4508;border-bottom:2px solid #b45309;padding:12px max(16px,env(safe-area-inset-left,0px));font:700 15px/1.35 system-ui,sans-serif;display:flex;gap:12px;align-items:center;justify-content:center;flex-wrap:wrap;text-align:center">⚠ Carica i tuoi documenti privacy (informativa e nomina del responsabile) per completare l'attivazione. Finché mancano, questo avviso resta visibile.<a href="/_suite/privacy" style="background:#b45309;color:#fff;padding:8px 14px;border-radius:8px;text-decoration:none;font-weight:800">Carica i documenti</a></div>`;
function conAvviso(html) {
  if (!S.TENANT || !stato || !stato.length) return html;
  return /<body[^>]*>/i.test(html) ? html.replace(/<body[^>]*>/i, m => m + BANNER()) : BANNER() + html;
}

// pagina e caricamento (dentro il motore del cliente; l'amministratore carica, tutti leggono)
const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '12mb' }));
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
let accessi = null; const acc = () => accessi || (accessi = require('../accessi/server'));
async function chi(req) {
  const c = await acc().store.check(acc().readCookie(req)).catch(() => null);
  if (!c) return null;
  return { id: c.user.id, nome: `${c.user.first_name || ''} ${c.user.last_name || ''}`.trim(), admin: !!c.user.owner || c.apps.accessi === 'admin' };
}
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
app.get('/_suite/privacy', wrap(async (req, res) => {
  await migrate();
  const me = await chi(req);
  const { rows } = await q('select id, tipo, titolo, mime, caricato_il from suite.privacy_doc where slug = $1 order by caricato_il', [S.TENANT]);
  const mm = await mancanti();
  res.set('Cache-Control', 'no-store').type('html').send(`<!doctype html><html lang="it"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Documenti privacy · To Smile</title><link rel="stylesheet" href="/fonts/tosmile.css?f=figtree:400,600,700,800">
<style>body{margin:0;background:#FBFBF8;color:#2B3033;font-family:Figtree,system-ui,sans-serif;font-size:15px}.w{max-width:760px;margin:0 auto;padding:20px max(16px,env(safe-area-inset-left,0px)) 60px}
a{color:#2b8a83;font-weight:700}h1{font-size:22px;margin:10px 0}.c{background:#fff;border:1px solid #e1e7e5;border-radius:12px;padding:14px;margin-top:12px}
.r{display:flex;justify-content:space-between;gap:10px;align-items:center;padding:8px 0;border-bottom:1px solid #eef1ef;flex-wrap:wrap}.r:last-child{border:0}
.m{color:#6B7276;font-size:13px}.ok{color:#1e8a5a;font-weight:700}.no{color:#b45309;font-weight:700}
select,input,button{font:inherit;padding:8px 10px;border:1px solid #d8dedc;border-radius:8px}button{background:#2b8a83;color:#fff;border:0;font-weight:700;cursor:pointer}
.del{background:none;color:#b42318;border:1px solid #f0c4bf;padding:4px 10px}</style></head><body><div class="w">
<a href="/">← Le mie app</a><h1>Documenti privacy</h1>
<p class="m">Qui ci sono i documenti privacy della tua azienda: valgono per tutte le app della suite.</p>
<div class="c"><b>Obbligatori</b>${TIPI.filter(t => t.obbligo).map(t => `<div class="r"><span>${esc(t.nome)}</span>${mm.some(x => x.id === t.id) ? '<span class="no">manca</span>' : '<span class="ok">caricato ✓</span>'}</div>`).join('')}</div>
<div class="c"><b>Documenti caricati</b>${rows.length ? rows.map(r => `<div class="r"><span><a href="/_suite/privacy/${esc(r.id)}" target="_blank" rel="noopener">${esc(r.titolo)}</a><div class="m">${esc((TIPI.find(t => t.id === r.tipo) || {}).nome || '')} · ${new Date(r.caricato_il).toLocaleDateString('it-IT')}</div></span>${me?.admin ? `<button class="del" data-del="${esc(r.id)}" type="button">Togli</button>` : ''}</div>`).join('') : '<p class="m">Nessun documento ancora.</p>'}</div>
${me?.admin ? `<div class="c"><b>Carica un documento</b><p class="m">PDF, PNG o JPG, al massimo 8 MB.</p>
<div style="display:grid;gap:8px"><select id="tipo">${TIPI.map(t => `<option value="${t.id}">${esc(t.nome)}${t.obbligo ? ' (obbligatorio)' : ''}</option>`).join('')}</select>
<input id="titolo" placeholder="Titolo (es. Informativa dipendenti 2026)"><input id="file" type="file" accept="application/pdf,image/png,image/jpeg"><button id="carica" type="button">Carica</button><span class="m" id="msg"></span></div></div>`
    : `<p class="m">${me ? 'Solo l’amministratore della tua azienda può caricare i documenti.' : '<a href="/accedi">Accedi</a> per vedere tutti i dettagli.'}</p>`}
</div><script>
const msg = t => document.getElementById('msg') && (document.getElementById('msg').textContent = t);
document.addEventListener('click', async e => {
  if (e.target.id === 'carica') {
    const f = document.getElementById('file').files[0]; if (!f) return msg('Scegli il file.');
    if (f.size > 8 * 1024 * 1024) return msg('Il file è troppo grande: al massimo 8 MB.');
    const data = await new Promise((ok, ko) => { const r = new FileReader(); r.onload = () => ok(r.result); r.onerror = ko; r.readAsDataURL(f); });
    e.target.disabled = true; msg('Caricamento…');
    const r = await fetch('/_suite/privacy', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tipo: document.getElementById('tipo').value, titolo: document.getElementById('titolo').value || f.name, file: data }) });
    const j = await r.json().catch(() => ({})); if (!r.ok) { e.target.disabled = false; return msg(j.error || 'Errore, riprova.'); }
    location.reload();
  }
  const d = e.target.closest('[data-del]');
  if (d) {
    if (d.dataset.ok !== '1') { d.dataset.ok = '1'; d.textContent = 'Confermi?'; return; }
    const r = await fetch('/_suite/privacy/' + d.dataset.del, { method: 'DELETE' }); if (r.ok) location.reload();
  }
});
</script></body></html>`);
}));
app.get('/_suite/privacy/:id', wrap(async (req, res) => {
  await migrate();
  const { rows: [r] } = await q('select titolo, mime, dati from suite.privacy_doc where id = $1 and slug = $2', [String(req.params.id), S.TENANT]);
  if (!r) return res.status(404).send('Documento non trovato.');
  res.set({ 'Content-Type': r.mime, 'Content-Disposition': `inline; filename="${String(r.titolo).replace(/[^\w .-]/g, '').slice(0, 80)}.${MIME[r.mime] || 'bin'}"`, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.send(r.dati);
}));
app.post('/_suite/privacy', wrap(async (req, res) => {
  const me = await chi(req); if (!me?.admin) return res.status(403).json({ error: 'Solo l’amministratore può caricare i documenti.' });
  const tipo = TIPI.find(t => t.id === req.body?.tipo); if (!tipo) return res.status(400).json({ error: 'Tipo di documento non valido.' });
  const m = /^data:([a-z/]+);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.file || ''));
  if (!m || !MIME[m[1]]) return res.status(400).json({ error: 'File non valido: PDF, PNG o JPG.' });
  const dati = Buffer.from(m[2], 'base64'); if (dati.length > 8 * 1024 * 1024) return res.status(400).json({ error: 'Il file è troppo grande: al massimo 8 MB.' });
  await migrate();
  await q('insert into suite.privacy_doc (id, slug, tipo, titolo, mime, dati, caricato_da) values ($1,$2,$3,$4,$5,$6,$7)',
    [crypto.randomBytes(12).toString('hex'), S.TENANT, tipo.id, String(req.body.titolo || tipo.nome).slice(0, 120), m[1], dati, me.nome]);
  stato = null; await mancanti();
  res.json({ ok: true });
}));
app.delete('/_suite/privacy/:id', wrap(async (req, res) => {
  const me = await chi(req); if (!me?.admin) return res.status(403).json({ error: 'Solo l’amministratore.' });
  await q('delete from suite.privacy_doc where id = $1 and slug = $2', [String(req.params.id), S.TENANT]);
  stato = null; await mancanti();
  res.json({ ok: true });
}));
app.use((err, req, res, next) => { console.error('Privacy suite:', err.message); res.status(500).json({ error: 'Errore del server. Riprova.' }); });

module.exports = { app, mancanti, ultimoStato, conAvviso };
