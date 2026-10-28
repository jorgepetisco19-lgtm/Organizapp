// Pruebas de las funciones puras. Ejecutar:  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sumarDias, diffDias, diaSemana, inicioSemana, rejillaMes, finMes, sumarMeses, hoyISO,
  ocurrencias, expandirEventos, repetirSemanas, parseCSV, leerImportacion, fechaLarga,
  primeraLinea, lineasExtra, esFechaISO, esHora, normalizarDias, descripcionRepeticion, diasExtra, fechaFinDe, tramoDia, textoHora,
} from '../js/util.js';

test('fechas: días de la semana y cambio de hora', () => {
  assert.equal(diaSemana('2026-10-26'), 0); // lunes
  assert.equal(diaSemana('2026-11-01'), 6); // domingo
  assert.equal(inicioSemana('2026-10-30'), '2026-10-26');
  // el 25/10/2026 cambia la hora en España: no debe perderse ni duplicarse un día
  assert.equal(sumarDias('2026-10-24', 1), '2026-10-25');
  assert.equal(sumarDias('2026-10-25', 1), '2026-10-26');
  assert.equal(diffDias('2026-10-26', '2026-10-24'), 2);
  assert.equal(sumarDias('2026-12-31', 1), '2027-01-01');
  assert.equal(sumarDias('2028-02-28', 1), '2028-02-29');
  assert.equal(finMes(2026, 10), '2026-10-31');
  assert.equal(finMes(2028, 2), '2028-02-29');
  assert.deepEqual(sumarMeses(2026, 12, 1), { y: 2027, m: 1 });
  assert.deepEqual(sumarMeses(2026, 1, -1), { y: 2025, m: 12 });
  assert.equal(fechaLarga('2026-10-24'), 'sábado 24 de octubre');
  assert.equal(hoyISO(new Date(2026, 9, 23, 0, 30)), '2026-10-23');
});

test('rejilla de octubre 2026 = la del calendario de la nevera (28 sep a 1 nov)', () => {
  const r = rejillaMes(2026, 10);
  assert.equal(r.length, 5);
  assert.equal(r[0][0], '2026-09-28');
  assert.equal(r[4][6], '2026-11-01');
  assert.ok(r.every((s) => s.length === 7));
});

test('validaciones', () => {
  assert.ok(esFechaISO('2026-02-28'));
  assert.ok(!esFechaISO('2026-02-30'));
  assert.ok(!esFechaISO('26-02-2026'));
  assert.ok(esHora('06:35') && esHora('23:59') && !esHora('24:00') && !esHora('9:30'));
});

test('eventos sueltos y semanales', () => {
  const suelto = { id: 'a', fecha: '2026-10-27', titulo: 'Pádel' };
  assert.deepEqual(ocurrencias(suelto, '2026-10-26', '2026-11-01'), ['2026-10-27']);
  assert.deepEqual(ocurrencias(suelto, '2026-11-02', '2026-11-08'), []);

  const pilates = { id: 'b', fecha: '2026-10-01', repeticion: 'semanal', repite_hasta: null, excepciones: [] };
  assert.deepEqual(ocurrencias(pilates, '2026-10-26', '2026-11-15'), ['2026-10-29', '2026-11-05', '2026-11-12']);
  // empieza antes del rango y pasa por el cambio de hora sin desplazarse
  assert.deepEqual(ocurrencias(pilates, '2026-10-22', '2026-10-30'), ['2026-10-22', '2026-10-29']);

  const conFin = { ...pilates, repite_hasta: '2026-11-05' };
  assert.deepEqual(ocurrencias(conFin, '2026-10-26', '2026-11-30'), ['2026-10-29', '2026-11-05']);

  const conExc = { ...pilates, excepciones: ['2026-11-05'] };
  assert.deepEqual(ocurrencias(conExc, '2026-10-26', '2026-11-15'), ['2026-10-29', '2026-11-12']);

  const futuro = { ...pilates, fecha: '2026-12-03' };
  assert.deepEqual(ocurrencias(futuro, '2026-10-26', '2026-11-15'), []);
});

