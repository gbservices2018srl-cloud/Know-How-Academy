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
const APP_NOMI = { protocolli: 'Protocolli', turni: 'Turni', magazzino: 'Magazzino', documenti: 'Documenti di studio', prezzi: 'Raffronto prezzi', aso: 'Gestione ASO', hr: 'HR' };

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
  const ripieghi = voci.filter(v => /ripiego da Gemini/.test(v.funzione)).reduce((s, v) => ({ n: s.n + v.chiamate, costo: s.costo + v.costo }), { n: 0, costo: 0 });
  return { mese: m, ripieghi, totale: voci.reduce((s, v) => s + v.costo, 0), voci: voci.map(v => ({ ...v, appNome: APP_NOMI[v.app] || v.app })), giorni, mesi };
}

/* ---------- interruttori: per ogni funzione si sceglie Claude, Gemini (solo dati non personali) o Spento ---------- */
// def 'auto' = Gemini se c'è la chiave (dati non personali), altrimenti Claude
const FUNZIONI = {
  prot_chat: { app: 'protocolli', nome: 'Assistente in chat dei Protocolli', def: 'off', gemini: true, senza: 'resta la ricerca nei testi.' },
  prot_riadegua: { app: 'protocolli', nome: 'Riscrittura dei protocolli nel modello', def: 'auto', gemini: true, senza: 'i protocolli si scrivono o si incollano a mano.' },
  prot_banca: { app: 'protocolli', nome: 'Banca domande dei test (300 per mansione)', def: 'auto', gemini: true, senza: 'la banca non si rigenera; i test usano le domande già presenti.' },
  prot_correzione: { app: 'protocolli', nome: 'Correzione delle risposte aperte dei test', def: 'claude', gemini: false, senza: 'le risposte aperte le corregge l’amministratore.' },
  doc_pdf: { app: 'documenti', nome: 'Conversione dei PDF in pagine (Documenti di studio)', def: 'auto', gemini: true, senza: 'il PDF si converte dal solo testo, con un’impaginazione più semplice.' },
  prezzi_letture: { app: 'prezzi', nome: 'Lettura di listini e fatture dei fornitori (Raffronto prezzi)', def: 'auto', gemini: true, senza: 'le voci si inseriscono a mano.' },
  mag_letture: { app: 'magazzino', nome: 'Lettura di bolle ed etichette (Magazzino)', def: 'auto', gemini: true, senza: 'i dati si scrivono a mano.' },
  // solo le foto dei cicli della sterilizzatrice (nessun dato del paziente). Le etichette degli impianti, legate al paziente,
  // NON vanno a nessuna AI: si leggono con il lettore di codici a barre nel telefono. Se un giorno servisse l'AI, solo Claude.
  aso_foto: { app: 'aso', nome: 'Lettura delle foto della sterilizzatrice (Gestione ASO)', def: 'auto', gemini: true, senza: 'i dati del ciclo si compilano a mano.' },
  turni_buste: { app: 'turni', nome: 'Lettura di ferie e permessi dalle buste paga', def: 'claude', gemini: false, senza: 'i residui si scrivono a mano. Con un formato già conosciuto la lettura è comunque automatica e gratuita.' },
  turni_regole: { app: 'turni', nome: 'Regole del planning scritte a parole (Turni)', def: 'claude', gemini: false, senza: 'le regole si impostano a mano.' },
  hr_iprofile: { app: 'hr', nome: 'Lettura del grafico I-Profile (HR)', def: 'claude', gemini: false, senza: 'i valori si scrivono a mano.' },
};
let cacheInt = null, cacheT = 0;
async function interruttori() {
  if (cacheInt && Date.now() - cacheT < 20000) return cacheInt;
  await migrate();
  await store.q('create table if not exists ai_interruttori (k text primary key, v text not null)');
  // novembre 2026: si passa tutto a Claude (Gemini gratuito troppo lento e con poca quota). Una volta sola:
  // chi poi rimette Gemini a mano in «Consumo AI» lo ritrova.
  await store.q(`insert into ai_interruttori (k, v) values ('_tutto_claude_2026_11', 'fatto') on conflict do nothing returning k`)
    .then(r => r.rowCount && store.q(`update ai_interruttori set v = 'claude' where v = 'gemini'`)).catch(() => {});
  const { rows } = await store.q("select k, v from ai_interruttori where k not like '\\_%'");
  const salvati = Object.fromEntries(rows.map(r => [r.k, r.v]));
  const g = !!process.env.GEMINI_API_KEY;
  cacheInt = Object.fromEntries(Object.entries(FUNZIONI).map(([k, f]) => {
    let v = salvati[k] || f.def;
    if (v === 'auto') v = 'claude'; // predefinito: Claude (Gemini solo se scelto a mano in «Consumo AI»)
    if (v === 'gemini' && (!f.gemini || !g)) v = 'claude';
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

// blocchi in formato Anthropic (testo, immagine, PDF) → parti di Gemini
function partiGemini(content) {
  if (typeof content === 'string') return [{ text: content }];
  return content.map(b => b.type === 'text' ? { text: b.text } : (b.type === 'image' || b.type === 'document') && b.source?.type === 'base64'
    ? { inline_data: { mime_type: b.source.media_type, data: b.source.data } } : { text: '' });
}
// Modello Gemini: quello impostato (GEMINI_MODEL) oppure, se Google lo ritira, il "flash" più recente che Google offre
// (si chiede a Google l'elenco dei modelli). Così quando Google cambia modello l'app si adegua da sola.
let modelloAuto = null, modelloAutoIl = 0;
async function modelliFlash() {
  const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=200', { headers: { 'x-goog-api-key': process.env.GEMINI_API_KEY }, signal: AbortSignal.timeout(15000) });
  if (!r.ok) return [];
  const j = await r.json();
  const ver = n => (String(n).match(/gemini-(\d+(?:\.\d+)?)/) || [, '0'])[1] * 1;
  return (j.models || []).filter(m => (m.supportedGenerationMethods || []).includes('generateContent'))
    .map(m => m.name.replace(/^models\//, ''))
    .filter(n => /^gemini-\d+(\.\d+)?-flash$/.test(n)) // solo i "flash" stabili (niente preview, lite, tts, immagini…)
    .sort((a, b) => ver(b) - ver(a));
}
async function modelloGemini(cambia = false) {
  if (!cambia && modelloAuto && Date.now() - modelloAutoIl < 24 * 3600e3) return modelloAuto;
  if (cambia) {
    const lista = await modelliFlash().catch(() => []);
    const nuovo = lista.find(m => m !== modelloAuto);
    if (nuovo) { console.log(`Gemini: modello ${modelloAuto || process.env.GEMINI_MODEL} non disponibile, passo a ${nuovo}`); modelloAuto = nuovo; modelloAutoIl = Date.now(); return nuovo; }
    return null;
  }
  modelloAuto = modelloAuto || process.env.GEMINI_MODEL || 'gemini-3.8-flash'; modelloAutoIl = modelloAutoIl || Date.now();
  return modelloAuto;
}
async function unaChiamataGemini(model, system, msgs, maxTokens, conPensiero) {
  return fetch(process.env.GEMINI_URL || `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
    method: 'POST', signal: AbortSignal.timeout(90000),
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': process.env.GEMINI_API_KEY },
    body: JSON.stringify({ ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
      generationConfig: { maxOutputTokens: Math.max(maxTokens, 2048), ...(conPensiero ? {} : { thinkingConfig: { thinkingBudget: 0 } }) },
      contents: msgs.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: partiGemini(m.content) })) }),
  });
}
const pausa = ms => new Promise(r => setTimeout(r, ms));
async function viaGemini(f, label, system, msgs, maxTokens) {
  let model = await modelloGemini(), conPensiero = false, r, t = '', cambiato = false;
  // fino a 3 tentativi: Google a volte è sovraccarico (503) o lento; se il modello è stato ritirato (404) si passa al più recente
  for (let tentativo = 0; tentativo < 3; tentativo++) {
    try { r = await unaChiamataGemini(model, system, msgs, maxTokens, conPensiero); }
    catch (e) { if (tentativo < 2) { await pausa(1500); continue; } throw Object.assign(new Error('Gemini lento: ' + e.message), { gemini: 'timeout' }); }
    if (r.ok) break;
    t = await r.text().catch(() => '');
    if (r.status === 400 && /thinking/i.test(t) && !conPensiero) { conPensiero = true; continue; }
    if ((r.status === 404 || (r.status === 400 && /model/i.test(t))) && !cambiato) { const m = await modelloGemini(true); if (m) { model = m; cambiato = true; continue; } }
    if ([500, 502, 503, 504].includes(r.status) && tentativo < 2) { await pausa(2000 * (tentativo + 1)); continue; }
    break;
  }
  if (!r?.ok) throw Object.assign(new Error(`Gemini ${r?.status} ${t.slice(0, 200)}`), { gemini: r?.status });
  const j = await r.json();
  const u = j.usageMetadata || {};
  registra(f.app, label + ' (Gemini)', 'gemini', { input_tokens: u.promptTokenCount || 0, output_tokens: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) });
  const c = j.candidates?.[0] || {};
  return { text: (c.content?.parts || []).map(p => p.text || '').join(''), troncato: c.finishReason === 'MAX_TOKENS' };
}
async function viaClaude(f, label, system, msgs, maxTokens, opts) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error('La lettura automatica non è attiva (manca la chiave ANTHROPIC_API_KEY su Render).'), { status: 400 });
  const model = opts.model || process.env.PROT_AI_MODEL || 'claude-sonnet-5-5';
  let r;
  try {
    r = await fetch(process.env.PROT_AI_URL || 'https://api.anthropic.com/v1/messages', {
      method: 'POST', signal: AbortSignal.timeout(opts.timeout || 240000),
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: maxTokens, ...(system ? { system } : {}), messages: msgs }),
    });
  } catch { throw Object.assign(new Error('La lettura ha impiegato troppo. Riprova.'), { status: 502 }); }
  if (!r.ok) { const t = await r.text().catch(() => ''); console.error('Claude:', f.app, r.status, t.slice(0, 300));
    throw Object.assign(new Error(r.status === 429 ? 'Troppe richieste ravvicinate: riprova tra poco.' : r.status === 413 || /too large/i.test(t) ? 'Il file è troppo grande: prova con meno pagine.' : 'Il servizio di intelligenza artificiale non ha risposto. Riprova tra poco.'), { status: 502, http: r.status }); }
  const j = await r.json();
  registra(f.app, label, model, j.usage);
  return { text: (j.content || []).filter(b => b.type === 'text').map(b => b.text).join(''), troncato: j.stop_reason === 'max_tokens' };
}

// Quando Gemini non risponde e si usa Claude (a pagamento) avvisa il proprietario: al massimo una notifica al giorno per funzione.
// I disguidi passeggeri di Google (sovraccarico, lentezza) non si segnalano: si avvisa solo se la quota è finita
// oppure se nella giornata i ripieghi sono tanti (5 o più), cioè se c'è davvero un problema.
const ripieghi = new Map(), contaRipieghi = new Map();
async function avvisaRipiego(k, f, motivo, grave = false) {
  const oggi = new Date().toLocaleDateString('sv-SE', { timeZone: 'Europe/Rome' });
  const ck = k + '|' + oggi, n = (contaRipieghi.get(ck) || 0) + 1; contaRipieghi.set(ck, n);
  if (contaRipieghi.size > 200) contaRipieghi.clear();
  if (!grave && n < 5) return;
  if (ripieghi.get(k) === oggi) return;
  ripieghi.set(k, oggi);
  try {
    const { rows } = await store.q("select id from users where owner and status = 'active'");
    await require('../accessi/lib/notifiche').notifica(rows.map(r => r.id), 'sistema', {
      title: 'Gemini non disponibile: uso Claude', body: `${f.nome}: ${motivo}. Per oggi si usa Claude (a pagamento). Dettagli in Consumo AI.`, url: '/admin', tag: 'ripiego-' + k });
  } catch (e) { console.warn('Avviso ripiego non inviato:', e.message); }
}

// Chiamata all'AI scelta per la funzione k. system: istruzioni (o null); messages: testo o [{role, content}] (content: testo o blocchi).
// opts: { model (solo Claude), timeout, completo (restituisce {text, troncato}) }. Se Gemini non risponde o finisce la quota, prova con Claude.
async function chiedi(k, system, messages, maxTokens = 4000, etichetta, opts = {}) {
  const f = FUNZIONI[k], prov = await stato(k);
  if (prov === 'off') throw Object.assign(new Error('Questa funzione è spenta dall’amministratore: compila a mano.'), { status: 403, spenta: true });
  const msgs = Array.isArray(messages) ? messages : [{ role: 'user', content: messages }];
  const label = etichetta || f.nome;
  let out;
  if (prov === 'gemini') {
    try { out = await viaGemini(f, label, system, msgs, maxTokens); }
    catch (e) {
      console.warn(`Gemini (${f.app}) non disponibile, uso Claude:`, e.message);
      avvisaRipiego(k, f, e.gemini === 429 ? 'quota gratuita di oggi finita' : 'Gemini non risponde da diverse richieste', e.gemini === 429);
      if (!process.env.ANTHROPIC_API_KEY) throw Object.assign(new Error(e.gemini === 429 ? 'Gemini: quota gratuita finita per oggi. Riprova domani.' : 'Il servizio di intelligenza artificiale non ha risposto. Riprova tra poco.'), { status: 502 });
      out = await viaClaude(f, label + ' · ripiego da Gemini', system, msgs, maxTokens, opts);
    }
  } else out = await viaClaude(f, label, system, msgs, maxTokens, opts);
  return opts.completo ? out : out.text;
}

module.exports = { registra, riepilogo, migrate, PREZZI, FUNZIONI, interruttori, stato, imposta, elenco, chiedi };
