// Figure professionali del gruppo (solo per il Medico odontoiatra si chiede l'iscrizione all'albo): una sola lista per tutte le app (accesso unico, Turni, Calendario, Protocolli…).
// (le figure «ritirata» restano valide per chi le ha già, ma non compaiono più nelle scelte)
// La persona la sceglie quando si registra, l'amministratore la conferma o la corregge nel pannello accessi.
module.exports = [
  { id: 'Medico', nome: 'Medico odontoiatra', gruppo: 'Medici' },
  { id: 'Igienista', nome: 'Igienista dentale', gruppo: 'Igienisti' },
  { id: 'ASO', nome: 'ASO (assistente alla poltrona)', gruppo: 'ASO' },
  { id: 'REC', nome: 'REC (reception)', gruppo: 'REC' },
  { id: 'RAP', nome: 'RAP', gruppo: 'RAP' },
  { id: 'RUL', nome: 'RUL', gruppo: 'RUL' },
  // ritirata: non si sceglie più; chi ce l'ha resta segnato «da rivedere» nel pannello accessi finché l'amministratore non la cambia
  { id: 'Extrambulatoriale', nome: 'Extrambulatoriale', gruppo: 'Extrambulatoriali', ritirata: true },
  { id: 'Manager', nome: 'Manager', gruppo: 'Manager' },
  { id: 'MiddleManager', nome: 'Middle manager', gruppo: 'Middle manager' },
  { id: 'OperationExtra', nome: 'Operation extra-ambulatoriale', gruppo: 'Operation extra-ambulatoriale' },
];