test('orden dentro del día: sin hora primero, luego por hora', () => {
  const evs = [
    { id: '1', fecha: '2026-10-29', titulo: 'Cena fuera', hora_inicio: '21:00:00' },
    { id: '2', fecha: '2026-10-29', titulo: 'Pilates', hora_inicio: '20:00:00' },
    { id: '3', fecha: '2026-10-29', titulo: 'Cumple', hora_inicio: null },
    { id: '4', fecha: '2026-10-29', titulo: 'Crema', hora_inicio: '17:00:00' },
  ];
  const m = expandirEventos(evs, '2026-10-29', '2026-10-29');
  assert.deepEqual(m.get('2026-10-29').map((x) => x.ev.titulo), ['Cumple', 'Crema', 'Pilates', 'Cena fuera']);
});

test('repetir 2 semanas hasta fin de mes', () => {
  // Semana 1 (26 oct) y semana 2 (2 nov); cada una con un martes distinto
  const filas = [
    { fecha: '2026-10-27', owner_id: 'j', franja: 'comida', texto: 'S1 martes' },
    { fecha: '2026-11-03', owner_id: 'j', franja: 'comida', texto: 'S2 martes' },
    { fecha: '2026-11-08', owner_id: 'j', franja: 'cena', texto: 'S2 domingo' },
  ];
  const nuevas = repetirSemanas(filas, '2026-10-26', 2, '2026-11-30');
  const por = Object.fromEntries(nuevas.map((f) => [f.fecha, f.texto]));
  assert.equal(por['2026-11-10'], 'S1 martes'); // 3ª semana = como la 1ª
  assert.equal(por['2026-11-17'], 'S2 martes'); // 4ª = como la 2ª
  assert.equal(por['2026-11-24'], 'S1 martes');
  assert.equal(por['2026-11-22'], 'S2 domingo');
  assert.ok(nuevas.every((f) => f.fecha > '2026-11-08' && f.fecha <= '2026-11-30'));
  assert.equal(nuevas.length, 4); // 10, 17, 22 y 24 de noviembre
  // 1 semana
  const una = repetirSemanas([{ fecha: '2026-10-27', franja: 'comida', texto: 'x' }], '2026-10-26', 1, '2026-11-10');
  assert.deepEqual(una.map((f) => f.fecha), ['2026-11-03', '2026-11-10']);
});

test('CSV: coma, punto y coma, comillas y saltos de línea dentro de una celda', () => {
  const a = parseCSV('a,b,c\n1,"x,y",3\n"l1\nl2","di ""hola""",z\n');
  assert.deepEqual(a, [['a', 'b', 'c'], ['1', 'x,y', '3'], ['l1\nl2', 'di "hola"', 'z']]);
  const b = parseCSV('﻿a;b\r\n1;2\r\n3;4');
  assert.deepEqual(b, [['a', 'b'], ['1', '2'], ['3', '4']]);
});

test('importación del menú', () => {
  const csv = [
    'fecha,persona,franja,hora,texto',
    '2026-10-26,Jorge,desayuno,08:00,Avena proteica con whey · 2/3 ración',
    '2026-10-26,Jorge,comida,,"Crema de puerro · 335 g\nPollo con verduras · 210 g"',
    '26/10/2026,Paula,Media mañana,12:00,Overnight oats',
    '2026-10-26,Paula,cena,,',
    '2026-13-40,Paula,cena,,mal',
    '2026-10-26,Paula,brunch,,mal',
    '2026-10-26,Paula,cena,25:00,mal',
  ].join('\n');
  const r = leerImportacion(csv);
  assert.equal(r.filas.length, 3);
  assert.equal(r.filas[1].texto, 'Crema de puerro · 335 g\nPollo con verduras · 210 g');
  assert.equal(r.filas[2].franja, 'media_manana');
  assert.equal(r.filas[2].fecha, '2026-10-26');
  assert.deepEqual(r.personas, ['Jorge', 'Paula']);
  assert.equal(r.errores.length, 3);
  assert.equal(leerImportacion('a,b\n1,2').errores.length, 1);
  assert.equal(leerImportacion('').errores.length, 1);
});

test('texto del menú', () => {
  assert.equal(primeraLinea('\n  Crema \nPollo'), 'Crema');
  assert.equal(lineasExtra('Crema\nPollo\nFruta'), 2);
  assert.equal(lineasExtra('Crema'), 0);
  assert.equal(lineasExtra(''), 0);
});

