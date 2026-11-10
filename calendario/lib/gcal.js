// Eventi del Calendario nel Google Calendar di ogni persona, SOLO IN USCITA.
// Come: un invito via email (file .ics "METHOD:REQUEST") all'indirizzo Google che la persona ha indicato:
// Google lo aggiunge da solo al suo calendario. Se l'evento cambia parte un aggiornamento (stesso UID, SEQUENCE più alta),
// se la persona dice "non ci sarò" o l'evento viene tolto parte l'annullamento (METHOD:CANCEL).
// Nessun accesso al calendario della persona: l'app non legge niente da Google.
const db = require('./db');
const mail = require('../../accessi/lib/mail');

async function migrate() {
  await db.q(`
    alter table users add column if not exists gcal_email text;
    alter table users add column if not exists gcal_chiesto boolean not null default false;
    alter table events add column if not exists created_by_id text;
    create table if not exists gcal_invii (event_id text not null, user_id text not null, email text not null, seq int not null default 0,
      attivo boolean not null default true, il timestamptz not null default now(), primary key (event_id, user_id));
  `);
  // eventi creati prima: chi li ha creati si ricava da "modificato da" (nome della persona)
  await db.q(`update events e set created_by_id = (select u.id from users u where u.name = e.updated_by order by u.role = 'admin' desc limit 1)
    where e.created_by_id is null and e.updated_by is not null`);
}

const escI = s => String(s || '').replace(/\\/g, '\\\\').replace(/\r?\n/g, '\\n').replace(/([,;])/g, '\\$1');
// righe lunghe spezzate a 75 caratteri come chiede lo standard
const piega = l => { let out = '', x = l; while (Buffer.byteLength(x) > 74) { let n = 74; while (Buffer.byteLength(x.slice(0, n)) > 74) n--; out += x.slice(0, n) + '\r\n '; x = x.slice(n); } return out + x; };
const mailDi = from => (String(from).match(/<([^>]+)>/) || [, from])[1];

// testo .ics dell'evento (lo usa anche il pulsante "scarica")
function ics(e, { metodo = null, seq = 0, email = null, annullato = false } = {}) {
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
  const ora = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+/, '');
  const org = mailDi(process.env.MAIL_FROM || 'accessi@appgestione.it');
  const tz = ['BEGIN:VTIMEZONE', 'TZID:Europe/Rome', 'BEGIN:STANDARD', 'DTSTART:19701025T030000', 'RRULE:FREQ=YEARLY;BYMONTH=10;BYDAY=-1SU', 'TZOFFSETFROM:+0200', 'TZOFFSETTO:+0100', 'TZNAME:CET', 'END:STANDARD',
    'BEGIN:DAYLIGHT', 'DTSTART:19700329T020000', 'RRULE:FREQ=YEARLY;BYMONTH=3;BYDAY=-1SU', 'TZOFFSETFROM:+0100', 'TZOFFSETTO:+0200', 'TZNAME:CEST', 'END:DAYLIGHT', 'END:VTIMEZONE'];
  return ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//To Smile//Calendario eventi//IT', 'CALSCALE:GREGORIAN', metodo && `METHOD:${metodo}`,
    ...(e.all_day || !e.start_time ? [] : tz), 'BEGIN:VEVENT',
    `UID:${e.id}@calendario.appgestione.it`, `DTSTAMP:${ora}`, `SEQUENCE:${seq}`, ...quando, `SUMMARY:${escI(e.title)}`,
    luogo && `LOCATION:${escI(luogo)}`, descr && `DESCRIPTION:${escI(descr)}`, e.link && `URL:${e.link}`,
    metodo && `ORGANIZER;CN=To Smile Calendario eventi:mailto:${org}`,
    email && `ATTENDEE;CN=${escI(email)};ROLE=REQ-PARTICIPANT;PARTSTAT=ACCEPTED;RSVP=FALSE:mailto:${email}`,
    `STATUS:${annullato ? 'CANCELLED' : 'CONFIRMED'}`, 'TRANSP:OPAQUE', 'END:VEVENT', 'END:VCALENDAR']
    .filter(Boolean).map(piega).join('\r\n');
}

