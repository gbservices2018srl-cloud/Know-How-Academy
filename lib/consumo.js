// Registro dei consumi di Claude (API Anthropic) di tutte le app dello stesso servizio:
// ogni chiamata salva app, funzione, modello e parole-pezzo (token) lette e scritte, con il costo stimato in dollari.
// Si legge dal pannello di appgestione.it/admin → "Consumo AI".
const store = require('../accessi/lib/store');

// Prezzi in dollari per milione di token (input, output, input letto dalla cache). Modelli non elencati: prezzi Sonnet.
const PREZZI = {
  sonnet: { in: 2, out: 10, cache: 0.1 },
  haiku: { in: 1, out: 5, cache: 0.1 },
  opus: { in: 5, out: 25, cache: 0.5 },
  gemini: { in: 0, out: 0, cache: 0 }, // quota gratuita di Google AI Studio
};
const prezzo = model => PREZZI[Object.keys(PREZZI).find(k => String(model || '').includes(k)) || 'sonnet'];
const APP_NOMI = { protocolli: 'Protocolli', turni: 'Turni', magazzino: 'Magazzino' };

let pronto = null;
function migrate() {
  if (!pronto) pronto = store.q(`create table if not exists ai_consumo (
      id bigserial primary key, quando timestamptz not null default now(), app text not null, funzione text not null,
      modello text, token_in int not null default 0, token_out int not null default 0, token_cache int not null default 0, costo numeric(12,6) not null default 0)`)
    .then(() => store.q('create index if not exists ai_consumo_quando on ai_consumo(quando)')).catch(e => { pronto = null; throw e; });
  return pronto;
}

// usage = j.usage della risposta Anthropic. Non blocca mai la chiamata che lo usa.
function registra(app, funzione, modello, usage) {
  if (!usage) return;
  const p = prezzo(modello);
  const tin = (usage.input_tokens || 0) + (usage.cache_creation_input_tokens || 0), tout = usage.output_tokens || 0, tc = usage.cache_read_input_tokens || 0;
  const costo = (tin * p.in + tout * p.out + tc * p.cache) / 1e6;
  migrate().then(() => store.q('insert into ai_consumo (app, funzione, modello, token_in, token_out, token_cache, costo) values ($1,$2,$3,$4,$5,$6,$7)',
    [app, funzione, String(modello || '').slice(0, 60), tin, tout, tc, costo])).catch(e => console.warn('Consumo AI non registrato:', e.message));
}

// Riepilogo di un mese (YYYY-MM, ora di Roma)
async function riepilogo(mese) {
  await migrate();
  const m = /^\d{4}-\d{2}$/.test(mese || '') ? mese : new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' }).slice(0, 7);
  const dove = `to_char(quando at time zone 'Europe/Rome', 'YYYY-MM') = $1`;
  const { rows: voci } = await store.q(`select app, funzione, count(*)::int as chiamate, sum(token_in)::int as tin, sum(token_out)::int as tout, sum(costo)::float as costo
    from ai_consumo where ${dove} group by app, funzione order by costo desc`, [m]);
  const { rows: giorni } = await store.q(`select to_char(quando at time zone 'Europe/Rome', 'YYYY-MM-DD') as giorno, sum(costo)::float as costo, count(*)::int as chiamate
    from ai_consumo where ${dove} group by 1 order by 1`, [m]);
  const { rows: mesi } = await store.q(`select to_char(quando at time zone 'Europe/Rome', 'YYYY-MM') as mese, sum(costo)::float as costo from ai_consumo group by 1 order by 1 desc limit 12`);
  return { mese: m, totale: voci.reduce((s, v) => s + v.costo, 0), voci: voci.map(v => ({ ...v, appNome: APP_NOMI[v.app] || v.app })), giorni, mesi };
}

