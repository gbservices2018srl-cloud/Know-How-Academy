// Invio email con Resend (https://resend.com, gratuito fino a 3.000 email al mese).
// Impostazioni su Render: RESEND_API_KEY, MAIL_FROM (es. "To Smile <accessi@appgestione.it>").
// Senza chiave le email non partono: il messaggio finisce nel log e l'app continua a funzionare.
const FROM = () => process.env.MAIL_FROM || 'To Smile · Accessi <accessi@appgestione.it>';

const enabled = () => !!process.env.RESEND_API_KEY;

async function send({ to, subject, text, html, replyTo, attachments }) {
  if (!enabled()) {
    console.log(`[email non inviata: manca RESEND_API_KEY] a ${to}: ${subject}`);
    return false;
  }
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: FROM(), to: [].concat(to), subject, text, html, ...(replyTo ? { reply_to: replyTo } : {}),
        ...(attachments?.length ? { attachments: attachments.map(a => ({ filename: a.filename, content: Buffer.from(a.content).toString('base64') })) } : {}) }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { console.warn('Email non inviata:', r.status, (await r.text()).slice(0, 300)); return false; }
    return true;
  } catch (e) {
    console.warn('Email non inviata:', e.message);
    return false;
  }
}

const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Impaginazione semplice e leggibile in tutti i programmi di posta.
function layout(title, paragraphs, button) {
  const ps = paragraphs.map(p => `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:#2B3033">${p}</p>`).join('');
  const btn = button ? `<p style="margin:22px 0 8px"><a href="${esc(button.url)}" style="display:inline-block;background:#2A7C7D;color:#fff;text-decoration:none;font-weight:600;padding:12px 20px;border-radius:10px;font-size:15px">${esc(button.label)}</a></p>
    <p style="margin:0 0 14px;font-size:12.5px;color:#6B7276">Se il pulsante non funziona copia questo indirizzo nel browser:<br>${esc(button.url)}</p>` : '';
  return `<!doctype html><html><body style="margin:0;background:#FBFBF8;font-family:Arial,Helvetica,sans-serif">
  <div style="max-width:560px;margin:0 auto;padding:28px 20px">
    <div style="font-weight:800;font-size:20px;color:#2A7C7D;margin-bottom:4px">To Smile</div>
    <div style="width:44px;height:8px;border:4px solid #E8E560;border-top:0;border-radius:0 0 40px 40px;margin-bottom:22px"></div>
    <h1 style="font-size:20px;margin:0 0 16px;color:#2B3033">${esc(title)}</h1>${ps}${btn}
    <p style="margin:26px 0 0;font-size:12px;color:#6B7276;border-top:1px solid #E6E6DF;padding-top:14px">Email automatica dell'accesso unico alle app del gruppo To Smile · appgestione.it</p>
  </div></body></html>`;
}

module.exports = { send, enabled, layout, esc };
