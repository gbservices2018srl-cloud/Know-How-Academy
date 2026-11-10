/* Scheda personale · parte della persona: Timbra, Assenze, Turni, Performance, Documenti, Info utili.
   Il medico vede solo Assenze, Turni, Documenti (CU e Contratti) e Info utili. */
let ME = null, USEZ = 'timbra', MESE_U = null;

async function caricaMe(){ ME = await api('GET', '/api/sp/me'); return ME; }
function sezioniUtente(){
  const m = ME.me;
  if (m.medico) return [['assenze', 'Assenze'], ['turni', 'Turni'], ['doc', 'Documenti'], ['info', 'Info utili']];
  return [['timbra', 'Timbra'], ['assenze', 'Assenze'], ['turni', 'Turni'], ['perf', 'Performance'], ['doc', 'Documenti'], ['info', 'Info utili']];
}
window.avvioUtente = async function(st){
  try { await caricaMe(); } catch (e) { $('#main').innerHTML = `<div class="card">${esc(e.message)}</div>`; return; }
  $('#shell').classList.add('u');
  const sez = new URLSearchParams(location.search).get('sez');
  const voci = sezioniUtente().map(x => x[0]);
  USEZ = voci.includes(sez) ? sez : voci[0];
  disegnaUtente();
};
function navUtente(){
  const n = $('#unav'); n.hidden = false;
  const badge = { assenze: ME.sostituzioni.filter(r => r.stato === 'attesa_sost').length, info: INFO.docs.some(d => d.tipo === 'regolamento' && !d.letto) ? 1 : 0,
    doc: ME.docs.some(d => d.tipo === 'busta' && !d.ricevuto) ? 1 : 0 };
  n.innerHTML = sezioniUtente().map(([k, t]) => `<button data-u="${k}" aria-selected="${k === USEZ}"><span class="${badge[k] ? 'dot' : ''}">${svg(k)}</span><span>${t}</span></button>`).join('');
  n.onclick = e => { const b = e.target.closest('[data-u]'); if (b) { USEZ = b.dataset.u; history.replaceState(null, '', '/?sez=' + USEZ); disegnaUtente(); scrollTo(0, 0); } };
}
async function disegnaUtente(){
  navUtente();
  const m = $('#main'); m.className = 'u-wrap'; m.onclick = null; m.onchange = null;
  // primo accesso: dipendente o partita IVA (i medici no)
  if (!ME.me.medico && !ME.me.onb && !ME.me.tipoOk && USEZ !== 'info') return vistaOnb(m);
  const f = { timbra: vistaTimbra, assenze: vistaAssenze, turni: vistaTurniU, perf: vistaPerfU, doc: vistaDocU, info: vistaInfo }[USEZ];
  try { await f(m); } catch (e) { m.innerHTML = `<div class="card">${esc(e.message)}</div>`; }
}
async function ricarica(){ await caricaMe(); disegnaUtente(); }

/* ---------- primo accesso ---------- */
function vistaOnb(m, modifica){
  let tipo = ME.me.tipo || 'dip';
  const draw = () => {
    m.innerHTML = `<div class="card"><span class="tag info">${modifica ? 'Il mio contratto' : 'Primo accesso'}</span><h2 style="margin-top:10px">Come lavori con noi?</h2>
      <p class="muted small">Lo chiediamo una volta sola. L'amministrazione lo controlla e lo può correggere.</p>
      <div class="chips" style="margin:6px 0 14px">${[['dip', 'Dipendente'], ['piva', 'Partita IVA']].map(([k, t]) => `<button class="chip" data-t="${k}" aria-pressed="${tipo === k}" style="flex:1;min-height:46px">${t}</button>`).join('')}</div>
      ${tipo === 'dip' ? `<label class="f">Ore settimanali da contratto<input id="ore" type="text" inputmode="decimal" value="${esc(ME.me.ore ?? '')}" placeholder="per esempio 32" style="max-width:160px;font-size:20px;font-weight:800"></label>
        <p class="muted xs">Scrivi il numero esatto del tuo contratto (per esempio 32, 31 o 27). I giorni e gli orari li trovi nei Turni.</p>`
      : `<p class="muted small">Per i collaboratori a partita IVA si registrano le timbrature, ma non si calcolano ore da contratto, ferie e permessi.</p>`}
      <button class="btn primary big" id="salva" style="margin-top:10px">Salva e continua</button></div>`;
    m.querySelectorAll('[data-t]').forEach(b => b.onclick = () => { tipo = b.dataset.t; draw(); });
    $('#salva').onclick = async () => {
      try { const r = await api('POST', '/api/sp/onb', {tipo, ore: $('#ore')?.value}); if (r.bloccato) toast('L\'amministrazione ha già confermato il tuo contratto.'); await ricarica(); }
      catch (e) { toast(e.message); }
    };
  };
  draw();
}

