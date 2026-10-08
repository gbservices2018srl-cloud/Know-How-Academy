// Motore del Turnario: date, regole, generatore dei turni, ore in avanzo, sostituzioni, regole scritte.
// Lo stesso file gira sul server (generazione, approvazioni, vista del dipendente) e nella pagina (calcoli per le tabelle).
// Usa queste variabili di stato, dichiarate da chi lo carica:
//   SEDI, STAFF, REMOVED, REG, FESTIVI, DEROGHE, CAD, UNAV, RULES_TXT, reqs, AI, plan, short, fixMiss, genAt, dirty, TODAY, MONTHS, uid
const pad = n=>String(n).padStart(2,"0");
const daysIn = ym => { const [y,m]=ym.split("-").map(Number); return new Date(y,m,0).getDate(); };
const dstr = (ym,d)=>`${ym}-${pad(d)}`;
const dow = s => new Date(s+"T12:00").getDay();
const DOW = ["D","L","M","M","G","V","S"];
const DOWL = ["domenica","lunedì","martedì","mercoledì","giovedì","venerdì","sabato"];
const WEEK = [1,2,3,4,5,6,0];
const fmt = s => new Date(s+"T12:00").toLocaleDateString("it-IT",{day:"numeric",month:"short"});
const diffDays = (a,b)=> Math.round((new Date(b+"T12:00")-new Date(a+"T12:00"))/864e5);
const addDays = (s,n)=>{ const t=new Date(s+"T12:00"); t.setDate(t.getDate()+n); return `${t.getFullYear()}-${pad(t.getMonth()+1)}-${pad(t.getDate())}`; };
const inRange = (d,r)=> d>=r.dal && d<=r.al;
const weekKey = s => addDays(s, -((dow(s)+6)%7));
const meseLabel = ym => new Date(ym+"-15T12:00").toLocaleDateString("it-IT",{month:"long",year:"numeric"});
const meseShort = ym => new Date(ym+"-15T12:00").toLocaleDateString("it-IT",{month:"long"});
const allDays = () => MONTHS.flatMap(ym=>Array.from({length:daysIn(ym)},(_,i)=>dstr(ym,i+1)));
const esc = s=>String(s??"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]));
const nowStr = ()=> new Date().toLocaleString("it-IT",{day:"2-digit",month:"2-digit",year:"numeric",hour:"2-digit",minute:"2-digit",timeZone:"Europe/Rome"});
const oggiRoma = ()=> new Date().toLocaleDateString("sv-SE",{timeZone:"Europe/Rome"}); // AAAA-MM-GG
const sede = id => SEDI.find(s=>s.id===id);
const TIPI_PROF = ["Medico","ASO","REC","RAP","RUL","Extrambulatoriale","Altro"];
const ALTRI = ["REC","RAP","RUL","Extrambulatoriale","Altro"];
// regole salvate prima che esistesse una figura: minimo 0, massimo 1 per turno
const normReg = r => { if (r && r.altri) for (const t of ALTRI) if (!r.altri[t]) r.altri[t] = {min:0, max:1}; return r; };
const TIPI = {FE:"Ferie", ROL:"ROL", MAL:"Malattia"};
const emp = id => STAFF.find(e=>e.id===id) || REMOVED.find(e=>e.id===id);
const full = e => e ? `${e.nome} ${e.cognome}` : "—";
const sediOf = e => SEDI.filter(s=>(e.ore[s.id]||0)>0).map(s=>s.id);
const oreTot = e => sediOf(e).reduce((a,s)=>a+e.ore[s],0);
const toMin = s => { const [h,m]=String(s).split(":").map(Number); return h*60+(m||0); };
const H = t => Math.max(0,(toMin(REG.ore[t][1])-toMin(REG.ore[t][0]))/60);
const hMin = () => Math.min(...["M","P"].map(H).filter(x=>x>0)) || 4;
const fmtH = n => (Math.round(n*10)/10).toLocaleString("it-IT")+" h";
const SPEC = {sempre:0, dow:1, data:2};
const derMatch = (x,d)=> x.quando==="sempre" || (x.quando==="dow" && dow(d)===x.dow) || (x.quando==="data" && x.data===d);
const derFor = (sid,d)=> DEROGHE.filter(x=>x.sede===sid && derMatch(x,d)).sort((a,b)=>SPEC[a.quando]-SPEC[b.quando]);
function isOpen(sid,d){
  let o = {...REG.orario[dow(d)]};
  if (REG.festivi && FESTIVI[d]) o = {M:false,P:false};
  for (const x of derFor(sid,d)){
    if (x.cosa==="chiusa") o={M:false,P:false};
    else if (x.cosa==="mattina") o={M:true,P:false};
    else if (x.cosa==="aperta") o={M:true,P:true};
  }
  return o;
}
function riuniti(sid,d){ let n = sede(sid)?.riuniti||0; for (const x of derFor(sid,d)) if (x.cosa==="riuniti") n=x.n; return n; }
function need(sid,d,tipo,t){
  if (!isOpen(sid,d)[t] || !REG.altri[tipo]) return 0;
  let n = REG.altri[tipo].min;
  for (const x of derFor(sid,d)) if (x.cosa==="fabb" && x.tipo===tipo && (x.turno===t || x.turno==="MP")) n = x.n;
  return n;
}
const maxFor = (sid,d,tipo,t) => Math.max(REG.altri[tipo]?.max||0, need(sid,d,tipo,t));
const derCosa = x => ({chiusa:"Chiusa", mattina:"Solo mattina", aperta:"Aperta mattina e pomeriggio"})[x.cosa]
  || (x.cosa==="riuniti" ? `${x.n} ${x.n===1?"riunito disponibile":"riuniti disponibili"}`
  : `${x.tipo} ${x.turno==="M"?"mattina":x.turno==="P"?"pomeriggio":"mattina e pomeriggio"}: almeno ${x.n}`);
const derQuando = x => x.quando==="sempre" ? "sempre" : x.quando==="dow" ? "ogni "+DOWL[x.dow] : fmt(x.data)+" "+x.data.slice(0,4);

function absenceOn(id,d){
  if (AI.has(id+"|"+d)) return {code:"AI"};
  const r = reqs.find(r=>r.emp===id && inRange(d,r) && r.stato!=="rifiutata");
  if (!r) return null;
  return r.stato==="approvata" ? {code:r.tipo, r} : {code:"PEND", r};
}
const blocked = (id,d)=>{ const a=absenceOn(id,d); return !!(a && a.code!=="PEND"); };
// presenze a cadenza fissa: n = settimane del mese (1-4, 5 = ultima, 0 = ogni settimana), t = M, P o G (giornata intera)
const NTH = {0:"ogni", 1:"1°", 2:"2°", 3:"3°", 4:"4°", 5:"ultimo"};
const cadMatch = (c,d) => { if (dow(d)!==c.dow) return false;
  if (c.ogni===2) return d>=(c.dal||"") && Math.round(diffDays(weekKey(c.dal||d), weekKey(d))/7)%2===0;
  if (c.n.includes(0)) return true;
  if (c.n.includes(Math.ceil(+d.slice(8)/7))) return true; return c.n.includes(5) && addDays(d,7).slice(5,7)!==d.slice(5,7); };
const listIt = a => a.length<2 ? a.join("") : a.slice(0,-1).join(", ")+" e "+a[a.length-1];
const cadTxt = c => (c.ogni===2 ? `ogni 2 settimane il ${DOWL[c.dow]}` : c.n.includes(0) ? `ogni ${DOWL[c.dow]}` : `${listIt([...c.n].sort().map(x=>NTH[x]))} ${DOWL[c.dow]} del mese`) + ` · ${c.t==="G"?"giornata intera":c.t==="M"?"mattina":"pomeriggio"}`;
const shiftsOf = p => p ? ["M","P"].filter(t=>p[t]) : [];
const hoursOn = (id,d) => shiftsOf(plan[id]?.[d]).reduce((a,t)=>a+H(t),0);
const inShift = (s,d,t,tipo) => STAFF.filter(x=>x.tipo===tipo && plan[x.id]?.[d]?.s===s && plan[x.id][d][t] && !blocked(x.id,d));
const weeksMap = () => { const w={}; allDays().forEach(d=>(w[weekKey(d)] ||= []).push(d)); return w; };
const workDay = d => dow(d)!==0 && !(REG.festivi && FESTIVI[d]);
// ore previste nella settimana: ore di contratto in proporzione ai giorni lavorabili (esclusi festivi e assenze approvate),
// più le ore del collega che sostituisce; se supera il massimo, prima si spostano le sue ore delle altre sedi. Arrotondate al turno.
function weekBudgets(e,wd){
  const hm = hMin(), avail = wd.filter(d=>workDay(d) && !blocked(e.id,d) && !UNAV.some(u=>u.emp===e.id && (u.dal||u.al) && u.t==="G" && unavMatch(u,d,"M")));
  const own = {}, extra = {};
  for (const s of sediOf(e)) own[s] = e.ore[s]*avail.length/6;
  for (const r of reqs){
    if (r.stato!=="approvata" || r.sost!==e.id) continue;
    const a = emp(r.emp); if (!a) continue;
    const gg = avail.filter(d=>inRange(d,r)).length; if (!gg) continue;
    for (const s of sediOf(a)) if (own[s]!==undefined) extra[s] = (extra[s]||0) + a.ore[s]*gg/6;
  }
  let over = Object.values(own).reduce((x,y)=>x+y,0) + Object.values(extra).reduce((x,y)=>x+y,0) - REG.maxGiorno*avail.length;
  for (const s of Object.keys(own)) if (over>0 && !extra[s]){ const cut=Math.min(own[s],over); own[s]-=cut; over-=cut; }
  for (const s of Object.keys(extra)) if (over>0){ const cut=Math.min(extra[s],over); extra[s]-=cut; over-=cut; }
  const out = {};
  for (const s of Object.keys(own)) out[s] = Math.round((own[s]+(extra[s]||0))/hm)*hm;
  return out;
}
const budget = (e,s,wd) => weekBudgets(e,wd)[s] || 0;
// ore collocate sul monte ore settimanale (le presenze fisse sono a parte)
const placedIn = (e,s,days) => days.reduce((a,d)=>{ const p=plan[e.id]?.[d]; if (!p || p.s!==s || blocked(e.id,d)) return a; return a + shiftsOf(p).filter(t=>!(p.fx||[]).includes(t)).reduce((x,t)=>x+H(t),0); }, 0);

// generatore: per ogni settimana prova più combinazioni e tiene quella che lascia meno ore in avanzo e meno scoperture
const rngOf = seed => () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const TENTATIVI = 40, MS_SETTIMANA = 70;
function genera(from){
  const hm = hMin(), EPS = 1e-9, hM = H("M"), hP = H("P"), HT = [hM,hP], TT = ["M","P"], MAXG = REG.maxGiorno+EPS;
  STAFF.forEach(e=>{ plan[e.id] ||= {}; for (const d in plan[e.id]) if (d>=from) delete plan[e.id][d]; });
  for (const d in short) if (d>=from) delete short[d];
  for (const d in fixMiss) if (d>=from) delete fixMiss[d];
  const NS = SEDI.length, NE = STAFF.length, TIPO = STAFF.map(e=>e.tipo);
  const tipoIdx = {}; ALTRI.forEach((t,i)=>tipoIdx[t]=i);
  const meds = [], asos = [], altri = ALTRI.map(()=>[]);
  STAFF.forEach((e,i)=>{ if (e.tipo==="Medico") meds.push(i); else if (e.tipo==="ASO") asos.push(i); else altri[tipoIdx[e.tipo]].push(i); });
  const nSedi = STAFF.map(e=>sediOf(e).length);
  for (const [w, wd] of Object.entries(weeksMap())){
    const gd = wd.filter(d=>d>=from); if (!gd.length) continue;
    const ND = gd.length, t0 = Date.now();
    const open = [], blk = [];
    for (let si=0; si<NS; si++){ open[si]=[]; for (let di=0; di<ND; di++){ const o=isOpen(SEDI[si].id,gd[di]); open[si][di]=[o.M,o.P]; } }
    for (let ei=0; ei<NE; ei++){ blk[ei]=[]; for (let di=0; di<ND; di++) blk[ei][di]=blocked(STAFF[ei].id,gd[di]); }
    const un = STAFF.map(e=>{ const us=UNAV.filter(u=>u.emp===e.id), a=new Array(ND*2).fill(false); if (us.length) for (let di=0; di<ND; di++) for (let ti=0; ti<2; ti++) a[di*2+ti]=us.some(u=>unavMatch(u,gd[di],TT[ti])); return a; });
    const base = STAFF.map(e=>{ const r=new Array(NS).fill(-1); SEDI.forEach((s,si)=>{ if ((e.ore[s.id]||0)>0) r[si]=budget(e,s.id,wd)-placedIn(e,s.id,wd); }); return r; });
    const slots0 = [];
    for (let di=0; di<ND; di++) for (let si=0; si<NS; si++) for (let ti=0; ti<2; ti++) if (open[si][di][ti]) {
      const s=SEDI[si].id, d=gd[di], t=TT[ti];
      slots0.push({si, di, ti, R:riuniti(s,d), need:ALTRI.map(tp=>need(s,d,tp,t)), max:ALTRI.map(tp=>maxFor(s,d,tp,t))});
    }
    const fixOcc = [];
    for (const c of CAD){ const ei=STAFF.findIndex(e=>e.id===c.emp), si=SEDI.findIndex(s=>s.id===c.sede); if (ei<0 || si<0) continue;
      for (let di=0; di<ND; di++) if (cadMatch(c,gd[di])) fixOcc.push({c, ei, si, di, ts: c.t==="G"?[0,1]:[c.t==="M"?0:1]}); }
    let best = null;
    for (let k=0; k<TENTATIVI; k++){
      if (k>2 && Date.now()-t0 > MS_SETTIMANA) break;
      const rnd = rngOf((w.replace(/-/g,"")|0) * 131 + k), noise = x => k===0 ? 0 : rnd()*x;
      const rem = base.map(r=>r.slice());
      const dS = STAFF.map(()=>new Array(ND).fill(-1));      // sede del giorno
      const dT = STAFF.map(()=>new Array(ND*2).fill(0));      // turno: 0 libero, n = riunito, -1 presente
      const dH = STAFF.map(()=>new Array(ND).fill(0));
      const maxRem = ei => { let m=0; for (const v of rem[ei]) if (v>m) m=v; return m; };
      const can = (ei,si,di,ti) => { if (!open[si][di][ti] || blk[ei][di] || un[ei][di*2+ti] || rem[ei][si] < HT[ti]-EPS) return false;
        if (dS[ei][di]===-1) return HT[ti] <= MAXG; return dS[ei][di]===si && !dT[ei][di*2+ti] && dH[ei][di]+HT[ti] <= MAXG; };
      const put = (ei,si,di,ti,v) => { dS[ei][di]=si; dT[ei][di*2+ti]=v; dH[ei][di]+=HT[ti]; rem[ei][si]-=HT[ti]; };
      const slots = slots0.map(x=>({...x, n:0, c:[0,0,0,0]}));
      const sh = [];
      const pickPerson = (list, done) => { let b=-1, bv=-Infinity; for (const ei of list){ if (done.has(ei)) continue; const m=maxRem(ei); if (m<hm-EPS) continue; const v=m+nSedi[ei]*6+noise(10); if (v>bv){ bv=v; b=ei; } } return b; };
      const partnerScore = (ei,sl) => -(dS[ei][sl.di]!==-1?6:0) + nSedi[ei]*2 - rem[ei][sl.si]/8 + noise(4);
      // 0. presenze fisse: si mettono per prime; un medico o un'ASO fissi ricevono subito il compagno di riunito
      const fx = STAFF.map(()=>new Array(ND*2).fill(false)), fm = [];
      const slotAt = {}; slots.forEach(sl=>slotAt[sl.si*100000+sl.di*2+sl.ti]=sl);
      const fixPut = (ei,si,di,ti,v) => { dS[ei][di]=si; dT[ei][di*2+ti]=v; dH[ei][di]+=HT[ti]; fx[ei][di*2+ti]=true; };
      for (const f of fixOcc){
        const {ei,si,di,c}=f, tipo=TIPO[ei];
        if (blk[ei][di]) continue;
        const miss = (why,ti) => fm.push([gd[di], {emp:c.emp, s:SEDI[si].id, t:ti===undefined?c.t:TT[ti], why}]);
        if (dS[ei][di]!==-1 && dS[ei][di]!==si){ miss("Ha già un'altra presenza fissa quel giorno"); continue; }
        for (const ti of f.ts){
          const quando = ti ? "al pomeriggio" : "al mattino";
          if (!open[si][di][ti]){ miss(`Sede chiusa ${quando}`, ti); continue; }
          if (dT[ei][di*2+ti]) continue;
          if (un[ei][di*2+ti]){ miss(`Non disponibile ${quando} (regola personale)`, ti); continue; }
          if (dH[ei][di]+HT[ti] > MAXG){ miss("Supera le ore massime del giorno", ti); continue; }
          const sl = slotAt[si*100000+di*2+ti];
          if (tipo==="Medico" || tipo==="ASO"){
            if (sl.n>=sl.R){ miss(`Riuniti tutti occupati ${quando}`, ti); continue; }
            let a=-1, av=Infinity; for (const x of (tipo==="Medico"?asos:meds)){ if (!can(x,si,di,ti)) continue; const q=partnerScore(x,sl); if (q<av){ av=q; a=x; } }
            if (a<0){ miss(tipo==="Medico" ? `Nessuna ASO libera ${quando}` : `Nessun medico libero ${quando}`, ti); continue; }
            sl.n++; fixPut(ei,si,di,ti,sl.n); put(a,si,di,ti,sl.n);
          } else { fixPut(ei,si,di,ti,-1); sl.c[tipoIdx[tipo]]++; }
        }
      }
      // 1. riuniti: un medico entra solo con un'ASO accanto
      const done = new Set();
      for (;;){
        const m = pickPerson(meds, done); if (m<0) break;
        let bs=null, ba=-1, sc=Infinity;
        for (const sl of slots){
          if (sl.n>=sl.R || !can(m,sl.si,sl.di,sl.ti)) continue;
          const v = sl.n*10 - (dS[m][sl.di]!==-1?6:0) + (open[sl.si][sl.di][1-sl.ti]?0:3) + noise(8);
          if (v>=sc) continue;
          let a=-1, av=Infinity;
          for (const x of asos){ if (!can(x,sl.si,sl.di,sl.ti)) continue; const q=partnerScore(x,sl); if (q<av){ av=q; a=x; } }
          if (a<0) continue;
          sc=v; bs=sl; ba=a;
        }
        if (!bs){ done.add(m); continue; }
        bs.n++; put(m,bs.si,bs.di,bs.ti,bs.n); put(ba,bs.si,bs.di,bs.ti,bs.n);
      }
      for (const sl of slots){ const mn=Math.min(REG.minRiuniti, sl.R); if (sl.n<mn) sh.push([gd[sl.di],{s:SEDI[sl.si].id, tipo:"Riunito", t:TT[sl.ti], n:mn-sl.n}]); }
      // 2. altre figure: prima i minimi per turno, poi le ore restanti dove c'è posto
      ALTRI.forEach((tipo,tx)=>{
        const ppl = altri[tx];
        const order = k===0 ? slots : [...slots].sort(()=>rnd()-.5);
        for (const sl of order){
          const n = sl.need[tx];
          while (sl.c[tx] < n){
            let c=-1, cv=Infinity;
            for (const ei of ppl){ if (!can(ei,sl.si,sl.di,sl.ti)) continue; const q=partnerScore(ei,sl); if (q<cv){ cv=q; c=ei; } }
            if (c<0) break; put(c,sl.si,sl.di,sl.ti,-1); sl.c[tx]++;
          }
          if (sl.c[tx] < n) sh.push([gd[sl.di],{s:SEDI[sl.si].id, tipo, t:TT[sl.ti], n:n-sl.c[tx]}]);
        }
        const fin = new Set();
        for (;;){
          const c = pickPerson(ppl, fin); if (c<0) break;
          let bs=null, sc=Infinity;
          for (const sl of slots){ if (sl.c[tx]>=sl.max[tx] || !can(c,sl.si,sl.di,sl.ti)) continue; const v=sl.c[tx]*10-(dS[c][sl.di]!==-1?6:0)+noise(8); if (v<sc){ sc=v; bs=sl; } }
          if (!bs){ fin.add(c); continue; }
          put(c,bs.si,bs.di,bs.ti,-1); bs.c[tx]++;
        }
      });
      let left = 0; for (const r of rem) for (const v of r) if (v>0) left+=v;
      const score = left + sh.reduce((a,[,x])=>a+x.n*20,0) + fm.length*30;
      if (!best || score<best.score) best = {score, sh, dS, dT, fx, fm};
      if (score===0) break;
    }
    STAFF.forEach((e,ei)=>{ for (let di=0; di<ND; di++){ const si=best.dS[ei][di]; if (si<0) continue;
      const p={s:SEDI[si].id}; for (let ti=0; ti<2; ti++){ const v=best.dT[ei][di*2+ti]; if (v) p[TT[ti]] = v>0 ? v : true; if (best.fx[ei][di*2+ti]) (p.fx ||= []).push(TT[ti]); } plan[e.id][gd[di]]=p; } });
    for (const [d,x] of best.fm) (fixMiss[d] ||= []).push(x);
    for (const [d,x] of best.sh) (short[d] ||= []).push(x);
  }
  genAt = nowStr(); dirty = false;
}
// ore in avanzo: ore previste che non hanno trovato posto, per persona e sede, nel mese
const weekMonth = w => { const th=addDays(w,3); return MONTHS.find(m=>th.startsWith(m)) || (th<MONTHS[0]+"-01" ? MONTHS[0] : MONTHS[MONTHS.length-1]); };
function freeSlotFor(e,s,days,full_){ // c'era un turno aperto, con il riunito libero (o posto per la figura), in cui la persona era libera?
  return days.some(d=>!blocked(e.id,d) && ["M","P"].some(t=>{
    if (!isOpen(s,d)[t]) return false;
    const p=plan[e.id]?.[d]; if (p && (p.s!==s || p[t] || hoursOn(e.id,d)+H(t)>REG.maxGiorno)) return false;
    if (!p && H(t)>REG.maxGiorno) return false;
    return full_(d,t);
  }));
}
function avanzi(ym){
  const out = {};
  for (const [w,wd] of Object.entries(weeksMap())){
    if (weekMonth(w)!==ym) continue;
    for (const e of STAFF) for (const s of sediOf(e)){
      const b=budget(e,s,wd), p=placedIn(e,s,wd), k=e.id+"|"+s;
      out[k] ||= {e, s, prev:0, coll:0, days:[], small:true};
      out[k].prev+=b; out[k].coll+=Math.min(p,b);
      if (b-p>0.01){ out[k].days.push(...wd); if (b-p>=hMin()) out[k].small=false; }
    }
  }
  return Object.values(out).map(x=>({...x, avz:x.prev-x.coll})).filter(x=>x.avz>0.01).map(x=>{
    const {e,s,days}=x; let why;
    if (x.small) why = "Avanzano meno ore di un turno";
    else if (e.tipo==="Medico") why = freeSlotFor(e,s,days,(d,t)=>inShift(s,d,t,"Medico").length<riuniti(s,d)) ? "Nessuna ASO libera da affiancare" : "Riuniti tutti occupati";
    else if (e.tipo==="ASO") why = freeSlotFor(e,s,days,(d,t)=>inShift(s,d,t,"Medico").length<riuniti(s,d)) ? "Nessun medico libero da affiancare" : "Riuniti tutti occupati";
    else why = `Turni già al completo (max ${REG.altri[e.tipo].max} per turno)`;
    return {...x, why};
  }).sort((a,b)=>b.avz-a.avz);
}
function suggerimenti(list){
  const out=[], sum=(s,tipo,why)=>list.filter(x=>x.s===s && x.e.tipo===tipo && x.why.startsWith(why)).reduce((a,x)=>a+x.avz,0), hm=hMin();
  for (const y of SEDI){
    const senzaAso = sum(y.id,"Medico","Nessuna ASO");
    if (senzaAso>=hm){
      const x = SEDI.filter(x=>x!==y).map(x=>[x, sum(x.id,"ASO","Nessun medico")]).filter(([,h])=>h>=hm).sort((a,b)=>b[1]-a[1])[0];
      if (x){ const ponte = STAFF.find(a=>a.tipo==="ASO" && (a.ore[x[0].id]||0)>0 && (a.ore[y.id]||0)>0);
        out.push([senzaAso, `A ${y.nome} restano ${fmtH(senzaAso)} di medici senza ASO, mentre a ${x[0].nome} avanzano ${fmtH(x[1])} di ASO senza medico. ${ponte?`Puoi spostare ore di ${full(ponte)}, che lavora già in entrambe le sedi.`:`Puoi spostare ore di un'ASO da ${x[0].nome} a ${y.nome}.`}`]); }
      else out.push([senzaAso, `A ${y.nome} restano ${fmtH(senzaAso)} di medici senza ASO: servono più ore di ASO in questa sede.`]);
    }
    const pieni = sum(y.id,"Medico","Riuniti");
    if (pieni>=2*hm) out.push([pieni, `A ${y.nome} i riuniti sono tutti occupati e restano ${fmtH(pieni)} di medici: aggiungi un riunito o sposta ore in un'altra sede.`]);
  }
  for (const tipo of ALTRI){ const h=list.filter(x=>x.e.tipo===tipo && x.why.startsWith("Turni già")).reduce((a,x)=>a+x.avz,0);
    if (h>=2*hm) out.push([h, `${tipo}: ${fmtH(h)} senza posto perché i turni hanno già ${REG.altri[tipo].max} ${REG.altri[tipo].max===1?"persona":"persone"}. Alza il massimo in Regole o riduci le ore in Personale.`]); }
  return out.sort((a,b)=>b[0]-a[0]).slice(0,4).map(x=>x[1]);
}

// ================= assenze approvate: il sostituto prende i turni =================
function freeAt(x,s,d,t){ if (blocked(x.id,d) || !isOpen(s,d)[t]) return false; const p=plan[x.id]?.[d]; if (!p) return H(t)<=REG.maxGiorno; return p.s===s && !p[t] && hoursOn(x.id,d)+H(t)<=REG.maxGiorno; }
function applySubstitution(r){
  let dalSost=0, altri=0, scoperti=0, fermi=0;
  const tipo = emp(r.emp).tipo, sub = r.sost && emp(r.sost);
  for (let d=r.dal; d<=r.al; d=addDays(d,1)){
    const p = plan[r.emp]?.[d]; if (!p) continue;
    delete plan[r.emp][d];
    for (const t of shiftsOf(p)){
      const v = p[t];
      if (sub && plan[sub.id] && freeAt(sub,p.s,d,t)){ plan[sub.id][d] ||= {s:p.s}; plan[sub.id][d][t]=v; dalSost++; continue; }
      if (tipo!=="Medico" && tipo!=="ASO" && inShift(p.s,d,t,tipo).length >= need(p.s,d,tipo,t)) continue;
      const o = STAFF.filter(x=>x.tipo===tipo && x.id!==r.emp && (x.ore[p.s]||0)>0 && freeAt(x,p.s,d,t))
        .sort((a,b)=>placedIn(a,p.s,[d])-placedIn(b,p.s,[d]))[0];
      if (o){ plan[o.id][d] ||= {s:p.s}; plan[o.id][d][t]=v; altri++; continue; }
      if (tipo==="Medico" || tipo==="ASO"){ // un riunito non può restare con una sola persona: si ferma
        const other = tipo==="Medico"?"ASO":"Medico";
        STAFF.filter(x=>x.tipo===other && plan[x.id]?.[d]?.s===p.s && plan[x.id][d][t]===v).forEach(x=>{ delete plan[x.id][d][t]; if (!shiftsOf(plan[x.id][d]).length) delete plan[x.id][d]; });
        fermi++;
        if (inShift(p.s,d,t,"Medico").length < Math.min(REG.minRiuniti, riuniti(p.s,d))) (short[d] ||= []).push({s:p.s, tipo:"Riunito", t, n:1});
      } else { (short[d] ||= []).push({s:p.s, tipo, t, n:need(p.s,d,tipo,t)-inShift(p.s,d,t,tipo).length}); scoperti++; }
    }
  }
  return {dalSost, altri, scoperti, fermi};
}
const DAYH = () => Math.min(REG.maxGiorno, H("M")+H("P"));
const TURNI_TXT = {G:"giornata intera", M:"mattina", P:"pomeriggio"};
// non disponibilità personali (da regole scritte): giorno della settimana e/o periodo, per turno
const unavMatch = (u,d,t) => (u.dow==null || dow(d)===u.dow) && (!u.dal || d>=u.dal) && (!u.al || d<=u.al) && (u.t==="G" || u.t===t);
const unavTxt = u => `${u.dow!=null?"il "+DOWL[u.dow]:"tutti i giorni"}${u.dal?` dal ${fmt(u.dal)}`:""}${u.al?` al ${fmt(u.al)}`:""}${u.t==="G"?"":u.t==="M"?" al mattino":" al pomeriggio"}`;
// configurazione per sede di ogni collaboratore (quello che si imposta nella scheda)
const cfgDefault = () => ({rep:"settimana", unit:"ore", val:16, giorni:[2], turno:"G", freq:"mensile", settimane:[1,3], dal:TODAY});
// dalla scheda alle regole del generatore: ore settimanali + presenze fisse
function cfgToCad(e, s, x){
  if (x.rep==="settimana") return [];
  if (x.rep==="fissi") return x.giorni.map(w=>({emp:e.id, sede:s, n:[0], dow:w, t:x.turno, src:"cfg"}));
  if (x.freq==="2sett") return x.giorni.map(w=>({emp:e.id, sede:s, n:[0], dow:w, t:x.turno, ogni:2, dal:x.dal||TODAY, src:"cfg"}));
  return x.giorni.map(w=>({emp:e.id, sede:s, n:[...x.settimane], dow:w, t:x.turno, src:"cfg"}));
}
const cfgHours = x => x.rep!=="settimana" ? 0 : (x.unit==="giorni" ? x.val*DAYH() : x.val);
function cfgTxt(x){
  if (x.rep==="settimana") return x.unit==="giorni" ? `${x.val} ${x.val===1?"giorno":"giorni"} a settimana, giorni scelti dall'app` : `${x.val} h a settimana, giorni scelti dall'app`;
  const gg = listIt([...x.giorni].sort((a,b)=>(a||7)-(b||7)).map(w=>DOWL[w]));
  if (!x.giorni.length) return "nessun giorno scelto";
  if (x.rep==="fissi") return `ogni ${gg} · ${TURNI_TXT[x.turno]}`;
  if (x.freq==="2sett") return `ogni 2 settimane il ${gg} (dal ${fmt(x.dal||TODAY)}) · ${TURNI_TXT[x.turno]}`;
  return `${listIt([...x.settimane].sort().map(n=>NTH[n]==="ultimo"?"ultimo":NTH[n]))} ${gg} del mese · ${TURNI_TXT[x.turno]}`;
}
const nextDates = (e, s, x) => { const cs = cfgToCad(e,s,x); return allDays().filter(d=>d>=TODAY && cs.some(c=>cadMatch(c,d))).slice(0,5); };

// ---------- regole scritte → azioni ----------
const AZ_GIORNO = g => DOWL[g] || "?";
function azioneTxt(a){
  const P = id => full(emp(id)), S = id => sede(id)?.nome || id;
  switch (a.azione){
    case "deroga_sede": { const q = a.quando==="giorno"?`ogni ${AZ_GIORNO(a.giorno)}`:a.quando==="data"?`il ${fmt(a.data)}`:"sempre";
      const c = {chiusa:"chiusa", solo_mattina:"aperta solo al mattino", aperta:"aperta mattina e pomeriggio", riuniti:`${a.numero} riuniti disponibili`, minimo:`almeno ${a.numero} ${a.figura} ${a.turno==="M"?"al mattino":a.turno==="P"?"al pomeriggio":"per turno"}`}[a.cosa] || a.cosa;
      return `${S(a.sede)}: ${c}, ${q}`; }
    case "presenza_fissa": return `${P(a.persona)} va a ${S(a.sede)} ${a.ogni_due_settimane?`ogni 2 settimane il ${AZ_GIORNO(a.giorno)}`:a.settimane?.includes(0)?`ogni ${AZ_GIORNO(a.giorno)}`:`il ${listIt((a.settimane||[]).map(n=>n===5?"ultimo":NTH[n]))} ${AZ_GIORNO(a.giorno)} del mese`} · ${TURNI_TXT[a.turno]||a.turno}`;
    case "non_disponibile": return `${P(a.persona)} non è disponibile ${unavTxt({dow:a.giorno??null, dal:a.dal, al:a.al, t:a.turno||"G"})}`;
    case "ore_settimanali": return `${P(a.persona)}: ${a.ore} h a settimana a ${S(a.sede)}`;
    case "riuniti": return `${S(a.sede)}: ${a.numero} riuniti`;
    case "limiti_figura": return `${a.figura} per turno: ${a.minimo!=null?"minimo "+a.minimo:""}${a.minimo!=null&&a.massimo!=null?", ":""}${a.massimo!=null?"massimo "+a.massimo:""}`;
    default: return a.motivo ? `Non posso applicarlo: ${a.motivo}` : "Azione non riconosciuta";
  }
}
function azioneValida(a){
  const pe = id => STAFF.some(e=>e.id===id), se = id => !!sede(id), g = n => Number.isInteger(n) && n>=0 && n<=6, dt = s => !s || (/^\d{4}-\d{2}-\d{2}$/.test(s));
  switch (a?.azione){
    case "deroga_sede": return se(a.sede) && ["sempre","giorno","data"].includes(a.quando) && (a.quando!=="giorno"||g(a.giorno)) && (a.quando!=="data"||dt(a.data)&&a.data) && ["chiusa","solo_mattina","aperta","riuniti","minimo"].includes(a.cosa) && (!["riuniti","minimo"].includes(a.cosa) || Number.isFinite(+a.numero)) && (a.cosa!=="minimo" || ALTRI.includes(a.figura));
    case "presenza_fissa": return pe(a.persona) && se(a.sede) && g(a.giorno) && a.giorno>0 && ["M","P","G"].includes(a.turno) && (a.ogni_due_settimane || (Array.isArray(a.settimane) && a.settimane.length && a.settimane.every(n=>n>=0&&n<=5)));
    case "non_disponibile": return pe(a.persona) && (a.giorno==null || g(a.giorno)) && dt(a.dal) && dt(a.al) && ["M","P","G"].includes(a.turno||"G");
    case "ore_settimanali": return pe(a.persona) && se(a.sede) && Number.isFinite(+a.ore) && +a.ore>=0 && +a.ore<=REG.maxGiorno*6;
    case "riuniti": return se(a.sede) && Number.isFinite(+a.numero) && +a.numero>=0;
    case "limiti_figura": return ALTRI.includes(a.figura);
    default: return false;
  }
}
function applyAzioni(azioni, rid){
  for (const a of azioni){
    if (a.azione==="deroga_sede"){
      const x = {id:uid(), sede:a.sede, quando:a.quando==="giorno"?"dow":a.quando, cosa:{solo_mattina:"mattina", minimo:"fabb"}[a.cosa]||a.cosa, nota:"Da regola scritta", src:rid};
      if (x.quando==="dow") x.dow=a.giorno; if (x.quando==="data") x.data=a.data;
      if (x.cosa==="riuniti"||x.cosa==="fabb") x.n=+a.numero; if (x.cosa==="fabb"){ x.tipo=a.figura; x.turno=a.turno||"MP"; }
      DEROGHE.push(x);
    } else if (a.azione==="presenza_fissa"){
      CAD.push({id:uid(), emp:a.persona, sede:a.sede, n:a.ogni_due_settimane?[0]:[...a.settimane], dow:a.giorno, t:a.turno, ...(a.ogni_due_settimane?{ogni:2, dal:TODAY}:{}), src:rid});
    } else if (a.azione==="non_disponibile"){
      UNAV.push({id:uid(), emp:a.persona, dow:a.giorno??null, t:a.turno||"G", dal:a.dal||null, al:a.al||null, src:rid});
    } else if (a.azione==="ore_settimanali"){
      const e = emp(a.persona); e.cfg[a.sede] = {...(e.cfg[a.sede]||cfgDefault()), rep:"settimana", unit:"ore", val:+a.ore};
      if (+a.ore>0) e.ore[a.sede]=+a.ore; else { delete e.ore[a.sede]; delete e.cfg[a.sede]; }
    } else if (a.azione==="riuniti"){ sede(a.sede).riuniti = +a.numero; }
    else if (a.azione==="limiti_figura"){ const r=REG.altri[a.figura]; if (a.minimo!=null) r.min=+a.minimo; if (a.massimo!=null) r.max=Math.max(+a.massimo, r.min); }
  }
}
const permanente = a => ["ore_settimanali","riuniti","limiti_figura"].includes(a.azione);
function removeRule(id){
  DEROGHE = DEROGHE.filter(x=>x.src!==id); CAD = CAD.filter(x=>x.src!==id); UNAV = UNAV.filter(x=>x.src!==id);
  RULES_TXT = RULES_TXT.filter(r=>r.id!==id);
}
const turnoTxt = t => `${t==="M"?"Mattina":"Pomeriggio"} ${REG.ore[t].join("–")}`;
const sedeList = e => sediOf(e).map(s=>sede(s)?.nome).join(", ");
const sedeKey = () => `<div class="sedekey"><span class="mono">Sigle delle sedi</span>${SEDI.map(s=>`<span><span class="sigla xs">${esc(s.sigla)}</span> ${esc(s.nome)}</span>`).join("")}</div>`;
const oreList = e => sediOf(e).map(s=>`${sede(s).nome} ${e.ore[s]} h`).join(", ");
const partnerOf = (id,d,t) => { const p=plan[id]?.[d], v=p?.[t]; if (typeof v!=="number") return null; const o=emp(id).tipo==="Medico"?"ASO":"Medico";
  return STAFF.find(x=>x.tipo===o && plan[x.id]?.[d]?.s===p.s && plan[x.id][d][t]===v) || null; };
const cellCode = p => { const sh=shiftsOf(p); return sh.length===2 ? "G" : sh[0]; };
const cellLabel = p => { const sh=shiftsOf(p); if (sh.length===2) return "G"; const v=p[sh[0]]; return sh[0]+(typeof v==="number"?`<sub>${v}</sub>`:""); };
const shiftTip = (id,d) => { const p=plan[id][d]; return shiftsOf(p).map(t=>{ const v=p[t], pa=partnerOf(id,d,t); return turnoTxt(t)+(typeof v==="number"?` · riunito ${v}${pa?" con "+full(pa):""}`:"")+((p.fx||[]).includes(t)?" · presenza fissa":""); }).join("\n"); };
function oreMese(e, ym){ let prev=0, coll=0; for (const [w,wd] of Object.entries(weeksMap())){ if (weekMonth(w)!==ym) continue; for (const s of sediOf(e)){ const b=budget(e,s,wd); prev+=b; coll+=Math.min(b,placedIn(e,s,wd)); } } return {prev, coll}; }
function conChi(id,d,t){
  const p=plan[id][d], v=p[t], pa=partnerOf(id,d,t);
  const others = STAFF.filter(x=>x.id!==id && x!==pa && plan[x.id]?.[d]?.s===p.s && plan[x.id][d][t] && !blocked(x.id,d));
  const parts = [];
  if (typeof v==="number") parts.push(pa ? `Riunito ${v} con <b>${esc(full(pa))}</b> (${pa.tipo})` : `Riunito ${v}`);
  if (others.length) parts.push(`${typeof v==="number"?"In sede anche":"Con"} ${others.map(x=>`<b>${esc(full(x))}</b> (${x.tipo})`).join(", ")}`);
  return parts.join(" · ") || "Nessun collega nello stesso turno";
}

// festivi nazionali italiani per gli anni dei mesi in planning (Pasquetta compresa)
function calcFestivi(months){
  const out = {}, anni = [...new Set(months.map(m=>+m.slice(0,4)))];
  for (const y of anni){
    const a=y%19,b=Math.floor(y/100),c=y%100,d=Math.floor(b/4),e=b%4,f=Math.floor((b+8)/25),g=Math.floor((b-f+1)/3),h=(19*a+b-d-g+15)%30,i=Math.floor(c/4),k=c%4,l=(32+2*e+2*i-h-k)%7,m=Math.floor((a+11*h+22*l)/451),mo=Math.floor((h+l-7*m+114)/31),da=((h+l-7*m+114)%31)+1;
    const pasqua = `${y}-${pad(mo)}-${pad(da)}`;
    Object.assign(out, {[`${y}-01-01`]:"Capodanno", [`${y}-01-06`]:"Epifania", [pasqua]:"Pasqua", [addDays(pasqua,1)]:"Pasquetta", [`${y}-04-25`]:"Liberazione",
      [`${y}-05-01`]:"Festa del lavoro", [`${y}-06-02`]:"Festa della Repubblica", [`${y}-08-15`]:"Ferragosto", [`${y}-11-01`]:"Ognissanti",
      [`${y}-12-08`]:"Immacolata", [`${y}-12-25`]:"Natale", [`${y}-12-26`]:"Santo Stefano"});
  }
  return out;
}
// mesi del planning: il precedente, quello in corso e i due successivi
function calcMonths(today){
  const [y,m] = today.split("-").map(Number), out=[];
  for (let k=-1; k<=2; k++){ const t=new Date(y, m-1+k, 15); out.push(`${t.getFullYear()}-${pad(t.getMonth()+1)}`); }
  return out;
}
