// Pruebas del lector de archivos .ics (calendarios de Google, Outlook, Apple…).
import test from 'node:test';
import assert from 'node:assert/strict';
import { leerICS, LIMITES_ICS } from '../js/util.js';

const ZONA = 'Europe/Madrid';
const cal = (...eventos) => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//ES\r\n${eventos.map((e) => `BEGIN:VEVENT\r\n${e.join('\r\n')}\r\nEND:VEVENT`).join('\r\n')}\r\nEND:VCALENDAR\r\n`;
const leer = (t, desde = '2026-10-24') => leerICS(t, { desde, zona: ZONA });

test('horas: UTC, zona propia, otra zona y hora sin zona', () => {
  const r = leer(cal(
    ['UID:a', 'SUMMARY:Verano', 'DTSTART:20261024T180000Z', 'DTEND:20261024T200000Z'],     // aún horario de verano (UTC+2)
    ['UID:b', 'SUMMARY:Invierno', 'DTSTART:20261025T180000Z'],                              // ya UTC+1
    ['UID:c', 'SUMMARY:Nueva York', 'DTSTART;TZID=America/New_York:20261105T200000'],       // EST (UTC-5) → 02:00 del 6 en Madrid
    ['UID:d', 'SUMMARY:Sin zona', 'DTSTART:20261028T200000', 'DTEND:20261028T213000'],
    ['UID:e', 'SUMMARY:Madrid', 'DTSTART;TZID=Europe/Madrid:20261029T210000'],
    ['UID:f', 'SUMMARY:Zona rara', 'DTSTART;TZID=Romance Standard Time:20261030T190000'],   // nombre de Windows: se toma tal cual
  ));
  const por = (t) => r.eventos.find((e) => e.titulo === t);
  assert.deepEqual([por('Verano').fecha, por('Verano').hora_inicio, por('Verano').hora_fin], ['2026-10-24', '20:00', '22:00']);
  assert.deepEqual([por('Invierno').fecha, por('Invierno').hora_inicio, por('Invierno').hora_fin], ['2026-10-25', '19:00', null]);
  assert.deepEqual([por('Nueva York').fecha, por('Nueva York').hora_inicio], ['2026-11-06', '02:00']);
  assert.deepEqual([por('Sin zona').hora_inicio, por('Sin zona').hora_fin], ['20:00', '21:30']);
  assert.equal(por('Madrid').hora_inicio, '21:00');
  assert.equal(por('Zona rara').hora_inicio, '19:00');
  assert.equal(r.eventos.length, 6);
});

test('días enteros, varios días y eventos que acaban al día siguiente', () => {
  const r = leer(cal(
    ['UID:a', 'SUMMARY:Boda', 'DTSTART;VALUE=DATE:20261030', 'DTEND;VALUE=DATE:20261031'],
    ['UID:b', 'SUMMARY:Torneo', 'DTSTART;VALUE=DATE:20261030', 'DTEND;VALUE=DATE:20261102'],
    ['UID:c', 'SUMMARY:Fiesta', 'DTSTART:20261031T220000', 'DTEND:20261101T010000'],
    ['UID:d', 'SUMMARY:Medianoche', 'DTSTART:20261031T220000', 'DTEND:20261101T000000'],
    ['UID:e', 'SUMMARY:Viaje', 'DTSTART:20261031T080000', 'DTEND:20261103T180000'],
    ['UID:f', 'SUMMARY:Eterno', 'DTSTART;VALUE=DATE:20261030', 'DTEND;VALUE=DATE:20270301'],
  ));
  const por = (t) => r.eventos.find((e) => e.titulo === t);
  assert.deepEqual([por('Boda').hora_inicio, por('Boda').hora_fin, por('Boda').diasExtra], [null, null, 0]);
  assert.equal(por('Torneo').diasExtra, 2);                                                       // 30, 31 y 1: acaba 2 días después
  assert.deepEqual([por('Fiesta').hora_inicio, por('Fiesta').hora_fin, por('Fiesta').diasExtra], ['22:00', '01:00', 1]);
  assert.deepEqual([por('Medianoche').hora_fin, por('Medianoche').diasExtra], [null, 0]);         // acaba a las 00:00: sigue siendo del mismo día
  assert.deepEqual([por('Viaje').hora_inicio, por('Viaje').hora_fin, por('Viaje').diasExtra], ['08:00', '18:00', 3]);
  assert.equal(por('Eterno'), undefined);
  assert.ok(r.omitidos.some((o) => o.titulo === 'Eterno' && /30 días/.test(o.motivo)));
});

test('un evento de varios días que ya empezó pero sigue en curso se importa; si ya acabó, no', () => {
  const r = leer(cal(
    ['UID:a', 'SUMMARY:En curso', 'DTSTART;VALUE=DATE:20261022', 'DTEND;VALUE=DATE:20261026'],
    ['UID:b', 'SUMMARY:Acabado', 'DTSTART;VALUE=DATE:20261020', 'DTEND;VALUE=DATE:20261023'],
  ), '2026-10-24');
  assert.deepEqual(r.eventos.map((e) => e.titulo), ['En curso']);
  assert.equal(r.pasados, 1);
});