/* ---------- interruttori: per ogni funzione si sceglie Claude, Gemini (solo dati non personali) o Spento ---------- */
const FUNZIONI = {
  prot_chat: { app: 'protocolli', nome: 'Assistente in chat dei Protocolli', def: 'off', gemini: true, senza: 'resta la ricerca nei testi.' },
  prot_riadegua: { app: 'protocolli', nome: 'Riscrittura dei protocolli nel modello', def: 'claude', gemini: true, senza: 'i protocolli si scrivono o si incollano a mano.' },
  prot_banca: { app: 'protocolli', nome: 'Banca domande dei test (300 per mansione)', def: 'claude', gemini: true, senza: 'la banca non si rigenera; i test usano le domande già presenti.' },
  prot_correzione: { app: 'protocolli', nome: 'Correzione delle risposte aperte dei test', def: 'claude', gemini: false, senza: 'le risposte aperte le corregge l’amministratore.' },
  turni_buste: { app: 'turni', nome: 'Lettura di ferie e permessi dalle buste paga', def: 'claude', gemini: false, senza: 'i residui si scrivono a mano. Con un formato già conosciuto la lettura è comunque automatica e gratuita.' },
  mag_letture: { app: 'magazzino', nome: 'Lettura di bolle ed etichette (Magazzino)', def: 'claude', gemini: false, senza: 'i dati si scrivono a mano.' },
};
let cacheInt = null, cacheT = 0;
async function interruttori() {
  if (cacheInt && Date.now() - cacheT < 20000) return cacheInt;
  await migrate();
  await store.q('create table if not exists ai_interruttori (k text primary key, v text not null)');
  const { rows } = await store.q('select k, v from ai_interruttori');
  const salvati = Object.fromEntries(rows.map(r => [r.k, r.v]));
  cacheInt = Object.fromEntries(Object.entries(FUNZIONI).map(([k, f]) => {
    let v = salvati[k] || f.def; if (v === 'gemini' && (!f.gemini || !process.env.GEMINI_API_KEY)) v = f.def === 'gemini' ? 'claude' : f.def;
    return [k, v];
  }));
  cacheT = Date.now(); return cacheInt;
}
async function stato(k) { return (await interruttori())[k] || 'off'; }
async function imposta(k, v) {
  const f = FUNZIONI[k]; if (!f) throw Object.assign(new Error('Funzione sconosciuta'), { status: 400 });
  if (!['claude', 'gemini', 'off'].includes(v)) throw Object.assign(new Error('Valore non valido'), { status: 400 });
  if (v === 'gemini' && !f.gemini) throw Object.assign(new Error('Questa funzione tratta dati personali: Gemini non si può usare.'), { status: 400 });
  if (v === 'gemini' && !process.env.GEMINI_API_KEY) throw Object.assign(new Error('Manca GEMINI_API_KEY su Render.'), { status: 400 });
  await interruttori();
  await store.q('insert into ai_interruttori (k, v) values ($1,$2) on conflict (k) do update set v = excluded.v', [k, v]);
  cacheInt = null;
}
async function elenco() {
  const st = await interruttori();
  return Object.entries(FUNZIONI).map(([k, f]) => ({ k, ...f, v: st[k] }));
}

// Chiamata all'AI scelta per la funzione k. system: istruzioni; messages: [{role, content}] o testo.
async function chiedi(k, system, messages, maxTokens = 4000, etichetta) {
  const f = FUNZIONI[k], prov = await stato(k);
  if (prov === 'off') throw Object.assign(new Error('Questa funzione è spenta dall’amministratore.'), { status: 403, spenta: true });
  const msgs = Array.isArray(messages) ? messages : [{ role: 'user', content: messages }];
  const label = etichetta || f.nome;
  if (prov === 'gemini') {
    const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
    const r = await fetch(process.env.GEMINI_URL || `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', signal: AbortSignal.timeout(240000),
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: system }] }, generationConfig: { maxOutputTokens: Math.max(maxTokens, 2048) },
        contents: msgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })) }),
    });
    if (!r.ok) { const t = await r.text().catch(() => ''); console.error('Gemini:', r.status, t.slice(0, 300));
      throw Object.assign(new Error(r.status === 429 ? 'Gemini: superata la quota gratuita. Riprova più tardi o passa a Claude.' : 'Gemini non ha risposto. Riprova tra poco.'), { status: 502 }); }
    const j = await r.json();
    const u = j.usageMetadata || {};
    registra(f.app, label + ' (Gemini)', 'gemini', { input_tokens: u.promptTokenCount || 0, output_tokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) });
    return (j.candidates?.[0]?.content?.parts || []).map(p => p.text || '').join('');
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error('Manca la chiave ANTHROPIC_API_KEY su Render.'), { status: 400 });
  const model = process.env.PROT_AI_MODEL || 'claude-sonnet-5-5';
  const r = await fetch(process.env.PROT_AI_URL || 'https://api.anthropic.com/v1/messages', {
    method: 'POST', signal: AbortSignal.timeout(240000),
    headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: msgs }),
  });
  if (!r.ok) { const t = await r.text().catch(() => ''); console.error('Claude:', r.status, t.slice(0, 300)); throw Object.assign(new Error('Il servizio di intelligenza artificiale non ha risposto. Riprova tra poco.'), { status: 502 }); }
  const j = await r.json();
  registra(f.app, label, model, j.usage);
  return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

module.exports = { registra, riepilogo, migrate, PREZZI, FUNZIONI, interruttori, stato, imposta, elenco, chiedi };
