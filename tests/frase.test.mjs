// node --test tests/frase.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { interpretarFrase } from '../js/frase.js';

// Hoy = lunes 23/11/2026, son las 10:00
const HOY = '2026-11-23';
const f = (t, ahora = '10:00') => interpretarFrase(t, { hoy: HOY, ahora });
const comprueba = (t, esperado, ahora) => {
  const r = f(t, ahora);
  for (const [k, v] of Object.entries(esperado)) assert.deepEqual(r[k], v, `«${t}» → ${k}: ${JSON.stringify(r[k])} (esperado ${JSON.stringify(v)}) · resultado completo: ${JSON.stringify(r)}`);
  return r;
};

test('el ejemplo de Jorge: cita dentista el martes a las 12', () => {
  comprueba('cita dentista el martes a las 12', { tipo: 'compromiso', titulo: 'Dentista', fecha: '2026-11-24', hora_inicio: '12:00', hora_fin: null, repeticion: null, ok: true });
});

test('tipos solo por la palabra del principio; sin palabra, «plan»', () => {
  comprueba('tarea sacar el pollo mañana', { tipo: 'tarea', titulo: 'Sacar el pollo', fecha: '2026-11-24', hora_inicio: null });
  comprueba('deporte pádel el sábado', { tipo: 'deporte', titulo: 'Pádel', fecha: '2026-11-28' });
  comprueba('plan cine el viernes a las 21:30', { tipo: 'plan', titulo: 'Cine', fecha: '2026-11-27', hora_inicio: '21:30' });
  comprueba('dentista el martes a las 12', { tipo: 'plan', titulo: 'Dentista' });
  comprueba('añade una cita con el médico el viernes a las 10', { tipo: 'compromiso', titulo: 'Médico', fecha: '2026-11-27', hora_inicio: '10:00' });
  comprueba('apunta tarea comprar pan', { tipo: 'tarea', titulo: 'Comprar pan', fecha: HOY });
  // Limitación conocida: «plan» al principio se toma como tipo, no como parte del título
  comprueba('plan de ahorro mañana', { tipo: 'plan', titulo: 'Ahorro', fecha: '2026-11-24' });
  comprueba('revisión del plan de ahorro mañana', { tipo: 'plan', titulo: 'Revisión del plan de ahorro', fecha: '2026-11-24' });
});

test('«el martes» es el próximo que llega; «el martes que viene» el de la semana siguiente', () => {
  comprueba('dentista el martes', { fecha: '2026-11-24' });
  comprueba('dentista este martes', { fecha: '2026-11-24' });
  comprueba('dentista el martes que viene', { fecha: '2026-12-01' });
  comprueba('dentista el próximo martes', { fecha: '2026-12-01' });
  comprueba('dentista el martes de la semana que viene', { fecha: '2026-12-01' });
  comprueba('dentista el lunes', { fecha: '2026-11-30' }); // hoy es lunes: «el lunes» = el siguiente
  comprueba('dentista este lunes', { fecha: HOY });
  comprueba('dentista el lunes que viene', { fecha: '2026-11-30' });
  comprueba('dentista el domingo', { fecha: '2026-11-29' });
  comprueba('dentista el miércoles', { fecha: '2026-11-25' });
  comprueba('dentista el miercoles', { fecha: '2026-11-25' });
});

test('el domingo, «el martes que viene» ya es el de mañana+1 (semana siguiente)', () => {
  const r = interpretarFrase('dentista el martes que viene', { hoy: '2026-11-22' }); // domingo
  assert.equal(r.fecha, '2026-11-24');
});

test('hoy, mañana, pasado mañana, en N días', () => {
  comprueba('dentista hoy', { fecha: HOY, sinDia: false });
  comprueba('dentista mañana', { fecha: '2026-11-24', sinDia: false });
  comprueba('dentista pasado mañana', { fecha: '2026-11-25' });
  comprueba('dentista esta tarde', { fecha: HOY });
  comprueba('dentista dentro de 3 días', { fecha: '2026-11-26' });
  comprueba('dentista en dos semanas', { fecha: '2026-12-07' });
  comprueba('dentista', { fecha: HOY, sinDia: true });
});

test('«por la mañana» no es «mañana»', () => {
  comprueba('gimnasio mañana por la mañana', { fecha: '2026-11-24', titulo: 'Gimnasio por la mañana' });
  comprueba('gimnasio por la mañana', { fecha: HOY, sinDia: true });
  comprueba('desayuno a las 9 de la mañana', { fecha: HOY, hora_inicio: '09:00', titulo: 'Desayuno' });
});