async function evento(id) {
  const { rows } = await db.q(`select e.id, e.title, e.location_note, e.start_date::text as start_date, e.end_date::text as end_date, e.all_day,
      to_char(e.start_time, 'HH24:MI') as start_time, to_char(e.end_time, 'HH24:MI') as end_time, e.description, e.link,
      t.name as type_name, l.name as loc_name, l.address as loc_address
    from events e left join event_types t on t.id = e.type_id left join locations l on l.id = e.location_id where e.id = $1`, [id]);
  return rows[0] || null;
}
const quandoTesto = e => {
  const f = s => new Date(s + 'T12:00:00Z').toLocaleDateString('it-IT', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  const fine = e.end_date && e.end_date !== e.start_date ? ` – ${f(e.end_date)}` : '';
  return `${f(e.start_date)}${fine}${e.all_day || !e.start_time ? '' : `, ore ${e.start_time}${e.end_time ? '–' + e.end_time : ''}`}`;
};

async function spedisci(e, email, seq, annulla) {
  const metodo = annulla ? 'CANCEL' : 'REQUEST';
  const testo = annulla ? `«${e.title}» è stato tolto dal tuo calendario.` : `«${e.title}» · ${quandoTesto(e)}. L'evento è nel tuo Google Calendar.`;
  return mail.send({
    to: email, subject: `${annulla ? 'Annullato: ' : ''}${e.title} · ${quandoTesto(e)}`, text: testo,
    html: mail.layout(annulla ? 'Evento tolto dal calendario' : e.title, [mail.esc(testo), 'Te lo manda il Calendario eventi To Smile. Si aggiorna da solo se l\'evento cambia.']),
    attachments: [{ filename: 'invito.ics', content: ics(e, { metodo, seq, email, annullato: annulla }), contentType: `text/calendar; charset=utf-8; method=${metodo}` }],
  });
}

// l'evento va (o si aggiorna) nel calendario Google di questa persona
async function invia(eventId, userId) {
  try {
    const { rows: [u] } = await db.q('select gcal_email from users where id = $1', [userId]);
    if (!u?.gcal_email) return;
    const e = await evento(eventId); if (!e) return;
    const { rows: [x] } = await db.q(`insert into gcal_invii (event_id, user_id, email) values ($1,$2,$3)
      on conflict (event_id, user_id) do update set seq = gcal_invii.seq + 1, email = excluded.email, attivo = true, il = now() returning seq`, [eventId, userId, u.gcal_email]);
    await spedisci(e, u.gcal_email, x.seq, false);
  } catch (err) { console.warn('Calendario → Google:', err.message); }
}
// l'evento si toglie dal calendario Google di questa persona (se c'era)
async function togli(eventId, userId, e = null) {
  try {
    const { rows: [x] } = await db.q(`update gcal_invii set seq = seq + 1, attivo = false, il = now() where event_id = $1 and user_id = $2 and attivo returning seq, email`, [eventId, userId]);
    if (!x) return;
    e = e || await evento(eventId); if (!e) return;
    await spedisci(e, x.email, x.seq, true);
  } catch (err) { console.warn('Calendario → Google (annullo):', err.message); }
}
// l'evento è cambiato: aggiorna tutti quelli che ce l'hanno
async function aggiorna(eventId) {
  const { rows } = await db.q('select user_id from gcal_invii where event_id = $1 and attivo', [eventId]);
  for (const r of rows) await invia(eventId, r.user_id);
}
// l'evento sta per essere cancellato: si toglie a tutti (prima di cancellarlo, quando i dati ci sono ancora)
async function cancellato(eventId) {
  const e = await evento(eventId); if (!e) return;
  const { rows } = await db.q('select user_id from gcal_invii where event_id = $1 and attivo', [eventId]);
  for (const r of rows) await togli(eventId, r.user_id, e);
  await db.q('delete from gcal_invii where event_id = $1', [eventId]);
}
// eventi futuri di una persona: quelli in cui ha detto "ci sarò" e quelli che ha creato
async function suoiFuturi(userId) {
  const { rows } = await db.q(`select e.id from events e where coalesce(e.end_date, e.start_date) >= (now() at time zone 'Europe/Rome')::date
      and (e.created_by_id = $1 or exists (select 1 from rsvp r where r.event_id = e.id and r.user_id = $1 and r.status = 'yes'))`, [userId]);
  return rows.map(r => r.id);
}
async function attiva(userId, email) {
  await db.q('update users set gcal_email = $2, gcal_chiesto = true where id = $1', [userId, email]);
  const ids = await suoiFuturi(userId);
  for (const id of ids) await invia(id, userId);
  return ids.length;
}
async function disattiva(userId) {
  const { rows } = await db.q('select event_id from gcal_invii where user_id = $1 and attivo', [userId]);
  for (const r of rows) await togli(r.event_id, userId);
  await db.q('update users set gcal_email = null, gcal_chiesto = true where id = $1', [userId]);
}

module.exports = { migrate, ics, evento, invia, togli, aggiorna, cancellato, attiva, disattiva, attivo: mail.enabled };
