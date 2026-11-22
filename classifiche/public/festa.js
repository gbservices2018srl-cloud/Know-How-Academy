/* Festa To Smile: festoni e finestra di lode, uguali in tutte le app (CRM, REC, ASO, Classifiche).
   Uso: TSFesta.festoni(false) per un getto piccolo; TSFesta.mostra(dati) per la lode con i festoni grandi. */
(function () {
  if (window.TSFesta) return;
  const css = `
  .tsf-velo{position:fixed;inset:0;background:rgba(20,27,28,.45);display:grid;place-items:center;padding:16px;z-index:9998;overflow-y:auto}
  .tsf-velo[hidden]{display:none!important}
  .tsf{--tsf-bg:#fff;--tsf-fg:#1F2A2B;--tsf-mu:#5E6B6C;--tsf-s2:#EEF3F2;--tsf-ok:#2E8B57;--tsf-oks:#E3F3EA;--tsf-w:#FBF5D6;--tsf-star:#E0A100;--tsf-off:#D5DCDB;
    background:var(--tsf-bg);color:var(--tsf-fg);border-radius:22px;box-shadow:0 18px 50px rgba(31,42,43,.25);max-width:440px;width:100%;padding:24px 20px 18px;text-align:center;position:relative;overflow:hidden;display:grid;gap:10px;font-family:inherit;animation:tsf-in .5s cubic-bezier(.2,1.4,.4,1)}
  @media (prefers-color-scheme: dark){.tsf{--tsf-bg:#1D2627;--tsf-fg:#E8EFEE;--tsf-mu:#9FB0B1;--tsf-s2:#253031;--tsf-ok:#5CC28A;--tsf-oks:#1E3A2B;--tsf-w:#3A3420;--tsf-star:#F2C230;--tsf-off:#3C4A4C}}
  .tsf::before{content:"";position:absolute;inset:0 0 auto;height:8px;background:linear-gradient(90deg,#4CAAAA,#E8E564,#8C6898)}
  .tsf.oro::before{background:linear-gradient(90deg,#F6D365,#D4A017,#F6D365)}
  .tsf h2{margin:0;font-size:24px;font-weight:800;line-height:1.2}
  .tsf .tsf-chi{color:#2F7F7F;font-weight:700;margin:-6px 0 0}
  @media (prefers-color-scheme: dark){.tsf .tsf-chi{color:#7FD0D0}}
  .tsf .tsf-frase{font-size:16.5px;line-height:1.45;margin:0}
  .tsf .tsf-tr{justify-self:center;background:#8C6898;color:#fff;border-radius:99px;padding:5px 14px;font-size:12.5px;font-weight:800;letter-spacing:.04em;text-transform:uppercase}
  .tsf .tsf-sorp{background:#8C6898;color:#fff;border-radius:12px;padding:10px 12px;font-weight:700;font-size:14.5px}
  .tsf .tsf-badge{justify-self:center;background:var(--tsf-s2);border-radius:99px;padding:6px 12px;font-size:13px;font-weight:600;color:var(--tsf-mu)}
  .tsf .tsf-st{display:inline-flex;gap:2px;font-size:18px;line-height:1;justify-self:center}.tsf .tsf-st.big{font-size:28px}
  .tsf .tsf-st .on{color:var(--tsf-star)}.tsf .tsf-st .off{color:var(--tsf-off)}
  .tsf .tsf-par{display:grid;grid-template-columns:1fr auto;gap:2px 12px;align-items:center;text-align:left;padding:9px 12px;border-radius:12px;background:var(--tsf-s2);font-size:13.5px}
  .tsf .tsf-par .v{color:var(--tsf-mu);grid-column:1/-1;font-size:12.5px}
  .tsf .tsf-par .g{grid-column:1/-1;font-size:12.5px;font-weight:700;color:var(--tsf-mu)}.tsf .tsf-par .g.si{color:var(--tsf-ok)}
  .tsf .tsf-ok{background:var(--tsf-oks);color:var(--tsf-ok);border-radius:12px;padding:8px 12px;font-weight:700;font-size:14px}
  .tsf .tsf-passo{font-size:13.5px;background:var(--tsf-w);border-radius:10px;padding:8px 12px;text-align:left}
  .tsf .tsf-btn{border:0;border-radius:12px;background:#4CAAAA;color:#fff;font:inherit;font-weight:700;font-size:15px;min-height:46px;width:100%;cursor:pointer;margin-top:4px}
  .tsf a.tsf-link{font-size:13.5px;color:var(--tsf-mu);font-weight:600}
  .tsf .tsf-med{width:110px;height:110px;justify-self:center}
  @keyframes tsf-in{from{transform:scale(.7);opacity:0}to{transform:none;opacity:1}}
  @media (prefers-reduced-motion: reduce){.tsf{animation:none}}`;
  const st = document.createElement('style'); st.textContent = css; document.head.appendChild(st);
  const cv = document.createElement('canvas'); cv.setAttribute('aria-hidden', 'true');
  cv.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;pointer-events:none;z-index:9999';
  const velo = document.createElement('div'); velo.className = 'tsf-velo'; velo.hidden = true;
  const pronto = () => { document.body.appendChild(velo); document.body.appendChild(cv); };
  document.body ? pronto() : document.addEventListener('DOMContentLoaded', pronto);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const stelle = (n, big) => `<span class="tsf-st${big ? ' big' : ''}"><span class="on">${'★'.repeat(n)}</span><span class="off">${'★'.repeat(5 - n)}</span></span>`;
  const MED = { oro: ['#F6D365', '#D4A017', '#A77B06'], argento: ['#E3E8EA', '#9AA5A8', '#6E7A7D'], bronzo: ['#E8B07A', '#B87333', '#7A4A1F'] };
  const medaglia = t => { const c = MED[t] || MED.oro; return `<svg viewBox="0 0 100 100"><path d="M34 4h14l6 30H40z" fill="#4CAAAA"/><path d="M66 4H52l-6 30h14z" fill="#8C6898"/><circle cx="50" cy="62" r="30" fill="${c[1]}"/><circle cx="50" cy="62" r="23" fill="${c[0]}" stroke="${c[2]}" stroke-width="2"/><path d="M50 46l4.6 9.4 10.4 1.5-7.5 7.3 1.8 10.3L50 69.6l-9.3 4.9 1.8-10.3-7.5-7.3 10.4-1.5z" fill="${c[2]}"/></svg>`; };
  // mostrine: commerciali 0–3, REC 0–4
  const insegna = (cat, g) => {
    const col = cat === 'rec' ? ['#9AA5A8', '#4CAAAA', '#5B8DB8', '#8C6898', '#D4A017'][g] : ['#9AA5A8', '#4CAAAA', '#8C6898', '#D4A017'][g];
    if (!g) return `<svg viewBox="0 0 40 40"><circle cx="20" cy="20" r="9" fill="${col}"/></svg>`;
    const top = cat === 'rec' ? g === 4 : g === 3, n = cat === 'rec' ? (g === 4 ? 1 : Math.min(g, 3)) : (g === 3 ? 2 : g), y0 = top ? 20 : 12;
    let s = ''; for (let i = 0; i < n; i++) s += `<path d="M8 ${y0 + i * 8} L20 ${y0 + i * 8 + 7} L32 ${y0 + i * 8}" fill="none" stroke="${col}" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>`;
    if (top) s += `<path d="M20 2 l2.6 5.4 5.9.8-4.3 4.1 1 5.9L20 15.4l-5.2 2.8 1-5.9-4.3-4.1 5.9-.8z" fill="${col}"/>`;
    return `<svg viewBox="0 0 40 40">${s}</svg>`;
  };
  function mostra(d) {
    if (!d) return;
    const medTipo = ['oro', 'argento', 'bronzo'].includes(d.tipo) ? d.tipo : '';
    velo.innerHTML = `<div class="tsf${d.oro ? ' oro' : ''}" role="dialog" aria-modal="true" aria-label="${esc(d.titolo)}">
      ${d.traguardo ? `<span class="tsf-tr">${esc(d.traguardo)}</span>` : ''}
      ${medTipo ? `<div class="tsf-med">${medaglia(medTipo)}</div>` : ''}
      ${d.tipo === 'grado' ? `<div class="tsf-med" style="width:90px;height:90px">${insegna(d.cat, d.grado)}</div>` : ''}
      <h2>${esc(d.titolo)}</h2>
      ${d.chi ? `<p class="tsf-chi">${esc(d.chi)}</p>` : ''}
      ${d.paziente ? `<div class="tsf-par"><b>${esc(d.paziente.nome)}</b><span></span><span class="v">${esc(d.paziente.dettaglio)}</span></div>` : ''}
      ${d.frase ? `<p class="tsf-frase">${esc(d.frase)}</p>` : ''}
      ${d.sorpasso ? `<div class="tsf-sorp">${esc(d.sorpasso)}</div>` : d.posizione ? `<div class="tsf-badge">${esc(d.posizione)}</div>` : ''}
      ${d.stelle ? stelle(d.stelle, true) : ''}
      ${(d.parametri || []).map(p => `<div class="tsf-par"><b>${esc(p.nome)}</b>${stelle(p.stelle)}<span class="v">${esc(p.valore)}</span><span class="g ${p.ok ? 'si' : ''}">${esc(p.goal)}</span></div>`).join('')}
      ${d.doppio ? `<div class="tsf-ok">${esc(d.doppio)}</div>` : ''}
      ${d.grado && typeof d.grado === 'string' ? `<div class="tsf-ok">${esc(d.grado)}</div>` : ''}
      ${d.passo ? `<div class="tsf-passo"><b>Prossimo passo:</b> ${esc(d.passo)}</div>` : ''}
      <button class="tsf-btn" type="button" data-tsf-chiudi>${esc(d.bottone || 'Grazie, continuo così')}</button>
      ${location.pathname.startsWith('/classifiche') ? '' : '<a class="tsf-link" href="/classifiche/">Vedi le classifiche →</a>'}
    </div>`;
    velo.hidden = false;
    velo.querySelector('[data-tsf-chiudi]').focus();
    festoni(true); if (d.grande) setTimeout(() => festoni(true), 700);
  }
  const chiudi = () => { velo.hidden = true; };
  velo.addEventListener('click', e => { if (e.target === velo || e.target.closest('[data-tsf-chiudi]')) chiudi(); });
  document.addEventListener('keydown', e => { if (e.key === 'Escape' && !velo.hidden) chiudi(); });
  // festoni disegnati qui (nessun file esterno), colori To Smile
  const COL = ['#4CAAAA', '#E8E564', '#8C6898', '#2E8B57', '#F28C6B', '#5B8DB8', '#D4A017'];
  let pezzi = [], giro = 0;
  function festoni(grande) {
    const d = devicePixelRatio || 1, W = cv.width = innerWidth * d, H = cv.height = innerHeight * d, n = grande ? 220 : 120;
    for (let i = 0; i < n; i++) {
      const sx = i % 2 === 0, x0 = grande ? (sx ? 0 : W) : W / 2, y0 = grande ? H * .75 : H * .55;
      const a = grande ? (sx ? -Math.PI / 3 : -2 * Math.PI / 3) + (Math.random() - .5) * .9 : -Math.PI / 2 + (Math.random() - .5) * 2.2;
      const v = (grande ? 18 : 14) * d * (.55 + Math.random() * .7);
      pezzi.push({ x: x0, y: y0, vx: Math.cos(a) * v, vy: Math.sin(a) * v, r: Math.random() * 6.28, vr: (Math.random() - .5) * .35, w: (5 + Math.random() * 7) * d, h: (8 + Math.random() * 10) * d, c: COL[i % COL.length], nastro: Math.random() < .25, t: 0 });
    }
    if (!giro) giro = requestAnimationFrame(passo);
  }
  function passo() {
    const d = devicePixelRatio || 1, cx = cv.getContext('2d'); cx.clearRect(0, 0, cv.width, cv.height);
    pezzi = pezzi.filter(p => p.y < cv.height + 40 && p.t < 400);
    for (const p of pezzi) {
      p.t++; p.vx *= .985; p.vy = p.vy * .985 + .32 * d; p.x += p.vx + Math.sin(p.t / 9) * .8 * d; p.y += p.vy; p.r += p.vr;
      cx.save(); cx.translate(p.x, p.y); cx.rotate(p.r); cx.fillStyle = p.c;
      if (p.nastro) cx.fillRect(-p.w / 4, -p.h, p.w / 2, p.h * 2.2); else { cx.scale(1, Math.cos(p.t / 6)); cx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h); }
      cx.restore();
    }
    giro = pezzi.length ? requestAnimationFrame(passo) : 0;
    if (!giro) cx.clearRect(0, 0, cv.width, cv.height);
  }
  window.TSFesta = { mostra, festoni, insegna, medaglia, stelle };
})();