test('eventos que se repiten varios días a la semana', () => {
  // 2026-10-26 es lunes. Lunes, miércoles y viernes (0, 2, 4)
  const lmv = { id: 'c', fecha: '2026-10-26', repeticion: 'semanal', dias_semana: [0, 2, 4], excepciones: [] };
  assert.deepEqual(ocurrencias(lmv, '2026-10-26', '2026-11-08'),
    ['2026-10-26', '2026-10-28', '2026-10-30', '2026-11-02', '2026-11-04', '2026-11-06']);
  // el rango empieza a mitad de semana
  assert.deepEqual(ocurrencias(lmv, '2026-10-29', '2026-11-03'), ['2026-10-30', '2026-11-02']);
  // no sale antes de la fecha de inicio aunque coincida el día de la semana
  assert.deepEqual(ocurrencias({ ...lmv, fecha: '2026-10-28' }, '2026-10-26', '2026-10-31'), ['2026-10-28', '2026-10-30']);
  // empieza en un día que no está marcado: la primera vez es el siguiente día marcado
  assert.deepEqual(ocurrencias({ ...lmv, fecha: '2026-10-27' }, '2026-10-26', '2026-10-31'), ['2026-10-28', '2026-10-30']);
  // fin de la serie y días quitados
  assert.deepEqual(ocurrencias({ ...lmv, repite_hasta: '2026-11-02' }, '2026-10-26', '2026-11-30'), ['2026-10-26', '2026-10-28', '2026-10-30', '2026-11-02']);
  assert.deepEqual(ocurrencias({ ...lmv, excepciones: ['2026-10-28', '2026-11-02'] }, '2026-10-26', '2026-11-04'), ['2026-10-26', '2026-10-30', '2026-11-04']);
  // fin de semana (sábado y domingo = 5 y 6) cruzando el cambio de hora de octubre
  assert.deepEqual(ocurrencias({ id: 'd', fecha: '2026-10-24', repeticion: 'semanal', dias_semana: [5, 6], excepciones: [] }, '2026-10-24', '2026-11-01'),
    ['2026-10-24', '2026-10-25', '2026-10-31', '2026-11-01']);
  // sin dias_semana (o vacío) todo funciona como siempre: el día de su fecha
  assert.deepEqual(ocurrencias({ id: 'e', fecha: '2026-10-29', repeticion: 'semanal', dias_semana: [], excepciones: [] }, '2026-10-26', '2026-11-08'), ['2026-10-29', '2026-11-05']);
  assert.deepEqual(ocurrencias({ id: 'e', fecha: '2026-10-29', repeticion: 'semanal', dias_semana: null, excepciones: [] }, '2026-10-26', '2026-11-08'), ['2026-10-29', '2026-11-05']);
  // expandirEventos las ordena por día
  const mapa = expandirEventos([lmv], '2026-10-26', '2026-10-30');
  assert.deepEqual([...mapa.keys()], ['2026-10-26', '2026-10-28', '2026-10-30']);
});

test('normalizarDias y descripcionRepeticion', () => {
  assert.equal(normalizarDias([3], '2026-10-29'), null);           // jueves y la fecha es jueves: como siempre
  assert.deepEqual(normalizarDias([1], '2026-10-29'), [1]);        // solo martes aunque empiece un jueves
  assert.deepEqual(normalizarDias([4, 0, 2, 2], '2026-10-26'), [0, 2, 4]);
  assert.equal(normalizarDias([], '2026-10-26'), null);
  assert.equal(normalizarDias([9, -1, 'x'], '2026-10-26'), null);
  assert.equal(descripcionRepeticion({}), 'cada semana');
  assert.equal(descripcionRepeticion({ dias_semana: [1] }), 'cada semana (mar)');
  assert.equal(descripcionRepeticion({ dias_semana: [0, 2, 4] }), 'cada semana (lun, mié y vie)');
  assert.equal(descripcionRepeticion({ dias_semana: [1, 3] }), 'cada semana (mar y jue)');
});

