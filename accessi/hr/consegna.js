/* I-Profile · CONSEGNA (privata: la vede solo chi ha l'accesso "I-Profile · Consegna").
   Prepara la traccia per consegnare il grafico alla persona, seguendo il metodo del manuale
   ("Come consegnare I-Profile": studia il grafico → indagine → lati positivi → aree di miglioramento →
   stimolazione → sintesi e prescrizione delle azioni-rimedio → consegna della relazione → follow-up con il capo). */
(function () {
  const T = () => window.IP_TRATTI, F = (k, v) => window.IP_FASCIA(k, v);
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const TRATTI = ['org', 'auto', 'gp', 'ad', 'det', 'vend', 'hr', 'pro', 'com', 'esp'];
  const LATERALI = ['rc', 'fin', 'suc', 'pri', 'lin', 'va', 'wi'];

  // domande per l'indagine iniziale (dalle "cause" del manuale), quando il tratto è fuori fascia
  const DOMANDE = {
    org: v => v < 25 && 'Come ti organizzi la settimana? Usi un\'agenda e una lista delle cose da fare? Ti capita di rincorrere le urgenze?',
    auto: v => v < 0 && 'Che cosa ti muove al mattino? C\'è un progetto o un sogno che ti fa da motore? C\'è qualcosa in cui ci tenevi e che non è andato?',
    gp: v => v < 21 ? 'Chi, nel tuo ambiente (lavoro o casa), ti critica, ti ostacola o ti mette in difficoltà?' : v > 68 && 'C\'è qualcuno con cui eviti di affrontare le cose per non avere problemi?',
    ad: v => v < 40 && 'C\'è qualcosa di importante per il tuo lavoro che stai rimandando da tempo? Che cosa ti blocca?',
    det: v => v < 35 && 'C\'è qualcuno a cui non riesci a chiedere le cose che dovresti, o con cui giri attorno ai problemi?',
    vend: v => v < 40 && 'Quando presenti un\'idea o un prodotto, come lo racconti? Che cosa pensi di chi vende?',
    pro: v => v < 30 && 'Raccontami una situazione recente che non è andata come volevi: che cosa hai fatto tu? Che cosa avresti potuto fare?',
    com: v => v < 16 && 'Come vanno i rapporti con colleghi e collaboratori? C\'è qualcuno che ti delude o di cui non ti fidi?',
    esp: v => v < 30 && 'Come ti trovi quando devi conoscere persone nuove o rompere il ghiaccio?',
    rc: v => v < -19 ? 'Con chi ti senti incerto? Con chi non sai come comportarti?' : v > 44 && 'Ci sono abitudini o procedure che fai fatica a cambiare anche quando non danno risultati?',
    fin: v => v < 30 && 'Come va la tua situazione economica: quello che incassi copre quello che spendi? Hai delle riserve?',
    suc: v => v < 60 && 'Come sono andate le esperienze di lavoro precedenti? Che cosa ti aspettavi e non è arrivato?',
    pri: v => v < 40 && 'Che cosa rende buona, per te, un\'offerta di lavoro? Che cosa ti aspetti dall\'azienda?',
  };
  // azioni-rimedio (dal manuale: "come aiutare" e "servizi"), per i tratti fuori fascia
  const RIMEDI = {
    org: ['Piani di lavoro giornalieri o settimanali fatti con lei; agenda e lista quotidiana delle cose da fare; aiutarla a scegliere le priorità.', 'Rimedio Programmazione MBS; corso Delega Efficace; corso Time Management (App OSM).'],
    auto: ['Far scrivere le mete che la accendono (capitoli I e II de "I Nuovi Condottieri"); frequentare persone positive e di successo; verificare chi nel suo ambiente la critica o la sminuisce.', 'Corso Leadership MBS; se sotto -30 o se qualcuno la critica: Rimedio Pressioni o One to One.'],
    gp: ['Intervista per individuare la persona che la mette in difficoltà e applicare il protocollo di gestione della persona demotivante (non andare in scontro, prepararsi agli incontri, frequentare persone positive).', 'Corso One to One in azienda (sempre, da +20 in giù) o Gestione Situazioni di Pressione MBS.'],
    ad: ['Darle statistiche e obiettivi numerici concreti; individuare le cose non gestite che lascia e fargliele gestire; scrivere le proprie azioni non efficienti.', 'Rimedio Autodisciplina MBS; corso Time Management (App OSM).'],
    det: ['Esercitarla a fare richieste dirette, a esprimere le idee come affermazioni e a dare ordini; una giornata di affiancamento-allenamento.', 'Corso Comunicazione MBS; Principi del Comando MBS; se molto inibita: Rimedio Pressioni o One to One.'],
    vend: ['Esercitazioni di vendita simulate e affiancamento settimanale del responsabile; lavorare sui tratti di supporto (automotivazione, determinazione, espansività).', 'Corso Vendite (interaziendale o MBS); Comunicazione MBS; Public Speaking.'],
    hr: ['Prima gestire gli eventuali comportamenti speciali; poi statistiche e piano di crescita per ogni persona del team, delega efficace, manuali delle funzioni, momenti di lavoro in squadra.', 'Corso Leadership (interaziendale o MBS); Public Speaking.'],
    pro: ['Spiegarle la teoria causa-effetto (capitolo III de "I Nuovi Condottieri"); farle notare quando è permalosa e come così perde il controllo della comunicazione.', 'Corso Leadership Base; Comunicazione MBS; One to One.'],
    com: ['Farle notare con esempi pratici quando non ascolta o interrompe; lavorare sui lati positivi delle persone e dare più apprezzamenti (capitoli V e X de "I Nuovi Condottieri"); esercizio di duplicazione.', 'Corso Leadership (interaziendale o MBS); Comunicazione MBS.'],
    esp: ['Allenamento pratico ad approcciare persone nuove: guarda dove ha l\'attenzione l\'altro, fai un\'affermazione su quello, poi una domanda che ti incuriosisce.', 'Giornate di allenamento sul campo; esercizi di approccio del corso Vendite; Comunicazione MBS.'],
    rc: v => v > 44
      ? ['Farle notare quando "razionalizza" e giustifica i risultati; gestirla con numeri, statistiche e indici, senza discussioni infinite; essere meno abitudinaria, a partire dalla vita personale.', 'Corso Etica e lavoro sulle azioni non efficienti; Public Speaking.']
      : ['Diventare il suo punto di riferimento: gestirla in modo positivo, con apprezzamenti, sempre raggiungibile.' + (v < -19 ? ' Individuare le persone con cui si sente incerta e gestirle.' : '') + (v < -29 ? ' Stile direttivo: piani di lavoro dettagliati e verificati.' : ''), 'One to One o Gestione Situazioni di Pressione MBS; corso sul Progetto d\'Impresa.'],
    fin: ['Lista di tutti i debiti e delle spese mensili; media degli incassi degli ultimi tre mesi; piano di intervento con monitoraggio; leggere "Guida alla Prosperità".', 'Per un imprenditore: Intervento finanziario One to One o corso Gestione Finanziaria MBS.'],
    suc: ['Indagare le aspettative deluse o gli scopi falliti; per un titolare guardare subito Resistenza al cambiamento, Finanze, Principi e Automotivazione.'],
    pri: ['Mettere nero su bianco gli accordi contrattuali; formazione su come funziona il lavoro in azienda (per un manager servono principi sopra 45).'],
    lin: ['Fargli capire che ci sono persone per cui deve prendersi la responsabilità; curare automotivazione, determinazione, proattività e comprensione se basse.', 'Corso Leadership (interaziendale o MBS); Public Speaking.'],
  };
  // come dirlo durante la consegna (attenzioni del manuale)
  const ATTENZIONI = v => {
    const a = [];
    if (v.pro !== null && v.pro < 30) a.push('<b>Proattività bassa:</b> usa i guanti di velluto. Prima un paio di cose positive, poi l\'area da migliorare; mai riprenderla davanti ad altri. Tenderà a dire che non è vero: porta esempi concreti di situazioni sue.');
    if (v.com !== null && v.com < 16) a.push('<b>Comprensione bassa:</b> difficilmente lo riconoscerà da sola. Usa esempi pratici dei suoi comportamenti (interrompe, non ascolta, risponde al telefono mentre le parli) oppure chiedile cosa ne pensa il coniuge.');
    if (v.auto !== null && v.auto < 0 && v.pro !== null && v.pro > 40) a.push('<b>Automotivazione bassa con proattività alta:</b> non dirle che non crede in sé (non si riconoscerà). Mostrale che riconosce il suo valore solo quando sono gli altri a dirle che è brava.');
    if (v.gp !== null && v.gp > 68) a.push('<b>Gestione Pressioni sopra 68:</b> ti dirà che va tutto bene e che non ha problemi con nessuno. Preparati bene: il lavoro è farle aprire gli occhi sulla persona che sta evitando di affrontare.');
    if (v.rc !== null && v.rc >= 45) a.push('<b>Resistenza al cambiamento alta:</b> se inizia a giustificarsi non entrare in discussione; riporta tutto a fatti e numeri.');
    return a;
  };

  function genera(dati) {
    const v = dati.v, P = dati.P || [], S = dati.S || [];
    const vals = [...TRATTI, ...LATERALI].filter(k => v[k] !== null && v[k] !== undefined && !isNaN(v[k]));
    if (vals.length < 5) return { vuoto: true };
    const tuttoBasso = TRATTI.every(k => v[k] !== null && v[k] <= 10);
    let positivi = TRATTI.filter(k => v[k] !== null && F(k, v[k]).ok);
    if (tuttoBasso || !positivi.length) positivi = TRATTI.filter(k => v[k] !== null).sort((a, b) => v[b] - v[a]).slice(0, 3);
    const lontananza = k => { const t = T()[k], x = v[k]; if (k === 'gp') return x < 21 ? 21 - x : x - 68; if (k === 'rc') return x > 44 ? x - 44 : -14 - x; const soglia = { org: 40, auto: 0, ad: 39, det: 35, vend: 60, hr: 30, pro: 29, com: 15, esp: 50, fin: 30, suc: 69, pri: 39, lin: 35 }[k]; return soglia === undefined ? 0 : soglia - x; };
    const aree = [...TRATTI, 'rc', 'fin', 'suc', 'pri', 'lin'].filter(k => v[k] !== null && !positivi.includes(k) && !F(k, v[k]).ok).sort((a, b) => lontananza(b) - lontananza(a));
    const domande = [...TRATTI, ...LATERALI].filter(k => v[k] !== null && DOMANDE[k]).map(k => DOMANDE[k](v[k])).filter(Boolean);
    const rimedi = aree.map(k => { const r = typeof RIMEDI[k] === 'function' ? RIMEDI[k](v[k]) : RIMEDI[k]; return r ? { k, r } : null; }).filter(Boolean);
    return { tuttoBasso, positivi, aree, domande, rimedi, P, S, isp: dati.isp, attenzioni: ATTENZIONI(v), v };
  }

  function html(g) {
    if (g.vuoto) return '<p class="empty">Inserisci (o leggi dal grafico) almeno i valori dei tratti: la traccia di consegna si prepara da sola.</p>';
    const v = g.v, nome = k => T()[k].nome, val = k => `<span style="font-family:var(--num);font-weight:700">${v[k]}</span>`;
    const passo = (n, tit, corpo) => `<article class="item info" style="border-left-color:var(--purple)"><h3>${n}. ${tit}</h3>${corpo}</article>`;
    const li = a => `<ul style="margin:4px 0 0;padding-left:20px">${a.map(x => `<li style="margin:3px 0">${x}</li>`).join('')}</ul>`;
    const out = [];
    out.push(`<div class="isp"><b>Traccia per la consegna</b><span>Circa un'ora. Segue il metodo del manuale: prima studi il grafico, poi indagine, lati positivi, aree di miglioramento, stimolazione, sintesi e azioni-rimedio. Ad uso riservato: non va data alla persona.</span></div>`);
    out.push(passo(1, 'Prima della consegna: studia il grafico', li([
      'Controlla che il questionario sia attendibile.',
      'Metti in relazione il grafico con quello che sai già della persona: come va in azienda, le sue statistiche, cosa dice il responsabile, come comunica.',
      'Immagina come il grafico si manifesta in questa persona; se hai dubbi chiariscili con il tuo responsabile prima di iniziare.',
      ...(g.tuttoBasso ? ['<b>Grafico tutto basso:</b> è la chiave di lettura di tutto il profilo (qualcuno nell\'ambiente le causa ansia e difficoltà). Considera come positivi i tratti più alti, anche se non sono in fascia ottimale.'] : []),
      ...(g.isp ? [`<b>Scala dell'ISP: ${esc(g.isp)}.</b> Tienilo presente in tutta la consegna.`] : []),
    ])));
    out.push(passo(2, 'Approccio e indagine', `<p>Una chiacchierata piacevole, non un interrogatorio: come sta andando il lavoro, come vede l'azienda, cosa le piace, quali difficoltà incontra. Appena ti è chiaro come il grafico si manifesta in lei, parti con la consegna (se l'indagine non porta da nessuna parte, parti comunque).</p>
      ${g.domande.length ? `<p style="margin-top:6px"><b>Domande utili per questo profilo:</b></p>${li(g.domande.map(esc))}` : ''}`));
    out.push(passo(3, 'Consegna dei lati positivi', `<p>Apri così: <i>"Le 242 domande a cui ha risposto delineano 10 caratteristiche che vanno da +100 a -100… poi qui a lato ce ne sono altre."</i> Parti dai lati positivi o da quelli su cui è più facile trovare accordo.</p>
      ${li(g.positivi.map(k => `<b>${nome(k)}</b> ${val(k)}: ${esc(F(k, v[k]).testo)}`))}
      <p style="margin-top:6px">Ogni volta che non è d'accordo: dai riconoscimento (<i>"Ah, capisco…"</i>) e riformula con parole diverse finché non ottieni accordo. Chiudi con una breve sintesi dei lati positivi.</p>`));
    out.push(passo(4, 'Consegna delle aree di miglioramento', `${g.aree.length ? li(g.aree.map(k => `<b>${nome(k)}</b> ${val(k)} <span class="muted">(ottimale ${esc(T()[k].ottimoTxt)})</span>: ${esc(F(k, v[k]).testo)}`)) : '<p>Nessun tratto fuori fascia.</p>'}
      ${g.P.length ? `<p style="margin-top:8px"><b>Comportamenti speciali da tenere presenti</b> (descrivi i comportamenti, non dare etichette alla persona):</p>${li(g.P.map(o => `<b>${o.n}) ${esc(o.t)}</b>: ${esc(o.m)}`))}` : ''}
      ${g.attenzioni.length ? `<p style="margin-top:8px"><b>Come dirlo:</b></p>${li(g.attenzioni)}` : ''}
      <p style="margin-top:6px">Ottieni accordo anche su queste, poi fai la sintesi delle aree di miglioramento.</p>`));
    const stim = [];
    if (v.rc !== null && v.rc >= 50) stim.push('<i>"Le voglio dire anche un\'altra cosa: oltre a quello di cui abbiamo parlato, dovrà fare uno sforzo molto grande, perché tenderà a rimanere com\'è e a giustificarsi."</i>');
    else if (v.rc !== null && v.rc < 15) stim.push('Resistenza al cambiamento bassa: valuta se parlarle del suo bisogno di una persona di riferimento, se può aiutarla a sbloccarsi.');
    if (v.fin !== null && v.fin < 30) stim.push('Finanze basse: mostrale che tutte queste aree, alla fine, la limitano nel guadagnare.');
    if (stim.length) out.push(passo(5, 'Stimolazione', li(stim)));
    out.push(passo(stim.length ? 6 : 5, 'Sintesi e prescrizione delle azioni-rimedio', `<p>Fai la grande sintesi e prescrivi le azioni per migliorare la produttività e ottenere più successo. Qui serve impatto: sii determinato e diretto.</p>
      ${g.rimedi.length ? li(g.rimedi.map(({ k, r }) => `<b>${nome(k)}</b>: ${esc(r[0])}${r[1] ? `<br><span class="muted">Servizi: ${esc(r[1])}</span>` : ''}`)) : '<p>Nessuna azione-rimedio specifica: rinforza i punti di forza.</p>'}
      <p style="margin-top:6px">Per tutti, dall'App OSM Corsi: audiolibri "Le 10 Regole del Successo" e "L'etica dell'Eccellenza", test di comprensione, contatto con il tutor.</p>`));
    out.push(passo(stim.length ? 7 : 6, 'Chiusura', li(['Consegna la relazione.', 'Fai il follow-up con il suo responsabile: cosa è emerso, cosa ha accettato, quali azioni sono state concordate.'])));
    return out.join('');
  }
  function testo(g) {
    if (g.vuoto) return '';
    const v = g.v, n = k => T()[k].nome;
    return ['TRACCIA DI CONSEGNA I-PROFILE (riservata)', '',
      'Lati positivi: ' + g.positivi.map(k => `${n(k)} ${v[k]}`).join(', '),
      'Aree di miglioramento: ' + (g.aree.map(k => `${n(k)} ${v[k]}`).join(', ') || 'nessuna'),
      'Comportamenti speciali: ' + (g.P.map(o => `${o.n}) ${o.t}`).join(', ') || 'nessuno'), '',
      'Domande per l\'indagine:', ...g.domande.map(d => '- ' + d), '',
      'Azioni-rimedio:', ...g.rimedi.map(({ k, r }) => `- ${n(k)}: ${r[0]}${r[1] ? ' Servizi: ' + r[1] : ''}`)].join('\n');
  }
  window.IP_CONSEGNA = (box, dati) => {
    if (!dati) return;
    const g = genera(dati);
    box.innerHTML = `<div class="row-btns" style="justify-content:flex-end"><button class="btn small" type="button" id="c-stampa">Stampa / PDF</button><button class="btn small" type="button" id="c-copia">Copia traccia</button></div>
      <div class="list">${html(g)}</div>`;
    box.querySelector('#c-stampa').onclick = () => window.print();
    box.querySelector('#c-copia').onclick = async e => { const b = e.currentTarget; try { await navigator.clipboard.writeText(testo(g)); b.textContent = 'Copiata'; } catch { b.textContent = 'Copia non riuscita'; } setTimeout(() => b.textContent = 'Copia traccia', 1800); };
  };
})();