/* ---------- timbratura ---------- */
async function vistaTimbra(m){
  const t = ME.timbrature, ultima = t[t.length - 1], dentro = ultima?.tipo === 'in';
  const me = ME.me;
  m.innerHTML = `${pushBanner()}
    <div class="stato ${dentro ? 'in' : ''}"><span class="k">Oggi, ${fmtG(ME.oggi)}</span><span class="v">${dentro ? 'In servizio' : t.length ? 'Uscito' : 'Non in servizio'}</span>
      <span class="small">${dentro ? `Dalle ${ultima.ora}${ultima.sede ? ' · ' + esc(ultima.sede) : ''}` : t.length ? `Uscita alle ${ultima.ora}` : 'Appoggia il telefono al tag all\'ingresso'}</span></div>
    <div class="nfcbox">${svg('timbra')}<b>Avvicina il telefono al tag NFC</b>
      <span class="muted small">${isIOS ? 'iPhone: sblocca il telefono e avvicina la parte alta al tag, poi tocca la notifica che compare.' : 'Android: tieni l\'NFC acceso e appoggia il retro del telefono al tag.'} Si apre la timbratura da confermare.</span></div>
    ${me.senzaNfc ? `<div class="card"><p class="muted small" style="margin-top:0">L'amministrazione ti ha autorizzato a timbrare senza NFC.</p>
      ${me.sedi.length > 1 ? `<label class="f" style="margin-bottom:10px">Sede<select id="sedeT">${me.sedi.map(s => `<option value="${s.id}">${esc(s.nome)}</option>`).join('')}</select></label>` : ''}
      <button class="btn primary big" id="senzaNfc">Timbra ${dentro ? 'USCITA' : 'INGRESSO'} senza NFC</button></div>`
    : `<p class="muted xs" style="text-align:center;margin:-6px 0 16px">Si timbra solo con il tag NFC. Telefono senza NFC? Chiedi l'autorizzazione all'amministrazione.</p>`}
    <div class="card"><h3>Timbrature di oggi</h3>${t.length ? `<div class="lista">${t.map(x => `<div class="li"><span class="grow">${x.tipo === 'in' ? 'Ingresso' : 'Uscita'}${x.sede ? ' · ' + esc(x.sede) : ''}${x.modo !== 'nfc' ? ` <span class="tag">${x.modo === 'app' ? 'senza NFC' : 'corretta'}</span>` : ''}</span><b>${x.ora}</b></div>`).join('')}</div>` : '<p class="muted small" style="margin:0">Nessuna timbratura.</p>'}</div>
    ${me.admin ? '' : `<div class="card"><div class="row"><h3 class="grow" style="margin:0">Il mio contratto</h3>${!me.tipoOk ? '<button class="btn small" id="modOnb">Modifica</button>' : ''}</div>
      <div class="li" style="border:0"><span class="grow muted small">Tipo</span><b>${me.tipo === 'piva' ? 'Partita IVA' : me.tipo === 'dip' ? 'Dipendente' : '—'}</b></div>
      ${me.tipo === 'dip' ? `<div class="li"><span class="grow muted small">Ore settimanali</span><b>${nume(me.ore ?? '—')} h</b></div>` : ''}
      ${!me.tipoOk ? '<span class="tag warn">In attesa di conferma dell\'amministrazione</span>' : '<span class="tag ok">Confermato</span>'}</div>`}`;
  const b = $('#senzaNfc');
  if (b) b.onclick = () => confermaTimbra({ tipo: dentro ? 'out' : 'in', ora: new Date().toLocaleTimeString('it-IT', {hour: '2-digit', minute: '2-digit', timeZone: 'Europe/Rome'}), sede: me.sedi.find(s => s.id === ($('#sedeT')?.value || me.sedi[0]?.id))?.nome || '', protetto: false },
    { senzaNfc: true, sede: $('#sedeT')?.value || me.sedi[0]?.id }, () => window.dopoTimbra ? window.dopoTimbra() : ricarica());
  const mo = $('#modOnb'); if (mo) mo.onclick = () => vistaOnb(m, true);
}
function confermaTimbra(a, corpo, dopo){
  const d = finestra(`<span class="tag ${a.protetto ? 'ok' : 'info'}">${a.protetto ? 'Tag NFC verificato' : corpo.senzaNfc ? 'Timbratura autorizzata senza NFC' : 'Tag NFC'}${a.sede ? ' · ' + esc(a.sede) : ''}</span>
    <h2 style="margin-top:12px;font-size:24px">Timbra ${a.tipo === 'in' ? 'INGRESSO' : 'USCITA'} alle ${a.ora}?</h2>
    <p class="muted small">Se è sbagliato, puoi cambiarlo: <button class="btn small" id="cambia">È ${a.tipo === 'in' ? 'un\'uscita' : 'un ingresso'}</button></p>
    <button class="btn primary big" id="ok">Conferma</button><button class="btn big" style="border:0;margin-top:6px" id="no">Annulla</button>`);
  d.querySelector('#no').onclick = () => { chiudi(); dopo && dopo(true); };
  d.querySelector('#cambia').onclick = () => { a.tipo = a.tipo === 'in' ? 'out' : 'in'; chiudi(); confermaTimbra(a, corpo, dopo); };
  d.querySelector('#ok').onclick = async e => {
    e.target.disabled = true;
    try { const r = await api('POST', '/api/sp/timbra', {...corpo, tipo: a.tipo}); chiudi(); esitoTimbra(true, `${r.tipo === 'in' ? 'Ingresso' : 'Uscita'} registrat${r.tipo === 'in' ? 'o' : 'a'} alle ${r.ora}`, r.sede, dopo); }
    catch (er) { chiudi(); esitoTimbra(false, er.message, '', dopo); }
  };
}
function esitoTimbra(ok, testo, sede, dopo){
  const d = finestra(`<div class="big-ok"><div class="ico ${ok ? '' : 'no'}">${ok ? '✓' : '!'}</div><h2>${esc(testo)}</h2>${sede ? `<p class="muted">${esc(sede)}</p>` : ''}<button class="btn primary big" id="fine">Ok</button></div>`);
  d.querySelector('#fine').onclick = () => { chiudi(); dopo && dopo(); };
}
// pagina aperta dal tag: turni.appgestione.it/nfc/<codice>?e=…&c=…
window.timbraDaTag = async function(cod, qs){
  const corpo = { cod, e: qs.get('e') || '', c: qs.get('c') || '' };
  history.replaceState(null, '', '/'); // il link letto non si riusa
  const vai = () => { location.href = '/?sez=timbra'; };
  $('#main').innerHTML = '<div class="card" style="max-width:560px;margin:20px auto"><p class="muted">Leggo il tag…</p></div>';
  try {
    const a = await api('GET', `/api/sp/timbra/anteprima?${new URLSearchParams(corpo)}`);
    confermaTimbra(a, corpo, vai);
  } catch (e) { esitoTimbra(false, e.message, '', vai); }
};

