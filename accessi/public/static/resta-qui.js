/* To Smile · "resta qui": dopo una modifica la pagina non torna in alto.
   Vale per tutte le app (si carica da appgestione.it/static/resta-qui.js).
   Quando tocchi, scrivi o scegli qualcosa, ricorda dove eri (la pagina e le tabelle che scorrono dentro di sé);
   se subito dopo l'app ridisegna la pagina e la posizione salta indietro, la rimette com'era.
   Non interviene quando cambi sezione (menu, schede, link) o quando è l'app stessa a portarti in un punto preciso. */
(function () {
  if (window.__restaQui) return;
  window.__restaQui = true;
  var DURATA = 1500;          // per quanto tempo dopo un gesto si sorveglia la posizione
  var NAV = 'nav, [role="tab"], [role="tablist"] *, .tabs, .tab, .navbtn, .navlink, .menu, .sidebar a, aside a, a[href]:not([href^="#"]):not([href=""]), [data-go], [data-pag], [data-sez], [data-view], [data-nav], [data-tab], [data-page], [data-goto]';
  var snap = null, voluto = 0;

  // l'app che sposta di proposito la pagina (es. "torna su" quando apre un'altra schermata) ha la precedenza
  function segnaVoluto() { voluto = Date.now(); }
  var ws = window.scrollTo, wb = window.scroll, iv = Element.prototype.scrollIntoView;
  window.scrollTo = function () { segnaVoluto(); return ws.apply(window, arguments); };
  window.scroll = function () { segnaVoluto(); return wb.apply(window, arguments); };
  Element.prototype.scrollIntoView = function () { segnaVoluto(); return iv.apply(this, arguments); };

  function scorrevoli() {
    var out = [], els = document.querySelectorAll('body *');
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      if (e.scrollTop > 0 || e.scrollLeft > 0) {
        var st = getComputedStyle(e);
        if (/(auto|scroll)/.test(st.overflowY + st.overflowX)) out.push(e);
      }
    }
    return out;
  }
  function chiave(e) { // come ritrovare la stessa tabella dopo che è stata ridisegnata
    var c = (e.className && typeof e.className === 'string' ? e.className.trim().split(/\s+/).sort().join('.') : '');
    var k = e.tagName + '.' + c + (e.id ? '#' + e.id : '');
    var stessi = document.querySelectorAll(e.tagName + (c ? '.' + c.split('.').map(function (x) { return CSS.escape(x); }).join('.') : ''));
    return { k: k, sel: e.tagName + (c ? '.' + c.split('.').map(function (x) { return CSS.escape(x); }).join('.') : ''), i: Array.prototype.indexOf.call(stessi, e), id: e.id };
  }
  var CAMPI = 'input, select, textarea, [contenteditable="true"]';
  function eScorrevole(e) { if (!e || e === document.documentElement || e === document.body) return true; var st = getComputedStyle(e); return /(auto|scroll)/.test(st.overflowY + st.overflowX) && (e.scrollHeight > e.clientHeight || e.scrollWidth > e.clientWidth); }
  function fotografa(ev) {
    var t = ev.target && ev.target.closest ? ev.target : null;
    if (t && t.closest(NAV)) { snap = null; return; }      // cambio di sezione: si riparte dall'alto come previsto
    // tasti per scorrere (frecce, pagina su/giù…) fuori dai campi: è l'utente che si sposta
    if (ev.type === 'keydown' && !(t && t.closest(CAMPI)) && ['PageUp', 'PageDown', 'Home', 'End', 'ArrowUp', 'ArrowDown', ' ', 'Spacebar'].indexOf(ev.key) >= 0) { snap = null; return; }
    // presa sulla barra di scorrimento della pagina o di una tabella: è l'utente che si sposta
    if (ev.type === 'pointerdown' && t && eScorrevole(t)) { snap = null; return; }
    snap = { t: Date.now(), x: window.scrollX, y: window.scrollY, h: document.documentElement.scrollHeight,
      dentro: scorrevoli().map(function (e) { return { c: chiave(e), top: e.scrollTop, left: e.scrollLeft }; }) };
  }
  ['pointerdown', 'keydown', 'change', 'input', 'submit'].forEach(function (n) { document.addEventListener(n, fotografa, true); });
  // l'utente scorre con la rotellina o con il dito: da quel momento comanda lui
  ['wheel', 'touchmove'].forEach(function (n) { document.addEventListener(n, function () { snap = null; }, { capture: true, passive: true }); });

  var attesa = false;
  function ripristina() {
    attesa = false;
    if (!snap || Date.now() - snap.t > DURATA) return;
    if (voluto > snap.t) return;                            // l'app ha spostato la pagina di proposito
    var y = window.scrollY;
    if (snap.y - y > 30) {
      var max = document.documentElement.scrollHeight - window.innerHeight;
      if (max >= snap.y - 30) ws.call(window, snap.x, Math.min(snap.y, max));
    }
    snap.dentro.forEach(function (d) {
      var e = d.c.id ? document.getElementById(d.c.id) : document.querySelectorAll(d.c.sel)[d.c.i];
      if (!e) return;
      if (e.scrollTop < d.top - 30) e.scrollTop = d.top;
      if (e.scrollLeft < d.left - 30) e.scrollLeft = d.left;
    });
  }
  function pianifica() { if (!attesa && snap) { attesa = true; requestAnimationFrame(function () { requestAnimationFrame(ripristina); }); } }
  new MutationObserver(pianifica).observe(document.documentElement, { childList: true, subtree: true });
  window.addEventListener('scroll', function () { if (snap && Date.now() - snap.t < DURATA) pianifica(); }, { passive: true });
})();