test('turno de noche semanal: se guarda como serie y cada vez acaba al día siguiente', () => {
  const r = leer(cal(['UID:a', 'SUMMARY:Noche', 'DTSTART;TZID=Europe/Madrid:20261030T220000', 'DTEND;TZID=Europe/Madrid:20261031T060000', 'RRULE:FREQ=WEEKLY;BYDAY=FR']));
  assert.equal(r.eventos.length, 1);
  const e = r.eventos[0];
  assert.deepEqual([e.repeticion, e.hora_inicio, e.hora_fin, e.diasExtra], ['semanal', '22:00', '06:00', 1]);
  const largo = leer(cal(['UID:b', 'SUMMARY:Largo', 'DTSTART;VALUE=DATE:20261030', 'DTEND;VALUE=DATE:20261108', 'RRULE:FREQ=WEEKLY']));
  assert.equal(largo.eventos.length, 0);
  assert.ok(largo.omitidos.some((o) => /6 días/.test(o.motivo)));
});

test('textos: escapes, líneas largas, HTML, lugar y cancelados', () => {
  const r = leer(cal(
    ['UID:a', 'SUMMARY:Final\\, España vs\\nItalia', 'DTSTART:20261028T200000', 'LOCATION:Estadio\; Madrid',
      'DESCRIPTION:Línea 1\\nLínea 2 con un texto muy lar', ' go que continúa<br>en otra <b>línea</b> &amp; más'],
    ['UID:b', 'SUMMARY:Cancelado', 'DTSTART:20261028T200000', 'STATUS:CANCELLED'],
    ['UID:c', 'DTSTART:20261029T200000'],
  ));
  assert.equal(r.eventos.length, 2);
  const a = r.eventos.find((e) => e.uid === 'a');
  assert.equal(a.titulo, 'Final, España vs Italia');
  assert.equal(a.notas, 'Lugar: Estadio; Madrid\nLínea 1\nLínea 2 con un texto muy largo que continúa\nen otra línea & más');
  assert.equal(r.eventos.find((e) => e.uid === 'c').titulo, '(sin título)');
  assert.ok(leer(cal(['UID:z', 'SUMMARY:' + 'x'.repeat(300), 'DTSTART:20261028T200000', 'DESCRIPTION:' + 'y'.repeat(2000)])).eventos[0].titulo.length === 120);
  assert.ok(leer(cal(['UID:z', 'SUMMARY:t', 'DTSTART:20261028T200000', 'DESCRIPTION:' + 'y'.repeat(2000)])).eventos[0].notas.length === 1000);
});

test('eventos pasados, archivo que no es un calendario y evento sin fecha', () => {
  const r = leer(cal(['UID:a', 'SUMMARY:Ayer', 'DTSTART:20261023T200000'], ['UID:b', 'SUMMARY:Hoy', 'DTSTART:20261024T200000'], ['UID:c', 'SUMMARY:Rota', 'DTSTART:mañana']));
  assert.deepEqual(r.eventos.map((e) => e.titulo), ['Hoy']);
  assert.equal(r.pasados, 1);
  assert.equal(r.omitidos.length, 1);
  assert.match(leerICS('hola, esto no es un calendario', { zona: ZONA }).error, /no parece un calendario/);
});

test('serie semanal: días, fin, cuenta y días quitados', () => {
  // martes y jueves desde septiembre, hasta el 17 de diciembre, sin el 5 de noviembre
  const r = leer(cal(['UID:s', 'SUMMARY:Pilates', 'DTSTART:20260901T190000', 'DTEND:20260901T200000', 'RRULE:FREQ=WEEKLY;BYDAY=TU,TH;UNTIL=20261217T220000Z', 'EXDATE;VALUE=DATE:20261105,20260915']));
  assert.equal(r.eventos.length, 1);
  const e = r.eventos[0];
  assert.deepEqual([e.repeticion, e.dias_semana, e.fecha, e.repite_hasta], ['semanal', [1, 3], '2026-10-27', '2026-12-17']);
  assert.deepEqual(e.excepciones, ['2026-11-05']);               // la del 15 de septiembre ya pasó y no se guarda
  assert.deepEqual([e.hora_inicio, e.hora_fin], ['19:00', '20:00']);
  // un solo día, sin BYDAY: como las series de siempre (sin dias_semana)
  const s = leer(cal(['UID:t', 'SUMMARY:Yoga', 'DTSTART:20261001T180000', 'RRULE:FREQ=WEEKLY'])).eventos[0];
  assert.deepEqual([s.dias_semana, s.fecha, s.repite_hasta], [null, '2026-10-29', null]);
  // COUNT: tres lunes desde el 26 → acaba el 9 de noviembre
  const c = leer(cal(['UID:u', 'SUMMARY:Curso', 'DTSTART:20261026T100000', 'RRULE:FREQ=WEEKLY;COUNT=3'])).eventos[0];
  assert.deepEqual([c.fecha, c.repite_hasta], ['2026-10-26', '2026-11-09']);
  // COUNT que ya se cumplió o UNTIL pasado: no hay nada que importar
  const v = leer(cal(['UID:v', 'SUMMARY:Viejo', 'DTSTART:20260901T100000', 'RRULE:FREQ=WEEKLY;COUNT=3'], ['UID:w', 'SUMMARY:Viejo2', 'DTSTART:20260901T100000', 'RRULE:FREQ=WEEKLY;UNTIL=20261001T000000Z']));
  assert.equal(v.eventos.length, 0);
  assert.equal(v.pasados, 2);
});

