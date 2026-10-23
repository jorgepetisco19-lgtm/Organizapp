// Pruebas de las funciones puras. Ejecutar:  node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sumarDias, diffDias, diaSemana, inicioSemana, rejillaMes, finMes, sumarMeses, hoyISO,
  ocurrencias, expandirEventos, repetirSemanas, parseCSV, leerImportacion, fechaLarga,
  primeraLinea, lineasExtra, esFechaISO, esHora,
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
