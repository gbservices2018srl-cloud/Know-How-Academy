// Collegamento all'assistente AI. Si sceglie con AI_PROVIDER = openai | anthropic | gemini.
// Il modello si può cambiare con AI_MODEL senza toccare il codice.

const DEFAULT_MODELS = {
  openai: 'gpt-4.1-mini',
  anthropic: 'claude-sonnet-5-5',
  gemini: 'gemini-2.5-flash',
};

function providerInfo() {
  const provider = (process.env.AI_PROVIDER || '').trim().toLowerCase();
  const keys = { openai: process.env.OPENAI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY, gemini: process.env.GEMINI_API_KEY };
  if (!DEFAULT_MODELS[provider]) return { ok: false, reason: 'AI_PROVIDER non impostato (usa openai, anthropic o gemini).' };
  if (!keys[provider]) return { ok: false, reason: `Manca la chiave API per ${provider}.` };
  return { ok: true, provider, key: keys[provider], model: process.env.AI_MODEL || DEFAULT_MODELS[provider] };
}

class AIError extends Error {}

async function readError(res) {
  let t = ''; try { t = await res.text(); } catch (e) {}
  return `${res.status} ${t.slice(0, 400)}`;
}

// system: istruzioni + fonti; messages: [{role:'user'|'assistant', content}]
async function complete(system, messages) {
  const p = providerInfo();
  if (!p.ok) throw new AIError(p.reason);
  const signal = AbortSignal.timeout(120000);

  if (p.provider === 'openai') {
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
      body: JSON.stringify({ model: p.model, messages: [{ role: 'system', content: system }, ...messages] }),
    });
    if (!res.ok) throw new AIError('OpenAI: ' + await readError(res));
    const j = await res.json();
    return j.choices?.[0]?.message?.content || '';
  }

  if (p.provider === 'anthropic') {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST', signal,
      headers: { 'Content-Type': 'application/json', 'x-api-key': p.key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: p.model, max_tokens: 1500, system, messages }),
    });
    if (!res.ok) throw new AIError('Anthropic: ' + await readError(res));
    const j = await res.json();
    return (j.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  }

  // gemini
  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(p.model)}:generateContent`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': p.key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: system }] },
      contents: messages.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] })),
    }),
  });
  if (!res.ok) throw new AIError('Gemini: ' + await readError(res));
  const j = await res.json();
  return (j.candidates?.[0]?.content?.parts || []).map(x => x.text || '').join('');
}

/* ---------- impronte di significato (embeddings) per la ricerca semantica ---------- */
// Anthropic non offre embeddings: in quel caso si usa Gemini o OpenAI se è presente la loro chiave,
// altrimenti la ricerca resta solo per parole. Si può forzare con EMBED_PROVIDER.
const EMBED_DEFAULTS = { openai: 'text-embedding-3-small', gemini: 'gemini-embedding-001' };
const EMBED_DIMS = 768;
function embedInfo() {
  const keys = { openai: process.env.OPENAI_API_KEY, gemini: process.env.GEMINI_API_KEY };
  let p = (process.env.EMBED_PROVIDER || '').trim().toLowerCase();
  if (!p) {
    const main = (process.env.AI_PROVIDER || '').trim().toLowerCase();
    p = keys[main] ? main : keys.gemini ? 'gemini' : keys.openai ? 'openai' : '';
  }
  if (!EMBED_DEFAULTS[p] || !keys[p]) return { ok: false };
  const model = process.env.EMBED_MODEL || EMBED_DEFAULTS[p];
  return { ok: true, provider: p, key: keys[p], model, id: `${p}:${model}:${EMBED_DIMS}` };
}
function normalize(v) { let s = 0; for (const x of v) s += x * x; s = Math.sqrt(s) || 1; return v.map(x => x / s); }

// texts: array di stringhe; kind: 'doc' | 'query'. Restituisce array di vettori normalizzati.
async function embed(texts, kind = 'doc') {
  const p = embedInfo(); if (!p.ok) throw new AIError('Embeddings non configurati');
  const out = [];
  for (let i = 0; i < texts.length; i += 50) {
    const batch = texts.slice(i, i + 50).map(t => t.slice(0, 8000));
    const signal = AbortSignal.timeout(60000);
    if (p.provider === 'openai') {
      const res = await fetch('https://api.openai.com/v1/embeddings', {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${p.key}` },
        body: JSON.stringify({ model: p.model, input: batch, dimensions: EMBED_DIMS }),
      });
      if (!res.ok) throw new AIError('OpenAI embeddings: ' + await readError(res));
      const j = await res.json();
      j.data.sort((a, b) => a.index - b.index).forEach(d => out.push(normalize(d.embedding)));
    } else {
      const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(p.model)}:batchEmbedContents`, {
        method: 'POST', signal, headers: { 'Content-Type': 'application/json', 'x-goog-api-key': p.key },
        body: JSON.stringify({ requests: batch.map(t => ({
          model: `models/${p.model}`, content: { parts: [{ text: t }] },
          taskType: kind === 'query' ? 'RETRIEVAL_QUERY' : 'RETRIEVAL_DOCUMENT', outputDimensionality: EMBED_DIMS,
        })) }),
      });
      if (!res.ok) throw new AIError('Gemini embeddings: ' + await readError(res));
      const j = await res.json();
      j.embeddings.forEach(e => out.push(normalize(e.values)));
    }
  }
  return out;
}

module.exports = { complete, providerInfo, AIError, embed, embedInfo };
