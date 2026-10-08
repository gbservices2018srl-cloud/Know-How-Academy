// Figure professionali del gruppo: una sola lista per tutte le app (accesso unico, Turni, Calendario, Protocolli…).
// La persona la sceglie quando si registra, l'amministratore la conferma o la corregge nel pannello accessi.
module.exports = [
  { id: 'Medico', nome: 'Medico / odontoiatra', gruppo: 'Medici' },
  { id: 'ASO', nome: 'ASO (assistente alla poltrona)', gruppo: 'ASO' },
  { id: 'REC', nome: 'REC (reception)', gruppo: 'REC' },
  { id: 'RAP', nome: 'RAP', gruppo: 'RAP' },
  { id: 'RUL', nome: 'RUL', gruppo: 'RUL' },
  { id: 'Extrambulatoriale', nome: 'Extrambulatoriale', gruppo: 'Extrambulatoriali' },
  { id: 'Altro', nome: 'Altro', gruppo: 'Altro' },
];
