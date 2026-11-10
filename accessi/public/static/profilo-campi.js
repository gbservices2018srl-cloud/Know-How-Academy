// Campi dell'anagrafica (telefono, residenza, IBAN, contratto…): stesso modulo in registrazione, «Completa il tuo profilo» e pannello.
// L'elenco dei campi arriva dal server (accessi/lib/profilo.js): un campo nuovo compare qui da solo.
(function () {
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const aiuto = c => c.aiuto ? ` <small class="muted" style="font-weight:500">${esc(c.aiuto)}</small>` : '';
  function campo(c, v, o) {
    const id = (o.prefix || 'pc') + '-' + c.k, manca = o.mancanti && o.mancanti.includes(c.k);
    const seg = manca ? ' <b style="color:var(--olive-ink);font-size:12.5px">· da compilare</b>' : '';
    if (c.tipo === 'tel') return `<label class="field" for="${id}"><span>${esc(c.nome)}${seg}</span>${aiuto(c)}<input id="${id}" data-pc="${c.k}" type="tel" inputmode="tel" autocomplete="tel" maxlength="20" value="${esc(v || '')}" placeholder="es. 3471234567"></label>`;
    if (c.tipo === 'indirizzo') {
      v = v || {};
      return `<fieldset class="pc-box" data-pc="${c.k}" data-tipo="indirizzo"><legend>${esc(c.nome)}${seg}</legend>
        <label class="field" for="${id}-via">Via e numero civico<input id="${id}-via" data-sub="via" autocomplete="street-address" maxlength="120" value="${esc(v.via || '')}"></label>
        <div class="pc-3"><label class="field" for="${id}-cap">CAP<input id="${id}-cap" data-sub="cap" inputmode="numeric" autocomplete="postal-code" maxlength="5" value="${esc(v.cap || '')}"></label>
        <label class="field" for="${id}-com">Comune<input id="${id}-com" data-sub="comune" autocomplete="address-level2" maxlength="80" value="${esc(v.comune || '')}"></label>
        <label class="field" for="${id}-pr">Prov.<input id="${id}-pr" data-sub="provincia" maxlength="2" style="text-transform:uppercase" value="${esc(v.provincia || '')}" placeholder="CA"></label></div></fieldset>`;
    }
    if (c.tipo === 'iban') {
      const ph = o.ibanFine ? `•••• ${o.ibanFine} (lascia vuoto per non cambiarlo)` : 'IT00 X000 0000 0000 0000 0000 000';
      return `<label class="field" for="${id}"><span>${esc(c.nome)}${seg}</span>${aiuto(c)}<input id="${id}" data-pc="${c.k}" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="42"
        style="text-transform:uppercase;letter-spacing:.03em" value="${esc(v || '')}" placeholder="${esc(ph)}"></label>`;
    }
    if (c.tipo === 'contratto') {
      v = v || {};
      const bloccato = v.ok && !o.admin;
      return `<fieldset class="pc-box" data-pc="${c.k}" data-tipo="contratto" ${bloccato ? 'disabled' : ''}><legend>${esc(c.nome)}${seg}</legend>${aiuto(c) ? `<div style="margin-top:-4px">${aiuto(c)}</div>` : ''}
        <div class="pc-scelte"><label class="check"><input type="radio" name="${id}-t" value="dip" data-sub="tipo" ${v.tipo === 'dip' ? 'checked' : ''}><span>Dipendente</span></label>
        <label class="check"><input type="radio" name="${id}-t" value="piva" data-sub="tipo" ${v.tipo === 'piva' ? 'checked' : ''}><span>Partita IVA</span></label></div>
        <label class="field pc-ore" for="${id}-ore" ${v.tipo === 'dip' ? '' : 'hidden'}>Ore settimanali del contratto<input id="${id}-ore" data-sub="ore" inputmode="decimal" maxlength="5" value="${esc(v.ore ?? '')}" placeholder="es. 32" style="max-width:140px"></label>
        ${v.tipo ? `<div style="font-size:13.5px;color:${v.ok ? 'var(--ok)' : 'var(--olive-ink)'}">${v.ok ? "✓ Confermato dall'amministratore" + (bloccato ? ': per cambiarlo chiediglielo.' : '') : "In attesa di conferma dell'amministratore"}</div>` : ''}</fieldset>`;
    }
    return `<label class="field" for="${id}"><span>${esc(c.nome)}${seg}</span>${aiuto(c)}<input id="${id}" data-pc="${c.k}" maxlength="200" value="${esc(v || '')}"></label>`;
  }
  const CSS = `.pc-box{border:1px solid var(--line);border-radius:14px;padding:12px 14px 14px;display:flex;flex-direction:column;gap:10px;margin:0;min-width:0}
    .pc-box legend{font-weight:600;padding:0 6px}.pc-3{display:grid;grid-template-columns:110px 1fr 70px;gap:10px}
    .pc-scelte{display:flex;gap:18px;flex-wrap:wrap}[hidden]{display:none!important}
    @media (max-width:480px){.pc-3{grid-template-columns:1fr 70px}.pc-3 label:nth-child(2){grid-column:1/-1;grid-row:1}}`;
  function stile() { if (!document.getElementById('pc-css')) { const s = document.createElement('style'); s.id = 'pc-css'; s.textContent = CSS; document.head.appendChild(s); } }
  window.ProfiloCampi = {
    // campi: dal server; valori: { telefono, residenza, iban, contratto }; o: { prefix, admin, mancanti, ibanFine, solo: [chiavi] }
    html(campi, valori, o = {}) {
      stile(); valori = valori || {};
      return campi.filter(c => c.chi === 'persona' && (!o.solo || o.solo.includes(c.k))).map(c => campo(c, valori[c.k], o)).join('');
    },
    // dopo aver messo l'html nella pagina: le ore compaiono solo per i dipendenti
    attiva(root) {
      root.addEventListener('change', e => {
        const r = e.target.closest('[data-tipo="contratto"] input[data-sub="tipo"]'); if (!r) return;
        const box = r.closest('fieldset'), ore = box.querySelector('.pc-ore');
        ore.hidden = r.value !== 'dip'; if (r.value === 'dip') ore.querySelector('input').focus();
      });
    },
    leggi(root) {
      const out = {};
      root.querySelectorAll('[data-pc]').forEach(el => {
        const k = el.dataset.pc;
        if (el.dataset.tipo === 'indirizzo') { out[k] = {}; el.querySelectorAll('[data-sub]').forEach(i => out[k][i.dataset.sub] = i.value.trim()); }
        else if (el.dataset.tipo === 'contratto') {
          if (el.disabled) return;
          const t = el.querySelector('[data-sub="tipo"]:checked');
          out[k] = { tipo: t ? t.value : '', ore: el.querySelector('[data-sub="ore"]').value.trim() };
          if (!out[k].tipo) out[k] = null;
        } else out[k] = el.value.trim();
      });
      return out;
    },
  };
})();