test('eventos que acaban otro día: se reparten por días y aguantan la repetición semanal', () => {
  // turno de noche: viernes 22:00 → sábado 06:00, cada semana
  const turno = { id: 't', titulo: 'Turno', fecha: '2026-10-30', hora_inicio: '22:00', hora_fin: '06:00', dias_extra: 1, repeticion: 'semanal', excepciones: [] };
  assert.equal(diasExtra(turno), 1);
  assert.equal(diasExtra({}), 0);
  assert.equal(fechaFinDe(turno, '2026-11-06'), '2026-11-07');
  const mapa = expandirEventos([turno], '2026-10-30', '2026-11-08');
  assert.deepEqual([...mapa.keys()], ['2026-10-30', '2026-10-31', '2026-11-06', '2026-11-07']);
  assert.deepEqual(mapa.get('2026-10-30').map((x) => x.parte), ['primero']);
  assert.deepEqual(mapa.get('2026-10-31').map((x) => x.parte), ['ultimo']);
  assert.equal(mapa.get('2026-10-31')[0].fecha, '2026-10-30');  // sigue identificado por el día en que empieza
  assert.equal(mapa.get('2026-10-31')[0].dia, '2026-10-31');
  // la rejilla empieza el sábado: la noche del viernes anterior se sigue viendo
  const desdeSabado = expandirEventos([turno], '2026-10-31', '2026-11-01');
  assert.deepEqual([...desdeSabado.keys()], ['2026-10-31']);
  assert.equal(desdeSabado.get('2026-10-31')[0].parte, 'ultimo');
  // si se quita una noche (excepción), tampoco aparece su mañana siguiente
  const sinUna = expandirEventos([{ ...turno, excepciones: ['2026-10-30'] }], '2026-10-30', '2026-11-01');
  assert.equal(sinUna.size, 0);
  // texto y tramo de cada parte
  const [p1, p2] = [mapa.get('2026-10-30')[0], mapa.get('2026-10-31')[0]];
  assert.deepEqual([textoHora(p1), textoHora(p2)], ['22:00 →', '→ 06:00']);
  assert.deepEqual(tramoDia(p1), { a: 1320, b: 1440 });
  assert.deepEqual(tramoDia(p2), { a: 0, b: 360 });
  // de varios días sin horas: todos «todo el día»; en medio también
  const viaje = { id: 'v', titulo: 'Viaje', fecha: '2026-11-02', hora_inicio: null, hora_fin: null, dias_extra: 2, repeticion: null, excepciones: [] };
  const mv = expandirEventos([viaje], '2026-11-01', '2026-11-10');
  assert.deepEqual([...mv.keys()], ['2026-11-02', '2026-11-03', '2026-11-04']);
  assert.deepEqual([...mv.values()].map((l) => l[0].parte), ['primero', 'medio', 'ultimo']);
  assert.ok([...mv.values()].every((l) => tramoDia(l[0]) === null && textoHora(l[0]) === 'Todo el día'));
  // con hora de inicio y de fin: el día de en medio es «todo el día»
  const gira = { ...viaje, hora_inicio: '10:00', hora_fin: '20:00' };
  const mg = [...expandirEventos([gira], '2026-11-01', '2026-11-10').values()].map((l) => textoHora(l[0]));
  assert.deepEqual(mg, ['10:00 →', 'Todo el día', '→ 20:00']);
  // de un solo día no cambia nada
  const normal = { id: 'n', titulo: 'Cine', fecha: '2026-11-02', hora_inicio: '19:00', hora_fin: '21:00', repeticion: null, excepciones: [] };
  const mn = expandirEventos([normal], '2026-11-01', '2026-11-10').get('2026-11-02')[0];
  assert.equal(mn.parte, 'unico');
  assert.equal(textoHora(mn), '19:00–21:00');
  // orden: lo que viene de ayer o es de todo el día va antes que lo que tiene hora
  const dia = expandirEventos([normal, turno], '2026-10-31', '2026-10-31');
  assert.equal(dia.get('2026-10-31')[0].ev.id, 't');
  // dos veces el mismo evento en un mismo día no se pisa si se solapan (semanal con 6 días de más)
  const largo = { id: 'l', titulo: 'Largo', fecha: '2026-11-02', dias_extra: 6, repeticion: 'semanal', excepciones: [] };
  const ml = expandirEventos([largo], '2026-11-02', '2026-11-15');
  assert.equal([...ml.values()].every((l) => l.length === 1), true);
  assert.equal(ml.size, 14);
});
