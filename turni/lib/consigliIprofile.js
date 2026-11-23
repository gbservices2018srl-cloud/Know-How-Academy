// Miglioramento personale: corsi e letture consigliati in base all'I-Profile (dal file «Competenze e formazione»).
// Per ogni tratto: quando il valore è nella fascia indicata, si consigliano il corso e la lettura.
const TABELLA = [
  { k: 'org', nome: 'Organizzazione', se: v => v < 60, soglia: 'sotto 60', corso: 'Time management', lettura: 'I nuovi condottieri, capitolo 6' },
  { k: 'auto', nome: 'Automotivazione', se: v => v < 30, soglia: 'sotto 30', corso: 'Scrivi le tue mete', lettura: 'I nuovi condottieri, capitoli 1 e 2' },
  { k: 'gp', nome: 'Gestione pressioni', se: v => v >= -21 && v <= 69, soglia: 'tra −21 e +69', corso: 'Corso di gestione pressioni', lettura: 'Dispensa su come gestire la persona demotivante' },
  { k: 'ad', nome: 'Autodisciplina', se: v => v < 60, soglia: 'sotto 60', corso: 'Corso di time management + corso rimedio disciplina', lettura: 'I nuovi condottieri, capitolo 6' },
  { k: 'det', nome: 'Determinazione', se: v => v < 30, soglia: 'sotto 30', corso: 'Corso di comunicazione', lettura: '' },
  { k: 'vend', nome: 'Attitudine alla vendita', se: v => v < 30, soglia: 'sotto 30', corso: 'Corso di vendita', lettura: 'I nuovi condottieri, capitolo 2 + Vendere in un\'ora' },
  { k: 'hr', nome: 'HR management', se: v => v < 30, soglia: 'sotto 30', corso: 'Corso RUL + corso leadership', lettura: 'Manuale delle linee guida di HR; I nuovi condottieri, parte 3' },
  { k: 'pro', nome: 'Proattività', se: v => v < 40, soglia: 'sotto 40', corso: '', lettura: 'I nuovi condottieri, capitoli 3 e 4' },
  { k: 'com', nome: 'Comprensione', se: v => v < 15, soglia: 'sotto 15', corso: 'Corso di comunicazione', lettura: 'I nuovi condottieri, capitolo 4' },
  { k: 'esp', nome: 'Espansività', se: v => v < 30, soglia: 'sotto 30', corso: 'Corso di public speaking', lettura: '' },
];
function consigli(valori) {
  if (!valori) return [];
  return TABELLA.filter(t => valori[t.k] != null && valori[t.k] !== '' && isFinite(Number(valori[t.k])) && t.se(Number(valori[t.k])))
    .map(t => ({ titolo: t.nome, corso: t.corso, lettura: t.lettura, perche: `Il tuo valore è ${Number(valori[t.k])}: consigliato quando è ${t.soglia}` }));
}
module.exports = { consigli, TABELLA };