/* To Smile · pulsante "Le mie app" in alto, uguale in tutte le app: riporta alla pagina con tutte le app.
   Si mette accanto al logo dell'app (barra in alto o barra laterale); se l'app ridisegna la barra, ricompare da solo.
   Una pagina può farne a meno con <body data-ts-home="no"> (es. la pagina "Le mie app" stessa). */
(function () {
  if (window.__tsHome) return; window.__tsHome = true;
  var qui = location.hostname === 'appgestione.it' || location.hostname === 'www.appgestione.it';
  if (qui && /^\/(accedi|registrati|password-dimenticata|reimposta|privacy|cookie|termini)?\/?$/.test(location.pathname)) return;
  var URL_HOME = qui ? '/' : 'https://appgestione.it/';
  var css = '.ts-home{display:inline-flex;align-items:center;gap:6px;flex:none;height:36px;padding:0 12px 0 9px;border-radius:999px;border:1px solid #D3E2E2;background:#fff;color:#2B8384;' +
    'font:700 13.5px/1 "Fira Sans",system-ui,-apple-system,"Segoe UI",sans-serif;text-decoration:none;white-space:nowrap;box-shadow:0 1px 2px rgba(20,48,48,.08);margin-right:10px;vertical-align:middle;letter-spacing:0}' +
    '.ts-home:hover{background:#EAF4F4;border-color:#4CAAAA}.ts-home:focus-visible{outline:2px solid #2B8384;outline-offset:2px}' +
    '.ts-home svg{width:19px;height:19px;stroke:currentColor;fill:none;stroke-width:2;stroke-linecap:round;stroke-linejoin:round;flex:none}' +
    '.ts-home.blocco{display:flex;margin:10px 14px 4px;justify-content:center;flex:none;box-sizing:border-box}' +
    '@media (max-width:900px){.ts-home.blocco{margin:6px 4px 6px 10px;width:36px;padding:0}.ts-home.blocco span{display:none}}' +
    '.ts-home.vola{position:fixed;left:max(12px,env(safe-area-inset-left));bottom:max(14px,env(safe-area-inset-bottom));z-index:900;margin:0;box-shadow:0 4px 14px rgba(20,48,48,.18)}' +
    '@media (max-width:700px){.ts-home:not(.blocco) span{display:none}.ts-home:not(.blocco){width:36px;padding:0;justify-content:center;margin-right:8px}}' +
    '@media (prefers-color-scheme:dark){.ts-home{background:#172121;border-color:#2A3939;color:#62C3C3}.ts-home:hover{background:#1D2929}}' +
    '@media print{.ts-home{display:none!important}}';
  function crea(cls) {
    var a = document.createElement('a');
    a.className = 'ts-home' + (cls ? ' ' + cls : ''); a.href = URL_HOME; a.setAttribute('data-ts-home', '');
    a.title = 'Torna a Le mie app'; a.setAttribute('aria-label', 'Home: torna a Le mie app');
    a.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 11l9-7 9 7"/><path d="M5 10v10h5v-6h4v6h5V10"/></svg><span>Le mie app</span>';
    return a;
  }
  function visibile(e) { if (!e) return false; var r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.top < 160; }
  function metti() {
    if (!document.body || document.body.getAttribute('data-ts-home') === 'no') return;
    var c = document.querySelector('a[data-ts-home]');
    if (c && !c.classList.contains('vola')) return;
    // il pulsante "di riserva" (in basso) lascia il posto a quello nella barra, appena la barra compare
    if (c) { if (!trovaPosto()) return; c.remove(); }
    if (!document.getElementById('ts-home-css')) { var st = document.createElement('style'); st.id = 'ts-home-css'; st.textContent = css; document.head.appendChild(st); }
    var posto = trovaPosto();
    if (posto) return posto();
    if (pronta) document.body.appendChild(crea('vola')); // nessuna barra (pagina già caricata): pulsante in basso a sinistra
  }
  // dove mettere il pulsante: restituisce una funzione che lo inserisce, oppure null
  function trovaPosto() {
    // barra laterale (Gestione finanziaria, Bilancio): sotto il logo (sul telefono, se la barra diventa una riga, prima delle voci)
    var side = document.querySelector('#sidebar, aside.sidebar');
    if (side && visibile(side) && side.querySelector('.brand')) { var b0 = side.querySelector('.brand'); return function () { b0.parentNode.insertBefore(crea('blocco'), b0.nextSibling); }; }
    // barra in alto: prima del logo / nome dell'app
    var bars = document.querySelectorAll('header, .top, .topbar, .navbar');
    for (var i = 0; i < bars.length; i++) {
      var bar = bars[i]; if (!visibile(bar)) continue;
      var brand = bar.querySelector('.brand, .navbar-brand, .hin, .top-in');
      if (brand && brand.matches('.hin, .top-in')) brand = brand.querySelector('.brand, a, img') || brand;
      if (brand && brand.closest('.brand, .navbar-brand') && brand.tagName !== 'DIV' && brand.tagName !== 'SPAN') brand = brand.closest('.brand, .navbar-brand');
      return (function (bar, brand) { return function () {
        // dentro il gruppo del logo (che è già una riga), come primo elemento; se il logo è un link o un'immagine, subito prima
        if (brand) { if (/^(A|IMG|SPAN|B)$/.test(brand.tagName)) brand.parentNode.insertBefore(crea(), brand); else brand.insertBefore(crea(), brand.firstChild); }
        else bar.insertBefore(crea(), bar.firstChild);
      }; })(bar, brand);
    }
    return null;
  }
  var pronta = false;
  window.addEventListener('load', function () { setTimeout(function () { pronta = true; presto(); }, 1500); });
  var t = null;
  function presto() { if (t) return; t = setTimeout(function () { t = null; try { metti(); } catch (e) {} }, 120); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', presto); else presto();
  window.addEventListener('load', presto);
  new MutationObserver(function () { var c = document.querySelector('a[data-ts-home]'); if (!c || c.classList.contains('vola')) presto(); }).observe(document.documentElement, { childList: true, subtree: true });
})();

/* Campi numerici (tutte le app): niente freccine su/giù dentro il campo; con le frecce della tastiera
   ci si muove come in un foglio di calcolo: ← → dentro il numero e, arrivati in fondo, al campo vicino;
   ↑ ↓ al campo sopra/sotto (stessa colonna della tabella, altrimenti il campo prima/dopo). */
(function () {
  if (window.__tsCampi) return; window.__tsCampi = true;
  var st = document.createElement('style');
  st.textContent = 'input[type=number]::-webkit-inner-spin-button,input[type=number]::-webkit-outer-spin-button{-webkit-appearance:none;appearance:none;margin:0}input[type=number]{-moz-appearance:textfield;appearance:textfield}';
  (document.head || document.documentElement).appendChild(st);
  var D = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  var PROP = ['width', 'height', 'box-sizing', 'padding-top', 'padding-right', 'padding-bottom', 'padding-left', 'font-family', 'font-size', 'font-weight', 'text-align', 'color', 'background-color',
    'border-top-width', 'border-right-width', 'border-bottom-width', 'border-left-width', 'border-top-style', 'border-right-style', 'border-bottom-style', 'border-left-style',
    'border-top-color', 'border-right-color', 'border-bottom-color', 'border-left-color', 'border-radius', 'min-height', 'letter-spacing', 'font-variant-numeric'];
  function eReact(el) { for (var k in el) if (k.indexOf('__react') === 0) return true; return false; }
  function numerico(el) {
    if (!el || el.tagName !== 'INPUT' || el.disabled || el.readOnly) return false;
    if (el.type === 'number' || el.getAttribute('data-ts-num') != null) return true;
    var im = el.getAttribute('inputmode'); return el.type === 'text' && (im === 'decimal' || im === 'numeric');
  }
  function norm(v) { v = String(v == null ? '' : v).trim().replace(/\s/g, ''); if (v.indexOf(',') >= 0) v = v.replace(/\./g, '').replace(',', '.'); return v; }
  // Mentre lo si scrive, il campo numerico diventa di testo (così il cursore si muove dentro il numero);
  // all'uscita torna numerico. Il valore letto dall'app resta sempre un numero valido (la virgola vale come punto).
  document.addEventListener('focusin', function (e) {
    var el = e.target;
    if (!el || el.tagName !== 'INPUT' || el.type !== 'number' || el.disabled || el.readOnly || eReact(el)) return;
    // l'aspetto resta identico anche se le regole di stile dell'app valgono solo per i campi numerici
    var cs = getComputedStyle(el), salva = {};
    PROP.forEach(function (k) { salva[k] = el.style.getPropertyValue(k); el.style.setProperty(k, cs.getPropertyValue(k)); });
    el.__tsStile = salva;
    el.setAttribute('data-ts-num', ''); el.type = 'text'; if (!el.getAttribute('inputmode')) { el.setAttribute('inputmode', 'decimal'); el.__tsIm = true; }
    Object.defineProperty(el, 'value', { configurable: true, get: function () { return norm(D.get.call(this)); }, set: function (v) { D.set.call(this, v); } });
    Object.defineProperty(el, 'valueAsNumber', { configurable: true, get: function () { var n = parseFloat(this.value); return isNaN(n) ? NaN : n; } });
    try { el.select(); } catch (x) {}
  }, true);
  document.addEventListener('focusout', function (e) {
    var el = e.target; if (!el || el.getAttribute == null || el.getAttribute('data-ts-num') == null) return;
    var v = norm(D.get.call(el));
    delete el.value; delete el.valueAsNumber;
    el.removeAttribute('data-ts-num'); if (el.__tsIm) { el.removeAttribute('inputmode'); el.__tsIm = false; }
    el.type = 'number'; D.set.call(el, isNaN(parseFloat(v)) ? '' : v);
    if (el.__tsStile) { var sv = el.__tsStile; PROP.forEach(function (k) { if (sv[k]) el.style.setProperty(k, sv[k]); else el.style.removeProperty(k); }); el.__tsStile = null; }
  }, true);
  function campi() { return Array.prototype.filter.call(document.querySelectorAll('input'), function (x) { return numerico(x) && x.offsetParent !== null; }); }
  function vai(el) { if (!el) return false; el.focus(); try { el.select(); } catch (x) {} return true; }
  function nellaRiga(cella, el, dir) {
    var row = cella.parentElement, celle = Array.prototype.slice.call(row.children), i = celle.indexOf(cella) + dir;
    // stessa cella con più campi: prima quelli
    var dentro = Array.prototype.filter.call(cella.querySelectorAll('input'), numerico), j = dentro.indexOf(el) + dir;
    if (j >= 0 && j < dentro.length) return dentro[j];
    for (; i >= 0 && i < celle.length; i += dir) { var c = Array.prototype.filter.call(celle[i].querySelectorAll('input'), numerico); if (c.length) return dir > 0 ? c[0] : c[c.length - 1]; }
    return null;
  }
  function inColonna(cella, dir) {
    var row = cella.parentElement, col = 0, celle = row.children;
    for (var k = 0; k < celle.length && celle[k] !== cella; k++) col += celle[k].colSpan || 1;
    var tab = cella.closest('table'), righe = Array.prototype.slice.call(tab.rows), r = righe.indexOf(row) + dir;
    for (; r >= 0 && r < righe.length; r += dir) {
      var pos = 0, cs = righe[r].cells;
      for (var m = 0; m < cs.length; m++) { if (pos <= col && col < pos + (cs[m].colSpan || 1)) { var c = Array.prototype.filter.call(cs[m].querySelectorAll('input'), numerico); if (c.length) return c[0]; break; } pos += cs[m].colSpan || 1; }
    }
    return null;
  }
  function vicino(el, dir) { var l = campi(), i = l.indexOf(el); return i < 0 ? null : l[i + dir] || null; }
  // il campo più vicino sopra/sotto sullo schermo (es. la tabella successiva)
  function sottoSopra(el, dir) {
    var r = el.getBoundingClientRect(), cx = r.left + r.width / 2, cy = r.top + r.height / 2, best = null, bd = 1e9;
    campi().forEach(function (x) {
      if (x === el) return; var q = x.getBoundingClientRect(), y = q.top + q.height / 2, dy = (y - cy) * dir;
      if (dy < r.height / 2) return;
      var dx = Math.abs(q.left + q.width / 2 - cx), d = dy * 3 + dx; if (d < bd) { bd = d; best = x; }
    });
    return best;
  }
  document.addEventListener('keydown', function (e) {
    var el = e.target, k = e.key;
    if (!numerico(el) || e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
    if (k !== 'ArrowUp' && k !== 'ArrowDown' && k !== 'ArrowLeft' && k !== 'ArrowRight') return;
    var cella = el.closest('td, th'), dir = (k === 'ArrowUp' || k === 'ArrowLeft') ? -1 : 1, dest = null;
    if (k === 'ArrowUp' || k === 'ArrowDown') {
      e.preventDefault(); // niente +1/-1 sul numero
      dest = (cella && cella.closest('table') && inColonna(cella, dir)) || sottoSopra(el, dir);
      return vai(dest);
    }
    var s = null, f = null; try { s = el.selectionStart; f = el.selectionEnd; } catch (x) {}
    var len = D.get.call(el).length;
    if (s != null) {
      if (s !== f) return;                          // numero selezionato: la freccia entra nel numero
      if (dir < 0 && s > 0) return; if (dir > 0 && s < len) return; // il cursore si muove dentro il numero
    }
    dest = (cella && nellaRiga(cella, el, dir)) || vicino(el, dir);
    if (dest) { e.preventDefault(); vai(dest); }
  }, true);
})();

/* Grafici (tutte le app con Chart.js): un clic su un punto o una barra apre un riquadro con i valori;
   un clic sul riquadro porta ai dati da cui nascono (se il grafico lo prevede). */
(function () {
  if (window.__tsGrafici) return; window.__tsGrafici = true;
  var pop = null, chiudiT = 0;
  var aperto = null; // il grafico col riquadro aperto: intanto il suo fumetto al passaggio è spento
  function chiudi() {
    if (pop) { pop.remove(); pop = null; }
    if (aperto) { try { if (aperto.canvas && aperto.canvas.isConnected) { aperto.options.plugins.tooltip.enabled = aperto.__tsTip !== false; aperto.update('none'); } } catch (x) {} aperto = null; }
  }
  function css() {
    if (document.getElementById('ts-chpop-css')) return;
    var st = document.createElement('style'); st.id = 'ts-chpop-css';
    st.textContent = '.ts-chpop{position:fixed;z-index:99999;min-width:170px;max-width:min(320px,calc(100vw - 24px));background:#241A29;color:#fff;border-radius:12px;padding:10px 12px;box-shadow:0 10px 30px rgba(0,0,0,.25);font:500 13.5px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif}'
      + '.ts-chpop b.t{display:block;font-weight:700;margin-bottom:4px}.ts-chpop .r{display:flex;gap:7px;align-items:center}.ts-chpop .q{width:10px;height:10px;border-radius:3px;flex:none}'
      + '.ts-chpop .vai{display:block;margin-top:8px;padding:7px 10px;border-radius:9px;background:#2F8F9E;color:#fff;font-weight:700;text-align:center}.ts-chpop.link{cursor:pointer}.ts-chpop.link:hover .vai{background:#3aa5b5}'
      + '.ts-chpop .x{position:absolute;top:4px;right:8px;color:#bbb;cursor:pointer;font-size:16px;line-height:1}';
    document.head.appendChild(st);
  }
  function testo(v) { return String(v).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function apri(chart, els, ev) {
    chiudi(); css();
    var tt = chart.tooltip, titolo = [], righe = [];
    try {
      tt.setActiveElements(els, { x: ev.x, y: ev.y });
      titolo = tt.title || []; (tt.body || []).forEach(function (b, i) { (b.lines || []).forEach(function (l) { righe.push({ t: l, c: (tt.labelColors && tt.labelColors[i] && (tt.labelColors[i].backgroundColor || tt.labelColors[i].borderColor)) || '#2F8F9E' }); }); });
      tt.setActiveElements([], { x: 0, y: 0 });
      chart.__tsTip = chart.options.plugins.tooltip.enabled; chart.options.plugins.tooltip.enabled = false; chart.update('none'); aperto = chart;
    } catch (x) {}
    if (!titolo.length && !righe.length) return;
    var vai = chart.options.onClick;
    pop = document.createElement('div'); pop.className = 'ts-chpop' + (vai ? ' link' : '');
    pop.innerHTML = '<span class="x" title="Chiudi">×</span>' + (titolo.length ? '<b class="t">' + titolo.map(testo).join('<br>') + '</b>' : '')
      + righe.map(function (r) { return '<div class="r"><span class="q" style="background:' + testo(r.c) + '"></span><span>' + testo(r.t) + '</span></div>'; }).join('')
      + (vai ? '<span class="vai">Vai ai dati →</span>' : '');
    document.body.appendChild(pop);
    var n = ev.native, cx = n && n.clientX != null ? n.clientX : (n && n.changedTouches && n.changedTouches[0] ? n.changedTouches[0].clientX : 0), cy = n && n.clientY != null ? n.clientY : (n && n.changedTouches && n.changedTouches[0] ? n.changedTouches[0].clientY : 0);
    var w = pop.offsetWidth, h = pop.offsetHeight, x = cx + 14, y = cy - h - 12;
    if (x + w > innerWidth - 8) x = cx - w - 14; if (x < 8) x = 8; if (y < 8) y = cy + 16; if (y + h > innerHeight - 8) y = innerHeight - h - 8;
    pop.style.left = x + 'px'; pop.style.top = y + 'px';
    pop.addEventListener('click', function (e) {
      e.stopPropagation();
      if (e.target.classList.contains('x')) return chiudi();
      chiudi(); if (vai) try { vai.call(chart, ev, els, chart); } catch (x) { console.warn(x); }
    });
    chiudiT = Date.now();
  }
  var plugin = {
    id: 'tsRiquadro',
    beforeEvent: function (chart, args) {
      var e = args.event; if (!e) return;
      if (pop && (e.type === 'mousemove' || e.type === 'mouseout')) return false; // col riquadro aperto niente fumetto al passaggio
      if (e.type !== 'click') return;
      var o = chart.options.interaction || {};
      var els = [];
      try { els = chart.getElementsAtEventForMode(e.native, o.mode || 'nearest', { intersect: o.intersect !== false, axis: o.axis }, false); } catch (x) {}
      if (!els.length) { chiudi(); return false; }
      apri(chart, els, e);
      return false; // il clic sul grafico apre il riquadro; è il clic sul riquadro che porta ai dati
    }
  };
  document.addEventListener('click', function (e) { if (pop && !pop.contains(e.target) && Date.now() - chiudiT > 300 && e.target.tagName !== 'CANVAS') chiudi(); }, true);
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') chiudi(); });
  window.addEventListener('scroll', function () { if (pop && Date.now() - chiudiT > 400) chiudi(); }, { passive: true });
  function registra() { if (window.Chart && window.Chart.register && !window.Chart.__tsRiq) { window.Chart.register(plugin); window.Chart.__tsRiq = true; return true; } return false; }
  if (!registra()) { var tent = 0, iv = setInterval(function () { if (registra() || ++tent > 40) clearInterval(iv); }, 250); document.addEventListener('DOMContentLoaded', registra); }
})();
