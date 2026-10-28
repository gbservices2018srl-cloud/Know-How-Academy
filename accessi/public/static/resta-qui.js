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
