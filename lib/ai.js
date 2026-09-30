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

module.exports = { complete, providerInfo, AIError };
