/* Scheda personale · amministrazione (menu laterale). Le persone vedono solo la loro parte. */
let ASEZ = 'timbra', AD = {};
const VOCI_ADMIN = [
  ['timbra', 'Timbratura'], ['presenze', 'Report presenze'], ['ore', 'Ore riconosciute'], ['richieste', 'Richieste e saldi'],
  ['persone', 'Persone e contratti'], ['turni', 'Turni di lavoro'], '-', ['branche', 'Branche medici'], ['info', 'Info utili'],
  ['perf', 'Performance'], ['doc', 'Documenti'], '-', ['tag', 'Sedi e tag NFC'], ['attiva', 'Attivazione'],
];
window.avvioAdmin = async function(st){
  const sez = new URLSearchParams(location.search).get('sez');
  const alias = { assenze: 'richieste', doc: 'doc', perf: 'perf', turni: 'turni', persone: 'persone', timbra: 'timbra', richieste: 'richieste' };
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
      <td style="white-space:nowrap">${x.timbrature.map(t => `${t.tipo === 'in' ? '↘' : '↗'} ${t.ora}${t.modo !== 'nfc' ? '*' : ''}`).join('  ')}</td><td>${x.ore ? hm(x.ore) : ''}</td><td><span class="tag ${x.k}">${esc(x.nota)}</span></td></tr>`).join('') || '<tr><td colspan="8" class="muted">Nessun dato nel periodo.</td></tr>'}
    </tbody></table></div><p class="muted xs">↘ ingresso · ↗ uscita · * senza NFC o corretta a mano.</p>`;
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
    <div class="lista">${x.timbrature.map(t => `<div class="li"><span class="grow">${t.tipo === 'in' ? 'Ingresso' : 'Uscita'} <b>${t.ora}</b> ${t.modo !== 'nfc' ? `<span class="tag">${t.modo === 'app' ? 'senza NFC' : 'a mano'}</span>` : ''}${t.nota ? `<span class="s">${esc(t.nota)}</span>` : ''}</span><button class="btn small danger" data-ann="${t.id}">Annulla</button></div>`).join('') || '<p class="muted small">Nessuna timbratura.</p>'}</div>
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
    <div class="tw"><table class="t dense"><thead><tr><th class="stk">Persona</th>${r.giorni.map(g => `<th>${g.w}<br>${g.n}</th>`).join('')}<th>Totale</th><th>Tetto</th><th>F</th><th>P</th><th>M</th><th>AI</th></tr></thead><tbody>
    ${r.righe.map(p => `<tr><td class="stk"><b>${esc(p.nome)}</b><br><span class="muted xs">${esc(p.figura)} · ${p.ore != null ? nume(p.ore) + ' h/sett.' : '<span style="color:var(--bad)">ore mancanti</span>'}</span></td>
      ${p.celle.map((c, i) => `<td class="${r.giorni[i].fest ? 'we' : ''} ${c.cod ? 'c-' + c.cod.replace('*', '') : ''} ${c.corto ? 'corto' : ''}" title="${c.fuori ? 'Timbrato fuori turno' : ''}">${c.min ? hm(c.min) : ''}${c.cod ? (c.min ? '<br>' : '') + c.cod : ''}${c.fuori && !c.min ? '·' : ''}</td>`).join('')}
      <td><b>${hm(p.totale)}</b>${p.oltre ? ' ⤓' : ''}</td><td class="muted">${p.tetto ? hm(p.tetto) : '—'}</td><td>${p.conta.F || ''}</td><td>${p.conta.P || ''}</td><td>${p.conta.M || ''}</td><td>${p.conta.AI || ''}</td></tr>`).join('') || `<tr><td class="stk muted" colspan="${r.giorni.length + 7}">Nessun dipendente con questi filtri. Controlla in Persone e contratti chi è dipendente.</td></tr>`}
    </tbody></table></div>
    <p class="muted xs">F ferie · P permesso · M malattia · AI assenza ingiustificata · * scalato in automatico per mancata timbratura · in arancio i giorni con meno ore del turno · ⤓ tagliato al tetto del contratto.</p>`;
  m.onchange = e => { if (e.target.id === 'fSede') FILTRI.sede = e.target.value; if (e.target.id === 'fFig') FILTRI.figura = e.target.value; aOre(m); };
  $('#oPrev').onclick = () => { MESE_A = meseAdd(MESE_A, -1); aOre(m); };
  $('#oNext').onclick = () => { MESE_A = meseAdd(MESE_A, 1); aOre(m); };
}

/* ---------- richieste e saldi ---------- */
async function aRichieste(m){
  const r = await api('GET', '/api/sp/admin/richieste');
  const rich = x => `<div class="li"><span class="grow"><span class="t">${esc(x.nome)} · ${esc(x.desc)}</span><span class="s">${x.quanti != null ? (x.tipo === 'ferie' ? nume(x.quanti) + ' giorni' : nume(x.quanti) + ' ore') + ' · ' : ''}${x.sostNome ? `sostituto ${esc(x.sostNome)} · ${x.sostOk ? 'ha accettato' : x.sostOk === false ? 'ha rifiutato' : 'in attesa'}` : 'senza sostituto'}${x.nota ? ' · ' + esc(x.nota) : ''}</span></span>`;
  m.innerHTML = `<div class="row"><h1 class="grow">Richieste e saldi</h1><button class="btn" id="regAss">+ Registra un'assenza</button></div>
    <p class="sub">Approvando, ferie e permessi si scalano dal saldo e i turni passano al sostituto.</p>
    <div class="card"><h2>Da approvare</h2>${r.aperte.length ? `<div class="lista">${r.aperte.map(x => rich(x) + (x.stato === 'attesa_admin' ? `<button class="btn small primary" data-ok="${x.id}">Approva</button><button class="btn small" data-no="${x.id}">Rifiuta</button>` : '<span class="tag warn">Aspetta il sostituto</span><button class="btn small" data-no="' + x.id + '">Rifiuta</button>') + '</div>').join('')}</div>` : '<p class="muted small" style="margin:0">Nessuna richiesta in attesa.</p>'}</div>
    <div class="card"><h2>Saldi dei dipendenti</h2><p class="muted small" style="margin-top:-4px">Il saldo arriva dalla busta paga pubblicata; qui puoi impostarlo o correggerlo a mano.</p>
      <div class="tw"><table class="t"><thead><tr><th>Persona</th><th>Ruolo</th><th>Ferie</th><th>Permessi</th><th></th></tr></thead><tbody>
      ${r.saldi.map(s => `<tr><td><b>${esc(s.nome)}</b></td><td>${esc(s.figura)}</td><td>${s.base.ferie ? nume(s.ferie) + ' gg' : '<span class="muted">—</span>'}</td><td>${s.base.permessi ? nume(s.permessi) + ' h' : '<span class="muted">—</span>'}</td><td><button class="btn small" data-mov="${s.id}">Movimenti</button></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Nessun dipendente indicato in Persone e contratti.</td></tr>'}
      </tbody></table></div></div>
    <div class="card"><h2>Mancate timbrature</h2><p class="muted small" style="margin-top:-4px">Giorno di turno senza timbrature e senza assenza approvata: prima si scalano le ferie, poi i permessi, altrimenti è assenza ingiustificata.</p>
      ${r.mancate.length ? `<div class="lista">${r.mancate.map(x => `<div class="li"><span class="grow"><span class="t">${esc(x.nome)} · ${fmtG(x.giorno)}</span><span class="s">${x.esito === 'ferie' ? '1 giorno di ferie scalato' : x.esito === 'permessi' ? nume(x.valore) + ' ore di permesso scalate' : 'assenza ingiustificata'}</span></span>${x.annullata ? '<span class="tag">Annullata</span>' : `<button class="btn small" data-annm="${x.user}|${x.giorno}">Annulla</button>`}</div>`).join('')}</div>` : '<p class="muted small" style="margin:0">Nessuna negli ultimi 45 giorni.</p>'}</div>
    <div class="card"><h2>Decise di recente</h2>${r.recenti.length ? `<div class="lista">${r.recenti.map(x => rich(x) + `<span class="tag ${x.stato === 'approvata' ? 'ok' : 'no'}">${x.stato === 'approvata' ? 'Approvata' : 'Rifiutata'}</span></div>`).join('')}</div>` : '<p class="muted small" style="margin:0">Niente.</p>'}</div>`;
  m.onclick = async e => {
    const ok = e.target.closest('[data-ok]'), no = e.target.closest('[data-no]'), mv = e.target.closest('[data-mov]'), am = e.target.closest('[data-annm]');
    try {
      if (ok || no) { const nota = no ? (prompt('Motivo del rifiuto (facoltativo)') ?? null) : ''; if (nota === null) return; await api('POST', `/api/sp/admin/richieste/${(ok || no).dataset[ok ? 'ok' : 'no']}`, {ok: !!ok, nota}); toast(ok ? 'Approvata.' : 'Rifiutata.'); return ridisegna(); }
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
function registraAssenza(persone, dopo){
  const d = finestra(`<h2>Registra un'assenza</h2><p class="muted small">Viene registrata già approvata e la persona riceve un avviso.</p>
    <div class="grid2"><label class="f">Persona<select id="rU">${persone.map(p => `<option value="${p.id}">${esc(p.nome)}</option>`).join('')}</select></label>
      <label class="f">Tipo<select id="rT"><option value="ferie">Ferie</option><option value="permesso">Permesso (ore)</option><option value="malattia">Malattia</option><option value="altro">Altra assenza</option></select></label>
      <label class="f">Dal<input type="date" id="rDal" value="${oggiG()}"></label><label class="f">Al<input type="date" id="rAl" value="${oggiG()}"></label>
      <label class="f">Dalle (permesso)<input type="time" id="rDa" value="16:00"></label><label class="f">Alle (permesso)<input type="time" id="rA" value="18:30"></label>
      <label class="f">Sostituto<select id="rS"><option value="">Nessuno</option>${persone.map(p => `<option value="${p.id}">${esc(p.nome)}</option>`).join('')}</select></label><label class="f">Nota<input type="text" id="rN"></label></div>
    <div class="acts"><button class="btn" id="chiudi">Annulla</button><button class="btn primary" id="salva">Registra</button></div>`);
  d.querySelector('#chiudi').onclick = chiudi;
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

/* ---------- info utili (orari, policy, regolamento) ---------- */
async function aInfo(m){
  await caricaInfo();
  const S2 = INFO, reg = S2.docs.find(d => d.tipo === 'regolamento'), pol = S2.docs.filter(d => d.tipo === 'policy');
  m.innerHTML = `<h1>Info utili</h1><p class="sub">Quello che il personale trova nella sezione Info utili.</p>
    <div class="card"><h2>Orari delle sedi</h2><p class="muted small" style="margin-top:-4px">Ogni persona vede solo gli orari delle sedi in cui lavora.</p>
      <div class="chips" id="sediOr">${S2.sedi.map((s, i) => `<button class="chip" data-s="${s.id}" aria-pressed="${i === 0}">${esc(s.nome)}</button>`).join('')}</div>
      <div id="orEd" style="margin-top:14px"></div></div>
    <div class="card"><div class="row"><h2 class="grow" style="margin:0">Policy aziendali</h2><button class="btn small primary" id="nuovaPol">+ Carica policy</button></div>
      <div class="lista" style="margin-top:8px">${pol.length ? pol.map(d => `<div class="li"><span class="grow"><span class="t">${esc(d.titolo)}</span><span class="s">Versione ${d.versione} · ${fmtD(d.caricato)}</span></span>
        <button class="btn small" data-apri="${d.id}">Apri</button><button class="btn small" data-sost="${d.id}">Sostituisci</button><button class="btn small danger" data-togli="${d.id}">Togli</button></div>`).join('') : '<p class="muted">Nessuna policy caricata.</p>'}</div></div>
    <div class="card"><div class="row"><h2 class="grow" style="margin:0">Regolamento aziendale</h2><button class="btn small primary" id="nuovoReg">${reg ? 'Carica nuova versione' : '+ Carica regolamento'}</button></div>
      ${reg ? `<div class="li" style="margin-top:8px"><span class="grow"><span class="t">${esc(reg.titolo)}</span><span class="s">Versione ${reg.versione} · ${fmtD(reg.caricato)} · letto e accettato da ${S2.regLetti || 0} su ${S2.persone}</span></span>
        <button class="btn small" data-apri="${reg.id}">Apri</button><button class="btn small" data-letture="${reg.id}">Chi ha letto</button></div>
        <p class="muted small">Quando carichi una nuova versione, tutti devono rileggerla e accettarla di nuovo.</p><div id="letture"></div>` : '<p class="muted">Non ancora caricato.</p>'}</div>
    <input type="file" id="file" accept=".pdf,.docx,application/pdf" hidden>`;
  const sedeOr = id => { m.querySelectorAll('#sediOr .chip').forEach(c => c.setAttribute('aria-pressed', c.dataset.s === id)); editorOrari(S2.sedi.find(s => s.id === id)); };
  $('#sediOr').onclick = e => { const c = e.target.closest('[data-s]'); if (c) sedeOr(c.dataset.s); };
  if (S2.sedi[0]) editorOrari(S2.sedi[0]);
  let car = null;
  const scegli = (tipo, sost) => { car = {tipo, sost}; $('#file').value = ''; $('#file').click(); };
  $('#nuovaPol').onclick = () => scegli('policy');
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
    const a = e.target.closest('[data-apri]'), s = e.target.closest('[data-sost]'), t = e.target.closest('[data-togli]'), l = e.target.closest('[data-letture]');
    if (a) apriDocInfo(S2.docs.find(d => d.id === a.dataset.apri));
    if (s) scegli('policy', s.dataset.sost);
    if (t && confirm('Togliere questa policy? Non la vedrà più nessuno, ma resta archiviata.')) { await api('DELETE', `/api/scheda/doc/${t.dataset.togli}`); toast('Policy tolta.'); aInfo(m); }
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
let PTAB = 'approva';
async function aPerf(m){
  const r = await api('GET', '/api/sp/admin/perf');
  if (PTAB === 'approva' && !r.dati.length && !r.passaggi.length) PTAB = r.piani.length ? 'ruoli' : 'piani';
  const tabs = [['approva', `Da approvare${r.dati.length + r.passaggi.length ? ' (' + (r.dati.length + r.passaggi.length) + ')' : ''}`], ['ruoli', 'Persone e ruoli'], ['piani', 'Piani di carriera']];
  let corpo = '';
  if (PTAB === 'approva') corpo = `<div class="card"><h2>Dati inviati dalle persone</h2>${r.dati.length ? `<div class="lista">${r.dati.map(d => `<div class="li"><span class="grow"><span class="t">${esc(d.nome)} · ${esc(d.obiettivo)}</span><span class="s">«${esc(d.dato)}» · ${fmtDT(d.il)}</span></span><button class="btn small primary" data-dok="${d.id}">Dai il pass</button><button class="btn small" data-dno="${d.id}">Non approvare</button></div>`).join('')}</div>` : '<p class="muted small" style="margin:0">Niente da verificare.</p>'}</div>
    <div class="card"><h2>Passaggi di ruolo</h2>${r.passaggi.length ? `<div class="lista">${r.passaggi.map(x => `<div class="li"><span class="grow"><span class="t">${esc(x.nome)}: ${esc(x.da)} → ${esc(x.a)}</span><span class="s">Tutti i pass raggiunti${x.bonus ? ' · bonus ' + esc(x.bonus) : ''}</span></span><button class="btn small primary" data-pok="${x.id}">Approva</button><button class="btn small" data-pno="${x.id}">Rimanda</button></div>`).join('')}</div>` : '<p class="muted small" style="margin:0">Nessun passaggio in attesa.</p>'}</div>`;
  if (PTAB === 'ruoli') corpo = `<div class="card"><p class="muted small" style="margin-top:0">Dai a ogni persona il suo piano e il ruolo attuale. Lei vede gli obiettivi del ruolo successivo e invia i suoi dati.</p>
    ${r.piani.length ? `<div class="tw"><table class="t"><thead><tr><th>Persona</th><th>Piano</th><th>Ruolo attuale</th><th>Verso</th><th>Pass</th></tr></thead><tbody>${r.persone.map(p => { const pi = r.piani.find(x => x.id === p.piano);
      return `<tr><td><b>${esc(p.nome)}</b><br><span class="muted xs">${esc(p.figura)}</span></td><td><select data-piano="${p.id}"><option value="">—</option>${r.piani.map(x => `<option value="${x.id}" ${p.piano === x.id ? 'selected' : ''}>${esc(x.nome)}</option>`).join('')}</select></td>
      <td>${pi ? `<select data-liv="${p.id}">${pi.livelli.map(l => `<option value="${l.n}" ${p.livello === l.n ? 'selected' : ''}>${esc(l.ruolo)}</option>`).join('')}</select>` : ''}</td>
      <td>${p.stato?.prossimo ? esc(p.stato.prossimo.ruolo) : p.stato ? '<span class="muted">ultimo livello</span>' : ''}</td><td>${p.stato?.prossimo ? `${p.stato.pass} su ${p.stato.obiettivi.length}` : ''}</td></tr>`; }).join('')}</tbody></table></div>` : '<p class="muted">Prima crea un piano di carriera.</p>'}</div>`;
  if (PTAB === 'piani') corpo = `<div id="pianiEd"></div>`;
  m.innerHTML = `<h1>Performance</h1><p class="sub">Piani di carriera con ruoli, obiettivi e bonus. Le persone inviano i loro dati, tu dai i pass; con tutti i pass il passaggio di ruolo va approvato.</p>
    <div class="chips" style="margin-bottom:14px">${tabs.map(([k, t]) => `<button class="chip" data-pt="${k}" aria-pressed="${PTAB === k}">${t}</button>`).join('')}</div>${corpo}`;
  if (PTAB === 'piani') editorPiani($('#pianiEd'), r.piani, () => aPerf(m), r.regole);
  m.onclick = async e => {
    const t = e.target.closest('[data-pt]'); if (t) { PTAB = t.dataset.pt; return aPerf(m); }
    const k = ['dok', 'dno', 'pok', 'pno'].find(x => e.target.closest(`[data-${x}]`));
    if (!k) return;
    const id = e.target.closest(`[data-${k}]`).dataset[k];
    try {
      if (k[0] === 'd') { const nota = k === 'dno' ? prompt('Perché non lo approvi? (lo legge la persona)') : ''; if (nota === null) return; await api('POST', `/api/sp/admin/perf/dato/${id}`, {ok: k === 'dok', nota}); }
      else await api('POST', `/api/sp/admin/passaggi/${id}`, {ok: k === 'pok'});
      toast('Fatto.'); ridisegna();
    } catch (er) { toast(er.message); }
  };
  m.onchange = async e => {
    const p = e.target.closest('[data-piano]'), l = e.target.closest('[data-liv]');
    try {
      if (p) await api('PUT', `/api/sp/admin/perf/${p.dataset.piano}`, {piano: p.value});
      if (l) await api('PUT', `/api/sp/admin/perf/${l.dataset.liv}`, {piano: r.persone.find(x => x.id === l.dataset.liv).piano, livello: l.value});
      aPerf(m);
    } catch (er) { toast(er.message); }
  };
}
function editorPiani(h, piani, dopo, regole){
  let P = JSON.parse(JSON.stringify(piani)), sel = 0, R = regole || '', apertoL = null;
  const nuovoL = () => ({ruolo: '', bonus: '', fisso: '', variabile: '', area: '', skill: [], obiettivi: [{testo: '', misura: ''}]});
  const ta = (cls, v, ph, rows = 3) => `<textarea class="${cls}" rows="${rows}" placeholder="${ph}" style="width:100%;resize:vertical">${esc(v || '')}</textarea>`;
  const draw = () => {
    const p = P[sel];
    h.innerHTML = `<div class="card"><div class="row" style="flex-wrap:wrap;gap:6px"><div class="chips grow">${P.map((x, i) => `<button class="chip" data-sel="${i}" aria-pressed="${i === sel}">${esc(x.nome || 'Nuovo piano')}</button>`).join('')}<button class="chip" id="nuovoP">+ Nuovo piano</button></div>
        <button class="btn small" id="modello" title="Carica qui il piano di crescita To Smile 2025 (dal documento ufficiale): poi controlli e salvi">Carica il piano di crescita To Smile</button></div></div>
      <details class="card" ${R ? '' : 'open'}><summary><b>Regole del piano di crescita</b> <span class="muted small">· le vede ogni persona nella sua Performance</span></summary>
        <div style="margin-top:8px">${ta('regole', R, 'Regole valide per tutti i piani (passaggi, retrocessioni, incentivi, note di credito…)', 10)}</div></details>
      ${p ? `<div class="card"><label class="f">Nome del piano<input type="text" id="pNome" value="${esc(p.nome)}" placeholder="es. ASO"></label>
        <p class="muted small">Il livello 1 è il ruolo di ingresso (es. in training). Per ogni livello: compenso, competenze da sviluppare e gli obiettivi (pass) per arrivarci. Tocca un livello per aprirlo.</p>
        ${p.livelli.map((l, i) => { const ap = apertoL === i; return `<div class="card" style="background:var(--sunken);box-shadow:none" data-l="${i}">
          <div class="row"><button class="btn small" data-apri="${i}" aria-expanded="${ap}" style="min-width:34px">${ap ? '▾' : '▸'}</button><b>Livello ${i + 1}</b><input type="text" class="ruolo grow" value="${esc(l.ruolo)}" placeholder="Ruolo">
            ${ap ? '' : `<span class="muted xs">${esc(l.fisso || '')}${i ? ' · ' + (l.obiettivi || []).filter(o => o.testo).length + ' obiettivi' : ''}</span>`}<button class="btn small danger" data-vl="${i}">×</button></div>
          <div ${ap ? '' : 'hidden'} style="margin-top:10px;display:grid;gap:8px">
            <div class="row" style="flex-wrap:wrap"><label class="f grow">Compenso fisso<input type="text" class="fisso" value="${esc(l.fisso)}" placeholder="es. 1.530 € netti/mese (13ª e 14ª incluse)"></label>
              <label class="f grow">Bonus al passaggio<input type="text" class="bonus" value="${esc(l.bonus)}" placeholder="${i ? 'facoltativo' : 'livello di ingresso'}" ${i ? '' : 'disabled'}></label></div>
            <label class="f">Compenso variabile (%) <span class="muted xs">· una voce per riga</span>${ta('variabile', l.variabile, 'es. 1% su porta pazienti')}</label>
            <label class="f">Compenso di area${ta('area', l.area, 'facoltativo', 2)}</label>
            <label class="f">Hard skill da sviluppare <span class="muted xs">· una per riga</span>${ta('skill', (l.skill || []).join('\n'), 'es. Time management', 4)}</label>
            ${i ? `<div><b class="small">Obiettivi da raggiungere (pass per diventare ${esc(l.ruolo || 'questo ruolo')})</b>
              <div style="margin-top:6px">${l.obiettivi.map((o, j) => `<div class="row" data-o="${j}" style="margin-bottom:6px"><input type="text" class="testo grow" value="${esc(o.testo)}" placeholder="Obiettivo"><input type="text" class="misura" value="${esc(o.misura)}" placeholder="Come si misura (facoltativo)"><button class="btn small danger" data-vo="${i}|${j}">×</button></div>`).join('')}
              <button class="btn small" data-po="${i}">+ Obiettivo</button></div></div>` : ''}
          </div></div>`; }).join('')}
        <div class="row"><button class="btn small" id="piuL">+ Livello</button><span class="grow"></span><button class="btn danger" id="viaP">Togli il piano</button><button class="btn primary" id="salvaP">Salva i piani</button></div></div>`
      : '<div class="card"><p class="muted">Nessun piano. Carica quello ufficiale con «Carica il piano di crescita To Smile» oppure crea il primo con «+ Nuovo piano».</p><div class="row"><span class="grow"></span><button class="btn primary" id="salvaP">Salva</button></div></div>'}`;
  };
  const leggi = () => {
    const rg = h.querySelector('.regole'); if (rg) R = rg.value;
    const p = P[sel]; if (!p) return;
    p.nome = h.querySelector('#pNome').value;
    h.querySelectorAll('[data-l]').forEach(el => { const l = p.livelli[+el.dataset.l]; const v = c => el.querySelector('.' + c).value;
      l.ruolo = v('ruolo'); l.bonus = v('bonus'); l.fisso = v('fisso'); l.variabile = v('variabile'); l.area = v('area');
      l.skill = v('skill').split('\n').map(x => x.trim()).filter(Boolean);
      el.querySelectorAll('[data-o]').forEach(oe => { const o = l.obiettivi[+oe.dataset.o]; o.testo = oe.querySelector('.testo').value; o.misura = oe.querySelector('.misura').value; }); });
  };
  h.onclick = async e => {
    const s = e.target.closest('[data-sel]'); if (s) { leggi(); sel = +s.dataset.sel; apertoL = null; return draw(); }
    const ap = e.target.closest('[data-apri]'); if (ap) { leggi(); apertoL = apertoL === +ap.dataset.apri ? null : +ap.dataset.apri; return draw(); }
    if (e.target.id === 'modello') {
      leggi();
      const m = await api('GET', '/api/sp/admin/piani/modello');
      const gia = new Set(P.map(x => x.nome.trim().toLowerCase())), nuovi = m.piani.filter(x => !gia.has(x.nome.trim().toLowerCase()));
      if (!confirm(`Carico il piano di crescita To Smile: ${nuovi.length} piani${nuovi.length < m.piani.length ? ` (${m.piani.length - nuovi.length} già presenti con lo stesso nome restano come sono)` : ''}${!R.trim() ? ' e le regole' : ''}.\n\nPoi controlla e premi «Salva i piani».`)) return;
      nuovi.forEach(x => P.push({ nome: x.nome, livelli: x.livelli.map(l => ({ ...l, bonus: '', obiettivi: l.obiettivi.map(t => ({testo: t, misura: ''})) })) }));
      if (!R.trim()) R = m.regole;
      sel = Math.max(0, P.length - nuovi.length); apertoL = null; draw(); toast('Caricato: controlla e premi «Salva i piani».'); return;
    }
    if (e.target.id === 'nuovoP') { leggi(); P.push({nome: '', livelli: [{...nuovoL(), obiettivi: []}, nuovoL()]}); sel = P.length - 1; apertoL = 0; return draw(); }
    if (e.target.id === 'piuL') { leggi(); P[sel].livelli.push(nuovoL()); apertoL = P[sel].livelli.length - 1; return draw(); }
    const vl = e.target.closest('[data-vl]'); if (vl) { leggi(); P[sel].livelli.splice(+vl.dataset.vl, 1); apertoL = null; return draw(); }
    const po = e.target.closest('[data-po]'); if (po) { leggi(); P[sel].livelli[+po.dataset.po].obiettivi.push({testo: '', misura: ''}); return draw(); }
    const vo = e.target.closest('[data-vo]'); if (vo) { leggi(); const [i, j] = vo.dataset.vo.split('|').map(Number); P[sel].livelli[i].obiettivi.splice(j, 1); return draw(); }
    if (e.target.id === 'viaP') { if (!confirm('Togliere questo piano? Resta archiviato con i dati già inviati.')) return; P.splice(sel, 1); sel = 0; }
    if (e.target.id === 'salvaP' || e.target.id === 'viaP') {
      if (e.target.id === 'salvaP') leggi();
      try { await api('PUT', '/api/sp/admin/piani', {piani: P, regole: R}); toast('Piani salvati.'); dopo(); } catch (er) { toast(er.message); }
    }
  };
  draw();
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
      ${pub.length ? `<h3 style="margin-top:12px">Pubblicate</h3><div class="lista">${pub.map(d => `<div class="li"><span class="grow"><span class="t">${esc(nomi.get(d.user_id) || '?')}</span><span class="s">${d.ricevuto ? 'ricevuta confermata ' + fmtDT(d.ricevuto) : d.visto ? 'aperta ' + fmtDT(d.visto) : 'non ancora aperta'}</span></span><a class="btn small" href="/api/sp/doc/${d.id}/file" target="_blank">Guarda</a></div>`).join('')}</div>` : ''}</div>`;
  };
  m.innerHTML = `<h1>Documenti</h1><p class="sub">Buste paga e CU si dividono da sole per codice fiscale; i file restano cifrati. Ogni persona vede solo i suoi.</p>
    ${!r.cifra ? '<div class="banner bad">Manca la chiave di cifratura dei documenti su Render: finché non c\'è, non si possono caricare documenti.</div>' : ''}
    <div class="chips" style="margin-bottom:14px">${[['busta', 'Buste paga'], ['cu', 'CU'], ['personali', 'Contratti e altri']].map(([k, t]) => `<button class="chip" data-dt="${k}" aria-pressed="${DOCF.tipo === k}">${t}</button>`).join('')}</div>
    ${DOCF.tipo !== 'personali' ? `<div class="card"><h2>Carica ${DOCF.tipo === 'busta' ? 'le buste paga' : 'le CU'}</h2><p class="muted small" style="margin-top:-4px">Il PDF unico della consulente: la app lo divide per codice fiscale${DOCF.tipo === 'busta' ? ' e legge ferie e permessi residui' : ''}. Controlli e poi pubblichi.</p>
      <div class="row"><label class="f">${DOCF.tipo === 'busta' ? 'Mese' : 'Anno della CU'}${DOCF.tipo === 'busta' ? `<input type="month" id="dPer" value="${meseDef}">` : `<input type="number" id="dPer" value="${new Date().getFullYear()}" min="2020" max="2100" style="width:110px">`}</label>
      <label class="f">File PDF<input type="file" id="dFile" accept="application/pdf,.pdf"></label><button class="btn primary" id="dCarica" style="align-self:flex-end">Carica e dividi</button></div></div>
      ${periodi.map(blocco).join('') || '<p class="muted">Ancora niente.</p>'}`
    : `<div class="card"><h2>Carica un documento per una persona</h2><div class="grid2"><label class="f">Persona<select id="pU">${r.persone.map(p => `<option value="${p.id}">${esc(p.nome)}</option>`).join('')}</select></label>
        <label class="f">Tipo<select id="pT"><option value="contratto">Contratto</option><option value="altro">Altro (attestato, certificato…)</option></select></label>
        <label class="f">Titolo<input type="text" id="pTit" placeholder="es. Contratto di lavoro 2026"></label><label class="f">File PDF<input type="file" id="pFile" accept="application/pdf,.pdf"></label></div>
        <div class="acts"><button class="btn primary" id="pCarica">Carica</button></div></div>
      <div class="card"><h2>Caricati</h2>${docs.length ? `<div class="lista">${docs.map(d => `<div class="li"><span class="grow"><span class="t">${esc(nomi.get(d.user_id) || '?')} · ${esc(d.titolo)}</span><span class="s">${fmtD(d.pubblicato)}${d.visto ? ' · aperto' : ''}</span></span><a class="btn small" href="/api/sp/doc/${d.id}/file" target="_blank">Guarda</a><button class="btn small danger" data-rit="${d.id}">Ritira</button></div>`).join('')}</div>` : '<p class="muted small" style="margin:0">Nessuno.</p>'}</div>`}`;
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
