/* Scheda personale · amministrazione (menu laterale). Le persone vedono solo la loro parte. */
let ASEZ = 'timbra', AD = {};
const VOCI_ADMIN = [
  ['timbra', 'Timbratura'], ['presenze', 'Report presenze'], ['ore', 'Ore riconosciute'], ['richieste', 'Richieste e saldi'],
  ['persone', 'Persone e contratti'], ['turni', 'Turni di lavoro'], '-', ['branche', 'Branche medici'], ['info', 'Info utili'],
  ['perf', 'Performance'], ['doc', 'Documenti'], '-', ['tag', 'Sedi e tag NFC'], ['attiva', 'Attivazione'],
];
window.avvioAdmin = async function(st){
  const sez = new URLSearchParams(location.search).get('sez');
  const alias = { assenze: 'richieste', doc: 'doc', perf: 'perf', turni: 'turni', persone: 'persone', timbra: 'timbra', richieste: 'richieste', info: 'info', tag: 'tag' };
  if (alias[sez]) ASEZ = alias[sez];
  const side = document.createElement('aside'); side.className = 'sidemenu'; side.id = 'side';
  side.innerHTML = '<div class="sidemenu-h">Amministrazione</div>' + VOCI_ADMIN.map(v => v === '-' ? '<div class="sep"></div>' : `<button data-v="${v[0]}"><span>${v[1]}</span><span data-n="${v[0]}"></span></button>`).join('');
  side.onclick = e => { const b = e.target.closest('[data-v]'); if (b) { ASEZ = b.dataset.v; history.replaceState(null, '', '/?sez=' + ASEZ); disegnaAdmin(); } };
  $('#shell').prepend(side);
  disegnaAdmin();
  contatori();
};
async function contatori(){
  try {
    const [r, p] = await Promise.all([api('GET', '/api/sp/admin/richieste'), api('GET', '/api/sp/admin/perf')]);
    const n = { richieste: r.aperte.filter(x => x.stato === 'attesa_admin').length, perf: p.dati.length + p.passaggi.length };
    for (const [k, v] of Object.entries(n)) { const el = document.querySelector(`[data-n="${k}"]`); if (el) el.innerHTML = v ? `<span class="num">${v}</span>` : ''; }
  } catch {}
}
async function disegnaAdmin(){
  document.querySelectorAll('#side [data-v]').forEach(b => b.setAttribute('aria-selected', b.dataset.v === ASEZ));
  const m = $('#main'); m.className = ''; m.onclick = null; m.onchange = null; m.oninput = null;
  m.innerHTML = '<p class="muted">Carico…</p>';
  const f = { timbra: aTimbra, presenze: aPresenze, ore: aOre, richieste: aRichieste, persone: aPersone, turni: aTurni, branche: aBranche, info: aInfo, perf: aPerf, doc: aDoc, tag: aTag, attiva: aAttiva }[ASEZ];
  try { await f(m); } catch (e) { m.innerHTML = `<div class="card">${esc(e.message)}</div>`; }
}
const ridisegna = () => { disegnaAdmin(); contatori(); };
async function sediEFigure(){
  if (!AD.persone) AD.persone = await api('GET', '/api/sp/admin/persone');
  const figure = [...new Set(AD.persone.persone.map(p => p.figura).filter(Boolean))].sort();
  return { sedi: AD.persone.sedi, figure };
}
function filtriHtml(sf, f){
  return `<div class="row" style="margin-bottom:12px"><label class="f">Sede<select id="fSede"><option value="">Tutte le sedi</option>${sf.sedi.map(s => `<option value="${s.id}" ${f.sede === s.id ? 'selected' : ''}>${esc(s.nome)}</option>`).join('')}</select></label>
    <label class="f">Ruolo<select id="fFig"><option value="">Tutti i ruoli</option>${sf.figure.map(x => `<option ${f.figura === x ? 'selected' : ''}>${esc(x)}</option>`).join('')}</select></label></div>`;
}
const FILTRI = { sede: '', figura: '' };

/* ---------- timbratura dell'amministratore + chi è in servizio ---------- */
async function aTimbra(m){
  await caricaMe();
  const d = await api('GET', '/api/sp/admin/inservizio');
  m.innerHTML = `<h1>Timbratura</h1><p class="sub">Anche l'amministratore timbra appoggiando il telefono al tag, come tutti.</p>
    <div class="grid2" style="grid-template-columns:repeat(auto-fit,minmax(300px,1fr))"><div id="mia"></div>
    <div class="card"><h3>In servizio adesso</h3>${d.dentro.length ? `<div class="lista">${d.dentro.map(r => `<div class="li"><span class="grow">${esc(r.nome)}${r.sede ? ' · ' + esc(r.sede) : ''}</span><b>dalle ${r.ora}</b></div>`).join('')}</div>` : '<p class="muted small" style="margin:0">Nessuno ha timbrato l\'ingresso.</p>'}</div></div>`;
  window.dopoTimbra = () => disegnaAdmin();
  await vistaTimbra($('#mia'));
}

/* ---------- report 1: presenze ---------- */
let PRES = { dal: null, al: null };
async function aPresenze(m){
  const sf = await sediEFigure();
  PRES.al = PRES.al || oggiG(); PRES.dal = PRES.dal || addG(PRES.al, -6);
  const qs = new URLSearchParams({ dal: PRES.dal, al: PRES.al, sede: FILTRI.sede, figura: FILTRI.figura });
  const r = await api('GET', '/api/sp/admin/presenze?' + qs);
  m.innerHTML = `<div class="row"><h1 class="grow">Report presenze</h1><a class="btn" href="/api/sp/admin/presenze?${qs}&csv=1">Esporta (Excel)</a></div>
    <p class="sub">Gli orari veri di timbratura, così come sono stati registrati. Comprende dipendenti e partite IVA. Tocca una riga per correggere.</p>
    <div class="row" style="align-items:flex-end">${filtriHtml(sf, FILTRI)}<div class="row" style="margin-bottom:12px"><label class="f">Dal<input type="date" id="pDal" value="${PRES.dal}"></label><label class="f">Al<input type="date" id="pAl" value="${PRES.al}"></label></div></div>
    <div class="tw"><table class="t"><thead><tr><th>Data</th><th>Persona</th><th>Ruolo</th><th>Sede</th><th>Turno</th><th>Timbrature</th><th>Ore</th><th>Nota</th></tr></thead><tbody>
    ${r.righe.map((x, i) => `<tr class="click" data-i="${i}"><td style="white-space:nowrap">${fmtG(x.giorno)}</td><td><b>${esc(x.nome)}</b></td><td>${esc(x.figura)}</td><td>${esc(x.sede)}</td><td>${esc(x.turno)}</td>
      <td style="white-space:nowrap">${x.timbrature.map(t => `${t.tipo === 'in' ? '↘' : '↗'} ${t.ora}${t.modo === 'smart' ? ' ⌂' : t.modo !== 'nfc' ? '*' : ''}`).join('  ')}</td><td>${x.ore ? hm(x.ore) : ''}</td><td><span class="tag ${x.k}">${esc(x.nota)}</span></td></tr>`).join('') || '<tr><td colspan="8" class="muted">Nessun dato nel periodo.</td></tr>'}
    </tbody></table></div><p class="muted xs">↘ ingresso · ↗ uscita · ⌂ smart working (tocca la riga per vedere la posizione) · * senza NFC o corretta a mano.</p>`;
  m.onchange = e => {
    if (e.target.id === 'fSede') FILTRI.sede = e.target.value; if (e.target.id === 'fFig') FILTRI.figura = e.target.value;
    if (e.target.id === 'pDal') PRES.dal = e.target.value; if (e.target.id === 'pAl') PRES.al = e.target.value;
    aPresenze(m);
  };
  m.onclick = e => { const tr = e.target.closest('tr[data-i]'); if (tr) correggi(r.righe[+tr.dataset.i], () => aPresenze(m)); };
}
function correggi(x, dopo){
  const sedi = AD.persone.sedi;
  const d = finestra(`<h2>${esc(x.nome)}</h2><p class="muted small">${fmtG(x.giorno)}${x.turno ? ' · turno ' + esc(x.turno) : ''}</p>
    ${x.mancata ? `<div class="banner warn row"><span class="grow">Segnata come mancata timbratura (${x.mancata === 'ingiustificata' ? 'assenza ingiustificata' : x.mancata + ' scalati'}).</span><button class="btn small" id="annM">Annulla e restituisci</button></div>` : ''}
    <div class="lista">${x.timbrature.map(t => `<div class="li"><span class="grow">${t.tipo === 'in' ? 'Ingresso' : 'Uscita'} <b>${t.ora}</b> ${t.modo === 'smart' ? `<span class="tag">smart working</span>${t.lat != null ? ` <a class="btn small" target="_blank" rel="noopener" href="https://www.openstreetmap.org/?mlat=${t.lat}&mlon=${t.lon}#map=16/${t.lat}/${t.lon}">Posizione (±${Math.max(100, t.prec || 0)} m)</a>` : ''}` : t.modo !== 'nfc' ? `<span class="tag">${t.modo === 'app' ? 'senza NFC' : 'a mano'}</span>` : ''}${t.nota ? `<span class="s">${esc(t.nota)}</span>` : ''}</span><button class="btn small danger" data-ann="${t.id}">Annulla</button></div>`).join('') || '<p class="muted small">Nessuna timbratura.</p>'}</div>
    <h3 style="margin-top:16px">Aggiungi una timbratura</h3>
    <div class="grid2"><label class="f">Tipo<select id="cTipo"><option value="in">Ingresso</option><option value="out">Uscita</option></select></label><label class="f">Ora<input type="time" id="cOra" value="09:30"></label>
    <label class="f">Sede<select id="cSede">${sedi.map(s => `<option value="${s.id}">${esc(s.nome)}</option>`).join('')}</select></label><label class="f">Motivo<input type="text" id="cNota" placeholder="es. dimenticata"></label></div>
    <div class="acts"><button class="btn" id="chiudi">Chiudi</button><button class="btn primary" id="agg">Aggiungi</button></div>`);
  d.querySelector('#chiudi').onclick = chiudi;
  d.querySelector('#agg').onclick = async () => { try { await api('POST', '/api/sp/admin/timbrature', {user: x.user, giorno: x.giorno, tipo: $('#cTipo').value, ora: $('#cOra').value, sede: $('#cSede').value, nota: $('#cNota').value}); chiudi(); toast('Timbratura aggiunta.'); dopo(); } catch (e) { toast(e.message); } };
  d.onclick = async e => {
    const a = e.target.closest('[data-ann]');
    if (a && confirm('Annullare questa timbratura? Resta nello storico come annullata.')) { await api('DELETE', `/api/sp/admin/timbrature/${a.dataset.ann}`); chiudi(); toast('Annullata.'); dopo(); }
    if (e.target.id === 'annM') { try { await api('POST', '/api/sp/admin/mancate/annulla', {user: x.user, giorno: x.giorno}); chiudi(); toast('Annullata: quanto scalato è stato restituito.'); dopo(); } catch (er) { toast(er.message); } }
  };
}

/* ---------- report 2: ore riconosciute ---------- */
let MESE_A = null;
async function aOre(m){
  const sf = await sediEFigure();
  MESE_A = MESE_A || oggiG().slice(0, 7);
  const qs = new URLSearchParams({ mese: MESE_A, sede: FILTRI.sede, figura: FILTRI.figura });
  const r = await api('GET', '/api/sp/admin/ore?' + qs);
  m.innerHTML = `<div class="row"><h1 class="grow">Ore riconosciute</h1><a class="btn primary" href="/api/sp/admin/ore?${qs}&csv=1">Esporta per la consulente</a></div>
    <p class="sub">Solo dipendenti. Ogni giorno conta al massimo il turno: entrata prima dell'inizio = inizio turno, uscita dopo la fine = fine turno. Il totale del mese non supera mai il tetto del contratto.</p>
    <div class="row" style="align-items:flex-end">${filtriHtml(sf, FILTRI)}<div class="row" style="margin-bottom:12px"><button class="btn small" id="oPrev">‹</button><b style="min-width:130px;text-align:center">${meseLbl(MESE_A)}</b><button class="btn small" id="oNext">›</button></div></div>
    <div class="tw"><table class="t dense"><thead><tr><th class="stk">Persona</th>${r.giorni.map(g => `<th>${g.w}<br>${g.n}</th>`).join('')}<th>Totale</th><th>Tetto</th><th>F</th><th>P</th><th>M</th><th>AI</th><th>SW</th><th>L</th><th>CP</th><th>MAT</th><th>PNR</th></tr></thead><tbody>
    ${r.righe.map(p => `<tr><td class="stk"><b>${esc(p.nome)}</b><br><span class="muted xs">${esc(p.figura)} · ${p.ore != null ? nume(p.ore) + ' h/sett.' : '<span style="color:var(--bad)">ore mancanti</span>'}</span></td>
      ${p.celle.map((c, i) => `<td class="${r.giorni[i].fest ? 'we' : ''} ${c.cod ? 'c-' + c.cod.replace('*', '') : ''} ${c.corto ? 'corto' : ''}" title="${c.fuori ? 'Timbrato fuori turno' : c.attesa ? 'Documento ancora da presentare' : ''}">${c.min ? hm(c.min) : ''}${c.cod ? (c.min ? '<br>' : '') + c.cod : ''}${c.fuori && !c.min ? '·' : ''}</td>`).join('')}
      <td><b>${hm(p.totale)}</b>${p.oltre ? ' ⤓' : ''}</td><td class="muted">${p.tetto ? hm(p.tetto) : '—'}</td><td>${p.conta.F || ''}</td><td>${p.conta.P || ''}</td><td>${p.conta.M || ''}</td><td>${p.conta.AI || ''}</td><td>${p.conta.SW || ''}</td><td>${p.conta.L || ''}</td><td>${p.conta.CP || ''}</td><td>${p.conta.MAT || ''}</td><td>${p.conta.PNR || ''}</td></tr>`).join('') || `<tr><td class="stk muted" colspan="${r.giorni.length + 12}">Nessun dipendente con questi filtri. Controlla in Persone e contratti chi è dipendente.</td></tr>`}
    </tbody></table></div>
    <p class="muted xs">F ferie · P permesso · M malattia · AI assenza ingiustificata · SW smart working (senza turno contano le ore timbrate) · L lutto (con il certificato conta come il turno) · CP congedo parentale (a ore) · MAT maternità · PNR permesso non retribuito · * scalato in automatico per mancata timbratura · in arancio i giorni con meno ore del turno · ⤓ tagliato al tetto del contratto.</p>`;
  m.onchange = e => { if (e.target.id === 'fSede') FILTRI.sede = e.target.value; if (e.target.id === 'fFig') FILTRI.figura = e.target.value; aOre(m); };
  $('#oPrev').onclick = () => { MESE_A = meseAdd(MESE_A, -1); aOre(m); };
  $('#oNext').onclick = () => { MESE_A = meseAdd(MESE_A, 1); aOre(m); };
}