/* ---------- assenze ---------- */
const STATI = { attesa_sost: ['In attesa del sostituto', 'warn'], attesa_admin: ['In attesa dell\'amministrazione', 'warn'], approvata: ['Approvata', 'ok'], rifiutata: ['Rifiutata', 'no'] };
async function vistaAssenze(m){
  const me = ME.me, s = ME.saldi;
  let tipo = 'ferie';
  const sostDa = ME.sostituzioni.filter(r => r.stato === 'attesa_sost' && r.sost === me.id);
  const draw = () => {
    const serveSost = ['ferie', 'permesso'].includes(tipo) && !me.medico && me.tipo !== 'piva';
    m.innerHTML = `${s ? `<div class="grid2" style="margin-bottom:16px"><div class="stat"><div class="k">Ferie residue</div><div class="v">${nume(s.ferie)} gg</div></div><div class="stat"><div class="k">Permessi residui</div><div class="v">${nume(s.permessi)} h</div></div></div>` : ''}
      ${sostDa.length ? `<div class="card"><h3>Ti chiedono di sostituirli</h3>${sostDa.map(r => `<div class="li"><span class="grow"><b>${esc(r.nome)}</b> · ${esc(r.desc.toLowerCase())}</span><button class="btn small primary" data-si="${r.id}">Accetto</button><button class="btn small" data-no="${r.id}">Non posso</button></div>`).join('')}</div>` : ''}
      <div class="card"><h3>Nuova richiesta</h3>
        <div class="chips" style="margin-bottom:12px">${[['ferie', 'Ferie'], ['permesso', 'Permesso (ore)'], ['malattia', 'Malattia'], ['altro', 'Altro']].map(([k, t]) => `<button class="chip" data-tipo="${k}" aria-pressed="${tipo === k}">${t}</button>`).join('')}</div>
        <div class="grid2">${tipo === 'permesso' ? `<label class="f">Giorno<input type="date" id="dal" min="${ME.oggi}" value="${ME.oggi}"></label><span></span>
            <label class="f">Dalle<input type="time" id="oraDa" value="16:00"></label><label class="f">Alle<input type="time" id="oraA" value="18:30"></label>`
          : `<label class="f">Dal<input type="date" id="dal" ${tipo !== 'malattia' ? `min="${ME.oggi}"` : ''} value="${ME.oggi}"></label><label class="f">Al<input type="date" id="al" value="${ME.oggi}"></label>`}</div>
        ${tipo === 'malattia' ? `<label class="f" style="margin-top:10px">Numero di protocollo del certificato<input type="text" id="prot" placeholder="dal certificato del medico"></label>` : ''}
        ${tipo !== 'malattia' || true ? `<label class="f" style="margin-top:10px">Chi ti sostituisce?${serveSost ? ' (deve accettare)' : ' (facoltativo)'}<select id="sost"><option value="">${serveSost ? 'Scegli un collega…' : 'Nessuno'}</option>${ME.colleghi.map(c => `<option value="${c.id}">${esc(c.nome)}${c.figura ? ' · ' + esc(c.figura) : ''}</option>`).join('')}</select></label>` : ''}
        <label class="f" style="margin-top:10px">Note (facoltative)<input type="text" id="nota" maxlength="300" placeholder="${tipo === 'altro' ? 'Scrivi il motivo' : ''}"></label>
        <button class="btn primary big" id="invia" style="margin-top:14px">${tipo === 'malattia' ? 'Comunica la malattia' : 'Invia richiesta'}</button></div>
      <div class="card"><h3>Le mie richieste</h3>${ME.richieste.length ? `<div class="lista">${ME.richieste.map(r => `<div class="li"><span class="grow"><span class="t">${esc(r.desc)}</span><span class="s">${r.quanti != null ? (r.tipo === 'ferie' ? `${nume(r.quanti)} giorni` : `${nume(r.quanti)} ore`) + ' · ' : ''}${r.sostNome ? 'sostituto ' + esc(r.sostNome) : ''}${r.notaAdmin ? ' · ' + esc(r.notaAdmin) : ''}</span></span>
        <span class="tag ${STATI[r.stato]?.[1] || ''}">${STATI[r.stato]?.[0] || r.stato}</span>${['attesa_sost', 'attesa_admin'].includes(r.stato) ? `<button class="btn small" data-ann="${r.id}">Annulla</button>` : ''}</div>`).join('')}</div>` : '<p class="muted small" style="margin:0">Nessuna richiesta.</p>'}</div>
      ${s ? `<div class="card"><h3>Movimenti di ferie e permessi</h3>${ME.movimenti.length ? `<div class="lista">${ME.movimenti.map(x => `<div class="li"><span class="grow"><span class="t" style="font-weight:600">${esc(x.causale)}</span><span class="s">${fmtG(x.data)}</span></span><b style="white-space:nowrap">${x.tipo === 'saldo' ? 'saldo ' : x.valore > 0 ? '+' : ''}${nume(x.valore)} ${x.voce === 'ferie' ? 'gg ferie' : 'h permessi'}</b></div>`).join('')}</div>` : '<p class="muted small" style="margin:0">Il saldo arriva con la prossima busta paga.</p>'}</div>` : ''}`;
  };
  draw();
  m.onclick = async e => {
    const t = e.target.closest('[data-tipo]'); if (t) { tipo = t.dataset.tipo; return draw(); }
    const si = e.target.closest('[data-si]'), no = e.target.closest('[data-no]'), an = e.target.closest('[data-ann]');
    try {
      if (si || no) { await api('POST', `/api/sp/richieste/${(si || no).dataset[si ? 'si' : 'no']}/sostituto`, {ok: !!si}); toast(si ? 'Hai accettato: ora decide l\'amministrazione.' : 'Risposta inviata.'); return ricarica(); }
      if (an) { if (!confirm('Annullare la richiesta?')) return; await api('POST', `/api/sp/richieste/${an.dataset.ann}/annulla`, {}); toast('Richiesta annullata.'); return ricarica(); }
      if (e.target.id === 'invia') {
        const r = await api('POST', '/api/sp/richieste', { tipo, dal: $('#dal').value, al: $('#al')?.value || $('#dal').value, oraDa: $('#oraDa')?.value, oraA: $('#oraA')?.value,
          sost: $('#sost')?.value, prot: $('#prot')?.value, nota: $('#nota').value });
        toast(r.stato === 'attesa_sost' ? 'Richiesta inviata al sostituto.' : r.stato === 'approvata' ? 'Registrata.' : 'Richiesta inviata all\'amministrazione.');
        if (r.avviso) setTimeout(() => toast(r.avviso), 3300);
        return ricarica();
      }
    } catch (er) { toast(er.message); }
  };
  m.onchange = e => { if (e.target.id === 'dal' && $('#al') && $('#al').value < e.target.value) $('#al').value = e.target.value; };
}