test('otras repeticiones: fechas sueltas de los próximos meses', () => {
  const diaria = leer(cal(['UID:d', 'SUMMARY:Pastilla', 'DTSTART:20261026T090000', 'RRULE:FREQ=DAILY;COUNT=5'])).eventos[0];
  assert.deepEqual(diaria.fechas, ['2026-10-26', '2026-10-27', '2026-10-28', '2026-10-29', '2026-10-30']);
  assert.equal(diaria.expandido, true);
  const sinFin = leer(cal(['UID:e', 'SUMMARY:Siempre', 'DTSTART:20261026T090000', 'RRULE:FREQ=DAILY']));
  assert.equal(sinFin.eventos[0].fechas.length, LIMITES_ICS.porSerie);
  assert.equal(sinFin.truncado, true);
  const mensual = leer(cal(['UID:m', 'SUMMARY:Alquiler', 'DTSTART:20260915T090000', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=15']));
  assert.deepEqual(mensual.eventos[0].fechas, ['2026-11-15', '2026-12-15', '2027-01-15', '2027-02-15']);
  assert.equal(mensual.truncado, true);
  const quincenal = leer(cal(['UID:q', 'SUMMARY:Sábados alternos', 'DTSTART:20261024T100000', 'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=SA']));
  assert.deepEqual(quincenal.eventos[0].fechas.slice(0, 4), ['2026-10-24', '2026-11-07', '2026-11-21', '2026-12-05']);
  const anual = leer(cal(['UID:y', 'SUMMARY:Cumple', 'DTSTART:20200105T090000', 'RRULE:FREQ=YEARLY']), '2026-12-20');
  assert.deepEqual(anual.eventos[0].fechas, ['2027-01-05']);
  // 29 de febrero: solo años bisiestos
  assert.equal(leer(cal(['UID:b', 'SUMMARY:Bisiesto', 'DTSTART:20240229T090000', 'RRULE:FREQ=YEARLY']), '2026-10-24').eventos.length, 0);
});

test('repeticiones que no sabemos hacer se avisan, no se importan mal', () => {
  const r = leer(cal(
    ['UID:a', 'SUMMARY:Primer lunes', 'DTSTART:20261005T090000', 'RRULE:FREQ=MONTHLY;BYDAY=1MO'],
    ['UID:b', 'SUMMARY:Raro', 'DTSTART:20261005T090000', 'RRULE:FREQ=MONTHLY;BYSETPOS=-1;BYDAY=FR'],
    ['UID:c', 'SUMMARY:Otro día del mes', 'DTSTART:20261005T090000', 'RRULE:FREQ=MONTHLY;BYMONTHDAY=20'],
    ['UID:d', 'SUMMARY:Normal', 'DTSTART:20261026T090000'],
  ));
  assert.deepEqual(r.eventos.map((e) => e.titulo), ['Normal']);
  assert.deepEqual(r.omitidos.map((o) => o.titulo).sort(), ['Otro día del mes', 'Primer lunes', 'Raro']);
});

test('una ocurrencia cambiada de una serie sustituye a la original', () => {
  const r = leer(cal(
    ['UID:x', 'SUMMARY:Entreno', 'DTSTART:20261027T190000', 'RRULE:FREQ=WEEKLY'],
    ['UID:x', 'SUMMARY:Entreno (movido)', 'RECURRENCE-ID:20261103T190000', 'DTSTART:20261104T200000'],
  ));
  const serie = r.eventos.find((e) => e.repeticion);
  const movido = r.eventos.find((e) => e.titulo === 'Entreno (movido)');
  assert.deepEqual(serie.excepciones, ['2026-11-03']);
  assert.deepEqual([movido.fecha, movido.hora_inicio, movido.repeticion], ['2026-11-04', '20:00', null]);
});

test('límite de eventos por archivo y orden', () => {
  const muchos = Array.from({ length: 600 }, (_, i) => ['UID:' + i, 'SUMMARY:E' + i, `DTSTART:2026${String(11 + Math.floor(i / 300)).padStart(2, '0')}${String(1 + (i % 28)).padStart(2, '0')}T100000`]);
  const r = leer(cal(...muchos));
  assert.equal(r.eventos.length, LIMITES_ICS.eventos);
  assert.equal(r.truncado, true);
  assert.equal(r.encontrados, 600);
  const o = leer(cal(['UID:2', 'SUMMARY:B', 'DTSTART:20261102T100000'], ['UID:1', 'SUMMARY:A', 'DTSTART:20261101T100000'], ['UID:3', 'SUMMARY:C', 'DTSTART:20261101T090000']));
  assert.deepEqual(o.eventos.map((e) => e.titulo), ['C', 'A', 'B']);
});
