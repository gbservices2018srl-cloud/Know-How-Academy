// Lead da Meta (Facebook / Instagram, moduli delle inserzioni) → Gestione lead.
// Meta avvisa il CRM (webhook «leadgen») con l'id del lead; il CRM legge il lead con la chiave della pagina e lo inserisce
// in Gestione lead come gli altri: canale META, sede dal modulo o dal nome della campagna, setter della sede.
// Chiavi solo nelle variabili d'ambiente di Render: META_APP_SECRET (firma), META_VERIFY_TOKEN (verifica del webhook),
// META_PAGE_TOKENS = {"<id pagina>":"<chiave pagina>", ...} oppure META_PAGE_TOKEN (una sola pagina).
// I dati del lead (nome, telefono, email, risposte) restano nel database: mai nei log, nei KPI o nell'AI.
const crypto = require('crypto');

const GRAPH = process.env.META_GRAPH_URL || 'https://graph.facebook.com/v21.0'; // META_GRAPH_URL solo per le prove in locale
const CAMPI_LEAD = 'created_time,field_data,ad_name,adset_name,campaign_name,form_id,is_organic';

function chiavi() {
  let m = {};
  try { m = JSON.parse(process.env.META_PAGE_TOKENS || '{}') || {}; } catch { m = {}; }
  return m;
}
const chiavePagina = pageId => chiavi()[String(pageId || '')] || process.env.META_PAGE_TOKEN || '';
const configurato = () => !!(process.env.META_APP_SECRET && process.env.META_VERIFY_TOKEN && (process.env.META_PAGE_TOKEN || Object.keys(chiavi()).length));
const pagine = () => Object.keys(chiavi());

// firma di Meta sul corpo della richiesta (X-Hub-Signature-256: sha256=<hmac>)
function firmaOk(raw, header) {
  const sec = process.env.META_APP_SECRET;
  if (!sec || !raw || !header || !String(header).startsWith('sha256=')) return false;
  const atteso = crypto.createHmac('sha256', sec).update(raw).digest('hex');
  const a = Buffer.from(atteso), b = Buffer.from(String(header).slice(7));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function graph(path, token) {
  const r = await fetch(`${GRAPH}/${path}${path.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}`, { signal: AbortSignal.timeout(15000) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || j.error) throw new Error(`Meta: ${j.error?.message || 'risposta ' + r.status}`);
  return j;
}
const leggiLead = (leadId, token) => graph(`${encodeURIComponent(leadId)}?fields=${CAMPI_LEAD}`, token);
const nomeModulo = async (formId, token) => { try { return (await graph(`${encodeURIComponent(formId)}?fields=name`, token)).name || ''; } catch { return ''; } };

// risposte del modulo → campi del lead
function campi(fd) {
  const v = {};
  for (const f of fd || []) v[String(f.name || '').toLowerCase()] = (f.values || []).join(', ');
  const trova = re => { const k = Object.keys(v).find(x => re.test(x)); return k ? v[k] : ''; };
  let nome = trova(/^first_name$|^nome$/), cognome = trova(/^last_name$|^cognome$/);
  if (!nome && !cognome) {
    const full = trova(/full_name|nome_e_cognome|nome_completo/).trim().split(/\s+/);
    nome = full.shift() || ''; cognome = full.join(' ');
  }
  const telefono = trova(/phone|telefono|cellulare/), email = trova(/email/);
  const sede = trova(/sede|studio|clinica|centro|citt/);
  const usati = new Set(Object.keys(v).filter(k => /first_name|last_name|^nome$|^cognome$|full_name|nome_e_cognome|nome_completo|phone|telefono|cellulare|email/.test(k)));
  const altre = Object.entries(v).filter(([k]) => !usati.has(k)).map(([k, x]) => `${k.replace(/_/g, ' ')}: ${x}`);
  return { nome, cognome, telefono, email, sede, altre };
}

// sede: prima la risposta del modulo, poi il nome di campagna / gruppo / inserzione / modulo (il nome di sede più lungo che compare)
const norm = s => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
function sedeDa(sedi, daModulo, testi) {
  const ord = [...sedi].sort((a, b) => norm(b.nome).length - norm(a.nome).length);
  const cerca = t => { const n = ' ' + norm(t) + ' '; return ord.find(s => norm(s.nome) && n.includes(' ' + norm(s.nome) + ' ')) || null; };
  if (daModulo) { const s = cerca(daModulo); if (s) return { sede: s, come: 'dal modulo' }; }
  for (const t of testi) { const s = cerca(t); if (s) return { sede: s, come: 'dalla campagna' }; }
  return { sede: null, come: '' };
}

module.exports = { configurato, pagine, chiavePagina, firmaOk, graph, leggiLead, nomeModulo, campi, sedeDa };