/* ---------- turni del mese ---------- */
async function vistaTurniU(m){
  MESE_U = MESE_U || ME.oggi.slice(0, 7);
  const r = await api('GET', `/api/sp/turni?mese=${MESE_U}`);
  const sn = new Map(ME.sedi.map(s => [s.id, s.nome]));
  const g = giorniMese(MESE_U), vuoti = (dowG(g[0]) + 6) % 7;
  let minuti = 0;
  const celle = g.map(x => {
    const ts = r.turni.filter(t => t.giorno === x), as = r.assenze.find(a => a.dal <= x && a.al >= x);
    ts.forEach(t => { const [a, b] = [t.da, t.a].map(v => +v.slice(0, 2) * 60 + +v.slice(3)); minuti += Math.max(0, b - a - (t.pausa || 0)); });
    const cls = as ? 'ass' : ts.length ? 'on' : '';
    return `<div class="d ${cls} ${x === ME.oggi ? 'oggi' : ''}"><b>${+x.slice(8)}</b>${ts.map(t => `<span>${t.da.replace(/^0/, '')}–${t.a.replace(/^0/, '')}</span>${sn.get(t.sede) && ME.sedi.length > 1 ? `<span class="xs">${esc(sn.get(t.sede))}</span>` : ''}`).join('')}${as ? `<span>${as.tipo === 'permesso' ? 'perm.' : as.tipo}</span>` : !ts.length ? '<span>riposo</span>' : ''}</div>`;
  });
  m.innerHTML = `<div class="card"><div class="row" style="margin-bottom:12px"><button class="btn small" id="mPrev" aria-label="Mese prima">‹</button><h2 class="grow" style="margin:0;text-align:center">${meseLbl(MESE_U)}</h2><button class="btn small" id="mNext" aria-label="Mese dopo">›</button></div>
    <div class="cal">${['L', 'M', 'M', 'G', 'V', 'S', 'D'].map(h => `<span class="h">${h}</span>`).join('')}${'<div class="d vuoto"></div>'.repeat(vuoti)}${celle.join('')}</div>
    <p class="muted xs" style="margin:12px 0 0">In turno nel mese: <b>${hm(minuti)}</b>${ME.me.tipo === 'dip' && ME.me.ore ? ` · contratto ${nume(ME.me.ore)} h/settimana` : ''}. Oggi ha il bordo scuro. I turni li decide l'amministrazione e possono cambiare.</p></div>`;
  $('#mPrev').onclick = () => { MESE_U = meseAdd(MESE_U, -1); vistaTurniU(m); };
  $('#mNext').onclick = () => { MESE_U = meseAdd(MESE_U, 1); vistaTurniU(m); };
}