test('horas', () => {
  comprueba('reunión a las 17:30', { hora_inicio: '17:30', titulo: 'Reunión' });
  comprueba('reunión a las 5 de la tarde', { hora_inicio: '17:00' });
  comprueba('reunión a las 5', { hora_inicio: '17:00' });
  comprueba('reunión a las 9', { hora_inicio: '09:00' });
  comprueba('reunión a las 12', { hora_inicio: '12:00' });
  comprueba('cena a las 9 de la noche', { hora_inicio: '21:00' });
  comprueba('cena a las 8 y media de la noche', { hora_inicio: '20:30' });
  comprueba('cena a las ocho y media de la noche', { hora_inicio: '20:30' });
  comprueba('reunión a las 12 y cuarto', { hora_inicio: '12:15' });
  comprueba('reunión a las 3 menos cuarto', { hora_inicio: '14:45' });
  comprueba('reunión a las doce', { hora_inicio: '12:00' });
  comprueba('reunión a la una', { hora_inicio: '13:00', titulo: 'Reunión' });
  comprueba('reunión a las 12h30', { hora_inicio: '12:30' });
  comprueba('reunión a las 12.30', { hora_inicio: '12:30' });
  comprueba('reunión 18:45', { hora_inicio: '18:45', titulo: 'Reunión' });
  comprueba('reunión a las 12 de la noche', { hora_inicio: '00:00' });
  comprueba('llamar a las 3 de la noche', { hora_inicio: '03:00' });
  comprueba('comida a mediodía', { hora_inicio: '12:00', titulo: 'Comida' });
});

test('rangos de hora', () => {
  comprueba('reunión de 17 a 18:30 mañana', { hora_inicio: '17:00', hora_fin: '18:30', fecha: '2026-11-24', titulo: 'Reunión' });
  comprueba('reunión de las 5 a las 6 de la tarde', { hora_inicio: '17:00', hora_fin: '18:00' });
  comprueba('reunión de 10 a 12', { hora_inicio: '10:00', hora_fin: '12:00' });
  comprueba('reunión de 10 a 2', { hora_inicio: '10:00', hora_fin: '14:00' });
  comprueba('yoga a las 7 de la tarde hasta las 8', { hora_inicio: '19:00', hora_fin: '20:00', titulo: 'Yoga' });
  comprueba('yoga de 20:00 a 21:30', { hora_inicio: '20:00', hora_fin: '21:30' });
});

test('fechas escritas', () => {
  comprueba('cena el 25 de diciembre a las 9 de la noche', { fecha: '2026-12-25', hora_inicio: '21:00', titulo: 'Cena' });
  comprueba('cumpleaños el 3 de enero', { fecha: '2027-01-03', titulo: 'Cumpleaños' }); // ya pasó este año → el siguiente
  comprueba('cumpleaños el 3 de enero de 2028', { fecha: '2028-01-03' });
  comprueba('dentista el 25/12', { fecha: '2026-12-25' });
  comprueba('dentista 3/1', { fecha: '2027-01-03' });
  comprueba('dentista el 25/12/2027', { fecha: '2027-12-25' });
  comprueba('dentista el día 28', { fecha: '2026-11-28' });
  comprueba('dentista el día 5', { fecha: '2026-12-05' }); // este mes ya pasó → el siguiente
  comprueba('dentista el 31 de febrero', { ok: true, sinDia: true }); // fecha imposible: no se inventa
});

test('repeticiones', () => {
  comprueba('deporte pádel todos los sábados a las 10', { tipo: 'deporte', titulo: 'Pádel', repeticion: 'semanal', dias: [5], dias_semana: null, fecha: '2026-11-28', hora_inicio: '10:00', repite_hasta: null });
  comprueba('todos los martes pilates', { repeticion: 'semanal', fecha: '2026-11-24', dias: [1], titulo: 'Pilates' });
  comprueba('pilates los lunes y miércoles a las 7 de la tarde', { repeticion: 'semanal', dias: [0, 2], dias_semana: [0, 2], hora_inicio: '19:00', fecha: HOY, titulo: 'Pilates' }); // hoy lunes 10:00 y la hora aún no ha pasado
  comprueba('pilates los lunes y miércoles a las 7 de la tarde', { fecha: '2026-11-25' }, '20:00'); // la hora de hoy ya pasó: empieza el miércoles
  comprueba('pilates todos los lunes', { fecha: '2026-11-30', dias: [0] }, '10:00'); // sin hora: desde mañana
  comprueba('yoga cada viernes', { repeticion: 'semanal', dias: [4], fecha: '2026-11-27' });
  comprueba('yoga todos los días a las 8', { repeticion: 'semanal', dias: [0, 1, 2, 3, 4, 5, 6], dias_semana: [0, 1, 2, 3, 4, 5, 6], hora_inicio: '08:00' });
  comprueba('oficina entre semana', { dias: [0, 1, 2, 3, 4] });
  comprueba('correr los fines de semana', { dias: [5, 6], fecha: '2026-11-28', titulo: 'Correr' });
  comprueba('correr todas las semanas', { repeticion: 'semanal', dias: [1], fecha: '2026-11-24' }); // mañana (martes)
  comprueba('pilates todos los martes hasta el 15 de diciembre', { repeticion: 'semanal', repite_hasta: '2026-12-15', titulo: 'Pilates' });
  comprueba('pilates todos los martes desde el 1 de diciembre', { fecha: '2026-12-01', titulo: 'Pilates' });
});

