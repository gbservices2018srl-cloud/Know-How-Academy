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
    '.ts-home.blocco{display:flex;margin:0 0 12px;justify-content:center;width:100%;box-sizing:border-box}' +
    '.ts-home.vola{position:fixed;left:max(12px,env(safe-area-inset-left));top:max(10px,env(safe-area-inset-top));z-index:2147483000;margin:0}' +
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
    if (document.querySelector('a[data-ts-home]')) return;
    if (!document.getElementById('ts-home-css')) { var st = document.createElement('style'); st.id = 'ts-home-css'; st.textContent = css; document.head.appendChild(st); }
    // barra laterale (Gestione finanziaria, Bilancio): sotto il logo, a tutta larghezza
    var side = document.querySelector('#sidebar, aside.sidebar');
    if (side && visibile(side) && side.querySelector('.brand')) { var b0 = side.querySelector('.brand'); b0.parentNode.insertBefore(crea('blocco'), b0.nextSibling); return; }
    // barra in alto: prima del logo / nome dell'app
    var bars = document.querySelectorAll('header, .top, .topbar, .navbar');
    for (var i = 0; i < bars.length; i++) {
      var bar = bars[i]; if (!visibile(bar)) continue;
      var brand = bar.querySelector('.brand, .navbar-brand, .hin, .top-in');
      if (brand && brand.matches('.hin, .top-in')) brand = brand.querySelector('.brand, a, img') || brand;
      if (brand && brand.closest('.brand, .navbar-brand') && brand.tagName !== 'DIV' && brand.tagName !== 'SPAN') brand = brand.closest('.brand, .navbar-brand');
      if (brand) {
        // dentro il gruppo del logo (che è già una riga), come primo elemento; se il logo è un link o un'immagine, subito prima
        if (/^(A|IMG|SPAN|B)$/.test(brand.tagName)) brand.parentNode.insertBefore(crea(), brand);
        else brand.insertBefore(crea(), brand.firstChild);
      } else bar.insertBefore(crea(), bar.firstChild);
      return;
    }
    if (pronta) document.body.appendChild(crea('vola')); // nessuna barra (pagina già caricata): pulsante fisso in alto a sinistra
  }
  var pronta = false;
  window.addEventListener('load', function () { setTimeout(function () { pronta = true; presto(); }, 1500); });
  var t = null;
  function presto() { if (t) return; t = setTimeout(function () { t = null; try { metti(); } catch (e) {} }, 120); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', presto); else presto();
  window.addEventListener('load', presto);
  new MutationObserver(function () { if (!document.querySelector('a[data-ts-home]')) presto(); }).observe(document.documentElement, { childList: true, subtree: true });
})();
