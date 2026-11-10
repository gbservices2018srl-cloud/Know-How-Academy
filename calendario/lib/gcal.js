// Eventi del Calendario nel Google Calendar di ogni persona, SOLO IN USCITA e SENZA EMAIL.
// Ogni persona ha un indirizzo privato (con una chiave segreta) del suo calendario To Smile: lo aggiunge una volta in Google
// Calendar ("Da URL") e Google lo rilegge da solo (di solito ogni 8-24 ore). Dentro ci sono gli eventi a cui ha detto
// «Ci sarò» e quelli che ha creato. L'app non legge niente dal calendario della persona.
const crypto = require('crypto');
const db = require('./db');

async function migrate() {
  await db.q(`
    alter table users add column if not exists gcal_email text;
    alter table users add column if not exists gcal_chiesto boolean not null default false;
    alter table users add column if not exists gcal_token text unique;
    alter table users add column if not exists gcal_collegato timestamptz;
    alter table events add column if not exists created_by_id text;
  `);
  // eventi creati prima: chi li ha creati si ricava da "modificato da" (nome della persona)
  await db.q(`update events e set created_by_id = (select u.id from users u where u.name = e.updated_by order by u.role = 'admin' desc limit 1)
    where e.created_by_id is null and e.updated_by is not null`);
}

const escI = s => String(s || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
// righe lunghe spezzate a 75 caratteri come chiede lo standard
const piega = l => { let out = '', x = l; while (Buffer.byteLength(x) > 74) { let n = 74; while (Buffer.byteLength(x.slice(0, n)) > 74) n--; out += x.slice(0, n) + '\r\n '; x = x.slice(n); } return out + x; };
const TZ = ['BEGIN:VTIMEZONE', 'TZID:Europe/Rome', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'END:STANDARD',
  'BEGIN:DAYLIGHT', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'END:DAYLIGHT', 'END:VTIMEZONE'];

function vevent(e) {
  const d = s => String(s).replace(/-/g, '');
  const giornoDopo = s => { const x = new Date(s + 'T12:00:00Z'); x.setUTCDate(x.getUTCDate() + 1); return x.toISOString().slice(0, 10); };
  const fine = e.end_date || e.start_date;
  let quando;
  if (e.all_day || !e.start_time) quando = [`DTSTART;VALUE=DATE:${d(e.start_date)}`, `DTEND;VALUE=DATE:${d(giornoDopo(fine))}`];
  else {
    const t = s => String(s).slice(0, 5).replace(':', '') + '00';
    const et = e.end_time || (() => { const [h, m] = String(e.start_time).split(':').map(Number); const x = Math.min(h * 60 + m + 60, 23 * 60 + 59); return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`; })();
    quando = [`DTSTART;TZID=Europe/Rome:${d(e.start_date)}T${t(e.start_time)}`, `DTEND;TZID=Europe/Rome:${d(fine)}T${t(et)}`];
  }
  const luogo = [e.loc_name, e.loc_address, e.location_note].filter(Boolean).join(' · ');
  const descr = [e.type_name, e.description, e.link].filter(Boolean).join('\n\n');
  const agg = new Date(e.updated_at || Date.now()).toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  return ['BEGIN:VEVENT', `UID:${e.id}@calendario.appgestione.it`, `DTSTAMP:${agg}`, `LAST-MODIFIED:${agg}`, ...quando, `SUMMARY:${escI(e.title)}`,
    luogo && `LOCATION:${escI(luogo)}`, descr && `DESCRIPTION:${escI(descr)}`, e.link && `URL:${e.link}`, 'STATUS:CONFIRMED', 'TRANSP:OPAQUE', 'END:VEVENT'].filter(Boolean);
}
function calendario(eventi, nome) {
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//To Smile//Calendario eventi//IT', 'CALSCALE:GREGORIAN', 'METHOD:PUBLISH',
    `X-WR-CALNAME:${escI(nome)}`, 'X-WR-TIMEZONE:Europe/Rome', 'REFRESH-INTERVAL;VALUE=DURATION:PT1H', 'X-PUBLISHED-TTL:PT1H',
    ...TZ, ...eventi.flatMap(vevent), 'END:VCALENDAR'].map(piega).join('\r\n');
}
// un solo evento (pulsante "scarica .ics")
const ics = e => calendario([e], 'To Smile · Eventi');

const COLS = `e.id, e.title, e.location_note, e.start_date::text as start_date, e.end_date::text as end_date, e.all_day,
  to_char(e.start_time, 'HH24:MI') as start_time, to_char(e.end_time, 'HH24:MI') as end_time, e.description, e.link, e.updated_at,
  t.name as type_name, l.name as loc_name, l.address as loc_address`;
const FROM = 'from events e left join event_types t on t.id = e.type_id left join locations l on l.id = e.location_id';

// il calendario privato di una persona: eventi a cui ha detto «Ci sarò» e quelli che ha creato (dagli ultimi 60 giorni in poi)
async function feed(token) {
  if (!/^[a-f0-9]{40}$/.test(String(token || ''))) return null;
  const { rows: [u] } = await db.q('select id, name, active from users where gcal_token = $1', [token]);
  if (!u || !u.active) return null;
  const { rows } = await db.q(`select ${COLS} ${FROM}
    where coalesce(e.end_date, e.start_date) >= (now() at time zone 'Europe/Rome')::date - 60
      and (e.created_by_id = $1 or exists (select 1 from rsvp r where r.event_id = e.id and r.user_id = $1 and r.status = 'yes' and not r.da_riconfermare))
    order by e.start_date`, [u.id]);
  await db.q('update users set gcal_collegato = now() where id = $1', [u.id]).catch(() => {});
  return calendario(rows, 'To Smile · Eventi');
}
async function evento(id) {
  const { rows } = await db.q(`select ${COLS} ${FROM} where e.id = $1`, [id]);
  return rows[0] || null;
}
// chiave dell'indirizzo privato (creata la prima volta; "nuova" la cambia e il vecchio indirizzo smette di funzionare)
async function token(userId, nuova = false) {
  const { rows: [u] } = await db.q('select gcal_token from users where id = $1', [userId]);
  if (u?.gcal_token && !nuova) return u.gcal_token;
  const t = crypto.randomBytes(20).toString('hex');
  await db.q('update users set gcal_token = $2, gcal_chiesto = true where id = $1', [userId, t]);
  return t;
}

module.exports = { migrate, ics, evento, feed, token };