test('repeticiones que la app no tiene: se avisa y no se repite', () => {
  const r = comprueba('pilates cada dos semanas', { repeticion: null, titulo: 'Pilates' });
  assert.equal(r.avisos.length, 1);
  assert.match(r.avisos[0], /Solo sé repetir cada semana/);
  comprueba('pagar el seguro cada mes', { repeticion: null, titulo: 'Pagar el seguro' });
  comprueba('revisión anual', { repeticion: null });
});

test('limpieza del título', () => {
  comprueba('tengo dentista el martes', { titulo: 'Dentista' });
  comprueba('tengo que sacar al perro mañana a las 8 de la mañana', { titulo: 'Sacar al perro', hora_inicio: '08:00', fecha: '2026-11-24' });
  comprueba('Añade una tarea: sacar el pollo del congelador mañana', { tipo: 'tarea', titulo: 'Sacar el pollo del congelador', fecha: '2026-11-24' });
  comprueba('  cena   con  Paula   el sábado ', { titulo: 'Cena con Paula', fecha: '2026-11-28' });
  comprueba('cena con Paula', { titulo: 'Cena con Paula' });
  comprueba('Dentista el MARTES a las 12', { titulo: 'Dentista', fecha: '2026-11-24' });
});

test('frases vacías o sin título', () => {
  comprueba('', { ok: false, sinTitulo: true });
  comprueba('el martes a las 12', { ok: false, sinTitulo: true });
  comprueba('cita', { ok: false, sinTitulo: true, tipo: 'compromiso' });
  comprueba('   ', { ok: false });
});

test('títulos muy largos se cortan; emojis no descuadran', () => {
  const r = f('a'.repeat(300) + ' mañana');
  assert.equal(r.titulo.length, 120);
  assert.equal(r.fecha, '2026-11-24');
  comprueba('🍕 cena el sábado a las 9 de la noche', { titulo: '🍕 cena', fecha: '2026-11-28', hora_inicio: '21:00' });
});

test('no revienta con cualquier texto', () => {
  for (const t of ['a las 99', 'de a a a', '??? ¡!', 'el 0/0', 'todos los', 'cada', 'hasta hasta', 'x'.repeat(5000), '12:99', 'hoy mañana ayer', 'martes martes martes']) {
    const r = f(t);
    assert.equal(typeof r.titulo, 'string');
    assert.match(r.fecha, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('lista de la compra: «añade X a la compra»', () => {
  comprueba('añade leche a la compra', { accion: 'compra', ok: true, articulos: ['Leche'] });
  comprueba('añade leche, pan y huevos a la lista de la compra', { accion: 'compra', articulos: ['Leche', 'Pan', 'Huevos'] });
  comprueba('Añade la leche y el pan a la lista de la compra', { articulos: ['Leche', 'Pan'] });
  comprueba('apunta en la compra: 2 litros de leche', { articulos: ['2 litros de leche'] });
  comprueba('añade a la compra papel higiénico', { articulos: ['Papel higiénico'] });
  comprueba('pon pan en la lista', { accion: 'compra', articulos: ['Pan'] });
  comprueba('lista de la compra: arroz, sal', { accion: 'compra', articulos: ['Arroz', 'Sal'] });
  comprueba('por favor añade leche a la compra', { accion: 'compra', articulos: ['Leche'] });
  comprueba('añade leche, Leche a la compra', { articulos: ['Leche'] }); // sin repetidos
  comprueba('añade a la compra', { accion: 'compra', ok: false, sinTitulo: true, articulos: [] });
});

test('lista de la compra: no se confunde con eventos', () => {
  comprueba('hacer la compra el sábado', { accion: 'evento', titulo: 'Hacer la compra', fecha: '2026-11-28' });
  comprueba('ir a la compra', { accion: 'evento' });
  comprueba('añade cita dentista el martes', { accion: 'evento', tipo: 'compromiso', titulo: 'Dentista' });
  comprueba('añade una tarea comprar pan', { accion: 'evento', tipo: 'tarea', titulo: 'Comprar pan' });
  comprueba('dentista el martes', { accion: 'evento' });
});

test('lista de la compra: límites', () => {
  const r = f('añade ' + Array.from({ length: 25 }, (_, i) => 'cosa' + i).join(', ') + ' a la compra');
  assert.equal(r.articulos.length, 20);
  assert.equal(r.avisos.length, 1);
  assert.equal(f('añade ' + 'x'.repeat(500) + ' a la compra').articulos[0].length, 200);
});
