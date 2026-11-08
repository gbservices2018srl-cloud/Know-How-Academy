// Tag NFC NTAG 424 DNA con SUN (Secure Unique NFC): ogni lettura produce un URL nuovo con
//   e = dati cifrati (UID del tag + contatore delle letture)   c = firma (CMAC troncato a 8 byte)
// Così un link copiato o una foto del tag non bastano per timbrare: serve appoggiare il telefono al tag.
// Chiave: NFC_SDM_KEY su Render (32 cifre esadecimali), la stessa per lettura e firma; se manca si usa la chiave di fabbrica (tutti zeri).
const crypto = require('crypto');

const chiave = () => {
  const k = String(process.env.NFC_SDM_KEY || '').trim();
  return /^[0-9a-f]{32}$/i.test(k) ? Buffer.from(k, 'hex') : Buffer.alloc(16);
};
const xor = (a, b) => { const o = Buffer.alloc(16); for (let i = 0; i < 16; i++) o[i] = a[i] ^ b[i]; return o; };
function aes(key, b) { const c = crypto.createCipheriv('aes-128-ecb', key, null); c.setAutoPadding(false); return Buffer.concat([c.update(b), c.final()]); }
// AES-CMAC (RFC 4493)
function cmac(key, msg) {
  const dbl = b => { const o = Buffer.alloc(16); let carry = 0; for (let i = 15; i >= 0; i--) { o[i] = ((b[i] << 1) | carry) & 0xff; carry = b[i] >> 7; } if (b[0] & 0x80) o[15] ^= 0x87; return o; };
  const K1 = dbl(aes(key, Buffer.alloc(16))), K2 = dbl(K1);
  const n = Math.max(1, Math.ceil(msg.length / 16)), completo = msg.length > 0 && msg.length % 16 === 0;
  let ultimo;
  if (completo) ultimo = xor(msg.subarray((n - 1) * 16, n * 16), K1);
  else { const p = Buffer.alloc(16); msg.copy(p, 0, (n - 1) * 16); p[msg.length - (n - 1) * 16] = 0x80; ultimo = xor(p, K2); }
  let X = Buffer.alloc(16);
  for (let i = 0; i < n - 1; i++) X = aes(key, xor(X, msg.subarray(i * 16, i * 16 + 16)));
  return aes(key, xor(X, ultimo));
}
// Verifica: restituisce { uid, ctr } se il link è autentico, altrimenti null
function verifica(eHex, cHex, key = chiave()) {
  if (!/^[0-9a-f]{32}$/i.test(eHex || '') || !/^[0-9a-f]{16}$/i.test(cHex || '')) return null;
  const d = crypto.createDecipheriv('aes-128-cbc', key, Buffer.alloc(16)); d.setAutoPadding(false);
  const p = Buffer.concat([d.update(Buffer.from(eHex, 'hex')), d.final()]);
  if (p[0] !== 0xC7) return null; // deve contenere UID (7 byte) e contatore (3 byte)
  const uid = p.subarray(1, 8), ctrB = p.subarray(8, 11);
  const sv2 = Buffer.concat([Buffer.from('3CC300010080', 'hex'), uid, ctrB]);
  const ses = cmac(key, sv2);
  const full = cmac(ses, Buffer.alloc(0));
  const mac = Buffer.from([1, 3, 5, 7, 9, 11, 13, 15].map(i => full[i]));
  if (!crypto.timingSafeEqual(mac, Buffer.from(cHex, 'hex'))) return null;
  return { uid: uid.toString('hex').toUpperCase(), ctr: ctrB[0] | (ctrB[1] << 8) | (ctrB[2] << 16) };
}
module.exports = { verifica, cmac, chiaveDiFabbrica: () => !/^[0-9a-f]{32}$/i.test(String(process.env.NFC_SDM_KEY || '').trim()) };