/* ---------- richieste e saldi ---------- */
async function aRichieste(m){
  const r = await api('GET', '/api/sp/admin/richieste');
  const rich = x => `<div class="li"><span class="grow"><span class="t">${esc(x.nome)} · ${esc(x.desc)}</span><span class="s">${x.quanti != null ? (['ferie', 'lutto', 'maternita'].includes(x.tipo) || (x.tipo === 'pnr' && !x.oraDa) ? nume(x.quanti) + ' giorni' : nume(x.quanti) + ' ore') + ' · ' : ''}${x.sostNome ? `sostituto ${esc(x.sostNome)} · ${x.sostOk ? 'ha accettato' : x.sostOk === false ? 'ha rifiutato' : 'in attesa'}` : 'senza sostituto'}${x.nota ? ' · ' + esc(x.nota) : ''}</span></span>`;
  m.innerHTML = `<div class="row"><h1 class="grow">Richieste e saldi</h1><button class="btn" id="regAss">+ Registra un'assenza</button></div>
    <p class="sub">Approvando, ferie e ROL si scalano dal saldo e i turni passano al sostituto. Ogni richiesta approvata si può revocare: il saldo e i turni tornano com'erano.</p>
    <div class="card"><h2>Da approvare</h2>${r.aperte.length ? `<div class="lista">${r.aperte.map(x => rich(x) + (x.stato === 'attesa_admin' ? `<button class="btn small primary" data-ok="${x.id}">Approva</button><button class="btn small" data-no="${x.id}">Rifiuta</button>` : '<span class="tag warn">Aspetta il sostituto</span><button class="btn small" data-no="' + x.id + '">Rifiuta</button>') + '</div>').join('')}</div>` : '<p class="muted small" style="margin:0">Nessuna richiesta in attesa.</p>'}</div>
    ${r.certificati.length ? `<div class="card"><h2>Certificati da controllare</h2><p class="muted small" style="margin-top:-4px">Aprilo e leggilo. Se lo approvi, la persona lo ritrova in Documenti → I miei documenti. Se non va bene, deve ricaricarlo.</p>
      <div class="lista">${r.certificati.map(x => `<div class="li"><span class="grow"><span class="t">${esc(x.nome)} · ${esc(x.desc)}</span><span class="s">${esc(x.docNome || 'certificato')}</span></span><a class="btn small" href="/api/sp/richieste/${x.id}/certificato" target="_blank" rel="noopener">Apri</a><button class="btn small" data-certno="${x.id}">Non valido</button><button class="btn small primary" data-certok="${x.id}">Approva</button></div>`).join('')}</div></div>` : ''}
    ${r.daCompletare.length ? `<div class="card"><h2>Lutto e malattia da completare</h2><p class="muted small" style="margin-top:-4px">Già approvati. Se il certificato di morte o il protocollo non arriva entro la scadenza, i giorni si scalano dalle ferie, oppure diventano assenza ingiustificata.</p>
      <div class="lista">${r.daCompletare.map(x => `<div class="li"><span class="grow"><span class="t">${esc(x.nome)} · ${esc(x.desc)}</span><span class="s">${x.tipo === 'lutto' ? 'certificato di morte' : x.tipo === 'maternita' ? 'certificato di maternità' : 'numero di protocollo'}${x.scadenza ? ' entro ' + (x.scadenza === oggiG() ? 'le 23:59 di oggi' : 'il ' + fmtG(x.scadenza)) : ' da caricare'}</span></span><span class="tag warn">In attesa</span><button class="btn small" data-rev="${x.id}">Revoca</button></div>`).join('')}</div></div>` : ''}
    <div class="card"><h2>Saldi dei dipendenti</h2><p class="muted small" style="margin-top:-4px">Il saldo arriva dalla busta paga pubblicata; qui puoi impostarlo o correggerlo a mano.</p>
      <div class="tw"><table class="t"><thead><tr><th>Persona</th><th>Ruolo</th><th>Ferie</th><th>Permessi</th><th></th></tr></thead><tbody>
      ${r.saldi.map(s => `<tr><td><b>${esc(s.nome)}</b></td><td>${esc(s.figura)}</td><td>${s.base.ferie ? nume(s.ferie) + ' gg' : '<span class="muted">—</span>'}</td><td>${s.base.permessi ? nume(s.permessi) + ' h' : '<span class="muted">—</span>'}</td><td><button class="btn small" data-mov="${s.id}">Movimenti</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nessun dipendente indicato in Persone e contratti.</td></tr>'}
      </tbody></table></div></div>
    <div class="card"><h2>Mancate timbrature</h2><p class="muted small" style="margin-top:-4px">Giorno di turno senza timbrature e senza assenza approvata (lo smart working non copre: si timbra da casa): prima si scalano le ferie, poi i permessi, altrimenti è assenza ingiustificata.</p>
      ${r.mancate.length ? `<div class="lista">${r.mancate.map(x => `<div class="li"><span class="grow"><span class="t">${esc(x.nome)} · ${fmtG(x.giorno)}</span><span class="s">${x.motivo ? esc(x.motivo) + ' · ' : ''}${x.esito === 'ferie' ? '1 giorno di ferie scalato' : x.esito === 'permessi' ? nume(x.valore) + ' ore di permesso scalate' : 'assenza ingiustificata'}</span></span>${x.annullata ? '<span class="tag">Annullata</span>' : `<button class="btn small" data-annm="${x.user}|${x.giorno}">Annulla</button>`}</div>`).join('')}</div>` : '<p class="muted small" style="margin:0">Nessuna negli ultimi 45 giorni.</p>'}</div>
    <div class="card"><h2>Decise di recente</h2>${r.recenti.length ? `<div class="lista">${r.recenti.map(x => rich(x) + (x.haDoc ? `${x.docApprovato ? '<span class="tag ok">Certificato approvato</span>' : '<span class="tag warn">Certificato da controllare</span>'}<a class="btn small" href="/api/sp/richieste/${x.id}/certificato" target="_blank" rel="noopener">Certificato</a>` : x.tipo === 'malattia' && x.prot ? `<span class="tag">prot. ${esc(x.prot)}</span>` : x.docStato === 'scaduta' ? '<span class="tag no">Non arrivato: scalato</span>' : '') + `<span class="tag ${x.stato === 'approvata' ? 'ok' : 'no'}">${x.stato === 'approvata' ? 'Approvata' : x.stato === 'revocata' ? 'Revocata' : 'Rifiutata'}</span>${x.stato === 'approvata' ? `<button class="btn small" data-rev="${x.id}">Revoca</button>` : ''}</div>`).join('')}</div>` : '<p class="muted small" style="margin:0">Niente.</p>'}</div>`;
  m.onclick = async e => {
    const ok = e.target.closest('[data-ok]'), no = e.target.closest('[data-no]'), mv = e.target.closest('[data-mov]'), am = e.target.closest('[data-annm]');
    try {
      if (ok || no) { const nota = no ? (prompt('Motivo del rifiuto (facoltativo)') ?? null) : ''; if (nota === null) return; await api('POST', `/api/sp/admin/richieste/${(ok || no).dataset[ok ? 'ok' : 'no']}`, {ok: !!ok, nota}); toast(ok ? 'Approvata.' : 'Rifiutata.'); return ridisegna(); }
      const co = e.target.closest('[data-certok]'), cn = e.target.closest('[data-certno]');
      if (co) { await api('POST', `/api/sp/admin/richieste/${co.dataset.certok}/certificato`, {ok: true}); toast('Approvato: la persona lo trova in I miei documenti.'); return aRichieste(m); }
      if (cn) { const nota = prompt('Cosa non va nel certificato? (lo legge la persona)') ?? null; if (nota === null) return; await api('POST', `/api/sp/admin/richieste/${cn.dataset.certno}/certificato`, {ok: false, nota}); toast('La persona deve ricaricarlo.'); return aRichieste(m); }
      const rv = e.target.closest('[data-rev]');
      if (rv) { const x = [...r.recenti, ...r.daCompletare].find(y => y.id === rv.dataset.rev); return revoca(x, () => aRichieste(m)); }
      if (mv) return movimenti(r.saldi.find(s => s.id === mv.dataset.mov), () => aRichieste(m));
      if (am) { if (!confirm('Annullare? Quanto scalato viene restituito.')) return; const [user, giorno] = am.dataset.annm.split('|'); await api('POST', '/api/sp/admin/mancate/annulla', {user, giorno}); toast('Annullata.'); return aRichieste(m); }
      if (e.target.id === 'regAss') return registraAssenza(r.persone, () => aRichieste(m));
    } catch (er) { toast(er.message); }
  };
}
async function movimenti(s, dopo){
  const r = await api('GET', `/api/sp/admin/movimenti/${s.id}`);
  const d = finestra(`<h2>${esc(s.nome)}</h2><p class="muted small">Ferie ${nume(s.ferie)} gg · permessi ${nume(s.permessi)} h</p>
    <div class="lista" style="max-height:260px;overflow:auto">${r.movimenti.map(x => `<div class="li"><span class="grow"><span class="t" style="font-weight:600;${x.annullato ? 'text-decoration:line-through' : ''}">${esc(x.causale)}</span><span class="s">${fmtG(x.data)}${x.da ? ' · ' + esc(x.da) : ''}</span></span><b>${x.tipo === 'saldo' ? '= ' : x.valore > 0 ? '+' : ''}${nume(x.valore)} ${x.voce === 'ferie' ? 'gg' : 'h'}</b></div>`).join('') || '<p class="muted small">Nessun movimento.</p>'}</div>
    <h3 style="margin-top:14px">Nuovo movimento</h3>
    <div class="grid2"><label class="f">Voce<select id="mVoce"><option value="ferie">Ferie (giorni)</option><option value="permessi">Permessi (ore)</option></select></label>
      <label class="f">Tipo<select id="mTipo"><option value="delta">Aggiungi o togli</option><option value="saldo">Imposta il saldo</option></select></label>
      <label class="f">Valore<input type="text" inputmode="decimal" id="mVal" placeholder="es. -1 oppure 12,5"></label><label class="f">Data<input type="date" id="mData" value="${oggiG()}"></label></div>
    <label class="f" style="margin-top:10px">Causale<input type="text" id="mCaus" placeholder="es. correzione"></label>
    <div class="acts"><button class="btn" id="chiudi">Chiudi</button><button class="btn primary" id="salva">Salva</button></div>`);
  d.querySelector('#chiudi').onclick = chiudi;
  d.querySelector('#salva').onclick = async () => { try { await api('POST', '/api/sp/admin/movimenti', {user: s.id, voce: $('#mVoce').value, tipo: $('#mTipo').value, valore: $('#mVal').value, data: $('#mData').value, causale: $('#mCaus').value}); chiudi(); toast('Salvato.'); dopo(); } catch (e) { toast(e.message); } };
}
// revoca con conferma nella pagina: ferie/ROL restituiti, turni tornati alla persona
function revoca(x, dopo){
  const d = finestra(`<h2>Revocare la richiesta?</h2><p><b>${esc(x.nome)}</b> · ${esc(x.desc)}</p>
    <ul class="small" style="margin:0 0 10px;padding-left:18px">${['ferie', 'permesso'].includes(x.tipo) ? `<li>${x.tipo === 'ferie' ? 'I giorni di ferie' : 'Le ore di ROL'} tornano nel saldo.</li>` : ''}${x.sostNome ? `<li>I turni passati a ${esc(x.sostNome)} tornano a ${esc(x.nome)}.</li>` : ''}<li>${esc(x.nome)}${x.sostNome ? ' e ' + esc(x.sostNome) + ' ricevono' : ' riceve'} un avviso.</li><li>Se in quei giorni non timbra, valgono le regole delle mancate timbrature.</li></ul>
    <label class="f">Motivo (facoltativo, lo legge la persona)<input type="text" id="rvN" maxlength="300"></label>
    <div class="acts"><button class="btn" id="chiudi">Annulla</button><button class="btn danger" id="rvOk">Revoca</button></div>`);
  d.querySelector('#chiudi').onclick = chiudi;
  d.querySelector('#rvOk').onclick = async e => { e.target.disabled = true; try { await api('POST', `/api/sp/admin/richieste/${x.id}/revoca`, {nota: $('#rvN').value}); chiudi(); toast('Revocata.'); dopo(); } catch (er) { e.target.disabled = false; toast(er.message); } };
}
function registraAssenza(persone, dopo){
  const d = finestra(`<h2>Registra un'assenza</h2><p class="muted small">Viene registrata già approvata e la persona riceve un avviso.</p>
    <div class="grid2"><label class="f">Persona<select id="rU">${persone.map(p => `<option value="${p.id}">${esc(p.nome)}</option>`).join('')}</select></label>
      <label class="f">Tipo<select id="rT"><option value="ferie">Ferie</option><option value="permesso">Permesso (ore)</option><option value="malattia">Malattia</option><option value="lutto">Lutto (3 giorni lavorativi)</option><option value="smart">Smart working</option><option value="parentale">Congedo parentale (ore)</option><option value="maternita">Maternità</option><option value="pnr">Permesso non retribuito</option><option value="altro">Altra assenza</option></select></label>
      <label class="f">Dal<input type="date" id="rDal" value="${oggiG()}"></label><label class="f">Al<input type="date" id="rAl" value="${oggiG()}"></label>
      <label class="f">Dalle (solo per le ore)<input type="time" id="rDa"></label><label class="f">Alle (solo per le ore)<input type="time" id="rA"></label>
      <label class="f">Sostituto<select id="rS"><option value="">Nessuno</option>${persone.map(p => `<option value="${p.id}">${esc(p.nome)}</option>`).join('')}</select></label><label class="f">Nota<input type="text" id="rN"></label></div>
    <div class="acts"><button class="btn" id="chiudi">Annulla</button><button class="btn primary" id="salva">Registra</button></div>`);
  d.querySelector('#chiudi').onclick = chiudi;
  d.querySelector('#rT').onchange = e => { const ore = e.target.value === 'permesso'; $('#rDa').value = ore ? '16:00' : ''; $('#rA').value = ore ? '18:30' : ''; };
  d.querySelector('#salva').onclick = async () => { try { await api('POST', '/api/sp/richieste', {user: $('#rU').value, tipo: $('#rT').value, dal: $('#rDal').value, al: $('#rAl').value, oraDa: $('#rDa').value, oraA: $('#rA').value, sost: $('#rS').value, nota: $('#rN').value}); chiudi(); toast('Registrata.'); dopo(); } catch (e) { toast(e.message); } };
}

/* ---------- persone e contratti ---------- */
async function aPersone(m){
  AD.persone = await api('GET', '/api/sp/admin/persone');
  const { persone, sedi } = AD.persone, sn = new Map(sedi.map(s => [s.id, s.nome]));
  m.innerHTML = `<h1>Persone e contratti</h1><p class="sub">Ognuno indica al primo accesso se è dipendente o partita IVA e le ore del contratto: qui le confermi o le correggi. Di regola si timbra solo con il tag NFC: autorizza qui chi ha un telefono senza NFC. Le persone arrivano dal pannello accessi.</p>
    <div class="tw"><table class="t"><thead><tr><th>Persona</th><th>Ruolo</th><th>Sedi</th><th>Tipo</th><th>Ore / sett.</th><th>Timbra senza NFC</th><th>Cod. fiscale</th><th></th></tr></thead><tbody>
    ${persone.map(p => `<tr data-id="${p.id}"><td><b>${esc(p.nome)}</b>${p.admin ? ' <span class="tag info">admin</span>' : ''}</td><td>${esc(p.figura)}</td>
      <td>${p.medico ? `<span class="small">${esc(p.sedi.map(s => sn.get(s)).filter(Boolean).join(', ') || '—')}</span><br><span class="muted xs">da Branche medici</span>` : `<button class="btn small" data-sedi="${p.id}">${esc(p.sedi.map(s => sn.get(s)).filter(Boolean).join(', ') || 'Scegli')}</button>`}</td>
      <td><select data-tipo="${p.id}"><option value="">—</option><option value="dip" ${p.tipo === 'dip' ? 'selected' : ''}>Dipendente</option><option value="piva" ${p.tipo === 'piva' ? 'selected' : ''}>Partita IVA</option></select></td>
      <td>${p.tipo === 'dip' ? `<input type="text" inputmode="decimal" data-ore="${p.id}" value="${p.ore ?? ''}" style="width:72px">` : '<span class="muted">—</span>'}</td>
      <td>${p.medico ? '<span class="muted xs">non timbra</span>' : `<button class="btn small ${p.senzaNfc ? 'ok' : ''}" data-nfc="${p.id}">${p.senzaNfc ? 'Autorizzato · togli' : 'Solo NFC · autorizza'}</button>`}</td>
      <td>${p.haCf ? `<span class="small">${esc(p.cf)}</span>` : '<span class="tag warn">manca</span>'}</td>
      <td>${p.tipoOk ? '<span class="tag ok">Confermato</span>' : p.onb ? `<button class="btn small primary" data-conf="${p.id}">Conferma</button>` : '<span class="tag">Non ancora entrato</span>'}</td></tr>`).join('')}
    </tbody></table></div>
    <p class="muted xs">Il codice fiscale (dal pannello accessi) serve per dividere buste paga e CU. I medici sono sempre a partita IVA e non timbrano.</p>`;
  const salva = async (id, b) => { try { await api('PUT', `/api/sp/admin/persone/${id}`, b); AD.persone = null; aPersone(m); } catch (e) { toast(e.message); } };
  m.onchange = e => {
    const t = e.target.closest('[data-tipo]'), o = e.target.closest('[data-ore]');
    if (t) salva(t.dataset.tipo, {tipo: t.value});
    if (o) salva(o.dataset.ore, {ore: o.value || null});
  };
  m.onclick = e => {
    const n = e.target.closest('[data-nfc]'), c = e.target.closest('[data-conf]'), s = e.target.closest('[data-sedi]');
    if (n) { const p = persone.find(x => x.id === n.dataset.nfc); salva(p.id, {senzaNfc: !p.senzaNfc}); }
    if (c) salva(c.dataset.conf, {conferma: true});
    if (s) {
      const p = persone.find(x => x.id === s.dataset.sedi);
      const d = finestra(`<h2>Sedi di ${esc(p.nome)}</h2><div class="lista">${sedi.map(x => `<label class="li"><input type="checkbox" class="cb" value="${x.id}" ${p.sedi.includes(x.id) ? 'checked' : ''}> ${esc(x.nome)}</label>`).join('')}</div>
        <div class="acts"><button class="btn" id="chiudi">Annulla</button><button class="btn primary" id="ok">Salva</button></div>`);
      d.querySelector('#chiudi').onclick = chiudi;
      d.querySelector('#ok').onclick = () => { const v = [...d.querySelectorAll('input:checked')].map(i => i.value); chiudi(); salva(p.id, {sedi: v}); };
    }
  };
}

/* ---------- turni di lavoro: calendario del mese a riquadri ---------- */
let TM = { mese: null, sede: '', pennello: null };
async function aTurni(m){
  TM.mese = TM.mese || oggiG().slice(0, 7);
  const r = await api('GET', `/api/sp/turni?mese=${TM.mese}&tutti=1`);
  const sedi = (AD.persone || await api('GET', '/api/sp/admin/persone')).sedi;
  if (!AD.persone) AD.persone = await api('GET', '/api/sp/admin/persone');
  if (!TM.sede && sedi[0]) TM.sede = sedi[0].id;
  const sn = new Map(sedi.map(s => [s.id, s.nome]));
  const g = giorniMese(TM.mese), oggi = oggiG();
  const pp = r.persone.filter(p => !TM.sede || p.sedi.includes(TM.sede) || r.turni.some(t => t.user === p.id && t.sede === TM.sede));
  const lun = g.filter(x => dowG(x) === 1);
  const cella = (p, x) => {
    const ts = r.turni.filter(t => t.user === p.id && t.giorno === x), as = r.assenze.find(a => a.user === p.id && a.dal <= x && a.al >= x);
    return `<td class="c ${[0, 6].includes(dowG(x)) ? 'we' : ''}" data-u="${p.id}" data-g="${x}">${ts.map(t => `<span class="s" title="${esc(sn.get(t.sede) || '')}${t.nota ? ' · ' + esc(t.nota) : ''}">${t.da.replace(/^0/, '')}–${t.a.replace(/^0/, '')}${t.sede && t.sede !== TM.sede ? '<br><span class="xs">' + esc((sn.get(t.sede) || '').slice(0, 10)) + '</span>' : ''}</span>`).join('')}${as ? `<span class="a">${as.tipo === 'permesso' ? 'perm.' : as.tipo.slice(0, 5)}</span>` : ''}</td>`;
  };
  m.innerHTML = `<div class="row"><h1 class="grow">Turni di lavoro</h1><button class="btn" id="preset">Turni tipo</button><button class="btn" id="copia">Copia una settimana</button><button class="btn primary" id="avvisa">Avvisa le persone</button></div>
    <p class="sub">Scegli un turno tipo e tocca i riquadri per riempirli; senza turno scelto, il riquadro si apre per scrivere l'orario. Le persone vedono i loro turni nel calendario.</p>
    <div class="row" style="margin-bottom:12px"><button class="btn small" id="tPrev">‹</button><b style="min-width:130px;text-align:center">${meseLbl(TM.mese)}</b><button class="btn small" id="tNext">›</button>
      <span class="grow"></span><label class="f">Sede<select id="tSede">${sedi.map(s => `<option value="${s.id}" ${TM.sede === s.id ? 'selected' : ''}>${esc(s.nome)}</option>`).join('')}<option value="" ${!TM.sede ? 'selected' : ''}>Tutte le sedi</option></select></label></div>
    <div class="chips" style="margin-bottom:12px"><button class="chip" data-pen="" aria-pressed="${!TM.pennello}">✎ Scrivi l'orario</button>${r.preset.map(p => `<button class="chip" data-pen="${p.id}" aria-pressed="${TM.pennello === p.id}">${esc(p.nome)} ${p.da}–${p.a}</button>`).join('')}<button class="chip" data-pen="riposo" aria-pressed="${TM.pennello === 'riposo'}">Riposo</button></div>
    <div class="tw"><table class="t dense tg"><thead><tr><th class="stk">Persona</th>${g.map(x => `<th class="${x === oggi ? 'oggi' : ''}">${'DLMMGVS'[dowG(x)]}<br>${+x.slice(8)}</th>`).join('')}<th>Ore</th></tr></thead><tbody>
    ${pp.map(p => { const min = r.turni.filter(t => t.user === p.id).reduce((s, t) => s + Math.max(0, (+t.a.slice(0, 2) * 60 + +t.a.slice(3)) - (+t.da.slice(0, 2) * 60 + +t.da.slice(3)) - (t.pausa || 0)), 0);
      return `<tr><td class="stk"><b>${esc(p.nome)}</b><br><span class="muted xs">${esc(p.figura)}${p.ore ? ' · ' + nume(p.ore) + ' h/sett.' : ''}</span></td>${g.map(x => cella(p, x)).join('')}<td><b>${hm(min)}</b></td></tr>`; }).join('') || `<tr><td class="stk muted" colspan="${g.length + 2}">Nessuna persona in questa sede. Assegna le sedi in Persone e contratti.</td></tr>`}
    </tbody></table></div>`;
  $('#tPrev').onclick = () => { TM.mese = meseAdd(TM.mese, -1); aTurni(m); };
  $('#tNext').onclick = () => { TM.mese = meseAdd(TM.mese, 1); aTurni(m); };
  m.onchange = e => { if (e.target.id === 'tSede') { TM.sede = e.target.value; aTurni(m); } };
  m.onclick = async e => {
    const pen = e.target.closest('[data-pen]'); if (pen) { TM.pennello = pen.dataset.pen || null; return aTurni(m); }
    const c = e.target.closest('td.c');
    if (c) {
      const p = r.persone.find(x => x.id === c.dataset.u), sede = TM.sede || p.sedi[0] || null;
      if (TM.pennello) {
        const pr = r.preset.find(x => x.id === TM.pennello);
        try { await api('PUT', '/api/sp/admin/turni', {user: p.id, giorno: c.dataset.g, turni: pr ? [{da: pr.da, a: pr.a, pausa: pr.pausa, sede}] : []}); } catch (er) { return toast(er.message); }
        return aTurni(m);
      }
      return editaTurno(p, c.dataset.g, r.turni.filter(t => t.user === p.id && t.giorno === c.dataset.g), sedi, sede, () => aTurni(m));
    }
    if (e.target.id === 'preset') return editaPreset(r.preset, () => aTurni(m));
    if (e.target.id === 'copia') {
      const d = finestra(`<h2>Copia una settimana</h2><p class="muted small">I turni delle persone ${TM.sede ? 'di ' + esc(sn.get(TM.sede)) : ''} vengono copiati sulla settimana scelta (quelli già scritti lì vengono sostituiti).</p>
        <div class="grid2"><label class="f">Copia la settimana del<select id="cDa">${lun.concat([addG(lun[0], -7)]).sort().map(x => `<option value="${x}">lunedì ${fmtG(x).slice(4)}</option>`).join('')}</select></label>
        <label class="f">Sulla settimana del<select id="cA">${lun.concat([addG(lun[lun.length - 1], 7)]).map(x => `<option value="${x}">lunedì ${fmtG(x).slice(4)}</option>`).join('')}</select></label></div>
        <div class="acts"><button class="btn" id="chiudi">Annulla</button><button class="btn primary" id="ok">Copia</button></div>`);
      d.querySelector('#chiudi').onclick = chiudi;
      d.querySelector('#ok').onclick = async () => { if ($('#cDa').value === $('#cA').value) return toast('Scegli due settimane diverse.'); try { const x = await api('POST', '/api/sp/admin/turni/copia', {da: $('#cDa').value, a: $('#cA').value, users: pp.map(p => p.id)}); chiudi(); toast(`Copiati ${x.copiati} turni.`); aTurni(m); } catch (er) { toast(er.message); } };
    }
    if (e.target.id === 'avvisa') { if (!confirm(`Mandare una notifica a chi ha turni in ${meseLbl(TM.mese)}?`)) return; const x = await api('POST', '/api/sp/admin/turni/avvisa', {mese: TM.mese}); toast(`Avvisate ${x.persone} persone.`); }
  };
}
function editaTurno(p, g, ts, sedi, sede, dopo){
  const riga = (t, i) => `<div class="grid2" data-r="${i}" style="grid-template-columns:1fr 1fr 1fr 1.4fr;margin-bottom:8px"><label class="f">Dalle<input type="time" class="da" value="${t?.da || '09:30'}"></label><label class="f">Alle<input type="time" class="a" value="${t?.a || '18:30'}"></label>
    <label class="f">Pausa (min)<input type="number" class="pausa" min="0" max="240" value="${t?.pausa ?? 0}"></label><label class="f">Sede<select class="sede">${sedi.map(s => `<option value="${s.id}" ${(t?.sede || sede) === s.id ? 'selected' : ''}>${esc(s.nome)}</option>`).join('')}</select></label></div>`;
  let n = Math.max(1, ts.length);
  const draw = () => {
    const d = finestra(`<h2>${esc(p.nome)}</h2><p class="muted small">${fmtG(g)}</p><div id="righe">${Array.from({length: n}, (_, i) => riga(ts[i], i)).join('')}</div>
      ${n < 3 ? '<button class="btn small" id="piu">+ Secondo turno nello stesso giorno</button>' : ''}
      <label class="f" style="margin-top:10px"><span><input type="checkbox" id="settimana"> Ripeti lo stesso orario per ogni ${['domenica', 'lunedì', 'martedì', 'mercoledì', 'giovedì', 'venerdì', 'sabato'][dowG(g)]} del mese</span></label>
      <div class="acts"><button class="btn danger" id="riposo">Riposo</button><span class="grow"></span><button class="btn" id="chiudi">Annulla</button><button class="btn primary" id="ok">Salva</button></div>`);
    d.querySelector('#chiudi').onclick = chiudi;
    const piu = d.querySelector('#piu'); if (piu) piu.onclick = () => { n++; draw(); };
    const giorni = () => d.querySelector('#settimana').checked ? giorniMese(g.slice(0, 7)).filter(x => dowG(x) === dowG(g)) : [g];
    const salva = async turni => { try { await api('PUT', '/api/sp/admin/turni', {user: p.id, giorni: giorni(), turni}); chiudi(); dopo(); } catch (e) { toast(e.message); } };
    d.querySelector('#riposo').onclick = () => salva([]);
    d.querySelector('#ok').onclick = () => salva([...d.querySelectorAll('[data-r]')].map(r => ({da: r.querySelector('.da').value, a: r.querySelector('.a').value, pausa: r.querySelector('.pausa').value, sede: r.querySelector('.sede').value})));
  };
  draw();
}
function editaPreset(lista, dopo){
  let l = lista.map(x => ({...x}));
  const draw = () => {
    const d = finestra(`<h2>Turni tipo</h2><p class="muted small">Servono per riempire il calendario in fretta. La pausa (in minuti) non conta nelle ore.</p>
      ${l.map((p, i) => `<div class="row" data-i="${i}" style="margin-bottom:8px"><input type="text" class="nome grow" value="${esc(p.nome)}" placeholder="Nome" style="max-width:150px"><input type="time" class="da" value="${p.da}"><input type="time" class="a" value="${p.a}"><input type="number" class="pausa" value="${p.pausa}" style="width:70px" title="Pausa (min)"><button class="btn small danger" data-via="${i}">×</button></div>`).join('')}
      <button class="btn small" id="piu">+ Turno tipo</button>
      <div class="acts"><button class="btn" id="chiudi">Annulla</button><button class="btn primary" id="ok">Salva</button></div>`, true);
    const leggi = () => { l = [...d.querySelectorAll('[data-i]')].map(r => ({nome: r.querySelector('.nome').value, da: r.querySelector('.da').value, a: r.querySelector('.a').value, pausa: r.querySelector('.pausa').value})); };
    d.querySelector('#chiudi').onclick = chiudi;
    d.querySelector('#piu').onclick = () => { leggi(); l.push({nome: '', da: '09:30', a: '13:30', pausa: 0}); draw(); };
    d.onclick = e => { const v = e.target.closest('[data-via]'); if (v) { leggi(); l.splice(+v.dataset.via, 1); draw(); } };
    d.querySelector('#ok').onclick = async () => { leggi(); try { await api('PUT', '/api/sp/admin/preset', {preset: l}); chiudi(); dopo(); } catch (e) { toast(e.message); } };
  };
  draw();
}

/* ---------- branche medici ---------- */
let sedeBr = null;
async function aBranche(m){
  await caricaInfo();
  const S2 = INFO;
  if (!sedeBr || !S2.tutteSedi.some(s => s.id === sedeBr)) sedeBr = S2.tutteSedi[0]?.id;
  const ms = S2.tuttiMedici.filter(x => x.sedi.includes(sedeBr));
  const brDi = x => S2.medici.find(y => y.id === x.id)?.branche[sedeBr] || [];
  m.innerHTML = `<h1>Branche medici</h1><p class="sub">Scegli la sede e spunta le branche per cui ogni medico è abilitato. Si salva da solo. I medici vedono le loro abilitazioni in Info utili.</p>
    <div class="chips" style="margin-bottom:14px">${S2.tutteSedi.map(s => `<button class="chip" data-s="${s.id}" aria-pressed="${s.id === sedeBr}">${esc(s.nome)} · ${S2.tuttiMedici.filter(x => x.sedi.includes(s.id)).length}</button>`).join('')}</div>
    <div class="card">${ms.length ? `<div class="tw"><table class="br"><thead><tr><th>Branca</th>${ms.map(x => `<th>${esc(x.nome)}<div class="th-acts"><button data-tutte="${x.id}">Tutte</button>·<button data-nessuna="${x.id}">Nessuna</button></div></th>`).join('')}</tr></thead>
      <tbody>${S2.branche.map(b => `<tr><td>${esc(b)}</td>${ms.map(x => `<td><input type="checkbox" class="cb" data-m="${x.id}" data-b="${esc(b)}" ${brDi(x).includes(b) ? 'checked' : ''} aria-label="${esc(x.nome)} – ${esc(b)}"></td>`).join('')}</tr>`).join('')}</tbody></table></div>`
      : '<p class="muted">Nessun medico in questa sede.</p>'}
      <p class="muted small" style="margin:14px 0 0">I medici e le loro sedi arrivano in automatico dal pannello accessi: sono quelli assegnati in Nuovalab con il livello «Medico», ognuno nello studio della sua sede. Per aggiungere o togliere un medico da una sede cambialo lì.</p></div>`;
  const salva = async (id, lista) => {
    let med = S2.medici.find(y => y.id === id); if (!med) { med = {id, branche: {}, sedi: []}; S2.medici.push(med); }
    await api('PUT', `/api/scheda/branche/${id}/${sedeBr}`, {branche: lista}); med.branche[sedeBr] = lista;
  };
  m.onchange = async e => {
    const c = e.target.closest('input[data-m]'); if (!c) return;
    const lista = [...m.querySelectorAll(`input[data-m="${c.dataset.m}"]:checked`)].map(x => x.dataset.b);
    try { await salva(c.dataset.m, lista); } catch (er) { c.checked = !c.checked; toast(er.message); }
  };
  m.onclick = async e => {
    const s = e.target.closest('[data-s]'); if (s) { sedeBr = s.dataset.s; return aBranche(m); }
    const t = e.target.closest('[data-tutte]'), n = e.target.closest('[data-nessuna]');
    try {
      if (t) { await salva(t.dataset.tutte, [...S2.branche]); aBranche(m); }
      if (n) { await salva(n.dataset.nessuna, []); aBranche(m); }
    } catch (er) { toast(er.message); }
  };
}

/* ---------- info utili (orari, linee aziendali, regolamento, contatti utili) ---------- */
async function aInfo(m){
  await caricaInfo();
  const S2 = INFO, reg = S2.docs.find(d => d.tipo === 'regolamento');
  m.innerHTML = `<h1>Info utili</h1><p class="sub">Quello che il personale trova nella sezione Info utili.</p>
    <div class="card"><h2>Orari delle sedi</h2><p class="muted small" style="margin-top:-4px">Ogni persona vede solo gli orari delle sedi in cui lavora.</p>
      <div class="chips" id="sediOr">${S2.sedi.map((s, i) => `<button class="chip" data-s="${s.id}" aria-pressed="${i === 0}">${esc(s.nome)}</button>`).join('')}</div>
      <div id="orEd" style="margin-top:14px"></div></div>
    <div class="card"><h2>Linee aziendali (policy, pilastri valoriali e clinici)</h2><p class="muted small" style="margin-top:-4px">Il personale li legge in Info utili, senza poterli scaricare, stampare o modificare.</p>
      ${LINEE.map(([t, nome]) => { const ds = S2.docs.filter(d => d.tipo === t);
      return `<div class="row" style="margin-top:14px"><h3 class="grow" style="margin:0">${nome}</h3><button class="btn small primary" data-carica="${t}">+ Carica</button></div>
      <div class="lista" style="margin-top:6px">${ds.length ? ds.map(d => `<div class="li"><span class="grow"><span class="t">${esc(d.titolo)}</span><span class="s">Versione ${d.versione} · ${fmtD(d.caricato)}</span></span>
        <button class="btn small" data-apri="${d.id}">Apri</button><button class="btn small" data-sost="${d.id}" data-tipo="${t}">Sostituisci</button><button class="btn small danger" data-togli="${d.id}">Togli</button></div>`).join('') : '<p class="muted small" style="margin:0">Nessun documento.</p>'}</div>`; }).join('')}</div>
    <div class="card"><div class="row"><h2 class="grow" style="margin:0">Convenzioni per te</h2><a class="btn small" href="https://appgestione.it/admin" target="_blank" rel="noopener">Gestisci in Gestione accessi → Sedi</a></div>
      <p class="muted small" style="margin:6px 0 0">${(S2.convenzioni || []).length ? `${S2.convenzioni.length} convenzioni: ${S2.convenzioni.map(c => esc(c.titolo)).join(', ')}.` : 'Nessuna convenzione ancora.'}</p></div>
    <div class="card"><div class="row"><h2 class="grow" style="margin:0">Contatti utili</h2><a class="btn small" href="https://appgestione.it/admin" target="_blank" rel="noopener">Gestisci in Gestione accessi → Sedi</a></div>
      <p class="muted small" style="margin:6px 0 0">${(S2.contatti || []).length ? `${S2.contatti.length} contatti pubblicati: ${S2.contatti.map(c => esc(c.riferimento)).join(', ')}.` : 'Nessun contatto ancora.'}</p></div>
    <div class="card"><div class="row"><h2 class="grow" style="margin:0">Regolamento aziendale</h2><button class="btn small primary" id="nuovoReg">${reg ? 'Carica nuova versione' : '+ Carica regolamento'}</button></div>
      ${reg ? `<div class="li" style="margin-top:8px"><span class="grow"><span class="t">${esc(reg.titolo)}</span><span class="s">Versione ${reg.versione} · ${fmtD(reg.caricato)} · letto e accettato da ${S2.regLetti || 0} su ${S2.persone}</span></span>
        <button class="btn small" data-apri="${reg.id}">Apri</button><button class="btn small" data-letture="${reg.id}">Chi ha letto</button></div>
        <p class="muted small">Quando carichi una nuova versione, tutti devono rileggerla e accettarla di nuovo.</p><div id="letture"></div>` : '<p class="muted">Non ancora caricato.</p>'}</div>
    <input type="file" id="file" accept=".pdf,.docx,application/pdf" hidden>`;
  const sedeOr = id => { m.querySelectorAll('#sediOr .chip').forEach(c => c.setAttribute('aria-pressed', c.dataset.s === id)); editorOrari(S2.sedi.find(s => s.id === id)); };
  $('#sediOr').onclick = e => { const c = e.target.closest('[data-s]'); if (c) sedeOr(c.dataset.s); };
  // da Gestione accessi («cosa resta da fare»): si apre direttamente sugli orari della sede indicata
  const sedeUrl = new URLSearchParams(location.search).get('sede');
  if (sedeUrl && S2.sedi.some(s => s.id === sedeUrl)) {
    sedeOr(sedeUrl);
    const card = $('#sediOr').closest('.card'); window.scrollTo({ top: card.getBoundingClientRect().top + scrollY - 90 }); card.style.outline = '3px solid var(--accent, #2B8384)'; card.style.outlineOffset = '3px';
  } else if (S2.sedi[0]) editorOrari(S2.sedi[0]);
  let car = null;
  const scegli = (tipo, sost) => { car = {tipo, sost}; $('#file').value = ''; $('#file').click(); };
  $('#nuovoReg').onclick = () => scegli('regolamento');
  $('#file').onchange = async () => {
    const f = $('#file').files[0]; if (!f || !car) return;
    const def = car.sost ? (S2.docs.find(d => d.id === car.sost)?.titolo || '') : (car.tipo === 'regolamento' ? 'Regolamento aziendale' : f.name.replace(/\.[^.]+$/, ''));
    const titolo = prompt('Titolo del documento', def); if (titolo === null) return;
    const fd = new FormData(); fd.append('file', f); fd.append('tipo', car.tipo); fd.append('titolo', titolo);
    if (car.sost) fd.append('sostituisce', car.sost);
    try { await api('POST', '/api/scheda/doc', undefined, fd); toast('Documento caricato.'); aInfo(m); } catch (e) { toast(e.message); }
  };
  m.onclick = async e => {
    const cc = e.target.closest('[data-carica]'); if (cc) return scegli(cc.dataset.carica);
    const a = e.target.closest('[data-apri]'), s = e.target.closest('[data-sost]'), t = e.target.closest('[data-togli]'), l = e.target.closest('[data-letture]');
    if (a) apriDocInfo(S2.docs.find(d => d.id === a.dataset.apri));
    if (s) scegli(s.dataset.tipo, s.dataset.sost);
    if (t && confirm('Togliere questo documento? Non lo vedrà più nessuno, ma resta archiviato.')) { await api('DELETE', `/api/scheda/doc/${t.dataset.togli}`); toast('Documento tolto.'); aInfo(m); }
    if (l) { const r = await api('GET', `/api/scheda/doc/${l.dataset.letture}/letture`);
      $('#letture').innerHTML = `<div class="tw" style="margin-top:10px"><table class="t"><thead><tr><th>Persona</th><th>Ruolo</th><th>Letto e accettato</th></tr></thead><tbody>${r.persone.map(p => `<tr><td>${esc(p.nome)}</td><td>${esc(p.figura)}</td><td>${p.letto ? `<span class="tag ok">${fmtD(p.letto)}</span>` : '<span class="tag warn">Non ancora</span>'}</td></tr>`).join('')}</tbody></table></div>`; }
  };
}
function editorOrari(s){
  const h = $('#orEd'); if (!s) return;
  h.innerHTML = `<table class="orari">${INFO.giorni.map((g, i) => { const x = s.orari[i] || {}; return `<tr data-g="${i}"><td>${g}</td>
    <td><label class="row" style="gap:6px"><input type="checkbox" class="cb ap" ${x.aperto ? 'checked' : ''}> Aperto</label></td>
    <td><input type="time" class="da" value="${esc(x.da || '09:30')}" ${x.aperto ? '' : 'disabled'}> – <input type="time" class="a" value="${esc(x.a || '18:30')}" ${x.aperto ? '' : 'disabled'}></td></tr>`; }).join('')}</table>
    <div class="row" style="margin-top:12px"><button class="btn primary" id="salvaOr">Salva orari</button><span class="muted small">${esc(s.nome)}</span></div>`;
  h.querySelectorAll('.ap').forEach(c => c.onchange = () => c.closest('tr').querySelectorAll('input[type=time]').forEach(t => t.disabled = !c.checked));
  $('#salvaOr').onclick = async () => {
    const orari = [...h.querySelectorAll('tr[data-g]')].map(r => ({aperto: r.querySelector('.ap').checked, da: r.querySelector('.da').value, a: r.querySelector('.a').value}));
    try { await api('PUT', `/api/scheda/orari/${s.id}`, {orari}); s.orari = orari; toast('Orari salvati.'); } catch (e) { toast(e.message); }
  };
}

/* ---------- performance ---------- */
let PTAB = 'persone', PSEL = null, IMESE = null;
async function aPerf(m){
  const r = await api('GET', '/api/sp/admin/perf');
  const tabs = [['persone', 'Persone'], ['piani', 'Piano di crescita'], [r.piani.some(x => x.fonte) ? 'guadagni' : 'incentivi', r.piani.some(x => x.fonte) ? 'Guadagni del mese' : 'Incentivi del mese']];
  if (PTAB === 'incentivi' && r.piani.some(x => x.fonte)) PTAB = 'guadagni';
  const ST = { pass: ['Approvato', 'ok'], verifica: ['Da verificare', 'warn'], no: ['Non approvato', 'no'], fare: ['Da fare', 'info'] };
  let corpo = '';
  if (PTAB === 'persone') {
    const nelPiano = r.persone.filter(p => p.stato), senza = r.persone.filter(p => !p.stato);
    if (!PSEL || !r.persone.some(p => p.id === PSEL)) PSEL = (nelPiano.find(p => p.stato.obiettivi.some(o => o.stato === 'verifica')) || nelPiano[0] || r.persone[0])?.id;
    const card = p => { const st = p.stato, tot = st.obiettivi.length, pct = st.prossimo && tot ? Math.round(100 * st.pass / tot) : 100;
      const dv = st.obiettivi.filter(o => o.stato === 'verifica').length;
      const badge = st.inAttesa ? 'Passaggio da approvare' : st.test?.stato === 'superato' ? 'Test superato' : st.test?.stato ? 'Test in corso' : st.test?.disponibile ? 'Pronto per il test' : dv ? `${dv} ${dv === 1 ? 'prova' : 'prove'} da verificare` : st.prossimo ? 'In corso' : 'Ultimo livello';
      return `<button class="termcard" data-psel="${p.id}" aria-pressed="${PSEL === p.id}">${termometro(pct)}<span class="pc">${st.prossimo && tot ? pct + '%' : '—'}</span>
        <b class="small">${esc(p.nome)}</b><span class="xs muted">${esc(st.ruolo)}${st.prossimo ? ' → ' + esc(st.prossimo.ruolo) : ''}</span>
        <span class="xs muted">${esc((p.sedi || []).map(x => r.sediNomi[x] || '').filter(Boolean)[0] || '')}${st.prossimo && tot ? ' · ' + st.pass + ' di ' + tot : ''}</span>
        <span class="tag ${st.inAttesa || st.test?.disponibile ? 'warn' : dv ? 'info' : ''}" style="margin-top:4px">${badge}</span></button>`; };
    const sp = r.persone.find(p => p.id === PSEL), st = sp?.stato, pi = r.piani.find(x => x.id === sp?.piano);
    const pas = r.passaggi;
    const dettaglio = !sp ? '' : `<div class="card"><div class="row" style="flex-wrap:wrap;justify-content:space-between;gap:8px"><h2 style="margin:0">${esc(sp.nome)}</h2>
        <div class="row" style="gap:6px;flex-wrap:wrap"><select data-piano="${sp.id}" aria-label="Piano"><option value="">Nessun piano</option>${r.piani.map(x => `<option value="${x.id}" ${sp.piano === x.id ? 'selected' : ''}>${esc(x.nome)}</option>`).join('')}</select>
        ${pi ? `<select data-liv="${sp.id}" aria-label="Ruolo attuale">${pi.livelli.map(l => `<option value="${l.n}" ${sp.livello === l.n ? 'selected' : ''}>${esc(l.ruolo)}</option>`).join('')}</select>` : ''}</div></div>
      ${st ? `${st.prossimo ? `<p class="muted small">${st.daExcel ? `Obiettivi per superare <b>${esc(st.ruolo)}</b> (poi ${esc(st.prossimo.ruolo)})` : `Obiettivi per diventare <b>${esc(st.prossimo.ruolo)}</b>`}</p>${st.obiettivi.length ? `<div class="lista">${st.obiettivi.map(o => `<div class="li" style="align-items:flex-start;gap:10px">
          <span class="grow"><span class="t">${esc(o.testo)}</span>
          <span class="s">${o.file && o.datoId ? `<a href="/api/sp/perf/prova/${o.datoId}" target="_blank" rel="noopener">📎 ${esc(o.file)}</a> · ` : ''}${o.dato && o.dato !== '(prova caricata)' ? '«' + esc(o.dato) + '» · ' : ''}${o.il ? fmtDT(o.il) : ''}${o.nota ? ' · nota: ' + esc(o.nota) : ''}</span></span>
          ${o.stato === 'verifica' && o.datoId ? `<button class="btn small" data-dno="${o.datoId}">Non basta</button><button class="btn small primary" data-dok="${o.datoId}">Approva</button>` : `<span class="tag ${ST[o.stato][1]}">${ST[o.stato][0]}</span>`}</div>`).join('')}</div>` : '<p class="muted small">Il ruolo successivo non ha obiettivi: il passaggio lo decidi tu cambiando il ruolo qui sopra.</p>'}
        <div class="card testbox ${st.test?.disponibile ? 'on' : ''}" style="margin:12px 0 0;box-shadow:none"><b class="small">${st.inAttesa ? 'Passaggio in attesa della tua approvazione' : st.test?.stato === 'superato' ? 'Test superato' : st.test?.stato === 'da_ripetere' ? 'Test da ripetere' : st.test?.stato ? 'Test generato: la persona lo sta facendo' : st.test?.disponibile ? 'Tutti i pass approvati: la persona può generare il test' : 'Test bloccato'}</b>
          <p class="xs muted" style="margin:4px 0 0">${st.test?.disponibile || st.test?.stato ? 'Il test pesca dai Protocolli della sua mansione; superato, il passaggio di ruolo arriva qui da confermare.' : 'Si sblocca per la persona quando approvi tutte le prove.'}</p></div>` : '<p class="muted small">È all\'ultimo livello del suo piano.</p>'}
      ${st.daExcel ? `<div class="card" style="box-shadow:none;border:1px solid var(--line);margin-top:12px" id="ipBox" data-uid="${sp.id}"><div class="row" style="justify-content:space-between;flex-wrap:wrap;gap:6px"><b>I-Profile</b>${st.iprofile ? `<span class="xs muted">salvato il ${fmtD(st.iprofile.il)}</span>` : ''}</div>
          ${st.iprofile ? `<div style="margin-top:8px">${graficoIprofile(st.iprofile.valori)}</div>` : '<p class="small muted" style="margin:4px 0 0">Non ancora caricato: la persona lo vedrà in alto nella sua Performance.</p>'}
          <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:10px"><label class="btn small" style="cursor:pointer">${st.iprofile ? 'Carica un nuovo I-Profile' : 'Carica la foto del grafico'}<input type="file" id="ipF" accept="image/*" hidden></label><button class="btn small" id="ipMano">Inserisci a mano</button></div>
          <div id="ipForm"></div></div>
        <p class="muted xs" style="margin-top:12px">Fisso, bonus e malus: scheda «Guadagni del mese».</p>` : `<div style="margin-top:12px">${boxIncentivo(st.incentivo, 'Incentivo · ' + st.ruolo)}</div>`}` : '<p class="muted small">Scegli un piano e il ruolo attuale per vedere obiettivi e incentivo.</p>'}</div>`;
    corpo = `${pas.length ? `<div class="card"><h2>Passaggi di ruolo da confermare</h2><div class="lista">${pas.map(x => `<div class="li"><span class="grow"><span class="t">${esc(x.nome)}: ${esc(x.da)} → ${esc(x.a)}</span><span class="s">Test superato${x.bonus ? ' · bonus ' + esc(x.bonus) : ''}</span></span><button class="btn small" data-pno="${x.id}">Rimanda</button><button class="btn small primary" data-pok="${x.id}">Conferma</button></div>`).join('')}</div></div>` : ''}
      ${nelPiano.length ? `<p class="muted small" style="margin:0 0 8px">Ogni termometro mostra a che punto è la persona con gli obiettivi del ruolo successivo. Tocca una persona per vedere le prove e l'incentivo.</p><div class="termgrid">${nelPiano.map(card).join('')}</div>` : `<div class="card"><p class="muted" style="margin:0">${r.piani.length ? 'Nessuno è ancora in un piano: scegli una persona qui sotto e assegnale piano e ruolo.' : 'Prima carica il piano di crescita (scheda «Piano di crescita»).'}</p></div>`}
      ${senza.length ? `<details class="card" ${nelPiano.length ? '' : 'open'}><summary><b>Senza piano (${senza.length})</b></summary><div class="chips" style="margin-top:8px">${senza.map(p => `<button class="chip" data-psel="${p.id}" aria-pressed="${PSEL === p.id}">${esc(p.nome)}</button>`).join('')}</div></details>` : ''}
      ${dettaglio}`;
  }
  if (PTAB === 'piani') corpo = `<div id="pianiG"></div>`;
  if (PTAB === 'guadagni') corpo = `<div id="guadA"><div class="card"><p class="muted" style="margin:0">Calcolo dei guadagni…</p></div></div>`;
  if (PTAB === 'incentivi') {
    let inc = null, err = '', az = null;
    try { inc = await api('GET', '/api/sp/admin/incentivi' + (IMESE ? '?mese=' + IMESE : '')); } catch (e) { err = e.message; }
    try { az = await api('GET', '/api/sp/admin/finanza/aziende'); } catch (e) { err = err || e.message; }
    IMESE = inc?.mese || IMESE || r.mese;
    const mesi = Array.from({ length: 12 }, (_, i) => { const d = new Date(r.mese + '-15'); d.setMonth(d.getMonth() - i); return d.toISOString().slice(0, 7); });
    corpo = `<div class="card"><div class="row" style="flex-wrap:wrap;gap:8px;justify-content:space-between"><div><h2 style="margin:0">Incentivi</h2><p class="muted small" style="margin:4px 0 0">Calcolati dal consuntivo di ogni sede in Gestione finanziaria, con la regola del ruolo (impostala nel Piano di crescita, livello per livello).</p></div>
      <div class="row" style="gap:6px;flex-wrap:wrap">${az ? `<select id="finAz" aria-label="Azienda in Gestione finanziaria"><option value="">Azienda in Gestione finanziaria…</option>${az.aziende.map(a => `<option value="${esc(a.id)}" ${az.scelta === a.id ? 'selected' : ''}>${esc(a.nome)}</option>`).join('')}</select>` : ''}
      <select id="iMese" aria-label="Mese">${mesi.map(x => `<option value="${x}" ${x === IMESE ? 'selected' : ''}>${new Date(x + '-15').toLocaleDateString('it-IT', { month: 'long', year: 'numeric' })}</option>`).join('')}</select></div></div>
      ${err ? `<div class="banner warn" style="margin-top:10px">${esc(err)}</div>` : ''}
      ${inc ? `<div class="tw" style="margin-top:12px"><table class="t"><thead><tr><th>Persona</th><th>Ruolo</th><th>Sede</th><th style="text-align:right">Fatturato</th><th style="text-align:right">Target</th><th>Regola</th><th style="text-align:right">Incentivo</th></tr></thead><tbody>
        ${inc.righe.map(x => `<tr><td><b>${esc(x.nome)}</b></td><td>${esc(x.ruolo)}</td><td>${esc(x.sede || '')}</td><td style="text-align:right">${x.calcolabile ? esc(x.testo.fatturato) : ''}</td><td style="text-align:right">${x.calcolabile ? esc(x.testo.target) : ''}</td>
          <td class="small">${esc(x.regola)}${x.errore ? `<br><span class="muted xs">${esc(x.errore)}</span>` : x.calcolabile && !x.aTarget ? '<br><span class="muted xs">target non raggiunto</span>' : ''}</td><td style="text-align:right;font-weight:800">${x.calcolabile ? esc(x.testo.valore) : '—'}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Nessuna persona in un piano.</td></tr>'}
        </tbody><tfoot><tr><td colspan="6"><b>Totale</b></td><td style="text-align:right;font-weight:800">€ ${Number(inc.totale).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td></tr></tfoot></table></div>
        <p class="muted xs">Il mese di riferimento è quello chiuso; il fatturato personale (RAP, CM) non è in Gestione finanziaria: quelle voci si calcolano a mano.</p>` : ''}</div>`;
  }
  m.innerHTML = `<h1>Performance</h1><p class="sub">Piano di crescita, obiettivi con le prove delle persone, test di passaggio e incentivi calcolati dal fatturato.</p>
    <div class="chips" style="margin-bottom:14px">${tabs.map(([k, t]) => `<button class="chip" data-pt="${k}" aria-pressed="${PTAB === k}">${t}${k === 'persone' && (r.dati.length + r.passaggi.length) ? ` (${r.dati.length + r.passaggi.length})` : ''}</button>`).join('')}</div>${corpo}`;
  if (PTAB === 'piani') gestionePiani($('#pianiG'), r, () => aPerf(m));
  if (PTAB === 'guadagni') { guadagniAdmin($('#guadA')); m.onclick = async e => { const t = e.target.closest('[data-pt]'); if (t) { PTAB = t.dataset.pt; return aPerf(m); } }; m.onchange = null; return; }
  // I-Profile: foto → lettura dei numeri (come l'app I-Profile) → controllo → salva
  const ipForm = (v = {}) => { const f = $('#ipForm'); if (!f) return;
    f.innerHTML = `<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(150px,1fr));gap:8px;margin-top:10px">${[...IP_TRATTI, ...IP_LATO].map(([k, l]) => `<label class="f xs">${l}<input type="number" min="-100" max="100" data-ip="${k}" value="${v[k] ?? ''}"></label>`).join('')}</div>
      <p class="xs muted">Controlla i numeri con il grafico, poi salva. Si salvano solo i numeri, non la foto.</p><div class="row"><span class="grow"></span><button class="btn primary small" id="ipSalva">Salva I-Profile</button></div>`; };
  const ipLeggi = async inp => {
    if (!inp.files[0]) return;
    const f = inp.files[0], img = await createImageBitmap(f), sc = Math.min(1, 1800 / Math.max(img.width, img.height)), cv = document.createElement('canvas');
    cv.width = Math.round(img.width * sc); cv.height = Math.round(img.height * sc); const cx = cv.getContext('2d'); cx.fillStyle = '#fff'; cx.fillRect(0, 0, cv.width, cv.height); cx.drawImage(img, 0, 0, cv.width, cv.height);
    const b = await new Promise(r => cv.toBlob(r, 'image/jpeg', .88)), fd = new FormData(); fd.append('foto', b, 'iprofile.jpg');
    $('#ipForm').innerHTML = '<p class="small muted">Lettura del grafico in corso…</p>';
    try { const r = await api('POST', '/api/sp/admin/iprofile/leggi', undefined, fd); ipForm(r.valori); toast('Valori letti: controllali e salva.'); } catch (er) { toast(er.message); ipForm(); }
  };
  m.onclick = async e => {
    const t = e.target.closest('[data-pt]'); if (t) { PTAB = t.dataset.pt; return aPerf(m); }
    const ps = e.target.closest('[data-psel]'); if (ps) { PSEL = ps.dataset.psel; return aPerf(m); }
    if (e.target.id === 'ipMano') return ipForm(r.persone.find(x => x.id === PSEL)?.stato?.iprofile?.valori || {});
    if (e.target.id === 'ipSalva') { const v = {}; m.querySelectorAll('[data-ip]').forEach(i => v[i.dataset.ip] = i.value);
      try { await api('PUT', `/api/sp/admin/iprofile/${PSEL}`, {valori: v}); toast('I-Profile salvato.'); return aPerf(m); } catch (er) { return toast(er.message); } }
    const k = ['dok', 'dno', 'pok', 'pno'].find(x => e.target.closest(`[data-${x}]`));
    if (!k) return;
    const id = e.target.closest(`[data-${k}]`).dataset[k];
    try {
      if (k[0] === 'd') { const nota = k === 'dno' ? prompt('Cosa manca? (lo legge la persona)') : ''; if (nota === null) return; await api('POST', `/api/sp/admin/perf/dato/${id}`, {ok: k === 'dok', nota}); }
      else await api('POST', `/api/sp/admin/passaggi/${id}`, {ok: k === 'pok'});
      toast('Fatto.'); aPerf(m);
    } catch (er) { toast(er.message); }
  };
  m.onchange = async e => {
    if (e.target.id === 'ipF') return ipLeggi(e.target);
    const p = e.target.closest('[data-piano]'), l = e.target.closest('[data-liv]');
    try {
      if (p) await api('PUT', `/api/sp/admin/perf/${p.dataset.piano}`, {piano: p.value});
      if (l) await api('PUT', `/api/sp/admin/perf/${l.dataset.liv}`, {piano: r.persone.find(x => x.id === l.dataset.liv).piano, livello: l.value});
      if (e.target.id === 'finAz') { await api('PUT', '/api/sp/admin/finanza/azienda', {azienda: e.target.value}); toast('Azienda salvata.'); }
      if (e.target.id === 'iMese') IMESE = e.target.value;
      if (p || l || e.target.id === 'finAz' || e.target.id === 'iMese') aPerf(m);
    } catch (er) { toast(er.message); }
  };
}
/* ---------- Piano di crescita (amministratore): elenco dei piani; per ognuno Vedi · Modifica · Persone.
   Si crea da zero nell'app oppure da Excel (aggiungere come piano nuovo o sostituire un piano che c'è già). ---------- */
let PG = { vista: 'elenco', id: null, tab: 'vedi' };
const CONTR = { dip: 'CCNL', piva: 'Partita IVA' };
const H7 = ['RUOLO', 'FISSO EURO', 'VARIABILE', 'OBIETTIVI (HARD SKILL)', 'SOTTO OBIETTIVI', 'SOFT SKILL', 'SCUOLA DI FORMAZIONE'];
function gestionePiani(h, r, ricarica){
  const piani = r.piani, inPiano = id => r.persone.filter(x => x.piano === id);
  const tipoTag = g => g.tipo === 'perc' ? '<span class="tag ok">automatico</span>' : g.tipo === 'manuale' ? '<span class="tag warn">a mano</span>' : '<span class="tag">nota</span>';
  const testata = (titolo, sotto = '') => `<div class="row" style="gap:10px;margin-bottom:12px;flex-wrap:wrap"><button class="btn small" data-pg="elenco">← Tutti i piani</button><h2 style="margin:0" class="grow">${titolo}</h2>${sotto}</div>`;
  if (PG.vista === 'elenco') {
    h.innerHTML = `<div class="card"><div class="row" style="flex-wrap:wrap;gap:8px;justify-content:space-between"><div><h2 style="margin:0">I piani di crescita</h2><p class="muted small" style="margin:4px 0 0">Tocca un piano per vederlo, modificarlo e assegnarlo alle persone.</p></div>
        <div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn" data-pg="excel">Carica da Excel</button><button class="btn primary" data-pg="nuovo">+ Crea un piano da zero</button></div></div>
      <div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(240px,1fr));gap:10px;margin-top:14px">
        ${piani.map(p => { const n = inPiano(p.id).length; return `<button class="card" data-pgapri="${p.id}" style="text-align:left;cursor:pointer;margin:0;box-shadow:none;border:1px solid var(--line)">
          <b style="font-size:16px">${esc(p.nome || 'Senza nome')}</b>${p.contratto ? ` <span class="tag info">${CONTR[p.contratto]}</span>` : ''}
          <span class="small muted" style="display:block;margin-top:6px">${p.livelli.length} livelli · ${p.livelli.reduce((t, l) => t + l.obiettivi.length, 0)} obiettivi</span>
          <span class="small" style="display:block;margin-top:2px"><b>${n}</b> ${n === 1 ? 'persona' : 'persone'}</span>
          <span class="xs muted" style="display:block;margin-top:6px">${p.fonte ? (/\.xlsx$/i.test(p.fonte) ? 'Da Excel: ' + esc(p.fonte) : esc(p.fonte)) : 'Piano di prima'}</span></button>`; }).join('') || '<p class="muted">Nessun piano. Caricalo da Excel o crealo da zero.</p>'}</div></div>
      <details class="card"><summary><b>Regole del piano di crescita</b> <span class="muted small">· le vede ogni persona nella sua Performance</span></summary>
        <textarea id="pgReg" rows="10" style="width:100%;margin-top:8px" placeholder="Regole valide per tutti i piani (passaggi, retrocessioni, incentivi…)">${esc(r.regole || '')}</textarea>
        <div class="row"><span class="grow"></span><button class="btn primary small" id="pgRegS">Salva le regole</button></div></details>`;
  } else if (PG.vista === 'excel') { return pianiExcel(h, r, ricarica, testata); }
  else {
    const p = PG.vista === 'nuovo' ? { id: 'nuovo', nome: '', contratto: '', livelli: [] } : piani.find(x => x.id === PG.id);
    if (!p) { PG = { vista: 'elenco' }; return gestionePiani(h, r, ricarica); }
    const tabs = PG.vista === 'nuovo' ? [] : [['vedi', 'Vedi'], ['modifica', 'Modifica'], ['persone', `Persone (${inPiano(p.id).length})`]];
    const tab = PG.vista === 'nuovo' ? 'modifica' : PG.tab;
    const chips = tabs.length ? `<div class="chips" style="margin-bottom:12px">${tabs.map(([k, t]) => `<button class="chip" data-pgtab="${k}" aria-pressed="${tab === k}">${t}</button>`).join('')}</div>` : '';
    const sotto = p.contratto ? `<span class="tag info">${CONTR[p.contratto]}</span>` : '';
    if (tab === 'vedi') {
      const H = p.intestazioni?.length === 7 ? p.intestazioni : H7;
      h.innerHTML = testata(esc(p.nome || 'Senza nome'), sotto) + chips + p.livelli.map(l => `<div class="card"><div class="pch"><div><span class="pcl">${esc(H[0])}</span><b>${esc(l.ruolo)}</b></div><div><span class="pcl">${esc(H[1])}</span><b>${esc(l.fisso || '—')}</b>${l.fissoCond === 'senza_target_pers' ? '<br><span class="xs muted">solo se non raggiunge il target personale</span>' : ''}</div>
          <div style="grid-column:1/-1"><span class="pcl">${esc(H[2])}</span>${(l.regole || []).length ? l.regole.map(g => `<div class="small" style="display:flex;gap:8px;align-items:baseline;margin:3px 0">${tipoTag(g)}<span>${esc(g.testo)}</span></div>`).join('') : '<span class="small">—</span>'}</div></div>
        ${l.obiettivi.map(o => `<div class="pcr ${o.test ? 'test' : ''}"><span class="pcl">${esc(H[3])}</span><b class="pco">${esc(o.testo)}</b>
          ${o.sotto ? `<div class="pcb"><span class="pcl">${esc(H[4])}</span><div class="pct">${esc(o.sotto)}</div></div>` : ''}${o.soft ? `<div class="pcb"><span class="pcl">${esc(H[5])}</span><div class="pct">${esc(o.soft)}</div></div>` : ''}${o.scuola ? `<div class="pcb"><span class="pcl">${esc(H[6])}</span><div class="pct">${esc(o.scuola)}</div></div>` : ''}</div>`).join('') || '<p class="muted small">Nessun obiettivo.</p>'}</div>`).join('')
        + (p.note ? `<details class="card"><summary><b>Fonti e criteri del file</b></summary><div class="small" style="white-space:pre-line;margin-top:8px">${esc(p.note)}</div></details>` : '');
    } else if (tab === 'persone') {
      const dentro = inPiano(p.id), fuori = r.persone.filter(x => x.piano !== p.id);
      const opt = sel => p.livelli.map(l => `<option value="${l.n}" ${sel === l.n ? 'selected' : ''}>${esc(l.ruolo)}</option>`).join('');
      h.innerHTML = testata(esc(p.nome || 'Senza nome'), sotto) + chips + `<div class="card"><h3 style="margin:0 0 8px">Persone in questo piano</h3>
        ${dentro.map(x => `<div class="row" style="gap:8px;padding:8px 0;border-bottom:1px solid var(--line);flex-wrap:wrap"><span class="grow"><b>${esc(x.nome)}</b> <span class="xs muted">${esc(x.figura || '')}</span></span>
          <select data-pgliv="${x.id}" aria-label="Livello">${opt(x.livello)}</select><button class="btn small" data-pgvia="${x.id}">Togli dal piano</button></div>`).join('') || '<p class="muted small">Nessuno.</p>'}</div>
        <div class="card"><h3 style="margin:0 0 8px">Aggiungi una persona</h3><div class="row" style="gap:8px;flex-wrap:wrap">
          <select id="pgChi" class="grow"><option value="">Scegli la persona…</option>${fuori.map(x => `<option value="${x.id}">${esc(x.nome)}${x.piano ? ' · ora in ' + esc(piani.find(y => y.id === x.piano)?.nome || '') : ''}</option>`).join('')}</select>
          <select id="pgLiv" aria-label="Livello">${opt(1)}</select><button class="btn primary" id="pgAgg">Assegna</button></div>
          <p class="xs muted" style="margin:8px 0 0">Se la persona è in un altro piano, passa a questo.</p></div>`;
    } else {
      // modifica (o nuovo): livelli → obiettivi con sotto-obiettivi, soft skill, scuola di formazione
      const P = JSON.parse(JSON.stringify(p)); if (!P.livelli.length) P.livelli.push({ ruolo: '', fisso: '', variabile: '', obiettivi: [{ testo: '' }] });
      let aperto = PG.vista === 'nuovo' ? 0 : null;
      const ta = (cls, v, ph, rows = 3) => `<textarea class="${cls}" rows="${rows}" placeholder="${ph}" style="width:100%;resize:vertical">${esc(v || '')}</textarea>`;
      const draw = () => {
        h.innerHTML = testata(PG.vista === 'nuovo' ? 'Nuovo piano' : esc(p.nome || 'Senza nome'), sotto) + chips + `<div class="card">
          <div class="row" style="gap:10px;flex-wrap:wrap"><label class="f grow">Nome del piano<input type="text" id="peNome" value="${esc(P.nome)}" placeholder="es. CCNL"></label>
            <label class="f">Contratto<select id="peContr"><option value="">—</option><option value="dip" ${P.contratto === 'dip' ? 'selected' : ''}>CCNL</option><option value="piva" ${P.contratto === 'piva' ? 'selected' : ''}>Partita IVA</option></select></label></div>
          <p class="muted small">Ogni livello è un ruolo, dal primo (ingresso) all'ultimo. Gli obiettivi di un livello sono quelli da raggiungere per superarlo. Il variabile: una voce per riga; le % sul fatturato si calcolano da sole.</p>
          ${P.livelli.map((l, i) => { const ap = aperto === i; return `<div class="card" style="background:var(--sunken);box-shadow:none" data-pel="${i}">
            <div class="row" style="gap:6px"><button class="btn small" data-peapri="${i}" style="min-width:34px">${ap ? '▾' : '▸'}</button><b class="small">Livello ${i + 1}</b><input type="text" class="ruolo grow" value="${esc(l.ruolo)}" placeholder="Ruolo (es. REC SENIOR)">
              ${ap ? '' : `<span class="muted xs">${(l.obiettivi || []).filter(o => o.testo).length} obiettivi</span>`}
              <button class="btn small" data-pesu="${i}" title="Sposta su" ${i ? '' : 'disabled'}>↑</button><button class="btn small danger" data-pevl="${i}" title="Togli il livello">×</button></div>
            <div ${ap ? '' : 'hidden'} style="margin-top:10px;display:grid;gap:8px">
              <label class="f">Fisso<input type="text" class="fisso" value="${esc(l.fisso)}" placeholder="es. 1530"></label>
              <label class="row small" style="gap:8px"><input type="checkbox" class="fcond" ${l.fissoCond === 'senza_target_pers' ? 'checked' : ''}> Il fisso spetta solo se non raggiunge il target personale</label>
              <label class="f">Variabile <span class="muted xs">· una voce per riga, es. «0,3% sul fatturato mensile a target»</span>${ta('variabile', l.variabile, 'es. 0,25% SUL FATTURATO MENSILE A TARGET', 4)}</label>
              <b class="small">Obiettivi (hard skill)</b>
              ${(l.obiettivi || []).map((o, j) => `<div data-peo="${j}" style="border:1px solid var(--line);border-radius:10px;padding:8px;background:var(--surface);display:grid;gap:6px">
                <div class="row" style="gap:6px"><input type="text" class="testo grow" value="${esc(o.testo)}" placeholder="Obiettivo"><button class="btn small danger" data-pevo="${i}|${j}">×</button></div>
                ${ta('sotto', o.sotto, 'Sotto obiettivi (uno per riga)', 3)}<div class="row" style="gap:6px;flex-wrap:wrap">${ta('soft', o.soft, 'Soft skill', 2)}${ta('scuola', o.scuola, 'Scuola di formazione', 2)}</div></div>`).join('')}
              <button class="btn small" data-pepo="${i}" style="justify-self:start">+ Obiettivo</button></div></div>`; }).join('')}
          <div class="row" style="gap:8px;flex-wrap:wrap"><button class="btn small" id="pePiuL">+ Livello</button><span class="grow"></span>
            ${PG.vista === 'nuovo' ? '' : '<button class="btn danger" id="peVia">Togli il piano</button>'}<button class="btn primary" id="peSalva">${PG.vista === 'nuovo' ? 'Crea il piano' : 'Salva le modifiche'}</button></div></div>`;
      };
      const leggi = () => {
        P.nome = h.querySelector('#peNome').value; P.contratto = h.querySelector('#peContr').value;
        h.querySelectorAll('[data-pel]').forEach(el => { const l = P.livelli[+el.dataset.pel], v = c => el.querySelector('.' + c).value;
          l.ruolo = v('ruolo'); l.fisso = v('fisso'); l.variabile = v('variabile'); l.fissoCond = el.querySelector('.fcond').checked ? 'senza_target_pers' : '';
          el.querySelectorAll('[data-peo]').forEach(oe => { const o = l.obiettivi[+oe.dataset.peo], w = c => oe.querySelector('.' + c).value; o.testo = w('testo'); o.sotto = w('sotto'); o.soft = w('soft'); o.scuola = w('scuola'); }); });
      };
      draw();
      h.onclick = async e => {
        const t = e.target;
        if (t.closest('[data-pg]')) { PG = { vista: t.closest('[data-pg]').dataset.pg }; return gestionePiani(h, r, ricarica); }
        const tb = t.closest('[data-pgtab]'); if (tb) { PG.tab = tb.dataset.pgtab; return gestionePiani(h, r, ricarica); }
        const a = t.closest('[data-peapri]'); if (a) { leggi(); aperto = aperto === +a.dataset.peapri ? null : +a.dataset.peapri; return draw(); }
        if (t.id === 'pePiuL') { leggi(); P.livelli.push({ ruolo: '', fisso: '', variabile: '', obiettivi: [{ testo: '' }] }); aperto = P.livelli.length - 1; return draw(); }
        const su = t.closest('[data-pesu]'); if (su) { leggi(); const i = +su.dataset.pesu; [P.livelli[i - 1], P.livelli[i]] = [P.livelli[i], P.livelli[i - 1]]; aperto = null; return draw(); }
        const vl = t.closest('[data-pevl]'); if (vl) { leggi(); if (!confirm('Togliere questo livello? Le prove già inviate restano archiviate.')) return; P.livelli.splice(+vl.dataset.pevl, 1); aperto = null; return draw(); }
        const po = t.closest('[data-pepo]'); if (po) { leggi(); P.livelli[+po.dataset.pepo].obiettivi.push({ testo: '' }); return draw(); }
        const vo = t.closest('[data-pevo]'); if (vo) { leggi(); const [i, j] = vo.dataset.pevo.split('|').map(Number); P.livelli[i].obiettivi.splice(j, 1); return draw(); }
        if (t.id === 'peVia') { const n = inPiano(p.id).length; if (!confirm(`Togliere il piano «${p.nome}»?${n ? ` ${n} persone resteranno senza piano.` : ''} Resta archiviato con le prove già inviate.`)) return;
          try { await api('DELETE', '/api/sp/admin/piano/' + p.id); toast('Piano tolto.'); PG = { vista: 'elenco' }; ricarica(); } catch (er) { toast(er.message); } return; }
        if (t.id === 'peSalva') { leggi(); t.disabled = true;
          try { const x = await api('PUT', '/api/sp/admin/piano/' + p.id, P); toast(PG.vista === 'nuovo' ? 'Piano creato.' : 'Piano salvato.'); PG = { vista: 'piano', id: x.id, tab: 'vedi' }; ricarica(); } catch (er) { toast(er.message); t.disabled = false; } }
      };
      h.onchange = null;
      return;
    }
  }
  h.onclick = async e => {
    const t = e.target;
    if (t.closest('[data-pg]')) { PG = { vista: t.closest('[data-pg]').dataset.pg, tab: 'vedi' }; return gestionePiani(h, r, ricarica); }
    const ap = t.closest('[data-pgapri]'); if (ap) { PG = { vista: 'piano', id: ap.dataset.pgapri, tab: 'vedi' }; return gestionePiani(h, r, ricarica); }
    const tb = t.closest('[data-pgtab]'); if (tb) { PG.tab = tb.dataset.pgtab; return gestionePiani(h, r, ricarica); }
    if (t.id === 'pgRegS') { try { await api('PUT', '/api/sp/admin/regole', { regole: h.querySelector('#pgReg').value }); toast('Regole salvate.'); } catch (er) { toast(er.message); } return; }
    const via = t.closest('[data-pgvia]');
    if (via) { const x = r.persone.find(y => y.id === via.dataset.pgvia); if (!confirm(`Togliere ${x.nome} da questo piano?`)) return;
      try { await api('PUT', `/api/sp/admin/perf/${x.id}`, { piano: '' }); toast('Tolta dal piano.'); ricarica(); } catch (er) { toast(er.message); } return; }
    if (t.id === 'pgAgg') { const chi = h.querySelector('#pgChi').value; if (!chi) return toast('Scegli la persona.');
      try { await api('PUT', `/api/sp/admin/perf/${chi}`, { piano: PG.id, livello: h.querySelector('#pgLiv').value }); toast('Assegnata.'); ricarica(); } catch (er) { toast(er.message); } }
  };
  h.onchange = async e => {
    const l = e.target.closest('[data-pgliv]');
    if (l) { try { await api('PUT', `/api/sp/admin/perf/${l.dataset.pgliv}`, { piano: PG.id, livello: l.value }); toast('Livello aggiornato.'); ricarica(); } catch (er) { toast(er.message); } }
  };
}

// Carica da Excel: per ogni file scegli se aggiungerlo come piano nuovo o sostituire un piano; poi chi va dove
function pianiExcel(h, r, dopo, testata){
  let F = null, A = null;
  const tipoTag = g => g.tipo === 'perc' ? '<span class="tag ok">automatico</span>' : g.tipo === 'manuale' ? '<span class="tag warn">a mano</span>' : '<span class="tag">nota</span>';
  const draw = () => {
    h.innerHTML = testata('Carica da Excel') + `<div class="card">
      <p class="muted small" style="margin:0 0 10px">Il file «Piano di inserimento e crescita» (colonne ${H7.join(' · ')}). Puoi scegliere più file insieme (es. CCNL e Partita IVA).</p>
      <div class="row" style="gap:8px;flex-wrap:wrap"><label class="btn" style="cursor:pointer">Scegli i file .xlsx<input type="file" id="xlF" accept=".xlsx" multiple hidden></label><span class="small muted grow">${F ? [...F].map(f => esc(f.name)).join(', ') : 'Nessun file scelto'}</span>
        <button class="btn primary" id="xlA" ${F ? '' : 'disabled'}>Anteprima</button></div></div>
      ${A ? `${A.piani.map(p => `<div class="card"><div class="row" style="flex-wrap:wrap;gap:8px"><div class="grow"><b>${esc(p.nome)}</b> <span class="muted small">· ${p.livelli.length} livelli · ${p.livelli.reduce((t, l) => t + l.obiettivi.length, 0)} obiettivi · ${esc(p.file)}</span></div>
          <label class="f" style="min-width:260px">Cosa faccio con questo file?<select data-xm="${esc(p.file)}"><option value="nuovo" ${A.modi[p.file] === 'nuovo' ? 'selected' : ''}>Aggiungilo come piano nuovo</option>
            ${A.esistenti.map(x => `<option value="${x.id}" ${A.modi[p.file] === x.id ? 'selected' : ''}>Sostituisci «${esc(x.nome)}»</option>`).join('')}</select></label></div>
          <details style="margin-top:8px"><summary class="small">Livelli e variabile</summary>${p.livelli.map(l => `<div style="margin-top:8px;padding-top:6px;border-top:1px solid var(--line)"><b class="small">${esc(l.ruolo)}</b> <span class="muted xs">· fisso ${esc(l.fisso || '—')} · ${l.obiettivi.length} obiettivi</span>
            ${l.regole.map(g => `<div class="xs" style="display:flex;gap:8px;align-items:baseline;margin:3px 0">${tipoTag(g)}<span><span class="muted">${esc(g.testo)}</span> → ${esc(g.spiega)}</span></div>`).join('')}</div>`).join('')}</details></div>`).join('')}
        <div class="card"><h3 style="margin:0 0 6px">Chi va dove</h3><p class="xs muted" style="margin:0 0 8px">Se sostituisci un piano, ci sono le sue persone (stesso ruolo, se c'è). Se aggiungi un piano nuovo, le persone del suo contratto che oggi non hanno un piano. «Lascia com'è» non cambia niente.</p>
          ${A.persone.length ? `<div class="tw"><table class="t"><thead><tr><th>Persona</th><th>Adesso</th><th>Dopo</th></tr></thead><tbody>
          ${A.persone.map(x => { const p = A.piani.find(y => y.file === x.file); return `<tr><td><b>${esc(x.nome)}</b><br><span class="xs muted">${esc(x.figura)} · ${x.contratto === 'piva' ? 'P.IVA' : x.contratto === 'dip' ? 'CCNL' : '—'}</span></td><td class="small">${esc(x.da || 'Nessun piano')}</td>
            <td><select data-xs="${esc(x.id)}"><option value="">Lascia com'è</option>${p.livelli.map((l, i) => `<option value="${esc(p.file)}|${i + 1}" ${x.livello === i + 1 ? 'selected' : ''}>${esc(p.nome)} · ${esc(l.ruolo)}</option>`).join('')}</select></td></tr>`; }).join('')}
          </tbody></table></div>` : '<p class="small muted" style="margin:0">Nessuna persona da spostare: le assegni dopo, dal piano → Persone.</p>'}</div>
        <div class="row"><span class="grow"></span><button class="btn" data-pg="elenco">Annulla</button><button class="btn primary" id="xlOk">Conferma</button></div>` : ''}`;
  };
  const fd = () => { const f = new FormData(); [...F].forEach(x => f.append('file', x)); return f; };
  const anteprima = async modi => { const f = fd(); if (modi) f.append('modi', JSON.stringify(modi)); A = await api('POST', '/api/sp/admin/piani/excel/anteprima', undefined, f); draw(); };
  h.onchange = async e => {
    if (e.target.id === 'xlF') { F = e.target.files.length ? e.target.files : null; A = null; return draw(); }
    const m = e.target.closest('[data-xm]'); if (m) { const modi = { ...A.modi, [m.dataset.xm]: m.value }; try { await anteprima(modi); } catch (er) { toast(er.message); } }
  };
  h.onclick = async e => {
    if (e.target.closest('[data-pg]')) { PG = { vista: e.target.closest('[data-pg]').dataset.pg }; return gestionePiani(h, r, dopo); }
    if (e.target.id === 'xlA') { e.target.disabled = true; try { await anteprima(null); } catch (er) { toast(er.message); e.target.disabled = false; } }
    if (e.target.id === 'xlOk') {
      const sost = A.piani.filter(p => A.modi[p.file] !== 'nuovo').map(p => `«${A.esistenti.find(x => x.id === A.modi[p.file])?.nome}» con ${p.file}`);
      if (!confirm(`${sost.length ? 'Sostituisco ' + sost.join(', ') + ' (livelli e obiettivi di prima restano archiviati con le prove già inviate). ' : ''}${A.piani.length - sost.length ? 'Aggiungo ' + (A.piani.length - sost.length) + ' piano nuovo. ' : ''}Confermi?`)) return;
      const scelte = {}; h.querySelectorAll('[data-xs]').forEach(sl => { const [file, lv] = sl.value.split('|'); if (file) scelte[sl.dataset.xs] = { file, livello: lv }; });
      const f = fd(); f.append('modi', JSON.stringify(A.modi)); f.append('scelte', JSON.stringify(scelte)); e.target.disabled = true;
      try { await api('POST', '/api/sp/admin/piani/excel/conferma', undefined, f); toast('Fatto.'); PG = { vista: 'elenco' }; dopo(); } catch (er) { toast(er.message); e.target.disabled = false; }
    }
  };
  draw();
}

// Guadagni del mese (amministratore): per ogni persona accordi presi (dal piano, modificabili), malus con motivo, target personale, voci a mano
let GMESE = null, GAPERTO = null;
async function guadagniAdmin(h){
  let d, az = null;
  try { d = await api('GET', '/api/sp/admin/guadagni' + (GMESE ? '?mese=' + GMESE : '')); } catch (e) { h.innerHTML = `<div class="banner warn">${esc(e.message)}</div>`; return; }
  try { az = await api('GET', '/api/sp/admin/finanza/aziende'); } catch {}
  GMESE = d.mese;
  const eu = n => n == null ? '—' : '€ ' + Number(n).toLocaleString('it-IT', { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: 'always' });
  const nm = x => new Date(x + '-15').toLocaleDateString('it-IT', { month: 'long', year: 'numeric' });
  const riga = x => {
    const s = x.sede || {}, ap = GAPERTO === x.id;
    const man = (x.regole || []).filter(r => r.tipo === 'manuale');
    return `<tr><td><b>${esc(x.nome)}</b><br><span class="xs muted">${esc(x.ruolo || '')} · ${esc(x.piano)}</span></td>
      <td class="small">${s.errore ? `<span class="muted xs">${esc(s.errore)}</span>` : `${s.area ? '<b>Area</b> · ' : ''}${esc((s.nomi || []).join(', '))}<br>${eu(s.fatturato)}${s.pct != null ? ` · <b>${s.pct}%</b>` : ''}
        ${(s.dettaglio || []).map(d => `<br><span class="xs muted">${esc(d.nome)}: ${d.trovata ? eu(d.fatturato) + (d.pct != null ? ' · ' + d.pct + '%' : '') : 'non trovata'}</span>`).join('')}`}</td>
      <td class="small">${x.personale ? `${eu(x.personale.fatt)} · <b>${x.personale.pct ?? '—'}%</b><br><span class="xs muted">target ${String(x.personale.targetPerc).replace('.', ',')}%</span>` : '—'}</td>
      <td style="text-align:right">${eu(x.fisso)}${x.fissoMan != null || x.variabileMan ? '<br><span class="xs muted">accordi modificati</span>' : ''}</td><td style="text-align:right">${eu(x.bonusPagato)}</td>
      <td style="text-align:right">${x.trimestre ? (x.trimestre.fineTrim ? eu(x.trimestre.importo) : `<span class="xs muted">maturato ${eu(x.trimestre.maturato)}</span>`) : '—'}</td>
      <td>${x.malus ? `<span class="tag no" title="${esc(x.malusNota)}">Malus</span>` : '—'}</td><td style="text-align:right;font-weight:800">${eu(x.totale)}</td>
      <td><button class="btn small" data-gap="${esc(x.id)}">${ap ? 'Chiudi' : 'Modifica'}</button></td></tr>
      ${ap ? `<tr><td colspan="9" style="background:var(--sunken)"><div style="display:grid;gap:10px;max-width:760px">
        <div><b class="small">Bonus del mese</b>${(x.bonus || []).map(b => `<div class="small" style="display:flex;justify-content:space-between;gap:10px;padding:3px 0"><span>${esc(b.testo)}<br><span class="xs muted">${esc(b.manuale ? 'a mano' : b.ok ? b.regola : 'non maturato: ' + b.motivo)}</span></span>
          ${b.manuale ? `<input type="text" inputmode="decimal" data-man="${b.id}" value="${b.importo || ''}" placeholder="€" style="width:110px">` : `<b>${eu(b.importo)}</b>`}</div>`).join('') || '<div class="small muted">Nessun bonus nel ruolo.</div>'}</div>
        <label class="row" style="gap:8px"><input type="checkbox" id="gMal" ${x.malus ? 'checked' : ''}><b class="small">Malus questo mese</b> <span class="xs muted">(annulla i bonus del mese e la stessa cifra si toglie dal trimestre)</span></label>
        <label class="f">Motivo del malus <span class="xs muted">· lo legge la persona</span><textarea id="gMalN" rows="2">${esc(x.malusNota || '')}</textarea></label>
        ${x.personale ? `<label class="f" style="max-width:260px">Target personale (% del target della sede)<input type="text" inputmode="decimal" id="gTp" value="${x.personale.targetPerc}" placeholder="35"></label>` : ''}
        <div style="border:1px solid var(--line);border-radius:10px;padding:10px;background:var(--surface)"><b class="small">Accordi presi con ${esc(x.nome)}</b> <span class="xs muted">· arrivano dal piano di crescita (${esc(x.ruolo || '')}); se li cambi qui valgono per questa persona, anche nel calcolo dei bonus</span>
          <div class="row" style="gap:8px;flex-wrap:wrap;align-items:flex-start;margin-top:8px"><label class="f" style="max-width:200px">Fisso (€ al mese)<input type="text" inputmode="decimal" id="gFi" value="${x.fissoMan ?? x.fissoLivello ?? ''}" data-orig="${x.fissoLivello ?? ''}"></label>
            <label class="f grow">Variabile <span class="xs muted">· una voce per riga</span><textarea id="gVa" rows="4" data-orig="${esc(x.variabileLivello || '')}">${esc(x.variabileMan ?? x.variabileLivello ?? '')}</textarea></label></div>
          <div class="row" style="gap:8px"><span class="xs muted grow">${x.fissoMan != null || x.variabileMan ? '<b>Modificati</b> rispetto al piano.' : 'Uguali al piano.'}</span>${x.fissoMan != null || x.variabileMan ? '<button class="btn small" id="gRip" type="button">Rimetti quelli del piano</button>' : ''}</div></div>
        <div class="row"><span class="grow"></span><button class="btn primary" data-gsalva="${esc(x.id)}">Salva</button></div></div></td></tr>` : ''}`;
  };
  h.innerHTML = `<div class="card"><div class="row" style="flex-wrap:wrap;gap:8px;justify-content:space-between"><div><h2 style="margin:0">Guadagni · ${esc(d.nomeMese)}</h2><p class="muted small" style="margin:4px 0 0">Fatturato lordo delle sedi da Gestione finanziaria (target = Budget), fatturato personale dal CRM (€ piano di cura dei preventivi A). Regole dal piano di ogni persona.</p></div>
      <div class="row" style="gap:6px;flex-wrap:wrap">${az ? `<select id="gAz" aria-label="Azienda in Gestione finanziaria"><option value="">Azienda in Gestione finanziaria…</option>${az.aziende.map(a => `<option value="${esc(a.id)}" ${az.scelta === a.id ? 'selected' : ''}>${esc(a.nome)}</option>`).join('')}</select>` : ''}
      <select id="gMese" aria-label="Mese">${d.mesi.map(x => `<option value="${x}" ${x === d.mese ? 'selected' : ''}>${nm(x)}</option>`).join('')}</select></div></div>
    <div class="tw" style="margin-top:12px"><table class="t"><thead><tr><th>Persona</th><th>Sede</th><th>Personale</th><th style="text-align:right">Fisso</th><th style="text-align:right">Bonus mese</th><th style="text-align:right">Trimestre</th><th>Malus</th><th style="text-align:right">Totale</th><th></th></tr></thead>
      <tbody>${d.righe.map(riga).join('') || '<tr><td colspan="9" class="muted">Nessuna persona in un piano da Excel.</td></tr>'}</tbody>
      <tfoot><tr><td colspan="7"><b>Totale</b></td><td style="text-align:right;font-weight:800">${eu(d.totale)}</td><td></td></tr></tfoot></table></div></div>`;
  h.onchange = async e => {
    if (e.target.id === 'gMese') { GMESE = e.target.value; GAPERTO = null; return guadagniAdmin(h); }
    if (e.target.id === 'gAz') { try { await api('PUT', '/api/sp/admin/finanza/azienda', {azienda: e.target.value}); toast('Azienda salvata.'); guadagniAdmin(h); } catch (er) { toast(er.message); } return; }
  };
  h.onclick = async e => {
    if (e.target.id === 'gRip') { $('#gFi').value = $('#gFi').dataset.orig; $('#gVa').value = $('#gVa').dataset.orig; toast('Rimessi quelli del piano: premi Salva.'); return; }
    const g = e.target.closest('[data-gap]'); if (g) { GAPERTO = GAPERTO === g.dataset.gap ? null : g.dataset.gap; return guadagniAdmin(h); }
    const sv = e.target.closest('[data-gsalva]');
    if (sv) {
      const uid = sv.dataset.gsalva, man = {}; h.querySelectorAll('[data-man]').forEach(i => { if (i.value.trim()) man[i.dataset.man] = i.value; });
      sv.disabled = true;
      try {
        await api('PUT', `/api/sp/admin/mese/${uid}`, {mese: GMESE, malus: $('#gMal').checked, malusNota: $('#gMalN').value, targetPerc: $('#gTp')?.value ?? '', manuali: man});
        const fi = $('#gFi'), va = $('#gVa'), norm = v => String(v || '').replace(/\r/g, '').trim(), fN = v => String(v).replace(/\s|€/g, '').replace(',', '.');
        await api('PUT', `/api/sp/admin/perf/${uid}/compenso`, {fisso: fN(fi.value) === fN(fi.dataset.orig) ? '' : fi.value, variabile: norm(va.value) === norm(va.dataset.orig) ? '' : va.value});
        toast('Salvato.'); GAPERTO = null; guadagniAdmin(h);
      } catch (er) { toast(er.message); sv.disabled = false; }
    }
  };
}
/* ---------- documenti: buste paga, CU, contratti ---------- */
let DOCF = { tipo: 'busta' };
async function aDoc(m){
  const r = await api('GET', '/api/sp/admin/doc');
  const nomi = new Map(r.persone.map(p => [p.id, p.nome]));
  const docs = r.docs.filter(d => DOCF.tipo === 'personali' ? ['contratto', 'altro'].includes(d.tipo) : d.tipo === DOCF.tipo);
  const periodi = [...new Set(docs.map(d => d.periodo))];
  const meseDef = meseAdd(oggiG().slice(0, 7), -1);
  const saldiTxt = s => !s ? '<span class="muted xs">lettura in corso…</span>' : s.vuoto && !s.manuale ? '<span class="tag warn">Residui non letti: scrivili con «Residui»</span>'
    : `${s.ferie?.residuo != null ? nume(s.ferie.residuo) + ' ' + (s.ferie.unita === 'ore' ? 'h' : 'gg') + ' ferie' : ''}${s.rol?.residuo != null ? ' · ' + nume(s.rol.residuo) + ' ' + (s.rol.unita === 'giorni' ? 'gg' : 'h') + ' perm.' : ''}${s.exfest?.residuo != null ? ' · ' + nume(s.exfest.residuo) + ' ex fest.' : ''}`;
  const blocco = per => {
    const l = docs.filter(d => d.periodo === per), bozze = l.filter(d => d.stato === 'bozza'), sosp = l.filter(d => d.stato === 'sospesa'), pub = l.filter(d => d.stato === 'pubblicato');
    return `<div class="card"><div class="row"><h2 class="grow" style="margin:0">${DOCF.tipo === 'busta' ? meseLbl(per) : 'CU ' + esc(per)}</h2>${bozze.length ? `<button class="btn primary" data-pubb="${per}">Pubblica ${bozze.length} ${DOCF.tipo === 'busta' ? 'buste' : 'CU'}</button>` : ''}</div>
      ${sosp.length ? `<div class="banner warn" style="margin-top:10px">${sosp.length} pagin${sosp.length > 1 ? 'e' : 'a'} senza codice fiscale riconosciuto: scegli a chi va.</div>${sosp.map(d => `<div class="li"><span class="grow">Pagina ${d.pagina} di «${esc(d.origine)}»</span><a class="btn small" href="/api/sp/doc/${d.id}/file" target="_blank">Guarda</a><select data-ass="${d.id}"><option value="">A chi va?</option>${r.persone.map(p => `<option value="${p.id}" ${d.suggerito === p.id ? 'selected' : ''}>${esc(p.nome)}</option>`).join('')}</select><button class="btn small" data-assok="${d.id}">Assegna</button></div>`).join('')}` : ''}
      ${bozze.length ? `<h3 style="margin-top:12px">Da pubblicare</h3><div class="lista">${bozze.map(d => `<div class="li"><span class="grow"><span class="t">${esc(nomi.get(d.user_id) || '?')}</span><span class="s">${d.pagine} pag.${DOCF.tipo === 'busta' ? ' · ' + saldiTxt(d.saldi) : ''}</span></span><a class="btn small" href="/api/sp/doc/${d.id}/file" target="_blank">Guarda</a>${DOCF.tipo === 'busta' ? `<button class="btn small" data-saldi="${d.id}">Residui</button>` : ''}<button class="btn small danger" data-rit="${d.id}">Togli</button></div>`).join('')}</div>` : ''}
      ${pub.length ? `<h3 style="margin-top:12px">Pubblicate</h3><div class="lista">${pub.map(d => `<div class="li"><span class="grow"><span class="t">${esc(nomi.get(d.user_id) || '?')}</span><span class="s">${d.firmato ? 'firmata ' + fmtDT(d.firmato) + (d.firma_disp ? ' · ' + esc(d.firma_disp) : '') : d.ricevuto ? 'ricevuta confermata ' + fmtDT(d.ricevuto) : d.visto ? 'aperta, da firmare · ' + fmtDT(d.visto) : 'non ancora aperta'}</span></span>${d.firmato ? `<a class="btn small" href="/api/sp/doc/${d.id}/firma" target="_blank" title="Impronta del documento firmato: ${esc(d.firma_impronta || '')}">Vedi firma</a>` : ''}<a class="btn small" href="/api/sp/doc/${d.id}/file" target="_blank">Guarda</a></div>`).join('')}</div>` : ''}</div>`;
  };
  m.innerHTML = `<h1>Documenti</h1><p class="sub">Buste paga e CU si dividono da sole per codice fiscale; i file restano cifrati. Ogni persona vede solo i suoi.</p>
    ${!r.cifra ? '<div class="banner bad">Manca la chiave di cifratura dei documenti su Render: finché non c\'è, non si possono caricare documenti.</div>' : ''}
    <div class="chips" style="margin-bottom:14px">${[['busta', 'Buste paga'], ['cu', 'CU'], ['personali', 'Contratti e altri']].map(([k, t]) => `<button class="chip" data-dt="${k}" aria-pressed="${DOCF.tipo === k}">${t}</button>`).join('')}</div>
    ${DOCF.tipo !== 'personali' ? `<div class="card"><h2>Carica ${DOCF.tipo === 'busta' ? 'le buste paga' : 'le CU'}</h2><p class="muted small" style="margin-top:-4px">Il PDF unico della consulente: la app lo divide per codice fiscale${DOCF.tipo === 'busta' ? ' e legge ferie e ROL residui' : ''}. Controlli e poi pubblichi.</p>
      <div class="row"><label class="f">${DOCF.tipo === 'busta' ? 'Mese' : 'Anno della CU'}${DOCF.tipo === 'busta' ? `<input type="month" id="dPer" value="${meseDef}">` : `<input type="number" id="dPer" value="${new Date().getFullYear()}" min="2020" max="2100" style="width:110px">`}</label>
      <label class="f">File PDF<input type="file" id="dFile" accept="application/pdf,.pdf"></label><button class="btn primary" id="dCarica" style="align-self:flex-end">Carica e dividi</button></div></div>
      ${periodi.map(blocco).join('') || '<p class="muted">Ancora niente.</p>'}`
    : `<div class="card"><h2>Carica un documento per una persona</h2><div class="grid2"><label class="f">Persona<select id="pU">${r.persone.map(p => `<option value="${p.id}">${esc(p.nome)}</option>`).join('')}</select></label>
        <label class="f">Tipo<select id="pT"><option value="contratto">Contratto</option><option value="altro">Altro (attestato, certificato…)</option></select></label>
        <label class="f">Titolo<input type="text" id="pTit" placeholder="es. Contratto di lavoro 2026"></label><label class="f">File PDF<input type="file" id="pFile" accept="application/pdf,.pdf"></label></div>
        <div class="acts"><button class="btn primary" id="pCarica">Carica</button></div></div>
      <div class="card"><h2>Caricati</h2>${docs.length ? `<div class="lista">${docs.map(d => `<div class="li"><span class="grow"><span class="t">${esc(nomi.get(d.user_id) || '?')} · ${esc(d.titolo)}</span><span class="s">${fmtD(d.pubblicato)}${d.firmato ? ' · firmato ' + fmtDT(d.firmato) : d.visto ? ' · aperto, da firmare' : ' · da firmare'}</span></span>${d.firmato ? `<a class="btn small" href="/api/sp/doc/${d.id}/firma" target="_blank">Vedi firma</a>` : ''}<a class="btn small" href="/api/sp/doc/${d.id}/file" target="_blank">Guarda</a><button class="btn small danger" data-rit="${d.id}">Ritira</button></div>`).join('')}</div>` : '<p class="muted small" style="margin:0">Nessuno.</p>'}</div>`}`;
  m.onclick = async e => {
    const dt = e.target.closest('[data-dt]'); if (dt) { DOCF.tipo = dt.dataset.dt; return aDoc(m); }
    const k = ['pubb', 'assok', 'saldi', 'rit'].find(x => e.target.closest(`[data-${x}]`));
    try {
      if (e.target.id === 'dCarica') {
        const f = $('#dFile').files[0]; if (!f) return toast('Scegli il PDF.');
        const fd = new FormData(); fd.append('file', f); fd.append('tipo', DOCF.tipo === 'cu' ? 'cu' : 'busta'); fd.append('periodo', String($('#dPer').value));
        e.target.disabled = true; e.target.textContent = 'Divido…';
        const x = await api('POST', '/api/sp/admin/doc/carica', undefined, fd);
        toast(`${x.pagine} pagine: ${x.divise} persone${x.sospese ? `, ${x.sospese} pagine da assegnare` : ''}.`);
        setTimeout(() => aDoc(m), 2500); return aDoc(m);
      }
      if (e.target.id === 'pCarica') {
        const f = $('#pFile').files[0]; if (!f) return toast('Scegli il PDF.');
        const fd = new FormData(); fd.append('file', f); fd.append('user', $('#pU').value); fd.append('tipo', $('#pT').value); fd.append('titolo', $('#pTit').value);
        await api('POST', '/api/sp/admin/doc/persona', undefined, fd); toast('Caricato: la persona riceve un avviso.'); return aDoc(m);
      }
      if (!k) return;
      const id = e.target.closest(`[data-${k}]`).dataset[k];
      if (k === 'pubb') { if (!confirm('Pubblicare? Le persone ricevono un avviso e i saldi di ferie e permessi si aggiornano.')) return; const x = await api('POST', '/api/sp/admin/doc/pubblica', {tipo: DOCF.tipo, periodo: id}); toast(`Pubblicati ${x.pubblicati} documenti${x.saldi ? `, ${x.saldi} saldi aggiornati` : ''}.`); }
      if (k === 'assok') { const u = m.querySelector(`[data-ass="${id}"]`).value; if (!u) return toast('Scegli la persona.'); await api('POST', `/api/sp/admin/doc/${id}/assegna`, {user: u}); }
      if (k === 'rit') { if (!confirm('Togliere questo documento? Resta archiviato, non si cancella.')) return; await api('POST', `/api/sp/admin/doc/${id}/ritira`, {}); }
      if (k === 'saldi') {
        const d = r.docs.find(x => x.id === id), s = d.saldi || {};
        const og = (r.persone.find(p => p.id === d.user_id)?.ore || 0) / 5;
        const fer = s.ferie?.residuo != null ? (s.ferie.unita === 'ore' && og ? Math.round(s.ferie.residuo / og * 100) / 100 : s.ferie.residuo) : '';
        const per = (s.rol?.residuo != null || s.exfest?.residuo != null) ? Math.round(((s.rol?.unita === 'giorni' ? (s.rol.residuo || 0) * og : (s.rol?.residuo || 0)) + (s.exfest?.unita === 'giorni' ? (s.exfest.residuo || 0) * og : (s.exfest?.residuo || 0))) * 100) / 100 : '';
        const w = finestra(`<h2>Residui di ${esc(nomi.get(d.user_id) || '')}</h2><p class="muted small">Letti dal cedolino: controllali. Diventano il saldo quando pubblichi.</p>
          <div class="grid2"><label class="f">Ferie (giorni)<input type="text" inputmode="decimal" id="sF" value="${nume(fer)}"></label><label class="f">Permessi, ROL + ex festività (ore)<input type="text" inputmode="decimal" id="sP" value="${nume(per)}"></label></div>
          <div class="acts"><button class="btn" id="chiudi">Annulla</button><button class="btn primary" id="ok">Salva</button></div>`);
        w.querySelector('#chiudi').onclick = chiudi;
        w.querySelector('#ok').onclick = async () => { await api('PUT', `/api/sp/admin/doc/${id}/saldi`, {ferie: $('#sF').value, permessi: $('#sP').value}); chiudi(); aDoc(m); };
        return;
      }
      aDoc(m);
    } catch (er) { toast(er.message); aDoc(m); }
  };
}

/* ---------- sedi e tag NFC ---------- */
async function aTag(m){
  const r = await api('GET', '/api/sp/admin/tag');
  const codici = [...new Set(Array.from({length: 15}, (_, i) => String(i + 1).padStart(2, '0')).concat(r.tag.map(t => t.cod)))].sort();
  const tm = new Map(r.tag.map(t => [t.cod, t]));
  m.innerHTML = `<h1>Sedi e tag NFC</h1><p class="sub">Ogni tag ha un codice (01–15). Lo colleghi a una sede: quando qualcuno lo tocca, la timbratura va su quella sede.</p>
    <div class="card"><h2>Come vanno programmati i tag</h2><p class="small">Tag NTAG 424 DNA con <b>SUN/SDM</b> attivo. Indirizzo da scrivere sul tag (ogni tag con il suo codice):</p>
      <p><code style="background:var(--sunken);padding:6px 10px;border-radius:8px;display:inline-block;word-break:break-all">https://turni.appgestione.it/nfc/01?e={PICCData}&amp;c={CMAC}</code></p>
      <p class="muted small">PICCData cifrato con UID e contatore, CMAC su un input vuoto (offset del CMAC uguale all'offset di inizio). ${r.chiaveFabbrica ? 'Per ora la app usa la chiave di fabbrica (tutti zeri): se il fornitore imposta una chiave diversa, va messa su Render come NFC_SDM_KEY.' : 'Chiave personalizzata impostata su Render.'} Il primo tocco registra il tag; da lì in poi quel codice accetta solo quel tag e un link copiato non funziona.</p></div>
    <div class="tw"><table class="t"><thead><tr><th>Tag</th><th>Sede</th><th>Stato</th><th>Ultima lettura</th><th></th></tr></thead><tbody>
    ${codici.map(c => { const t = tm.get(c) || {}; return `<tr><td><b>Tag ${c}</b></td><td><select data-tag="${c}"><option value="">Scorta (non collegato)</option>${r.sedi.map(s => `<option value="${s.id}" ${t.sede === s.id ? 'selected' : ''}>${esc(s.nome)}</option>`).join('')}</select></td>
      <td>${!t.sede ? '<span class="tag">Non collegato</span>' : t.protetto ? `<span class="tag ok">Attivo e protetto ${esc(t.uid)}</span>` : t.ultima ? '<span class="tag warn">Attivo, senza protezione</span>' : '<span class="tag warn">Da attivare: toccalo con il telefono</span>'}</td>
      <td>${t.ultima ? fmtDT(t.ultima) : '—'}</td><td>${t.protetto ? `<button class="btn small" data-reset="${c}">Cambia tag fisico</button>` : ''}</td></tr>`; }).join('')}
    </tbody></table></div>`;
  m.onchange = async e => { const s = e.target.closest('[data-tag]'); if (!s) return; try { await api('PUT', `/api/sp/admin/tag/${s.dataset.tag}`, {sede: s.value}); toast('Salvato.'); aTag(m); } catch (er) { toast(er.message); } };
  m.onclick = async e => { const b = e.target.closest('[data-reset]'); if (!b) return; if (!confirm('Il prossimo tag toccato con questo codice diventerà quello valido (es. tag rotto sostituito con uno di scorta). Continuare?')) return;
    await api('PUT', `/api/sp/admin/tag/${b.dataset.reset}`, {sede: tm.get(b.dataset.reset).sede, reimposta: true}); aTag(m); };
}

/* ---------- attivazione ---------- */
async function aAttiva(m){
  await caricaInfo();
  m.innerHTML = `<h1>Attivazione</h1><p class="sub">Finché è spenta, la Scheda personale la vedono solo gli amministratori.</p>
    <div class="card">${INFO.attiva ? '<div class="banner ok">La Scheda personale è attiva: la vede tutto il personale.</div>' : '<div class="banner warn">La Scheda personale è spenta: il personale non la vede ancora.</div>'}
      <p>Quando la attivi, le persone trovano: Timbra, Assenze, Turni, Performance, Documenti e Info utili. I medici vedono solo Assenze, Turni, Documenti (CU e Contratti) e Info utili.</p>
      <p class="muted small">Dal giorno di attivazione la app controlla le mancate timbrature dei dipendenti (giorni con turno senza timbrature né assenze approvate).</p>
      <button class="btn ${INFO.attiva ? '' : 'primary'}" id="sw">${INFO.attiva ? 'Spegni per tutti' : 'Attiva per tutti'}</button></div>`;
  $('#sw').onclick = async () => {
    if (!INFO.attiva && !confirm('Attivare la Scheda personale per tutto il personale?')) return;
    await api('PUT', '/api/scheda/attiva', {attiva: !INFO.attiva}); toast(INFO.attiva ? 'Spenta.' : 'Attivata.'); aAttiva(m);
  };
}
