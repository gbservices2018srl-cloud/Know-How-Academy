// Backup della suite: esporta TUTTI i dati di un cliente (o di To Smile) in un unico file .tar.gz.
// Ogni tabella diventa un file <area>/<tabella>.ndjson (una riga JSON per record; i file binari in base64).
// Solo lettura: non modifica niente. Legge a blocchi (cursore) per non riempire la memoria.
const fs = require('fs');
const os = require('os');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');
const { Pool } = require('pg');

const url = process.env.DATABASE_URL || '';
const pool = new Pool({ connectionString: url, ssl: process.env.PGSSL === 'true' || /\.render\.com/.test(url) ? { rejectUnauthorized: false } : false, max: 2 });
const clean = s => String(s || '').replace(/[^a-z0-9_]/gi, '').toLowerCase();

// aree del database di To Smile (come sono configurate) o di un cliente (<cliente>_<area>)
const AREE = ['accessi', 'protocolli', 'calendario', 'magazzino', 'turni', 'comunicazioni', 'documenti', 'aso', 'crm', 'cassa', 'compensi', 'classifiche'];
const ENV = { accessi: 'ACCESSI_DB_SCHEMA', protocolli: 'DB_SCHEMA', calendario: 'CAL_DB_SCHEMA', magazzino: 'MAG_DB_SCHEMA', turni: 'TURNI_DB_SCHEMA',
  comunicazioni: 'COM_DB_SCHEMA', documenti: 'DOC_DB_SCHEMA', aso: 'ASO_DB_SCHEMA', crm: 'CRM_DB_SCHEMA', cassa: 'CASSA_DB_SCHEMA', compensi: 'COMPENSI_DB_SCHEMA', classifiche: 'CLASSIFICHE_DB_SCHEMA' };
const DEF = { protocolli: 'mappa' };
function schemi(slug) {
  slug = clean(slug);
  if (slug && slug !== 'tosmile') return AREE.map(a => ({ area: a, schema: `${slug}_${a}` }));
  return [...AREE.map(a => ({ area: a, schema: clean(process.env[ENV[a]]) || DEF[a] || a })), { area: 'suite', schema: 'suite' }];
}

// To Smile: tutte le aree presenti nel database (così non ne manca nessuna), tranne quelle dei clienti della suite
async function elenco(c, slug) {
  if (clean(slug) && clean(slug) !== 'tosmile') return schemi(slug);
  const { rows } = await c.query(`select schema_name from information_schema.schemata
    where schema_name not in ('information_schema','pg_toast') and schema_name not like 'pg\\_%' order by 1`);
  let clienti = [];
  try { clienti = (await c.query('select slug from suite.clienti')).rows.map(r => r.slug + '_'); } catch {}
  return rows.map(r => r.schema_name).filter(s => !clienti.some(p => s.startsWith(p))).map(s => ({ area: s, schema: s }));
}

// --- tar (formato ustar) scritto a mano: intestazione da 512 byte, contenuto, riempimento a 512 ---
function intestazione(nome, size, mtime) {
  const h = Buffer.alloc(512);
  const scrivi = (str, off, len) => h.write(String(str).slice(0, len), off, len, 'utf8');
  const ott = (n, len) => n.toString(8).padStart(len - 1, '0') + '\0';
  scrivi(nome, 0, 100); scrivi(ott(0o644, 8), 100, 8); scrivi(ott(0, 8), 108, 8); scrivi(ott(0, 8), 116, 8);
  scrivi(ott(size, 12), 124, 12); scrivi(ott(Math.floor(mtime / 1000), 12), 136, 12);
  h.fill(' ', 148, 156); scrivi('0', 156, 1); scrivi('ustar\0', 257, 6); scrivi('00', 263, 2);
  let sum = 0; for (const b of h) sum += b;
  scrivi(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8);
  return h;
}
const json = r => JSON.stringify(r, (k, v) => (v && v.type === 'Buffer' && Array.isArray(v.data)) ? { $b64: Buffer.from(v.data).toString('base64') } : v);

// esporta nel flusso «out» (es. la risposta HTTP o un file); restituisce il riassunto
async function esporta(slug, out, { etichetta = '' } = {}) {
  const gz = zlib.createGzip({ level: 6 });
  gz.pipe(out);
  const scrivi = b => new Promise(ok => { if (gz.write(b)) ok(); else gz.once('drain', ok); });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'backup-'));
  const riassunto = { cliente: clean(slug) || 'tosmile', creato: new Date().toISOString(), etichetta, tabelle: [] };
  const c = await pool.connect();
  try {
    for (const { area, schema } of await elenco(c, slug)) {
      const { rows: tab } = await c.query(`select table_name from information_schema.tables where table_schema = $1 and table_type = 'BASE TABLE' order by 1`, [schema]);
      for (const { table_name: t } of tab) {
        const file = path.join(tmp, crypto.randomBytes(6).toString('hex'));
        const fd = fs.openSync(file, 'w'); let n = 0;
        await c.query('begin');
        try {
          await c.query(`declare cur no scroll cursor for select * from "${schema}"."${t.replace(/"/g, '')}"`);
          // poche righe alla volta: alcune tabelle hanno file dentro (anche MB per riga) e 500 righe insieme
          // riempivano la memoria del server (512 MB) fino a farlo ripartire. Si regola da solo sulla grandezza delle righe.
          let quante = 20;
          for (;;) {
            const { rows } = await c.query(`fetch ${quante} from cur`);
            if (!rows.length) break;
            let byte = 0;
            for (const r of rows) { const riga = json(r) + '\n'; byte += riga.length; fs.writeSync(fd, riga); }
            n += rows.length;
            quante = Math.max(1, Math.min(500, Math.floor(4e6 / Math.max(1, byte / rows.length))));
          }
          await c.query('close cur');
        } finally { await c.query('commit'); fs.closeSync(fd); }
        const size = fs.statSync(file).size;
        await scrivi(intestazione(`${area}/${t}.ndjson`, size, Date.now()));
        await new Promise((ok, ko) => { const rs = fs.createReadStream(file); rs.on('data', d => { if (!gz.write(d)) { rs.pause(); gz.once('drain', () => rs.resume()); } }); rs.on('end', ok); rs.on('error', ko); });
        if (size % 512) await scrivi(Buffer.alloc(512 - (size % 512)));
        fs.unlinkSync(file);
        riassunto.tabelle.push({ area, tabella: t, righe: n });
      }
    }
    const man = Buffer.from(JSON.stringify(riassunto, null, 1));
    await scrivi(intestazione('LEGGIMI-backup.json', man.length, Date.now())); await scrivi(man);
    if (man.length % 512) await scrivi(Buffer.alloc(512 - (man.length % 512)));
    await scrivi(Buffer.alloc(1024));
  } finally {
    c.release();
    fs.rmSync(tmp, { recursive: true, force: true });
    gz.end();
  }
  return riassunto;
}
// chiave per cliente: il motore di un cliente può chiedere solo il suo backup
const chiaveCliente = slug => crypto.createHmac('sha256', process.env.SSO_API_KEY || 'x').update('backup:' + (clean(slug) || 'tosmile')).digest('hex');
module.exports = { esporta, schemi, chiaveCliente };