/* ---------- performance ---------- */
// compenso di un ruolo (fisso, variabile, di area) come scritto nel piano di crescita
function compenso(tit, c){
  if (!c || !(c.fisso || c.variabile || c.area)) return '';
  const righe = t => String(t || '').split('\n').filter(Boolean).map(x => `<li class="small" style="margin:3px 0">${esc(x)}</li>`).join('');
  return `<div class="card"><h3>${esc(tit)}</h3>
    ${c.fisso ? `<p class="small" style="margin:4px 0"><b>Fisso:</b> ${esc(c.fisso)}</p>` : ''}
    ${c.variabile ? `<p class="small" style="margin:8px 0 0"><b>Variabile</b></p><ul style="margin:2px 0 0;padding-left:20px">${righe(c.variabile)}</ul>` : ''}
    ${c.area ? `<p class="small" style="margin:8px 0 0"><b>Compenso di area</b></p><ul style="margin:2px 0 0;padding-left:20px">${righe(c.area)}</ul>` : ''}</div>`;
}
async function vistaPerfU(m){
  const p = ME.perf;
  if (!p) { m.innerHTML = `<div class="card"><h2>Performance</h2><p class="muted">Non sei ancora inserito in un piano di carriera. Quando l'amministrazione ti assegna un ruolo, qui trovi gli obiettivi per crescere e i bonus.</p></div>`; return; }
  const tot = p.obiettivi.length, pct = tot ? Math.round(100 * p.pass / tot) : 0;
  const ST = { pass: ['Pass ✓', 'ok'], verifica: ['In verifica', 'warn'], no: ['Non approvato', 'no'], fare: ['Da fare', 'info'] };
  m.innerHTML = `<div class="card" style="background:var(--teal-ink);color:#fff;border:0"><span class="xs" style="text-transform:uppercase;letter-spacing:.05em;font-weight:700;opacity:.85">${esc(p.piano)}</span>
      <h2 style="margin:4px 0;color:#fff">Ruolo attuale: ${esc(p.ruolo)}</h2>
      ${p.prossimo ? `<p class="small" style="margin:0 0 10px;opacity:.9">Prossimo ruolo: <b>${esc(p.prossimo.ruolo)}</b>${p.prossimo.bonus ? ' · bonus al passaggio: ' + esc(p.prossimo.bonus) : ''}</p>
      <div style="height:10px;background:rgba(255,255,255,.22);border-radius:5px;overflow:hidden"><div style="height:100%;width:${pct}%;background:#E8E560"></div></div>
      <p class="small" style="margin:8px 0 0;font-weight:700">${p.pass} pass su ${tot} obiettivi</p>` : '<p class="small" style="margin:0">Sei all\'ultimo livello del tuo piano.</p>'}</div>
    ${compenso('Il tuo compenso da ' + p.ruolo, p.attuale)}
    ${p.inAttesa ? `<div class="banner ok">Hai tutti i pass! Il passaggio a ${esc(p.prossimo?.ruolo || '')} e il bonus sono in attesa di approvazione dell'amministrazione.</div>` : ''}
    ${p.prossimo ? `<div class="card"><h3>Obiettivi per diventare ${esc(p.prossimo.ruolo)}</h3>${tot ? p.obiettivi.map(o => `<div class="li" style="flex-direction:column;align-items:stretch;gap:6px">
        <div class="row"><b class="grow">${esc(o.testo)}</b><span class="tag ${ST[o.stato][1]}">${ST[o.stato][0]}</span></div>
        ${o.misura ? `<span class="muted xs">${esc(o.misura)}</span>` : ''}
        ${o.dato ? `<span class="small" style="background:var(--sunken);padding:6px 10px;border-radius:8px">Il tuo dato: ${esc(o.dato)}</span>` : ''}
        ${o.nota ? `<span class="xs muted">Nota dell'amministrazione: ${esc(o.nota)}</span>` : ''}
        ${['fare', 'no'].includes(o.stato) ? `<div class="row"><input type="text" class="grow" data-dato="${o.id}" placeholder="Scrivi il risultato raggiunto"><button class="btn small primary" data-invia="${o.id}">Invia</button></div>` : ''}</div>`).join('') : '<p class="muted small">Gli obiettivi non sono ancora stati indicati.</p>'}</div>` : ''}
    ${p.prossimo?.skill?.length ? `<div class="card"><h3>Competenze da sviluppare per diventare ${esc(p.prossimo.ruolo)}</h3><ul style="margin:6px 0 0;padding-left:20px">${p.prossimo.skill.map(x => `<li class="small" style="margin:3px 0">${esc(x)}</li>`).join('')}</ul></div>` : ''}
    ${p.prossimo ? compenso('Compenso da ' + p.prossimo.ruolo, p.prossimo) : ''}
    ${p.regole ? `<details class="card"><summary><b>Regole del piano di crescita</b></summary><div class="small" style="white-space:pre-line;margin-top:8px;line-height:1.5">${esc(p.regole)}</div></details>` : ''}`;
  m.onclick = async e => {
    const b = e.target.closest('[data-invia]'); if (!b) return;
    try { await api('POST', '/api/sp/perf/dato', {obiettivo: b.dataset.invia, dato: m.querySelector(`[data-dato="${b.dataset.invia}"]`).value}); toast('Inviato: ora lo verifica l\'amministrazione.'); ricarica(); }
    catch (er) { toast(er.message); }
  };
}

/* ---------- documenti personali ---------- */
let DTAB = null;
async function vistaDocU(m){
  const me = ME.me;
  const tabs = me.medico ? [['cu', 'CU'], ['contratti', 'Contratti']] : me.tipo === 'piva' ? [['contratti', 'Contratto e altri'], ['cu', 'CU']] : [['buste', 'Buste paga'], ['cu', 'CU'], ['contratti', 'Contratto e altri']];
  if (!tabs.some(t => t[0] === DTAB)) DTAB = tabs[0][0];
  const filt = { buste: d => d.tipo === 'busta', cu: d => d.tipo === 'cu', contratti: d => d.tipo === 'contratto' || d.tipo === 'altro' }[DTAB];
  const lista = ME.docs.filter(filt);
  m.innerHTML = `<div class="chips" style="margin-bottom:14px">${tabs.map(([k, t]) => `<button class="chip" data-tab="${k}" aria-pressed="${DTAB === k}">${t}</button>`).join('')}</div>
    <div class="card">${lista.length ? `<div class="lista">${lista.map(d => `<div class="li"><span class="grow"><span class="t">${esc(d.titolo)}</span><span class="s">${d.tipo === 'busta' ? (d.ricevuto ? 'Ricevuta confermata il ' + fmtD(d.ricevuto) : 'Da confermare') : 'Caricato il ' + fmtD(d.pubblicato)}</span></span>
      <button class="btn small" data-apri="${d.id}">Apri</button>${d.tipo === 'busta' && !d.ricevuto ? `<button class="btn small primary" data-ric="${d.id}">Confermo la ricezione</button>` : ''}</div>`).join('')}</div>`
      : `<p class="muted small" style="margin:0">${DTAB === 'buste' ? 'Le buste paga compaiono qui appena l\'amministrazione le pubblica.' : DTAB === 'cu' ? 'La CU compare qui appena l\'amministrazione la pubblica.' : 'Nessun documento.'}</p>`}</div>
    <p class="muted xs">Sono documenti tuoi: puoi aprirli e scaricarli. Li vedi solo tu e l'amministrazione.</p>`;
  m.onclick = async e => {
    const t = e.target.closest('[data-tab]'); if (t) { DTAB = t.dataset.tab; return vistaDocU(m); }
    const a = e.target.closest('[data-apri]'); if (a) { window.open(`/api/sp/doc/${a.dataset.apri}/file`, '_blank', 'noopener'); return; }
    const r = e.target.closest('[data-ric]');
    if (r) { try { await api('POST', `/api/sp/doc/${r.dataset.ric}/ricevuto`, {}); toast('Ricezione confermata.'); ricarica(); } catch (er) { toast(er.message); } }
  };
}
